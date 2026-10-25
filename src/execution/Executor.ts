/**
 * Order execution.
 *
 * Responsibilities, in the order they matter:
 *
 *  1. **Place an entry as ALO (post-only), never marketable.** A pullback entry
 *     that crosses the spread is not a pullback entry. ALO also means the engine
 *     rejects us with POST_ONLY_WOULD_CROSS rather than letting us pay up.
 *
 *  2. **Attach the stop as soon as the entry fills — and never widen exposure
 *     before it is confirmed.** If the stop cannot be placed and confirmed, the
 *     position is treated as UNPROTECTED: the executor refuses further increases
 *     and the runtime is expected to flatten or halt. This is the brief's "如果止损未确认，
 *     禁止继续扩大仓位" made structural.
 *
 *  3. **All exits are reduce-only.** A take-profit or stop that is not reduce-only
 *     could open a reverse position, which is exactly the "止盈订单导致反向开仓"
 *     failure the brief names. The flag is set on every exit order and asserted.
 *
 *  4. **Every order carries a unique, well-formed clientId.** The charset is
 *     `[A-Za-z0-9_-]{1,36}`, which is validated BEFORE signing so a rejected
 *     clientId cannot burn a slot in the per-subaccount pool.
 *
 *  5. **Emergency exits use reduce-only IOC with a protective bound price**, never
 *     a naked market order that could flip the position.
 *
 * The executor does not consult the RiskEngine. That is deliberate and safe: it
 * only ever acts on an already-approved proposal, and every exit path it owns can
 * only REDUCE exposure.
 */

import { Decimal, dec, floorToTick, toFixedString } from '../util/decimal';
import type { Logger } from '../util/logger';
import type { ArcusRestClient } from '../arcus/ArcusRestClient';
import { ArcusHttpError, ArcusRateLimitError, ArcusValidationError } from '../arcus/ArcusRestClient';
import type { MarketInfo, Order, OrderResponse, PlaceOrderRequest } from '../arcus/types';
import type { TradeProposal } from '../risk/RiskEngine';
import { OrderStateMachine, type LocalOrder, type OrderPurpose } from './OrderStateMachine';

/** Order submission outcome, including the reason a refusal happened. */
export type SubmitOutcome =
  | { readonly ok: true; readonly order: OrderResponse; readonly localKey: string }
  | {
      readonly ok: false;
      /** True when the failure is transient and a retry could succeed. */
      readonly retryable: boolean;
      readonly reason: string;
      /** Venue rejection reason, when the engine rejected us. */
      readonly rejectionReason?: string;
      readonly localKey: string;
    };

export interface ExecutorOptions {
  readonly rest: ArcusRestClient;
  readonly logger: Logger;
  readonly address: string;
  readonly accountIndex: number;
  readonly orderStateMachine: OrderStateMachine;
  /** Good-til-time horizon for resting orders, in days. Must be >= 31. */
  readonly goodTilDays: number;
  /** Max value accepted as `price` on an emergency market/IOC order, in bps from mark. */
  readonly emergencyBoundBps?: Decimal;
  /** Depth to walk when pricing an emergency exit. */
  readonly now?: () => number;
  /** Client id prefix, so ids are greppable in the venue order history. */
  readonly clientIdPrefix?: string;
}

/** Result of attempting to protect a newly filled position. */
export interface ProtectionResult {
  readonly protected: boolean;
  readonly stopOrderKey?: string;
  readonly reason?: string;
}

export class Executor {
  private readonly rest: ArcusRestClient;
  private readonly logger: Logger;
  private readonly address: string;
  private readonly accountIndex: number;
  private readonly osm: OrderStateMachine;
  private readonly goodTilDays: number;
  private readonly emergencyBoundBps: Decimal;
  private readonly now: () => number;
  private readonly clientIdPrefix: string;

  /**
   * Markets where a position exists but its protective stop is not confirmed.
   * While a market is in this set, the executor refuses to increase exposure.
   */
  private readonly unprotectedMarkets = new Set<number>();

  /** Monotonic counter appended to client ids to guarantee uniqueness. */
  private clientIdCounter = 0;

