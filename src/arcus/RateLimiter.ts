/**
 * Client-side rate-limit accounting.
 *
 * Arcus throttles on two independent layers (`docs/API_CONTRACTS.md` §4):
 *
 *   - Per-IP weight bucket: 1500 weight, refilling 1500/min = 25 weight/second.
 *   - Per-subaccount order/cancel pools, replenished by realized volume.
 *
 * There are NO `X-RateLimit-*` response headers, so the budget has to be
 * modelled locally or discovered by getting throttled. This module models it,
 * because a naive poll loop is a real trap: 4 req/s against weight-20 endpoints
 * costs 80 weight/s against a 25/s refill, which drains the bucket in ~25 s and
 * then throttles continuously *while the trading path sits idle*.
 *
 * Two guards are implemented:
 *
 *   1. `WeightBudget` — a token bucket mirroring the server's, with a
 *      configurable ceiling well under 1500 so the strategy never spends the
 *      last of the budget on a read it does not need.
 *   2. `CircuitBreaker` for observed 429s — when the server does throttle us,
 *      we stop issuing that class of request for a cooldown rather than
 *      hammering. Repeated throttling escalates the cooldown.
 *
 * Fail-closed contract: `canSpend()` returning false is a reason to SKIP a read,
 * never a reason to bypass the budget. Entry logic treats an unaffordable account
 * or position read as "unknown state" and refuses to open new positions.
 */

import type { Logger } from '../util/logger';

/** Published per-endpoint weights. Only the ones this system calls are listed. */
export const REQUEST_WEIGHT = {
  health: 0,
  time: 1,
  /** Order writes are free on the IP layer; they draw on the per-subaccount pool. */
  placeOrder: 0,
  cancelOrder: 0,
  modifyOrder: 0,
  cancelAllOrders: 0,
  bbo: 2,
  mids: 2,
  account: 2,
  positions: 2,
  order: 2,
  feeTiers: 2,
  leverages: 2,
  accountStats: 2,
  /**
   * Affiliate info. The published weight is not listed in the docs this system was
   * built against, so it is charged at the same rate as the other heavy account reads.
   * Over-charging only throttles us earlier; under-charging would risk a 429.
   */
  affiliateInfo: 20,
  rateLimit: 2,
  prices: 20,
  markets: 20,
  trade: 20,
  trades: 20,
  candles: 20,
  portfolio: 20,
  openOrders: 20,
  orders: 20,
  fills: 20,
  funding: 20,
  fundingRates: 20,
  setLeverage: 125,
  withdraw: 125,
  transfer: 125,
} as const;

export type WeightedEndpoint = keyof typeof REQUEST_WEIGHT;

/* ------------------------------------------------------------------ *
 * Weight budget
 * ------------------------------------------------------------------ */

export interface WeightBudgetOptions {
  /** Ceiling we allow ourselves. Default 900 of the server's 1500. */
  readonly capacity?: number;
  /** Refill rate. The server publishes 25 weight/second. */
  readonly refillPerSecond?: number;
  /** Injectable clock for tests. */
  readonly now?: () => number;
  readonly logger?: Logger;
}

export class WeightBudget {
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly now: () => number;
  private readonly logger?: Logger;

  private tokens: number;
  private lastRefillMs: number;
  /** Total spend since construction, for the daily report. */
  private spentTotal = 0;
  private throttledCount = 0;

  constructor(options: WeightBudgetOptions = {}) {
    this.capacity = options.capacity ?? 900;
    this.refillPerSecond = options.refillPerSecond ?? 25;
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger;
    this.tokens = this.capacity;
    this.lastRefillMs = this.now();
  }

  private refill(): void {
    const nowMs = this.now();
    const elapsedSeconds = Math.max(0, (nowMs - this.lastRefillMs) / 1000);
    this.lastRefillMs = nowMs;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
  }

  /** Tokens currently available (after applying elapsed refill). */
  available(): number {
    this.refill();
    return this.tokens;
  }

  /**
   * Can we afford this request right now?
   *
   * Returning false means the caller must skip the request. It is never correct
   * to treat false as permission — that is how a system talks itself into
   * throttling at the worst possible moment.
   */
  canSpend(endpoint: WeightedEndpoint): boolean {
    return this.available() >= REQUEST_WEIGHT[endpoint];
  }

