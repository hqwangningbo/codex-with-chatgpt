import { WebError } from "../web/errors.js";
import { CHAIN_MAX_STEPS } from "../web/chat-turn.js";
import { checkConcurrentUser } from "../web/selectors.js";
import type { InteractiveChatSession } from "../web/session.js";
import { activeWebTask, observeWebTask, writeWebRuntime } from "../web/state.js";
import { captureDevCapability, type DevEnvironment } from "./environment.js";
import { dispatchDevTool } from "./dispatcher.js";
import {
  DEV_READY,
  devProtocolCorrection,
  formatDevToolResult,
  newDevSessionId,
  parseDevAssistantAction,
} from "./protocol.js";
import { devBootstrapPrompt } from "./prompt.js";
import { findDevObservation } from "./runtime.js";

export interface DevChatInput {
  env: DevEnvironment;
  session: InteractiveChatSession;
  signal?: AbortSignal;
  onReady?: (info: { sessionId: string }) => void;
}

export interface DevChatResult {
  sessionId: string;
  status: "interrupted" | "failed";
  steps: number;
  error?: { code: string; message: string };
}

export async function runDevChat(input: DevChatInput): Promise<DevChatResult> {
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
  const envObservation = await findDevObservation(input.env.name);
  if (envObservation.state !== "healthy") {
    throw new WebError("BRIDGE_NOT_RUNNING", "Development environment Bridge is not running");
  }
  const snapshot = captureDevCapability(input.env);
  const sessionId = newDevSessionId();
  writeRuntime(snapshot.environmentId, sessionId, 0, "running");

  const seenCallIds = new Set<string>();
  let totalSteps = 0;

  const assertNoConcurrentUser = async (): Promise<void> => {
    const checked = checkConcurrentUser(input.session.acknowledgedBaseline(), await input.session.snapshot());
    if (checked.status === "fail") {
      throw new WebError(
        checked.code,
        checked.code === "WEB_TURN_AMBIGUOUS"
          ? "ChatGPT turns were not unique during the tool chain"
          : "ChatGPT turn identity could not be proven during the tool chain"
      );
    }
    if (checked.status === "concurrent") {
      throw new WebError(
        "WEB_CHAT_CONCURRENT_USER_TURN",
        "A new human user turn arrived while a tool chain was active"
      );
    }
  };

  const processAssistant = async (text: string): Promise<void> => {
    let correctionUsed = false;
    let reply = text;
    let chainSteps = 0;
    for (;;) {
      if (input.signal?.aborted) throw new WebError("WEB_TIMEOUT", "Web session was cancelled");
      const parsed = parseDevAssistantAction(reply, sessionId, seenCallIds);
      if (!parsed.ok && parsed.kind === "prose") return;
      if (!parsed.ok) {
        if (!correctionUsed) {
          correctionUsed = true;
          await assertNoConcurrentUser();
          reply = await input.session.sendAndWait(devProtocolCorrection(sessionId, parsed.message), {
            signal: input.signal,
            multipleUserTurns: "concurrent",
          });
          continue;
        }
        throw new WebError("WEB_PROTOCOL_INVALID", parsed.message);
      }
      if (chainSteps >= CHAIN_MAX_STEPS) {
        throw new WebError("WEB_MAX_STEPS_REACHED", `Reached max_steps=${CHAIN_MAX_STEPS} for this tool chain`);
      }
      await assertNoConcurrentUser();
      seenCallIds.add(parsed.action.call_id);
      chainSteps += 1;
      totalSteps += 1;
      writeRuntime(snapshot.environmentId, sessionId, totalSteps, "running");
      const dispatched = await dispatchDevTool(input.env, snapshot, {
        tool: parsed.action.tool,
        workspace: parsed.action.workspace,
        arguments: parsed.action.arguments,
      });
      await assertNoConcurrentUser();
      reply = await input.session.sendAndWait(
        formatDevToolResult({
          sessionId,
          callId: parsed.action.call_id,
          tool: parsed.action.tool,
          workspace: parsed.action.workspace,
          ok: dispatched.ok,
          result: dispatched.result,
          error: dispatched.error,
        }),
        { signal: input.signal, multipleUserTurns: "concurrent" }
      );
      correctionUsed = false;
    }
  };

  try {
    await input.session.ensureReady();
    const ready = await input.session.sendAndWait(devBootstrapPrompt({ sessionId, env: input.env }), {
      signal: input.signal,
    });
    if (ready.trim() !== DEV_READY) {
      throw new WebError("WEB_PROTOCOL_INVALID", "Dev chat bootstrap did not reply C2C DEV READY");
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
      try {
        await processAssistant(text);
      } catch (error) {
        if (error instanceof WebError && recoverableChatError(error.code)) continue;
        throw error;
      }
    }

    writeRuntime(snapshot.environmentId, sessionId, totalSteps, "interrupted", true);
    return { sessionId, status: "interrupted", steps: totalSteps };
  } catch (error) {
    const code = error instanceof WebError ? error.code : "INTERNAL_ERROR";
    const message = error instanceof Error ? error.message : String(error);
    const interrupted = input.signal?.aborted || code === "WEB_TIMEOUT";
    writeRuntime(snapshot.environmentId, sessionId, totalSteps, interrupted ? "interrupted" : "failed", true);
    return {
      sessionId,
      status: interrupted ? "interrupted" : "failed",
      steps: totalSteps,
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
  environmentId: string,
  sessionId: string,
  stepCount: number,
  status: "running" | "interrupted" | "failed",
  clearPid = false
): void {
  writeWebRuntime({
    pid: clearPid ? null : process.pid,
    requestId: null,
    sessionId,
    kind: "dev",
    workspaceId: environmentId,
    startedAt: new Date().toISOString(),
    stepCount,
    status,
  });
}
