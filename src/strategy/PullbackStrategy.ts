/**
 * Strong-asset pullback strategy.
 *
 * Three timeframes, each with one job:
 *
 *   TREND (default 4h)      — is there a directional regime at all?
 *   STRUCTURE (default 1h)  — where are the levels a pullback would respect?
 *   TRIGGER (default 15m)   — has the pullback actually reversed?
 *
 * The point of a pullback strategy is to buy strength on a discount rather than to
 * buy a breakout. That imposes an unusual constraint: the entry is a LIMIT order
 * BELOW the market for a long (and above it for a short), placed as ALO/post-only.
 * Chasing with a market order is what destroys the edge, so the strategy never
 * emits a marketable price and explicitly refuses a setup whose trigger has
 * already run past `MAX_CHASE_ATR` beyond the trigger bar's extreme.
 *
 * Every evaluation returns a full list of reasons, whether or not it fires. The
 * brief's daily report and the replay runner both need to explain why a setup was
 * skipped, and reconstructing that from a bare "no signal" is impossible.
 *
 * A 1-minute trigger is not representable here: `TRIGGER_TIMEFRAME` excludes it at
 * the configuration schema level.
 */

import { Decimal, dec, dMax, dMin, floorToTick, toFixedString } from '../util/decimal';
import type { Candle, MarketInfo } from '../arcus/types';
import {
  computeTrendSnapshot,
  latestDirectionalVwap,
  lastDefined,
  structureLevels,
  atr as atrSeries,
  closedCandles,
  fallingHighs,
  highestHigh,
  lowestLow,
  risingLows,
  volumeProfile,
} from './StrategyIndicators';
import type { TradeDirection, TradeProposal } from '../risk/RiskEngine';

export interface StrategyConfig {
  readonly emaFastPeriod: number;
  readonly emaMidPeriod: number;
  readonly emaSlowPeriod: number;
  readonly atrPeriod: number;
  readonly minHistoryBars: number;
  /** ATR multiple added beyond the structural stop. */
  readonly stopAtrBuffer: Decimal;
  /** Max EMA distance, in ATRs, before a trend counts as too extended to enter. */
  readonly maxExtensionAtr: Decimal;
  /** Max distance beyond the trigger bar extreme we will chase, in ATRs. */
  readonly maxChaseAtr: Decimal;
  /** How close to EMA21/AVWAP/structure counts as "in the zone", in ATRs. */
  readonly pullbackZoneAtr: Decimal;
  readonly tp1RMultiple: Decimal;
  readonly tp1ClosePct: Decimal;
  readonly tp2RMultiple: Decimal;
  /** Bars scanned for swing structure and AVWAP anchoring. */
  readonly structureLookback: number;
  /** Swing confirmation window on the structure timeframe. */
  readonly swingLeftBars: number;
  readonly swingRightBars: number;
  /**
   * How many structure bars to look back for the INVALIDATION level.
   *
   * The default (0) uses the most recent confirmed swing, which is a 2-bar pivot and
   * therefore a *minor* one: the stop ends up sitting immediately behind recent noise
   * and is hit by ordinary wobble. Backtests over four months showed ~79% of trades
   * stopped out that way, far above the ~42% break-even rate the 1.6R/-1.2R payoff mix
   * needs.
   *
   * Setting this to N makes the stop the DEEPER of (last swing, extreme of the last N
   * structure bars), giving the trade room to breathe inside the structure it is
   * supposed to be trading.
   */
  readonly stopStructureBars?: number;
}

/** Trend classification on the trend timeframe. */
export type TrendBias = 'bullish' | 'bearish' | 'none';

