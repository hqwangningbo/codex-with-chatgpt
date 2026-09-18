import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import { WebError } from "../web/errors.js";
import { DevError } from "../dev/errors.js";
import {
  deleteDevProfile,
  listDevProfiles,
  publicMountView,
  readDevProfile,
  resolveUpProfile,
  resolvedMounts,
} from "../dev/profile.js";
import { addressDevEnvironment, accessLabel, downDevEnvironment, statusDevEnvironment, upDevEnvironment } from "../dev/lifecycle.js";
import { assertProfileName } from "../dev/mounts.js";
import {
  chooseDevNamedTunnel,
  chooseDevQuickTunnel,
  devTunnelChoicePayload,
} from "../dev/tunnel.js";
import { NAMED_LOGIN_PROMPT } from "../tunnel/state.js";

interface CliHelpers {
  say: (msg: string) => void;
  check: (msg: string) => void;
  handleCliError: (error: unknown, json: boolean) => void;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function collectMounts(value: string, previous: string[]): string[] {
  if (!value.includes("=")) {
    throw new InvalidArgumentError("expected alias=/absolute/path");
  }
  return collect(value, previous);
}

export function registerDevCommands(program: Command, helpers: CliHelpers): void {
  const { say, check, handleCliError } = helpers;
  const dev = program.command("dev").description("Multi-workspace development environment");

  program
    .command("serve-dev", { hidden: true })
    .description("Run the environment bridge in the foreground (internal)")
    .requiredOption("--name <name>", "saved or starting environment name")
    .action(async (opts: { name: string }) => {
      try {
        const { readDevRuntime, capabilityFromRuntime } = await import("../dev/runtime.js");
        const { environmentFromCapability } = await import("../dev/environment.js");
        const { startEnvironmentBridge } = await import("../dev/bridge.js");
        const { Logger } = await import("../logger/index.js");
        const runtime = readDevRuntime(opts.name);
        if (!runtime) throw new DevError("DEV_NOT_RUNNING", `No starting runtime for '${opts.name}'`);
        const env = environmentFromCapability(capabilityFromRuntime(runtime));
        const logger = new Logger({ name: "dev-bridge", console: true });
        const bridge = await startEnvironmentBridge({ env, logger });
        const shutdown = (): void => {
          void bridge.close().then(() => process.exit(0));
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
        say(`environment bridge ready on ${bridge.localBaseUrl()} (${env.name})`);
      } catch (error) {
        handleCliError(error, false);
      }
    });

  dev
    .command("up")
    .description("Start a named multi-workspace development environment")
    .argument("<name>", "environment / profile name")
    .option("--mount <alias=path>", "read/write mount", collectMounts, [] as string[])
    .option("--read-only <alias=path>", "read-only mount", collectMounts, [] as string[])
    .option("--write-root <alias=path>", "optional writeRoot inside a mount", collectMounts, [] as string[])
    .option("--mode <mode>", "write or poc")
    .option("--save", "save or replace the named profile", false)
    .option("--tunnel", "start the configured Named Tunnel", false)
    .option("--chat", "start Web Dev Chat after the environment is up", false)
    .option("--json", "machine-readable output", false)
    .action(
      async (
        name: string,
        opts: {
          mount: string[];
          readOnly: string[];
          writeRoot: string[];
          mode?: string;
          save: boolean;
          tunnel: boolean;
          chat: boolean;
          json: boolean;
        }
      ) => {
        try {
          if (opts.mode && opts.mode !== "write" && opts.mode !== "poc") {
            throw new InvalidArgumentError("mode must be write or poc");
          }
          const { profile } = resolveUpProfile({
            name,
            mounts: opts.mount,
            readOnly: opts.readOnly,
            writeRoots: opts.writeRoot,
            mode: opts.mode,
            save: opts.save,
          });
          const mounts = resolvedMounts(profile);
          const result = await upDevEnvironment({
            profile,
            tunnel: opts.tunnel,
            startChat: opts.chat
              ? async ({ env, runtime, localMcpUrl, publicMcpUrl, markChatReady }) => {
                  const printReadyBanner = (sessionId?: string): void => {
                    if (opts.json) {
                      say(
                        JSON.stringify({
                          ok: true,
                          environmentId: runtime.environmentId,
                          localMcpUrl,
                          publicMcpUrl,
                          mounts: mounts.map((mount) => publicMountView(mount, profile.mode)),
                          chat: { status: "ready", sessionId: sessionId ?? null },
                        })
                      );
                      return;
                    }
                    say(`Development environment: ${profile.name}`);
                    say("");
                    say("Bridge local:");
                    say(localMcpUrl);
                    if (publicMcpUrl) {
                      say("");
                      say("Bridge public:");
                      say(publicMcpUrl);
                    }
                    say("");
                    say("Workspaces:");
                    for (const mount of mounts) {
                      say(`${mount.alias.padEnd(12)} ${accessLabel(mount.access, profile.mode)}`);
                    }
                    say("");
                    say("Web Chat:");
                    say("ready");
                    say("请直接在打开的 ChatGPT 页面聊天。");
                    say("");
                    say("Stop:");
                    say(`c2c dev down ${profile.name}`);
                  };

                  const { openChatSession } = await import("../web/session.js");
                  const { runDevChat } = await import("../dev/chat-turn.js");
                  const { session } = await openChatSession({});
                  const ac = new AbortController();
                  const onAbort = (): void => ac.abort();
                  process.on("SIGINT", onAbort);
                  process.on("SIGTERM", onAbort);
                  try {
                    let ready = false;
                    const chat = await runDevChat({
                      env,
                      session,
                      signal: ac.signal,
                      onReady: (info) => {
                        ready = true;
                        markChatReady();
                        printReadyBanner(info.sessionId);
                      },
                    });
                    if (!ready) {
                      throw new WebError(
                        (chat.error?.code as never) ?? "WEB_SESSION_NOT_READY",
                        chat.error?.message ?? "Dev Chat failed before ready"
                      );
                    }
                    if (opts.json && chat.status === "failed") process.exitCode = 1;
                    if (!opts.json && chat.status === "failed") {
                      throw new WebError(
                        (chat.error?.code as never) ?? "WEB_PROTOCOL_INVALID",
                        chat.error?.message ?? "Dev Chat failed"
                      );
                    }
                  } finally {
                    process.off("SIGINT", onAbort);
                    process.off("SIGTERM", onAbort);
                    await session.close();
                  }
                }
              : undefined,
          });
          if (opts.chat) return;
          if (opts.json) {
            say(
              JSON.stringify({
                ok: true,
                environmentId: result.runtime.environmentId,
                localMcpUrl: result.localMcpUrl,
                publicMcpUrl: result.publicMcpUrl,
                mounts: mounts.map((mount) => ({
                  alias: mount.alias,
                  access: mount.access,
                  mode: mount.access === "ro" ? "read-only" : profile.mode,
                })),
                chat: { status: "idle" },
              })
            );
            return;
          }
          say(`Development environment: ${profile.name}`);
          say("");
          say("Bridge local:");
          say(result.localMcpUrl);
          if (result.publicMcpUrl) {
            say("");
            say("Bridge public:");
            say(result.publicMcpUrl);
          }
          say("");
          say("Workspaces:");
          for (const mount of mounts) {
            say(`${mount.alias.padEnd(12)} ${accessLabel(mount.access, profile.mode)}`);
          }
          say("");
          say("Stop:");
          say(`c2c dev down ${profile.name}`);
        } catch (error) {
          handleCliError(error, opts.json);
        }
      }
    );

  dev
    .command("down")
    .description("Stop a development environment without deleting its saved profile")
    .argument("<name>", "environment / profile name")
    .option("--json", "machine-readable output", false)
    .action(async (name: string, opts: { json: boolean }) => {
      try {
        const result = await downDevEnvironment(assertProfileName(name));
        if (opts.json) say(JSON.stringify({ ok: true, ...result }));
        else check(`Development environment '${name}' stopped`);
      } catch (error) {
        handleCliError(error, opts.json);
      }
    });

  dev
    .command("status")
    .description("Show development environment status")
    .argument("<name>", "environment / profile name")
    .option("--verbose", "include canonical local roots", false)
    .option("--json", "machine-readable output", false)
    .action(async (name: string, opts: { verbose: boolean; json: boolean }) => {
      try {
        const payload = await statusDevEnvironment(assertProfileName(name), { verbose: opts.verbose });
        if (opts.json) {
          say(JSON.stringify(payload));
          return;
        }
        say(`Environment：${name}`);
        say(`Running：${payload.running ? "yes" : "no"}`);
        say(`Bridge：${payload.bridgeRunning ? "running" : "stopped"}`);
        say(`Tunnel：${payload.tunnelRunning ? "running" : "stopped"}`);
        say(`Chat：${payload.chatRunning ? "running" : "stopped"}`);
        const mounts = payload.mounts as Array<{ alias: string; access: string; mode?: string; localRoot?: string }>;
        for (const mount of mounts) {
          const extra = opts.verbose && mount.localRoot ? ` ${mount.localRoot}` : "";
          say(`${mount.alias}  ${mount.access}${mount.mode && mount.mode !== "read-only" ? ` ${mount.mode}` : ""}${extra}`);
        }
      } catch (error) {
        handleCliError(error, opts.json);
      }
    });

  dev
    .command("address")
    .description("Print the best MCP URL for this development environment")
    .argument("<name>", "environment / profile name")
    .option("--json", "machine-readable output", false)
    .action((name: string, opts: { json: boolean }) => {
      try {
        const addr = addressDevEnvironment(assertProfileName(name));
        if (opts.json) {
          say(JSON.stringify({ ok: Boolean(addr.preferred), local: addr.local, public: addr.public }));
          if (!addr.preferred) process.exitCode = 1;
          return;
        }
        if (!addr.preferred) throw new DevError("DEV_NOT_RUNNING", `Development environment '${name}' is not running`);
        say(addr.preferred);
      } catch (error) {
        handleCliError(error, opts.json);
      }
    });

  dev
    .command("chat")
    .description("Open Web Dev Chat against a running development environment")
    .argument("<name>", "environment / profile name")
    .option("--json", "machine-readable output", false)
    .action(async (name: string, opts: { json: boolean }) => {
      try {
        const { loadRunningEnvironment } = await import("../dev/lifecycle.js");
        const { openChatSession } = await import("../web/session.js");
        const { runDevChat } = await import("../dev/chat-turn.js");
        const env = loadRunningEnvironment(assertProfileName(name));
        const { session } = await openChatSession({});
        const ac = new AbortController();
        const onAbort = (): void => ac.abort();
        process.on("SIGINT", onAbort);
        process.on("SIGTERM", onAbort);
        try {
          const result = await runDevChat({
            env,
            session,
            signal: ac.signal,
            onReady: (info) => {
              if (opts.json) {
                say(JSON.stringify({ ok: true, ready: true, kind: "dev", sessionId: info.sessionId }));
                return;
              }
              say("Web Chat ready.");
              say("请直接在打开的 ChatGPT 页面聊天。");
            },
          });
          if (opts.json && result.status === "failed") process.exitCode = 1;
          if (!opts.json && result.status === "failed") {
            throw new WebError(
              (result.error?.code as never) ?? "WEB_PROTOCOL_INVALID",
              result.error?.message ?? "Dev Chat failed"
            );
          }
        } finally {
          process.off("SIGINT", onAbort);
          process.off("SIGTERM", onAbort);
          await session.close();
        }
      } catch (error) {
        handleCliError(error, opts.json);
      }
    });

  const profileCmd = dev.command("profile").description("Saved development environment profiles");

  profileCmd
    .command("list")
    .description("List saved development profiles")
    .option("--json", "machine-readable output", false)
    .action((opts: { json: boolean }) => {
      const names = listDevProfiles();
      if (opts.json) say(JSON.stringify({ ok: true, profiles: names }));
      else if (names.length === 0) say("No saved development profiles.");
      else names.forEach((item) => say(item));
    });

  profileCmd
    .command("show")
    .description("Show a saved development profile")
    .argument("<name>", "profile name")
    .option("--verbose", "include canonical local roots", false)
    .option("--json", "machine-readable output", false)
    .action((name: string, opts: { verbose: boolean; json: boolean }) => {
      try {
        const profile = readDevProfile(assertProfileName(name));
        if (!profile) throw new DevError("DEV_PROFILE_NOT_FOUND", `No saved profile named '${name}'`);
        const mounts = resolvedMounts(profile).map((mount) => ({
          ...publicMountView(mount, profile.mode),
          ...(opts.verbose ? { localRoot: mount.root } : {}),
        }));
        const payload = { ok: true, name: profile.name, mode: profile.mode, mounts };
        if (opts.json) say(JSON.stringify(payload));
        else {
          say(`Profile：${profile.name}`);
          say(`Mode：${profile.mode}`);
          for (const mount of mounts) {
            say(`${mount.alias}  ${mount.access}${opts.verbose && "localRoot" in mount ? ` ${mount.localRoot}` : ""}`);
          }
        }
      } catch (error) {
        handleCliError(error, opts.json);
      }
    });

  profileCmd
    .command("delete")
    .description("Delete a saved development profile")
    .argument("<name>", "profile name")
    .option("--yes", "confirm deletion", false)
    .option("--json", "machine-readable output", false)
    .action((name: string, opts: { yes: boolean; json: boolean }) => {
      try {
        if (!opts.yes) throw new DevError("DEV_PROFILE_NOT_FOUND", "Pass --yes to delete the saved profile");
        deleteDevProfile(assertProfileName(name));
        if (opts.json) say(JSON.stringify({ ok: true, deleted: name }));
        else check(`Profile '${name}' deleted`);
      } catch (error) {
        handleCliError(error, opts.json);
      }
    });

  const tunnelCmd = dev.command("tunnel").description("Named Tunnel for a saved development profile");

  const printTunnelStatus = (name: string, json: boolean, zone?: string): void => {
    const payload = devTunnelChoicePayload(name, zone);
    if (json) {
      say(JSON.stringify(payload));
      return;
    }
    if (payload.needsChoice) say("This development profile still needs a one-time Named Tunnel setup.");
    else if (payload.namedReady) check(`固定域名：${payload.hostname}`);
    else say("当前使用临时地址。");
  };

  tunnelCmd
    .command("status", { isDefault: true })
    .description("Show whether this development profile still needs Named Tunnel setup")
    .argument("<name>", "saved profile name")
    .option("--zone <domain>", "optional domain, used to preview the stable hostname")
    .option("--json", "machine-readable output", false)
    .action((name: string, opts: { zone?: string; json: boolean }) => {
      try {
        printTunnelStatus(assertProfileName(name), opts.json, opts.zone);
      } catch (error) {
        handleCliError(error, opts.json);
      }
    });

  const runNamedSetup = async (
    name: string,
    opts: { zone?: string; hostname?: string; json: boolean }
  ): Promise<void> => {
    const result = await chooseDevNamedTunnel({
      name: assertProfileName(name),
      zone: opts.zone,
      hostname: opts.hostname,
    });
    if (result.ok) {
      if (opts.json) {
        say(JSON.stringify(result.payload));
        return;
      }
      check(`Profile：${name}`);
      check("Mode：Named Tunnel");
      check(`Hostname：${result.state.hostname}`);
      check("Status：Ready");
      return;
    }
    if (opts.json) {
      say(JSON.stringify(result.payload));
      process.exitCode = 1;
      return;
    }
    if (result.need === "zone") {
      say(result.userMessage);
      return;
    }
    throw new Error(result.userMessage);
  };

  tunnelCmd
    .command("setup")
    .description("First-time Named Tunnel setup for this development profile")
    .argument("<name>", "saved profile name")
    .option("--zone <domain>", "Cloudflare domain for a named hostname")
    .option("--hostname <hostname>", "override the default c2c-<profile>.<zone>")
    .option("--json", "machine-readable output", false)
    .action(async (name: string, opts: { zone?: string; hostname?: string; json: boolean }) => {
      try {
        if (!opts.json) say(NAMED_LOGIN_PROMPT);
        await runNamedSetup(name, opts);
      } catch (error) {
        handleCliError(error, opts.json);
      }
    });

  tunnelCmd
    .command("choose")
    .description("Remember named (or explicit quick) for this development profile")
    .argument("<name>", "saved profile name")
    .option("--named", "provision or reuse the profile Named Tunnel", false)
    .option("--quick", "explicitly choose a temporary address; never implied", false)
    .option("--zone <domain>", "Cloudflare domain for a named hostname")
    .option("--hostname <hostname>", "override the default c2c-<profile>.<zone>")
    .option("--json", "machine-readable output", false)
    .action(
      async (
        name: string,
        opts: { named: boolean; quick: boolean; zone?: string; hostname?: string; json: boolean }
      ) => {
        try {
          if (opts.named && opts.quick) {
            throw new DevError("DEV_PROTOCOL_INVALID", "Pass either --named or --quick, not both");
          }
          if (!opts.named && !opts.quick) {
            throw new DevError("DEV_PROTOCOL_INVALID", "Pass --named (recommended) or --quick");
          }
          if (opts.quick) {
            const state = chooseDevQuickTunnel(assertProfileName(name));
            const payload = { ...devTunnelChoicePayload(name), state, implicitQuick: false };
            if (opts.json) say(JSON.stringify(payload));
            else check("已选用临时地址");
            return;
          }
          if (!opts.json) say(NAMED_LOGIN_PROMPT);
          await runNamedSetup(name, opts);
        } catch (error) {
          handleCliError(error, opts.json);
        }
      }
    );
}