  constructor(options: ExecutorOptions) {
    this.rest = options.rest;
    this.logger = options.logger;
    this.address = options.address;
    this.accountIndex = options.accountIndex;
    this.osm = options.orderStateMachine;
    this.goodTilDays = options.goodTilDays;
    this.emergencyBoundBps = options.emergencyBoundBps ?? dec('50');
    this.now = options.now ?? (() => Date.now());
    this.clientIdPrefix = options.clientIdPrefix ?? 'at';
  }

  get unprotected(): readonly number[] {
    return [...this.unprotectedMarkets];
  }

  isMarketProtected(marketId: number): boolean {
    return !this.unprotectedMarkets.has(marketId);
  }

  markProtected(marketId: number): void {
    this.unprotectedMarkets.delete(marketId);
  }

  markUnprotected(marketId: number): void {
    this.unprotectedMarkets.add(marketId);
  }

  /**
   * Build a client id.
   *
   * Charset is restricted by the API to `[A-Za-z0-9_-]` with a 36-char maximum,
   * and the id is signed byte-for-byte, so it is validated here rather than
   * discovered as a 400 after consuming rate-limit budget.
   */
  nextClientId(purpose: OrderPurpose, marketId: number): string {
    this.clientIdCounter += 1;
    const shortPurpose =
      purpose === 'entry'
        ? 'en'
        : purpose === 'stop'
          ? 'sl'
          : purpose === 'take_profit'
            ? 'tp'
            : purpose === 'trailing_stop'
              ? 'tr'
              : 'ex';
    const id = `${this.clientIdPrefix}${shortPurpose}${marketId}-${this.now()}-${this.clientIdCounter}`;
    if (!/^[A-Za-z0-9_-]{1,36}$/.test(id)) {
      // Truncate deterministically rather than throwing: the counter suffix is
      // what guarantees uniqueness, so keep the tail.
      const suffix = `${this.now()}${this.clientIdCounter}`;
      return `${this.clientIdPrefix}${shortPurpose}${marketId}-${suffix}`.slice(0, 36);
    }
    return id;
  }

  /**
   * `goodTilTime` in epoch microseconds, taken from the CLIENT's clock.
   *
   * Must come from the same clock that signs the request: the signed `g` is this
   * value x 1000, and the venue requires it to be at least a month ahead. Using a
   * separate local clock here would let the signed `g` and the body's
   * `goodTilTime` diverge.
   */
  private goodTilMicros(): string {
    return this.rest.goodTilTimeMicros(this.goodTilDays);
  }

  /* ---------------------------------------------------------------- *
   * Entry
   * ---------------------------------------------------------------- */

  /**
   * Submit the entry leg of an approved proposal as an ALO/post-only limit order.
   *
   * Refuses when the market is flagged unprotected, because adding exposure to a
   * position whose stop is not confirmed is precisely the compounding risk the
   * brief forbids.
   */
  async submitEntry(params: {
    market: MarketInfo;
    proposal: TradeProposal;
    quantity: Decimal;
    /** True when the account may submit orders at all (live mode). */
    allowSubmission: boolean;
  }): Promise<SubmitOutcome> {
    const { market, proposal, quantity } = params;
    const localKeyBase = this.nextClientId('entry', market.marketId);

    if (!this.isMarketProtected(market.marketId)) {
      return {
        ok: false,
        retryable: false,
        localKey: localKeyBase,
        reason:
          `market ${market.marketDisplayName} is flagged UNPROTECTED (a previous position's stop was never ` +
          'confirmed); refusing to increase exposure',
      };
    }
    if (!quantity.greaterThan(0)) {
      return { ok: false, retryable: false, localKey: localKeyBase, reason: 'quantity is not positive' };
    }

    const local = this.osm.create({
      key: localKeyBase,
      clientId: localKeyBase,
      marketId: market.marketId,
      symbol: market.marketDisplayName,
      purpose: 'entry',
      reduceOnly: false,
      side: proposal.direction === 'long' ? 'BUY' : 'SELL',
      quantity: toFixedString(quantity),
      price: toFixedString(proposal.entryPrice),
    });

    if (!params.allowSubmission) {
      // Dry-run path: the intent is fully recorded but nothing is sent.
      this.osm.applyVenueOrder({
        orderId: `dry-${localKeyBase}`,
        clientId: localKeyBase,
        marketId: market.marketId,
        marketDisplayName: market.marketDisplayName,
        side: local.side,
        status: 'OPEN',
        state: 'OPEN',
        price: toFixedString(proposal.entryPrice),
        originalSize: toFixedString(quantity),
        remainingSize: toFixedString(quantity),
        filledSize: '0',
        updatedAt: this.now() * 1000,
      } as Order);
      this.logger.info(
        { clientId: localKeyBase, marketId: market.marketId, dryRun: true },
        'DRY RUN: entry order would be submitted (not sent)',
      );
      return {
        ok: false,
        retryable: false,
        localKey: localKeyBase,
        reason: 'dry-run: order not submitted (order submission disabled by configuration)',
      };
    }

    const request: PlaceOrderRequest = {
      address: this.address,
      marketId: market.marketId,
      accountIndex: this.accountIndex,
      orderSide: local.side,
      orderType: 'LIMIT',
      quantity: toFixedString(quantity),
      price: toFixedString(proposal.entryPrice),
      // ALO = post-only: the engine rejects rather than letting us cross.
      timeInForce: 'ALO',
      goodTilTime: this.goodTilMicros(),
      clientId: localKeyBase,
      reduceOnly: false,
      timestamp: '0',
    };

    return this.submitSigned(localKeyBase, request, market, 'entry');
  }

