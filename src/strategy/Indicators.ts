/**
 * Indicator primitives over closed candles.
 *
 * Every exported function here is PURE over `readonly Candle[]`: no clock, no
 * randomness, no I/O, and never a mutation of the caller's array. The strategy
 * re-scores the same candle window on every tick, so a helper that sorted or
 * spliced its input in place would corrupt history another layer is still
 * reading.
 *
 * Why Decimal everywhere
 * ----------------------
 * Candle OHLCV fields are decimal STRINGS on the wire (see `src/arcus/types.ts`).
 * A single `number` round-trip through `+`/`*` re-introduces binary floating
 * point: `0.1 + 0.1 + ... (ten times) = 0.9999999999999999`, not `1`. A drifted
 * moving average can flip an "is this pullback deep enough" comparison, and a
 * drifted ATR changes position size. Every price, volume and ratio below is
 * computed with Decimal.js; plain `number` appears only where the value is
 * genuinely a count — bar indices, window widths, bucket counts and periods.
 *
 * null vs undefined
 * -----------------
 *   `null`      "not yet defined". The series is still warming up: EMA/ATR
 *               padding before the seed, AVWAP bars before the anchor. These
 *               functions return an array of the SAME LENGTH as the input so
 *               `values[i]` always lines up with `candles[i]`. Returning a
 *               compacted array would force every caller to re-derive offsets,
 *               and an off-by-one there is invisible until it misprices an
 *               order.
 *   `undefined` "cannot be computed". The question itself has no answer: too
 *               little history, ATR <= 0, no swing inside the window. NEVER
 *               NaN: NaN propagates through position sizing and produces an
 *               order instead of a loud failure. A NaN that reaches a size is a
 *               real-money bug, so every division below is guarded and reports
 *               `undefined`/`null` instead of dividing.
 *
 * Closed bars only
 * ----------------
 * Indicators must be fed CLOSED bars. A forming bar's high/low/close still move,
 * so an EMA computed on it changes under the caller's feet and a freshly
 * "confirmed" swing can vanish before the order lands. Nothing here silently
 * drops forming bars — `isFinal` is a decision for the CALLER, and
 * `closedCandles()` is exported so that decision is one visible line at each
 * call site rather than an implicit assumption buried in an indicator. Every
 * swing helper additionally needs `rightBars` bars of *later* data to confirm a
 * pivot, which is only meaningful on closed bars.
 */

import type { Candle } from '../arcus/types';
import { Decimal, dAbs, dMax, dec } from '../util/decimal';

export class IndicatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IndicatorError';
  }
}

/**
 * Structural subset of `Candle` the indicators actually read.
 *
 * Callers routinely hold a warmed-up slice, a synthetic test fixture or a
 * partially-hydrated bar, none of which carry the market/timeframe metadata.
 * Taking the `Pick` keeps those callers compiling without casts and documents
 * precisely which fields an indicator is allowed to touch.
 */
export type CandleLike = Pick<
  Candle,
  'openTime' | 'open' | 'high' | 'low' | 'close' | 'volume' | 'isFinal'
>;

/** A confirmed pivot: a bar index into the array the caller passed in. */
export interface SwingPoint {
  /** Index into the candle array the pivot was found in. */
  index: number;
  /** Epoch microseconds of the pivot bar's open, copied from the candle. */
  openTime: number;
  /** The pivot's traded extreme: `high` for a swing high, `low` for a swing low. */
  price: Decimal;
}

/** Which candle field an EMA is computed over. */
export type EmaSource = 'close' | 'hlc3' | 'hl2';

/** Immutable Decimal constants. Decimal instances are never mutated in place. */
const ZERO = new Decimal(0);
const ONE = new Decimal(1);
const TWO = new Decimal(2);
const THREE = new Decimal(3);

/**
 * Two swing levels closer than this (as a fraction: 0.0005 = 0.05%) are the same
 * level to a human reading the chart. Treating them as distinct double-counts a
 * level and inflates any confluence score built from it.
 */
const LEVEL_DUPLICATE_TOLERANCE = new Decimal('0.0005');

/** Swing window used by the impulse / breakout / structure helpers. */
const STRUCTURE_WINDOW = 2;

/* ------------------------------------------------------------------ *
 * Input validation
 * ------------------------------------------------------------------ */

