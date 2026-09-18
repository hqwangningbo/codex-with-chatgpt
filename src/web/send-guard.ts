import { WebError } from "./errors.js";

/** Prevents duplicate ChatGPT sends after a click that was not acknowledged. */
export class SendGuard {
  private sentWithoutAck = false;

  assertCanSend(): void {
    if (this.sentWithoutAck) {
      throw new WebError("WEB_TURN_STATE_UNKNOWN", "A previous send was not acknowledged; refusing to resend");
    }
  }

  markSent(): void {
    this.sentWithoutAck = true;
  }

  markAcknowledged(): void {
    this.sentWithoutAck = false;
  }

  get blocked(): boolean {
    return this.sentWithoutAck;
  }
}
