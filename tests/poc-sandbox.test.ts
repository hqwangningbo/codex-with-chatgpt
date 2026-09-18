import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { runPoc } from "../src/poc/run.js";
import { createPocSandbox, isUnsafeSandboxReadRoot, runtimeReadRoots } from "../src/poc/sandbox.js";
import type { WriteScopeState } from "../src/write-scope/state.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

const ENV_PLAIN = "PASSWORD=plain-value\nDATABASE_URL=plain-value\n";
const roots: string[] = [];

function fixture(mode: "write" | "poc" = "poc") {
  const root = makeTmpDir("poc-sandbox");
  roots.push(root);
  fs.mkdirSync(path.join(root, "test/poc"), { recursive: true });
  write(root, ".env", ENV_PLAIN);
  write(root, ".env.local", ENV_PLAIN);
  write(root, "visible.txt", "WORKSPACE_MARKER\n");
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

const probeScript = `import fs from "node:fs";
const target = process.argv[2];
const mode = process.argv[3];
try {
  if (mode === "read") process.stdout.write(fs.readFileSync(target, "utf8"));
  else {
    fs.writeFileSync(target, "pwned\\n");
    process.stdout.write("WRITE_ALLOWED");
  }
} catch (e) {
  process.stdout.write("DENIED:" + (e.code || "ERR"));
}
`;

describe("POC sandbox read roots", () => {
  it("never derives a filesystem-wide read root from /bin/echo", () => {
    const executables = [process.execPath];
    if (fs.existsSync("/bin/echo")) executables.push("/bin/echo");
    const rootsFound = runtimeReadRoots(executables);
    expect(rootsFound.some((root) => isUnsafeSandboxReadRoot(root))).toBe(false);
    expect(rootsFound).not.toContain("/");
    expect(rootsFound).not.toContain("/private");
  });
});

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
      runPoc({
        workspace,
        scope: { ...scope, mode: "poc" },
        program: "bash",
        args: [],
      })
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

  macIt("does not emit a filesystem-wide Seatbelt read allow", () => {
    const { workspace, scope } = fixture();
    const sandbox = createPocSandbox({
      workspace,
      scope,
      executable: process.execPath,
      extraExecutables: ["/bin/echo"],
    });
    try {
      const profile = fs.readFileSync(sandbox.profileFile, "utf8");
      expect(profile).not.toMatch(/\(subpath\s+"\/"\)/);
      expect(profile).not.toMatch(/\(subpath\s+"\/private"\)/);
      expect(profile).toContain(`(subpath ${JSON.stringify(path.join(workspace.root, "test/poc"))}`);
    } finally {
      sandbox.cleanup();
    }
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

  macIt("confines reads and writes to Workspace / Writable Root", async () => {
    const { root, workspace, scope } = fixture();
    const outsideDir = makeTmpDir("poc-outside");
    roots.push(outsideDir);
    const outside = write(outsideDir, "secret.txt", "OUTSIDE_MARKER\n");
    write(root, "test/poc/probe.mjs", probeScript);
    try {
      const outsideRead = await runPoc({
        workspace,
        scope,
        program: "node",
        args: ["test/poc/probe.mjs", outside, "read"],
      });
      expect(outsideRead.stdout).toMatch(/^DENIED:/);
      expect(outsideRead.stdout).not.toContain("OUTSIDE_MARKER");

      const outsideWrite = await runPoc({
        workspace,
        scope,
        program: "node",
        args: ["test/poc/probe.mjs", outside, "write"],
      });
      expect(outsideWrite.stdout).toMatch(/^DENIED:/);
      expect(fs.readFileSync(outside, "utf8")).toBe("OUTSIDE_MARKER\n");

      const insideWrite = await runPoc({
        workspace,
        scope,
        program: "node",
        args: ["test/poc/probe.mjs", path.join(root, "test/poc/artifact.txt"), "write"],
      });
      expect(insideWrite.stdout).toBe("WRITE_ALLOWED");
      expect(fs.readFileSync(path.join(root, "test/poc/artifact.txt"), "utf8")).toBe("pwned\n");

      const workspaceRead = await runPoc({
        workspace,
        scope,
        program: "node",
        args: ["test/poc/probe.mjs", path.join(root, "visible.txt"), "read"],
      });
      expect(workspaceRead.stdout).toContain("WORKSPACE_MARKER");

      const workspaceWrite = await runPoc({
        workspace,
        scope,
        program: "node",
        args: ["test/poc/probe.mjs", path.join(root, "visible.txt"), "write"],
      });
      expect(workspaceWrite.stdout).toMatch(/^DENIED:/);
      expect(fs.readFileSync(path.join(root, "visible.txt"), "utf8")).toBe("WORKSPACE_MARKER\n");
    } finally {
      fs.rmSync(outside, { force: true });
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
      `import fs from "node:fs";\nimport path from "node:path";\nimport { fileURLToPath } from "node:url";\nconst here=path.dirname(fileURLToPath(import.meta.url));\nconst env=path.resolve(here,"../../.env");\nconst alias=path.join(here,"env-alias");\nconst checks=[];\nfor (const [name,fn] of [\n ["read",()=>fs.readFileSync(env,"utf8")],\n ["write",()=>fs.writeFileSync(env,"changed")],\n ["symlink",()=>fs.readFileSync(path.join(here,"env-link"),"utf8")],\n ["alias",()=>fs.readFileSync(alias,"utf8")],\n ["aliasWrite",()=>fs.writeFileSync(alias,"changed")],\n ["newlink",()=>{fs.linkSync(env,path.join(here,"new-alias")); return fs.readFileSync(path.join(here,"new-alias"),"utf8")}],\n]) { try { fn(); checks.push(name+":ALLOWED") } catch(e) { checks.push(name+":"+e.code) } }\nconsole.log(checks.join("\\n"));\n`
    );
    const result = await runPoc({
      workspace,
      scope,
      program: "node",
      args: ["test/poc/env.mjs"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("ALLOWED");
    expect(result.stdout).not.toContain("PASSWORD=plain-value");
    expect(result.stdout).not.toContain("DATABASE_URL=plain-value");
    expect(fs.readFileSync(path.join(root, ".env"), "utf8")).toBe(ENV_PLAIN);
    expect(fs.readFileSync(alias, "utf8")).toBe(ENV_PLAIN);
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
    expect(result.stdout).not.toContain("PASSWORD=plain-value");
    expect(fs.readFileSync(path.join(root, ".env.local"), "utf8")).toBe(ENV_PLAIN);
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