function assertPeriod(period: number, fn: string): void {
  if (!Number.isInteger(period) || period < 1) {
    throw new IndicatorError(`${fn}: period must be an integer >= 1, got ${period}`);
  }
}

function assertLookback(lookback: number, fn: string): void {
  if (!Number.isInteger(lookback) || lookback < 1) {
    throw new IndicatorError(`${fn}: lookback must be an integer >= 1, got ${lookback}`);
  }
}

function assertCount(count: number, fn: string): void {
  if (!Number.isInteger(count) || count < 1) {
    throw new IndicatorError(`${fn}: count must be an integer >= 1, got ${count}`);
  }
}

/**
 * Parse a candle field, refusing a non-finite result.
 *
 * `dec()` rejects empty/garbage strings but Decimal.js deliberately accepts
 * `"NaN"` and `"Infinity"`. Either would silently poison every downstream
 * comparison, so they are rejected at the boundary instead.
 */
function field(value: string, name: string): Decimal {
  const d = dec(value);
  if (!d.isFinite()) {
    throw new IndicatorError(`candle ${name} is not finite: ${JSON.stringify(value)}`);
  }
  return d;
}

/** Same guard for a plain indicator input (EMA series values). */
function input(value: Decimal | string, name: string): Decimal {
  const d = dec(value);
  if (!d.isFinite()) {
    throw new IndicatorError(`${name} input is not finite: ${String(value)}`);
  }
  return d;
}

/* ------------------------------------------------------------------ *
 * Price sources
 * ------------------------------------------------------------------ */

/** (high + low + close) / 3 — the usual proxy for the bar's traded value. */
function typicalPrice(candle: CandleLike): Decimal {
  return field(candle.high, 'high')
    .plus(field(candle.low, 'low'))
    .plus(field(candle.close, 'close'))
    .div(THREE);
}

function sourcePrice(candle: CandleLike, source: EmaSource): Decimal {
  const high = field(candle.high, 'high');
  const low = field(candle.low, 'low');
  switch (source) {
    case 'close':
      return field(candle.close, 'close');
    case 'hlc3':
      return high.plus(low).plus(field(candle.close, 'close')).div(THREE);
    case 'hl2':
      return high.plus(low).div(TWO);
  }
}

/* ------------------------------------------------------------------ *
 * Moving averages
 * ------------------------------------------------------------------ */

/**
 * Exponential moving average, seeded with the simple average of the first
 * `period` values.
 *
 *   seed = SMA(v[0..period-1])
 *   ema_t = v_t * k + ema_{t-1} * (1 - k),  k = 2 / (period + 1)
 *
 * The SMA seed is deliberate: an EMA started from `v[0]` carries a warm-up bias
 * that can take several multiples of `period` bars to decay, which on a 250-bar
 * history is long enough to point the trend filter the wrong way. Seeding from
 * the SMA makes the first defined value reproducible from the window alone.
 *
 * Returns an array of the SAME LENGTH as `values`. Indices `0 .. period-2` are
 * `null` ("not yet defined"); index `period-1` is the seed.
 *
 * Throws `IndicatorError` when `period < 1` (or is not an integer) or when
 * fewer than `period` values are supplied — silently returning all-nulls would
 * hide a caller that forgot to warm the window up.
 */
export function ema(
  values: readonly Decimal[] | readonly string[],
  period: number,
): (Decimal | null)[] {
  assertPeriod(period, 'ema');
  if (values.length < period) {
    throw new IndicatorError(`ema: need at least ${period} values, got ${values.length}`);
  }

  const out: (Decimal | null)[] = new Array<Decimal | null>(values.length).fill(null);

  let seed = ZERO;
  for (let i = 0; i < period; i += 1) seed = seed.plus(input(values[i]!, 'ema'));

  const count = dec(period);
  const k = TWO.div(count.plus(ONE));
  const oneMinusK = ONE.minus(k);

  let previous = seed.div(count);
  out[period - 1] = previous;

  for (let i = period; i < values.length; i += 1) {
    previous = input(values[i]!, 'ema').times(k).plus(previous.times(oneMinusK));
    out[i] = previous;
  }

  return out;
}

/**
 * EMA over candles, with the usual choice of source price.
 *
 *   close — the traded price (default; what the trend filter quotes)
 *   hlc3  — (high + low + close) / 3, the VWAP-style "typical price"
 *   hl2   — (high + low) / 2, the "median price" used by some channels
 *
 * Same length and same `null` padding as `ema()`; throws for the same reasons.
 */
