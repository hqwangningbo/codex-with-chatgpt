import { spawn, spawnSync } from "node:child_process";
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
import { inspectProcess, isWebHarnessCommand, isWebResearchCommand, hashOwnerCommand, readWebRuntime, stopWebTask, writeWebRuntime, webRuntimeFile } from "../src/web/state.js";

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
      authenticated: boolean | "unknown";
      browserRunning: boolean;
    };
    expect(status.profileExists).toBe(false);
    expect(status.authenticated).toBe(false);
    expect(status.browserRunning).toBe(false);

    fs.mkdirSync(path.join(stateDir, "web-profile"), { mode: 0o700 });
    const withProfile = JSON.parse(runCli(["web", "status", "--json"]).stdout) as {
      profileExists: boolean;
      authenticated: boolean | "unknown";
    };
    expect(withProfile.profileExists).toBe(true);
    expect(withProfile.authenticated).toBe("unknown");
    fs.rmSync(path.join(stateDir, "web-profile"), { recursive: true, force: true });
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

    const chatModel = runCli(["web", "chat", "--json", "-w", workspace, "--model", "high"]);
    expect(chatModel.status).not.toBe(0);
    expect(chatModel.stdout).toMatch(/WEB_MODEL_UNAVAILABLE/);
    const chatMissing = runCli(["web", "chat", "--json", "-w", workspace]);
    expect(chatMissing.status).not.toBe(0);
    expect(chatMissing.stdout).toMatch(/WEB_PROFILE_REQUIRED/);
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

describe("web stop PID identity", () => {
  it("clears stale runtime with a dead PID without signaling", () => {
    process.env.C2C_STATE_DIR = stateDir;
    writeWebRuntime({
      pid: 999_999_999,
      requestId: "c2c_wr_dead",
      workspaceId: "ws",
      startedAt: new Date().toISOString(),
      processStartedAt: "Mon Jan  1 00:00:00 2000",
      commandHash: "dead",
      stepCount: 1,
      status: "running",
    });
    const stopped = runCli(["web", "stop", "--json"]);
    expect(stopped.status, stopped.stderr || stopped.stdout).toBe(0);
    expect(JSON.parse(stopped.stdout)).toMatchObject({ ok: true, stopped: true, stale: true });
    expect(readWebRuntime().status).toBe("interrupted");
    expect(readWebRuntime().pid).toBeNull();
  });

  it("does not kill an unrelated live PID reused by stale runtime", () => {
    process.env.C2C_STATE_DIR = stateDir;
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    try {
      if (!child.pid) throw new Error("failed to spawn helper");
      const live = inspectProcess(child.pid);
      expect(live.alive).toBe(true);
      writeWebRuntime({
        pid: child.pid,
        requestId: "c2c_wr_reused",
        workspaceId: "ws",
        startedAt: new Date().toISOString(),
        processStartedAt: live.startedAt,
        commandHash: "not-the-live-process",
        kind: "research",
        stepCount: 1,
        status: "running",
      });
      const stopped = runCli(["web", "stop", "--json"]);
      expect(stopped.status).not.toBe(0);
      expect(stopped.stdout).toMatch(/WEB_STOP_PID_UNCERTAIN/);
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
      expect(readWebRuntime().status).toBe("running");
      expect(readWebRuntime().pid).toBe(child.pid);
    } finally {
      if (child.pid) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }
  });
});

function spawnFakeWebOwner(
  ignoreTerm: boolean,
  subcommand: "research" | "chat" = "research"
): { child: ReturnType<typeof spawn>; dir: string; ready: string } {
  const dir = makeTmpDir("web-owner");
  fs.mkdirSync(path.join(dir, "cli"), { recursive: true });
  const ready = path.join(dir, "ready");
  const ignore = ignoreTerm ? `process.on("SIGTERM", () => {});\n` : "";
  const script = `import fs from "node:fs";
${ignore}fs.writeFileSync(${JSON.stringify(ready)}, "1");
setInterval(() => {}, 1000);
`;
  const file = path.join(dir, "cli", "index.js");
  fs.writeFileSync(file, script);
  const child = spawn(process.execPath, [file, "web", subcommand], { stdio: "ignore", detached: true });
  child.unref();
  if (!child.pid) throw new Error("failed to spawn helper");
  return { child, dir, ready };
}

async function waitForFile(file: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`helper did not become ready: ${file}`);
}

async function recordFakeOwner(child: ReturnType<typeof spawn>): Promise<void> {
  if (!child.pid) throw new Error("failed to spawn helper");
  const live = inspectProcess(child.pid);
  expect(live.alive).toBe(true);
  expect(isWebHarnessCommand(live.command)).toBe(true);
  writeWebRuntime({
    pid: child.pid,
    requestId: "c2c_wr_owner",
    workspaceId: "ws",
    startedAt: new Date().toISOString(),
    processStartedAt: live.startedAt,
    commandHash: hashOwnerCommand(live.command ?? ""),
    kind: isWebResearchCommand(live.command) ? "research" : "chat",
    stepCount: 1,
    status: "running",
  });
}

