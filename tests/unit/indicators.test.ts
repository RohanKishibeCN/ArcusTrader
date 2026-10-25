/**
 * Indicator tests.
 *
 * The strategy sizes positions off ATR and places stops off swing structure, so a
 * wrong number here is not a cosmetic bug — it is a wrong order size or a stop in
 * the wrong place. That drives the shape of this suite:
 *
 *  1. HAND-COMPUTED vectors wherever the arithmetic fits on a napkin. The seed of
 *     the EMA is asserted to equal the SMA by hand, the ATR example is worked out
 *     in the comment above the expectation, and the AVWAP expectations are
 *     three-bar sums a reader can verify without running anything.
 *  2. The PADDING CONTRACT (`null` before the seed, array length preserved) is
 *     pinned explicitly, because an off-by-one in the padding silently misaligns
 *     every `values[i]` against `candles[i]` downstream.
 *  3. The DEGENERATE paths are pinned too: zero-width ranges, zero volume, ATR of
 *     zero, ties in swing detection. These are exactly the inputs that produce
 *     NaN/Infinity in a naive implementation, and a NaN that reaches a position
 *     size is a real-money defect.
 *  4. Exactness is asserted against JavaScript floats directly: the final test
 *     shows ten `0.1` volumes summing to `0.9999999999999999` in `number` while
 *     the same sum through this module is exactly `1`.
 *
 * The synthetic zig-zag below is generated rather than typed out so that every
 * pivot is at a known index with a known price; see `zigzag()` for the layout.
 */

import { describe, expect, it } from 'vitest';
import {
  IndicatorError,
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
  findSwingPoints,
  highestHigh,
  isExtendedFromEma,
  lowestLow,
  realizedVolatility,
  risingLows,
  structureLevels,
  trueRange,
  volumeProfile,
  type CandleLike,
} from '../../src/strategy/Indicators';
import { Decimal, dec } from '../../src/util/decimal';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** Epoch microseconds of the first bar: fixed so nothing in this file can drift. */
const T0 = 1_700_000_000_000_000;

/** One-minute bars, in microseconds. */
function openTimeAt(index: number): number {
  return T0 + index * 60_000_000;
}

/** `[high, low, close, volume?]`; `open` is set to the low (never read here). */
type BarSpec = [high: string, low: string, close: string, volume?: string];

function series(specs: readonly BarSpec[], isFinal = true): CandleLike[] {
  return specs.map(([high, low, close, volume], index) => ({
    openTime: openTimeAt(index),
    open: low,
    high,
    low,
    close,
    volume: volume ?? '1',
    isFinal,
  }));
}

/**
 * Synthetic zig-zag with a KNOWN swing structure, laid out in blocks of six bars:
 *
 *   index 2 + 6k  →  swing LOW  = troughs[k]
 *   index 5 + 6k  →  swing HIGH = peaks[k]
 *
 * The bar between two pivots is the trough value +4/+8/+9 (rising) or
 * trough+8/+4 (falling), and the highs mirror that with the peak value -2/-4/-5.
 * Those offsets are deliberately far apart: an intermediate bar is never an
 * extreme of its own 2/2 window, so `findSwingPoints(candles, 2, 2)` returns
 * exactly the listed troughs and peaks. Two bars lead into the first trough, so
 * the array length is `6 * troughs.length + 2`.
 */
function zigzag(troughs: readonly string[], peaks: readonly string[]): CandleLike[] {
  const low: string[] = [];
  const high: string[] = [];
  const shift = (value: string, delta: number): string => dec(value).plus(delta).toFixed();

  low[0] = shift(troughs[0]!, 8);
  low[1] = shift(troughs[0]!, 4);
  high[0] = shift(peaks[0]!, -2);
  high[1] = shift(peaks[0]!, -2);

  for (let k = 0; k < troughs.length; k += 1) {
    const t = 2 + 6 * k;
    const trough = troughs[k]!;
    const peak = peaks[k]!;
    const next = troughs[k + 1] ?? trough;

    low[t] = trough;
    low[t + 1] = shift(trough, 4);
    low[t + 2] = shift(trough, 8);
    low[t + 3] = shift(trough, 9);
    low[t + 4] = shift(next, 8);
    low[t + 5] = shift(next, 4);

    high[t] = shift(peak, -5);
    high[t + 1] = shift(peak, -4);
    high[t + 2] = shift(peak, -2);
    high[t + 3] = peak;
    high[t + 4] = shift(peak, -2);
    high[t + 5] = shift(peak, -4);
  }

  return low.map((l, index) => ({
    openTime: openTimeAt(index),
    open: l,
    high: high[index]!,
    low: l,
    close: l,
    volume: '1',
    isFinal: true,
  }));
}

/** 26 bars, swing lows at 2/8/14/20 and swing highs at 5/11/17/23. */
const ZIGZAG = zigzag(
  ['99.00', '100.00', '100.04', '100.50'],
  ['120.00', '120.04', '125.00', '130.00'],
);

/* ------------------------------------------------------------------ *
 * Assertion helpers
 * ------------------------------------------------------------------ */

