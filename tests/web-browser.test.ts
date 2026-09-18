import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SendGuard } from "../src/web/send-guard.js";
import { WebError } from "../src/web/errors.js";
import {
  classifyPage,
  isTemporaryChatProven,
  sessionIsReady,
  watchSentTurn,
  mergeSeenTurns,
  copySendBaseline,
  newBoundUserTurns,
  checkConcurrentUser,
  type ChatGptSnapshot,
  type SendBaseline,
} from "../src/web/selectors.js";
import { waitForSignal, PlaywrightChatSession, isTransientNavigationSnapshotError } from "../src/web/session.js";
import { resolveBrowserExecutable } from "../src/web/browser.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function snapshot(over: Partial<ChatGptSnapshot> = {}): ChatGptSnapshot {
  return {
    href: "https://chatgpt.com/?temporary-chat=true",
    origin: "https://chatgpt.com",
    composerCount: 1,
    composerDisabled: false,
    profilePresent: true,
    temporaryChat: true,
    temporaryTogglePressed: false,
    loginSurface: false,
    challenge: false,
    rateLimit: false,
    usageLimit: false,
    turnContainerIds: [],
    userTurnIds: [],
    assistantTurnIds: [],
    assistantIdByContainer: {},
    userIdByContainer: {},
    stopVisible: false,
    streaming: false,
    assistantTextById: {},
    ...over,
  };
}

function baseline(over: Partial<SendBaseline> = {}): SendBaseline {
  return { assistantTurnIds: [], turnContainerIds: [], userTurnIds: [], userIdByContainer: {}, ...over };
}

