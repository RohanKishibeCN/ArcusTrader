/**
 * Cost model.
 *
 * The brief is explicit that an entry is only permitted when
 * `expectedMove > totalEstimatedCost`, and equally explicit that we must not
 * assume every order is a maker, that a maker order will fill, that funding is
 * zero, that RWA off-hours spreads are stable, that mark equals last trade, or
 * that an unfilled order produced volume.
 *
 * So this module produces a deliberately pessimistic estimate:
 *
 *   estimatedEntryFee   — maker rate only when the order is ALO AND we are
 *                         prepared for it not to fill; otherwise the taker rate
 *   estimatedExitFee    — the stop is a trigger order and may cross; use taker
 *   estimatedSpreadCost — half-spread paid on the crossing leg(s)
 *   estimatedSlippage   — configured bps applied to the crossing notional
 *   expectedFundingCost — funding accrued over the expected holding horizon,
 *                         charged AGAINST us regardless of sign, because a
 *                         favourable funding sign can flip before exit
 *   safetyBuffer        — a further configured bps on top
 *
 * Every component is returned separately so the daily report and the replay
 * runner can attribute PnL to fees, funding and slippage rather than lumping
 * them together, which the brief requires.
 */

import { Decimal, dec, toFixedString } from '../util/decimal';

export interface CostModelConfig {
  /** Fee rate in bps applied when our order rests (maker). */
  readonly makerFeeBps: Decimal;
  /** Fee rate in bps applied when our order crosses (taker). */
  readonly takerFeeBps: Decimal;
  /** Assumed adverse slippage on a crossing leg, in bps. */
  readonly assumedSlippageBps: Decimal;
  /** Additional safety margin over the whole estimate, in bps of notional. */
  readonly safetyBufferBps: Decimal;
}

export interface FundingHorizon {
  /** Funding rate per funding interval, as a signed fraction. */
  readonly ratePerInterval: Decimal;
  /** How long until the next funding payment, in hours. */
  readonly hoursToNextFunding: Decimal;
  /** Expected holding time, in hours. */
  readonly expectedHoldHours: Decimal;
  /** Funding interval length in hours (Arcushourly by default). */
  readonly intervalHours: Decimal;
}

export interface CostEstimateInput {
  readonly notional: Decimal;
  /** True when the entry is an ALO/post-only maker order. */
  readonly entryIsMaker: boolean;
  /** Half-spread in bps of mid, paid on each crossing leg. */
  readonly halfSpreadBps: Decimal;
  /** Expected favourable price move over the holding horizon, in quote units. */
  readonly expectedMove: Decimal;
  readonly funding?: FundingHorizon;
  readonly config: CostModelConfig;
}

export interface CostEstimate {
  readonly notional: string;
  readonly estimatedEntryFee: string;
  readonly estimatedExitFee: string;
  readonly estimatedSpreadCost: string;
  readonly estimatedSlippage: string;
  readonly expectedFundingCost: string;
  readonly safetyBuffer: string;
  readonly totalEstimatedCost: string;
  /** Expected move minus total cost. Positive means the trade clears its costs. */
  readonly netEdge: string;
  readonly expectedMove: string;
  readonly viable: boolean;
  /** Per-component bps of notional, for the report. */
  readonly bpsBreakdown: Record<string, string>;
  readonly assumptions: readonly string[];
}

/**
 * Estimate the round-trip cost of a prospective trade.
 *
 * The maker assumption is applied ONLY to the entry, and only when the caller
 * asserts the order is post-only. The exit is always costed as a taker because
 * exits are triggered stops or marketable reduce-only orders; assuming a maker
 * exit would understate cost precisely when it matters (a fast move against us).
 */