export function emaOnCandles(
  candles: readonly CandleLike[],
  period: number,
  source: EmaSource = 'close',
): (Decimal | null)[] {
  return ema(
    candles.map((candle) => sourcePrice(candle, source)),
    period,
  );
}

/**
 * Difference between the last non-null value and the one `lookback` non-null
 * entries earlier. Positive = rising.
 *
 * "Non-null entries earlier" (not "indices earlier") is the point: the EMA's
 * warm-up nulls are skipped, so asking for a 3-bar slope right after the seed
 * compares the freshly defined values instead of returning `undefined`. Returns
 * `undefined` when fewer than `lookback + 1` values are defined, which is the
 * honest answer — an insufficient-history slope must not be reported as flat.
 */
export function emaSlope(
  values: readonly (Decimal | null)[],
  lookback = 3,
): Decimal | undefined {
  if (!Number.isInteger(lookback) || lookback < 1) {
    throw new IndicatorError(`emaSlope: lookback must be an integer >= 1, got ${lookback}`);
  }

  const defined: Decimal[] = [];
  for (const value of values) {
    if (value !== null) defined.push(value);
  }
  if (defined.length < lookback + 1) return undefined;

  const last = defined[defined.length - 1]!;
  const earlier = defined[defined.length - 1 - lookback]!;
  return last.minus(earlier);
}

/* ------------------------------------------------------------------ *
 * Volatility
 * ------------------------------------------------------------------ */

/**
 * True range of one bar.
 *
 *   TR = max(high - low, |high - prevClose|, |low - prevClose|)
 *
 * The two gap terms are why TR beats `high - low`: a bar that gaps through the
 * previous close has a real range wider than its own high-low, and a stop placed
 * at "1 ATR beyond structure" must account for that gap. For the first bar there
 * is no previous close, so TR degenerates to `high - low`.
 */
export function trueRange(prev: CandleLike | undefined, cur: CandleLike): Decimal {
  const high = field(cur.high, 'high');
  const low = field(cur.low, 'low');
  const range = high.minus(low);
  if (prev === undefined) return range;

  const prevClose = field(prev.close, 'close');
  return dMax(range, dAbs(high.minus(prevClose)), dAbs(low.minus(prevClose)));
}

/**
 * Average True Range with Wilder smoothing.
 *
 *   ATR[period-1] = SMA(TR[0..period-1])
 *   ATR_t        = (ATR_{t-1} * (period - 1) + TR_t) / period
 *
 * Wilder's recursion is NOT the EMA above: its smoothing constant is `1/period`,
 * not `2/(period+1)`, so it reacts more slowly than an EMA of the same length.
 * That is the point — ATR is a *risk* input (stop distance, position size,
 * "extended" checks), and Wilder's original definition is what every chart and
 * every other implementation quotes. Inventing a faster smoother here would make
 * our stop distance disagree with the number a human sees on the chart.
 *
 * Same shape as `ema`: an array of the input's length, `null` before the seed.
 * Throws for `period < 1` or fewer than `period` candles.
 */
export function atr(candles: readonly CandleLike[], period: number): (Decimal | null)[] {
  assertPeriod(period, 'atr');
  if (candles.length < period) {
    throw new IndicatorError(`atr: need at least ${period} candles, got ${candles.length}`);
  }

  const out: (Decimal | null)[] = new Array<Decimal | null>(candles.length).fill(null);
  const trueRanges = candles.map((candle, i) =>
    trueRange(i === 0 ? undefined : candles[i - 1], candle),
  );

  let previous = ZERO;
  for (let i = 0; i < period; i += 1) previous = previous.plus(trueRanges[i]!);

  const count = dec(period);
  const decay = count.minus(ONE);

  previous = previous.div(count);
  out[period - 1] = previous;

  for (let i = period; i < candles.length; i += 1) {
    previous = previous.times(decay).plus(trueRanges[i]!).div(count);
    out[i] = previous;
  }

  return out;
}

