/**
 * Position manager — the exit half of the strategy.
 *
 * The brief specifies a full exit plan that the executor alone cannot express,
 * because it is stateful across fills:
 *
 *   - TP1 at 2R closes 50%
 *   - the remainder is trailed on the 9 EMA or on structure
 *   - all exit orders are reduce-only
 *   - a take-profit order must never be able to open a reverse position
 *
 * `Executor` places individual legs; this class decides WHEN each leg is needed and
 * keeps the plan consistent with the venue. It exists because the alternative —
 * scattering "has TP1 filled yet?" checks through the trading loop — is how a system
 * ends up placing a second TP1 after a restart, or trailing a position that already
 * closed.
 *
 * THE HARD PART is that the venue does not tell us which position a reduce-only fill
 * belonged to. A fill carries `closedPnl` and `positionEffect`, not a position id. So
 * progress is INFERRED from the position's own numbers:
 *
 *   - baseline size and average entry are captured when a position is first seen
 *   - TP1 has filled when the position's size has fallen to (at most) half the
 *     baseline while the position is still open
 *   - the position is closed when size reaches zero
 *   - the stop has trailed when the live protective stop's trigger differs from the
 *     level this manager last asked for
 *
 * Every inference is monotonic and every write is guarded, so a restart re-derives
 * the same state from the venue rather than replaying actions. Ambiguity resolves
 * toward NOT acting: if progress cannot be established, the manager leaves the
 * existing stop in place and logs why, because a widen-the-stop bug is far worse than
 * a missed trailing update.
 */

import { Decimal, dec, floorToTick, toFixedString } from '../util/decimal';
import type { Logger } from '../util/logger';
import type { Candle, MarketInfo, Position } from '../arcus/types';
import type { Executor } from '../execution/Executor';
import type { LocalOrder, OrderStateMachine } from '../execution/OrderStateMachine';
import { emaOnCandles, lastDefined } from '../strategy/StrategyIndicators';

/** What the manager did, or why it did nothing. Surfaced for the report and tests. */
export type ExitAction =
  | 'placed_tp1'
  | 'placed_tp2'
  | 'reduced_stop_after_tp1'
  | 'trailed_stop'
  | 'emergency_exit'
  | 'nothing_to_do'
  | 'blocked';

export interface ExitOutcome {
  readonly marketId: number;
  readonly symbol: string;
  readonly action: ExitAction;
  /** Set whenever `action === 'blocked'`, and sometimes otherwise for context. */
  readonly reason?: string;
  /** True when a venue write was attempted. */
  readonly submitted: boolean;
  readonly detail?: Record<string, unknown>;
}

/** Per-market exit state, re-derived from the venue on every evaluation. */
interface ExitPlan {
  readonly marketId: number;
  readonly symbol: string;
  /** Position size when this plan was created. The TP1 threshold derives from it. */
  baselineSize: Decimal;
  readonly direction: 'long' | 'short';
  /** R multiples for the two targets, captured at plan time. */
  readonly entryPrice: Decimal;
  readonly initialStop: Decimal;
  readonly target1: Decimal;
  readonly target2?: Decimal;
  /** TP1 treated as complete once size falls to or below this. */
  readonly tp1Threshold: Decimal;
  tp1Done: boolean;
  tp2Done: boolean;
  /** The stop level this manager last requested, for trailing comparison. */
  lastRequestedStop?: Decimal;
  /** Client id of the working stop, so a replace can cancel the old leg. */
  stopClientId?: string;
}

/**
 * The slice of `Executor` this manager depends on.
 *
 * Narrowing the dependency to exactly four methods does two things: it documents the
 * boundary (the manager cannot place entries, so it structurally cannot increase
 * exposure), and it lets a test supply a typed double whose return shapes are checked
 * against the real signatures instead of being cast away.
 */
export type ExitExecutor = Pick<
  Executor,
  'placeProtectiveStop' | 'placeTakeProfit' | 'cancelOrder' | 'emergencyExit'
>;

