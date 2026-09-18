import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { Workspace, WorkspaceError } from "../workspace/manager.js";
import { sanitizeWorkspaceText } from "../workspace/sanitize.js";
import { isWriteDenied } from "./policy.js";
import type { WriteScopeState } from "./state.js";

export type WriteErrorCode =
  | "WRITE_SCOPE_NOT_ACTIVE"
  | "WRITE_SCOPE_VIOLATION"
  | "WRITE_DENIED_SENSITIVE_FILE"
  | "PRECONDITION_REQUIRED"
  | "WRITE_PRECONDITION_FAILED"
  | "EMPTY_OVERWRITE_REQUIRES_EXPLICIT_SUPPORT"
  | "WRITE_CONTENT_TOO_LARGE"
  | "WRITE_CONTENT_REJECTED";

export class WriteScopeError extends Error {
  constructor(
    public readonly code: WriteErrorCode,
    message: string
  ) {
    super(message);
    this.name = "WriteScopeError";
  }
}

export interface WriteFileResult {
  path: string;
  sha256: string;
  sizeBytes: number;
  created: boolean;
}

const MAX_WRITE_BYTES = 1024 * 1024;

export function sha256Bytes(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function normalizeRelative(requested: string): string {
  if (
    path.isAbsolute(requested) ||
    /^[a-zA-Z]:[\\/]/.test(requested) ||
    requested.startsWith("\\\\") ||
    requested.includes("\0")
  ) {
    throw new WriteScopeError("WRITE_SCOPE_VIOLATION", "Path must be Workspace-relative");
  }
  const normalized = requested.replace(/\\/g, "/");
  if (normalized.split("/").includes("..")) {
    throw new WriteScopeError("WRITE_SCOPE_VIOLATION", "Path traversal is not allowed");
  }
  return normalized;
}

function contains(root: string, candidate: string): boolean {
  if (root === "") return true;
  const caseFold = (value: string): string =>
    process.platform === "darwin" || process.platform === "win32" ? value.toLowerCase() : value;
  const parent = caseFold(root);
  const child = caseFold(candidate);
  return child === parent || child.startsWith(`${parent}/`);
}

function assertAllowedPath(workspace: Workspace, scope: WriteScopeState, requested: string) {
  const normalized = normalizeRelative(requested);
  const lexical = path.resolve(workspace.root, normalized);
  let resolved: { abs: string; rel: string };
  try {
    resolved = workspace.resolve(normalized, { allowSensitive: true });
  } catch (error) {
    if (error instanceof WorkspaceError) {
      throw new WriteScopeError("WRITE_SCOPE_VIOLATION", error.message);
    }
    throw error;
  }
  if (resolved.abs !== lexical) {
    throw new WriteScopeError("WRITE_SCOPE_VIOLATION", "Symlinked write targets are not allowed");
  }
  const scopeRel = scope.root === "." ? "" : scope.root;
  if (!contains(scopeRel, resolved.rel)) {
    throw new WriteScopeError(
      "WRITE_SCOPE_VIOLATION",
      `Target is outside the active Writable Root '${scope.root}'`
    );
  }
  if (isWriteDenied(resolved.rel) || workspace.ignoreRules.isSensitive(resolved.rel)) {
    throw new WriteScopeError(
      "WRITE_DENIED_SENSITIVE_FILE",
      `Writing '${resolved.rel}' is permanently denied`
    );
  }
  return resolved;
}

function ensureSafeParents(workspace: Workspace, scope: WriteScopeState, targetAbs: string): void {
  const scopeAbs = path.resolve(workspace.root, scope.root);
  const parent = path.dirname(targetAbs);
  const relative = path.relative(scopeAbs, parent);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new WriteScopeError("WRITE_SCOPE_VIOLATION", "Parent is outside the active Writable Root");
  }
  let current = scopeAbs;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new WriteScopeError("WRITE_SCOPE_VIOLATION", "Parent path contains a symlink or non-directory");
      }
    } catch (error) {
      if (error instanceof WriteScopeError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
      fs.mkdirSync(current, { mode: 0o700 });
    }
    const real = fs.realpathSync.native(current);
    if (real !== current) {
      throw new WriteScopeError("WRITE_SCOPE_VIOLATION", "Parent path contains a symlink");
    }
  }
}