describe("ChatGPT page fixtures", () => {
  it("classifies login, ready Temporary Chat, missing composer, and disabled composer", () => {
    expect(classifyPage(snapshot({ href: "https://chatgpt.com/auth/login", loginSurface: true }))).toBe("login");
    expect(sessionIsReady(snapshot())).toBe(true);
    expect(sessionIsReady(snapshot({ composerCount: 0 }))).toBe(false);
    expect(sessionIsReady(snapshot({ composerDisabled: true }))).toBe(false);
    expect(
      sessionIsReady(
        snapshot({
          href: "https://chatgpt.com/",
          temporaryChat: false,
          temporaryTogglePressed: false,
        })
      )
    ).toBe(false);
  });

  it("proves Temporary Chat only from the URL or an explicit pressed toggle", () => {
    expect(isTemporaryChatProven(snapshot())).toBe(true);
    expect(
      isTemporaryChatProven(
        snapshot({
          href: "https://chatgpt.com/",
          temporaryChat: true,
          temporaryTogglePressed: false,
        })
      )
    ).toBe(false);
    expect(
      isTemporaryChatProven(
        snapshot({
          href: "https://chatgpt.com/",
          temporaryTogglePressed: true,
        })
      )
    ).toBe(true);
    expect(
      sessionIsReady(
        snapshot({
          href: "https://chatgpt.com/",
          temporaryChat: true,
          temporaryTogglePressed: false,
        })
      )
    ).toBe(false);
  });

  it("fail-closes CAPTCHA, rate-limit, and UI drift", () => {
    expect(classifyPage(snapshot({ challenge: true }))).toBe("challenge");
    expect(classifyPage(snapshot({ rateLimit: true }))).toBe("rate_limit");
    expect(classifyPage(snapshot({ origin: "https://example.com", href: "https://example.com/" }))).toBe("drift");
  });

  it("binds completion to a unique new logical container, not a remounted assistant", () => {
    const before = baseline({
      assistantTurnIds: ["old-turn"],
      turnContainerIds: ["c-old", "c-hidden"],
      userTurnIds: ["u-old"],
      userIdByContainer: { "c-old": "u-old" },
    });
    expect(
      watchSentTurn(
        before,
        snapshot({
          userTurnIds: ["u-old", "u-new"],
          turnContainerIds: ["c-old", "c-hidden", "c-new"],
          assistantTurnIds: ["old-turn", "new-turn"],
          userIdByContainer: { "c-old": "u-old", "c-new": "u-new" },
          assistantIdByContainer: { "c-old": "old-turn", "c-new": "new-turn" },
          streaming: true,
          assistantTextById: { "new-turn": "partial" },
        })
      ).status
    ).toBe("waiting");
    expect(
      watchSentTurn(
        before,
        snapshot({
          userTurnIds: ["u-old", "u-new"],
          turnContainerIds: ["c-old", "c-hidden", "c-new"],
          assistantTurnIds: ["old-turn", "new-turn"],
          userIdByContainer: { "c-old": "u-old", "c-new": "u-new" },
          assistantIdByContainer: { "c-old": "old-turn", "c-new": "new-turn" },
          assistantTextById: { "new-turn": "final answer" },
        })
      )
    ).toMatchObject({ status: "complete", id: "new-turn", text: "final answer" });
  });

  it("does not treat a virtualized old assistant remount as this send's reply", () => {
    const before = baseline({ assistantTurnIds: ["visible-old"], turnContainerIds: ["c-visible", "c-hidden"] });
    const remounted = watchSentTurn(
      before,
      snapshot({
        turnContainerIds: ["c-visible", "c-hidden"],
        assistantTurnIds: ["visible-old", "hidden-old"],
        assistantIdByContainer: { "c-visible": "visible-old", "c-hidden": "hidden-old" },
        assistantTextById: {
          "visible-old": "old visible",
          "hidden-old": "<C2C_ACTION>{\"type\":\"final\",\"summary\":\"stale\"}</C2C_ACTION>",
        },
      })
    );
    expect(remounted.status).toBe("waiting");
  });

  it("does not treat DOM reorder or remount of the same containers as a new action", () => {
    const before = baseline({ assistantTurnIds: ["a", "b"], turnContainerIds: ["c-a", "c-b"] });
    expect(
      watchSentTurn(
        before,
        snapshot({
          turnContainerIds: ["c-b", "c-a"],
          assistantTurnIds: ["b", "a"],
          assistantIdByContainer: { "c-a": "a", "c-b": "b" },
          assistantTextById: { a: "one", b: "two" },
        })
      ).status
    ).toBe("waiting");
  });

  it("fail-closes when a unique new assistant turn cannot be proven", () => {
    const before = baseline({ assistantTurnIds: ["old-turn"], turnContainerIds: ["c-old"] });
    expect(
      watchSentTurn(
        before,
        snapshot({
          turnContainerIds: ["c-old", "c-new", "c-new"],
          assistantTurnIds: ["old-turn", "new-turn"],
          assistantIdByContainer: { "c-old": "old-turn", "c-new": "new-turn" },
          assistantTextById: { "new-turn": "dup container" },
        })
      )
    ).toMatchObject({ status: "fail", code: "WEB_TURN_AMBIGUOUS" });
    expect(
      watchSentTurn(
        before,
        snapshot({
          userTurnIds: ["u-new"],
          turnContainerIds: ["c-old", "c-new-1", "c-new-2"],
          assistantTurnIds: ["old-turn", "n1", "n2"],
          userIdByContainer: { "c-new-1": "u-new" },
          assistantIdByContainer: { "c-old": "old-turn", "c-new-1": "n1", "c-new-2": "n2" },
          assistantTextById: { n1: "one", n2: "two" },
        })
      )
    ).toMatchObject({ status: "fail", code: "WEB_TURN_AMBIGUOUS" });
    expect(
      watchSentTurn(
        before,
        snapshot({
          turnContainerIds: ["c-old", ""],
          assistantTurnIds: ["old-turn", "new-turn"],
          assistantIdByContainer: { "c-old": "old-turn" },
          assistantTextById: { "new-turn": "missing container id" },
        })
      )
    ).toMatchObject({ status: "fail", code: "WEB_TURN_STATE_UNKNOWN" });
    expect(
      watchSentTurn(
        before,
        snapshot({
          turnContainerIds: ["c-old", "c-new"],
          assistantTurnIds: ["old-turn", "old-turn"],
          assistantIdByContainer: { "c-new": "old-turn" },
          assistantTextById: { "old-turn": "moved" },
        })
      )
    ).toMatchObject({ status: "fail", code: "WEB_TURN_AMBIGUOUS" });
    expect(
      watchSentTurn(
        before,
        snapshot({
          userTurnIds: ["u-new"],
          turnContainerIds: ["c-old", "c-new"],
          assistantTurnIds: ["old-turn"],
          userIdByContainer: { "c-new": "u-new" },
          assistantIdByContainer: { "c-new": "old-turn" },
          assistantTextById: { "old-turn": "same id in new container" },
        })
      )
    ).toMatchObject({ status: "fail", code: "WEB_TURN_STATE_UNKNOWN" });
  });

  it("detects a user turn that arrived before passive wait starts", () => {
    const seen = baseline({
      userTurnIds: ["u-boot"],
      turnContainerIds: ["c-boot"],
      assistantTurnIds: ["a-boot"],
      userIdByContainer: { "c-boot": "u-boot" },
    });
    const early = snapshot({
      userTurnIds: ["u-boot", "u-early"],
      turnContainerIds: ["c-boot", "c-early"],
      assistantTurnIds: ["a-boot", "a-early"],
      userIdByContainer: { "c-boot": "u-boot", "c-early": "u-early" },
      assistantIdByContainer: { "c-boot": "a-boot", "c-early": "a-early" },
      assistantTextById: { "a-early": "early reply" },
    });
    expect(watchSentTurn(seen, early)).toMatchObject({ status: "complete", id: "a-early", text: "early reply" });
    expect(watchSentTurn(mergeSeenTurns(seen, early), early).status).toBe("waiting");
    expect(watchSentTurn(copySendBaseline(seen), early)).toMatchObject({ status: "complete", id: "a-early" });
  });

  it("does not treat an old-container user remount as a new human turn", () => {
    const before = baseline({
      userTurnIds: ["u-visible"],
      turnContainerIds: ["c-visible", "c-hidden"],
      assistantTurnIds: ["a-visible"],
      userIdByContainer: { "c-visible": "u-visible" },
    });
    const after = snapshot({
        userTurnIds: ["u-visible", "u-hidden"],
        turnContainerIds: ["c-visible", "c-hidden"],
        assistantTurnIds: ["a-visible", "a-hidden"],
        userIdByContainer: { "c-visible": "u-visible", "c-hidden": "u-hidden" },
        assistantIdByContainer: { "c-visible": "a-visible", "c-hidden": "a-hidden" },
        assistantTextById: { "a-hidden": "stale user remount" },
      });
    expect(watchSentTurn(before, after).status).toBe("waiting");
    expect(newBoundUserTurns(before, after)).toEqual([]);
    expect(checkConcurrentUser(before, after).status).toBe("clear");
  });

  it("fail-closes concurrent checks when container identity is missing or duplicate", () => {
    const before = baseline({
      userTurnIds: ["u-1"],
      turnContainerIds: ["c-1"],
      userIdByContainer: { "c-1": "u-1" },
    });
    const duplicate = snapshot({
      userTurnIds: ["u-1", "u-2"],
      turnContainerIds: ["c-1", "c-2", "c-2"],
      userIdByContainer: { "c-1": "u-1", "c-2": "u-2" },
    });
    expect(newBoundUserTurns(before, duplicate)).toEqual([]);
    expect(checkConcurrentUser(before, duplicate)).toMatchObject({
      status: "fail",
      code: "WEB_TURN_AMBIGUOUS",
    });
    const missing = snapshot({
      userTurnIds: ["u-1", "u-2"],
      turnContainerIds: ["c-1", ""],
      userIdByContainer: { "c-1": "u-1" },
    });
    expect(newBoundUserTurns(before, missing)).toEqual([]);
    expect(checkConcurrentUser(before, missing)).toMatchObject({
      status: "fail",
      code: "WEB_TURN_STATE_UNKNOWN",
    });
    const unbound = snapshot({
      userTurnIds: ["u-1", "u-2"],
      turnContainerIds: ["c-1"],
      userIdByContainer: { "c-1": "u-1" },
    });
    expect(checkConcurrentUser(before, unbound)).toMatchObject({
      status: "fail",
      code: "WEB_TURN_STATE_UNKNOWN",
    });
    const concurrent = snapshot({
      userTurnIds: ["u-1", "u-2"],
      turnContainerIds: ["c-1", "c-2"],
      userIdByContainer: { "c-1": "u-1", "c-2": "u-2" },
    });
    expect(checkConcurrentUser(before, concurrent).status).toBe("concurrent");
  });

  it("treats login or drift after send as WEB_TURN_STATE_UNKNOWN", () => {
    expect(
      watchSentTurn(
        baseline(),
        snapshot({ href: "https://chatgpt.com/auth/login", loginSurface: true })
      )
    ).toMatchObject({ status: "fail", code: "WEB_TURN_STATE_UNKNOWN" });
    expect(
      watchSentTurn(baseline(), snapshot({ origin: "https://evil.example", href: "https://evil.example/" }))
    ).toMatchObject({ status: "fail", code: "WEB_TURN_STATE_UNKNOWN" });
  });
});