export interface PositionManagerOptions {
  readonly logger: Logger;
  readonly executor: ExitExecutor;
  readonly orderStateMachine: OrderStateMachine;
  /** Fraction of the position closed at TP1, as a percentage (e.g. 50). */
  readonly tp1ClosePct: Decimal;
  /** Period for the trailing EMA on the structure timeframe. */
  readonly trailEmaPeriod: number;
  /** Structure timeframe, used for the trailing EMA series. */
  readonly structureTimeframe: string;
  /** ATR multiple for the initial emergency stop check. */
  readonly emergencyBoundBps: Decimal;
  /** Supplies closed structure candles for the trailing EMA. */
  readonly getStructureCandles: (symbol: string) => readonly Candle[];
  readonly now?: () => number;
}

/** Minimum favourable move before a trailing stop is allowed to move at all. */
const TRAIL_ACTIVATION_R = dec('0.5');

export class PositionManager {
  private readonly options: PositionManagerOptions;
  /** marketId → exit plan. */
  private readonly plans = new Map<number, ExitPlan>();
  /** Market ids for which an emergency exit has already been submitted. */
  private readonly emergencySubmitted = new Set<number>();

  /** Counters for the daily report. */
  readonly counters = {
    tp1Placed: 0,
    tp2Placed: 0,
    stopsReduced: 0,
    stopsTrailed: 0,
    emergencyExits: 0,
    blockedActions: 0,
    /** Plans created (i.e. positions adopted for management). */
    plansCreated: 0,
  };

  constructor(options: PositionManagerOptions) {
    this.options = options;
  }

  /** Diagnostics for the report and tests. */
  get planSnapshot(): {
    marketId: number;
    symbol: string;
    direction: 'long' | 'short';
    baselineSize: string;
    entryPrice: string;
    target1: string;
    target2?: string;
    tp1Done: boolean;
    tp2Done: boolean;
    lastRequestedStop?: string;
  }[] {
    return [...this.plans.values()].map((plan) => ({
      marketId: plan.marketId,
      symbol: plan.symbol,
      direction: plan.direction,
      baselineSize: toFixedString(plan.baselineSize),
      entryPrice: toFixedString(plan.entryPrice),
      target1: toFixedString(plan.target1),
      ...(plan.target2 ? { target2: toFixedString(plan.target2) } : {}),
      tp1Done: plan.tp1Done,
      tp2Done: plan.tp2Done,
      ...(plan.lastRequestedStop ? { lastRequestedStop: toFixedString(plan.lastRequestedStop) } : {}),
    }));
  }

  /**
   * Register a plan for a position and derive its targets.
   *
   * Called when a position is first observed. The trade's own proposal is preferred
   * (it carries the real structural levels); when it is unavailable — a restart — the
   * stop is taken from the live protective order and the R multiples are applied to
   * that risk distance, so the plan is still coherent.
   */
  registerPlan(params: {
    market: MarketInfo;
    position: Position;
    /** The live protective stop, when one is already working. */
    stopTriggerPrice?: Decimal;
    /** The original proposal's structural levels, when still known in-process. */
    proposal?: { entryPrice: Decimal; stopPrice: Decimal; target1: Decimal; target2?: Decimal };
    tp1RMultiple: Decimal;
    tp2RMultiple: Decimal;
  }): ExitPlan {
    const { market, position } = params;
    const direction: 'long' | 'short' = position.side === 'LONG' ? 'long' : 'short';
    const size = dec(position.size).abs();

    const entryPrice = params.proposal?.entryPrice ?? dec(position.averageEntryPrice);
    // Prefer the proposal's stop; else the live order's trigger; else the position's
    // own mark with a conservative offset so a plan always exists.
    const initialStop =
      params.proposal?.stopPrice ??
      params.stopTriggerPrice ??
      (direction === 'long' ? entryPrice.times('0.99') : entryPrice.times('1.01'));

    // A risk distance of zero makes R meaningless, so fall back to the entry price
    // distance and refuse to derive targets rather than inventing them.
    const risk = entryPrice.minus(initialStop).abs();
    const riskUsable = risk.greaterThan(0);

    const target1 =
      params.proposal?.target1 ??
      (riskUsable
        ? direction === 'long'
          ? entryPrice.plus(risk.times(params.tp1RMultiple))
          : entryPrice.minus(risk.times(params.tp1RMultiple))
        : entryPrice);
    const target2 =
      params.proposal?.target2 ??
      (riskUsable
        ? direction === 'long'
          ? entryPrice.plus(risk.times(params.tp2RMultiple))
          : entryPrice.minus(risk.times(params.tp2RMultiple))
        : undefined);

    // TP1 is complete once the position has shed the configured fraction. Computed
    // once at plan creation so a partial TP2 fill cannot be mistaken for TP1.
    const tp1Threshold = size.times(dec('100').minus(this.options.tp1ClosePct).div(100));

    const existing = this.plans.get(market.marketId);
    if (existing) {
      // Adopt the smaller baseline: the position only ever shrinks, so a smaller size
      // means TP1 already happened while the manager was not looking.
      if (size.lessThan(existing.baselineSize)) {
        existing.tp1Done = !size.greaterThan(existing.tp1Threshold);
      }
      return existing;
    }

    const plan: ExitPlan = {
      marketId: market.marketId,
      symbol: market.marketDisplayName,
      baselineSize: size,
      direction,
      entryPrice,
      initialStop,
      target1,
      ...(target2 ? { target2 } : {}),
      tp1Threshold,
      tp1Done: false,
      tp2Done: false,
    };
    this.plans.set(market.marketId, plan);
    this.counters.plansCreated += 1;
    this.options.logger.info(
      {
        marketId: market.marketId,
        symbol: market.marketDisplayName,
        direction,
        baselineSize: toFixedString(size),
        entryPrice: toFixedString(entryPrice),
        initialStop: toFixedString(initialStop),
        target1: toFixedString(target1),
        target2: target2 ? toFixedString(target2) : null,
        tp1Threshold: toFixedString(tp1Threshold),
        targetSource: params.proposal ? 'proposal' : 'reconstructed',
      },
      'exit plan registered',
    );
    return plan;
  }

