import ignore, { type Ignore } from "ignore";
import fs from "node:fs";
import path from "node:path";

/**
 * Files that must never be readable through MCP, regardless of user config.
 * Matched with gitignore semantics against workspace-relative paths.
 */
export const SENSITIVE_PATTERNS: string[] = [
  ".env",
  ".env.*",
  "!.env.example",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.jks",
  "*.keystore",
  "keystore/",
  "keystores/",
  "wallet/",
  "wallets/",
  "mnemonic*",
  "seed*",
  "private-key*",
  "private_key*",
  "secret*",
  "secrets/",
  "credentials/",
  "deploy-secrets/",
  "production-secrets/",
  "prod-secrets/",
  "*.secret",
  "*.secrets",
  "foundry.keystore",
  "cast-wallet*",
  "id_rsa",
  "id_rsa.*",
  "id_ed25519",
  "id_ed25519.*",
  "id_ecdsa",
  "id_ecdsa.*",
  "id_dsa",
  "id_dsa.*",
  ".ssh/",
  ".aws/",
  ".gnupg/",
  ".npmrc",
  ".netrc",
  "_netrc",
  ".git-credentials",
  "*.keychain",
  "*.keychain-db",
  ".cloudflared/",
  "credentials.json",
  "service-account*.json",
  "secrets.json",
  "cookies.sqlite",
  "Cookies",
  ".c2c-secrets*",
];

/** High-noise directories excluded from listing/search by default. */
export const NOISE_PATTERNS: string[] = [
  ".git/",
  "node_modules/",
  "dist/",
  "build/",
  "out/",
  ".next/",
  ".nuxt/",
  ".svelte-kit/",
  "coverage/",
  ".cache/",
  ".turbo/",
  ".venv/",
  "venv/",
  "__pycache__/",
  ".pytest_cache/",
  ".mypy_cache/",
  "target/",
  ".gradle/",
  ".idea/",
  ".tooling/",
  ".pnpm-store/",
  ".DS_Store",
  "*.lock",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
];

export function fileInodeKey(absPath: string): string | null {
  try {
    const stat = fs.lstatSync(absPath);
    return stat.isFile() ? `${stat.dev}:${stat.ino}` : null;
  } catch {
    return null;
  }
}

/**
 * Collect inodes of regular files whose workspace-relative path matches.
 * Symlinks are ignored so a name check cannot be redirected outside the tree.
 */
export function collectMatchingInodes(root: string, match: (relPath: string) => boolean): Set<string> {
  const inodes = new Set<string>();
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
      if (entry.isSymbolicLink()) continue;
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (entry.isDirectory()) {
        if (entry.name === ".git") continue;
        stack.push(abs);
        continue;
      }
      if (!entry.isFile() || !match(rel)) continue;
      const key = fileInodeKey(abs);
      if (key) inodes.add(key);
    }
  }
  return inodes;
}

export class IgnoreRules {
  private readonly root: string;
  private sensitive: Ignore;
  private noise: Ignore;
  private custom: Ignore;
  private sensitiveInodes: Set<string>;

  constructor(workspaceRoot: string) {
    this.root = workspaceRoot;
    this.sensitive = ignore().add(SENSITIVE_PATTERNS);
    this.noise = ignore().add(NOISE_PATTERNS);
    this.custom = ignore();
    const c2cignore = path.join(workspaceRoot, ".c2cignore");
    try {
      if (fs.existsSync(c2cignore)) {
        this.custom.add(fs.readFileSync(c2cignore, "utf8"));
      }
    } catch {
      // unreadable .c2cignore: fall back to defaults only
    }
    this.sensitiveInodes = collectMatchingInodes(workspaceRoot, (rel) => this.nameIsSensitive(rel));
  }

  exportSensitiveInodes(): Set<string> {
    return new Set(this.sensitiveInodes);
  }

  mergeSensitiveInodes(inodes: Iterable<string>): void {
    for (const inode of inodes) this.sensitiveInodes.add(inode);
  }

  private nameIsSensitive(relPath: string): boolean {
    return this.sensitive.ignores(relPath) || this.custom.ignores(relPath);
  }

  private matchesSensitiveInode(relPath: string): boolean {
    const abs = path.join(this.root, relPath);
    const key = fileInodeKey(abs);
    if (!key) return false;
    if (this.sensitiveInodes.has(key)) return true;
    let nlink = 1;
    try {
      nlink = fs.lstatSync(abs).nlink;
    } catch {
      return false;
    }
    if (nlink <= 1) return false;
    for (const inode of collectMatchingInodes(this.root, (rel) => this.nameIsSensitive(rel))) {
      this.sensitiveInodes.add(inode);
    }
    return this.sensitiveInodes.has(key);
  }

  /** True when the path must be denied with ACCESS_DENIED_SENSITIVE_FILE. */
  isSensitive(relPath: string): boolean {
    if (!relPath || relPath === ".") return false;
    return this.nameIsSensitive(relPath) || this.matchesSensitiveInode(relPath);
  }

  /** True when the path should be hidden from listing/search (not an error). */
  isNoise(relPath: string): boolean {
    if (!relPath || relPath === ".") return false;
    return this.noise.ignores(relPath);
  }

  isHidden(relPath: string): boolean {
    return this.isSensitive(relPath) || this.isNoise(relPath);
  }
}
