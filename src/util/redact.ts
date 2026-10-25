/**
 * Credential redaction primitives.
 *
 * Deliberately in its own module with NO pino dependency, so both the logger and
 * the config serializer can use it without a cycle (config needs to redact its own
 * description; the logger needs config's redaction list).
 *
 * Three complementary mechanisms:
 *
 *  1. **Key-name matching** — a field called `apiKey`, `signingKey`, `token`, … is
 *     replaced wholesale. Catches the common case.
 *  2. **Registered secret VALUES** — actual credential strings are registered at
 *     load time and removed wherever they appear, including inside a free-form
 *     message. This is the only mechanism that stops a third party echoing a
 *     credential back at us: `{"detail":"auth failed for <key>"}` would otherwise
 *     leak, because no KEY is named.
 *  3. **Shape rules** — a string that is ENTIRELY a 64/128-char hex run is replaced,
 *     and `Bearer <token>` runs are replaced in prose.
 *
 * Why a whole-string match for the hex rule rather than any hex run: a 64-char hex
 * substring can legitimately be a trade or order identifier. Mangling identifiers
 * would break the reconciliation debugging that logs exist to support, so the rule
 * is deliberately narrow and mechanism 2 covers the exact-value case instead.
 */

/** Field names whose values are always secret, regardless of content. */
export const SECRET_KEYS = [
  'ARCUS_API_SIGNING_KEY',
  'ARCUS_API_KEY',
  'LARK_APP_ID',
  'LARK_APP_SECRET',
  /** Recognised so an accidental plaintext key in the wrong var is still redacted. */
  'ARCUS_PRIVATE_KEY',
  'WALLET_PRIVATE_KEY',
  'LARK_APP_TOKEN',
] as const;

/** Key-name pattern for the recursive scrubber. */
const SENSITIVE_KEY_PATTERN =
  /(secret|privatekey|private_key|signingkey|signing_key|apikey|api_key|token|password|passphrase|authorization)/i;

const registeredSecrets = new Set<string>();

/**
 * Register a credential value so it can never be logged.
 *
 * Never throws. Ignores values shorter than 12 characters, because registering a
 * short string (say `"ok"`) would blank unrelated log content and make the logs
 * useless — strictly worse than the risk it removes.
 */
export function registerSecret(value: string | undefined | null): void {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  if (trimmed.length < 12) return;
  registeredSecrets.add(trimmed);
}

/** How many distinct secret values are registered. For tests and diagnostics. */
export function registeredSecretCount(): number {
  return registeredSecrets.size;
}

/** Clear the registry. Test-only. */
export function resetRegisteredSecrets(): void {
  registeredSecrets.clear();
}

/** True when this exact string has been registered as a credential. */
export function isRegisteredSecret(value: string): boolean {
  return registeredSecrets.has(value);
}

/**
 * Scrub a free-form string.
 *
 * Exported because the logger needs it for message text, which pino's path-based
 * redaction cannot reach.
 */
export function redactString(value: string): string {
  let out = value;
  for (const secret of registeredSecrets) {
    if (secret.length > 0 && out.includes(secret)) out = out.split(secret).join('<redacted>');
  }
  // A quoted Authorization header.
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/g, 'Bearer <redacted>');
  // A value that IS a key-shaped hex string.
  if (/^[0-9a-fA-F]{64}$/.test(out) || /^[0-9a-fA-F]{128}$/.test(out)) return '<redacted-hex>';
  return out;
}

/**
 * Recursively redact a value for logging.
 *
 * Applies key-name matching, then value-level scrubbing for every string leaf.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[depth-limit]';
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const sensitive =
        SECRET_KEYS.some((s) => s.toLowerCase() === k.toLowerCase()) || SENSITIVE_KEY_PATTERN.test(k);
      out[k] = sensitive ? '<redacted>' : redactValue(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') return redactString(value);
  return value;
}

/** Does this string have the shape of a hex-encoded key or signature? */
export function looksLikeHexSecret(value: string): boolean {
  const v = value.startsWith('0x') ? value.slice(2) : value;
  return /^[0-9a-fA-F]{64}$/.test(v) || /^[0-9a-fA-F]{128}$/.test(v);
}

/**
 * Redact a serialised JSON log line.
 *
 * Returns the input unchanged when it is not JSON, so a pretty-printer's output is
 * not corrupted. Used by the logger's destination wrapper, which is what makes the
 * scrubbing apply to EVERY line rather than only to lines where a secret was passed
 * as a named binding.
 */
export function redactJsonLine(line: string): string {
  try {
    const parsed = JSON.parse(line) as unknown;
    return `${JSON.stringify(redactValue(parsed))}\n`;
  } catch {
    return line;
  }
}
