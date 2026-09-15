# Troubleshooting — Manual Safe Mode

Start with:

```bash
c2c doctor -w /path/to/workspace
```

Doctor may repair local Bridge/Tunnel state. It never operates ChatGPT and
never changes global Codex configuration.

## Bridge not running

Run `c2c start -w <workspace> --tunnel`. If state is reported as uncertain,
do not start a second Bridge; wait and run doctor again.

## Public address changed

Doctor prints the Connector name and new MCP URL. Update that Connector
manually in ChatGPT. When its OAuth authorization page is ready:

```bash
c2c pair -w <workspace>
```

C2C does not create, delete, reconnect, or edit the Connector.

## Pairing code invalid or expired

Codes are one-time and expire after about five minutes. Generate one only when
the authorization page is ready. A newly generated code invalidates the old one.

## 401 from MCP

The token is missing, expired, invalid, or revoked. Authorize the Connector
again and enter a new code from `c2c pair`.

## Wrong Workspace / 403

The token belongs to another Workspace. Confirm the Connector name and run
`workspace_info`; authorize the correct Workspace Connector.

## cloudflared missing

- macOS: `brew install cloudflared`
- Windows: `winget install Cloudflare.cloudflared`
- Linux: use Cloudflare's package instructions

C2C reports the command but never installs system software automatically.
For a custom binary path, set `C2C_CLOUDFLARED_PATH`.

## QUIC blocked

Set `C2C_TUNNEL_PROTOCOL=http2` and restart the Bridge.

## State directory not writable

Inspect without writing:

```bash
c2c sandbox-allow --json
```

Review the exact config path and state root. After explicit approval:

```bash
c2c sandbox-allow --yes
```

`setup` and `doctor` never perform this change.

## Sensitive file denied

This is expected for `.env`, keys, credentials, Web3 wallet/seed material, and
anything matched by `.c2cignore`. Keep secrets outside the Workspace.

## Generate a fresh review request

```bash
c2c prompt review -w <workspace>
```

The command only prints text. Copy it to ChatGPT manually.
