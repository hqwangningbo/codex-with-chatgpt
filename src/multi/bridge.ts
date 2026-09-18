import express, { type Request, type Response, type NextFunction } from "express";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import { AuthStore, MULTI_SCOPES } from "../auth/store.js";
import { createOAuthRouter } from "../auth/oauth.js";
import { bearerAuth } from "../auth/middleware.js";
import { PairingManager } from "../pairing/manager.js";
import { createMcpHttpHandler } from "../mcp/http.js";
import { CloudflaredQuickTunnel } from "../tunnel/cloudflared.js";
import { CloudflaredNamedTunnel } from "../tunnel/cloudflared-named.js";
import { UnavailableTunnel, type TunnelProvider } from "../tunnel/provider.js";
import { isNamedTunnelId, namedTunnelBinding, readTunnelState } from "../tunnel/state.js";
import { Logger, nullLogger } from "../logger/index.js";
import { DEFAULT_HOST, DEFAULT_PORT } from "../config/paths.js";
import { SERVICE_NAME, VERSION } from "../version.js";
import { createMultiMcpServer } from "./mcp-server.js";
import { MultiError } from "./errors.js";
import {
  addRepoToProfile,
  environmentIdFor,
  removeRepoFromProfile,
  tunnelIdentityFor,
  writeMultiProfile,
  type MultiProfile,
} from "./profile.js";
import { createMultiRegistry, type MultiWorkspaceRegistry } from "./registry.js";
import {
  clearMultiRuntime,
  ownerIdentityFor,
  readMultiRuntime,
  writeMultiRuntime,
  type MultiRuntimeState,
} from "./runtime.js";

export function tunnelForMultiProfile(name: string, logger: Logger = nullLogger): TunnelProvider {
  const workspaceId = tunnelIdentityFor(name);
  const state = readTunnelState(workspaceId);
  const binding = namedTunnelBinding(state);
  if (binding) {
    return new CloudflaredNamedTunnel({
      tunnelName: binding.tunnelName,
      tunnelId: binding.tunnelId,
      hostname: binding.hostname,
      logger,
    });
  }
  if (state.preference === "quick") return new CloudflaredQuickTunnel(logger);
  if (state.preference === "named") {
    if (!isNamedTunnelId(state.tunnelId)) return new UnavailableTunnel("NAMED_TUNNEL_ID_MISSING");
    return new UnavailableTunnel("NAMED_TUNNEL_NOT_CONFIGURED");
  }
  return new UnavailableTunnel("TUNNEL_CHOICE_REQUIRED");
}

export interface MultiBridge {
  name: string;
  environmentId: string;
  startedAt: string;
  registry: MultiWorkspaceRegistry;
  port: number;
  host: string;
  adminToken: string;
  authStore: AuthStore;
  pairing: PairingManager;
  tunnel: TunnelProvider;
  getPublicBaseUrl(): string | null;
  localBaseUrl(): string;
  close(): Promise<void>;
}

function listen(app: express.Express, host: string, preferredPort: number): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const tryListen = (port: number, allowFallback: boolean): void => {
      const server = app.listen(port, host);
      server.once("listening", () => {
        const address = server.address();
        const actual = typeof address === "object" && address ? address.port : port;
        resolve({ server, port: actual });
      });
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE" && allowFallback) tryListen(0, false);
        else reject(error);
      });
    };
    tryListen(preferredPort, preferredPort !== 0);
  });
}

