const PRIVATE_KEY_BLOCK =
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/i;

const TOKEN_PATTERNS: RegExp[] = [
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /((?:AWS_SECRET_ACCESS_KEY|PRIVATE_KEY|WALLET_PRIVATE_KEY|DEPLOYER_PRIVATE_KEY|MNEMONIC|SEED_PHRASE)\s*[:=]\s*)[^\s,;]+/gi,
  /((?:mnemonic|private[_-]?key|seed[_-]?phrase)\s*[:=]\s*)["']?[^"'\r\n,;}]+["']?/gi,
];

const WEB3_CONTEXT = /\b(?:private|private[_-]?key|secret|wallet|mnemonic|signer|deployer)\b/i;
const HEX_32_BYTES = /\b0x[a-fA-F0-9]{64}\b/g;

export type WorkspaceSanitizeResult =
  | { allowed: true; text: string }
  | { allowed: false; reason: "private_key" };

/** Lightweight output gate for workspace text. It is deliberately not a DLP system. */
export function sanitizeWorkspaceText(raw: string): WorkspaceSanitizeResult {
  if (PRIVATE_KEY_BLOCK.test(raw)) return { allowed: false, reason: "private_key" };

  let text = raw;
  for (const pattern of TOKEN_PATTERNS) {
    text = text.replace(pattern, (match, prefix) =>
      typeof prefix === "string" ? `${prefix}[REDACTED]` : "[REDACTED]"
    );
  }

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const context = lines.slice(Math.max(0, i - 1), i + 2).join(" ");
    if (WEB3_CONTEXT.test(context)) lines[i] = lines[i].replace(HEX_32_BYTES, "[REDACTED]");
  }
  return { allowed: true, text: lines.join("\n") };
}
