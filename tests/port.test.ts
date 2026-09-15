import { describe, it, expect } from "vitest";
import path from "node:path";
import { startBridge } from "../src/bridge/server.js";
import { probeBridge } from "../src/bridge/runtime.js";
import { makeTmpDir, cleanup, write, isolateStateDir } from "./helpers.js";

describe("port collision handling", () => {
  it("falls back to a free port when the preferred one is taken", async () => {
    isolateStateDir();
    const rootA = makeTmpDir("port-a");
    const rootB = makeTmpDir("port-b");
    write(rootA, "a.txt", "a");
    write(rootB, "b.txt", "b");
    const preferred = 47000 + Math.floor(Math.random() * 1000);

    const bridgeA = await startBridge({
      workspaceRoot: rootA,
      port: preferred,
      persistRuntime: false,
      authStoreFile: path.join(makeTmpDir("auth"), "a.json"),
    });
    const bridgeB = await startBridge({
      workspaceRoot: rootB,
      port: preferred,
      persistRuntime: false,
      authStoreFile: path.join(makeTmpDir("auth"), "b.json"),
    });

    expect(bridgeA.port).toBe(preferred);
    expect(bridgeB.port).not.toBe(preferred);
    expect(bridgeB.port).toBeGreaterThan(0);

    // health identifies each bridge's workspace, so callers can detect reuse
    const healthA = await probeBridge(bridgeA.port);
    const healthB = await probeBridge(bridgeB.port);
    expect(healthA?.workspaceId).toBe(bridgeA.workspace.id);
    expect(healthB?.workspaceId).toBe(bridgeB.workspace.id);
    expect(healthA?.workspaceId).not.toBe(healthB?.workspaceId);

    await bridgeA.close();
    await bridgeB.close();
    cleanup(rootA);
    cleanup(rootB);
  });

  it("refuses to bind non-loopback hosts", async () => {
    const root = makeTmpDir("port-c");
    write(root, "c.txt", "c");
    await expect(
      startBridge({ workspaceRoot: root, host: "0.0.0.0", persistRuntime: false })
    ).rejects.toThrow(/loopback/);
    cleanup(root);
  });

  it("keeps the admin API loopback-only, token-protected, and proxy-proof", async () => {
    const root = makeTmpDir("admin-guard");
    write(root, "a.txt", "a");
    const bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: false,
      authStoreFile: path.join(makeTmpDir("auth"), "admin.json"),
    });
    try {
      const url = `${bridge.localBaseUrl()}/admin/info`;
      expect((await fetch(url)).status).toBe(404);
      expect(
        (
          await fetch(url, {
            headers: {
              authorization: `Bearer ${bridge.adminToken}`,
              "cf-connecting-ip": "203.0.113.10",
            },
          })
        ).status
      ).toBe(404);
      expect(
        (await fetch(url, { headers: { authorization: `Bearer ${bridge.adminToken}` } })).status
      ).toBe(200);
    } finally {
      await bridge.close();
      cleanup(root);
    }
  });
});
