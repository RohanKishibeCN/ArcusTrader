/**
 * Indicator façade.
 *
 * The signal logic in `PullbackStrategy` and `StrategyEvaluator` consumes
 * indicators through this narrow module rather than importing the primitives
 * directly. Two reasons:
 *
 *  1. It documents, in one place, exactly which indicator semantics the strategy
 *     depends on — the Wilder ATR smoothing, the AVWAP anchoring rule, the
 *     "closed bars only" rule.
 *  2. Signal code is much easier to test when the indicator surface is a small
 *     named set that a test can stub.
 *
 * Everything here is a thin, pure re-export plus a few composition helpers. No
 * state, no I/O.
 */

import { Decimal } from '../util/decimal';
import type { Candle } from '../arcus/types';
import {
  anchoredVwap,
  atr,
  closedCandles,
  distanceInAtr,
  ema,
  emaOnCandles,
  emaSlope,
  fallingHighs,
  findBreakoutOrigin,
  findImpulseHigh,
  findImpulseLow,
  highestHigh,
  isExtendedFromEma,
  lowestLow,
  realizedVolatility,
  risingLows,
  structureLevels,
  volumeProfile,
  type SwingPoint,
} from './Indicators';

export type { SwingPoint };

export {
  anchoredVwap,
  atr,
  closedCandles,
  distanceInAtr,
  ema,
  emaOnCandles,
  emaSlope,
  fallingHighs,
  findBreakoutOrigin,
  findImpulseHigh,
  findImpulseLow,
  highestHigh,
  isExtendedFromEma,
  lowestLow,
  realizedVolatility,
  risingLows,
  structureLevels,
  volumeProfile,
};

/** Last defined value of a nullable series, or undefined. */
export function lastDefined(series: readonly (Decimal | null)[]): Decimal | undefined {
  for (let i = series.length - 1; i >= 0; i -= 1) {
    const value = series[i];
    if (value !== null && value !== undefined) return value;
  }
  return undefined;
}

/** Value at an index, or undefined when null/out of range. */
export function at(
  series: readonly (Decimal | null)[],
  index: number,
): Decimal | undefined {
  if (index < 0 || index >= series.length) return undefined;
  return series[index] ?? undefined;
}

/**
 * The bundle of indicator values a trend decision needs, computed once per
 * evaluation so the strategy never recomputes the same EMA several times with
 * subtly different windows.
 */
export interface TrendSnapshot {
  readonly emaFast: Decimal;
  readonly emaMid: Decimal;
  readonly emaSlow: Decimal;
  /** Difference of emaMid over the configured lookback. */
  readonly emaMidSlope: Decimal | undefined;
  readonly atr: Decimal;
  readonly lastClose: Decimal;
  /** True when price has run too far from EMA21 to be a pullback entry. */
  readonly extended: boolean;
  readonly barCount: number;
}

export interface TrendSnapshotInput {
  readonly candles: readonly Candle[];
  readonly emaFastPeriod: number;
  readonly emaMidPeriod: number;
  readonly emaSlowPeriod: number;
  readonly atrPeriod: number;
  readonly slopeLookback?: number;
  readonly maxExtensionAtr: Decimal;
}

/**
 * Compute the trend bundle from closed bars.
 *
 * Returns undefined when there is not enough history to define every series —
 * an explicitly undefined trend is far safer than one computed from a partially
 * seeded EMA, which would silently read as a valid signal.
 */
