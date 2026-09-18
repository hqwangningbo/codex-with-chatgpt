import ignore, { type Ignore } from "ignore";

/**
 * Permanent write denies. Unlike read policy, this has no user-configurable
 * exceptions and deliberately denies .env.example too.
 */
export const WRITE_DENY_PATTERNS = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.jks",
  "*.keystore",
  "keystore/",
  "keystores/",
  "wallet/",
  "wallets/",
  "mnemonic*",
  "seed*",
  "private-key*",
  "private_key*",
  "secret*",
  "secrets/",
  "credentials/",
  "deploy-secrets/",
  "production-secrets/",
  "prod-secrets/",
  ".ssh/",
  ".aws/",
  ".gnupg/",
  ".npmrc",
  ".netrc",
  "_netrc",
  ".git-credentials",
  ".cloudflared/",
  "credentials.json",
  "service-account*.json",
  "secrets.json",
  ".git/",
  ".c2c.json",
] as const;

const rules: Ignore = ignore().add([...WRITE_DENY_PATTERNS]);

export function isWriteDenied(relPath: string): boolean {
  return relPath !== "" && relPath !== "." && rules.ignores(relPath);
}
