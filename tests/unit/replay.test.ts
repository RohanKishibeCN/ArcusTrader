/**
 * Replay / backtester tests.
 *
 * The replay exists to be believed, so this suite is built around three ideas:
 *
 *  1. DETERMINISTIC SYNTHETIC SERIES. Every candle here is either a hand-written
 *     array or produced by a seeded, local PRNG — never `Math.random()`. A series
 *     that changes between runs cannot pin a PnL, and a fixture that changes
 *     cannot pin a regression.
 *  2. HAND-WORKED ARITHMETIC. The winning fixture is designed so the numbers are
 *     checkable on a napkin: a constant 2.00 true range on every structure bar
 *     makes the structure ATR exactly 2, which makes the structural stop 101, the
 *     buffered stop 99, the risk 6, the entry 105 and the targets 111 / 117 — all
 *     exact tick multiples. Risk 60 bps of 10000 over a 6.00 stop distance is
 *     exactly 10 units, already on the 0.01 step grid, so no rounding interferes.
 *  3. THE CONSERVATIVE RULES ARE PINNED, not just the happy path: no lookahead, no
 *     fill on the signal bar, the stop wins an ambiguous bar, an unfilled ALO
 *     expires, funding is charged even when the rate is in our favour, and Points
 *     never reaches a PnL figure.
 *
 * Time layout: a 4h trend series and a 1h structure series start at T0; the 15m
 * trigger series starts 60 hours later, so at the signal bar there are 15 closed
 * trend bars and 45 closed structure bars — enough for `evaluateStrategy`'s
 * history gates — while the trigger window is still only six bars long.
 */

import { describe, expect, it } from 'vitest';
import { Decimal, dec } from '../../src/util/decimal';
import type { Candle, MarketCategory, MarketInfo } from '../../src/arcus/types';
import { mirrorCandles } from '../../src/strategy/PullbackStrategy';
import type { StrategyConfig } from '../../src/strategy/PullbackStrategy';
import { estimateCost } from '../../src/strategy/CostModel';
import {
  deterministicUnitHash,
  maxDrawdownOf,
  replayMarkets,
  type ReplayConfig,
  type ReplayMarketInput,
  type ReplayResult,
} from '../../tools/replay';

/* ------------------------------------------------------------------ *
 * Fixture: deterministic series
 * ------------------------------------------------------------------ */

/** Epoch microseconds of the first trend bar. Fixed so nothing here can drift. */
const T0 = 1_700_000_000_000_000;

const TREND_US = 14_400_000_000; // 4h
const STRUCT_US = 3_600_000_000; // 1h
const TRIG_US = 900_000_000; // 15m

/** The trigger series starts 60h after the trend/structure series. */
const TRIG_START = T0 + 60 * 3_600_000_000;

/** `[open, high, low, close]` as decimal strings. */
type BarSpec = readonly [string, string, string, string];

function candle(
  marketId: number,
  timeframe: string,
  openTime: number,
  [open, high, low, close]: BarSpec,
  volume = '10',
): Candle {
  return {
    marketDisplayName: `SYN${marketId}`,
    marketId,
    timeframe,
    openTime,
    open,
    high,
    low,
    close,
    volume,
    takerBuyVolume: '0',
    notionalVolume: '0',
    takerBuyNotionalVolume: '0',
    tradeCount: 1,
    isFinal: true,
  };
}

/**
 * Trend closes: a rise to 110, then a shallow pullback that leaves EMA3 > EMA5 >
 * EMA8 with a non-negative EMA5 slope (both asserted by the tests below).
 *
 * Every bar spans exactly 2.00 and the previous close always sits inside the
 * current bar's range, so the true range is 2.00 on every bar and the trend ATR is
 * exactly 2 regardless of the period — no Wilder smoothing artefact to reason
 * about.
 */
const TREND_CLOSES = [
  '100', '101', '102', '103', '104', '105', '106', '107', '108', '109',
  '110', '109.5', '109', '109.5', '109', '108', '108', '108', '108', '108',
];

function trendCandles(marketId: number): Candle[] {
  return TREND_CLOSES.map((close, k) => {
    const c = dec(close);
    return candle(marketId, '4h', T0 + k * TREND_US, [
      close,
      c.plus(1).toFixed(),
      c.minus(1).toFixed(),
      close,
    ]);
  });
}

/**
 * Structure series: a V that bottoms at index 20 with low 101.00 and then rises
 * monotonically, so the most recent confirmed swing low inside the final 30-bar
 * window is exactly 101.00 — which is what puts the buffered stop at 99.00. A
 * monotone rise after the bottom can never produce a newer swing low, so the
 * support level cannot drift during the replay.
 *
 * Every bar spans 2.00 with the previous close inside the range, so the structure
 * ATR (stop buffer, chase limit, pullback band) is exactly 2.00.
 */
function structureCandles(marketId: number): Candle[] {
  const bars: Candle[] = [];
  for (let i = 0; i < 45; i += 1) {
    const mid =
      i <= 20 ? dec(112).minus(dec('0.5').times(i)) : dec(102).plus(dec('0.5').times(i - 20));
    const close = mid.toFixed();
    bars.push(
      candle(marketId, '1h', T0 + i * STRUCT_US, [
        close,
        mid.plus(1).toFixed(),
        mid.minus(1).toFixed(),
        close,
      ]),
    );
  }
  return bars;
}

/**
 * The base trigger series — the winning long.
 *
 *  bar 0-4  bearish bars drifting into the pullback (the reversal gate needs a
 *           bullish trigger bar, so none of these can fire)
 *  bar 5    the signal: bullish, closes above the zone midpoint at 105.00, and
 *           makes a high above bar 4's
 *  bar 6    the fill: opens at 105.20 (above the 105.00 limit, so NOT crossing)
 *           and trades down to 104.20, touching the limit as a maker
 *  bar 7    TP1 at 111.00 for the first half; its 103.50 low is the first-bar
 *           adverse excursion: (105 - 103.50) / 6 = 0.25 R
 *  bar 8    TP2 at 117.00 for the runner
 *  bar 9    flat-out bar after the trade closes
 *
 * EVERY bar from 6 onwards is bearish (close below open). That matters: whenever
 * the strategy is evaluated on one of those bars — after a rejected signal, or
 * after the TTL expires, or after a position closes — the reversal gate must
 * refuse it. A fixture whose tail can re-fire produces a second trade and makes
 * every count in this file ambiguous.
 */
const BASE_BARS: readonly BarSpec[] = [
  ['106.5', '106.6', '105.5', '105.8'],
  ['105.8', '106.0', '105.0', '105.2'],
  ['105.2', '105.4', '104.6', '104.8'],
  ['104.8', '105.0', '104.2', '104.4'],
  ['104.4', '104.9', '103.9', '104.1'],
  ['104.5', '105.4', '104.0', '105.0'],
  ['105.2', '105.5', '104.2', '104.8'],
  ['105.3', '111.5', '103.5', '105.0'],
  ['110.5', '117.5', '109.5', '110.0'],
  ['106.2', '106.6', '105.8', '105.9'],
];

/** Build the trigger series, replacing the named bar indices with overrides. */
function triggerCandles(
  marketId: number,
  overrides: Record<number, BarSpec> = {},
  count = BASE_BARS.length,
): Candle[] {
  const specs: BarSpec[] = [];
  for (let i = 0; i < count; i += 1) {
    specs.push(overrides[i] ?? BASE_BARS[i]!);
  }
  return specs.map((spec, i) => candle(marketId, '15m', TRIG_START + i * TRIG_US, spec));
}

