/**
 * Deterministic offline replay / backtester.
 *
 * WHAT THIS IS
 * ------------
 * A backtest that calls the REAL `evaluateStrategy` from
 * `src/strategy/PullbackStrategy.ts` on a fixed candle series, and then simulates
 * what would have happened to the order that signal produces. It is a harness for
 * the *shipped* signal logic, not a second implementation of it: if the
 * strategy's gates change, the replay changes with them. A reimplementation would
 * drift from the live path and start certifying trades the live system would
 * never place.
 *
 * WHY EVERY RULE BELOW IS CONSERVATIVE
 * ------------------------------------
 * A backtest's natural failure mode is optimism: assuming the limit filled,
 * assuming the favourable branch of an ambiguous bar, assuming funding was free.
 * Every rule here is chosen so the error points the other way — an unfilled
 * order, the stop instead of the target, a cost rather than a credit. Where the
 * conservative choice is not the obvious one, the code says why.
 *
 * MODELING ASSUMPTIONS (all of them, in one place)
 * ------------------------------------------------
 *  A1  NO LOOKAHEAD. Signals are evaluated at the CLOSE of a closed trigger bar
 *      using only bars whose close time is at or before that instant. Each
 *      series' bar interval is inferred from the series itself, so a bar counts
 *      as closed when `openTime + interval <= decisionInstant`. The trigger
 *      window is exactly the bars up to and including the signal bar.
 *  A2  ENTRY FILL. The signal's limit order is placed at the signal bar's close
 *      and may only fill on a LATER bar whose range touches the limit. The signal
 *      bar itself never fills, and a bar that gaps past the limit is a fill.
 *  A3  TTL. The order lives for `entryTtlBars` bars after the signal bar and is
 *      then cancelled with no trade (`entriesExpired`). An order still live when
 *      the data runs out is `entriesOpenAtEndOfData`, also a non-trade.
 *  A4  MAKER FILL. The entry is an ALO (post-only) limit, so `makerEntry` is
 *      always true. A merely touched order fills as maker only when a
 *      deterministic FNV-1a hash of `(marketId, barIndex, limitPrice)` falls
 *      below `makerFillProbability`. No `Math.random()`: the same input replays
 *      byte-identically. This models queue position and adverse selection, which
 *      a "touched = filled" rule silently assumes away.
 *  A5  CROSSING ENTRY = TAKER. If the bar's OPEN is already beyond the limit (for
 *      a long `open < limit`, for a short `open > limit`) the order is treated as
 *      having taken liquidity: it fills at the LIMIT price — never at the more
 *      favourable open — and pays the TAKER fee.
 *  A6  EXITS START AFTER THE FILL BAR. The fill bar's high/low include price
 *      action that happened before the position existed, so exits are only
 *      evaluated from the next bar. Using the fill bar would let a wick that
 *      printed before entry stop the trade out.
 *  A7  AMBIGUOUS BAR -> STOP. When one bar's range contains the stop AND a
 *      target, the STOP is assumed hit first and the whole position exits there.
 *      The favourable branch is never assumed when the intrabar path is
 *      unknowable.
 *  A8  NO FREE STOP MOVES. The runner keeps the original stop; a breakeven move
 *      (which the strategy does not specify) is not assumed. A trailing stop
 *      exists only when the caller sets `trailingAtrMultiple`, and it is applied
 *      from the bar AFTER the one that created it — a ratchet cannot be used
 *      inside its own bar.
 *  A9  FEES ARE REAL. Both legs are charged from `CostModelConfig`: the entry at
 *      the maker rate only when it genuinely filled passively, otherwise the
 *      taker rate; the exit always at the taker rate, because stop and risk exits
 *      cross the book. This mirrors `estimateCost`.
 *  A10 SLIPPAGE IS SEPARATE from fees, is charged only on legs that crossed, and
 *      is reported on its own. `safetyBufferBps` is a pre-trade edge buffer, not
 *      cash, so it is never booked as a cost.
 *  A11 FUNDING IS CHARGED AS A COST. `|fundingRatePerHour| * hoursHeld * notional`
 *      is charged against the trade, so a rate that currently pays us cannot make
 *      a trade look better than it is (the sign can invert before the exit). The
 *      full entry notional is charged for the whole hold even after a partial
 *      exit, which over-charges rather than under-charges.
 *  A12 COST GATE. Before placing an order the replay applies the rule the
 *      RiskEngine applies: `expectedMove` (TP1 distance x projectableFraction x
 *      quantity) must be STRICTLY greater than the modelled round-trip cost. The
 *      test is `greaterThan(0)` on the net edge, not `isPositive()`: decimal.js
 *      reports `+0` as positive, and a zero edge is not an edge.
 *  A13 SIZING. Local, mirroring `RiskEngine.computeSizing`: the minimum of the
 *      risk budget, the notional cap and the leverage cap, floored to `stepSize`
 *      so rounding can only reduce risk. The RiskEngine class is not instantiated
 *      because it demands fresh websocket/reconciliation/account state that does
 *      not exist offline; fabricating "healthy" state would make its gates
 *      meaningless.
 *  A14 SEQUENTIAL MARKETS. Markets are replayed in the order supplied and equity
 *      compounds across them. This is not a simultaneous-portfolio simulation;
 *      every metric is per-trade, so cross-market timing does not affect them.
 *  A15 POINTS ARE NOT MONEY. `pointsContribution` is always the literal `'0'`.
 *      Points is a non-cash observation and is never revenue, and no Points value
 *      is read anywhere in this file.
 *
 * CLI
 * ---
 *   tsx tools/replay.ts --help
 *   tsx tools/replay.ts --file scenario.json [--trades]
 *
 * The scenario is `{ "config": {...}, "markets": [{ "market": {...},
 * "trendCandles": [...], "structureCandles": [...], "triggerCandles": [...] }] }`
 * with every money value as a decimal string.
 */

import { readFileSync } from 'node:fs';
import { Decimal, dec, floorToStep, toFixedString, type DecimalLike } from '../src/util/decimal';
import type { Candle, MarketInfo } from '../src/arcus/types';
import { isRwaCategory } from '../src/arcus/types';
import { evaluateStrategy } from '../src/strategy/PullbackStrategy';
import type { StrategyConfig, StrategySignal } from '../src/strategy/PullbackStrategy';
import { closedCandles } from '../src/strategy/StrategyIndicators';
import { countFundingPayments, estimateCost, expectedMoveToTarget } from '../src/strategy/CostModel';
import type { CostModelConfig } from '../src/strategy/CostModel';

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

const ZERO = new Decimal(0);
const ONE = new Decimal(1);

/** Epoch microseconds in one millisecond. */
const MICROS_PER_MS = 1000;

/** Milliseconds in one hour, exact. */
const MS_PER_HOUR = 3_600_000;

/** 2^32, the divisor that maps a 32-bit hash into [0, 1). */
const HASH_SPACE = new Decimal(4294967296);

