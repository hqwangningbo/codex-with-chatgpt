import { z } from "zod";
import { randomBytes } from "node:crypto";
import { ACTION_CLOSE, ACTION_OPEN, RESULT_CLOSE, RESULT_OPEN, WEB_TOOLS, type WebToolName } from "../web/protocol.js";

export const DEV_PROTOCOL = "c2c-web-dev-v1";
export const DEV_READY = "C2C DEV READY";

export const DEV_TOOLS = ["environment_info", ...WEB_TOOLS] as const;
export type DevToolName = (typeof DEV_TOOLS)[number];

const toolCallSchema = z.object({
  protocol: z.literal(DEV_PROTOCOL),
  session_id: z.string().min(8),
  workspace: z.string().min(1).optional(),
  type: z.literal("tool_call"),
  call_id: z.string().min(1),
  tool: z.enum(DEV_TOOLS),
  arguments: z.record(z.unknown()).default({}),
});

export type DevToolCallAction = z.infer<typeof toolCallSchema>;

export function newDevSessionId(): string {
  return `c2c_wd_${randomBytes(12).toString("hex")}`;
}

export type ParseDevActionResult =
  | { ok: true; action: DevToolCallAction }
  | { ok: false; kind: "prose" }
  | { ok: false; kind: "malformed"; code: "WEB_PROTOCOL_INVALID"; message: string };

export function parseDevAssistantAction(
  text: string,
  sessionId: string,
  seenCallIds: Set<string>
): ParseDevActionResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, kind: "prose" };
  const exact = trimmed.startsWith(ACTION_OPEN) && trimmed.endsWith(ACTION_CLOSE);
  if (!exact) return { ok: false, kind: "prose" };
  const inner = trimmed.slice(ACTION_OPEN.length, trimmed.length - ACTION_CLOSE.length).trim();
  if (inner.includes(ACTION_OPEN) || inner.includes(ACTION_CLOSE)) {
    return {
      ok: false,
      kind: "malformed",
      code: "WEB_PROTOCOL_INVALID",
      message: "Multiple <C2C_ACTION> envelopes are not allowed",
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(inner);
  } catch {
    return { ok: false, kind: "malformed", code: "WEB_PROTOCOL_INVALID", message: "C2C_ACTION JSON is malformed" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, kind: "malformed", code: "WEB_PROTOCOL_INVALID", message: "C2C_ACTION must be an object" };
  }
  const record = raw as Record<string, unknown>;
  if (record.protocol !== DEV_PROTOCOL) {
    return {
      ok: false,
      kind: "malformed",
      code: "WEB_PROTOCOL_INVALID",
      message: "protocol must be c2c-web-dev-v1",
    };
  }
  if (record.session_id !== sessionId) {
    return {
      ok: false,
      kind: "malformed",
      code: "WEB_PROTOCOL_INVALID",
      message: "session_id does not match this chat session",
    };
  }
  if (record.type !== "tool_call") {
    return {
      ok: false,
      kind: "malformed",
      code: "WEB_PROTOCOL_INVALID",
      message: "type must be tool_call",
    };
  }
  if (typeof record.tool === "string" && !DEV_TOOLS.includes(record.tool as DevToolName)) {
    return {
      ok: false,
      kind: "malformed",
      code: "WEB_PROTOCOL_INVALID",
      message: `unknown or forbidden tool '${record.tool}'`,
    };
  }
  if (record.tool !== "environment_info" && (typeof record.workspace !== "string" || !record.workspace.trim())) {
    return {
      ok: false,
      kind: "malformed",
      code: "WEB_PROTOCOL_INVALID",
      message: "workspace alias is required",
    };
  }
  const parsed = toolCallSchema.safeParse(record);
  if (!parsed.success) {
    return {
      ok: false,
      kind: "malformed",
      code: "WEB_PROTOCOL_INVALID",
      message: parsed.error.issues[0]?.message ?? "invalid tool_call envelope",
    };
  }
  if (seenCallIds.has(parsed.data.call_id)) {
    return {
      ok: false,
      kind: "malformed",
      code: "WEB_PROTOCOL_INVALID",
      message: "call_id has already been used",
    };
  }
  return { ok: true, action: parsed.data };
}

export function formatDevToolResult(input: {
  sessionId: string;
  callId: string;
  tool: string;
  workspace?: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}): string {
  return `${RESULT_OPEN}\n${JSON.stringify(
    {
      protocol: DEV_PROTOCOL,
      session_id: input.sessionId,
      call_id: input.callId,
      tool: input.tool,
      ...(input.workspace ? { workspace: input.workspace } : {}),
      ok: input.ok,
      ...(input.ok ? { result: input.result } : { error: input.error }),
    },
    null,
    2
  )}\n${RESULT_CLOSE}`;
}

export function devProtocolCorrection(sessionId: string, reason: string): string {
  return [
    "The previous assistant message was not a valid C2C Dev Action envelope.",
    `Reason: ${reason}`,
    "If you need a local tool, output exactly one <C2C_ACTION> JSON object and nothing else.",
    `protocol must be ${DEV_PROTOCOL}.`,
    `session_id must be ${sessionId}.`,
    "Workspace-specific tools must include workspace: \"<alias>\".",
    "Ordinary chat replies must not include <C2C_ACTION>.",
  ].join("\n");
}

export function isDevWorkspaceTool(tool: string): tool is WebToolName {
  return WEB_TOOLS.includes(tool as WebToolName);
}