/**
 * Compare a `(Decimal|null)[]` series against expected values.
 *
 * Both sides are rendered with `toFixed(dp)` so the comparison holds for values
 * that Decimal can only represent to 40 significant digits (5/3, ln 2, …) while
 * still rejecting a genuinely different number.
 */
function expectSeries(
  actual: readonly (Decimal | null)[],
  expected: readonly (string | null)[],
  dp = 24,
): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i += 1) {
    const want = expected[i]!;
    const got = actual[i] ?? null;
    if (want === null) {
      expect(got).toBeNull();
    } else {
      expect(got === null ? null : got.toFixed(dp)).toBe(dec(want).toFixed(dp));
    }
  }
}

/** `toFixed()` of a Decimal list, with trailing zeros normalised away by Decimal. */
function render(values: readonly Decimal[]): string[] {
  return values.map((value) => value.toFixed());
}

/* ------------------------------------------------------------------ *
 * EMA
 * ------------------------------------------------------------------ */

describe('ema', () => {
  it('seeds with the SMA of the first `period` values', () => {
    // SMA(1, 2, 3) = 6 / 3 = 2, at index period - 1 = 2.
    const out = ema(['1', '2', '3', '4', '5'], 3);
    expect(out[2]!.toFixed()).toBe('2');
  });

  it('reproduces a hand-worked recurrence', () => {
    // period 3 → k = 2 / (3 + 1) = 0.5.
    //   idx2 = SMA(1,2,3)          = 2
    //   idx3 = 4*0.5 + 2*0.5       = 3
    //   idx4 = 5*0.5 + 3*0.5       = 4
    expectSeries(ema(['1', '2', '3', '4', '5'], 3), [null, null, '2', '3', '4']);
  });

  it('pads with null for exactly period - 1 leading indices', () => {
    const out = ema(['10', '11', '12', '13', '14', '15', '16'], 5);
    expect(out.length).toBe(7);
    expect(out.slice(0, 4).every((value) => value === null)).toBe(true);
    expect(out[4]).not.toBeNull();
  });

  it('returns a constant series unchanged (constant input → constant output)', () => {
    // seed = SMA(10,10,10) = 10; every step is 10*0.5 + 10*0.5 = 10.
    expectSeries(ema(['10', '10', '10', '10', '10'], 3), [null, null, '10', '10', '10']);
  });

  it('with period 1 is the identity map', () => {
    // k = 2/2 = 1, so ema_t = v_t.
    expectSeries(ema(['1.5', '2.5', '0.25'], 1), ['1.5', '2.5', '0.25']);
  });

  it('treats Decimal and string inputs identically', () => {
    const render12 = (values: readonly (Decimal | null)[]): (string | null)[] =>
      values.map((value) => (value === null ? null : value.toFixed(12)));
    const fromStrings = ema(['1', '2', '3', '4'], 2);
    const fromDecimals = ema([dec(1), dec(2), dec(3), dec(4)], 2);
    expect(render12(fromDecimals)).toEqual(render12(fromStrings));
  });

  it('rises monotonically on a rising series', () => {
    const out = ema(['1', '2', '3', '4', '5', '6'], 3);
    for (let i = 3; i < out.length; i += 1) {
      expect(out[i]!.greaterThan(out[i - 1]!)).toBe(true);
    }
  });

  it('throws when period is below 1', () => {
    expect(() => ema(['1', '2'], 0)).toThrow(IndicatorError);
    expect(() => ema(['1', '2'], -1)).toThrow(IndicatorError);
  });

  it('throws when period is not an integer', () => {
    expect(() => ema(['1', '2', '3'], 2.5)).toThrow(/integer >= 1/);
  });

  it('throws when there are fewer values than the period', () => {
    expect(() => ema(['1', '2'], 3)).toThrow(/need at least 3 values, got 2/);
  });

  it('refuses non-finite inputs instead of seeding on NaN', () => {
    expect(() => ema([new Decimal(Number.NaN), dec(1)], 1)).toThrow(IndicatorError);
  });

  it('does not mutate the input array', () => {
    const values = ['3', '1', '2'];
    ema(values, 2);
    expect(values).toEqual(['3', '1', '2']);
  });
});

describe('emaOnCandles', () => {
  it('defaults to the close price', () => {
    const candles = series([
      ['10', '8', '9'],
      ['11', '9', '10'],
      ['12', '10', '11'],
    ]);
    // EMA over closes 9, 10, 11 with period 2: seed = 9.5,
    // idx2 = 11*(2/3) + 9.5*(1/3) = 22/3 + 19/6 = 63/6 = 10.5.
    expectSeries(emaOnCandles(candles, 2), [null, '9.5', '10.5']);
    expectSeries(emaOnCandles(candles, 2, 'close'), [null, '9.5', '10.5']);
  });

  it('computes hlc3 = (high + low + close) / 3', () => {
    // (13 + 8 + 9) / 3 = 30 / 3 = 10. period 1 makes the EMA the identity.
    const candles = series([['13', '8', '9']]);
    expectSeries(emaOnCandles(candles, 1, 'hlc3'), ['10']);
  });

  it('computes hl2 = (high + low) / 2', () => {
    // (13 + 8) / 2 = 21 / 2 = 10.5.
    const candles = series([['13', '8', '9']]);
    expectSeries(emaOnCandles(candles, 1, 'hl2'), ['10.5']);
  });

  it('throws when there are fewer candles than the period', () => {
    expect(() => emaOnCandles(series([['13', '8', '9']]), 2)).toThrow(IndicatorError);
  });
});