  /** Forget a plan once its position is gone. */
  releasePlan(marketId: number): void {
    if (this.plans.delete(marketId)) {
      this.emergencySubmitted.delete(marketId);
    }
  }

  /**
   * Manage one position: place the missing TP legs, then trail the stop.
   *
   * Ordering is deliberate — TP placement before trailing — because a trailing update
   * replaces the stop, and doing that first would leave a window in which the position
   * has a stop but no target, and would make the "did TP1 fill" inference harder to
   * reason about against a moving stop.
   */
  async manage(params: {
    market: MarketInfo;
    position: Position;
    allowSubmission: boolean;
    /** When true, flatten instead of managing (kill switch / fatal drift). */
    emergency?: { reason: string };
  }): Promise<ExitOutcome> {
    const { market, position } = params;
    const size = dec(position.size).abs();
    if (!size.greaterThan(0)) {
      this.releasePlan(market.marketId);
      return { marketId: market.marketId, symbol: market.marketDisplayName, action: 'nothing_to_do', submitted: false, reason: 'position is flat' };
    }

    const direction: 'long' | 'short' = position.side === 'LONG' ? 'long' : 'short';
    const plan = this.plans.get(market.marketId);

    /* ---- emergency: flatten, do not manage ---- */
    if (params.emergency) {
      if (this.emergencySubmitted.has(market.marketId)) {
        return {
          marketId: market.marketId,
          symbol: market.marketDisplayName,
          action: 'nothing_to_do',
          submitted: false,
          reason: `emergency exit already submitted for this market (${params.emergency.reason})`,
        };
      }
      const reference = dec(position.markPx);
      const result = await this.options.executor.emergencyExit({
        market,
        direction,
        quantity: size,
        referencePrice: reference,
        allowSubmission: params.allowSubmission,
      });
      if (result.ok) {
        this.emergencySubmitted.add(market.marketId);
        this.counters.emergencyExits += 1;
        this.options.logger.error(
          { marketId: market.marketId, symbol: market.marketDisplayName, size: toFixedString(size), reason: params.emergency.reason },
          'EMERGENCY EXIT submitted as reduce-only IOC',
        );
        return {
          marketId: market.marketId,
          symbol: market.marketDisplayName,
          action: 'emergency_exit',
          submitted: true,
          detail: { reason: params.emergency.reason, size: toFixedString(size) },
        };
      }
      this.counters.blockedActions += 1;
      return {
        marketId: market.marketId,
        symbol: market.marketDisplayName,
        action: 'blocked',
        submitted: false,
        reason: `emergency exit failed: ${result.reason}`,
      };
    }

    if (!plan) {
      // Not yet adopted. `Runtime` registers plans before calling manage, so this is
      // an ordering bug rather than a normal case — refuse rather than guess levels.
      this.counters.blockedActions += 1;
      return {
        marketId: market.marketId,
        symbol: market.marketDisplayName,
        action: 'blocked',
        submitted: false,
        reason: 'no exit plan registered for this position',
      };
    }

    /* ---- establish progress from the position's own numbers ---- */
    // Monotonic: once TP1 is done it stays done for this position's life.
    if (!plan.tp1Done && size.lessThanOrEqualTo(plan.tp1Threshold)) {
      plan.tp1Done = true;
      this.options.logger.info(
        { marketId: market.marketId, symbol: market.marketDisplayName, size: toFixedString(size), threshold: toFixedString(plan.tp1Threshold) },
        'TP1 detected as filled (position size fell to the TP1 threshold)',
      );
    }

    const protective = this.options.orderStateMachine.protectiveOrders(market.marketId);
    const liveStop = protective.find((o) => o.purpose === 'stop');
    const liveTps = protective.filter((o) => o.purpose === 'take_profit');

    /* ---- 1. place the missing take-profit legs ---- */
    const tpPlacement = await this.ensureTakeProfits({
      market,
      plan,
      direction,
      size,
      liveTps,
      allowSubmission: params.allowSubmission,
    });
    if (tpPlacement) return tpPlacement;

    /* ---- 2. reduce the stop's quantity after TP1 ---- */
    const reduceOutcome = await this.reconcileStopQuantity({
      market,
      plan,
      direction,
      size,
      liveStop,
      allowSubmission: params.allowSubmission,
    });
    if (reduceOutcome) return reduceOutcome;

    /* ---- 3. trail the remainder ---- */
    const trailOutcome = await this.maybeTrail({
      market,
      plan,
      direction,
      size,
      liveStop,
      allowSubmission: params.allowSubmission,
    });
    if (trailOutcome) return trailOutcome;

    return { marketId: market.marketId, symbol: market.marketDisplayName, action: 'nothing_to_do', submitted: false };
  }

