/**
 * Backtest runner against REAL Arcus history.
 *
 * Fetches 4h / 1h / 15m candles for a set of liquid markets from the public Arcus API,
 * then drives the shipped strategy through `replayMarkets`. The point is to answer one
 * question: does the deterministic pullback strategy have an edge after real fees,
 * funding and modelled slippage?
 *
 * The backtester itself is offline and deterministic (tools/replay.ts); this script is
 * only the data loader plus a report.
 *
 * Usage:
 *   tsx tools/backtest.ts                        # default: 6 markets, ~4 months
 *   tsx tools/backtest.ts --months 6 --markets BTC-USD,ETH-USD
 *   tsx tools/backtest.ts --maker-fill 0.6       # model queue position pessimistically
 *   tsx tools/backtest.ts --triple               # run 3 fill assumptions side by side
 *
 * Read the output with the caveats printed at the end. In particular a positive result
 * from `--maker-fill 1.0` is NOT evidence of profitability: it assumes every touched
 * ALO order fills, which is the most favourable possible assumption.
 */

import { ArcusRestClient } from '../src/arcus/ArcusRestClient';
import { createLogger } from '../src/util/logger';
import { readFile, writeFile } from 'node:fs/promises';
import { dec } from '../src/util/decimal';
import { loadConfig } from '../src/config/config';
import { strategyConfigFrom } from '../src/app/bootstrap';
import type { Candle, MarketInfo } from '../src/arcus/types';
import type { StrategyConfig } from '../src/strategy/PullbackStrategy';
import { replayMarkets, type ReplayConfig, type ReplayMarketInput, type ReplayResult } from './replay';

const logger = createLogger({ level: 'error', pretty: false });

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

interface Args {
  months: number;
  symbols: string[];
  makerFill: number;
  halfSpreadBps: number;
  triple: boolean;
  trailingAtr: number | undefined;
  equity: string;
  riskBps: string;
  /**
   * Strategy overrides for a sensitivity sweep. `undefined` means "use the mode's
   * preset", so `--strategy scalp` alone measures the scalp configuration rather than
   * the swing defaults with a different set of timeframes.
   */
  stopAtr: number | undefined;
  tp1R: number | undefined;
  tp2R: number | undefined;
  tp1ClosePct: number | undefined;
  zoneAtr: number | undefined;
  maxExtensionAtr: number | undefined;
  stopBars: number;
  strategy: 'swing' | 'scalp';
  makerFeeBps: number;
  takerFeeBps: number;
  /** Candle cache: fetch once, replay many parameter sets offline. */
  savePath: string | undefined;
  loadPath: string | undefined;
}

