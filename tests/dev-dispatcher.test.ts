import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SERVICE_NAME, VERSION } from "../src/version.js";
import { buildProfileFromFlags, writeDevProfile } from "../src/dev/profile.js";
import { captureDevCapability, createDevEnvironment } from "../src/dev/environment.js";
import { dispatchDevTool } from "../src/dev/dispatcher.js";
import { writeDevRuntime } from "../src/dev/runtime.js";
import { parseDevAssistantAction } from "../src/dev/protocol.js";
import { ACTION_CLOSE, ACTION_OPEN } from "../src/web/protocol.js";
import { cleanup, isolateStateDir, makeGitRepo, makeTmpDir, write } from "./helpers.js";

const roots: string[] = [];
const states: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) cleanup(root);
  for (const dir of states.splice(0)) cleanup(dir);
});

function repo(name: string, files: Record<string, string>): string {
  const root = makeTmpDir(name);
  roots.push(root);
  makeGitRepo(root);
  for (const [rel, content] of Object.entries(files)) write(root, rel, content);
  return fs.realpathSync.native(root);
}

function persist(env: ReturnType<typeof createDevEnvironment>) {
  writeDevRuntime({
    service: SERVICE_NAME,
    version: VERSION,
    ...captureDevCapability(env),
    pid: process.pid,
    port: 1,
    adminToken: "test",
    publicUrl: null,
    status: "running",
  });
}