/* ------------------------------------------------------------------ *
 * Input types
 * ------------------------------------------------------------------ */

/** One market's three candle series. */
export interface ReplayMarketInput {
  readonly market: MarketInfo;
  /** Trend timeframe bars (only `isFinal` ones are used). */
  readonly trendCandles: readonly Candle[];
  /** Structure timeframe bars (only `isFinal` ones are used). */
  readonly structureCandles: readonly Candle[];
  /** Trigger timeframe bars. This series is the replay clock. */
  readonly triggerCandles: readonly Candle[];
}

/** Replay configuration. Rates and money are Decimals. */
export interface ReplayConfig {
  strategy: StrategyConfig;
  cost: CostModelConfig;
  /** Equity at the start of the replay, quote units. */
  initialEquity: Decimal;
  /** Risk budget per trade, in basis points of running equity (A13). */
  riskBps: Decimal;
  /** Hard cap on entry notional as a percentage of equity (A13). */
  maxNotionalPct: Decimal;
  /** Hard cap on leverage (A13). */
  maxLeverage: Decimal;
  /** How many trigger bars the entry limit may rest before cancelling (A3). */
  entryTtlBars: number;
  /** Fraction of the TP1 distance treated as realistically projectable (A12). */
  projectableFraction: Decimal;
  /** Funding rate per hour on open notional, signed; charged as a cost (A11). */
  fundingRatePerHour?: Decimal;
  /**
   * Probability that a merely touched ALO order fills (A4). Default 1: a touch
   * fills. Lower it to model queue position and adverse selection.
   */
  makerFillProbability?: Decimal;
  /**
   * Half-spread in bps handed to the cost model's entry gate. The replay has no
   * order book, so it defaults to 0 — supply a measured spread if you have one.
   * It affects the pre-trade gate only, never the booked PnL.
   */
  halfSpreadBps?: Decimal;
  /**
   * Trailing distance in ATR applied to the runner AFTER TP1 fills (A8). Omitted
   * means the original stop is kept and `trailing` never appears as a reason.
   */
  trailingAtrMultiple?: Decimal;
}

/* ------------------------------------------------------------------ *
 * Output types
 * ------------------------------------------------------------------ */

export type ExitReason = 'target1' | 'target2' | 'stop' | 'trailing' | 'eod';

/** RWA (anything with an underlying exchange calendar) or crypto. */
export type ReplayCategory = 'RWA' | 'crypto';

/** Regular trading hours, or outside them. Sourced from `MarketInfo`. */
export type ReplaySession = 'RTH' | 'off_hours';

export interface ReplayTrade {
  marketId: number;
  symbol: string;
  direction: 'long' | 'short';
  /** Fill bar's open, in ms; the exact intrabar tick time is unknowable (A2). */
  entryTimeMs: number;
  /** Last exit leg's bar open, in ms. */
  exitTimeMs: number;
  entryPrice: string;
  /** Quantity-weighted average of the exit legs. */
  exitPrice: string;
  quantity: string;
  /** The ORIGINAL stop. A trailing ratchet is never written into this field. */
  stopPrice: string;
  grossPnl: string;
  /** Maker/taker fees on both legs. Always >= 0. */
  fees: string;
  /** |funding| over the hold. Always >= 0: it is charged, never credited (A11). */
  funding: string;
  /** Modelled slippage on crossing legs only (A10). Always >= 0. */
  slippage: string;
  /** Exactly `gross - fees - slippage - funding`. */
  netPnl: string;
  /** netPnl / (risk per unit x quantity); undefined when risk is zero. */
  rMultiple: string | undefined;
  exitReason: ExitReason;
  /** Intent: the strategy always places an ALO limit, so this is always true. */
  makerEntry: boolean;
  /** Outcome: false means the entry took liquidity and paid the taker fee (A5). */
  filledAsMaker: boolean;
  /** Worst adverse excursion on the first bar after the fill, in R (>= 0). */
  adverseSelectionR: string | undefined;
  /** RWA or crypto, from `MarketInfo.category`. */
  category: ReplayCategory;
  /** RTH or off-hours, from `MarketInfo.isOutsideRth`. */
  session: ReplaySession;
}

/** Aggregates over any subset of trades. Money fields are decimal strings. */
export interface GroupMetrics {
  tradeCount: number;
  winCount: number;
  lossCount: number;
  /** Trades whose net PnL is exactly zero. */
  scratchCount: number;
  grossPnl: string;
  netPnl: string;
  fees: string;
  funding: string;
  slippage: string;
  /** wins / tradeCount, as a fraction in [0, 1]. */
  winRate: string;
  /**
   * sum(winning net) / |sum(losing net)|. `undefined` when there were no losing
   * trades: the ratio is unbounded, and `Infinity` is not a number a report can
   * print or a test can scan.
   */
  profitFactor?: string;
  averageNetPnl: string;
  /** Mean of the defined R multiples; `undefined` when none are defined. */
  averageRMultiple?: string;
  /** Realised maker fills / tradeCount. */
  makerFillRate: string;
  averageHoldingMs: string;
  /** Mean adverse excursion in R; `undefined` when none could be measured. */
  averageAdverseSelectionR?: string;
  /**
   * Literal '0'. Points is a non-cash observation and is never revenue, so no
   * Points value can enter any PnL figure in this report (A15).
   */
  pointsContribution: '0';
}

/** Counters for why setups did or did not become trades. */
export interface ReplaySignalCounts {
  /** Trigger bars evaluated. */
  barsEvaluated: number;
  /** Signals produced by the strategy. */
  signalsFired: number;
  /** Signals refused because expectedMove did not cover the modelled cost. */
  rejectedByCost: number;
  /** Signals refused because sizing produced nothing. */
  rejectedBySizing: number;
  /** Entries that filled. */
  entriesFilled: number;
  /** Fills that were passive (maker). */
  makerFills: number;
  /** Fills that took liquidity (taker). */
  takerFills: number;
  /** Limit orders that never filled before their TTL. */
  entriesExpired: number;
  /** Orders still resting when the data ended. */
  entriesOpenAtEndOfData: number;
  /** Evaluations that threw; counted rather than propagated. */
  evaluationErrors: number;
  /**
   * Stop exits where the SAME bar also contained a take-profit level.
   *
   * The engine resolves such a bar to the stop (A7), which is the correct conservative
   * choice — but it can only be trusted as a verdict on the strategy if the count is
   * small. A large count means the result is dominated by intrabar ambiguity rather than
   * by the signal, and a coarser trigger timeframe or a wider stop is needed before the
   * backtest can say anything useful.
   */
  ambiguousBarStops: number;
}

export interface ReplayMetrics extends GroupMetrics {
  maxDrawdown: string;
  maxDrawdownPct: string;
  finalEquity: string;
  byCategory: Record<ReplayCategory, GroupMetrics>;
  bySession: Record<ReplaySession, GroupMetrics>;
  signals: ReplaySignalCounts;
}

