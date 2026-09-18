import type { Command } from "commander";
import { Workspace } from "../workspace/manager.js";
import { findBridgeObservation } from "../bridge/runtime.js";
import { WebError } from "../web/errors.js";
import { clearWebProfile, webProfileExists, webProfileDir } from "../web/profile.js";
import {
  activeWebTask,
  clearWebRuntime,
  observeWebTask,
  readWebRuntime,
  stopWebTask,
} from "../web/state.js";

interface CliHelpers {
  say: (msg: string) => void;
  check: (msg: string) => void;
  resolveWorkspace: (option?: string) => string;
  handleCliError: (error: unknown, json: boolean) => void;
  acceptUnusedWorkspaceOption: (command: Command) => Command;
}

function pidAlive(pid: number | null): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function statusAuthenticated(): false | "unknown" {
  return webProfileExists() ? "unknown" : false;
}

export function registerWebCommands(program: Command, helpers: CliHelpers): void {
  const { say, check, resolveWorkspace, handleCliError, acceptUnusedWorkspaceOption } = helpers;
  const web = program.command("web").description("Optional ChatGPT Web Research Harness");

  acceptUnusedWorkspaceOption(
    web
      .command("login")
      .description("Open the dedicated browser profile for a manual ChatGPT login")
      .option("--json", "machine-readable output", false)
  ).action(async (opts: { json: boolean }) => {
    try {
      const { openChatSession } = await import("../web/session.js");
      const { session } = await openChatSession({ login: true });
      try {
        if (!opts.json) {
          say("已打开 C2C 专用浏览器。请在 chatgpt.com 手动登录，不要把密码发给 C2C。");
          say("登录并看到 Temporary Chat 输入框后，回到这里即可。");
        }
        await session.ensureReady();
        const payload = { ok: true, profileExists: webProfileExists(), authenticated: true };
        if (opts.json) say(JSON.stringify(payload));
        else check("ChatGPT Web 会话已就绪");
      } finally {
        await session.close();
      }
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

  acceptUnusedWorkspaceOption(
    web
      .command("status")
      .description("Show Web Research Harness status without secrets")
      .option("--json", "machine-readable output", false)
  ).action((opts: { json: boolean }) => {
    const runtime = readWebRuntime();
    const observation = observeWebTask();
    const task = observation.state === "running" ? observation.runtime : null;
    const payload = {
      ok: true,
      profileExists: webProfileExists(),
      authenticated: statusAuthenticated(),
      browserRunning: Boolean(task && pidAlive(task.pid)),
      activeResearchTask: task
        ? { requestId: task.requestId, workspaceId: task.workspaceId, stepCount: task.stepCount, status: task.status }
        : null,
      status: runtime.status,
    };
    if (opts.json) {
      say(JSON.stringify(payload));
      return;
    }
    say(`Profile：${payload.profileExists ? "present" : "missing"}`);
    say(`Browser：${payload.browserRunning ? "running" : "stopped"}`);
    say(`Research：${payload.activeResearchTask ? payload.activeResearchTask.status : "idle"}`);
  });

  web
    .command("research")
    .description("Run a ChatGPT Web research task against the current Workspace")
    .requiredOption("--task <text>", "research task")
    .option("-w, --workspace <path>")
    .option("--model <name>", "current", "current")
    .option("--max-steps <n>", "local action budget", (value) => Number.parseInt(value, 10), 30)
    .option("--json", "machine-readable output", false)
    .action(
      async (opts: {
        task: string;
        workspace?: string;
        model: string;
        maxSteps: number;
        json: boolean;
      }) => {
        try {
          if (opts.model !== "current") {
            throw new WebError("WEB_MODEL_UNAVAILABLE", "V1 only supports --model current");
          }
          const workspace = new Workspace(resolveWorkspace(opts.workspace));
          const { captureCapabilitySnapshot } = await import("../web/dispatcher.js");
          const snapshot = await captureCapabilitySnapshot(workspace);
          if (snapshot.writeActive && !snapshot.bridgeStartedAt) {
            throw new WebError("BRIDGE_NOT_RUNNING", "Writable Scope requires a live Bridge");
          }
          if (snapshot.writeActive) {
            const observation = await findBridgeObservation(workspace.id);
            if (observation.state !== "healthy") {
              throw new WebError("BRIDGE_NOT_RUNNING", "Writable Scope requires a live Bridge");
            }
          }
          const { openChatSession } = await import("../web/session.js");
          const { runResearchTurn } = await import("../web/research-turn.js");
          const { session } = await openChatSession({ workspaceRoot: workspace.root });
          const ac = new AbortController();
          const onAbort = (): void => ac.abort();
          process.on("SIGINT", onAbort);
          process.on("SIGTERM", onAbort);
          try {
            const result = await runResearchTurn({
              workspace,
              task: opts.task,
              maxSteps: opts.maxSteps,
              session,
              signal: ac.signal,
            });
            if (opts.json) {
              say(JSON.stringify({ ok: result.status === "completed", ...result }));
              if (result.status !== "completed") process.exitCode = 1;
              return;
            }
            if (result.status === "completed") {
              check(`Research 完成（${result.steps} steps）`);
              if (result.summary) say(result.summary);
              if (result.changedFiles.length > 0) say(`Changed files：${result.changedFiles.join(", ")}`);
            } else {
              throw new WebError(
                (result.error?.code as never) ?? "WEB_PROTOCOL_INVALID",
                result.error?.message ?? "Research failed"
              );
            }
          } finally {
            process.off("SIGINT", onAbort);
            process.off("SIGTERM", onAbort);
            await session.close();
          }
        } catch (error) {
          handleCliError(error, opts.json);
        }
      }
    );

  acceptUnusedWorkspaceOption(
    web
      .command("stop")
      .description("Stop the Web Research Harness without touching Bridge or Tunnel")
      .option("--json", "machine-readable output", false)
  ).action(async (opts: { json: boolean }) => {
    try {
      const payload = await stopWebTask();
      if (opts.json) say(JSON.stringify(payload));
      else check("Web Research Harness 已停止");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

  acceptUnusedWorkspaceOption(
    web
      .command("logout")
      .description("Delete the dedicated ChatGPT Web browser profile")
      .option("--yes", "confirm profile deletion", false)
      .option("--json", "machine-readable output", false)
  ).action((opts: { yes: boolean; json: boolean }) => {
    try {
      if (!opts.yes) {
        throw new WebError("WEB_LOGOUT_REQUIRES_YES", "Pass --yes to delete the C2C Browser Profile");
      }
      if (activeWebTask()) throw new WebError("WEB_RESEARCH_BUSY", "Stop the research task before logout");
      if (observeWebTask().state === "unknown") {
        throw new WebError("WEB_STOP_PID_UNCERTAIN", "A recorded PID is live but unproven; refusing to delete the profile");
      }
      clearWebProfile();
      clearWebRuntime();
      if (opts.json) say(JSON.stringify({ ok: true, profileExists: false, profileDir: webProfileDir() }));
      else check("C2C Browser Profile 已删除");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

  acceptUnusedWorkspaceOption(
    web
      .command("smoke")
      .description("Live Temporary Chat smoke test; not used in CI")
      .option("--json", "machine-readable output", false)
  ).action(async (opts: { json: boolean }) => {
    try {
      const { openChatSession } = await import("../web/session.js");
      const { SMOKE_PROMPT, SMOKE_EXPECTED } = await import("../web/prompt.js");
      const { session } = await openChatSession({ login: false });
      try {
        await session.ensureReady();
        const text = await session.sendAndWait(SMOKE_PROMPT);
        const ok = text.trim() === SMOKE_EXPECTED;
        const payload = { ok, response: ok ? SMOKE_EXPECTED : "mismatch" };
        if (opts.json) {
          say(JSON.stringify(payload));
          if (!ok) process.exitCode = 1;
          return;
        }
        if (!ok) throw new WebError("WEB_PROTOCOL_INVALID", "Smoke response did not match C2C WEB READY");
        check("C2C WEB READY");
      } finally {
        await session.close();
      }
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });
}
