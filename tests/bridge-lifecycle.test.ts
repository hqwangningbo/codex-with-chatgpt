import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanup, makeTmpDir, write } from "./helpers.js";

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
  stateDir = makeTmpDir("bridge-lifecycle-state");
  workspace = makeTmpDir("bridge-lifecycle-workspace");
  write(workspace, ".c2c.json", JSON.stringify({ name: "Lifecycle" }));
});

afterAll(() => {
  runCli(["stop", "--json", "-w", workspace]);
  cleanup(workspace);
  cleanup(stateDir);
});

describe("Bridge CLI lifecycle", () => {
  it("status is read-only, starts a stopped Bridge, reuses it, then confirms stop", () => {
    const initial = runCli(["status", "--json", "-w", workspace]);
    expect(initial.status).toBe(0);
    const stopped = JSON.parse(initial.stdout);
    expect(stopped).toMatchObject({
      state: "stopped",
      workspace: { name: "Lifecycle" },
      bridge: { healthy: false, pid: null },
      tunnel: { running: false },
    });

    const first = runCli(["start", "--json", "-w", workspace]);
    expect(first.status, first.stderr || first.stdout).toBe(0);
    const firstStart = JSON.parse(first.stdout);

    const second = runCli(["start", "--json", "-w", workspace]);
    expect(second.status, second.stderr || second.stdout).toBe(0);
    const secondStart = JSON.parse(second.stdout);
    expect(secondStart.port).toBe(firstStart.port);

    const running = runCli(["status", "--json", "-w", workspace]);
    const runningStatus = JSON.parse(running.stdout);
    expect(runningStatus).toMatchObject({
      state: "healthy",
      workspace: { name: "Lifecycle" },
      bridge: { healthy: true, port: firstStart.port },
      tunnel: { running: false },
      mcpUrl: null,
    });
    expect(running.stdout).not.toMatch(/adminToken|accessToken|refreshToken|pairing|credential/i);

    const stop = runCli(["stop", "--json", "-w", workspace]);
    expect(stop.status, stop.stderr || stop.stdout).toBe(0);
    expect(JSON.parse(stop.stdout)).toMatchObject({ ok: true, stopped: true });
    expect(JSON.parse(runCli(["status", "--json", "-w", workspace]).stdout).state).toBe("stopped");

    const rejectedTunnel = runCli(["start", "--tunnel", "--json", "-w", workspace]);
    expect(rejectedTunnel.status).toBe(1);
    expect(JSON.parse(rejectedTunnel.stdout)).toMatchObject({ ok: false, error: "TUNNEL_CHOICE_REQUIRED" });
    const localOnly = JSON.parse(runCli(["status", "--json", "-w", workspace]).stdout);
    expect(localOnly).toMatchObject({
      state: "healthy",
      bridge: { healthy: true },
      tunnel: { running: false, provider: "unconfigured" },
      mcpUrl: null,
    });
  });
});
