import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { startBridge } from "../src/bridge/server.js";
import type { RuntimeState } from "../src/bridge/runtime.js";
import { adminFetch, verifyPublicConnectionOrStop } from "../src/process/daemon.js";
import type { TunnelProvider, TunnelStatus } from "../src/tunnel/provider.js";
import { SERVICE_NAME, VERSION } from "../src/version.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

class FakeTunnel implements TunnelProvider {
  readonly name = "fake";
  readonly stop = vi.fn(async () => {
    this.running = false;
  });
  private running = false;
  private readonly url = "https://c2c-test.example.com";

  async start(): Promise<string> {
    this.running = true;
    return this.url;
  }

  async restart(): Promise<string> {
    await this.stop();
    return this.start();
  }

  status(): TunnelStatus {
    return { running: this.running, url: this.running ? this.url : null, provider: this.name };
  }

  getPublicUrl(): string | null {
    return this.running ? this.url : null;
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

describe("public Tunnel verification cleanup", () => {
  it.each(["unreachable", "wrong-service", "wrong-workspace", "wrong-mcp"] as const)(
    "stops and clears the Tunnel after %s verification failure",
    async (failure) => {
      const root = makeTmpDir("tunnel-cleanup");
      const authDir = makeTmpDir("tunnel-cleanup-auth");
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
        const started = await adminFetch<{ url: string }>(runtime, "POST", "/admin/tunnel/start");
        const fetchImpl = vi.fn(async (input: string | URL) => {
          if (failure === "unreachable") throw new Error("unreachable");
          if (String(input).endsWith("/health")) {
            return new Response(
              JSON.stringify({
                service: failure === "wrong-service" ? "other-service" : SERVICE_NAME,
                status: "ok",
                workspaceId: failure === "wrong-workspace" ? "wrong-workspace" : bridge.workspace.id,
              }),
              { status: 200 }
            );
          }
          return new Response("wrong service", { status: 200 });
        });
        await expect(
          verifyPublicConnectionOrStop(runtime, started.url, bridge.workspace.id, fetchImpl as typeof fetch)
        ).rejects.toThrow();
        expect(tunnel.stop).toHaveBeenCalled();
        const info = await adminFetch<{
          publicUrl: string | null;
          tunnel: { running: boolean; url: string | null };
        }>(runtime, "GET", "/admin/info");
        expect(info).toMatchObject({ publicUrl: null, tunnel: { running: false, url: null } });
      } finally {
        await bridge.close();
        cleanup(root);
        cleanup(authDir);
      }
    }
  );
});
