import { Command, InvalidArgumentError } from "commander";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startBridge } from "../bridge/server.js";
import { findBridgeObservation, findLiveBridge, type RuntimeState } from "../bridge/runtime.js";
import {
  adminFetch,
  ensureBridge,
  startTunnelAndVerify,
  stopBridge,
  verifyPublicConnection,
  verifyPublicConnectionOrStop,
} from "../process/daemon.js";
import { Workspace } from "../workspace/manager.js";
import { AuthStore } from "../auth/store.js";
import { detectTunnelBinaries } from "../tunnel/detect.js";
import {
  chooseQuickTunnel,
  hasCloudflaredCert,
  ProcessCloudflaredAccount,
  provisionNamedTunnel,
} from "../tunnel/named-provision.js";
import { parseZoneInput, suggestedNamedHostname } from "../tunnel/hostname.js";
import { inspectZoneDns } from "../tunnel/zone.js";
import {
  isNamedTunnelReady,
  NAMED_LOGIN_PROMPT,
  NAMED_REPAIR_MESSAGE,
  needsTunnelChoice,
  readTunnelState,
  TUNNEL_CHOICE_PROMPT,
} from "../tunnel/state.js";
import { Logger } from "../logger/index.js";
import { getStateDir } from "../config/paths.js";
import { ensureSandboxAllowlist, getCodexConfigPath, isStateDirAllowlisted } from "../config/sandbox-allow.js";
import {
  connectorAction,
  connectorNameFor,
  mcpUrlFromPublic,
  normalizePublicUrl,
  readLastEndpoint,
  reclaimUserMessage,
  writeLastEndpoint,
  type LastEndpoint,
} from "../config/endpoint.js";
import { PRODUCT_NAME, VERSION } from "../version.js";
import { appendExecutionRecord } from "../execution/records.js";
import { saveExecutionOutput } from "../execution/output.js";
import { generatePlanPrompt, generateReviewPrompt, type PromptProfile } from "../prompt/generate.js";
import {
  clearWriteScope,
  setWriteScope,
  writeScopeInfo,
  type WriteScopeMode,
} from "../write-scope/state.js";
import { registerWebCommands } from "./web.js";

const program = new Command();

const say = (msg: string): void => {
  process.stdout.write(msg + "\n");
};
const check = (msg: string): void => say(`✓ ${msg}`);
const cross = (msg: string): void => say(`✗ ${msg}`);

function resolveWorkspace(option?: string): string {
  return path.resolve(option ?? process.cwd());
}

function parseWriteScopeMode(value: string): WriteScopeMode {
  if (value !== "write" && value !== "poc") {
    throw new InvalidArgumentError("mode must be write or poc");
  }
  return value;
}

function resolveWritableRoot(workspace: Workspace, requested: string): string {
  if (
    path.isAbsolute(requested) ||
    /^[a-zA-Z]:[\\/]/.test(requested) ||
    requested.startsWith("\\\\")
  ) {
    throw new Error("WRITE_ROOT_MUST_BE_WORKSPACE_RELATIVE");
  }
  const normalized = requested.replace(/\\/g, "/");
  if (normalized.split("/").includes("..")) {
    throw new Error("WRITE_ROOT_MUST_BE_WORKSPACE_RELATIVE");
  }
  const resolved = workspace.resolve(normalized);
  const lexical = path.resolve(workspace.root, normalized);
  if (resolved.abs !== lexical) throw new Error("WRITE_ROOT_SYMLINK_NOT_ALLOWED");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved.abs);
  } catch {
    throw new Error("WRITE_ROOT_NOT_FOUND");
  }
  if (!stat.isDirectory()) throw new Error("WRITE_ROOT_NOT_DIRECTORY");
  return resolved.rel || ".";
}

function parsePromptProfile(value: string): PromptProfile {
  if (value !== "default" && value !== "defi") {
    throw new InvalidArgumentError("profile must be default or defi");
  }
  return value;
}

function isSolidityWorkspace(root: string): boolean {
  return [
    "foundry.toml",
    "hardhat.config.js",
    "hardhat.config.ts",
    "hardhat.config.cjs",
    "hardhat.config.mjs",
  ].some((file) => fs.existsSync(path.join(root, file))) ||
    fs.existsSync(path.join(root, "contracts"));
}

function parseInteger(value: string): number {
  const normalized = value.trim();
  if (!/^-?\d+$/.test(normalized)) {
    throw new InvalidArgumentError("must be an integer");
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) throw new InvalidArgumentError("must be a safe integer");
  return parsed;
}

function parseNonNegativeInteger(value: string): number {
  const parsed = parseInteger(value);
  if (parsed < 0) throw new InvalidArgumentError("must be a non-negative integer");
  return parsed;
}

function parseChangedFiles(value: string): string[] | number {
  const normalized = value.trim();
  if (/^-?\d+$/.test(normalized)) {
    const count = parseInteger(normalized);
    if (count < 0) {
      throw new InvalidArgumentError("changed-files count must be a non-negative safe integer");
    }
    return count;
  }
  return value.split(",").map((file) => file.trim()).filter(Boolean);
}

/** Local harness output only. Never pasted into ChatGPT. */
const MAX_RECORD_OUTPUT_READ = 256 * 1024;

function readCappedUtf8(filePath: string, maxBytes: number): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function persistWorkspaceEndpoint(opts: {
  workspaceId: string;
  workspaceName: string;
  port: number;
  publicUrl: string | null;
  mcpUrl: string;
  previous?: LastEndpoint | null;
}): string {
  const previous = opts.previous ?? readLastEndpoint(opts.workspaceId);
  const connectorName = connectorNameFor({
    workspaceName: opts.workspaceName,
    workspaceId: opts.workspaceId,
    previousName: previous?.connectorName,
    hadEndpointBefore: Boolean(previous),
  });
  writeLastEndpoint({
    workspaceId: opts.workspaceId,
    port: opts.port,
    publicUrl: opts.publicUrl,
    mcpUrl: opts.mcpUrl,
    connectorName,
  });
  return connectorName;
}