/**
 * Standard deviation of the close-to-close LOG returns over the last `period`
 * returns, returned PER BAR (not annualised — multiply by `sqrt(bars per year)`
 * at the reporting layer, where the timeframe is known).
 *
 *   r_t = ln(close_t / close_{t-1})
 *   vol = sqrt( sum((r_t - mean)^2) / period )
 *
 * Log returns are used because they are additive across bars and cannot go below
 * -1, and because `Decimal.ln()` keeps the whole computation exact instead of
 * bouncing through `Math.log` on a float.
 *
 * The population divisor (`period`, not `period - 1`) is deliberate: it is the
 * convention for realised volatility over a fixed window, and it keeps
 * `period = 1` well defined. A sample divisor would divide by zero there and
 * return a volatility of `undefined` for the shortest meaningful window.
 *
 * Returns `undefined` when fewer than `period + 1` candles are available, or when
 * any close that feeds the window is non-positive (the log ratio would be
 * meaningless / infinite).
 */
export function realizedVolatility(
  candles: readonly CandleLike[],
  period: number,
): Decimal | undefined {
  assertPeriod(period, 'realizedVolatility');
  if (candles.length < period + 1) return undefined;

  const start = candles.length - period - 1;
  const closes: Decimal[] = [];
  for (let i = start; i < candles.length; i += 1) {
    const close = field(candles[i]!.close, 'close');
    // Strictly positive: decimal.js calls `+0` "positive", and `ln(x/0)` would
    // be Infinity rather than a volatility.
    if (!close.greaterThan(ZERO)) return undefined;
    closes.push(close);
  }

  const returns: Decimal[] = [];
  for (let i = 1; i < closes.length; i += 1) {
    returns.push(closes[i]!.div(closes[i - 1]!).ln());
  }

  let sum = ZERO;
  for (const r of returns) sum = sum.plus(r);
  const mean = sum.div(dec(period));

  let sumSquares = ZERO;
  for (const r of returns) {
    const deviation = r.minus(mean);
    sumSquares = sumSquares.plus(deviation.times(deviation));
  }

  return sumSquares.div(dec(period)).sqrt();
}

/* ------------------------------------------------------------------ *
 * Anchored VWAP
 * ------------------------------------------------------------------ */

/**
 * Volume-weighted average price anchored at `anchorIndex`.
 *
 *   AVWAP_i = sum_{j=anchor..i}(typicalPrice_j * volume_j) / sum_{j=anchor..i}(volume_j)
 *
 * The anchor is the whole point of the tool: a VWAP restarted at the origin of
 * the current move measures the average price paid by everyone who traded *this
 * leg*, so it acts as the pullback zone / invalidation line for that leg. The
 * caller chooses the origin from `findImpulseLow` / `findImpulseHigh` /
 * `findBreakoutOrigin` below.
 *
 * Anchoring rules:
 *  - indices before the anchor are `null` ("not yet defined"); the array keeps
 *    the input's length so callers can index it in lockstep with the candles;
 *  - a bar whose CUMULATIVE volume is zero returns `null` rather than dividing
 *    (a zero-volume stretch has no price to average; `0/0` is not a level);
 *  - cumulative weighting never resets, so a later bar with volume still
 *    averages in everything since the anchor.
 *
 * Throws when `anchorIndex` is not an integer inside `[0, candles.length - 1]`.
 */