describe('emaSlope', () => {
  it('is positive when the EMA is rising and negative when it is falling', () => {
    const rising = ema(['1', '2', '3', '4', '5', '6'], 2);
    // Defined values: 1.5, 2.5, 3.5, 4.5, 5.5. 5.5 - (3 non-null entries back) 2.5 = 3.
    expect(emaSlope(rising, 3)!.toFixed()).toBe('3');

    const falling = ema(['6', '5', '4', '3', '2', '1'], 2);
    expect(emaSlope(falling, 3)!.toFixed()).toBe('-3');
  });

  it('is exactly zero on a constant series', () => {
    // The period-3 EMA has only three defined values, so the smallest usable
    // lookback (2) is the one that can produce a slope here.
    const flat = ema(['7', '7', '7', '7', '7'], 3);
    expect(flat.filter((value) => value !== null).length).toBe(3);
    expect(emaSlope(flat, 2)!.isZero()).toBe(true);
  });

  it('ignores null padding when counting back', () => {
    // Nulls at 0..1 are skipped, so lookback 3 compares 5 against 2.
    const padded = [null, null, dec(1), dec(2), dec(3), dec(4), dec(5)];
    expect(emaSlope(padded, 3)!.toFixed()).toBe('3');
  });

  it('returns undefined when fewer than lookback + 1 values are defined', () => {
    expect(emaSlope([null, dec(1), dec(2), dec(3)], 3)).toBeUndefined();
    expect(emaSlope([], 3)).toBeUndefined();
  });

  it('defaults lookback to 3', () => {
    const padded = [null, null, dec(1), dec(2), dec(3), dec(4), dec(5)];
    expect(emaSlope(padded)!.toFixed()).toBe(emaSlope(padded, 3)!.toFixed());
  });

  it('throws for a lookback below 1', () => {
    expect(() => emaSlope([dec(1), dec(2)], 0)).toThrow(IndicatorError);
  });
});

/* ------------------------------------------------------------------ *
 * True range and ATR
 * ------------------------------------------------------------------ */

describe('trueRange', () => {
  it('is high - low for the first bar (no previous close)', () => {
    const first = series([['10', '8', '9']])[0]!;
    expect(trueRange(undefined, first).toFixed()).toBe('2');
  });

  it('uses high - low when the previous close is inside the bar', () => {
    const [prev, cur] = series([
      ['10', '8', '10'],
      ['12', '9', '11'],
    ]);
    // max(12-9, |12-10|, |9-10|) = max(3, 2, 1) = 3.
    expect(trueRange(prev, cur!).toFixed()).toBe('3');
  });

  it('captures a gap up where the previous close is below the bar', () => {
    const [prev, cur] = series([
      ['10', '8', '10'],
      ['15', '14', '14.5'],
    ]);
    // max(15-14, |15-10|, |14-10|) = max(1, 5, 4) = 5: the gap, not the range.
    expect(trueRange(prev, cur!).toFixed()).toBe('5');
  });

  it('captures a gap down where the previous close is above the bar', () => {
    const [prev, cur] = series([
      ['22', '20', '20'],
      ['15', '14', '14.5'],
    ]);
    // max(1, |15-20|, |14-20|) = max(1, 5, 6) = 6.
    expect(trueRange(prev, cur!).toFixed()).toBe('6');
  });
});

describe('atr — Wilder smoothing', () => {
  // Bars:                    TR
  //  0: h 10.0  l 8.0       2    (first bar → high - low)
  //  1: h 10.5  l 9.0       1.5  max(1.5, |10.5-9|, |9-9|)
  //  2: h 11.0  l 9.5       1.5  max(1.5, |11-10|, |9.5-10|)
  //  3: h 12.0  l 11.0      1.5  max(1, |12-10.5|, |11-10.5|)
  const candles = series([
    ['10', '8', '9'],
    ['10.5', '9', '10'],
    ['11', '9.5', '10.5'],
    ['12', '11', '11.5'],
  ]);

  it('seeds with the SMA of the first `period` true ranges', () => {
    // period 3: (2 + 1.5 + 1.5) / 3 = 5 / 3.
    const out = atr(candles, 3);
    expect(out[2]!.toFixed(24)).toBe(dec(5).div(3).toFixed(24));
  });

  it('applies the Wilder step (atr*(period-1) + tr) / period after the seed', () => {
    // idx3 = (5/3 * 2 + 1.5) / 3 = (10/3 + 3/2) / 3 = (29/6) / 3 = 29 / 18.
    const out = atr(candles, 3);
    expect(out[3]!.toFixed(24)).toBe(dec(29).div(18).toFixed(24));
  });

  it('pads with null before the seed and keeps the input length', () => {
    expectSeries(atr(candles, 3), [null, null, '1.666666666666666666666667', '1.611111111111111111111111']);
    expect(atr(candles, 3).length).toBe(candles.length);
  });

  it('holds a constant ATR when every true range is equal', () => {
    // Each bar: range 2 and the previous close sits on the current low, so every
    // TR = 2 and the Wilder recursion keeps (2*2 + 2)/3 = 2.
    const steady = series([
      ['10', '8', '9'],
      ['11', '9', '10'],
      ['12', '10', '11'],
      ['13', '11', '12'],
    ]);
    expectSeries(atr(steady, 3), [null, null, '2', '2']);
  });

  it('throws for period below 1 and for too few candles', () => {
    expect(() => atr(candles, 0)).toThrow(IndicatorError);
    expect(() => atr(candles, 5)).toThrow(/need at least 5 candles, got 4/);
  });
});

