/**
 * Local RiskEngine.
 *
 * Every trading decision in this system passes through `evaluateEntry`. There is
 * no other code path that produces an order, and no component can raise a limit or
 * bypass a check. The engine is a pure function of an explicit state object, so every
 * refusal is reproducible in a test.
 *
 * The engine is deliberately a pure function of an explicit state object rather
 * than something that reaches out to read the world. That makes every refusal
 * reproducible in a test, and it means the caller has to assemble the state —
 * which is where freshness is enforced, because a state that cannot be assembled
 * fresh cannot produce an approval.
 *
 * Sizing follows the brief exactly:
 *
 *   riskBudget          = accountEquity * RISK_PER_TRADE_BPS / 10000
 *   stopDistance        = abs(entryPrice - stopPrice)
 *   quantityByRisk      = riskBudget / stopDistance
 *   quantityByNotional  = accountEquity * MAX_NOTIONAL_PCT / 100 / entryPrice
 *   finalQuantity       = min(quantityByRisk, quantityByNotional,
 *                             freeCollateralLimit, marketMaxPosition,
 *                             arcusMaxPosition, leverageLimit)
 *
 * and is then floored to `stepSize`, so rounding can only ever reduce risk.
 */

import { Decimal, dec, floorToStep, toFixedString } from '../util/decimal';
import type { Logger } from '../util/logger';
import type { MarketInfo, Position } from '../arcus/types';
import type { Fresh } from '../market/MarketProvider';

/* ------------------------------------------------------------------ *
 * Inputs
 * ------------------------------------------------------------------ */

export type TradeDirection = 'long' | 'short';

/**
 * Deterministic strategy proposal. Carries no uncertainty: if the strategy is not
 * confident, it does not emit a proposal at all.
 */
export interface TradeProposal {
  readonly marketId: number;
  readonly symbol: string;
  readonly direction: TradeDirection;
  /** Structural invalidation price (swing low/high), before the ATR buffer. */
  readonly structuralStop: Decimal;
  /** Entry limit price, already snapped to the tick grid. */
  readonly entryPrice: Decimal;
  /** Stop after the ATR buffer is applied. This is what sizes the position. */
  readonly stopPrice: Decimal;
  readonly target1: Decimal;
  readonly target2?: Decimal;
  /** Human-readable rationale, surfaced in logs and the daily report. */
  readonly rationale: readonly string[];
}

/** Cost-model verdict for the proposed entry. */
export interface CostVerdictInput {
  /** Expected favourable move over the intended holding horizon, quote units. */
  readonly expectedMove: Decimal;
  readonly totalEstimatedCost: Decimal;
  readonly breakdown: Readonly<Record<string, string>>;
}

export interface RiskEngineState {
  /** Account equity. Must be positive to size anything. */
  readonly accountEquity: Decimal;
  readonly freeCollateral: Decimal;
  readonly usedMargin: Decimal;
  readonly unrealizedPnl: Decimal;

  /** Open positions across the account, used for the position-count limit. */
  readonly openPositions: readonly Position[];
  /** Order-entry orders currently working. Blocks a second entry per market. */
  readonly workingEntryOrders: readonly { marketId: number; clientId?: string; orderId: string }[];

  /** Realized PnL accumulated for the current UTC day, in quote units. */
  readonly realizedPnlToday: Decimal;
  /** Consecutive losing trades (closed positions), for the streak breaker. */
  readonly consecutiveLosses: number;
  /** True while the account is recalibrating after a large cash-flow change. */
  readonly recalibrating: boolean;
  /** Why recalibration is active, for the refusal message. */
  readonly recalibrationReason?: string;

  /** Freshness of the account/position reads. */
  readonly accountFresh: Fresh<unknown> | undefined;
  readonly positionsFresh: Fresh<unknown> | undefined;
  /** Freshness of market metadata. */
  readonly metadataFresh: Fresh<unknown>;