/** The outcome of one full evaluation. */
export interface StrategySignal {
  readonly direction: TradeDirection | 'flat';
  /** The proposal, present only when `direction !== 'flat'`. */
  readonly proposal?: TradeProposal;
  /** Diagnostic trail. Always populated, whatever the outcome. */
  readonly reasons: readonly string[];
  /** Why the signal is flat, when it is. */
  readonly flatReason?: string;
  /**
   * Diagnostic values captured as the evaluation progresses. Mutable because it
   * is progressively populated by the gate sequence; the returned object is
   * treated as read-only by callers.
   */
  readonly diagnostics: {
    trendBias: TrendBias;
    emaFast?: string;
    emaMid?: string;
    emaSlow?: string;
    emaMidSlope?: string;
    atr?: string;
    avwap?: string;
    avwapAnchor?: string;
    structuralStop?: string;
    triggerBarHigh?: string;
    triggerBarLow?: string;
  };
}

export interface StrategyInput {
  readonly market: MarketInfo;
  /** Trend timeframe bars, closed only. */
  readonly trendCandles: readonly Candle[];
  /** Structure timeframe bars, closed only. */
  readonly structureCandles: readonly Candle[];
  /** Trigger timeframe bars, closed only.**
   * The LAST bar is treated as the just-closed trigger bar. */
  readonly triggerCandles: readonly Candle[];
  readonly config: StrategyConfig;
}

/* ------------------------------------------------------------------ *
 * Trend
 * ------------------------------------------------------------------ */

/**
 * Classify the trend on the trend timeframe.
 *
 * The brief's conditions, verbatim:
 *   bullish: EMA9 > EMA21, EMA21 > EMA50, EMA21 slope not negative,
 *            and price not extended too far above EMA21
 *   bearish: the mirror
 * A slope of exactly zero is permitted (the brief says "不为负" / "不为正").
 */
export function classifyTrend(
  candles: readonly Candle[],
  config: StrategyConfig,
): { bias: TrendBias; reasons: string[]; snapshot?: ReturnType<typeof computeTrendSnapshot> } {
  const reasons: string[] = [];
  const bars = closedCandles(candles);
  const snapshot = computeTrendSnapshot({
    candles: bars,
    emaFastPeriod: config.emaFastPeriod,
    emaMidPeriod: config.emaMidPeriod,
    emaSlowPeriod: config.emaSlowPeriod,
    atrPeriod: config.atrPeriod,
    maxExtensionAtr: config.maxExtensionAtr,
  });

  if (!snapshot) {
    reasons.push(
      `trend timeframe has insufficient or degenerate history (${bars.length} closed bars; ` +
        `need >= ${Math.max(config.emaSlowPeriod, config.atrPeriod) + 1})`,
    );
    return { bias: 'none', reasons };
  }

  const { emaFast, emaMid, emaSlow, emaMidSlope, extended } = snapshot;

  const bullishStack = emaFast.greaterThan(emaMid) && emaMid.greaterThan(emaSlow);
  const bearishStack = emaFast.lessThan(emaMid) && emaMid.lessThan(emaSlow);

  if (extended) {
    // Report the extension but still allow classification: the zone check later
    // is what actually rejects an extended entry, because extension is only
    // disqualifying if price is ALSO not in a pullback zone.
    reasons.push(
      `price ${toFixedString(snapshot.lastClose)} is more than ${toFixedString(config.maxExtensionAtr)} ATR ` +
        `from EMA${config.emaMidPeriod} (${toFixedString(emaMid)})`,
    );
  }

  if (bullishStack && (emaMidSlope === undefined || !emaMidSlope.isNegative())) {
    return { bias: 'bullish', reasons, snapshot };
  }
  if (bearishStack && (emaMidSlope === undefined || !emaMidSlope.greaterThan(0))) {
    return { bias: 'bearish', reasons, snapshot };
  }

  reasons.push(
    `no stacked trend: EMA${config.emaFastPeriod}=${toFixedString(emaFast)}, ` +
      `EMA${config.emaMidPeriod}=${toFixedString(emaMid)}, EMA${config.emaSlowPeriod}=${toFixedString(emaSlow)}, ` +
      `EMA${config.emaMidPeriod} slope=${emaMidSlope ? toFixedString(emaMidSlope) : 'undefined'}`,
  );
  return { bias: 'none', reasons, snapshot };
}

