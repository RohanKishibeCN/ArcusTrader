/**
 * Decision pipeline.
 *
 * Turns "current market state" into "an order the RiskEngine approved, or an explicit
 * refusal with reasons". This is the only place the three independent gates are joined,
 * in this fixed order:
 *
 *   1. DETERMINISTIC STRATEGY  — produces a direction, or nothing.
 *   2. COST MODEL              — is the expected move worth the round trip?
 *   3. RISK ENGINE             — sizing and every hard limit.
 *
 * Ordering is deliberate: the strategy is cheapest and rejects most evaluations, so it
 * runs first; the cost model needs a concrete proposal, so it runs second; the RiskEngine
 * runs last because it needs everything else as input.
 *
 * Anything that cannot be established is a refusal. There is no default-allow.
 */

import { Decimal, dec, toFixedString } from '../util/decimal';
import type { Logger } from '../util/logger';
import type { Candle, MarketInfo } from '../arcus/types';
import { evaluateStrategy, type StrategyConfig, type StrategySignal } from '../strategy/PullbackStrategy';
import {
  estimateCost,
  expectedMoveToTarget,
  type CostEstimate,
  type CostModelConfig,
  type FundingHorizon,
} from '../strategy/CostModel';
import type { RiskDecision, RiskEngine, RiskEngineState, TradeProposal } from '../risk/RiskEngine';

/** Everything the pipeline needs to know about one market right now. */
export interface MarketSnapshotInput {
  readonly market: MarketInfo;
  readonly trendCandles: readonly Candle[];
  readonly structureCandles: readonly Candle[];
  readonly triggerCandles: readonly Candle[];
  readonly bid: Decimal;
  readonly ask: Decimal;
  readonly quoteAgeMs: number;
  /** Bid/ask depth within a small band of mid, for reporting. */
  readonly bidDepthUsd?: Decimal;
  readonly askDepthUsd?: Decimal;
  /** Funding rate per interval, as a fraction. */
  readonly fundingRate?: Decimal;
  /** Hours until the next funding payment. */
  readonly hoursToNextFunding?: Decimal;
  /** Expected hold duration, in hours, used by the funding estimate. */
  readonly expectedHoldHours?: Decimal;
}

export type DecisionOutcome =
  | {
      readonly kind: 'no_signal';
      readonly symbol: string;
      readonly signal: StrategySignal;
    }
  | {
      readonly kind: 'rejected';
      readonly symbol: string;
      readonly stage: 'cost' | 'risk';
      readonly reasons: readonly string[];
      readonly signal: StrategySignal;
      readonly cost?: CostEstimate;
    }
  | {
      readonly kind: 'approved';
      readonly symbol: string;
      readonly proposal: TradeProposal;
      readonly quantity: Decimal;
      readonly notional: Decimal;
      readonly riskDecision: RiskDecision;
      readonly cost: CostEstimate;
      readonly signal: StrategySignal;
    };

export interface DecisionPipelineOptions {
  readonly logger: Logger;
  readonly strategyConfig: StrategyConfig;
  readonly costConfig: CostModelConfig;
  readonly riskEngine: RiskEngine;
  /** Fraction of the target distance treated as realistically projectable. */
  readonly projectableFraction: Decimal;
  readonly maxDataAgeMs: number;
  /** Fee rates resolved from the tier table (or a documented fallback). */
  readonly feeRates: { makerFeeBps: Decimal; takerFeeBps: Decimal; source: 'table' | 'fallback'; note?: string };
}

/** Counters surfaced in the daily report so the pipeline's behaviour is auditable. */
export interface PipelineStats {
  evaluations: number;
  noSignal: number;
  rejectedByCost: number;
  rejectedByRisk: number;
  approved: number;
  /** Why the last evaluation ended, for the report's strategy-state line. */
  lastReason?: string;
}

export class DecisionPipeline {
  private readonly options: DecisionPipelineOptions;

  readonly stats: PipelineStats = {
    evaluations: 0,
    noSignal: 0,
    rejectedByCost: 0,
    rejectedByRisk: 0,
    approved: 0,
  };

  constructor(options: DecisionPipelineOptions) {
    this.options = options;
  }

