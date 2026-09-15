import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, getStateDir } from "../config/paths.js";
import { findBridgeObservation, findLiveBridge, type RuntimeState } from "../bridge/runtime.js";
import { Workspace } from "../workspace/manager.js";
import { SERVICE_NAME } from "../version.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Path to the CLI entry, works from dist/ and from tsx dev runs. */
function cliEntry(): { cmd: string; args: string[] } {
  const distEntry = path.resolve(__dirname, "..", "cli", "index.js");
  if (fs.existsSync(distEntry)) {
    return { cmd: process.execPath, args: [distEntry] };
  }
  // dev fallback: run TypeScript sources through the tsx ESM loader
  const projectRoot = path.resolve(__dirname, "..", "..");
  const tsEntry = path.join(projectRoot, "src", "cli", "index.ts");
  return { cmd: process.execPath, args: ["--import", "tsx/esm", tsEntry] };
}

export interface EnsureBridgeResult {
  runtime: RuntimeState;
  spawned: boolean;
}

/**
 * Ensure a bridge is running for the workspace. Reuses a live instance,
 * otherwise spawns a detached daemon and waits for it to become healthy.
 */
export async function ensureBridge(workspaceRoot: string, opts: { port?: number } = {}): Promise<EnsureBridgeResult> {
  const workspace = new Workspace(workspaceRoot);
  const observation = await findBridgeObservation(workspace.id);
  if (observation.state === "healthy") return { runtime: observation.runtime, spawned: false };
  if (observation.state === "unknown") {
    throw new Error(
      `Bridge state is uncertain (${observation.reason}); refusing to start another bridge.`
    );
  }

  const logDir = ensureDir(path.join(getStateDir(), "logs"));
  const logFile = path.join(logDir, `bridge-${workspace.id}.out.log`);
  const out = fs.openSync(logFile, "a", 0o600);
  try {
    // Existing files may have been created with a permissive umask. Keep the
    // daemon's inherited stdout/stderr log owner-readable only.
    fs.chmodSync(logFile, 0o600);
  } catch {
    // Windows / filesystems without chmod semantics
  }
  const { cmd, args } = cliEntry();
  const child = spawn(
    cmd,
    [...args, "serve", "--workspace", workspace.root, ...(opts.port ? ["--port", String(opts.port)] : [])],
    {
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env },
      windowsHide: true,
    }
  );
  child.unref();
  fs.closeSync(out);

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const runtime = await findLiveBridge(workspace.id);
    if (runtime) return { runtime, spawned: true };
    if (child.exitCode !== null && child.exitCode !== 0) {
      throw new Error(`Bridge process exited with code ${child.exitCode}. See ${logFile}`);
    }
  }
  throw new Error(`Bridge did not become healthy within 20s. See ${logFile}`);
}

export async function adminFetch<T = unknown>(
  runtime: RuntimeState,
  method: "GET" | "POST",
  route: string,
  timeoutMs = 60_000
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}${route}`, {
      method,
      headers: { Authorization: `Bearer ${runtime.adminToken}` },
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => ({}))) as T & { message?: string };
    if (!response.ok) {
      throw new Error((body as { message?: string }).message ?? `Admin request failed (${response.status})`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyPublicConnection(
  publicUrl: string,
  workspaceId: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const health = await fetchImpl(`${publicUrl}/health`, { signal: AbortSignal.timeout(8000) });
  if (!health.ok) throw new Error(`Tunnel health check returned HTTP ${health.status}`);
  const payload = (await health.json().catch(() => null)) as {
    service?: string;
    workspaceId?: string;
    status?: string;
  } | null;
  if (payload?.service !== SERVICE_NAME || payload.status !== "ok" || payload.workspaceId !== workspaceId) {
    throw new Error("Tunnel health check returned the wrong service or workspace");
  }
  const mcp = await fetchImpl(`${publicUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
    signal: AbortSignal.timeout(8000),
  });
  if (mcp.status !== 401) {
    await mcp.body?.cancel().catch(() => undefined);
    throw new Error(`Public MCP check returned HTTP ${mcp.status}, expected OAuth 401`);
  }
  await mcp.body?.cancel().catch(() => undefined);
}

export async function verifyPublicConnectionOrStop(
  runtime: RuntimeState,
  publicUrl: string,
  workspaceId: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  try {
    await verifyPublicConnection(publicUrl, workspaceId, fetchImpl);
  } catch (error) {
    try {
      await adminFetch(runtime, "POST", "/admin/tunnel/stop", 5000);
      const info = await adminFetch<{
        publicUrl: string | null;
        tunnel: { running: boolean; url: string | null };
      }>(runtime, "GET", "/admin/info", 5000);
      if (info.publicUrl || info.tunnel.running || info.tunnel.url) {
        throw new Error("Tunnel still reports running after cleanup");
      }
    } catch (cleanupError) {
      throw new Error(
        `${(error as Error).message}; TUNNEL_CLEANUP_FAILED: ${(cleanupError as Error).message}`
      );
    }
    throw error;
  }
}

export async function startTunnelAndVerify(
  runtime: RuntimeState,
  workspaceId: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const started = await adminFetch<{ url?: string; message?: string }>(
    runtime,
    "POST",
    "/admin/tunnel/start",
    90_000
  );
  if (!started.url) {
    await adminFetch(runtime, "POST", "/admin/tunnel/stop", 5000).catch(() => undefined);
    throw new Error(started.message ?? "Tunnel start failed");
  }
  await verifyPublicConnectionOrStop(runtime, started.url, workspaceId, fetchImpl);
  return started.url;
}

export async function stopBridge(workspaceRoot: string): Promise<boolean> {
  const workspace = new Workspace(workspaceRoot);
  const observation = await findBridgeObservation(workspace.id);
  if (observation.state === "stopped") return false;
  if (observation.state === "unknown") {
    throw new Error(`Bridge state is uncertain (${observation.reason}); refusing to signal the recorded PID.`);
  }
  const runtime = observation.runtime;
  const identity = await adminFetch<{ workspaceId: string; pid: number }>(runtime, "GET", "/admin/info", 5000);
  if (identity.workspaceId !== workspace.id || identity.pid !== runtime.pid) {
    throw new Error("Bridge runtime identity mismatch; refusing to signal the recorded PID.");
  }
  try {
    await adminFetch(runtime, "POST", "/admin/shutdown", 5000);
    if (await waitUntilStopped(workspace.id)) return true;
  } catch {
    // The authenticated admin identity was confirmed immediately above.
  }
  try {
    process.kill(runtime.pid, "SIGTERM");
    return waitUntilStopped(workspace.id);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return waitUntilStopped(workspace.id);
    throw error;
  }
}

async function waitUntilStopped(workspaceId: string): Promise<boolean> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const observation = await findBridgeObservation(workspaceId);
    if (observation.state === "stopped") return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}
