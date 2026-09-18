export type MultiErrorCode =
  | "MULTI_PROFILE_NOT_FOUND"
  | "MULTI_PROFILE_EXISTS"
  | "MULTI_INVALID_NAME"
  | "MULTI_INVALID_ALIAS"
  | "MULTI_RESERVED_ALIAS"
  | "MULTI_DUPLICATE_ALIAS"
  | "MULTI_REPO_OVERLAP"
  | "MULTI_MOUNT_FORBIDDEN"
  | "MULTI_MOUNT_NOT_FOUND"
  | "MULTI_WORKSPACE_NOT_ATTACHED"
  | "MULTI_ALREADY_RUNNING"
  | "MULTI_NOT_RUNNING"
  | "MULTI_STOP_PID_UNCERTAIN"
  | "MULTI_STOP_TIMEOUT"
  | "MULTI_LAST_REPO"
  | "MULTI_UP_FAILED"
  | "MULTI_ROLLBACK_FAILED"
  | "MULTI_PROTOCOL_INVALID"
  | "MULTI_ADD_FAILED"
  | "MULTI_REMOVE_FAILED";

export class MultiError extends Error {
  constructor(
    public readonly code: MultiErrorCode,
    message: string,
    public readonly original?: { code: string; message: string },
    public readonly rollback?: { code: string; message: string }
  ) {
    super(message);
    this.name = "MultiError";
  }
}

export function errorCodeOf(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && (error as { code: unknown }).code) {
    return String((error as { code: unknown }).code);
  }
  return "INTERNAL_ERROR";
}

export function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