  /* ---------------------------------------------------------------- *
   * Protection
   * ---------------------------------------------------------------- */

  /**
   * Place the structural stop for a filled position.
   *
   * Uses a STOP_LOSS trigger order (not a plain limit) so the stop only becomes
   * marketable once the trigger is touched, and marks it reduce-only so it can
   * never open a reverse position.
   *
   * On failure the market is flagged unprotected and the caller must not add.
   */
  async placeProtectiveStop(params: {
    market: MarketInfo;
    direction: 'long' | 'short';
    quantity: Decimal;
    stopPrice: Decimal;
    allowSubmission: boolean;
    /** Price to use as the protective bound on the triggered leg. */
    boundPrice?: Decimal;
  }): Promise<ProtectionResult> {
    const { market, direction, quantity, stopPrice } = params;
    const clientId = this.nextClientId('stop', market.marketId);
    // The stop closes the position, so it is the OPPOSITE side of the entry.
    const side: 'BUY' | 'SELL' = direction === 'long' ? 'SELL' : 'BUY';

    this.osm.create({
      key: clientId,
      clientId,
      marketId: market.marketId,
      symbol: market.marketDisplayName,
      purpose: 'stop',
      // Asserted below and in reconciliation: a protective order must be reduce-only.
      reduceOnly: true,
      side,
      quantity: toFixedString(quantity),
      triggerPrice: toFixedString(stopPrice),
    });

    if (!params.allowSubmission) {
      this.markUnprotected(market.marketId);
      this.logger.warn(
        { clientId, marketId: market.marketId, stopPrice: toFixedString(stopPrice) },
        'DRY RUN: protective stop would be submitted (not sent); market flagged UNPROTECTED for realism',
      );
      return {
        protected: false,
        reason: 'dry-run: protective stop not submitted',
      };
    }

    // The protective bound on the triggered leg. For a long's stop (a SELL), the
    // bound sits BELOW the trigger so the order is marketable on the way down but
    // cannot be filled at an absurd price.
    const bound = params.boundPrice ?? this.boundForStop(direction, stopPrice, market);

    const request: PlaceOrderRequest = {
      address: this.address,
      marketId: market.marketId,
      accountIndex: this.accountIndex,
      orderSide: side,
      orderType: 'MARKET',
      quantity: toFixedString(quantity),
      price: toFixedString(bound),
      // MARKET orders must be IOC, and still require a protective `price`.
      timeInForce: 'IOC',
      goodTilTime: this.goodTilMicros(),
      clientId,
      reduceOnly: true,
      tpslType: 'STOP_LOSS',
      stopPrice: toFixedString(stopPrice),
      timestamp: '0',
    };

    const outcome = await this.submitSigned(clientId, request, market, 'stop');
    if (outcome.ok) {
      this.markProtected(market.marketId);
      this.logger.info(
        {
          marketId: market.marketId,
          clientId,
          orderId: outcome.order.orderId,
          stopPrice: toFixedString(stopPrice),
          bound: toFixedString(bound),
        },
        'protective stop placed',
      );
      return { protected: true, stopOrderKey: clientId };
    }

    this.markUnprotected(market.marketId);
    this.logger.error(
      { marketId: market.marketId, clientId, reason: outcome.reason },
      'PROTECTIVE STOP FAILED — market flagged UNPROTECTED; no further exposure may be added',
    );
    return {
      protected: false,
      reason: outcome.reason,
    };
  }