  /** Venue per-market caps, read from metadata. */
  readonly marketMaxOrderSize?: Decimal;

  /** Current quote for the market under consideration. */
  readonly quoteFresh: boolean;
  readonly quoteReason?: string;
  /** True when the market is outside regular trading hours. */
  readonly isOutsideRth: boolean;
  /** Whether off-hours entries are permitted by configuration. */
  readonly allowOffHours: boolean;

  /** WebSocket health. A down socket blocks new entries. */
  readonly websocketReady: boolean;
  readonly websocketReason?: string;
  /** Reconciliation verdict. Drift blocks new entries. */
  readonly reconciled: boolean;
  readonly reconciliationReason?: string;
  /** Kill-switch verdict. */
  readonly killSwitchEngaged: boolean;
  readonly killSwitchReason?: string;
  /** Per-subaccount order pool. */
  readonly orderPoolAllowed: boolean;
  readonly orderPoolReason?: string;

  readonly cost?: CostVerdictInput;

  /** Market metadata for the market under consideration. */
  readonly market: MarketInfo | undefined;
  /** Effective leverage cap for this market (account override, else default). */
  readonly effectiveLeverage?: Decimal;
}

export interface RiskLimits {
  readonly riskPerTradeBps: Decimal;
  readonly dailyLossLimitBps: Decimal;
  readonly maxNotionalPct: Decimal;
  readonly maxLeverage: Decimal;
  readonly maxOpenPositions: number;
  readonly maxMarketsPerAccount: number;
  readonly maxConsecutiveLosses: number;
  readonly minFreeCollateralUsd: Decimal;
  readonly maxOrderNotionalPct: Decimal;
  readonly minNotional: Decimal;
  readonly minOrderSize: Decimal | undefined;
}

export interface SizingBreakdown {
  readonly riskBudget: string;
  readonly stopDistance: string;
  readonly quantityByRisk: string;
  readonly quantityByNotional: string;
  readonly freeCollateralLimit: string;
  readonly marketMaxPosition: string;
  readonly arcusMaxPosition: string;
  readonly leverageLimit: string;
  readonly bindingConstraint: string;
  readonly finalQuantity: string;
  readonly notionalAtEntry: string;
  readonly riskAtStop: string;
  readonly riskAtStopBps: string;
}

export interface RiskDecision {
  readonly approved: boolean;
  /** Populated only when approved. */
  readonly quantity?: Decimal;
  readonly sizing?: SizingBreakdown;
  /** Every reason for refusal. Never empty when `approved` is false. */
  readonly blockReasons: readonly string[];
  /** Non-blocking observations worth surfacing. */
  readonly warnings: readonly string[];
}

/* ------------------------------------------------------------------ *
 * Engine
 * ------------------------------------------------------------------ */

export class RiskEngine {
  private readonly limits: RiskLimits;
  private readonly logger: Logger;

  constructor(limits: RiskLimits, logger: Logger) {
    this.limits = limits;
    this.logger = logger;
  }

  get currentLimits(): RiskLimits {
    return this.limits;
  }

