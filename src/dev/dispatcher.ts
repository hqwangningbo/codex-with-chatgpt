import { z } from "zod";
import { WorkspaceError } from "../workspace/manager.js";
import { searchWorkspace } from "../workspace/search.js";
import { gitDiff, gitInfo, gitStatus, type DiffMode } from "../workspace/git.js";
import { writeFileWithinScope, WriteScopeError } from "../write-scope/write-file.js";
import type { WriteScopeState } from "../write-scope/state.js";
import { PocError, runPoc } from "../poc/run.js";
import { sanitizeExecutionOutput } from "../execution/sanitize.js";
import { type WebToolName } from "../web/protocol.js";
import { DevError } from "./errors.js";
import type { DevCapabilitySnapshot, DevEnvironment } from "./environment.js";
import { assertLiveCapability, readDevRuntime } from "./runtime.js";
import { DEV_TOOLS, type DevToolName } from "./protocol.js";

export interface DevDispatchResult {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

const listArgs = z.object({
  path: z.string().default("."),
  depth: z.number().int().min(1).max(4).default(1),
  limit: z.number().int().min(1).max(1000).default(200),
  offset: z.number().int().min(0).default(0),
});

const readArgs = z.object({
  path: z.string(),
  start_line: z.number().int().min(1).optional(),
  end_line: z.number().int().min(1).optional(),
});

const searchArgs = z.object({
  query: z.string().min(2),
  path: z.string().optional(),
  glob: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  regex: z.boolean().default(false),
});

const diffArgs = z.object({
  mode: z.enum(["unstaged", "staged", "head"]).default("unstaged"),
  path: z.string().optional(),
  offset: z.number().int().min(0).default(0),
  max_bytes: z.number().int().min(1024).max(262144).default(65536),
});

const writeArgs = z.object({
  path: z.string().min(1),
  content: z.string().max(1024 * 1024),
  expected_writable_sha256: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
});

const pocArgs = z.object({
  program: z.enum(["forge", "cast", "python3", "node", "bun"]),
  args: z.array(z.string()).max(100).default([]),
  cwd: z.string().optional(),
  timeout_ms: z.number().int().min(1).max(120_000).default(30_000),
});

export interface DevToolCall {
  tool: DevToolName;
  workspace?: string;
  arguments: Record<string, unknown>;
}

function fail(error: unknown): DevDispatchResult {
  if (
    error instanceof DevError ||
    error instanceof WorkspaceError ||
    error instanceof WriteScopeError ||
    error instanceof PocError
  ) {
    return { ok: false, error: { code: error.code, message: error.message } };
  }
  return {
    ok: false,
    error: { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) },
  };
}

function toAliasPath(alias: string, rel: string): string {
  const clean = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!clean || clean === ".") return `workspace://${alias}/`;
  return `workspace://${alias}/${clean}`;
}

function rewriteAbsRoots(env: DevEnvironment, value: string): string {
  let text = value;
  const mounts = [...env.mounts.values()].sort((a, b) => b.workspace.root.length - a.workspace.root.length);
  for (const mount of mounts) {
    if (text.includes(mount.workspace.root)) {
      text = text.split(mount.workspace.root).join(`workspace://${mount.alias}`);
    }
  }
  return text.replace(/\\/g, "/");
}

function prefixKnownPaths(alias: string, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => prefixKnownPaths(alias, item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => {
        if (
          (key === "path" || key === "cwd" || key === "root" || key === "rootAlias") &&
          typeof item === "string" &&
          !item.startsWith("workspace://")
        ) {
          return [key, toAliasPath(alias, item)];
        }
        if ((key === "untracked" || key === "conflicted" || key === "artifacts") && Array.isArray(item)) {
          return [
            key,
            item.map((entry) => (typeof entry === "string" && !entry.startsWith("workspace://") ? toAliasPath(alias, entry) : prefixKnownPaths(alias, entry))),
          ];
        }
        return [key, prefixKnownPaths(alias, item)];
      })
    );
  }
  return value;
}

function boundResult(env: DevEnvironment, alias: string | undefined, value: unknown): unknown {
  const walk = (input: unknown): unknown => {
    if (typeof input === "string") return rewriteAbsRoots(env, input);
    if (Array.isArray(input)) return input.map(walk);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.entries(input as Record<string, unknown>).map(([key, item]) => [key, walk(item)]));
    }
    return input;
  };
  const rewritten = walk(value);
  const prefixed = alias ? prefixKnownPaths(alias, rewritten) : rewritten;
  const text = JSON.stringify(prefixed);
  const sanitized = sanitizeExecutionOutput(text);
  if (!sanitized.allowed) return { withheld: true, reason: sanitized.reason };
  try {
    return JSON.parse(sanitized.text);
  } catch {
    return sanitized.text;
  }
}

function stripAliasPrefix(alias: string, requested: string): string {
  const prefix = `workspace://${alias}/`;
  if (requested === `workspace://${alias}` || requested === `workspace://${alias}/`) return ".";
  if (requested.startsWith(prefix)) return requested.slice(prefix.length) || ".";
  return requested;
}

function rejectAbsolute(requested: string): void {
  if (pathLooksAbsolute(requested)) {
    throw new WorkspaceError("PATH_OUTSIDE_WORKSPACE", "Absolute paths are not allowed");
  }
}

function pathLooksAbsolute(requested: string): boolean {
  return (
    requested.startsWith("/") ||
    /^[a-zA-Z]:[\\/]/.test(requested) ||
    requested.startsWith("\\\\")
  );
}