  /* ---------------------------------------------------------------- *
   * Take-profit legs
   * ---------------------------------------------------------------- */

  private async ensureTakeProfits(params: {
    market: MarketInfo;
    plan: ExitPlan;
    direction: 'long' | 'short';
    size: Decimal;
    liveTps: readonly LocalOrder[];
    allowSubmission: boolean;
  }): Promise<ExitOutcome | undefined> {
    const { market, plan, direction, size, liveTps } = params;
    const hasTp = liveTps.length > 0;

    // Which target is next? TP1 until it is detected, then TP2.
    const wantTp1 = !plan.tp1Done;
    const wantTp2 = plan.tp1Done && plan.target2 !== undefined && !plan.tp2Done;

    if (!wantTp1 && !wantTp2) return undefined;

    /**
     * Never stack take-profit legs.
     *
     * A partially filled TP keeps resting with a reduced `remainingSize` — that is the
     * venue's own semantics — so a second leg at the same price would double the exit
     * intent and could close the position twice. Whenever ANY TP leg is live, this
     * returns and lets the resting order finish.
     *
     * The residual imperfection is recorded rather than papered over: if the position
     * shrinks while a larger TP still rests, that leg is reduce-only and therefore
     * clamped by the engine, so it cannot reverse the position — but its stated size
     * overstates what can fill, and the daily report surfaces the live-order count so
     * the condition is visible.
     */
    if (hasTp) return undefined;

    const target = wantTp1 ? plan.target1 : plan.target2!;
    // Sized against what remains: before TP1 that is the whole position, after TP1
    // only the remainder, so the leg can never exceed the open size.
    const quantity =
      wantTp1 && !plan.tp1Done ? size : size;
    if (!quantity.greaterThan(0)) return undefined;

    const snapped = floorToTick(target, dec(market.tickSize));
    const result = await this.options.executor.placeTakeProfit({
      market,
      direction,
      quantity,
      targetPrice: snapped,
      allowSubmission: params.allowSubmission,
    });

    if (result.ok) {
      if (wantTp1) this.counters.tp1Placed += 1;
      else this.counters.tp2Placed += 1;
      return {
        marketId: market.marketId,
        symbol: market.marketDisplayName,
        action: wantTp1 ? 'placed_tp1' : 'placed_tp2',
        submitted: true,
        detail: {
          target: toFixedString(snapped),
          quantity: toFixedString(quantity),
          ...(wantTp1 ? {} : { rMultiple: 'tp2' }),
        },
      };
    }
    // A failed TP is not a safety failure — the stop is still the risk control — so
    // it is a `blocked` outcome that the caller logs and retries next tick, not a
    // reason to flatten.
    this.counters.blockedActions += 1;
    return {
      marketId: market.marketId,
      symbol: market.marketDisplayName,
      action: 'blocked',
      submitted: false,
      reason: `take-profit placement failed: ${result.reason}`,
    };
  }

