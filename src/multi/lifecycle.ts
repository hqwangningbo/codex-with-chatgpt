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
import { inspectProcess } from "../web/state.js";
import { MultiError, errorCodeOf, errorMessageOf } from "./errors.js";
import {
  addRepoToProfile,
  environmentIdFor,
  readMultiProfile,
  removeRepoFromProfile,
  tunnelIdentityFor,
  writeMultiProfile,
  type MultiProfile,
} from "./profile.js";
import { assertProfileName } from "./mounts.js";
import {
  clearMultiRuntime,
  findMultiObservation,
  isProvenMultiOwner,
  readMultiRuntime,
  writeMultiRuntime,
  type MultiRuntimeState,
} from "./runtime.js";

export const MULTI_STOP_WAIT_MS = 10_000;

function cliEntry(): { cmd: string; args: string[] } {
  const distEntry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cli", "index.js");
  if (fs.existsSync(distEntry)) {
    return { cmd: process.execPath, args: [distEntry] };
  }
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  return { cmd: process.execPath, args: ["--import", "tsx/esm", path.join(projectRoot, "src", "cli", "index.ts")] };
}

function asBridgeRuntime(runtime: MultiRuntimeState): RuntimeState {
  return {
    service: runtime.service,
    version: runtime.version,
    workspaceId: runtime.environmentId,
    workspaceRoot: runtime.environmentName,
    pid: runtime.pid,
    port: runtime.port,
    adminToken: runtime.adminToken,
    publicUrl: runtime.publicUrl,
    startedAt: runtime.startedAt,
  };
}

async function waitHealthy(name: string, child: { exitCode: number | null }, logFile: string): Promise<MultiRuntimeState> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const observation = await findMultiObservation(name);
    if (observation.state === "healthy") return observation.runtime;
    if (child.exitCode !== null && child.exitCode !== 0) {
      throw new MultiError("MULTI_UP_FAILED", `Multi-repo bridge exited with code ${child.exitCode}. See ${logFile}`);
    }
  }
  throw new MultiError("MULTI_UP_FAILED", `Multi-repo bridge did not become healthy within 20s. See ${logFile}`);
}

