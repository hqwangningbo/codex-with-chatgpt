/**
 * ChatGPT page inspection helpers.
 *
 * Turn identity uses ChatGPT's logical `data-turn-id` / `data-turn-id-container`,
 * not display indexes such as `conversation-turn-N`. The approach follows the
 * MIT-licensed patterns in miuuyy/codex-chatgpt-web without copying that runtime.
 */

export const CHATGPT_ORIGIN = "https://chatgpt.com";
export const TEMPORARY_CHAT_URL = "https://chatgpt.com/?temporary-chat=true";

export const SELECTORS = {
  composer: 'div[contenteditable="true"][id="prompt-textarea"], #prompt-textarea, [data-testid="composer"] [contenteditable="true"]',
  sendButton: 'button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="发送提示"]',
  stopButton: 'button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="停止生成"]',
  userTurn: '[data-message-author-role="user"][data-turn-id], [data-turn="user"][data-turn-id]',
  assistantTurn: '[data-message-author-role="assistant"][data-turn-id], [data-turn="assistant"][data-turn-id]',
  turnContainer: "[data-turn-id-container]",
  profile: '[data-testid="profile-button"], button[aria-label="Open profile menu"], button[aria-label="打开个人资料菜单"]',
  temporarySwitch: 'button[aria-label*="Temporary" i], button[aria-label*="临时" i], [data-testid="temporary-chat-toggle"]',
} as const;

export interface ChatGptSnapshot {
  href: string;
  origin: string;
  composerCount: number;
  composerDisabled: boolean;
  profilePresent: boolean;
  temporaryChat: boolean;
  temporaryTogglePressed: boolean;
  loginSurface: boolean;
  challenge: boolean;
  rateLimit: boolean;
  usageLimit: boolean;
  turnContainerIds: string[];
  userTurnIds: string[];
  assistantTurnIds: string[];
  assistantIdByContainer: Record<string, string>;
  userIdByContainer: Record<string, string>;
  stopVisible: boolean;
  streaming: boolean;
  assistantTextById: Record<string, string>;
}

export function classifyPage(snapshot: ChatGptSnapshot):
  | "ready"
  | "login"
  | "challenge"
  | "rate_limit"
  | "usage_limit"
  | "drift" {
  if (snapshot.challenge) return "challenge";
  if (snapshot.rateLimit) return "rate_limit";
  if (snapshot.usageLimit) return "usage_limit";
  if (snapshot.loginSurface) return "login";
  if (snapshot.origin !== CHATGPT_ORIGIN) return "drift";
  try {
    const host = new URL(snapshot.href).hostname;
    if (host !== "chatgpt.com" && host !== "www.chatgpt.com") return "drift";
  } catch {
    return "drift";
  }
  return "ready";
}

export function sessionIsReady(snapshot: ChatGptSnapshot): boolean {
  return (
    classifyPage(snapshot) === "ready" &&
    snapshot.composerCount === 1 &&
    !snapshot.composerDisabled &&
    snapshot.profilePresent &&
    isTemporaryChatProven(snapshot) &&
    !snapshot.loginSurface
  );
}

/** Temporary Chat must be proven by URL or an explicit pressed toggle, not button text. */
export function isTemporaryChatProven(snapshot: Pick<ChatGptSnapshot, "href" | "temporaryTogglePressed">): boolean {
  try {
    if (new URL(snapshot.href).searchParams.get("temporary-chat") === "true") return true;
  } catch {
    return false;
  }
  return snapshot.temporaryTogglePressed === true;
}

export function uniqueIds(values: string[]): { ok: true; ids: string[] } | { ok: false; reason: "missing" | "duplicate" } {
  if (values.some((value) => !value || value.trim() === "")) return { ok: false, reason: "missing" };
  if (new Set(values).size !== values.length) return { ok: false, reason: "duplicate" };
  return { ok: true, ids: values };
}

export function newLogicalIds(before: string[], after: string[]): string[] {
  const known = new Set(before);
  return after.filter((id) => !known.has(id));
}

export function resolveNewAssistantTurn(
  before: string[],
  after: string[]
): { ok: true; id: string } | { ok: false; reason: "missing" | "ambiguous" | "duplicate" } {
  const uniqueness = uniqueIds(after);
  if (!uniqueness.ok) return uniqueness;
  const created = newLogicalIds(before, uniqueness.ids);
  if (created.length === 0) return { ok: false, reason: "missing" };
  if (created.length > 1) return { ok: false, reason: "ambiguous" };
  return { ok: true, id: created[0] };
}

