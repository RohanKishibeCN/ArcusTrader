/**
 * Arcus REST client.
 *
 * Wraps the 32 verified operations with:
 *   - zod validation of every response, so a field rename upstream surfaces as a
 *     typed failure for that call rather than as `undefined` flowing into sizing
 *     arithmetic later;
 *   - client-side weight accounting, so read traffic cannot silently exhaust the
 *     per-IP bucket (`src/arcus/RateLimiter.ts`);
 *   - 429 handling that honours `Retry-After` and the `reason` discriminator;
 *   - a hard rule that no credential is ever logged.
 *
 * Error taxonomy matters for fail-closed behaviour, so failures are typed:
 *   - `ArcusHttpError`      — non-2xx with a parsed body
 *   - `ArcusRateLimitError` — 429, carrying `retryAfterMs` and the pool reason
 *   - `ArcusValidationError`— 2xx whose body did not match the expected schema
 *   - `ArcusNetworkError`   — transport failure or timeout
 *
 * Callers distinguish `ArcusValidationError` (schema drift → treat the datum as
 * unavailable) from success. Nothing here retries silently: retry policy belongs
 * to the caller, which knows whether the datum is safe to operate without.
 */

import { z } from 'zod';
import { Decimal, dec } from '../util/decimal';
import type { Logger } from '../util/logger';
import { describeSignature } from '../util/logger';
import type { ArcusSigner } from './ArcusSigner';
import { canonicalJson } from './ArcusSigner';
import { ThrottleCircuitBreaker, WeightBudget, type WeightedEndpoint } from './RateLimiter';
import type {
  Account,
  BBO,
  CancelOrderRequest,
  Candle,
  FeeTiersResponse,
  GetAccountTransferUpdatesResponse,
  GetFillsResponse,
  GetFundingPaymentsResponse,
  GetLeveragesResponse,
  GetMarketFundingRatesResponse,
  GetOpenOrdersResponse,
  GetRateLimitResponse,
  GetTradesResponse,
  MarketInfo,
  Order,
  OrderResponse,
  OrderbookSnapshot,
  PlaceOrderRequest,
  Position,
  AffiliateInfo,
} from './types';

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

export class ArcusError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ArcusError';
  }
}

/** 1e9 quote quantums = $1. */
const QUOTE_QUANTUMS_PER_USD = '1000000000';

/**
 * `GET /v1/affiliate/info` response.
 *
 * Every rollup-backed field is optional and nullable in practice: the endpoint
 * "degrades gracefully" and returns 0 when the hourly rollup is unavailable, rather
 * than failing. Treated as 0 here so a temporarily-missing rollup cannot break the
 * report.
 */
const affiliateInfoSchema = z
  .object({
    address: z.string(),
    code: z.string().optional().nullable(),
    kickbackBps: z.number().optional().nullable(),
    tier: z.number().optional().nullable(),
    totalCommission: z.union([z.number(), z.string()]).optional().nullable(),
    pendingCommission: z.union([z.number(), z.string()]).optional().nullable(),
    commission30d: z.union([z.number(), z.string()]).optional().nullable(),
    volume30d: z.union([z.number(), z.string()]).optional().nullable(),
    totalReferredVolume30d: z.union([z.number(), z.string()]).optional().nullable(),
    totalReferredVolumeAllTime: z.union([z.number(), z.string()]).optional().nullable(),
    traderCount: z.number().optional().nullable(),
    // Accept both the BPS spelling and the ppm spelling used by GET /v1/feetiers.
    tradingFeeTier: z
      .object({
        level: z.number().optional(),
        name: z.string().optional(),
        makerFeeBps: z.union([z.number(), z.string()]).optional().nullable(),
        takerFeeBps: z.union([z.number(), z.string()]).optional().nullable(),
        // VERIFIED LIVE: the payload uses camelCase ppm, not the snake_case used by
        // GET /v1/feetiers, and not bps despite the schema's field name.
        makerFeePpm: z.union([z.number(), z.string()]).optional().nullable(),
        takerFeePpm: z.union([z.number(), z.string()]).optional().nullable(),
        maker_fee_ppm: z.union([z.number(), z.string()]).optional().nullable(),
        taker_fee_ppm: z.union([z.number(), z.string()]).optional().nullable(),
      })
      .passthrough()
      .optional()
      .nullable(),
  })
  .passthrough();

export interface AffiliateInfoResponse extends AffiliateInfo {}