function scopeFor(snapshot: DevCapabilitySnapshot, alias: string): WriteScopeState {
  const mount = snapshot.mounts.find((item) => item.alias === alias);
  if (!mount) throw new DevError("DEV_WORKSPACE_NOT_ATTACHED", `Workspace '${alias}' is not attached`);
  return {
    workspaceId: mount.workspaceId,
    root: mount.writeRoot,
    mode: snapshot.mode,
    createdAt: snapshot.devStartedAt,
    expiresAt: new Date(Date.parse(snapshot.devStartedAt) + 12 * 60 * 60 * 1000).toISOString(),
    bridgeStartedAt: snapshot.devStartedAt,
  };
}

function assertMutable(
  env: DevEnvironment,
  snapshot: DevCapabilitySnapshot,
  alias: string,
  tool: WebToolName
): WriteScopeState {
  const live = readDevRuntime(env.name);
  assertLiveCapability(snapshot, live);
  const mount = env.get(alias);
  if (mount.access === "ro") {
    throw new DevError("DEV_WORKSPACE_READ_ONLY", `Workspace '${alias}' is read-only`);
  }
  if (tool === "run_poc" && snapshot.mode !== "poc") {
    throw new DevError("POC_NOT_ALLOWED", "Development environment mode is not poc");
  }
  return scopeFor(snapshot, alias);
}

export function environmentInfoResult(env: DevEnvironment): unknown {
  return boundResult(env, undefined, {
    name: env.name,
    workspaces: env.aliases().map((alias) => {
      const mount = env.get(alias);
      return {
        alias,
        root: `workspace://${alias}/`,
        access: mount.access,
        mode: mount.access === "ro" ? "read-only" : env.mode,
      };
    }),
  });
}

export async function dispatchDevTool(
  env: DevEnvironment,
  snapshot: DevCapabilitySnapshot,
  call: DevToolCall
): Promise<DevDispatchResult> {
  try {
    if (!DEV_TOOLS.includes(call.tool)) {
      return { ok: false, error: { code: "DEV_PROTOCOL_INVALID", message: "unknown tool" } };
    }
    if (call.tool === "environment_info") {
      return { ok: true, result: environmentInfoResult(env) };
    }
    const alias = call.workspace;
    if (!alias || typeof alias !== "string") {
      throw new DevError("DEV_WORKSPACE_NOT_ATTACHED", "workspace alias is required");
    }
    const mount = env.get(alias);
    const workspace = mount.workspace;
    const args = call.arguments ?? {};
    const rel = (value: string): string => {
      const stripped = stripAliasPrefix(alias, value);
      rejectAbsolute(stripped);
      return stripped;
    };

    switch (call.tool) {
      case "workspace_info": {
        const project = workspace.detectProject();
        const git = gitInfo(workspace.root);
        return {
          ok: true,
          result: boundResult(env, alias, {
            alias,
            workspaceName: workspace.name,
            root: `workspace://${alias}/`,
            access: mount.access,
            mode: mount.access === "ro" ? "read-only" : env.mode,
            ...project,
            git,
          }),
        };
      }
      case "list_directory": {
        const parsed = listArgs.parse(args);
        return {
          ok: true,
          result: boundResult(env, alias, await workspace.listDirectory(rel(parsed.path), parsed)),
        };
      }
      case "read_file": {
        const parsed = readArgs.parse(args);
        return {
          ok: true,
          result: boundResult(
            env,
            alias,
            await workspace.readFile(rel(parsed.path), { startLine: parsed.start_line, endLine: parsed.end_line })
          ),
        };
      }
      case "search_workspace": {
        const parsed = searchArgs.parse(args);
        return {
          ok: true,
          result: boundResult(
            env,
            alias,
            await searchWorkspace(workspace, { ...parsed, path: parsed.path ? rel(parsed.path) : undefined })
          ),
        };
      }
      case "git_status":
        return { ok: true, result: boundResult(env, alias, gitStatus(workspace)) };
      case "git_diff": {
        const parsed = diffArgs.parse(args);
        let relPath: string | undefined;
        if (parsed.path) relPath = workspace.resolve(rel(parsed.path)).rel;
        return {
          ok: true,
          result: boundResult(
            env,
            alias,
            gitDiff(workspace, { mode: parsed.mode as DiffMode, offset: parsed.offset, maxBytes: parsed.max_bytes }, relPath)
          ),
        };
      }
      case "write_scope_info":
        return {
          ok: true,
          result: boundResult(env, alias, {
            alias,
            active: mount.access === "rw",
            root: mount.access === "rw" ? toAliasPath(alias, mount.writeRoot) : undefined,
            mode: mount.access === "ro" ? "read-only" : env.mode,
          }),
        };
      case "write_file": {
        const parsed = writeArgs.parse(args);
        const scope = assertMutable(env, snapshot, alias, "write_file");
        const written = await writeFileWithinScope({
          workspace,
          scope,
          path: rel(parsed.path),
          content: parsed.content,
          expectedWritableSha256: parsed.expected_writable_sha256,
        });
        return { ok: true, result: boundResult(env, alias, written) };
      }
      case "run_poc": {
        const parsed = pocArgs.parse(args);
        const scope = assertMutable(env, snapshot, alias, "run_poc");
        const poc = await runPoc({
          workspace,
          scope,
          program: parsed.program,
          args: parsed.args,
          cwd: parsed.cwd ? rel(parsed.cwd) : undefined,
          timeoutMs: parsed.timeout_ms,
        });
        return { ok: true, result: boundResult(env, alias, poc) };
      }
      default:
        return { ok: false, error: { code: "DEV_PROTOCOL_INVALID", message: "unknown tool" } };
    }
  } catch (error) {
    return fail(error);
  }
}
