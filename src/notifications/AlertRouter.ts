/**
 * Alert routing: severity policy, de-duplication, local rate limiting and an
 * outbox that survives Lark being unreachable.
 *
 * The single design constraint behind this file is that **notifications are a
 * side-channel**. The trading loop calls `alert()` from inside its risk and
 * execution paths; if Lark is down, misconfigured, rate limiting us or simply
 * slow, the trading loop must still place, cancel and protect orders. So:
 *
 *  - `alert()` and `flushOutbox()` never throw and never block on network I/O
 *    beyond the client's own bounded attempt budget.
 *  - Anything that cannot be sent right now is persisted to the outbox, which is
 *    retried later with the SAME idempotency key, so a retry after a send whose
 *    response was lost cannot double-post (Lark de-duplicates a `uuid` for one
 *    hour).
 *  - Deduplication happens before the network, keyed on the alert's stable `key`,
 *    so an alert storm cannot become a message storm — except for `critical`,
 *    which is allowed through the throttle because dropping a critical alert is
 *    worse than a burst of them, and which is only deduped against a much shorter
 *    30s window so an operator still sees a persistent severe condition.
 *  - Local pacing (≤ `MAX_SENDS_PER_SECOND`) is enforced by DEFERRING to the
 *    outbox rather than by sleeping. Sleeping inside a trading process would stall
 *    order management to protect a chat message; the outbox is the buffer, and the
 *    deferred record goes out on the next flush.
 */

import { type Logger } from '../util/logger';
import {
  buildMarkdownCard,
  LarkError,
  type LarkCard,
  type LarkClient,
  type LarkSendResult,
} from './LarkClient';

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface Alert {
  severity: AlertSeverity;
  title: string;
  body: string;
  /** Dedupe window key. Defaults to `severity|title` when omitted. */
  key?: string;
}

export interface OutboxStore {
  /** Persist a message for later retry. Returns an id. */
  enqueue(record: {
    idempotencyKey: string;
    kind: 'text' | 'card';
    payload: string;
    createdAtMs: number;
    attempts: number;
    lastError?: string;
  }): void;
  /** Pending records, oldest first. */
  pending(
    limit: number,
  ): { id: number; idempotencyKey: string; kind: 'text' | 'card'; payload: string; attempts: number }[];
  markSent(id: number): void;
  markFailed(id: number, error: string): void;
}

export interface AlertRouterDeps {
  client: LarkClient;
  logger: Logger;
  outbox: OutboxStore;
  /** Injectable clock (epoch ms). Defaults to Date.now. */
  now?: () => number;
  /** Duplicate-suppression window for info/warning. Default 5 minutes. */
  dedupeWindowMs?: number;
  /** Max records retried per `flushOutbox()` call. Default 20. */
  maxOutboxPerFlush?: number;
}

/* ------------------------------------------------------------------ *
 * Policy constants
 * ------------------------------------------------------------------ */

/** Target ceiling for outbound Lark messages. Bursts are deferred to the outbox. */
export const MAX_SENDS_PER_SECOND = 5;

/** Minimum spacing between non-critical sends implied by `MAX_SENDS_PER_SECOND`. */
export const MIN_SEND_INTERVAL_MS = Math.ceil(1000 / MAX_SENDS_PER_SECOND);

export const DEFAULT_DEDUPE_WINDOW_MS = 5 * 60 * 1000;

/**
 * Critical alerts are only suppressed when the *same* key fires twice inside this
 * short window: repeated criticals usually mean the position is still broken, and
 * silently swallowing them for five minutes would be indefensible.
 */
export const CRITICAL_DEDUPE_WINDOW_MS = 30 * 1000;

export const DEFAULT_MAX_OUTBOX_PER_FLUSH = 20;

/** Severity → card header colour. */
export const SEVERITY_TEMPLATE: Record<AlertSeverity, string> = {
  info: 'blue',
  warning: 'orange',
  critical: 'red',
};

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** FNV-1a, 32-bit. Used to keep generated idempotency keys well under 50 chars. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ------------------------------------------------------------------ *
 * Router
 * ------------------------------------------------------------------ */

export class AlertRouter {
  private readonly client: LarkClient;
  private readonly logger: Logger;
  private readonly outbox: OutboxStore;
  private readonly now: () => number;
  private readonly dedupeWindowMs: number;
  private readonly criticalDedupeWindowMs = CRITICAL_DEDUPE_WINDOW_MS;
  private readonly maxOutboxPerFlush: number;

  /** key → epoch ms of the last accepted occurrence. */
  private readonly lastSeenAtMs = new Map<string, number>();
  private suppressed = 0;
  /** Wall-clock at which the next non-critical send becomes eligible. */
  private nextSendAtMs = 0;

