import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { Workspace } from "../src/workspace/manager.js";
import { clearWriteScope, setWriteScope } from "../src/write-scope/state.js";
import { captureCapabilitySnapshot } from "../src/web/dispatcher.js";
import { WebError } from "../src/web/errors.js";
import {
  ACTION_CLOSE,
  ACTION_OPEN,
  parseChatAssistantAction,
  WEB_CHAT_PROTOCOL,
  WEB_PROTOCOL,
} from "../src/web/protocol.js";
import { CHAT_READY } from "../src/web/prompt.js";
import { runWebChat } from "../src/web/chat-turn.js";
import type { InteractiveChatSession } from "../src/web/session.js";
import type { ChatGptSnapshot } from "../src/web/selectors.js";
import { watchSentTurn } from "../src/web/selectors.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

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
    stopVisible: false,
    streaming: false,
    assistantTextById: {},
    ...over,
  };
}

function chatEnvelope(
  sessionId: string,
  tool: string,
  args: Record<string, unknown>,
  callId: string
): string {
  return `${ACTION_OPEN}\n${JSON.stringify({
    protocol: WEB_CHAT_PROTOCOL,
    session_id: sessionId,
    type: "tool_call",
    call_id: callId,
    tool,
    arguments: args,
  })}\n${ACTION_CLOSE}`;
}

type Scripted = string | ((sessionId: string) => string);

class FakeChatSession implements InteractiveChatSession {
  sent: string[] = [];
  sessionId = "";
  sendReplies: Scripted[] = [];
  humanQueue: Scripted[] = [];
  userTurns: string[] = [];
  injectAfterSnapshots = -1;
  concurrentOnNextHuman = false;
  onAfterBootstrap?: () => void;
  private n = 0;

  constructor(private readonly ac: AbortController) {}

  private resolve(item: Scripted): string {
    return typeof item === "function" ? item(this.sessionId) : item;
  }

  async snapshot(): Promise<ChatGptSnapshot> {
    if (this.injectAfterSnapshots === 0) {
      this.injectAfterSnapshots = -1;
      this.userTurns.push("u-concurrent");
    } else if (this.injectAfterSnapshots > 0) {
      this.injectAfterSnapshots -= 1;
    }
    return snapshot({ userTurnIds: [...this.userTurns] });
  }

  async ensureReady(): Promise<ChatGptSnapshot> {
    return snapshot({ userTurnIds: [...this.userTurns] });
  }

  async sendAndWait(text: string): Promise<string> {
    this.sent.push(text);
    const match = text.match(/^session_id: (\S+)$/m);
    if (match) this.sessionId = match[1];
    this.userTurns.push(`u-harness-${this.n++}`);
    const next = this.sendReplies.shift();
    if (next === undefined) throw new Error("no scripted send reply");
    const reply = this.resolve(next);
    if (this.sent.length === 1) this.onAfterBootstrap?.();
    return reply;
  }

  async waitForNextManualExchange(): Promise<string> {
    const next = this.humanQueue.shift();
    if (next === undefined) {
      this.ac.abort();
      throw new WebError("WEB_TIMEOUT", "Web session was cancelled");
    }
    this.userTurns.push(`u-human-${this.n++}`);
    if (this.concurrentOnNextHuman) this.injectAfterSnapshots = 1;
    return this.resolve(next);
  }

  async close(): Promise<void> {}
}

async function runScriptedChat(input: {
  root: string;
  sendReplies: Scripted[];
  humanQueue?: Scripted[];
  injectConcurrentAfterSync?: boolean;
  onAfterBootstrap?: () => void;
}): Promise<{ result: Awaited<ReturnType<typeof runWebChat>>; session: FakeChatSession }> {
  const ac = new AbortController();
  const session = new FakeChatSession(ac);
  session.sendReplies = [...input.sendReplies];
  session.humanQueue = [...(input.humanQueue ?? [])];
  session.onAfterBootstrap = input.onAfterBootstrap;
  session.concurrentOnNextHuman = Boolean(input.injectConcurrentAfterSync);
  const result = await runWebChat({
    workspace: new Workspace(input.root),
    session,
    signal: ac.signal,
  });
  return { result, session };
}