export class ArcusHttpError extends ArcusError {
  readonly status: number;
  readonly path: string;
  readonly body: unknown;
  constructor(status: number, path: string, body: unknown, message?: string) {
    super(message ?? `HTTP ${status} on ${path}`);
    this.name = 'ArcusHttpError';
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

/** 429. `reason` distinguishes the per-IP bucket from a per-subaccount pool. */
export class ArcusRateLimitError extends ArcusHttpError {
  readonly retryAfterMs: number;
  readonly reason?: 'ip' | 'account_empty' | 'account_partial';
  constructor(
    path: string,
    body: unknown,
    retryAfterMs: number,
    reason?: 'ip' | 'account_empty' | 'account_partial',
  ) {
    super(429, path, body, `rate limited on ${path} (reason=${reason ?? 'ip'}, retryAfterMs=${retryAfterMs})`);
    this.name = 'ArcusRateLimitError';
    this.retryAfterMs = retryAfterMs;
    this.reason = reason;
  }
}

/** A 2xx whose payload did not satisfy the expected schema. Treat as unavailable. */
export class ArcusValidationError extends ArcusError {
  readonly path: string;
  readonly issues: readonly string[];
  constructor(path: string, issues: readonly string[]) {
    super(`response schema mismatch on ${path}: ${issues.slice(0, 5).join('; ')}`);
    this.name = 'ArcusValidationError';
    this.path = path;
    this.issues = issues;
  }
}

export class ArcusNetworkError extends ArcusError {
  readonly path: string;
  constructor(path: string, cause: unknown) {
    super(`network failure on ${path}: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
    this.name = 'ArcusNetworkError';
    this.path = path;
  }
}

/* ------------------------------------------------------------------ *
 * Response schemas
 * ------------------------------------------------------------------ */

const decimalString = z.string();

const marketInfoSchema = z
  .object({
    marketDisplayName: z.string(),
    fullAssetName: z.string().nullable().optional(),
    marketId: z.number().int(),
    status: z.string(),
    baseAsset: z.string(),
    quoteAsset: z.string(),
    tickSize: decimalString,
    stepSize: decimalString,
    // Live shape: {upToPrice?: decimal-string, tick: decimal-string}. `upToPrice`
    // is absent on the unbounded top band, hence the `.optional()`.
    tickTiers: z
      .array(z.object({ upToPrice: z.string().optional(), tick: z.string() }).passthrough())
      .default([]),
    minOrderNotional: decimalString,
    minOrderSize: decimalString,
    maxOrderSize: decimalString,
    oraclePrice: decimalString.nullable().optional(),
    markPrice: decimalString.nullable().optional(),
    lastTradePrice: decimalString.nullable().optional(),
    fundingRate: decimalString.nullable().optional(),
    nextFundingRate: decimalString.nullable().optional(),
    nextFundingAt: z.number().nullable().optional(),
    priceChange24h: decimalString.nullable().optional(),
    volume24h: decimalString.nullable().optional(),
    volume24hNotional: decimalString.nullable().optional(),
    high24h: decimalString.nullable().optional(),
    low24h: decimalString.nullable().optional(),
    trades24h: z.number().optional(),
    openInterest: decimalString.nullable().optional(),
    openInterestCapNotional: decimalString.nullable().optional(),
    initialMarginFraction: decimalString.nullable().optional(),
    maintenanceMarginFraction: decimalString.nullable().optional(),
    offHoursInitialMarginFraction: decimalString.nullable().optional(),
    regularTradingHours: z.record(z.unknown()).nullable().optional(),
    liquidationFeePpm: z.union([z.string(), z.number()]).optional(),
    /**
     * Off-hours flag.
     *
     * Observed live as `null` for markets whose calendar is not applicable (many
     * crypto perps). Typed `boolean | null` rather than coerced here, because the
     * caller must decide what null MEANS — and for the off-hours rule the safe
     * reading is "unknown", not "RTH is open". See `MarketProvider.isTradable`.
     */
    isOutsideRth: z.boolean().nullable(),
    currentSettlementPrice: decimalString.nullable().optional(),
    upperTradingBound: decimalString.nullable().optional(),
    lowerTradingBound: decimalString.nullable().optional(),
    nextUpperTradingBound: decimalString.nullable().optional(),
    nextLowerTradingBound: decimalString.nullable().optional(),
    isUpperInExpansionZone: z.boolean().nullable().optional(),
    isLowerInExpansionZone: z.boolean().nullable().optional(),
    upperZoneEnteredAt: z.number().nullable().optional(),
    upperExpectedExpansionAt: z.number().nullable().optional(),
    lowerZoneEnteredAt: z.number().nullable().optional(),
    lowerExpectedExpansionAt: z.number().nullable().optional(),
    type: z.string(),
    category: z.string(),
    addedTimestamp: z.number().nullable().optional(),
    assetResolution: decimalString.nullable().optional(),
    pythId: z.string().nullable().optional(),
  })
  .passthrough();

const marketsResponseSchema = z.object({ markets: z.array(marketInfoSchema) }).passthrough();

const candleSchema = z
  .object({
    marketDisplayName: z.string(),
    marketId: z.number().int(),
    timeframe: z.string(),
    openTime: z.number(),
    open: decimalString,
    high: decimalString,
    low: decimalString,
    close: decimalString,
    volume: decimalString,
    takerBuyVolume: decimalString,
    notionalVolume: decimalString,
    takerBuyNotionalVolume: decimalString,
    tradeCount: z.number(),
    isFinal: z.boolean(),
  })
  .passthrough();

const candlesResponseSchema = z.object({ candles: z.array(candleSchema) }).passthrough();

/**
 * BBO sides are objects with named fields (verified live).
 */
const bboLevelSchema = z.object({ price: decimalString, size: decimalString }).passthrough();
const bboSchema = z
  .object({
    bestBid: bboLevelSchema.nullable().optional(),
    bestAsk: bboLevelSchema.nullable().optional(),
    lastSequenceId: z.number().optional(),
    globalSequenceId: z.number().optional(),
    timestamp: z.number().optional(),
  })
  .passthrough();

/**
 * L2 levels are POSITIONAL TUPLES `[price, size]` (verified live), not objects.
 * The tuple is validated as a 2-element array of decimal strings and converted to
 * the nominal `OrderbookLevel` type at this boundary.
 */
const orderbookLevelSchema = z.tuple([decimalString, decimalString]);
const orderbookSchema = z
  .object({
    bids: z.array(orderbookLevelSchema).default([]),
    asks: z.array(orderbookLevelSchema).default([]),
    lastSequenceId: z.number().optional(),
    globalSequenceId: z.number().optional(),
    timestamp: z.number().optional(),
  })
  .passthrough();

const positionSchema = z
  .object({
    address: z.string(),
    accountIndex: z.number(),
    marketId: z.number().int(),
    marketDisplayName: z.string(),
    side: z.enum(['LONG', 'SHORT']),
    size: decimalString,
    averageEntryPrice: decimalString,
    cumulativeFunding: z.record(z.unknown()).optional(),
    leverage: decimalString,
    marginMode: z.enum(['CROSS', 'ISOLATED']),
    borrowedCapital: decimalString,
    marginUsed: decimalString,
    positionValueNotional: decimalString,
    unrealizedPnl: decimalString,
    markPx: decimalString,
    sequenceNumber: z.number().optional(),
  })
  .passthrough();

const accountSchema = z
  .object({
    accountIndex: z.number(),
    address: z.string(),
    netQuoteBalance: decimalString,
    equity: decimalString,
    freeCollateral: decimalString,
    netDeposits: decimalString,
    pendingDeposits: decimalString.optional(),
    pendingWithdrawals: decimalString.optional(),
    positions: z.record(positionSchema),
    sequenceNumber: z.number().optional(),
  })
  .passthrough();

const orderSchema = z
  .object({
    orderId: z.string(),
    clientId: z.string().optional(),
    address: z.string().optional(),
    accountIndex: z.number().optional(),
    marketId: z.number().int(),
    marketDisplayName: z.string(),
    side: z.enum(['BUY', 'SELL']),
    type: z.enum(['LIMIT', 'MARKET']).optional(),
    status: z.string(),
    price: decimalString,
    originalSize: decimalString,
    filledSize: decimalString.optional(),
    remainingSize: decimalString,
    avgFillPrice: decimalString.optional(),
    timeInForce: z.string().optional(),
    goodTilTime: z.string().optional(),
    reduceOnly: z.boolean().optional(),
    triggerPrice: decimalString.optional(),
    tpslType: z.enum(['STOP_LOSS', 'TAKE_PROFIT']).optional(),
    isPositionTPSL: z.boolean().optional(),
    parentOrderId: z.string().optional(),
    rejectionReason: z.string().optional(),
    cancelReason: z.string().optional(),
    state: z.string().optional(),
    positionEffect: z.string().optional(),
    createdAt: z.number().optional(),
    updatedAt: z.number(),
    sequenceNumber: z.number().optional(),
  })
  .passthrough();

const fillSchema = z
  .object({
    tradeId: z.string(),
    orderId: z.string(),
    address: z.string().optional(),
    accountIndex: z.number().optional(),
    marketId: z.number().int(),
    marketDisplayName: z.string(),
    clientId: z.string().optional(),
    side: z.enum(['BUY', 'SELL']),
    originalSize: decimalString,
    size: decimalString,
    price: decimalString,
    fee: decimalString,
    closedPnl: decimalString.optional(),
    role: z.enum(['MAKER', 'TAKER']),
    remainingSize: decimalString.optional(),
    positionEffect: z.string().optional(),
    createdAt: z.number(),
    sequenceNumber: z.number().optional(),
    liquidation: z.record(z.unknown()).optional(),
  })
  .passthrough();

const fundingPaymentSchema = z
  .object({
    marketId: z.number().int(),
    marketDisplayName: z.string().optional(),
    payment: decimalString,
    time: z.number(),
    rate: decimalString.optional(),
  })
  .passthrough();

/**
 * Historical funding rate row. VERIFIED LIVE: the field is `fundingRate`, not
 * `rate`, and the payload is `{"fundingRates":[...]}`. Both are accepted.
 */
const marketFundingRateSchema = z
  .object({
    marketId: z.number().int(),
    marketDisplayName: z.string().optional(),
    fundingRate: decimalString.optional(),
    rate: decimalString.optional(),
    time: z.number(),
  })
  .passthrough();

const transferUpdateSchema = z
  .object({
    type: z.string(),
    status: z.string(),
    amount: decimalString,
    accountIndex: z.number(),
    time: z.number(),
    txHash: z.string().optional(),
  })
  .passthrough();

/**
 * Trading pool state.
 *
 * VERIFIED LIVE: `{"order":{"used":96,"cap":4678349,"nextAvailableMs":0},
 * "cancel":{"used":11000,"cap":4698349,"nextAvailableMs":0}}`.
 *
 * The live names are `used` / `cap`, NOT the documented `capacity` / `remaining`.
 * `remaining` is derived as `cap - used`; both spellings are accepted so a
 * spec-shaped response still parses.
 */
const rateLimitPoolSchema = z
  .object({
    used: z.number().optional(),
    cap: z.number().optional(),
    capacity: z.number().optional(),
    remaining: z.number().optional(),
    nextAvailableMs: z.number().optional(),
    refillRatePerSecond: z.number().optional(),
  })
  .passthrough();

const rateLimitSchema = z
  .object({ order: rateLimitPoolSchema.optional(), cancel: rateLimitPoolSchema.optional() })
  .passthrough();

const orderResponseSchema = z
  .object({
    address: z.string(),
    accountIndex: z.number(),
    orderId: z.string(),
    marketId: z.number().int(),
    marketDisplayName: z.string(),
    side: z.enum(['BUY', 'SELL']),
    quantity: decimalString,
    price: decimalString,
    status: z.string(),
    createdAt: z.number(),
    clientId: z.string().optional(),
    updatedAt: z.number().optional(),
    remainingSize: decimalString.optional(),
    filledSize: decimalString.optional(),
    rejectionReason: z.string().optional(),
  })
  .passthrough();

/**
 * Public trade row.
 *
 * VERIFIED LIVE: `GET /v1/trades` returns `timestamp` (epoch µs), NOT `createdAt`
 * as the endpoint's OpenAPI fragment suggests, plus maker/taker order ids and
 * addresses. Both timestamp spellings are accepted so either document shape parses.
 */
const tradeSchema = z
  .object({
    tradeId: z.string(),
    marketId: z.number().int(),
    marketDisplayName: z.string().optional(),
    price: decimalString,
    size: decimalString,
    side: z.enum(['BUY', 'SELL']).optional(),
    timestamp: z.number().optional(),
    createdAt: z.number().optional(),
    makerOrderId: z.string().optional(),
    takerOrderId: z.string().optional(),
    sequenceNumber: z.number().optional(),
  })
  .passthrough();

const leverageEntrySchema = z
  .object({
    marketId: z.number().int(),
    leverage: decimalString,
    marginMode: z.enum(['CROSS', 'ISOLATED']),
  })
  .passthrough();

/**
 * Fee tier row.
 *
 * VERIFIED LIVE against `GET /v1/feetiers`, whose actual shape is
 * `{"tiers":[{"level":0,"name":"Base","volume_threshold":0,"maker_fee_ppm":0,
 * "taker_fee_ppm":225}]}` — note the snake_case names and the unit: fees are in
 * PARTS PER MILLION, not basis points. An earlier schema guessed
 * `makerFeeBps`/`tierLevel` and therefore always fell back to the configured
 * default rates, silently overstating maker fees. Both spellings are accepted
 * here so a spec-compliant response would also parse.
 */
const feeTierRowSchema = z
  .object({
    level: z.number().optional(),
    name: z.string().optional(),
    tierLevel: z.number().optional(),
    volume_threshold: z.union([decimalString, z.number()]).optional(),
    volumeThreshold: decimalString.optional(),
    maker_fee_ppm: z.union([decimalString, z.number()]).optional(),
    taker_fee_ppm: z.union([decimalString, z.number()]).optional(),
    makerFeeBps: decimalString.optional(),
    takerFeeBps: decimalString.optional(),
  })
  .passthrough();

/** Convert parts-per-million to basis points. 1 bp = 100 ppm. */
export function ppmToBps(ppm: string | number): string {
  const value = typeof ppm === 'number' ? String(ppm) : ppm;
  return new Decimal(value).div(100).toString();
}

/**
 * Server time.
 *
 * VERIFIED LIVE: `GET /v1/time` returns `{"timeNs":"1791882169366870379"}` — the
 * field is `timeNs`, NOT `time` as the endpoint's OpenAPI fragment states. Both are
 * accepted so either document shape parses, but the live one is what is sent.
 */
const timeSchema = z
  .object({
    // Live payload sends a JSON NUMBER for `timeNs`; the doc fragment shows a
    // string. Both are accepted and normalised to a decimal string, since a
    // nanosecond epoch exceeds Number.MAX_SAFE_INTEGER and must not be re-parsed
    // from a float downstream.
    timeNs: z.union([z.string(), z.number()]).optional(),
    time: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

/* ------------------------------------------------------------------ *
 * Client
 * ------------------------------------------------------------------ */

export interface ArcusRestClientOptions {
  readonly baseUrl: string;
  readonly logger: Logger;
  readonly signer?: ArcusSigner;
  readonly weightBudget?: WeightBudget;
  readonly circuitBreaker?: ThrottleCircuitBreaker;
  /** Used to construct the breaker when one is not supplied directly. */
  readonly circuitBreakerOptions?: {
    readonly threshold?: number;
    readonly cooldownMs?: number;
    readonly maxCooldownMs?: number;
  };
  /** Per-request timeout. Default 10s. */
  readonly timeoutMs?: number;
  /** Injectable fetch for tests. */
  readonly fetchImpl?: typeof fetch;
}

interface RequestOptions {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly endpoint: WeightedEndpoint;
  readonly query?: Record<string, string | number | undefined>;
  readonly body?: unknown;
  /** Send signature headers. */
  readonly signed?: boolean;
  /** Scheme 2 action name; defaults to the last path segment. */
  readonly action?: string;
  /** Pre-built Scheme 1 headers (placeOrder/cancelOrder/modifyOrder). */
  readonly typedSignature?: { timestamp: string; signature: string };
  /** Callers may opt out of weight accounting (e.g. /health). */
  readonly skipWeight?: boolean;
}

export class ArcusRestClient {
  private readonly baseUrl: string;
  private readonly logger: Logger;
  /** Exposed so the executor can stamp a request from the SAME clock that signs it. */
  readonly signer?: ArcusSigner;
  readonly weightBudget: WeightBudget;
  readonly circuitBreaker: ThrottleCircuitBreaker;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ArcusRestClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.logger = options.logger;
    this.signer = options.signer;
    this.weightBudget = options.weightBudget ?? new WeightBudget();
    this.circuitBreaker =
      options.circuitBreaker ?? new ThrottleCircuitBreaker(options.circuitBreakerOptions ?? {});
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** True when a signer is available for mutating requests. */
  get canSign(): boolean {
    return this.signer !== undefined;
  }

  get apiKeyHex(): string | undefined {
    return this.signer?.apiKeyHex;
  }

  /**
   * Current time in Unix nanoseconds, from the signer's monotonic clock.
   *
   * The executor needs this so the body's `timestamp`, the signed `ct` and the
   * `X-Timestamp` header are byte-identical. Falls back to wall-clock only when no
   * signer exists, which is exactly the dry-run case where no request is sent.
   */
  nowNanos(): bigint {
    if (this.signer) return this.signer.nowNanos();
    return BigInt(Date.now()) * 1_000_000n;
  }

  /**
   * `goodTilTime` for a resting order, in epoch MICROSECONDS (the unit the REST
   * body uses). The signer multiplies by 1000 to produce the signed `g`.
   */
  goodTilTimeMicros(days: number): string {
    if (!Number.isFinite(days) || days <= 0) throw new ArcusError(`invalid goodTilTime days: ${days}`);
    const micros = this.nowNanos() / 1000n + BigInt(Math.round(days * 86_400 * 1_000_000));
    return micros.toString();
  }

  private buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  /**
   * Execute a request.
   *
   * The 429 path is deliberately explicit: the server's `reason` field says
   * WHICH bucket rejected us, and `Retry-After` (or `retryAfterMs` for writes)
   * says how long to wait. Both are surfaced on the thrown error so the caller
   * can decide, rather than this layer sleeping and hiding the condition.
   */
  private async request<T>(options: RequestOptions, schema: z.ZodType<T>): Promise<T> {
    if (!options.skipWeight) {
      if (this.circuitBreaker.isOpen) {
        throw new ArcusRateLimitError(
          options.path,
          { error: 'client circuit breaker open' },
          this.circuitBreaker.remainingMs(),
          'ip',
        );
      }
      if (!this.weightBudget.spend(options.endpoint)) {
        const waitMs = this.weightBudget.waitMsFor(options.endpoint);
        this.logger.warn(
          { path: options.path, endpoint: options.endpoint, waitMs },
          'skipping request: local weight budget exhausted',
        );
        throw new ArcusRateLimitError(options.path, { error: 'local weight budget exhausted' }, waitMs, 'ip');
      }
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options.signed) {
      if (!this.signer) throw new ArcusError(`cannot sign ${options.path}: no signing key configured`);
      if (options.typedSignature) {
        headers['X-API-Key'] = this.signer.apiKeyHex;
        headers['X-Timestamp'] = options.typedSignature.timestamp;
        headers['X-Signature'] = options.typedSignature.signature;
      } else {
        const nanos = this.signer.nowNanos().toString();
        const action = options.action ?? options.path.split('/').filter(Boolean).pop() ?? '';
        const { signature } = this.signer.signLegacyMessage(nanos, action, options.body);
        headers['X-API-Key'] = this.signer.apiKeyHex;
        headers['X-Timestamp'] = nanos;
        headers['X-Signature'] = signature;
      }
    }

    const url = this.buildUrl(options.path, options.query);
    const method = options.method;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      this.logger.warn({ path: options.path, err: String(error) }, 'arcus request failed at transport');
      throw new ArcusNetworkError(options.path, error);
    }

    const text = await response.text();
    let parsed: unknown = undefined;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!response.ok) {
      if (response.status === 429) {
        const body = (parsed ?? {}) as Record<string, unknown>;
        const reason =
          body.reason === 'ip' || body.reason === 'account_empty' || body.reason === 'account_partial'
            ? body.reason
            : undefined;
        const retryAfterHeader = Number(response.headers.get('retry-after') ?? '0');
        const retryAfterMs =
          typeof body.retryAfterMs === 'number'
            ? body.retryAfterMs
            : Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
              ? retryAfterHeader * 1000
              : 1000;
        this.weightBudget.recordThrottled();
        this.circuitBreaker.recordThrottled();
        throw new ArcusRateLimitError(options.path, body, retryAfterMs, reason);
      }
      throw new ArcusHttpError(response.status, options.path, parsed);
    }

    this.circuitBreaker.recordSuccess();

    const result = schema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
      throw new ArcusValidationError(options.path, issues);
    }
    return result.data;
  }

  /* ---------------------------------------------------------------- *
   * Public reads
   * ---------------------------------------------------------------- */

  async health(): Promise<unknown> {
    return this.request({ method: 'GET', path: '/health', endpoint: 'health', skipWeight: true }, z.unknown());
  }

  async serverTimeNanos(): Promise<string> {
    const res = await this.request(
      { method: 'GET', path: '/v1/time', endpoint: 'time' },
      timeSchema,
    );
    const raw = res.timeNs ?? res.time;
    if (raw === undefined) {
      throw new ArcusValidationError('/v1/time', ['neither `timeNs` nor `time` was present']);
    }
    // A JSON number here has already lost precision in the low nanosecond digits.
    // It is only used for a coarse clock-skew check, so that is acceptable — but the
    // signed request timestamp always comes from the local monotonic clock instead,
    // never from this value.
    return typeof raw === 'string' ? raw : String(raw);
  }

  /**
   * Precomputed mid prices for every market.
   *
   * VERIFIED LIVE: `{"mids":{"BTC-USD":"83298.15", …}}` — a nested `mids` object
   * keyed by TICKER with decimal-string values, not a flat map of objects.
   */
  async getAllMids(): Promise<Record<string, string>> {
    const res = await this.request(
      { method: 'GET', path: '/v1/mids', endpoint: 'mids' },
      z.object({ mids: z.record(decimalString) }).passthrough(),
    );
    return res.mids;
  }

  /**
   * Live prices for all markets.
   *
   * VERIFIED LIVE: keyed by marketId as a STRING, with `marketDisplayName`,
   * `oraclePrice`, `markPrice` and `sequencer` (not `sequenceNumber`). The
   * `sequencer` value is a global counter, useful for detecting a stale snapshot.
   */
  async getPrices(): Promise<Record<string, unknown>> {
    const res = await this.request(
      { method: 'GET', path: '/v1/prices', endpoint: 'prices' },
      z.record(
        z
          .object({
            marketDisplayName: z.string().optional(),
            oraclePrice: decimalString.optional(),
            markPrice: decimalString.optional(),
            sequencer: z.number().optional(),
            sequenceNumber: z.number().optional(),
          })
          .passthrough(),
      ),
    );
    return res;
  }

  async getMarkets(market?: string): Promise<readonly MarketInfo[]> {
    const res = await this.request(
      { method: 'GET', path: '/v1/markets', endpoint: 'markets', query: { market } },
      marketsResponseSchema,
    );
    return res.markets as readonly MarketInfo[];
  }

  /**
   * Historical candles.
   *
   * `to` is REQUIRED by the API — omitting it is a 400, not a defaulted window.
   * It is epoch microseconds. `countback` and `from` are mutually exclusive.
   */
  async getCandles(params: {
    market: string;
    timeframe: string;
    /** Epoch microseconds. Required. */
    to: number;
    from?: number;
    countback?: number;
  }): Promise<readonly Candle[]> {
    if (params.from !== undefined && params.countback !== undefined) {
      throw new ArcusError('getCandles: `from` and `countback` are mutually exclusive');
    }
    const res = await this.request(
      {
        method: 'GET',
        path: '/v1/candles',
        endpoint: 'candles',
        query: {
          market: params.market,
          timeframe: params.timeframe,
          to: params.to,
          from: params.from,
          countback: params.countback,
        },
      },
      candlesResponseSchema,
    );
    return res.candles as readonly Candle[];
  }

  async getBbo(market: string): Promise<BBO> {
    const res = await this.request(
      { method: 'GET', path: `/v1/bbo/${encodeURIComponent(market)}`, endpoint: 'bbo' },
      bboSchema,
    );
    return res as BBO;
  }

  async getL2Orderbook(market: string, nLevels?: number): Promise<OrderbookSnapshot> {
    const res = await this.request(
      {
        method: 'GET',
        path: `/v1/l2OrderBook/${encodeURIComponent(market)}`,
        endpoint: 'bbo',
        query: { nLevels },
      },
      orderbookSchema,
    );
    return res as OrderbookSnapshot;
  }

  async getMarketsFundingRates(params: {
    market: string;
    from?: number;
    to?: number;
  }): Promise<GetMarketFundingRatesResponse> {
    const res = await this.request(
      {
        method: 'GET',
        path: '/v1/fundingRates',
        endpoint: 'fundingRates',
        query: { market: params.market, from: params.from, to: params.to },
      },
      z.object({ fundingRates: z.array(marketFundingRateSchema) }).passthrough(),
    );
    return res as GetMarketFundingRatesResponse;
  }

  /**
   * Affiliate / referral standing for the caller's wallet.
   *
   * Requires an Ed25519 signature even though it is a GET: `X-API-Key` alone proves
   * nothing because API keys are public keys that anyone can list. With no body the
   * signing message is `timestamp + action`, where the action is the path segment
   * verbatim (`info`).
   *
   * Address-scoped only — no `accountIndex` — so `volume30d` spans every subaccount.
   */
  async getAffiliateInfo(address: string): Promise<AffiliateInfoResponse> {
    const res = await this.request(
      {
        method: 'GET',
        path: '/v1/affiliate/info',
        endpoint: 'affiliateInfo',
        query: { address },
        // Sign when a key is available, but do not require one.
        //
        // VERIFIED LIVE 2026-10-25: this endpoint returns 200 with NO auth headers at
        // all, despite the docs describing it as signed and 403-scoped to the caller.
        // Requiring a signature would make the readout unavailable for no reason; not
        // sending one keeps working today and degrades to a 401 — handled by callers —
        // if the venue starts enforcing the documented behaviour.
        signed: this.signer !== undefined,
        action: 'info',
      },
      affiliateInfoSchema,
    );

    // 1e9 quote quantums = $1.
    const usd = (value: unknown): Decimal => {
      if (value === null || value === undefined) return dec('0');
      const raw = typeof value === 'number' ? String(value) : String(value);
      if (!/^-?[0-9]+$/.test(raw)) {
        // A float would mean the field is not the documented integer amount; treat it
        // as unknown rather than silently rounding money.
        throw new ArcusError(`affiliate amount is not an integer quantum value: ${raw}`);
      }
      return dec(raw).div(QUOTE_QUANTUMS_PER_USD);
    };

    const tier = res.tradingFeeTier;
    // 1 bp = 100 ppm. The live payload reports ppm, so it must be divided, not copied:
    // reading 150 ppm as 150 bps would overstate the fee by 100x.
    const asBps = (bps: unknown, ppm: unknown): Decimal | undefined => {
      if (bps !== undefined && bps !== null) return dec(String(bps));
      if (ppm !== undefined && ppm !== null) return dec(String(ppm)).div(100);
      return undefined;
    };
    const maker = asBps(tier?.makerFeeBps, tier?.makerFeePpm ?? tier?.maker_fee_ppm);
    const taker = asBps(tier?.takerFeeBps, tier?.takerFeePpm ?? tier?.taker_fee_ppm);

    return {
      address: res.address.toLowerCase(),
      code: res.code ?? '',
      kickbackBps: res.kickbackBps ?? 0,
      tier: res.tier ?? 0,
      totalCommissionUsd: usd(res.totalCommission),
      pendingCommissionUsd: usd(res.pendingCommission),
      commission30dUsd: usd(res.commission30d),
      volume30dUsd: usd(res.volume30d),
      referredVolume30dUsd: usd(res.totalReferredVolume30d),
      referredVolumeAllTimeUsd: usd(res.totalReferredVolumeAllTime),
      traderCount: res.traderCount ?? 0,
      ...(tier
        ? {
            tradingFeeTier: {
              level: tier.level ?? 0,
              ...(maker !== undefined ? { makerFeeBps: maker } : {}),
              ...(taker !== undefined ? { takerFeeBps: taker } : {}),
            },
          }
        : {}),
    };
  }

  async getFeeTiers(): Promise<FeeTiersResponse> {
    const res = await this.request(
      { method: 'GET', path: '/v1/feetiers', endpoint: 'feeTiers' },
      // The live key is `tiers`; `feeTiers` is accepted for a spec-shaped response.
      z
        .object({
          tiers: z.array(feeTierRowSchema).optional(),
          feeTiers: z.array(feeTierRowSchema).optional(),
        })
        .passthrough(),
    );
    const rows = res.tiers ?? res.feeTiers ?? [];
    return { feeTiers: rows } as FeeTiersResponse;
  }

  async getRecentTrades(params: { market: string; limit?: number }): Promise<GetTradesResponse> {
    const res = await this.request(
      {
        method: 'GET',
        path: '/v1/trades',
        endpoint: 'trades',
        query: { market: params.market, limit: params.limit },
      },
      z.object({ trades: z.array(tradeSchema) }).passthrough(),
    );
    return res as GetTradesResponse;
  }

  /**
   * Per-subaccount trading pools.
   *
   * Requires `address` (and honours `accountIndex`): calling it bare returns
   * `400 {"error":"address not on access whitelist"}`, and an address that is not
   * whitelisted for this endpoint returns `403`. Both were observed live. This
   * endpoint is therefore NOT publicly readable in the way the other account
   * reads are, which means a 403 here is an operational fact about the account
   * rather than a bug — the caller must decide whether it can trade without a
   * pool reading (see `TradingPoolGuard`).
   */
  async getRateLimit(params?: { address?: string; accountIndex?: number }): Promise<GetRateLimitResponse> {
    const res = (await this.request(
      {
        method: 'GET',
        path: '/v1/rateLimit',
        endpoint: 'rateLimit',
        query: { address: params?.address, accountIndex: params?.accountIndex },
      },
      rateLimitSchema,
    )) as {
      order?: { used?: number; cap?: number; capacity?: number; remaining?: number };
      cancel?: { used?: number; cap?: number; capacity?: number; remaining?: number };
    };

    const normalise = (pool: typeof res.order): { capacity: number; remaining: number } | undefined => {
      if (!pool) return undefined;
      const capacity = pool.cap ?? pool.capacity ?? 0;
      const remaining = pool.remaining ?? Math.max(0, capacity - (pool.used ?? 0));
      return { capacity, remaining };
    };

    return {
      ...(normalise(res.order) ? { order: normalise(res.order) } : {}),
      ...(normalise(res.cancel) ? { cancel: normalise(res.cancel) } : {}),
    } as GetRateLimitResponse;
  }

  /* ---------------------------------------------------------------- *
   * Account reads
   * ---------------------------------------------------------------- */

  /**
   * Account snapshot, including open positions keyed by marketId.
   *
   * A brand-new unfunded account returns 404 "this account has no activity yet"
   * rather than a zeroed account. That is expected, not an error, and is
   * surfaced as `undefined` so callers can distinguish "no account yet" from
   * "could not read the account".
   */
  async getAccount(address: string, accountIndex: number): Promise<Account | undefined> {
    try {
      const res = await this.request(
        {
          method: 'GET',
          path: '/v1/account',
          endpoint: 'account',
          query: { address, accountIndex },
        },
        accountSchema,
      );
      return res as Account;
    } catch (error) {
      if (error instanceof ArcusHttpError && error.status === 404) return undefined;
      throw error;
    }
  }

  /**
   * Open positions.
   *
   * VERIFIED LIVE against a whitelisted account: the response is
   * `{"positions": {}, "total": 0}` — `positions` is a MAP keyed by marketId, exactly
   * like `account.positions`, NOT the array the endpoint's OpenAPI fragment declares.
   * An array parser rejects the real payload, so both shapes are accepted and
   * normalised to an array here.
   */
  async getPositions(address: string, accountIndex: number): Promise<readonly Position[]> {
    const positionsMapSchema = z.union([
      z.array(positionSchema),
      z.record(positionSchema),
    ]);
    const res = await this.request(
      {
        method: 'GET',
        path: '/v1/positions',
        endpoint: 'positions',
        query: { address, accountIndex },
      },
      z.object({ positions: positionsMapSchema }).passthrough(),
    );
    const raw = res.positions;
    return Array.isArray(raw) ? (raw as Position[]) : (Object.values(raw) as Position[]);
  }

  async getOpenOrders(params: {
    address: string;
    accountIndex: number;
    market?: string;
  }): Promise<readonly Order[]> {
    const res = await this.request(
      {
        method: 'GET',
        path: '/v1/openOrders',
        endpoint: 'openOrders',
        query: {
          address: params.address,
          accountIndex: params.accountIndex,
          market: params.market,
        },
      },
      z.object({ orders: z.array(orderSchema) }).passthrough(),
    );
    return res.orders as readonly Order[];
  }

  async getOrderHistory(params: {
    address: string;
    accountIndex: number;
    market?: string;
    from?: number;
    to?: number;
  }): Promise<GetOpenOrdersResponse> {
    const res = await this.request(
      {
        method: 'GET',
        path: '/v1/orders',
        endpoint: 'orders',
        query: {
          address: params.address,
          accountIndex: params.accountIndex,
          market: params.market,
          from: params.from,
          to: params.to,
        },
      },
      z.object({ orders: z.array(orderSchema) }).passthrough(),
    );
    return res as GetOpenOrdersResponse;
  }

  async getOrderStatus(params: {
    address: string;
    accountIndex: number;
    orderId: string;
  }): Promise<Order | undefined> {
    try {
      const res = await this.request(
        {
          method: 'GET',
          path: `/v1/order/${encodeURIComponent(params.orderId)}`,
          endpoint: 'order',
          query: { address: params.address, accountIndex: params.accountIndex },
        },
        orderSchema,
      );
      return res as Order;
    } catch (error) {
      if (error instanceof ArcusHttpError && error.status === 404) return undefined;
      throw error;
    }
  }

  async getFills(params: {
    address: string;
    accountIndex: number;
    market?: string;
    from?: number;
    to?: number;
  }): Promise<GetFillsResponse> {
    const res = await this.request(
      {
        method: 'GET',
        path: '/v1/fills',
        endpoint: 'fills',
        query: {
          address: params.address,
          accountIndex: params.accountIndex,
          market: params.market,
          from: params.from,
          to: params.to,
        },
      },
      z.object({ fills: z.array(fillSchema) }).passthrough(),
    );
    return res as GetFillsResponse;
  }

  /** Funding PAYMENTS for the account (not rates — see getMarketsFundingRates). */
  async getFundingPayments(params: {
    address: string;
    accountIndex: number;
    market?: string;
    from?: number;
    to?: number;
  }): Promise<GetFundingPaymentsResponse> {
    const res = await this.request(
      {
        method: 'GET',
        path: '/v1/funding',
        endpoint: 'funding',
        query: {
          address: params.address,
          accountIndex: params.accountIndex,
          market: params.market,
          from: params.from,
          to: params.to,
        },
      },
      z.object({ funding: z.array(fundingPaymentSchema) }).passthrough(),
    );
    return res as GetFundingPaymentsResponse;
  }

  /** Deposits, withdrawals and transfers. Drives the cash-flow ledger. */
  async getAccountTransferUpdates(params: {
    address: string;
    accountIndex: number;
    from?: number;
    to?: number;
  }): Promise<GetAccountTransferUpdatesResponse> {
    const res = await this.request(
      {
        method: 'GET',
        path: '/v1/accountTransferUpdates',
        endpoint: 'orders',
        query: {
          address: params.address,
          accountIndex: params.accountIndex,
          from: params.from,
          to: params.to,
        },
      },
      z.object({ transfers: z.array(transferUpdateSchema) }).passthrough(),
    );
    return res as GetAccountTransferUpdatesResponse;
  }

  async getLeverages(address: string, accountIndex: number): Promise<GetLeveragesResponse> {
    const res = await this.request(
      {
        method: 'GET',
        path: '/v1/leverages',
        endpoint: 'leverages',
        query: { address, accountIndex },
      },
      z.object({ leverages: z.array(leverageEntrySchema) }).passthrough(),
    );
    return res as GetLeveragesResponse;
  }

  /* ---------------------------------------------------------------- *
   * Signed writes
   * ---------------------------------------------------------------- */

  /**
   * Place an order.
   *
   * The signed payload and the HTTP body are built from the SAME decimal
   * strings, and the signer asserts grid alignment before signing, so a body
   * whose `price`/`quantity` disagree with the signed `p`/`q` is not
   * representable. `timestamp` is shared verbatim between the body and the
   * `X-Timestamp` header.
   */
  async placeOrder(
    request: PlaceOrderRequest,
    market: { marketId: number; tickSize: string; stepSize: string },
  ): Promise<OrderResponse> {
    if (!this.signer) throw new ArcusError('placeOrder requires a signing key');
    const signed = this.signer.buildPlaceOrderPayload(request, market);
    this.logger.debug(
      {
        clientId: request.clientId,
        marketId: request.marketId,
        side: request.orderSide,
        price: request.price,
        quantity: request.quantity,
        timeInForce: request.timeInForce,
        reduceOnly: request.reduceOnly ?? false,
        signature: describeSignature(signed.signature),
      },
      'submitting order',
    );
    const res = await this.request(
      {
        method: 'POST',
        path: '/v1/placeOrder',
        endpoint: 'placeOrder',
        body: request,
        signed: true,
        typedSignature: { timestamp: request.timestamp, signature: signed.signature },
      },
      orderResponseSchema,
    );
    return res as OrderResponse;
  }

  async cancelOrder(
    request: CancelOrderRequest,
    market: { marketId: number },
  ): Promise<unknown> {
    if (!this.signer) throw new ArcusError('cancelOrder requires a signing key');
    const signed = this.signer.buildCancelOrderPayload(request, market);
    return this.request(
      {
        method: 'POST',
        path: '/v1/cancelOrder',
        endpoint: 'cancelOrder',
        body: request,
        signed: true,
        typedSignature: { timestamp: request.timestamp, signature: signed.signature },
      },
      z.unknown(),
    );
  }

  /**
   * Cancel every open order for the account.
   *
   * Uses Scheme 2 (`timestamp + action + canonical body`) and charges the cancel
   * pool a flat 1000, so it is reserved for kill-switch and reconciliation paths
   * rather than routine cleanup.
   */
  async cancelAllOrders(params: {
    address: string;
    accountIndex: number;
    marketId?: number;
  }): Promise<unknown> {
    if (!this.signer) throw new ArcusError('cancelAllOrders requires a signing key');
    const body: Record<string, unknown> = {
      address: params.address,
      accountIndex: params.accountIndex,
    };
    if (params.marketId !== undefined) body.marketId = params.marketId;
    const nanos = this.signer.nowNanos().toString();
    const { signature } = this.signer.signLegacyMessage(nanos, 'cancelAllOrders', body);
    return this.request(
      {
        method: 'POST',
        path: '/v1/cancelAllOrders',
        endpoint: 'cancelAllOrders',
        body,
        signed: true,
        typedSignature: { timestamp: nanos, signature },
      },
      z.unknown(),
    );
  }

  /**
   * Set leverage for one market.
   *
   * Scheme 2 signing. Not on the startup path: leverage is only ever lowered to
   * `MAX_LEVERAGE`, never raised, and a failure is non-fatal because the
   * RiskEngine clamps notional independently of the venue setting.
   */
  async setLeverage(params: {
    address: string;
    accountIndex: number;
    marketId: number;
    leverage: number;
    marginMode?: 'CROSS' | 'ISOLATED';
  }): Promise<unknown> {
    if (!this.signer) throw new ArcusError('setLeverage requires a signing key');
    const body: Record<string, unknown> = {
      address: params.address,
      accountIndex: params.accountIndex,
      marketId: params.marketId,
      leverage: params.leverage,
    };
    if (params.marginMode) body.marginMode = params.marginMode;
    const nanos = this.signer.nowNanos().toString();
    const { signature } = this.signer.signLegacyMessage(nanos, 'setLeverage', body);
    return this.request(
      {
        method: 'POST',
        path: '/v1/setLeverage',
        endpoint: 'setLeverage',
        body,
        signed: true,
        typedSignature: { timestamp: nanos, signature },
      },
      z.unknown(),
    );
  }

  /**
   * Arm the dead man's switch. Deliberately exposed but NOT used by default:
   * arming it would cancel resting stop orders on disconnect, and this system's
   * fail-closed posture is to keep protective reduce-only stops alive.
   */
  async scheduleCancel(params: {
    address: string;
    accountIndex: number;
    /** Epoch microseconds; omit to disarm. */
    deadline?: number;
  }): Promise<unknown> {
    if (!this.signer) throw new ArcusError('scheduleCancel requires a signing key');
    const body: Record<string, unknown> = {
      address: params.address,
      accountIndex: params.accountIndex,
    };
    if (params.deadline !== undefined) body.deadline = params.deadline;
    const nanos = this.signer.nowNanos().toString();
    const { signature } = this.signer.signLegacyMessage(nanos, 'scheduleCancel', body);
    return this.request(
      {
        method: 'POST',
        path: '/v1/scheduleCancel',
        endpoint: 'cancelAllOrders',
        body,
        signed: true,
        typedSignature: { timestamp: nanos, signature },
      },
      z.unknown(),
    );
  }

  /** Exposed for the preflight self-test: prove canonicalisation is available. */
  static canonicalise(value: unknown): string {
    return canonicalJson(value);
  }

  /** Endpoints this client will never call, asserted by a safety test. */
  static readonly FORBIDDEN_METHODS = ['withdraw', 'transfer'] as const;
}