  constructor(deps: AlertRouterDeps) {
    this.client = deps.client;
    this.logger = deps.logger;
    this.outbox = deps.outbox;
    this.now = deps.now ?? (() => Date.now());
    this.dedupeWindowMs = Math.max(0, deps.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS);
    this.maxOutboxPerFlush = Math.max(1, Math.floor(deps.maxOutboxPerFlush ?? DEFAULT_MAX_OUTBOX_PER_FLUSH));
  }

  /** Number of alerts dropped as duplicates since construction. */
  get suppressedCount(): number {
    return this.suppressed;
  }

  /**
   * Route an alert.
   *
   * Order of operations matters: dedupe → (throttle | send) → enqueue on failure.
   * The dedupe stamp is written BEFORE the send so that a slow/failing send still
   * suppresses an identical alert firing again a second later (which is precisely
   * the storm this guards against).
   *
   * Never throws.
   */
  async alert(a: Alert): Promise<LarkSendResult> {
    try {
      return await this.route(a);
    } catch (err) {
      // Belt and braces: `route` is written not to throw, but the trading loop
      // calls this, so a defect here must still not propagate.
      this.logger.error({ err: errorText(err) }, 'alert routing threw; alert was dropped');
      return {
        ok: false,
        error: new LarkError(`alert routing failed: ${errorText(err)}`, { retryable: true }),
        attempts: 0,
      };
    }
  }

  private async route(a: Alert): Promise<LarkSendResult> {
    const nowMs = this.now();
    const critical = a.severity === 'critical';
    const key = this.dedupeKeyFor(a);
    const windowMs = critical ? this.criticalDedupeWindowMs : this.dedupeWindowMs;

    if (this.isDuplicate(key, windowMs, nowMs)) {
      this.suppressed += 1;
      this.logger.debug(
        { key, severity: a.severity, windowMs },
        'alert suppressed as a duplicate inside the dedupe window',
      );
      return {
        ok: false,
        error: new LarkError(
          `alert suppressed: duplicate of "${key}" within ${windowMs} ms`,
          { retryable: false },
        ),
        attempts: 0,
      };
    }
    this.lastSeenAtMs.set(key, nowMs);
    this.pruneSeen(nowMs);

    const card = buildMarkdownCard(
      a.title,
      `${a.severity.toUpperCase()} · ${new Date(nowMs).toISOString()}`,
      [a.body],
      SEVERITY_TEMPLATE[a.severity],
    );
    const idempotencyKey = this.idempotencyKeyFor(key, nowMs);

    if (!critical && nowMs < this.nextSendAtMs) {
      this.enqueue({
        idempotencyKey,
        kind: 'card',
        payload: JSON.stringify(card),
        createdAtMs: nowMs,
        attempts: 0,
        lastError: 'deferred by the local send rate limit',
      });
      this.logger.debug(
        { key, severity: a.severity },
        'alert deferred to the outbox by the local rate limit',
      );
      return {
        ok: false,
        error: new LarkError(
          `alert deferred to the outbox: local rate limit is ${MAX_SENDS_PER_SECOND} QPS; ` +
            'it will be retried by flushOutbox()',
          { retryable: true },
        ),
        attempts: 0,
      };
    }
    // Critical alerts deliberately do not advance the throttle clock: they bypass
    // pacing entirely instead of consuming a token a non-critical alert could use.
    if (!critical) this.nextSendAtMs = nowMs + MIN_SEND_INTERVAL_MS;

    if (!this.client.configured) {
      this.enqueue({
        idempotencyKey,
        kind: 'card',
        payload: JSON.stringify(card),
        createdAtMs: nowMs,
        attempts: 0,
        lastError: 'lark client is not configured',
      });
      this.logger.warn(
        { key, severity: a.severity },
        'lark is not configured; alert queued to the outbox',
      );
      return {
        ok: false,
        error: new LarkError(
          'lark is not configured; alert queued to the local outbox for later delivery',
          { retryable: true },
        ),
        attempts: 0,
      };
    }

    const result = await this.safeSendCard(card, idempotencyKey);
    if (result.ok) {
      this.logger.info(
        { key, severity: a.severity, messageId: result.messageId, attempts: result.attempts },
        'alert delivered to lark',
      );
      return result;
    }

    this.enqueue({
      idempotencyKey,
      kind: 'card',
      payload: JSON.stringify(card),
      createdAtMs: nowMs,
      attempts: result.attempts,
      lastError: result.error.message,
    });
    this.logger.warn(
      {
        key,
        severity: a.severity,
        code: result.error.code,
        httpStatus: result.error.httpStatus,
        attempts: result.attempts,
      },
      'alert delivery failed; queued to the outbox',
    );
    return result;
  }

