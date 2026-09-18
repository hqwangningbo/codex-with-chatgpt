import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { SERVICE_NAME, VERSION } from "../src/version.js";
import { buildProfileFromFlags, writeDevProfile } from "../src/dev/profile.js";
import { captureDevCapability, createDevEnvironment } from "../src/dev/environment.js";
import { dispatchDevTool } from "../src/dev/dispatcher.js";
import {
  findDevObservation,
  ownerIdentityFor,
  probeDevBridge,
  readDevRuntime,
  writeDevRuntime,
} from "../src/dev/runtime.js";
import { parseDevAssistantAction } from "../src/dev/protocol.js";
import { ACTION_CLOSE, ACTION_OPEN } from "../src/web/protocol.js";
import { cleanup, isolateStateDir, makeGitRepo, makeTmpDir, write } from "./helpers.js";

const roots: string[] = [];
const states: string[] = [];
const bridges: ChildProcess[] = [];

afterEach(() => {
  for (const child of bridges.splice(0)) {
    if (child.pid) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
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
    processStartedAt: null,
    commandHash: null,
  });
}

async function persistLive(
  env: ReturnType<typeof createDevEnvironment>,
  opts: {
    healthStartedAt?: string;
    recordedPid?: number;
  } = {}
): Promise<{ child: ChildProcess; port: number }> {
  const scriptDir = makeTmpDir("live-bridge");
  roots.push(scriptDir);
  const scriptFile = path.join(scriptDir, "bridge.cjs");
  fs.writeFileSync(
    scriptFile,
    `
const http = require("node:http");
const server = http.createServer((req, res) => {
  if (req.url !== "/health") {
    res.statusCode = 404;
    res.end();
    return;
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({
    service: process.env.DEV_SERVICE,
    version: process.env.DEV_VERSION,
    status: "ok",
    workspaceId: process.env.DEV_ENV_ID,
    environmentId: process.env.DEV_ENV_ID,
    environmentName: process.env.DEV_ENV_NAME,
    mountCount: 1,
    startedAt: process.env.DEV_HEALTH_STARTED_AT,
  }));
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(JSON.stringify({ port: server.address().port }) + "\\n");
});
`
  );
  const child = spawn(process.execPath, [scriptFile, "serve-dev", "--name", env.name], {
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
    env: {
      ...process.env,
      DEV_SERVICE: SERVICE_NAME,
      DEV_VERSION: VERSION,
      DEV_ENV_ID: env.environmentId,
      DEV_ENV_NAME: env.name,
      DEV_HEALTH_STARTED_AT: opts.healthStartedAt ?? env.startedAt,
    },
  });
  bridges.push(child);
  const port = await new Promise<number>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("live bridge did not bind"));
      }
    }, 5000);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      try {
        const parsed = JSON.parse(chunk.toString("utf8").split("\n")[0]!) as { port: number };
        settled = true;
        clearTimeout(timer);
        resolve(parsed.port);
      } catch (error) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`live bridge exited ${code}`));
    });
  });
  const pid = opts.recordedPid ?? child.pid ?? 0;
  const deadline = Date.now() + 5000;
  let health = await probeDevBridge(port);
  while (!health && Date.now() < deadline) {
    await delay(25);
    health = await probeDevBridge(port);
  }
  if (!health) throw new Error("live bridge health failed");
  let identity = ownerIdentityFor(pid);
  while (Date.now() < deadline && (!identity.processStartedAt || !identity.commandHash)) {
    await delay(25);
    identity = ownerIdentityFor(pid);
  }
  if (!identity.processStartedAt || !identity.commandHash) {
    throw new Error("live bridge owner identity was not available");
  }
  writeDevRuntime({
    service: SERVICE_NAME,
    version: VERSION,
    ...captureDevCapability(env),
    pid,
    port,
    adminToken: "test",
    publicUrl: null,
    status: "running",
    ...identity,
  });
  return { child, port };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnSleeper(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  bridges.push(child);
  return child;
}

