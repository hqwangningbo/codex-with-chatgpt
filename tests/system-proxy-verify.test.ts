import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { startBridge } from "../src/bridge/server.js";
import type { RuntimeState } from "../src/bridge/runtime.js";
import {
  isPublicTransportError,
  verifyPublicConnection,
  verifyPublicConnectionOrStop,
  adminFetch,
} from "../src/process/daemon.js";
import { parseScutilProxy } from "../src/network/system-proxy.js";
import type { TunnelProvider, TunnelStatus } from "../src/tunnel/provider.js";
import { SERVICE_NAME, VERSION } from "../src/version.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

const PUBLIC_URL = "https://c2c-test.example.com";

function transportError(code: string): Error {
  const cause = Object.assign(new Error(code), { code });
  return Object.assign(new TypeError("fetch failed"), { cause });
}

class FakeTunnel implements TunnelProvider {
  readonly name = "fake";
  readonly stop = vi.fn(async () => {
    this.running = false;
  });
  private running = false;

  async start(): Promise<string> {
    this.running = true;
    return PUBLIC_URL;
  }
  async restart(): Promise<string> {
    await this.stop();
    return this.start();
  }
  status(): TunnelStatus {
    return { running: this.running, url: this.running ? PUBLIC_URL : null, provider: this.name };
  }
  getPublicUrl(): string | null {
    return this.running ? PUBLIC_URL : null;
  }
  async doctor() {
    return {
      provider: this.name,
      binaryFound: true,
      binaryPath: "fake",
      running: this.running,
      url: this.getPublicUrl(),
      problems: [],
    };
  }
}

describe("parseScutilProxy", () => {
  it("accepts loopback HTTPS proxies only", () => {
    expect(
      parseScutilProxy(`<dictionary> {
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
}`)
    ).toEqual({ host: "127.0.0.1", port: 7890 });
    expect(
      parseScutilProxy(`HTTPSEnable : 1
HTTPSProxy : 8.8.8.8
HTTPSPort : 7890`)
    ).toBeNull();
    expect(parseScutilProxy("not a proxy dictionary")).toBeNull();
  });
});

describe("isPublicTransportError", () => {
  it("detects nested ECONNREFUSED but not TLS failures", () => {
    expect(isPublicTransportError(transportError("ECONNREFUSED"))).toBe(true);
    expect(isPublicTransportError(transportError("UNABLE_TO_VERIFY_LEAF_SIGNATURE"))).toBe(false);
    expect(isPublicTransportError(new Error("wrong workspace"))).toBe(false);
  });
});

describe("verifyPublicConnection proxy fallback", () => {
  it("uses direct success without calling scutil/curl", async () => {
    const detectProxy = vi.fn(async () => ({ host: "127.0.0.1", port: 7890 }));
    const proxyFetch = vi.fn();
    const fetchImpl = vi.fn(async (input: string | URL) => {
      if (String(input).endsWith("/health")) {
        return new Response(
          JSON.stringify({ service: SERVICE_NAME, status: "ok", workspaceId: "ws-1" }),
          { status: 200 }
        );
      }
      return new Response("unauthorized", { status: 401 });
    });
    await expect(
      verifyPublicConnection(PUBLIC_URL, "ws-1", fetchImpl as typeof fetch, { detectProxy, proxyFetch })
    ).resolves.toBe("direct");
    expect(detectProxy).not.toHaveBeenCalled();
    expect(proxyFetch).not.toHaveBeenCalled();
  });

  it("falls back to loopback system proxy after ECONNREFUSED", async () => {
    const detectProxy = vi.fn(async () => ({ host: "127.0.0.1", port: 7890 }));
    const proxyFetch = vi.fn(async (url: string) => {
      if (url.endsWith("/health")) {
        return {
          status: 200,
          body: JSON.stringify({ service: SERVICE_NAME, status: "ok", workspaceId: "ws-1" }),
        };
      }
      return { status: 401, body: "" };
    });
    const fetchImpl = vi.fn(async () => {
      throw transportError("ECONNREFUSED");
    });
    await expect(
      verifyPublicConnection(PUBLIC_URL, "ws-1", fetchImpl as typeof fetch, { detectProxy, proxyFetch })
    ).resolves.toBe("system-proxy");
    expect(detectProxy).toHaveBeenCalledOnce();
    expect(proxyFetch).toHaveBeenCalled();
  });

  it("does not fall back on TLS validation failures", async () => {
    const detectProxy = vi.fn(async () => ({ host: "127.0.0.1", port: 7890 }));
    const proxyFetch = vi.fn();
    const fetchImpl = vi.fn(async () => {
      throw transportError("UNABLE_TO_VERIFY_LEAF_SIGNATURE");
    });
    await expect(
      verifyPublicConnection(PUBLIC_URL, "ws-1", fetchImpl as typeof fetch, { detectProxy, proxyFetch })
    ).rejects.toThrow(/fetch failed/);
    expect(detectProxy).not.toHaveBeenCalled();
    expect(proxyFetch).not.toHaveBeenCalled();
  });

  it("fails closed when no system proxy is available", async () => {
    const detectProxy = vi.fn(async () => null);
    const proxyFetch = vi.fn();
    const fetchImpl = vi.fn(async () => {
      throw transportError("ECONNREFUSED");
    });
    await expect(
      verifyPublicConnection(PUBLIC_URL, "ws-1", fetchImpl as typeof fetch, { detectProxy, proxyFetch })
    ).rejects.toThrow(/No macOS loopback HTTPS system proxy/);
    expect(proxyFetch).not.toHaveBeenCalled();
  });

  it("rejects a remote system proxy", async () => {
    const detectProxy = vi.fn(async () => null); // detector already filtered remote
    const proxyFetch = vi.fn();
    expect(parseScutilProxy("HTTPSEnable : 1\nHTTPSProxy : 1.2.3.4\nHTTPSPort : 8080")).toBeNull();
    const fetchImpl = vi.fn(async () => {
      throw transportError("ECONNREFUSED");
    });
    await expect(
      verifyPublicConnection(PUBLIC_URL, "ws-1", fetchImpl as typeof fetch, { detectProxy, proxyFetch })
    ).rejects.toThrow(/No macOS loopback HTTPS system proxy/);
  });
});