export function estimateCost(input: CostEstimateInput): CostEstimate {
  const notional = input.notional;
  if (!notional.greaterThan(0)) {
    throw new Error(`cost model requires a positive notional, got ${toFixedString(notional)}`);
  }
  const cfg = input.config;
  const assumptions: string[] = [];

  const entryFeeBps = input.entryIsMaker ? cfg.makerFeeBps : cfg.takerFeeBps;
  if (input.entryIsMaker) {
    assumptions.push(
      'entry costed at the MAKER rate because the entry is an ALO/post-only order; ' +
        'an ALO order may not fill at all, in which case this trade never happens',
    );
  } else {
    assumptions.push('entry costed at the TAKER rate because the entry may cross the spread');
  }
  assumptions.push('exit costed at the TAKER rate: triggered stops and risk exits cross the book');

  const estimatedEntryFee = notional.times(entryFeeBps).div(10_000);
  const estimatedExitFee = notional.times(cfg.takerFeeBps).div(10_000);

  // Spread is paid on each crossing leg. The maker entry is assumed not to cross,
  // so it pays no spread — but it may not fill, which the assumption records.
  const crossingLegs = input.entryIsMaker ? new Decimal(1) : new Decimal(2);
  const estimatedSpreadCost = notional.times(input.halfSpreadBps).div(10_000).times(crossingLegs);

  const estimatedSlippage = notional.times(cfg.assumedSlippageBps).div(10_000).times(crossingLegs);

  let expectedFundingCost = new Decimal(0);
  if (input.funding) {
    const { ratePerInterval, hoursToNextFunding, expectedHoldHours, intervalHours } = input.funding;
    if (!intervalHours.greaterThan(0)) {
      throw new Error('funding intervalHours must be positive');
    }
    // Count funding payments that could land inside the holding window. The first
    // payment occurs at hoursToNextFunding; subsequent ones every intervalHours.
    const payments = countFundingPayments(hoursToNextFunding, expectedHoldHours, intervalHours);
    // Charged AGAINST us in absolute terms: a rate that is currently in our
    // favour can invert before exit, and planning on a funding subsidy is exactly
    // the kind of assumption the brief forbids.
    expectedFundingCost = notional.times(ratePerInterval.abs()).times(payments);
    assumptions.push(
      `funding charged against us as |rate| x ${toFixedString(payments)} payment(s) in ` +
        `${toFixedString(expectedHoldHours)}h (rate=${toFixedString(ratePerInterval)}, ` +
        `${toFixedString(hoursToNextFunding)}h to next, interval=${toFixedString(intervalHours)}h)`,
    );
  } else {
    assumptions.push('no funding data supplied; funding cost assumed zero (conservative only if the rate is ~0)');
  }

  const safetyBuffer = notional.times(cfg.safetyBufferBps).div(10_000);

  const totalEstimatedCost = estimatedEntryFee
    .plus(estimatedExitFee)
    .plus(estimatedSpreadCost)
    .plus(estimatedSlippage)
    .plus(expectedFundingCost)
    .plus(safetyBuffer);

  const netEdge = input.expectedMove.minus(totalEstimatedCost);

  const bps = (value: Decimal): string => toFixedString(value.div(notional).times(10_000));

  return {
    notional: toFixedString(notional),
    estimatedEntryFee: toFixedString(estimatedEntryFee),
    estimatedExitFee: toFixedString(estimatedExitFee),
    estimatedSpreadCost: toFixedString(estimatedSpreadCost),
    estimatedSlippage: toFixedString(estimatedSlippage),
    expectedFundingCost: toFixedString(expectedFundingCost),
    safetyBuffer: toFixedString(safetyBuffer),
    totalEstimatedCost: toFixedString(totalEstimatedCost),
    netEdge: toFixedString(netEdge),
    expectedMove: toFixedString(input.expectedMove),
    viable: netEdge.greaterThan(0),
    bpsBreakdown: {
      estimatedEntryFee: bps(estimatedEntryFee),
      estimatedExitFee: bps(estimatedExitFee),
      estimatedSpreadCost: bps(estimatedSpreadCost),
      estimatedSlippage: bps(estimatedSlippage),
      expectedFundingCost: bps(expectedFundingCost),
      safetyBuffer: bps(safetyBuffer),
      total: bps(totalEstimatedCost),
    },
    assumptions,
  };
}

/**
 * How many funding payments fall inside the holding window.
 *
 * Returns a Decimal because fractional exposure to a funding interval is
 * meaningful for a conservative estimate (we round UP to the next whole payment
 * only when the window overlaps it at all). Rounding up is the pessimistic and
 * therefore correct direction.
 */
export function countFundingPayments(
  hoursToNextFunding: Decimal,
  expectedHoldHours: Decimal,
  intervalHours: Decimal,
): Decimal {
  if (!expectedHoldHours.greaterThan(0)) return new Decimal(0);
  if (hoursToNextFunding.greaterThan(expectedHoldHours)) return new Decimal(0);
  const remainingAfterFirst = expectedHoldHours.minus(hoursToNextFunding);
  const extra = remainingAfterFirst.div(intervalHours).floor();
  return extra.plus(1);
}

/**
 * Expected favourable move for a proposal, used as the `expectedMove` input.
 *
 * Defined as the distance from entry to the first target, scaled by the
 * configured projectable fraction. It is deliberately NOT the full R multiple:
 * TP1 is the point at which the trade has actually paid, and using the full
 * target would let a trade through whose realistic move does not cover costs.
 */
export function expectedMoveToTarget(params: {
  entryPrice: Decimal;
  firstTarget: Decimal;
  /** Fraction of the target distance regarded as realistically projectable. */
  projectableFraction: Decimal;
  quantity: Decimal;
}): Decimal {
  const distance = params.firstTarget.minus(params.entryPrice).abs();
  return distance.times(params.projectableFraction).times(params.quantity);
}

/**
 * Fee rates for the account, from the published fee tier table.
 *
 * Falls back to configured defaults only when the table cannot be read, and says
 * so — silently substituting a guessed fee rate is how a cost model starts lying.
 */
export function resolveFeeRates(params: {
  rows: readonly { tierLevel?: number; makerFeeBps?: string; takerFeeBps?: string }[];
  fallbackMakerFeeBps: Decimal;
  fallbackTakerFeeBps: Decimal;
}): { makerFeeBps: Decimal; takerFeeBps: Decimal; source: 'table' | 'fallback'; note?: string } {
  // Tier 1 is the entry tier; use the lowest tier present when levels are absent.
  const sorted = [...params.rows].sort((a, b) => (a.tierLevel ?? 0) - (b.tierLevel ?? 0));
  const row = sorted.find((r) => r.makerFeeBps !== undefined && r.takerFeeBps !== undefined);
  if (row?.makerFeeBps && row.takerFeeBps) {
    return {
      makerFeeBps: dec(row.makerFeeBps),
      takerFeeBps: dec(row.takerFeeBps),
      source: 'table',
    };
  }
  return {
    makerFeeBps: params.fallbackMakerFeeBps,
    takerFeeBps: params.fallbackTakerFeeBps,
    source: 'fallback',
    note: 'fee tier table unavailable or empty; using configured fallback rates',
  };
}