  /**
   * Retry everything in the outbox. Never throws.
   *
   * Records are sent with their stored idempotency key, so a record whose original
   * send actually reached Lark is de-duplicated server-side rather than posted
   * twice. `pending` in the result is re-read from the store, because a
   * `markFailed`/`markSent` failure leaves records behind.
   */
  async flushOutbox(): Promise<{ sent: number; failed: number; pending: number }> {
    let sent = 0;
    let failed = 0;
    let initial = 0;

    try {
      const records = this.outbox.pending(this.maxOutboxPerFlush);
      initial = records.length;
      for (const record of records) {
        try {
          const result = await this.sendRecord(record);
          if (result.ok) {
            try {
              this.outbox.markSent(record.id);
            } catch (err) {
              this.logger.warn(
                { id: record.id, err: errorText(err) },
                'lark outbox markSent failed; the record may be retried',
              );
            }
            sent += 1;
          } else {
            failed += 1;
            this.markFailedSafely(record.id, result.error.message);
          }
        } catch (err) {
          failed += 1;
          this.markFailedSafely(record.id, errorText(err));
        }
      }
    } catch (err) {
      this.logger.warn(
        { err: errorText(err) },
        'lark outbox flush could not read pending records',
      );
    }

    return { sent, failed, pending: this.countPending(initial - sent) };
  }

  /* ---------------------------------------------------------------- *
   * internals
   * ---------------------------------------------------------------- */

  private async sendRecord(record: {
    idempotencyKey: string;
    kind: 'text' | 'card';
    payload: string;
  }): Promise<LarkSendResult> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(record.payload) as unknown;
    } catch (err) {
      return {
        ok: false,
        error: new LarkError(
          `outbox record ${record.idempotencyKey} has an unparseable payload: ${errorText(err)}`,
          { retryable: false },
        ),
        attempts: 0,
      };
    }

    try {
      if (record.kind === 'text') {
        const text = (parsed as { text?: unknown })?.text;
        return await this.client.sendText(typeof text === 'string' ? text : String(parsed), {
          uuid: record.idempotencyKey,
        });
      }
      return await this.client.sendCard(parsed as LarkCard, { uuid: record.idempotencyKey });
    } catch (err) {
      // A defective client (or a card whose getters throw) must not abort the
      // whole flush; report it as a failed record and carry on.
      return {
        ok: false,
        error: new LarkError(`lark client threw while flushing the outbox: ${errorText(err)}`, {
          retryable: true,
        }),
        attempts: 0,
      };
    }
  }

  private async safeSendCard(card: LarkCard, uuid: string): Promise<LarkSendResult> {
    try {
      return await this.client.sendCard(card, { uuid });
    } catch (err) {
      return {
        ok: false,
        error: new LarkError(`lark client threw while sending a card: ${errorText(err)}`, {
          retryable: true,
        }),
        attempts: 0,
      };
    }
  }

  private enqueue(record: {
    idempotencyKey: string;
    kind: 'text' | 'card';
    payload: string;
    createdAtMs: number;
    attempts: number;
    lastError?: string;
  }): void {
    try {
      this.outbox.enqueue(record);
    } catch (err) {
      // Losing the record is bad but survivable; throwing would be worse.
      this.logger.error(
        { err: errorText(err), idempotencyKey: record.idempotencyKey },
        'failed to enqueue a lark message into the outbox',
      );
    }
  }

  private markFailedSafely(id: number, error: string): void {
    try {
      this.outbox.markFailed(id, error);
    } catch (err) {
      this.logger.warn(
        { id, err: errorText(err) },
        'lark outbox markFailed failed; the record may be retried',
      );
    }
  }

  private countPending(fallback: number): number {
    try {
      return this.outbox.pending(this.maxOutboxPerFlush).length;
    } catch {
      return Math.max(0, fallback);
    }
  }

  private dedupeKeyFor(a: Alert): string {
    const explicit = a.key?.trim();
    if (explicit !== undefined && explicit !== '') return explicit;
    return `${a.severity}|${a.title}`;
  }

  private isDuplicate(key: string, windowMs: number, nowMs: number): boolean {
    const last = this.lastSeenAtMs.get(key);
    if (last === undefined) return false;
    return nowMs - last < windowMs;
  }

  /**
   * Keep the dedupe map bounded: this process may run for weeks, and an unbounded
   * map keyed on alert text is a slow memory leak.
   */
  private pruneSeen(nowMs: number): void {
    if (this.lastSeenAtMs.size <= 256) return;
    const horizon = Math.max(this.dedupeWindowMs, this.criticalDedupeWindowMs);
    for (const [key, seenAt] of this.lastSeenAtMs) {
      if (nowMs - seenAt >= horizon) this.lastSeenAtMs.delete(key);
    }
  }

  /**
   * Lark's `uuid` idempotency key, ≤ 50 chars: a stable hash of the alert key plus
   * a coarse timestamp. Deterministic for a given key and millisecond, which is
   * what makes the enqueue → flush round trip idempotent.
   */
  private idempotencyKeyFor(key: string, nowMs: number): string {
    return `ar${fnv1a(key)}${nowMs.toString(36)}`;
  }
}