  /**
   * Run the pipeline for one market.
   *
   * `buildRiskState` is a thunk because assembling the risk state requires knowing the
   * proposal (for the market metadata and effective leverage) and is expensive; it is
   * only invoked once a proposal exists.
   */
  async decide(params: {
    snapshot: MarketSnapshotInput;
    buildRiskState: (proposal: TradeProposal) => RiskEngineState;
  }): Promise<DecisionOutcome> {
    const { snapshot } = params;
    const symbol = snapshot.market.marketDisplayName;
    this.stats.evaluations += 1;

    /* ---- 1. deterministic strategy --------------------------------- */
    const signal = evaluateStrategy({
      market: snapshot.market,
      trendCandles: snapshot.trendCandles,
      structureCandles: snapshot.structureCandles,
      triggerCandles: snapshot.triggerCandles,
      config: this.options.strategyConfig,
    });

    if (signal.direction === 'flat' || !signal.proposal) {
      this.stats.noSignal += 1;
      this.stats.lastReason = signal.flatReason ?? 'no setup';
      return { kind: 'no_signal', symbol, signal };
    }
    const proposal = signal.proposal;

    /* ---- 2. cost model --------------------------------------------- */
    // Provisional size for the cost estimate: the risk-based size is not known until the
    // RiskEngine runs, and the RiskEngine needs the cost verdict. Sizing does not depend
    // on the cost verdict (only approval does), so this is not circular.
    const provisionalQuantity = this.provisionalQuantity(proposal, params.buildRiskState(proposal));
    const notional = provisionalQuantity.times(proposal.entryPrice);

    if (!notional.greaterThan(0)) {
      this.stats.rejectedByRisk += 1;
      this.stats.lastReason = 'computed notional is zero before the cost check';
      return {
        kind: 'rejected',
        symbol,
        stage: 'risk',
        reasons: ['computed notional is zero, so no cost estimate is meaningful'],
        signal,
      };
    }

    const funding: FundingHorizon | undefined =
      snapshot.fundingRate !== undefined &&
      snapshot.hoursToNextFunding !== undefined &&
      snapshot.expectedHoldHours !== undefined
        ? {
            ratePerInterval: snapshot.fundingRate,
            hoursToNextFunding: snapshot.hoursToNextFunding,
            expectedHoldHours: snapshot.expectedHoldHours,
            intervalHours: new Decimal(1),
          }
        : undefined;

    const mid = snapshot.ask.plus(snapshot.bid).div(2);
    const halfSpreadBps =
      mid.greaterThan(0) && snapshot.ask.greaterThan(snapshot.bid)
        ? snapshot.ask.minus(snapshot.bid).div(mid).times(10_000).div(2)
        : new Decimal(0);

    const cost = estimateCost({
      notional,
      entryIsMaker: true, // pullback entries are ALO
      halfSpreadBps,
      expectedMove: expectedMoveToTarget({
        entryPrice: proposal.entryPrice,
        firstTarget: proposal.target1,
        projectableFraction: this.options.projectableFraction,
        quantity: provisionalQuantity,
      }),
      ...(funding ? { funding } : {}),
      config: {
        ...this.options.costConfig,
        makerFeeBps: this.options.feeRates.makerFeeBps,
        takerFeeBps: this.options.feeRates.takerFeeBps,
      },
    });

    if (!cost.viable) {
      this.stats.rejectedByCost += 1;
      this.stats.lastReason = 'expected move does not cover estimated cost';
      this.options.logger.info(
        { symbol, netEdge: cost.netEdge, totalCost: cost.totalEstimatedCost },
        'setup rejected: expected move does not cover estimated cost',
      );
      return { kind: 'rejected', symbol, stage: 'cost', reasons: [costVerdict(cost)], signal, cost };
    }

    /* ---- 3. risk engine -------------------------------------------- */
    const riskDecision = this.options.riskEngine.evaluateEntry(proposal, {
      ...params.buildRiskState(proposal),
      cost: {
        expectedMove: dec(cost.expectedMove),
        totalEstimatedCost: dec(cost.totalEstimatedCost),
        breakdown: cost.bpsBreakdown,
      },
    });

    if (!riskDecision.approved || !riskDecision.quantity) {
      this.stats.rejectedByRisk += 1;
      this.stats.lastReason = riskDecision.blockReasons[0] ?? 'risk engine refused';
      this.options.logger.info(
        { symbol, blockReasons: riskDecision.blockReasons.slice(0, 5) },
        'setup rejected by risk engine',
      );
      return {
        kind: 'rejected',
        symbol,
        stage: 'risk',
        reasons: riskDecision.blockReasons,
        signal,
        cost,
      };
    }

    this.stats.approved += 1;
    this.stats.lastReason = `approved ${proposal.direction} ${toFixedString(riskDecision.quantity)}`;
    return {
      kind: 'approved',
      symbol,
      proposal,
      quantity: riskDecision.quantity,
      notional: riskDecision.quantity.times(proposal.entryPrice),
      riskDecision,
      cost,
      signal,
    };
  }

  /**
   * Quantity used only to bound the cost estimate.
   *
   * Uses the RiskEngine's own sizing so the notional in the cost estimate matches the
   * notional that would actually be traded.
   */
  private provisionalQuantity(proposal: TradeProposal, state: RiskEngineState): Decimal {
    if (!state.market) return new Decimal(0);
    return this.options.riskEngine.computeSizing(proposal, state, state.market).quantity;
  }
}

function costVerdict(cost: CostEstimate): string {
  return (
    `expected move ${cost.expectedMove} does not cover estimated total cost ${cost.totalEstimatedCost} ` +
    `(net edge ${cost.netEdge}); components: ${Object.entries(cost.bpsBreakdown)
      .map(([k, v]) => `${k}=${v}bps`)
      .join(', ')}`
  );
}