  /**
   * Decide whether a proposal may become an order, and at what size.
   *
   * Ordering matters for diagnostics: structural and safety refusals are
   * collected BEFORE sizing, so a refusal message never implies the system got as
   * far as computing a size for an invalid trade.
   */
  evaluateEntry(proposal: TradeProposal, state: RiskEngineState): RiskDecision {
    const blockReasons: string[] = [];
    const warnings: string[] = [];

    /* ---- 1. Kill switch and reconciliation come first ---------------- */
    if (state.killSwitchEngaged) {
      blockReasons.push(`kill switch engaged: ${state.killSwitchReason ?? 'reason not recorded'}`);
    }
    if (!state.reconciled) {
      blockReasons.push(`state not reconciled: ${state.reconciliationReason ?? 'unknown drift'}`);
    }
    if (!state.websocketReady) {
      blockReasons.push(`websocket not ready: ${state.websocketReason ?? 'not connected/ready'}`);
    }

    /* ---- 2. Data freshness ------------------------------------------ */
    if (!state.accountFresh) {
      blockReasons.push('account state has never been read');
    } else if (!state.accountFresh.fresh) {
      blockReasons.push(`account state unusable: ${state.accountFresh.reason ?? 'stale'}`);
    }
    if (!state.positionsFresh) {
      blockReasons.push('positions have never been read');
    } else if (!state.positionsFresh.fresh) {
      blockReasons.push(`positions unusable: ${state.positionsFresh.reason ?? 'stale'}`);
    }
    if (!state.metadataFresh.fresh) {
      blockReasons.push(`market metadata unusable: ${state.metadataFresh.reason ?? 'stale'}`);
    }
    if (!state.quoteFresh) {
      blockReasons.push(`quote unusable: ${state.quoteReason ?? 'stale or missing'}`);
    }
    if (!state.orderPoolAllowed) {
      blockReasons.push(`order rate-limit pool unavailable: ${state.orderPoolReason ?? 'unknown'}`);
    }

    /* ---- 3. Off-hours rule ------------------------------------------ */
    if (state.isOutsideRth && !state.allowOffHours) {
      blockReasons.push('market is outside regular trading hours and ALLOW_RWA_OFF_HOURS is false');
    }

    /* ---- 4. Market metadata ---------------------------------------- */
    const market = state.market;
    if (!market) {
      blockReasons.push(`no metadata for market ${proposal.marketId}`);
    } else {
      if (market.status !== 'ONLINE') blockReasons.push(`market status is ${market.status}`);
      const tickSize = dec(market.tickSize);
      const stepSize = dec(market.stepSize);
      if (!tickSize.greaterThan(0)) blockReasons.push('tickSize is not positive');
      if (!stepSize.greaterThan(0)) blockReasons.push('stepSize is not positive');
    }

    /* ---- 5. Equity and cash ---------------------------------------- */
    if (!state.accountEquity.greaterThan(0)) {
      blockReasons.push(`account equity is not positive (${toFixedString(state.accountEquity)})`);
    }
    if (state.freeCollateral.lessThan(this.limits.minFreeCollateralUsd)) {
      blockReasons.push(
        `free collateral ${toFixedString(state.freeCollateral)} below minimum ${toFixedString(this.limits.minFreeCollateralUsd)}`,
      );
    }

    /* ---- 6. Circuit breakers --------------------------------------- */
    const dailyLossLimit = state.accountEquity.times(this.limits.dailyLossLimitBps).div(10_000);
    if (state.realizedPnlToday.isNegative() && state.realizedPnlToday.abs().greaterThanOrEqualTo(dailyLossLimit)) {
      blockReasons.push(
        `daily loss limit reached: realized ${toFixedString(state.realizedPnlToday)} vs limit -${toFixedString(dailyLossLimit)}`,
      );
    }
    if (state.consecutiveLosses >= this.limits.maxConsecutiveLosses) {
      blockReasons.push(
        `consecutive losses ${state.consecutiveLosses} reached the limit of ${this.limits.maxConsecutiveLosses}`,
      );
    }
    if (state.recalibrating) {
      blockReasons.push(`account is recalibrating: ${state.recalibrationReason ?? 'recent large cash-flow change'}`);
    }

    /* ---- 7. Exposure limits ---------------------------------------- */
    const openCount = state.openPositions.filter((p) => !dec(p.size).isZero()).length;
    if (openCount >= this.limits.maxOpenPositions) {
      blockReasons.push(`open positions ${openCount} reached MAX_OPEN_POSITIONS ${this.limits.maxOpenPositions}`);
    }
    const distinctMarkets = new Set(
      state.openPositions.filter((p) => !dec(p.size).isZero()).map((p) => p.marketId),
    );
    const alreadyInMarket = distinctMarkets.has(proposal.marketId);
    if (!alreadyInMarket && distinctMarkets.size >= this.limits.maxMarketsPerAccount) {
      blockReasons.push(
        `distinct markets ${distinctMarkets.size} reached MAX_MARKETS_PER_ACCOUNT ${this.limits.maxMarketsPerAccount}`,
      );
    }
    // One entry order per market: refuse if one is already working.
    const workingHere = state.workingEntryOrders.filter((o) => o.marketId === proposal.marketId);
    if (workingHere.length > 0) {
      blockReasons.push(
        `entry order already working for market ${proposal.marketId} (${workingHere[0]!.orderId})`,
      );
    }

    /* ---- 8. Proposal sanity ---------------------------------------- */
    const structuralSideError = this.checkStopSide(proposal);
    if (structuralSideError) blockReasons.push(structuralSideError);

    const stopDistance = proposal.entryPrice.minus(proposal.stopPrice).abs();
    if (!stopDistance.greaterThan(0)) {
      blockReasons.push('stop distance is zero; a position with no stop cannot be sized');
    }

    /* ---- 9. Cost model --------------------------------------------- */
    if (state.cost) {
      if (state.cost.totalEstimatedCost.greaterThanOrEqualTo(state.cost.expectedMove)) {
        blockReasons.push(
          `expected move ${toFixedString(state.cost.expectedMove)} does not cover estimated cost ` +
            `${toFixedString(state.cost.totalEstimatedCost)}`,
        );
      }
    } else {
      blockReasons.push('cost model verdict missing; refusing to trade without a cost estimate');
    }

    /* ---- 10. Sizing ------------------------------------------------- */
    if (blockReasons.length > 0 || !market) {
      return { approved: false, blockReasons, warnings };
    }

    const sizing = this.computeSizing(proposal, state, market);

    // Order matters for diagnostics. The zero-quantity check MUST come before the
    // notional checks: a zero quantity produces a zero notional, which would
    // otherwise be reported as "below the market minimum" and hide the real cause
    // (which limit actually bound the size to nothing).
    if (!sizing.quantity.greaterThan(0)) {
      blockReasons.push(
        `computed size floors to zero (binding constraint: ${sizing.breakdown.bindingConstraint}, ` +
          `raw quantities: risk=${sizing.breakdown.quantityByRisk} notional=${sizing.breakdown.quantityByNotional} ` +
          `collateral=${sizing.breakdown.freeCollateralLimit} leverage=${sizing.breakdown.leverageLimit})`,
      );
      return { approved: false, blockReasons, warnings };
    }

    if (dec(sizing.breakdown.notionalAtEntry).greaterThan(
      state.accountEquity.times(this.limits.maxOrderNotionalPct).div(100),
    )) {
      blockReasons.push(
        `order notional ${sizing.breakdown.notionalAtEntry} exceeds MAX_ORDER_NOTIONAL_PCT ` +
          `${toFixedString(this.limits.maxOrderNotionalPct)}% of equity`,
      );
      return { approved: false, blockReasons, warnings };
    }

    if (dec(sizing.breakdown.notionalAtEntry).lessThan(this.limits.minNotional)) {
      blockReasons.push(
        `order notional ${sizing.breakdown.notionalAtEntry} is below the market minimum ${toFixedString(this.limits.minNotional)}`,
      );
      return { approved: false, blockReasons, warnings };
    }

    this.logger.info(
      {
        marketId: proposal.marketId,
        direction: proposal.direction,
        quantity: sizing.breakdown.finalQuantity,
        notional: sizing.breakdown.notionalAtEntry,
        riskAtStop: sizing.breakdown.riskAtStop,
        riskAtStopBps: sizing.breakdown.riskAtStopBps,
        bindingConstraint: sizing.breakdown.bindingConstraint,
      },
      'risk engine approved entry',
    );

    return { approved: true, quantity: sizing.quantity, sizing: sizing.breakdown, blockReasons, warnings };
  }