export function anchoredVwap(
  candles: readonly CandleLike[],
  anchorIndex: number,
): (Decimal | null)[] {
  if (!Number.isInteger(anchorIndex) || anchorIndex < 0 || anchorIndex >= candles.length) {
    throw new IndicatorError(
      `anchoredVwap: anchorIndex ${anchorIndex} is out of range for ${candles.length} candles`,
    );
  }

  const out: (Decimal | null)[] = new Array<Decimal | null>(candles.length).fill(null);

  let cumulativeNotional = ZERO;
  let cumulativeVolume = ZERO;

  for (let i = anchorIndex; i < candles.length; i += 1) {
    const candle = candles[i]!;
    const volume = field(candle.volume, 'volume');
    cumulativeNotional = cumulativeNotional.plus(typicalPrice(candle).times(volume));
    cumulativeVolume = cumulativeVolume.plus(volume);
    // `greaterThan(ZERO)`, NOT `isPositive()`: decimal.js reports `+0` as
    // positive, so `isPositive()` would divide by zero here and hand back NaN.
    // A non-positive total also flips the sign of the average, so the guard has
    // to be strict.
    out[i] = cumulativeVolume.greaterThan(ZERO) ? cumulativeNotional.div(cumulativeVolume) : null;
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * Market structure
 * ------------------------------------------------------------------ */

/**
 * Confirmed swing highs and lows.
 *
 * A swing high at `i` is a bar whose high is STRICTLY greater than the `leftBars`
 * highs before it and STRICTLY greater than the `rightBars` highs after it; a
 * swing low mirrors that on lows. Strictness is intentional: on equal highs there
 * is no pivot, just a flat shelf, and calling both bars pivots would invent two
 * levels where the market made one.
 *
 * Only `i` values where both windows fit are considered, so the final `rightBars`
 * bars can never be swings. That lag is the price of confirmation — a pivot is
 * only knowable after price has moved away from it — and it is why indicators
 * must be fed closed bars.
 *
 * Both lists are in ascending index order. `leftBars`/`rightBars` of 0 are
 * allowed and make that side's comparison vacuous (window 0/0 makes every bar a
 * swing), which is occasionally useful for scanning; negative or fractional
 * windows throw.
 */
export function findSwingPoints(
  candles: readonly CandleLike[],
  leftBars: number,
  rightBars: number,
): { highs: SwingPoint[]; lows: SwingPoint[] } {
  if (!Number.isInteger(leftBars) || leftBars < 0) {
    throw new IndicatorError(`findSwingPoints: leftBars must be an integer >= 0, got ${leftBars}`);
  }
  if (!Number.isInteger(rightBars) || rightBars < 0) {
    throw new IndicatorError(
      `findSwingPoints: rightBars must be an integer >= 0, got ${rightBars}`,
    );
  }

  const highs: SwingPoint[] = [];
  const lows: SwingPoint[] = [];

  for (let i = leftBars; i + rightBars < candles.length; i += 1) {
    const candle = candles[i]!;
    const high = field(candle.high, 'high');
    const low = field(candle.low, 'low');

    let isSwingHigh = true;
    let isSwingLow = true;

    for (let j = i - leftBars; j < i && (isSwingHigh || isSwingLow); j += 1) {
      const other = candles[j]!;
      if (!field(other.high, 'high').lessThan(high)) isSwingHigh = false;
      if (!field(other.low, 'low').greaterThan(low)) isSwingLow = false;
    }
    for (let j = i + 1; j <= i + rightBars && (isSwingHigh || isSwingLow); j += 1) {
      const other = candles[j]!;
      if (!field(other.high, 'high').lessThan(high)) isSwingHigh = false;
      if (!field(other.low, 'low').greaterThan(low)) isSwingLow = false;
    }

    if (isSwingHigh) highs.push({ index: i, openTime: candle.openTime, price: high });
    if (isSwingLow) lows.push({ index: i, openTime: candle.openTime, price: low });
  }

  return { highs, lows };
}

/**
 * Most recent confirmed swing low at or after `candles.length - lookback`, using
 * a 2/2 confirmation window. This is the natural AVWAP anchor for a long: the
 * origin of the impulse leg the pullback is retracing.
 *
 * The swings are detected over the WHOLE array and then filtered by index, rather
 * than detected inside a `lookback`-bar slice. Slicing would truncate the left
 * window of the earliest bars in the window and invent a pivot there. When two
 * swing lows share the same price the later bar wins, because the most recent
 * structure is the one current price has actually respected.
 *
 * Returns `undefined` when no confirmed swing low falls inside the window.
 */
export function findImpulseLow(
  candles: readonly CandleLike[],
  lookback: number,
): SwingPoint | undefined {
  assertLookback(lookback, 'findImpulseLow');
  const { lows } = findSwingPoints(candles, STRUCTURE_WINDOW, STRUCTURE_WINDOW);
  const firstIndex = candles.length - lookback;

  let best: SwingPoint | undefined;
  for (const point of lows) {
    // Ascending order, so the last assignment is the most recent match.
    if (point.index >= firstIndex) best = point;
  }
  return best;
}

/**
 * Mirror of `findImpulseLow` for shorts: the most recent confirmed swing high
 * (2/2 window) at or after `candles.length - lookback`.
 */
export function findImpulseHigh(
  candles: readonly CandleLike[],
  lookback: number,
): SwingPoint | undefined {
  assertLookback(lookback, 'findImpulseHigh');
  const { highs } = findSwingPoints(candles, STRUCTURE_WINDOW, STRUCTURE_WINDOW);
  const firstIndex = candles.length - lookback;

  let best: SwingPoint | undefined;
  for (const point of highs) {
    if (point.index >= firstIndex) best = point;
  }
  return best;
}

/**
 * Most recent bar that broke out of its `lookback`-bar range: a close strictly
 * above the highest high of the preceding `lookback` bars (`'up'`) or strictly
 * below the lowest low (`'down'`).
 *
 * This is the AVWAP anchor for a breakout continuation: the breakout bar is where
 * the position of everyone who chased the break was established. Scanning from
 * the newest bar backwards means "most recent" wins, which is what matters when a
 * market has broken out more than once — the level that still matters is the one
 * the current leg started from. A close exactly ON the prior extreme is not a
 * breakout; that bar merely retested the range top.
 *
 * Returns `undefined` when there are not enough preceding bars to define a range.
 */
export function findBreakoutOrigin(
  candles: readonly CandleLike[],
  lookback: number,
): { index: number; direction: 'up' | 'down' } | undefined {
  assertLookback(lookback, 'findBreakoutOrigin');
  if (candles.length <= lookback) return undefined;

  for (let i = candles.length - 1; i >= lookback; i -= 1) {
    let highest = field(candles[i - lookback]!.high, 'high');
    let lowest = field(candles[i - lookback]!.low, 'low');
    for (let j = i - lookback + 1; j < i; j += 1) {
      const high = field(candles[j]!.high, 'high');
      const low = field(candles[j]!.low, 'low');
      if (high.greaterThan(highest)) highest = high;
      if (low.lessThan(lowest)) lowest = low;
    }

    const close = field(candles[i]!.close, 'close');
    if (close.greaterThan(highest)) return { index: i, direction: 'up' };
    if (close.lessThan(lowest)) return { index: i, direction: 'down' };
  }

  return undefined;
}

/**
 * Support and resistance levels derived from swings, most recent first.
 *
 * Both lists are ordered by recency (the most recent pivot is `[0]`) because a
 * level that price touched 20 bars ago is more relevant than one from 200 bars
 * ago, and callers walk the list in that order.
 *
 * De-duplication: two levels within 0.05% of each other are the same level to a
 * human reading the chart (support at 100.00 and 100.04), so the later one is
 * kept and the earlier dropped. Distance is measured relative to the larger
 * magnitude of the pair, which is symmetric and cannot divide by zero when one
 * level is 0 (only two zeros collapse). Dropping the SHADOWED (older) level
 * rather than averaging is deliberate: averaging invents a price that no bar
 * actually printed.
 */
export function structureLevels(
  candles: readonly CandleLike[],
  lookback: number,
): { support: Decimal[]; resistance: Decimal[] } {
  assertLookback(lookback, 'structureLevels');
  const { highs, lows } = findSwingPoints(candles, STRUCTURE_WINDOW, STRUCTURE_WINDOW);
  const firstIndex = candles.length - lookback;

  const inWindow = (point: SwingPoint): boolean => point.index >= firstIndex;

  return {
    support: dedupeMostRecentFirst(lows.filter(inWindow)),
    resistance: dedupeMostRecentFirst(highs.filter(inWindow)),
  };
}

function dedupeMostRecentFirst(points: readonly SwingPoint[]): Decimal[] {
  const kept: Decimal[] = [];
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const price = points[i]!.price;
    if (kept.some((existing) => withinLevelTolerance(price, existing))) continue;
    kept.push(price);
  }
  return kept;
}

function withinLevelTolerance(a: Decimal, b: Decimal): boolean {
  const denominator = dMax(dAbs(a), dAbs(b));
  if (denominator.isZero()) return true; // both levels are exactly 0
  return dAbs(a.minus(b)).div(denominator).lessThanOrEqualTo(LEVEL_DUPLICATE_TOLERANCE);
}

/**
 * True when the last `count` confirmed swing lows (2/2 window) are STRICTLY
 * ascending in price — the "higher lows" leg of an uptrend.
 *
 * Returns false when fewer than `count` swing lows exist: an unconfirmed
 * structure must not be read as a bullish one. Throws for `count < 1`.
 */
export function risingLows(candles: readonly CandleLike[], count: number): boolean {
  assertCount(count, 'risingLows');
  const { lows } = findSwingPoints(candles, STRUCTURE_WINDOW, STRUCTURE_WINDOW);
  if (lows.length < count) return false;

  const tail = lows.slice(lows.length - count);
  for (let i = 1; i < tail.length; i += 1) {
    if (!tail[i]!.price.greaterThan(tail[i - 1]!.price)) return false;
  }
  return true;
}

/**
 * Mirror of `risingLows`: true when the last `count` confirmed swing highs are
 * STRICTLY descending — the "lower highs" leg of a downtrend.
 */
export function fallingHighs(candles: readonly CandleLike[], count: number): boolean {
  assertCount(count, 'fallingHighs');
  const { highs } = findSwingPoints(candles, STRUCTURE_WINDOW, STRUCTURE_WINDOW);
  if (highs.length < count) return false;

  const tail = highs.slice(highs.length - count);
  for (let i = 1; i < tail.length; i += 1) {
    if (!tail[i]!.price.lessThan(tail[i - 1]!.price)) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * Distance / extension checks
 * ------------------------------------------------------------------ */

/**
 * "Too far to chase": true when price sits more than `maxExtensionAtr` ATRs away
 * from its EMA.
 *
 * The comparison is strict (`>`), so a price exactly at the configured limit is
 * still tradeable. An ATR of zero or below (a perfectly flat window, or a data
 * gap) returns false rather than a meaningless `Infinity`: the guard is the
 * difference between "no volatility information" and "infinitely extended",
 * and only one of those should block a trade.
 *
 * The guard is `greaterThan(ZERO)` rather than `isPositive()` because decimal.js
 * treats `+0` as positive — the naive check would let a zero ATR through and
 * report a perfectly flat market as infinitely extended.
 */
export function isExtendedFromEma(
  price: Decimal,
  emaValue: Decimal,
  atrValue: Decimal,
  maxExtensionAtr: Decimal,
): boolean {
  const atr = dec(atrValue);
  if (!atr.greaterThan(ZERO)) return false;
  return dAbs(dec(price).minus(dec(emaValue))).greaterThan(dec(maxExtensionAtr).times(atr));
}

/**
 * Distance between two prices expressed in ATRs, or `undefined` when ATR is zero
 * or negative (there is no unit to measure with). Callers use this for the
 * pullback-zone test and for logging; `undefined` must be treated as "unknown",
 * never as "close enough". The `greaterThan(ZERO)` guard matters: decimal.js
 * reports `+0` as positive, so `isPositive()` would divide by zero and yield
 * Infinity.
 */
export function distanceInAtr(
  a: Decimal,
  b: Decimal,
  atrValue: Decimal,
): Decimal | undefined {
  const atr = dec(atrValue);
  if (!atr.greaterThan(ZERO)) return undefined;
  return dAbs(dec(a).minus(dec(b))).div(atr);
}

/* ------------------------------------------------------------------ *
 * Window extremes
 * ------------------------------------------------------------------ */

/**
 * Highest high of the last `count` bars, or `undefined` when the window does not
 * fit (`count < 1` or fewer than `count` bars available). Truncating to whatever
 * history exists would silently answer a different question than the caller
 * asked, so "not enough bars" is reported as `undefined`.
 */
export function highestHigh(
  candles: readonly CandleLike[],
  count: number,
): Decimal | undefined {
  if (!Number.isInteger(count) || count < 1) return undefined;
  if (candles.length < count) return undefined;

  let best = field(candles[candles.length - count]!.high, 'high');
  for (let i = candles.length - count + 1; i < candles.length; i += 1) {
    const high = field(candles[i]!.high, 'high');
    if (high.greaterThan(best)) best = high;
  }
  return best;
}

/** Lowest low of the last `count` bars. Mirror of `highestHigh`, same guard. */
export function lowestLow(
  candles: readonly CandleLike[],
  count: number,
): Decimal | undefined {
  if (!Number.isInteger(count) || count < 1) return undefined;
  if (candles.length < count) return undefined;

  let best = field(candles[candles.length - count]!.low, 'low');
  for (let i = candles.length - count + 1; i < candles.length; i += 1) {
    const low = field(candles[i]!.low, 'low');
    if (low.lessThan(best)) best = low;
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * Volume profile
 * ------------------------------------------------------------------ */

/**
 * Volume bucketed by price, sorted by DESCENDING volume — the "recent
 * high-volume area" input used to sanity-check entries against where the market
 * actually traded.
 *
 * The range `[lowest low, highest high]` is split into `bucketCount` equal
 * buckets and each bar's volume is added to the bucket containing its typical
 * price `(high + low + close) / 3`. Each returned bucket carries the MIDPOINT of
 * its price band as `price`, which is the representative level a caller would
 * quote or snap to a tick.
 *
 * Every bucket is returned, including empty ones, so the shape of the profile is
 * complete; consumers that want the traded area filter on `volume > 0` (or just
 * take `[0]`, which is the highest-volume bucket). Ties are broken by bucket
 * index so the output is deterministic.
 *
 * Degenerate inputs return `[]` rather than throwing: a zero-width range (every
 * bar at the same price) has no profile, `bucketCount < 1` has no buckets, and
 * an empty candle list has nothing to weigh. These are "no information"
 * situations, not caller errors.
 */
export function volumeProfile(
  candles: readonly CandleLike[],
  bucketCount: number,
): { price: Decimal; volume: Decimal }[] {
  if (!Number.isInteger(bucketCount) || bucketCount < 1) return [];
  if (candles.length === 0) return [];

  const low = lowestLow(candles, candles.length);
  const high = highestHigh(candles, candles.length);
  if (low === undefined || high === undefined) return [];

  const width = high.minus(low);
  // `greaterThan(ZERO)`, not `isPositive()`: decimal.js reports `+0` as positive,
  // and a zero width would make every bucket boundary collapse onto one price.
  if (!width.greaterThan(ZERO)) return [];

  const bucketWidth = width.div(dec(bucketCount));
  if (!bucketWidth.greaterThan(ZERO)) return [];

  const volumes: Decimal[] = new Array<Decimal>(bucketCount).fill(ZERO);
  for (const candle of candles) {
    const index = bucketIndexOf(typicalPrice(candle), low, bucketWidth, bucketCount);
    volumes[index] = volumes[index]!.plus(field(candle.volume, 'volume'));
  }

  const buckets = volumes.map((volume, index) => ({
    index,
    // Band midpoint: low + width * index + width / 2.
    price: low.plus(bucketWidth.times(index)).plus(bucketWidth.div(TWO)),
    volume,
  }));

  buckets.sort((a, b) => b.volume.comparedTo(a.volume) || a.index - b.index);

  return buckets.map(({ price, volume }) => ({ price, volume }));
}

/**
 * Bucket containing `value`, with a boundary fix-up.
 *
 * `floor((value - low) / bucketWidth)` is the direct answer, but the division is
 * rounded to 40 significant digits, so a value that sits exactly on a bucket edge
 * can land one bucket low. The fix-up walks over the edges recomputed from the
 * SAME rounded `bucketWidth` that defines the buckets, so the assignment is
 * self-consistent with the boundaries actually reported.
 */
function bucketIndexOf(
  value: Decimal,
  low: Decimal,
  bucketWidth: Decimal,
  bucketCount: number,
): number {
  let index = value.minus(low).div(bucketWidth).floor().toNumber();

  while (
    index + 1 < bucketCount &&
    low.plus(bucketWidth.times(index + 1)).lessThanOrEqualTo(value)
  ) {
    index += 1;
  }
  while (index > 0 && low.plus(bucketWidth.times(index)).greaterThan(value)) {
    index -= 1;
  }

  if (index < 0) return 0;
  if (index >= bucketCount) return bucketCount - 1;
  return index;
}

/* ------------------------------------------------------------------ *
 * Bar hygiene
 * ------------------------------------------------------------------ */

/**
 * The only bars an indicator may consume: those the engine has marked final.
 *
 * A forming bar is revised on every update (`isFinal: false`), so an EMA over it
 * changes value between the decision and the order, and a "confirmed" swing can
 * disappear. Filtering explicitly at the call site makes the choice visible
 * instead of leaving it to a default inside an indicator.
 *
 * Generic in the element type so a `readonly Candle[]` slice comes back as
 * `Candle[]` with the market/timeframe metadata intact.
 */
export function closedCandles<T extends CandleLike>(candles: readonly T[]): T[] {
  return candles.filter((candle) => candle.isFinal === true);
}