export async function writeFileWithinScope(input: {
  workspace: Workspace;
  scope: WriteScopeState | null;
  path: string;
  content: string;
  expectedSha256?: string;
}): Promise<WriteFileResult> {
  const { workspace, scope } = input;
  if (!scope) throw new WriteScopeError("WRITE_SCOPE_NOT_ACTIVE", "Writable Scope is not active");
  const target = assertAllowedPath(workspace, scope, input.path);
  const bytes = Buffer.from(input.content, "utf8");
  if (bytes.length === 0) {
    throw new WriteScopeError(
      "EMPTY_OVERWRITE_REQUIRES_EXPLICIT_SUPPORT",
      "Empty writes are not supported in V1"
    );
  }
  if (bytes.length > MAX_WRITE_BYTES) {
    throw new WriteScopeError("WRITE_CONTENT_TOO_LARGE", "Content exceeds the 1 MiB write limit");
  }
  const contentGate = sanitizeWorkspaceText(input.content);
  if (!contentGate.allowed || contentGate.text !== input.content) {
    throw new WriteScopeError("WRITE_CONTENT_REJECTED", "Content matches the secret policy");
  }

  let existing: Buffer | null = null;
  let existingMode = 0o600;
  try {
    const stat = fs.lstatSync(target.abs);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new WriteScopeError("WRITE_SCOPE_VIOLATION", "Target must be a regular file");
    }
    existing = await fs.promises.readFile(target.abs);
    existingMode = stat.mode & 0o777;
  } catch (error) {
    if (error instanceof WriteScopeError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (existing) {
    const raw = existing.toString("utf8");
    const existingGate = sanitizeWorkspaceText(raw);
    if (!existingGate.allowed || existingGate.text !== raw) {
      throw new WriteScopeError("WRITE_CONTENT_REJECTED", "Existing file matches the secret policy");
    }
    if (!input.expectedSha256) {
      throw new WriteScopeError("PRECONDITION_REQUIRED", "expected_sha256 is required for existing files");
    }
    if (sha256Bytes(existing) !== input.expectedSha256.toLowerCase()) {
      throw new WriteScopeError("WRITE_PRECONDITION_FAILED", "The file changed since it was read");
    }
  } else if (input.expectedSha256) {
    throw new WriteScopeError("WRITE_PRECONDITION_FAILED", "The target file does not exist");
  }

  ensureSafeParents(workspace, scope, target.abs);
  const parent = path.dirname(target.abs);
  const temp = path.join(parent, `.c2c-write-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(temp, "wx", existingMode);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;

    const rechecked = assertAllowedPath(workspace, scope, input.path);
    if (rechecked.abs !== target.abs || fs.realpathSync.native(parent) !== parent) {
      throw new WriteScopeError("WRITE_SCOPE_VIOLATION", "Write target changed during validation");
    }
    if (existing) {
      const current = await fs.promises.readFile(target.abs);
      if (sha256Bytes(current) !== input.expectedSha256?.toLowerCase()) {
        throw new WriteScopeError("WRITE_PRECONDITION_FAILED", "The file changed during the write");
      }
    }
    await fs.promises.rename(temp, target.abs);
    try {
      const dir = await fs.promises.open(parent, "r");
      await dir.sync();
      await dir.close();
    } catch {
      // Directory fsync is not available on every supported filesystem.
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.promises.rm(temp, { force: true }).catch(() => undefined);
  }

  return {
    path: target.rel,
    sha256: sha256Bytes(bytes),
    sizeBytes: bytes.length,
    created: existing === null,
  };
}