/* ------------------------------------------------------------------ *
 * Anchored VWAP
 * ------------------------------------------------------------------ */

describe('anchoredVwap', () => {
  // typical prices / volumes:
  //  idx0: (10+8+9)/3   = 9,   vol 2  → 18
  //  idx1: (12+10+11)/3 = 11,  vol 3  → 33
  //  idx2: (14+12+13)/3 = 13,  vol 5  → 65
  const candles = series(
    [
      ['10', '8', '9', '2'],
      ['12', '10', '11', '3'],
      ['14', '12', '13', '5'],
    ],
    true,
  );

  it('averages cumulatively from the anchor, hand-computed from bar 0', () => {
    // idx0 = 18 / 2       = 9
    // idx1 = (18+33) / 5  = 51 / 5  = 10.2
    // idx2 = (51+65) / 10 = 116 / 10 = 11.6
    expectSeries(anchoredVwap(candles, 0), ['9', '10.2', '11.6']);
  });

  it('nulls the bars before a mid-array anchor and averages only from it', () => {
    // idx1 = 33 / 3         = 11
    // idx2 = (33+65) / 8    = 98 / 8 = 12.25
    expectSeries(anchoredVwap(candles, 1), [null, '11', '12.25']);
  });

  it('returns null while cumulative volume is zero, then resumes', () => {
    const zeroAnchor = series([
      ['10', '8', '9', '0'],
      ['12', '10', '11', '3'],
    ]);
    // idx0: cumulative volume 0 → null (never 0/0).
    // idx1: (0 + 33) / 3 = 11.
    expectSeries(anchoredVwap(zeroAnchor, 0), [null, '11']);
  });

  it('does not null a zero-volume bar whose cumulative volume is positive', () => {
    const middleZero = series([
      ['10', '8', '9', '2'],
      ['12', '10', '11', '0'],
      ['14', '12', '13', '2'],
    ]);
    // idx1: (18 + 0) / 2 = 9 — the level is unchanged, not undefined.
    // idx2: (18 + 0 + 26) / 4 = 44 / 4 = 11.
    expectSeries(anchoredVwap(middleZero, 0), ['9', '9', '11']);
  });

  it('throws when the anchor is out of range', () => {
    expect(() => anchoredVwap(candles, -1)).toThrow(/out of range/);
    expect(() => anchoredVwap(candles, 3)).toThrow(/out of range/);
    expect(() => anchoredVwap([], 0)).toThrow(/out of range/);
    expect(() => anchoredVwap(candles, 1.5)).toThrow(/out of range/);
  });
});

/* ------------------------------------------------------------------ *
 * Swing structure
 * ------------------------------------------------------------------ */

