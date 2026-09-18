import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir } from "../config/paths.js";

export function webProfileDir(): string {
  return path.join(getStateDir(), "web-profile");
}

export function webRuntimeDir(): string {
  return path.join(getStateDir(), "web");
}

export function ensureWebProfileDir(): string {
  const dir = ensureDir(webProfileDir());
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Filesystems without chmod still keep the profile out of the workspace.
  }
  return dir;
}

export function webProfileExists(): boolean {
  try {
    return fs.existsSync(webProfileDir()) && fs.statSync(webProfileDir()).isDirectory();
  } catch {
    return false;
  }
}

export function clearWebProfile(): void {
  fs.rmSync(webProfileDir(), { recursive: true, force: true });
}
