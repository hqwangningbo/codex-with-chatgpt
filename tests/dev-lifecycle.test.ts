import { spawn } from "node:child_process";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { startEnvironmentBridge } from "../src/dev/bridge.js";
import { buildProfileFromFlags, readDevProfile, writeDevProfile } from "../src/dev/profile.js";
import { captureDevCapability, createDevEnvironment } from "../src/dev/environment.js";
import { downDevEnvironment, statusDevEnvironment } from "../src/dev/lifecycle.js";
import { readDevRuntime, writeDevRuntime } from "../src/dev/runtime.js";
import { SERVICE_NAME, VERSION } from "../src/version.js";
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
});
