import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Workspace, WorkspaceError } from "../src/workspace/manager.js";
import { makeTmpDir, cleanup, write } from "./helpers.js";

let root: string;
let outside: string;
let ws: Workspace;
let symlinksReady: boolean;

beforeAll(() => {
  root = makeTmpDir("ws");
  outside = makeTmpDir("outside");
  write(root, "hello.txt", "hello world\n");
  write(root, "src/app.ts", "const x = 1;\n");
  write(root, ".env", "SECRET=topsecret\n");
  write(root, ".env.production", "SECRET=prod\n");
  write(root, ".env.example", "SECRET=changeme\n");
  write(root, "certs/server.pem", "PRIVATE KEY\n");
  write(root, "keys/id_rsa", "PRIVATE KEY\n");
  write(root, "nested/.ssh/config", "Host *\n");
  write(outside, "secret.txt", "outside data\n");
  write(root, ".c2cignore", "private-notes/\n");
  write(root, "private-notes/todo.md", "secret notes\n");
  // symlink pointing outside the workspace (needs symlink privileges, e.g.
  // absent for unprivileged Windows runners — the escape tests then skip)
  symlinksReady = true;
  try {
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link-out.txt"));
    fs.symlinkSync(outside, path.join(root, "dir-out"));
  } catch {
    symlinksReady = false;
  }
  ws = new Workspace(root);
});

afterAll(() => {
  cleanup(root);
  cleanup(outside);
});

describe("path containment", () => {
  it("reads a normal relative path", async () => {
    const result = await ws.readFile("hello.txt");
    expect(result.content).toContain("hello world");
  });

  it("rejects ../ traversal", () => {
    for (const candidate of [
      "../secret",
      "../../.ssh",
      "/etc/passwd",
      "~/.ssh/id_ed25519",
      "C:\\Users\\xxx\\.ssh",
      "workspace:/../secret",
    ]) {
      expect(() => ws.resolve(candidate), candidate).toThrowError(WorkspaceError);
    }
    try {
      ws.resolve("a/../../b");
    } catch (error) {
      expect((error as WorkspaceError).code).toBe("PATH_OUTSIDE_WORKSPACE");
    }
  });

  it("rejects absolute paths outside the workspace", () => {
    expect(() => ws.resolve("/etc/passwd")).toThrowError(WorkspaceError);
    expect(() => ws.resolve(outside)).toThrowError(WorkspaceError);
  });

  it("allows absolute paths inside the workspace", () => {
    const resolved = ws.resolve(path.join(root, "hello.txt"));
    expect(resolved.rel).toBe("hello.txt");
  });

  it("rejects windows-style traversal", () => {
    expect(() => ws.resolve("..\\..\\etc\\passwd")).toThrowError(WorkspaceError);
  });

  it("rejects null bytes", () => {
    expect(() => ws.resolve("hello.txt\0.png")).toThrowError(WorkspaceError);
  });

  it("rejects symlinked file escaping the workspace", () => {
    if (!symlinksReady) return; // symlink privilege unavailable
    try {
      ws.resolve("link-out.txt");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as WorkspaceError).code).toBe("PATH_OUTSIDE_WORKSPACE");
    }
  });

  it("rejects paths through a symlinked directory escaping the workspace", () => {
    if (!symlinksReady) return; // symlink privilege unavailable
    try {
      ws.resolve("dir-out/secret.txt");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as WorkspaceError).code).toBe("PATH_OUTSIDE_WORKSPACE");
    }
  });
});

describe("sensitive files", () => {
  const expectDenied = (p: string): void => {
    try {
      ws.resolve(p);
      expect.unreachable(`expected ${p} to be denied`);
    } catch (error) {
      expect((error as WorkspaceError).code).toBe("ACCESS_DENIED_SENSITIVE_FILE");
    }
  };

  it("denies .env and variants", () => {
    expectDenied(".env");
    expectDenied(".env.production");
  });

  it("denies a hardlink alias of .env with an ordinary name", async () => {
    const alias = path.join(root, "notes-plain.txt");
    try {
      fs.linkSync(path.join(root, ".env"), alias);
    } catch {
      return;
    }
    write(root, ".env", "PASSWORD=plain-value\nDATABASE_URL=plain-value\n");
    const fresh = new Workspace(root);
    try {
      fresh.resolve("notes-plain.txt");
      expect.unreachable("hardlink alias should be denied");
    } catch (error) {
      expect((error as WorkspaceError).code).toBe("ACCESS_DENIED_SENSITIVE_FILE");
    }
    await expect(fresh.readFile("notes-plain.txt")).rejects.toMatchObject({
      code: "ACCESS_DENIED_SENSITIVE_FILE",
    });
  });

  it("rediscovers a .env created after Workspace construction via nlink", async () => {
    const lateRoot = makeTmpDir("ws-late-env");
    try {
      write(lateRoot, "visible.txt", "ok\n");
      const late = new Workspace(lateRoot);
      expect((await late.readFile("visible.txt")).content).toContain("ok");
      write(lateRoot, ".env", "SECRET=after-construct\n");
      const alias = path.join(lateRoot, "later.txt");
      try {
        fs.linkSync(path.join(lateRoot, ".env"), alias);
      } catch {
        return;
      }
      await expect(late.readFile("later.txt")).rejects.toMatchObject({
        code: "ACCESS_DENIED_SENSITIVE_FILE",
      });
    } finally {
      cleanup(lateRoot);
    }
  });

  it("allows .env.example", () => {
    expect(ws.resolve(".env.example").rel).toBe(".env.example");
  });

  it("denies keys and certificates", () => {
    expectDenied("certs/server.pem");
    expectDenied("keys/id_rsa");
  });

  it("denies Web3 wallet and secret paths", () => {
    for (const candidate of [
      "wallet/account.json",
      "wallets/alice.json",
      "keystore/key.json",
      "keystores/key.json",
      "mnemonic.txt",
      "seed-phrase.txt",
      "private_key.txt",
      "deploy-secrets/mainnet.json",
      "foundry.keystore",
      "cast-wallet-prod",
    ]) {
      expectDenied(candidate);
    }
  });

  it("denies .ssh directories anywhere", () => {
    expectDenied("nested/.ssh/config");
  });

  it("honors .c2cignore custom rules", () => {
    expectDenied("private-notes/todo.md");
  });

  it("hides sensitive files from directory listing", async () => {
    const listing = await ws.listDirectory(".", { limit: 500, depth: 2 });
    const paths = listing.entries.map((entry) => entry.path);
    expect(paths).toContain("hello.txt");
    expect(paths).not.toContain(".env");
    expect(paths.some((p) => p.includes("private-notes"))).toBe(false);
  });
});

