import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { runPoc } from "../src/poc/run.js";
import type { WriteScopeState } from "../src/write-scope/state.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

const roots: string[] = [];

function fixture(mode: "write" | "poc" = "poc") {
  const root = makeTmpDir("poc-sandbox");
  roots.push(root);
  fs.mkdirSync(path.join(root, "test/poc"), { recursive: true });
  write(root, ".env", "PRIVATE_KEY=never-expose\n");
  write(root, ".env.local", "MNEMONIC=never-expose\n");
  const workspace = new Workspace(root);
  const scope: WriteScopeState = {
    workspaceId: workspace.id,
    root: "test/poc",
    mode,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    bridgeStartedAt: "session",
  };
  return { root, workspace, scope };
}

afterEach(() => {
  for (const root of roots.splice(0)) cleanup(root);
});

const macIt = process.platform === "darwin" ? it : it.skip;

describe("runPoc policy", () => {
  it("rejects inactive/write-only scopes and shell programs", async () => {
    const { root, workspace, scope } = fixture("write");
    write(root, "test/poc/ok.mjs", "console.log('ok')\n");
    await expect(
      runPoc({ workspace, scope: null, program: "node", args: [] })
    ).rejects.toMatchObject({ code: "WRITE_SCOPE_NOT_ACTIVE" });
    await expect(
      runPoc({ workspace, scope, program: "node", args: [] })
    ).rejects.toMatchObject({ code: "POC_NOT_ALLOWED" });
    await expect(
      runPoc({ workspace, scope: { ...scope, mode: "poc" }, program: "bash", args: [] })
    ).rejects.toMatchObject({ code: "POC_PROGRAM_NOT_ALLOWED" });
    await expect(
      runPoc({
        workspace,
        scope: { ...scope, mode: "poc" },
        program: "node",
        args: ["-e", "console.log('no')"],
      })
    ).rejects.toMatchObject({ code: "POC_ARGUMENTS_NOT_ALLOWED" });
    await expect(
      runPoc({
        workspace,
        scope: { ...scope, mode: "poc" },
        program: "node",
        args: ["test/poc/ok.mjs"],
        cwd: "../outside",
      })
    ).rejects.toMatchObject({ code: "POC_CWD_NOT_ALLOWED" });
  });

  macIt("refuses forge when foundry.toml enables FFI", async () => {
    const { root, workspace, scope } = fixture();
    write(root, "foundry.toml", "[profile.default]\nffi = true\n");
    await expect(
      runPoc({ workspace, scope, program: "forge", args: ["test"] })
    ).rejects.toMatchObject({ code: "POC_ARGUMENTS_NOT_ALLOWED" });
  });

  macIt("runs allowlisted Node argv without shell expansion and strips secret env", async () => {
    const { root, workspace, scope } = fixture();
    write(
      root,
      "test/poc/argv.mjs",
      "import fs from 'node:fs'; fs.writeFileSync(new URL('./generated.txt',import.meta.url),'ok\\n'); console.log(JSON.stringify({argv:process.argv.slice(2),privateKey:process.env.PRIVATE_KEY,mnemonic:process.env.MNEMONIC,openai:process.env.OPENAI_API_KEY,aws:process.env.AWS_SECRET_ACCESS_KEY,github:process.env.GITHUB_TOKEN}))\n"
    );
    const previous = {
      PRIVATE_KEY: process.env.PRIVATE_KEY,
      MNEMONIC: process.env.MNEMONIC,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    };
    process.env.PRIVATE_KEY = "forbidden";
    process.env.MNEMONIC = "forbidden";
    process.env.OPENAI_API_KEY = "forbidden";
    process.env.AWS_SECRET_ACCESS_KEY = "forbidden";
    process.env.GITHUB_TOKEN = "forbidden";
    try {
      const result = await runPoc({
        workspace,
        scope,
        program: "node",
        args: ["test/poc/argv.mjs", "; rm -rf /", "$(touch nope)", "`touch nope2`"],
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('"; rm -rf /"');
      expect(result.stdout).not.toContain("forbidden");
      expect(fs.existsSync(path.join(root, "nope"))).toBe(false);
      expect(fs.existsSync(path.join(root, "nope2"))).toBe(false);
      expect(fs.readFileSync(path.join(root, "test/poc/generated.txt"), "utf8")).toBe("ok\n");
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  macIt("blocks Node read, write, symlink, and hardlink access to .env", async () => {
    const { root, workspace, scope } = fixture();
    const alias = path.join(root, "test/poc/env-alias");
    fs.linkSync(path.join(root, ".env"), alias);
    fs.symlinkSync(path.join(root, ".env"), path.join(root, "test/poc/env-link"));
    write(
      root,
      "test/poc/env.mjs",
      `import fs from "node:fs";\nimport path from "node:path";\nimport { fileURLToPath } from "node:url";\nconst here=path.dirname(fileURLToPath(import.meta.url));\nconst env=path.resolve(here,"../../.env");\nconst checks=[];\nfor (const [name,fn] of [\n [\"read\",()=>fs.readFileSync(env,\"utf8\")],\n [\"write\",()=>fs.writeFileSync(env,\"changed\")],\n [\"symlink\",()=>fs.readFileSync(path.join(here,\"env-link\"),\"utf8\")],\n [\"alias\",()=>fs.readFileSync(path.join(here,\"env-alias\"),\"utf8\")],\n [\"newlink\",()=>{fs.linkSync(env,path.join(here,\"new-alias\")); return fs.readFileSync(path.join(here,\"new-alias\"),\"utf8\")}],\n]) { try { fn(); checks.push(name+\":ALLOWED\") } catch(e) { checks.push(name+\":\"+e.code) } }\nconsole.log(checks.join(\"\\n\"));\n`
    );
    const result = await runPoc({
      workspace,
      scope,
      program: "node",
      args: ["test/poc/env.mjs"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("ALLOWED");
    expect(result.stdout).not.toContain("never-expose");
    expect(fs.readFileSync(path.join(root, ".env"), "utf8")).toContain("never-expose");
  });

  macIt("blocks Python read and write of .env", async () => {
    const { root, workspace, scope } = fixture();
    write(
      root,
      "test/poc/env.py",
      `from pathlib import Path\np=Path(__file__).resolve().parents[2]/'.env.local'\nfor name,fn in [('read',lambda:p.read_text()),('write',lambda:p.write_text('changed'))]:\n  try:\n    fn(); print(name+':ALLOWED')\n  except Exception as e:\n    print(name+':'+type(e).__name__)\n`
    );
    const result = await runPoc({
      workspace,
      scope,
      program: "python3",
      args: ["test/poc/env.py"],
    });
    expect(result.stdout).not.toContain("ALLOWED");
    expect(result.stdout).not.toContain("never-expose");
    expect(fs.readFileSync(path.join(root, ".env.local"), "utf8")).toContain("never-expose");
  });

  macIt("denies network, enforces timeout, and caps output", async () => {
    const { root, workspace, scope } = fixture();
    write(
      root,
      "test/poc/network.mjs",
      `import net from "node:net";\nconst s=net.connect(9,"127.0.0.1");\ns.on("connect",()=>{console.log("NETWORK_ALLOWED");s.destroy()});\ns.on("error",e=>console.log(e.code));\n`
    );
    const network = await runPoc({
      workspace,
      scope,
      program: "node",
      args: ["test/poc/network.mjs"],
    });
    expect(network.stdout).not.toContain("NETWORK_ALLOWED");
    expect(network.stdout).toMatch(/EPERM|EACCES/);

    write(root, "test/poc/timeout.mjs", "setTimeout(()=>{},10000)\n");
    await expect(
      runPoc({
        workspace,
        scope,
        program: "node",
        args: ["test/poc/timeout.mjs"],
        timeoutMs: 50,
      })
    ).rejects.toMatchObject({ code: "POC_TIMEOUT" });

    write(root, "test/poc/output.mjs", "process.stdout.write('x'.repeat(1100000))\n");
    await expect(
      runPoc({ workspace, scope, program: "node", args: ["test/poc/output.mjs"] })
    ).rejects.toMatchObject({ code: "OUTPUT_LIMIT_EXCEEDED" });
  });
});