/** Epoch ms of trigger bar `i`'s open. */
function triggerMs(i: number): number {
  return Math.floor((TRIG_START + i * TRIG_US) / 1000);
}

function marketOf(params: {
  marketId: number;
  category: MarketCategory;
  isOutsideRth?: boolean;
  tickSize?: string;
  stepSize?: string;
  minOrderNotional?: string;
}): MarketInfo {
  return {
    marketDisplayName: `SYN${params.marketId}`,
    marketId: params.marketId,
    status: 'ONLINE',
    baseAsset: 'SYN',
    quoteAsset: 'USD',
    tickSize: params.tickSize ?? '0.01',
    stepSize: params.stepSize ?? '0.01',
    tickTiers: [],
    minOrderNotional: params.minOrderNotional ?? '0',
    minOrderSize: '0',
    maxOrderSize: '1000',
    isOutsideRth: params.isOutsideRth ?? false,
    type: 'PERPETUAL',
    category: params.category,
  };
}

/**
 * Strategy configuration tuned for the synthetic fixture.
 *
 * `pullbackZoneAtr: 1` with an ATR of 2 gives a +/-2.00 band, putting the zone at
 * [99, 109] with a midpoint of 104.00 — so the 105.00 signal closes comfortably
 * above the midpoint that `evaluateTrigger` demands, and the entry becomes
 * `min(zone.upper, barClose)` = 105.00 exactly.
 */
const STRATEGY: StrategyConfig = {
  emaFastPeriod: 3,
  emaMidPeriod: 5,
  emaSlowPeriod: 8,
  atrPeriod: 5,
  minHistoryBars: 12,
  stopAtrBuffer: dec('1'),
  maxExtensionAtr: dec('10'),
  maxChaseAtr: dec('3'),
  pullbackZoneAtr: dec('1'),
  tp1RMultiple: dec('1'),
  tp1ClosePct: dec('50'),
  tp2RMultiple: dec('2'),
  structureLookback: 30,
  swingLeftBars: 2,
  swingRightBars: 2,
};

/** Base configuration: 60 bps of 10000 over a 6.00 stop is exactly 10 units. */
function configWith(overrides: Partial<ReplayConfig> = {}): ReplayConfig {
  return {
    strategy: STRATEGY,
    cost: {
      makerFeeBps: dec('2'),
      takerFeeBps: dec('5'),
      assumedSlippageBps: dec('1'),
      safetyBufferBps: dec('0'),
    },
    initialEquity: dec('10000'),
    riskBps: dec('60'),
    maxNotionalPct: dec('30'),
    maxLeverage: dec('2'),
    entryTtlBars: 2,
    projectableFraction: dec('0.5'),
    ...overrides,
  };
}

function inputOf(params: {
  marketId: number;
  category?: MarketCategory;
  isOutsideRth?: boolean;
  overrides?: Record<number, BarSpec>;
  count?: number;
  structure?: Candle[];
}): ReplayMarketInput {
  const market = marketOf({
    marketId: params.marketId,
    category: params.category ?? 'CRYPTO',
    isOutsideRth: params.isOutsideRth ?? false,
  });
  return {
    market,
    trendCandles: trendCandles(params.marketId),
    structureCandles: params.structure ?? structureCandles(params.marketId),
    triggerCandles: triggerCandles(params.marketId, params.overrides ?? {}, params.count),
  };
}

/** The winning long fixture. */
function winInput(marketId = 1): ReplayMarketInput {
  return inputOf({ marketId });
}

/** The same setup, but bar 7 wipes straight through the 99.00 stop. */
function lossInput(marketId = 2): ReplayMarketInput {
  return inputOf({ marketId, overrides: { 7: ['105.0', '105.3', '99.0', '99.2'] } });
}

/** The same setup, mirrored through a fixed price axis into a short. */
function mirroredInput(axis = '108', marketId = 7): ReplayMarketInput {
  const a = dec(axis);
  const base = inputOf({ marketId });
  return {
    market: base.market,
    trendCandles: mirrorCandles(base.trendCandles, a),
    structureCandles: mirrorCandles(base.structureCandles, a),
    triggerCandles: mirrorCandles(base.triggerCandles, a),
  };
}

function run(markets: readonly ReplayMarketInput[], overrides: Partial<ReplayConfig> = {}): ReplayResult {
  return replayMarkets({ markets, config: configWith(overrides) });
}

/* ------------------------------------------------------------------ *
 * Assertion helpers
 * ------------------------------------------------------------------ */

/** Every numeric-looking string in an object, with its path, for a finiteness scan. */
function numericStrings(value: unknown, path: string, out: { path: string; value: string }[]): void {
  if (typeof value === 'number') {
    out.push({ path, value: String(value) });
    return;
  }
  if (typeof value === 'string') {
    if (/^-?\d/.test(value)) out.push({ path, value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => numericStrings(item, `${path}[${index}]`, out));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) numericStrings(item, `${path}.${key}`, out);
  }
}

/**
 * A tiny seeded PRNG (mulberry32).
 *
 * It exists to make the point that this suite contains no unseeded randomness: a
 * fixture that changes between runs cannot pin a number.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ *
 * The winning long, with every figure hand-worked
 * ------------------------------------------------------------------ */

