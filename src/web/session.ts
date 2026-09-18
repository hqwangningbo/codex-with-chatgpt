import type { BrowserContext, Page } from "playwright-core";
import { WebError } from "./errors.js";
import { launchWebContext } from "./browser.js";
import { ensureWebProfileDir, webProfileExists } from "./profile.js";
import {
  TEMPORARY_CHAT_URL,
  classifyPage,
  extractChatGptSnapshot,
  sessionIsReady,
  sendBaselineFrom,
  uniqueIds,
  watchSentTurn,
  type ChatGptSnapshot,
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
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "deny";
  const host = parsed.hostname;
  if (!host) return "deny";
  if (mode === "research") return allowedResearchHost(host) ? "allow" : "deny";
  return allowedLoginHost(host) ? "allow" : "deny";
}

function assertAllowedUrl(url: string, mode: WebNavigationMode): void {
  if (navigationDecision(url, mode) === "deny") {
    throw new WebError("WEB_UI_DRIFT", `Blocked navigation to ${url}`);
  }
}

export interface ChatSession {
  snapshot(): Promise<ChatGptSnapshot>;
  ensureReady(): Promise<ChatGptSnapshot>;
  sendAndWait(text: string, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<string>;
  close(): Promise<void>;
}

async function waitForSignal(signal: AbortSignal | undefined, ms: number): Promise<void> {
  if (signal?.aborted) throw new WebError("WEB_TIMEOUT", "Research was cancelled");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new WebError("WEB_TIMEOUT", "Research was cancelled"));
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

export class PlaywrightChatSession implements ChatSession {
  private readonly sendGuard = new SendGuard();
  private readonly mode: WebNavigationMode;
  private drift: WebError | null = null;

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
      if (sessionIsReady(snapshot)) return snapshot;
      if (!this.loginMode && kind === "login") failFromSnapshot(snapshot);
      if (!this.loginMode && kind === "drift") failFromSnapshot(snapshot);
      await this.page.waitForTimeout(750);
    }
    throw new WebError("WEB_SESSION_NOT_READY", "Could not confirm an authenticated Temporary Chat");
  }

  async sendAndWait(text: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<string> {
    this.throwIfDrifted();
    this.sendGuard.assertCanSend();
    const before = await this.snapshot();
    if (!sessionIsReady(before)) failFromSnapshot(before);
    const baselineContainers = uniqueIds(before.turnContainerIds);
    if (!baselineContainers.ok && before.turnContainerIds.length > 0) {
      throw new WebError(
        baselineContainers.reason === "duplicate" ? "WEB_TURN_AMBIGUOUS" : "WEB_TURN_STATE_UNKNOWN",
        "ChatGPT turn containers were not unique before send; refusing to send"
      );
    }
    const baselineAssistants = uniqueIds(before.assistantTurnIds);
    if (!baselineAssistants.ok && before.assistantTurnIds.length > 0) {
      throw new WebError(
        baselineAssistants.reason === "duplicate" ? "WEB_TURN_AMBIGUOUS" : "WEB_TURN_STATE_UNKNOWN",
        "ChatGPT assistant turns were not unique before send; refusing to send"
      );
    }
    const baseline = sendBaselineFrom(before);
    const composer = this.page.locator(SELECTORS.composer).first();
    await composer.click();
    await composer.fill(text);
    const send = this.page.locator(SELECTORS.sendButton).first();
    await send.click();
    this.sendGuard.markSent();

    const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
    const deadline = Date.now() + timeoutMs;
    let lastText = "";
    let stableSince = 0;
    while (Date.now() < deadline) {
      if (opts.signal?.aborted) throw new WebError("WEB_TIMEOUT", "Research was cancelled");
      this.throwIfDrifted();
      const snapshot = await this.snapshot();
      const watched = watchSentTurn(baseline, snapshot);
      if (watched.status === "fail") {
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
      if (watched.status === "complete") {
        if (watched.text === lastText && watched.text.trim()) {
          if (stableSince === 0) stableSince = Date.now();
          if (Date.now() - stableSince >= 1500) {
            this.sendGuard.markAcknowledged();
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
    throw new WebError("WEB_TURN_STATE_UNKNOWN", "Timed out waiting for a unique assistant turn after send");
  }

  async close(): Promise<void> {
    await this.context.close();
  }
}