describe("web chat protocol strictness", () => {
  const sessionId = "c2c_wc_testsessionid";

  it("executes only when the trimmed assistant response is exactly one envelope", () => {
    const exact = chatEnvelope(sessionId, "read_file", { path: "README.md" }, "c1");
    expect(parseChatAssistantAction(exact, sessionId, new Set())).toMatchObject({
      ok: true,
      action: { tool: "read_file", call_id: "c1" },
    });
    const embedded = `下面是一个例子：\n${exact}`;
    expect(parseChatAssistantAction(embedded, sessionId, new Set())).toEqual({ ok: false, kind: "prose" });
    expect(parseChatAssistantAction("ordinary prose with no marker", sessionId, new Set())).toEqual({
      ok: false,
      kind: "prose",
    });
  });

  it("treats exact but invalid envelopes as malformed, not prose", () => {
    expect(parseChatAssistantAction(`${ACTION_OPEN}{not json}${ACTION_CLOSE}`, sessionId, new Set())).toMatchObject({
      ok: false,
      kind: "malformed",
    });
    expect(
      parseChatAssistantAction(chatEnvelope(sessionId, "shell", {}, "c-shell"), sessionId, new Set())
    ).toMatchObject({
      ok: false,
      kind: "malformed",
      message: expect.stringMatching(/shell/),
    });
    expect(
      parseChatAssistantAction(
        `${ACTION_OPEN}\n${JSON.stringify({
          protocol: WEB_PROTOCOL,
          request_id: "c2c_wr_x",
          type: "final",
          summary: "nope",
        })}\n${ACTION_CLOSE}`,
        sessionId,
        new Set()
      )
    ).toMatchObject({ ok: false, kind: "malformed" });
  });
});

describe("web chat loop", () => {
  let stateDir: string;
  let root: string;

  beforeAll(() => {
    stateDir = isolateStateDir();
    root = makeTmpDir("web-chat");
    write(root, "README.md", "# hello\n");
    write(root, "src/a.ts", "export const n = 1;\n");
  });

  afterAll(() => {
    cleanup(root);
    cleanup(stateDir);
  });

  it("bootstraps, requires C2C CHAT READY, and does not call tools", async () => {
    const { result, session } = await runScriptedChat({
      root,
      sendReplies: [CHAT_READY],
    });
    expect(result.status).toBe("interrupted");
    expect(session.sent).toHaveLength(1);
    expect(session.sent[0]).toContain("C2C Interactive Web Chat");
    expect(session.sent[0]).toContain(WEB_CHAT_PROTOCOL);
    expect(session.sent.join("\n")).not.toContain("<C2C_TOOL_RESULT>");
  });

  it("ignores ordinary assistant prose and waits for the next human turn", async () => {
    const { session } = await runScriptedChat({
      root,
      sendReplies: [CHAT_READY],
      humanQueue: ["当前仓库的 reserve 研究还在早期。"],
    });
    expect(session.sent).toHaveLength(1);
    expect(session.sent.join("\n")).not.toContain("<C2C_TOOL_RESULT>");
  });

  it("does not execute an envelope quoted inside ordinary prose", async () => {
    const { session } = await runScriptedChat({
      root,
      sendReplies: [CHAT_READY],
      humanQueue: [
        (id) => `下面是一个例子：\n${chatEnvelope(id, "read_file", { path: "README.md" }, "quoted")}`,
      ],
    });
    expect(session.sent).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, "README.md"), "utf8")).toBe("# hello\n");
  });

  it("runs a read_file tool chain then returns to listening after prose", async () => {
    const { session } = await runScriptedChat({
      root,
      sendReplies: [CHAT_READY, "README 里写着 hello。"],
      humanQueue: [(id) => chatEnvelope(id, "read_file", { path: "README.md" }, "read-1")],
    });
    expect(session.sent).toHaveLength(2);
    expect(session.sent[1]).toContain("<C2C_TOOL_RESULT>");
    expect(session.sent[1]).toContain(WEB_CHAT_PROTOCOL);
    expect(session.sent[1]).toContain("hello");
  });

  it("chains search_workspace then read_file before prose", async () => {
    const { session } = await runScriptedChat({
      root,
      sendReplies: [
        CHAT_READY,
        (id) => chatEnvelope(id, "read_file", { path: "src/a.ts" }, "read-2"),
        "src/a.ts 导出了 n。",
      ],
      humanQueue: [(id) => chatEnvelope(id, "search_workspace", { query: "export const n" }, "search-1")],
    });
    expect(session.sent).toHaveLength(3);
    expect(session.sent[1]).toContain("search_workspace");
    expect(session.sent[2]).toContain("read_file");
    expect(session.sent[2]).toContain("export const n");
  });

  it("stops a tool chain on a concurrent human user turn before dispatch", async () => {
    const { session, result } = await runScriptedChat({
      root,
      sendReplies: [CHAT_READY],
      humanQueue: [(id) => chatEnvelope(id, "read_file", { path: "README.md" }, "read-race")],
      injectConcurrentAfterSync: true,
    });
    expect(result.status).toBe("interrupted");
    expect(session.sent).toHaveLength(1);
    expect(session.sent.join("\n")).not.toContain("<C2C_TOOL_RESULT>");
  });
});

