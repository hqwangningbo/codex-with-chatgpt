import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { buildProfileFromFlags, tunnelIdentityFor, writeDevProfile } from "../src/dev/profile.js";
import {
  chooseDevNamedTunnel,
  chooseDevQuickTunnel,
  devTunnelChoicePayload,
} from "../src/dev/tunnel.js";
import { isNamedTunnelId, isNamedTunnelReady, needsTunnelChoice, readTunnelState, writeTunnelState } from "../src/tunnel/state.js";
import { suggestedNamedHostname } from "../src/tunnel/hostname.js";
import { tunnelForDevProfile } from "../src/dev/bridge.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "src/cli/index.ts");
const roots: string[] = [];
const states: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) cleanup(root);
  for (const dir of states.splice(0)) cleanup(dir);
});

function repo(name: string): string {
  const root = makeTmpDir(name);
  roots.push(root);
  write(root, "README.md", `${name}\n`);
  return fs.realpathSync.native(root);
}

function saveProfile(name: string) {
  const research = repo(`${name}-research`);
  const profile = buildProfileFromFlags({
    name,
    mounts: [`research=${research}`],
    mode: "poc",
  });
  writeDevProfile(profile);
  return { research, profile };
}

function runCli(args: string[], stateDir: string) {
  return spawnSync(process.execPath, ["--import", "tsx", cliEntry, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, C2C_STATE_DIR: stateDir },
  });
}

describe("dev tunnel identity", () => {
  it("keeps a stable named hostname on the profile identity, not a repo workspace id", async () => {
    const stateDir = isolateStateDir();
    states.push(stateDir);
    const { research, profile } = saveProfile("tbpros");
    const identity = tunnelIdentityFor("tbpros");
    expect(identity).toMatch(/^devp_[0-9a-f]{12}$/);
    expect(identity).not.toBe(new Workspace(research).id);

    const status = devTunnelChoicePayload("tbpros", "example.com");
    expect(status.needsChoice).toBe(true);
    expect(status.namedReady).toBe(false);
    expect(status.implicitQuick).toBe(false);
    expect(status.tunnelIdentity).toBe(identity);
    expect(status.suggestedHostname).toBe(suggestedNamedHostname("example.com", "tbpros", identity));

    const missingZone = await chooseDevNamedTunnel({ name: "tbpros" });
    expect(missingZone.ok).toBe(false);
    if (missingZone.ok) throw new Error("expected zone");
    expect(missingZone.need).toBe("zone");
    expect(missingZone.payload.implicitQuick).toBe(false);

    const first = await chooseDevNamedTunnel({
      name: "tbpros",
      zone: "example.com",
      inspectZone: async (zone) => ({
        zone,
        nameservers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"],
        cloudflareDelegated: true,
        existingRecordTypes: [],
      }),
      provision: async (opts) => {
        const state = writeTunnelState({
          workspaceId: opts.workspaceId,
          preference: "named",
          askedAt: new Date().toISOString(),
          provider: "cloudflare-named",
          tunnelName: `c2c-${opts.workspaceId}`,
          tunnelId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          hostname: suggestedNamedHostname(opts.zone, opts.workspaceName, opts.workspaceId),
          zone: "example.com",
          configuredAt: new Date().toISOString(),
        });
        return { ok: true, fallback: false, state };
      },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected named setup");
    expect(first.state.hostname).toBe(`c2c-tbpros.example.com`);
    expect(isNamedTunnelId(first.state.tunnelId)).toBe(true);
    expect(isNamedTunnelReady(readTunnelState(identity))).toBe(true);
    expect(needsTunnelChoice(readTunnelState(identity))).toBe(false);
    expect(readTunnelState(new Workspace(research).id).preference).toBe("unset");

    const again = await chooseDevNamedTunnel({
      name: "tbpros",
      zone: "example.com",
      inspectZone: async (zone) => ({
        zone,
        nameservers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"],
        cloudflareDelegated: true,
        existingRecordTypes: [],
      }),
      provision: async (opts) => ({
        ok: true,
        fallback: false,
        state: readTunnelState(opts.workspaceId),
      }),
    });
    expect(again.ok).toBe(true);
    if (!again.ok) throw new Error("expected reuse");
    expect(again.state.hostname).toBe(first.state.hostname);
    expect(first.payload.fallback).toBe(false);
    expect(first.payload.implicitQuick).toBe(false);
    expect(tunnelForDevProfile(profile.name).name).toBe("cloudflare-named");

    const cliStatus = runCli(["dev", "tunnel", "status", "tbpros", "--json"], stateDir);
    expect(cliStatus.status).toBe(0);
    expect(JSON.parse(cliStatus.stdout)).toMatchObject({
      ok: true,
      namedReady: true,
      hostname: "c2c-tbpros.example.com",
      implicitQuick: false,
      tunnelIdentity: identity,
    });
  });

  it("does not imply Quick and requires --named or explicit --quick", () => {
    const stateDir = isolateStateDir();
    states.push(stateDir);
    saveProfile("tbpros");
    const missing = runCli(["dev", "tunnel", "choose", "tbpros", "--json"], stateDir);
    expect(missing.status).not.toBe(0);
    expect(missing.stdout).toMatch(/--named/);

    const namedNoZone = runCli(["dev", "tunnel", "choose", "tbpros", "--named", "--json"], stateDir);
    expect(JSON.parse(namedNoZone.stdout)).toMatchObject({ ok: false, need: "zone", implicitQuick: false });

    const setupNoZone = runCli(["dev", "tunnel", "setup", "tbpros", "--json"], stateDir);
    expect(JSON.parse(setupNoZone.stdout)).toMatchObject({ ok: false, need: "zone" });

    chooseDevQuickTunnel("tbpros");
    const afterQuick = devTunnelChoicePayload("tbpros");
    expect(afterQuick.preference).toBe("quick");
    expect(afterQuick.implicitQuick).toBe(false);
    expect(afterQuick.needsChoice).toBe(false);
  });
});