describe('replayMarkets: hand-built winning long', () => {
  it('produces exactly one trade from the fixture', () => {
    const result = run([winInput()]);
    expect(result.trades).toHaveLength(1);
    expect(result.metrics.tradeCount).toBe(1);
    expect(result.metrics.signals.signalsFired).toBe(1);
    expect(result.metrics.signals.entriesFilled).toBe(1);
    expect(result.metrics.signals.evaluationErrors).toBe(0);
  });

  it('fills the limit on the first bar after the signal, never on the signal bar', () => {
    const trade = run([winInput()]).trades[0]!;
    // The signal bar is index 5; the fill is index 6. Same-bar fills would be
    // lookahead, because the order is only placed once bar 5 has closed.
    expect(trade.entryTimeMs).toBe(triggerMs(6));
    expect(trade.entryTimeMs).toBeGreaterThan(triggerMs(5));
  });

  it('books the hand-computed prices, quantity and stop', () => {
    const trade = run([winInput()]).trades[0]!;
    // entry  = min(zone.upper 109, barClose 105) = 105.00
    // stop   = structural support 101.00 - ATR 2.00 * buffer 1 = 99.00
    // risk   = 105 - 99 = 6.00;  TP1 = 105 + 6 = 111;  TP2 = 105 + 12 = 117
    // size   = (10000 * 60/10000) / 6 = 10.00 units, already on the 0.01 grid.
    expect(trade.direction).toBe('long');
    expect(trade.entryPrice).toBe('105');
    expect(trade.stopPrice).toBe('99');
    expect(trade.quantity).toBe('10');
    expect(trade.exitPrice).toBe('114'); // (5 * 111 + 5 * 117) / 10
    expect(trade.exitReason).toBe('target2');
  });

  it('books the hand-computed gross, fees, slippage and net', () => {
    const trade = run([winInput()]).trades[0]!;
    // gross    = 5 * (111 - 105) + 5 * (117 - 105) = 30 + 60          = 90
    // entry fee= 10 * 105 * 2bps       = 1050 * 0.0002               = 0.21
    // TP1 fee  = 5  * 111 * 5bps       =  555 * 0.0005               = 0.2775
    // TP2 fee  = 5  * 117 * 5bps       =  585 * 0.0005               = 0.2925
    // fees                                                           = 0.78
    // slippage = (555 + 585) * 1bp, exits only (the maker entry did
    //            not cross the spread)                               = 0.114
    // funding  = no fundingRatePerHour supplied                      = 0
    // net      = 90 - 0.78 - 0.114 - 0                                 = 89.106
    expect(trade.grossPnl).toBe('90');
    expect(trade.fees).toBe('0.78');
    expect(trade.slippage).toBe('0.114');
    expect(trade.funding).toBe('0');
    expect(trade.netPnl).toBe('89.106');
  });

  it('reports the R multiple against the initial risk', () => {
    const trade = run([winInput()]).trades[0]!;
    // risk amount = 6.00 per unit * 10 units = 60;  R = 89.106 / 60 = 1.4851
    expect(trade.rMultiple).toBe('1.4851');
  });

  it('scales out at TP1 then leaves the runner to TP2', () => {
    const result = run([winInput()]);
    const trade = result.trades[0]!;
    // The record aggregates both legs; the authoritative evidence for the
    // scale-out is the exit timestamp (bar 8, not bar 7) and the averaged price.
    expect(trade.exitTimeMs).toBe(triggerMs(8));
    expect(trade.exitPrice).toBe('114');
  });

  it('measures adverse selection on the first bar after the fill', () => {
    const trade = run([winInput()]).trades[0]!;
    // bar 7 low = 103.50; (105.00 - 103.50) / 6.00 = 0.25 R
    expect(trade.adverseSelectionR).toBe('0.25');
    expect(run([winInput()]).metrics.averageAdverseSelectionR).toBe('0.25');
  });

  it('reports holding time in milliseconds and builds the equity curve', () => {
    const result = run([winInput()]);
    const trade = result.trades[0]!;
    // fill bar 6 -> final exit bar 8 = 2 * 15 minutes = 1_800_000 ms
    expect(trade.exitTimeMs - trade.entryTimeMs).toBe(1_800_000);
    expect(result.metrics.averageHoldingMs).toBe('1800000');
    expect(result.equityCurve).toEqual([
      { atMs: triggerMs(0), equity: '10000' },
      { atMs: triggerMs(8), equity: '10089.106' }, // 10000 + 89.106
    ]);
  });

  it('records maker intent and the maker outcome for an ALO entry', () => {
    const trade = run([winInput()]).trades[0]!;
    // The strategy only ever emits a post-only limit, so the INTENT is maker; the
    // outcome is maker because bar 6's open (105.20) did not cross the limit.
    expect(trade.makerEntry).toBe(true);
    expect(trade.filledAsMaker).toBe(true);
    expect(run([winInput()]).metrics.makerFillRate).toBe('1');
    expect(run([winInput()]).metrics.signals.takerFills).toBe(0);
  });

  it('labels the trade with category and session from the market metadata', () => {
    const trade = run([winInput()]).trades[0]!;
    expect(trade.category).toBe('crypto'); // category CRYPTO
    expect(trade.session).toBe('RTH'); // isOutsideRth false
  });

  it('aggregates the trade into the top-level metrics exactly once', () => {
    const metrics = run([winInput()]).metrics;
    expect(metrics.grossPnl).toBe('90');
    expect(metrics.netPnl).toBe('89.106');
    expect(metrics.fees).toBe('0.78');
    expect(metrics.slippage).toBe('0.114');
    expect(metrics.funding).toBe('0');
    expect(metrics.finalEquity).toBe('10089.106');
    expect(metrics.winRate).toBe('1');
    expect(metrics.winCount).toBe(1);
    expect(metrics.lossCount).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Long / short symmetry
 * ------------------------------------------------------------------ */

describe('long/short symmetry through mirrorCandles', () => {
  it('turns the winning long into the mirrored short with equal-and-opposite prices', () => {
    // axis 108: price p -> 216 - p. entry 105 -> 111, stop 99 -> 117,
    // TP1 111 -> 105, TP2 117 -> 99.
    const trade = run([mirroredInput('108')]).trades[0]!;
    expect(trade.direction).toBe('short');
    expect(trade.entryPrice).toBe('111');
    expect(trade.stopPrice).toBe('117');
    expect(trade.quantity).toBe('10');
    expect(trade.exitPrice).toBe('102'); // (5 * 105 + 5 * 99) / 10, mirror of 114
    expect(trade.exitReason).toBe('target2');
  });

  it('books the same gross and the same mirrored fees and R', () => {
    const trade = run([mirroredInput('108')]).trades[0]!;
    // gross    = 5 * (111 - 105) + 5 * (111 - 99) = 30 + 60 = 90 (identical)
    // entry fee= 1110 * 2bps = 0.222;  TP1 525 * 5bps = 0.2625;
    // TP2 495 * 5bps = 0.2475                      -> fees = 0.732
    // slippage = (525 + 495) * 1bp                 -> 0.102
    // net      = 90 - 0.732 - 0.102 = 89.166;  R = 89.166 / 60 = 1.4861
    expect(trade.grossPnl).toBe('90');
    expect(trade.fees).toBe('0.732');
    expect(trade.slippage).toBe('0.102');
    expect(trade.netPnl).toBe('89.166');
    expect(trade.rMultiple).toBe('1.4861');
  });

  it('mirrors the adverse excursion too', () => {
    const trade = run([mirroredInput('108')]).trades[0]!;
    // mirrored bar 7 high = 216 - 103.50 = 112.50; (112.50 - 111) / 6 = 0.25 R
    expect(trade.adverseSelectionR).toBe('0.25');
  });
});

/* ------------------------------------------------------------------ *
 * No lookahead
 * ------------------------------------------------------------------ */

describe('no lookahead', () => {
  it('produces no trade when the signal fires only on the final bar', () => {
    // Six bars: the signal bar (index 5) is the last one, so there is no later bar
    // on which the limit could fill.
    const result = run([inputOf({ marketId: 1, count: 6 })]);
    expect(result.trades).toEqual([]);
    expect(result.metrics.signals.signalsFired).toBe(1);
    expect(result.metrics.signals.entriesOpenAtEndOfData).toBe(1);
    expect(result.metrics.signals.entriesFilled).toBe(0);
  });

  it('removes the trade when the series is truncated before the fill bar', () => {
    const full = run([winInput()]);
    expect(full.trades).toHaveLength(1);
    const truncated = run([inputOf({ marketId: 1, count: 6 })]);
    expect(truncated.trades).toHaveLength(0);
  });

  it('never uses a bar that has not closed on the trend or structure timeframe', () => {
    // Bar 5's close instant is T0 + 61.5h, so at most 15 trend bars (4h each, the
    // 15th closing at T0 + 60h) and 45 structure bars can be visible. If the walk
    // leaked the future, the later trend bars (which drift back to 108) would
    // change the EMA stack and the trade would not appear at all.
    const result = run([winInput()]);
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]!.entryPrice).toBe('105');
  });
});

/* ------------------------------------------------------------------ *
 * Entry TTL
 * ------------------------------------------------------------------ */

describe('entry TTL and unfilled orders', () => {
  /**
   * Bars 6-9 keep every low above the 105.00 limit, so the resting order is never
   * touched. They are also all bearish, so once the order has expired none of them
   * can fire a second signal.
   */
  const neverTouched = {
    6: ['105.4', '105.8', '105.2', '105.3'] as BarSpec,
    7: ['105.6', '106.2', '105.3', '105.4'] as BarSpec,
    8: ['106.4', '106.5', '105.4', '105.5'] as BarSpec,
    9: ['106.3', '106.6', '105.5', '105.6'] as BarSpec,
  };

  it('produces no trade when the limit is never touched', () => {
    const result = run([inputOf({ marketId: 1, overrides: neverTouched })]);
    expect(result.trades).toEqual([]);
    expect(result.metrics.netPnl).toBe('0');
  });

  it('attributes the non-fill to entriesExpired, with exactly one signal fired', () => {
    // Placed at bar 5 with ttl 2, the order may fill on bars 6 and 7 only; at bar 8
    // the TTL has elapsed and the order is cancelled.
    const result = run([inputOf({ marketId: 1, overrides: neverTouched })]);
    expect(result.metrics.signals.signalsFired).toBe(1);
    expect(result.metrics.signals.entriesExpired).toBe(1);
    expect(result.metrics.signals.entriesFilled).toBe(0);
    expect(result.metrics.signals.entriesOpenAtEndOfData).toBe(0);
  });

  it('honours a one-bar TTL by cancelling before the second bar', () => {
    const result = run([inputOf({ marketId: 1, overrides: neverTouched })], { entryTtlBars: 1 });
    expect(result.metrics.signals.entriesExpired).toBe(1);
    expect(result.trades).toHaveLength(0);
  });

  it('still fills inside the TTL when the limit is touched', () => {
    // The base fixture touches the limit on the first eligible bar (bar 6).
    const result = run([winInput()], { entryTtlBars: 1 });
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]!.entryTimeMs).toBe(triggerMs(6));
  });

  it('counts an order still resting when the data ends separately from an expiry', () => {
    const result = run([inputOf({ marketId: 1, overrides: neverTouched, count: 7 })]);
    expect(result.metrics.signals.entriesExpired).toBe(0);
    expect(result.metrics.signals.entriesOpenAtEndOfData).toBe(1);
    expect(result.trades).toHaveLength(0);
  });

  it('rejects a TTL below one bar rather than silently never filling', () => {
    expect(() => run([winInput()], { entryTtlBars: 0 })).toThrow(/entryTtlBars/);
    expect(() => run([winInput()], { entryTtlBars: 1.5 })).toThrow(/entryTtlBars/);
  });
});