export interface ReplayResult {
  trades: ReplayTrade[];
  metrics: ReplayMetrics;
  equityCurve: { atMs: number; equity: string }[];
}

/* ------------------------------------------------------------------ *
 * Small numeric helpers
 * ------------------------------------------------------------------ */

/** Division that answers 0 instead of NaN/Infinity when the divisor is zero. */
function divOrZero(numerator: DecimalLike, denominator: DecimalLike): Decimal {
  const divisor = dec(denominator);
  return divisor.isZero() ? ZERO : dec(numerator).div(divisor);
}

/** Percentage of a base, answering 0 when the base is non-positive. */
function pctOf(value: DecimalLike, base: DecimalLike): Decimal {
  const b = dec(base);
  if (!b.greaterThan(ZERO)) return ZERO;
  return dec(value).div(b).times(100);
}

function microsToMs(micros: number): number {
  return Math.floor(micros / MICROS_PER_MS);
}

function byOpenTime(a: { openTime: number }, b: { openTime: number }): number {
  return a.openTime - b.openTime;
}

/**
 * Bar interval inference: the smallest positive gap between consecutive open
 * times, or 0 when there is only one bar.
 *
 * The SMALLEST gap is used, not the average. A missing bar would stretch an
 * averaged interval and let the most recent bar be declared closed too early —
 * which is exactly the lookahead A1 exists to prevent.
 */
function inferIntervalMicros(bars: readonly Candle[]): number {
  let smallest = Number.POSITIVE_INFINITY;
  for (let i = 1; i < bars.length; i += 1) {
    const gap = bars[i]!.openTime - bars[i - 1]!.openTime;
    if (gap > 0 && gap < smallest) smallest = gap;
  }
  return Number.isFinite(smallest) ? smallest : 0;
}

/**
 * Deterministic [0, 1) hash of a key, used for the maker-fill lottery (A4).
 *
 * FNV-1a, 32-bit, computed with `Math.imul` so the result is identical on every
 * engine. The key is a composed string of integer/hashable parts; a float would
 * be a portability hazard, and `Math.random()` would make the replay
 * irreproducible.
 */
export function deterministicUnitHash(key: string): Decimal {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return new Decimal(hash).div(HASH_SPACE);
}

/**
 * Peak-to-trough drawdown of an equity path.
 *
 * The first value seeds the peak, so a path that only loses money reports the
 * loss from the starting equity rather than 0. `pct` is measured against the
 * running peak — the only definition that makes two paths of different sizes
 * comparable. A non-positive peak reports 0% instead of dividing.
 */
export function maxDrawdownOf(equity: readonly Decimal[]): { absolute: Decimal; pct: Decimal } {
  if (equity.length === 0) return { absolute: ZERO, pct: ZERO };
  let peak = equity[0]!;
  let worst = ZERO;
  let worstPct = ZERO;
  for (const value of equity) {
    if (value.greaterThan(peak)) peak = value;
    const drop = peak.minus(value);
    if (drop.greaterThan(worst)) {
      worst = drop;
      worstPct = pctOf(drop, peak);
    }
  }
  return { absolute: worst, pct: worstPct };
}

/* ------------------------------------------------------------------ *
 * Metrics
 * ------------------------------------------------------------------ */

function emptyGroup(): GroupMetrics {
  return {
    tradeCount: 0,
    winCount: 0,
    lossCount: 0,
    scratchCount: 0,
    grossPnl: '0',
    netPnl: '0',
    fees: '0',
    funding: '0',
    slippage: '0',
    winRate: '0',
    averageNetPnl: '0',
    makerFillRate: '0',
    averageHoldingMs: '0',
    pointsContribution: '0',
  };
}

/**
 * Aggregate a set of trades.
 *
 * Money is summed with Decimal and rendered via `toFixedString`, so the report is
 * exact rather than a float approximation. Every ratio guards its denominator: a
 * report that prints `NaN` for an empty group is worse than useless, because
 * `NaN` silently defeats every comparison downstream.
 */
function groupMetrics(trades: readonly ReplayTrade[]): GroupMetrics {
  if (trades.length === 0) return emptyGroup();

  let gross = ZERO;
  let net = ZERO;
  let fees = ZERO;
  let funding = ZERO;
  let slippage = ZERO;
  let wins = 0;
  let losses = 0;
  let scratches = 0;
  let grossProfit = ZERO;
  let grossLoss = ZERO;
  let makerFills = 0;
  let holdingMs = 0;
  let rSum = ZERO;
  let rCount = 0;
  let adverseSum = ZERO;
  let adverseCount = 0;

  for (const trade of trades) {
    const netPnl = dec(trade.netPnl);
    gross = gross.plus(dec(trade.grossPnl));
    net = net.plus(netPnl);
    fees = fees.plus(dec(trade.fees));
    funding = funding.plus(dec(trade.funding));
    slippage = slippage.plus(dec(trade.slippage));
    if (netPnl.greaterThan(ZERO)) {
      wins += 1;
      grossProfit = grossProfit.plus(netPnl);
    } else if (netPnl.lessThan(ZERO)) {
      losses += 1;
      grossLoss = grossLoss.plus(netPnl.abs());
    } else {
      scratches += 1;
    }
    if (trade.filledAsMaker) makerFills += 1;
    holdingMs += trade.exitTimeMs - trade.entryTimeMs;
    if (trade.rMultiple !== undefined) {
      rSum = rSum.plus(dec(trade.rMultiple));
      rCount += 1;
    }
    if (trade.adverseSelectionR !== undefined) {
      adverseSum = adverseSum.plus(dec(trade.adverseSelectionR));
      adverseCount += 1;
    }
  }

  const count = new Decimal(trades.length);
  return {
    tradeCount: trades.length,
    winCount: wins,
    lossCount: losses,
    scratchCount: scratches,
    grossPnl: toFixedString(gross),
    netPnl: toFixedString(net),
    fees: toFixedString(fees),
    funding: toFixedString(funding),
    slippage: toFixedString(slippage),
    winRate: toFixedString(divOrZero(wins, count)),
    // No losing trades means the ratio is unbounded. Saying so with `undefined`
    // beats printing Infinity, which is not a number a report can carry.
    ...(grossLoss.greaterThan(ZERO)
      ? { profitFactor: toFixedString(grossProfit.div(grossLoss)) }
      : {}),
    averageNetPnl: toFixedString(net.div(count)),
    ...(rCount > 0 ? { averageRMultiple: toFixedString(rSum.div(rCount)) } : {}),
    makerFillRate: toFixedString(divOrZero(makerFills, count)),
    averageHoldingMs: toFixedString(new Decimal(holdingMs).div(count).toDecimalPlaces(0)),
    ...(adverseCount > 0
      ? { averageAdverseSelectionR: toFixedString(adverseSum.div(adverseCount)) }
      : {}),
    pointsContribution: '0',
  };
}