  /* ---------------------------------------------------------------- *
   * Stop quantity after TP1
   * ---------------------------------------------------------------- */

  /**
   * Bring the stop's quantity in line with the position after a partial exit.
   *
   * Left alone, a stop sized for the ORIGINAL quantity becomes an order to sell more
   * than is held. Because it is reduce-only the engine clamps it, so this is not a
   * correctness bug on the venue — but it makes the stop's stated size misleading,
   * and it means a partial fill reports as "reduced only". Re-placing it at the actual
   * size keeps the local view and the venue view consistent, which is what
   * reconciliation compares.
   */
  private async reconcileStopQuantity(params: {
    market: MarketInfo;
    plan: ExitPlan;
    direction: 'long' | 'short';
    size: Decimal;
    liveStop: LocalOrder | undefined;
    allowSubmission: boolean;
  }): Promise<ExitOutcome | undefined> {
    const { market, plan, direction, size, liveStop } = params;
    if (!plan.tp1Done || !liveStop) return undefined;

    const stopQuantity = dec(liveStop.quantity);
    if (stopQuantity.lessThanOrEqualTo(size)) return undefined; // already right-sized

    // Cancel the oversized leg, then place a correctly sized one. Ordering matters:
    // placing first would briefly double the protective orders, and cancelling first
    // opens a gap — so the new leg is placed BEFORE the old one is cancelled, which
    // can only ever over-protect for an instant rather than under-protect.
    const snappedStop = floorToTick(plan.lastRequestedStop ?? plan.initialStop, dec(market.tickSize));
    const placed = await this.options.executor.placeProtectiveStop({
      market,
      direction,
      quantity: size,
      stopPrice: snappedStop,
      allowSubmission: params.allowSubmission,
    });
    if (!placed.protected) {
      this.counters.blockedActions += 1;
      return {
        marketId: market.marketId,
        symbol: market.marketDisplayName,
        action: 'blocked',
        submitted: false,
        reason: `could not re-place the stop at the reduced size: ${placed.reason ?? 'unknown'}`,
      };
    }

    const cancelled = await this.options.executor.cancelOrder({
      market,
      localKey: liveStop.key,
      allowSubmission: params.allowSubmission,
      reason: 'stop superseded by a correctly sized leg after TP1',
    });
    if (!cancelled.ok) {
      // The replacement is live, so the position is protected; the stale leg is now
      // also present. Report it so the operator sees the duplicate rather than having
      // it silently reconciled away.
      this.options.logger.warn(
        { marketId: market.marketId, staleStop: liveStop.key, reason: cancelled.reason },
        'could not cancel the superseded stop; both legs may now rest',
      );
    }

    plan.lastRequestedStop = snappedStop;
    this.counters.stopsReduced += 1;
    return {
      marketId: market.marketId,
      symbol: market.marketDisplayName,
      action: 'reduced_stop_after_tp1',
      submitted: true,
      detail: {
        fromQuantity: toFixedString(stopQuantity),
        toQuantity: toFixedString(size),
        stopPrice: toFixedString(snappedStop),
        supersededCancelled: cancelled.ok,
      },
    };
  }

  /* ---------------------------------------------------------------- *
   * Trailing
   * ---------------------------------------------------------------- */

