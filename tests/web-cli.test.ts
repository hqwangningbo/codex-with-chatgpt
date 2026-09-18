import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";
import { runResearchTurn } from "../src/web/research-turn.js";
import { Workspace } from "../src/workspace/manager.js";
import type { ChatSession } from "../src/web/session.js";
import type { ChatGptSnapshot } from "../src/web/selectors.js";
import { ACTION_CLOSE, ACTION_OPEN, WEB_PROTOCOL } from "../src/web/protocol.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "src/cli/index.ts");

let stateDir: string;
let workspace: string;

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", cliEntry, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, C2C_STATE_DIR: stateDir },
  });
}

beforeAll(() => {
  stateDir = makeTmpDir("web-cli-state");
  workspace = makeTmpDir("web-cli-workspace");
  fs.mkdirSync(path.join(workspace, "docs"), { recursive: true });
});

afterAll(() => {
  runCli(["stop", "--json", "-w", workspace]);
  cleanup(workspace);
  cleanup(stateDir);
});

describe("web CLI isolation", () => {
  it("does not create a web profile during ordinary c2c start", () => {
    const started = runCli(["start", "--json", "-w", workspace]);
    expect(started.status, started.stderr || started.stdout).toBe(0);
    expect(fs.existsSync(path.join(stateDir, "web-profile"))).toBe(false);
    const status = JSON.parse(runCli(["web", "status", "--json"]).stdout) as {
      profileExists: boolean;
      authenticated: boolean;
      browserRunning: boolean;
    };
    expect(status.profileExists).toBe(false);
    expect(status.authenticated).toBe(false);
    expect(status.browserRunning).toBe(false);
  });

  it("rejects non-current models and missing profiles without launching a browser", () => {
    const model = runCli([
      "web",
      "research",
      "--json",
      "-w",
      workspace,
      "--task",
      "demo",
      "--model",
      "high",
    ]);
    expect(model.status).not.toBe(0);
    expect(model.stdout).toMatch(/WEB_MODEL_UNAVAILABLE/);
    expect(fs.existsSync(path.join(stateDir, "web-profile"))).toBe(false);

    const missing = runCli(["web", "research", "--json", "-w", workspace, "--task", "demo"]);
    expect(missing.status).not.toBe(0);
    expect(missing.stdout).toMatch(/WEB_PROFILE_REQUIRED/);
    expect(fs.existsSync(path.join(stateDir, "web-profile"))).toBe(false);
  });

  it("requires --yes before deleting a profile and leaves start-created state alone", () => {
    const denied = runCli(["web", "logout", "--json"]);
    expect(denied.status).not.toBe(0);
    expect(denied.stdout).toMatch(/WEB_LOGOUT_REQUIRES_YES/);
    const stopped = runCli(["web", "stop", "--json"]);
    expect(stopped.status).toBe(0);
    expect(JSON.parse(stopped.stdout)).toMatchObject({ ok: true, stopped: true });
    expect(fs.existsSync(path.join(stateDir, "web-profile"))).toBe(false);
  });
});

class FakeSession implements ChatSession {
  sent: string[] = [];
  async snapshot(): Promise<ChatGptSnapshot> {
    throw new Error("unused");
  }
  async ensureReady(): Promise<ChatGptSnapshot> {
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
    };
  }
  async sendAndWait(_text: string): Promise<string> {
    return "";
  }
  async close(): Promise<void> {}
}

function envelope(body: unknown): string {
  return `${ACTION_OPEN}\n${JSON.stringify(body)}\n${ACTION_CLOSE}`;
}

describe("web research loop", () => {
  it("corrects one invalid envelope then finishes without git writes", async () => {
    const loopState = isolateStateDir();
    const root = makeTmpDir("web-loop");
    write(root, "hello.txt", "hello\n");
    const session = new FakeSession();
    session.sendAndWait = async (text: string): Promise<string> => {
      session.sent.push(text);
      if (session.sent.length === 1) return "not an envelope";
      const match = session.sent[0]?.match(/request_id: (\S+)/);
      const requestId = match?.[1] ?? "";
      return envelope({
        protocol: WEB_PROTOCOL,
        request_id: requestId,
        type: "final",
        summary: "research complete",
        artifacts: [],
      });
    };
    const previousState = process.env.C2C_STATE_DIR;
    const result = await runResearchTurn({
      workspace: new Workspace(root),
      task: "summarize hello.txt",
      session,
    });
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("research complete");
    expect(session.sent).toHaveLength(2);
    expect(session.sent[1]).toMatch(/not a valid C2C Research envelope/);
    cleanup(root);
    cleanup(loopState);
    if (previousState === undefined) delete process.env.C2C_STATE_DIR;
    else process.env.C2C_STATE_DIR = previousState;
  });
});
