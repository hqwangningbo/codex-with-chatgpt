import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DevError } from "../src/dev/errors.js";
import {
  assertAlias,
  canonicalizeMountRoot,
  parseAliasPath,
} from "../src/dev/mounts.js";
import {
  buildProfileFromFlags,
  environmentIdFor,
  profileHash,
  resolveUpProfile,
  writeDevProfile,
} from "../src/dev/profile.js";
import { environmentInfoResult } from "../src/dev/dispatcher.js";
import { captureDevCapability, createDevEnvironment } from "../src/dev/environment.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";
import { getStateDir } from "../src/config/paths.js";

const roots: string[] = [];
const states: string[] = [];

function repo(name: string): string {
  const root = makeTmpDir(name);
  roots.push(root);
  write(root, "README.md", `${name}\n`);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) cleanup(root);
  for (const dir of states.splice(0)) cleanup(dir);
});

describe("dev mount validation", () => {
  it("accepts two rw repos and one ro repo and hides absolute paths in environment_info", () => {
    states.push(isolateStateDir());
    const research = repo("research");
    const contracts = repo("contracts");
    const aave = repo("aave");
    const profile = buildProfileFromFlags({
      name: "tbpros",
      mounts: [`research=${research}`, `contracts=${contracts}`],
      readOnly: [`aave=${aave}`],
      mode: "poc",
    });
    expect(profile.mounts.research.access).toBe("rw");
    expect(profile.mounts.contracts.writeRoot).toBe(".");
    expect(profile.mounts.aave.access).toBe("ro");
    const env = createDevEnvironment(profile, new Date().toISOString());
    const info = environmentInfoResult(env) as {
      name: string;
      workspaces: Array<{ alias: string; root: string; access: string; mode: string }>;
    };
    expect(info.name).toBe("tbpros");
    expect(info.workspaces.map((item) => item.alias).sort()).toEqual(["aave", "contracts", "research"]);
    expect(JSON.stringify(info)).not.toContain(research);
    expect(JSON.stringify(info)).not.toContain("/Volumes");
    expect(info.workspaces.find((item) => item.alias === "aave")).toMatchObject({
      root: "workspace://aave/",
      access: "ro",
      mode: "read-only",
    });
    expect(info.workspaces.find((item) => item.alias === "contracts")).toMatchObject({
      access: "rw",
      mode: "poc",
    });
  });

  it("denies duplicate aliases, same realpath, nested roots, and home/root/state", () => {
    states.push(isolateStateDir());
    const research = repo("research");
    const nested = path.join(research, "contracts");
    fs.mkdirSync(nested, { recursive: true });
    expect(() => assertAlias("workspace")).toThrow(DevError);
    expect(() => parseAliasPath("nope")).toThrow(DevError);
    try {
      buildProfileFromFlags({
        name: "dup",
        mounts: [`research=${research}`, `research=${research}`],
      });
      throw new Error("expected duplicate");
    } catch (error) {
      expect((error as DevError).code).toBe("DEV_DUPLICATE_ALIAS");
    }
    try {
      buildProfileFromFlags({
        name: "same",
        mounts: [`a=${research}`, `b=${research}`],
      });
      throw new Error("expected overlap");
    } catch (error) {
      expect((error as DevError).code).toBe("DEV_MOUNT_OVERLAP");
    }
    try {
      buildProfileFromFlags({
        name: "nested",
        mounts: [`a=${research}`, `b=${nested}`],
      });
      throw new Error("expected nested");
    } catch (error) {
      expect((error as DevError).code).toBe("DEV_MOUNT_OVERLAP");
    }
    expect(() => canonicalizeMountRoot("/")).toThrow(DevError);
    expect(() => canonicalizeMountRoot(os.homedir())).toThrow(DevError);
    expect(() => canonicalizeMountRoot(getStateDir())).toThrow(DevError);
  });

  it("does not silently overwrite a saved profile", () => {
    states.push(isolateStateDir());
    const research = repo("research");
    const contracts = repo("contracts");
    writeDevProfile(
      buildProfileFromFlags({
        name: "tbpros",
        mounts: [`research=${research}`],
        mode: "write",
      })
    );
    try {
      resolveUpProfile({
        name: "tbpros",
        mounts: [`research=${research}`, `contracts=${contracts}`],
        mode: "poc",
      });
      throw new Error("expected exists");
    } catch (error) {
      expect((error as DevError).code).toBe("DEV_PROFILE_EXISTS");
    }
    const saved = resolveUpProfile({
      name: "tbpros",
      mounts: [`research=${research}`, `contracts=${contracts}`],
      mode: "poc",
      save: true,
    });
    expect(saved.saved).toBe(true);
    expect(Object.keys(saved.profile.mounts).sort()).toEqual(["contracts", "research"]);
    const reused = resolveUpProfile({ name: "tbpros" });
    expect(reused.profile.mode).toBe("poc");
    expect(profileHash(reused.profile)).toBe(profileHash(saved.profile));
    expect(environmentIdFor(reused.profile)).toMatch(/^c2c_de_/);
  });

  it("freezes capability identity from aliases, roots, and mode", () => {
    states.push(isolateStateDir());
    const research = repo("research");
    const contracts = repo("contracts");
    const profile = buildProfileFromFlags({
      name: "tbpros",
      mounts: [`research=${research}`, `contracts=${contracts}`],
      mode: "poc",
    });
    const env = createDevEnvironment(profile, "t0");
    const snapshot = captureDevCapability(env);
    expect(snapshot.profileHash).toBe(profileHash(profile));
    expect(snapshot.mounts.map((item) => item.alias).sort()).toEqual(["contracts", "research"]);
    const widened = buildProfileFromFlags({
      name: "tbpros",
      mounts: [`research=${research}`, `contracts=${contracts}`, `extra=${repo("extra")}`],
      mode: "poc",
    });
    expect(environmentIdFor(widened)).not.toBe(environmentIdFor(profile));
  });
});