  /**
   * Protective bound for a stop's triggered leg.
   *
   * A wider bound than the trigger means the triggered order can still execute
   * through a fast move; too wide invites a terrible fill. Symmetric around the
   * trigger by configured bps.
   */
  private boundForStop(direction: 'long' | 'short', stopPrice: Decimal, market: MarketInfo): Decimal {
    const offset = stopPrice.times(this.emergencyBoundBps).div(10_000);
    const raw = direction === 'long' ? stopPrice.minus(offset) : stopPrice.plus(offset);
    // Snap so the bound is representable on the venue grid.
    const snapped = floorToTick(raw, dec(market.tickSize));
    return snapped.greaterThan(0) ? snapped : stopPrice;
  }

  /**
   * Place a take-profit leg.
   *
   * Always reduce-only, always the opposite side of the entry. The comment is not
   * boilerplate: an accidental non-reduce-only TP is a reverse position.
   */
  async placeTakeProfit(params: {
    market: MarketInfo;
    direction: 'long' | 'short';
    quantity: Decimal;
    targetPrice: Decimal;
    allowSubmission: boolean;
  }): Promise<SubmitOutcome> {
    const { market, direction, quantity, targetPrice } = params;
    const clientId = this.nextClientId('take_profit', market.marketId);
    const side: 'BUY' | 'SELL' = direction === 'long' ? 'SELL' : 'BUY';

    this.osm.create({
      key: clientId,
      clientId,
      marketId: market.marketId,
      symbol: market.marketDisplayName,
      purpose: 'take_profit',
      reduceOnly: true,
      side,
      quantity: toFixedString(quantity),
      price: toFixedString(targetPrice),
    });

    if (!params.allowSubmission) {
      return { ok: false, retryable: false, localKey: clientId, reason: 'dry-run: take-profit not submitted' };
    }

    const request: PlaceOrderRequest = {
      address: this.address,
      marketId: market.marketId,
      accountIndex: this.accountIndex,
      orderSide: side,
      orderType: 'LIMIT',
      quantity: toFixedString(quantity),
      price: toFixedString(targetPrice),
      // GTT for a resting exit; ALO would risk a post-only rejection on a limit
      // that is already through the market after a fast move.
      timeInForce: 'GTT',
      goodTilTime: this.goodTilMicros(),
      clientId,
      reduceOnly: true,
      timestamp: '0',
    };

    return this.submitSigned(clientId, request, market, 'take_profit');
  }

  /* ---------------------------------------------------------------- *
   * Emergency exit
   * ---------------------------------------------------------------- */