describe("duplicate-send guard", () => {
  it("refuses a second send when the previous click was not acknowledged", () => {
    const guard = new SendGuard();
    guard.assertCanSend();
    guard.markSent();
    expect(() => guard.assertCanSend()).toThrow(WebError);
    try {
      guard.assertCanSend();
    } catch (error) {
      expect((error as WebError).code).toBe("WEB_TURN_STATE_UNKNOWN");
    }
    guard.markAcknowledged();
    expect(() => guard.assertCanSend()).not.toThrow();
  });

  it("removes abort listeners when waitForSignal resolves", async () => {
    const ac = new AbortController();
    let removed = 0;
    const orig = ac.signal.removeEventListener.bind(ac.signal);
    ac.signal.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
      if (type === "abort") removed += 1;
      return orig(type, listener, options);
    }) as AbortSignal["removeEventListener"];
    await waitForSignal(ac.signal, 15);
    expect(removed).toBe(1);
    ac.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it("does not merge the current snapshot into the passive wait baseline", () => {
    const source = fs.readFileSync(path.join(root, "src/web/session.ts"), "utf8");
    const passive = source.split("async waitForNextManualExchange")[1]?.split("private assertUniqueVisibleTurns")[0] ?? "";
    expect(passive).toContain("copySendBaseline(this.seen)");
    expect(passive).not.toContain("mergeSeenTurns(this.seen, before)");
  });
});

