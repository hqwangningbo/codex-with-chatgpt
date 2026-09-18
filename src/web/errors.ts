export type WebErrorCode =
  | "WEB_SESSION_NOT_READY"
  | "WEB_TURN_AMBIGUOUS"
  | "WEB_UI_DRIFT"
  | "WEB_TURN_STATE_UNKNOWN"
  | "WEB_RESEARCH_BUSY"
  | "WEB_CAPABILITY_REVOKED"
  | "WEB_MAX_STEPS_REACHED"
  | "WEB_MODEL_UNAVAILABLE"
  | "WEB_CHALLENGE"
  | "WEB_RATE_LIMIT"
  | "WEB_LOGIN_EXPIRED"
  | "WEB_BROWSER_UNAVAILABLE"
  | "WEB_PROFILE_REQUIRED"
  | "WEB_PROTOCOL_INVALID"
  | "WEB_TIMEOUT"
  | "WEB_LOGOUT_REQUIRES_YES"
  | "WEB_STOP_PID_UNCERTAIN"
  | "WEB_STOP_TIMEOUT"
  | "WRITE_SCOPE_NOT_ACTIVE"
  | "BRIDGE_NOT_RUNNING"
  | "POC_NOT_ALLOWED";

export class WebError extends Error {
  constructor(
    public readonly code: WebErrorCode,
    message: string
  ) {
    super(message);
    this.name = "WebError";
  }
}
