import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { startBridge } from "../src/bridge/server.js";
import { ensureSandboxAllowlist } from "../src/config/sandbox-allow.js";
import { readLastEndpoint } from "../src/config/endpoint.js";
import type { TunnelProvider, TunnelStatus } from "../src/tunnel/provider.js";
import { writeTunnelState } from "../src/tunnel/state.js";
import { SERVICE_NAME } from "../src/version.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "src/cli/index.ts");

class DoctorTunnel implements TunnelProvider {
  readonly name = "cloudflare-named";
  readonly stop = vi.fn(async () => {
    this.running = false;
  });
  private running = false;

  constructor(private readonly url: string) {}

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

async function runDoctor(workspace: string, env: NodeJS.ProcessEnv): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", cliEntry, "doctor", "--json", "-w", workspace],
      { cwd: projectRoot, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

describe("doctor Tunnel repair verification", () => {
  it.each(["unreachable", "wrong-workspace", "wrong-mcp", "ok"] as const)(
    "verifies and conditionally persists the repaired Tunnel: %s",
    async (mode) => {
      const root = makeTmpDir(`doctor-${mode}`);
      const stateDir = makeTmpDir(`doctor-${mode}-state`);
      const codexHome = makeTmpDir(`doctor-${mode}-codex`);
      const authDir = makeTmpDir(`doctor-${mode}-auth`);
      const binDir = makeTmpDir(`doctor-${mode}-bin`);
      write(root, ".c2c.json", JSON.stringify({ name: "Doctor" }));
      const fakeCloudflared = write(binDir, "cloudflared", "#!/bin/sh\nexit 0\n");
      if (process.platform !== "win32") fs.chmodSync(fakeCloudflared, 0o755);

      const previousState = process.env.C2C_STATE_DIR;
      const previousCodex = process.env.CODEX_HOME;
      process.env.C2C_STATE_DIR = stateDir;
      process.env.CODEX_HOME = codexHome;
      ensureSandboxAllowlist();

      let expectedWorkspaceId = "";
      const publicServer = http.createServer((req, res) => {
        if (req.url === "/health") {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({
            service: SERVICE_NAME,
            status: "ok",
            workspaceId: mode === "wrong-workspace" ? "another-workspace" : expectedWorkspaceId,
          }));
          return;
        }
        res.statusCode = mode === "wrong-mcp" ? 200 : 401;
        res.end();
      });
      await new Promise<void>((resolve) => publicServer.listen(0, "127.0.0.1", resolve));
      const address = publicServer.address();
      if (!address || typeof address === "string") throw new Error("test server did not bind");
      const publicUrl = `http://127.0.0.1:${address.port}`;
      const tunnel = new DoctorTunnel(publicUrl);
      const bridge = await startBridge({
        workspaceRoot: root,
        port: 0,
        persistRuntime: true,
        authStoreFile: path.join(authDir, "store.json"),
        tunnelProvider: tunnel,
      });
      expectedWorkspaceId = bridge.workspace.id;
      writeTunnelState({
        workspaceId: bridge.workspace.id,
        preference: "named",
        provider: "cloudflare-named",
        tunnelName: `c2c-${bridge.workspace.id}`,
        tunnelId: "99999999-9999-9999-9999-999999999999",
        hostname: "c2c-doctor.example.com",
      });
      if (mode === "unreachable") {
        await new Promise<void>((resolve) => publicServer.close(() => resolve()));
      }

      try {
        const result = await runDoctor(root, {
          C2C_STATE_DIR: stateDir,
          CODEX_HOME: codexHome,
          C2C_CLOUDFLARED_PATH: fakeCloudflared,
        });
        const payload = JSON.parse(result.stdout);
        if (mode === "ok") {
          expect(result.status, result.stderr || result.stdout).toBe(0);
          expect(payload.report.tunnel).toEqual({ ok: true, detail: publicUrl });
          expect(readLastEndpoint(bridge.workspace.id)?.mcpUrl).toBe(`${publicUrl}/mcp`);
          expect(tunnel.status().running).toBe(true);
        } else {
          expect(result.status).toBe(1);
          expect(payload.report.tunnel.ok).toBe(false);
          expect(readLastEndpoint(bridge.workspace.id)).toBeNull();
          expect(tunnel.status()).toMatchObject({ running: false, url: null });
        }
      } finally {
        await bridge.close();
        if (publicServer.listening) {
          await new Promise<void>((resolve) => publicServer.close(() => resolve()));
        }
        if (previousState === undefined) delete process.env.C2C_STATE_DIR;
        else process.env.C2C_STATE_DIR = previousState;
        if (previousCodex === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = previousCodex;
        cleanup(root);
        cleanup(stateDir);
        cleanup(codexHome);
        cleanup(authDir);
        cleanup(binDir);
      }
    }
  );
});