describe("web chat writable dispatcher", () => {
  let stateDir: string;
  let root: string;
  let bridge: Bridge | undefined;
  let workspace: Workspace;

  beforeAll(async () => {
    stateDir = isolateStateDir();
    root = makeTmpDir("web-chat-write");
    fs.mkdirSync(path.join(root, "docs/research"), { recursive: true });
    fs.mkdirSync(path.join(root, "contracts"), { recursive: true });
    write(root, ".env", "PRIVATE_KEY=never\n");
    write(root, "docs/research/seed.md", "seed\n");
    write(root, "contracts/A.sol", "contract A {}\n");
    workspace = new Workspace(root);
    bridge = await startBridge({ workspaceRoot: root, port: 0 });
    setWriteScope({
      workspaceId: workspace.id,
      root: "docs/research",
      mode: "write",
      bridgeStartedAt: (await captureCapabilitySnapshot(workspace)).bridgeStartedAt ?? "missing",
    });
  });

  afterAll(async () => {
    await bridge?.close();
    if (root) cleanup(root);
    if (stateDir) cleanup(stateDir);
  });

  it("allows write_file inside the frozen root and denies contracts, .env, and hardlink aliases", async () => {
    const alias = path.join(root, "docs/research/notes.txt");
    let aliasReady = false;
    try {
      fs.linkSync(path.join(root, ".env"), alias);
      aliasReady = true;
    } catch {
      aliasReady = false;
    }
    const afterFirst: Scripted[] = [
      (id) => chatEnvelope(id, "write_file", { path: "contracts/A.sol", content: "pwn\n" }, "w-out"),
      (id) => chatEnvelope(id, "write_file", { path: "docs/research/.env", content: "x=1\n" }, "w-env"),
    ];
    if (aliasReady) {
      afterFirst.push((id) =>
        chatEnvelope(id, "write_file", { path: "docs/research/notes.txt", content: "pwn\n" }, "w-alias")
      );
    }
    afterFirst.push("done");
    const { session } = await runScriptedChat({
      root,
      sendReplies: [CHAT_READY, ...afterFirst],
      humanQueue: [
        (id) => chatEnvelope(id, "write_file", { path: "docs/research/out.md", content: "updated\n" }, "w-ok"),
      ],
    });
    expect(fs.readFileSync(path.join(root, "docs/research/out.md"), "utf8")).toBe("updated\n");
    expect(fs.readFileSync(path.join(root, "contracts/A.sol"), "utf8")).toBe("contract A {}\n");
    expect(session.sent.some((item) => item.includes("WRITE_SCOPE_VIOLATION"))).toBe(true);
    expect(session.sent.some((item) => item.includes("WRITE_DENIED_SENSITIVE_FILE"))).toBe(true);
    expect(fs.readFileSync(path.join(root, ".env"), "utf8")).toBe("PRIVATE_KEY=never\n");
  });

  it("denies run_poc in write mode and allows it only after a new poc session snapshot", async () => {
    write(root, "docs/research/ok.mjs", "console.log('POC_OK')\n");
    const denied = await runScriptedChat({
      root,
      sendReplies: [CHAT_READY, "cannot run poc"],
      humanQueue: [
        (id) => chatEnvelope(id, "run_poc", { program: "node", args: ["docs/research/ok.mjs"] }, "poc-write"),
      ],
    });
    expect(denied.session.sent[1]).toContain("POC_NOT_ALLOWED");

    setWriteScope({
      workspaceId: workspace.id,
      root: "docs/research",
      mode: "poc",
      bridgeStartedAt: (await captureCapabilitySnapshot(workspace)).bridgeStartedAt ?? "missing",
    });
    const allowed = await runScriptedChat({
      root,
      sendReplies: [CHAT_READY, "poc finished"],
      humanQueue: [
        (id) => chatEnvelope(id, "run_poc", { program: "node", args: ["docs/research/ok.mjs"] }, "poc-ok"),
      ],
    });
    if (allowed.session.sent[1].includes('"ok": true')) {
      expect(allowed.session.sent[1]).toContain("POC_OK");
    } else {
      expect(allowed.session.sent[1]).not.toContain("POC_NOT_ALLOWED");
    }
  });

  it("revokes a later write after the captured scope is cleared", async () => {
    setWriteScope({
      workspaceId: workspace.id,
      root: "docs/research",
      mode: "write",
      bridgeStartedAt: (await captureCapabilitySnapshot(workspace)).bridgeStartedAt ?? "missing",
    });
    const after = await runScriptedChat({
      root,
      sendReplies: [CHAT_READY, "cannot write"],
      humanQueue: [
        (id) => chatEnvelope(id, "write_file", { path: "docs/research/late.md", content: "nope\n" }, "late"),
      ],
      onAfterBootstrap: () => clearWriteScope(workspace.id),
    });
    expect(fs.existsSync(path.join(root, "docs/research/late.md"))).toBe(false);
    expect(after.session.sent[1]).toContain("WEB_CAPABILITY_REVOKED");
  });
});

