import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { getStateDir, readJsonIfExists, writeSecureJson, ensureDir } from "../config/paths.js";
import { DevError } from "./errors.js";
import {
  assertAlias,
  assertNoMountOverlap,
  assertProfileName,
  canonicalizeMountRoot,
  canonicalizeWriteRoot,
  parseAliasPath,
  type DevMode,
  type MountAccess,
} from "./mounts.js";

export interface DevProfileMount {
  root: string;
  access: MountAccess;
  writeRoot: string;
}

export interface DevProfile {
  name: string;
  mounts: Record<string, DevProfileMount>;
  mode: DevMode;
}

export interface ResolvedMount {
  alias: string;
  root: string;
  access: MountAccess;
  writeRoot: string;
}

function profilesDir(): string {
  return ensureDir(path.join(getStateDir(), "dev", "profiles"));
}

export function profileFile(name: string): string {
  return path.join(profilesDir(), `${assertProfileName(name)}.json`);
}

export function identityPayload(profile: Pick<DevProfile, "name" | "mounts" | "mode">): string {
  const mounts = Object.keys(profile.mounts)
    .sort()
    .map((alias) => ({
      alias,
      root: profile.mounts[alias].root,
      access: profile.mounts[alias].access,
      writeRoot: profile.mounts[alias].writeRoot,
    }));
  return JSON.stringify({ name: profile.name, mounts, mode: profile.mode });
}

export function profileHash(profile: Pick<DevProfile, "name" | "mounts" | "mode">): string {
  return createHash("sha256").update(identityPayload(profile)).digest("hex");
}

export function environmentIdFor(profile: Pick<DevProfile, "name" | "mounts" | "mode">): string {
  return `c2c_de_${profileHash(profile).slice(0, 24)}`;
}

export function tunnelIdentityFor(name: string): string {
  return `devp_${createHash("sha256").update(assertProfileName(name)).digest("hex").slice(0, 12)}`;
}

function parseProfile(raw: unknown, expectedName?: string): DevProfile {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new DevError("DEV_PROFILE_NOT_FOUND", "Saved profile is malformed");
  }
  const record = raw as Record<string, unknown>;
  const name = typeof record.name === "string" ? assertProfileName(record.name) : "";
  if (!name || (expectedName && name !== expectedName)) {
    throw new DevError("DEV_PROFILE_NOT_FOUND", "Saved profile is malformed");
  }
  const mode = record.mode === "poc" || record.mode === "write" ? record.mode : null;
  if (!mode) throw new DevError("DEV_PROFILE_NOT_FOUND", "Saved profile is malformed");
  if (!record.mounts || typeof record.mounts !== "object" || Array.isArray(record.mounts)) {
    throw new DevError("DEV_PROFILE_NOT_FOUND", "Saved profile is malformed");
  }
  const mounts: Record<string, DevProfileMount> = {};
  for (const [alias, value] of Object.entries(record.mounts as Record<string, unknown>)) {
    assertAlias(alias);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new DevError("DEV_PROFILE_NOT_FOUND", "Saved profile is malformed");
    }
    const mount = value as Record<string, unknown>;
    if (typeof mount.root !== "string" || (mount.access !== "rw" && mount.access !== "ro")) {
      throw new DevError("DEV_PROFILE_NOT_FOUND", "Saved profile is malformed");
    }
    mounts[alias] = {
      root: mount.root,
      access: mount.access,
      writeRoot: typeof mount.writeRoot === "string" ? mount.writeRoot : ".",
    };
  }
  if (Object.keys(mounts).length === 0) {
    throw new DevError("DEV_PROFILE_NOT_FOUND", "Saved profile has no mounts");
  }
  return { name, mounts, mode };
}

export function readDevProfile(name: string): DevProfile | null {
  const raw = readJsonIfExists<unknown>(profileFile(name));
  if (!raw) return null;
  return parseProfile(raw, name);
}

export function writeDevProfile(profile: DevProfile): void {
  writeSecureJson(profileFile(profile.name), profile);
}

export function listDevProfiles(): string[] {
  let files: string[] = [];
  try {
    files = fs.readdirSync(profilesDir());
  } catch {
    return [];
  }
  return files
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -5))
    .filter((name) => {
      try {
        return Boolean(readDevProfile(name));
      } catch {
        return false;
      }
    })
    .sort();
}

export function deleteDevProfile(name: string): void {
  try {
    fs.rmSync(profileFile(name), { force: true });
  } catch {
    // missing profile is already gone
  }
}

