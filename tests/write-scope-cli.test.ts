import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { cleanup, makeTmpDir } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "src/cli/index.ts");
let stateDir: string;
let workspace: string;

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", cliEntry, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, C2C_STATE_DIR: stateDir },
  });
}

beforeAll(() => {
  stateDir = makeTmpDir("write-scope-cli-state");
  workspace = makeTmpDir("write-scope-cli-workspace");
  fs.mkdirSync(path.join(workspace, "docs/research"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "contracts/experimental"), { recursive: true });
});

afterAll(() => {
  runCli(["stop", "--json", "-w", workspace]);
  cleanup(workspace);
  cleanup(stateDir);
});

describe("write-scope CLI", () => {
  it("requires a healthy Bridge and explicit workspace-root/source confirmation", () => {
    const stopped = runCli([
      "write-scope",
      "set",
      "--json",
      "-w",
      workspace,
      "--root",
      "docs/research",
      "--mode",
      "write",
    ]);
    expect(stopped.status).not.toBe(0);

    expect(runCli(["start", "--json", "-w", workspace]).status).toBe(0);
    const rootWithoutFlag = runCli([
      "write-scope",
      "set",
      "--json",
      "-w",
      workspace,
      "--root",
      ".",
      "--mode",
      "poc",
    ]);
    expect(rootWithoutFlag.status).not.toBe(0);

    const sourceWithoutConfirmation = runCli([
      "write-scope",
      "set",
      "--json",
      "-w",
      workspace,
      "--root",
      "contracts/experimental",
      "--mode",
      "write",
    ]);
    expect(sourceWithoutConfirmation.status).not.toBe(0);

    const set = runCli([
      "write-scope",
      "set",
      "--json",
      "-w",
      workspace,
      "--root",
      "contracts/experimental",
      "--mode",
      "write",
      "--yes",
    ]);
    expect(set.status, set.stderr || set.stdout).toBe(0);
    expect(JSON.parse(set.stdout)).toMatchObject({
      active: true,
      root: "contracts/experimental",
      mode: "write",
    });
    expect(JSON.parse(runCli(["status", "--json", "-w", workspace]).stdout)).toMatchObject({
      writeScope: { active: true, root: "contracts/experimental", mode: "write" },
    });

    expect(runCli(["stop", "--json", "-w", workspace]).status).toBe(0);
    expect(JSON.parse(runCli(["write-scope", "status", "--json", "-w", workspace]).stdout)).toMatchObject({
      active: false,
    });
  });

  it("rejects absolute, traversal, and implicit workspace root", () => {
    expect(runCli(["start", "--json", "-w", workspace]).status).toBe(0);
    for (const root of [workspace, "../outside"]) {
      const result = runCli([
        "write-scope",
        "set",
        "--json",
        "-w",
        workspace,
        "--root",
        root,
        "--mode",
        "write",
      ]);
      expect(result.status).not.toBe(0);
    }
    const allowed = runCli([
      "write-scope",
      "set",
      "--json",
      "-w",
      workspace,
      "--root",
      ".",
      "--mode",
      "poc",
      "--allow-workspace-root",
      "--yes",
    ]);
    expect(allowed.status, allowed.stderr || allowed.stdout).toBe(0);
    expect(JSON.parse(allowed.stdout)).toMatchObject({ active: true, root: ".", mode: "poc" });
    expect(runCli(["write-scope", "clear", "--json", "-w", workspace]).status).toBe(0);
  });
});