function tunnelChoicePayload(workspace: Workspace, zoneHint?: string): Record<string, unknown> {
  const state = readTunnelState(workspace.id);
  const zone = parseZoneInput(zoneHint ?? "") ?? state.zone ?? null;
  return {
    ok: true,
    needsChoice: needsTunnelChoice(state),
    preference: state.preference,
    loggedIn: hasCloudflaredCert(),
    namedReady: isNamedTunnelReady(state),
    zone,
    hostname: state.hostname ?? null,
    suggestedHostname: zone ? suggestedNamedHostname(zone, workspace.name, workspace.id) : null,
    userPrompt: needsTunnelChoice(state) ? TUNNEL_CHOICE_PROMPT : undefined,
    loginPrompt: NAMED_LOGIN_PROMPT,
    fallbackReason: state.fallbackReason,
  };
}

function trySandboxAllow():
  | { ok: true; added: boolean; alreadyAllowed: boolean; stateDir: string; configPath: string }
  | { ok: false; added: false; alreadyAllowed: false; error: string } {
  try {
    const result = ensureSandboxAllowlist();
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, added: false, alreadyAllowed: false, error: (error as Error).message };
  }
}

function inspectSandboxAllow(): {
  ok: boolean;
  added: false;
  alreadyAllowed: boolean;
  consentRequired: boolean;
  stateDir: string;
  configPath: string;
  error?: string;
} {
  const stateDir = getStateDir();
  const configPath = getCodexConfigPath();
  try {
    const alreadyAllowed =
      fs.existsSync(configPath) && isStateDirAllowlisted(fs.readFileSync(configPath, "utf8"), stateDir);
    return { ok: alreadyAllowed, added: false, alreadyAllowed, consentRequired: !alreadyAllowed, stateDir, configPath };
  } catch (error) {
    return {
      ok: false,
      added: false,
      alreadyAllowed: false,
      consentRequired: true,
      stateDir,
      configPath,
      error: (error as Error).message,
    };
  }
}

interface PairingResponse {
  code: string;
  expiresAt: number;
}

interface AdminInfo {
  workspaceId: string;
  workspaceName: string;
  workspaceRoot: string;
  port: number;
  publicUrl: string | null;
  tunnel: { running: boolean; url: string | null; provider: string };
  tokenCount: number;
  pairingActive: boolean;
  pid: number;
  startedAt: string;
  writeScope?: { active: boolean; root?: string; mode?: WriteScopeMode };
}

async function ensureBridgeAndTunnel(
  workspaceRoot: string,
  opts: { tunnel: boolean }
): Promise<{
  runtime: RuntimeState;
  info: AdminInfo;
  mcpUrl: string | null;
  publicVerification: "direct" | "system-proxy" | null;
}> {
  const workspace = new Workspace(workspaceRoot);
  if (opts.tunnel && readTunnelState(workspace.id).preference === "unset") {
    throw new Error("TUNNEL_CHOICE_REQUIRED");
  }
  const { runtime } = await ensureBridge(workspaceRoot);
  let info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
  let mcpUrl: string | null = info.publicUrl ? `${info.publicUrl}/mcp` : null;
  let publicVerification: "direct" | "system-proxy" | null = null;
  if (opts.tunnel && (!info.publicUrl || !info.tunnel.running)) {
    const binaries = detectTunnelBinaries();
    if (!binaries.cloudflared) {
      throw new Error(
        "NEED_CLOUDFLARED: cloudflared is not installed. Install it first (macOS: brew install cloudflared)."
      );
    }
    const started = await startTunnelAndVerify(runtime, info.workspaceId);
    publicVerification = started.transport;
    info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
    mcpUrl = `${started.url}/mcp`;
  }
  if (opts.tunnel) {
    const publicUrl = info.publicUrl ?? info.tunnel.url;
    if (!publicUrl) throw new Error("Tunnel did not publish a URL");
    if (!publicVerification) {
      publicVerification = await verifyPublicConnectionOrStop(runtime, publicUrl, info.workspaceId);
    }
    mcpUrl = `${publicUrl}/mcp`;
  }
  return { runtime, info, mcpUrl, publicVerification };
}

program
  .name("c2c")
  .description(`${PRODUCT_NAME} — ChatGPT thinks. Codex works.`)
  .version(VERSION, "-v, --version")
  .configureHelp({ sortSubcommands: true });

/** Machine-wide commands ignore `-w` so a Skill that always passes it cannot crash them. */
function acceptUnusedWorkspaceOption(command: Command): Command {
  return command.option("-w, --workspace <path>", "ignored; this command is machine-wide");
}

// ---------------------------------------------------------------- serve (internal)