export function resolvedMounts(profile: DevProfile): ResolvedMount[] {
  const mounts = Object.entries(profile.mounts).map(([alias, mount]) => {
    const root = canonicalizeMountRoot(mount.root);
    return {
      alias: assertAlias(alias),
      root,
      access: mount.access,
      writeRoot: canonicalizeWriteRoot(root, mount.writeRoot || "."),
    };
  });
  assertNoMountOverlap(mounts);
  return mounts.sort((a, b) => a.alias.localeCompare(b.alias));
}

export function buildProfileFromFlags(input: {
  name: string;
  mounts?: string[];
  readOnly?: string[];
  writeRoots?: string[];
  mode?: string;
}): DevProfile {
  const name = assertProfileName(input.name);
  const mode: DevMode = input.mode === "poc" ? "poc" : "write";
  const writeRootByAlias = new Map<string, string>();
  for (const item of input.writeRoots ?? []) {
    const parsed = parseAliasPath(item);
    writeRootByAlias.set(parsed.alias, parsed.rawPath);
  }
  const mounts: Record<string, DevProfileMount> = {};
  const add = (flags: string[] | undefined, access: MountAccess): void => {
    for (const flag of flags ?? []) {
      const parsed = parseAliasPath(flag);
      if (mounts[parsed.alias]) {
        throw new DevError("DEV_DUPLICATE_ALIAS", `Duplicate mount alias '${parsed.alias}'`);
      }
      const root = canonicalizeMountRoot(parsed.rawPath);
      mounts[parsed.alias] = {
        root,
        access,
        writeRoot: canonicalizeWriteRoot(root, writeRootByAlias.get(parsed.alias) ?? "."),
      };
    }
  };
  add(input.mounts, "rw");
  add(input.readOnly, "ro");
  if (Object.keys(mounts).length === 0) {
    throw new DevError("DEV_PROFILE_NOT_FOUND", "Provide --mount or --read-only, or save a profile first");
  }
  for (const alias of writeRootByAlias.keys()) {
    if (!mounts[alias]) {
      throw new DevError("DEV_INVALID_ALIAS", `writeRoot alias '${alias}' has no matching mount`);
    }
  }
  assertNoMountOverlap(
    Object.entries(mounts).map(([alias, mount]) => ({ alias, root: mount.root }))
  );
  return { name, mounts, mode };
}

export function resolveUpProfile(input: {
  name: string;
  mounts?: string[];
  readOnly?: string[];
  writeRoots?: string[];
  mode?: string;
  save?: boolean;
}): { profile: DevProfile; saved: boolean } {
  const name = assertProfileName(input.name);
  const hasMountFlags = Boolean(
    (input.mounts && input.mounts.length > 0) ||
      (input.readOnly && input.readOnly.length > 0) ||
      (input.writeRoots && input.writeRoots.length > 0)
  );
  const explicitMode: DevMode | undefined = input.mode === "poc" ? "poc" : input.mode === "write" ? "write" : undefined;
  const existing = readDevProfile(name);

  if (hasMountFlags) {
    const profile = buildProfileFromFlags({
      name,
      mounts: input.mounts,
      readOnly: input.readOnly,
      writeRoots: input.writeRoots,
      mode: explicitMode ?? existing?.mode,
    });
    if (existing && !input.save) {
      throw new DevError("DEV_PROFILE_EXISTS", `Profile '${name}' already exists; pass --save to replace it`);
    }
    if (input.save) writeDevProfile(profile);
    return { profile, saved: Boolean(input.save) };
  }

  if (!existing) {
    throw new DevError("DEV_PROFILE_NOT_FOUND", `No saved profile named '${name}'`);
  }
  if (explicitMode && explicitMode !== existing.mode) {
    if (!input.save) {
      throw new DevError("DEV_PROFILE_EXISTS", `Profile '${name}' already exists; pass --save to replace it`);
    }
    const profile = { ...existing, mode: explicitMode };
    writeDevProfile(profile);
    resolvedMounts(profile);
    return { profile, saved: true };
  }
  resolvedMounts(existing);
  return { profile: existing, saved: false };
}

export function publicMountView(mount: ResolvedMount, mode: DevMode): {
  alias: string;
  root: string;
  access: MountAccess;
  mode: DevMode | "read-only";
} {
  return {
    alias: mount.alias,
    root: `workspace://${mount.alias}/`,
    access: mount.access,
    mode: mount.access === "ro" ? "read-only" : mode,
  };
}