function parseArgs(argv: readonly string[]): Args {
  const args = argv.slice(2);
  const out: Args = {
    months: 4,
    symbols: ['BTC-USD', 'ETH-USD', 'SOL-USD', 'SPY-USD', 'NVDA-USD', 'QQQ-USD'],
    makerFill: 0.7,
    halfSpreadBps: 1,
    triple: false,
    trailingAtr: undefined,
    equity: '10000',
    riskBps: '25',
    stopAtr: undefined,
    tp1R: undefined,
    tp2R: undefined,
    tp1ClosePct: undefined,
    zoneAtr: undefined,
    maxExtensionAtr: undefined,
    stopBars: 0,
    strategy: 'swing',
    // Live base tier read from GET /v1/feetiers on 2026-10-25:
    // maker 150 ppm = 1.5 bps, taker 450 ppm = 4.5 bps.
    makerFeeBps: 1.5,
    takerFeeBps: 4.5,
    savePath: undefined,
    loadPath: undefined,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = (): string => {
      const v = args[i + 1];
      if (v === undefined) throw new Error(`${arg} requires a value`);
      i += 1;
      return v;
    };
    switch (arg) {
      case '--months': out.months = Number(next()); break;
      case '--markets': out.symbols = next().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--maker-fill': out.makerFill = Number(next()); break;
      case '--half-spread': out.halfSpreadBps = Number(next()); break;
      case '--triple': out.triple = true; break;
      case '--trailing-atr': out.trailingAtr = Number(next()); break;
      case '--equity': out.equity = next(); break;
      case '--risk-bps': out.riskBps = next(); break;
      case '--stop-atr': out.stopAtr = Number(next()); break;
      case '--tp1-r': out.tp1R = Number(next()); break;
      case '--tp2-r': out.tp2R = Number(next()); break;
      case '--zone-atr': out.zoneAtr = Number(next()); break;
      case '--max-extension-atr': out.maxExtensionAtr = Number(next()); break;
      case '--stop-bars': out.stopBars = Number(next()); break;
      case '--strategy': out.strategy = next() === 'scalp' ? 'scalp' : 'swing'; break;
      case '--maker-fee-bps': out.makerFeeBps = Number(next()); break;
      case '--taker-fee-bps': out.takerFeeBps = Number(next()); break;
      case '--save': out.savePath = next(); break;
      case '--load': out.loadPath = next(); break;
      case '--help':
        console.log('tsx tools/backtest.ts [--months N] [--markets A,B] [--maker-fill 0.7] [--triple]');
        process.exit(0);
        break;
      default:
        throw new Error(`unknown flag ${arg}`);
    }
  }
  if (!Number.isFinite(out.months) || out.months <= 0) throw new Error('--months must be > 0');
  if (!Number.isFinite(out.makerFill) || out.makerFill < 0 || out.makerFill > 1) {
    throw new Error('--maker-fill must be within [0, 1]');
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Data loading
 * ------------------------------------------------------------------ */

/**
 * Fetch `count` bars of one timeframe, paging backwards.
 *
 * The API caps a single request at 1500 bars and returns newest-first, so pages are
 * requested with `to = oldestSoFar - 1` and the results are concatenated then sorted
 * ascending. The client's own weight budget paces the requests.
 */
async function fetchHistory(params: {
  rest: ArcusRestClient;
  symbol: string;
  timeframe: string;
  count: number;
}): Promise<Candle[]> {
  const { rest, symbol, timeframe, count } = params;
  const collected = new Map<number, Candle>();
  let to = Math.floor(Date.now() * 1000); // µs
  let guard = 0;

  while (collected.size < count && guard < 40) {
    guard += 1;
    const pageSize = Math.min(1500, count - collected.size + 5);
    let page: readonly Candle[];
    try {
      page = await rest.getCandles({ market: symbol, timeframe, to, countback: pageSize });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A weight-budget refusal is recoverable: the budget refills continuously.
      if (/rate limited|budget/i.test(message)) {
        await sleep(1500);
        continue;
      }
      throw error;
    }
    if (page.length === 0) break;
    let oldest = to;
    for (const bar of page) {
      collected.set(bar.openTime, bar);
      if (bar.openTime < oldest) oldest = bar.openTime;
    }
    if (oldest >= to) break; // no progress
    to = oldest - 1;
    await sleep(120); // stay well inside the per-IP weight bucket
  }

  // Drop the forming bar and sort ascending; indicators require chronology.
  return [...collected.values()].filter((b) => b.isFinal).sort((a, b) => a.openTime - b.openTime);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ *
 * Strategy config (matches the runtime defaults)
 * ------------------------------------------------------------------ */

/**
 * Strategy parameters for the selected mode.
 *
 * Built from `loadConfig`, so the backtest uses exactly the geometry production would —
 * including the mode's timeframes and TP1 close percentage. The CLI flags then act as
 * overrides for sensitivity sweeps.
 */
function strategyConfig(args: Args): StrategyConfig {
  const base = strategyConfigFrom(loadConfig({ STRATEGY_MODE: args.strategy }));
  // Each override is applied only when explicitly provided.
  return {
    ...base,
    ...(args.stopAtr !== undefined ? { stopAtrBuffer: dec(String(args.stopAtr)) } : {}),
    ...(args.maxExtensionAtr !== undefined
      ? { maxExtensionAtr: dec(String(args.maxExtensionAtr)) }
      : {}),
    ...(args.zoneAtr !== undefined ? { pullbackZoneAtr: dec(String(args.zoneAtr)) } : {}),
    ...(args.tp1R !== undefined ? { tp1RMultiple: dec(String(args.tp1R)) } : {}),
    ...(args.tp1ClosePct !== undefined ? { tp1ClosePct: dec(String(args.tp1ClosePct)) } : {}),
    ...(args.tp2R !== undefined ? { tp2RMultiple: dec(String(args.tp2R)) } : {}),
    ...(args.stopBars > 0 ? { stopStructureBars: args.stopBars } : {}),
  };
}

function baseConfig(args: Args, market: MarketInfo, makerFill: number): ReplayConfig {
  const funding = market.fundingRate ? dec(market.fundingRate) : undefined;
  return {
    strategy: strategyConfig(args),
    cost: {
      // Live base tier from GET /v1/feetiers (2026-10-25): 1.5 / 4.5 bps.
      makerFeeBps: dec(String(args.makerFeeBps)),
      takerFeeBps: dec(String(args.takerFeeBps)),
      assumedSlippageBps: dec('3'),
      safetyBufferBps: dec('2'),
    },
    initialEquity: dec(args.equity),
    riskBps: dec(args.riskBps),
    maxNotionalPct: dec('30'),
    maxLeverage: dec('2'),
    entryTtlBars: 4,
    projectableFraction: dec('0.6'),
    ...(funding ? { fundingRatePerHour: funding.abs() } : {}),
    makerFillProbability: dec(makerFill.toFixed(2)),
    halfSpreadBps: dec(String(args.halfSpreadBps)),
    ...(args.trailingAtr !== undefined ? { trailingAtrMultiple: dec(String(args.trailingAtr)) } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------ */

function pct(value: string | undefined): string {
  return value === undefined ? 'n/a' : `${(Number(value) * 100).toFixed(1)}%`;
}

function money(value: string): string {
  return Number(value).toFixed(2);
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const rest = new ArcusRestClient({ baseUrl: 'https://api.arcus.xyz', logger });

  console.log('Fetching market metadata…');
  const all = await rest.getMarkets();
  const bySymbol = new Map(all.map((m) => [m.marketDisplayName.toUpperCase(), m]));

  const targets = args.symbols
    .map((s) => bySymbol.get(s.toUpperCase()))
    .filter((m): m is MarketInfo => m !== undefined);
  const missing = args.symbols.filter((s) => !bySymbol.has(s.toUpperCase()));
  if (missing.length > 0) console.log(`  (not listed, skipping: ${missing.join(', ')})`);
  if (targets.length === 0) throw new Error('none of the requested markets exist');

  const days = Math.round(args.months * 30);

  /**
   * The three clocks come from the SAME config the runtime would use for this mode, so a
   * backtest cannot silently measure different timeframes than production runs.
   */
  const modeConfig = loadConfig({ STRATEGY_MODE: args.strategy });
  const tf = {
    trend: modeConfig.raw.TREND_TIMEFRAME,
    structure: modeConfig.raw.STRUCTURE_TIMEFRAME,
    trigger: modeConfig.raw.TRIGGER_TIMEFRAME,
  };
  const barMinutes = (timeframe: string): number => {
    const match = /^(\d+)([mhd])$/.exec(timeframe);
    if (!match) throw new Error(`unsupported timeframe in config: ${timeframe}`);
    const value = Number(match[1]);
    return match[2] === 'm' ? value : match[2] === 'h' ? value * 60 : value * 1_440;
  };
  const barsFor = (timeframe: string): number =>
    Math.ceil((days * 24 * 60) / barMinutes(timeframe)) + 5;

  console.log(
    `Strategy ${args.strategy.toUpperCase()} (${tf.trend}/${tf.structure}/${tf.trigger}) — ` +
      `fetching ${days} days per market: ` +
      `${tf.trend}=${barsFor(tf.trend)} ${tf.structure}=${barsFor(tf.structure)} ${tf.trigger}=${barsFor(tf.trigger)} bars\n`,
  );

  const markets: ReplayMarketInput[] = [];

  // A cached dataset makes a parameter sweep offline and instant, which matters because
  // each fetch is ~2s per 1500 bars and a sweep needs the SAME candles for every run.
  if (args.loadPath !== undefined) {
    const raw = JSON.parse(await readFile(args.loadPath, 'utf8')) as {
      markets: { market: MarketInfo; trendCandles: Candle[]; structureCandles: Candle[]; triggerCandles: Candle[] }[];
    };
    for (const entry of raw.markets) markets.push(entry);
    console.log(`Loaded ${markets.length} cached markets from ${args.loadPath}`);
  }

  for (const market of args.loadPath !== undefined ? [] : targets) {
    const symbol = market.marketDisplayName;
    process.stdout.write(`  ${symbol.padEnd(10)}`);
    try {
      const trendCandles = await fetchHistory({
        rest, symbol, timeframe: tf.trend, count: barsFor(tf.trend),
      });
      const structureCandles = await fetchHistory({
        rest, symbol, timeframe: tf.structure, count: barsFor(tf.structure),
      });
      const triggerCandles = await fetchHistory({
        rest, symbol, timeframe: tf.trigger, count: barsFor(tf.trigger),
      });
      if (triggerCandles.length === 0) {
        console.log(` no ${tf.trigger} data, skipping`);
        continue;
      }
      console.log(
        ` ${tf.trend}=${trendCandles.length} ${tf.structure}=${structureCandles.length} ${tf.trigger}=${triggerCandles.length}` +
          `  (${new Date(triggerCandles[0]!.openTime / 1000).toISOString().slice(0, 10)} → ` +
          `${new Date(triggerCandles[triggerCandles.length - 1]!.openTime / 1000).toISOString().slice(0, 10)})`,
      );
      markets.push({ market, trendCandles, structureCandles, triggerCandles });
    } catch (error) {
      console.log(` failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (markets.length === 0) throw new Error('no usable market history');

  if (args.savePath !== undefined) {
    await writeFile(args.savePath, JSON.stringify({ markets }), 'utf8');
    console.log(`Saved ${markets.length} markets to ${args.savePath}`);
  }

  /* ---- run ---- */
  const scenarios = args.triple
    ? [
        { label: 'A: every touched ALO fills (optimistic bound)', maker: 1.0 },
        { label: 'B: 70% of touched ALO orders fill (realistic)', maker: 0.7 },
        { label: 'C: 40% of touched ALO orders fill (pessimistic)', maker: 0.4 },
      ]
    : [{ label: `maker fill probability ${args.makerFill}`, maker: args.makerFill }];

  const equityAtStart = dec(args.equity);
  for (const scenario of scenarios) {
    const perMarket: ReplayResult[] = [];
    for (const input of markets) {
      const config = baseConfig(args, input.market, scenario.maker);
      perMarket.push(replayMarkets({ markets: [input], config }));
    }

    // Aggregate: concatenate trades from the independent per-market runs, then re-derive
    // the headline numbers from the actual trade list so nothing is double-counted.
    const allTrades = perMarket.flatMap((r) => r.trades);
    const net = allTrades.reduce((a, t) => a + Number(t.netPnl), 0);
    const gross = allTrades.reduce((a, t) => a + Number(t.grossPnl), 0);
    const fees = allTrades.reduce((a, t) => a + Number(t.fees), 0);
    const funding = allTrades.reduce((a, t) => a + Number(t.funding), 0);
    const slip = allTrades.reduce((a, t) => a + Number(t.slippage), 0);
    const wins = allTrades.filter((t) => Number(t.netPnl) > 0);
    const losses = allTrades.filter((t) => Number(t.netPnl) < 0);
    const grossWin = wins.reduce((a, t) => a + Number(t.netPnl), 0);
    const grossLoss = Math.abs(losses.reduce((a, t) => a + Number(t.netPnl), 0));
    const makerFills = allTrades.filter((t) => t.filledAsMaker).length;

    // Peak-to-trough on the summed per-market equity curves would double-count markets,
    // so drawdown is taken from the worst single-market run: a conservative reading.
    const worstDd = Math.max(0, ...perMarket.map((r) => Number(r.metrics.maxDrawdownPct)));

    console.log(`\n${'='.repeat(78)}`);
    console.log(`### ${scenario.label}`);
    console.log(`${'='.repeat(78)}`);
    console.log(`  markets          ${markets.map((m) => m.market.marketDisplayName).join(', ')}`);
    console.log(`  trades           ${allTrades.length}  (${wins.length}W / ${losses.length}L)`);
    console.log(`  NET PnL          ${net.toFixed(2)}   on ${equityAtStart.toFixed(0)} per market`);
    console.log(`  gross PnL        ${gross.toFixed(2)}`);
    console.log(`  fees             ${fees.toFixed(2)}`);
    console.log(`  funding          ${funding.toFixed(2)}`);
    console.log(`  slippage         ${slip.toFixed(2)}`);
    console.log(`  win rate         ${allTrades.length ? ((wins.length / allTrades.length) * 100).toFixed(1) : '0.0'}%`);
    console.log(`  profit factor    ${grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : 'n/a (no losing trades)'}`);
    console.log(`  expectancy       ${allTrades.length ? (net / allTrades.length).toFixed(2) : '0.00'} per trade`);
    console.log(`  maker fill rate  ${allTrades.length ? ((makerFills / allTrades.length) * 100).toFixed(1) : '0.0'}%`);

    /* ---- Throughput ------------------------------------------------ *
     * Answers "how much does this actually trade per day?", which is the question
     * that decides whether a volume goal is even reachable. Reported per calendar
     * day of the DATA WINDOW, not per trading day, so weekends/holidays on the
     * equity markets count as zero-trade days — which is the honest denominator for
     * "how many trades per day will I see".
     */
    {
      const spansMs = allTrades.flatMap((t) => [t.entryTimeMs, t.exitTimeMs]);
      const firstMs = Math.min(...spansMs);
      const lastMs = Math.max(...spansMs);
      const days = Math.max(1, (lastMs - firstMs) / 86_400_000);

      const notionalOf = (t: { entryPrice: string; quantity: string }): number =>
        Math.abs(Number(t.entryPrice) * Number(t.quantity));
      const totalNotional = allTrades.reduce((a, t) => a + notionalOf(t), 0);
      const avgNotional = allTrades.length > 0 ? totalNotional / allTrades.length : 0;
      // A round trip trades the entry notional twice (in and out).
      const roundTripNotional = totalNotional * 2;

      const holds = allTrades
        .map((t) => t.exitTimeMs - t.entryTimeMs)
        .filter((ms) => ms >= 0);
      const avgHoldHours =
        holds.length > 0 ? holds.reduce((a, b) => a + b, 0) / holds.length / 3_600_000 : 0;

      console.log(
        `  trades / day     ${(allTrades.length / days).toFixed(3)}  (${allTrades.length} over ${days.toFixed(0)} days)`,
      );
      console.log(
        `  notional / trade ${avgNotional.toFixed(0)}  |  notional / day ${(totalNotional / days).toFixed(0)}`,
      );
      console.log(
        `  volume / day     ${(roundTripNotional / days).toFixed(0)} (round trip)  |  total ${roundTripNotional.toFixed(0)}`,
      );
      console.log(`  avg hold         ${avgHoldHours.toFixed(1)} h`);
      console.log(`  days to $1M      ${roundTripNotional > 0 ? (1_000_000 / (roundTripNotional / days)).toFixed(0) : 'n/a'}`);
    }
    console.log(`  worst mkt DD     ${worstDd.toFixed(2)}%`);
    const avgR = allTrades.map((t) => t.rMultiple).filter((r): r is string => r !== undefined);
    console.log(`  avg R            ${avgR.length ? (avgR.reduce((a, r) => a + Number(r), 0) / avgR.length).toFixed(2) : 'n/a'}`);

    // Exit distribution: the single most diagnostic number. A stop-dominated
    // distribution means the invalidation level is too tight for the volatility, not
    // that the entries were wrong; a target-dominated one with a poor PF means costs.
    const exitCounts = new Map<string, number>();
    for (const t of allTrades) exitCounts.set(t.exitReason, (exitCounts.get(t.exitReason) ?? 0) + 1);
    console.log(
      `  exits            ${[...exitCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}=${v} (${((v / allTrades.length) * 100).toFixed(0)}%)`)
        .join(', ')}`,
    );

    const rWins = wins.map((t) => Number(t.rMultiple ?? 0));
    const rLosses = losses.map((t) => Number(t.rMultiple ?? 0));
    console.log(
      `  avg R win/loss   ${rWins.length ? (rWins.reduce((a, r) => a + r, 0) / rWins.length).toFixed(2) : 'n/a'} / ` +
        `${rLosses.length ? (rLosses.reduce((a, r) => a + r, 0) / rLosses.length).toFixed(2) : 'n/a'}`,
    );

    // Gross before costs vs costs, so the split between "bad signal" and "eaten by
    // costs" is explicit. GP = gross PnL already excludes fees/funding/slippage.
    const costTotal = fees + Math.abs(funding) + slip;
    console.log(
      `  signal vs cost   gross ${gross.toFixed(2)} | costs ${costTotal.toFixed(2)} ` +
        `(${gross !== 0 ? ((costTotal / Math.abs(gross)) * 100).toFixed(0) : '0'}% of gross magnitude)`,
    );

    // How much of the result rests on intrabar ambiguity rather than on the signal.
    const ambiguous = perMarket.reduce((a, r) => a + r.metrics.signals.ambiguousBarStops, 0);
    const stopExits = exitCounts.get('stop') ?? 0;
    console.log(
      `  ambiguous stops  ${ambiguous}${stopExits > 0 ? ` of ${stopExits} stop exits (${((ambiguous / stopExits) * 100).toFixed(0)}%)` : ''}` +
        '  [bar contained BOTH stop and target; resolved to the stop]',
    );

    const adverse = allTrades
      .map((t) => t.adverseSelectionR)
      .filter((r): r is string => r !== undefined);
    const adverseAvg =
      adverse.length > 0
        ? `${(adverse.reduce((a, r) => a + Number(r), 0) / adverse.length).toFixed(2)}R`
        : 'n/a';
    console.log(`  avg adverse      ${adverseAvg}`);

    for (const [i, input] of markets.entries()) {
      const r = perMarket[i]!;
      console.log(
        `    ${input.market.marketDisplayName.padEnd(9)} ${String(r.metrics.tradeCount).padStart(3)}t ` +
          `${money(r.metrics.netPnl).padStart(10)}  PF ${(r.metrics.profitFactor ? Number(r.metrics.profitFactor) : 0).toFixed(2).padStart(5)}  ` +
          `win ${pct(r.metrics.winRate).padStart(6)}  signals ${r.metrics.signals.signalsFired}`,
      );
    }
  }

  console.log(`\n${'─'.repeat(78)}`);
  console.log('Caveats — read before drawing conclusions:');
  console.log('  • Entry fills are modelled probabilistically (deterministic hash, not Math.random).');
  console.log('    Scenario A assumes every touched ALO fills; that is an upper bound, not an estimate.');
  console.log('  • The replay trails on an ATR multiple only when --trailing-atr is set; the live');
  console.log('    PositionManager trails on the 9 EMA after a 0.5R move. Exit paths differ.');
  console.log('  • Funding is charged as |rate| x holding time, never credited, and uses the CURRENT');
  console.log('    rate as a constant. Real funding varies hourly and can flip sign.');
  console.log('  • Half-spread is a constant given to the cost gate; the live system measures it.');
  console.log('  • No liquidity constraint: the replay never checks that the modelled size would');
  console.log('    actually fill against the book.');
  console.log('  • Per-market runs are independent; the aggregate is not a portfolio simulation.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