describe("web stop waits for owner exit", () => {
  it("does not announce success while a proven owner ignores SIGTERM", async () => {
    process.env.C2C_STATE_DIR = stateDir;
    const { child, dir, ready } = spawnFakeWebOwner(true);
    try {
      await waitForFile(ready);
      await recordFakeOwner(child);
      await expect(stopWebTask({ waitMs: 400 })).rejects.toMatchObject({ code: "WEB_STOP_TIMEOUT" });
      expect(readWebRuntime().status).toBe("running");
      expect(readWebRuntime().pid).toBe(child.pid);
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
      const loopRoot = makeTmpDir("web-busy");
      write(loopRoot, "hello.txt", "hello\n");
      await expect(
        runResearchTurn({
          workspace: new Workspace(loopRoot),
          task: "should be busy",
          session: new FakeSession(),
        })
      ).rejects.toMatchObject({ code: "WEB_RESEARCH_BUSY" });
      cleanup(loopRoot);
    } finally {
      if (child.pid) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          /* ignore */
        }
      }
      cleanup(dir);
    }
  });

  it("marks interrupted only after the proven owner actually exits", async () => {
    process.env.C2C_STATE_DIR = stateDir;
    const { child, dir, ready } = spawnFakeWebOwner(false);
    try {
      await waitForFile(ready);
      await recordFakeOwner(child);
      await expect(stopWebTask({ waitMs: 2000 })).resolves.toMatchObject({ ok: true, stopped: true });
      expect(readWebRuntime().status).toBe("interrupted");
      expect(readWebRuntime().pid).toBeNull();
      expect(() => process.kill(child.pid!, 0)).toThrow();
    } finally {
      if (child.pid) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          /* ignore */
        }
      }
      cleanup(dir);
    }
  });

  it("waits for a proven web chat owner the same way as research", async () => {
    process.env.C2C_STATE_DIR = stateDir;
    const { child, dir, ready } = spawnFakeWebOwner(true, "chat");
    try {
      await waitForFile(ready);
      await recordFakeOwner(child);
      expect(isWebResearchCommand(inspectProcess(child.pid!).command)).toBe(false);
      expect(isWebHarnessCommand(inspectProcess(child.pid!).command)).toBe(true);
      await expect(stopWebTask({ waitMs: 400 })).rejects.toMatchObject({ code: "WEB_STOP_TIMEOUT" });
      expect(readWebRuntime().status).toBe("running");
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
    } finally {
      if (child.pid) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          /* ignore */
        }
      }
      cleanup(dir);
    }
  });

  it("marks a chat owner interrupted only after it actually exits", async () => {
    process.env.C2C_STATE_DIR = stateDir;
    const { child, dir, ready } = spawnFakeWebOwner(false, "chat");
    try {
      await waitForFile(ready);
      await recordFakeOwner(child);
      await expect(stopWebTask({ waitMs: 2000 })).resolves.toMatchObject({ ok: true, stopped: true });
      expect(readWebRuntime().status).toBe("interrupted");
      expect(readWebRuntime().pid).toBeNull();
    } finally {
      if (child.pid) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          /* ignore */
        }
      }
      cleanup(dir);
    }
  });
});

describe("web harness command identity", () => {
  it("matches web research and web chat, not web stop", () => {
    expect(isWebHarnessCommand("node src/cli/index.ts web research --task x")).toBe(true);
    expect(isWebHarnessCommand("node src/cli/index.js web chat -w /tmp")).toBe(true);
    expect(isWebHarnessCommand("node src/cli/index.ts web stop --json")).toBe(false);
    expect(isWebResearchCommand("node src/cli/index.js web chat")).toBe(false);
  });

  it("does not persist research task text in runtime.json", () => {
    process.env.C2C_STATE_DIR = stateDir;
    const secret = "UNIQUE_PRIVACY_TOKEN_c2c_task_xyz";
    const command = `${process.execPath} src/cli/index.ts web research --task ${JSON.stringify(secret)}`;
    writeWebRuntime({
      pid: 424242,
      requestId: "c2c_wr_private",
      workspaceId: "ws",
      startedAt: new Date().toISOString(),
      processStartedAt: "Mon Jan  1 00:00:00 2000",
      commandHash: hashOwnerCommand(command),
      kind: "research",
      stepCount: 1,
      status: "running",
    });
    const raw = fs.readFileSync(webRuntimeFile(), "utf8");
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain("--task");
    expect(JSON.parse(raw).command).toBeUndefined();
    expect(JSON.parse(raw).commandHash).toBe(hashOwnerCommand(command));
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
