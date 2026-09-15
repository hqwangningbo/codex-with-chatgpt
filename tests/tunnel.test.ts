import { describe, it, expect, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { tunnelForWorkspace } from "../src/bridge/server.js";
import { findBinary } from "../src/tunnel/detect.js";
import {
  CloudflaredQuickTunnel,
  parseQuickTunnelUrl,
  type CloudflaredQuickTunnelOptions,
} from "../src/tunnel/cloudflared.js";
import { CloudflaredNamedTunnel, normalizeNamedTunnelHostname } from "../src/tunnel/cloudflared-named.js";
import { hostnameSlug, parseZoneInput, suggestedNamedHostname } from "../src/tunnel/hostname.js";
import {
  chooseQuickTunnel,
  parseCreatedTunnel,
  parseTunnelList,
  provisionNamedTunnel,
  type CloudflaredAccount,
} from "../src/tunnel/named-provision.js";
import { resolveTunnelProtocol, tunnelProtocolArgs } from "../src/tunnel/protocol.js";
import {
  isNamedTunnelReady,
  needsTunnelChoice,
  readTunnelState,
  tunnelStateFile,
  writeTunnelState,
} from "../src/tunnel/state.js";
import { isCloudflareDelegation } from "../src/tunnel/zone.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const stateDirs: string[] = [];
const previousStateDir = process.env.C2C_STATE_DIR;
const previousCloudflaredPath = process.env.C2C_CLOUDFLARED_PATH;
const QUICK_URL = "https://random-words-here-1234.trycloudflare.com";
type FetchImpl = NonNullable<CloudflaredQuickTunnelOptions["fetchImpl"]>;

class FakeCloudflaredProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  readonly kill = vi.fn(() => {
    this.killed = true;
    return true;
  });
}

function setupTunnel(fetchImpl: FetchImpl, startTimeoutMs = 1_000) {
  const child = new FakeCloudflaredProcess();
  const spawnImpl = vi.fn(() => child as unknown as ChildProcess);
  const tunnel = new CloudflaredQuickTunnel(undefined, "cloudflared", {
    spawnImpl,
    fetchImpl,
    startTimeoutMs,
  });
  return { child, spawnImpl, tunnel };
}

function announceUrl(child: FakeCloudflaredProcess): void {
  child.stderr.write(`INF ${QUICK_URL}\n`);
}

function healthResponse(): Response {
  return new Response(JSON.stringify({ service: "c2c-bridge", status: "ok" }), { status: 200 });
}

afterEach(() => {
  while (stateDirs.length) cleanup(stateDirs.pop()!);
  if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousStateDir;
  if (previousCloudflaredPath === undefined) delete process.env.C2C_CLOUDFLARED_PATH;
  else process.env.C2C_CLOUDFLARED_PATH = previousCloudflaredPath;
});

describe("findBinary", () => {
  it("uses C2C_CLOUDFLARED_PATH for an accessible cloudflared executable", () => {
    const dir = makeTmpDir("cloudflared-path");
    stateDirs.push(dir);
    const filename = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
    const configured = write(dir, filename, "placeholder");
    if (process.platform !== "win32") fs.chmodSync(configured, 0o755);
    process.env.C2C_CLOUDFLARED_PATH = configured;
    expect(findBinary("cloudflared")).toBe(configured);
  });
});

describe("parseQuickTunnelUrl", () => {
  it("extracts the URL from cloudflared banner output", () => {
    const line =
      "2026-08-28T10:00:00Z INF |  https://random-words-here-1234.trycloudflare.com                              |";
    expect(parseQuickTunnelUrl(line)).toBe(QUICK_URL);
  });

  it("ignores unrelated lines and non-Quick-Tunnel hosts", () => {
    expect(parseQuickTunnelUrl("INF Starting tunnel connection")).toBeNull();
    expect(parseQuickTunnelUrl("visit https://www.cloudflare.com for docs")).toBeNull();
    expect(parseQuickTunnelUrl("https://evil.example.com/trycloudflare.com")).toBeNull();
  });

  it("rejects Cloudflare's API host", () => {
    expect(parseQuickTunnelUrl("INF https://api.trycloudflare.com")).toBeNull();
  });
});

