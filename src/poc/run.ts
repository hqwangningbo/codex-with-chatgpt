import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Workspace } from "../workspace/manager.js";
import { sanitizeExecutionOutput } from "../execution/sanitize.js";
import type { WriteScopeState } from "../write-scope/state.js";
import { isWriteDenied } from "../write-scope/policy.js";
import { createPocSandbox, PocSandboxError, type PocSandbox } from "./sandbox.js";

export type PocErrorCode =
  | "WRITE_SCOPE_NOT_ACTIVE"
  | "POC_NOT_ALLOWED"
  | "POC_PROGRAM_NOT_ALLOWED"
  | "POC_ARGUMENTS_NOT_ALLOWED"
  | "POC_CWD_NOT_ALLOWED"
  | "POC_SANDBOX_UNAVAILABLE"
  | "POC_ENV_ISOLATION_UNAVAILABLE"
  | "POC_TIMEOUT"
  | "OUTPUT_LIMIT_EXCEEDED";

export class PocError extends Error {
  constructor(
    public readonly code: PocErrorCode,
    message: string
  ) {
    super(message);
    this.name = "PocError";
  }
}

export interface RunPocResult {
  program: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

const PROGRAMS = new Set(["forge", "cast", "python3", "node", "bun"]);
const MAX_OUTPUT_BYTES = 1024 * 1024;

function installedSolcExecutables(): string[] {
  const root = path.join(os.homedir(), ".svm");
  const found: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(candidate);
      else if (entry.isFile() && /^solc(?:-|$)/.test(entry.name)) {
        try {
          if ((fs.statSync(candidate).mode & 0o111) !== 0) {
            found.push(fs.realpathSync.native(candidate));
          }
        } catch {
          // Ignore racing or unreadable compiler entries.
        }
      }
    }
  }
  return found;
}

function failSandbox(error: unknown): never {
  if (error instanceof PocSandboxError) throw new PocError(error.code, error.message);
  throw error;
}

function resolveExecutable(program: string): string {
  if (!PROGRAMS.has(program)) {
    throw new PocError("POC_PROGRAM_NOT_ALLOWED", `Program '${program}' is not allowlisted`);
  }
  const home = os.homedir();
  const candidates: Record<string, string[]> = {
    node: [process.execPath, "/opt/homebrew/bin/node", "/usr/local/bin/node"],
    python3: ["/usr/bin/python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3"],
    forge: [path.join(home, ".foundry/bin/forge"), "/opt/homebrew/bin/forge", "/usr/local/bin/forge"],
    cast: [path.join(home, ".foundry/bin/cast"), "/opt/homebrew/bin/cast", "/usr/local/bin/cast"],
    bun: [path.join(home, ".bun/bin/bun"), "/opt/homebrew/bin/bun", "/usr/local/bin/bun"],
  };
  for (const candidate of candidates[program] ?? []) {
    try {
      const real = fs.realpathSync.native(candidate);
      if (fs.statSync(real).isFile()) return real;
    } catch {
      // Try the next fixed location.
    }
  }
  throw new PocError("POC_PROGRAM_NOT_ALLOWED", `Allowlisted program '${program}' was not found`);
}

function relativeInside(root: string, candidate: string): string | null {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
    ? rel.split(path.sep).join("/") || "."
    : null;
}

function resolveCwd(workspace: Workspace, scope: WriteScopeState, requested?: string): {
  abs: string;
  rel: string;
} {
  const cwd = requested ?? ".";
  if (path.isAbsolute(cwd) || cwd.replace(/\\/g, "/").split("/").includes("..")) {
    throw new PocError("POC_CWD_NOT_ALLOWED", "cwd must be Workspace-relative");
  }
  const resolved = workspace.resolve(cwd, { allowSensitive: true });
  if (isWriteDenied(resolved.rel) || workspace.ignoreRules.isSensitive(resolved.rel)) {
    throw new PocError("POC_CWD_NOT_ALLOWED", "cwd matches the sensitive-file policy");
  }
  const writeRoot = path.resolve(workspace.root, scope.root);
  if (resolved.abs !== workspace.root && relativeInside(writeRoot, resolved.abs) === null) {
    throw new PocError("POC_CWD_NOT_ALLOWED", "cwd must be the Workspace root or inside Writable Root");
  }
  if (!fs.statSync(resolved.abs).isDirectory()) {
    throw new PocError("POC_CWD_NOT_ALLOWED", "cwd is not a directory");
  }
  return { abs: resolved.abs, rel: resolved.rel || "." };
}

