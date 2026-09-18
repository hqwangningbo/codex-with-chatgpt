import { Workspace } from "../workspace/manager.js";
import { SensitiveInodeRegistry } from "../workspace/ignore.js";
import { MultiError } from "./errors.js";
import { assertAlias, assertNoRepoOverlap, canonicalizeRepoRoot } from "./mounts.js";
import type { MultiProfile, ResolvedRepo } from "./profile.js";
import { resolvedRepos } from "./profile.js";

export interface AttachedRepo {
  alias: string;
  workspace: Workspace;
  root: string;
}

class AsyncLock {
  private tail = Promise.resolve();

  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.tail.then(() => fn());
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

export class MultiWorkspaceRegistry {
  private readonly workspaces = new Map<string, AttachedRepo>();
  readonly inodeRegistry: SensitiveInodeRegistry;
  private generationValue = 0;
  private readonly lock = new AsyncLock();

  constructor(inodeRegistry = new SensitiveInodeRegistry()) {
    this.inodeRegistry = inodeRegistry;
  }

  get generation(): number {
    return this.generationValue;
  }

  aliases(): string[] {
    return [...this.workspaces.keys()].sort();
  }

  snapshot(): AttachedRepo[] {
    return this.aliases().map((alias) => this.workspaces.get(alias)!);
  }

  roots(): { alias: string; root: string }[] {
    return this.snapshot().map((item) => ({ alias: item.alias, root: item.root }));
  }

  get(alias: string): AttachedRepo {
    const attached = this.workspaces.get(alias);
    if (!attached) {
      throw new MultiError("MULTI_WORKSPACE_NOT_ATTACHED", `Workspace '${alias}' is not attached`);
    }
    return attached;
  }

  has(alias: string): boolean {
    return this.workspaces.has(alias);
  }

  size(): number {
    return this.workspaces.size;
  }

  load(repos: ResolvedRepo[]): void {
    for (const repo of repos) {
      this.attachNow(repo.alias, repo.root);
    }
    this.inodeRegistry.rebuild();
  }

  async add(alias: string, rawRoot: string): Promise<AttachedRepo> {
    return this.lock.run(() => {
      const name = assertAlias(alias);
      if (this.workspaces.has(name)) {
        throw new MultiError("MULTI_DUPLICATE_ALIAS", `Duplicate repo alias '${name}'`);
      }
      const root = canonicalizeRepoRoot(rawRoot);
      assertNoRepoOverlap([...this.roots(), { alias: name, root }]);
      const attached = this.attachNow(name, root);
      this.inodeRegistry.rebuild();
      this.generationValue += 1;
      return attached;
    });
  }

  async remove(alias: string): Promise<AttachedRepo> {
    return this.lock.run(() => {
      const name = assertAlias(alias);
      const attached = this.workspaces.get(name);
      if (!attached) {
        throw new MultiError("MULTI_WORKSPACE_NOT_ATTACHED", `Workspace '${name}' is not attached`);
      }
      if (this.workspaces.size <= 1) {
        throw new MultiError("MULTI_LAST_REPO", "Cannot remove the last repo from a multi profile");
      }
      this.workspaces.delete(name);
      this.inodeRegistry.detach(attached.root);
      this.generationValue += 1;
      return attached;
    });
  }

  async rollbackAdd(alias: string): Promise<void> {
    return this.lock.run(() => {
      const attached = this.workspaces.get(alias);
      if (!attached) return;
      this.workspaces.delete(alias);
      this.inodeRegistry.detach(attached.root);
      if (this.generationValue > 0) this.generationValue -= 1;
    });
  }

  async rollbackRemove(attached: AttachedRepo): Promise<void> {
    return this.lock.run(() => {
      if (this.workspaces.has(attached.alias)) return;
      this.workspaces.set(attached.alias, attached);
      this.inodeRegistry.attach(
        attached.root,
        (rel) => attached.workspace.ignoreRules.sensitiveNameMatch(rel),
        attached.workspace.ignoreRules.exportSensitiveInodes(),
        attached.root
      );
      this.inodeRegistry.rebuild();
      if (this.generationValue > 0) this.generationValue -= 1;
    });
  }

  private attachNow(alias: string, root: string): AttachedRepo {
    const workspace = new Workspace(root, { sensitiveInodeRegistry: this.inodeRegistry });
    const attached: AttachedRepo = { alias, workspace, root: workspace.root };
    this.workspaces.set(alias, attached);
    return attached;
  }
}

export function createMultiRegistry(profile: MultiProfile): MultiWorkspaceRegistry {
  const registry = new MultiWorkspaceRegistry();
  registry.load(resolvedRepos(profile));
  return registry;
}