describe("read_file pagination", () => {
  it("caps unbounded reads at 400 lines and reports the remainder", async () => {
    const big = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    write(root, "big.txt", big);
    const result = await ws.readFile("big.txt");
    expect(result.totalLines).toBe(1000);
    expect(result.endLine).toBe(400);
    expect(result.truncated).toBe(true);
    expect(result.remainingLines).toBe(600);
    expect(result.nextStartLine).toBe(401);
    expect(result.writable_sha256).toBeNull();
  });

  it("issues writable_sha256 only for a complete read", async () => {
    const complete = await ws.readFile("hello.txt");
    expect(complete.truncated).toBe(false);
    expect(complete.writable_sha256).toEqual(expect.stringMatching(/^[0-9a-f]{64}$/));
    expect(complete.writable_sha256).not.toBe(complete.sha256);
  });

  it("returns an explicit range", async () => {
    const result = await ws.readFile("big.txt", { startLine: 500, endLine: 502 });
    expect(result.content).toBe("line 500\nline 501\nline 502");
    expect(result.startLine).toBe(500);
    expect(result.endLine).toBe(502);
  });

  it("denies binary files", async () => {
    fs.writeFileSync(path.join(root, "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
    await expect(ws.readFile("blob.bin")).rejects.toMatchObject({ code: "BINARY_FILE" });
  });

  it("reports FILE_NOT_FOUND for missing files", async () => {
    await expect(ws.readFile("nope.txt")).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
  });

  it("rejects private-key blocks and redacts obvious secrets in safe-named files", async () => {
    write(root, "notes.txt", "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n");
    await expect(ws.readFile("notes.txt")).rejects.toMatchObject({
      code: "ACCESS_DENIED_SENSITIVE_FILE",
    });

    const key = `0x${"a".repeat(64)}`;
    write(root, "config.example.ts", `const private_key = "${key}";\nconst hash = "${key}";\n`);
    const result = await ws.readFile("config.example.ts");
    expect(result.content).not.toContain(`private_key = "${key}"`);
    expect(result.content).toContain("[REDACTED]");
  });
});

describe("workspace identity", () => {
  it("has a stable id and name", () => {
    const again = new Workspace(root);
    expect(again.id).toBe(ws.id);
    expect(ws.id).toMatch(/^[a-f0-9]{12}$/);
    expect(ws.name).toBe(path.basename(root));
  });

  it("reads .c2c.json project name", () => {
    const named = makeTmpDir("named");
    write(
      named,
      ".c2c.json",
      JSON.stringify({
        name: "Remi",
      })
    );
    const namedWs = new Workspace(named);
    expect(namedWs.name).toBe("Remi");
    cleanup(named);
  });

  it("falls back to the directory name when .c2c.json has invalid types", () => {
    const invalid = makeTmpDir("invalid-project-config");
    write(invalid, ".c2c.json", JSON.stringify({ name: 42, maxIterations: "many" }));

    const invalidWs = new Workspace(invalid);

    expect(invalidWs.name).toBe(path.basename(invalid));
    expect(invalidWs.projectConfig).toEqual({});
    cleanup(invalid);
  });

  it("filters invalid package script values during project detection", () => {
    const projectRoot = makeTmpDir("invalid-package-scripts");
    write(
      projectRoot,
      "package.json",
      JSON.stringify({
        name: "demo",
        scripts: { test: "vitest run", invalid: 42 },
        dependencies: { react: "^19.0.0" },
      })
    );

    const project = new Workspace(projectRoot).detectProject();

    expect(project.scripts).toEqual({ test: "vitest run" });
    expect(project.frameworks).toContain("React");
    cleanup(projectRoot);
  });
});