describe("browser executable policy", () => {
  it("rejects a Workspace-provided fake Chrome", () => {
    const previous = process.env.C2C_BROWSER_PATH;
    const fake = "/Volumes/project/codex-with-chatgpt/package.json";
    process.env.C2C_BROWSER_PATH = fake;
    try {
      expect(() => resolveBrowserExecutable("/Volumes/project/codex-with-chatgpt")).toThrow(WebError);
    } finally {
      if (previous === undefined) delete process.env.C2C_BROWSER_PATH;
      else process.env.C2C_BROWSER_PATH = previous;
    }
  });

  it("does not hide Playwright automation identity", () => {
    const source = fs.readFileSync(path.join(root, "src/web/browser.ts"), "utf8");
    expect(source).not.toContain("AutomationControlled");
    expect(source).not.toContain("ignoreDefaultArgs");
    expect(source).not.toContain("disable-blink-features");
  });
});

describe("Temporary Chat extractor contract", () => {
  it("does not treat Temporary button text as proof", () => {
    const source = fs.readFileSync(path.join(root, "src/web/selectors.ts"), "utf8");
    expect(source).not.toMatch(/temporary\/i\.test\(\s*el\.textContent/);
    expect(source).not.toContain("el.textContent ?? \"\"");
  });
});

describe("browser navigation allowlist", () => {
  it("allows login hosts and denies off-domain pages and popups", async () => {
    const { navigationDecision } = await import("../src/web/session.js");
    expect(navigationDecision("https://chatgpt.com/?temporary-chat=true", "login")).toBe("allow");
    expect(navigationDecision("https://www.chatgpt.com/", "login")).toBe("allow");
    expect(navigationDecision("https://auth.openai.com/authorize", "login")).toBe("allow");
    expect(navigationDecision("https://accounts.google.com/o/oauth2", "login")).toBe("allow");
    expect(navigationDecision("https://oauth.google.com/auth", "login")).toBe("allow");
    expect(navigationDecision("https://login.microsoftonline.com/common", "login")).toBe("allow");
    expect(navigationDecision("https://contoso.microsoftonline.com/", "login")).toBe("allow");
    expect(navigationDecision("https://appleid.apple.com/auth/authorize", "login")).toBe("allow");
    expect(navigationDecision("about:blank", "login")).toBe("ignore");
    expect(navigationDecision("https://evil.example/popup", "login")).toBe("deny");
    expect(navigationDecision("https://bing.com/search?q=chatgpt", "login")).toBe("deny");
    expect(navigationDecision("https://login.live.com/", "login")).toBe("deny");
  });

  it("restricts research navigation to chatgpt.com, including popups", async () => {
    const { navigationDecision } = await import("../src/web/session.js");
    expect(navigationDecision("https://chatgpt.com/?temporary-chat=true", "research")).toBe("allow");
    expect(navigationDecision("https://www.chatgpt.com/", "research")).toBe("allow");
    expect(navigationDecision("https://auth.openai.com/authorize", "research")).toBe("deny");
    expect(navigationDecision("https://accounts.google.com/o/oauth2", "research")).toBe("deny");
    expect(navigationDecision("https://www.google.com/search?q=erc-7540", "research")).toBe("deny");
    expect(navigationDecision("https://evil.example/popup", "research")).toBe("deny");
    const source = fs.readFileSync(path.join(root, "src/web/session.ts"), "utf8");
    expect(source).toContain('context.on("page"');
    expect(source).toContain("popup");
    expect(source).toContain("assertAllowedUrl");
  });

  it("denies http navigation even for allowlisted hosts", async () => {
    const { navigationDecision } = await import("../src/web/session.js");
    expect(navigationDecision("http://chatgpt.com/", "login")).toBe("deny");
    expect(navigationDecision("http://chatgpt.com/", "research")).toBe("deny");
    expect(navigationDecision("http://auth.openai.com/authorize", "login")).toBe("deny");
    expect(navigationDecision("http://accounts.google.com/o/oauth2", "login")).toBe("deny");
    expect(navigationDecision("https://chatgpt.com/", "research")).toBe("allow");
    expect(navigationDecision("https://auth.openai.com/authorize", "login")).toBe("allow");
    expect(navigationDecision("https://accounts.google.com/o/oauth2", "login")).toBe("allow");
  });
});

const NAV_DESTROYED = "page.evaluate: Execution context was destroyed, most likely because of a navigation";

function loginSnapshot(): ChatGptSnapshot {
  return snapshot({
    href: "https://chatgpt.com/auth/login",
    origin: "https://chatgpt.com",
    composerCount: 0,
    profilePresent: false,
    temporaryChat: false,
    loginSurface: true,
  });
}

function fakeLoginSession(evaluate: () => Promise<ChatGptSnapshot>) {
  let href = "https://chatgpt.com/?temporary-chat=true";
  const mainFrame = { url: () => href };
  const frameNav: Array<(frame: typeof mainFrame) => void> = [];
  const page = {
    url: () => href,
    mainFrame: () => mainFrame,
    on(event: string, handler: (frame: typeof mainFrame) => void) {
      if (event === "framenavigated") frameNav.push(handler);
    },
    goto: async () => undefined,
    waitForTimeout: async () => undefined,
    close: async () => undefined,
    evaluate,
  };
  const context = {
    pages: () => [page],
    on: () => undefined,
    close: async () => undefined,
  };
  const session = new PlaywrightChatSession(context as never, page as never, true);
  return {
    session,
    navigate(url: string) {
      href = url;
      for (const handler of frameNav) handler(mainFrame);
    },
  };
}

describe("login snapshot navigation race", () => {
  it("matches only explicit navigation context destruction", () => {
    expect(isTransientNavigationSnapshotError(new Error(NAV_DESTROYED))).toBe(true);
    expect(isTransientNavigationSnapshotError(new Error("Cannot find context with specified id"))).toBe(true);
    expect(isTransientNavigationSnapshotError(new Error("frame context was destroyed due to navigation"))).toBe(true);
    expect(isTransientNavigationSnapshotError(new Error("page.evaluate: boom"))).toBe(false);
    expect(isTransientNavigationSnapshotError(new Error("Target closed"))).toBe(false);
    expect(
      isTransientNavigationSnapshotError(
        new Error("page.evaluate: Target page, context or browser has been closed")
      )
    ).toBe(false);
    expect(isTransientNavigationSnapshotError(new Error("Timeout 30000ms exceeded"))).toBe(false);
    expect(isTransientNavigationSnapshotError(new WebError("WEB_UI_DRIFT", "Blocked navigation"))).toBe(false);
    expect(isTransientNavigationSnapshotError(new WebError("WEB_CHALLENGE", "challenge"))).toBe(false);
    expect(isTransientNavigationSnapshotError(new WebError("WEB_RATE_LIMIT", "rate"))).toBe(false);
    expect(isTransientNavigationSnapshotError(new WebError("WEB_LOGIN_EXPIRED", "login"))).toBe(false);
  });

  it("retries a destroyed execution context until Temporary Chat is ready", async () => {
    const replies: Array<Error | ChatGptSnapshot> = [
      new Error(NAV_DESTROYED),
      loginSnapshot(),
      snapshot(),
    ];
    const { session } = fakeLoginSession(async () => {
      const next = replies.shift();
      if (next instanceof Error) throw next;
      if (!next) throw new Error("unexpected extra snapshot");
      return next;
    });
    await expect(session.ensureReady()).resolves.toMatchObject({
      href: "https://chatgpt.com/?temporary-chat=true",
      profilePresent: true,
    });
    expect(replies).toEqual([]);
  });

  it("keeps retrying consecutive transient navigation errors", async () => {
    const replies: Array<Error | ChatGptSnapshot> = [
      new Error(NAV_DESTROYED),
      new Error("Cannot find context with specified id"),
      snapshot(),
    ];
    const { session } = fakeLoginSession(async () => {
      const next = replies.shift();
      if (next instanceof Error) throw next;
      if (!next) throw new Error("unexpected extra snapshot");
      return next;
    });
    await expect(session.ensureReady()).resolves.toMatchObject({ profilePresent: true });
    expect(replies).toEqual([]);
  });

  it("throws an unknown evaluate error immediately", async () => {
    const { session } = fakeLoginSession(async () => {
      throw new Error("page.evaluate: unexpected crash");
    });
    await expect(session.ensureReady()).rejects.toThrow("page.evaluate: unexpected crash");
  });

  it("fail-closes WEB_UI_DRIFT set during a transient navigation error", async () => {
    let navigate = (_url: string): void => undefined;
    const fake = fakeLoginSession(async () => {
      navigate("https://evil.example/popup");
      throw new Error(NAV_DESTROYED);
    });
    navigate = fake.navigate;
    await expect(fake.session.ensureReady()).rejects.toMatchObject({
      code: "WEB_UI_DRIFT",
    });
  });

  it("does not treat a closed target as a retryable navigation", async () => {
    const { session } = fakeLoginSession(async () => {
      throw new Error("page.evaluate: Target page, context or browser has been closed");
    });
    await expect(session.ensureReady()).rejects.toThrow(/Target page, context or browser has been closed/);
  });

  it("retries navigation races only in ensureReady, not send or tool-chain waits", () => {
    const source = fs.readFileSync(path.join(root, "src/web/session.ts"), "utf8");
    const ready = source.split("async ensureReady")[1]?.split("async sendAndWait")[0] ?? "";
    const send = source.split("async sendAndWait")[1]?.split("async waitForNextManualExchange")[0] ?? "";
    const bound = source.split("private async waitForBoundExchange")[1] ?? "";
    expect(ready).toContain("isTransientNavigationSnapshotError");
    expect(send).not.toContain("isTransientNavigationSnapshotError");
    expect(bound).not.toContain("isTransientNavigationSnapshotError");
  });
});

