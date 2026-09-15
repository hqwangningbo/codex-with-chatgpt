import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string): string => fs.readFileSync(path.join(root, file), "utf8");

describe("secure operational policy", () => {
  it("pins every declared dependency to the verified lockfile version", () => {
    const pkg = JSON.parse(read("package.json")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    for (const [name, version] of Object.entries({
      ...pkg.dependencies,
      ...pkg.devDependencies,
    })) {
      expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect(pkg.dependencies["@modelcontextprotocol/sdk"]).toBe("1.30.0");
    expect(read("pnpm-workspace.yaml")).toContain("qs: 6.16.0");
  });

  it("keeps the ordinary update check notification-only", () => {
    const skill = read("skill/SKILL.md");
    const ordinary = skill.split("## Update checks")[1]
      .split("Only an explicit")[0];
    expect(ordinary).toContain("notification-only");
    expect(ordinary).toContain("Do not fetch, pull, install, build, or restart");
    expect(ordinary).not.toMatch(
      /^\s*\d+\.\s*`(?:git (?:pull|fetch)|(?:pnpm|npm|yarn|bun|brew|winget) install|c2c sandbox-allow)/m
    );
  });

  it("requires a clean, reviewed, fast-forward-only explicit update", () => {
    const skill = read("skill/SKILL.md");
    const update = skill.split("Only an explicit")[1]
      .split("## First-time setup")[0];
    expect(update).toContain("starts a reviewable update");
    expect(update).toContain("git status --porcelain");
    expect(update).toContain("git fetch origin main");
    expect(update).toContain("git merge --ff-only origin/main");
    expect(update).toContain("corepack pnpm install --frozen-lockfile");
    expect(update).toContain("Never use `git pull`");
  });

  it("does not let setup or doctor silently write Codex config", () => {
    const cli = read("src/cli/index.ts");
    const setup = cli.split("// ---------------------------------------------------------------- setup")[1]
      .split("// ---------------------------------------------------------------- stop / restart")[0];
    const doctor = cli.split("// ---------------------------------------------------------------- doctor")[1]
      .split("// ---------------------------------------------------------------- pair")[0];
    expect(setup).not.toContain("trySandboxAllow()");
    expect(setup).toContain("inspectSandboxAllow()");
    expect(doctor).not.toContain("trySandboxAllow()");
    expect(cli).toContain('.option("--yes", "confirm the disclosed config.toml change", false)');
  });

  it("routes doctor Tunnel repair through verified public checks", () => {
    const cli = read("src/cli/index.ts");
    const doctor = cli.split("// ---------------------------------------------------------------- doctor")[1]
      .split("// ---------------------------------------------------------------- pair")[0];
    expect(doctor).toContain("startTunnelAndVerify(runtime, info.workspaceId)");
    expect(doctor).toContain("verifyPublicConnectionOrStop(runtime, currentUrl, info.workspaceId)");
    expect(doctor).not.toMatch(/started\.url[\s\S]{0,120}healthy\s*=\s*true/);
  });

  it("does not describe an unverified local Tunnel process as healthy", () => {
    const cli = read("src/cli/index.ts");
    const status = cli.split("// ---------------------------------------------------------------- status")[1]
      .split("// ---------------------------------------------------------------- doctor")[0];
    expect(status).toContain("verified: false");
    expect(status).toContain("Tunnel：running");
    expect(status).not.toContain("Tunnel：healthy");
  });

  it("contains no executable ChatGPT page automation or conversation state", () => {
    const runtimePolicy = [
      read("skill/SKILL.md"),
      read("src/cli/index.ts"),
      read("src/config/endpoint.ts"),
      read("src/prompt/generate.ts"),
    ].join("\n");
    expect(runtimePolicy).not.toMatch(
      /chatgpt\.com|\biab\b|Playwright|Computer Use|markHandoff|markDeliverable|tabs\.new|\.goto\(|waitFor/
    );
    expect(runtimePolicy).not.toContain('.command("session")');
    expect(fs.existsSync(path.join(root, "src/session/state.ts"))).toBe(false);
    expect(fs.existsSync(path.join(root, "src/config/ui-prefs.ts"))).toBe(false);
  });
});