describe("web chat remount safety", () => {
  it("does not complete on a remounted historical C2C_ACTION without a new user turn", () => {
    const watched = watchSentTurn(
      {
        assistantTurnIds: ["visible-old"],
        turnContainerIds: ["c-visible", "c-hidden"],
        userTurnIds: ["u-old"],
      },
      snapshot({
        userTurnIds: ["u-old"],
        turnContainerIds: ["c-visible", "c-hidden"],
        assistantTurnIds: ["visible-old", "hidden-old"],
        assistantIdByContainer: { "c-visible": "visible-old", "c-hidden": "hidden-old" },
        assistantTextById: {
          "hidden-old": chatEnvelope("c2c_wc_old", "read_file", { path: "README.md" }, "stale"),
        },
      })
    );
    expect(watched.status).toBe("waiting");
  });

  it("fail-closes duplicate user turn ids", () => {
    const watched = watchSentTurn(
      { assistantTurnIds: [], turnContainerIds: [], userTurnIds: [] },
      snapshot({
        userTurnIds: ["u-1", "u-1"],
        turnContainerIds: ["c-new"],
        assistantTurnIds: ["a-new"],
      })
    );
    expect(watched).toMatchObject({ status: "fail", code: "WEB_TURN_AMBIGUOUS" });
  });
});
