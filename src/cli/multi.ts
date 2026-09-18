import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import { MultiError } from "../multi/errors.js";
import { readMultiProfile, resolveUpProfile } from "../multi/profile.js";
import {
  addMultiRepo,
  addressMultiEnvironment,
  downMultiEnvironment,
  listMultiRepos,
  removeMultiRepo,
  statusMultiEnvironment,
  upMultiEnvironment,
} from "../multi/lifecycle.js";
import { assertProfileName } from "../multi/mounts.js";
import { multiTunnelChoicePayload, setupMultiNamedTunnel } from "../multi/tunnel.js";
import { NAMED_LOGIN_PROMPT } from "../tunnel/state.js";

interface CliHelpers {
  say: (msg: string) => void;
  check: (msg: string) => void;
  handleCliError: (error: unknown, json: boolean) => void;
}

function collectRepo(value: string, previous: string[]): string[] {
  if (!value.includes("=")) {
    throw new InvalidArgumentError("expected alias=/absolute/path");
  }
  return [...previous, value];
}

export function registerMultiCommands(program: Command, helpers: CliHelpers): void {
  const { say, check, handleCliError } = helpers;
  const multi = program.command("multi").description("Multi-repo read-only Bridge for the official ChatGPT Connector");

  program
    .command("serve-multi", { hidden: true })
    .description("Run the multi-repo bridge in the foreground (internal)")
    .requiredOption("--name <name>", "saved multi profile name")
    .action(async (opts: { name: string }) => {
      try {
        const { readMultiRuntime } = await import("../multi/runtime.js");
        const { readMultiProfile } = await import("../multi/profile.js");
        const { startMultiBridge } = await import("../multi/bridge.js");
        const { Logger } = await import("../logger/index.js");
        const runtime = readMultiRuntime(opts.name);
        const profile = readMultiProfile(opts.name);
        if (!runtime || !profile) {
          throw new MultiError("MULTI_NOT_RUNNING", `No starting runtime for '${opts.name}'`);
        }
        const logger = new Logger({ name: "multi-bridge", console: true });
        const bridge = await startMultiBridge({ profile, startedAt: runtime.startedAt, logger });
        const shutdown = (): void => {
          void bridge.close().then(() => process.exit(0));
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
        say(`multi-repo bridge ready on ${bridge.localBaseUrl()} (${profile.name})`);
      } catch (error) {
        handleCliError(error, false);
      }
    });

  multi
    .command("up")
    .description("Start a named multi-repo read-only Bridge")
    .argument("<name>", "environment / profile name")
    .option("--repo <alias=path>", "read-only repo", collectRepo, [] as string[])
    .option("--save", "save or replace the named profile", false)
    .option("--tunnel", "start the configured Named Tunnel", false)
    .option("--json", "machine-readable output", false)
    .action(async (name: string, opts: { repo: string[]; save: boolean; tunnel: boolean; json: boolean }) => {
      try {
        const { profile } = resolveUpProfile({ name, repos: opts.repo, save: opts.save });
        const result = await upMultiEnvironment({ profile, tunnel: opts.tunnel });
        if (opts.json) {
          say(
            JSON.stringify({
              ok: true,
              environmentId: result.runtime.environmentId,
              localMcpUrl: result.localMcpUrl,
              publicMcpUrl: result.publicMcpUrl,
              repos: result.runtime.aliases,
              generation: result.runtime.generation,
            })
          );
          return;
        }
        say(`Multi-Repo Bridge: ${profile.name}`);
        say("");
        say("Workspaces:");
        for (const alias of result.runtime.aliases) say(alias);
        say("");
        say("Bridge local:");
        say(result.localMcpUrl);
        if (result.publicMcpUrl) {
          say("");
          say("Bridge public:");
          say(result.publicMcpUrl);
        }
        say("");
        say("Stop:");
        say(`c2c multi down ${profile.name}`);
      } catch (error) {
        handleCliError(error, opts.json);
      }
    });

  multi
    .command("down")
    .description("Stop a multi-repo Bridge without deleting its saved profile")
    .argument("<name>", "environment / profile name")
    .option("--json", "machine-readable output", false)
    .action(async (name: string, opts: { json: boolean }) => {
      try {
        const result = await downMultiEnvironment(assertProfileName(name));
        if (opts.json) say(JSON.stringify({ ok: true, ...result }));
        else check(`Multi-repo Bridge '${name}' stopped`);
      } catch (error) {
        handleCliError(error, opts.json);
      }
    });

  multi
    .command("status")
    .description("Show multi-repo Bridge status")
    .argument("<name>", "environment / profile name")
    .option("--verbose", "include canonical local roots", false)
    .option("--json", "machine-readable output", false)
    .action(async (name: string, opts: { verbose: boolean; json: boolean }) => {
      try {
        const payload = await statusMultiEnvironment(assertProfileName(name), { verbose: opts.verbose });
        if (opts.json) {
          say(JSON.stringify(payload));
          return;
        }
        say(`Multi-Repo Bridge：${name}`);
        say(`Running：${payload.running ? "yes" : "no"}`);
        say(`Bridge：${payload.bridge}`);
        say(`Tunnel：${payload.tunnel}`);
        say(`Generation：${payload.generation}`);
        const repos = payload.repos as Array<{ alias: string; localRoot?: string }>;
        for (const repo of repos) {
          const extra = opts.verbose && repo.localRoot ? ` ${repo.localRoot}` : "";
          say(`${repo.alias}${extra}`);
        }
      } catch (error) {
        handleCliError(error, opts.json);
      }
    });

  multi
    .command("address")
    .description("Show the Connector MCP URL for a multi-repo Bridge")
    .argument("<name>", "environment / profile name")
    .option("--json", "machine-readable output", false)
    .action((name: string, opts: { json: boolean }) => {
      try {
        const payload = addressMultiEnvironment(assertProfileName(name));
        if (opts.json) {
          say(JSON.stringify({ ok: true, ...payload }));
          return;
        }
        if (payload.preferred) say(payload.preferred);
        else say("Multi-repo Bridge is not running");
      } catch (error) {
        handleCliError(error, opts.json);
      }
    });

  multi
    .command("add")
    .description("Attach a read-only repo to a multi profile")
    .argument("<name>", "environment / profile name")
    .argument("<alias=path>", "alias=/absolute/path")
    .option("--json", "machine-readable output", false)
    .action(async (name: string, aliasPath: string, opts: { json: boolean }) => {
      try {
        if (!aliasPath.includes("=")) throw new InvalidArgumentError("expected alias=/absolute/path");
        const result = await addMultiRepo(name, aliasPath);
        if (opts.json) say(JSON.stringify({ ok: true, ...result }));
        else check(`Added repo to '${name}'${result.running ? ` (generation ${result.generation})` : ""}`);
      } catch (error) {
        handleCliError(error, opts.json);
      }
    });

  multi
    .command("remove")
    .description("Detach a repo from a multi profile")
    .argument("<name>", "environment / profile name")
    .argument("<alias>", "workspace alias")
    .option("--json", "machine-readable output", false)
    .action(async (name: string, alias: string, opts: { json: boolean }) => {
      try {
        const result = await removeMultiRepo(name, alias);
        if (opts.json) say(JSON.stringify({ ok: true, ...result }));
        else check(`Removed '${alias}' from '${name}'`);
      } catch (error) {
        handleCliError(error, opts.json);
      }
    });

  multi
    .command("repos")
    .description("List repos in a saved multi profile")
    .argument("<name>", "environment / profile name")
    .option("--verbose", "include canonical local roots", false)
    .option("--json", "machine-readable output", false)
    .action((name: string, opts: { verbose: boolean; json: boolean }) => {
      try {
        const payload = listMultiRepos(assertProfileName(name), { verbose: opts.verbose });
        if (opts.json) {
          say(JSON.stringify(payload));
          return;
        }
        const repos = payload.repos as Array<{ alias: string; localRoot?: string }>;
        for (const repo of repos) {
          const extra = opts.verbose && repo.localRoot ? ` ${repo.localRoot}` : "";
          say(`${repo.alias}${extra}`);
        }
      } catch (error) {
        handleCliError(error, opts.json);
      }
    });

  const tunnel = multi.command("tunnel").description("Named Tunnel identity for a multi-repo profile");

  tunnel
    .command("status")
    .description("Show this profile's Named Tunnel identity")
    .argument("<name>", "environment / profile name")
    .option("--zone <zone>", "optional zone hint")
    .option("--json", "machine-readable output", false)
    .action((name: string, opts: { zone?: string; json: boolean }) => {
      try {
        const payload = multiTunnelChoicePayload(name, opts.zone);
        if (opts.json) say(JSON.stringify(payload));
        else {
          say(`Tunnel identity：${payload.tunnelIdentity}`);
          say(`Preference：${payload.preference ?? "unset"}`);
          say(`Hostname：${payload.hostname ?? "(none)"}`);
        }
      } catch (error) {
        handleCliError(error, opts.json);
      }
    });

  tunnel
    .command("setup")
    .description("Create or reuse this profile's Named Tunnel")
    .argument("<name>", "environment / profile name")
    .option("--zone <zone>", "Cloudflare zone, e.g. example.com")
    .option("--hostname <hostname>", "optional full hostname")
    .option("--json", "machine-readable output", false)
    .action(async (name: string, opts: { zone?: string; hostname?: string; json: boolean }) => {
      try {
        if (!readMultiProfile(assertProfileName(name))) {
          throw new MultiError("MULTI_PROFILE_NOT_FOUND", `No saved multi profile named '${name}'`);
        }
        const result = await setupMultiNamedTunnel({ name, zone: opts.zone, hostname: opts.hostname });
        if (opts.json) {
          say(JSON.stringify(result.ok ? result.payload : { ...result.payload, userMessage: result.userMessage }));
          if (!result.ok) process.exitCode = 1;
          return;
        }
        if (!result.ok) {
          say(result.userMessage);
          if (result.need === "zone") say(NAMED_LOGIN_PROMPT);
          process.exitCode = 1;
          return;
        }
        check(`Named Tunnel ready for '${name}'`);
      } catch (error) {
        handleCliError(error, opts.json);
      }
    });
}