/* ------------------------------------------------------------------ *
 * Pullback zone
 * ------------------------------------------------------------------ */

export interface PullbackZone {
  /** Zone bounds. A long's zone lies BELOW the last close (a discount). */
  readonly lower: Decimal;
  readonly upper: Decimal;
  /** Which references defined the zone. */
  readonly references: readonly string[];
}

/**
 * Build the pullback zone from EMA21, AVWAP, prior structure and the
 * high-volume area.
 *
 * The zone is deliberately built from several independent references: a pullback
 * that only touches one indicator is a much weaker setup than one where EMA21,
 * AVWAP and a prior swing level coincide.
 */
export function buildPullbackZone(input: {
  direction: TradeDirection;
  lastClose: Decimal;
  atr: Decimal;
  emaMid: Decimal;
  avwap?: Decimal;
  structureCandles: readonly Candle[];
  config: StrategyConfig;
}): PullbackZone {
  const { direction, lastClose, atr, emaMid, config } = input;
  const band = atr.times(config.pullbackZoneAtr);
  const references: string[] = [];
  const candidates: Decimal[] = [];

  candidates.push(emaMid);
  references.push(`EMA${config.emaMidPeriod}`);

  if (input.avwap) {
    candidates.push(input.avwap);
    references.push('AVWAP');
  }

  const levels = structureLevels(input.structureCandles, config.structureLookback);
  const relevantLevels = direction === 'long' ? levels.support : levels.resistance;
  for (const level of relevantLevels.slice(0, 3)) {
    // Only levels on the correct side of price define a pullback zone.
    if (direction === 'long' && level.lessThan(lastClose)) {
      candidates.push(level);
      references.push('prior structure');
      break;
    }
    if (direction === 'short' && level.greaterThan(lastClose)) {
      candidates.push(level);
      references.push('prior structure');
      break;
    }
  }

  // High-volume area: the price band carrying the most traded volume is a magnet
  // and often acts as support/resistance on the retest.
  const profile = volumeProfile(input.structureCandles, 20);
  if (profile.length > 0 && profile[0]) {
    candidates.push(profile[0].price);
    references.push('high-volume area');
  }

  if (candidates.length === 0) {
    // Cannot happen because EMA is always present, but keep the type honest.
    return { lower: emaMid.minus(band), upper: emaMid.plus(band), references };
  }

  const lowest = candidates.reduce((min, cur) => (cur.lessThan(min) ? cur : min), candidates[0]!);
  const highest = candidates.reduce((max, cur) => (cur.greaterThan(max) ? cur : max), candidates[0]!);

  // Widen the band around the cluster of references. For a long the zone must sit
  // at or below the last close to be a discount, so it is clipped there if the
  // reference cluster has drifted above price.
  let lower = lowest.minus(band);
  let upper = highest.plus(band);
  if (direction === 'long' && upper.greaterThan(lastClose)) upper = lastClose;
  if (direction === 'short' && lower.lessThan(lastClose)) lower = lastClose;

  return { lower, upper, references };
}

/* ------------------------------------------------------------------ *
 * Trigger
 * ------------------------------------------------------------------ */

export interface TriggerResult {
  readonly fired: boolean;
  readonly reasons: readonly string[];
  /** The just-closed trigger bar. */
  readonly bar?: Candle;
  readonly previousBar?: Candle;
  /** Proposed entry price, already snapped to the tick grid. */
  readonly entryPrice?: Decimal;
}

/**
 * 15m reversal confirmation.
 *
 * The brief's sequence for a long:
 *   1. price shows rejection in the support zone
 *   2. the current or next bar breaks the previous bar's high
 *   3. the breakout is within the max chase distance
 *   4. only a pullback LIMIT order — never a market order
 *
 * "Rejection" is operationalised as: the bar traded down into the zone (its low
 * reached it) but closed back above the zone's midpoint, i.e. the zone held.
 */
