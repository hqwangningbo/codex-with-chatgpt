import { Workspace } from "../workspace/manager.js";
import { WebError } from "./errors.js";
import {
  assertBridgeForStoredScope,
  captureCapabilitySnapshot,
  dispatchWebTool,
  type CapabilitySnapshot,
} from "./dispatcher.js";
import {
  chatProtocolCorrection,
  formatChatToolResult,
  newChatSessionId,
  parseChatAssistantAction,
} from "./protocol.js";
import { CHAT_READY, chatBootstrapPrompt } from "./prompt.js";
import type { InteractiveChatSession } from "./session.js";
import { newLogicalIds, uniqueIds } from "./selectors.js";
import { activeWebTask, observeWebTask, writeWebRuntime } from "./state.js";

export interface ChatInput {
  workspace: Workspace;
  session: InteractiveChatSession;
  signal?: AbortSignal;
  onReady?: (info: { sessionId: string }) => void;
}

export interface ChatResult {
  sessionId: string;
  status: "interrupted" | "failed";
  steps: number;
  error?: { code: string; message: string };
}

const CHAIN_MAX_STEPS = 30;

export async function runWebChat(input: ChatInput): Promise<ChatResult> {
  const observation = observeWebTask();
  if (observation.state === "unknown") {
    throw new WebError(
      "WEB_STOP_PID_UNCERTAIN",
      "A recorded PID is live but unproven; refusing to start another web session"
    );
  }
  const busy = activeWebTask();
  if (busy && busy.pid !== process.pid) {
    throw new WebError("WEB_RESEARCH_BUSY", "A Web Research or Chat session is already running");
  }
  await assertBridgeForStoredScope(input.workspace);
  const snapshot: CapabilitySnapshot = await captureCapabilitySnapshot(input.workspace);
  const sessionId = newChatSessionId();
  writeRuntime(input.workspace.id, sessionId, 0, "running");

  const seenCallIds = new Set<string>();
  let steps = 0;
  let knownUsers: string[] = [];

  const syncKnownUsers = async (): Promise<void> => {
    const snap = await input.session.snapshot();
    knownUsers = [...new Set([...knownUsers, ...snap.userTurnIds.filter((id) => id && id.trim())])];
  };

  const absorbVisibleTurns = async (): Promise<void> => {
    await syncKnownUsers();
  };

  const assertNoConcurrentUser = async (): Promise<void> => {
    const snap = await input.session.snapshot();
    const live = uniqueIds(snap.userTurnIds.filter((id) => id && id.trim()));
    if (!live.ok) {
      throw new WebError(
        live.reason === "duplicate" ? "WEB_TURN_AMBIGUOUS" : "WEB_TURN_STATE_UNKNOWN",
        "ChatGPT user turns were not unique during the tool chain"
      );
    }
    if (newLogicalIds(knownUsers, live.ids).length > 0) {
      throw new WebError(
        "WEB_CHAT_CONCURRENT_USER_TURN",
        "A new human user turn arrived while a tool chain was active"
      );
    }
  };

  const processAssistant = async (text: string): Promise<void> => {
    let correctionUsed = false;
    let reply = text;
    for (;;) {
      if (input.signal?.aborted) throw new WebError("WEB_TIMEOUT", "Web session was cancelled");
      const parsed = parseChatAssistantAction(reply, sessionId, seenCallIds);
      if (!parsed.ok && parsed.kind === "prose") return;
      if (!parsed.ok) {
        if (!correctionUsed) {
          correctionUsed = true;
          await assertNoConcurrentUser();
          reply = await input.session.sendAndWait(chatProtocolCorrection(sessionId, parsed.message), {
            signal: input.signal,
            multipleUserTurns: "concurrent",
          });
          await syncKnownUsers();
          continue;
        }
        throw new WebError("WEB_PROTOCOL_INVALID", parsed.message);
      }
      if (steps >= CHAIN_MAX_STEPS) {
        throw new WebError("WEB_MAX_STEPS_REACHED", `Reached max_steps=${CHAIN_MAX_STEPS} for this tool chain`);
      }
      await assertNoConcurrentUser();
      seenCallIds.add(parsed.action.call_id);
      steps += 1;
      writeRuntime(input.workspace.id, sessionId, steps, "running");
      const dispatched = await dispatchWebTool(input.workspace, snapshot, parsed.action);
      await assertNoConcurrentUser();
      reply = await input.session.sendAndWait(
        formatChatToolResult({
          sessionId,
          callId: parsed.action.call_id,
          tool: parsed.action.tool,
          ok: dispatched.ok,
          result: dispatched.result,
          error: dispatched.error,
        }),
        { signal: input.signal, multipleUserTurns: "concurrent" }
      );
      await syncKnownUsers();
      correctionUsed = false;
    }
  };

  try {
    await input.session.ensureReady();
    await syncKnownUsers();
    const ready = await input.session.sendAndWait(
      chatBootstrapPrompt({
        sessionId,
        workspaceName: input.workspace.name,
        snapshot,
      }),
      { signal: input.signal }
    );
    await syncKnownUsers();
    if (ready.trim() !== CHAT_READY) {
      throw new WebError("WEB_PROTOCOL_INVALID", "Chat bootstrap did not reply C2C CHAT READY");
    }
    input.onReady?.({ sessionId });

    while (!input.signal?.aborted) {
      let text: string;
      try {
        text = await input.session.waitForNextManualExchange({ signal: input.signal });
      } catch (error) {
        if (input.signal?.aborted) break;
        throw error;
      }
      await syncKnownUsers();
      try {
        await processAssistant(text);
      } catch (error) {
        if (error instanceof WebError && recoverableChatError(error.code)) {
          await absorbVisibleTurns();
          continue;
        }
        throw error;
      }
    }

    writeRuntime(input.workspace.id, sessionId, steps, "interrupted", true);
    return { sessionId, status: "interrupted", steps };
  } catch (error) {
    const code = error instanceof WebError ? error.code : "INTERNAL_ERROR";
    const message = error instanceof Error ? error.message : String(error);
    const interrupted = input.signal?.aborted || code === "WEB_TIMEOUT";
    writeRuntime(input.workspace.id, sessionId, steps, interrupted ? "interrupted" : "failed", true);
    return {
      sessionId,
      status: interrupted ? "interrupted" : "failed",
      steps,
      error: { code, message },
    };
  }
}

function recoverableChatError(code: string): boolean {
  return (
    code === "WEB_CHAT_CONCURRENT_USER_TURN" ||
    code === "WEB_PROTOCOL_INVALID" ||
    code === "WEB_CAPABILITY_REVOKED" ||
    code === "WEB_MAX_STEPS_REACHED"
  );
}

function writeRuntime(
  workspaceId: string,
  sessionId: string,
  stepCount: number,
  status: "running" | "interrupted" | "failed",
  clearPid = false
): void {
  writeWebRuntime({
    pid: clearPid ? null : process.pid,
    requestId: null,
    sessionId,
    kind: "chat",
    workspaceId,
    startedAt: new Date().toISOString(),
    stepCount,
    status,
  });
}