describe("dev dispatcher cross-repo", () => {
  it("reads and writes both rw mounts and rejects the ro mount", async () => {
    states.push(isolateStateDir());
    const research = repo("research", { "docs/design.md": "design\n" });
    const contracts = repo("contracts", { "src/Reserve.sol": "contract Reserve {}\n" });
    const aave = repo("aave", { "src/Pool.sol": "contract Pool {}\n" });
    const profile = buildProfileFromFlags({
      name: "tbpros",
      mounts: [`research=${research}`, `contracts=${contracts}`],
      readOnly: [`aave=${aave}`],
      mode: "poc",
    });
    const env = createDevEnvironment(profile, new Date().toISOString());
    persist(env);
    const snapshot = captureDevCapability(env);

    const readResearch = await dispatchDevTool(env, snapshot, {
      tool: "read_file",
      workspace: "research",
      arguments: { path: "docs/design.md" },
    });
    expect(readResearch.ok).toBe(true);
    expect(JSON.stringify(readResearch.result)).toContain("design");
    expect(JSON.stringify(readResearch.result)).toContain("workspace://research/");
    expect(JSON.stringify(readResearch.result)).not.toContain(research);

    const readContracts = await dispatchDevTool(env, snapshot, {
      tool: "read_file",
      workspace: "contracts",
      arguments: { path: "src/Reserve.sol" },
    });
    expect(readContracts.ok).toBe(true);
    expect(JSON.stringify(readContracts.result)).toContain("Reserve");

    const writeResearch = await dispatchDevTool(env, snapshot, {
      tool: "write_file",
      workspace: "research",
      arguments: { path: "docs/out.md", content: "updated\n" },
    });
    expect(writeResearch.ok).toBe(true);
    expect(fs.readFileSync(path.join(research, "docs/out.md"), "utf8")).toBe("updated\n");

    const writeContracts = await dispatchDevTool(env, snapshot, {
      tool: "write_file",
      workspace: "contracts",
      arguments: { path: "src/Note.sol", content: "contract Note {}\n" },
    });
    expect(writeContracts.ok).toBe(true);

    const roWrite = await dispatchDevTool(env, snapshot, {
      tool: "write_file",
      workspace: "aave",
      arguments: { path: "src/Hack.sol", content: "nope\n" },
    });
    expect(roWrite.ok).toBe(false);
    expect(roWrite.error?.code).toBe("DEV_WORKSPACE_READ_ONLY");
  });

  it("cannot read unspecified directories via traversal, absolute paths, or cross-mount symlinks", async () => {
    states.push(isolateStateDir());
    const attachedA = repo("attached-a", { "visible.txt": "A\n" });
    const attachedB = repo("attached-b", { "src/A.sol": "contract A {}\n" });
    const secret = repo("not-attached-secret", { "secret.txt": "LEAK\n" });
    fs.symlinkSync(path.join(attachedB, "src"), path.join(attachedA, "link"));
    const profile = buildProfileFromFlags({
      name: "pair",
      mounts: [`alpha=${attachedA}`, `beta=${attachedB}`],
      mode: "write",
    });
    const env = createDevEnvironment(profile, new Date().toISOString());
    persist(env);
    const snapshot = captureDevCapability(env);

    const abs = await dispatchDevTool(env, snapshot, {
      tool: "read_file",
      workspace: "alpha",
      arguments: { path: path.join(secret, "secret.txt") },
    });
    expect(abs.ok).toBe(false);
    expect(JSON.stringify(abs)).not.toContain("LEAK");

    const traversal = await dispatchDevTool(env, snapshot, {
      tool: "read_file",
      workspace: "alpha",
      arguments: { path: `../${path.basename(secret)}/secret.txt` },
    });
    expect(traversal.ok).toBe(false);

    const escaped = await dispatchDevTool(env, snapshot, {
      tool: "read_file",
      workspace: "alpha",
      arguments: { path: "link/A.sol" },
    });
    expect(escaped.ok).toBe(false);
    expect(escaped.error?.code).toBe("PATH_OUTSIDE_WORKSPACE");

    const viaBeta = await dispatchDevTool(env, snapshot, {
      tool: "read_file",
      workspace: "beta",
      arguments: { path: "src/A.sol" },
    });
    expect(viaBeta.ok).toBe(true);
  });

  it("denies .env and cross-mount hardlink aliases on every mount", async () => {
    states.push(isolateStateDir());
    const research = repo("research", { "docs/a.md": "ok\n" });
    const contracts = repo("contracts", { "src/A.sol": "contract A {}\n" });
    write(research, ".env", "PRIVATE_KEY=never\n");
    fs.linkSync(path.join(research, ".env"), path.join(contracts, "notes.txt"));
    const profile = buildProfileFromFlags({
      name: "envpair",
      mounts: [`research=${research}`, `contracts=${contracts}`],
      mode: "poc",
    });
    const env = createDevEnvironment(profile, new Date().toISOString());
    persist(env);
    const snapshot = captureDevCapability(env);

    const envRead = await dispatchDevTool(env, snapshot, {
      tool: "read_file",
      workspace: "research",
      arguments: { path: ".env" },
    });
    expect(envRead.ok).toBe(false);
    expect(envRead.error?.code).toBe("ACCESS_DENIED_SENSITIVE_FILE");

    const envWrite = await dispatchDevTool(env, snapshot, {
      tool: "write_file",
      workspace: "research",
      arguments: { path: ".env", content: "x=1\n" },
    });
    expect(envWrite.ok).toBe(false);

    const aliasRead = await dispatchDevTool(env, snapshot, {
      tool: "read_file",
      workspace: "contracts",
      arguments: { path: "notes.txt" },
    });
    expect(aliasRead.ok).toBe(false);
    expect(aliasRead.error?.code).toBe("ACCESS_DENIED_SENSITIVE_FILE");

    const aliasWrite = await dispatchDevTool(env, snapshot, {
      tool: "write_file",
      workspace: "contracts",
      arguments: { path: "notes.txt", content: "pwn\n" },
    });
    expect(aliasWrite.ok).toBe(false);

    const search = await dispatchDevTool(env, snapshot, {
      tool: "search_workspace",
      workspace: "contracts",
      arguments: { query: "PRIVATE_KEY" },
    });
    expect(JSON.stringify(search.result ?? search.error)).not.toContain("PRIVATE_KEY=never");

    const diff = await dispatchDevTool(env, snapshot, {
      tool: "git_diff",
      workspace: "contracts",
      arguments: {},
    });
    expect(JSON.stringify(diff.result ?? {})).not.toContain("PRIVATE_KEY=never");

    write(contracts, "ok.mjs", "console.log('POC_OK')\n");
    const poc = await dispatchDevTool(env, snapshot, {
      tool: "run_poc",
      workspace: "contracts",
      arguments: { program: "node", args: ["ok.mjs"] },
    });
    if (poc.ok) {
      expect(JSON.stringify(poc.result)).not.toContain("PRIVATE_KEY=never");
    } else {
      expect(poc.error?.code).toBeTruthy();
    }
  });

  it("does not pick up a profile mount added after the session started", async () => {
    states.push(isolateStateDir());
    const research = repo("research", { "a.md": "a\n" });
    const contracts = repo("contracts", { "b.sol": "contract B {}\n" });
    const extra = repo("extra", { "secret.md": "NEW\n" });
    const profile = buildProfileFromFlags({
      name: "freeze",
      mounts: [`research=${research}`, `contracts=${contracts}`],
      mode: "write",
    });
    const env = createDevEnvironment(profile, new Date().toISOString());
    persist(env);
    const snapshot = captureDevCapability(env);
    writeDevProfile(
      buildProfileFromFlags({
        name: "freeze",
        mounts: [`research=${research}`, `contracts=${contracts}`, `extra=${extra}`],
        mode: "write",
      })
    );
    const later = await dispatchDevTool(env, snapshot, {
      tool: "read_file",
      workspace: "extra",
      arguments: { path: "secret.md" },
    });
    expect(later.ok).toBe(false);
    expect(later.error?.code).toBe("DEV_WORKSPACE_NOT_ATTACHED");
  });
});

describe("dev chat protocol", () => {
  it("executes only an exact c2c-web-dev-v1 envelope and requires a workspace alias", () => {
    const sessionId = "c2c_wd_testsessionid";
    const envelope = `${ACTION_OPEN}\n${JSON.stringify({
      protocol: "c2c-web-dev-v1",
      session_id: sessionId,
      workspace: "contracts",
      type: "tool_call",
      call_id: "read-1",
      tool: "read_file",
      arguments: { path: "src/Reserve.sol" },
    })}\n${ACTION_CLOSE}`;
    expect(parseDevAssistantAction(envelope, sessionId, new Set())).toMatchObject({
      ok: true,
      action: { tool: "read_file", workspace: "contracts" },
    });
    expect(parseDevAssistantAction(`note\n${envelope}`, sessionId, new Set())).toEqual({ ok: false, kind: "prose" });
    const missingWs = `${ACTION_OPEN}\n${JSON.stringify({
      protocol: "c2c-web-dev-v1",
      session_id: sessionId,
      type: "tool_call",
      call_id: "read-2",
      tool: "read_file",
      arguments: { path: "src/Reserve.sol" },
    })}\n${ACTION_CLOSE}`;
    expect(parseDevAssistantAction(missingWs, sessionId, new Set())).toMatchObject({
      ok: false,
      kind: "malformed",
    });
  });
});
