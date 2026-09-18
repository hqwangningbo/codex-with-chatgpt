import {
  hasCloudflaredCert,
  provisionNamedTunnel,
  chooseQuickTunnel,
  type ProvisionNamedResult,
} from "../tunnel/named-provision.js";
import { parseZoneInput, suggestedNamedHostname } from "../tunnel/hostname.js";
import { inspectZoneDns, type ZoneInspection } from "../tunnel/zone.js";
import {
  isNamedTunnelReady,
  NAMED_LOGIN_PROMPT,
  needsTunnelChoice,
  readTunnelState,
  TUNNEL_CHOICE_PROMPT,
  type TunnelState,
} from "../tunnel/state.js";
import { DevError } from "./errors.js";
import { readDevProfile, tunnelIdentityFor } from "./profile.js";
import { assertProfileName } from "./mounts.js";

export function assertSavedDevProfile(name: string) {
  const profile = readDevProfile(assertProfileName(name));
  if (!profile) throw new DevError("DEV_PROFILE_NOT_FOUND", `No saved profile named '${name}'`);
  return profile;
}

export function devTunnelChoicePayload(name: string, zoneHint?: string): Record<string, unknown> {
  const profile = assertSavedDevProfile(name);
  const workspaceId = tunnelIdentityFor(profile.name);
  const state = readTunnelState(workspaceId);
  const zone = parseZoneInput(zoneHint ?? "") ?? state.zone ?? null;
  return {
    ok: true,
    name: profile.name,
    tunnelIdentity: workspaceId,
    needsChoice: needsTunnelChoice(state),
    preference: state.preference,
    loggedIn: hasCloudflaredCert(),
    namedReady: isNamedTunnelReady(state),
    zone,
    hostname: state.hostname ?? null,
    suggestedHostname: zone ? suggestedNamedHostname(zone, profile.name, workspaceId) : null,
    userPrompt: needsTunnelChoice(state) ? TUNNEL_CHOICE_PROMPT : undefined,
    loginPrompt: NAMED_LOGIN_PROMPT,
    fallbackReason: state.fallbackReason,
    implicitQuick: false,
  };
}

export function chooseDevQuickTunnel(name: string): TunnelState {
  const profile = assertSavedDevProfile(name);
  return chooseQuickTunnel(tunnelIdentityFor(profile.name));
}

export async function chooseDevNamedTunnel(input: {
  name: string;
  zone?: string;
  hostname?: string;
  provision?: typeof provisionNamedTunnel;
  inspectZone?: typeof inspectZoneDns;
}): Promise<
  | { ok: true; state: TunnelState; payload: Record<string, unknown> }
  | { ok: false; need?: string; payload: Record<string, unknown>; userMessage: string }
> {
  const profile = assertSavedDevProfile(input.name);
  const workspaceId = tunnelIdentityFor(profile.name);
  const zone = parseZoneInput(input.zone ?? "");
  if (!zone) {
    const userMessage = "请告诉我已经加在 Cloudflare 上的域名，例如 example.com";
    return {
      ok: false,
      need: "zone",
      userMessage,
      payload: {
        ok: false,
        need: "zone",
        userMessage,
        loginPrompt: NAMED_LOGIN_PROMPT,
        name: profile.name,
        tunnelIdentity: workspaceId,
        suggestedHostname: null,
        implicitQuick: false,
      },
    };
  }

  const inspect = input.inspectZone ?? inspectZoneDns;
  const inspection: ZoneInspection = await inspect(zone);
  if (!inspection.cloudflareDelegated) {
    const recordsWarning = inspection.existingRecordTypes.length
      ? ` 切换 Nameserver 前请先在 Cloudflare 导入并核对这些现有记录：${inspection.existingRecordTypes.join(", ")}。`
      : "";
    const userMessage =
      `Cloudflare Zone 尚未确认 Active。请先在 Cloudflare 添加 ${zone}，` +
      "再到域名注册商把 Nameserver 改成 Cloudflare 分配的两个地址并等待 Active。" +
      recordsWarning;
    return {
      ok: false,
      need: "cloudflare_zone_active",
      userMessage,
      payload: { ok: false, need: "cloudflare_zone_active", inspection, userMessage },
    };
  }

  const provision = input.provision ?? provisionNamedTunnel;
  const result: ProvisionNamedResult = await provision({
    workspaceId,
    workspaceName: profile.name,
    zone,
    hostname: input.hostname,
  });
  if (!result.ok) {
    return {
      ok: false,
      userMessage: `${result.userMessage ?? "固定域名配置失败"} ${result.error ?? ""}`.trim(),
      payload: {
        ...devTunnelChoicePayload(profile.name, zone),
        ok: false,
        fallback: false,
        implicitQuick: false,
        userMessage: result.userMessage,
        error: result.error,
        state: result.state,
      },
    };
  }
  return {
    ok: true,
    state: result.state,
    payload: {
      ...devTunnelChoicePayload(profile.name, zone),
      ok: true,
      fallback: false,
      implicitQuick: false,
      state: result.state,
    },
  };
}
