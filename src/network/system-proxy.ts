import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const MAX_BODY_CHARS = 64 * 1024;
const MAX_ERROR_CHARS = 400;

export interface LoopbackHttpsProxy {
  host: string;
  port: number;
}

export interface ProxyFetchInit {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
}

export interface ProxyFetchResult {
  status: number;
  body: string;
}

export type ProxyDetector = () => Promise<LoopbackHttpsProxy | null>;
export type ProxyFetcher = (
  url: string,
  proxy: LoopbackHttpsProxy,
  init?: ProxyFetchInit
) => Promise<ProxyFetchResult>;

type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: { encoding: "utf8"; timeout: number; maxBuffer: number; windowsHide: boolean }
) => Promise<{ stdout: string; stderr: string }>;

function clip(text: string, max = MAX_ERROR_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export function parseScutilProxy(output: string): LoopbackHttpsProxy | null {
  if (!/HTTPSEnable\s*:\s*1\b/.test(output)) return null;
  const host = output.match(/HTTPSProxy\s*:\s*(\S+)/)?.[1]?.trim();
  const portRaw = output.match(/HTTPSPort\s*:\s*(\d+)/)?.[1];
  if (!host || !portRaw) return null;
  const normalizedHost = host.toLowerCase();
  if (!LOOPBACK_HOSTS.has(normalizedHost)) return null;
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return {
    host: normalizedHost === "localhost" ? "localhost" : normalizedHost === "::1" ? "::1" : "127.0.0.1",
    port,
  };
}

/** Read-only macOS HTTPS system proxy; only loopback is accepted. */
export async function detectMacOsLoopbackHttpsProxy(
  execFileImpl: ExecFileFn = execFileAsync as ExecFileFn
): Promise<LoopbackHttpsProxy | null> {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await execFileImpl("/usr/sbin/scutil", ["--proxy"], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
    return parseScutilProxy(stdout);
  } catch {
    return null;
  }
}

export async function curlFetchThroughProxy(
  url: string,
  proxy: LoopbackHttpsProxy,
  init: ProxyFetchInit = {},
  execFileImpl: ExecFileFn = execFileAsync as ExecFileFn
): Promise<ProxyFetchResult> {
  if (!/^https:\/\//i.test(url)) {
    throw new Error("Proxy fetch is limited to https public URLs");
  }
  const proxyUrl =
    proxy.host === "::1" ? `http://[::1]:${proxy.port}` : `http://${proxy.host}:${proxy.port}`;
  const args = [
    "--proxy",
    proxyUrl,
    "--silent",
    "--show-error",
    "--max-time",
    "8",
    "--write-out",
    "\n%{http_code}",
  ];
  if (init.method === "POST") args.push("-X", "POST");
  for (const [key, value] of Object.entries(init.headers ?? {})) {
    if (/authorization|cookie|token|proxy-authorization/i.test(key)) {
      throw new Error("Refusing to pass credentials to proxy curl");
    }
    args.push("-H", `${key}: ${value}`);
  }
  if (init.body !== undefined) args.push("--data-binary", init.body);
  args.push(url);

  let stdout: string;
  let stderr: string;
  try {
    ({ stdout, stderr } = await execFileImpl("/usr/bin/curl", args, {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: MAX_BODY_CHARS + 64,
      windowsHide: true,
    }));
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    throw new Error(`Proxy curl failed: ${clip((err.stderr || err.message || "curl failed").toString())}`);
  }

  const text = stdout ?? "";
  const nl = text.lastIndexOf("\n");
  if (nl < 0) throw new Error(`Proxy curl failed: ${clip(stderr || "missing HTTP status")}`);
  const body = text.slice(0, nl).slice(0, MAX_BODY_CHARS);
  const status = Number(text.slice(nl + 1).trim());
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new Error(`Proxy curl failed: ${clip(stderr || "invalid HTTP status")}`);
  }
  return { status, body };
}
