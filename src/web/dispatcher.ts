import { z } from "zod";
import { Workspace, WorkspaceError } from "../workspace/manager.js";
import { searchWorkspace } from "../workspace/search.js";
import { gitDiff, gitInfo, gitStatus, type DiffMode } from "../workspace/git.js";
import { activeWriteScope, readWriteScopeState, writeScopeInfo, type WriteScopeState } from "../write-scope/state.js";
import { writeFileWithinScope, WriteScopeError } from "../write-scope/write-file.js";
import { PocError, runPoc } from "../poc/run.js";
import { findBridgeObservation } from "../bridge/runtime.js";
import { sanitizeExecutionOutput } from "../execution/sanitize.js";
import { MUTABLE_TOOLS, type WebToolInvocation, type WebToolName } from "./protocol.js";
import { WebError } from "./errors.js";

export interface CapabilitySnapshot {
  workspaceId: string;
  bridgeStartedAt: string | null;
  root?: string;
  mode?: WriteScopeState["mode"];
  writeActive: boolean;
}

export interface DispatchResult {
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

export async function captureCapabilitySnapshot(workspace: Workspace): Promise<CapabilitySnapshot> {
  const observation = await findBridgeObservation(workspace.id);
  if (observation.state !== "healthy") {
    return { workspaceId: workspace.id, bridgeStartedAt: null, writeActive: false };
  }
  const scope = activeWriteScope(workspace.id, observation.runtime.startedAt);
  return {
    workspaceId: workspace.id,
    bridgeStartedAt: observation.runtime.startedAt,
    root: scope?.root,
    mode: scope?.mode,
    writeActive: Boolean(scope),
  };
}

export async function assertMutableCapability(
  workspace: Workspace,
  snapshot: CapabilitySnapshot,
  tool: WebToolName
): Promise<WriteScopeState> {
  if (!MUTABLE_TOOLS.has(tool)) {
    throw new WebError("WEB_PROTOCOL_INVALID", `${tool} is not mutable`);
  }
  if (!snapshot.writeActive || !snapshot.bridgeStartedAt) {
    throw new WebError("WRITE_SCOPE_NOT_ACTIVE", "Writable Scope is not active");
  }
  const observation = await findBridgeObservation(workspace.id);
  if (observation.state !== "healthy") {
    throw new WebError("BRIDGE_NOT_RUNNING", "Workspace Bridge is not running");
  }
  if (observation.runtime.startedAt !== snapshot.bridgeStartedAt) {
    throw new WebError("WEB_CAPABILITY_REVOKED", "Bridge session changed during this web session");
  }
  const scope = activeWriteScope(workspace.id, snapshot.bridgeStartedAt);
  if (!scope || scope.root !== snapshot.root || scope.mode !== snapshot.mode) {
    throw new WebError("WEB_CAPABILITY_REVOKED", "Writable Scope changed or expired");
  }
  if (tool === "run_poc" && scope.mode !== "poc") {
    throw new WebError("POC_NOT_ALLOWED", "Writable Scope mode is not poc");
  }
  return scope;
}

function fail(error: unknown): DispatchResult {
  if (error instanceof WebError || error instanceof WorkspaceError || error instanceof WriteScopeError || error instanceof PocError) {
    return { ok: false, error: { code: error.code, message: error.message } };
  }
  return {
    ok: false,
    error: { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) },
  };
}

function workspaceAlias(workspace: Workspace, value: unknown): unknown {
  if (typeof value === "string") {
    const root = workspace.root;
    return value.split(root).join("workspace:").replace(/\\/g, "/");
  }
  if (Array.isArray(value)) return value.map((item) => workspaceAlias(workspace, item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, workspaceAlias(workspace, item)])
    );
  }
  return value;
}

function boundResult(workspace: Workspace, value: unknown): unknown {
  const aliased = workspaceAlias(workspace, value);
  const text = JSON.stringify(aliased);
  const sanitized = sanitizeExecutionOutput(text);
  if (!sanitized.allowed) {
    return { withheld: true, reason: sanitized.reason };
  }
  try {
    return JSON.parse(sanitized.text);
  } catch {
    return sanitized.text;
  }
}