/* ------------------------------------------------------------------ *
 * Replay state
 * ------------------------------------------------------------------ */

interface PendingEntry {
  readonly direction: 'long' | 'short';
  readonly limit: Decimal;
  readonly stopPrice: Decimal;
  readonly target1: Decimal;
  readonly target2: Decimal | undefined;
  readonly quantity: Decimal;
  /** Structure ATR at the signal bar, used by the optional trailing stop. */
  readonly atr: Decimal;
  readonly expiresAtIndex: number;
}

interface ExitLeg {
  readonly quantity: Decimal;
  readonly price: Decimal;
  readonly reason: ExitReason;
  readonly atMs: number;
}

interface OpenPosition {
  readonly direction: 'long' | 'short';
  readonly entryPrice: Decimal;
  readonly quantity: Decimal;
  readonly originalStop: Decimal;
  currentStop: Decimal;
  readonly target1: Decimal;
  readonly target2: Decimal | undefined;
  readonly atr: Decimal;
  readonly riskPerUnit: Decimal;
  readonly entryTimeMs: number;
  readonly filledAsMaker: boolean;
  readonly legs: ExitLeg[];
  remaining: Decimal;
  tp1Taken: boolean;
  /** Best favourable extreme since the fill, for the trailing ratchet. */
  bestExtreme: Decimal;
  adverseSelectionR: string | undefined;
  adverseRecorded: boolean;
}

interface MarketOutcome {
  trades: ReplayTrade[];
  equityAfter: Decimal[];
  finalEquity: Decimal;
  firstAtMs: number | undefined;
  counters: ReplaySignalCounts;
}

function emptyCounters(): ReplaySignalCounts {
  return {
    barsEvaluated: 0,
    signalsFired: 0,
    rejectedByCost: 0,
    rejectedBySizing: 0,
    entriesFilled: 0,
    makerFills: 0,
    takerFills: 0,
    entriesExpired: 0,
    entriesOpenAtEndOfData: 0,
    evaluationErrors: 0,
    ambiguousBarStops: 0,
  };
}

/**
 * True when a candle's OHLC can be used at all.
 *
 * A malformed bar is dropped before the walk rather than raising inside it: the
 * replay must not crash on one bad row, and it must never let a non-finite price
 * reach a size. `strictly positive` for every OHLC, because decimal.js calls `+0`
 * positive and a zero price produces an infinite quantity.
 */
function isUsableBar(candle: Candle): boolean {
  for (const field of [candle.open, candle.high, candle.low, candle.close]) {
    let value: Decimal;
    try {
      value = dec(field);
    } catch {
      return false;
    }
    if (!value.isFinite() || !value.greaterThan(ZERO)) return false;
  }
  return Number.isFinite(candle.openTime);
}

/* ------------------------------------------------------------------ *
 * Sizing
 * ------------------------------------------------------------------ */

/**
 * Local position sizing, mirroring `RiskEngine.computeSizing` (A13).
 *
 * The floor to `stepSize` is the load-bearing line: it is the only rounding in
 * the path and it rounds DOWN, so a sizing mistake can only reduce risk. The
 * binding constraint is returned for diagnostics — a surprising size should be
 * attributable to a named limit rather than guessed at.
 */
function sizePosition(params: {
  equity: Decimal;
  entry: Decimal;
  stop: Decimal;
  market: MarketInfo;
  config: ReplayConfig;
}): { quantity: Decimal; binding: string } {
  const { equity, entry, stop, market, config } = params;
  if (!equity.greaterThan(ZERO) || !entry.greaterThan(ZERO)) {
    return { quantity: ZERO, binding: 'nonPositiveEquityOrEntry' };
  }
  const stopDistance = entry.minus(stop).abs();
  if (!stopDistance.greaterThan(ZERO)) return { quantity: ZERO, binding: 'zeroStopDistance' };

  const riskBudget = equity.times(config.riskBps).div(10_000);
  const candidates: { name: string; value: Decimal }[] = [
    { name: 'quantityByRisk', value: riskBudget.div(stopDistance) },
    { name: 'quantityByNotional', value: equity.times(config.maxNotionalPct).div(100).div(entry) },
    { name: 'leverageLimit', value: equity.times(config.maxLeverage).div(entry) },
  ];
  const binding = candidates.reduce(
    (min, cur) => (cur.value.lessThan(min.value) ? cur : min),
    candidates[0]!,
  );
  return { quantity: floorToStep(binding.value, market.stepSize), binding: binding.name };
}

/* ------------------------------------------------------------------ *
 * Position lifecycle
 * ------------------------------------------------------------------ */

/**
 * Fill the resting entry, if this bar touches it.
 *
 * Returns `undefined` both when the bar misses the limit and when the maker
 * lottery says the order was not filled — the caller keeps the order resting in
 * either case, so the distinction is invisible (and irrelevant) to it (A4/A5).
 */
function tryFill(
  pending: PendingEntry,
  bar: Candle,
  barIndex: number,
  market: MarketInfo,
  makerFillProbability: Decimal,
): { filledAsMaker: boolean } | undefined {
  const limit = pending.limit;
  const open = dec(bar.open);
  const high = dec(bar.high);
  const low = dec(bar.low);
  const isLong = pending.direction === 'long';

  const crossing = isLong ? open.lessThan(limit) : open.greaterThan(limit);
  const touched = isLong ? low.lessThanOrEqualTo(limit) : high.greaterThanOrEqualTo(limit);
  if (!touched) return undefined;
  if (crossing) return { filledAsMaker: false };

  if (!makerFillProbability.greaterThan(ZERO)) return undefined;
  if (makerFillProbability.greaterThanOrEqualTo(ONE)) return { filledAsMaker: true };

  // Deterministic lottery: the same bar and price always resolve the same way, so
  // two replays of the same scenario can be diffed (A4).
  const key = `${market.marketId}|${barIndex}|${toFixedString(limit)}`;
  return deterministicUnitHash(key).lessThan(makerFillProbability)
    ? { filledAsMaker: true }
    : undefined;
}

function openPosition(
  pending: PendingEntry,
  fill: { filledAsMaker: boolean },
  bar: Candle,
): OpenPosition {
  const extreme = pending.direction === 'long' ? dec(bar.high) : dec(bar.low);
  return {
    direction: pending.direction,
    entryPrice: pending.limit,
    quantity: pending.quantity,
    originalStop: pending.stopPrice,
    currentStop: pending.stopPrice,
    target1: pending.target1,
    target2: pending.target2,
    atr: pending.atr,
    riskPerUnit: pending.limit.minus(pending.stopPrice).abs(),
    entryTimeMs: microsToMs(bar.openTime),
    filledAsMaker: fill.filledAsMaker,
    legs: [],
    remaining: pending.quantity,
    tp1Taken: false,
    bestExtreme: extreme,
    adverseSelectionR: undefined,
    adverseRecorded: false,
  };
}

