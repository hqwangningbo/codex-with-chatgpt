import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { startEnvironmentBridge } from "../src/dev/bridge.js";
import { buildProfileFromFlags, readDevProfile, writeDevProfile } from "../src/dev/profile.js";
import { captureDevCapability, createDevEnvironment } from "../src/dev/environment.js";
import {
  downDevEnvironment,
  statusDevEnvironment,
  stopDevTunnel,
  upDevEnvironment,
} from "../src/dev/lifecycle.js";
import { findDevObservation, readDevRuntime, writeDevRuntime } from "../src/dev/runtime.js";
import { SERVICE_NAME, VERSION } from "../src/version.js";
import { adminFetch } from "../src/process/daemon.js";
import type { RuntimeState } from "../src/bridge/runtime.js";
import type { TunnelProvider, TunnelDoctorReport, TunnelStatus } from "../src/tunnel/provider.js";
import { WebError } from "../src/web/errors.js";
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
    });
  }

  async function spawnFakeBridge(input: {
    env: ReturnType<typeof createDevEnvironment>;
    exitOnShutdown: boolean;
    ignoreTerm: boolean;
    publicUrl?: string | null;
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
    const child = spawn(process.execPath, ["-e", script], {
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
      },
    });
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("fake bridge did not bind")), 5000);
      child.stdout?.on("data", (chunk: Buffer) => {
        try {
          const parsed = JSON.parse(chunk.toString("utf8").split("\n")[0]!) as { port: number };
          clearTimeout(timer);
          resolve(parsed.port);
        } catch (error) {
          clearTimeout(timer);
          reject(error);
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`fake bridge exited ${code}`));
      });
    });
    persistRuntime(input.env, {
      pid: child.pid ?? 0,
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
});