export async function assertBridgeForStoredScope(workspace: Workspace): Promise<void> {
  const stored = readWriteScopeState(workspace.id);
  if (!stored) return;
  const expires = Date.parse(stored.expiresAt);
  if (!Number.isFinite(expires) || expires <= Date.now()) return;
  const observation = await findBridgeObservation(workspace.id);
  if (observation.state !== "healthy" || observation.runtime.startedAt !== stored.bridgeStartedAt) {
    throw new WebError("BRIDGE_NOT_RUNNING", "Writable Scope requires a live Bridge");
  }
}

export async function dispatchWebTool(
  workspace: Workspace,
  snapshot: CapabilitySnapshot,
  call: WebToolInvocation
): Promise<DispatchResult> {
  try {
    switch (call.tool) {
      case "workspace_info": {
        const project = workspace.detectProject();
        const git = gitInfo(workspace.root);
        return {
          ok: true,
          result: boundResult(workspace, {
            workspaceId: workspace.id,
            workspaceName: workspace.name,
            rootAlias: "workspace:/",
            ...project,
            git,
          }),
        };
      }
      case "list_directory": {
        const args = listArgs.parse(call.arguments);
        return { ok: true, result: boundResult(workspace, await workspace.listDirectory(args.path, args)) };
      }
      case "read_file": {
        const args = readArgs.parse(call.arguments);
        return {
          ok: true,
          result: boundResult(
            workspace,
            await workspace.readFile(args.path, { startLine: args.start_line, endLine: args.end_line })
          ),
        };
      }
      case "search_workspace": {
        const args = searchArgs.parse(call.arguments);
        return { ok: true, result: boundResult(workspace, await searchWorkspace(workspace, args)) };
      }
      case "git_status":
        return { ok: true, result: boundResult(workspace, gitStatus(workspace)) };
      case "git_diff": {
        const args = diffArgs.parse(call.arguments);
        let relPath: string | undefined;
        if (args.path) relPath = workspace.resolve(args.path).rel;
        return {
          ok: true,
          result: boundResult(
            workspace,
            gitDiff(workspace, { mode: args.mode as DiffMode, offset: args.offset, maxBytes: args.max_bytes }, relPath)
          ),
        };
      }
      case "write_scope_info": {
        const observation = await findBridgeObservation(workspace.id);
        const startedAt = observation.state === "healthy" ? observation.runtime.startedAt : undefined;
        return { ok: true, result: writeScopeInfo(workspace.id, startedAt) };
      }
      case "write_file": {
        const args = writeArgs.parse(call.arguments);
        const scope = await assertMutableCapability(workspace, snapshot, "write_file");
        const written = await writeFileWithinScope({
          workspace,
          scope,
          path: args.path,
          content: args.content,
          expectedWritableSha256: args.expected_writable_sha256,
        });
        return { ok: true, result: boundResult(workspace, written) };
      }
      case "run_poc": {
        const args = pocArgs.parse(call.arguments);
        const scope = await assertMutableCapability(workspace, snapshot, "run_poc");
        const poc = await runPoc({
          workspace,
          scope,
          program: args.program,
          args: args.args,
          cwd: args.cwd,
          timeoutMs: args.timeout_ms,
        });
        return { ok: true, result: boundResult(workspace, poc) };
      }
      default:
        return { ok: false, error: { code: "WEB_PROTOCOL_INVALID", message: "unknown tool" } };
    }
  } catch (error) {
    return fail(error);
  }
}

export function summarizeWorkspaceChanges(workspace: Workspace): string[] {
  const status = gitStatus(workspace);
  const names = [
    ...status.staged.map((entry) => entry.path),
    ...status.unstaged.map((entry) => entry.path),
    ...status.untracked,
  ];
  return [...new Set(names.map((name) => name.replace(/\\/g, "/")))];
}

export function toWorkspacePath(rel: string): string {
  return `workspace:/${rel.replace(/\\/g, "/").replace(/^\.\//, "")}`;
}
