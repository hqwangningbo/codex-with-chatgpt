import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { Workspace } from "../src/workspace/manager.js";
import { setWriteScope } from "../src/write-scope/state.js";
import { captureCapabilitySnapshot, dispatchWebTool, type CapabilitySnapshot } from "../src/web/dispatcher.js";
import { WEB_PROTOCOL, type ToolCallAction } from "../src/web/protocol.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

let stateDir: string;
let root: string;
let bridge: Bridge | undefined;
let workspace: Workspace;
let snapshot: CapabilitySnapshot;

function call(tool: ToolCallAction["tool"], args: Record<string, unknown> = {}, callId = tool): ToolCallAction {
  return {
    protocol: WEB_PROTOCOL,
    request_id: "c2c_wr_capability",
    type: "tool_call",
    call_id: callId,
    tool,
    arguments: args,
  };
}

beforeAll(async () => {
  stateDir = isolateStateDir();
  root = makeTmpDir("web-cap");
  fs.mkdirSync(path.join(root, "docs/research"), { recursive: true });
  fs.mkdirSync(path.join(root, "contracts"), { recursive: true });
  write(root, ".env", "PRIVATE_KEY=never\n");
  write(root, "docs/research/a.md", "seed\n");
  write(root, "contracts/A.sol", "contract A {}\n");
  workspace = new Workspace(root);
  bridge = await startBridge({ workspaceRoot: root, port: 0 });
  setWriteScope({
    workspaceId: workspace.id,
    root: "docs/research",
    mode: "write",
    bridgeStartedAt: (await captureCapabilitySnapshot(workspace)).bridgeStartedAt ?? "missing",
  });
  snapshot = await captureCapabilitySnapshot(workspace);
  expect(snapshot.writeActive).toBe(true);
  expect(snapshot.root).toBe("docs/research");
});

afterAll(async () => {
  await bridge?.close();
  if (root) cleanup(root);
  if (stateDir) cleanup(stateDir);
});

describe("web dispatcher capability", () => {
  it("allows write_file inside the active root and denies contracts, .env, and hardlink aliases", async () => {
    const allowed = await dispatchWebTool(
      workspace,
      snapshot,
      call("write_file", { path: "docs/research/out.md", content: "updated\n" }, "write-ok")
    );
    expect(allowed.ok).toBe(true);
    expect(fs.readFileSync(path.join(root, "docs/research/out.md"), "utf8")).toBe("updated\n");

    const outside = await dispatchWebTool(
      workspace,
      snapshot,
      call("write_file", { path: "contracts/A.sol", content: "pwn\n" }, "write-out")
    );
    expect(outside.ok).toBe(false);
    expect(outside.error?.code).toBe("WRITE_SCOPE_VIOLATION");

    const envWrite = await dispatchWebTool(
      workspace,
      snapshot,
      call("write_file", { path: "docs/research/.env", content: "x=1\n" }, "write-env")
    );
    expect(envWrite.ok).toBe(false);
    expect(envWrite.error?.code).toBe("WRITE_DENIED_SENSITIVE_FILE");

    const envRead = await dispatchWebTool(workspace, snapshot, call("read_file", { path: ".env" }, "read-env"));
    expect(envRead.ok).toBe(false);
    expect(envRead.error?.code).toBe("ACCESS_DENIED_SENSITIVE_FILE");

    const alias = path.join(root, "docs/research/notes.txt");
    try {
      fs.linkSync(path.join(root, ".env"), alias);
    } catch {
      return;
    }
    const aliasRead = await dispatchWebTool(
      workspace,
      snapshot,
      call("read_file", { path: "docs/research/notes.txt" }, "read-alias")
    );
    expect(aliasRead.ok).toBe(false);
    expect(aliasRead.error?.code).toBe("ACCESS_DENIED_SENSITIVE_FILE");
    const aliasWrite = await dispatchWebTool(
      workspace,
      snapshot,
      call("write_file", { path: "docs/research/notes.txt", content: "pwn\n" }, "write-alias")
    );
    expect(aliasWrite.ok).toBe(false);
    expect(aliasWrite.error?.code).toBe("WRITE_DENIED_SENSITIVE_FILE");
  });

  it("denies run_poc in write mode and allows it only in poc mode", async () => {
    write(root, "docs/research/ok.mjs", "console.log('POC_OK')\n");
    const denied = await dispatchWebTool(
      workspace,
      snapshot,
      call("run_poc", { program: "node", args: ["docs/research/ok.mjs"] }, "poc-write")
    );
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe("POC_NOT_ALLOWED");

    setWriteScope({
      workspaceId: workspace.id,
      root: "docs/research",
      mode: "poc",
      bridgeStartedAt: snapshot.bridgeStartedAt ?? "missing",
    });
    const pocSnapshot = await captureCapabilitySnapshot(workspace);
    const allowed = await dispatchWebTool(
      workspace,
      pocSnapshot,
      call("run_poc", { program: "node", args: ["docs/research/ok.mjs"] }, "poc-ok")
    );
    if (allowed.ok) {
      expect(String((allowed.result as { stdout?: string }).stdout ?? "")).toContain("POC_OK");
    } else {
      expect(allowed.error?.code).not.toBe("POC_NOT_ALLOWED");
    }

    const envPoc = await dispatchWebTool(
      workspace,
      pocSnapshot,
      call("run_poc", { program: "node", args: [".env"] }, "poc-env")
    );
    expect(envPoc.ok).toBe(false);
    expect(envPoc.error?.code).toMatch(/POC_ARGUMENTS_NOT_ALLOWED|ACCESS_DENIED_SENSITIVE_FILE/);
  });

  it("rejects the next mutable action after the scope is cleared or the Bridge session changes", async () => {
    setWriteScope({
      workspaceId: workspace.id,
      root: "docs/research",
      mode: "poc",
      bridgeStartedAt: snapshot.bridgeStartedAt ?? "missing",
    });
    const live = await captureCapabilitySnapshot(workspace);
    const { clearWriteScope } = await import("../src/write-scope/state.js");
    clearWriteScope(workspace.id);
    const cleared = await dispatchWebTool(
      workspace,
      live,
      call("write_file", { path: "docs/research/b.md", content: "nope\n" }, "after-clear")
    );
    expect(cleared.ok).toBe(false);
    expect(cleared.error?.code).toBe("WEB_CAPABILITY_REVOKED");

    setWriteScope({
      workspaceId: workspace.id,
      root: "docs/research",
      mode: "write",
      bridgeStartedAt: snapshot.bridgeStartedAt ?? "missing",
    });
    const stale: CapabilitySnapshot = { ...live, writeActive: true, bridgeStartedAt: "other-session" };
    const changed = await dispatchWebTool(
      workspace,
      stale,
      call("write_file", { path: "docs/research/c.md", content: "nope\n" }, "stale-bridge")
    );
    expect(changed.ok).toBe(false);
    expect(changed.error?.code).toBe("WEB_CAPABILITY_REVOKED");
  });
});