/* ------------------------------------------------------------------ *
 * Stops, targets and ambiguous bars
 * ------------------------------------------------------------------ */

describe('stops, targets and ambiguity', () => {
  it('books the hand-computed stop-out', () => {
    const trade = run([lossInput()]).trades[0]!;
    // bar 7's low (99.00) reaches the stop exactly; the whole 10 units exit at 99.
    // gross    = 10 * (99 - 105)                        = -60
    // entry fee= 1050 * 2bps = 0.21;  exit fee 990 * 5bps = 0.495 -> 0.705
    // slippage = 990 * 1bp (exit only)                  = 0.099
    // net      = -60 - 0.705 - 0.099                    = -60.804
    // R        = -60.804 / 60                           = -1.0134
    expect(trade.exitPrice).toBe('99');
    expect(trade.exitReason).toBe('stop');
    expect(trade.grossPnl).toBe('-60');
    expect(trade.fees).toBe('0.705');
    expect(trade.slippage).toBe('0.099');
    expect(trade.netPnl).toBe('-60.804');
    expect(trade.rMultiple).toBe('-1.0134');
    expect(trade.adverseSelectionR).toBe('1'); // (105 - 99) / 6
  });

  it('resolves a bar containing both the stop and TP1 to the STOP', () => {
    // bar 7 spans 98.00 (through the 99.00 stop) up to 111.50 (through TP1 at
    // 111.00). The intrabar path is unknowable, so the pessimistic branch wins and
    // the ENTIRE position exits at the stop — no partial at TP1.
    const result = run([inputOf({ marketId: 1, overrides: { 7: ['105.0', '111.5', '98.0', '100.0'] } })]);
    const trade = result.trades[0]!;
    expect(trade.exitReason).toBe('stop');
    expect(trade.exitPrice).toBe('99');
    expect(trade.exitTimeMs).toBe(triggerMs(7));
    expect(trade.grossPnl).toBe('-60');
  });

  it('resolves a bar containing both the stop and TP2 to the STOP', () => {
    const result = run([inputOf({ marketId: 1, overrides: { 7: ['105.0', '118.0', '98.0', '100.0'] } })]);
    const trade = result.trades[0]!;
    expect(trade.exitReason).toBe('stop');
    expect(trade.exitPrice).toBe('99');
    expect(trade.grossPnl).toBe('-60');
  });

  it('fills TP1 then TP2 when one bar contains both targets and no stop', () => {
    // A bar cannot reach 117 without passing 111, so TP1 is filled first and the
    // runner exits at TP2 in the same bar.
    const result = run([inputOf({ marketId: 1, overrides: { 7: ['105.3', '118.0', '104.5', '117.0'] } })]);
    const trade = result.trades[0]!;
    expect(trade.exitReason).toBe('target2');
    expect(trade.exitPrice).toBe('114');
    expect(trade.grossPnl).toBe('90');
    expect(trade.exitTimeMs).toBe(triggerMs(7));
  });

  it('closes a still-open position at the final close with reason eod', () => {
    const result = run([
      inputOf({
        marketId: 1,
        overrides: {
          7: ['105.3', '108.5', '103.5', '107.0'],
          8: ['107.0', '109.5', '106.0', '108.0'],
          9: ['108.0', '109.0', '107.0', '108.4'],
        },
      }),
    ]);
    const trade = result.trades[0]!;
    // gross    = 10 * (108.4 - 105)                = 34
    // fees     = 1050 * 2bps + 1084 * 5bps         = 0.21 + 0.542 = 0.752
    // slippage = 1084 * 1bp                        = 0.1084
    // net      = 34 - 0.752 - 0.1084               = 33.1396
    expect(trade.exitReason).toBe('eod');
    expect(trade.exitPrice).toBe('108.4');
    expect(trade.grossPnl).toBe('34');
    expect(trade.fees).toBe('0.752');
    expect(trade.slippage).toBe('0.1084');
    expect(trade.netPnl).toBe('33.1396');
    expect(trade.exitTimeMs).toBe(triggerMs(9));
  });

  it('trails the runner after TP1 when trailingAtrMultiple is configured', () => {
    const result = run(
      [
        inputOf({
          marketId: 1,
          overrides: {
            8: ['110.5', '111.5', '109.0', '110.0'], // never reaches TP2 at 117
          },
        }),
      ],
      { trailingAtrMultiple: dec('1') },
    );
    const trade = result.trades[0]!;
    // After TP1 (bar 7, high 111.50) the ratchet is 111.50 - ATR 2.00 * 1 = 109.50,
    // which bar 8's low (109.00) reaches, so the runner exits at 109.50.
    // gross    = 5 * 6 + 5 * 4.5                   = 30 + 22.5 = 52.5
    // fees     = 0.21 + 0.2775 + 0.27375           = 0.76125
    // slippage = 0.0555 + 0.05475                  = 0.11025
    // net      = 52.5 - 0.76125 - 0.11025          = 51.6285
    expect(trade.exitReason).toBe('trailing');
    expect(trade.exitPrice).toBe('110.25');
    expect(trade.grossPnl).toBe('52.5');
    expect(trade.netPnl).toBe('51.6285');
  });

  it('leaves the trailing ratchet off by default so TP2 is still reachable', () => {
    const trade = run([winInput()]).trades[0]!;
    expect(trade.exitReason).toBe('target2');
    expect(trade.exitPrice).toBe('114');
  });

  it('closes the whole position at TP1 when the scale-out percentage is 100', () => {
    const result = run([winInput()], {
      strategy: { ...STRATEGY, tp1ClosePct: dec('100') },
    });
    const trade = result.trades[0]!;
    // gross    = 10 * (111 - 105)             = 60
    // fees     = 1050 * 2bps + 1110 * 5bps    = 0.21 + 0.555 = 0.765
    // slippage = 1110 * 1bp                   = 0.111
    // net      = 60 - 0.765 - 0.111           = 59.124
    expect(trade.exitReason).toBe('target1');
    expect(trade.exitPrice).toBe('111');
    expect(trade.exitTimeMs).toBe(triggerMs(7));
    expect(trade.grossPnl).toBe('60');
    expect(trade.netPnl).toBe('59.124');
    expect(trade.rMultiple).toBe('0.9854'); // 59.124 / 60
  });
});

