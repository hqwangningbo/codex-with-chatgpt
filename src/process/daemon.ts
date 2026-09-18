import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, getStateDir } from "../config/paths.js";
import { findBridgeObservation, findLiveBridge, type RuntimeState } from "../bridge/runtime.js";
import {
  curlFetchThroughProxy,
  detectMacOsLoopbackHttpsProxy,
  type ProxyDetector,
  type ProxyFetcher,
} from "../network/system-proxy.js";
import { Workspace } from "../workspace/manager.js";
import { SERVICE_NAME } from "../version.js";

export type PublicVerificationTransport = "direct" | "system-proxy";

export interface VerifyPublicDeps {
  detectProxy?: ProxyDetector;
  proxyFetch?: ProxyFetcher;
}

const TRANSPORT_CODES = new Set([
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ETIMEDOUT",
  "ECONNRESET",
]);

function collectErrorCodes(error: unknown, into = new Set<string>()): Set<string> {
  if (!error || typeof error !== "object") return into;
  const err = error as { code?: unknown; cause?: unknown; errors?: unknown[] };
  if (typeof err.code === "string") into.add(err.code);
  if (err.cause) collectErrorCodes(err.cause, into);
  if (Array.isArray(err.errors)) {
    for (const nested of err.errors) collectErrorCodes(nested, into);
  }
  return into;
}

export function isPublicTransportError(error: unknown): boolean {
  const codes = collectErrorCodes(error);
  for (const code of codes) {
    if (TRANSPORT_CODES.has(code)) return true;
  }
  return false;
}

function assertHealthPayload(status: number, body: string, workspaceId: string): void {
  if (status !== 200) throw new Error(`Tunnel health check returned HTTP ${status}`);
  let payload: { service?: string; workspaceId?: string; environmentId?: string; status?: string } | null = null;
  try {
    payload = JSON.parse(body) as {
      service?: string;
      workspaceId?: string;
      environmentId?: string;
      status?: string;
    };
  } catch {
    payload = null;
  }
  const id = payload?.environmentId ?? payload?.workspaceId;
  if (payload?.service !== SERVICE_NAME || payload.status !== "ok" || id !== workspaceId) {
    throw new Error("Tunnel health check returned the wrong service or workspace");
  }
}

function assertMcpUnauthorized(status: number): void {
  if (status !== 401) {
    throw new Error(`Public MCP check returned HTTP ${status}, expected OAuth 401`);
  }
}

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
  timeoutMs = 60_000,
  requestBody?: unknown
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${runtime.adminToken}`,
        ...(requestBody !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: requestBody !== undefined ? JSON.stringify(requestBody) : undefined,
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

async function verifyDirectPublicConnection(
  publicUrl: string,
  workspaceId: string,
  fetchImpl: typeof fetch
): Promise<void> {
  const health = await fetchImpl(`${publicUrl}/health`, { signal: AbortSignal.timeout(8000) });
  const healthBody = await health.text();
  assertHealthPayload(health.status, healthBody, workspaceId);
  const mcp = await fetchImpl(`${publicUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
    signal: AbortSignal.timeout(8000),
  });
  await mcp.body?.cancel().catch(() => undefined);
  assertMcpUnauthorized(mcp.status);
}

async function verifyProxyPublicConnection(
  publicUrl: string,
  workspaceId: string,
  deps: VerifyPublicDeps
): Promise<void> {
  const detectProxy = deps.detectProxy ?? detectMacOsLoopbackHttpsProxy;
  const proxyFetch = deps.proxyFetch ?? curlFetchThroughProxy;
  const proxy = await detectProxy();
  if (!proxy) throw new Error("No macOS loopback HTTPS system proxy available");
  const health = await proxyFetch(`${publicUrl}/health`, proxy);
  assertHealthPayload(health.status, health.body, workspaceId);
  const mcp = await proxyFetch(`${publicUrl}/mcp`, proxy, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
  });
  assertMcpUnauthorized(mcp.status);
}

export async function verifyPublicConnection(
  publicUrl: string,
  workspaceId: string,
  fetchImpl: typeof fetch = fetch,
  deps: VerifyPublicDeps = {}
): Promise<PublicVerificationTransport> {
  try {
    await verifyDirectPublicConnection(publicUrl, workspaceId, fetchImpl);
    return "direct";
  } catch (error) {
    if (!isPublicTransportError(error)) throw error;
    try {
      await verifyProxyPublicConnection(publicUrl, workspaceId, deps);
      return "system-proxy";
    } catch (proxyError) {
      throw new Error(
        `${(error as Error).message}; proxy fallback failed: ${(proxyError as Error).message}`
      );
    }
  }
}

export async function verifyPublicConnectionOrStop(
  runtime: RuntimeState,
  publicUrl: string,
  workspaceId: string,
  fetchImpl: typeof fetch = fetch,
  deps: VerifyPublicDeps = {}
): Promise<PublicVerificationTransport> {
  try {
    return await verifyPublicConnection(publicUrl, workspaceId, fetchImpl, deps);
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
  fetchImpl: typeof fetch = fetch,
  deps: VerifyPublicDeps = {}
): Promise<{ url: string; transport: PublicVerificationTransport }> {
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
  const transport = await verifyPublicConnectionOrStop(
    runtime,
    started.url,
    workspaceId,
    fetchImpl,
    deps
  );
  return { url: started.url, transport };
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
