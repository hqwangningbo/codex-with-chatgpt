import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { SERVICE_NAME, VERSION } from "../version.js";
import { DevError } from "./errors.js";
import type { DevCapabilitySnapshot } from "./environment.js";
import { assertProfileName } from "./mounts.js";

export interface DevRuntimeState extends DevCapabilitySnapshot {
  service: string;
  version: string;
  pid: number;
  port: number;
  adminToken: string;
  publicUrl: string | null;
  status: "starting" | "running" | "stopped";
}

function runtimeDir(): string {
  return ensureDir(path.join(getStateDir(), "dev", "runtime"));
}

export function devRuntimeFile(name: string): string {
  return path.join(runtimeDir(), `${assertProfileName(name)}.json`);
}

export function writeDevRuntime(state: DevRuntimeState): void {
  writeSecureJson(devRuntimeFile(state.environmentName), state);
}

export function readDevRuntime(name: string): DevRuntimeState | null {
  const raw = readJsonIfExists<DevRuntimeState>(devRuntimeFile(name));
  if (!raw || raw.environmentName !== name) return null;
  if (!raw.environmentId || !raw.profileHash || !raw.devStartedAt || !Array.isArray(raw.mounts)) return null;
  return raw;
}

export function clearDevRuntime(name: string): void {
  try {
    fs.rmSync(devRuntimeFile(name), { force: true });
  } catch {
    // already gone
  }
}

export function capabilityFromRuntime(runtime: DevRuntimeState): DevCapabilitySnapshot {
  return {
    environmentId: runtime.environmentId,
    environmentName: runtime.environmentName,
    profileHash: runtime.profileHash,
    devStartedAt: runtime.devStartedAt,
    mode: runtime.mode,
    mounts: runtime.mounts.map((mount) => ({ ...mount })),
  };
}

export function assertLiveCapability(
  snapshot: DevCapabilitySnapshot,
  runtime: DevRuntimeState | null
): void {
  if (!runtime || runtime.status !== "running") {
    throw new DevError("DEV_CAPABILITY_REVOKED", "Development environment is not running");
  }
  if (
    runtime.environmentId !== snapshot.environmentId ||
    runtime.profileHash !== snapshot.profileHash ||
    runtime.devStartedAt !== snapshot.devStartedAt
  ) {
    throw new DevError("DEV_CAPABILITY_REVOKED", "Development environment capability changed");
  }
}

export interface DevHealthPayload {
  service: string;
  version: string;
  status: string;
  workspaceId: string;
  environmentId: string;
  environmentName: string;
  mountCount: number;
  startedAt: string;
}

export async function probeDevBridge(port: number, timeoutMs = 2000): Promise<DevHealthPayload | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return null;
    const body = (await response.json()) as DevHealthPayload;
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

export type DevBridgeObservation =
  | { state: "healthy"; runtime: DevRuntimeState }
  | { state: "stopped"; runtime: DevRuntimeState | null; reason: "runtime_missing" | "pid_missing" }
  | { state: "unknown"; runtime: DevRuntimeState | null; reason: "probe_failed" | "pid_unknown" | "environment_mismatch" };

export async function findDevObservation(name: string): Promise<DevBridgeObservation> {
  const runtime = readDevRuntime(name);
  if (!runtime) return { state: "stopped", runtime: null, reason: "runtime_missing" };
  const health = await probeDevBridge(runtime.port);
  if (health && health.environmentId === runtime.environmentId) {
    return { state: "healthy", runtime };
  }
  if (health) return { state: "unknown", runtime, reason: "environment_mismatch" };
  const pid = observePid(runtime.pid);
  if (pid === "missing") return { state: "stopped", runtime, reason: "pid_missing" };
  return { state: "unknown", runtime, reason: pid === "unknown" ? "pid_unknown" : "probe_failed" };
}
