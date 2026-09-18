import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startEnvironmentBridge } from "../src/dev/bridge.js";
import { buildProfileFromFlags, environmentIdFor, readDevProfile, writeDevProfile } from "../src/dev/profile.js";
import { captureDevCapability, createDevEnvironment } from "../src/dev/environment.js";
import {
  downDevEnvironment,
  ensureEnvironmentRunning,
  statusDevEnvironment,
  stopDevTunnel,
  upDevEnvironment,
} from "../src/dev/lifecycle.js";
import { findDevObservation, ownerIdentityFor, readDevRuntime, writeDevRuntime } from "../src/dev/runtime.js";
import { dispatchDevTool } from "../src/dev/dispatcher.js";
import { SERVICE_NAME, VERSION } from "../src/version.js";
import { adminFetch } from "../src/process/daemon.js";
import type { RuntimeState } from "../src/bridge/runtime.js";
import type { TunnelProvider, TunnelDoctorReport, TunnelStatus } from "../src/tunnel/provider.js";
import { WebError } from "../src/web/errors.js";
import { DevError } from "../src/dev/errors.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const roots: string[] = [];
const states: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) cleanup(root);
  for (const dir of states.splice(0)) cleanup(dir);
});

function repo(name: string): string {
  const root = makeTmpDir(name);
  roots.push(root);
  write(root, "README.md", `${name}\n`);
  return fs.realpathSync.native(root);
}

