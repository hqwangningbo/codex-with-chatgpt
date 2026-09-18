import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ensureDir, getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { MultiError } from "./errors.js";
import {
  assertAlias,
  assertNoRepoOverlap,
  assertProfileName,
  canonicalizeRepoRoot,
  parseAliasPath,
} from "./mounts.js";

export interface MultiProfileRepo {
  root: string;
}

export interface MultiProfile {
  name: string;
  profileId: string;
  repos: Record<string, MultiProfileRepo>;
}

export interface ResolvedRepo {
  alias: string;
  root: string;
}

function profilesDir(): string {
  return ensureDir(path.join(getStateDir(), "multi", "profiles"));
}

export function multiProfileFile(name: string): string {
  return path.join(profilesDir(), `${assertProfileName(name)}.json`);
}

export function environmentIdFor(profileId: string): string {
  return `c2c_mr_${createHash("sha256").update(profileId).digest("hex").slice(0, 24)}`;
}

export function tunnelIdentityFor(name: string): string {
  return `multip_${createHash("sha256").update(assertProfileName(name)).digest("hex").slice(0, 12)}`;
}

function parseProfile(raw: unknown, expectedName?: string): MultiProfile {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new MultiError("MULTI_PROFILE_NOT_FOUND", "Saved multi profile is malformed");
  }
  const record = raw as Record<string, unknown>;
  const name = typeof record.name === "string" ? assertProfileName(record.name) : "";
  if (!name || (expectedName && name !== expectedName)) {
    throw new MultiError("MULTI_PROFILE_NOT_FOUND", "Saved multi profile is malformed");
  }
  if (typeof record.profileId !== "string" || !record.profileId.trim()) {
    throw new MultiError("MULTI_PROFILE_NOT_FOUND", "Saved multi profile is malformed");
  }
  if (!record.repos || typeof record.repos !== "object" || Array.isArray(record.repos)) {
    throw new MultiError("MULTI_PROFILE_NOT_FOUND", "Saved multi profile is malformed");
  }
  const repos: Record<string, MultiProfileRepo> = {};
  for (const [alias, value] of Object.entries(record.repos as Record<string, unknown>)) {
    assertAlias(alias);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new MultiError("MULTI_PROFILE_NOT_FOUND", "Saved multi profile is malformed");
    }
    const repo = value as Record<string, unknown>;
    if (typeof repo.root !== "string") {
      throw new MultiError("MULTI_PROFILE_NOT_FOUND", "Saved multi profile is malformed");
    }
    repos[alias] = { root: repo.root };
  }
  if (Object.keys(repos).length === 0) {
    throw new MultiError("MULTI_PROFILE_NOT_FOUND", "Saved multi profile has no repos");
  }
  return { name, profileId: record.profileId, repos };
}

export function readMultiProfile(name: string): MultiProfile | null {
  const raw = readJsonIfExists<unknown>(multiProfileFile(name));
  if (!raw) return null;
  return parseProfile(raw, name);
}

export function writeMultiProfile(profile: MultiProfile): void {
  writeSecureJson(multiProfileFile(profile.name), {
    name: profile.name,
    profileId: profile.profileId,
    repos: profile.repos,
  });
}

export function resolvedRepos(profile: MultiProfile): ResolvedRepo[] {
  const repos = Object.entries(profile.repos).map(([alias, repo]) => ({
    alias: assertAlias(alias),
    root: canonicalizeRepoRoot(repo.root),
  }));
  assertNoRepoOverlap(repos);
  return repos.sort((a, b) => a.alias.localeCompare(b.alias));
}

export function buildProfileFromRepos(input: {
  name: string;
  repos: string[];
  profileId?: string;
}): MultiProfile {
  const name = assertProfileName(input.name);
  const repos: Record<string, MultiProfileRepo> = {};
  for (const flag of input.repos) {
    const parsed = parseAliasPath(flag);
    if (repos[parsed.alias]) {
      throw new MultiError("MULTI_DUPLICATE_ALIAS", `Duplicate repo alias '${parsed.alias}'`);
    }
    repos[parsed.alias] = { root: canonicalizeRepoRoot(parsed.rawPath) };
  }
  if (Object.keys(repos).length === 0) {
    throw new MultiError("MULTI_PROFILE_NOT_FOUND", "Provide --repo, or save a profile first");
  }
  assertNoRepoOverlap(Object.entries(repos).map(([alias, repo]) => ({ alias, root: repo.root })));
  return { name, profileId: input.profileId ?? randomUUID(), repos };
}

export function resolveUpProfile(input: {
  name: string;
  repos?: string[];
  save?: boolean;
}): { profile: MultiProfile; saved: boolean } {
  const name = assertProfileName(input.name);
  const hasRepoFlags = Boolean(input.repos && input.repos.length > 0);
  const existing = readMultiProfile(name);

  if (hasRepoFlags) {
    const profile = buildProfileFromRepos({
      name,
      repos: input.repos ?? [],
      profileId: existing?.profileId,
    });
    if (existing && !input.save) {
      throw new MultiError("MULTI_PROFILE_EXISTS", `Profile '${name}' already exists; pass --save to replace it`);
    }
    if (input.save) writeMultiProfile(profile);
    return { profile, saved: Boolean(input.save) };
  }

  if (!existing) {
    throw new MultiError("MULTI_PROFILE_NOT_FOUND", `No saved multi profile named '${name}'`);
  }
  resolvedRepos(existing);
  return { profile: existing, saved: false };
}

export function addRepoToProfile(profile: MultiProfile, aliasPath: string): MultiProfile {
  const parsed = parseAliasPath(aliasPath);
  if (profile.repos[parsed.alias]) {
    throw new MultiError("MULTI_DUPLICATE_ALIAS", `Duplicate repo alias '${parsed.alias}'`);
  }
  const root = canonicalizeRepoRoot(parsed.rawPath);
  const next: MultiProfile = {
    ...profile,
    repos: { ...profile.repos, [parsed.alias]: { root } },
  };
  resolvedRepos(next);
  return next;
}

export function removeRepoFromProfile(profile: MultiProfile, alias: string): MultiProfile {
  const name = assertAlias(alias);
  if (!profile.repos[name]) {
    throw new MultiError("MULTI_WORKSPACE_NOT_ATTACHED", `Workspace '${name}' is not attached`);
  }
  if (Object.keys(profile.repos).length <= 1) {
    throw new MultiError("MULTI_LAST_REPO", "Cannot remove the last repo from a multi profile");
  }
  const repos = { ...profile.repos };
  delete repos[name];
  return { ...profile, repos };
}
