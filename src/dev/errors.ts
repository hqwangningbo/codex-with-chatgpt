export type DevErrorCode =
  | "DEV_PROFILE_NOT_FOUND"
  | "DEV_PROFILE_EXISTS"
  | "DEV_INVALID_NAME"
  | "DEV_INVALID_ALIAS"
  | "DEV_RESERVED_ALIAS"
  | "DEV_DUPLICATE_ALIAS"
  | "DEV_MOUNT_OVERLAP"
  | "DEV_MOUNT_FORBIDDEN"
  | "DEV_MOUNT_NOT_FOUND"
  | "DEV_INVALID_WRITE_ROOT"
  | "DEV_WORKSPACE_NOT_ATTACHED"
  | "DEV_WORKSPACE_READ_ONLY"
  | "DEV_CAPABILITY_REVOKED"
  | "DEV_ALREADY_RUNNING"
  | "DEV_NOT_RUNNING"
  | "DEV_STOP_PID_UNCERTAIN"
  | "DEV_UP_FAILED"
  | "DEV_PROTOCOL_INVALID"
  | "POC_NOT_ALLOWED";

export class DevError extends Error {
  constructor(
    public readonly code: DevErrorCode,
    message: string
  ) {
    super(message);
    this.name = "DevError";
  }
}