export async function ensureMultiRunning(profile: MultiProfile): Promise<{
  runtime: MultiRuntimeState;
  spawned: boolean;
}> {
  const observation = await findMultiObservation(profile.name);
  if (observation.state === "healthy") {
    if (observation.runtime.environmentId !== environmentIdFor(profile.profileId)) {
      throw new MultiError(
        "MULTI_ALREADY_RUNNING",
        `A different Multi environment is recorded as running for '${profile.name}'`
      );
    }
    return { runtime: observation.runtime, spawned: false };
  }
  if (observation.state === "unknown") {
    throw new MultiError(
      "MULTI_STOP_PID_UNCERTAIN",
      `Multi environment '${profile.name}' is in an uncertain state (${observation.reason}); refusing to start another bridge`
    );
  }

  const startedAt = new Date().toISOString();
  writeMultiRuntime({
    service: SERVICE_NAME,
    version: VERSION,
    environmentId: environmentIdFor(profile.profileId),
    environmentName: profile.name,
    profileId: profile.profileId,
    startedAt,
    generation: 0,
    aliases: Object.keys(profile.repos).sort(),
    pid: 0,
    port: 0,
    adminToken: "",
    publicUrl: null,
    status: "starting",
    processStartedAt: null,
    commandHash: null,
  });

  const logDir = ensureDir(path.join(getStateDir(), "logs"));
  const logFile = path.join(logDir, `multi-${profile.name}.out.log`);
  const out = fs.openSync(logFile, "a", 0o600);
  try {
    fs.chmodSync(logFile, 0o600);
  } catch {
    // filesystems without chmod
  }
  const { cmd, args } = cliEntry();
  const child = spawn(cmd, [...args, "serve-multi", "--name", profile.name], {
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
    clearMultiRuntime(profile.name);
    throw error;
  }
}

export async function attachTunnel(runtime: MultiRuntimeState): Promise<{
  runtime: MultiRuntimeState;
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
  const latest = readMultiRuntime(runtime.environmentName);
  if (!latest) throw new MultiError("MULTI_UP_FAILED", "Multi runtime disappeared after tunnel start");
  return { runtime: latest, publicVerification: started.transport };
}

export async function stopMultiTunnel(name: string): Promise<void> {
  const observation = await findMultiObservation(name);
  if (observation.state !== "healthy") return;
  await adminFetch(asBridgeRuntime(observation.runtime), "POST", "/admin/tunnel/stop", 5000);
  const latest = readMultiRuntime(name);
  if (latest) writeMultiRuntime({ ...latest, publicUrl: null });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntilStopped(name: string, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    const current = await findMultiObservation(name);
    if (current.state === "stopped") return true;
    await sleep(100);
  }
  return false;
}

export async function upMultiEnvironment(input: {
  profile: MultiProfile;
  tunnel?: boolean;
  waitMs?: number;
}): Promise<{
  runtime: MultiRuntimeState;
  spawned: boolean;
  localMcpUrl: string;
  publicMcpUrl: string | null;
  publicVerification: "direct" | "system-proxy" | null;
}> {
  const started = { bridge: false, tunnel: false };
  try {
    const ensured = await ensureMultiRunning(input.profile);
    started.bridge = ensured.spawned;
    let runtime = ensured.runtime;
    let publicVerification: "direct" | "system-proxy" | null = null;
    if (input.tunnel && !runtime.publicUrl) {
      const attached = await attachTunnel(runtime);
      runtime = attached.runtime;
      publicVerification = attached.publicVerification;
      started.tunnel = true;
    }
    const localMcpUrl = `http://127.0.0.1:${runtime.port}/mcp`;
    const publicMcpUrl = runtime.publicUrl ? `${runtime.publicUrl.replace(/\/+$/, "")}/mcp` : null;
    return { runtime, spawned: started.bridge, localMcpUrl, publicMcpUrl, publicVerification };
  } catch (error) {
    if (started.bridge || started.tunnel) {
      try {
        if (started.bridge) await downMultiEnvironment(input.profile.name, { waitMs: input.waitMs });
        else await stopMultiTunnel(input.profile.name);
      } catch (rollbackError) {
        throw new MultiError(
          "MULTI_ROLLBACK_FAILED",
          `MULTI_ROLLBACK_FAILED: original=${errorCodeOf(error)} rollback=${errorCodeOf(rollbackError)}`,
          { code: errorCodeOf(error), message: errorMessageOf(error) },
          { code: errorCodeOf(rollbackError), message: errorMessageOf(rollbackError) }
        );
      }
    }
    throw error;
  }
}

async function assertProvenMultiBridge(runtime: MultiRuntimeState): Promise<void> {
  let info: { environmentId?: string; pid?: number; startedAt?: string };
  try {
    info = await adminFetch(asBridgeRuntime(runtime), "GET", "/admin/info", 5000);
  } catch {
    throw new MultiError(
      "MULTI_STOP_PID_UNCERTAIN",
      "Multi admin identity could not be proven; refusing to signal it"
    );
  }
  if (info.environmentId !== runtime.environmentId || info.pid !== runtime.pid || info.startedAt !== runtime.startedAt) {
    throw new MultiError(
      "MULTI_STOP_PID_UNCERTAIN",
      "Multi admin identity mismatch; refusing to signal the recorded PID"
    );
  }
  const live = inspectProcess(runtime.pid);
  if (!isProvenMultiOwner(runtime, live)) {
    throw new MultiError(
      "MULTI_STOP_PID_UNCERTAIN",
      "Multi PID is live but is not a proven serve-multi owner; refusing to signal it"
    );
  }
}

export async function downMultiEnvironment(
  name: string,
  opts: { waitMs?: number } = {}
): Promise<{ stopped: boolean; profilePreserved: true }> {
  const waitMs = opts.waitMs && opts.waitMs > 0 ? opts.waitMs : MULTI_STOP_WAIT_MS;
  const observation = await findMultiObservation(name);
  if (observation.state === "unknown") {
    throw new MultiError(
      "MULTI_STOP_PID_UNCERTAIN",
      `Multi PID is live but unproven (${observation.reason}); refusing to signal it`
    );
  }
  if (observation.state === "stopped") {
    clearMultiRuntime(name);
    return { stopped: false, profilePreserved: true };
  }

  const live = observation.runtime;
  await assertProvenMultiBridge(live);
  try {
    await adminFetch(asBridgeRuntime(live), "POST", "/admin/tunnel/stop", 5000).catch(() => undefined);
    await adminFetch(asBridgeRuntime(live), "POST", "/admin/revoke-all", 5000).catch(() => undefined);
    await adminFetch(asBridgeRuntime(live), "POST", "/admin/shutdown", 5000);
  } catch {
    // Authenticated shutdown may be unavailable; SIGTERM the proven PID below.
  }

  try {
    process.kill(live.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }

  const deadline = Date.now() + waitMs;
  if (await waitUntilStopped(name, deadline)) {
    clearMultiRuntime(name);
    return { stopped: true, profilePreserved: true };
  }

  throw new MultiError(
    "MULTI_STOP_TIMEOUT",
    `Multi Bridge pid ${live.pid} did not exit after shutdown/SIGTERM; runtime kept`
  );
}

export async function statusMultiEnvironment(
  name: string,
  opts: { verbose?: boolean } = {}
): Promise<Record<string, unknown>> {
  const observation = await findMultiObservation(name);
  const runtime = observation.state === "healthy" ? observation.runtime : readMultiRuntime(name);
  const profile = readMultiProfile(name);
  const aliases = runtime?.aliases ?? (profile ? Object.keys(profile.repos).sort() : []);
  const repos = aliases.map((alias) => ({
    alias,
    root: `workspace://${alias}/`,
    ...(opts.verbose && profile?.repos[alias] ? { localRoot: profile.repos[alias].root } : {}),
  }));
  return {
    ok: true,
    name,
    running: observation.state === "healthy",
    environmentId: runtime?.environmentId ?? (profile ? environmentIdFor(profile.profileId) : null),
    bridge: observation.state === "healthy" ? "running" : "stopped",
    tunnel: runtime?.publicUrl ? "running" : "stopped",
    generation: runtime?.generation ?? 0,
    repos,
  };
}

export function addressMultiEnvironment(name: string): {
  local: string | null;
  public: string | null;
  preferred: string | null;
} {
  const runtime = readMultiRuntime(name);
  if (!runtime || runtime.status !== "running" || !runtime.port) {
    return { local: null, public: null, preferred: null };
  }
  const local = `http://127.0.0.1:${runtime.port}/mcp`;
  const pub = runtime.publicUrl ? `${runtime.publicUrl.replace(/\/+$/, "")}/mcp` : null;
  return { local, public: pub, preferred: pub ?? local };
}

export async function addMultiRepo(name: string, aliasPath: string): Promise<{ running: boolean; generation: number | null }> {
  const profileName = assertProfileName(name);
  const observation = await findMultiObservation(profileName);
  if (observation.state === "unknown") {
    throw new MultiError(
      "MULTI_STOP_PID_UNCERTAIN",
      `Multi environment '${profileName}' is in an uncertain state (${observation.reason})`
    );
  }
  if (observation.state === "healthy") {
    const eq = aliasPath.indexOf("=");
    const alias = eq > 0 ? aliasPath.slice(0, eq) : "";
    const root = eq > 0 ? aliasPath.slice(eq + 1) : "";
    const result = await adminFetch<{ generation?: number }>(
      asBridgeRuntime(observation.runtime),
      "POST",
      "/admin/workspaces/add",
      10_000,
      { alias, root }
    );
    return { running: true, generation: result.generation ?? null };
  }
  const existing = readMultiProfile(profileName);
  if (!existing) throw new MultiError("MULTI_PROFILE_NOT_FOUND", `No saved multi profile named '${profileName}'`);
  writeMultiProfile(addRepoToProfile(existing, aliasPath));
  return { running: false, generation: null };
}

export async function removeMultiRepo(name: string, alias: string): Promise<{ running: boolean; generation: number | null }> {
  const profileName = assertProfileName(name);
  const observation = await findMultiObservation(profileName);
  if (observation.state === "unknown") {
    throw new MultiError(
      "MULTI_STOP_PID_UNCERTAIN",
      `Multi environment '${profileName}' is in an uncertain state (${observation.reason})`
    );
  }
  if (observation.state === "healthy") {
    const result = await adminFetch<{ generation?: number }>(
      asBridgeRuntime(observation.runtime),
      "POST",
      "/admin/workspaces/remove",
      10_000,
      { alias }
    );
    return { running: true, generation: result.generation ?? null };
  }
  const existing = readMultiProfile(profileName);
  if (!existing) throw new MultiError("MULTI_PROFILE_NOT_FOUND", `No saved multi profile named '${profileName}'`);
  writeMultiProfile(removeRepoFromProfile(existing, alias));
  return { running: false, generation: null };
}

export function listMultiRepos(name: string, opts: { verbose?: boolean } = {}): Record<string, unknown> {
  const profile = readMultiProfile(assertProfileName(name));
  if (!profile) throw new MultiError("MULTI_PROFILE_NOT_FOUND", `No saved multi profile named '${name}'`);
  return {
    ok: true,
    name: profile.name,
    repos: Object.keys(profile.repos)
      .sort()
      .map((alias) => ({
        alias,
        root: `workspace://${alias}/`,
        ...(opts.verbose ? { localRoot: profile.repos[alias].root } : {}),
      })),
  };
}