program
  .command("serve", { hidden: true })
  .description("Run the bridge in the foreground (internal)")
  .requiredOption("--workspace <path>")
  .option("--port <port>", "preferred port")
  .action(async (opts: { workspace: string; port?: string }) => {
    const logger = new Logger({ name: "bridge", console: true });
    const bridge = await startBridge({
      workspaceRoot: resolveWorkspace(opts.workspace),
      port: opts.port ? parseInt(opts.port, 10) : undefined,
      logger,
    });
    const shutdown = (): void => {
      void bridge.close().then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    say(`bridge ready on ${bridge.localBaseUrl()} (workspace ${bridge.workspace.name})`);
  });

// ---------------------------------------------------------------- start

program
  .command("start")
  .description("Start (or reuse) the bridge for this workspace")
  .option("-w, --workspace <path>", "workspace root (defaults to current directory)")
  .option("--tunnel", "also establish the secure public connection", false)
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; tunnel: boolean; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      const { runtime, info, mcpUrl, publicVerification } = await ensureBridgeAndTunnel(root, {
        tunnel: opts.tunnel,
      });
      const connectorName = mcpUrl
        ? persistWorkspaceEndpoint({
            workspaceId: info.workspaceId,
            workspaceName: info.workspaceName,
            port: runtime.port,
            publicUrl: info.publicUrl,
            mcpUrl,
          })
        : readLastEndpoint(info.workspaceId)?.connectorName;
      if (opts.json) {
        say(
          JSON.stringify({
            ok: true,
            port: runtime.port,
            workspaceId: info.workspaceId,
            mcpUrl,
            connectorName,
            publicVerification,
          })
        );
        return;
      }
      if (publicVerification) say(`public verification: ${publicVerification}`);
      check(`当前项目已识别（${info.workspaceName}）`);
      check("Workspace Bridge：healthy");
      if (mcpUrl) {
        check(`Tunnel：healthy（${info.tunnel.provider}）`);
        check("Read-only MCP：ready");
        say(`MCP 地址：${mcpUrl}`);
      }
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

// ---------------------------------------------------------------- setup

program
  .command("setup")
  .description("Prepare the read-only MCP connector for manual ChatGPT setup")
  .option("-w, --workspace <path>")
  .option("--no-tunnel", "local-only setup (development)")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; tunnel: boolean; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      if (!opts.json) {
        say(PRODUCT_NAME);
        say("");
        say("正在准备 Read-only MCP…");
        say("");
      }
      const sandbox = inspectSandboxAllow();
      const { runtime, info, mcpUrl } = await ensureBridgeAndTunnel(root, { tunnel: opts.tunnel });
      const connectorName = mcpUrl
        ? persistWorkspaceEndpoint({
            workspaceId: info.workspaceId,
            workspaceName: info.workspaceName,
            port: runtime.port,
            publicUrl: info.publicUrl,
            mcpUrl,
          })
        : connectorNameFor({
            workspaceName: info.workspaceName,
            workspaceId: info.workspaceId,
            previousName: readLastEndpoint(info.workspaceId)?.connectorName,
            hadEndpointBefore: Boolean(readLastEndpoint(info.workspaceId)),
          });
      const tunnelState = readTunnelState(info.workspaceId);
      if (opts.json) {
        say(
          JSON.stringify({
            ok: true,
            workspaceId: info.workspaceId,
            workspaceName: info.workspaceName,
            connectorName,
            mcpUrl: mcpUrl ?? `http://127.0.0.1:${runtime.port}/mcp`,
            local: mcpUrl === null,
            sandbox,
            manualSetup: true,
            authentication: "OAuth",
            tunnel: {
              mode: isNamedTunnelReady(tunnelState) ? "named" : "quick",
              hostname: tunnelState.hostname ?? null,
              fallback: Boolean(tunnelState.fallbackReason),
            },
          })
        );
        return;
      }
      check(`当前项目已识别（${info.workspaceName}）`);
      check("Workspace Bridge 已启动");
      if (mcpUrl) check("安全连接已建立");
      check("Read-only MCP 已就绪");
      say("");
      say("接下来请在 ChatGPT 中手动创建自定义 Connector：");
      say("");
      say(`名称：\n${connectorName}`);
      say("");
      say(`Server URL：\n${mcpUrl ?? `http://127.0.0.1:${runtime.port}/mcp`}`);
      say("");
      say("Authentication：\nOAuth");
      say("");
      say("如尚未开启 Developer Mode，请在 ChatGPT 设置中手动开启。");
      say("Connector 进入授权页后，再在本机运行：");
      say(`c2c pair -w ${JSON.stringify(root)}`);
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

// ---------------------------------------------------------------- write-scope

const writeScopeCommand = program
  .command("write-scope")
  .description("Manage the local, session-bound writable root");

writeScopeCommand
  .command("status")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const observation = await findBridgeObservation(workspace.id);
    const info =
      observation.state === "healthy"
        ? writeScopeInfo(workspace.id, observation.runtime.startedAt)
        : { active: false as const };
    if (opts.json) {
      say(JSON.stringify({ ok: true, workspace: { id: workspace.id, name: workspace.name }, ...info }));
      return;
    }
    say(`Workspace：${workspace.name}`);
    say(info.active ? `Writable Root：${info.root}\nMode：${info.mode}` : "Writable Scope：inactive");
  });

writeScopeCommand
  .command("set")
  .requiredOption("--root <relative-directory>", "Workspace-relative writable directory")
  .requiredOption("--mode <mode>", "write or poc", parseWriteScopeMode)
  .option("-w, --workspace <path>")
  .option("--allow-workspace-root", "explicitly allow root='.'", false)
  .option("--yes", "confirm source-directory or workspace-root access", false)
  .option("--json", "machine-readable output", false)
  .action(
    async (opts: {
      root: string;
      mode: WriteScopeMode;
      workspace?: string;
      allowWorkspaceRoot: boolean;
      yes: boolean;
      json: boolean;
    }) => {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const root = resolveWritableRoot(workspace, opts.root);
      if (root === "." && !opts.allowWorkspaceRoot) {
        throw new Error("WORKSPACE_ROOT_REQUIRES_ALLOW_WORKSPACE_ROOT");
      }
      const sourceLike = root === "." || /^(?:src|contracts|packages|apps)(?:\/|$)/i.test(root);
      if (sourceLike && !opts.yes) {
        throw new Error(
          root === "."
            ? "WORKSPACE_ROOT_REQUIRES_CONFIRMATION"
            : "SOURCE_WRITE_ROOT_REQUIRES_CONFIRMATION"
        );
      }
      const observation = await findBridgeObservation(workspace.id);
      if (observation.state !== "healthy") throw new Error("WRITE_SCOPE_BRIDGE_NOT_RUNNING");
      const state = setWriteScope({
        workspaceId: workspace.id,
        root,
        mode: opts.mode,
        bridgeStartedAt: observation.runtime.startedAt,
      });
      const result = {
        ok: true,
        workspace: { id: workspace.id, name: workspace.name },
        active: true,
        root: state.root,
        mode: state.mode,
      };
      if (opts.json) {
        say(JSON.stringify(result));
        return;
      }
      check(`Workspace：${workspace.name}`);
      check(`Writable Root：${state.root}`);
      check(`Mode：${state.mode}`);
    }
  );

writeScopeCommand
  .command("clear")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    clearWriteScope(workspace.id);
    if (opts.json) {
      say(JSON.stringify({ ok: true, workspace: { id: workspace.id, name: workspace.name }, active: false }));
      return;
    }
    check(`已关闭 ${workspace.name} 的 Writable Scope`);
  });

// ---------------------------------------------------------------- stop / restart