  /**
   * Spend weight for a request.
   *
   * Returns false when the budget could not cover it, in which case nothing is
   * deducted and the caller must NOT issue the request.
   */
  spend(endpoint: WeightedEndpoint): boolean {
    const weight = REQUEST_WEIGHT[endpoint];
    this.refill();
    if (this.tokens < weight) return false;
    this.tokens -= weight;
    this.spentTotal += weight;
    return true;
  }

  /** Record a server-side 429 so the report and the counters reflect reality. */
  recordThrottled(): void {
    this.throttledCount += 1;
    this.logger?.warn({ endpoint: 'unknown', throttledCount: this.throttledCount }, 'arcus rate limited us');
  }

  /**
   * How long to wait before this endpoint becomes affordable, in ms.
   * Zero when it is affordable now.
   */
  waitMsFor(endpoint: WeightedEndpoint): number {
    this.refill();
    const weight = REQUEST_WEIGHT[endpoint];
    const deficit = weight - this.tokens;
    if (deficit <= 0) return 0;
    return Math.ceil((deficit / this.refillPerSecond) * 1000);
  }

  snapshot(): {
    available: number;
    capacity: number;
    spentTotal: number;
    throttledCount: number;
    utilisationPct: number;
  } {
    const available = this.available();
    return {
      available: Number(available.toFixed(2)),
      capacity: this.capacity,
      spentTotal: this.spentTotal,
      throttledCount: this.throttledCount,
      utilisationPct: Number((((this.capacity - available) / this.capacity) * 100).toFixed(1)),
    };
  }
}

/* ------------------------------------------------------------------ *
 * Throttle circuit breaker
 * ------------------------------------------------------------------ */

export interface CircuitBreakerOptions {
  /** Failures before the breaker opens. */
  readonly threshold?: number;
  /** Initial cooldown once open. */
  readonly cooldownMs?: number;
  /** Cooldown multiplier per consecutive trip. */
  readonly backoffFactor?: number;
  readonly maxCooldownMs?: number;
  readonly now?: () => number;
}

/**
 * Stops issuing a request class after observed 429s.
 *
 * Deliberately independent of the local weight model: the local model can be
 * wrong (another process sharing the IP, a server-side weight change), so actual
 * throttling is treated as authoritative and always honoured.
 */
export class ThrottleCircuitBreaker {
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly backoffFactor: number;
  private readonly maxCooldownMs: number;
  private readonly now: () => number;

  private consecutiveFailures = 0;
  private openedUntilMs = 0;
  private currentCooldownMs: number;
  private tripCount = 0;

  constructor(options: CircuitBreakerOptions = {}) {
    this.threshold = options.threshold ?? 3;
    this.cooldownMs = options.cooldownMs ?? 2_000;
    this.backoffFactor = options.backoffFactor ?? 2;
    this.maxCooldownMs = options.maxCooldownMs ?? 60_000;
    this.now = options.now ?? (() => Date.now());
    this.currentCooldownMs = this.cooldownMs;
  }

  get isOpen(): boolean {
    return this.now() < this.openedUntilMs;
  }

  /** Remaining cooldown in ms, 0 when closed. */
  remainingMs(): number {
    return Math.max(0, this.openedUntilMs - this.now());
  }

  get trips(): number {
    return this.tripCount;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    // Successful traffic lets the cooldown decay so a transient burst does not
    // leave the system permanently pessimistic.
    this.currentCooldownMs = this.cooldownMs;
  }

  recordThrottled(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.threshold) {
      this.openedUntilMs = Math.max(this.openedUntilMs, this.now() + this.currentCooldownMs);
      this.currentCooldownMs = Math.min(this.maxCooldownMs, this.currentCooldownMs * this.backoffFactor);
      this.tripCount += 1;
    }
  }

  reset(): void {
    this.consecutiveFailures = 0;
    this.openedUntilMs = 0;
    this.currentCooldownMs = this.cooldownMs;
    this.tripCount = 0;
  }
}

/* ------------------------------------------------------------------ *
 * Per-subaccount trading pools
 * ------------------------------------------------------------------ */

/**
 * The order/cancel pool state, as reported by `GET /v1/rateLimit`.
 *
 * This one is NOT modelled locally, because it is replenished by realized
 * volume and there is no published formula. It is read from the API and cached,
 * and new order writes are blocked when it runs low. That is the fail-closed
 * direction: an unknown pool is treated as empty, never as full.
 */
