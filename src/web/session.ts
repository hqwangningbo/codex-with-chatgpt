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

  constructor(
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly loginMode: boolean
  ) {}

  async snapshot(): Promise<ChatGptSnapshot> {
    return readSnapshot(this.page);
  }

  async ensureReady(): Promise<ChatGptSnapshot> {
    await this.page.goto(TEMPORARY_CHAT_URL, { waitUntil: "domcontentloaded" });
    const deadline = Date.now() + (this.loginMode ? 10 * 60_000 : 45_000);
    while (Date.now() < deadline) {
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

export function allowedLoginHost(hostname: string): boolean {
  return LOGIN_HOSTS.has(hostname) || hostname.endsWith(".google.com") || hostname.endsWith(".microsoftonline.com");
}