describe('findSwingPoints', () => {
  it('finds exactly the known pivots of the synthetic zig-zag', () => {
    const { highs, lows } = findSwingPoints(ZIGZAG, 2, 2);
    expect(highs.map((p) => p.index)).toEqual([5, 11, 17, 23]);
    expect(render(highs.map((p) => p.price))).toEqual(['120', '120.04', '125', '130']);
    expect(lows.map((p) => p.index)).toEqual([2, 8, 14, 20]);
    expect(render(lows.map((p) => p.price))).toEqual(['99', '100', '100.04', '100.5']);
  });

  it('returns pivots in ascending index order and carries openTime through', () => {
    const { highs, lows } = findSwingPoints(ZIGZAG, 2, 2);
    for (let i = 1; i < highs.length; i += 1) {
      expect(highs[i]!.index).toBeGreaterThan(highs[i - 1]!.index);
    }
    for (let i = 1; i < lows.length; i += 1) {
      expect(lows[i]!.index).toBeGreaterThan(lows[i - 1]!.index);
    }
    expect(highs[0]!.openTime).toBe(openTimeAt(5));
    expect(lows[0]!.openTime).toBe(openTimeAt(2));
  });

  it('excludes the boundary bars where a window does not fit', () => {
    // The 20 high at index 1 is the series maximum, but with leftBars 2 there is
    // no left window, so it must NOT be reported.
    const candles = series([
      ['5', '1', '1'],
      ['20', '2', '2'],
      ['4', '1', '1'],
      ['3', '1', '0.5'],
      ['2', '0.5', '0.5'],
    ]);
    expect(findSwingPoints(candles, 1, 1).highs.map((p) => p.index)).toEqual([1]);
    expect(findSwingPoints(candles, 2, 2).highs).toEqual([]);
  });

  it('treats equal neighbouring highs as a shelf, not a pivot', () => {
    const candles = series([
      ['10', '5', '6'],
      ['12', '6', '7'],
      ['12', '6', '7'],
      ['10', '5', '6'],
      ['9', '4', '5'],
    ]);
    expect(findSwingPoints(candles, 1, 1).highs).toEqual([]);
  });

  it('reports nothing when the array is too short for both windows', () => {
    expect(findSwingPoints(series([['10', '8', '9']]), 2, 2)).toEqual({ highs: [], lows: [] });
    expect(findSwingPoints([], 2, 2)).toEqual({ highs: [], lows: [] });
  });

  it('with 0/0 windows reports every bar (the degenerate, documented case)', () => {
    const candles = series([
      ['10', '8', '9'],
      ['11', '9', '10'],
      ['12', '10', '11'],
    ]);
    expect(findSwingPoints(candles, 0, 0).highs.length).toBe(3);
    expect(findSwingPoints(candles, 0, 0).lows.length).toBe(3);
  });

  it('throws for negative or fractional windows', () => {
    expect(() => findSwingPoints(ZIGZAG, -1, 2)).toThrow(IndicatorError);
    expect(() => findSwingPoints(ZIGZAG, 2, 1.5)).toThrow(IndicatorError);
  });
});

describe('findImpulseLow / findImpulseHigh', () => {
  it('returns the most recent confirmed swing low inside the lookback', () => {
    const point = findImpulseLow(ZIGZAG, ZIGZAG.length);
    expect(point!.index).toBe(20);
    expect(point!.price.toFixed()).toBe('100.5');
    expect(point!.openTime).toBe(openTimeAt(20));
  });

  it('narrows the window with the lookback', () => {
    // 26 bars, lookback 7 → only pivots at index >= 19 qualify → the 20 low.
    expect(findImpulseLow(ZIGZAG, 7)!.index).toBe(20);
    // lookback 5 → index >= 21 → the most recent pivot (20) is outside.
    expect(findImpulseLow(ZIGZAG, 5)).toBeUndefined();
  });

  it('prefers the most recent of two pivots that share a price', () => {
    const tied = zigzag(
      ['99.00', '100.00', '100.50', '100.50'],
      ['120.00', '120.04', '125.00', '130.00'],
    );
    const { lows } = findSwingPoints(tied, 2, 2);
    // Two swing lows at 100.50, at indices 14 and 20.
    expect(lows.map((p) => p.index)).toEqual([2, 8, 14, 20]);
    expect(lows[2]!.price.equals(lows[3]!.price)).toBe(true);
    expect(findImpulseLow(tied, tied.length)!.index).toBe(20);
  });

  it('mirrors the logic for swing highs (shorts)', () => {
    expect(findImpulseHigh(ZIGZAG, ZIGZAG.length)!.index).toBe(23);
    expect(findImpulseHigh(ZIGZAG, ZIGZAG.length)!.price.toFixed()).toBe('130');
    // 26 bars, lookback 14 → pivots at index >= 12 → 17 and 23 → the later one.
    expect(findImpulseHigh(ZIGZAG, 14)!.index).toBe(23);
    expect(findImpulseHigh(ZIGZAG, 2)).toBeUndefined();
  });

  it('throws for a lookback below 1', () => {
    expect(() => findImpulseLow(ZIGZAG, 0)).toThrow(IndicatorError);
    expect(() => findImpulseHigh(ZIGZAG, 0)).toThrow(IndicatorError);
  });
});

describe('findBreakoutOrigin', () => {
  //  i   high   low   close   highest high of the preceding 2 bars
  //  0   10     9     9.5     —
  //  1   11     10    10.5    —
  //  2   11     10    10.4    max(10, 11) = 11     → no break
  //  3   12     11    11.5    max(11, 11) = 11     → closes above 11 → 'up'
  //  4   12     11    11.8    max(11, 12) = 12     → no break
  //  5   11.5   10    10.2    lowest low max(11, 11) = 11 → closes below 11 → 'down'
  const candles = series([
    ['10', '9', '9.5'],
    ['11', '10', '10.5'],
    ['11', '10', '10.4'],
    ['12', '11', '11.5'],
    ['12', '11', '11.8'],
    ['11.5', '10', '10.2'],
  ]);

  it('detects an upside breakout of the preceding range', () => {
    expect(findBreakoutOrigin(candles.slice(0, 4), 2)).toEqual({ index: 3, direction: 'up' });
  });

  it('detects a downside breakout of the preceding range', () => {
    expect(findBreakoutOrigin(candles.slice(0, 6), 2)).toEqual({ index: 5, direction: 'down' });
  });

  it('prefers the most recent breakout when there are several', () => {
    // Both index 3 (up) and index 5 (down) qualify; the later one is returned.
    expect(findBreakoutOrigin(candles, 2)!.index).toBe(5);
  });

  it('does not treat a close exactly on the prior extreme as a breakout', () => {
    const retest = series([
      ['10', '9', '9.5'],
      ['11', '10', '10.5'],
      ['11', '10', '10.4'],
      ['12', '11', '11'], // closes exactly at the 11 range top
    ]);
    expect(findBreakoutOrigin(retest, 2)).toBeUndefined();
  });

  it('returns undefined when there are not enough preceding bars', () => {
    expect(findBreakoutOrigin(candles.slice(0, 3), 2)).toBeUndefined();
    expect(findBreakoutOrigin(candles, 6)).toBeUndefined();
    expect(() => findBreakoutOrigin(candles, 0)).toThrow(IndicatorError);
  });
});

