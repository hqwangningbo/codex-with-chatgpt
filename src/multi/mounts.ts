import path from "node:path";
import { DevError } from "../dev/errors.js";
import {
  ALIAS_PATTERN,
  RESERVED_ALIASES,
  assertAlias as assertDevAlias,
  assertProfileName as assertDevProfileName,
  canonicalizeMountRoot,
  parseAliasPath as parseDevAliasPath,
} from "../dev/mounts.js";
import { MultiError } from "./errors.js";

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";
const normCase = (value: string): string => (CASE_INSENSITIVE ? value.toLowerCase() : value);

export { ALIAS_PATTERN, RESERVED_ALIASES };

function wrapDev(error: unknown): never {
  if (error instanceof DevError) {
    const mapped: Record<string, MultiError["code"]> = {
      DEV_INVALID_ALIAS: "MULTI_INVALID_ALIAS",
      DEV_RESERVED_ALIAS: "MULTI_RESERVED_ALIAS",
      DEV_INVALID_NAME: "MULTI_INVALID_NAME",
      DEV_MOUNT_NOT_FOUND: "MULTI_MOUNT_NOT_FOUND",
      DEV_MOUNT_FORBIDDEN: "MULTI_MOUNT_FORBIDDEN",
      DEV_MOUNT_OVERLAP: "MULTI_REPO_OVERLAP",
    };
    throw new MultiError(mapped[error.code] ?? "MULTI_MOUNT_FORBIDDEN", error.message);
  }
  throw error;
}

export function assertAlias(alias: string): string {
  try {
    return assertDevAlias(alias);
  } catch (error) {
    wrapDev(error);
  }
}

export function assertProfileName(name: string): string {
  try {
    return assertDevProfileName(name);
  } catch (error) {
    wrapDev(error);
  }
}

export function parseAliasPath(value: string): { alias: string; rawPath: string } {
  try {
    return parseDevAliasPath(value);
  } catch (error) {
    wrapDev(error);
  }
}

export function canonicalizeRepoRoot(rawPath: string): string {
  try {
    return canonicalizeMountRoot(rawPath);
  } catch (error) {
    wrapDev(error);
  }
}

export function assertNoRepoOverlap(roots: { alias: string; root: string }[]): void {
  for (let i = 0; i < roots.length; i++) {
    for (let j = i + 1; j < roots.length; j++) {
      const a = roots[i]!;
      const b = roots[j]!;
      const left = normCase(a.root);
      const right = normCase(b.root);
      if (left === right || right.startsWith(left + path.sep) || left.startsWith(right + path.sep)) {
        throw new MultiError("MULTI_REPO_OVERLAP", `Repos '${a.alias}' and '${b.alias}' overlap`);
      }
    }
  }
}

export function repoOverlaps(
  existing: { alias: string; root: string }[],
  candidate: { alias: string; root: string }
): boolean {
  return existing.some((item) => {
    const left = normCase(item.root);
    const right = normCase(candidate.root);
    return left === right || right.startsWith(left + path.sep) || left.startsWith(right + path.sep);
  });
}
