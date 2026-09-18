import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getStateDir } from "../config/paths.js";
import { webProfileDir } from "../web/profile.js";
import { DevError } from "./errors.js";

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";
const normCase = (value: string): string => (CASE_INSENSITIVE ? value.toLowerCase() : value);

export const RESERVED_ALIASES = new Set([
  "workspace",
  "system",
  "state",
  "browser",
  "env",
  "root",
  "home",
  "tmp",
  "temp",
  "proc",
  "dev",
  "c2c",
  "mcp",
  "admin",
  "health",
]);

export const ALIAS_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/;

export type MountAccess = "rw" | "ro";
export type DevMode = "write" | "poc";

export interface ParsedMountFlag {
  alias: string;
  rawPath: string;
}

export function assertAlias(alias: string): string {
  if (!ALIAS_PATTERN.test(alias)) {
    throw new DevError("DEV_INVALID_ALIAS", `Invalid mount alias '${alias}'`);
  }
  if (RESERVED_ALIASES.has(alias.toLowerCase())) {
    throw new DevError("DEV_RESERVED_ALIAS", `Alias '${alias}' is reserved`);
  }
  return alias;
}

export function assertProfileName(name: string): string {
  if (!ALIAS_PATTERN.test(name)) {
    throw new DevError("DEV_INVALID_NAME", `Invalid development environment name '${name}'`);
  }
  return name;
}

export function parseAliasPath(value: string): ParsedMountFlag {
  const index = value.indexOf("=");
  if (index <= 0) {
    throw new DevError("DEV_INVALID_ALIAS", `Expected alias=/absolute/path, received '${value}'`);
  }
  return { alias: assertAlias(value.slice(0, index)), rawPath: value.slice(index + 1) };
}

function realOrResolve(input: string): string {
  const resolved = path.resolve(input);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function contains(parent: string, child: string): boolean {
  const left = normCase(parent);
  const right = normCase(child);
  return right === left || right.startsWith(left + path.sep);
}

export function isForbiddenMountRoot(real: string): boolean {
  const home = realOrResolve(os.homedir());
  const state = realOrResolve(getStateDir());
  const web = realOrResolve(webProfileDir());
  const exact = new Set(
    [
      "/",
      "/private",
      "/Users",
      "/home",
      "/Volumes",
      "/System",
      "/Library",
      home,
      path.parse(real).root,
    ].map((item) => normCase(item.replace(/[\\/]+$/, "") || item))
  );
  if (exact.has(normCase(real))) return true;
  if (contains(real, state) || contains(real, web)) return true;
  if (contains(state, real) || contains(web, real)) return true;
  return false;
}

export function canonicalizeMountRoot(rawPath: string): string {
  if (!rawPath || !rawPath.trim()) {
    throw new DevError("DEV_MOUNT_NOT_FOUND", "Mount path is empty");
  }
  const expanded = rawPath.startsWith("~/") ? path.join(os.homedir(), rawPath.slice(2)) : rawPath;
  let real: string;
  try {
    real = fs.realpathSync.native(path.resolve(expanded));
  } catch {
    throw new DevError("DEV_MOUNT_NOT_FOUND", `Mount path does not exist: ${rawPath}`);
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(real);
  } catch {
    throw new DevError("DEV_MOUNT_NOT_FOUND", `Mount path does not exist: ${rawPath}`);
  }
  if (!stat.isDirectory()) {
    throw new DevError("DEV_MOUNT_NOT_FOUND", `Mount path is not a directory: ${rawPath}`);
  }
  if (isForbiddenMountRoot(real)) {
    throw new DevError("DEV_MOUNT_FORBIDDEN", `Mount root '${rawPath}' is too broad or reserved`);
  }
  return real;
}

export function assertNoMountOverlap(roots: { alias: string; root: string }[]): void {
  for (let i = 0; i < roots.length; i++) {
    for (let j = i + 1; j < roots.length; j++) {
      const a = roots[i];
      const b = roots[j];
      if (normCase(a.root) === normCase(b.root) || contains(a.root, b.root) || contains(b.root, a.root)) {
        throw new DevError(
          "DEV_MOUNT_OVERLAP",
          `Mounts '${a.alias}' and '${b.alias}' overlap`
        );
      }
    }
  }
}

export function canonicalizeWriteRoot(mountRoot: string, requested = "."): string {
  const normalized = requested.replace(/\\/g, "/").trim() || ".";
  if (
    path.isAbsolute(normalized) ||
    /^[a-zA-Z]:[\\/]/.test(normalized) ||
    normalized.startsWith("\\\\") ||
    normalized.split("/").includes("..")
  ) {
    throw new DevError("DEV_INVALID_WRITE_ROOT", "writeRoot must be a directory inside the mount");
  }
  const abs = path.resolve(mountRoot, normalized);
  let real: string;
  try {
    real = fs.realpathSync.native(abs);
  } catch {
    throw new DevError("DEV_INVALID_WRITE_ROOT", `writeRoot '${requested}' does not exist`);
  }
  if (real !== abs) {
    throw new DevError("DEV_INVALID_WRITE_ROOT", "writeRoot must not be a symlink");
  }
  if (!contains(mountRoot, real)) {
    throw new DevError("DEV_INVALID_WRITE_ROOT", "writeRoot must stay inside the mount");
  }
  if (!fs.statSync(real).isDirectory()) {
    throw new DevError("DEV_INVALID_WRITE_ROOT", "writeRoot must be a directory");
  }
  const rel = path.relative(mountRoot, real).split(path.sep).join("/");
  return rel || ".";
}