  /**
   * The stop must be on the losing side of the entry.
   *
   * A long whose stop sits ABOVE its entry would size against a negative risk
   * distance and, worse, would be a marketable order with no invalidation level.
   */
  private checkStopSide(proposal: TradeProposal): string | undefined {
    if (proposal.direction === 'long') {
      if (!proposal.stopPrice.lessThan(proposal.entryPrice)) {
        return `long stop ${toFixedString(proposal.stopPrice)} must be below entry ${toFixedString(proposal.entryPrice)}`;
      }
      if (proposal.target1.lessThanOrEqualTo(proposal.entryPrice)) {
        return `long target1 ${toFixedString(proposal.target1)} must be above entry`;
      }
    } else {
      if (!proposal.stopPrice.greaterThan(proposal.entryPrice)) {
        return `short stop ${toFixedString(proposal.stopPrice)} must be above entry ${toFixedString(proposal.entryPrice)}`;
      }
      if (proposal.target1.greaterThanOrEqualTo(proposal.entryPrice)) {
        return `short target1 ${toFixedString(proposal.target1)} must be below entry`;
      }
    }
    return undefined;
  }

  /**
   * Position sizing.
   *
   * Every candidate is computed separately and the minimum wins, with the binding
   * constraint named so a surprising size can be attributed to a specific limit
   * rather than guessed at.
   */
  computeSizing(
    proposal: TradeProposal,
    state: RiskEngineState,
    market: MarketInfo,
  ): { quantity: Decimal; breakdown: SizingBreakdown } {
    const equity = state.accountEquity;
    const entry = proposal.entryPrice;
    const stopDistance = entry.minus(proposal.stopPrice).abs();

    /**
     * Degenerate inputs short-circuit to a zero size.
     *
     * A non-positive equity or entry price makes every candidate a division by
     * zero, which produces NaN — and a NaN cannot even be serialised, so it would
     * surface as an exception rather than as a refusal. Returning an explicit zero
     * keeps the refusal path intact and the breakdown printable.
     */
    if (!equity.greaterThan(0) || !entry.greaterThan(0) || !stopDistance.greaterThan(0)) {
      return {
        quantity: new Decimal(0),
        breakdown: {
          riskBudget: '0',
          stopDistance: toFixedString(stopDistance),
          quantityByRisk: '0',
          quantityByNotional: '0',
          freeCollateralLimit: '0',
          marketMaxPosition: '0',
          arcusMaxPosition: '0',
          leverageLimit: '0',
          bindingConstraint: !equity.greaterThan(0) ? 'accountEquity' : !entry.greaterThan(0) ? 'entryPrice' : 'stopDistance',
          finalQuantity: '0',
          notionalAtEntry: '0',
          riskAtStop: '0',
          riskAtStopBps: '0',
        },
      };
    }

    const riskBudget = equity.times(this.limits.riskPerTradeBps).div(10_000);
    const quantityByRisk = stopDistance.greaterThan(0) ? riskBudget.div(stopDistance) : new Decimal(0);

    const quantityByNotional = equity
      .times(this.limits.maxNotionalPct)
      .div(100)
      .div(entry);

    // Collateral ceiling: cap notional at the leverage limit, and never demand
    // more collateral than is actually free.
    const leverageCap = this.limits.maxLeverage;
    const effectiveLeverage = state.effectiveLeverage && state.effectiveLeverage.greaterThan(0)
      ? Decimal.min(state.effectiveLeverage, leverageCap)
      : leverageCap;

    // freeCollateralLimit = the smaller of (leverage-limited notional / entry)
    // and (free collateral beyond the configured floor) * max leverage / entry.
    const usableCollateral = Decimal.max(
      state.freeCollateral.minus(this.limits.minFreeCollateralUsd),
      new Decimal(0),
    );
    const freeCollateralLimit = Decimal.min(
      usableCollateral.times(leverageCap).div(entry),
      equity.times(leverageCap).div(entry),
    );

    const marketMaxPosition = state.marketMaxOrderSize ?? dec(market.maxOrderSize);
    const arcusMaxPosition = dec(market.maxOrderSize);
    const leverageLimit = equity.times(effectiveLeverage).div(entry);

    const candidates: { name: string; value: Decimal }[] = [
      { name: 'quantityByRisk', value: quantityByRisk },
      { name: 'quantityByNotional', value: quantityByNotional },
      { name: 'freeCollateralLimit', value: freeCollateralLimit },
      { name: 'marketMaxPosition', value: marketMaxPosition },
      { name: 'arcusMaxPosition', value: arcusMaxPosition },
      { name: 'leverageLimit', value: leverageLimit },
    ];
    const binding = candidates.reduce((min, cur) => (cur.value.lessThan(min.value) ? cur : min), candidates[0]!);

    const stepSize = dec(market.stepSize);
    const floored = floorToStep(binding.value, stepSize);

    // Respect a venue minimum order size where published.
    let finalQuantity = floored;
    const minOrderSize = market.minOrderSize ? dec(market.minOrderSize) : undefined;
    if (minOrderSize && finalQuantity.greaterThan(0) && finalQuantity.lessThan(minOrderSize)) {
      finalQuantity = new Decimal(0);
    }

    const notionalAtEntry = finalQuantity.times(entry);
    const riskAtStop = finalQuantity.times(stopDistance);
    const riskAtStopBps = equity.greaterThan(0) ? riskAtStop.div(equity).times(10_000) : new Decimal(0);

    return {
      quantity: finalQuantity,
      breakdown: {
        riskBudget: toFixedString(riskBudget),
        stopDistance: toFixedString(stopDistance),
        quantityByRisk: toFixedString(quantityByRisk),
        quantityByNotional: toFixedString(quantityByNotional),
        freeCollateralLimit: toFixedString(freeCollateralLimit),
        marketMaxPosition: toFixedString(marketMaxPosition),
        arcusMaxPosition: toFixedString(arcusMaxPosition),
        leverageLimit: toFixedString(leverageLimit),
        bindingConstraint: binding.name,
        finalQuantity: toFixedString(finalQuantity),
        notionalAtEntry: toFixedString(notionalAtEntry),
        riskAtStop: toFixedString(riskAtStop),
        riskAtStopBps: toFixedString(riskAtStopBps),
      },
    };
  }