export interface TradingPoolState {
  readonly orderRemaining: number;
  readonly cancelRemaining: number;
  readonly orderCapacity: number;
  readonly cancelCapacity: number;
  readonly observedAtMs: number;
}

export class TradingPoolGuard {
  private state: TradingPoolState | undefined;
  private readonly minOrderRemaining: number;
  private readonly minCancelRemaining: number;
  private readonly now: () => number;
  /** How long a reading stays trustworthy. */
  private readonly maxAgeMs: number;

  /**
   * When true (the default), an unread or stale pool BLOCKS order submission.
   *
   * Set false only when the account is not whitelisted for `GET /v1/rateLimit`
   * (which returns 403 for such accounts), because otherwise the system can never
   * open a position at all and the safety property is vacuous rather than useful.
   * With it false, throttling is still handled by the local weight budget, the
   * circuit breaker on observed 429s, and `Retry-After` — just without the
   * pre-emptive pool check.
   */
  private readonly requirePoolReading: boolean;

  constructor(options: {
    minOrderRemaining: number;
    minCancelRemaining?: number;
    maxAgeMs?: number;
    now?: () => number;
    requirePoolReading?: boolean;
  }) {
    this.minOrderRemaining = options.minOrderRemaining;
    this.minCancelRemaining = options.minCancelRemaining ?? 10;
    this.maxAgeMs = options.maxAgeMs ?? 300_000;
    this.now = options.now ?? (() => Date.now());
    this.requirePoolReading = options.requirePoolReading ?? true;
  }

  /** Record that the venue refused to disclose pool state (e.g. HTTP 403). */
  markUndisclosed(reason: string): void {
    this.undisclosedReason = reason;
    this.state = undefined;
  }

  private undisclosedReason?: string;

  get disclosureFailure(): string | undefined {
    return this.undisclosedReason;
  }

  update(state: Omit<TradingPoolState, 'observedAtMs'> & { observedAtMs?: number }): void {
    this.state = { ...state, observedAtMs: state.observedAtMs ?? this.now() };
  }

  /**
   * Whether a new order write is permitted.
   *
   * An unread or stale pool reading fails closed: we refuse to submit rather
   * than risk a rejection, because a rejected entry can leave a position with no
   * confirmed stop (the engine rejects the stop leg for the same reason).
   */
  canSubmitOrder(): { allowed: boolean; reason?: string } {
    if (!this.state) {
      if (!this.requirePoolReading) {
        // Explicitly configured to proceed without pool state; other throttling
        // layers (weight budget, 429 circuit breaker) still apply.
        return { allowed: true };
      }
      return {
        allowed: false,
        reason:
          this.undisclosedReason ??
          'trading pool state never read (GET /v1/rateLimit)',
      };
    }
    const age = this.now() - this.state.observedAtMs;
    if (age > this.maxAgeMs) {
      return {
        allowed: false,
        reason: `trading pool state is stale (${age}ms old, limit ${this.maxAgeMs}ms)`,
      };
    }
    if (this.state.orderRemaining < this.minOrderRemaining) {
      return {
        allowed: false,
        reason: `order pool remaining ${this.state.orderRemaining} < minimum ${this.minOrderRemaining}`,
      };
    }
    return { allowed: true };
  }

  /**
   * Whether a cancel is permitted.
   *
   * Cancels are treated more permissively than places: cancelling a stale entry
   * order is a risk-REDUCING action, so the pool is only consulted to avoid a
   * guaranteed rejection. `cancelAllOrders` is not routed through here at all —
   * it is reserved for kill-switch paths that must proceed regardless.
   */
  canCancelOrder(): { allowed: boolean; reason?: string } {
    if (!this.state) {
      // A cancel is safe to attempt even without a pool reading.
      return { allowed: true };
    }
    if (this.state.cancelRemaining < this.minCancelRemaining) {
      return {
        allowed: false,
        reason: `cancel pool remaining ${this.state.cancelRemaining} < minimum ${this.minCancelRemaining}`,
      };
    }
    return { allowed: true };
  }

  get snapshotState(): TradingPoolState | undefined {
    return this.state;
  }
}
