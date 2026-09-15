import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "src/cli/index.ts");
let stateDir: string;
let codexHome: string;
let workspace: string;

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", cliEntry, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, C2C_STATE_DIR: stateDir, CODEX_HOME: codexHome },
  });
}

beforeAll(() => {
  stateDir = isolateStateDir();
  codexHome = makeTmpDir("manual-setup-codex");
  workspace = makeTmpDir("manual-setup-workspace");
  write(workspace, "README.md", "manual setup\n");
  write(workspace, ".c2c.json", JSON.stringify({ name: "Manual Setup" }));
});

afterAll(() => {
  runCli(["stop", "-w", workspace]);
  cleanup(workspace);
  cleanup(codexHome);
  cleanup(stateDir);
  delete process.env.C2C_STATE_DIR;
});

describe("manual setup", () => {
  it("prepares Connector information without minting pairing credentials or changing Codex config", () => {
    const result = runCli(["setup", "--no-tunnel", "--json", "-w", workspace]);
    expect(result.status, result.stderr).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      manualSetup: true,
      authentication: "OAuth",
      local: true,
    });
    expect(payload.connectorName).toBe("Codex · Manual Setup");
    expect(payload.mcpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(payload).not.toHaveProperty("pairingCode");
    expect(payload).not.toHaveProperty("pairingExpiresAt");
    expect(fs.existsSync(path.join(codexHome, "config.toml"))).toBe(false);
  });
});