function assertScriptInsideWriteRoot(
  workspace: Workspace,
  scope: WriteScopeState,
  script: string
): void {
  if (!script || script.startsWith("-") || path.isAbsolute(script)) {
    throw new PocError("POC_ARGUMENTS_NOT_ALLOWED", "A Workspace-relative script file is required");
  }
  const resolved = workspace.resolve(script);
  if (isWriteDenied(resolved.rel) || workspace.ignoreRules.isSensitive(resolved.rel)) {
    throw new PocError("POC_ARGUMENTS_NOT_ALLOWED", "Script matches the sensitive-file policy");
  }
  const writeRoot = path.resolve(workspace.root, scope.root);
  if (relativeInside(writeRoot, resolved.abs) === null || !fs.statSync(resolved.abs).isFile()) {
    throw new PocError("POC_ARGUMENTS_NOT_ALLOWED", "Script must be a file inside Writable Root");
  }
}

function validateForge(workspace: Workspace, scope: WriteScopeState, args: string[]): string[] {
  if (args[0] !== "test") {
    throw new PocError("POC_ARGUMENTS_NOT_ALLOWED", "forge only supports the test subcommand");
  }
  try {
    const foundry = fs.readFileSync(workspace.resolve("foundry.toml").abs, "utf8");
    if (/^\s*ffi\s*=\s*true\b/im.test(foundry)) {
      throw new PocError("POC_ARGUMENTS_NOT_ALLOWED", "Foundry FFI is enabled and POC execution is refused");
    }
  } catch (error) {
    if (error instanceof PocError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const valueFlags = new Set(["--match-path", "--match-test", "--match-contract"]);
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (/^-v{1,4}$/.test(arg)) continue;
    const [flag, inline] = arg.split("=", 2);
    if (!valueFlags.has(flag)) {
      throw new PocError("POC_ARGUMENTS_NOT_ALLOWED", `forge argument '${arg}' is not allowed`);
    }
    const value = inline ?? args[++index];
    if (!value || value.startsWith("-")) {
      throw new PocError("POC_ARGUMENTS_NOT_ALLOWED", `${flag} requires a value`);
    }
    if (flag === "--match-path") assertScriptInsideWriteRoot(workspace, scope, value);
  }
  return [...args];
}

function validateArgs(
  workspace: Workspace,
  scope: WriteScopeState,
  program: string,
  args: string[]
): string[] {
  if (args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    throw new PocError("POC_ARGUMENTS_NOT_ALLOWED", "Arguments must be plain strings");
  }
  if (program === "forge") return validateForge(workspace, scope, args);
  if (program === "node" || program === "python3" || program === "bun") {
    const forbidden = new Set([
      "-e",
      "--eval",
      "-p",
      "--print",
      "-c",
      "-m",
      "-r",
      "--require",
      "--import",
    ]);
    if (args.some((arg) => forbidden.has(arg) || [...forbidden].some((flag) => arg.startsWith(`${flag}=`)))) {
      throw new PocError("POC_ARGUMENTS_NOT_ALLOWED", "Inline code and preload options are not allowed");
    }
    assertScriptInsideWriteRoot(workspace, scope, args[0]);
  }
  return [...args];
}

function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals = "SIGTERM"): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The child already exited.
    }
  }
}

