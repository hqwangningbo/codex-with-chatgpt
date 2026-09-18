import fs from "node:fs";
import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";

export type WriteScopeMode = "write" | "poc";

export interface WriteScopeState {
  workspaceId: string;
  root: string;
  mode: WriteScopeMode;
  createdAt: string;
  expiresAt: string;
  bridgeStartedAt: string;
}

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

export interface WriteScopeInfo {
  active: boolean;
  root?: string;
  mode?: WriteScopeMode;
}

export function writeScopeFile(workspaceId: string): string {
  return path.join(getStateDir(), "write-scopes", `${workspaceId}.json`);
}

export function readWriteScopeState(workspaceId: string): WriteScopeState | null {
  const state = readJsonIfExists<WriteScopeState>(writeScopeFile(workspaceId));
  if (
    !state ||
    state.workspaceId !== workspaceId ||
    (state.mode !== "write" && state.mode !== "poc") ||
    typeof state.root !== "string" ||
    typeof state.bridgeStartedAt !== "string" ||
    typeof state.expiresAt !== "string"
  ) {
    return null;
  }
  return state;
}

export function activeWriteScope(workspaceId: string, bridgeStartedAt: string): WriteScopeState | null {
  const state = readWriteScopeState(workspaceId);
  if (!state || state.bridgeStartedAt !== bridgeStartedAt) return null;
  const expires = Date.parse(state.expiresAt);
  if (!Number.isFinite(expires) || expires <= Date.now()) return null;
  return state;
}

export function writeScopeInfo(workspaceId: string, bridgeStartedAt?: string): WriteScopeInfo {
  if (!bridgeStartedAt) return { active: false };
  const state = activeWriteScope(workspaceId, bridgeStartedAt);
  return state ? { active: true, root: state.root, mode: state.mode } : { active: false };
}

export function setWriteScope(input: {
  workspaceId: string;
  root: string;
  mode: WriteScopeMode;
  bridgeStartedAt: string;
}): WriteScopeState {
  const createdAt = new Date();
  const state: WriteScopeState = {
    ...input,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + DEFAULT_TTL_MS).toISOString(),
  };
  writeSecureJson(writeScopeFile(input.workspaceId), state);
  return state;
}

export function clearWriteScope(workspaceId: string): void {
  try {
    fs.rmSync(writeScopeFile(workspaceId), { force: true });
  } catch {
    // A missing or already-removed scope is inactive.
  }
}
