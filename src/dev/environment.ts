import { Workspace } from "../workspace/manager.js";
import { DevError } from "./errors.js";
import { environmentIdFor, profileHash, resolvedMounts, type DevProfile } from "./profile.js";
import type { DevMode, MountAccess } from "./mounts.js";

export interface AttachedMount {
  alias: string;
  workspace: Workspace;
  access: MountAccess;
  writeRoot: string;
  mode: DevMode;
}

export interface DevCapabilitySnapshot {
  environmentId: string;
  environmentName: string;
  profileHash: string;
  devStartedAt: string;
  mode: DevMode;
  mounts: Array<{
    alias: string;
    workspaceId: string;
    root: string;
    access: MountAccess;
    writeRoot: string;
    mode: DevMode;
  }>;
}

export class DevEnvironment {
  readonly mounts = new Map<string, AttachedMount>();

  constructor(
    readonly name: string,
    readonly environmentId: string,
    readonly profileHash: string,
    readonly startedAt: string,
    readonly mode: DevMode,
    mounts: AttachedMount[]
  ) {
    for (const mount of mounts) this.mounts.set(mount.alias, mount);
  }

  get(alias: string): AttachedMount {
    const mount = this.mounts.get(alias);
    if (!mount) {
      throw new DevError("DEV_WORKSPACE_NOT_ATTACHED", `Workspace '${alias}' is not attached`);
    }
    return mount;
  }

  aliases(): string[] {
    return [...this.mounts.keys()].sort();
  }
}

export function applySensitiveInodeUnion(workspaces: Workspace[]): void {
  const union = new Set<string>();
  for (const workspace of workspaces) {
    for (const inode of workspace.ignoreRules.exportSensitiveInodes()) union.add(inode);
  }
  for (const workspace of workspaces) workspace.ignoreRules.mergeSensitiveInodes(union);
}

export function createDevEnvironment(profile: DevProfile, startedAt: string): DevEnvironment {
  const resolved = resolvedMounts(profile);
  const attached: AttachedMount[] = resolved.map((mount) => ({
    alias: mount.alias,
    workspace: new Workspace(mount.root),
    access: mount.access,
    writeRoot: mount.writeRoot,
    mode: profile.mode,
  }));
  applySensitiveInodeUnion(attached.map((item) => item.workspace));
  return new DevEnvironment(
    profile.name,
    environmentIdFor(profile),
    profileHash(profile),
    startedAt,
    profile.mode,
    attached
  );
}

export function captureDevCapability(env: DevEnvironment): DevCapabilitySnapshot {
  return {
    environmentId: env.environmentId,
    environmentName: env.name,
    profileHash: env.profileHash,
    devStartedAt: env.startedAt,
    mode: env.mode,
    mounts: [...env.mounts.values()].map((mount) => ({
      alias: mount.alias,
      workspaceId: mount.workspace.id,
      root: mount.workspace.root,
      access: mount.access,
      writeRoot: mount.writeRoot,
      mode: env.mode,
    })),
  };
}

export function environmentFromCapability(snapshot: DevCapabilitySnapshot): DevEnvironment {
  const attached: AttachedMount[] = snapshot.mounts.map((mount) => ({
    alias: mount.alias,
    workspace: new Workspace(mount.root),
    access: mount.access,
    writeRoot: mount.writeRoot,
    mode: snapshot.mode,
  }));
  applySensitiveInodeUnion(attached.map((item) => item.workspace));
  return new DevEnvironment(
    snapshot.environmentName,
    snapshot.environmentId,
    snapshot.profileHash,
    snapshot.devStartedAt,
    snapshot.mode,
    attached
  );
}
