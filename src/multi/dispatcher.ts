import { z } from "zod";
import { WorkspaceError } from "../workspace/manager.js";
import { searchWorkspace } from "../workspace/search.js";
import { gitDiff, gitInfo, gitStatus, type DiffMode } from "../workspace/git.js";
import { sanitizeExecutionOutput } from "../execution/sanitize.js";
import { MultiError } from "./errors.js";
import type { MultiWorkspaceRegistry } from "./registry.js";

export const MULTI_TOOLS = [
  "environment_info",
  "workspace_info",
  "list_directory",
  "read_file",
  "search_workspace",
  "git_status",
  "git_diff",
] as const;

export type MultiToolName = (typeof MULTI_TOOLS)[number];

export interface MultiDispatchResult {
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

export interface MultiToolCall {
  tool: MultiToolName;
  workspace?: string;
  arguments: Record<string, unknown>;
}

function fail(error: unknown): MultiDispatchResult {
  if (error instanceof MultiError || error instanceof WorkspaceError) {
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

function rewriteAbsRoots(registry: MultiWorkspaceRegistry, value: string): string {
  let text = value;
  const repos = registry.snapshot().sort((a, b) => b.root.length - a.root.length);
  for (const repo of repos) {
    if (text.includes(repo.root)) {
      text = text.split(repo.root).join(`workspace://${repo.alias}`);
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
            item.map((entry) =>
              typeof entry === "string" && !entry.startsWith("workspace://") ? toAliasPath(alias, entry) : prefixKnownPaths(alias, entry)
            ),
          ];
        }
        return [key, prefixKnownPaths(alias, item)];
      })
    );
  }
  return value;
}

function boundResult(registry: MultiWorkspaceRegistry, alias: string | undefined, value: unknown): unknown {
  const walk = (input: unknown): unknown => {
    if (typeof input === "string") return rewriteAbsRoots(registry, input);
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

function pathLooksAbsolute(requested: string): boolean {
  return requested.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(requested) || requested.startsWith("\\\\");
}

function rejectAbsolute(requested: string): void {
  if (pathLooksAbsolute(requested)) {
    throw new WorkspaceError("PATH_OUTSIDE_WORKSPACE", "Absolute paths are not allowed");
  }
}

export function environmentInfoResult(
  name: string,
  registry: MultiWorkspaceRegistry,
  extra: { generation?: number } = {}
): unknown {
  return boundResult(registry, undefined, {
    name,
    generation: extra.generation ?? registry.generation,
    workspaces: registry.aliases().map((alias) => ({
      alias,
      root: `workspace://${alias}/`,
    })),
  });
}

export async function dispatchMultiTool(
  name: string,
  registry: MultiWorkspaceRegistry,
  call: MultiToolCall
): Promise<MultiDispatchResult> {
  try {
    if (!MULTI_TOOLS.includes(call.tool)) {
      return { ok: false, error: { code: "MULTI_PROTOCOL_INVALID", message: "unknown tool" } };
    }
    if (call.tool === "environment_info") {
      return { ok: true, result: environmentInfoResult(name, registry) };
    }
    const alias = call.workspace;
    if (!alias || typeof alias !== "string") {
      throw new MultiError("MULTI_WORKSPACE_NOT_ATTACHED", "workspace alias is required");
    }
    const attached = registry.get(alias);
    const workspace = attached.workspace;
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
          result: boundResult(registry, alias, {
            alias,
            workspaceName: workspace.name,
            root: `workspace://${alias}/`,
            ...project,
            git,
          }),
        };
      }
      case "list_directory": {
        const parsed = listArgs.parse(args);
        return {
          ok: true,
          result: boundResult(registry, alias, await workspace.listDirectory(rel(parsed.path), parsed)),
        };
      }
      case "read_file": {
        const parsed = readArgs.parse(args);
        return {
          ok: true,
          result: boundResult(
            registry,
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
            registry,
            alias,
            await searchWorkspace(workspace, { ...parsed, path: parsed.path ? rel(parsed.path) : undefined })
          ),
        };
      }
      case "git_status":
        return { ok: true, result: boundResult(registry, alias, gitStatus(workspace)) };
      case "git_diff": {
        const parsed = diffArgs.parse(args);
        let relPath: string | undefined;
        if (parsed.path) relPath = workspace.resolve(rel(parsed.path)).rel;
        return {
          ok: true,
          result: boundResult(
            registry,
            alias,
            gitDiff(workspace, { mode: parsed.mode as DiffMode, offset: parsed.offset, maxBytes: parsed.max_bytes }, relPath)
          ),
        };
      }
      default:
        return { ok: false, error: { code: "MULTI_PROTOCOL_INVALID", message: "unknown tool" } };
    }
  } catch (error) {
    return fail(error);
  }
}