export function turnLooksComplete(snapshot: ChatGptSnapshot, assistantId: string): boolean {
  if (snapshot.stopVisible || snapshot.streaming) return false;
  const text = snapshot.assistantTextById[assistantId] ?? "";
  return text.trim().length > 0;
}

export interface SendBaseline {
  assistantTurnIds: string[];
  turnContainerIds: string[];
  userTurnIds: string[];
  userIdByContainer: Record<string, string>;
}

export type SentTurnWatch =
  | { status: "waiting" }
  | { status: "complete"; id: string; text: string }
  | {
      status: "fail";
      code: "WEB_TURN_AMBIGUOUS" | "WEB_TURN_STATE_UNKNOWN" | "WEB_CHALLENGE" | "WEB_RATE_LIMIT";
      reason?: "multiple_user_turns";
    };

export function sendBaselineFrom(snapshot: ChatGptSnapshot): SendBaseline {
  return {
    assistantTurnIds: snapshot.assistantTurnIds,
    turnContainerIds: snapshot.turnContainerIds,
    userTurnIds: snapshot.userTurnIds,
    userIdByContainer: { ...snapshot.userIdByContainer },
  };
}

export function copySendBaseline(seen: SendBaseline): SendBaseline {
  return {
    assistantTurnIds: [...seen.assistantTurnIds],
    turnContainerIds: [...seen.turnContainerIds],
    userTurnIds: [...seen.userTurnIds],
    userIdByContainer: { ...seen.userIdByContainer },
  };
}

export function mergeSeenTurns(seen: SendBaseline, snapshot: ChatGptSnapshot): SendBaseline {
  const merge = (previous: string[], next: string[]): string[] => [
    ...new Set([...previous, ...next.filter((id) => id && id.trim())]),
  ];
  const userIdByContainer = { ...seen.userIdByContainer };
  for (const [containerId, userId] of Object.entries(snapshot.userIdByContainer)) {
    if (containerId && userId) userIdByContainer[containerId] = userId;
  }
  return {
    userTurnIds: merge(seen.userTurnIds, snapshot.userTurnIds),
    assistantTurnIds: merge(seen.assistantTurnIds, snapshot.assistantTurnIds),
    turnContainerIds: merge(seen.turnContainerIds, snapshot.turnContainerIds),
    userIdByContainer,
  };
}

export const EMPTY_SEND_BASELINE: SendBaseline = {
  assistantTurnIds: [],
  turnContainerIds: [],
  userTurnIds: [],
  userIdByContainer: {},
};

/** New human turns must appear in a new logical container, not an old remount. */
export function newBoundUserTurns(
  baseline: SendBaseline,
  snapshot: ChatGptSnapshot
): { containerId: string; userId: string }[] {
  const containers = uniqueIds(snapshot.turnContainerIds);
  if (!containers.ok) return [];
  const bound: { containerId: string; userId: string }[] = [];
  for (const containerId of newLogicalIds(baseline.turnContainerIds, containers.ids)) {
    const userId = snapshot.userIdByContainer[containerId];
    if (userId && userId.trim()) bound.push({ containerId, userId });
  }
  return bound;
}

export type ConcurrentUserCheck =
  | { status: "clear" }
  | { status: "concurrent" }
  | { status: "fail"; code: "WEB_TURN_AMBIGUOUS" | "WEB_TURN_STATE_UNKNOWN" };

export function checkConcurrentUser(baseline: SendBaseline, snapshot: ChatGptSnapshot): ConcurrentUserCheck {
  const users = uniqueIds(snapshot.userTurnIds);
  if (!users.ok) {
    return { status: "fail", code: users.reason === "duplicate" ? "WEB_TURN_AMBIGUOUS" : "WEB_TURN_STATE_UNKNOWN" };
  }
  const containers = uniqueIds(snapshot.turnContainerIds);
  if (!containers.ok) {
    return { status: "fail", code: containers.reason === "duplicate" ? "WEB_TURN_AMBIGUOUS" : "WEB_TURN_STATE_UNKNOWN" };
  }
  if (users.ids.length > 0 && containers.ids.length === 0) {
    return { status: "fail", code: "WEB_TURN_STATE_UNKNOWN" };
  }
  const boundUserIds = Object.values(snapshot.userIdByContainer).filter((id) => id && id.trim());
  for (const userId of users.ids) {
    if (!boundUserIds.includes(userId)) {
      return { status: "fail", code: "WEB_TURN_STATE_UNKNOWN" };
    }
  }
  if (newBoundUserTurns(baseline, snapshot).length > 0) return { status: "concurrent" };
  return { status: "clear" };
}