  /**
   * Daily-loss circuit breaker, exposed separately so the runtime can trip the
   * kill switch the moment the limit is crossed rather than waiting for the next
   * entry attempt.
   */
  checkDailyLossBreaker(state: {
    accountEquity: Decimal;
    realizedPnlToday: Decimal;
  }): { tripped: boolean; limit: Decimal; observed: Decimal } {
    const limit = state.accountEquity.times(this.limits.dailyLossLimitBps).div(10_000);
    const tripped =
      state.realizedPnlToday.isNegative() && state.realizedPnlToday.abs().greaterThanOrEqualTo(limit);
    return { tripped, limit, observed: state.realizedPnlToday };
  }

  /**
   * Theoretical withdrawable balance.
   *
   * Reported only — this system never withdraws (`ALLOW_AUTO_WITHDRAW=false`).
   * Deducts used margin, a maintenance-margin buffer for every open position,
   * the worst-case loss if every stop were hit, and a configured safety reserve.
   */
  computeWithdrawable(params: {
    equity: Decimal;
    usedMargin: Decimal;
    positions: readonly { size: Decimal; markPx: Decimal; maintenanceMarginFraction?: Decimal }[];
    worstCaseStopLoss: Decimal;
    safetyReservePct: Decimal;
  }): { withdrawable: Decimal; components: Record<string, string> } {
    const maintenanceBuffer = params.positions.reduce((acc, p) => {
      const mmf = p.maintenanceMarginFraction ?? new Decimal('0.005');
      return acc.plus(p.size.abs().times(p.markPx).times(mmf));
    }, new Decimal(0));

    const afterMargin = params.equity.minus(params.usedMargin);
    const afterMaintenance = afterMargin.minus(maintenanceBuffer);
    const afterStops = afterMaintenance.minus(params.worstCaseStopLoss);
    const reserve = params.equity.times(params.safetyReservePct).div(100);
    const withdrawable = Decimal.max(afterStops.minus(reserve), new Decimal(0));

    return {
      withdrawable,
      components: {
        equity: toFixedString(params.equity),
        usedMargin: toFixedString(params.usedMargin),
        maintenanceBuffer: toFixedString(maintenanceBuffer),
        worstCaseStopLoss: toFixedString(params.worstCaseStopLoss),
        safetyReserve: toFixedString(reserve),
        withdrawable: toFixedString(withdrawable),
      },
    };
  }

