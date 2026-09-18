# Codex with ChatGPT — Manual Safe Mode

> ChatGPT plans and reviews. Codex edits and tests. The user carries prompts.

This security-focused fork is designed for private repositories, Solidity,
DeFi, and other high-value engineering work.

## Architecture

```text
┌─────────────────────────────┐
│           ChatGPT           │
│ Planning / Security Review  │
└──────────────┬──────────────┘
               │
        Official Connector
               │
      Read-only by default MCP
               │
               ▼
┌─────────────────────────────┐
│       Local Workspace       │
│ contracts / tests / docs    │
└──────────────▲──────────────┘
               │
               │ Edit / Shell / Git / Test
               │
┌──────────────┴──────────────┐
│            Codex            │
│     Execution / Testing     │
└─────────────────────────────┘

User manually carries:
Codex Prompt → ChatGPT
ChatGPT Review → Codex
```

ChatGPT accesses only the connected Workspace through the official custom
Connector and C2C's OAuth-protected MCP. Codex retains local editing, Shell,
Git, Foundry, and test ownership.

## What this fork never does

- Automatically log in to or control ChatGPT
- Open or operate ChatGPT pages
- Create, delete, reconnect, or edit a Connector
- Send prompts or read replies
- Poll page state or generation status
- Create or restore Chats/Projects
- Store ChatGPT conversation URLs

Those constraints apply to Manual Safe Mode, which remains the default
Connector path. An optional `c2c web` Research Harness can drive the visible
chatgpt.com UI after an explicit command; `c2c start` never launches it.
Cloudflare account authorization for an optional named Tunnel remains a
separate, explicit user action.

## MCP tools

The public MCP server exposes exactly:

- `workspace_info`
- `list_directory`
- `read_file`
- `search_workspace`
- `git_status`
- `git_diff`
- `test_status`
- `execution_summary`
- `execution_output`
- `write_scope_info` (read-only)
- `write_file` (requires explicit OAuth scope + local Writable Root)
- `run_poc` (requires explicit OAuth scope + local `poc` mode)

The default OAuth grant remains read-only. Mutable tools stay unavailable until
the user explicitly sets a session-bound, Workspace-relative Writable Root on
the local machine. There is no arbitrary shell, package-installation, delete,
rename, or Git-write tool. `.env`, every `.env.*`, and `.env.example` writes
are permanently denied.

```bash
c2c write-scope set -w <workspace> --root docs/research --mode write
c2c write-scope status -w <workspace>
c2c write-scope clear -w <workspace>
```

Source directories require `--yes`; root `.` additionally requires
`--allow-workspace-root`. `c2c stop` clears the active scope.

## Optional Web Research Harness