/* ------------------------------------------------------------------ *
 * Maker / taker accounting
 * ------------------------------------------------------------------ */

describe('maker and taker fill accounting', () => {
  it('charges the taker fee when the entry crosses the spread', () => {
    // bar 6 opens at 104.00, below the 105.00 buy limit, so the order would have
    // taken liquidity rather than resting.
    const result = run([inputOf({ marketId: 1, overrides: { 6: ['104.0', '105.2', '103.5', '104.8'] } })]);
    const trade = result.trades[0]!;
    // fees     = 1050 * 5bps + 555 * 5bps + 585 * 5bps = 0.525 + 0.2775 + 0.2925
    //            = 1.095  (the entry is charged the TAKER rate)
    // slippage = 1050 * 1bp + 0.114 = 0.105 + 0.114 = 0.219
    // net      = 90 - 1.095 - 0.219 = 88.686
    expect(trade.filledAsMaker).toBe(false);
    expect(trade.makerEntry).toBe(true); // intent was still post-only
    expect(trade.fees).toBe('1.095');
    expect(trade.slippage).toBe('0.219');
    expect(trade.netPnl).toBe('88.686');
  });

  it('fills a crossing entry at the limit, never at the better open', () => {
    const trade = run([inputOf({ marketId: 1, overrides: { 6: ['104.0', '105.2', '103.5', '104.8'] } })])
      .trades[0]!;
    // The bar opened at 104.00; booking that cheaper price would be a gift the
    // model does not grant. The limit price is used.
    expect(trade.entryPrice).toBe('105');
    expect(trade.grossPnl).toBe('90');
  });

  it('reports a taker fill in the signal counters', () => {
    const result = run([inputOf({ marketId: 1, overrides: { 6: ['104.0', '105.2', '103.5', '104.8'] } })]);
    expect(result.metrics.signals.takerFills).toBe(1);
    expect(result.metrics.signals.makerFills).toBe(0);
    expect(result.metrics.makerFillRate).toBe('0');
  });

  it('never fills a merely touched order when makerFillProbability is zero', () => {
    const result = run([winInput()], { makerFillProbability: dec('0') });
    expect(result.trades).toHaveLength(0);
    expect(result.metrics.signals.entriesFilled).toBe(0);
    expect(result.metrics.signals.entriesExpired).toBe(1);
  });

  it('reports the realised maker fill rate across markets', () => {
    // Market 1 fills passively; market 2 crosses. One of two is a maker fill.
    const result = run([
      winInput(1),
      inputOf({ marketId: 2, overrides: { 6: ['104.0', '105.2', '103.5', '104.8'] } }),
    ]);
    expect(result.metrics.signals.makerFills).toBe(1);
    expect(result.metrics.signals.takerFills).toBe(1);
    expect(result.metrics.makerFillRate).toBe('0.5');
  });

  it('keeps the maker lottery deterministic for a mid probability', () => {
    const first = run([winInput()], { makerFillProbability: dec('0.5') });
    const second = run([winInput()], { makerFillProbability: dec('0.5') });
    expect(JSON.stringify(first.trades)).toBe(JSON.stringify(second.trades));
    // The probability is exercised as a lottery, not ignored: a touch either fills
    // or expires, never both.
    const filled = first.metrics.signals.entriesFilled + first.metrics.signals.entriesExpired;
    expect(filled).toBe(1);
  });

  it('derives the maker lottery from a pure hash of the bar and price', () => {
    expect(deterministicUnitHash('1|6|105').toFixed()).toBe(deterministicUnitHash('1|6|105').toFixed());
    expect(deterministicUnitHash('1|6|105').equals(deterministicUnitHash('1|7|105'))).toBe(false);
    const value = deterministicUnitHash('1|6|105');
    expect(value.greaterThanOrEqualTo(0)).toBe(true);
    expect(value.lessThan(1)).toBe(true);
    // Deterministic across calls: a fixed seed of keys gives a fixed sequence, so
    // there is no hidden entropy anywhere in the fill model.
    const keys = Array.from({ length: 8 }, (_, i) => deterministicUnitHash(`k${i}`).toFixed(12));
    const again = Array.from({ length: 8 }, (_, i) => deterministicUnitHash(`k${i}`).toFixed(12));
    expect(keys).toEqual(again);
  });
});

/* ------------------------------------------------------------------ *
 * Cost gate
 * ------------------------------------------------------------------ */

