import type { BrowserContext, Page } from "playwright-core";
import { WebError } from "./errors.js";
import { launchWebContext } from "./browser.js";
import { ensureWebProfileDir, webProfileExists } from "./profile.js";
import {
  TEMPORARY_CHAT_URL,
  classifyPage,
  extractChatGptSnapshot,
  sessionIsReady,
  uniqueIds,
  watchSentTurn,
  mergeSeenTurns,
  EMPTY_SEND_BASELINE,
  type ChatGptSnapshot,
  type SendBaseline,
  SELECTORS,
} from "./selectors.js";
import { SendGuard } from "./send-guard.js";

const LOGIN_HOSTS = new Set([
  "chatgpt.com",
  "www.chatgpt.com",
  "auth.openai.com",
  "accounts.google.com",
  "login.microsoftonline.com",
  "appleid.apple.com",
]);

export type WebNavigationMode = "login" | "research";
export type NavigationDecision = "allow" | "ignore" | "deny";

export function allowedLoginHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    LOGIN_HOSTS.has(host) ||
    host.endsWith(".google.com") ||
    host.endsWith(".microsoftonline.com")
  );
}

export function allowedResearchHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "chatgpt.com" || host === "www.chatgpt.com";
}

export function navigationDecision(url: string, mode: WebNavigationMode): NavigationDecision {
  const trimmed = url.trim();
  if (!trimmed || trimmed === "about:blank") return "ignore";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "deny";
  }
  if (parsed.protocol === "chrome:" || parsed.protocol === "edge:" || parsed.protocol === "devtools:") {
    return "ignore";
  }
  if (parsed.protocol !== "https:") return "deny";
  const host = parsed.hostname;
  if (!host) return "deny";
  if (mode === "login") return allowedLoginHost(host) ? "allow" : "deny";
  return allowedResearchHost(host) ? "allow" : "deny";
}

function assertAllowedUrl(url: string, mode: WebNavigationMode): void {
  if (navigationDecision(url, mode) === "deny") {
    throw new WebError("WEB_UI_DRIFT", `Blocked navigation to ${url}`);
  }
}

export interface ChatSession {
  snapshot(): Promise<ChatGptSnapshot>;
  ensureReady(): Promise<ChatGptSnapshot>;
  sendAndWait(text: string, opts?: SendWaitOptions): Promise<string>;
  close(): Promise<void>;
}

export interface InteractiveChatSession extends ChatSession {
  waitForNextManualExchange(opts?: SendWaitOptions): Promise<string>;
}

export interface SendWaitOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  multipleUserTurns?: "ambiguous" | "concurrent";
}