describe('structureLevels', () => {
  it('lists levels most-recent-first and merges levels within 0.05%', () => {
    const { support, resistance } = structureLevels(ZIGZAG, ZIGZAG.length);

    // Swing lows, newest first: 100.50, 100.04, 100.00, 99.00.
    //   100.04 vs 100.50 → 0.46/100.50 = 0.00458 > 0.0005  → keep both
    //   100.00 vs 100.04 → 0.04/100.04 = 0.00040 ≤ 0.0005  → 100.00 is dropped
    //     (the more recent 100.04 is kept)
    //    99.00 vs 100.50 → 0.0149 > 0.0005, vs 100.04 → 0.0104 > 0.0005 → keep
    expect(render(support)).toEqual(['100.5', '100.04', '99']);

    // Swing highs, newest first: 130.00, 125.00, 120.04, 120.00.
    //   120.00 vs 120.04 → 0.04/120.04 = 0.00033 ≤ 0.0005 → 120.00 is dropped.
    expect(render(resistance)).toEqual(['130', '125', '120.04']);
  });

  it('keeps levels further apart than 0.05%', () => {
    // 100.00 vs 100.06: 0.06 / 100.06 = 0.0005997 > 0.0005 → both survive.
    const wider = zigzag(
      ['100.00', '100.06', '100.06', '100.06'],
      ['120.00', '120.00', '120.00', '120.00'],
    );
    const { support } = structureLevels(wider, wider.length);
    expect(render(support)).toEqual(['100.06', '100']);
  });

  it('restricts levels to the lookback window', () => {
    const { support, resistance } = structureLevels(ZIGZAG, 10);
    // Only pivots at index >= 16 qualify: the 20 low and the 17/23 highs.
    expect(render(support)).toEqual(['100.5']);
    expect(render(resistance)).toEqual(['130', '125']);
  });

  it('returns empty lists when there is no confirmed structure', () => {
    expect(structureLevels(series([['10', '8', '9']]), 5)).toEqual({
      support: [],
      resistance: [],
    });
  });
});

describe('risingLows / fallingHighs', () => {
  it('is true when the last swing lows are strictly ascending', () => {
    // Swing lows: 99.00, 100.00, 100.04, 100.50 → the last three rise.
    expect(risingLows(ZIGZAG, 3)).toBe(true);
    expect(risingLows(ZIGZAG, 4)).toBe(true);
    expect(risingLows(ZIGZAG, 1)).toBe(true);
  });

  it('is false when the swing lows are not strictly ascending', () => {
    // Swing lows: 99.00, 100.50, 100.50, 100.00 → the last three are 100.50,
    // 100.50, 100.00: the tie and the drop both violate strictness.
    const mixed = zigzag(
      ['99.00', '100.50', '100.50', '100.00'],
      ['120.00', '120.04', '125.00', '130.00'],
    );
    expect(risingLows(mixed, 3)).toBe(false);
    expect(risingLows(mixed, 2)).toBe(false);
  });

  it('is false when there are fewer swings than requested', () => {
    expect(risingLows(ZIGZAG, 5)).toBe(false);
  });

  it('mirrors for falling highs', () => {
    const descending = zigzag(
      ['99.00', '100.00', '100.04', '100.50'],
      ['130.00', '125.00', '120.04', '120.00'],
    );
    expect(fallingHighs(descending, 3)).toBe(true);
    // The rising-highs fixture is ascending, so it must fail.
    expect(fallingHighs(ZIGZAG, 3)).toBe(false);
    expect(fallingHighs(ZIGZAG, 5)).toBe(false);
  });

  it('throws for a count below 1', () => {
    expect(() => risingLows(ZIGZAG, 0)).toThrow(IndicatorError);
    expect(() => fallingHighs(ZIGZAG, 0)).toThrow(IndicatorError);
  });
});

/* ------------------------------------------------------------------ *
 * Volatility
 * ------------------------------------------------------------------ */