  /**
   * Estimated liquidation price for an isolated position.
   *
   * Approximate by construction and labelled as such: the venue computes the real
   * value from margin state this system cannot fully see. It is used for a
   * distance warning in the daily report, never as a stop substitute.
   */
  estimateLiquidationDistance(params: {
    entryPrice: Decimal;
    size: Decimal;
    marginUsed: Decimal;
    maintenanceMarginFraction: Decimal;
    direction: TradeDirection;
  }): { liquidationPrice: Decimal; distancePct: Decimal } | undefined {
    const size = params.size.abs();
    if (!size.greaterThan(0) || !params.entryPrice.greaterThan(0)) return undefined;
    const mmr = params.maintenanceMarginFraction;
    if (!mmr.greaterThan(0)) return undefined;

    const maintenance = size.times(params.entryPrice).times(mmr);
    const cushion = params.marginUsed.minus(maintenance);
    const adverseMove = cushion.div(size);
    const liquidationPrice =
      params.direction === 'long'
        ? params.entryPrice.minus(adverseMove)
        : params.entryPrice.plus(adverseMove);

    const distancePct = params.entryPrice.greaterThan(0)
      ? liquidationPrice.minus(params.entryPrice).abs().div(params.entryPrice).times(100)
      : new Decimal(0);
    return { liquidationPrice, distancePct };
  }

