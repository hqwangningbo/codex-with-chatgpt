import fs from "node:fs";
import path from "node:path";
import { readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { webRuntimeDir } from "./profile.js";

export type WebTaskStatus = "idle" | "running" | "interrupted" | "completed" | "failed";

export interface WebRuntimeState {
  pid: number | null;
  requestId: string | null;
  workspaceId: string | null;
  startedAt: string | null;
  stepCount: number;
  status: WebTaskStatus;
}

const EMPTY: WebRuntimeState = {
  pid: null,
  requestId: null,
  workspaceId: null,
  startedAt: null,
  stepCount: 0,
  status: "idle",
};

export function webRuntimeFile(): string {
  return path.join(webRuntimeDir(), "runtime.json");
}

export function readWebRuntime(): WebRuntimeState {
  return readJsonIfExists<WebRuntimeState>(webRuntimeFile()) ?? { ...EMPTY };
}

function pidAlive(pid: number | null): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function activeWebTask(): WebRuntimeState | null {
  const state = readWebRuntime();
  if (state.status === "running" && pidAlive(state.pid)) return state;
  return null;
}

export function writeWebRuntime(state: WebRuntimeState): void {
  fs.mkdirSync(webRuntimeDir(), { recursive: true, mode: 0o700 });
  writeSecureJson(webRuntimeFile(), state);
}

export function clearWebRuntime(): void {
  writeWebRuntime({ ...EMPTY });
}

export function markWebInterrupted(): void {
  const state = readWebRuntime();
  writeWebRuntime({ ...state, status: "interrupted", pid: null });
}