  /**
   * Trail the remainder on the structure EMA.
   *
   * TWO invariants, both strictly enforced:
   *
   *  1. A trailing stop may only ever move in the FAVOURABLE direction. For a long
   *     that means up, never down. A "trail" that widens risk is not a trail, and it
   *     is the single most dangerous plausible bug here — so the comparison is made
   *     before any submission and a refusal is logged rather than attempted.
   *
   *  2. Trailing only begins once the trade has moved `TRAIL_ACTIVATION_R` in our
   *     favour. Trailing from the start would convert ordinary noise into a stop-out,
   *     which defeats the purpose of a 2R target plan.
   */
  private async maybeTrail(params: {
    market: MarketInfo;
    plan: ExitPlan;
    direction: 'long' | 'short';
    size: Decimal;
    liveStop: LocalOrder | undefined;
    allowSubmission: boolean;
  }): Promise<ExitOutcome | undefined> {
    const { market, plan, direction, size, liveStop } = params;
    if (!plan.tp1Done) return undefined; // trail only the remainder
    if (!liveStop) {
      // No stop to trail. `Runtime` treats a missing stop as an emergency, so this is
      // not handled here — refusing keeps the responsibilities separate.
      return undefined;
    }

    const currentStop = liveStop.triggerPrice ? dec(liveStop.triggerPrice) : undefined;
    if (!currentStop) return undefined;

    // Favourability check against the LAST REQUESTED level, which is the only value we
    // can trust as "what we asked for"; the live trigger may be mid-update.
    const reference = plan.lastRequestedStop ?? currentStop;
    const volume = dec(market.markPrice ?? market.oraclePrice ?? market.lastTradePrice ?? '0');
    if (!volume.greaterThan(0)) return undefined;

    const risk = plan.entryPrice.minus(plan.initialStop).abs();
    if (!risk.greaterThan(0)) return undefined;
    const favourableMove = direction === 'long' ? volume.minus(plan.entryPrice) : plan.entryPrice.minus(volume);
    if (favourableMove.lessThan(risk.times(TRAIL_ACTIVATION_R))) {
      return undefined; // not enough progress to justify trailing yet
    }

    const ema = this.trailingEma(market.marketDisplayName);
    if (!ema) return undefined;

    // The candidate level is the EMA, pulled slightly beyond it so normal retests do
    // not stop us out, and snapped to the venue grid.
    const buffer = ema.times(this.options.emergencyBoundBps).div(10_000);
    const rawCandidate = direction === 'long' ? ema.minus(buffer) : ema.plus(buffer);
    const candidate = floorToTick(rawCandidate, dec(market.tickSize));

    const improves = direction === 'long' ? candidate.greaterThan(reference) : candidate.lessThan(reference);
    if (!improves) {
      return undefined;
    }
    // A stop that would sit beyond the current mark is not a stop.
    if (direction === 'long' && candidate.greaterThanOrEqualTo(volume)) return undefined;
    if (direction === 'short' && candidate.lessThanOrEqualTo(volume)) return undefined;

    const placed = await this.options.executor.placeProtectiveStop({
      market,
      direction,
      quantity: size,
      stopPrice: candidate,
      allowSubmission: params.allowSubmission,
    });
    if (!placed.protected) {
      this.counters.blockedActions += 1;
      return {
        marketId: market.marketId,
        symbol: market.marketDisplayName,
        action: 'blocked',
        submitted: false,
        reason: `trailing stop placement failed: ${placed.reason ?? 'unknown'}`,
      };
    }
    const cancelled = await this.options.executor.cancelOrder({
      market,
      localKey: liveStop.key,
      allowSubmission: params.allowSubmission,
      reason: 'stop superseded by a trailing update',
    });

    plan.lastRequestedStop = candidate;
    this.counters.stopsTrailed += 1;
    return {
      marketId: market.marketId,
      symbol: market.marketDisplayName,
      action: 'trailed_stop',
      submitted: true,
      detail: {
        from: toFixedString(reference),
        to: toFixedString(candidate),
        ema: toFixedString(ema),
        supersededCancelled: cancelled.ok,
      },
    };
  }

  /** Latest trailing EMA on the structure timeframe, or undefined. */
  private trailingEma(symbol: string): Decimal | undefined {
    const bars = this.options.getStructureCandles(symbol).filter((bar) => bar.isFinal);
    if (bars.length < this.options.trailEmaPeriod + 1) return undefined;
    const series = emaOnCandles(bars, this.options.trailEmaPeriod);
    return lastDefined(series);
  }
}