describe('realizedVolatility', () => {
  const flat = series([
    ['100', '100', '100'],
    ['100', '100', '100'],
    ['100', '100', '100'],
    ['100', '100', '100'],
    ['100', '100', '100'],
  ]);

  it('is exactly zero on a constant series', () => {
    // Every return is ln(100/100) = 0, so variance 0 and sqrt(0) = 0.
    const vol = realizedVolatility(flat, 4);
    expect(vol).toBeDefined();
    expect(vol!.isZero()).toBe(true);
  });

  it('matches ln(2) on the 100 → 200 → 100 round trip', () => {
    // r1 = ln(200/100) = ln 2, r2 = ln(100/200) = -ln 2 → mean 0,
    // variance = (ln2² + ln2²) / 2 = ln2² → vol = ln 2.
    const roundTrip = series([
      ['100', '100', '100'],
      ['200', '200', '200'],
      ['100', '100', '100'],
    ]);
    const vol = realizedVolatility(roundTrip, 2)!;
    expect(vol.toFixed(20)).toBe(dec(2).ln().toFixed(20));
  });

  it('is zero for a single-return window (population divisor, no divide by zero)', () => {
    const roundTrip = series([
      ['100', '100', '100'],
      ['200', '200', '200'],
      ['100', '100', '100'],
    ]);
    // period 1 → uses the last two closes (200, 100); one return, mean = it, so
    // the deviation is 0. A sample divisor (period - 1 = 0) would be undefined.
    expect(realizedVolatility(roundTrip, 1)!.isZero()).toBe(true);
  });

  it('returns undefined when there is not enough data', () => {
    expect(realizedVolatility(flat, 5)).toBeUndefined(); // needs period + 1 closes
    expect(realizedVolatility([], 1)).toBeUndefined();
  });

  it('returns undefined when a close that feeds the window is non-positive', () => {
    const withZero = series([
      ['100', '100', '100'],
      ['0', '0', '0'],
      ['100', '100', '100'],
    ]);
    expect(realizedVolatility(withZero, 2)).toBeUndefined();

    const withNegative = series([
      ['100', '100', '100'],
      ['-5', '-5', '-5'],
      ['100', '100', '100'],
    ]);
    expect(realizedVolatility(withNegative, 2)).toBeUndefined();
  });

  it('throws for a period below 1', () => {
    expect(() => realizedVolatility(flat, 0)).toThrow(IndicatorError);
  });
});

/* ------------------------------------------------------------------ *
 * Extension guards
 * ------------------------------------------------------------------ */

describe('isExtendedFromEma', () => {
  it('is false exactly at the configured limit (the limit is inclusive)', () => {
    // |110 - 100| = 10 and 2 * 5 = 10 → not GREATER than the limit, so tradeable.
    expect(isExtendedFromEma(dec(110), dec(100), dec(5), dec(2))).toBe(false);
  });

  it('is true just beyond the limit', () => {
    expect(isExtendedFromEma(dec('110.0001'), dec(100), dec(5), dec(2))).toBe(true);
    expect(isExtendedFromEma(dec('89.9'), dec(100), dec(5), dec(2))).toBe(true);
  });

  it('is false when ATR is zero or negative instead of dividing into Infinity', () => {
    expect(isExtendedFromEma(dec(1000), dec(100), dec(0), dec(2))).toBe(false);
    expect(isExtendedFromEma(dec(1000), dec(100), dec(-1), dec(2))).toBe(false);
  });
});