export async function startMultiBridge(opts: {
  profile: MultiProfile;
  startedAt?: string;
  port?: number;
  host?: string;
  logger?: Logger;
  tunnelProvider?: TunnelProvider;
  persistRuntime?: boolean;
  persistProfile?: (profile: MultiProfile) => void;
  authStoreFile?: string;
  registry?: MultiWorkspaceRegistry;
}): Promise<MultiBridge> {
  const logger = opts.logger ?? nullLogger;
  const persistProfile = opts.persistProfile ?? writeMultiProfile;
  let profile = opts.profile;
  const registry = opts.registry ?? createMultiRegistry(profile);
  const startedAt = opts.startedAt ?? new Date().toISOString();
  const environmentId = environmentIdFor(profile.profileId);
  const host = opts.host ?? DEFAULT_HOST;
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("The bridge only binds to loopback addresses. Public exposure goes through the tunnel.");
  }

  const authStore = new AuthStore(environmentId, { file: opts.authStoreFile });
  const pairing = new PairingManager(environmentId);
  const tunnel = opts.tunnelProvider ?? tunnelForMultiProfile(profile.name, logger);
  const adminToken = `c2c_admin_${randomBytes(24).toString("base64url")}`;
  let publicBaseUrl: string | null = null;

  const app = express();
  app.set("trust proxy", true);
  app.disable("x-powered-by");

  const getBaseUrl = (req: Request): string => {
    if (publicBaseUrl) return publicBaseUrl;
    const proto = req.protocol;
    const hostHeader = req.get("host") ?? `${host}:${port}`;
    return `${proto}://${hostHeader}`;
  };

  app.get("/health", (_req, res) => {
    res.json({
      service: SERVICE_NAME,
      status: "ok",
      environmentId,
      environmentName: profile.name,
      repoCount: registry.size(),
      startedAt,
    });
  });

  app.use(
    createOAuthRouter({
      store: authStore,
      pairing,
      workspaceName: `multi:${profile.name}`,
      getBaseUrl,
      logger,
      scopesSupported: MULTI_SCOPES,
    })
  );

  const mcpHandler = createMcpHttpHandler(() => createMultiMcpServer({ name: profile.name, registry }), logger);
  app.all(
    "/mcp",
    express.json({ limit: "8mb" }),
    bearerAuth({ store: authStore, workspaceId: environmentId, getBaseUrl, logger }),
    (req: Request, res: Response) => {
      void mcpHandler(req, res);
    }
  );

  const adminGuard = (req: Request, res: Response, next: NextFunction): void => {
    const remote = req.socket.remoteAddress ?? "";
    const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    const viaProxy = Boolean(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"]);
    const header = req.headers.authorization ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!isLoopback || viaProxy || token !== adminToken) {
      res.status(404).end();
      return;
    }
    next();
  };

  app.get("/admin/info", adminGuard, (_req, res) => {
    res.json({
      service: SERVICE_NAME,
      version: VERSION,
      environmentId,
      environmentName: profile.name,
      repoCount: registry.size(),
      aliases: registry.aliases(),
      generation: registry.generation,
      port,
      publicUrl: publicBaseUrl,
      tunnel: tunnel.status(),
      tokenCount: authStore.tokenCount(),
      pairingActive: pairing.hasActiveSession(),
      pid: process.pid,
      startedAt,
    });
  });

  app.post("/admin/workspaces/add", adminGuard, express.json(), async (req, res) => {
    const alias = typeof req.body?.alias === "string" ? req.body.alias : "";
    const root = typeof req.body?.root === "string" ? req.body.root : "";
    try {
      if (!alias || !root) throw new MultiError("MULTI_INVALID_ALIAS", "alias and canonical root are required");
      await registry.add(alias, root);
      try {
        const next = addRepoToProfile(profile, `${alias}=${root}`);
        persistProfile(next);
        profile = next;
      } catch (error) {
        await registry.rollbackAdd(alias);
        throw error;
      }
      persistRuntime();
      res.json({ ok: true, alias, generation: registry.generation, environmentId });
    } catch (error) {
      const code = error instanceof MultiError ? error.code : "MULTI_ADD_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: code, message });
    }
  });

  app.post("/admin/workspaces/remove", adminGuard, express.json(), async (req, res) => {
    const alias = typeof req.body?.alias === "string" ? req.body.alias : "";
    try {
      if (!alias) throw new MultiError("MULTI_INVALID_ALIAS", "alias is required");
      const removed = await registry.remove(alias);
      try {
        const next = removeRepoFromProfile(profile, alias);
        persistProfile(next);
        profile = next;
      } catch (error) {
        await registry.rollbackRemove(removed);
        throw error;
      }
      persistRuntime();
      res.json({ ok: true, alias, generation: registry.generation, environmentId });
    } catch (error) {
      const code = error instanceof MultiError ? error.code : "MULTI_REMOVE_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: code, message });
    }
  });

  app.post("/admin/pairing", adminGuard, (_req, res) => {
    const session = pairing.create();
    res.json({ code: session.code, expiresAt: session.expiresAt });
  });

  app.post("/admin/tunnel/start", adminGuard, (_req, res) => {
    tunnel
      .start(port)
      .then((url) => {
        publicBaseUrl = url;
        persistRuntime();
        res.json({ url });
      })
      .catch((error: Error) => {
        logger.error(`Tunnel start failed: ${error.message}`);
        res.status(500).json({ error: "tunnel_failed", message: error.message });
      });
  });

  app.post("/admin/tunnel/stop", adminGuard, (_req, res) => {
    void tunnel
      .stop()
      .then(() => {
        publicBaseUrl = null;
        persistRuntime();
        res.json({ stopped: true });
      })
      .catch((error: Error) => {
        logger.error(`Tunnel stop failed: ${error.message}`);
        res.status(500).json({ error: "tunnel_stop_failed", message: error.message });
      });
  });

  app.post("/admin/revoke-all", adminGuard, (_req, res) => {
    const count = authStore.revokeAll();
    pairing.invalidateAll();
    res.json({ revoked: count });
  });

  app.post("/admin/shutdown", adminGuard, (_req, res) => {
    res.json({ shuttingDown: true });
    setTimeout(() => {
      void shutdown().then(() => process.exit(0));
    }, 100);
  });

  const { server, port } = await listen(app, host, opts.port ?? DEFAULT_PORT);

  const persistRuntime = (): void => {
    if (opts.persistRuntime === false) return;
    const previous = readMultiRuntime(profile.name);
    const state: MultiRuntimeState = {
      service: SERVICE_NAME,
      version: VERSION,
      environmentId,
      environmentName: profile.name,
      profileId: profile.profileId,
      startedAt,
      generation: registry.generation,
      aliases: registry.aliases(),
      pid: process.pid,
      port,
      adminToken,
      publicUrl: publicBaseUrl,
      status: "running",
      ...ownerIdentityFor(process.pid, previous),
    };
    writeMultiRuntime(state);
  };
  persistRuntime();

  let closed = false;
  const shutdown = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await tunnel.stop().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (opts.persistRuntime !== false) clearMultiRuntime(profile.name);
    logger.info("Multi-repo bridge stopped");
  };

  return {
    name: profile.name,
    environmentId,
    startedAt,
    registry,
    port,
    host,
    adminToken,
    authStore,
    pairing,
    tunnel,
    getPublicBaseUrl: () => publicBaseUrl,
    localBaseUrl: () => `http://${host}:${port}`,
    close: shutdown,
  };
}