/** Quantity to close at TP1: the configured percentage, floored to the step grid. */
function tp1Quantity(position: OpenPosition, tp1ClosePct: Decimal, market: MarketInfo): Decimal {
  const raw = position.quantity.times(tp1ClosePct).div(100);
  const floored = floorToStep(raw, market.stepSize);
  if (floored.greaterThan(position.remaining)) return position.remaining;
  return floored.greaterThan(ZERO) ? floored : ZERO;
}

/**
 * Advance an open position across one bar.
 *
 * The order of the decisions inside the bar is the whole point (A7): the stop is
 * tested FIRST, so a bar spanning both the stop and a target books a loss. When
 * both targets are inside one bar and no stop is, TP1 fills before the runner at
 * TP2 — price cannot reach TP2 without passing TP1, so that is the only
 * physically possible ordering.
 */
function stepPosition(
  position: OpenPosition,
  bar: Candle,
  config: ReplayConfig,
  market: MarketInfo,
  counters: ReplaySignalCounts,
): void {
  const isLong = position.direction === 'long';
  const high = dec(bar.high);
  const low = dec(bar.low);
  const atMs = microsToMs(bar.openTime);

  // A6: the adverse excursion is measured on the first bar the position was
  // actually exposed to. It is a magnitude, never a bonus.
  if (!position.adverseRecorded && position.riskPerUnit.greaterThan(ZERO)) {
    const excursion = isLong ? position.entryPrice.minus(low) : high.minus(position.entryPrice);
    position.adverseSelectionR = toFixedString(
      excursion.greaterThan(ZERO) ? excursion.div(position.riskPerUnit) : ZERO,
    );
    position.adverseRecorded = true;
  }

  const stopHit = isLong
    ? low.lessThanOrEqualTo(position.currentStop)
    : high.greaterThanOrEqualTo(position.currentStop);
  const tp1Hit = isLong
    ? high.greaterThanOrEqualTo(position.target1)
    : low.lessThanOrEqualTo(position.target1);
  const tp2 = position.target2;
  const tp2Hit = tp2 !== undefined && (isLong ? high.greaterThanOrEqualTo(tp2) : low.lessThanOrEqualTo(tp2));

  if (stopHit) {
    // Pessimistic resolution of an ambiguous bar (A7). A stop that has been
    // ratcheted away from the original is reported as a trailing exit.
    if (tp1Hit || tp2Hit) counters.ambiguousBarStops += 1;
    const isTrailing = !position.currentStop.eq(position.originalStop);
    position.legs.push({
      quantity: position.remaining,
      price: position.currentStop,
      reason: isTrailing ? 'trailing' : 'stop',
      atMs,
    });
    position.remaining = ZERO;
    return;
  }

  if (tp2Hit && tp2 !== undefined) {
    if (!position.tp1Taken) {
      const partial = tp1Quantity(position, config.strategy.tp1ClosePct, market);
      if (partial.greaterThan(ZERO)) {
        position.legs.push({ quantity: partial, price: position.target1, reason: 'target1', atMs });
        position.remaining = position.remaining.minus(partial);
      }
      position.tp1Taken = true;
    }
    position.legs.push({ quantity: position.remaining, price: tp2, reason: 'target2', atMs });
    position.remaining = ZERO;
    return;
  }

  if (tp1Hit && !position.tp1Taken) {
    const partial = tp1Quantity(position, config.strategy.tp1ClosePct, market);
    if (partial.greaterThanOrEqualTo(position.remaining)) {
      // The configured scale-out is the whole position: the trade finishes at TP1
      // and the runner never exists.
      position.legs.push({
        quantity: position.remaining,
        price: position.target1,
        reason: 'target1',
        atMs,
      });
      position.remaining = ZERO;
      return;
    }
    if (partial.greaterThan(ZERO)) {
      position.legs.push({ quantity: partial, price: position.target1, reason: 'target1', atMs });
      position.remaining = position.remaining.minus(partial);
    }
    position.tp1Taken = true;
  }

  // Ratchet the trailing stop only from the NEXT bar, so the new level can never
  // be used inside the bar that created it (A8).
  if (position.tp1Taken && config.trailingAtrMultiple !== undefined && position.atr.greaterThan(ZERO)) {
    position.bestExtreme = isLong
      ? Decimal.max(position.bestExtreme, high)
      : Decimal.min(position.bestExtreme, low);
    const distance = position.atr.times(config.trailingAtrMultiple);
    const trail = isLong
      ? position.bestExtreme.minus(distance)
      : position.bestExtreme.plus(distance);
    position.currentStop = isLong
      ? Decimal.max(position.currentStop, trail)
      : Decimal.min(position.currentStop, trail);
  }
}

/**
 * Turn a closed position into a trade record.
 *
 * Fees, funding and slippage are computed here, once, from the legs that actually
 * filled. The identity `net = gross - fees - slippage - funding` holds by
 * construction: those four components are the only inputs.
 */
function finaliseTrade(
  position: OpenPosition,
  market: MarketInfo,
  config: ReplayConfig,
): { trade: ReplayTrade; netPnl: Decimal } {
  const directionSign = position.direction === 'long' ? ONE : new Decimal(-1);
  let grossPnl = ZERO;
  let fees = ZERO;
  let slippage = ZERO;
  let exitNotional = ZERO;
  let exitAtMs = position.entryTimeMs;

  for (const leg of position.legs) {
    const notional = leg.quantity.times(leg.price);
    grossPnl = grossPnl.plus(
      leg.price.minus(position.entryPrice).times(directionSign).times(leg.quantity),
    );
    // The exit is always a taker: triggered stops and risk exits cross the book,
    // so costing them as makers would understate cost exactly when it matters (A9).
    fees = fees.plus(notional.times(config.cost.takerFeeBps).div(10_000));
    slippage = slippage.plus(notional.times(config.cost.assumedSlippageBps).div(10_000));
    exitNotional = exitNotional.plus(notional);
    exitAtMs = leg.atMs;
  }

  const entryNotional = position.entryPrice.times(position.quantity);
  const entryFeeBps = position.filledAsMaker ? config.cost.makerFeeBps : config.cost.takerFeeBps;
  fees = fees.plus(entryNotional.times(entryFeeBps).div(10_000));
  // Slippage is charged only on legs that crossed. A maker entry did not cross,
  // so it pays none — but it also may not have filled at all, which was modelled
  // before this point (A10).
  if (!position.filledAsMaker) {
    slippage = slippage.plus(entryNotional.times(config.cost.assumedSlippageBps).div(10_000));
  }

  // Funding is CHARGED: the absolute rate over the hold, so a favourable sign
  // cannot inflate the result. The full entry notional is charged for the whole
  // hold even after a partial exit, which over-charges (A11).
  const hoursHeld = new Decimal(exitAtMs - position.entryTimeMs).div(MS_PER_HOUR);
  const funding = config.fundingRatePerHour
    ? entryNotional.times(config.fundingRatePerHour.abs()).times(hoursHeld)
    : ZERO;

  const netPnl = grossPnl.minus(fees).minus(slippage).minus(funding);
  const riskAmount = position.riskPerUnit.times(position.quantity);
  const rMultiple = riskAmount.greaterThan(ZERO) ? netPnl.div(riskAmount) : undefined;
  const lastLeg = position.legs[position.legs.length - 1];

  return {
    trade: {
      marketId: market.marketId,
      symbol: market.marketDisplayName,
      direction: position.direction,
      entryTimeMs: position.entryTimeMs,
      exitTimeMs: exitAtMs,
      entryPrice: toFixedString(position.entryPrice),
      exitPrice: toFixedString(divOrZero(exitNotional, position.quantity)),
      quantity: toFixedString(position.quantity),
      stopPrice: toFixedString(position.originalStop),
      grossPnl: toFixedString(grossPnl),
      fees: toFixedString(fees),
      funding: toFixedString(funding),
      slippage: toFixedString(slippage),
      netPnl: toFixedString(netPnl),
      rMultiple: rMultiple === undefined ? undefined : toFixedString(rMultiple),
      exitReason: lastLeg ? lastLeg.reason : 'eod',
      makerEntry: true,
      filledAsMaker: position.filledAsMaker,
      adverseSelectionR: position.adverseSelectionR,
      category: isRwaCategory(market.category) ? 'RWA' : 'crypto',
      session: market.isOutsideRth ? 'off_hours' : 'RTH',
    },
    netPnl,
  };
}

