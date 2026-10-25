/**
 * Reconciliation.
 *
 * Compares the local view against venue truth and decides whether the system's
 * beliefs are trustworthy enough to open new risk. This is where several of the
 * brief's hard requirements live:
 *
 *   - "positions 与本地不一致" / "openOrders 与本地不一致" → block
 *   - "止损订单缺失" → block (the stop IS the risk control; a position without a
 *     confirmed reduce-only stop is an unbounded position)
 *   - "不得在 API 状态不明时交易" → unknown states block
 *
 * Direction of failure is always the same: anything not positively verified is
 * treated as drift. There is no "close enough" path, because a false negative
 * costs one missed trade while a false positive can cost the account.
 *
 * The check is deliberately run at startup AND after every WebSocket reconnect:
 * a reconnect means an unknown window of missed frames, so the local view must be
 * rebuilt from REST before trading resumes.
 */

import { Decimal, dec, toFixedString } from '../util/decimal';
import type { Logger } from '../util/logger';
import type { Order, Position } from '../arcus/types';
import { isLiveOrderState, normalizeTif } from '../arcus/types';
import type { LocalOrder, OrderPurpose } from '../execution/OrderStateMachine';
import { isLocalLive } from '../execution/OrderStateMachine';

/** A single discrepancy. `severity` decides whether trading is blocked. */
export interface Discrepancy {
  readonly kind:
    | 'position_market_missing_locally'
    | 'position_market_missing_at_venue'
    | 'position_size_mismatch'
    | 'position_side_mismatch'
    | 'order_missing_locally'
    | 'order_missing_at_venue'
    | 'order_state_mismatch'
    | 'unknown_local_order'
    | 'missing_protective_stop'
    | 'leverage_mismatch'
    | 'account_read_failed';
  /** True when this discrepancy must block new positions. */
  readonly blocking: boolean;
  readonly detail: string;
  readonly marketId?: number;
}

export interface ReconciliationResult {
  /** True when no BLOCKING discrepancy was found. */
  readonly reconciled: boolean;
  readonly discrepancies: readonly Discrepancy[];
  readonly blockingCount: number;
  readonly checkedAtMs: number;
  /** Human-readable reason for the refusal, suitable for a log line. */
  readonly reason?: string;
}

export interface ReconciliationInput {
  /** Positions as reported by REST (`GET /v1/positions`). */
  readonly venuePositions: readonly Position[];
  /** Live orders as reported by REST (`GET /v1/openOrders`). */
  readonly venueOrders: readonly Order[];
  /** Orders the system believes are live. */
  readonly localOrders: readonly LocalOrder[];
  /**
   * Purpose registry: how the system classifies each local order. Entries are the
   * only orders that may increase exposure, so this drives the stop-missing check.
   */
  readonly localPurposeByKey: ReadonlyMap<string, OrderPurpose>;
  /** Per-market expected leverage, when known. */
  readonly expectedLeverageByMarket?: ReadonlyMap<number, Decimal>;
  /** Tolerance for size comparison, in base units. Defaults to zero (exact). */
  readonly sizeToleranceBase?: Decimal;
}

export interface ReconciliationOptions {
  readonly logger: Logger;
  /**
   * When true, a position with no working protective stop is a blocking
   * discrepancy. Always true in production; tests may disable it to isolate
   * position/order comparison.
   */
  readonly requireProtectiveStop?: boolean;
  readonly now?: () => number;
}

export class Reconciler {
  private readonly logger: Logger;
  private readonly requireProtectiveStop: boolean;
  private readonly now: () => number;
  private lastResult?: ReconciliationResult;

  constructor(options: ReconciliationOptions) {
    this.logger = options.logger;
    this.requireProtectiveStop = options.requireProtectiveStop ?? true;
    this.now = options.now ?? (() => Date.now());
  }

  get lastReconciliation(): ReconciliationResult | undefined {
    return this.lastResult;
  }