async function waitExit(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
  if (child.exitCode !== null || child.signalCode) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("process did not exit")), 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    if (child.pid) {
      try {
        process.kill(child.pid, signal);
      } catch {
        clearTimeout(timer);
        resolve();
      }
    }
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
    await persistLive(env);
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
    await persistLive(env);
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

  async function assertCrossMountSecretDenied(
    env: ReturnType<typeof createDevEnvironment>,
    snapshot: ReturnType<typeof captureDevCapability>,
    needle: string
  ) {
    const envRead = await dispatchDevTool(env, snapshot, {
      tool: "read_file",
      workspace: "research",
      arguments: { path: ".env" },
    });
    expect(envRead.ok).toBe(false);
    expect(JSON.stringify(envRead)).not.toContain(needle);

    const aliasRead = await dispatchDevTool(env, snapshot, {
      tool: "read_file",
      workspace: "contracts",
      arguments: { path: "notes.txt" },
    });
    expect(aliasRead.ok).toBe(false);
    expect(aliasRead.error?.code).toBe("ACCESS_DENIED_SENSITIVE_FILE");
    expect(JSON.stringify(aliasRead)).not.toContain(needle);

    const aliasWrite = await dispatchDevTool(env, snapshot, {
      tool: "write_file",
      workspace: "contracts",
      arguments: { path: "notes.txt", content: "pwn\n" },
    });
    expect(aliasWrite.ok).toBe(false);
    expect(JSON.stringify(aliasWrite)).not.toContain(needle);

    const search = await dispatchDevTool(env, snapshot, {
      tool: "search_workspace",
      workspace: "contracts",
      arguments: { query: needle.slice(0, 8) },
    });
    expect(JSON.stringify(search.result ?? search.error)).not.toContain(needle);

    const diff = await dispatchDevTool(env, snapshot, {
      tool: "git_diff",
      workspace: "contracts",
      arguments: {},
    });
    expect(JSON.stringify(diff.result ?? {})).not.toContain(needle);
  }

  it("rediscovers a .env created after env start and denies the other mount's hardlink", async () => {
    states.push(isolateStateDir());
    const research = repo("research-late", { "docs/a.md": "ok\n" });
    const contracts = repo("contracts-late", { "src/A.sol": "contract A {}\n" });
    const profile = buildProfileFromFlags({
      name: "lateenv",
      mounts: [`research=${research}`, `contracts=${contracts}`],
      mode: "poc",
    });
    const env = createDevEnvironment(profile, new Date().toISOString());
    await persistLive(env);
    const snapshot = captureDevCapability(env);
    const visible = await dispatchDevTool(env, snapshot, {
      tool: "read_file",
      workspace: "research",
      arguments: { path: "docs/a.md" },
    });
    expect(visible.ok).toBe(true);

    write(research, ".env", "PRIVATE_KEY=after-up\n");
    try {
      fs.linkSync(path.join(research, ".env"), path.join(contracts, "notes.txt"));
    } catch {
      return;
    }
    await assertCrossMountSecretDenied(env, snapshot, "PRIVATE_KEY=after-up");

    write(contracts, "dump.mjs", "import fs from 'node:fs';\ntry { process.stdout.write(fs.readFileSync('notes.txt','utf8')) } catch { process.stdout.write('DENIED') }\n");
    const poc = await dispatchDevTool(env, snapshot, {
      tool: "run_poc",
      workspace: "contracts",
      arguments: { program: "node", args: ["dump.mjs"] },
    });
    expect(JSON.stringify(poc.result ?? poc.error)).not.toContain("PRIVATE_KEY=after-up");
  });

  it("rediscovers a replaced .env inode across mounts", async () => {
    states.push(isolateStateDir());
    const research = repo("research-replace", { "docs/a.md": "ok\n" });
    const contracts = repo("contracts-replace", { "src/A.sol": "contract A {}\n" });
    write(research, ".env", "PRIVATE_KEY=old-inode\n");
    const profile = buildProfileFromFlags({
      name: "replaceenv",
      mounts: [`research=${research}`, `contracts=${contracts}`],
      mode: "poc",
    });
    const env = createDevEnvironment(profile, new Date().toISOString());
    await persistLive(env);
    const snapshot = captureDevCapability(env);
    fs.rmSync(path.join(research, ".env"));
    write(research, ".env", "PRIVATE_KEY=new-inode\n");
    try {
      fs.linkSync(path.join(research, ".env"), path.join(contracts, "notes.txt"));
    } catch {
      return;
    }
    await assertCrossMountSecretDenied(env, snapshot, "PRIVATE_KEY=new-inode");
    expect(JSON.stringify(await dispatchDevTool(env, snapshot, {
      tool: "read_file",
      workspace: "contracts",
      arguments: { path: "notes.txt" },
    }))).not.toContain("PRIVATE_KEY=old-inode");
  });

  it("does not leak parent process.env through Dev run_poc", async () => {
    states.push(isolateStateDir());
    const previous = process.env.C2C_SECRET_ENV_TEST;
    process.env.C2C_SECRET_ENV_TEST = "do-not-leak";
    try {
      const contracts = repo("contracts-env", { "src/A.sol": "contract A {}\n" });
      const research = repo("research-env", { "docs/a.md": "ok\n" });
      const profile = buildProfileFromFlags({
        name: "envstrip",
        mounts: [`research=${research}`, `contracts=${contracts}`],
        mode: "poc",
      });
      const env = createDevEnvironment(profile, new Date().toISOString());
      await persistLive(env);
      const snapshot = captureDevCapability(env);
      write(contracts, "dump-env.mjs", "console.log(JSON.stringify(process.env))\n");
      const nodePoc = await dispatchDevTool(env, snapshot, {
        tool: "run_poc",
        workspace: "contracts",
        arguments: { program: "node", args: ["dump-env.mjs"] },
      });
      const nodeText = JSON.stringify(nodePoc.result ?? nodePoc.error);
      expect(nodeText).not.toContain("C2C_SECRET_ENV_TEST");
      expect(nodeText).not.toContain("do-not-leak");
      if (process.platform === "darwin") expect(nodePoc.ok).toBe(true);
      write(contracts, "dump-env.py", "import json,os\nprint(json.dumps(dict(os.environ)))\n");
      const pyPoc = await dispatchDevTool(env, snapshot, {
        tool: "run_poc",
        workspace: "contracts",
        arguments: { program: "python3", args: ["dump-env.py"] },
      });
      const pyText = JSON.stringify(pyPoc.result ?? pyPoc.error);
      expect(pyText).not.toContain("C2C_SECRET_ENV_TEST");
      expect(pyText).not.toContain("do-not-leak");
    } finally {
      if (previous === undefined) delete process.env.C2C_SECRET_ENV_TEST;
      else process.env.C2C_SECRET_ENV_TEST = previous;
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

describe("dev capability liveness", () => {
  it("allows write_file and run_poc while the Bridge is live", async () => {
    states.push(isolateStateDir());
    const research = repo("live-research", { "docs/a.md": "before\n" });
    const contracts = repo("live-contracts", { "src/A.sol": "contract A {}\n" });
    const pocProfile = buildProfileFromFlags({
      name: "liveok",
      mounts: [`research=${research}`, `contracts=${contracts}`],
      mode: "poc",
    });
    const pocEnv = createDevEnvironment(pocProfile, new Date().toISOString());
    await persistLive(pocEnv);
    const pocSnapshot = captureDevCapability(pocEnv);
    expect(await findDevObservation(pocEnv.name)).toMatchObject({ state: "healthy" });

    const written = await dispatchDevTool(pocEnv, pocSnapshot, {
      tool: "write_file",
      workspace: "research",
      arguments: { path: "docs/out.md", content: "after\n" },
    });
    expect(written.ok).toBe(true);
    expect(fs.readFileSync(path.join(research, "docs/out.md"), "utf8")).toBe("after\n");

    write(contracts, "hello.mjs", "console.log('poc-ok')\n");
    const poc = await dispatchDevTool(pocEnv, pocSnapshot, {
      tool: "run_poc",
      workspace: "contracts",
      arguments: { program: "node", args: ["hello.mjs"] },
    });
    expect(poc.ok).toBe(true);
    expect(JSON.stringify(poc.result)).toContain("poc-ok");

    const writeOnly = repo("write-research", { "docs/a.md": "keep\n" });
    const writeContracts = repo("write-contracts", { "src/A.sol": "contract A {}\n" });
    const writeProfile = buildProfileFromFlags({
      name: "livewrite",
      mounts: [`research=${writeOnly}`, `contracts=${writeContracts}`],
      mode: "write",
    });
    const writeEnv = createDevEnvironment(writeProfile, new Date().toISOString());
    await persistLive(writeEnv);
    const writeSnapshot = captureDevCapability(writeEnv);
    write(writeContracts, "hello.mjs", "console.log('should-not-run')\n");
    const denied = await dispatchDevTool(writeEnv, writeSnapshot, {
      tool: "run_poc",
      workspace: "contracts",
      arguments: { program: "node", args: ["hello.mjs"] },
    });
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe("POC_NOT_ALLOWED");
  });

  it("revokes write_file and run_poc after the Bridge is SIGKILL'd with a stale runtime", async () => {
    states.push(isolateStateDir());
    const research = repo("killed-research", { "docs/a.md": "orig\n" });
    const contracts = repo("killed-contracts", { "src/A.sol": "contract A {}\n" });
    const profile = buildProfileFromFlags({
      name: "killed",
      mounts: [`research=${research}`, `contracts=${contracts}`],
      mode: "poc",
    });
    const env = createDevEnvironment(profile, new Date().toISOString());
    const { child } = await persistLive(env);
    const snapshot = captureDevCapability(env);
    const runtime = readDevRuntime(env.name);
    expect(runtime?.status).toBe("running");
    expect(child.pid).toBeTruthy();
    await waitExit(child);
    writeDevRuntime({
      ...runtime!,
      pid: child.pid!,
      status: "running",
    });
    expect(readDevRuntime(env.name)?.status).toBe("running");

    const written = await dispatchDevTool(env, snapshot, {
      tool: "write_file",
      workspace: "research",
      arguments: { path: "docs/a.md", content: "mutated\n" },
    });
    expect(written.ok).toBe(false);
    expect(written.error?.code).toBe("DEV_CAPABILITY_REVOKED");
    expect(fs.readFileSync(path.join(research, "docs/a.md"), "utf8")).toBe("orig\n");

    write(contracts, "touch.mjs", "import fs from 'node:fs'; fs.writeFileSync('POISON', 'x');\n");
    const poc = await dispatchDevTool(env, snapshot, {
      tool: "run_poc",
      workspace: "contracts",
      arguments: { program: "node", args: ["touch.mjs"] },
    });
    expect(poc.ok).toBe(false);
    expect(poc.error?.code).toBe("DEV_CAPABILITY_REVOKED");
    expect(fs.existsSync(path.join(contracts, "POISON"))).toBe(false);
  });

  it("does not treat a restarted session with a new startedAt as healthy", async () => {
    states.push(isolateStateDir());
    const research = repo("session-research", { "docs/a.md": "orig\n" });
    const contracts = repo("session-contracts", { "src/A.sol": "contract A {}\n" });
    const profile = buildProfileFromFlags({
      name: "session",
      mounts: [`research=${research}`, `contracts=${contracts}`],
      mode: "poc",
    });
    const t1 = new Date("2026-01-01T00:00:00.000Z").toISOString();
    const t2 = new Date("2026-01-01T00:01:00.000Z").toISOString();
    const env = createDevEnvironment(profile, t1);
    await persistLive(env, { healthStartedAt: t2 });
    expect(env.startedAt).toBe(t1);
    expect(readDevRuntime(env.name)?.devStartedAt).toBe(t1);
    expect(await findDevObservation(env.name)).toMatchObject({
      state: "unknown",
      reason: "session_mismatch",
    });
  });

  it("revokes mutable actions when the recorded PID is reused by an unrelated process", async () => {
    states.push(isolateStateDir());
    const research = repo("reuse-research", { "docs/a.md": "orig\n" });
    const contracts = repo("reuse-contracts", { "src/A.sol": "contract A {}\n" });
    const profile = buildProfileFromFlags({
      name: "pidreuse",
      mounts: [`research=${research}`, `contracts=${contracts}`],
      mode: "poc",
    });
    const env = createDevEnvironment(profile, new Date().toISOString());
    const sleeper = spawnSleeper();
    if (!sleeper.pid) throw new Error("failed to spawn sleeper");
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try {
        process.kill(sleeper.pid, 0);
        break;
      } catch {
        await delay(20);
      }
    }
    await persistLive(env, { recordedPid: sleeper.pid });
    expect(await findDevObservation(env.name)).toMatchObject({ state: "healthy" });
    const snapshot = captureDevCapability(env);

    const written = await dispatchDevTool(env, snapshot, {
      tool: "write_file",
      workspace: "research",
      arguments: { path: "docs/a.md", content: "mutated\n" },
    });
    expect(written.ok).toBe(false);
    expect(written.error?.code).toBe("DEV_CAPABILITY_REVOKED");
    expect(fs.readFileSync(path.join(research, "docs/a.md"), "utf8")).toBe("orig\n");

    write(contracts, "touch.mjs", "import fs from 'node:fs'; fs.writeFileSync('POISON', 'x');\n");
    const poc = await dispatchDevTool(env, snapshot, {
      tool: "run_poc",
      workspace: "contracts",
      arguments: { program: "node", args: ["touch.mjs"] },
    });
    expect(poc.ok).toBe(false);
    expect(poc.error?.code).toBe("DEV_CAPABILITY_REVOKED");
    expect(fs.existsSync(path.join(contracts, "POISON"))).toBe(false);
  });

  it("revokes mutable actions when the owner command hash does not match", async () => {
    states.push(isolateStateDir());
    const research = repo("hash-research", { "docs/a.md": "orig\n" });
    const contracts = repo("hash-contracts", { "src/A.sol": "contract A {}\n" });
    const profile = buildProfileFromFlags({
      name: "hashmiss",
      mounts: [`research=${research}`, `contracts=${contracts}`],
      mode: "poc",
    });
    const env = createDevEnvironment(profile, new Date().toISOString());
    await persistLive(env);
    const snapshot = captureDevCapability(env);
    const runtime = readDevRuntime(env.name);
    expect(runtime).toBeTruthy();
    writeDevRuntime({
      ...runtime!,
      commandHash: "0".repeat(64),
    });
    expect(await findDevObservation(env.name)).toMatchObject({ state: "healthy" });

    const written = await dispatchDevTool(env, snapshot, {
      tool: "write_file",
      workspace: "research",
      arguments: { path: "docs/a.md", content: "mutated\n" },
    });
    expect(written.ok).toBe(false);
    expect(written.error?.code).toBe("DEV_CAPABILITY_REVOKED");
    expect(fs.readFileSync(path.join(research, "docs/a.md"), "utf8")).toBe("orig\n");

    write(contracts, "touch.mjs", "import fs from 'node:fs'; fs.writeFileSync('POISON', 'x');\n");
    const poc = await dispatchDevTool(env, snapshot, {
      tool: "run_poc",
      workspace: "contracts",
      arguments: { program: "node", args: ["touch.mjs"] },
    });
    expect(poc.ok).toBe(false);
    expect(poc.error?.code).toBe("DEV_CAPABILITY_REVOKED");
    expect(fs.existsSync(path.join(contracts, "POISON"))).toBe(false);
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