describe("CloudflaredQuickTunnel", () => {
  it("resolves only after the public health endpoint identifies the bridge", async () => {
    const fetchImpl = vi.fn(async () => healthResponse());
    const { child, spawnImpl, tunnel } = setupTunnel(fetchImpl);
    const starting = tunnel.start(3333);
    announceUrl(child);

    await expect(starting).resolves.toBe(QUICK_URL);
    expect(spawnImpl).toHaveBeenCalledWith(
      "cloudflared",
      ["tunnel", "--url", "http://127.0.0.1:3333", "--no-autoupdate"],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
    );
    expect(fetchImpl).toHaveBeenCalledWith(`${QUICK_URL}/health`, {
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
    expect(tunnel.status()).toMatchObject({ running: true, url: QUICK_URL });
    await tunnel.stop();
  });

  it("passes --protocol when C2C_TUNNEL_PROTOCOL is set", async () => {
    vi.stubEnv("C2C_TUNNEL_PROTOCOL", "http2");
    const { child, spawnImpl, tunnel } = setupTunnel(async () => healthResponse());
    const starting = tunnel.start(3333);
    announceUrl(child);
    await expect(starting).resolves.toBe(QUICK_URL);
    expect(spawnImpl).toHaveBeenCalledWith(
      "cloudflared",
      ["tunnel", "--url", "http://127.0.0.1:3333", "--no-autoupdate", "--protocol", "http2"],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
    );
    await tunnel.stop();
    vi.unstubAllEnvs();
  });

  it("keeps consuming cloudflared errors after the tunnel is ready", async () => {
    const { child, tunnel } = setupTunnel(async () => healthResponse());
    const starting = tunnel.start(3333);
    announceUrl(child);
    await expect(starting).resolves.toBe(QUICK_URL);

    child.stderr.write("ERR runtime connection error\n");
    await new Promise((resolve) => setImmediate(resolve));
    expect(tunnel.status().detail).toBe("ERR runtime connection error");
    await tunnel.stop();
  });

  it("does not accept an HTTP 200 response from another service", async () => {
    const { child, tunnel } = setupTunnel(
      async () =>
        new Response(JSON.stringify({ service: "cloudflare", status: "ok" }), { status: 200 }),
      20
    );
    const starting = tunnel.start(3333);
    announceUrl(child);

    await expect(starting).rejects.toThrow(/timed out/i);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(tunnel.status()).toMatchObject({ running: false, url: null });
  });

  it("does not spawn twice or resolve a stopped pending start", async () => {
    const { child, spawnImpl, tunnel } = setupTunnel(() => new Promise<Response>(() => {}));
    const starting = tunnel.start(3333);
    announceUrl(child);
    await new Promise((resolve) => setImmediate(resolve));

    const concurrent = tunnel.start(3333);
    await tunnel.stop();
    await expect(starting).rejects.toThrow(/stopped/i);
    await expect(concurrent).rejects.toThrow(/stopped/i);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("does not resolve if cloudflared exits while the health probe is in flight", async () => {
    let resolveFetch!: (response: Response) => void;
    const { child, tunnel } = setupTunnel(
      () => new Promise<Response>((resolve) => (resolveFetch = resolve))
    );
    const starting = tunnel.start(3333);
    announceUrl(child);
    await new Promise((resolve) => setImmediate(resolve));

    child.exitCode = 1;
    child.emit("exit", 1, null);
    resolveFetch(healthResponse());
    await expect(starting).rejects.toThrow(/exited/i);
    expect(tunnel.status()).toMatchObject({ running: false, url: null });
  });

  it("rejects when spawning reports an asynchronous error", async () => {
    const { child, tunnel } = setupTunnel(async () => new Response(null));
    const starting = tunnel.start(3333);
    await new Promise((resolve) => setImmediate(resolve));
    child.emit("error", new Error("spawn cloudflared ENOENT"));

    await expect(starting).rejects.toThrow(/ENOENT/i);
    expect(tunnel.status()).toMatchObject({ running: false, url: null });
  });

  it("retries a non-ready health response before resolving", async () => {
    let calls = 0;
    const cancelBody = vi.fn(async () => undefined);
    const { child, tunnel } = setupTunnel(async () => {
      calls += 1;
      return calls === 1
        ? ({ ok: false, status: 503, body: { cancel: cancelBody } } as unknown as Response)
        : healthResponse();
    });
    const starting = tunnel.start(3333);
    announceUrl(child);

    await expect(starting).resolves.toBe(QUICK_URL);
    expect(calls).toBe(2);
    expect(cancelBody).toHaveBeenCalledTimes(1);
    await tunnel.stop();
  });
});

describe("tunnel transport protocol", () => {
  it("keeps cloudflared's default when C2C_TUNNEL_PROTOCOL is unset or empty", () => {
    expect(resolveTunnelProtocol({})).toBeNull();
    expect(resolveTunnelProtocol({ C2C_TUNNEL_PROTOCOL: "  " })).toBeNull();
    expect(tunnelProtocolArgs(null)).toEqual([]);
  });

  it("accepts the cloudflared protocol names case-insensitively", () => {
    expect(resolveTunnelProtocol({ C2C_TUNNEL_PROTOCOL: "HTTP2" })).toBe("http2");
    expect(resolveTunnelProtocol({ C2C_TUNNEL_PROTOCOL: " quic " })).toBe("quic");
    expect(resolveTunnelProtocol({ C2C_TUNNEL_PROTOCOL: "auto" })).toBe("auto");
    expect(tunnelProtocolArgs("http2")).toEqual(["--protocol", "http2"]);
  });

  it("rejects unknown protocols instead of silently falling back", () => {
    expect(() => resolveTunnelProtocol({ C2C_TUNNEL_PROTOCOL: "tcp" })).toThrow(
      /C2C_TUNNEL_PROTOCOL must be one of auto, quic, http2/
    );
  });
});

describe("normalizeNamedTunnelHostname", () => {
  it("normalizes a valid hostname", () => {
    expect(normalizeNamedTunnelHostname("Dev.GetRemi.xyz.")).toBe("dev.getremi.xyz");
  });

  it("rejects URLs and invalid hostnames", () => {
    expect(() => normalizeNamedTunnelHostname("https://dev.getremi.xyz")).toThrow(/invalid/i);
    expect(() => normalizeNamedTunnelHostname("localhost")).toThrow(/invalid/i);
  });
});

describe("CloudflaredNamedTunnel", () => {
  it("restarts the saved tunnel with the same hostname", async () => {
    const firstChild = new FakeCloudflaredProcess();
    const secondChild = new FakeCloudflaredProcess();
    const spawnImpl = vi.fn()
      .mockReturnValueOnce(firstChild as unknown as ChildProcess)
      .mockReturnValueOnce(secondChild as unknown as ChildProcess);
    const tunnel = new CloudflaredNamedTunnel({
      tunnelName: "c2c-abcdef123456",
      hostname: "c2c-bifrost.example.com",
      binaryOverride: "cloudflared",
      spawnImpl,
      startTimeoutMs: 1000,
    });

    const firstStart = tunnel.start(48765);
    firstChild.stderr.write("INF Registered tunnel connection\n");
    await expect(firstStart).resolves.toBe("https://c2c-bifrost.example.com");
    await tunnel.stop();

    const secondStart = tunnel.start(48766);
    secondChild.stderr.write("INF Registered tunnel connection\n");
    await expect(secondStart).resolves.toBe("https://c2c-bifrost.example.com");
    expect(spawnImpl).toHaveBeenNthCalledWith(
      2,
      "cloudflared",
      [
        "tunnel",
        "--no-autoupdate",
        "--url",
        "http://127.0.0.1:48766",
        "run",
        "c2c-abcdef123456",
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
    );
    await tunnel.stop();
  });
});

describe("named hostname helpers", () => {
  it("builds a stable c2c-<project>.<zone> hostname", () => {
    expect(suggestedNamedHostname("Example.COM", "My App", "abcdef123456")).toBe("c2c-my-app.example.com");
  });

  it("falls back to the workspace id when the name is not ASCII", () => {
    expect(hostnameSlug("回声", "abcdef123456")).toBe("c2c-ws-abcdef12");
  });

  it("parses a typed domain", () => {
    expect(parseZoneInput("https://Example.com/")).toBe("example.com");
    expect(parseZoneInput("not a domain")).toBeNull();
  });
});

describe("Cloudflare Zone checks", () => {
  it("requires at least two Cloudflare authoritative nameservers", () => {
    expect(isCloudflareDelegation(["ada.ns.cloudflare.com", "bob.ns.cloudflare.com."])).toBe(true);
    expect(isCloudflareDelegation(["ns1.aliyun.com", "ns2.aliyun.com"])).toBe(false);
    expect(isCloudflareDelegation(["ada.ns.cloudflare.com"])).toBe(false);
  });
});

describe("cloudflared output parsers", () => {
  it("reads a tunnel list table", () => {
    const output = `
ID                                   NAME          CREATED
11111111-1111-1111-1111-111111111111 c2c-abc123    2026-08-30
`;
    expect(parseTunnelList(output)).toEqual([
      { id: "11111111-1111-1111-1111-111111111111", name: "c2c-abc123" },
    ]);
  });

  it("reads created-tunnel output", () => {
    expect(
      parseCreatedTunnel(
        "Created tunnel c2c-abc with id 22222222-2222-2222-2222-222222222222",
        "c2c-abc"
      )
    ).toEqual({ id: "22222222-2222-2222-2222-222222222222", name: "c2c-abc" });
  });

});

describe("tunnel preference state", () => {
  it("asks once, then remembers a quick choice", () => {
    stateDirs.push(isolateStateDir());
    const unset = readTunnelState("ws1");
    expect(needsTunnelChoice(unset)).toBe(true);
    const saved = chooseQuickTunnel("ws1");
    expect(saved.preference).toBe("quick");
    expect(needsTunnelChoice(readTunnelState("ws1"))).toBe(false);
    expect(isNamedTunnelReady(saved)).toBe(false);
  });

  it("selects the saved Named provider after a Bridge restart", () => {
    stateDirs.push(isolateStateDir());
    writeTunnelState({
      workspaceId: "persisted-workspace",
      preference: "named",
      provider: "cloudflare-named",
      tunnelName: "c2c-persisted-workspace",
      tunnelId: "77777777-7777-7777-7777-777777777777",
      hostname: "c2c-persisted.example.com",
    });
    expect(tunnelForWorkspace("persisted-workspace").status()).toMatchObject({
      provider: "cloudflare-named",
      running: false,
      url: null,
    });
  });

  it("provisions a named hostname through the account adapter and stores it outside the project", () => {
    stateDirs.push(isolateStateDir());
    const account: CloudflaredAccount = {
      hasCert: () => true,
      login: async () => undefined,
      listTunnels: async () => [],
      createTunnel: async (name) => ({ id: "33333333-3333-3333-3333-333333333333", name }),
      routeDns: async () => undefined,
    };
    return provisionNamedTunnel({
      workspaceId: "abcdef123456",
      workspaceName: "Demo",
      zone: "example.com",
      account,
    }).then((result) => {
      expect(result.fallback).toBe(false);
      expect(result.state.preference).toBe("named");
      expect(result.state.hostname).toBe("c2c-demo.example.com");
      expect(result.state.tunnelName).toBe("c2c-abcdef123456");
      expect(isNamedTunnelReady(readTunnelState("abcdef123456"))).toBe(true);
      if (process.platform !== "win32") {
        expect(fs.statSync(tunnelStateFile("abcdef123456")).mode & 0o777).toBe(0o600);
      }
    });
  });

  it("fails closed without switching to a temporary address when named provisioning fails", () => {
    stateDirs.push(isolateStateDir());
    const account: CloudflaredAccount = {
      hasCert: () => true,
      login: async () => undefined,
      listTunnels: async () => [],
      createTunnel: async () => {
        throw new Error("no zone");
      },
      routeDns: async () => undefined,
    };
    return provisionNamedTunnel({
      workspaceId: "ws2",
      workspaceName: "Demo",
      zone: "example.com",
      account,
    }).then((result) => {
      expect(result.ok).toBe(false);
      expect(result.fallback).toBe(false);
      expect(result.state.preference).toBe("unset");
      expect(result.userMessage).toMatch(/未自动切换/);
    });
  });

  it("treats an existing unverified DNS record as a conflict, not success", async () => {
    stateDirs.push(isolateStateDir());
    const account: CloudflaredAccount = {
      hasCert: () => true,
      login: async () => undefined,
      listTunnels: async () => [],
      createTunnel: async (name) => ({ id: "66666666-6666-6666-6666-666666666666", name }),
      routeDns: async () => {
        throw new Error("Failed to add route: record already exists");
      },
    };
    const result = await provisionNamedTunnel({
      workspaceId: "dns-conflict",
      workspaceName: "Bifrost",
      zone: "example.com",
      account,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/already exists/);
    expect(readTunnelState("dns-conflict").preference).toBe("unset");
  });

  it("reuses the saved tunnel and hostname without routing DNS again", async () => {
    stateDirs.push(isolateStateDir());
    const routeDns = vi.fn(async () => undefined);
    const tunnel = { id: "44444444-4444-4444-4444-444444444444", name: "c2c-abcdef123456" };
    const account: CloudflaredAccount = {
      hasCert: () => true,
      login: async () => undefined,
      listTunnels: async () => [tunnel],
      createTunnel: async () => tunnel,
      routeDns,
    };
    const first = await provisionNamedTunnel({
      workspaceId: "abcdef123456",
      workspaceName: "Bifrost",
      zone: "example.com",
      account,
    });
    const second = await provisionNamedTunnel({
      workspaceId: "abcdef123456",
      workspaceName: "Bifrost",
      zone: "example.com",
      account,
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.state.hostname).toBe("c2c-bifrost.example.com");
    expect(routeDns).toHaveBeenCalledTimes(1);
  });

  it("does not let another workspace silently claim a saved hostname", async () => {
    stateDirs.push(isolateStateDir());
    const account: CloudflaredAccount = {
      hasCert: () => true,
      login: async () => undefined,
      listTunnels: async () => [],
      createTunnel: async (name) => ({ id: "55555555-5555-5555-5555-555555555555", name }),
      routeDns: async () => undefined,
    };
    await provisionNamedTunnel({
      workspaceId: "workspace-one",
      workspaceName: "One",
      zone: "example.com",
      hostname: "c2c-shared.example.com",
      account,
    });
    const second = await provisionNamedTunnel({
      workspaceId: "workspace-two",
      workspaceName: "Two",
      zone: "example.com",
      hostname: "c2c-shared.example.com",
      account,
    });
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/already bound to workspace workspace-one/);
    expect(second.state.preference).toBe("unset");
  });

  it("allows different workspaces to keep different stable hostnames", async () => {
    stateDirs.push(isolateStateDir());
    const account: CloudflaredAccount = {
      hasCert: () => true,
      login: async () => undefined,
      listTunnels: async () => [],
      createTunnel: async (name) => ({ id: `${name}-id`, name }),
      routeDns: async () => undefined,
    };
    const one = await provisionNamedTunnel({
      workspaceId: "workspace-one",
      workspaceName: "Bifrost",
      zone: "example.com",
      account,
    });
    const two = await provisionNamedTunnel({
      workspaceId: "workspace-two",
      workspaceName: "Vault",
      zone: "example.com",
      account,
    });
    expect(one.state.hostname).toBe("c2c-bifrost.example.com");
    expect(two.state.hostname).toBe("c2c-vault.example.com");
  });
});