program
  .command("stop")
  .description("Stop the bridge for this workspace")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    let stopped = false;
    try {
      stopped = await stopBridge(workspace.root);
    } finally {
      clearWriteScope(workspace.id);
    }
    if (opts.json) {
      say(JSON.stringify({ ok: true, workspace: { id: workspace.id, name: workspace.name }, stopped }));
      return;
    }
    if (stopped) {
      check("当前项目 Tunnel 已停止");
      check("当前项目 Bridge 已停止");
      say("ChatGPT 暂时无法读取本地 Workspace。");
    } else {
      say("当前项目 Bridge 与 Tunnel 均未运行。");
    }
  });

program
  .command("restart")
  .description("Restart the bridge for this workspace")
  .option("-w, --workspace <path>")
  .option("--tunnel", "re-establish the secure public connection", false)
  .action(async (opts: { workspace?: string; tunnel: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    await stopBridge(root);
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      const { info, mcpUrl } = await ensureBridgeAndTunnel(root, { tunnel: opts.tunnel });
      check(`Bridge 已重启（${info.workspaceName}）`);
      if (mcpUrl) check(`安全连接已建立`);
    } catch (error) {
      handleCliError(error, false);
    }
  });

// ---------------------------------------------------------------- status

program
  .command("status")
  .description("Show bridge status for this workspace")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    const workspace = new Workspace(root);
    const configuredTunnel = readTunnelState(workspace.id);
    const observation = await findBridgeObservation(workspace.id);
    if (observation.state === "unknown") {
      if (opts.json) {
        say(JSON.stringify({
          ok: false,
          state: "unknown",
          workspace: { id: workspace.id, name: workspace.name },
          bridge: { healthy: null, pid: observation.runtime?.pid ?? null, port: observation.runtime?.port ?? null },
          tunnel: {
            running: null,
            verified: false,
            provider: configuredTunnel.provider ?? null,
            hostname: configuredTunnel.hostname ?? null,
          },
          mcpUrl: null,
          writeScope: { active: false },
          reason: observation.reason,
        }));
      } else {
        say(`Workspace：${workspace.name}`);
        cross(`Bridge 状态无法确认（${observation.reason}），未将其视为未运行。`);
      }
      return;
    }
    if (observation.state === "stopped") {
      if (opts.json) {
        say(JSON.stringify({
          ok: false,
          state: "stopped",
          workspace: { id: workspace.id, name: workspace.name },
          bridge: { healthy: false, pid: null, port: null },
          tunnel: {
            running: false,
            verified: false,
            provider: configuredTunnel.provider ?? null,
            hostname: configuredTunnel.hostname ?? null,
          },
          mcpUrl: null,
          writeScope: { active: false },
        }));
      } else {
        say(`Workspace：${workspace.name}`);
        say("Bridge：已停止");
        say(`Tunnel：已停止${configuredTunnel.hostname ? `（${configuredTunnel.hostname}）` : ""}`);
        say("MCP URL：未运行");
        say("PID：无");
      }
      return;
    }
    const runtime = observation.runtime;
    const info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
    if (opts.json) {
      say(JSON.stringify({
        ok: true,
        state: "healthy",
        workspace: { id: info.workspaceId, name: info.workspaceName },
        bridge: { healthy: true, pid: info.pid, port: info.port },
        tunnel: { ...info.tunnel, verified: false },
        mcpUrl: info.tunnel.running && info.tunnel.url ? `${info.tunnel.url}/mcp` : null,
        writeScope: info.writeScope ?? { active: false },
      }));
      return;
    }
    say(PRODUCT_NAME);
    say("");
    check(`Workspace：${info.workspaceName}`);
    check(`Bridge：healthy（端口 ${info.port}）`);
    say(`PID：${info.pid}`);
    if (info.tunnel.running && info.tunnel.url) {
      check(`Tunnel：running（${info.tunnel.provider}）`);
      say("MCP public verification：not checked");
      say(`MCP URL：${info.tunnel.url}/mcp`);
    } else {
      say("Tunnel：已停止");
      say("MCP URL：未运行");
    }
  });

// ---------------------------------------------------------------- doctor

