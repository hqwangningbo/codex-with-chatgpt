import { z } from "zod";
import { randomBytes } from "node:crypto";

export const WEB_PROTOCOL = "c2c-web-research-v1";
export const ACTION_OPEN = "<C2C_ACTION>";
export const ACTION_CLOSE = "</C2C_ACTION>";
export const RESULT_OPEN = "<C2C_TOOL_RESULT>";
export const RESULT_CLOSE = "</C2C_TOOL_RESULT>";

export const WEB_TOOLS = [
  "workspace_info",
  "list_directory",
  "read_file",
  "search_workspace",
  "git_status",
  "git_diff",
  "write_scope_info",
  "write_file",
  "run_poc",
] as const;

export type WebToolName = (typeof WEB_TOOLS)[number];
export const MUTABLE_TOOLS = new Set<WebToolName>(["write_file", "run_poc"]);

const toolCallSchema = z.object({
  protocol: z.literal(WEB_PROTOCOL),
  request_id: z.string().min(8),
  type: z.literal("tool_call"),
  call_id: z.string().min(1),
  tool: z.enum(WEB_TOOLS),
  arguments: z.record(z.unknown()).default({}),
});

const finalSchema = z.object({
  protocol: z.literal(WEB_PROTOCOL),
  request_id: z.string().min(8),
  type: z.literal("final"),
  summary: z.string().min(1),
  artifacts: z.array(z.string()).default([]),
});

export type ToolCallAction = z.infer<typeof toolCallSchema>;
export type FinalAction = z.infer<typeof finalSchema>;
export type ParsedAction = ToolCallAction | FinalAction;

export function newRequestId(): string {
  return `c2c_wr_${randomBytes(12).toString("hex")}`;
}

export function extractActionBlocks(text: string): string[] {
  const blocks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf(ACTION_OPEN, cursor);
    if (start < 0) break;
    const end = text.indexOf(ACTION_CLOSE, start + ACTION_OPEN.length);
    if (end < 0) break;
    blocks.push(text.slice(start + ACTION_OPEN.length, end).trim());
    cursor = end + ACTION_CLOSE.length;
  }
  return blocks;
}

export type ParseActionResult =
  | { ok: true; action: ParsedAction }
  | { ok: false; code: "WEB_PROTOCOL_INVALID"; message: string };

export function parseAssistantAction(
  text: string,
  requestId: string,
  seenCallIds: Set<string>
): ParseActionResult {
  const blocks = extractActionBlocks(text);
  if (blocks.length === 0) {
    return { ok: false, code: "WEB_PROTOCOL_INVALID", message: "No <C2C_ACTION> envelope was found" };
  }
  if (blocks.length > 1) {
    return { ok: false, code: "WEB_PROTOCOL_INVALID", message: "Multiple <C2C_ACTION> envelopes are not allowed" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(blocks[0]);
  } catch {
    return { ok: false, code: "WEB_PROTOCOL_INVALID", message: "C2C_ACTION JSON is malformed" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, code: "WEB_PROTOCOL_INVALID", message: "C2C_ACTION must be an object" };
  }
  const record = raw as Record<string, unknown>;
  if (record.protocol !== WEB_PROTOCOL) {
    return { ok: false, code: "WEB_PROTOCOL_INVALID", message: "protocol must be c2c-web-research-v1" };
  }
  if (record.request_id !== requestId) {
    return { ok: false, code: "WEB_PROTOCOL_INVALID", message: "request_id does not match this research task" };
  }
  if (record.type === "final") {
    const parsed = finalSchema.safeParse(record);
    if (!parsed.success) {
      return { ok: false, code: "WEB_PROTOCOL_INVALID", message: parsed.error.issues[0]?.message ?? "invalid final envelope" };
    }
    return { ok: true, action: parsed.data };
  }
  if (record.type === "tool_call") {
    if (typeof record.tool === "string" && !WEB_TOOLS.includes(record.tool as WebToolName)) {
      return { ok: false, code: "WEB_PROTOCOL_INVALID", message: `unknown or forbidden tool '${record.tool}'` };
    }
    const parsed = toolCallSchema.safeParse(record);
    if (!parsed.success) {
      return { ok: false, code: "WEB_PROTOCOL_INVALID", message: parsed.error.issues[0]?.message ?? "invalid tool_call envelope" };
    }
    if (seenCallIds.has(parsed.data.call_id)) {
      return { ok: false, code: "WEB_PROTOCOL_INVALID", message: "call_id has already been used" };
    }
    return { ok: true, action: parsed.data };
  }
  return { ok: false, code: "WEB_PROTOCOL_INVALID", message: "type must be tool_call or final" };
}

export function formatToolResult(input: {
  requestId: string;
  callId: string;
  tool: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}): string {
  return `${RESULT_OPEN}\n${JSON.stringify(
    {
      protocol: WEB_PROTOCOL,
      request_id: input.requestId,
      call_id: input.callId,
      tool: input.tool,
      ok: input.ok,
      ...(input.ok ? { result: input.result } : { error: input.error }),
    },
    null,
    2
  )}\n${RESULT_CLOSE}`;
}

export function protocolCorrection(requestId: string, reason: string): string {
  return [
    "The previous assistant message was not a valid C2C Research envelope.",
    `Reason: ${reason}`,
    "Output exactly one <C2C_ACTION> JSON object.",
    `protocol must be ${WEB_PROTOCOL}.`,
    `request_id must be ${requestId}.`,
    "Do not explain outside the envelope.",
  ].join("\n");
}