/* ------------------------------------------------------------------ *
 * Per-market walk
 * ------------------------------------------------------------------ */

/**
 * Replay one market.
 *
 * A single forward pass over the trigger bars advances three states — flat,
 * pending entry, open position — off one clock. Nothing reads a bar that has not
 * been reached yet (A1, A2, A6).
 */
function replayOneMarket(
  input: ReplayMarketInput,
  config: ReplayConfig,
  startEquity: Decimal,
): MarketOutcome {
  const counters = emptyCounters();
  const trades: ReplayTrade[] = [];
  const equityAfter: Decimal[] = [];
  const market = input.market;

  const bars = [...closedCandles(input.triggerCandles)].filter(isUsableBar).sort(byOpenTime);
  const trendBars = [...closedCandles(input.trendCandles)].sort(byOpenTime);
  const structureBars = [...closedCandles(input.structureCandles)].sort(byOpenTime);

  const firstAtMs = bars.length > 0 ? microsToMs(bars[0]!.openTime) : undefined;
  const triggerInterval = inferIntervalMicros(bars);
  const trendInterval = inferIntervalMicros(trendBars);
  const structureInterval = inferIntervalMicros(structureBars);

  // A market with an unusable grid cannot produce a representable order. Fail
  // closed for that market rather than throwing away the whole replay.
  const gridOk = dec(market.tickSize).greaterThan(ZERO) && dec(market.stepSize).greaterThan(ZERO);
  if (!gridOk || bars.length === 0) {
    return { trades, equityAfter, finalEquity: startEquity, firstAtMs, counters };
  }

  const minNotional = dec(market.minOrderNotional ?? '0');
  const makerFillProbability = config.makerFillProbability ?? ONE;
  /** Pessimistic hold window for the cost gate's funding leg (A12). */
  const assumedHoldHours = new Decimal(Math.max(1, config.entryTtlBars))
    .times(triggerInterval)
    .div(MICROS_PER_MS)
    .div(MS_PER_HOUR);
  let equity = startEquity;
  let pending: PendingEntry | undefined;
  let position: OpenPosition | undefined;

  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i]!;

    /* ---- 1. manage an open position ------------------------------- */
    if (position) {
      stepPosition(position, bar, config, market, counters);
      if (!position.remaining.greaterThan(ZERO)) {
        const { trade, netPnl } = finaliseTrade(position, market, config);
        trades.push(trade);
        equity = equity.plus(netPnl);
        equityAfter.push(equity);
        position = undefined;
      } else if (i === bars.length - 1) {
        // End of data with the position still open: mark it out at the last
        // close, the only price we can honestly claim to know.
        position.legs.push({
          quantity: position.remaining,
          price: dec(bar.close),
          reason: 'eod',
          atMs: microsToMs(bar.openTime),
        });
        position.remaining = ZERO;
        const { trade, netPnl } = finaliseTrade(position, market, config);
        trades.push(trade);
        equity = equity.plus(netPnl);
        equityAfter.push(equity);
        position = undefined;
      }
      continue;
    }

    /* ---- 2. work a resting entry ---------------------------------- */
    if (pending) {
      if (i > pending.expiresAtIndex) {
        counters.entriesExpired += 1;
        pending = undefined;
        // Fall through: this bar's close is still a legitimate new decision.
      } else {
        const fill = tryFill(pending, bar, i, market, makerFillProbability);
        if (fill) {
          position = openPosition(pending, fill, bar);
          counters.entriesFilled += 1;
          if (fill.filledAsMaker) counters.makerFills += 1;
          else counters.takerFills += 1;
          pending = undefined;
          // Exits begin on the NEXT bar: the fill bar's wicks predate the
          // position (A6).
        }
        continue;
      }
    }

    /* ---- 3. look for a new signal --------------------------------- */
    counters.barsEvaluated += 1;
    const decisionMicros = bar.openTime + triggerInterval;
    const trendWindow = trendBars.filter((c) => c.openTime + trendInterval <= decisionMicros);
    const structureWindow = structureBars.filter(
      (c) => c.openTime + structureInterval <= decisionMicros,
    );

    let signal: StrategySignal | undefined;
    try {
      signal = evaluateStrategy({
        market,
        trendCandles: trendWindow,
        structureCandles: structureWindow,
        // The trigger window ends AT the signal bar and never beyond it (A1).
        triggerCandles: bars.slice(0, i + 1),
        config: config.strategy,
      });
    } catch {
      counters.evaluationErrors += 1;
      continue;
    }
    if (!signal || signal.direction === 'flat' || !signal.proposal) continue;
    const proposal = signal.proposal;
    counters.signalsFired += 1;

    const entryPrice = proposal.entryPrice;
    const sizing = sizePosition({
      equity,
      entry: entryPrice,
      stop: proposal.stopPrice,
      market,
      config,
    });
    if (!sizing.quantity.greaterThan(ZERO)) {
      counters.rejectedBySizing += 1;
      continue;
    }
    const notional = entryPrice.times(sizing.quantity);
    if (minNotional.greaterThan(ZERO) && notional.lessThan(minNotional)) {
      counters.rejectedBySizing += 1;
      continue;
    }

    /* ---- 4. cost gate (A12) ---------------------------------------- */
    // The entry is an ALO limit: post-only, and possibly never filled. That is
    // exactly the assumption the cost model's maker branch documents.
    const expectedMove = expectedMoveToTarget({
      entryPrice,
      firstTarget: proposal.target1,
      projectableFraction: config.projectableFraction,
      quantity: sizing.quantity,
    });
    let fundingHorizon:
      | {
          ratePerInterval: Decimal;
          hoursToNextFunding: Decimal;
          expectedHoldHours: Decimal;
          intervalHours: Decimal;
        }
      | undefined;
    if (config.fundingRatePerHour) {
      // The next funding instant is unknown offline, so the pessimistic reading is
      // that one is due IMMEDIATELY (0 hours away) and every hour after that, over
      // the window the order and its first bars could span. `countFundingPayments`
      // therefore always returns at least one payment for a positive window,
      // instead of returning zero whenever the window is shorter than the interval
      // — which would let a trade through that the first funding tick would sink.
      const payments = countFundingPayments(ZERO, assumedHoldHours, ONE);
      fundingHorizon = {
        // Folded into a single equivalent payment so the cost model charges
        // `|rate| * payments` over a one-hour window.
        ratePerInterval: config.fundingRatePerHour.times(payments),
        hoursToNextFunding: ONE,
        expectedHoldHours: ONE,
        intervalHours: ONE,
      };
    }
    const cost = estimateCost({
      notional,
      entryIsMaker: true,
      halfSpreadBps: config.halfSpreadBps ?? ZERO,
      expectedMove,
      ...(fundingHorizon ? { funding: fundingHorizon } : {}),
      config: config.cost,
    });
    // STRICTLY greater than zero. `CostEstimate.netEdge` is a decimal STRING, so
    // it is re-parsed here rather than trusted. `viable` on the estimate is not
    // used: it is built from `isPositive()`, which decimal.js reports as TRUE for
    // `+0`, and a zero edge is not an edge — that trap is why this reads
    // `greaterThan(0)` on its own parse (A12).
    if (!dec(cost.netEdge).greaterThan(ZERO)) {
      counters.rejectedByCost += 1;
      continue;
    }

    pending = {
      direction: proposal.direction,
      limit: entryPrice,
      stopPrice: proposal.stopPrice,
      target1: proposal.target1,
      target2: proposal.target2,
      quantity: sizing.quantity,
      atr: dec(signal.diagnostics.atr ?? '0'),
      // The order may fill on the next `entryTtlBars` bars, and no later.
      expiresAtIndex: i + config.entryTtlBars,
    };
  }

  if (pending) counters.entriesOpenAtEndOfData += 1;

  return { trades, equityAfter, finalEquity: equity, firstAtMs, counters };
}

