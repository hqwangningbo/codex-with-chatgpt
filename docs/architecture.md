# Architecture — Manual Safe Mode

```text
ChatGPT
  │ official Connector + OAuth
  ▼
C2C Bridge (loopback-only, public through Cloudflare HTTPS Tunnel)
  │ default-read-only MCP
  ▼
Workspace
  ▲
  │ edit / shell / git / Foundry / tests
Codex

User manually carries short Prompt/Plan/Review text between Codex and ChatGPT.
```

There is no automated ChatGPT control plane and no conversation state.

## Components

- `bridge/`: Express assembly, loopback listener, runtime state, local Admin API
- `mcp/`: read tools plus locally gated `write_file`/`run_poc` over stateless
  Streamable HTTP
- `auth/`: OAuth discovery, dynamic registration, authorization code + PKCE,
  refresh rotation, revocation, token hashes
- `pairing/`: CSPRNG one-time code, TTL, attempt and per-IP limits
- `workspace/`: canonical containment, sensitive paths/content, bounded
  read/list/search/Git
- `tunnel/`: Cloudflare Quick and Named Tunnel providers
- `execution/`: concise records and optional sanitized output
- `prompt/`: local plan/review text generation; no sending or receiving
- `process/`: Bridge lifecycle and health checks
- `cli/`: setup, pairing, prompt generation, diagnostics, local recording, and
  the optional `c2c web` Research Harness
- `web/`: dedicated ChatGPT Web profile, Temporary Chat session, local
  dispatcher, and fail-closed UI handling. Playwright is loaded only when a
  `c2c web` command runs.

## Lifecycles

MCP: ChatGPT → HTTPS Tunnel → `/mcp` → Bearer validation (401/403) → OAuth
scope check → handler → Workspace containment/filtering → bounded result.
Mutable handlers additionally require a machine-local Writable Root bound to
the current Bridge session. `run_poc` uses a macOS Seatbelt profile with no
network, Workspace/runtime reads, and write access limited to that root.

OAuth: protected-resource discovery → dynamic client registration →
authorization + user-entered one-time pairing code → PKCE token exchange.
Raw tokens are returned to the OAuth client and only hashes persist locally.

Setup requires an explicit Named or Quick preference. Unset returns
`TUNNEL_CHOICE_REQUIRED`; it never implies Quick. `c2c setup` starts the
Bridge/selected Tunnel and prints manual Connector settings.
It does not mint a pairing code or operate ChatGPT. The user runs `c2c pair`
only when the authorization page is ready.

Review: Codex records test metadata, generates a short review prompt, and stops.
The user sends it. ChatGPT independently reads the real Git diff and test state
through MCP.