describe('distanceInAtr', () => {
  it('measures the absolute distance in ATR units', () => {
    // |110 - 100| / 5 = 2.
    expect(distanceInAtr(dec(110), dec(100), dec(5))!.toFixed()).toBe('2');
    expect(distanceInAtr(dec(100), dec(110), dec(5))!.toFixed()).toBe('2');
  });

  it('returns undefined when ATR cannot be used as a unit', () => {
    expect(distanceInAtr(dec(110), dec(100), dec(0))).toBeUndefined();
    expect(distanceInAtr(dec(110), dec(100), dec(-3))).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * Window extremes and volume profile
 * ------------------------------------------------------------------ */

describe('highestHigh / lowestLow', () => {
  const candles = series([
    ['10', '9', '9.5'],
    ['14', '13', '13.5'],
    ['12', '11', '11.5'],
    ['16', '15', '15.5'],
    ['13', '12', '12.5'],
  ]);

  it('measures the last `count` bars only', () => {
    expect(highestHigh(candles, 2)!.toFixed()).toBe('16');
    expect(highestHigh(candles, 1)!.toFixed()).toBe('13');
    expect(highestHigh(candles, 5)!.toFixed()).toBe('16');
    expect(lowestLow(candles, 2)!.toFixed()).toBe('12');
    expect(lowestLow(candles, 5)!.toFixed()).toBe('9');
  });

  it('returns undefined rather than silently truncating an unfittable window', () => {
    expect(highestHigh(candles, 6)).toBeUndefined();
    expect(lowestLow(candles, 6)).toBeUndefined();
    expect(highestHigh(candles, 0)).toBeUndefined();
    expect(lowestLow(candles, -1)).toBeUndefined();
    expect(highestHigh([], 1)).toBeUndefined();
    expect(lowestLow([], 1)).toBeUndefined();
  });
});

describe('volumeProfile', () => {
  // low = 6, high = 14 → width 8, bucketCount 2 → bucket width 4.
  // Band midpoints: 8 and 12.
  //   bar0 tp = (10+6+8)/3   = 8   → bucket 0, vol 2
  //   bar1 tp = (14+10+12)/3 = 12  → bucket 1, vol 3
  //   bar2 tp = (14+14+14)/3 = 14  → floor((14-6)/4) = 2 → clamped to bucket 1
  const candles = series([
    ['10', '6', '8', '2'],
    ['14', '10', '12', '3'],
    ['14', '14', '14', '1'],
  ]);

  it('accumulates volume into price buckets and sorts by descending volume', () => {
    const profile = volumeProfile(candles, 2);
    expect(profile.map((b) => b.price.toFixed())).toEqual(['12', '8']);
    expect(profile.map((b) => b.volume.toFixed())).toEqual(['4', '2']);
  });

  it('clamps a bar at the very top of the range into the last bucket', () => {
    // Without the clamp, tp = 14 divides to bucket index 2 and the volume is lost.
    const withTop = series([['10', '6', '8', '2'], ['14', '14', '14', '5']]);
    const profile = volumeProfile(withTop, 2);
    expect(profile[0]!.volume.toFixed()).toBe('5');
    expect(profile[0]!.price.toFixed()).toBe('12');
  });

  it('reports each bucket midpoint as its price', () => {
    const single = volumeProfile(candles, 1);
    expect(single.length).toBe(1);
    expect(single[0]!.price.toFixed()).toBe('10'); // (6 + 14) / 2
    expect(single[0]!.volume.toFixed()).toBe('6'); // 2 + 3 + 1
  });

  it('returns [] for a zero-width range instead of dividing by zero', () => {
    expect(volumeProfile(series([['10', '10', '10', '5'], ['10', '10', '10', '5']]), 4)).toEqual([]);
  });

  it('returns [] for a non-positive bucket count and for no candles', () => {
    expect(volumeProfile(candles, 0)).toEqual([]);
    expect(volumeProfile(candles, -3)).toEqual([]);
    expect(volumeProfile([], 5)).toEqual([]);
  });

  it('is float-safe: ten 0.1 volumes sum to exactly 1, unlike number arithmetic', () => {
    // Range-setting bars carry no volume; ten identical 0.1 bars share one bucket.
    const tenths = series([
      ['8', '8', '8', '0'],
      ['14', '14', '14', '0'],
      ...Array.from({ length: 10 }, (): BarSpec => ['11', '11', '11', '0.1']),
    ]);
    const profile = volumeProfile(tenths, 1);
    expect(profile.length).toBe(1);
    expect(profile[0]!.volume.toFixed()).toBe('1');

    // The same sum in `number` does not come out at 1 — this is the defect the
    // whole module exists to avoid.
    let naive = 0;
    for (let i = 0; i < 10; i += 1) naive += 0.1;
    expect(String(naive)).toBe('0.9999999999999999');
    expect(profile[0]!.volume.equals(dec(1))).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Bar hygiene and purity
 * ------------------------------------------------------------------ */

describe('closedCandles', () => {
  it('keeps only final bars, preserving order, and returns a new array', () => {
    const mixed: CandleLike[] = [
      { openTime: openTimeAt(0), open: '9', high: '10', low: '8', close: '9', volume: '1', isFinal: true },
      { openTime: openTimeAt(1), open: '9', high: '11', low: '9', close: '10', volume: '1', isFinal: false },
      { openTime: openTimeAt(2), open: '10', high: '12', low: '10', close: '11', volume: '1', isFinal: true },
    ];
    const closed = closedCandles(mixed);
    expect(closed.map((c) => c.openTime)).toEqual([openTimeAt(0), openTimeAt(2)]);
    expect(closed).not.toBe(mixed);
    expect(mixed.length).toBe(3); // the input is untouched
  });
});

describe('purity', () => {
  it('never mutates the candle array or its bars', () => {
    const before = JSON.stringify(ZIGZAG);
    emaOnCandles(ZIGZAG, 9);
    atr(ZIGZAG, 14);
    anchoredVwap(ZIGZAG, 2);
    findSwingPoints(ZIGZAG, 2, 2);
    findImpulseLow(ZIGZAG, 10);
    findImpulseHigh(ZIGZAG, 10);
    findBreakoutOrigin(ZIGZAG, 5);
    structureLevels(ZIGZAG, 26);
    risingLows(ZIGZAG, 2);
    fallingHighs(ZIGZAG, 2);
    realizedVolatility(ZIGZAG, 5);
    highestHigh(ZIGZAG, 5);
    lowestLow(ZIGZAG, 5);
    volumeProfile(ZIGZAG, 6);
    closedCandles(ZIGZAG);
    expect(JSON.stringify(ZIGZAG)).toBe(before);
  });

  it('rejects non-finite candle fields instead of propagating NaN into a size', () => {
    const broken = series([['NaN', '8', '9']]);
    expect(() => emaOnCandles(broken, 1)).toThrow(IndicatorError);
    expect(() => atr(series([['Infinity', '8', '9']]), 1)).toThrow(IndicatorError);
  });
});
