/**
 * Structured logging.
 *
 * Every line passes through the value-level scrubber in `redact.ts`, so redaction
 * applies to the WHOLE line rather than only to fields pino was told about by name.
 * That distinction is what stops a credential that a remote service echoed inside
 * an error message from reaching disk: pino's path redaction cannot see inside a
 * free-form `message` string, and an auth failure very often quotes the offending
 * key.
 *
 * Rules this enforces:
 *  - API signing keys, wallet private keys, Lark app secrets and API tokens are
 *    never logged, in any form, at any nesting depth.
 *  - Signing diagnostics log only a signature PREFIX and its length.
 *  - Credentials are registered at config load via `registerSecret`, so even an
 *    unexpected code path cannot emit them.
 */

import pino, { type Logger, type LoggerOptions } from 'pino';
import { looksLikeHexSecret, redactJsonLine, redactValue } from './redact';

export type Level = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

/**
 * Field paths pino strips before serialisation.
 *
 * Defence in depth alongside the value scrubber. These paths cover the shapes we
 * control; the scrubber is what covers the shapes we do not.
 */
const REDACT_PATHS = [
  'password',
  'passphrase',
  'secret',
  '*.secret',
  '*.*.secret',
  'apiKey',
  '*.apiKey',
  '*.*.apiKey',
  'api_key',
  '*.api_key',
  '*.*.api_key',
  'privateKey',
  '*.privateKey',
  'signingKey',
  '*.signingKey',
  'token',
  '*.token',
  '*.*.token',
  'accessToken',
  '*.accessToken',
  'tenant_access_token',
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  'req.headers["x-signature"]',
  'headers.authorization',
  'headers["x-api-key"]',
  'headers["x-signature"]',
];

export interface LoggerInit {
  readonly level: Level;
  readonly pretty: boolean;
  readonly name?: string;
  /** Stable fields attached to every line (scrubbed defensively). */
  readonly base?: Record<string, unknown>;
  /**
   * Optional destination override, used by tests to capture output while still
   * exercising the REAL redaction stack. The scrubber is applied to an injected
   * destination too, so a test cannot accidentally validate an unredacted
   * configuration.
   */
  readonly destination?: pino.DestinationStream;
}

/**
 * Wrap a destination so every line is scrubbed.
 *
 * Applied unconditionally, including to injected destinations, because the point
 * is that no code path writes an unredacted line.
 */
export function scrubbingDestination(inner?: pino.DestinationStream): pino.DestinationStream {
  const target = inner ?? process.stdout;
  return {
    write(line: string): void {
      target.write(redactJsonLine(line));
    },
  } as pino.DestinationStream;
}

export function createLogger(init: LoggerInit): Logger {
  const options: LoggerOptions = {
    name: init.name ?? 'arcustrader',
    level: init.level,
    // Scrubbed before it is attached, so a caller passing a secret in a binding
    // cannot rely on the destination wrapper alone.
    base: init.base ? (redactValue(init.base) as Record<string, unknown>) : undefined,
    redact: { paths: REDACT_PATHS, censor: '<redacted>' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
  };

  if (init.pretty) {
    // pino-pretty formats the stream itself, so the JSON-level scrubber cannot sit
    // in front of it. pino's `redact` paths still apply, and the pretty path is a
    // local-development convenience only — production runs JSON, where the full
    // scrubber is active.
    return pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
      },
    });
  }

  return pino(options, scrubbingDestination(init.destination));
}

/** A logger that discards everything. For tests that do not assert on logs. */
export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}

/**
 * Safe description of a secret for diagnostics: presence, length and a short
 * prefix. Never enough material to reconstruct the key.
 */
export function describeSecret(secret: string | undefined): string {
  if (!secret) return '<unset>';
  const looksSecret = looksLikeHexSecret(secret);
  return `<set len=${secret.length}${looksSecret ? ` prefix=${secret.slice(0, 6)}` : ''}>`;
}

/** Truncate a signature for logs: enough to correlate, not enough to replay. */
export function describeSignature(signature: string): string {
  return signature.length <= 12 ? '<short>' : `${signature.slice(0, 12)}…(len=${signature.length})`;
}

export type { Logger };
export { redactValue, redactString, registerSecret } from './redact';
