import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { SERVICE_NAME, VERSION } from "../version.js";
import { hashOwnerCommand, inspectProcess, type ProcessIdentity } from "../web/state.js";
import { MultiError } from "./errors.js";
import { assertProfileName } from "./mounts.js";

export interface MultiRuntimeState {
  service: string;
  version: string;
  environmentId: string;
  environmentName: string;
  profileId: string;
  startedAt: string;
  generation: number;
  aliases: string[];
  pid: number;
  port: number;
  adminToken: string;
  publicUrl: string | null;
  status: "starting" | "running" | "stopped";
  processStartedAt: string | null;
  commandHash: string | null;
}

function runtimeDir(): string {
  return ensureDir(path.join(getStateDir(), "multi", "runtime"));
}

export function multiRuntimeFile(name: string): string {
  return path.join(runtimeDir(), `${assertProfileName(name)}.json`);
}

export function writeMultiRuntime(state: MultiRuntimeState): void {
  const { command: _ignored, ...safe } = state as MultiRuntimeState & { command?: unknown };
  writeSecureJson(multiRuntimeFile(safe.environmentName), {
    ...safe,
    processStartedAt: safe.processStartedAt ?? null,
    commandHash: safe.commandHash ?? null,
  });
}

export function readMultiRuntime(name: string): MultiRuntimeState | null {
  const raw = readJsonIfExists<MultiRuntimeState & { command?: unknown }>(multiRuntimeFile(name));
  if (!raw || raw.environmentName !== name) return null;
  if (!raw.environmentId || !raw.profileId || !raw.startedAt) return null;
  const { command: _ignored, ...safe } = raw;
  return {
    ...safe,
    aliases: Array.isArray(safe.aliases) ? safe.aliases : [],
    generation: Number.isInteger(safe.generation) ? safe.generation : 0,
    processStartedAt: safe.processStartedAt ?? null,
    commandHash: safe.commandHash ?? null,
  };
}

export function clearMultiRuntime(name: string): void {
  try {
    fs.rmSync(multiRuntimeFile(name), { force: true });
  } catch {
    // already gone
  }
}

export function ownerIdentityFor(
  pid: number,
  previous?: Pick<MultiRuntimeState, "pid" | "processStartedAt" | "commandHash"> | null
): { processStartedAt: string | null; commandHash: string | null } {
  if (previous && previous.pid === pid && previous.processStartedAt && previous.commandHash) {
    return { processStartedAt: previous.processStartedAt, commandHash: previous.commandHash };
  }
  const live = inspectProcess(pid);
  return {
    processStartedAt: live.startedAt,
    commandHash: live.command ? hashOwnerCommand(live.command) : null,
  };
}

export function isMultiBridgeCommand(command: string | null): boolean {
  if (!command) return false;
  const text = command.toLowerCase();
  const harness =
    text.includes("c2c") ||
    text.includes("cli/index.ts") ||
    text.includes("cli/index.js") ||
    text.includes("serve-multi");
  return harness && /\bserve-multi\b/.test(text);
}

export function isProvenMultiOwner(runtime: MultiRuntimeState, live: ProcessIdentity): boolean {
  if (!Number.isInteger(runtime.pid) || runtime.pid <= 0) return false;
  if (!live.alive) return false;
  if (!runtime.processStartedAt || !live.startedAt) return false;
  if (runtime.processStartedAt !== live.startedAt) return false;
  if (!isMultiBridgeCommand(live.command)) return false;
  if (!runtime.commandHash || !live.command || hashOwnerCommand(live.command) !== runtime.commandHash) {
    return false;
  }
  return true;
}

export type MultiBridgeObservation =
  | { state: "healthy"; runtime: MultiRuntimeState }
  | { state: "stopped"; runtime: MultiRuntimeState | null; reason: "runtime_missing" | "pid_missing" }
  | {
      state: "unknown";
      runtime: MultiRuntimeState | null;
      reason: "probe_failed" | "pid_unknown" | "environment_mismatch" | "session_mismatch";
    };

export interface MultiHealthPayload {
  service: string;
  status: string;
  environmentId: string;
  environmentName: string;
  repoCount: number;
  startedAt: string;
}

export async function probeMultiBridge(port: number, timeoutMs = 2000): Promise<MultiHealthPayload | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return null;
    const body = (await response.json()) as MultiHealthPayload;
    if (body.service !== SERVICE_NAME || body.status !== "ok") return null;
    return body;
  } catch {
    return null;
  }
}

function observePid(pid: number): "present" | "missing" | "unknown" {
  if (!Number.isInteger(pid) || pid <= 0) return "unknown";
  try {
    process.kill(pid, 0);
    return "present";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "missing" : "unknown";
  }
}

export async function findMultiObservation(name: string): Promise<MultiBridgeObservation> {
  const runtime = readMultiRuntime(name);
  if (!runtime) return { state: "stopped", runtime: null, reason: "runtime_missing" };
  const health = await probeMultiBridge(runtime.port);
  if (health && health.environmentId === runtime.environmentId) {
    if (health.startedAt !== runtime.startedAt || health.environmentName !== runtime.environmentName) {
      return { state: "unknown", runtime, reason: "session_mismatch" };
    }
    return { state: "healthy", runtime };
  }
  if (health) return { state: "unknown", runtime, reason: "environment_mismatch" };
  const pid = observePid(runtime.pid);
  if (pid === "missing") return { state: "stopped", runtime, reason: "pid_missing" };
  return { state: "unknown", runtime, reason: pid === "unknown" ? "pid_unknown" : "probe_failed" };
}

export function throwIfUncertain(name: string, observation: MultiBridgeObservation): void {
  if (observation.state === "unknown") {
    throw new MultiError(
      "MULTI_STOP_PID_UNCERTAIN",
      `Multi environment '${name}' is in an uncertain state (${observation.reason})`
    );
  }
}
