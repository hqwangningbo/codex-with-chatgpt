import { describe, expect, it } from "vitest";
import {
  ACTION_CLOSE,
  ACTION_OPEN,
  formatToolResult,
  parseAssistantAction,
  WEB_PROTOCOL,
} from "../src/web/protocol.js";

function envelope(body: unknown): string {
  return `${ACTION_OPEN}\n${JSON.stringify(body)}\n${ACTION_CLOSE}`;
}

const requestId = "c2c_wr_testrequestid";

function toolCall(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: WEB_PROTOCOL,
    request_id: requestId,
    type: "tool_call",
    call_id: "call-1",
    tool: "workspace_info",
    arguments: {},
    ...over,
  };
}

describe("web research protocol", () => {
  it("accepts a valid tool_call and final envelope", () => {
    const seen = new Set<string>();
    const call = parseAssistantAction(envelope(toolCall()), requestId, seen);
    expect(call).toMatchObject({
      ok: true,
      action: { type: "tool_call", tool: "workspace_info", call_id: "call-1" },
    });
    seen.add("call-1");
    const final = parseAssistantAction(
      envelope({
        protocol: WEB_PROTOCOL,
        request_id: requestId,
        type: "final",
        summary: "done",
        artifacts: ["workspace:/docs/a.md"],
      }),
      requestId,
      seen
    );
    expect(final).toMatchObject({ ok: true, action: { type: "final", summary: "done" } });
  });

  it("rejects the wrong protocol, request_id, duplicate call_id, and multiple blocks", () => {
    expect(parseAssistantAction(envelope(toolCall({ protocol: "other" })), requestId, new Set()).ok).toBe(false);
    expect(parseAssistantAction(envelope(toolCall({ request_id: "other-id-xx" })), requestId, new Set())).toMatchObject({
      code: "WEB_PROTOCOL_INVALID",
    });
    expect(parseAssistantAction(envelope(toolCall()), requestId, new Set(["call-1"]))).toMatchObject({
      message: expect.stringMatching(/call_id/),
    });
    const doubled = `${envelope(toolCall())}\n${envelope(toolCall({ call_id: "call-2" }))}`;
    expect(parseAssistantAction(doubled, requestId, new Set())).toMatchObject({
      message: expect.stringMatching(/Multiple/),
    });
  });

  it("rejects malformed JSON, unknown tools, and a shell tool", () => {
    expect(parseAssistantAction(`${ACTION_OPEN}{not json}${ACTION_CLOSE}`, requestId, new Set())).toMatchObject({
      code: "WEB_PROTOCOL_INVALID",
    });
    expect(parseAssistantAction(envelope(toolCall({ tool: "shell" })), requestId, new Set())).toMatchObject({
      message: expect.stringMatching(/unknown or forbidden tool 'shell'/),
    });
    expect(parseAssistantAction(envelope(toolCall({ tool: "exec" })), requestId, new Set()).ok).toBe(false);
    expect(parseAssistantAction("plain prose with no envelope", requestId, new Set())).toMatchObject({
      message: expect.stringMatching(/No <C2C_ACTION>/),
    });
  });

  it("formats tool results without extra envelopes", () => {
    const text = formatToolResult({
      requestId,
      callId: "call-1",
      tool: "workspace_info",
      ok: true,
      result: { rootAlias: "workspace:/" },
    });
    expect(text).toContain("<C2C_TOOL_RESULT>");
    expect(text).toContain(WEB_PROTOCOL);
    expect(JSON.parse(text.replace("<C2C_TOOL_RESULT>", "").replace("</C2C_TOOL_RESULT>", "").trim())).toMatchObject({
      ok: true,
      call_id: "call-1",
    });
  });
});
