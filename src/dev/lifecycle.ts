import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, getStateDir } from "../config/paths.js";
import { SERVICE_NAME, VERSION } from "../version.js";
import { adminFetch, startTunnelAndVerify } from "../process/daemon.js";
import { detectTunnelBinaries } from "../tunnel/detect.js";
import { needsTunnelChoice, readTunnelState } from "../tunnel/state.js";
import type { RuntimeState } from "../bridge/runtime.js";
import { observeWebTask, stopWebTask } from "../web/state.js";
import { WebError } from "../web/errors.js";
import { DevError } from "./errors.js";
import { captureDevCapability, createDevEnvironment, environmentFromCapability } from "./environment.js";
import {
  capabilityFromRuntime,
  clearDevRuntime,
  findDevObservation,
  readDevRuntime,
  writeDevRuntime,
  type DevRuntimeState,
} from "./runtime.js";
import { tunnelIdentityFor, type DevProfile } from "./profile.js";
import type { MountAccess } from "./mounts.js";

function cliEntry(): { cmd: string; args: string[] } {
  const distEntry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cli", "index.js");
  if (fs.existsSync(distEntry)) {
    return { cmd: process.execPath, args: [distEntry] };
  }
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  return { cmd: process.execPath, args: ["--import", "tsx/esm", path.join(projectRoot, "src", "cli", "index.ts")] };
}

function asBridgeRuntime(runtime: DevRuntimeState): RuntimeState {
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

export function accessLabel(access: MountAccess, mode: "write" | "poc"): string {
  if (access === "ro") return "ro";
  return mode === "poc" ? "rw+poc" : "rw";
}

async function waitHealthy(name: string, child: { exitCode: number | null }, logFile: string): Promise<DevRuntimeState> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const observation = await findDevObservation(name);
    if (observation.state === "healthy") return observation.runtime;
    if (child.exitCode !== null && child.exitCode !== 0) {
      throw new DevError("DEV_UP_FAILED", `Environment bridge exited with code ${child.exitCode}. See ${logFile}`);
    }
  }
  throw new DevError("DEV_UP_FAILED", `Environment bridge did not become healthy within 20s. See ${logFile}`);
}

