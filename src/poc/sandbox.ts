import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Workspace } from "../workspace/manager.js";
import { isWriteDenied } from "../write-scope/policy.js";
import type { WriteScopeState } from "../write-scope/state.js";

export class PocSandboxError extends Error {
  constructor(
    public readonly code: "POC_SANDBOX_UNAVAILABLE" | "POC_ENV_ISOLATION_UNAVAILABLE",
    message: string
  ) {
    super(message);
    this.name = "PocSandboxError";
  }
}

function sbplString(value: string): string {
  return JSON.stringify(value);
}

const BROAD_READ_ROOTS = new Set(["/", "/private", "/usr", "/System", "/Library", "/opt", "/Users", "/home", "/Volumes"]);

export function isUnsafeSandboxReadRoot(root: string): boolean {
  let normalized: string;
  try {
    normalized = fs.realpathSync.native(root);
  } catch {
    normalized = path.resolve(root);
  }
  if (BROAD_READ_ROOTS.has(normalized)) return true;
  const home = os.homedir();
  return normalized === home || normalized === path.dirname(home);
}

function parentDirectories(abs: string): string[] {
  const parents: string[] = [];
  let current = path.resolve(abs);
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) {
      parents.push(current);
      break;
    }
    parents.push(parent);
    current = parent;
  }
  return parents;
}

function metadataAllowRoots(paths: string[]): string[] {
  return [
    ...new Set(
      paths.flatMap((item) => {
        try {
          return parentDirectories(fs.realpathSync.native(item));
        } catch {
          return parentDirectories(path.resolve(item));
        }
      })
    ),
  ];
}
function addExistingRoot(roots: Set<string>, candidate: string): void {
  try {
    const real = fs.realpathSync.native(candidate);
    if (!fs.statSync(real).isDirectory()) return;
    if (isUnsafeSandboxReadRoot(real)) return;
    roots.add(real);
  } catch {
    // Missing or unreadable runtime paths are simply not granted.
  }
}

/**
 * Directories a allowlisted interpreter/compiler may read. Never `/` or other
 * filesystem-wide roots, even when an extra executable lives in `/bin`.
 */
export function runtimeReadRoots(executables: string[]): string[] {
  const roots = new Set<string>();
  for (const executable of executables) {
    let real: string;
    try {
      real = fs.realpathSync.native(executable);
    } catch {
      continue;
    }
    addExistingRoot(roots, path.dirname(real));
    const prefix = path.dirname(path.dirname(real));
    if (!isUnsafeSandboxReadRoot(prefix)) {
      addExistingRoot(roots, prefix);
      addExistingRoot(roots, path.join(prefix, "lib"));
      addExistingRoot(roots, path.join(prefix, "share"));
    }
  }
  for (const wellKnown of [
    "/usr/lib",
    "/usr/local/lib",
    "/usr/local/share",
    "/opt/homebrew/lib",
    "/opt/homebrew/share",
    "/opt/homebrew/Cellar",
    "/System/Library",
    "/Library/Developer",
    "/Library/Frameworks",
    path.join(os.homedir(), ".foundry"),
    path.join(os.homedir(), ".svm"),
    path.join(os.homedir(), ".bun"),
  ]) {
    addExistingRoot(roots, wellKnown);
  }
  return [...roots];
}

function walkRegularFiles(root: string): { abs: string; rel: string; key: string; sensitive: boolean }[] {
  const files: { abs: string; rel: string; key: string; sensitive: boolean }[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = fs.statSync(abs);
        files.push({
          abs: fs.realpathSync.native(abs),
          rel,
          key: `${stat.dev}:${stat.ino}`,
          sensitive: false,
        });
      } catch {
        // A racing or unreadable entry is not granted by the generated profile.
      }
    }
  }
  return files;
}

function sensitivePathsAndAliases(workspace: Workspace): string[] {
  const files = walkRegularFiles(workspace.root);
  const sensitiveInodes = new Set<string>();
  for (const file of files) {
    file.sensitive = isWriteDenied(file.rel) || workspace.ignoreRules.isSensitive(file.rel);
    if (file.sensitive) sensitiveInodes.add(file.key);
  }
  return [
    ...new Set(
      files
        .filter((file) => file.sensitive || sensitiveInodes.has(file.key))
        .map((file) => file.abs)
    ),
  ];
}

export interface PocSandbox {
  profileFile: string;
  pocDir: string;
  homeDir: string;
  tempDir: string;
  cacheDir: string;
  outDir: string;
  env: NodeJS.ProcessEnv;
  cleanup(): void;
}