/**
 * After a send click, bind the reply to a unique new logical container.
 * Visible assistant remounts of old containers are not this send's response.
 */
export function watchSentTurn(baseline: SendBaseline, snapshot: ChatGptSnapshot): SentTurnWatch {
  const kind = classifyPage(snapshot);
  if (kind === "challenge") return { status: "fail", code: "WEB_CHALLENGE" };
  if (kind === "rate_limit" || kind === "usage_limit") return { status: "fail", code: "WEB_RATE_LIMIT" };
  if (kind === "login" || kind === "drift") return { status: "fail", code: "WEB_TURN_STATE_UNKNOWN" };

  const containers = uniqueIds(snapshot.turnContainerIds);
  if (!containers.ok) {
    if (snapshot.turnContainerIds.length === 0) return { status: "waiting" };
    return {
      status: "fail",
      code: containers.reason === "duplicate" ? "WEB_TURN_AMBIGUOUS" : "WEB_TURN_STATE_UNKNOWN",
    };
  }
  const assistants = uniqueIds(snapshot.assistantTurnIds);
  if (!assistants.ok && snapshot.assistantTurnIds.length > 0) {
    return {
      status: "fail",
      code: assistants.reason === "duplicate" ? "WEB_TURN_AMBIGUOUS" : "WEB_TURN_STATE_UNKNOWN",
    };
  }

  const users = uniqueIds(snapshot.userTurnIds);
  if (!users.ok && snapshot.userTurnIds.length > 0) {
    return {
      status: "fail",
      code: users.reason === "duplicate" ? "WEB_TURN_AMBIGUOUS" : "WEB_TURN_STATE_UNKNOWN",
    };
  }

  const boundUsers = newBoundUserTurns(baseline, snapshot);
  if (boundUsers.length > 1) {
    return { status: "fail", code: "WEB_TURN_AMBIGUOUS", reason: "multiple_user_turns" };
  }
  if (boundUsers.length === 0) return { status: "waiting" };
  if (baseline.userTurnIds.includes(boundUsers[0].userId)) {
    return { status: "fail", code: "WEB_TURN_STATE_UNKNOWN" };
  }

  const newContainers = newLogicalIds(baseline.turnContainerIds, containers.ids);
  const newAssistants = assistants.ok ? newLogicalIds(baseline.assistantTurnIds, assistants.ids) : [];

  if (newAssistants.length > 0 && newContainers.length === 0) {
    return { status: "waiting" };
  }
  if (newContainers.length === 0) return { status: "waiting" };

  const bound: { containerId: string; assistantId: string }[] = [];
  for (const containerId of newContainers) {
    const assistantId = snapshot.assistantIdByContainer[containerId];
    if (assistantId) bound.push({ containerId, assistantId });
  }
  if (bound.length === 0) return { status: "waiting" };
  if (bound.length > 1) return { status: "fail", code: "WEB_TURN_AMBIGUOUS" };

  const assistantId = bound[0].assistantId;
  if (baseline.assistantTurnIds.includes(assistantId)) {
    return { status: "fail", code: "WEB_TURN_STATE_UNKNOWN" };
  }
  if (!assistants.ok || !assistants.ids.includes(assistantId)) return { status: "waiting" };
  if (!turnLooksComplete(snapshot, assistantId)) return { status: "waiting" };
  return {
    status: "complete",
    id: assistantId,
    text: snapshot.assistantTextById[assistantId] ?? "",
  };
}

/**
 * Browser-side extractor. Must stay self-contained for page.evaluate.
 */