async function waitForSignal(signal: AbortSignal | undefined, ms: number): Promise<void> {
  if (signal?.aborted) throw new WebError("WEB_TIMEOUT", "Web session was cancelled");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new WebError("WEB_TIMEOUT", "Web session was cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function failFromSnapshot(snapshot: ChatGptSnapshot): never {
  const kind = classifyPage(snapshot);
  if (kind === "challenge") throw new WebError("WEB_CHALLENGE", "ChatGPT presented a CAPTCHA or challenge");
  if (kind === "rate_limit") throw new WebError("WEB_RATE_LIMIT", "ChatGPT reported a rate limit");
  if (kind === "usage_limit") throw new WebError("WEB_RATE_LIMIT", "ChatGPT reported a usage limit");
  if (kind === "login") throw new WebError("WEB_LOGIN_EXPIRED", "ChatGPT login is required or expired");
  if (kind === "drift") throw new WebError("WEB_UI_DRIFT", "ChatGPT left chatgpt.com or the expected chat surface");
  throw new WebError("WEB_SESSION_NOT_READY", "ChatGPT Temporary Chat is not ready");
}

export async function readSnapshot(page: Page): Promise<ChatGptSnapshot> {
  return page.evaluate(extractChatGptSnapshot);
}

export async function openChatSession(input: {
  workspaceRoot?: string;
  login?: boolean;
}): Promise<{ session: PlaywrightChatSession; context: BrowserContext; page: Page }> {
  if (!input.login && !webProfileExists()) {
    throw new WebError("WEB_PROFILE_REQUIRED", "Run `c2c web login` first");
  }
  const profileDir = ensureWebProfileDir();
  const { context } = await launchWebContext({ profileDir, workspaceRoot: input.workspaceRoot });
  const page = context.pages()[0] ?? (await context.newPage());
  const session = new PlaywrightChatSession(context, page, Boolean(input.login));
  return { session, context, page };
}

export class PlaywrightChatSession implements InteractiveChatSession {
  private readonly sendGuard = new SendGuard();
  private readonly mode: WebNavigationMode;
  private drift: WebError | null = null;
  private seen: SendBaseline = { ...EMPTY_SEND_BASELINE };

  constructor(
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly loginMode: boolean
  ) {
    this.mode = loginMode ? "login" : "research";
    this.guardContext();
  }

  private failClosed(error: WebError): void {
    this.drift = error;
    void this.context.close().catch(() => undefined);
  }

  private throwIfDrifted(): void {
    if (this.drift) throw this.drift;
  }

  private guardPage(page: Page): void {
    const check = (url: string): void => {
      try {
        assertAllowedUrl(url, this.mode);
      } catch (error) {
        if (error instanceof WebError) {
          void page.close().catch(() => undefined);
          this.failClosed(error);
        }
      }
    };
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) check(frame.url());
    });
    page.on("popup", (popup) => {
      this.guardPage(popup);
      check(popup.url());
    });
    check(page.url());
  }

  private guardContext(): void {
    for (const page of this.context.pages()) this.guardPage(page);
    this.context.on("page", (page) => this.guardPage(page));
  }

  async snapshot(): Promise<ChatGptSnapshot> {
    this.throwIfDrifted();
    return readSnapshot(this.page);
  }

  async ensureReady(): Promise<ChatGptSnapshot> {
    this.throwIfDrifted();
    await this.page.goto(TEMPORARY_CHAT_URL, { waitUntil: "domcontentloaded" });
    this.throwIfDrifted();
    const deadline = Date.now() + (this.loginMode ? 10 * 60_000 : 45_000);
    while (Date.now() < deadline) {
      this.throwIfDrifted();
      const snapshot = await this.snapshot();
      const kind = classifyPage(snapshot);
      if (kind === "challenge" || kind === "rate_limit" || kind === "usage_limit") failFromSnapshot(snapshot);
      if (sessionIsReady(snapshot)) {
        this.seen = mergeSeenTurns(this.seen, snapshot);
        return snapshot;
      }
      if (!this.loginMode && kind === "login") failFromSnapshot(snapshot);
      if (!this.loginMode && kind === "drift") failFromSnapshot(snapshot);
      await this.page.waitForTimeout(750);
    }
    throw new WebError("WEB_SESSION_NOT_READY", "Could not confirm an authenticated Temporary Chat");
  }

  async sendAndWait(text: string, opts: SendWaitOptions = {}): Promise<string> {
    this.throwIfDrifted();
    this.sendGuard.assertCanSend();
    const before = await this.snapshot();
    if (!sessionIsReady(before)) failFromSnapshot(before);
    this.assertUniqueVisibleTurns(before);
    const baseline = mergeSeenTurns(this.seen, before);
    const composer = this.page.locator(SELECTORS.composer).first();
    await composer.click();
    await composer.fill(text);
    const send = this.page.locator(SELECTORS.sendButton).first();
    await send.click();
    this.sendGuard.markSent();

    const textReply = await this.waitForBoundExchange(baseline, opts, "send");
    this.sendGuard.markAcknowledged();
    return textReply;
  }

  async waitForNextManualExchange(opts: SendWaitOptions = {}): Promise<string> {
    this.throwIfDrifted();
    const before = await this.snapshot();
    if (!sessionIsReady(before)) failFromSnapshot(before);
    this.assertUniqueVisibleTurns(before);
    const baseline = mergeSeenTurns(this.seen, before);
    return this.waitForBoundExchange(
      baseline,
      { ...opts, multipleUserTurns: opts.multipleUserTurns ?? "concurrent", timeoutMs: opts.timeoutMs ?? 0 },
      "manual"
    );
  }

  private assertUniqueVisibleTurns(snapshot: ChatGptSnapshot): void {
    const baselineContainers = uniqueIds(snapshot.turnContainerIds);
    if (!baselineContainers.ok && snapshot.turnContainerIds.length > 0) {
      throw new WebError(
        baselineContainers.reason === "duplicate" ? "WEB_TURN_AMBIGUOUS" : "WEB_TURN_STATE_UNKNOWN",
        "ChatGPT turn containers were not unique; refusing to continue"
      );
    }
    const baselineAssistants = uniqueIds(snapshot.assistantTurnIds);
    if (!baselineAssistants.ok && snapshot.assistantTurnIds.length > 0) {
      throw new WebError(
        baselineAssistants.reason === "duplicate" ? "WEB_TURN_AMBIGUOUS" : "WEB_TURN_STATE_UNKNOWN",
        "ChatGPT assistant turns were not unique; refusing to continue"
      );
    }
    const baselineUsers = uniqueIds(snapshot.userTurnIds);
    if (!baselineUsers.ok && snapshot.userTurnIds.length > 0) {
      throw new WebError(
        baselineUsers.reason === "duplicate" ? "WEB_TURN_AMBIGUOUS" : "WEB_TURN_STATE_UNKNOWN",
        "ChatGPT user turns were not unique; refusing to continue"
      );
    }
  }

  private failWatchedTurn(
    watched: Extract<ReturnType<typeof watchSentTurn>, { status: "fail" }>,
    opts: SendWaitOptions,
    origin: "send" | "manual"
  ): never {
    if (watched.reason === "multiple_user_turns" && (opts.multipleUserTurns === "concurrent" || origin === "manual")) {
      throw new WebError(
        "WEB_CHAT_CONCURRENT_USER_TURN",
        "A new human user turn arrived while another exchange was still active"
      );
    }
    throw new WebError(
      watched.code,
      watched.code === "WEB_TURN_STATE_UNKNOWN"
        ? "ChatGPT UI changed after send; refusing to resend"
        : watched.code === "WEB_TURN_AMBIGUOUS"
          ? "ChatGPT turn identity was ambiguous after send"
          : watched.code === "WEB_CHALLENGE"
            ? "ChatGPT presented a CAPTCHA or challenge"
            : "ChatGPT reported a rate or usage limit"
    );
  }

  private async waitForBoundExchange(
    baseline: SendBaseline,
    opts: SendWaitOptions,
    origin: "send" | "manual"
  ): Promise<string> {
    const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : origin === "manual" ? Number.POSITIVE_INFINITY : 10 * 60_000;
    const deadline = Number.isFinite(timeoutMs) ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;
    let lastText = "";
    let stableSince = 0;
    while (Date.now() < deadline) {
      if (opts.signal?.aborted) throw new WebError("WEB_TIMEOUT", "Web session was cancelled");
      this.throwIfDrifted();
      const snapshot = await this.snapshot();
      const watched = watchSentTurn(baseline, snapshot);
      if (watched.status === "fail") this.failWatchedTurn(watched, opts, origin);
      if (watched.status === "complete") {
        if (watched.text === lastText && watched.text.trim()) {
          if (stableSince === 0) stableSince = Date.now();
          if (Date.now() - stableSince >= 1500) {
            this.seen = mergeSeenTurns(baseline, snapshot);
            return watched.text;
          }
        } else {
          lastText = watched.text;
          stableSince = 0;
        }
      } else {
        lastText = "";
        stableSince = 0;
      }
      await waitForSignal(opts.signal, 400);
    }
    throw new WebError(
      "WEB_TURN_STATE_UNKNOWN",
      origin === "manual"
        ? "Timed out waiting for a unique assistant turn after a user message"
        : "Timed out waiting for a unique assistant turn after send"
    );
  }

  async close(): Promise<void> {
    await this.context.close();
  }
}