export function createPocSandbox(input: {
  workspace: Workspace;
  scope: WriteScopeState;
  executable: string;
  extraExecutables?: string[];
}): PocSandbox {
  if (process.platform !== "darwin" || !fs.existsSync("/usr/bin/sandbox-exec")) {
    throw new PocSandboxError("POC_SANDBOX_UNAVAILABLE", "macOS sandbox-exec is unavailable");
  }
  const writeRoot = fs.realpathSync.native(path.resolve(input.workspace.root, input.scope.root));
  const pocDir = path.join(writeRoot, ".c2c-poc");
  const homeDir = path.join(pocDir, "home");
  const tempDir = path.join(pocDir, "tmp");
  const cacheDir = path.join(pocDir, "cache");
  const outDir = path.join(pocDir, "out");
  for (const dir of [pocDir, homeDir, tempDir, cacheDir, outDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  }

  const executable = fs.realpathSync.native(input.executable);
  const executables = [executable, ...(input.extraExecutables ?? [])]
    .map((item) => fs.realpathSync.native(item))
    .filter((item, index, all) => all.indexOf(item) === index);
  const runtimeRoots = runtimeReadRoots(executables);
  if (runtimeRoots.some((root) => isUnsafeSandboxReadRoot(root))) {
    throw new PocSandboxError("POC_SANDBOX_UNAVAILABLE", "POC sandbox refused a filesystem-wide read root");
  }
  const sensitive = sensitivePathsAndAliases(input.workspace);
  const metadataRoots = metadataAllowRoots([
    input.workspace.root,
    writeRoot,
    ...executables,
    ...runtimeRoots,
  ]);

  const profile = [
    "(version 1)",
    "(deny default)",
    '(import "system.sb")',
    "(allow process-fork)",
    `(allow process-exec ${executables.map((item) => `(literal ${sbplString(item)})`).join(" ")})`,
    `(allow file-read-metadata ${metadataRoots.map((root) => `(literal ${sbplString(root)})`).join(" ")})`,
    `(allow file-read* (subpath ${sbplString(input.workspace.root)}))`,
    ...runtimeRoots.map((root) => `(allow file-read* (subpath ${sbplString(root)}))`),
    `(allow file-read* file-write* (subpath ${sbplString(writeRoot)}))`,
    "(deny network*)",
    '(deny file-read* file-write* (regex #"(^|/)\\.env($|\\.)"))',
    '(deny file-read* file-write* (regex #"(^|/)(\\.git|\\.ssh|\\.aws|\\.gnupg|\\.cloudflared|keystore|keystores|wallet|wallets|secrets|credentials|deploy-secrets|production-secrets|prod-secrets)(/|$)"))',
    '(deny file-read* file-write* (regex #"(^|/)(mnemonic|seed|private-key|private_key|secret)[^/]*$"))',
    '(deny file-read* file-write* (regex #"(^|/)[^/]*\\.(pem|key|p12|pfx|jks|keystore)$"))',
    ...sensitive.map(
      (item) => `(deny file-read* file-write* (literal ${sbplString(item)}))`
    ),
  ].join("\n");
  if (/\(subpath\s+"\/(?:private)?"\)/.test(profile)) {
    throw new PocSandboxError("POC_SANDBOX_UNAVAILABLE", "POC sandbox refused a filesystem-wide read root");
  }
  const profileFile = path.join(pocDir, `sandbox-${process.pid}-${randomBytes(8).toString("hex")}.sb`);
  fs.writeFileSync(profileFile, profile, { mode: 0o600 });
  fs.chmodSync(profileFile, 0o600);

  const safePath = [
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    "/opt/homebrew/bin",
    path.join(os.homedir(), ".foundry", "bin"),
    path.join(os.homedir(), ".bun", "bin"),
  ].join(":");
  const env: NodeJS.ProcessEnv = {
    PATH: safePath,
    HOME: homeDir,
    TMPDIR: tempDir,
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? process.env.LANG ?? "C.UTF-8",
    FOUNDRY_CACHE_PATH: cacheDir,
    FOUNDRY_OUT: outDir,
    FOUNDRY_FFI: "false",
  };
  return {
    profileFile,
    pocDir,
    homeDir,
    tempDir,
    cacheDir,
    outDir,
    env,
    cleanup: () => {
      try {
        fs.rmSync(profileFile, { force: true });
      } catch {
        // Best effort after the child exits.
      }
    },
  };
}