/* ------------------------------------------------------------------ *
 * Public entry point
 * ------------------------------------------------------------------ */

/**
 * Replay every supplied market and aggregate the result.
 *
 * Markets are walked in the order given and share one equity ledger (A14), which
 * makes sizing respond to prior results: a compounding replay rather than a
 * fixed-stake one. Trades are reported in the order they closed.
 */
export function replayMarkets(input: {
  markets: readonly ReplayMarketInput[];
  config: ReplayConfig;
}): ReplayResult {
  const config = input.config;
  if (!Number.isInteger(config.entryTtlBars) || config.entryTtlBars < 1) {
    throw new Error(`entryTtlBars must be an integer >= 1, got ${String(config.entryTtlBars)}`);
  }

  const trades: ReplayTrade[] = [];
  const equityCurve: { atMs: number; equity: string }[] = [];
  const totals = emptyCounters();

  let equity = dec(config.initialEquity);
  let seededCurve = false;

  for (const marketInput of input.markets) {
    const outcome = replayOneMarket(marketInput, config, equity);
    if (!seededCurve && outcome.firstAtMs !== undefined) {
      equityCurve.push({ atMs: outcome.firstAtMs, equity: toFixedString(equity) });
      seededCurve = true;
    }
    for (let i = 0; i < outcome.trades.length; i += 1) {
      const trade = outcome.trades[i]!;
      trades.push(trade);
      equityCurve.push({ atMs: trade.exitTimeMs, equity: toFixedString(outcome.equityAfter[i]!) });
    }
    equity = outcome.finalEquity;

    totals.barsEvaluated += outcome.counters.barsEvaluated;
    totals.signalsFired += outcome.counters.signalsFired;
    totals.rejectedByCost += outcome.counters.rejectedByCost;
    totals.rejectedBySizing += outcome.counters.rejectedBySizing;
    totals.entriesFilled += outcome.counters.entriesFilled;
    totals.makerFills += outcome.counters.makerFills;
    totals.takerFills += outcome.counters.takerFills;
    totals.entriesExpired += outcome.counters.entriesExpired;
    totals.entriesOpenAtEndOfData += outcome.counters.entriesOpenAtEndOfData;
    totals.evaluationErrors += outcome.counters.evaluationErrors;
    totals.ambiguousBarStops += outcome.counters.ambiguousBarStops;
  }

  return {
    trades,
    metrics: computeMetrics(
      trades,
      equityCurve.map((point) => dec(point.equity)),
      equity,
      totals,
    ),
    equityCurve,
  };
}