export async function ensureEnvironmentRunning(profile: DevProfile): Promise<{
  runtime: DevRuntimeState;
  spawned: boolean;
}> {
  const observation = await findDevObservation(profile.name);
  if (observation.state === "healthy") return { runtime: observation.runtime, spawned: false };
  if (observation.state === "unknown") {
    throw new DevError(
      "DEV_STOP_PID_UNCERTAIN",
      `Environment '${profile.name}' is in an uncertain state (${observation.reason}); refusing to start another bridge`
    );
  }

  const startedAt = new Date().toISOString();
  const env = createDevEnvironment(profile, startedAt);
  const snapshot = captureDevCapability(env);
  writeDevRuntime({
    service: SERVICE_NAME,
    version: VERSION,
    ...snapshot,
    pid: 0,
    port: 0,
    adminToken: "",
    publicUrl: null,
    status: "starting",
  });

  const logDir = ensureDir(path.join(getStateDir(), "logs"));
  const logFile = path.join(logDir, `dev-${profile.name}.out.log`);
  const out = fs.openSync(logFile, "a", 0o600);
  try {
    fs.chmodSync(logFile, 0o600);
  } catch {
    // filesystems without chmod
  }
  const { cmd, args } = cliEntry();
  const child = spawn(cmd, [...args, "serve-dev", "--name", profile.name], {
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env },
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(out);

  try {
    const runtime = await waitHealthy(profile.name, child, logFile);
    return { runtime, spawned: true };
  } catch (error) {
    try {
      if (child.pid) process.kill(child.pid, "SIGTERM");
    } catch {
      // spawned child already gone
    }
    clearDevRuntime(profile.name);
    throw error;
  }
}

export async function attachTunnel(runtime: DevRuntimeState): Promise<{
  runtime: DevRuntimeState;
  publicVerification: "direct" | "system-proxy";
}> {
  const tunnelId = tunnelIdentityFor(runtime.environmentName);
  if (needsTunnelChoice(readTunnelState(tunnelId))) {
    throw new Error("TUNNEL_CHOICE_REQUIRED");
  }
  const binaries = detectTunnelBinaries();
  if (!binaries.cloudflared) {
    throw new Error("NEED_CLOUDFLARED: cloudflared is not installed. Install it first (macOS: brew install cloudflared).");
  }
  const started = await startTunnelAndVerify(asBridgeRuntime(runtime), runtime.environmentId);
  const latest = readDevRuntime(runtime.environmentName);
  if (!latest) throw new DevError("DEV_UP_FAILED", "Environment runtime disappeared after tunnel start");
  return { runtime: latest, publicVerification: started.transport };
}

export async function upDevEnvironment(input: {
  profile: DevProfile;
  tunnel?: boolean;
}): Promise<{
  runtime: DevRuntimeState;
  spawned: boolean;
  localMcpUrl: string;
  publicMcpUrl: string | null;
  publicVerification: "direct" | "system-proxy" | null;
}> {
  let spawned = false;
  try {
    const ensured = await ensureEnvironmentRunning(input.profile);
    spawned = ensured.spawned;
    let runtime = ensured.runtime;
    let publicVerification: "direct" | "system-proxy" | null = null;
    if (input.tunnel) {
      const attached = await attachTunnel(runtime);
      runtime = attached.runtime;
      publicVerification = attached.publicVerification;
    }
    const localMcpUrl = `http://127.0.0.1:${runtime.port}/mcp`;
    const publicMcpUrl = runtime.publicUrl ? `${runtime.publicUrl.replace(/\/+$/, "")}/mcp` : null;
    return { runtime, spawned, localMcpUrl, publicMcpUrl, publicVerification };
  } catch (error) {
    if (spawned) {
      try {
        await downDevEnvironment(input.profile.name, { ignoreChat: true });
      } catch {
        clearDevRuntime(input.profile.name);
      }
    }
    throw error;
  }
}

export async function downDevEnvironment(
  name: string,
  opts: { ignoreChat?: boolean } = {}
): Promise<{ stopped: boolean; profilePreserved: true }> {
  const runtime = readDevRuntime(name);
  if (!opts.ignoreChat) {
    const web = observeWebTask();
    if (web.state === "unknown") {
      throw new WebError(
        "WEB_STOP_PID_UNCERTAIN",
        "A recorded PID is live but unproven; refusing to stop the environment"
      );
    }
    if (
      web.state === "running" &&
      web.runtime.kind === "dev" &&
      runtime &&
      web.runtime.workspaceId === runtime.environmentId
    ) {
      await stopWebTask();
    }
  }

  const observation = await findDevObservation(name);
  if (observation.state === "unknown") {
    throw new DevError(
      "DEV_STOP_PID_UNCERTAIN",
      `Environment PID is live but unproven (${observation.reason}); refusing to signal it`
    );
  }
  if (observation.state === "stopped") {
    clearDevRuntime(name);
    return { stopped: false, profilePreserved: true };
  }

  const live = observation.runtime;
  try {
    await adminFetch(asBridgeRuntime(live), "POST", "/admin/tunnel/stop", 5000).catch(() => undefined);
    await adminFetch(asBridgeRuntime(live), "POST", "/admin/revoke-all", 5000).catch(() => undefined);
    await adminFetch(asBridgeRuntime(live), "POST", "/admin/shutdown", 5000);
  } catch {
    try {
      process.kill(live.pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const current = await findDevObservation(name);
    if (current.state === "stopped") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  clearDevRuntime(name);
  return { stopped: true, profilePreserved: true };
}

export async function statusDevEnvironment(
  name: string,
  opts: { verbose?: boolean } = {}
): Promise<Record<string, unknown>> {
  const observation = await findDevObservation(name);
  const runtime = observation.state === "healthy" ? observation.runtime : readDevRuntime(name);
  const web = observeWebTask();
  const chatRunning =
    web.state === "running" &&
    web.runtime.kind === "dev" &&
    runtime &&
    web.runtime.workspaceId === runtime.environmentId;
  const mounts = (runtime?.mounts ?? []).map((mount) => ({
    alias: mount.alias,
    access: mount.access,
    mode: mount.access === "ro" ? "read-only" : runtime?.mode,
    root: `workspace://${mount.alias}/`,
    ...(opts.verbose ? { localRoot: mount.root } : {}),
  }));
  return {
    ok: true,
    name,
    running: observation.state === "healthy",
    environmentId: runtime?.environmentId ?? null,
    bridgeRunning: observation.state === "healthy",
    tunnelRunning: Boolean(runtime?.publicUrl),
    chatRunning: Boolean(chatRunning),
    mode: runtime?.mode ?? null,
    mounts,
  };
}

export function addressDevEnvironment(name: string): {
  local: string | null;
  public: string | null;
  preferred: string | null;
} {
  const runtime = readDevRuntime(name);
  if (!runtime || runtime.status !== "running" || !runtime.port) {
    return { local: null, public: null, preferred: null };
  }
  const local = `http://127.0.0.1:${runtime.port}/mcp`;
  const pub = runtime.publicUrl ? `${runtime.publicUrl.replace(/\/+$/, "")}/mcp` : null;
  return { local, public: pub, preferred: pub ?? local };
}

export function loadRunningEnvironment(name: string) {
  const runtime = readDevRuntime(name);
  if (!runtime || runtime.status !== "running") {
    throw new DevError("DEV_NOT_RUNNING", `Development environment '${name}' is not running`);
  }
  return environmentFromCapability(capabilityFromRuntime(runtime));
}