program
  .command("doctor")
  .description("Diagnose and auto-repair the connection")
  .option("-w, --workspace <path>")
  .option("--no-fix", "diagnose only, do not repair")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; fix: boolean; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    const report: Record<string, { ok: boolean; detail?: string }> = {};
    const results: string[] = [];

    // Node
    const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
    report.node = { ok: nodeMajor >= 20, detail: `v${process.versions.node}` };

    // Diagnose only. Global Codex configuration is changed solely by an
    // explicit `sandbox-allow --yes` command after user consent.
    const sandbox = inspectSandboxAllow();
    report.sandbox = sandbox.alreadyAllowed
      ? { ok: true, detail: "已在白名单" }
      : { ok: false, detail: "未在白名单；需要用户明确授权后运行 sandbox-allow --yes" };

    // Workspace
    let workspace: Workspace | null = null;
    try {
      workspace = new Workspace(root);
      report.workspace = { ok: true, detail: workspace.name };
    } catch (error) {
      report.workspace = { ok: false, detail: (error as Error).message };
    }

    // Bridge
    let runtime: RuntimeState | null = null;
    let bridgeUnknown = false;
    if (workspace) {
      const observation = await findBridgeObservation(workspace.id);
      if (observation.state === "healthy") {
        runtime = observation.runtime;
      } else if (observation.state === "unknown") {
        bridgeUnknown = true;
        report.bridge = { ok: false, detail: `状态无法确认（${observation.reason}），未自动修复` };
      } else if (opts.fix) {
        try {
          runtime = (await ensureBridge(root)).runtime;
          results.push("已自动启动 Bridge");
        } catch (error) {
          report.bridge = { ok: false, detail: (error as Error).message };
        }
      }
      if (runtime) report.bridge = { ok: true, detail: `端口 ${runtime.port}` };
      else report.bridge = report.bridge ?? { ok: false, detail: "未运行" };
    }

    // MCP local reachability (401 without token means MCP + auth both work)
    if (runtime) {
      try {
        const response = await fetch(`http://127.0.0.1:${runtime.port}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
        });
        report.mcp = { ok: response.status === 401, detail: `未授权请求返回 ${response.status}` };
        report.oauth = { ok: response.status === 401 };
      } catch (error) {
        report.mcp = { ok: false, detail: (error as Error).message };
      }
    }

    // Tunnel + remote reachability. If this workspace once had a public URL,
    // a full quit reclaims it — restore a tunnel and tell the user to update
    // the Connector manually (never treat that as "local mode").
    const lastEndpoint = workspace ? readLastEndpoint(workspace.id) : null;
    const connectorName = workspace
      ? connectorNameFor({
          workspaceName: workspace.name,
          workspaceId: workspace.id,
          previousName: lastEndpoint?.connectorName,
          hadEndpointBefore: Boolean(lastEndpoint),
        })
      : "Codex with ChatGPT";
    const tunnelState = workspace ? readTunnelState(workspace.id) : null;
    const namedReady = tunnelState ? isNamedTunnelReady(tunnelState) : false;
    let namedRepair: { needed: boolean; userMessage?: string } = { needed: false };
    let chatgptRepair: {
      needed: boolean;
      reason?: string;
      connectorAction: "none" | "create" | "update";
      connectorName: string;
      userMessage?: string;
      mcpUrl: string | null;
      previousMcpUrl: string | null;
    } = {
      needed: false,
      connectorAction: "none",
      connectorName,
      mcpUrl: lastEndpoint?.mcpUrl ?? null,
      previousMcpUrl: lastEndpoint?.mcpUrl ?? null,
    };

    if (runtime) {
      let info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
      if (namedReady && opts.fix && info.tunnel.provider !== "cloudflare-named") {
        await stopBridge(root);
        await new Promise((resolve) => setTimeout(resolve, 400));
        try {
          runtime = (await ensureBridge(root)).runtime;
          info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
          results.push("已切换到固定域名连接");
        } catch (error) {
          report.tunnel = { ok: false, detail: (error as Error).message };
        }
      }
      const expectedPublic = Boolean(lastEndpoint?.publicUrl) || namedReady;
      let currentUrl = info.publicUrl ?? info.tunnel.url;
      let healthy = false;
      if (currentUrl) {
        try {
          if (opts.fix) {
            await verifyPublicConnectionOrStop(runtime, currentUrl, info.workspaceId);
          } else {
            await verifyPublicConnection(currentUrl, info.workspaceId);
          }
          healthy = true;
        } catch (error) {
          healthy = false;
          report.tunnel = { ok: false, detail: (error as Error).message };
        }
      }

      if ((!currentUrl || !healthy) && opts.fix && (expectedPublic || info.tunnel.running)) {
        try {
          const binaries = detectTunnelBinaries();
          if (!binaries.cloudflared) {
            report.tunnel = { ok: false, detail: "NEED_CLOUDFLARED" };
          } else {
            const previousUrl = lastEndpoint?.publicUrl;
            const verifiedTunnel = await startTunnelAndVerify(runtime, info.workspaceId);
            currentUrl = verifiedTunnel.url;
            healthy = true;
            info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
            const sameAddress =
              previousUrl && normalizePublicUrl(previousUrl) === normalizePublicUrl(verifiedTunnel.url);
            results.push(sameAddress ? "已重新建立安全连接" : "已重新建立安全连接（地址已更换）");
          }
        } catch (error) {
          report.tunnel = { ok: false, detail: (error as Error).message };
        }
      }

      if (currentUrl && healthy) {
        report.tunnel = { ok: true, detail: currentUrl };
        const nextMcp = mcpUrlFromPublic(currentUrl);
        const action = connectorAction(lastEndpoint?.mcpUrl, nextMcp);
        const boundName = nextMcp
          ? persistWorkspaceEndpoint({
              workspaceId: info.workspaceId,
              workspaceName: info.workspaceName,
              port: runtime.port,
              publicUrl: currentUrl,
              mcpUrl: nextMcp,
              previous: lastEndpoint,
            })
          : connectorName;
        chatgptRepair = {
          ...chatgptRepair,
          needed: action === "update",
          reason: action === "update" ? "address_reclaimed" : undefined,
          connectorAction: action,
          connectorName: boundName,
          userMessage: action === "update" ? reclaimUserMessage(boundName) : undefined,
          mcpUrl: nextMcp,
          previousMcpUrl: lastEndpoint?.mcpUrl ?? null,
        };
        if (action === "update") {
          results.push(`安全连接地址已更换，需要更新「${boundName}」`);
        }
      } else if (namedReady) {
        report.tunnel = report.tunnel ?? { ok: false, detail: "NAMED_TUNNEL_DOWN" };
        namedRepair = { needed: true, userMessage: NAMED_REPAIR_MESSAGE };
      } else if (expectedPublic) {
        report.tunnel = report.tunnel ?? { ok: false, detail: "安全连接未恢复" };
        chatgptRepair = {
          ...chatgptRepair,
          needed: true,
          reason: "address_reclaimed",
          connectorAction: "update",
          connectorName,
          userMessage: reclaimUserMessage(connectorName),
          mcpUrl: null,
        };
      } else if (!currentUrl) {
        report.tunnel = { ok: true, detail: "未启用（本地模式）" };
      } else {
        report.tunnel = { ok: false, detail: "公网地址无法访问" };
      }
    } else if (bridgeUnknown) {
      report.tunnel = report.tunnel ?? { ok: false, detail: "Bridge 状态无法确认，未执行连接器修复" };
    } else if (namedReady) {
      report.tunnel = { ok: false, detail: "NAMED_TUNNEL_DOWN" };
      namedRepair = { needed: true, userMessage: NAMED_REPAIR_MESSAGE };
    } else if (lastEndpoint?.publicUrl) {
      report.tunnel = { ok: false, detail: "安全连接未运行" };
      chatgptRepair = {
        ...chatgptRepair,
        needed: true,
        reason: "address_reclaimed",
        connectorAction: "update",
        connectorName,
        userMessage: reclaimUserMessage(connectorName),
      };
    }

    if (opts.json) {
      say(JSON.stringify({ report, repairs: results, chatgptRepair, namedRepair }));
      if (Object.values(report).some((item) => !item.ok) || namedRepair.needed) process.exitCode = 1;
      return;
    }
    say(`${PRODUCT_NAME} Doctor`);
    say("");
    const labels: Record<string, string> = {
      node: "Node.js",
      sandbox: "Sandbox",
      workspace: "Workspace",
      bridge: "Bridge",
      mcp: "MCP",
      oauth: "OAuth",
      tunnel: "Tunnel",
    };
    let allOk = true;
    for (const [key, value] of Object.entries(report)) {
      const label = labels[key] ?? key;
      if (value.ok) check(`${label}${value.detail ? `（${value.detail}）` : ""}`);
      else {
        cross(`${label}${value.detail ? `：${value.detail}` : ""}`);
        allOk = false;
      }
    }
    for (const repair of results) say(`· ${repair}`);
    say("");
    if (namedRepair.needed && namedRepair.userMessage) {
      say(namedRepair.userMessage);
      say("");
    }
    if (chatgptRepair.needed && chatgptRepair.userMessage) {
      say(chatgptRepair.userMessage);
      if (chatgptRepair.mcpUrl) say(`新的连接地址：${chatgptRepair.mcpUrl}`);
      say("");
    }
    say(
      allOk && !chatgptRepair.needed && !namedRepair.needed
        ? "Everything looks good."
        : chatgptRepair.needed
          ? "本地已就绪，请在 ChatGPT 中手动更新该 Connector；进入授权页后运行 c2c pair。"
          : namedRepair.needed
            ? "固定域名还没连上，需要先登录 Cloudflare。"
            : "仍有问题未解决，可尝试 `c2c restart --tunnel`。"
    );
    if (!allOk || namedRepair.needed) process.exitCode = 1;
  });

// ---------------------------------------------------------------- pair / unpair

program
  .command("pair")
  .description("Generate a fresh pairing code")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; json: boolean }) => {
    try {
      const { runtime } = await ensureBridge(resolveWorkspace(opts.workspace));
      const pairing = await adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing");
      if (opts.json) say(JSON.stringify({ ok: true, pairingCode: pairing.code, expiresAt: pairing.expiresAt }));
      else {
        say(`配对码：${pairing.code}`);
        say(`（${Math.round((pairing.expiresAt - Date.now()) / 60000)} 分钟内有效，仅可使用一次）`);
      }
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

program
  .command("unpair")
  .description("Revoke ChatGPT's access to this workspace immediately")
  .option("-w, --workspace <path>")
  .action(async (opts: { workspace?: string }) => {
    const root = resolveWorkspace(opts.workspace);
    const workspace = new Workspace(root);
    const runtime = await findLiveBridge(workspace.id);
    if (runtime) {
      await adminFetch(runtime, "POST", "/admin/revoke-all");
    } else {
      // bridge not running: revoke directly in the persisted store
      new AuthStore(workspace.id).revokeAll();
    }
    check("已断开 ChatGPT 对当前项目的访问（所有令牌已吊销）");
  });

// ---------------------------------------------------------------- logs / workspace / record

program
  .command("logs")
  .description("Show recent bridge logs")
  .option("-w, --workspace <path>")
  .option("-n, --lines <n>", "number of lines", "50")
  .option("--verbose", "include debug detail", false)
  .action((opts: { workspace?: string; lines: string; verbose: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const candidates = [
      path.join(getStateDir(), "logs", "bridge.log"),
      path.join(getStateDir(), "logs", `bridge-${workspace.id}.out.log`),
    ];
    let shown = false;
    for (const file of candidates) {
      if (!fs.existsSync(file)) continue;
      const lines = fs.readFileSync(file, "utf8").trim().split("\n");
      const filtered = opts.verbose ? lines : lines.filter((line) => !line.includes(" DEBUG "));
      say(filtered.slice(-parseInt(opts.lines, 10)).join("\n"));
      shown = true;
    }
    if (!shown) say("暂无日志。");
  });

program
  .command("workspace")
  .description("Show workspace identity and project info")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const project = workspace.detectProject();
    const data = { workspaceId: workspace.id, name: workspace.name, root: workspace.root, ...project };
    if (opts.json) say(JSON.stringify(data));
    else {
      say(`Workspace：${data.name}（${data.workspaceId}）`);
      say(`类型：${data.projectType}  语言：${data.languages.join(", ") || "-"}`);
      say(`路径：${data.root}`);
    }
  });

// ---------------------------------------------------------------- manual prompt generation

const promptCmd = program
  .command("prompt")
  .description("Generate text for the user to copy into ChatGPT; never sends it");

function promptContext(workspaceOption?: string): {
  workspace: Workspace;
  connectorName: string;
} {
  const workspace = new Workspace(resolveWorkspace(workspaceOption));
  const endpoint = readLastEndpoint(workspace.id);
  return {
    workspace,
    connectorName: connectorNameFor({
      workspaceName: workspace.name,
      workspaceId: workspace.id,
      previousName: endpoint?.connectorName,
      hadEndpointBefore: Boolean(endpoint),
    }),
  };
}

promptCmd
  .command("plan")
  .description("Generate a manual ChatGPT planning prompt")
  .option("-w, --workspace <path>")
  .option("--task <text>", "task for ChatGPT to plan")
  .action((opts: { workspace?: string; task?: string }) => {
    const { workspace, connectorName } = promptContext(opts.workspace);
    say("请复制以下内容发送到 ChatGPT：");
    say("");
    say(generatePlanPrompt({ workspaceName: workspace.name, connectorName, task: opts.task }));
  });

promptCmd
  .command("review")
  .description("Generate a manual independent-review prompt")
  .option("-w, --workspace <path>")
  .option("--profile <profile>", "default or defi (auto-detects Solidity when omitted)", parsePromptProfile)
  .action((opts: { workspace?: string; profile?: PromptProfile }) => {
    const { workspace, connectorName } = promptContext(opts.workspace);
    const profile = opts.profile ?? (isSolidityWorkspace(workspace.root) ? "defi" : "default");
    say("请复制以下内容发送到 ChatGPT：");
    say("");
    say(generateReviewPrompt({ workspaceName: workspace.name, connectorName, profile }));
  });

// ---------------------------------------------------------------- sandbox-allow (Codex writable_roots, macOS + Windows)

acceptUnusedWorkspaceOption(
  program
    .command("sandbox-allow")
    .description("Add the local settings directory to the Codex sandbox allowlist")
    .option("--yes", "confirm the disclosed config.toml change", false)
    .option("--json", "machine-readable output", false)
)
  .action((opts: { yes: boolean; json: boolean }) => {
    if (!opts.yes) {
      const result = inspectSandboxAllow();
      if (opts.json) {
        say(JSON.stringify(result));
      } else if (result.alreadyAllowed) {
        check("沙箱白名单已就绪");
      } else {
        say(`需要明确授权。将仅向 ${result.configPath} 增加：${result.stateDir}`);
        say("确认后运行：c2c sandbox-allow --yes");
      }
      return;
    }
    const result = trySandboxAllow();
    if (opts.json) {
      say(JSON.stringify(result));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (!result.ok) {
      cross(`无法写入 Codex 沙箱白名单：${result.error}`);
      process.exitCode = 1;
      return;
    }
    if (result.alreadyAllowed) check("沙箱白名单已就绪，后续对话无需再提权");
    else check("已将本地设置目录加入 Codex 沙箱白名单（后续对话无需再提权）");
  });

// ---------------------------------------------------------------- update-check (once per local day)

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function runGit(args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 8000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    windowsHide: true,
  });
  return { ok: result.status === 0, stdout: (result.stdout ?? "").trim() };
}

acceptUnusedWorkspaceOption(
  program
    .command("update-check")
    .description("Check GitHub for a newer version (real check at most once per local day)")
    .option("--force", "check even if already checked today", false)
    .option("--json", "machine-readable output", false)
)
  .action((opts: { force: boolean; json: boolean }) => {
    const file = path.join(getStateDir(), "update-check.json");
    const today = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD in local tz
    let last: { date?: string; updateAvailable?: boolean } = {};
    try {
      last = JSON.parse(fs.readFileSync(file, "utf8")) as typeof last;
    } catch {
      /* first run */
    }

    const emit = (data: {
      checked: boolean;
      updateAvailable: boolean;
      localCommit?: string;
      remoteCommit?: string;
      note?: string;
    }): void => {
      if (opts.json) say(JSON.stringify({ ok: true, version: VERSION, ...data }));
      else if (data.updateAvailable) say(`发现新版本（本地 ${data.localCommit?.slice(0, 7)} → 远端 ${data.remoteCommit?.slice(0, 7)}）。`);
      else say(data.note ?? "已是最新版本。");
    };

    if (!opts.force && last.date === today) {
      emit({ checked: false, updateAvailable: last.updateAvailable ?? false, note: "今天已检查过更新。" });
      return;
    }

    const local = runGit(["rev-parse", "HEAD"]);
    const remote = runGit(["ls-remote", "origin", "HEAD"]);
    if (!local.ok || !remote.ok || !remote.stdout) {
      // Offline or not a git checkout: skip quietly and retry tomorrow-ish (do not
      // record the date so a transient failure does not suppress the daily check).
      emit({ checked: false, updateAvailable: false, note: "无法检查更新（离线或非 git 安装），已跳过。" });
      return;
    }
    const remoteCommit = remote.stdout.split(/\s/)[0];
    const updateAvailable = remoteCommit !== local.stdout;
    fs.mkdirSync(getStateDir(), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ date: today, updateAvailable, remoteCommit }), { mode: 0o600 });
    emit({ checked: true, updateAvailable, localCommit: local.stdout, remoteCommit });
  });

program
  .command("record", { hidden: true })
  .description("Record a Codex execution summary (used by the Skill)")
  .option("-w, --workspace <path>")
  .requiredOption("--task <id>")
  .requiredOption("--iteration <n>", "non-negative execution iteration", parseNonNegativeInteger)
  .option("--changed-files <filesOrCount>", "comma-separated files or a count", "0")
  .option("--tests <summary>", "e.g. '27 passed'")
  .option("--exit-status <status>", "ok | failed | blocked", "ok")
  .option("--notes <text>")
  .option("--command <text>", "command whose output may be offered to ChatGPT")
  .option("--output <text>", "command output (prefer --output-file for long logs)")
  .option("--output-file <path>", "read command output from a local file")
  .option("--exit-code <n>", "numeric exit code of that command", parseInteger)
  .action(
    (opts: {
      workspace?: string;
      task: string;
      iteration: number;
      changedFiles: string;
      tests?: string;
      exitStatus: string;
      notes?: string;
      command?: string;
      output?: string;
      outputFile?: string;
      exitCode?: number;
    }) => {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const changed = parseChangedFiles(opts.changedFiles);
      let outputId: number | undefined;
      let outputAvailable = false;
      const rawOutput =
        opts.outputFile !== undefined
          ? readCappedUtf8(workspace.resolve(opts.outputFile).abs, MAX_RECORD_OUTPUT_READ)
          : opts.output;
      if (opts.command && rawOutput !== undefined) {
        const savedOutput = saveExecutionOutput(workspace.id, {
          command: opts.command,
          raw: rawOutput,
          exitCode: opts.exitCode ?? null,
          taskId: opts.task,
          iteration: opts.iteration,
        });
        outputId = savedOutput.id;
        outputAvailable = savedOutput.allowed;
      }
      appendExecutionRecord(workspace.id, {
        taskId: opts.task,
        iteration: opts.iteration,
        changedFiles: changed,
        tests: opts.tests ?? null,
        exitStatus: opts.exitStatus,
        timestamp: new Date().toISOString(),
        notes: opts.notes?.slice(0, 400),
        outputId,
        outputAvailable,
      });
      if (outputId !== undefined && !outputAvailable) check("已记录执行摘要（输出未对 ChatGPT 开放）");
      else if (outputId !== undefined) check("已记录执行摘要与输出");
      else check("已记录执行摘要");
    }
  );

const tunnelCmd = program.command("tunnel").description("Choose or inspect the public connection for this workspace");

tunnelCmd
  .command("status", { isDefault: true })
  .description("Show whether this workspace still needs a one-time connection choice")
  .option("-w, --workspace <path>")
  .option("--zone <domain>", "optional domain, used to preview the stable hostname")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; zone?: string; json: boolean }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const payload = tunnelChoicePayload(workspace, opts.zone);
      if (opts.json) {
        say(JSON.stringify(payload));
        return;
      }
      if (payload.needsChoice) say(TUNNEL_CHOICE_PROMPT);
      else if (payload.namedReady) check(`固定域名：${payload.hostname}`);
      else say("当前使用临时地址。");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

tunnelCmd
  .command("inspect-zone")
  .description("Check Cloudflare nameserver delegation and existing DNS record types")
  .requiredOption("--zone <domain>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { zone: string; json: boolean }) => {
    try {
      const zone = parseZoneInput(opts.zone);
      if (!zone) throw new Error("invalid root domain");
      const inspection = await inspectZoneDns(zone);
      if (opts.json) {
        say(JSON.stringify({ ok: true, ...inspection }));
        return;
      }
      say(`Zone：${inspection.zone}`);
      say(`Nameservers：${inspection.nameservers.join(", ") || "未解析到"}`);
      say(`Cloudflare Nameserver Delegated：${inspection.cloudflareDelegated ? "是" : "否"}`);
      say(`Existing records：${inspection.existingRecordTypes.join(", ") || "未检测到"}`);
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

tunnelCmd
  .command("choose")
  .description("Remember quick vs named, and provision a named hostname when asked")
  .requiredOption("--mode <mode>", "quick or named")
  .option("-w, --workspace <path>")
  .option("--zone <domain>", "Cloudflare domain for a named hostname")
  .option("--hostname <hostname>", "override the default c2c-<project>.<zone>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { mode: string; workspace?: string; zone?: string; hostname?: string; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      const workspace = new Workspace(root);
      const mode = opts.mode.trim().toLowerCase();
      const previous = readTunnelState(workspace.id);
      if (mode === "quick") {
        const state = chooseQuickTunnel(workspace.id);
        if (await findLiveBridge(workspace.id)) {
          if (previous.preference === "named") await stopBridge(root);
        }
        const payload = { ...tunnelChoicePayload(workspace), state };
        if (opts.json) say(JSON.stringify(payload));
        else check("已选用临时地址");
        return;
      }
      if (mode !== "named") {
        throw new Error("mode must be quick or named");
      }
      const zone = parseZoneInput(opts.zone ?? "");
      if (!zone) {
        const payload = {
          ok: false,
          need: "zone",
          userMessage: "请告诉我已经加在 Cloudflare 上的域名，例如 example.com",
          loginPrompt: NAMED_LOGIN_PROMPT,
        };
        if (opts.json) {
          say(JSON.stringify(payload));
          return;
        }
        say(payload.userMessage);
        return;
      }
      const inspection = await inspectZoneDns(zone);
      if (!inspection.cloudflareDelegated) {
        const recordsWarning = inspection.existingRecordTypes.length
          ? ` 切换 Nameserver 前请先在 Cloudflare 导入并核对这些现有记录：${inspection.existingRecordTypes.join(", ")}。`
          : "";
        const message =
          `Cloudflare Zone 尚未确认 Active。请先在 Cloudflare 添加 ${zone}，` +
          "再到域名注册商把 Nameserver 改成 Cloudflare 分配的两个地址并等待 Active。" +
          recordsWarning;
        if (opts.json) {
          say(JSON.stringify({ ok: false, need: "cloudflare_zone_active", inspection, userMessage: message }));
          process.exitCode = 1;
          return;
        }
        throw new Error(message);
      }
      if (!opts.json) say(NAMED_LOGIN_PROMPT);
      const result = await provisionNamedTunnel({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        zone,
        hostname: opts.hostname,
      });
      if (!result.ok) {
        const payload = {
          ...tunnelChoicePayload(workspace),
          ok: false,
          fallback: false,
          userMessage: result.userMessage,
          error: result.error,
          state: result.state,
        };
        if (opts.json) {
          say(JSON.stringify(payload));
          process.exitCode = 1;
          return;
        }
        throw new Error(`${result.userMessage ?? "固定域名配置失败"} ${result.error ?? ""}`.trim());
      }
      if (await findLiveBridge(workspace.id)) await stopBridge(root);
      const payload = {
        ...tunnelChoicePayload(workspace),
        ok: result.ok,
        fallback: false,
        state: result.state,
      };
      if (opts.json) {
        say(JSON.stringify(payload));
        return;
      }
      check(`Workspace：${workspace.name}`);
      check("Mode：Named Tunnel");
      check(`Hostname：${result.state.hostname}`);
      check("Status：Ready");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

acceptUnusedWorkspaceOption(
  tunnelCmd
    .command("login")
    .description("Open the Cloudflare login window used by a named hostname")
    .option("--json", "machine-readable output", false)
)
  .action(async (opts: { json: boolean }) => {
    try {
      if (!opts.json) say(NAMED_LOGIN_PROMPT);
      const account = new ProcessCloudflaredAccount();
      await account.login();
      const payload = { ok: true, loggedIn: hasCloudflaredCert() };
      if (opts.json) say(JSON.stringify(payload));
      else check("Cloudflare 已登录");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

registerWebCommands(program, {
  say,
  check,
  resolveWorkspace,
  handleCliError,
  acceptUnusedWorkspaceOption,
});

function handleCliError(error: unknown, json: boolean): void {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
  if (json) {
    say(JSON.stringify({ ok: false, error: code ? `${code}: ${message}` : message }));
  } else if (message.startsWith("NEED_CLOUDFLARED")) {
    say("需要你完成一步：");
    say("");
    say("尚未安装安全连接组件 cloudflared。");
    say("macOS 用户可运行：brew install cloudflared");
    say("完成后再试一次即可。");
  } else {
    cross(message);
  }
  process.exitCode = 1;
}

program.parseAsync(process.argv).catch((error: Error) => {
  cross(error.message);
  process.exit(1);
});
