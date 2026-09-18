import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SERVICE_NAME, VERSION } from "../src/version.js";
import { startMultiBridge, type MultiBridge } from "../src/multi/bridge.js";
import { buildProfileFromRepos, environmentIdFor, readMultiProfile, writeMultiProfile } from "../src/multi/profile.js";
import { dispatchMultiTool } from "../src/multi/dispatcher.js";
import {
  downMultiEnvironment,
} from "../src/multi/lifecycle.js";
import { ownerIdentityFor, readMultiRuntime, writeMultiRuntime } from "../src/multi/runtime.js";
import { MultiError } from "../src/multi/errors.js";
import { cleanup, isolateStateDir, makeGitRepo, makeTmpDir, write } from "./helpers.js";

const roots: string[] = [];
const states: string[] = [];
const bridges: MultiBridge[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.close().catch(() => undefined);
  for (const child of children.splice(0)) {
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

function repo(name: string, files: Record<string, string> = {}): string {
  const root = makeTmpDir(name);
  roots.push(root);
  makeGitRepo(root);
  for (const [rel, content] of Object.entries(files)) write(root, rel, content);
  return fs.realpathSync.native(root);
}

async function connect(bridge: MultiBridge): Promise<Client> {
  const tokens = bridge.authStore.issueTokens({
    clientId: "multi-test",
    scopes: ["workspace.read", "workspace.search", "git.read"],
  });
  const client = new Client({ name: "c2c-multi-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${tokens.accessToken}` } },
  });
  await client.connect(transport);
  return client;
}

function jsonOf<T>(result: { content?: unknown }): T {
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content?.[0]?.text ?? "{}") as T;
}

describe("multi-repo read-only bridge", () => {
  it("starts three repos, reads them, and does not register writable tools", async () => {
    states.push(isolateStateDir());
    const research = repo("research", { "docs/a.md": "research-ok\n" });
    const contracts = repo("contracts", { "src/Reserve.sol": "contract Reserve {}\n" });
    const dapp = repo("dapp", { "src/app.ts": "export const app = 1;\n" });
    const profile = buildProfileFromRepos({
      name: "tbpros",
      repos: [`research=${research}`, `contracts=${contracts}`, `dapp=${dapp}`],
    });
    writeMultiProfile(profile);
    const authDir = makeTmpDir("auth");
    roots.push(authDir);
    const bridge = await startMultiBridge({
      profile,
      port: 0,
      persistRuntime: false,
      authStoreFile: path.join(authDir, "store.json"),
    });
    bridges.push(bridge);

    const info = await dispatchMultiTool(profile.name, bridge.registry, {
      tool: "environment_info",
      arguments: {},
    });
    expect(info.ok).toBe(true);
    const workspaces = (info.result as { workspaces: Array<{ alias: string; root: string }> }).workspaces;
    expect(workspaces.map((item) => item.alias).sort()).toEqual(["contracts", "dapp", "research"]);
    expect(JSON.stringify(info.result)).not.toContain(research);
    expect(JSON.stringify(info.result)).not.toContain("/Volumes");

    const client = await connect(bridge);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name).sort();
      expect(names).toEqual([
        "environment_info",
        "git_diff",
        "git_status",
        "list_directory",
        "read_file",
        "search_workspace",
        "workspace_info",
      ]);
      expect(names).not.toContain("write_file");
      expect(names).not.toContain("run_poc");
      expect(names).not.toContain("write_scope_info");

      const researchFile = jsonOf<{ content: string }>(
        await client.callTool({ name: "read_file", arguments: { workspace: "research", path: "docs/a.md" } })
      );
      expect(researchFile.content).toContain("research-ok");
      const contractsFile = jsonOf<{ content: string }>(
        await client.callTool({ name: "read_file", arguments: { workspace: "contracts", path: "src/Reserve.sol" } })
      );
      expect(contractsFile.content).toContain("Reserve");
      const dappFile = jsonOf<{ content: string }>(
        await client.callTool({ name: "read_file", arguments: { workspace: "dapp", path: "src/app.ts" } })
      );
      expect(dappFile.content).toContain("export const app");
    } finally {
      await client.close();
    }
  });

  it("hot-adds and removes a repo without changing pid, environmentId, or URL", async () => {
    states.push(isolateStateDir());
    const research = repo("research-hot", { "docs/a.md": "a\n" });
    const contracts = repo("contracts-hot", { "src/A.sol": "contract A {}\n" });
    const dapp = repo("dapp-hot", { "src/app.ts": "export {}\n" });
    const bifrost = repo("bifrost-hot", { "README.md": "bifrost-ok\n" });
    const profile = buildProfileFromRepos({
      name: "hot",
      repos: [`research=${research}`, `contracts=${contracts}`, `dapp=${dapp}`],
    });
    writeMultiProfile(profile);
    const bridge = await startMultiBridge({ profile, port: 0, persistRuntime: false });
    bridges.push(bridge);
    const pid = process.pid;
    const environmentId = bridge.environmentId;
    const local = bridge.localBaseUrl();
    const beforeGen = bridge.registry.generation;

    const added = await fetch(`http://127.0.0.1:${bridge.port}/admin/workspaces/add`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bridge.adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ alias: "bifrost", root: bifrost }),
    });
    expect(added.ok).toBe(true);
    const addedBody = (await added.json()) as { generation: number; environmentId: string };
    expect(addedBody.environmentId).toBe(environmentId);
    expect(addedBody.generation).toBe(beforeGen + 1);
    expect(process.pid).toBe(pid);
    expect(bridge.localBaseUrl()).toBe(local);
    expect(bridge.environmentId).toBe(environmentId);
    expect(readMultiProfile("hot")?.repos.bifrost).toBeTruthy();

    const client = await connect(bridge);
    try {
      const file = jsonOf<{ content: string }>(
        await client.callTool({ name: "read_file", arguments: { workspace: "bifrost", path: "README.md" } })
      );
      expect(file.content).toContain("bifrost-ok");

      const removed = await fetch(`http://127.0.0.1:${bridge.port}/admin/workspaces/remove`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bridge.adminToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ alias: "bifrost" }),
      });
      expect(removed.ok).toBe(true);
      expect(bridge.environmentId).toBe(environmentId);
      expect(bridge.localBaseUrl()).toBe(local);
      expect(process.pid).toBe(pid);
      const gone = await client.callTool({
        name: "read_file",
        arguments: { workspace: "bifrost", path: "README.md" },
      });
      expect(jsonOf<{ error: string }>(gone).error).toBe("MULTI_WORKSPACE_NOT_ATTACHED");
      expect(readMultiProfile("hot")?.repos.bifrost).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it("denies unmounted siblings, absolute paths, and cross-repo symlinks", async () => {
    states.push(isolateStateDir());
    const research = repo("iso-research", { "visible.txt": "ok\n" });
    const contracts = repo("iso-contracts", { "src/A.sol": "contract A {}\n" });
    const secret = repo("iso-secret", { "secret.txt": "LEAK\n" });
    fs.symlinkSync(path.join(contracts, "src"), path.join(research, "link"));
    const profile = buildProfileFromRepos({
      name: "iso",
      repos: [`research=${research}`, `contracts=${contracts}`],
    });
    const bridge = await startMultiBridge({ profile, port: 0, persistRuntime: false });
    bridges.push(bridge);

    const abs = await dispatchMultiTool("iso", bridge.registry, {
      tool: "read_file",
      workspace: "research",
      arguments: { path: path.join(secret, "secret.txt") },
    });
    expect(abs.ok).toBe(false);
    expect(JSON.stringify(abs)).not.toContain("LEAK");

    const missing = await dispatchMultiTool("iso", bridge.registry, {
      tool: "read_file",
      workspace: "secret",
      arguments: { path: "secret.txt" },
    });
    expect(missing.error?.code).toBe("MULTI_WORKSPACE_NOT_ATTACHED");

    const linked = await dispatchMultiTool("iso", bridge.registry, {
      tool: "read_file",
      workspace: "research",
      arguments: { path: "link/A.sol" },
    });
    expect(linked.ok).toBe(false);
    expect(linked.error?.code).toBe("PATH_OUTSIDE_WORKSPACE");
  });

  it("denies .env on every repo, including late files, hardlinks, and dynamic add", async () => {
    states.push(isolateStateDir());
    const research = repo("env-research", { "docs/a.md": "ok\n" });
    const contracts = repo("env-contracts", { "src/A.sol": "contract A {}\n" });
    write(research, ".env", "PRIVATE_KEY=never\n");
    const profile = buildProfileFromRepos({
      name: "envpair",
      repos: [`research=${research}`, `contracts=${contracts}`],
    });
    const bridge = await startMultiBridge({ profile, port: 0, persistRuntime: false });
    bridges.push(bridge);

    const envRead = await dispatchMultiTool("envpair", bridge.registry, {
      tool: "read_file",
      workspace: "research",
      arguments: { path: ".env" },
    });
    expect(envRead.error?.code).toBe("ACCESS_DENIED_SENSITIVE_FILE");

    const extra = repo("env-extra");
    write(extra, ".env", "PRIVATE_KEY=added\n");
    try {
      fs.linkSync(path.join(extra, ".env"), path.join(extra, "notes.txt"));
    } catch {
      return;
    }
    await bridge.registry.add("extra", extra);
    const extraEnv = await dispatchMultiTool("envpair", bridge.registry, {
      tool: "read_file",
      workspace: "extra",
      arguments: { path: "notes.txt" },
    });
    expect(extraEnv.error?.code).toBe("ACCESS_DENIED_SENSITIVE_FILE");

    write(research, ".env.late", "PRIVATE_KEY=after-up\n");
    try {
      fs.linkSync(path.join(research, ".env.late"), path.join(contracts, "notes.txt"));
    } catch {
      return;
    }
    const late = await dispatchMultiTool("envpair", bridge.registry, {
      tool: "read_file",
      workspace: "contracts",
      arguments: { path: "notes.txt" },
    });
    expect(late.error?.code).toBe("ACCESS_DENIED_SENSITIVE_FILE");
  });

  it("rolls back live add when profile persist fails", async () => {
    states.push(isolateStateDir());
    const research = repo("rb-research", { "a.md": "a\n" });
    const contracts = repo("rb-contracts", { "b.sol": "contract B {}\n" });
    const extra = repo("rb-extra", { "c.md": "c\n" });
    const profile = buildProfileFromRepos({
      name: "rollback",
      repos: [`research=${research}`, `contracts=${contracts}`],
    });
    writeMultiProfile(profile);
    let fail = false;
    const bridge = await startMultiBridge({
      profile,
      port: 0,
      persistRuntime: false,
      persistProfile: (next) => {
        if (fail) throw new Error("disk full");
        writeMultiProfile(next);
      },
    });
    bridges.push(bridge);
    fail = true;
    const added = await fetch(`http://127.0.0.1:${bridge.port}/admin/workspaces/add`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bridge.adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ alias: "extra", root: extra }),
    });
    expect(added.ok).toBe(false);
    expect(bridge.registry.has("extra")).toBe(false);
    expect(readMultiProfile("rollback")?.repos.extra).toBeUndefined();
    const still = await dispatchMultiTool("rollback", bridge.registry, {
      tool: "read_file",
      workspace: "research",
      arguments: { path: "a.md" },
    });
    expect(still.ok).toBe(true);
  });

  it("hides roots on /health and requires OAuth for /mcp", async () => {
    states.push(isolateStateDir());
    const research = repo("pub-research", { "a.md": "a\n" });
    const contracts = repo("pub-contracts", { "b.sol": "x\n" });
    const profile = buildProfileFromRepos({
      name: "public",
      repos: [`research=${research}`, `contracts=${contracts}`],
    });
    const bridge = await startMultiBridge({ profile, port: 0, persistRuntime: false });
    bridges.push(bridge);
    const health = await fetch(`${bridge.localBaseUrl()}/health`);
    const body = (await health.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      service: SERVICE_NAME,
      status: "ok",
      environmentId: environmentIdFor(profile.profileId),
      environmentName: "public",
      repoCount: 2,
    });
    expect(JSON.stringify(body)).not.toContain(research);
    expect(JSON.stringify(body)).not.toContain(contracts);
    expect(body).not.toHaveProperty("version");
    expect(Object.keys(body).sort()).toEqual([
      "environmentId",
      "environmentName",
      "repoCount",
      "service",
      "startedAt",
      "status",
    ]);

    const mcp = await fetch(`${bridge.localBaseUrl()}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
    });
    expect(mcp.status).toBe(401);
  });

  it("rejects overlapping and forbidden roots", () => {
    states.push(isolateStateDir());
    const research = repo("ov-research");
    const nested = path.join(research, "contracts");
    fs.mkdirSync(nested, { recursive: true });
    expect(() =>
      buildProfileFromRepos({
        name: "overlap",
        repos: [`research=${research}`, `contracts=${nested}`],
      })
    ).toThrow(MultiError);
    try {
      buildProfileFromRepos({
        name: "overlap",
        repos: [`research=${research}`, `contracts=${nested}`],
      });
    } catch (error) {
      expect((error as MultiError).code).toBe("MULTI_REPO_OVERLAP");
    }
  });

  it("keeps the saved profile after a proven down", async () => {
    states.push(isolateStateDir());
    const research = repo("dn-research");
    const contracts = repo("dn-contracts");
    const profile = buildProfileFromRepos({
      name: "downed",
      repos: [`research=${research}`, `contracts=${contracts}`],
    });
    writeMultiProfile(profile);
    const startedAt = new Date().toISOString();
    const environmentId = environmentIdFor(profile.profileId);
    const adminToken = "c2c_admin_test_downed";
    const scriptDir = makeTmpDir("fake-multi");
    roots.push(scriptDir);
    const scriptFile = path.join(scriptDir, "bridge.cjs");
    fs.writeFileSync(
      scriptFile,
      `
const http = require("node:http");
const server = http.createServer((req, res) => {
  const json = (code, body) => {
    res.statusCode = code;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  };
  if (req.url === "/health") {
    json(200, {
      service: process.env.MULTI_SERVICE,
      status: "ok",
      environmentId: process.env.MULTI_ENV_ID,
      environmentName: process.env.MULTI_ENV_NAME,
      repoCount: 2,
      startedAt: process.env.MULTI_STARTED_AT,
    });
    return;
  }
  const auth = req.headers.authorization || "";
  if (auth !== "Bearer " + process.env.MULTI_ADMIN) {
    json(404, {});
    return;
  }
  if (req.url === "/admin/info" && req.method === "GET") {
    json(200, { environmentId: process.env.MULTI_ENV_ID, pid: process.pid, startedAt: process.env.MULTI_STARTED_AT });
    return;
  }
  if (req.url === "/admin/shutdown" && req.method === "POST") {
    json(200, { shuttingDown: true });
    server.close(() => process.exit(0));
    return;
  }
  if (req.url === "/admin/tunnel/stop" || req.url === "/admin/revoke-all") {
    json(200, { ok: true });
    return;
  }
  json(404, {});
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(JSON.stringify({ port: server.address().port }) + "\\n");
});
`
    );
    const child = spawn(process.execPath, [scriptFile, "serve-multi", "--name", "downed"], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      env: {
        ...process.env,
        MULTI_SERVICE: SERVICE_NAME,
        MULTI_VERSION: VERSION,
        MULTI_ENV_ID: environmentId,
        MULTI_ENV_NAME: "downed",
        MULTI_STARTED_AT: startedAt,
        MULTI_ADMIN: adminToken,
      },
    });
    children.push(child);
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("fake multi did not bind")), 5000);
      child.stdout?.on("data", (chunk: Buffer) => {
        clearTimeout(timer);
        resolve((JSON.parse(chunk.toString("utf8").split("\n")[0]!) as { port: number }).port);
      });
      child.on("exit", (code) => reject(new Error(`exited ${code}`)));
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const pid = child.pid!;
    const deadline = Date.now() + 3000;
    let identity = ownerIdentityFor(pid);
    while (Date.now() < deadline && (!identity.processStartedAt || !identity.commandHash)) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      identity = ownerIdentityFor(pid);
    }
    writeMultiRuntime({
      service: SERVICE_NAME,
      version: VERSION,
      environmentId,
      environmentName: "downed",
      profileId: profile.profileId,
      startedAt,
      generation: 0,
      aliases: ["contracts", "research"],
      pid,
      port,
      adminToken,
      publicUrl: "https://c2c-downed.example.test",
      status: "running",
      ...identity,
    });
    const down = await downMultiEnvironment("downed");
    expect(down.stopped).toBe(true);
    expect(down.profilePreserved).toBe(true);
    expect(readMultiProfile("downed")?.profileId).toBe(profile.profileId);
    expect(readMultiRuntime("downed")).toBeNull();
  });
});
