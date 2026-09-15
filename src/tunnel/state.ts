import fs from "node:fs";
import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";

export type TunnelPreference = "unset" | "quick" | "named";

export interface TunnelState {
  workspaceId: string;
  preference: TunnelPreference;
  askedAt?: string;
  provider?: "cloudflare-quick" | "cloudflare-named";
  tunnelName?: string;
  tunnelId?: string;
  hostname?: string;
  zone?: string;
  configuredAt?: string;
  fallbackReason?: string;
}

export function tunnelStateFile(workspaceId: string): string {
  return path.join(getStateDir(), "tunnels", `${workspaceId}.json`);
}

export function readTunnelState(workspaceId: string): TunnelState {
  return (
    readJsonIfExists<TunnelState>(tunnelStateFile(workspaceId)) ?? {
      workspaceId,
      preference: "unset",
    }
  );
}

export function writeTunnelState(state: TunnelState): TunnelState {
  writeSecureJson(tunnelStateFile(state.workspaceId), state);
  return state;
}

export function needsTunnelChoice(state: TunnelState): boolean {
  return state.preference === "unset" || !state.askedAt;
}

export function isNamedTunnelReady(state: TunnelState): boolean {
  return (
    state.preference === "named" &&
    state.provider === "cloudflare-named" &&
    Boolean(state.tunnelName?.trim()) &&
    Boolean(state.tunnelId?.trim()) &&
    Boolean(state.hostname?.trim())
  );
}

export function namedTunnelBinding(state: TunnelState): { tunnelName: string; hostname: string } | null {
  if (!isNamedTunnelReady(state) || !state.tunnelName || !state.hostname) return null;
  return { tunnelName: state.tunnelName, hostname: state.hostname };
}

export function findHostnameOwner(hostname: string, workspaceId: string): TunnelState | null {
  const dir = path.join(getStateDir(), "tunnels");
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const wanted = hostname.trim().toLowerCase();
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const state = readJsonIfExists<TunnelState>(path.join(dir, file));
    if (state?.workspaceId !== workspaceId && state?.hostname?.trim().toLowerCase() === wanted) {
      return state;
    }
  }
  return null;
}

export const TUNNEL_CHOICE_PROMPT = `配置公网只读连接时可以选择：
你有没有 Cloudflare 账号，并且有没有一个域名已经加在 Cloudflare 里？
- 有：使用一 Workspace 一固定域名；Connector 只需由你手动配置一次。
- 没有：可明确选择临时地址；重启后地址可能变化，需要你手动更新 Connector。
没有账号也完全能用。你选哪个？如果有域名，直接告诉我域名（例如 example.com）。`;

export const NAMED_LOGIN_PROMPT =
  "会弹出浏览器，请登录 Cloudflare 并选中你的域名，完成后告诉我「好了」。";

export const NAMED_REPAIR_MESSAGE =
  "固定域名 Tunnel 启动失败。未自动切换临时地址；请检查 Cloudflare 登录、Zone 和 Tunnel 状态。";
