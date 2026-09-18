import { describe, expect, it } from "vitest";
import { SendGuard } from "../src/web/send-guard.js";
import { WebError } from "../src/web/errors.js";
import {
  classifyPage,
  sessionIsReady,
  watchSentTurn,
  type ChatGptSnapshot,
} from "../src/web/selectors.js";
import { resolveBrowserExecutable } from "../src/web/browser.js";

function snapshot(over: Partial<ChatGptSnapshot> = {}): ChatGptSnapshot {
  return {
    href: "https://chatgpt.com/?temporary-chat=true",
    origin: "https://chatgpt.com",
    composerCount: 1,
    composerDisabled: false,
    profilePresent: true,
    temporaryChat: true,
    loginSurface: false,
    challenge: false,
    rateLimit: false,
    usageLimit: false,
    turnContainerIds: [],
    userTurnIds: [],
    assistantTurnIds: [],
    stopVisible: false,
    streaming: false,
    assistantTextById: {},
    ...over,
  };
}

describe("ChatGPT page fixtures", () => {
  it("classifies login, ready Temporary Chat, missing composer, and disabled composer", () => {
    expect(classifyPage(snapshot({ href: "https://chatgpt.com/auth/login", loginSurface: true }))).toBe("login");
    expect(sessionIsReady(snapshot())).toBe(true);
    expect(sessionIsReady(snapshot({ composerCount: 0 }))).toBe(false);
    expect(sessionIsReady(snapshot({ composerDisabled: true }))).toBe(false);
    expect(sessionIsReady(snapshot({ temporaryChat: false }))).toBe(false);
  });

  it("fail-closes CAPTCHA, rate-limit, and UI drift", () => {
    expect(classifyPage(snapshot({ challenge: true }))).toBe("challenge");
    expect(classifyPage(snapshot({ rateLimit: true }))).toBe("rate_limit");
    expect(classifyPage(snapshot({ origin: "https://example.com", href: "https://example.com/" }))).toBe("drift");
  });

  it("waits through streaming and remounts, and rejects duplicate turn ids", () => {
    const baseline = ["old-turn"];
    expect(
      watchSentTurn(
        baseline,
        snapshot({
          assistantTurnIds: ["old-turn", "new-turn"],
          streaming: true,
          assistantTextById: { "new-turn": "partial" },
        })
      ).status
    ).toBe("waiting");
    expect(
      watchSentTurn(
        baseline,
        snapshot({
          assistantTurnIds: ["old-turn", "new-turn"],
          stopVisible: true,
          assistantTextById: { "new-turn": "almost" },
        })
      ).status
    ).toBe("waiting");
    expect(
      watchSentTurn(
        baseline,
        snapshot({
          assistantTurnIds: ["new-turn"],
          assistantTextById: { "new-turn": "final answer" },
        })
      )
    ).toMatchObject({ status: "complete", id: "new-turn", text: "final answer" });
    expect(
      watchSentTurn(
        baseline,
        snapshot({
          assistantTurnIds: ["old-turn", "new-turn", "new-turn"],
          assistantTextById: { "new-turn": "dup" },
        })
      )
    ).toMatchObject({ status: "fail", code: "WEB_TURN_AMBIGUOUS" });
    expect(watchSentTurn(baseline, snapshot({ assistantTurnIds: ["old-turn"] })).status).toBe("waiting");
  });

  it("treats login or drift after send as WEB_TURN_STATE_UNKNOWN", () => {
    expect(
      watchSentTurn(
        [],
        snapshot({ href: "https://chatgpt.com/auth/login", loginSurface: true })
      )
    ).toMatchObject({ status: "fail", code: "WEB_TURN_STATE_UNKNOWN" });
    expect(
      watchSentTurn([], snapshot({ origin: "https://evil.example", href: "https://evil.example/" }))
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
});