export function evaluateTrigger(input: {
  direction: TradeDirection;
  triggerCandles: readonly Candle[];
  zone: PullbackZone;
  atr: Decimal;
  tickSize: Decimal;
  config: StrategyConfig;
}): TriggerResult {
  const reasons: string[] = [];
  const bars = closedCandles(input.triggerCandles);
  if (bars.length < 2) {
    return { fired: false, reasons: ['trigger timeframe needs at least 2 closed bars'] };
  }
  const bar = bars[bars.length - 1]!;
  const previousBar = bars[bars.length - 2]!;
  const atr = input.atr;
  const zoneMid = input.zone.lower.plus(input.zone.upper).div(2);

  const barLow = dec(bar.low);
  const barHigh = dec(bar.high);
  const barClose = dec(bar.close);
  const barOpen = dec(bar.open);
  const prevHigh = dec(previousBar.high);
  const prevLow = dec(previousBar.low);

  if (input.direction === 'long') {
    // 1. rejection in the zone: the bar probed the zone and closed back above its mid.
    const probedZone = barLow.lessThanOrEqualTo(input.zone.upper);
    if (!probedZone) {
      return {
        fired: false,
        reasons: [
          `trigger bar low ${toFixedString(barLow)} never reached the pullback zone ` +
            `[${toFixedString(input.zone.lower)}, ${toFixedString(input.zone.upper)}]`,
        ],
        bar,
        previousBar,
      };
    }
    if (!barClose.greaterThan(zoneMid)) {
      return {
        fired: false,
        reasons: [
          `trigger bar closed at ${toFixedString(barClose)}, at or below the zone midpoint ` +
            `${toFixedString(zoneMid)} — the zone did not hold`,
        ],
        bar,
        previousBar,
      };
    }
    // 2. bullish reversal: the bar closes up.
    if (!barClose.greaterThan(barOpen)) {
      return {
        fired: false,
        reasons: [`trigger bar is not bullish (open ${toFixedString(barOpen)} close ${toFixedString(barClose)})`],
        bar,
        previousBar,
      };
    }
    // 3. break of the previous bar's high.
    if (!barHigh.greaterThan(prevHigh)) {
      return {
        fired: false,
        reasons: [
          `trigger bar high ${toFixedString(barHigh)} did not exceed the previous bar's high ${toFixedString(prevHigh)}`,
        ],
        bar,
        previousBar,
      };
    }
    // 4. chase limit: the entry must not be more than maxChaseAtr away from the
    //    trigger bar's low. A pullback entry sits NEAR the bar, not at its extreme.
    const reference = barLow;
    const maxEntry = reference.plus(atr.times(input.config.maxChaseAtr));
    // Enter on a retracement to the zone's upper edge, which is below the close.
    const rawEntry = dMin(input.zone.upper, barClose);
    if (rawEntry.greaterThan(maxEntry)) {
      return {
        fired: false,
        reasons: [
          `entry ${toFixedString(rawEntry)} would be more than ${toFixedString(input.config.maxChaseAtr)} ATR ` +
            `above the trigger bar low ${toFixedString(reference)} (max ${toFixedString(maxEntry)})`,
        ],
        bar,
        previousBar,
      };
    }
    const entryPrice = floorToTick(rawEntry, input.tickSize);
    reasons.push(
      `long trigger confirmed: zone [${toFixedString(input.zone.lower)}, ${toFixedString(input.zone.upper)}] held, ` +
        `bar closed ${toFixedString(barClose)} after making ${toFixedString(barLow)}, ` +
        `broke previous high ${toFixedString(prevHigh)}`,
    );
    return { fired: true, reasons, bar, previousBar, entryPrice };
  }

  /* ---- short mirror ---- */
  const probedZone = barHigh.greaterThanOrEqualTo(input.zone.lower);
  if (!probedZone) {
    return {
      fired: false,
      reasons: [
        `trigger bar high ${toFixedString(barHigh)} never reached the resistance zone ` +
          `[${toFixedString(input.zone.lower)}, ${toFixedString(input.zone.upper)}]`,
      ],
      bar,
      previousBar,
    };
  }
  if (!barClose.lessThan(zoneMid)) {
    return {
      fired: false,
      reasons: [
        `trigger bar closed at ${toFixedString(barClose)}, at or above the zone midpoint ` +
          `${toFixedString(zoneMid)} — the zone did not hold`,
      ],
      bar,
      previousBar,
    };
  }
  if (!barClose.lessThan(barOpen)) {
    return {
      fired: false,
      reasons: [`trigger bar is not bearish (open ${toFixedString(barOpen)} close ${toFixedString(barClose)})`],
      bar,
      previousBar,
    };
  }
  if (!barLow.lessThan(prevLow)) {
    return {
      fired: false,
      reasons: [
        `trigger bar low ${toFixedString(barLow)} did not undercut the previous bar's low ${toFixedString(prevLow)}`,
      ],
      bar,
      previousBar,
    };
  }
  const reference = barHigh;
  const minEntry = reference.minus(atr.times(input.config.maxChaseAtr));
  const rawEntry = dMax(input.zone.lower, barClose);
  if (rawEntry.lessThan(minEntry)) {
    return {
      fired: false,
      reasons: [
        `entry ${toFixedString(rawEntry)} would be more than ${toFixedString(input.config.maxChaseAtr)} ATR ` +
          `below the trigger bar high ${toFixedString(reference)} (min ${toFixedString(minEntry)})`,
      ],
      bar,
      previousBar,
    };
  }
  const entryPrice = floorToTick(rawEntry, input.tickSize);
  reasons.push(
    `short trigger confirmed: zone [${toFixedString(input.zone.lower)}, ${toFixedString(input.zone.upper)}] held, ` +
      `bar closed ${toFixedString(barClose)} after making ${toFixedString(barHigh)}, ` +
      `undercut previous low ${toFixedString(prevLow)}`,
  );
  return { fired: true, reasons, bar, previousBar, entryPrice };
}

