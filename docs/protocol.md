# Manual Safe Mode Protocol

C2C has one automated data plane only:

```text
ChatGPT → official Connector → OAuth → default-read-only MCP → Workspace
```

There is no automated ChatGPT control plane in Manual Safe Mode. The user
manually copies a short planning or review prompt to ChatGPT and manually
brings the response back to Codex. C2C does not know which Chat, conversation,
or Project the user chooses. The optional `c2c web` Harness is a separate
local chatgpt.com path; it is not part of this Connector protocol.

## Setup

An explicit Named or Quick preference is required. An unset preference returns
`TUNNEL_CHOICE_REQUIRED` and never creates a Quick Tunnel.

`c2c setup -w <workspace>` starts the loopback Bridge and selected Tunnel,
persists the Workspace endpoint, and prints:

- Connector name
- Server URL (setup only)
- Authentication: OAuth
- manual setup instructions

It does not create a pairing code. When the Connector authorization page is
ready, the user runs `c2c pair -w <workspace>` to mint a short-lived,
one-time code.

The Server URL is never included in planning or review prompts. Prompts identify
the Connector by name.

## Planning

```bash
c2c prompt plan -w <workspace> --task "<task>"
```

The generated prompt asks ChatGPT to verify `workspace_info`, inspect only the
necessary code through read tools, and return task understanding, files,
implementation approach, security risks, and tests. C2C prints the prompt but
never sends it.

## Execution

Codex owns all local mutation and command execution. After implementation,
Codex may record metadata:

```bash
c2c record -w <workspace> \
  --task <id> --iteration <n> \
  --changed-files "<paths or count>" \
  --tests "<summary>" --exit-status ok
```

For test/build/lint/typecheck/Foundry output, add `--command`, `--output-file`,
and `--exit-code`. Output is subject to private-key rejection, token/secret/home
path redaction, and size/line caps before ChatGPT can read it.

## Independent review

```bash
c2c prompt review -w <workspace>
c2c prompt review -w <workspace> --profile defi
```

The generated prompt instructs ChatGPT not to trust Codex's summary. ChatGPT
must independently inspect `workspace_info`, `git_status`, `git_diff`, relevant
files, test status, execution records, and any released execution output.

The DeFi profile adds smart-contract, economic, token-behaviour, fuzz,
invariant, and fork-test checks. The user manually sends the prompt and manually
returns the result to Codex.

## Security invariants

- No ChatGPT page or account automation in Manual Safe Mode. Optional
  `c2c web` is a separate, explicit chatgpt.com UI path.
- No automatic message send, reply read, polling, conversation URL storage, or
  Connector mutation on the Connector path.
- No code, diff, output body, token, pairing code, or MCP URL in generated
  prompts.
- OAuth grants remain read-only by default. `write_file` and sandboxed
  `run_poc` require explicitly requested OAuth scopes plus a local,
  session-bound Writable Root. ChatGPT cannot set or widen that root.
- `.env`, every `.env.*`, and `.env.example` writes are permanently denied,
  including hardlink aliases; POC subprocesses cannot read or write them.
  `write_file` overwrites require `writable_sha256` from a complete `read_file`.
- Only Codex can perform arbitrary shell, package, delete/rename, or Git writes.