export function computeTrendSnapshot(input: TrendSnapshotInput): TrendSnapshot | undefined {
  const bars = input.candles;
  // The slowest series needs its full seed window plus one bar to produce a value.
  const minimum = Math.max(
    input.emaSlowPeriod + 1,
    input.emaMidPeriod + 1,
    input.atrPeriod + 1,
  );
  if (bars.length < minimum) return undefined;

  const emaFastSeries = emaOnCandles(bars, input.emaFastPeriod);
  const emaMidSeries = emaOnCandles(bars, input.emaMidPeriod);
  const emaSlowSeries = emaOnCandles(bars, input.emaSlowPeriod);
  const atrSeries = atr(bars, input.atrPeriod);

  const emaFast = lastDefined(emaFastSeries);
  const emaMid = lastDefined(emaMidSeries);
  const emaSlow = lastDefined(emaSlowSeries);
  const atrValue = lastDefined(atrSeries);
  const lastBar = bars[bars.length - 1];
  if (!emaFast || !emaMid || !emaSlow || !atrValue || !lastBar) return undefined;
  if (!atrValue.greaterThan(0)) {
    // A zero ATR means a flat/degenerate series. No stop distance can be derived.
    return undefined;
  }

  const lastClose = new Decimal(lastBar.close);
  return {
    emaFast,
    emaMid,
    emaSlow,
    emaMidSlope: emaSlope(emaMidSeries, input.slopeLookback ?? 3),
    atr: atrValue,
    lastClose,
    extended: isExtendedFromEma(lastClose, emaMid, atrValue, input.maxExtensionAtr),
    barCount: bars.length,
  };
}

/**
 * Anchor selection for AVWAP, per direction.
 *
 * Multi-anchor by design: a breakout origin and the most recent impulse extreme
 * often differ, and having both available lets the strategy choose the level that
 * actually behaves as support/resistance rather than committing to one rule.
 */
export interface VwapAnchors {
  readonly impulseLow?: SwingPoint;
  readonly impulseHigh?: SwingPoint;
  readonly breakoutOrigin?: { index: number; direction: 'up' | 'down' };
}

export function findVwapAnchors(
  candles: readonly Candle[],
  lookback: number,
): VwapAnchors {
  return {
    impulseLow: findImpulseLow(candles, lookback),
    impulseHigh: findImpulseHigh(candles, lookback),
    breakoutOrigin: findBreakoutOrigin(candles, lookback),
  };
}

/**
 * AVWAP series for a direction.
 *
 * For a long, the anchor is the most recent impulse low, falling back to the
 * origin of the most recent upward breakout. For a short, the mirror. Continuing
 * to use an anchor after the price has left the structure it described is the
 * main way AVWAP becomes misleading, so the caller must re-derive the anchor
 * every evaluation rather than caching one for the life of a position — which is
 * what calling this per evaluation achieves.
 */
export function directionalVwap(
  candles: readonly Candle[],
  direction: 'long' | 'short',
  lookback: number,
): { series: readonly (Decimal | null)[]; anchorIndex?: number; anchorReason?: string } {
  const anchors = findVwapAnchors(candles, lookback);
  if (direction === 'long') {
    if (anchors.impulseLow) {
      return {
        series: anchoredVwap(candles, anchors.impulseLow.index),
        anchorIndex: anchors.impulseLow.index,
        anchorReason: 'impulse low',
      };
    }
    if (anchors.breakoutOrigin && anchors.breakoutOrigin.direction === 'up') {
      return {
        series: anchoredVwap(candles, anchors.breakoutOrigin.index),
        anchorIndex: anchors.breakoutOrigin.index,
        anchorReason: 'upward breakout origin',
      };
    }
    return { series: [] };
  }

  if (anchors.impulseHigh) {
    return {
      series: anchoredVwap(candles, anchors.impulseHigh.index),
      anchorIndex: anchors.impulseHigh.index,
      anchorReason: 'impulse high',
    };
  }
  if (anchors.breakoutOrigin && anchors.breakoutOrigin.direction === 'down') {
    return {
      series: anchoredVwap(candles, anchors.breakoutOrigin.index),
      anchorIndex: anchors.breakoutOrigin.index,
      anchorReason: 'downward breakout origin',
    };
  }
  return { series: [] };
}

/** Convenience: the most recent AVWAP value for a direction. */
export function latestDirectionalVwap(
  candles: readonly Candle[],
  direction: 'long' | 'short',
  lookback: number,
): { value?: Decimal; anchorIndex?: number; anchorReason?: string } {
  const { series, anchorIndex, anchorReason } = directionalVwap(candles, direction, lookback);
  return { value: lastDefined(series), anchorIndex, anchorReason };
}