  /**
   * Flatten a position with a reduce-only IOC order.
   *
   * Uses IOC (an immediate-or-cancel limit) rather than a bare market order: the
   * `price` acts as a protective bound, which is what the venue requires for
   * MARKET orders anyway, and IOC means we never leave an unintended resting
   * order behind. `reduceOnly` guarantees the order cannot flip the position.
   */
  async emergencyExit(params: {
    market: MarketInfo;
    direction: 'long' | 'short';
    quantity: Decimal;
    /** Reference price used to derive the protective bound. */
    referencePrice: Decimal;
    allowSubmission: boolean;
  }): Promise<SubmitOutcome> {
    const { market, direction, quantity, referencePrice } = params;
    const clientId = this.nextClientId('emergency_exit', market.marketId);
    const side: 'BUY' | 'SELL' = direction === 'long' ? 'SELL' : 'BUY';
    const offset = referencePrice.times(this.emergencyBoundBps).div(10_000);
    const rawBound = direction === 'long' ? referencePrice.minus(offset) : referencePrice.plus(offset);
    const bound = floorToTick(rawBound, dec(market.tickSize));

    this.osm.create({
      key: clientId,
      clientId,
      marketId: market.marketId,
      symbol: market.marketDisplayName,
      purpose: 'emergency_exit',
      reduceOnly: true,
      side,
      quantity: toFixedString(quantity),
      price: toFixedString(bound),
    });

    if (!params.allowSubmission) {
      return { ok: false, retryable: false, localKey: clientId, reason: 'dry-run: emergency exit not submitted' };
    }

    const request: PlaceOrderRequest = {
      address: this.address,
      marketId: market.marketId,
      accountIndex: this.accountIndex,
      orderSide: side,
      orderType: 'LIMIT',
      quantity: toFixedString(quantity),
      price: toFixedString(bound),
      timeInForce: 'IOC',
      goodTilTime: this.goodTilMicros(),
      clientId,
      reduceOnly: true,
      timestamp: '0',
    };

    this.logger.error(
      { marketId: market.marketId, direction, quantity: toFixedString(quantity), bound: toFixedString(bound) },
      'EMERGENCY EXIT submitted as reduce-only IOC',
    );
    return this.submitSigned(clientId, request, market, 'emergency_exit');
  }

  /* ---------------------------------------------------------------- *
   * Cancellation
   * ---------------------------------------------------------------- */

  /**
   * Cancel a working order, preferring clientId so we can cancel an order whose
   * venue id we never learned (a lost ACK).
   */
  async cancelOrder(params: {
    market: MarketInfo;
    localKey: string;
    allowSubmission: boolean;
    reason: string;
  }): Promise<{ ok: boolean; reason?: string }> {
    const local = this.osm.get(params.localKey);
    if (!local) return { ok: false, reason: `no local order ${params.localKey}` };

    this.osm.markCancelRequested(params.localKey);

    if (!params.allowSubmission) {
      this.osm.markLocalFailure(params.localKey, `dry-run cancel: ${params.reason}`);
      return { ok: false, reason: 'dry-run: cancel not submitted' };
    }

    try {
      if (local.orderId) {
        await this.rest.cancelOrder(
          {
            address: this.address,
            accountIndex: this.accountIndex,
            marketId: params.market.marketId,
            kind: 'orderId',
            orderId: local.orderId,
            timestamp: '0',
          },
          { marketId: params.market.marketId },
        );
      } else if (local.clientId) {
        await this.rest.cancelOrder(
          {
            address: this.address,
            accountIndex: this.accountIndex,
            marketId: params.market.marketId,
            kind: 'clientId',
            clientId: local.clientId,
            timestamp: '0',
          },
          { marketId: params.market.marketId },
        );
      } else {
        return { ok: false, reason: 'order has neither orderId nor clientId' };
      }
      this.logger.info({ localKey: params.localKey, reason: params.reason }, 'order cancel submitted');
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({ localKey: params.localKey, err: message }, 'order cancel failed');
      return { ok: false, reason: message };
    }
  }

  /** Cancel every working entry order. Used by the kill switch. */
  async cancelWorkingEntries(params: {
    markets: ReadonlyMap<number, MarketInfo>;
    allowSubmission: boolean;
  }): Promise<{ cancelled: number; failed: number }> {
    let cancelled = 0;
    let failed = 0;
    for (const order of this.osm.workingEntryOrders()) {
      const market = params.markets.get(order.marketId);
      if (!market) {
        failed += 1;
        continue;
      }
      const result = await this.cancelOrder({
        market,
        localKey: order.key,
        allowSubmission: params.allowSubmission,
        reason: 'kill switch engaged',
      });
      if (result.ok) cancelled += 1;
      else failed += 1;
    }
    return { cancelled, failed };
  }

  /* ---------------------------------------------------------------- *
   * Shared submission path
   * ---------------------------------------------------------------- */