async function spawnSandboxed(
  profileFile: string,
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/sandbox-exec", ["-f", profileFile, executable, ...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString("utf8")}`.slice(0, 4000);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(0, 4000);
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function sandboxPreflight(profileFile: string, env: NodeJS.ProcessEnv): Promise<void> {
  const result = await spawnSandboxed(profileFile, "/bin/echo", ["c2c-sandbox-ok"], env, os.tmpdir());
  if (result.code !== 0) {
    throw new PocSandboxError(
      "POC_SANDBOX_UNAVAILABLE",
      `sandbox preflight failed (${result.code}): ${result.stderr.slice(0, 400)}`
    );
  }
}

async function assertEnvIsolation(
  workspace: Workspace,
  sandbox: PocSandbox,
  executable: string
): Promise<void> {
  const envFile = path.join(workspace.root, ".env");
  if (!fs.existsSync(envFile)) return;
  const base = path.basename(executable);
  const probe = path.join(sandbox.pocDir, `env-probe-${process.pid}`);
  let args: string[];
  if (base === "node" || base === "bun") {
    fs.writeFileSync(
      `${probe}.mjs`,
      "import fs from 'node:fs'; try { const t=fs.readFileSync(process.argv[2],'utf8'); if(t) process.stdout.write('ENV_LEAKED') } catch { process.stdout.write('DENIED') }\n",
      { mode: 0o600 }
    );
    args = [`${probe}.mjs`, envFile];
  } else if (base === "python3") {
    fs.writeFileSync(
      `${probe}.py`,
      "import pathlib,sys\np=pathlib.Path(sys.argv[1])\ntry:\n t=p.read_text()\n print('ENV_LEAKED' if t else 'DENIED')\nexcept Exception:\n print('DENIED')\n",
      { mode: 0o600 }
    );
    args = [`${probe}.py`, envFile];
  } else {
    return;
  }
  const result = await spawnSandboxed(sandbox.profileFile, executable, args, sandbox.env, sandbox.pocDir);
  fs.rmSync(`${probe}.mjs`, { force: true });
  fs.rmSync(`${probe}.py`, { force: true });
  if (result.stdout.includes("ENV_LEAKED")) {
    throw new PocSandboxError(
      "POC_ENV_ISOLATION_UNAVAILABLE",
      "POC sandbox could not prevent .env access"
    );
  }
}

export async function runPoc(input: {
  workspace: Workspace;
  scope: WriteScopeState | null;
  program: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
}): Promise<RunPocResult> {
  if (!input.scope) throw new PocError("WRITE_SCOPE_NOT_ACTIVE", "Writable Scope is not active");
  if (input.scope.mode !== "poc") throw new PocError("POC_NOT_ALLOWED", "Writable Scope mode is not poc");
  const executable = resolveExecutable(input.program);
  const args = validateArgs(input.workspace, input.scope, input.program, input.args);
  const cwd = resolveCwd(input.workspace, input.scope, input.cwd);
  const timeoutMs = Math.min(120_000, Math.max(1, input.timeoutMs ?? 30_000));

  let sandbox;
  try {
    sandbox = createPocSandbox({
      workspace: input.workspace,
      scope: input.scope,
      executable,
      extraExecutables: [
        "/bin/echo",
        ...(input.program === "forge" ? installedSolcExecutables() : []),
      ],
    });
    await sandboxPreflight(sandbox.profileFile, sandbox.env);
    await assertEnvIsolation(input.workspace, sandbox, executable);
  } catch (error) {
    failSandbox(error);
  }

  const started = Date.now();
  try {
    return await new Promise<RunPocResult>((resolve, reject) => {
      const child = spawn(
        "/usr/bin/sandbox-exec",
        ["-f", sandbox.profileFile, executable, ...args],
        {
          cwd: cwd.abs,
          env: sandbox.env,
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
          windowsHide: true,
        }
      );
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let exceeded = false;
      let timedOut = false;
      let forceTimer: NodeJS.Timeout | null = null;
      const terminate = (): void => {
        killProcessGroup(child.pid);
        forceTimer ??= setTimeout(() => killProcessGroup(child.pid, "SIGKILL"), 500);
      };
      const append = (
        current: Buffer<ArrayBufferLike>,
        chunk: Buffer<ArrayBufferLike>
      ): Buffer<ArrayBufferLike> => {
        const next = Buffer.concat([current, chunk]);
        if (next.length > MAX_OUTPUT_BYTES) {
          exceeded = true;
          terminate();
          return next.subarray(0, MAX_OUTPUT_BYTES);
        }
        return next;
      };
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout = append(stdout, chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = append(stderr, chunk);
      });
      const timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutMs);
      child.on("error", (error) => {
        clearTimeout(timer);
        if (forceTimer) clearTimeout(forceTimer);
        reject(new PocError("POC_SANDBOX_UNAVAILABLE", error.message));
      });
      child.on("exit", (exitCode, signal) => {
        clearTimeout(timer);
        if (forceTimer) clearTimeout(forceTimer);
        if (exceeded) {
          reject(new PocError("OUTPUT_LIMIT_EXCEEDED", "POC output exceeded 1 MiB"));
          return;
        }
        if (timedOut) {
          reject(new PocError("POC_TIMEOUT", `POC exceeded ${timeoutMs}ms`));
          return;
        }
        const out = sanitizeExecutionOutput(stdout.toString("utf8"));
        const err = sanitizeExecutionOutput(stderr.toString("utf8"));
        resolve({
          program: input.program,
          args,
          cwd: cwd.rel,
          exitCode,
          signal,
          durationMs: Date.now() - started,
          stdout: out.allowed ? out.text : "",
          stderr: err.allowed ? err.text : "",
          truncated:
            (out.allowed ? out.truncated : true) || (err.allowed ? err.truncated : true),
        });
      });
    });
  } finally {
    sandbox.cleanup();
  }
}