`c2c web` is opt-in. ChatGPT Web (the user's own chatgpt.com session) is the
reasoning model; C2C is the local capability boundary. It does not use Codex
models, the OpenAI API, ChatGPT API keys, or private ChatGPT endpoints.

```bash
c2c web login
c2c web research -w /path/to/project --task "..." --model current
c2c web status
c2c web stop
c2c web logout --yes
```

Login uses a dedicated 0700 browser profile under the C2C state directory.
Writable Scope and `.env` policy still apply. The Harness never writes Git
history and never starts or stops Bridge/Tunnel.

## Security-first installation

1. Clone this repository.
2. Inspect and pin the commit you intend to trust.
3. Run:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm test
```

4. Copy `skill/` to `~/.codex/skills/codex-with-chatgpt/` and replace
   `<ACTUAL_CHECKOUT_PATH>` in the installed Skill.
5. Missing Git, Node.js >= 20, or cloudflared is reported; C2C does not install
   system software automatically.

Dependencies are pinned to exact versions. Normal workflows do not install
packages or update the lockfile.

## First-time setup

```bash
c2c tunnel choose -w /path/to/project --mode quick
# Or configure a Named Tunnel as described below.

c2c setup -w /path/to/project
```

Tunnel choice is mandatory. If it is unset, `setup` returns
`TUNNEL_CHOICE_REQUIRED` instead of creating a random Quick Tunnel. Pure local
Bridge startup remains available without `--tunnel`.

Setup starts the loopback Bridge, establishes the selected Tunnel, and
prints the Connector name, Server URL, OAuth authentication choice, and manual
configuration guide. It does not open ChatGPT or generate a pairing code.

Create the custom Connector manually in ChatGPT. If Developer Mode is required,
enable it yourself in ChatGPT settings. When the authorization page asks for a
code, run:

```bash
c2c pair -w /path/to/project
```

Enter that short-lived, one-time code yourself.

If Codex needs the C2C state directory in `writable_roots`, first inspect:

```bash
c2c sandbox-allow --json
```

The command shows the exact `config.toml` and state directory without writing.
Only after explicit approval:

```bash
c2c sandbox-allow --yes
```

`c2c setup` and `c2c doctor` never modify global Codex configuration.

## Ask ChatGPT for a plan

```bash
c2c prompt plan -w /path/to/project --task "Implement the requested change"
```

Copy the generated prompt to ChatGPT, then paste ChatGPT's PLAN back to Codex.
C2C only generates text; it does not send or receive messages.

## Ask ChatGPT for an independent review

After Codex edits and tests:

```bash
c2c prompt review -w /path/to/project
```

The prompt tells ChatGPT not to trust Codex's summary and to inspect the real
`git_status`, `git_diff`, relevant files, test records, and sanitized execution
output through the named Connector.

For explicit DeFi review:

```bash
c2c prompt review -w /path/to/project --profile defi
```

Foundry, Hardhat, or `contracts/` workspaces select the DeFi profile
automatically. It covers access control, reentrancy, external calls,
upgradeability/storage, oracle and economic attacks, ERC4626 accounting,
rounding, unusual token behaviour, MEV, signatures, bridge assumptions,
governance, fuzzing, invariants, and fork tests.

The generated prompt contains the Connector name, never the MCP URL, tokens,
pairing code, admin token, code, diff, logs, or an absolute Workspace path.

## Daily Workflow

Start development by telling Codex: “开启 Bridge”.

Codex resolves the current Git root, checks status, reuses a healthy Bridge or
starts a detached one, starts the saved Named Tunnel, and verifies the public
health endpoint plus OAuth-protected MCP:

```text
✓ Workspace: Bifrost
✓ Bridge: healthy
✓ Named Tunnel: healthy
✓ MCP: https://c2c-bifrost.example.com/mcp
```

Open ChatGPT yourself and select the already configured `Codex · Bifrost`
Connector. C2C never opens or operates ChatGPT.

## End of Day

Tell Codex: “关闭 Bridge”. It runs the workspace-scoped stop command and
confirms both Tunnel and Bridge have stopped. OAuth registration, Named Tunnel,
DNS, and Connector configuration remain for the next day.

C2C does not install launchd, systemd, Windows Startup, login items, or other
24×7 auto-start services.

## One-time Domain Setup

```text
Domain at Aliyun or another registrar
→ Add the Zone to Cloudflare
→ Import and verify every existing DNS record
→ Change registrar nameservers to Cloudflare
→ Wait for Zone Active
→ Configure one Named Tunnel and hostname for this Workspace
→ Configure the ChatGPT Connector manually once
```

Aliyun may remain the registrar; only authoritative DNS and Tunnel service need
to use Cloudflare. Existing A, AAAA, CNAME, MX, TXT, and CAA records must be
preserved before changing nameservers to avoid website, API, or email outages.

```bash
c2c tunnel inspect-zone --zone example.com

c2c tunnel choose -w /path/to/project \
  --mode named \
  --zone example.com \
  --hostname c2c-bifrost.example.com

c2c start -w /path/to/project --tunnel
c2c status -w /path/to/project
```

Named configuration is stored under the machine-local C2C state directory, not
in Git. Subsequent starts reuse the same tunnel ID and hostname. A configured
Named Tunnel never silently falls back to a random Quick Tunnel, and an
existing hostname conflict is not overwritten.

## Execution records

Codex may record concise test metadata with `c2c record`. Nominated output from
Foundry, Slither, lint, typecheck, tests, or builds is available through
`execution_output` only after:

- Private-key block hard rejection
- API/token/Web3 secret redaction
- Home-path redaction
- Line and byte limits

Restricted output is listed without a body.

## Security model

- OAuth 2.1 authorization code flow with mandatory PKCE S256
- Short-lived, one-time pairing code with attempt and per-IP limits
- Access-token TTL and refresh-token rotation
- Raw OAuth tokens never written to disk; only SHA-256 hashes persist
- Token-to-Workspace binding: unauthenticated `/mcp` is 401, wrong Workspace is 403
- Bridge binds loopback only; Admin API requires loopback plus admin token and
  rejects proxy headers
- Canonical realpath containment and symlink escape protection
- Sensitive path policy plus `.c2cignore`
- Web3 wallet, keystore, seed, mnemonic, and deployment-secret defaults
- Content-level private-key rejection and obvious token/secret redaction
- Bounded file, search, diff, and execution output
- State directories 0700 and sensitive state files 0600 where supported

ChatGPT-requested Workspace content is transmitted to ChatGPT. C2C does not
bulk-upload the repository, but this is not a “code never leaves the machine”
system. Keep private keys, seed phrases, and production credentials outside the
project. For Web3 projects, copy:

```bash
cp examples/c2cignore.web3.example .c2cignore
```

Use a dedicated AI working copy for high-value repositories.

## Updates

`c2c update-check` only reports availability. Updates never run automatically.
An explicit “Update Codex with ChatGPT” request must verify a clean tree,
fetch and review commits/diffs/security-sensitive changes, then use a
fast-forward-only merge and frozen dependency install. Local changes are never
stashed, reset, cleaned, or overwritten.

## Development

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

Full threat model: [docs/security.md](docs/security.md)

Manual protocol: [docs/protocol.md](docs/protocol.md)

Troubleshooting: [docs/troubleshooting.md](docs/troubleshooting.md)

Unofficial community project. Not affiliated with or endorsed by OpenAI.

License: [MIT](LICENSE)
