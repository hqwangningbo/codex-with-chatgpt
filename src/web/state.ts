import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { webRuntimeDir } from "./profile.js";
import { WebError } from "./errors.js";

export type WebTaskStatus = "idle" | "running" | "interrupted" | "completed" | "failed";

export interface WebRuntimeState {
  pid: number | null;
  requestId: string | null;
  workspaceId: string | null;
  startedAt: string | null;
  processStartedAt: string | null;
  command: string | null;
  stepCount: number;
  status: WebTaskStatus;
}

export interface ProcessIdentity {
  alive: boolean;
  startedAt: string | null;
  command: string | null;
}

export type WebTaskObservation =
  | { state: "idle" }
  | { state: "running"; runtime: WebRuntimeState }
  | { state: "unknown"; runtime: WebRuntimeState; reason: "pid_identity_unproven" };

const EMPTY: WebRuntimeState = {
  pid: null,
  requestId: null,
  workspaceId: null,
  startedAt: null,
  processStartedAt: null,
  command: null,
  stepCount: 0,
  status: "idle",
};

export function webRuntimeFile(): string {
  return path.join(webRuntimeDir(), "runtime.json");
}

export function readWebRuntime(): WebRuntimeState {
  const raw = readJsonIfExists<Partial<WebRuntimeState>>(webRuntimeFile());
  if (!raw) return { ...EMPTY };
  return {
    ...EMPTY,
    ...raw,
    processStartedAt: raw.processStartedAt ?? null,
    command: raw.command ?? null,
  };
}

export function inspectProcess(pid: number): ProcessIdentity {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { alive: false, startedAt: null, command: null };
  }
  try {
    process.kill(pid, 0);
  } catch {
    return { alive: false, startedAt: null, command: null };
  }
  if (process.platform === "win32") return inspectWindows(pid);
  return inspectUnix(pid);
}

function inspectUnix(pid: number): ProcessIdentity {
  const started = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    timeout: 3000,
    windowsHide: true,
  });
  const command = spawnSync("ps", ["-p", String(pid), "-ww", "-o", "command="], {
    encoding: "utf8",
    timeout: 3000,
    windowsHide: true,
  });
  if (started.status !== 0) {
    return { alive: true, startedAt: null, command: null };
  }
  return {
    alive: true,
    startedAt: normalizePsField(started.stdout),
    command: normalizePsField(command.stdout),
  };
}

function inspectWindows(pid: number): ProcessIdentity {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object CreationDate,CommandLine | ConvertTo-Json -Compress`,
    ],
    { encoding: "utf8", timeout: 5000, windowsHide: true }
  );
  if (result.status !== 0 || !result.stdout.trim()) {
    return { alive: true, startedAt: null, command: null };
  }
  try {
    const parsed = JSON.parse(result.stdout) as { CreationDate?: string; CommandLine?: string };
    return {
      alive: true,
      startedAt: parsed.CreationDate?.trim() || null,
      command: parsed.CommandLine?.trim() || null,
    };
  } catch {
    return { alive: true, startedAt: null, command: null };
  }
}

function normalizePsField(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim().replace(/\s+/g, " ");
  return trimmed.length > 0 ? trimmed : null;
}

export function isWebResearchCommand(command: string | null): boolean {
  if (!command) return false;
  const text = command.toLowerCase();
  const harness = text.includes("c2c") || text.includes("cli/index.ts") || text.includes("cli/index.js");
  return harness && /\bweb\b/.test(text) && /\bresearch\b/.test(text);
}

export function isProvenWebOwner(state: WebRuntimeState, live: ProcessIdentity): boolean {
  if (state.status !== "running" || !state.pid) return false;
  if (!live.alive) return false;
  if (!state.processStartedAt || !live.startedAt) return false;
  if (state.processStartedAt !== live.startedAt) return false;
  if (!isWebResearchCommand(state.command) || !isWebResearchCommand(live.command)) return false;
  return true;
}

function attachOwnerIdentity(state: WebRuntimeState): WebRuntimeState {
  if (state.pid !== process.pid || state.status !== "running") {
    return {
      ...state,
      processStartedAt: state.processStartedAt ?? null,
      command: state.command ?? null,
    };
  }
  const previous = readJsonIfExists<Partial<WebRuntimeState>>(webRuntimeFile());
  if (previous?.pid === process.pid && previous.processStartedAt && previous.command) {
    return {
      ...state,
      processStartedAt: previous.processStartedAt,
      command: previous.command,
    };
  }
  const live = inspectProcess(process.pid);
  return {
    ...state,
    processStartedAt: live.startedAt,
    command: process.argv.join(" "),
  };
}

export function observeWebTask(): WebTaskObservation {
  const runtime = readWebRuntime();
  if (runtime.status !== "running" || !runtime.pid) return { state: "idle" };
  if (runtime.pid === process.pid) return { state: "running", runtime };
  const live = inspectProcess(runtime.pid);
  if (!live.alive) return { state: "idle" };
  if (isProvenWebOwner(runtime, live)) return { state: "running", runtime };
  return { state: "unknown", runtime, reason: "pid_identity_unproven" };
}

export function activeWebTask(): WebRuntimeState | null {
  const observation = observeWebTask();
  return observation.state === "running" ? observation.runtime : null;
}

export function writeWebRuntime(
  state: Omit<WebRuntimeState, "processStartedAt" | "command"> &
    Partial<Pick<WebRuntimeState, "processStartedAt" | "command">>
): void {
  fs.mkdirSync(webRuntimeDir(), { recursive: true, mode: 0o700 });
  writeSecureJson(
    webRuntimeFile(),
    attachOwnerIdentity({
      ...EMPTY,
      ...state,
      processStartedAt: state.processStartedAt ?? null,
      command: state.command ?? null,
    })
  );
}

export function clearWebRuntime(): void {
  writeWebRuntime({ ...EMPTY });
}

export function markWebInterrupted(): void {
  const state = readWebRuntime();
  writeWebRuntime({ ...state, status: "interrupted", pid: null, processStartedAt: null, command: null });
}

export function stopWebTask(): { ok: true; stopped: true; stale?: boolean } {
  const runtime = readWebRuntime();
  if (runtime.status !== "running" || !runtime.pid) {
    markWebInterrupted();
    return { ok: true, stopped: true, stale: true };
  }
  if (runtime.pid === process.pid) {
    markWebInterrupted();
    return { ok: true, stopped: true };
  }
  const live = inspectProcess(runtime.pid);
  if (!live.alive) {
    markWebInterrupted();
    return { ok: true, stopped: true, stale: true };
  }
  if (!isProvenWebOwner(runtime, live)) {
    throw new WebError(
      "WEB_STOP_PID_UNCERTAIN",
      "Recorded PID is live but is not a proven Web Research owner; refusing to signal it"
    );
  }
  try {
    process.kill(runtime.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  markWebInterrupted();
  return { ok: true, stopped: true };
}