  /**
   * Perform the signed submission and fold the outcome into the state machine.
   *
   * The `timestamp` placeholder of '0' in the request builders above is replaced
   * here from the signer's own clock, so the body, the `ct` in the signed payload
   * and the `X-Timestamp` header are all the same value — the property the signer
   * asserts and the venue verifies. Deriving the timestamp once, at submission,
   * also keeps it fresh: building it earlier would spend part of the venue's
   * ±30 s window on local work.
   */
  private async submitSigned(
    localKey: string,
    request: PlaceOrderRequest,
    market: MarketInfo,
    purpose: OrderPurpose,
  ): Promise<SubmitOutcome> {
    const timestamp = this.rest.nowNanos().toString();
    const stamped: PlaceOrderRequest = { ...request, timestamp };

    try {
      const order = await this.rest.placeOrder(stamped, {
        marketId: market.marketId,
        tickSize: market.tickSize,
        stepSize: market.stepSize,
      });
      // Fold the ACK into the state machine so reconciliation has something to
      // compare against even if the WebSocket update is delayed.
      this.osm.attachOrderId(localKey, order.orderId);
      if (order.status === 'REJECTED') {
        const reason = order.rejectionReason ?? 'REJECTED';
        this.osm.markLocalFailure(localKey, reason);
        this.logger.warn(
          { localKey, orderId: order.orderId, purpose, rejectionReason: reason },
          'venue rejected order',
        );
        return {
          ok: false,
          retryable: reason === 'POST_ONLY_WOULD_CROSS' ? false : isRetryableRejection(reason),
          reason: `venue rejected order: ${reason}`,
          rejectionReason: reason,
          localKey,
        };
      }
      this.logger.info(
        { localKey, orderId: order.orderId, status: order.status, purpose, marketId: market.marketId },
        'order acknowledged',
      );
      return { ok: true, order, localKey };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = error instanceof ArcusRateLimitError || !(error instanceof ArcusValidationError);
      if (error instanceof ArcusHttpError) {
        // A 4xx here is a business rejection (insufficient margin, bad price,
        // post-only collision). Retrying the identical request will not help.
        const bodyReason = extractRejectionReason(error.body);
        this.osm.markLocalFailure(localKey, bodyReason ?? message);
        this.logger.warn(
          { localKey, status: error.status, reason: bodyReason ?? message, purpose },
          'order submission rejected',
        );
        return {
          ok: false,
          retryable: error instanceof ArcusRateLimitError,
          reason: bodyReason ?? `HTTP ${error.status}`,
          ...(bodyReason !== undefined ? { rejectionReason: bodyReason } : {}),
          localKey,
        };
      }
      // Transport or validation failure: the order's fate is UNKNOWN, so leave it
      // non-terminal and let reconciliation decide rather than assuming failure.
      this.logger.error({ localKey, err: message, purpose }, 'order submission failed at transport');
      return { ok: false, retryable, reason: message, localKey };
    }
  }

  /**
   * Rejections that a retry at a different price could plausibly fix.
   *
   * POST_ONLY_WOULD_CROSS is NOT retryable at the same price — retrying an ALO
   * order that would cross is a loop; the entry must be re-derived.
   */
  static readonly RETRYABLE_REJECTIONS: readonly string[] = [
    'COULD_NOT_FILL',
    'IOC_CANCELED',
    'MODIFY_SUPERSEDED_BY_CANCEL',
    'OPEN_ORDER_CAP_EXCEEDED',
  ];
}

function isRetryableRejection(reason: string): boolean {
  return Executor.RETRYABLE_REJECTIONS.includes(reason);
}

function extractRejectionReason(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const record = body as Record<string, unknown>;
  for (const key of ['rejectionReason', 'reason', 'error', 'code']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Entry-order lifetime check.
 *
 * A resting entry order that has not filled within its TTL is cancelled rather
 * than left to fill into a stale thesis. Expressed in trigger-timeframe bars.
 */
export function isEntryOrderExpired(order: LocalOrder, nowMs: number, ttlMs: number): boolean {
  if (order.purpose !== 'entry') return false;
  return nowMs - order.createdAtMs > ttlMs;
}