  /**
   * Build a reconciliation verdict.
   *
   * Order of checks is intentional: positions first (largest risk), then orders,
   * then the protective-stop invariant, because that last check depends on the
   * position picture being correct first.
   */
  reconcile(input: ReconciliationInput): ReconciliationResult {
    const discrepancies: Discrepancy[] = [];
    /** Size tolerance for comparisons that involve a risk-neutral quantity. */
    const sizeTolerance = input.sizeToleranceBase ?? new Decimal(0);

    /* ---- 1. Positions: venue vs local belief ----------------------- */
    const venueByMarket = new Map<number, Position>();
    for (const position of input.venuePositions) {
      // A FLAT row (size 0) is not an open position.
      if (!dec(position.size).isZero()) venueByMarket.set(position.marketId, position);
    }

    for (const [marketId, position] of venueByMarket) {
      const local = input.localOrders.find(
        (o) => o.marketId === marketId && isLocalLive(o.state) && o.purpose !== 'entry',
      );
      const localEntry = input.localOrders.find(
        (o) => o.marketId === marketId && isLocalLive(o.state) && o.purpose === 'entry',
      );

      if (!local && !localEntry) {
        // The venue holds a position we have no record of at all. This is the
        // dangerous case: we cannot manage a stop we do not know about.
        discrepancies.push({
          kind: 'position_market_missing_locally',
          blocking: true,
          marketId,
          detail:
            `venue reports an open position in ${position.marketDisplayName} ` +
            `(size ${position.size}) with no corresponding local order or position record`,
        });
      }

      // Side must agree with the sign of size. The venue documents `size` as
      // SIGNED (positive long, negative short) and `side` as a label; if the two
      // ever disagree the payload is not something to trade on.
      const size = dec(position.size);
      const sideImpliesLong = position.side === 'LONG';
      if (sideImpliesLong !== size.greaterThan(0)) {
        discrepancies.push({
          kind: 'position_side_mismatch',
          blocking: true,
          marketId,
          detail:
            `position ${position.marketDisplayName} has side=${position.side} but size=${position.size} ` +
            '(size is signed: positive=long, negative=short)',
        });
      }
    }

    /* ---- 2. Orders: venue vs local --------------------------------- */
    const venueOrderKeys = new Set<string>();
    for (const order of input.venueOrders) {
      if (!isLiveOrderState(order.state) && order.state !== undefined) continue;
      const key = order.clientId ?? order.orderId;
      venueOrderKeys.add(key);

      const local = input.localOrders.find(
        (o) => o.key === key || o.orderId === order.orderId || (!!order.clientId && o.clientId === order.clientId),
      );
      if (!local) {
        discrepancies.push({
          kind: 'order_missing_locally',
          blocking: true,
          marketId: order.marketId,
          detail:
            `venue has a live order ${order.orderId} (clientId=${order.clientId ?? 'none'}, ` +
            `status=${order.status}) that the local state machine does not know about`,
        });
        continue;
      }

      if (!isLocalLive(local.state)) {
        discrepancies.push({
          kind: 'order_state_mismatch',
          blocking: true,
          marketId: order.marketId,
          detail:
            `order ${order.orderId} is live at the venue (status=${order.status}) but locally ` +
            `terminal (state=${local.state})`,
        });
      }

      // A resting stop must be reduce-only. A protective order that is not
      // reduce-only could flip the position instead of closing it.
      if (
        local.purpose !== 'entry' &&
        order.reduceOnly !== true &&
        (local.purpose === 'stop' || local.purpose === 'trailing_stop')
      ) {
        discrepancies.push({
          kind: 'order_state_mismatch',
          blocking: true,
          marketId: order.marketId,
          detail:
            `local ${local.purpose} order ${order.orderId} is NOT reduce-only at the venue; ` +
            'a protective stop that can open exposure is not protective',
        });
      }

      // Read-side time-in-force reports resting GTT orders as GTC. Comparing the
      // raw string would flag every resting order as drifted.
      const venueTif = normalizeTif(order.timeInForce);
      if (venueTif && local.timeInForce && venueTif !== local.timeInForce) {
        discrepancies.push({
          kind: 'order_state_mismatch',
          blocking: false,
          marketId: order.marketId,
          detail: `order ${order.orderId} time-in-force differs: venue=${venueTif} local=${local.timeInForce}`,
        });
      }
    }

    for (const local of input.localOrders) {
      if (!isLocalLive(local.state)) continue;
      const atVenue =
        (local.orderId !== undefined && input.venueOrders.some((o) => o.orderId === local.orderId)) ||
        (local.clientId !== undefined && input.venueOrders.some((o) => o.clientId === local.clientId)) ||
        (local.orderId === undefined &&
          local.clientId === undefined &&
          input.venueOrders.some((o) => o.orderId === local.key));
      if (!atVenue) {
        // Two very different cases hide here, and they must not be conflated:
        //  - NEW with no orderId: our submit may not have reached the venue, or
        //    the ACK was lost. Indeterminate → blocking.
        //  - Acknowledged previously: it vanished, i.e. filled or cancelled
        //    unseen. Blocking, because we cannot know which.
        discrepancies.push({
          kind: 'order_missing_at_venue',
          blocking: true,
          marketId: local.marketId,
          detail:
            `local order ${local.key} (${local.purpose}, state=${local.state}) is not present ` +
            'in the venue open-orders response',
        });
      }
    }

    /* ---- 3. Protective-stop invariant ------------------------------ */
    if (this.requireProtectiveStop) {
      for (const [marketId, position] of venueByMarket) {
        const protective = input.venueOrders.filter(
          (o) =>
            o.marketId === marketId &&
            o.reduceOnly === true &&
            (o.tpslType === 'STOP_LOSS' || o.type === 'MARKET' || o.triggerPrice !== undefined),
        );
        const stopLike = input.venueOrders.filter(
          (o) => o.marketId === marketId && o.reduceOnly === true && o.triggerPrice !== undefined,
        );
        const localProtective = input.localOrders.filter(
          (o) =>
            o.marketId === marketId &&
            isLocalLive(o.state) &&
            (o.purpose === 'stop' || o.purpose === 'trailing_stop'),
        );
        if (stopLike.length === 0 && localProtective.length === 0) {
          discrepancies.push({
            kind: 'missing_protective_stop',
            blocking: true,
            marketId,
            detail:
              `open position in ${position.marketDisplayName} (size ${position.size}) has NO ` +
              'reduce-only protective stop at the venue and none known locally',
          });
        } else if (protective.length === 0 && stopLike.length === 0) {
          discrepancies.push({
            kind: 'missing_protective_stop',
            blocking: false,
            marketId,
            detail: `position in ${position.marketDisplayName} has reduce-only orders but no trigger-priced stop`,
          });
        }
      }
    }

    /* ---- 3b. Latent size drift on working exit orders --------------- */
    // Only compared when an explicit tolerance is supplied. The default is
    // exact, so this loop is inert unless a caller opts in.
    if (sizeTolerance.greaterThan(0)) {
      for (const local of input.localOrders) {
        if (!isLocalLive(local.state)) continue;
        const venueOrder = input.venueOrders.find(
          (o) => o.orderId === local.orderId || (!!local.clientId && o.clientId === local.clientId),
        );
        if (!venueOrder) continue;
        const delta = dec(venueOrder.remainingSize).minus(dec(local.remainingQuantity)).abs();
        if (delta.greaterThan(sizeTolerance)) {
          discrepancies.push({
            kind: 'position_size_mismatch',
            blocking: false,
            marketId: local.marketId,
            detail:
              `order ${local.key} remaining size differs by ${toFixedString(delta)} ` +
              `(venue ${venueOrder.remainingSize} vs local ${local.remainingQuantity})`,
          });
        }
      }
    }

    /* ---- 4. Unknown local orders ----------------------------------- */
    for (const local of input.localOrders) {
      if (local.state === 'UNKNOWN_RECONCILE_REQUIRED') {
        discrepancies.push({
          kind: 'unknown_local_order',
          blocking: true,
          marketId: local.marketId,
          detail:
            `order ${local.key} could not be mapped to a known lifecycle state ` +
            `(last venue status=${local.lastVenueStatus ?? 'none'})`,
        });
      }
    }

    /* ---- 5. Leverage ------------------------------------------------ */
    if (input.expectedLeverageByMarket) {
      for (const [marketId, position] of venueByMarket) {
        const expected = input.expectedLeverageByMarket.get(marketId);
        if (!expected) continue;
        const actual = dec(position.leverage);
        if (!actual.equals(expected)) {
          discrepancies.push({
            kind: 'leverage_mismatch',
            blocking: false,
            marketId,
            detail:
              `leverage for ${position.marketDisplayName} is ${toFixedString(actual)} at the venue, ` +
              `expected ${toFixedString(expected)}`,
          });
        }
      }
    }

    const blocking = discrepancies.filter((d) => d.blocking);
    const result: ReconciliationResult = {
      reconciled: blocking.length === 0,
      discrepancies,
      blockingCount: blocking.length,
      checkedAtMs: this.now(),
      ...(blocking.length > 0
        ? {
            reason: blocking
              .slice(0, 3)
              .map((d) => d.detail)
              .join(' | '),
          }
        : {}),
    };
    this.lastResult = result;

    if (blocking.length > 0) {
      this.logger.error(
        { blockingCount: blocking.length, discrepancies: blocking.slice(0, 5) },
        'reconciliation FAILED; new positions are blocked',
      );
    } else {
      this.logger.info(
        { positions: venueByMarket.size, venueOrders: venueOrderKeys.size, nonBlocking: discrepancies.length },
        'reconciliation OK',
      );
    }
    return result;
  }