describe("verifyPublicConnectionOrStop proxy semantic failures", () => {
  async function withBridge(
    run: (runtime: RuntimeState, workspaceId: string, tunnel: FakeTunnel) => Promise<void>
  ): Promise<void> {
    const root = makeTmpDir("proxy-verify");
    const authDir = makeTmpDir("proxy-verify-auth");
    write(root, "README.md", "test\n");
    const tunnel = new FakeTunnel();
    const bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: false,
      authStoreFile: path.join(authDir, "store.json"),
      tunnelProvider: tunnel,
    });
    const runtime: RuntimeState = {
      service: SERVICE_NAME,
      version: VERSION,
      workspaceId: bridge.workspace.id,
      workspaceRoot: bridge.workspace.root,
      pid: process.pid,
      port: bridge.port,
      adminToken: bridge.adminToken,
      publicUrl: null,
      startedAt: new Date().toISOString(),
    };
    try {
      await adminFetch(runtime, "POST", "/admin/tunnel/start");
      await run(runtime, bridge.workspace.id, tunnel);
    } finally {
      await bridge.close();
      cleanup(root);
      cleanup(authDir);
    }
  }

  it("cleans up when proxy health reports the wrong workspace", async () => {
    await withBridge(async (runtime, workspaceId, tunnel) => {
      const fetchImpl = vi.fn(async () => {
        throw transportError("ECONNREFUSED");
      });
      const detectProxy = vi.fn(async () => ({ host: "127.0.0.1", port: 7890 }));
      const proxyFetch = vi.fn(async () => ({
        status: 200,
        body: JSON.stringify({ service: SERVICE_NAME, status: "ok", workspaceId: "other-ws" }),
      }));
      await expect(
        verifyPublicConnectionOrStop(runtime, PUBLIC_URL, workspaceId, fetchImpl as typeof fetch, {
          detectProxy,
          proxyFetch,
        })
      ).rejects.toThrow(/wrong service or workspace/);
      expect(tunnel.stop).toHaveBeenCalled();
      const info = await adminFetch<{
        publicUrl: string | null;
        tunnel: { running: boolean; url: string | null };
      }>(runtime, "GET", "/admin/info");
      expect(info).toMatchObject({ publicUrl: null, tunnel: { running: false, url: null } });
    });
  });

  it("cleans up when proxy /mcp returns 200", async () => {
    await withBridge(async (runtime, workspaceId, tunnel) => {
      const fetchImpl = vi.fn(async () => {
        throw transportError("ECONNREFUSED");
      });
      const detectProxy = vi.fn(async () => ({ host: "127.0.0.1", port: 7890 }));
      const proxyFetch = vi.fn(async (url: string) => {
        if (url.endsWith("/health")) {
          return {
            status: 200,
            body: JSON.stringify({ service: SERVICE_NAME, status: "ok", workspaceId }),
          };
        }
        return { status: 200, body: "ok" };
      });
      await expect(
        verifyPublicConnectionOrStop(runtime, PUBLIC_URL, workspaceId, fetchImpl as typeof fetch, {
          detectProxy,
          proxyFetch,
        })
      ).rejects.toThrow(/expected OAuth 401/);
      expect(tunnel.stop).toHaveBeenCalled();
    });
  });
});