/* ------------------------------------------------------------------ *
 * Full evaluation
 * ------------------------------------------------------------------ */

/**
 * Evaluate the whole strategy.
 *
 * Order of gates mirrors the brief: trend first (cheapest to reject), then the
 * pullback context, then the trigger. Each gate appends its reasons so the caller
 * can see how far the setup progressed.
 */
export function evaluateStrategy(input: StrategyInput): StrategySignal {
  const { config, market } = input;
  const reasons: string[] = [];
  const diagnostics: StrategySignal['diagnostics'] = { trendBias: 'none' };

  /* ---- 0. history sufficiency ------------------------------------ */
  const trendBars = closedCandles(input.trendCandles);
  const structureBars = closedCandles(input.structureCandles);
  const triggerBars = closedCandles(input.triggerCandles);
  if (trendBars.length < config.minHistoryBars) {
    return flat(
      `trend timeframe has ${trendBars.length} closed bars, below MIN_HISTORY_BARS ${config.minHistoryBars}`,
      reasons,
      diagnostics,
    );
  }
  if (structureBars.length < 30) {
    return flat(`structure timeframe has only ${structureBars.length} closed bars`, reasons, diagnostics);
  }
  if (triggerBars.length < 3) {
    return flat(`trigger timeframe has only ${triggerBars.length} closed bars`, reasons, diagnostics);
  }

  /* ---- 1. trend --------------------------------------------------- */
  const trend = classifyTrend(trendBars, config);
  reasons.push(...trend.reasons);
  diagnostics.trendBias = trend.bias;
  if (!trend.snapshot) {
    return flat('trend snapshot could not be computed', reasons, diagnostics);
  }
  const snapshot = trend.snapshot;
  diagnostics.emaFast = toFixedString(snapshot.emaFast);
  diagnostics.emaMid = toFixedString(snapshot.emaMid);
  diagnostics.emaSlow = toFixedString(snapshot.emaSlow);
  diagnostics.atr = toFixedString(snapshot.atr);
  if (snapshot.emaMidSlope) diagnostics.emaMidSlope = toFixedString(snapshot.emaMidSlope);

  if (trend.bias === 'none') {
    return flat('no directional trend on the trend timeframe', reasons, diagnostics);
  }
  const direction: TradeDirection = trend.bias === 'bullish' ? 'long' : 'short';

  /* ---- 2. structure: not fighting immediate structure ------------ */
  if (direction === 'long') {
    const lowsRising = risingLows(structureBars.slice(-40), 2);
    if (!lowsRising) {
      reasons.push('structure lows are not yet rising; pullback quality is unconfirmed');
    }
  } else {
    const highsFalling = fallingHighs(structureBars.slice(-40), 2);
    if (!highsFalling) {
      reasons.push('structure highs are not yet falling; pullback quality is unconfirmed');
    }
  }

  /* ---- 3. pullback context --------------------------------------- */
  const atrValue = lastDefined(atrSeries(structureBars, config.atrPeriod));
  if (!atrValue || !atrValue.greaterThan(0)) {
    return flat('structure ATR is unavailable or zero', reasons, diagnostics);
  }

  const vwap = latestDirectionalVwap(structureBars, direction, config.structureLookback);
  diagnostics.avwap = vwap.value ? toFixedString(vwap.value) : undefined;
  diagnostics.avwapAnchor = vwap.anchorReason;

  const zone = buildPullbackZone({
    direction,
    lastClose: snapshot.lastClose,
    atr: atrValue,
    emaMid: snapshot.emaMid,
    ...(vwap.value ? { avwap: vwap.value } : {}),
    structureCandles: structureBars,
    config,
  });

  // The pullback must actually be happening: for a long, price must be at or
  // below the zone's upper edge, not extended above it.
  if (direction === 'long' && snapshot.lastClose.greaterThan(zone.upper)) {
    return flat(
      `price ${toFixedString(snapshot.lastClose)} is above the pullback zone upper bound ` +
        `${toFixedString(zone.upper)} (references: ${zone.references.join(', ')}) — no pullback in progress`,
      reasons,
      diagnostics,
    );
  }
  if (direction === 'short' && snapshot.lastClose.lessThan(zone.lower)) {
    return flat(
      `price ${toFixedString(snapshot.lastClose)} is below the pullback zone lower bound ` +
        `${toFixedString(zone.lower)} (references: ${zone.references.join(', ')}) — no pullback in progress`,
      reasons,
      diagnostics,
    );
  }

  /* ---- 4. structural stop ---------------------------------------- */
  const levels = structureLevels(structureBars, config.structureLookback);
  const pivotReference = direction === 'long' ? levels.support[0] : levels.resistance[0];

  // The invalidation level. With `stopStructureBars` set, the DEEPER of the last swing
  // and the extreme of the recent structure window wins, so the stop is not parked
  // immediately behind a minor pivot.
  const stopBars = config.stopStructureBars ?? 0;
  let stopReference: Decimal | undefined = pivotReference;
  if (stopBars > 0) {
    const window = structureBars.slice(-stopBars);
    const extreme =
      direction === 'long' ? lowestLow(window, window.length) : highestHigh(window, window.length);
    if (extreme) {
      stopReference =
        pivotReference === undefined
          ? extreme
          : direction === 'long'
            ? dMin(pivotReference, extreme)
            : dMax(pivotReference, extreme);
    }
  }
  if (!stopReference) {
    return flat(
      `no confirmed structural ${direction === 'long' ? 'support' : 'resistance'} level to place a stop behind`,
      reasons,
      diagnostics,
    );
  }
  diagnostics.structuralStop = toFixedString(stopReference);

  /* ---- 5. trigger ------------------------------------------------- */
  const trigger = evaluateTrigger({
    direction,
    triggerCandles: triggerBars,
    zone,
    atr: atrValue,
    tickSize: dec(market.tickSize),
    config,
  });
  reasons.push(...trigger.reasons);
  if (!trigger.fired || !trigger.entryPrice || !trigger.bar) {
    return flat('trigger timeframe did not confirm a reversal', reasons, diagnostics);
  }
  diagnostics.triggerBarHigh = trigger.bar.high;
  diagnostics.triggerBarLow = trigger.bar.low;

  const entryPrice = trigger.entryPrice;

  /* ---- 6. stop price with ATR buffer ----------------------------- */
  const buffer = atrValue.times(config.stopAtrBuffer);
  const stopPriceRaw =
    direction === 'long' ? stopReference.minus(buffer) : stopReference.plus(buffer);
  // The stop must be on the losing side. If the ATR buffer pushes it the wrong way
  // (or structure sits beyond the entry), the setup is degenerate.
  if (direction === 'long' && !stopPriceRaw.lessThan(entryPrice)) {
    return flat(
      `computed stop ${toFixedString(stopPriceRaw)} is not below the entry ${toFixedString(entryPrice)}`,
      reasons,
      diagnostics,
    );
  }
  if (direction === 'short' && !stopPriceRaw.greaterThan(entryPrice)) {
    return flat(
      `computed stop ${toFixedString(stopPriceRaw)} is not above the entry ${toFixedString(entryPrice)}`,
      reasons,
      diagnostics,
    );
  }
  const stopPrice =
    direction === 'long'
      ? floorToTick(stopPriceRaw, dec(market.tickSize))
      : floorToTick(stopPriceRaw, dec(market.tickSize));

  /* ---- 7. targets ------------------------------------------------- */
  const risk = entryPrice.minus(stopPrice).abs();
  if (!risk.greaterThan(0)) {
    return flat('risk distance is zero; cannot define R multiples', reasons, diagnostics);
  }
  const target1 =
    direction === 'long'
      ? floorToTick(entryPrice.plus(risk.times(config.tp1RMultiple)), dec(market.tickSize))
      : floorToTick(entryPrice.minus(risk.times(config.tp1RMultiple)), dec(market.tickSize));
  const target2 =
    direction === 'long'
      ? floorToTick(entryPrice.plus(risk.times(config.tp2RMultiple)), dec(market.tickSize))
      : floorToTick(entryPrice.minus(risk.times(config.tp2RMultiple)), dec(market.tickSize));

  reasons.push(
    `proposal: ${direction} ${market.marketDisplayName} entry ${toFixedString(entryPrice)} ` +
      `stop ${toFixedString(stopPrice)} (structural ${toFixedString(stopReference)} ` +
      `-/+ ${toFixedString(buffer)} ATR buffer) TP1 ${toFixedString(target1)} ` +
      `(${toFixedString(config.tp1RMultiple)}R) TP2 ${toFixedString(target2)} ` +
      `(${toFixedString(config.tp2RMultiple)}R); zone references: ${zone.references.join(', ')}`,
  );

  return {
    direction,
    proposal: {
      marketId: market.marketId,
      symbol: market.marketDisplayName,
      direction,
      structuralStop: stopReference,
      entryPrice,
      stopPrice,
      target1,
      target2,
      rationale: reasons,
    },
    reasons,
    diagnostics,
  };
}

function flat(
  flatReason: string,
  reasons: readonly string[],
  diagnostics: StrategySignal['diagnostics'],
): StrategySignal {
  return { direction: 'flat', reasons: [...reasons, flatReason], flatReason, diagnostics };
}

/**
 * Symmetry check used by the test suite.
 *
 * A pullback strategy must behave identically long and short. This helper mirrors
 * a candle series through a fixed price level so a test can assert that evaluating
 * the mirror image produces the mirrored signal — catching any accidental long
 * bias in the many comparisons above.
 */
export function mirrorCandles(candles: readonly Candle[], axis: Decimal): Candle[] {
  return candles.map((bar) => ({
    ...bar,
    open: toFixedString(axis.times(2).minus(dec(bar.open))),
    high: toFixedString(axis.times(2).minus(dec(bar.low))),
    low: toFixedString(axis.times(2).minus(dec(bar.high))),
    close: toFixedString(axis.times(2).minus(dec(bar.close))),
  }));
}