export function extractChatGptSnapshot(): ChatGptSnapshot {
  const visible = (element: Element): boolean => {
    const node = element as HTMLElement;
    const style = getComputedStyle(node);
    const box = node.getBoundingClientRect();
    return (
      node.isConnected &&
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      (box.width > 0 || box.height > 0)
    );
  };
  const ids = (selector: string, attr: string): string[] =>
    [...document.querySelectorAll(selector)].filter(visible).map((el) => el.getAttribute(attr) ?? "");
  const containers = [...document.querySelectorAll("[data-turn-id-container]")].filter((element) => {
    const parent = element.parentElement?.closest("[data-turn-id-container]");
    return parent?.getAttribute("data-turn-id-container") !== element.getAttribute("data-turn-id-container");
  });
  const assistantTurns = [...document.querySelectorAll('[data-message-author-role="assistant"][data-turn-id], [data-turn="assistant"][data-turn-id]')].filter(visible);
  const assistantTextById: Record<string, string> = {};
  for (const turn of assistantTurns) {
    const id = turn.getAttribute("data-turn-id");
    if (id) assistantTextById[id] = (turn as HTMLElement).innerText ?? "";
  }
  const body = document.body?.innerText ?? "";
  const href = location.href;
  const composers = [...document.querySelectorAll('div[contenteditable="true"][id="prompt-textarea"], #prompt-textarea, [data-testid="composer"] [contenteditable="true"]')].filter(visible);
  const disabled = composers.some((el) => {
    const node = el as HTMLElement;
    return node.getAttribute("aria-disabled") === "true" || node.getAttribute("contenteditable") === "false";
  });
  const assistantIdByContainer: Record<string, string> = {};
  const userIdByContainer: Record<string, string> = {};
  for (const container of containers) {
    const containerId = container.getAttribute("data-turn-id-container") ?? "";
    const assistant = container.querySelector('[data-message-author-role="assistant"][data-turn-id], [data-turn="assistant"][data-turn-id]');
    const assistantId = assistant?.getAttribute("data-turn-id") ?? "";
    if (containerId && assistantId) assistantIdByContainer[containerId] = assistantId;
    const user = container.querySelector('[data-message-author-role="user"][data-turn-id], [data-turn="user"][data-turn-id]');
    const userId = user?.getAttribute("data-turn-id") ?? "";
    if (containerId && userId) userIdByContainer[containerId] = userId;
  }
  let temporaryFromUrl = false;
  try {
    temporaryFromUrl = new URL(href).searchParams.get("temporary-chat") === "true";
  } catch {
    temporaryFromUrl = false;
  }
  const temporaryTogglePressed = [...document.querySelectorAll('[data-testid="temporary-chat-toggle"], button[aria-label*="Temporary" i], button[aria-label*="临时" i]')].some((el) => {
    const pressed = el.getAttribute("aria-pressed") ?? el.getAttribute("aria-checked");
    return pressed === "true";
  });
  return {
    href,
    origin: location.origin,
    composerCount: composers.length,
    composerDisabled: disabled,
    profilePresent: [...document.querySelectorAll('[data-testid="profile-button"], button[aria-label="Open profile menu"], button[aria-label="打开个人资料菜单"]')].some(visible),
    temporaryChat: temporaryFromUrl || temporaryTogglePressed,
    temporaryTogglePressed,
    loginSurface: /\/auth\/|\/log-in|\/login(?:\/|$|\?)/i.test(href),
    challenge:
      /cf-challenge|captcha|human verification|verify you are human|cloudflare/i.test(body) ||
      Boolean(document.querySelector("#challenge-form, [data-testid='challenge'], iframe[src*='captcha' i]")),
    rateLimit: /too many requests|rate limit|try again later|请求过多/i.test(body),
    usageLimit: /usage limit|you.?ve reached|quota|用量上限|额度/i.test(body),
    turnContainerIds: containers.map((el) => el.getAttribute("data-turn-id-container") ?? ""),
    userTurnIds: ids('[data-message-author-role="user"][data-turn-id], [data-turn="user"][data-turn-id]', "data-turn-id"),
    assistantTurnIds: assistantTurns.map((el) => el.getAttribute("data-turn-id") ?? ""),
    assistantIdByContainer,
    userIdByContainer,
    stopVisible: [...document.querySelectorAll('button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="停止生成"]')].some(visible),
    streaming: Boolean(document.querySelector('[data-streaming-response-status], [data-state="streaming"]')),
    assistantTextById,
  };
}
