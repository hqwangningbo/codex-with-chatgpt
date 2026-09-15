/**
 * Tunnel abstraction. Business logic never talks to a specific vendor;
 * it only sees this interface. V1 ships a Cloudflare Quick Tunnel provider,
 * but ngrok / Tailscale / custom providers can be added without touching
 * the bridge.
 */
export interface TunnelStatus {
  running: boolean;
  url: string | null;
  provider: string;
  detail?: string;
}

export interface TunnelDoctorReport {
  provider: string;
  binaryFound: boolean;
  binaryPath: string | null;
  running: boolean;
  url: string | null;
  problems: string[];
}

export interface TunnelProvider {
  readonly name: string;
  /** Start the tunnel for a local port; resolves with the public URL. */
  start(localPort: number): Promise<string>;
  stop(): Promise<void>;
  restart(localPort: number): Promise<string>;
  status(): TunnelStatus;
  getPublicUrl(): string | null;
  doctor(): Promise<TunnelDoctorReport>;
}

export class UnavailableTunnel implements TunnelProvider {
  readonly name = "unconfigured";

  constructor(private readonly reason: string) {}

  async start(_localPort: number): Promise<string> {
    throw new Error(this.reason);
  }

  async stop(): Promise<void> {}

  async restart(localPort: number): Promise<string> {
    return this.start(localPort);
  }

  status(): TunnelStatus {
    return { running: false, url: null, provider: this.name, detail: this.reason };
  }

  getPublicUrl(): string | null {
    return null;
  }

  async doctor(): Promise<TunnelDoctorReport> {
    return {
      provider: this.name,
      binaryFound: false,
      binaryPath: null,
      running: false,
      url: null,
      problems: [this.reason],
    };
  }
}