  /* ---------------------------------------------------------------- *
   * Dynamic equity / recalibration
   * ---------------------------------------------------------------- */

  /**
   * Recalibration trigger for large cash-flow changes.
   *
   * A deposit or withdrawal that moves equity beyond
   * `EQUITY_CHANGE_PAUSE_BPS` pauses NEW entries while leaving existing
   * positions and their stops untouched — open positions keep being managed.
   */
  checkEquityChange(params: {
    previousEquity: Decimal | undefined;
    currentEquity: Decimal;
    thresholdBps: Decimal;
  }): { recalibrate: boolean; changeBps: Decimal; reason?: string } {
    const previous = params.previousEquity;
    if (!previous || !previous.greaterThan(0)) {
      return { recalibrate: false, changeBps: new Decimal(0) };
    }
    const changeBps = params.currentEquity.minus(previous).abs().div(previous).times(10_000);
    const recalibrate = changeBps.greaterThanOrEqualTo(params.thresholdBps);
    return {
      recalibrate,
      changeBps,
      ...(recalibrate
        ? {
            reason:
              `equity moved ${toFixedString(changeBps)} bps (threshold ${toFixedString(params.thresholdBps)} bps); ` +
              'new entries paused until the next trading day or an explicit recalibration',
          }
        : {}),
    };
  }

  /**
   * R multiple of a price target, used for TP placement and reporting.
   * Returns undefined when risk is zero (no meaningful R).
   */
  static rMultiple(entry: Decimal, stop: Decimal, target: Decimal): Decimal | undefined {
    const risk = entry.minus(stop).abs();
    if (!risk.greaterThan(0)) return undefined;
    return target.minus(entry).abs().div(risk);
  }
}
