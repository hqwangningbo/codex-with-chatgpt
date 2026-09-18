import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import {
  activeWriteScope,
  clearWriteScope,
  setWriteScope,
  writeScopeFile,
  writeScopeInfo,
} from "../src/write-scope/state.js";
import { sha256Bytes, writeFileWithinScope } from "../src/write-scope/write-file.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const roots: string[] = [];

function fixture(rootName = "docs/research") {
  isolateStateDir();
  const root = makeTmpDir("write-scope");
  roots.push(root);
  fs.mkdirSync(path.join(root, rootName), { recursive: true });
  write(root, ".env", "PRIVATE_KEY=never\n");
  write(root, ".env.local", "SECRET=never\n");
  write(root, ".env.production", "SECRET=never\n");
  write(root, ".env.example", "SECRET=example\n");
  write(root, "docs/design/a.md", "design\n");
  write(root, "contracts/Main.sol", "contract Main {}\n");
  const workspace = new Workspace(root);
  const state = setWriteScope({
    workspaceId: workspace.id,
    root: rootName,
    mode: "poc",
    bridgeStartedAt: "session-1",
  });
  return { root, workspace, state };
}

afterEach(() => {
  for (const root of roots.splice(0)) cleanup(root);
});

describe("write scope state", () => {
  it("is active only for the Bridge session and persists with mode 0600", () => {
    const { workspace } = fixture();
    expect(writeScopeInfo(workspace.id, "session-1")).toEqual({
      active: true,
      root: "docs/research",
      mode: "poc",
    });
    expect(activeWriteScope(workspace.id, "other-session")).toBeNull();
    if (process.platform !== "win32") {
      expect(fs.statSync(writeScopeFile(workspace.id)).mode & 0o777).toBe(0o600);
    }
    clearWriteScope(workspace.id);
    expect(writeScopeInfo(workspace.id, "session-1")).toEqual({ active: false });
  });

  it("treats an expired scope as inactive", () => {
    const { workspace } = fixture();
    const file = writeScopeFile(workspace.id);
    const state = JSON.parse(fs.readFileSync(file, "utf8")) as { expiresAt: string };
    state.expiresAt = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(file, JSON.stringify(state));
    expect(activeWriteScope(workspace.id, "session-1")).toBeNull();
  });
});

describe("writeFileWithinScope", () => {
  it("creates nested files only inside an arbitrary Writable Root", async () => {
    const { root, workspace, state } = fixture("contracts/experimental");
    await expect(
      writeFileWithinScope({
        workspace,
        scope: state,
        path: "contracts/experimental/sub/Poc.sol",
        content: "contract Poc {}\n",
      })
    ).resolves.toMatchObject({ path: "contracts/experimental/sub/Poc.sol", created: true });
    expect(fs.readFileSync(path.join(root, "contracts/experimental/sub/Poc.sol"), "utf8")).toContain(
      "contract Poc"
    );
    for (const denied of ["contracts/Main.sol", "test/Main.t.sol", "../outside.txt"]) {
      await expect(
        writeFileWithinScope({ workspace, scope: state, path: denied, content: "x\n" })
      ).rejects.toMatchObject({ code: "WRITE_SCOPE_VIOLATION" });
    }
  });

  it("requires expected_sha256 for existing files", async () => {
    const { root, workspace, state } = fixture();
    write(root, "docs/research/a.md", "old\n");
    await expect(
      writeFileWithinScope({ workspace, scope: state, path: "docs/research/a.md", content: "new\n" })
    ).rejects.toMatchObject({ code: "PRECONDITION_REQUIRED" });
    await expect(
      writeFileWithinScope({
        workspace,
        scope: state,
        path: "docs/research/a.md",
        content: "new\n",
        expectedSha256: "0".repeat(64),
      })
    ).rejects.toMatchObject({ code: "WRITE_PRECONDITION_FAILED" });
    const expectedSha256 = sha256Bytes("old\n");
    await expect(
      writeFileWithinScope({
        workspace,
        scope: state,
        path: "docs/research/a.md",
        content: "new\n",
        expectedSha256,
      })
    ).resolves.toMatchObject({ sha256: sha256Bytes("new\n"), created: false });
  });

  it("rejects every env variant even when Writable Root is the workspace", async () => {
    const { workspace } = fixture();
    const rootScope = setWriteScope({
      workspaceId: workspace.id,
      root: ".",
      mode: "poc",
      bridgeStartedAt: "session-1",
    });
    for (const candidate of [
      ".env",
      ".env.local",
      ".env.production",
      ".env.example",
      "foo/.env",
      "foo/.env.local",
      "foo/bar/.env.secret",
    ]) {
      await expect(
        writeFileWithinScope({ workspace, scope: rootScope, path: candidate, content: "x\n" })
      ).rejects.toMatchObject({ code: "WRITE_DENIED_SENSITIVE_FILE" });
    }
  });

  it("rejects inactive scope, empty writes, and symlink escapes", async () => {
    const { root, workspace, state } = fixture();
    await expect(
      writeFileWithinScope({ workspace, scope: null, path: "docs/research/a.md", content: "x\n" })
    ).rejects.toMatchObject({ code: "WRITE_SCOPE_NOT_ACTIVE" });
    await expect(
      writeFileWithinScope({ workspace, scope: state, path: "docs/research/a.md", content: "" })
    ).rejects.toMatchObject({ code: "EMPTY_OVERWRITE_REQUIRES_EXPLICIT_SUPPORT" });
    if (process.platform !== "win32") {
      fs.symlinkSync(path.join(root, "contracts"), path.join(root, "docs/research/link-source"));
      fs.symlinkSync(path.join(root, ".env"), path.join(root, "docs/research/link-env"));
      const outside = makeTmpDir("write-outside");
      roots.push(outside);
      fs.symlinkSync(outside, path.join(root, "docs/research/link-out"));
      for (const candidate of [
        "docs/research/link-source/Evil.sol",
        "docs/research/link-env",
        "docs/research/link-out/evil.txt",
      ]) {
        await expect(
          writeFileWithinScope({ workspace, scope: state, path: candidate, content: "x\n" })
        ).rejects.toMatchObject({ code: "WRITE_SCOPE_VIOLATION" });
      }
    }
  });
});
