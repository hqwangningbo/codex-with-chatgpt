import { Workspace } from "../workspace/manager.js";
import { WebError } from "./errors.js";
import {
  captureCapabilitySnapshot,
  dispatchWebTool,
  summarizeWorkspaceChanges,
  type CapabilitySnapshot,
} from "./dispatcher.js";
import {
  formatToolResult,
  newRequestId,
  parseAssistantAction,
  protocolCorrection,
  type FinalAction,
} from "./protocol.js";
import { researchContractPrompt } from "./prompt.js";
import type { ChatSession } from "./session.js";
import { activeWebTask, observeWebTask, writeWebRuntime } from "./state.js";

export interface ResearchInput {
  workspace: Workspace;
  task: string;
  maxSteps?: number;
  session: ChatSession;
  signal?: AbortSignal;
}

export interface ResearchResult {
  requestId: string;
  status: "completed" | "failed" | "interrupted";
  steps: number;
  summary?: string;
  artifacts?: string[];
  changedFiles: string[];
  error?: { code: string; message: string };
}

const DEFAULT_MAX_STEPS = 30;
const HARD_MAX_STEPS = 60;

export async function runResearchTurn(input: ResearchInput): Promise<ResearchResult> {
  const observation = observeWebTask();
  if (observation.state === "unknown") {
    throw new WebError("WEB_STOP_PID_UNCERTAIN", "A recorded PID is live but unproven; refusing to start another research task");
  }
  const busy = activeWebTask();
  if (busy && busy.pid !== process.pid) {
    throw new WebError("WEB_RESEARCH_BUSY", "A Web Research task is already running");
  }
  const maxSteps = Math.min(HARD_MAX_STEPS, Math.max(1, input.maxSteps ?? DEFAULT_MAX_STEPS));
  const requestId = newRequestId();
  const snapshot: CapabilitySnapshot = await captureCapabilitySnapshot(input.workspace);
  writeWebRuntime({
    pid: process.pid,
    requestId,
    workspaceId: input.workspace.id,
    startedAt: new Date().toISOString(),
    stepCount: 0,
    status: "running",
    kind: "research",
    sessionId: null,
  });

  const seenCallIds = new Set<string>();
  let steps = 0;
  let correctionUsed = false;
  try {
    await input.session.ensureReady();
    let reply = await input.session.sendAndWait(
      researchContractPrompt({
        task: input.task,
        requestId,
        snapshot,
        maxSteps,
      }),
      { signal: input.signal }
    );

    for (;;) {
      const parsed = parseAssistantAction(reply, requestId, seenCallIds);
      if (!parsed.ok) {
        if (!correctionUsed) {
          correctionUsed = true;
          reply = await input.session.sendAndWait(protocolCorrection(requestId, parsed.message), {
            signal: input.signal,
          });
          continue;
        }
        throw new WebError("WEB_PROTOCOL_INVALID", parsed.message);
      }
      if (parsed.action.type === "final") {
        return finish(input.workspace, requestId, steps, parsed.action);
      }
      if (steps >= maxSteps) {
        throw new WebError("WEB_MAX_STEPS_REACHED", `Reached max_steps=${maxSteps}`);
      }
      seenCallIds.add(parsed.action.call_id);
      steps += 1;
      writeWebRuntime({
        pid: process.pid,
        requestId,
        workspaceId: input.workspace.id,
        startedAt: new Date().toISOString(),
        stepCount: steps,
        status: "running",
        kind: "research",
      });
      const dispatched = await dispatchWebTool(input.workspace, snapshot, parsed.action);
      reply = await input.session.sendAndWait(
        formatToolResult({
          requestId,
          callId: parsed.action.call_id,
          tool: parsed.action.tool,
          ok: dispatched.ok,
          result: dispatched.result,
          error: dispatched.error,
        }),
        { signal: input.signal }
      );
    }
  } catch (error) {
    const code = error instanceof WebError ? error.code : "INTERNAL_ERROR";
    const message = error instanceof Error ? error.message : String(error);
    writeWebRuntime({
      pid: null,
      requestId,
      workspaceId: input.workspace.id,
      startedAt: new Date().toISOString(),
      stepCount: steps,
      status: input.signal?.aborted ? "interrupted" : "failed",
      kind: "research",
    });
    return {
      requestId,
      status: input.signal?.aborted ? "interrupted" : "failed",
      steps,
      changedFiles: summarizeWorkspaceChanges(input.workspace),
      error: { code, message },
    };
  }
}

function finish(workspace: Workspace, requestId: string, steps: number, action: FinalAction): ResearchResult {
  writeWebRuntime({
    pid: null,
    requestId,
    workspaceId: workspace.id,
    startedAt: new Date().toISOString(),
    stepCount: steps,
    status: "completed",
    kind: "research",
  });
  return {
    requestId,
    status: "completed",
    steps,
    summary: action.summary,
    artifacts: action.artifacts,
    changedFiles: summarizeWorkspaceChanges(workspace),
  };
}
