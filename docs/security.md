# Security Model

## Trust boundaries

1. **Workspace root** is the smallest authorization boundary. One bridge serves
   exactly one workspace; every token is bound to `workspace_id`; a token for
   project A returns 403 on project B's bridge.
2. **Workspace content is untrusted.** README, comments, diffs may contain
   prompt injection. Every MCP tool description carries an explicit warning and
   tools never grant capabilities based on file content.
3. **No ChatGPT automation exists.** The user manually configures the
   Connector, enters the one-time pairing code, and carries prompts/replies.
   Access/refresh tokens travel only through OAuth endpoints.

## Threat model → mitigations

| Threat | Mitigation |
| --- | --- |
| MCP URL leaks | URL alone is useless: every `/mcp` request requires a valid bearer token (401 without, 403 wrong workspace) |
| Pairing code brute force | 8 chars from a 31-char CSPRNG alphabet (~40 bits), 5 attempts per session, per-IP rate limit (10/min), 5-minute TTL, one-time use, session destroyed on limit |
| OAuth CSRF | `state` round-tripped verbatim; authorization requests are server-side records keyed by random ids |
| Code interception | PKCE S256 mandatory (plain rejected); authorization codes are one-time, 5-minute TTL, bound to client + redirect URI |
| Token theft | Opaque high-entropy tokens; stored only as SHA-256 hashes; access tokens live 1 h; refresh tokens rotate on every use (replay of the old one fails); revocation endpoint + `c2c unpair` |
| Workspace traversal | `realpath` canonicalization of the deepest existing ancestor; containment check against the canonical root; case-insensitive comparison on macOS/Windows; rejects `..`, absolute escapes, backslash tricks, null bytes |
| Symlink escape | Canonicalization resolves symlinks before the containment check (file and directory symlinks both covered by tests) |
| Sensitive files | Deny-by-default patterns (.env*, keys, SSH, cloud creds, Web3 wallets/keystores/seed material…) enforced at resolve time, including hardlink aliases of those files; `.c2cignore` extends them; `.env.example` allowed to read |
| Limited writes | Disabled by default; requires an explicitly requested OAuth scope and a machine-local Writable Root bound to the current Bridge session. Existing files require `writable_sha256` from a complete `read_file`; truncated reads cannot overwrite. |
| POC execution | `poc` mode only; fixed program/argument policy, no shell, stripped environment, bounded output/time, and macOS Seatbelt default-deny. Reads are Workspace + minimal runtime paths; writes are `<writeRoot>/**` only. Never a filesystem-wide read root. |
| Secret in a normally named file | `read_file`, search results, and `git_diff` reject private-key blocks and redact obvious API tokens, secret assignments, and context-qualified 32-byte Web3 keys |
| Oversized file / diff DoS | read_file caps lines and bytes per response; git_diff paginates by byte offset with hard caps; search caps matches and file sizes |
| Tunnel exposure | Bridge binds 127.0.0.1 only (refuses 0.0.0.0); the only public surface is HTTPS via the tunnel, protected by OAuth; `/health` reveals only a salted workspace hash |
| Admin API abuse | Loopback-only + random admin token (0600 runtime file) + requests with proxy headers (`cf-connecting-ip`, `x-forwarded-for`) rejected; unauthenticated probes get 404 |
| Log credential leakage | Logger redacts token prefixes, bearer headers, token-like parameters, and pairing-code-shaped strings before writing |
| Execution output leak | Codex may nominate test/build/lint logs; a local sanitizer redacts tokens, pairing-code-shaped strings and home paths, truncates size, and refuses private-key blocks entirely. Restricted items are listed without a body. ChatGPT still cannot run commands. |
| Account automation | C2C has no ChatGPT page control, message send/read, polling, Connector mutation, or conversation URL state |

## Token & scope design

Default scopes: `workspace.read`, `workspace.search`, `git.read`,
`execution.read`, `offline_access`. Optional `workspace.write` and
`execution.poc` are granted only when explicitly requested. Tools enforce
scopes individually (`INSUFFICIENT_SCOPE`), and mutable tools also require an
active local Writable Scope.
Access tokens: 1 hour. Refresh tokens: 30 days, rotated. All tokens bound to
`workspace_id` and `client_id`.

## Storage

State lives under the OS-convention app dir
(`~/Library/Application Support/codex-with-chatgpt` on macOS), directories 0700,
files 0600. Named-hostname preference and tunnel metadata live there too
(`tunnels/<workspaceId>.json`) — never in the project. Only SHA-256 hashes of
tokens are persisted — a stolen state file does not yield usable bearer tokens.

**V1 limitation**: client registrations and token hashes are file-based rather
than OS-keychain-based. Raw tokens are never written anywhere. Keychain
integration is a V2 item.

## Permanent restrictions

ChatGPT cannot set or widen Writable Scope, delete/rename files, run arbitrary
shell, commit, or install packages. `.env` and every `.env.*` are never
readable or writable, including hardlink aliases with ordinary names;
`.env.example` is read-only. No Writable Root, including `.`, can override
these rules. A POC reads Workspace non-sensitive files and may write only
inside `<writeRoot>/**`. It runs only when the macOS filesystem sandbox is
available and does not grant filesystem-wide reads.