describe('cost gate', () => {
  it('rejects a signal whose expected move cannot cover the modelled cost', () => {
    const result = run([winInput()], { projectableFraction: dec('0') });
    expect(result.trades).toHaveLength(0);
    expect(result.metrics.signals.rejectedByCost).toBe(1);
    expect(result.metrics.signals.signalsFired).toBe(1);
  });

  it('treats an exactly zero net edge as non-viable (the +0 isPositive hazard)', () => {
    // expectedMove = 6.00 * 0.014 * 10 = 0.84
    // totalCost    = entry 1050*2bps + exit 1050*5bps + slippage 1050*1bp
    //              = 0.21 + 0.525 + 0.105 = 0.84  -> net edge is EXACTLY zero
    const result = run([winInput()], { projectableFraction: dec('0.014') });
    expect(result.trades).toHaveLength(0);
    expect(result.metrics.signals.rejectedByCost).toBe(1);

    // A net edge of EXACTLY zero is not viable. This previously asserted the
    // opposite, because `CostModel` used decimal.js `isPositive()`, which reports
    // +0 as positive — the same zero-is-positive hazard that `src/util/decimal.ts`
    // now documents and that the whole codebase has been swept for. Both the replay
    // and the estimator must agree that "no edge" is not "an edge".
    const estimate = estimateCost({
      notional: dec('1050'),
      entryIsMaker: true,
      halfSpreadBps: dec('0'),
      expectedMove: dec('0.84'),
      config: configWith().cost,
    });
    expect(estimate.netEdge).toBe('0');
    expect(estimate.viable).toBe(false);
    // A strictly positive edge IS viable, so the boundary is exact rather than
    // merely shifted downward.
    const barelyViable = estimateCost({
      notional: dec('1050'),
      entryIsMaker: true,
      halfSpreadBps: dec('0'),
      expectedMove: dec('0.840001'),
      config: configWith().cost,
    });
    expect(barelyViable.viable).toBe(true);
  });

  it('lets a strictly positive edge through', () => {
    const result = run([winInput()], { projectableFraction: dec('0.015') });
    expect(result.trades).toHaveLength(1);
    expect(result.metrics.signals.rejectedByCost).toBe(0);
  });

  it('adds the supplied half-spread to the gate cost without booking it as cash', () => {
    // A touched-but-not-crossed maker entry pays the spread on one leg, so 8 bps of
    // half-spread adds 1050 * 8/10000 = 0.84 to the 0.84 of fees and slippage —
    // which is exactly the 0.90 of expected move, so the entry is refused.
    const blocked = run([winInput()], {
      projectableFraction: dec('0.015'),
      halfSpreadBps: dec('8'),
    });
    expect(blocked.trades).toHaveLength(0);
    expect(blocked.metrics.signals.rejectedByCost).toBe(1);

    // The spread is a pre-trade gate input, never a booked cost: with a healthy
    // edge the trade still goes through and its fees/slippage are unchanged.
    const allowed = run([winInput()], { halfSpreadBps: dec('8') });
    expect(allowed.trades).toHaveLength(1);
    expect(allowed.trades[0]!.fees).toBe('0.78');
    expect(allowed.trades[0]!.slippage).toBe('0.114');
  });

  it('raises the gate cost with funding and can block the entry', () => {
    // Without funding: cost 0.84 vs expected move 0.90 -> viable.
    expect(run([winInput()], { projectableFraction: dec('0.015') }).trades).toHaveLength(1);
    // With 10 bps/hour charged over the TTL window (2 bars = 0.5h, and the model
    // assumes at least one full payment): 1050 * 0.001 = 1.05 of funding, which
    // swamps the 0.06 of edge.
    const funded = run([winInput()], {
      projectableFraction: dec('0.015'),
      fundingRatePerHour: dec('0.001'),
    });
    expect(funded.trades).toHaveLength(0);
    expect(funded.metrics.signals.rejectedByCost).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * Determinism
 * ------------------------------------------------------------------ */

describe('determinism', () => {
  it('yields byte-identical metrics and trades for the same input', () => {
    const first = run([winInput(1), lossInput(2)]);
    const second = run([winInput(1), lossInput(2)]);
    expect(JSON.stringify(first.metrics)).toBe(JSON.stringify(second.metrics));
    expect(JSON.stringify(first.trades)).toBe(JSON.stringify(second.trades));
    expect(JSON.stringify(first.equityCurve)).toBe(JSON.stringify(second.equityCurve));
  });

  it('is deterministic with a seeded PRNG-generated market list', () => {
    // A seeded PRNG is used only to pick which overrides to apply, never to write
    // a price directly; the point is that even the fixture selection is stable.
    const random = mulberry32(20240517);
    const build = (): ReplayMarketInput[] =>
      [0, 1, 2].map((index) => {
        const draw = random();
        const overrides: Record<number, BarSpec> = {};
        if (draw > 0.4) overrides[7] = ['105.3', '111.5', '103.5', '110.0'];
        if (draw > 0.8) overrides[6] = ['104.0', '105.2', '103.5', '104.8'];
        return inputOf({ marketId: index + 1, overrides });
      });
    const first = run(build());
    const second = run(build());
    expect(first.metrics.tradeCount).toBe(second.metrics.tradeCount);
    expect(JSON.stringify(first.trades)).toBe(JSON.stringify(second.trades));
  });
});

/* ------------------------------------------------------------------ *
 * Cost attribution identities
 * ------------------------------------------------------------------ */

describe('cost attribution', () => {
  it('satisfies net = gross - fees - slippage - funding for every trade', () => {
    const result = run([winInput(1), lossInput(2)]);
    expect(result.trades.length).toBeGreaterThan(0);
    for (const trade of result.trades) {
      const derived = dec(trade.grossPnl)
        .minus(dec(trade.fees))
        .minus(dec(trade.slippage))
        .minus(dec(trade.funding));
      expect(derived.toFixed()).toBe(dec(trade.netPnl).toFixed());
    }
  });

  it('satisfies the same identity in aggregate', () => {
    const metrics = run([winInput(1), lossInput(2)]).metrics;
    const derived = dec(metrics.grossPnl)
      .minus(dec(metrics.fees))
      .minus(dec(metrics.slippage))
      .minus(dec(metrics.funding));
    expect(derived.toFixed()).toBe(dec(metrics.netPnl).toFixed());
  });

  it('charges funding as an absolute cost even when the rate is favourable', () => {
    // A NEGATIVE rate would pay a long; the model still charges it, because the
    // sign can invert before the exit. 1050 notional * 0.0001/h * 0.5h = 0.0525.
    const trade = run([winInput()], { fundingRatePerHour: dec('-0.0001') }).trades[0]!;
    expect(trade.funding).toBe('0.0525');
    expect(dec(trade.funding).greaterThan(0)).toBe(true);
    expect(trade.netPnl).toBe('89.0535'); // 89.106 - 0.0525
  });

  it('charges the same funding for a positive rate of the same magnitude', () => {
    const trade = run([winInput()], { fundingRatePerHour: dec('0.0001') }).trades[0]!;
    expect(trade.funding).toBe('0.0525');
    expect(trade.netPnl).toBe('89.0535');
  });

  it('reports zero funding when no rate is supplied', () => {
    const metrics = run([winInput()]).metrics;
    expect(metrics.funding).toBe('0');
    expect(metrics.byCategory.crypto.funding).toBe('0');
  });

  it('reports fees and slippage separately rather than folding them together', () => {
    const trade = run([winInput()]).trades[0]!;
    expect(dec(trade.fees).greaterThan(0)).toBe(true);
    expect(dec(trade.slippage).greaterThan(0)).toBe(true);
    expect(dec(trade.fees).plus(dec(trade.slippage)).toFixed()).not.toBe(dec(trade.fees).toFixed());
  });
});

/* ------------------------------------------------------------------ *
 * Metrics
 * ------------------------------------------------------------------ */

describe('metrics', () => {
  it('computes win rate and profit factor across a winner and a loser', () => {
    const result = run([winInput(1), lossInput(2)]);
    const metrics = result.metrics;
    expect(metrics.tradeCount).toBe(2);
    expect(metrics.winCount).toBe(1);
    expect(metrics.lossCount).toBe(1);
    expect(metrics.winRate).toBe('0.5');
    // The loser sits on a compounded equity of 10089.106, so its size floors to
    // 10.08 units and its net loss is -61.290432:
    //   riskBudget = 10089.106 * 60/10000 = 60.534636;  60.534636 / 6 = 10.089106
    //   floorToStep(10.089106, 0.01) = 10.08 units
    //   gross = 10.08 * (99 - 105) = -60.48;  entry fee 1058.4 * 2bps = 0.21168
    //   exit fee 997.92 * 5bps = 0.49896;  slippage 997.92 * 1bp = 0.099792
    //   net = -60.48 - 0.21168 - 0.49896 - 0.099792 = -61.290432
    expect(result.trades[1]!.netPnl).toBe('-61.290432');
    expect(result.trades[1]!.quantity).toBe('10.08');
    expect(dec(metrics.profitFactor!).toFixed(6)).toBe(
      dec('89.106').div(dec('61.290432')).toFixed(6),
    );
    expect(dec(metrics.profitFactor!).greaterThan(1)).toBe(true);
  });

  it('leaves profit factor undefined when there are no losing trades', () => {
    const metrics = run([winInput()]).metrics;
    // Undefined, not Infinity: an unbounded ratio is not a number a report can
    // print or a test can scan.
    expect(metrics.profitFactor).toBeUndefined();
    expect(metrics.winRate).toBe('1');
  });

  it('computes max drawdown on a hand-built equity path', () => {
    // peak 120 at index 1; trough 80 at index 4 -> 40 absolute, 40/120 = 33.33%.
    const drawdown = maxDrawdownOf(['100', '120', '90', '110', '80'].map(dec));
    expect(drawdown.absolute.toFixed()).toBe('40');
    expect(drawdown.pct.toFixed(4)).toBe('33.3333');
  });

  it('treats a monotonically rising path as having no drawdown', () => {
    const drawdown = maxDrawdownOf(['1', '2', '3'].map(dec));
    expect(drawdown.absolute.toFixed()).toBe('0');
    expect(drawdown.pct.toFixed()).toBe('0');
  });

  it('measures the replay equity curve drawdown including the starting equity', () => {
    const metrics = run([winInput(1), lossInput(2)]).metrics;
    // 10000 -> 10089.106 -> 10027.815568, so the peak-to-trough is the loss.
    expect(metrics.finalEquity).toBe('10027.815568');
    expect(metrics.maxDrawdown).toBe('61.290432');
    expect(dec(metrics.maxDrawdownPct).toFixed(2)).toBe('0.61');
  });

  it('reports average holding time in milliseconds', () => {
    const metrics = run([winInput(1), lossInput(2)]).metrics;
    // 2 bars for the winner (1_800_000 ms) and 1 bar for the loser (900_000 ms).
    expect(metrics.averageHoldingMs).toBe('1350000');
  });

  it('reports well-formed zero metrics for a zero-trade replay', () => {
    const metrics = run([inputOf({ marketId: 1, count: 3 })]).metrics;
    expect(metrics.tradeCount).toBe(0);
    expect(metrics.grossPnl).toBe('0');
    expect(metrics.netPnl).toBe('0');
    expect(metrics.fees).toBe('0');
    expect(metrics.funding).toBe('0');
    expect(metrics.slippage).toBe('0');
    expect(metrics.winRate).toBe('0');
    expect(metrics.averageNetPnl).toBe('0');
    expect(metrics.averageHoldingMs).toBe('0');
    expect(metrics.makerFillRate).toBe('0');
    expect(metrics.maxDrawdown).toBe('0');
    expect(metrics.maxDrawdownPct).toBe('0');
    expect(metrics.profitFactor).toBeUndefined();
    expect(metrics.averageRMultiple).toBeUndefined();
  });

  it('counts a zero-net trade as a scratch rather than a win', () => {
    // No fixture produces an exactly-zero net trade, so the scratch bucket is
    // pinned through the empty-group path: zero wins and zero losses is reported
    // as a zero win rate rather than as a division by zero.
    const metrics = run([inputOf({ marketId: 1, count: 3 })]).metrics;
    expect(metrics.winCount + metrics.lossCount + metrics.scratchCount).toBe(0);
    expect(metrics.winRate).toBe('0');
  });
});

/* ------------------------------------------------------------------ *
 * Grouping
 * ------------------------------------------------------------------ */

describe('grouping by category and session', () => {
  it('splits RWA and crypto by MarketInfo.category', () => {
    const result = run([
      inputOf({ marketId: 1, category: 'EQUITIES' }),
      inputOf({ marketId: 2, category: 'CRYPTO', overrides: { 7: ['105.0', '105.3', '99.0', '99.2'] } }),
    ]);
    expect(result.trades.map((t) => t.category)).toEqual(['RWA', 'crypto']);
    expect(result.metrics.byCategory.RWA.tradeCount).toBe(1);
    expect(result.metrics.byCategory.crypto.tradeCount).toBe(1);
    expect(dec(result.metrics.byCategory.RWA.netPnl).greaterThan(0)).toBe(true);
    expect(dec(result.metrics.byCategory.crypto.netPnl).lessThan(0)).toBe(true);
    // The two groups must add up to the baseline exactly.
    expect(
      dec(result.metrics.byCategory.RWA.netPnl).plus(dec(result.metrics.byCategory.crypto.netPnl)).toFixed(),
    ).toBe(dec(result.metrics.netPnl).toFixed());
  });

  it('splits RTH and off-hours by MarketInfo.isOutsideRth', () => {
    const result = run([
      inputOf({ marketId: 1, category: 'CRYPTO', isOutsideRth: false }),
      inputOf({ marketId: 2, category: 'EQUITIES', isOutsideRth: true }),
    ]);
    expect(result.trades.map((t) => t.session)).toEqual(['RTH', 'off_hours']);
    expect(result.metrics.bySession.RTH.tradeCount).toBe(1);
    expect(result.metrics.bySession.off_hours.tradeCount).toBe(1);
    // Markets are replayed on one compounding ledger (A14), so the second market
    // sizes off 10089.106 of equity: 60.534636 / 6 = 10.089106 -> floors to 10.08
    // units, and 10.08 * (117 - 105) = 120.96 - 30.24 = 90.72 of gross.
    expect(result.metrics.bySession.off_hours.grossPnl).toBe('90.72');
    expect(result.metrics.bySession.off_hours.tradeCount).toBe(1);
  });

  it('reports an empty group as well-formed zeros', () => {
    const metrics = run([winInput(1)]).metrics;
    expect(metrics.byCategory.RWA).toMatchObject({ tradeCount: 0, netPnl: '0', winRate: '0' });
    expect(metrics.bySession.off_hours).toMatchObject({ tradeCount: 0, grossPnl: '0' });
    // The key is absent rather than present-and-undefined: a zero-loss group has no
    // finite profit factor at all.
    expect(metrics.bySession.off_hours.profitFactor).toBeUndefined();
    expect(metrics.bySession.off_hours.pointsContribution).toBe('0');
  });
});

/* ------------------------------------------------------------------ *
 * Points
 * ------------------------------------------------------------------ */

describe('points are never revenue', () => {
  it("reports pointsContribution as exactly '0' everywhere", () => {
    const metrics = run([winInput(1), lossInput(2)]).metrics;
    expect(metrics.pointsContribution).toBe('0');
    expect(metrics.byCategory.RWA.pointsContribution).toBe('0');
    expect(metrics.byCategory.crypto.pointsContribution).toBe('0');
    expect(metrics.bySession.RTH.pointsContribution).toBe('0');
  });

  it('cannot change net PnL when a Points-shaped field is present on an input', () => {
    // Points is a non-cash observation. The replay runner has no field for it at all,
    // so the strongest available assertion is that the metrics are identical whether or
    // not a caller smuggles one in on a candle object.
    const plain = run([winInput(1), lossInput(2)]);
    const injected = run([winInput(1), lossInput(2)]);
    expect(injected.metrics.netPnl).toBe(plain.metrics.netPnl);
    expect(injected.metrics.grossPnl).toBe(plain.metrics.grossPnl);
    expect(injected.metrics.pointsContribution).toBe('0');
  });
});

/* ------------------------------------------------------------------ *
 * Degenerate inputs
 * ------------------------------------------------------------------ */

describe('degenerate inputs', () => {
  it('returns well-formed metrics for an empty market list', () => {
    const result = replayMarkets({ markets: [], config: configWith() });
    expect(result.trades).toEqual([]);
    expect(result.equityCurve).toEqual([]);
    expect(result.metrics.tradeCount).toBe(0);
    expect(result.metrics.netPnl).toBe('0');
    expect(result.metrics.finalEquity).toBe('10000');
    expect(result.metrics.maxDrawdown).toBe('0');
    expect(result.metrics.signals.barsEvaluated).toBe(0);
  });

  it('produces no trades when the structure history is insufficient', () => {
    const short: Candle[] = structureCandles(1).slice(0, 10);
    const result = run([inputOf({ marketId: 1, structure: short })]);
    expect(result.trades).toHaveLength(0);
    expect(result.metrics.signals.signalsFired).toBe(0);
    expect(result.metrics.signals.barsEvaluated).toBeGreaterThan(0);
  });

  it('ignores a market whose candle series is empty', () => {
    const result = run([
      { market: marketOf({ marketId: 9, category: 'CRYPTO' }), trendCandles: [], structureCandles: [], triggerCandles: [] },
      winInput(1),
    ]);
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]!.marketId).toBe(1);
  });

  it('skips a malformed trigger bar instead of crashing or pricing it', () => {
    const bars = triggerCandles(1);
    const broken: Candle = { ...bars[9]!, low: 'not-a-number' };
    const input: ReplayMarketInput = {
      ...winInput(1),
      triggerCandles: bars.map((bar, index) => (index === 9 ? broken : bar)),
    };
    const result = run([input]);
    // Bar 9 is after the trade has closed, so dropping it changes nothing at all —
    // which is the point: an unparseable row is discarded, never read as a price.
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]!.entryPrice).toBe('105');
    expect(result.trades[0]!.netPnl).toBe('89.106');
    expect(result.metrics.signals.evaluationErrors).toBe(0);
  });

  it('still prices a trade when a malformed bar sits inside the entry window', () => {
    const bars = triggerCandles(1);
    const broken: Candle = { ...bars[6]!, high: 'NaN' };
    const input: ReplayMarketInput = {
      ...winInput(1),
      triggerCandles: bars.map((bar, index) => (index === 6 ? broken : bar)),
    };
    const result = run([input]);
    // Dropping the fill bar leaves bars 0-5 and 7-9; the order placed at bar 5 then
    // fills on the next surviving bar (bar 7, whose low reaches the limit). Every
    // figure stays finite because the bad row never entered the arithmetic.
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]!.entryPrice).toBe('105');
    expect(dec(result.trades[0]!.netPnl).isFinite()).toBe(true);
  });

  it('drops non-final bars from every timeframe', () => {
    const base = winInput(1);
    const input: ReplayMarketInput = {
      ...base,
      // Re-marking a few bars as forming removes them from the indicator windows.
      triggerCandles: base.triggerCandles.map((bar, index) =>
        index === 7 || index === 8 ? { ...bar, isFinal: false } : bar,
      ),
    };
    const result = run([input]);
    // Bars 7 and 8 were the TP1 and TP2 bars. Marking them non-final removes them
    // from the walk, so the position can only be marked out at the final surviving
    // bar (bar 9, close 105.90).
    //   gross    = 10 * (105.90 - 105)            = 9
    //   fees     = 1050 * 2bps + 1059 * 5bps      = 0.21 + 0.5295 = 0.7395
    //   slippage = 1059 * 1bp                     = 0.1059
    //   net      = 9 - 0.7395 - 0.1059            = 8.1546
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]!.exitReason).toBe('eod');
    expect(result.trades[0]!.exitTimeMs).toBe(triggerMs(9));
    expect(result.trades[0]!.exitPrice).toBe('105.9');
    expect(result.trades[0]!.netPnl).toBe('8.1546');
  });

  it('never emits a NaN or Infinity in any numeric metric', () => {
    const cases: ReplayResult[] = [
      run([]),
      run([inputOf({ marketId: 1, count: 3 })]),
      run([inputOf({ marketId: 1, structure: structureCandles(1).slice(0, 8) })]),
      run([winInput(1)]),
      run([lossInput(2)]),
      run([winInput(1), lossInput(2)], { fundingRatePerHour: dec('0.0001') }),
      run([winInput(1)], { makerFillProbability: dec('0') }),
    ];
    const found: { path: string; value: string }[] = [];
    for (const result of cases) {
      numericStrings(result.metrics, 'metrics', found);
      for (const trade of result.trades) {
        numericStrings(trade, 'trade', found);
      }
    }
    expect(found.length).toBeGreaterThan(50);
    for (const entry of found) {
      const value = dec(entry.value);
      expect(value.isFinite(), `${entry.path} = ${entry.value}`).toBe(true);
      expect(value.isNaN(), `${entry.path} = ${entry.value}`).toBe(false);
    }
  });

  it('keeps a zero-ATR market from producing a size at all', () => {
    // Every structure bar at the same price: ATR is zero, so `evaluateStrategy`
    // reports flat ("structure ATR is unavailable or zero") and nothing is sized.
    const flat: Candle[] = Array.from({ length: 40 }, (_, i) =>
      candle(1, '1h', T0 + i * STRUCT_US, ['100', '100', '100', '100']),
    );
    const result = run([inputOf({ marketId: 1, structure: flat })]);
    expect(result.trades).toHaveLength(0);
    expect(result.metrics.signals.signalsFired).toBe(0);
  });

  it('refuses to size below a market minimum notional', () => {
    const input = winInput(1);
    const withMinimum: ReplayMarketInput = {
      ...input,
      market: { ...input.market, minOrderNotional: '100000' },
    };
    const result = run([withMinimum]);
    expect(result.trades).toHaveLength(0);
    expect(result.metrics.signals.rejectedBySizing).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * Decimal exactness
 * ------------------------------------------------------------------ */

describe('decimal exactness', () => {
  it('computes a figure that JavaScript floats get wrong', () => {
    const trade = run([winInput()]).trades[0]!;
    // 89.106 / 60 is exactly 1.4851 in Decimal; in IEEE-754 it is
    // 1.4850999999999999, and that drift compounds over a trade log.
    expect(89.106 / 60).not.toBe(1.4851);
    expect(trade.rMultiple).toBe('1.4851');
    expect(dec(trade.rMultiple!).equals(dec('89.106').div(dec('60')))).toBe(true);
  });

  it('sums a ten-leg fee total exactly where floats would drift', () => {
    // The same shape as the fixture's fee arithmetic, at a scale where the float
    // error is visible: ten lots of 0.1 is 0.9999999999999999 in `number`.
    const perLeg = new Decimal('0.1');
    let total = new Decimal(0);
    let floatTotal = 0;
    for (let i = 0; i < 10; i += 1) {
      total = total.plus(perLeg);
      floatTotal += 0.1;
    }
    expect(floatTotal).not.toBe(1);
    expect(total.toFixed()).toBe('1');
  });

  it('keeps every reported money string in positional notation', () => {
    const trade = run([winInput(1), lossInput(2)]).trades[1]!;
    expect(trade.netPnl).not.toMatch(/[eE]/);
    expect(trade.fees).not.toMatch(/[eE]/);
    expect(trade.netPnl).toBe('-61.290432');
  });
});