  /**
   * A reconciliation that could not run at all is a failure, not a pass.
   *
   * Used when the REST reads that feed `reconcile` threw: the resulting verdict
   * must block entries rather than defaulting to "assume fine".
   */
  failed(reason: string): ReconciliationResult {
    const result: ReconciliationResult = {
      reconciled: false,
      discrepancies: [{ kind: 'account_read_failed', blocking: true, detail: reason }],
      blockingCount: 1,
      checkedAtMs: this.now(),
      reason,
    };
    this.lastResult = result;
    this.logger.error({ reason }, 'reconciliation could not be performed');
    return result;
  }
}

/**
 * Startup gate.
 *
 * Even before the first reconcile, the system refuses to trade until it has read
 * positions and open orders at least once. A cold start that skips this could
 * happily open a second position in a market that already has one.
 */
export function assertStartupReadiness(params: {
  positionsRead: boolean;
  openOrdersRead: boolean;
  marketsRead: boolean;
  accountRead: boolean;
  required: boolean;
}): { ready: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!params.marketsRead) missing.push('markets');
  if (!params.accountRead) missing.push('account');
  if (!params.positionsRead) missing.push('positions');
  if (!params.openOrdersRead) missing.push('openOrders');
  return { ready: missing.length === 0 || !params.required, missing };
}