/** Assemble the full metrics object from the settled trades. */
function computeMetrics(
  trades: readonly ReplayTrade[],
  equityValues: readonly Decimal[],
  finalEquity: Decimal,
  counters: ReplaySignalCounts,
): ReplayMetrics {
  const drawdown = maxDrawdownOf(equityValues);

  return {
    ...groupMetrics(trades),
    maxDrawdown: toFixedString(drawdown.absolute),
    maxDrawdownPct: toFixedString(drawdown.pct),
    finalEquity: toFixedString(finalEquity),
    byCategory: {
      RWA: groupMetrics(trades.filter((t) => t.category === 'RWA')),
      crypto: groupMetrics(trades.filter((t) => t.category === 'crypto')),
    },
    bySession: {
      RTH: groupMetrics(trades.filter((t) => t.session === 'RTH')),
      off_hours: groupMetrics(trades.filter((t) => t.session === 'off_hours')),
    },
    signals: counters,
  };
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

const USAGE = `Arcus deterministic replay / backtester

Usage:
  tsx tools/replay.ts --help
  tsx tools/replay.ts --file <scenario.json> [--trades]

The scenario file is JSON:
{
  "config": {
    "strategy": { "emaFastPeriod": 3, "emaMidPeriod": 5, "emaSlowPeriod": 8,
                  "atrPeriod": 5, "minHistoryBars": 12, "stopAtrBuffer": "1",
                  "maxExtensionAtr": "10", "maxChaseAtr": "3",
                  "pullbackZoneAtr": "1", "tp1RMultiple": "1", "tp1ClosePct": "50",
                  "tp2RMultiple": "2", "structureLookback": 30,
                  "swingLeftBars": 2, "swingRightBars": 2 },
    "cost": { "makerFeeBps": "2", "takerFeeBps": "5",
              "assumedSlippageBps": "1", "safetyBufferBps": "0" },
    "initialEquity": "10000", "riskBps": "60", "maxNotionalPct": "30",
    "maxLeverage": "2", "entryTtlBars": 2, "projectableFraction": "0.5",
    "fundingRatePerHour": "0.0000125", "makerFillProbability": "1"
  },
  "markets": [
    { "market": { "marketId": 1, "marketDisplayName": "SYN-USD", "tickSize": "0.01",
                  "stepSize": "0.01", "category": "CRYPTO", "isOutsideRth": false },
      "trendCandles": [ { "openTime": 1700000000000000, "open": "100", "high": "101",
                          "low": "99", "close": "100.5", "volume": "10", "isFinal": true } ],
      "structureCandles": [], "triggerCandles": [] }
  ]
}

Every price/size in the scenario is a decimal string. The replay is offline and
deterministic: no network, no clock, no Math.random().
`;

function parseMarket(raw: Record<string, unknown>): MarketInfo {
  const base: Record<string, unknown> = {
    status: 'ONLINE',
    baseAsset: 'BASE',
    quoteAsset: 'USD',
    tickTiers: [],
    minOrderNotional: '0',
    minOrderSize: '0',
    maxOrderSize: '1000000',
    isOutsideRth: false,
    type: 'PERPETUAL',
    category: 'CRYPTO',
    ...raw,
  };
  return base as unknown as MarketInfo;
}

function parseCandles(raw: unknown, field: string): Candle[] {
  if (!Array.isArray(raw)) throw new Error(`${field} must be an array`);
  return (raw as Record<string, unknown>[]).map((bar) => ({
    marketDisplayName: String(bar.marketDisplayName ?? 'SYN'),
    marketId: Number(bar.marketId ?? 0),
    timeframe: String(bar.timeframe ?? '15m'),
    openTime: Number(bar.openTime),
    open: String(bar.open),
    high: String(bar.high),
    low: String(bar.low),
    close: String(bar.close),
    volume: String(bar.volume ?? '0'),
    takerBuyVolume: String(bar.takerBuyVolume ?? '0'),
    notionalVolume: String(bar.notionalVolume ?? '0'),
    takerBuyNotionalVolume: String(bar.takerBuyNotionalVolume ?? '0'),
    tradeCount: Number(bar.tradeCount ?? 0),
    isFinal: bar.isFinal !== false,
  })) as Candle[];
}

/** Build a `ReplayConfig` from a scenario's JSON, with documented defaults. */
function parseConfig(raw: Record<string, unknown>): ReplayConfig {
  const strategyRaw = (raw.strategy ?? {}) as Record<string, unknown>;
  const costRaw = (raw.cost ?? {}) as Record<string, unknown>;
  const numberField = (source: Record<string, unknown>, key: string, fallback: number): number => {
    const value = source[key];
    return value === undefined ? fallback : Number(value);
  };
  const decimalField = (source: Record<string, unknown>, key: string, fallback: string): Decimal =>
    dec(String(source[key] ?? fallback));

  return {
    strategy: {
      emaFastPeriod: numberField(strategyRaw, 'emaFastPeriod', 9),
      emaMidPeriod: numberField(strategyRaw, 'emaMidPeriod', 21),
      emaSlowPeriod: numberField(strategyRaw, 'emaSlowPeriod', 50),
      atrPeriod: numberField(strategyRaw, 'atrPeriod', 14),
      minHistoryBars: numberField(strategyRaw, 'minHistoryBars', 60),
      stopAtrBuffer: decimalField(strategyRaw, 'stopAtrBuffer', '0.5'),
      maxExtensionAtr: decimalField(strategyRaw, 'maxExtensionAtr', '3'),
      maxChaseAtr: decimalField(strategyRaw, 'maxChaseAtr', '0.5'),
      pullbackZoneAtr: decimalField(strategyRaw, 'pullbackZoneAtr', '0.5'),
      tp1RMultiple: decimalField(strategyRaw, 'tp1RMultiple', '1'),
      tp1ClosePct: decimalField(strategyRaw, 'tp1ClosePct', '50'),
      tp2RMultiple: decimalField(strategyRaw, 'tp2RMultiple', '2'),
      structureLookback: numberField(strategyRaw, 'structureLookback', 120),
      swingLeftBars: numberField(strategyRaw, 'swingLeftBars', 2),
      swingRightBars: numberField(strategyRaw, 'swingRightBars', 2),
    },
    cost: {
      makerFeeBps: decimalField(costRaw, 'makerFeeBps', '2'),
      takerFeeBps: decimalField(costRaw, 'takerFeeBps', '5'),
      assumedSlippageBps: decimalField(costRaw, 'assumedSlippageBps', '1'),
      safetyBufferBps: decimalField(costRaw, 'safetyBufferBps', '0'),
    },
    initialEquity: decimalField(raw, 'initialEquity', '10000'),
    riskBps: decimalField(raw, 'riskBps', '25'),
    maxNotionalPct: decimalField(raw, 'maxNotionalPct', '30'),
    maxLeverage: decimalField(raw, 'maxLeverage', '2'),
    entryTtlBars: numberField(raw, 'entryTtlBars', 2),
    projectableFraction: decimalField(raw, 'projectableFraction', '0.5'),
    ...(raw.fundingRatePerHour === undefined
      ? {}
      : { fundingRatePerHour: dec(String(raw.fundingRatePerHour)) }),
    ...(raw.makerFillProbability === undefined
      ? {}
      : { makerFillProbability: dec(String(raw.makerFillProbability)) }),
    ...(raw.halfSpreadBps === undefined ? {} : { halfSpreadBps: dec(String(raw.halfSpreadBps)) }),
    ...(raw.trailingAtrMultiple === undefined
      ? {}
      : { trailingAtrMultiple: dec(String(raw.trailingAtrMultiple)) }),
  };
}

function main(argv: readonly string[]): void {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }
  const fileIndex = argv.indexOf('--file');
  if (fileIndex === -1 || argv[fileIndex + 1] === undefined) {
    process.stderr.write('replay: --file <scenario.json> is required\n\n');
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }
  const scenario = JSON.parse(readFileSync(argv[fileIndex + 1]!, 'utf8')) as Record<string, unknown>;
  const config = parseConfig((scenario.config ?? {}) as Record<string, unknown>);
  const marketsRaw = Array.isArray(scenario.markets)
    ? (scenario.markets as Record<string, unknown>[])
    : [];
  const markets: ReplayMarketInput[] = marketsRaw.map((entry) => ({
    market: parseMarket((entry.market ?? {}) as Record<string, unknown>),
    trendCandles: parseCandles(entry.trendCandles ?? [], 'trendCandles'),
    structureCandles: parseCandles(entry.structureCandles ?? [], 'structureCandles'),
    triggerCandles: parseCandles(entry.triggerCandles ?? [], 'triggerCandles'),
  }));

  const result = replayMarkets({ markets, config });
  const payload = argv.includes('--trades')
    ? result
    : { metrics: result.metrics, equityCurve: result.equityCurve };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

if (require.main === module) {
  main(process.argv.slice(2));
}