describe("dev lifecycle", () => {
  it("starts an environment bridge, reports aliases without absolute paths, and down keeps the profile", async () => {
    states.push(isolateStateDir());
    const research = repo("research");
    const contracts = repo("contracts");
    const profile = buildProfileFromFlags({
      name: "tbpros",
      mounts: [`research=${research}`, `contracts=${contracts}`],
      mode: "poc",
    });
    writeDevProfile(profile);
    const env = createDevEnvironment(profile, new Date().toISOString());
    const bridge = await startEnvironmentBridge({ env, port: 0 });
    try {
      const health = await fetch(`http://127.0.0.1:${bridge.port}/health`);
      const body = (await health.json()) as Record<string, unknown>;
      expect(body.environmentId).toBe(env.environmentId);
      expect(JSON.stringify(body)).not.toContain(research);
      expect(JSON.stringify(body)).not.toContain(contracts);
      const status = await statusDevEnvironment("tbpros");
      expect(status.running).toBe(true);
      expect(JSON.stringify(status)).not.toContain(research);
      const verbose = await statusDevEnvironment("tbpros", { verbose: true });
      expect(JSON.stringify(verbose)).toContain(research);
    } finally {
      await bridge.close();
    }
    const down = await downDevEnvironment("tbpros");
    expect(down.profilePreserved).toBe(true);
    expect(readDevProfile("tbpros")?.name).toBe("tbpros");
    expect(readDevRuntime("tbpros")).toBeNull();
  });

  it("does not kill an unrelated live PID and still preserves the saved profile", async () => {
    states.push(isolateStateDir());
    const research = repo("research");
    const profile = buildProfileFromFlags({
      name: "safe",
      mounts: [`research=${research}`],
      mode: "write",
    });
    writeDevProfile(profile);
    const env = createDevEnvironment(profile, new Date().toISOString());
    const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    try {
      writeDevRuntime({
        service: SERVICE_NAME,
        version: VERSION,
        ...captureDevCapability(env),
        pid: sleeper.pid ?? 0,
        port: 1,
        adminToken: "nope",
        publicUrl: null,
        status: "running",
        processStartedAt: null,
        commandHash: null,
      });
      await expect(downDevEnvironment("safe")).rejects.toMatchObject({ code: "DEV_STOP_PID_UNCERTAIN" });
      expect(() => process.kill(sleeper.pid ?? 0, 0)).not.toThrow();
      expect(readDevProfile("safe")?.name).toBe("safe");
    } finally {
      if (sleeper.pid) process.kill(sleeper.pid, "SIGTERM");
    }
  });

  function asRuntime(runtime: NonNullable<ReturnType<typeof readDevRuntime>>): RuntimeState {
    return {
      service: runtime.service,
      version: runtime.version,
      workspaceId: runtime.environmentId,
      workspaceRoot: runtime.environmentName,
      pid: runtime.pid,
      port: runtime.port,
      adminToken: runtime.adminToken,
      publicUrl: runtime.publicUrl,
      startedAt: runtime.devStartedAt,
    };
  }

  function persistRuntime(
    env: ReturnType<typeof createDevEnvironment>,
    extra: { pid: number; port: number; adminToken: string; publicUrl?: string | null }
  ) {
    writeDevRuntime({
      service: SERVICE_NAME,
      version: VERSION,
      ...captureDevCapability(env),
      pid: extra.pid,
      port: extra.port,
      adminToken: extra.adminToken,
      publicUrl: extra.publicUrl ?? null,
      status: "running",
      ...ownerIdentityFor(extra.pid),
    });
  }

  async function spawnFakeBridge(input: {
    env: ReturnType<typeof createDevEnvironment>;
    exitOnShutdown: boolean;
    ignoreTerm: boolean;
    publicUrl?: string | null;
    recordedPid?: number;
    infoPid?: number;
    infoStartedAt?: string;
    infoEnvironmentId?: string;
  }): Promise<{ child: ChildProcess; port: number; adminToken: string }> {
    const adminToken = `c2c_admin_test_${input.env.name}`;
    const script = `
const http = require("node:http");
if (process.env.DEV_IGNORE_TERM === "1") {
  process.on("SIGTERM", () => {});
  process.on("SIGINT", () => {});
}
const server = http.createServer((req, res) => {
  const json = (code, body) => {
    res.statusCode = code;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  };
  if (req.url === "/health") {
    json(200, {
      service: process.env.DEV_SERVICE,
      version: process.env.DEV_VERSION,
      status: "ok",
      workspaceId: process.env.DEV_ENV_ID,
      environmentId: process.env.DEV_ENV_ID,
      environmentName: process.env.DEV_ENV_NAME,
      mountCount: 1,
      startedAt: process.env.DEV_STARTED_AT,
    });
    return;
  }
  const auth = req.headers.authorization || "";
  if (auth !== "Bearer " + process.env.DEV_ADMIN) {
    json(404, {});
    return;
  }
  if (req.url === "/admin/info" && req.method === "GET") {
    json(200, {
      environmentId: process.env.DEV_INFO_ENV_ID || process.env.DEV_ENV_ID,
      pid: Number(process.env.DEV_INFO_PID || process.pid),
      startedAt: process.env.DEV_INFO_STARTED_AT || process.env.DEV_STARTED_AT,
    });
    return;
  }
  if (req.url === "/admin/shutdown" && req.method === "POST") {
    json(200, { shuttingDown: true });
    if (process.env.DEV_EXIT_ON_SHUTDOWN === "1") {
      server.close(() => process.exit(0));
    }
    return;
  }
  if (req.url === "/admin/tunnel/stop" && req.method === "POST") {
    json(200, { stopped: true });
    return;
  }
  if (req.url === "/admin/revoke-all" && req.method === "POST") {
    json(200, { revoked: 0 });
    return;
  }
  if (req.url === "/admin/tunnel/start" && req.method === "POST") {
    json(200, { url: "https://tbpros-dev.example.test" });
    return;
  }
  json(404, {});
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(JSON.stringify({ port: server.address().port }) + "\\n");
});
`;
    const scriptDir = makeTmpDir("fake-bridge");
    roots.push(scriptDir);
    const scriptFile = path.join(scriptDir, "bridge.cjs");
    fs.writeFileSync(scriptFile, script);
    const child = spawn(process.execPath, [scriptFile, "serve-dev", "--name", input.env.name], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      env: {
        ...process.env,
        DEV_SERVICE: SERVICE_NAME,
        DEV_VERSION: VERSION,
        DEV_ENV_ID: input.env.environmentId,
        DEV_ENV_NAME: input.env.name,
        DEV_STARTED_AT: input.env.startedAt,
        DEV_ADMIN: adminToken,
        DEV_EXIT_ON_SHUTDOWN: input.exitOnShutdown ? "1" : "0",
        DEV_IGNORE_TERM: input.ignoreTerm ? "1" : "0",
        ...(input.infoPid !== undefined ? { DEV_INFO_PID: String(input.infoPid) } : {}),
        ...(input.infoStartedAt ? { DEV_INFO_STARTED_AT: input.infoStartedAt } : {}),
        ...(input.infoEnvironmentId ? { DEV_INFO_ENV_ID: input.infoEnvironmentId } : {}),
      },
    });
    const port = await new Promise<number>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error("fake bridge did not bind"));
        }
      }, 5000);
      child.stdout?.on("data", (chunk: Buffer) => {
        if (settled) return;
        try {
          const parsed = JSON.parse(chunk.toString("utf8").split("\n")[0]!) as { port: number };
          settled = true;
          clearTimeout(timer);
          resolve(parsed.port);
        } catch (error) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      });
      child.on("exit", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`fake bridge exited ${code}`));
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    persistRuntime(input.env, {
      pid: input.recordedPid ?? child.pid ?? 0,
      port,
      adminToken,
      publicUrl: input.publicUrl,
    });
    return { child, port, adminToken };
  }

  class MemoryTunnel implements TunnelProvider {
    readonly name = "memory";
    private url: string | null = null;
    async start(): Promise<string> {
      this.url = "https://tbpros-dev.example.test";
      return this.url;
    }
    async stop(): Promise<void> {
      this.url = null;
    }
    async restart(localPort: number): Promise<string> {
      await this.stop();
      return this.start(localPort);
    }
    status(): TunnelStatus {
      return { running: Boolean(this.url), url: this.url, provider: this.name };
    }
    getPublicUrl(): string | null {
      return this.url;
    }
    async doctor(): Promise<TunnelDoctorReport> {
      return {
        provider: this.name,
        binaryFound: true,
        binaryPath: null,
        running: Boolean(this.url),
        url: this.url,
        problems: [],
      };
    }
  }

  it("keeps runtime and does not SIGKILL when a proven Bridge ignores SIGTERM", async () => {
    states.push(isolateStateDir());
    const research = repo("research");
    const profile = buildProfileFromFlags({
      name: "hang",
      mounts: [`research=${research}`],
      mode: "write",
    });
    writeDevProfile(profile);
    const env = createDevEnvironment(profile, new Date().toISOString());
    const fake = await spawnFakeBridge({ env, exitOnShutdown: false, ignoreTerm: true });
    try {
      await expect(downDevEnvironment("hang", { waitMs: 800 })).rejects.toMatchObject({
        code: "DEV_STOP_TIMEOUT",
      });
      expect(readDevRuntime("hang")?.pid).toBe(fake.child.pid);
      expect(() => process.kill(fake.child.pid ?? 0, 0)).not.toThrow();
      expect(readDevProfile("hang")?.name).toBe("hang");
    } finally {
      if (fake.child.pid) {
        try {
          process.kill(fake.child.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  });

  it("rolls back a newly spawned Bridge+Tunnel when --chat fails before ready", async () => {
    states.push(isolateStateDir());
    const research = repo("research");
    const profile = buildProfileFromFlags({
      name: "tbpros",
      mounts: [`research=${research}`],
      mode: "poc",
    });
    writeDevProfile(profile);
    const env = createDevEnvironment(profile, new Date().toISOString());
    const fake = await spawnFakeBridge({ env, exitOnShutdown: true, ignoreTerm: false });
    try {
      await expect(
        upDevEnvironment({
          profile,
          tunnel: true,
          ensureRunning: async () => ({ runtime: readDevRuntime("tbpros")!, spawned: true }),
          attachTunnel: async (runtime) => {
            writeDevRuntime({ ...runtime, publicUrl: "https://tbpros-dev.example.test" });
            return { runtime: readDevRuntime("tbpros")!, publicVerification: "direct" };
          },
          startChat: async () => {
            throw new WebError("WEB_PROFILE_REQUIRED", "Run `c2c web login` first");
          },
        })
      ).rejects.toMatchObject({ code: "WEB_PROFILE_REQUIRED" });
      expect(readDevRuntime("tbpros")).toBeNull();
      await expect(findDevObservation("tbpros")).resolves.toMatchObject({ state: "stopped" });
    } finally {
      if (fake.child.pid) {
        try {
          process.kill(fake.child.pid, "SIGKILL");
        } catch {
          // rolled back
        }
      }
    }
  });

  it("stops only a newly started Tunnel when chat fails against an already running Environment", async () => {
    states.push(isolateStateDir());
    const research = repo("research");
    const profile = buildProfileFromFlags({
      name: "tbpros",
      mounts: [`research=${research}`],
      mode: "poc",
    });
    writeDevProfile(profile);
    const env = createDevEnvironment(profile, new Date().toISOString());
    const bridge = await startEnvironmentBridge({ env, port: 0, tunnelProvider: new MemoryTunnel() });
    try {
      expect(readDevRuntime("tbpros")?.publicUrl).toBeNull();
      await expect(
        upDevEnvironment({
          profile,
          tunnel: true,
          ensureRunning: async () => ({ runtime: readDevRuntime("tbpros")!, spawned: false }),
          attachTunnel: async (runtime) => {
            await adminFetch(asRuntime(runtime), "POST", "/admin/tunnel/start", 5000);
            return { runtime: readDevRuntime("tbpros")!, publicVerification: "direct" };
          },
          startChat: async () => {
            throw new WebError("WEB_PROFILE_REQUIRED", "missing browser profile");
          },
        })
      ).rejects.toMatchObject({ code: "WEB_PROFILE_REQUIRED" });
      const latest = readDevRuntime("tbpros");
      expect(latest).not.toBeNull();
      expect(latest?.publicUrl).toBeNull();
      expect(await findDevObservation("tbpros")).toMatchObject({ state: "healthy" });
      await stopDevTunnel("tbpros");
    } finally {
      await bridge.close();
    }
  });

  function killPid(pid: number | undefined): void {
    if (!pid) return;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }

  it("surfaces DEV_ROLLBACK_FAILED when chat fails and a hanging Bridge cannot be stopped", async () => {
    states.push(isolateStateDir());
    const research = repo("research");
    const profile = buildProfileFromFlags({
      name: "tbpros",
      mounts: [`research=${research}`],
      mode: "poc",
    });
    writeDevProfile(profile);
    const env = createDevEnvironment(profile, new Date().toISOString());
    const fake = await spawnFakeBridge({ env, exitOnShutdown: false, ignoreTerm: true });
    try {
      const err = await upDevEnvironment({
        profile,
        waitMs: 800,
        ensureRunning: async () => ({ runtime: readDevRuntime("tbpros")!, spawned: true }),
        startChat: async () => {
          throw new WebError("WEB_PROFILE_REQUIRED", "Run `c2c web login` first");
        },
      }).catch((error) => error as DevError);
      expect(err).toMatchObject({
        code: "DEV_ROLLBACK_FAILED",
        original: { code: "WEB_PROFILE_REQUIRED" },
        rollback: { code: "DEV_STOP_TIMEOUT" },
      });
      expect(err.message).toContain("original=WEB_PROFILE_REQUIRED");
      expect(err.message).toContain("rollback=DEV_STOP_TIMEOUT");
      expect(readDevRuntime("tbpros")?.pid).toBe(fake.child.pid);
      const observation = await findDevObservation("tbpros");
      expect(["healthy", "unknown"]).toContain(observation.state);
      const status = await statusDevEnvironment("tbpros");
      expect(status.running === true || observation.state === "unknown").toBe(true);
      expect(() => process.kill(fake.child.pid ?? 0, 0)).not.toThrow();
    } finally {
      killPid(fake.child.pid);
    }
  });

  it("does not SIGTERM an unrelated PID when admin info pid mismatches matching health", async () => {
    states.push(isolateStateDir());
    const research = repo("research");
    const profile = buildProfileFromFlags({
      name: "mismatch-pid",
      mounts: [`research=${research}`],
      mode: "write",
    });
    writeDevProfile(profile);
    const env = createDevEnvironment(profile, new Date().toISOString());
    const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const fake = await spawnFakeBridge({
      env,
      exitOnShutdown: false,
      ignoreTerm: true,
      recordedPid: sleeper.pid,
    });
    try {
      await expect(downDevEnvironment("mismatch-pid")).rejects.toMatchObject({ code: "DEV_STOP_PID_UNCERTAIN" });
      expect(() => process.kill(sleeper.pid ?? 0, 0)).not.toThrow();
      expect(() => process.kill(fake.child.pid ?? 0, 0)).not.toThrow();
      expect(readDevRuntime("mismatch-pid")?.pid).toBe(sleeper.pid);
    } finally {
      killPid(sleeper.pid);
      killPid(fake.child.pid);
    }
  });

  it("does not SIGTERM when admin info startedAt mismatches", async () => {
    states.push(isolateStateDir());
    const research = repo("research");
    const profile = buildProfileFromFlags({
      name: "mismatch-start",
      mounts: [`research=${research}`],
      mode: "write",
    });
    writeDevProfile(profile);
    const env = createDevEnvironment(profile, new Date().toISOString());
    const fake = await spawnFakeBridge({
      env,
      exitOnShutdown: false,
      ignoreTerm: true,
      infoStartedAt: "1999-01-01T00:00:00.000Z",
    });
    try {
      await expect(downDevEnvironment("mismatch-start")).rejects.toMatchObject({
        code: "DEV_STOP_PID_UNCERTAIN",
      });
      expect(() => process.kill(fake.child.pid ?? 0, 0)).not.toThrow();
      expect(readDevRuntime("mismatch-start")?.pid).toBe(fake.child.pid);
    } finally {
      killPid(fake.child.pid);
    }
  });

  it("SIGTERM a fully proven Environment Bridge owner", async () => {
    states.push(isolateStateDir());
    const research = repo("research");
    const profile = buildProfileFromFlags({
      name: "proven",
      mounts: [`research=${research}`],
      mode: "write",
    });
    writeDevProfile(profile);
    const env = createDevEnvironment(profile, new Date().toISOString());
    const fake = await spawnFakeBridge({ env, exitOnShutdown: true, ignoreTerm: false });
    try {
      const down = await downDevEnvironment("proven");
      expect(down.stopped).toBe(true);
      expect(readDevRuntime("proven")).toBeNull();
    } finally {
      killPid(fake.child.pid);
    }
  });

  it("refuses to reuse a running Environment after the saved profile grows", async () => {
    states.push(isolateStateDir());
    const research = repo("research");
    const contracts = repo("contracts");
    const frontend = repo("frontend");
    const original = buildProfileFromFlags({
      name: "tbpros",
      mounts: [`research=${research}`, `contracts=${contracts}`],
      mode: "write",
    });
    writeDevProfile(original);
    const env = createDevEnvironment(original, new Date().toISOString());
    const bridge = await startEnvironmentBridge({ env, port: 0 });
    try {
      const widened = buildProfileFromFlags({
        name: "tbpros",
        mounts: [`research=${research}`, `contracts=${contracts}`, `frontend=${frontend}`],
        mode: "write",
      });
      writeDevProfile(widened);
      expect(environmentIdFor(widened)).not.toBe(env.environmentId);
      await expect(ensureEnvironmentRunning(widened)).rejects.toMatchObject({ code: "DEV_RESTART_REQUIRED" });
      await expect(upDevEnvironment({ profile: widened })).rejects.toMatchObject({
        code: "DEV_RESTART_REQUIRED",
      });
      expect(await findDevObservation("tbpros")).toMatchObject({ state: "healthy" });
      const snapshot = captureDevCapability(env);
      const missing = await dispatchDevTool(env, snapshot, {
        tool: "read_file",
        workspace: "frontend",
        arguments: { path: "README.md" },
      });
      expect(missing.ok).toBe(false);
      expect(missing.error?.code).toBe("DEV_WORKSPACE_NOT_ATTACHED");
      const stillContracts = await dispatchDevTool(env, snapshot, {
        tool: "read_file",
        workspace: "contracts",
        arguments: { path: "README.md" },
      });
      expect(stillContracts.ok).toBe(true);
    } finally {
      await bridge.close();
    }
    await downDevEnvironment("tbpros");
    const widened = readDevProfile("tbpros");
    expect(widened).toBeTruthy();
    const next = createDevEnvironment(widened!, new Date().toISOString());
    persistRuntime(next, { pid: process.pid, port: 1, adminToken: "test" });
    const after = await dispatchDevTool(next, captureDevCapability(next), {
      tool: "read_file",
      workspace: "frontend",
      arguments: { path: "README.md" },
    });
    expect(after.ok).toBe(true);
    expect(JSON.stringify(after.result)).toContain("frontend");
  });
});
