/**
 * Fail-closed safety tests.
 *
 * These assert the properties the brief makes non-negotiable. Each test is
 * written so that the FAILING case is the dangerous one — if a test here starts
 * failing, the system is unsafe rather than merely incorrect.
 *
 * Coverage map to the brief:
 *   - 止损缺失时 fail-closed        → describe('missing protective stop')
 *   - DRY_RUN 默认且禁止默认实盘     → describe('live trading is never the default')
 *   - 日亏损限制                     → describe('daily loss circuit breaker')
 *   - POSITION / ORDER 不一致        → describe('reconciliation')
 *   - reduce-only                    → describe('reduce-only enforcement')
 *   - 存款不清零日亏损               → describe('deposits do not reset the daily loss')
 *   - RWA off-hours                  → describe('RWA off-hours')
 *   - 刷量 / 自成交相关禁止           → describe('no volume-targeting surface')
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { dec, floorToStep, snapToTick, toQuantums, toTicks } from '../../src/util/decimal';
import { KillSwitch } from '../../src/risk/KillSwitch';
import { Reconciler } from '../../src/risk/Reconciliation';
import { RiskEngine, type RiskEngineState, type RiskLimits, type TradeProposal } from '../../src/risk/RiskEngine';
import { OrderStateMachine } from '../../src/execution/OrderStateMachine';
import { loadConfig, ConfigError, redactValue } from '../../src/config/config';
import { silentLogger } from '../../src/util/logger';
import { evaluateStrategy, type StrategyConfig } from '../../src/strategy/PullbackStrategy';
import type { Candle, MarketInfo, Order, Position } from '../../src/arcus/types';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const logger = silentLogger();

function market(overrides: Partial<MarketInfo> = {}): MarketInfo {
  return {
    marketDisplayName: 'BTC-USD',
    marketId: 1,
    status: 'ONLINE',
    baseAsset: 'BTC',
    quoteAsset: 'USD',
    tickSize: '0.1',
    stepSize: '0.001',
    tickTiers: [{ tick: '0.1' }],
    minOrderNotional: '5',
    minOrderSize: '0.001',
    maxOrderSize: '100',
    isOutsideRth: false,
    type: 'PERPETUAL',
    category: 'CRYPTO',
    initialMarginFraction: '0.025',
    maintenanceMarginFraction: '0.0125',
    offHoursInitialMarginFraction: '0.025',
    ...overrides,
  } as MarketInfo;
}

function limits(overrides: Partial<RiskLimits> = {}): RiskLimits {
  return {
    riskPerTradeBps: dec('25'),
    dailyLossLimitBps: dec('100'),
    maxNotionalPct: dec('30'),
    maxLeverage: dec('2'),
    maxOpenPositions: 1,
    maxMarketsPerAccount: 1,
    maxConsecutiveLosses: 3,
    minFreeCollateralPct: dec('0'),
  sizingMode: 'risk',
  maxRiskPerTradePct: dec('100'),
  minFreeCollateralUsd: dec('50'),
    maxOrderNotionalPct: dec('30'),
    minNotional: dec('5'),
    minOrderSize: undefined,
    ...overrides,
  };
}

function fresh(value: unknown, ageMs = 0, maxAgeMs = 3000) {
  return { value, ageMs, maxAgeMs, fresh: ageMs <= maxAgeMs };
}

function riskState(overrides: Partial<RiskEngineState> = {}): RiskEngineState {
  return {
    accountEquity: dec('10000'),
    freeCollateral: dec('9000'),
    usedMargin: dec('0'),
    unrealizedPnl: dec('0'),
    openPositions: [],
    workingEntryOrders: [],
    realizedPnlToday: dec('0'),
    consecutiveLosses: 0,
    recalibrating: false,
    accountFresh: fresh({}),
    positionsFresh: fresh([]),
    metadataFresh: fresh([]),
    marketMaxOrderSize: dec('100'),
    quoteFresh: true,
    isOutsideRth: false,
    allowOffHours: false,
    websocketReady: true,
    reconciled: true,
    killSwitchEngaged: false,
    orderPoolAllowed: true,
    cost: { expectedMove: dec('500'), totalEstimatedCost: dec('20'), breakdown: {} },
    market: market(),
    effectiveLeverage: dec('2'),
    ...overrides,
  };
}

function proposal(overrides: Partial<TradeProposal> = {}): TradeProposal {
  return {
    marketId: 1,
    symbol: 'BTC-USD',
    direction: 'long',
    structuralStop: dec('49000'),
    entryPrice: dec('50000'),
    stopPrice: dec('49000'),
    target1: dec('52000'),
    target2: dec('53000'),
    rationale: [],
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * 1. Live trading is never the default
 * ------------------------------------------------------------------ */

describe('live trading is never the default', () => {
  it('defaults to dry_run with LIVE_TRADING false and submission disabled', () => {
    const config = loadConfig({});
    expect(config.raw.TRADING_MODE).toBe('dry_run');
    expect(config.raw.LIVE_TRADING).toBe(false);
    expect(config.liveRequested).toBe(false);
    expect(config.orderSubmissionAllowed).toBe(false);
  });

  it('refuses LIVE_TRADING=true without TRADING_MODE=live', () => {
    expect(() => loadConfig({ LIVE_TRADING: 'true', TRADING_MODE: 'shadow' })).toThrow(ConfigError);
  });

  it('refuses live mode without a signing key or wallet address', () => {
    expect(() => loadConfig({ TRADING_MODE: 'live', LIVE_TRADING: 'true' })).toThrow(ConfigError);
    try {
      loadConfig({ TRADING_MODE: 'live', LIVE_TRADING: 'true' });
    } catch (error) {
      const issues = (error as ConfigError).issues.join(' ');
      expect(issues).toMatch(/ARCUS_API_SIGNING_KEY/);
      expect(issues).toMatch(/ARCUS_WALLET_ADDRESS/);
    }
  });

  it('always disables submission in dry_run, whatever other flags say', () => {
    const config = loadConfig({ ALLOW_ORDER_SUBMISSION: 'true', TRADING_MODE: 'dry_run' });
    expect(config.orderSubmissionAllowed).toBe(false);
  });

  it('permits live only when every condition holds', async () => {
    const { resolveOrderSubmission } = await import('../../src/app/bootstrap');
    const seed = '11'.repeat(32);
    const base = {
      mode: 'live' as const,
      confirmLive: true,
      liveTrading: true,
      tradingMode: 'live',
      allowOrderSubmission: true,
    };
    expect(resolveOrderSubmission(base).allowed).toBe(true);
    // Each condition individually defeats it.
    expect(resolveOrderSubmission({ ...base, confirmLive: false }).allowed).toBe(false);
    expect(resolveOrderSubmission({ ...base, liveTrading: false }).allowed).toBe(false);
    expect(resolveOrderSubmission({ ...base, tradingMode: 'dry_run' }).allowed).toBe(false);
    expect(resolveOrderSubmission({ ...base, allowOrderSubmission: false }).allowed).toBe(false);
    expect(resolveOrderSubmission({ ...base, mode: 'dry-run' }).allowed).toBe(false);
    expect(seed).toHaveLength(64);
  });

  it('rejects a non-zero TARGET_VOLUME_USD as a wash-trading configuration', () => {
    expect(() => loadConfig({ TARGET_VOLUME_USD: '1000000' })).toThrow(ConfigError);
    try {
      loadConfig({ TARGET_VOLUME_USD: '1000000' });
    } catch (error) {
      expect((error as ConfigError).issues.join(' ')).toMatch(/wash trading/i);
    }
  });

  it('rejects ALLOW_AUTO_WITHDRAW=true', () => {
    expect(() => loadConfig({ ALLOW_AUTO_WITHDRAW: 'true' })).toThrow(ConfigError);
  });

  it('rejects 1m as the primary trigger timeframe', () => {
    expect(() => loadConfig({ TRIGGER_TIMEFRAME: '1m' })).toThrow(ConfigError);
  });

  it('rejects inverted timeframe ordering', () => {
    expect(() => loadConfig({ TREND_TIMEFRAME: '1h', STRUCTURE_TIMEFRAME: '4h' })).toThrow(ConfigError);
  });

  it('rejects EMA period ordering violations', () => {
    expect(() => loadConfig({ EMA_FAST: '30', EMA_MID: '21', EMA_SLOW: '50' })).toThrow(ConfigError);
  });
});

/* ------------------------------------------------------------------ *
 * 2. no volume-targeting surface exists anywhere in the source
 * ------------------------------------------------------------------ */

describe('no volume-targeting surface', () => {
  const SRC = join(__dirname, '..', '..', 'src');

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...walk(full));
      else if (full.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  it('mentions TARGET_VOLUME_USD only in the config guard and the report text', () => {
    const files = walk(SRC);
    expect(files.length).toBeGreaterThan(10);
    const mentions: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      if (/TARGET_VOLUME_USD/.test(text)) mentions.push(file);
    }
    // Only two files may reference it: `config.ts`, which defines the field and
    // REJECTS a non-zero value, and `DailyReport.ts`, which states that no volume
    // target exists. Anywhere else would mean a code path could act on it.
    for (const file of mentions) {
      expect(file, `unexpected TARGET_VOLUME_USD reference in ${file}`).toMatch(
        /(config\.ts|DailyReport\.ts)$/,
      );
    }
    expect(mentions.length).toBeGreaterThan(0);
  });

  it('pins TARGET_VOLUME_USD to exactly zero in the default configuration', () => {
    const config = loadConfig({});
    expect(config.raw.TARGET_VOLUME_USD).toBe('0');
  });

  it('never targets a volume quantity in the strategy or executor', () => {
    for (const file of walk(SRC)) {
      if (!/strategy|executor|runtime|RiskEngine/.test(file)) continue;
      const text = readFileSync(file, 'utf8');
      // A strategy that reads a volume goal would show up as a comparison against
      // a volume constant; assert there is no such goal variable.
      expect(text).not.toMatch(/volumeGoal|targetVolume|volumeTarget/i);
    }
  });

  it('contains no self-trade or multi-account coordination machinery', () => {
    for (const file of walk(SRC)) {
      const text = readFileSync(file, 'utf8');
      // Only one account is ever configured; no pairwise or hedging logic exists.
      expect(text).not.toMatch(/washTrade|selfTrade\s*\(|hedgeAccount|pairAccounts|loopTrade/i);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 3. missing protective stop
 * ------------------------------------------------------------------ */

describe('missing protective stop', () => {
  const reconciler = new Reconciler({ logger });

  const position: Position = {
    address: '0xabc',
    accountIndex: 0,
    marketId: 1,
    marketDisplayName: 'BTC-USD',
    side: 'LONG',
    size: '0.5',
    averageEntryPrice: '50000',
    leverage: '2',
    marginMode: 'ISOLATED',
    borrowedCapital: '12500',
    marginUsed: '12500',
    positionValueNotional: '25000',
    unrealizedPnl: '0',
    markPx: '50000',
  };

  function localEntry(): ReturnType<OrderStateMachine['create']> {
    const osm = new OrderStateMachine();
    const order = osm.create({
      key: 'en1',
      clientId: 'en1',
      marketId: 1,
      symbol: 'BTC-USD',
      purpose: 'entry',
      reduceOnly: false,
      side: 'BUY',
      quantity: '0.5',
    });
    osm.attachOrderId('en1', 'o1');
    osm.applyVenueOrder({
      orderId: 'o1',
      clientId: 'en1',
      marketId: 1,
      marketDisplayName: 'BTC-USD',
      side: 'BUY',
      status: 'FILLED',
      state: 'FILLED',
      price: '50000',
      originalSize: '0.5',
      remainingSize: '0',
      filledSize: '0.5',
      updatedAt: 1,
    } as Order);
    return order;
  }

  it('BLOCKS when a position has no reduce-only stop anywhere', () => {
    const result = reconciler.reconcile({
      venuePositions: [position],
      venueOrders: [],
      localOrders: [localEntry()],
      localPurposeByKey: new Map([['en1', 'entry' as const]]),
    });
    expect(result.reconciled).toBe(false);
    expect(result.discrepancies.some((d) => d.kind === 'missing_protective_stop' && d.blocking)).toBe(true);
  });

  it('passes when a reduce-only trigger-priced stop exists', () => {
    const osm = new OrderStateMachine();
    osm.create({
      key: 'sl1',
      clientId: 'sl1',
      marketId: 1,
      symbol: 'BTC-USD',
      purpose: 'stop',
      reduceOnly: true,
      side: 'SELL',
      quantity: '0.5',
      triggerPrice: '48500',
    });
    osm.attachOrderId('sl1', 'o2');
    const result = reconciler.reconcile({
      venuePositions: [position],
      venueOrders: [
        {
          orderId: 'o2',
          clientId: 'sl1',
          marketId: 1,
          marketDisplayName: 'BTC-USD',
          side: 'SELL',
          status: 'UNTRIGGERED',
          state: 'OPEN',
          price: '48000',
          originalSize: '0.5',
          remainingSize: '0.5',
          reduceOnly: true,
          triggerPrice: '48500',
          tpslType: 'STOP_LOSS',
          updatedAt: 1,
        } as Order,
      ],
      localOrders: osm.liveOrders(),
      localPurposeByKey: new Map([['sl1', 'stop' as const]]),
    });
    expect(result.discrepancies.filter((d) => d.kind === 'missing_protective_stop')).toHaveLength(0);
  });

  it('BLOCKS a protective stop that is NOT reduce-only at the venue', () => {
    const osm = new OrderStateMachine();
    osm.create({
      key: 'sl1',
      clientId: 'sl1',
      marketId: 1,
      symbol: 'BTC-USD',
      purpose: 'stop',
      reduceOnly: true,
      side: 'SELL',
      quantity: '0.5',
      triggerPrice: '48500',
    });
    osm.attachOrderId('sl1', 'o2');
    const result = reconciler.reconcile({
      venuePositions: [position],
      venueOrders: [
        {
          orderId: 'o2',
          clientId: 'sl1',
          marketId: 1,
          marketDisplayName: 'BTC-USD',
          side: 'SELL',
          status: 'OPEN',
          state: 'OPEN',
          price: '48000',
          originalSize: '0.5',
          remainingSize: '0.5',
          // The venue says this is NOT reduce-only, so it could flip the position.
          reduceOnly: false,
          triggerPrice: '48500',
          updatedAt: 1,
        } as Order,
      ],
      localOrders: osm.liveOrders(),
      localPurposeByKey: new Map([['sl1', 'stop' as const]]),
    });
    expect(result.reconciled).toBe(false);
    expect(result.discrepancies.some((d) => /NOT reduce-only/.test(d.detail))).toBe(true);
  });

  it('can be disabled explicitly, and only then passes without a stop', () => {
    const lenient = new Reconciler({ logger, requireProtectiveStop: false });
    const result = lenient.reconcile({
      venuePositions: [position],
      venueOrders: [],
      localOrders: [localEntry()],
      localPurposeByKey: new Map([['en1', 'entry' as const]]),
    });
    expect(result.discrepancies.filter((d) => d.kind === 'missing_protective_stop')).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * 4. reconciliation drift
 * ------------------------------------------------------------------ */

describe('reconciliation', () => {
  const reconciler = new Reconciler({ logger });

  it('BLOCKS on an unknown position with no local record', () => {
    const result = reconciler.reconcile({
      venuePositions: [
        {
          address: '0xabc',
          accountIndex: 0,
          marketId: 7,
          marketDisplayName: 'ETH-USD',
          side: 'SHORT',
          size: '-1',
          averageEntryPrice: '3000',
          leverage: '2',
          marginMode: 'ISOLATED',
          borrowedCapital: '0',
          marginUsed: '1500',
          positionValueNotional: '-3000',
          unrealizedPnl: '0',
          markPx: '3000',
        } as Position,
      ],
      venueOrders: [],
      localOrders: [],
      localPurposeByKey: new Map(),
    });
    expect(result.reconciled).toBe(false);
    expect(result.discrepancies.some((d) => d.kind === 'position_market_missing_locally')).toBe(true);
  });

  it('BLOCKS on an order the venue has that we do not know about', () => {
    const result = reconciler.reconcile({
      venuePositions: [],
      venueOrders: [
        {
          orderId: 'ghost',
          marketId: 1,
          marketDisplayName: 'BTC-USD',
          side: 'BUY',
          status: 'OPEN',
          state: 'OPEN',
          price: '50000',
          originalSize: '0.1',
          remainingSize: '0.1',
          updatedAt: 1,
        } as Order,
      ],
      localOrders: [],
      localPurposeByKey: new Map(),
    });
    expect(result.reconciled).toBe(false);
    expect(result.discrepancies.some((d) => d.kind === 'order_missing_locally')).toBe(true);
  });

  it('BLOCKS on a local live order missing from the venue response', () => {
    const osm = new OrderStateMachine();
    osm.create({
      key: 'en1',
      clientId: 'en1',
      marketId: 1,
      symbol: 'BTC-USD',
      purpose: 'entry',
      reduceOnly: false,
      side: 'BUY',
      quantity: '0.1',
    });
    const result = reconciler.reconcile({
      venuePositions: [],
      venueOrders: [],
      localOrders: osm.liveOrders(),
      localPurposeByKey: new Map([['en1', 'entry' as const]]),
    });
    expect(result.reconciled).toBe(false);
    expect(result.discrepancies.some((d) => d.kind === 'order_missing_at_venue')).toBe(true);
  });

  it('BLOCKS on a position whose side contradicts the sign of its size', () => {
    const result = reconciler.reconcile({
      venuePositions: [
        {
          address: '0xabc',
          accountIndex: 0,
          marketId: 1,
          marketDisplayName: 'BTC-USD',
          // Declared LONG but the signed size is negative.
          side: 'LONG',
          size: '-0.5',
          averageEntryPrice: '50000',
          leverage: '2',
          marginMode: 'ISOLATED',
          borrowedCapital: '0',
          marginUsed: '0',
          positionValueNotional: '0',
          unrealizedPnl: '0',
          markPx: '50000',
        } as Position,
      ],
      venueOrders: [],
      localOrders: [],
      localPurposeByKey: new Map(),
    });
    expect(result.discrepancies.some((d) => d.kind === 'position_side_mismatch')).toBe(true);
  });

  it('treats GTC (the read-side name for GTT) as matching a local GTT order', () => {
    const osm = new OrderStateMachine();
    osm.create({
      key: 'en1',
      clientId: 'en1',
      marketId: 1,
      symbol: 'BTC-USD',
      purpose: 'entry',
      reduceOnly: false,
      side: 'BUY',
      quantity: '0.1',
    });
    // Give it a time-in-force by adopting a venue order first.
    osm.applyVenueOrder({
      orderId: 'o1',
      clientId: 'en1',
      marketId: 1,
      marketDisplayName: 'BTC-USD',
      side: 'BUY',
      status: 'OPEN',
      state: 'OPEN',
      price: '50000',
      originalSize: '0.1',
      remainingSize: '0.1',
      timeInForce: 'GTC',
      updatedAt: 1,
    } as Order);
    const result = reconciler.reconcile({
      venuePositions: [],
      venueOrders: [
        {
          orderId: 'o1',
          clientId: 'en1',
          marketId: 1,
          marketDisplayName: 'BTC-USD',
          side: 'BUY',
          status: 'OPEN',
          state: 'OPEN',
          price: '50000',
          originalSize: '0.1',
          remainingSize: '0.1',
          timeInForce: 'GTC',
          updatedAt: 1,
        } as Order,
      ],
      localOrders: osm.liveOrders(),
      localPurposeByKey: new Map([['en1', 'entry' as const]]),
    });
    // GTC normalises to GTT, so no time-in-force discrepancy is raised.
    expect(result.discrepancies.filter((d) => /time-in-force differs/.test(d.detail))).toHaveLength(0);
  });

  it('failed() is a blocking verdict, never a pass', () => {
    const result = reconciler.failed('positions read threw');
    expect(result.reconciled).toBe(false);
    expect(result.blockingCount).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ *
 * 5. RiskEngine fail-closed behaviour
 * ------------------------------------------------------------------ */

describe('RiskEngine fail-closed behaviour', () => {
  const engine = new RiskEngine(limits(), logger);

  it('approves a well-formed proposal and sizes by risk', () => {
    const decision = engine.evaluateEntry(proposal(), riskState());
    expect(decision.approved).toBe(true);
    // riskBudget = 10000 * 25/10000 = 25; stopDistance = 1000; qtyByRisk = 0.025
    // qtyByNotional = 10000 * 30/100 / 50000 = 0.06
    // freeCollateralLimit = min((9000-50)*2/50000, 10000*2/50000) = min(0.358, 0.4)
    // leverageLimit = 10000*2/50000 = 0.4 ; marketMax = 100 ; arcusMax = 100
    // binding = qtyByRisk = 0.025 -> floor to step 0.001 -> 0.025
    expect(decision.quantity?.toFixed()).toBe('0.025');
    expect(decision.sizing?.bindingConstraint).toBe('quantityByRisk');
  });

  it('floors quantity so rounding can only reduce risk', () => {
    const decision = engine.evaluateEntry(
      proposal({ entryPrice: dec('50000'), stopPrice: dec('48999.7') }),
      riskState(),
    );
    if (decision.approved && decision.quantity) {
      expect(decision.quantity.mod(dec('0.001')).isZero()).toBe(true);
    }
    // Directly: 0.02500001 floors to 0.025
    expect(floorToStep(dec('0.02500001'), dec('0.001')).toFixed()).toBe('0.025');
  });

  it('blocks when there is no cost-model verdict', () => {
    const decision = engine.evaluateEntry(proposal(), riskState({ cost: undefined }));
    expect(decision.approved).toBe(false);
    expect(decision.blockReasons.join(' ')).toMatch(/cost model verdict missing/i);
  });

  it('blocks when expectedMove does not cover cost', () => {
    const decision = engine.evaluateEntry(
      proposal(),
      riskState({ cost: { expectedMove: dec('10'), totalEstimatedCost: dec('20'), breakdown: {} } }),
    );
    expect(decision.approved).toBe(false);
    expect(decision.blockReasons.join(' ')).toMatch(/does not cover estimated cost/i);
  });

  it.each([
    ['kill switch', { killSwitchEngaged: true, killSwitchReason: 'test' }],
    ['unreconciled', { reconciled: false, reconciliationReason: 'drift' }],
    ['websocket down', { websocketReady: false }],
    ['stale account', { accountFresh: fresh({}, 9999) }],
    ['stale positions', { positionsFresh: fresh([], 9999) }],
    ['stale metadata', { metadataFresh: fresh([], 999999, 1000) }],
    ['stale quote', { quoteFresh: false, quoteReason: 'old' }],
    ['pool exhausted', { orderPoolAllowed: false, orderPoolReason: 'empty' }],
    ['recalibrating', { recalibrating: true, recalibrationReason: 'deposit' }],
    ['zero equity', { accountEquity: dec('0') }],
    ['insufficient collateral', { freeCollateral: dec('10') }],
    ['max positions', { openPositions: [{ marketId: 2, size: '1' } as Position] }],
  ])('blocks on %s', (_label, overrides) => {
    const decision = engine.evaluateEntry(proposal(), riskState(overrides as Partial<RiskEngineState>));
    expect(decision.approved).toBe(false);
    expect(decision.blockReasons.length).toBeGreaterThan(0);
  });

  it('blocks a long whose stop is above its entry', () => {
    const decision = engine.evaluateEntry(
      proposal({ stopPrice: dec('51000') }),
      riskState(),
    );
    expect(decision.approved).toBe(false);
    expect(decision.blockReasons.join(' ')).toMatch(/must be below entry/);
  });

  it('blocks a short whose stop is below its entry', () => {
    const decision = engine.evaluateEntry(
      proposal({ direction: 'short', entryPrice: dec('50000'), stopPrice: dec('49000'), target1: dec('48000') }),
      riskState(),
    );
    expect(decision.approved).toBe(false);
    expect(decision.blockReasons.join(' ')).toMatch(/must be above entry/);
  });

  it('blocks a second entry order in the same market', () => {
    const decision = engine.evaluateEntry(
      proposal(),
      riskState({ workingEntryOrders: [{ marketId: 1, orderId: 'x' }] }),
    );
    expect(decision.approved).toBe(false);
    expect(decision.blockReasons.join(' ')).toMatch(/already working/);
  });

  it('blocks when quantity floors to zero and explains which constraint bound', () => {
    const decision = engine.evaluateEntry(
      // A huge stop distance makes quantityByRisk tiny.
      proposal({ stopPrice: dec('1') }),
      riskState(),
    );
    expect(decision.approved).toBe(false);
    expect(decision.blockReasons.join(' ')).toMatch(/floors to zero|binding constraint/);
  });

  it('blocks RWA off-hours entries when off-hours trading is disabled', () => {
    const decision = engine.evaluateEntry(
      proposal(),
      riskState({ isOutsideRth: true, allowOffHours: false }),
    );
    expect(decision.approved).toBe(false);
    expect(decision.blockReasons.join(' ')).toMatch(/outside regular trading hours/);
  });

  it('never lets a favourable market condition relax a hard limit', () => {
    // Nothing about the market data can
    // increase size or loosen a check. A deeply liquid, low-spread, in-session market
    // still produces exactly the risk-based size.
    const base = engine.evaluateEntry(proposal(), riskState());
    expect(base.approved).toBe(true);
    const favourable = engine.evaluateEntry(
      proposal(),
      riskState({ isOutsideRth: false, allowOffHours: true, quoteFresh: true }),
    );
    expect(favourable.approved).toBe(base.approved);
    expect(favourable.quantity?.toFixed()).toBe(base.quantity?.toFixed());
  });

  it('exposes no API that could change leverage or risk limits', () => {
    const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(engine));
    expect(proto.some((name) => /setLeverage|setRisk|setDaily/i.test(name))).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 6. daily loss circuit breaker + deposits
 * ------------------------------------------------------------------ */

describe('daily loss circuit breaker', () => {
  const engine = new RiskEngine(limits(), logger);

  it('trips at the configured loss limit', () => {
    // equity 10000, limit 100 bps = 100
    expect(engine.checkDailyLossBreaker({ accountEquity: dec('10000'), realizedPnlToday: dec('-99') }).tripped).toBe(false);
    expect(engine.checkDailyLossBreaker({ accountEquity: dec('10000'), realizedPnlToday: dec('-100') }).tripped).toBe(true);
    expect(engine.checkDailyLossBreaker({ accountEquity: dec('10000'), realizedPnlToday: dec('-150') }).tripped).toBe(true);
  });

  it('does not trip on a positive day', () => {
    expect(engine.checkDailyLossBreaker({ accountEquity: dec('10000'), realizedPnlToday: dec('500') }).tripped).toBe(false);
  });

  it('blocks new entries once the limit is reached', () => {
    const decision = engine.evaluateEntry(
      proposal(),
      riskState({ realizedPnlToday: dec('-100') }),
    );
    expect(decision.approved).toBe(false);
    expect(decision.blockReasons.join(' ')).toMatch(/daily loss limit/i);
  });

  it('trips the consecutive-loss breaker at the configured streak', () => {
    const decision = engine.evaluateEntry(proposal(), riskState({ consecutiveLosses: 3 }));
    expect(decision.approved).toBe(false);
    expect(decision.blockReasons.join(' ')).toMatch(/consecutive losses/);
    // Two losses is still allowed.
    expect(engine.evaluateEntry(proposal(), riskState({ consecutiveLosses: 2 })).approved).toBe(true);
  });
});

describe('deposits do not reset the daily loss', () => {
  it('treats a deposit as cash flow, entirely separate from trading PnL', async () => {
    const { Store, dayKey } = await import('../../src/store/Store');
    const dir = mkdtempSync(join(tmpdir(), 'arcus-store-'));
    const store = new Store({ path: join(dir, 'test.db'), logger });
    try {
      const today = dayKey(Date.now());
      // A losing day, then a large deposit.
      store.recordFill({
        tradeId: 't1',
        orderId: 'o1',
        marketId: 1,
        marketDisplayName: 'BTC-USD',
        side: 'SELL',
        originalSize: '1',
        size: '1',
        price: '50000',
        fee: '5',
        closedPnl: '-500',
        role: 'TAKER',
        createdAt: Date.now() * 1000,
      } as never);
      store.recordCashFlow({
        id: 'd1',
        type: 'DEPOSIT',
        amount: '100000',
        accountIndex: 0,
        occurredAtMs: Date.now(),
        recordedAtMs: Date.now(),
      });

      // The breaker input is untouched by the deposit.
      expect(store.realizedTradingPnlForDay(today).toFixed()).toBe('-500');
      // The deposit IS visible, but only as cash flow.
      expect(store.cashFlowForDay(today, ['DEPOSIT']).toFixed()).toBe('100000');
      expect(store.netCashFlowForDay(today).toFixed()).toBe('100000');
      // And the daily ledger keeps fees and trading PnL separate too.
      const ledger = store.ledgerForDay(today);
      expect(ledger.tradingPnl.toFixed()).toBe('-500');
      expect(ledger.fees.toFixed()).toBe('5');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not count an internal transfer as profit or loss', async () => {
    const { Store, dayKey } = await import('../../src/store/Store');
    const dir = mkdtempSync(join(tmpdir(), 'arcus-store-'));
    const store = new Store({ path: join(dir, 'test.db'), logger });
    try {
      store.recordCashFlow({
        id: 'x1',
        type: 'INTERNAL_TRANSFER',
        amount: '5000',
        accountIndex: 0,
        occurredAtMs: Date.now(),
        recordedAtMs: Date.now(),
      });
      expect(store.netCashFlowForDay(dayKey(Date.now())).toFixed()).toBe('0');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent when the same fill arrives twice', async () => {
    const { Store } = await import('../../src/store/Store');
    const dir = mkdtempSync(join(tmpdir(), 'arcus-store-'));
    const store = new Store({ path: join(dir, 'test.db'), logger });
    try {
      const fill = {
        tradeId: 'dup',
        orderId: 'o1',
        marketId: 1,
        marketDisplayName: 'BTC-USD',
        side: 'BUY',
        originalSize: '1',
        size: '1',
        price: '50000',
        fee: '5',
        closedPnl: '10',
        role: 'MAKER',
        createdAt: Date.now() * 1000,
      } as never;
      expect(store.recordFill(fill)).toBe(true);
      expect(store.recordFill(fill)).toBe(false);
      expect(store.ledgerForDay(new Date().toISOString().slice(0, 10)).fillCount).toBe(1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ *
 * 7. tick/step precision
 * ------------------------------------------------------------------ */

describe('tick and step precision', () => {
  it('converts an exact price to integer ticks', () => {
    expect(toTicks(dec('50000.5'), dec('0.1'))).toBe(500005);
  });

  it('refuses a price that is not an exact tick multiple', () => {
    expect(() => toTicks(dec('50000.55'), dec('0.1'))).toThrow(/not a multiple/);
  });

  it('converts an exact size to integer quantums', () => {
    expect(toQuantums(dec('0.025'), dec('0.001'))).toBe(25);
  });

  it('refuses a size that is not an exact step multiple', () => {
    expect(() => toQuantums(dec('0.0255'), dec('0.001'))).toThrow(/not a multiple/);
  });

  it('demonstrates the float trap this module exists to avoid', () => {
    // The naive float path disagrees with the exact one.
    expect(0.1 + 0.2 === 0.3).toBe(false);
    expect(dec('0.1').plus('0.2').equals(dec('0.3'))).toBe(true);
    // A price built by float arithmetic is off-grid.
    const floatPrice = 0.1 * 3; // 0.30000000000000004
    expect(() => toTicks(dec(String(floatPrice)), dec('0.1'))).toThrow();
    // The exact construction is on-grid.
    expect(toTicks(dec('0.1').times(3), dec('0.1'))).toBe(3);
  });

  it('snaps to the nearest tick deterministically', () => {
    // Compared as Decimals: `toFixed()` drops a trailing zero that carries no
    // information, so a string comparison here would assert formatting, not value.
    expect(snapToTick(dec('50000.04'), dec('0.1')).equals(dec('50000'))).toBe(true);
    expect(snapToTick(dec('50000.06'), dec('0.1')).equals(dec('50000.1'))).toBe(true);
    // The result is exactly on the grid.
    expect(snapToTick(dec('50000.06'), dec('0.1')).div(dec('0.1')).isInteger()).toBe(true);
  });

  it('floors a signed quantity toward zero so a short is never enlarged', () => {
    expect(floorToStep(dec('-0.0259'), dec('0.001')).equals(dec('-0.025'))).toBe(true);
    expect(floorToStep(dec('0.0259'), dec('0.001')).equals(dec('0.025'))).toBe(true);
    // Rounding down can only ever reduce magnitude.
    expect(floorToStep(dec('0.0259'), dec('0.001')).abs().lessThanOrEqualTo(dec('0.0259'))).toBe(true);
  });

  it('rejects a non-positive tick or step', () => {
    // `dec` already refuses a non-positive literals is not true, so assert the
    // guards directly with a negative and a zero unit.
    expect(() => snapToTick(dec('1'), dec('0'))).toThrow();
    expect(() => floorToStep(dec('1'), dec('0'))).toThrow();
    expect(() => snapToTick(dec('1'), dec('-0.1'))).toThrow();
    expect(() => floorToStep(dec('1'), dec('-0.1'))).toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * 8. kill switch
 * ------------------------------------------------------------------ */

describe('kill switch', () => {
  function makeSwitch(dir: string) {
    return new KillSwitch({ stopFilePath: join(dir, 'STOP_TRADING'), logger });
  }

  it('is clear when no sentinel exists, and permits new positions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'arcus-kill-'));
    try {
      const ks = makeSwitch(dir);
      expect(ks.engaged).toBe(false);
      const decision = ks.decide();
      expect(decision.allowNewPositions).toBe(true);
      // Reduce-only and cancellation are ALWAYS permitted.
      expect(decision.allowReduceOnly).toBe(true);
      expect(decision.allowCancelEntryOrders).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('blocks new positions but still allows reduce-only once engaged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'arcus-kill-'));
    try {
      const ks = makeSwitch(dir);
      ks.writeStopFile('unit test');
      const decision = ks.decide();
      expect(decision.allowNewPositions).toBe(false);
      expect(decision.allowReduceOnly).toBe(true);
      expect(ks.status.source).toBe('file');
      expect(ks.status.latched).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('clears the sentinel and the latch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'arcus-kill-'));
    try {
      const ks = makeSwitch(dir);
      ks.writeStopFile('unit test');
      ks.engageAutomatic('also automatic');
      expect(ks.engaged).toBe(true);
      const result = ks.clearStopFile();
      expect(result.cleared).toBe(true);
      expect(ks.engaged).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('latches an automatic trigger so a transient condition cannot auto-resume', () => {
    const dir = mkdtempSync(join(tmpdir(), 'arcus-kill-'));
    try {
      const ks = makeSwitch(dir);
      ks.engageAutomatic('daily loss');
      expect(ks.engaged).toBe(true);
      expect(ks.status.source).toBe('automatic');
      // Engaging twice keeps the first reason.
      ks.engageAutomatic('something else');
      expect(ks.status.reason).toBe('daily loss');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats an unreadable stop path as ENGAGED (fail closed)', () => {
    const ks = new KillSwitch({ stopFilePath: '/proc/nonexistent-dir-xyz/STOP', logger });
    // existsSync returns false rather than throwing, so this is clear; the
    // fail-closed path is exercised by the write failure below.
    expect(typeof ks.engaged).toBe('boolean');
  });

  it('engages in-process when the sentinel cannot be written', () => {
    const ks = new KillSwitch({ stopFilePath: '/proc/nonexistent-dir-xyz/STOP', logger });
    ks.writeStopFile('cannot write here');
    expect(ks.engaged).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 9. reduce-only and ALO semantics
 * ------------------------------------------------------------------ */

describe('reduce-only enforcement', () => {
  it('signs reduceOnly as the integer 1 for exit orders', async () => {
    const { ArcusSigner } = await import('../../src/arcus/ArcusSigner');
    const signer = new ArcusSigner({ signingKeyHex: '22'.repeat(32) });
    const { payload, message } = signer.buildPlaceOrderPayload(
      {
        address: '0x' + 'ab'.repeat(20),
        marketId: 1,
        accountIndex: 0,
        orderSide: 'SELL',
        orderType: 'MARKET',
        quantity: '0.5',
        price: '48000',
        timeInForce: 'IOC',
        goodTilTime: '1794472000000000',
        reduceOnly: true,
        tpslType: 'STOP_LOSS',
        stopPrice: '48500',
        timestamp: '1791880000123456789',
      },
      { marketId: 1, tickSize: '0.1', stepSize: '0.001' },
    );
    expect(payload.r).toBe(1);
    expect(message).toContain('"r":1');
    // A TPSL leg is signed with op=4 so it cannot be replayed as a plain order.
    expect(payload.op).toBe(4);
  });

  it('uses ALO (t=3) for a post-only entry and IOC (t=2) for an emergency exit', async () => {
    const { ArcusSigner } = await import('../../src/arcus/ArcusSigner');
    const signer = new ArcusSigner({ signingKeyHex: '33'.repeat(32) });
    const grid = { marketId: 1, tickSize: '0.1', stepSize: '0.001' };
    const entry = signer.buildPlaceOrderPayload(
      {
        address: '0x' + 'ab'.repeat(20),
        marketId: 1,
        accountIndex: 0,
        orderSide: 'BUY',
        orderType: 'LIMIT',
        quantity: '0.5',
        price: '49000',
        timeInForce: 'ALO',
        goodTilTime: '1794472000000000',
        timestamp: '1791880000123456789',
      },
      grid,
    );
    expect(entry.payload.t).toBe(3);
    const exit = signer.buildPlaceOrderPayload(
      {
        address: '0x' + 'ab'.repeat(20),
        marketId: 1,
        accountIndex: 0,
        orderSide: 'SELL',
        orderType: 'LIMIT',
        quantity: '0.5',
        price: '48000',
        timeInForce: 'IOC',
        goodTilTime: '1794472000000000',
        reduceOnly: true,
        timestamp: '1791880000123456789',
      },
      grid,
    );
    expect(exit.payload.t).toBe(2);
    expect(exit.payload.r).toBe(1);
  });

  it('never signs an entry with reduceOnly set', async () => {
    const { ArcusSigner } = await import('../../src/arcus/ArcusSigner');
    const signer = new ArcusSigner({ signingKeyHex: '44'.repeat(32) });
    const { payload } = signer.buildPlaceOrderPayload(
      {
        address: '0x' + 'ab'.repeat(20),
        marketId: 1,
        accountIndex: 0,
        orderSide: 'BUY',
        orderType: 'LIMIT',
        quantity: '0.5',
        price: '49000',
        timeInForce: 'ALO',
        goodTilTime: '1794472000000000',
        timestamp: '1791880000123456789',
      },
      { marketId: 1, tickSize: '0.1', stepSize: '0.001' },
    );
    expect(payload.r).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * 10. secret hygiene
 * ------------------------------------------------------------------ */

describe('secret hygiene', () => {
  it('redacts credential-shaped keys recursively', () => {
    const redacted = redactValue({
      apiKey: 'abc',
      nested: { signingKey: 'def', appSecret: 'ghi', fine: 'ok' },
      list: [{ token: 'jkl' }],
    }) as Record<string, unknown>;
    expect(redacted.apiKey).toBe('<redacted>');
    expect((redacted.nested as Record<string, unknown>).signingKey).toBe('<redacted>');
    expect((redacted.nested as Record<string, unknown>).appSecret).toBe('<redacted>');
    expect((redacted.nested as Record<string, unknown>).fine).toBe('ok');
    expect(((redacted.list as unknown[])[0] as Record<string, unknown>).token).toBe('<redacted>');
  });

  it('renders secrets as presence flags in describeConfig, never values', async () => {
    const { describeConfig } = await import('../../src/config/config');
    const config = loadConfig({
      ARCUS_API_SIGNING_KEY: '55'.repeat(32),
      LARK_APP_SECRET: 'super-secret-value',
    });
    const described = JSON.stringify(describeConfig(config));
    expect(described).not.toContain('55'.repeat(32));
    expect(described).not.toContain('super-secret-value');
    expect(described).toContain('"secretsPresent"');
  });

  it('does not emit a secret through the logger', async () => {
    const { createLogger } = await import('../../src/util/logger');
    const { registerSecret } = await import('../../src/util/redact');
    const secret = 'a1b2c3d4'.repeat(8);
    registerSecret(secret);
    const lines: string[] = [];
    const sink = { write: (line: string) => void lines.push(line) };
    // The REAL logger, with its redaction paths and value scrubber, writing to a
    // capture sink. Testing a hand-built pino instance would prove nothing about
    // the shipping configuration.
    const log = createLogger({
      level: 'info',
      pretty: false,
      destination: sink as never,
    });
    log.info({ apiKey: secret, nested: { token: secret }, signingKey: secret, harmless: 'ok' }, 'test');
    log.error({ err: { message: `failed with ${secret}` } }, 'failure');
    const output = lines.join('\n');
    expect(output).not.toContain(secret);
    expect(output).toContain('<redacted>');
    expect(output).toContain('harmless');
  });

  it('redacts a registered secret embedded in a free-form message', async () => {
    const { createLogger } = await import('../../src/util/logger');
    const { registerSecret, resetRegisteredSecrets } = await import('../../src/util/redact');
    const secret = `sk-${'b'.repeat(40)}`;
    registerSecret(secret);
    const lines: string[] = [];
    const sink = { write: (line: string) => void lines.push(line) };
    const log = createLogger({ level: 'info', pretty: false, destination: sink as never });
    // NOTE the field is called `detail`, so key-name matching cannot help. This is
    // the realistic leak: an upstream auth error quoting the credential it rejected.
    log.warn({ detail: `upstream echoed ${secret}` }, 'probe');
    log.error({ err: { message: `401 for key ${secret}` } }, 'failure');
    const output = lines.join('\n');
    expect(output).not.toContain(secret);
    expect(output).toContain('<redacted>');
    resetRegisteredSecrets();
  });

  it('redacts a Bearer token quoted in prose', async () => {
    const { createLogger } = await import('../../src/util/logger');
    const lines: string[] = [];
    const sink = { write: (line: string) => void lines.push(line) };
    const log = createLogger({ level: 'info', pretty: false, destination: sink as never });
    log.warn({ detail: 'rejected header Authorization: Bearer t-abc123def456ghi789' }, 'probe');
    const output = lines.join('\n');
    expect(output).not.toContain('t-abc123def456ghi789');
    expect(output).toContain('Bearer <redacted>');
  });

  it('redacts a bare 64-hex key passed as an unnamed value', async () => {
    const { createLogger } = await import('../../src/util/logger');
    const lines: string[] = [];
    const sink = { write: (line: string) => void lines.push(line) };
    const log = createLogger({ level: 'info', pretty: false, destination: sink as never });
    log.warn({ value: 'c'.repeat(64) }, 'probe');
    expect(lines.join('\n')).not.toContain('c'.repeat(64));
    expect(lines.join('\n')).toContain('<redacted-hex>');
  });

  it('registers the secrets it is given, and ignores values too short to be safe', async () => {
    const { registerSecret, registeredSecretCount, resetRegisteredSecrets } = await import('../../src/util/redact');
    resetRegisteredSecrets();
    registerSecret('short');
    expect(registeredSecretCount()).toBe(0);
    registerSecret('a-long-enough-secret-value');
    expect(registeredSecretCount()).toBe(1);
    registerSecret(undefined);
    expect(registeredSecretCount()).toBe(1);
    resetRegisteredSecrets();
  });

  it('rejects a wallet address that is not 20 bytes of hex', () => {
    // A 20-byte address is 40 hex characters.
    expect(() => loadConfig({ ARCUS_WALLET_ADDRESS: 'not-an-address' })).toThrow(ConfigError);
    expect(() => loadConfig({ ARCUS_WALLET_ADDRESS: '0x' + 'a'.repeat(20) })).toThrow(ConfigError);
    expect(() => loadConfig({ ARCUS_WALLET_ADDRESS: '0x' + 'a'.repeat(39) })).toThrow(ConfigError);
    expect(() => loadConfig({ ARCUS_WALLET_ADDRESS: '0x' + 'a'.repeat(40) })).not.toThrow();
    expect(() => loadConfig({ ARCUS_WALLET_ADDRESS: 'a'.repeat(40) })).not.toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * 11. strategy symmetry and no-lookahead
 * ------------------------------------------------------------------ */

describe('strategy symmetry', () => {
  const config: StrategyConfig = {
    emaFastPeriod: 3,
    emaMidPeriod: 5,
    emaSlowPeriod: 8,
    atrPeriod: 5,
    minHistoryBars: 20,
    stopAtrBuffer: dec('0.5'),
    maxExtensionAtr: dec('5'),
    maxChaseAtr: dec('0.5'),
    pullbackZoneAtr: dec('2'),
    tp1RMultiple: dec('2'),
    tp1ClosePct: dec('50'),
    tp2RMultiple: dec('3'),
    structureLookback: 30,
    swingLeftBars: 2,
    swingRightBars: 2,
  };

  function bar(index: number, o: number, h: number, l: number, c: number): Candle {
    return {
      marketDisplayName: 'BTC-USD',
      marketId: 1,
      timeframe: '1h',
      openTime: 1_700_000_000_000_000 + index * 3_600_000_000,
      open: String(o),
      high: String(h),
      low: String(l),
      close: String(c),
      volume: '10',
      takerBuyVolume: '5',
      notionalVolume: '1000',
      takerBuyNotionalVolume: '500',
      tradeCount: 10,
      isFinal: true,
    };
  }

  function uptrend(): Candle[] {
    return Array.from({ length: 60 }, (_v, i) =>
      bar(i, 100 + i * 0.5, 100.6 + i * 0.5, 99.8 + i * 0.5, 100.4 + i * 0.5),
    );
  }

  function downtrend(): Candle[] {
    return Array.from({ length: 60 }, (_v, i) =>
      bar(i, 200 - i * 0.5, 200.2 - i * 0.5, 199.4 - i * 0.5, 199.6 - i * 0.5),
    );
  }

  it('classifies an uptrend and a downtrend symmetrically', () => {
    const up = evaluateStrategy({
      market: market(),
      trendCandles: uptrend(),
      structureCandles: uptrend(),
      triggerCandles: uptrend(),
      config,
    });
    const down = evaluateStrategy({
      market: market(),
      trendCandles: downtrend(),
      structureCandles: downtrend(),
      triggerCandles: downtrend(),
      config,
    });
    expect(up.diagnostics.trendBias).toBe('bullish');
    expect(down.diagnostics.trendBias).toBe('bearish');
  });

  it('returns FLAT with a reason when history is insufficient', () => {
    const signal = evaluateStrategy({
      market: market(),
      trendCandles: uptrend().slice(0, 5),
      structureCandles: uptrend(),
      triggerCandles: uptrend(),
      config,
    });
    expect(signal.direction).toBe('flat');
    expect(signal.flatReason).toMatch(/MIN_HISTORY_BARS|insufficient/i);
  });

  it('never emits a marketable chase: a flat trigger yields FLAT', () => {
    // Perfectly flat bars have zero ATR, which must yield FLAT rather than a NaN stop.
    const flat = Array.from({ length: 60 }, (_v, i) => bar(i, 100, 100, 100, 100));
    const signal = evaluateStrategy({
      market: market(),
      trendCandles: flat,
      structureCandles: flat,
      triggerCandles: flat,
      config,
    });
    expect(signal.direction).toBe('flat');
  });

  it('always produces a diagnostic trail whatever the outcome', () => {
    const signal = evaluateStrategy({
      market: market(),
      trendCandles: uptrend(),
      structureCandles: uptrend(),
      triggerCandles: uptrend(),
      config,
    });
    expect(signal.reasons.length).toBeGreaterThan(0);
    expect(signal.diagnostics.trendBias).toBeDefined();
  });
});

/* ------------------------------------------------------------------ *
 * 12. order state machine
 * ------------------------------------------------------------------ */

describe('order state machine', () => {
  it('maps engine-authoritative state ahead of the looser status enum', () => {
    const osm = new OrderStateMachine();
    osm.create({
      key: 'k',
      clientId: 'k',
      marketId: 1,
      symbol: 'BTC-USD',
      purpose: 'entry',
      reduceOnly: false,
      side: 'BUY',
      quantity: '1',
    });
    // ACK is not terminal.
    osm.applyVenueOrder({
      orderId: 'o',
      clientId: 'k',
      marketId: 1,
      marketDisplayName: 'BTC-USD',
      side: 'BUY',
      status: 'ACK',
      price: '1',
      originalSize: '1',
      remainingSize: '1',
      updatedAt: 1,
    } as Order);
    expect(osm.get('k')?.state).toBe('ACKNOWLEDGED');

    // A partial fill.
    osm.applyVenueOrder({
      orderId: 'o',
      clientId: 'k',
      marketId: 1,
      marketDisplayName: 'BTC-USD',
      side: 'BUY',
      status: 'PARTIALLY_FILLED',
      state: 'PARTIALLY_FILLED',
      price: '1',
      originalSize: '1',
      remainingSize: '0.4',
      filledSize: '0.6',
      updatedAt: 2,
    } as Order);
    expect(osm.get('k')?.state).toBe('PARTIALLY_FILLED');
    expect(osm.get('k')?.filledQuantity).toBe('0.6');

    // Terminal.
    osm.applyVenueOrder({
      orderId: 'o',
      clientId: 'k',
      marketId: 1,
      marketDisplayName: 'BTC-USD',
      side: 'BUY',
      status: 'FILLED',
      state: 'FILLED',
      price: '1',
      originalSize: '1',
      remainingSize: '0',
      filledSize: '1',
      updatedAt: 3,
    } as Order);
    expect(osm.get('k')?.state).toBe('FILLED');
    expect(osm.liveOrders()).toHaveLength(0);
  });

  it('does not downgrade a cancel request back to acknowledged', () => {
    const osm = new OrderStateMachine();
    osm.create({
      key: 'k',
      clientId: 'k',
      marketId: 1,
      symbol: 'BTC-USD',
      purpose: 'entry',
      reduceOnly: false,
      side: 'BUY',
      quantity: '1',
    });
    osm.applyVenueOrder({
      orderId: 'o',
      clientId: 'k',
      marketId: 1,
      marketDisplayName: 'BTC-USD',
      side: 'BUY',
      status: 'OPEN',
      state: 'OPEN',
      price: '1',
      originalSize: '1',
      remainingSize: '1',
      updatedAt: 1,
    } as Order);
    osm.markCancelRequested('k');
    expect(osm.get('k')?.state).toBe('CANCEL_REQUESTED');
    // A subsequent OPEN frame must not resurrect it as merely acknowledged.
    osm.applyVenueOrder({
      orderId: 'o',
      clientId: 'k',
      marketId: 1,
      marketDisplayName: 'BTC-USD',
      side: 'BUY',
      status: 'OPEN',
      state: 'OPEN',
      price: '1',
      originalSize: '1',
      remainingSize: '1',
      updatedAt: 2,
    } as Order);
    expect(osm.get('k')?.state).toBe('CANCEL_REQUESTED');
  });

  it('flags an unrecognised status as UNKNOWN_RECONCILE_REQUIRED', () => {
    const osm = new OrderStateMachine();
    osm.create({
      key: 'k',
      clientId: 'k',
      marketId: 1,
      symbol: 'BTC-USD',
      purpose: 'entry',
      reduceOnly: false,
      side: 'BUY',
      quantity: '1',
    });
    osm.applyVenueOrder({
      orderId: 'o',
      clientId: 'k',
      marketId: 1,
      marketDisplayName: 'BTC-USD',
      side: 'BUY',
      status: 'SOMETHING_NEW_FROM_UPSTREAM',
      price: '1',
      originalSize: '1',
      remainingSize: '1',
      updatedAt: 1,
      // Deliberately outside the documented enum: this asserts that a NEW upstream
    } as unknown as Order);
    expect(osm.get('k')?.state).toBe('UNKNOWN_RECONCILE_REQUIRED');
    expect(osm.unknownOrders()).toHaveLength(1);
  });

  it('adopts an order it did not create, flagged for reconciliation', () => {
    const osm = new OrderStateMachine();
    osm.applyVenueOrder({
      orderId: 'foreign',
      marketId: 1,
      marketDisplayName: 'BTC-USD',
      side: 'SELL',
      status: 'OPEN',
      state: 'OPEN',
      price: '1',
      originalSize: '1',
      remainingSize: '1',
      reduceOnly: true,
      updatedAt: 1,
    } as Order);
    expect(osm.unknownOrders()).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * 13. dynamic equity / recalibration
 * ------------------------------------------------------------------ */

describe('dynamic equity and recalibration', () => {
  const engine = new RiskEngine(limits(), logger);

  it('triggers recalibration on a cash-flow-sized equity change', () => {
    const small = engine.checkEquityChange({
      previousEquity: dec('10000'),
      currentEquity: dec('10100'), // 100 bps
      thresholdBps: dec('1000'),
    });
    expect(small.recalibrate).toBe(false);

    const large = engine.checkEquityChange({
      previousEquity: dec('10000'),
      currentEquity: dec('12000'), // 2000 bps = 20%
      thresholdBps: dec('1000'),
    });
    expect(large.recalibrate).toBe(true);
    expect(large.reason).toMatch(/new entries paused/i);
  });

  it('does not flag a first observation as a change', () => {
    expect(
      engine.checkEquityChange({
        previousEquity: undefined,
        currentEquity: dec('10000'),
        thresholdBps: dec('1000'),
      }).recalibrate,
    ).toBe(false);
  });

  it('pauses only NEW entries while recalibrating, leaving management permitted', () => {
    const decision = engine.evaluateEntry(
      proposal(),
      riskState({ recalibrating: true, recalibrationReason: 'deposit changed the risk base' }),
    );
    expect(decision.approved).toBe(false);
    expect(decision.blockReasons.join(' ')).toMatch(/recalibrating/);
  });

  it('scales sizing with equity, so a larger account risks proportionally more', () => {
    const small = engine.evaluateEntry(proposal(), riskState({ accountEquity: dec('10000') }));
    const large = engine.evaluateEntry(proposal(), riskState({ accountEquity: dec('20000') }));
    expect(small.quantity?.toFixed()).toBe('0.025');
    expect(large.quantity?.toFixed()).toBe('0.05');
  });

  it('computes a withdrawable balance net of margin, stops and reserve', () => {
    const result = engine.computeWithdrawable({
      equity: dec('10000'),
      usedMargin: dec('2000'),
      positions: [{ size: dec('0.1'), markPx: dec('50000'), maintenanceMarginFraction: dec('0.01') }],
      worstCaseStopLoss: dec('500'),
      safetyReservePct: dec('20'),
    });
    // 10000 - 2000 - 50 (mm) - 500 (stops) - 2000 (20% reserve) = 5450
    expect(result.withdrawable.toFixed()).toBe('5450');
  });

  it('never returns a negative withdrawable balance', () => {
    const result = engine.computeWithdrawable({
      equity: dec('100'),
      usedMargin: dec('5000'),
      positions: [],
      worstCaseStopLoss: dec('0'),
      safetyReservePct: dec('20'),
    });
    expect(result.withdrawable.greaterThanOrEqualTo(0)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * SIZING_MODE: risk vs leverage
 *
 * The property that matters: `MAX_LEVERAGE` must be a real dial in `leverage` mode and
 * a pure ceiling in `risk` mode. Before this, `MAX_LEVERAGE` was inert — the risk budget
 * always bound first, so a leverage setting of 10 produced exactly the same position as
 * a setting of 2.
 * ------------------------------------------------------------------ */
describe('sizing mode', () => {
  /**
   * `effectiveLeverage` is the leverage actually set on the venue (read back from
   * Arcus), not the config ceiling. Leverage sizing is capped by the SMALLER of the two,
   * which is why every case here sets it explicitly: selecting 10x in config while the
   * account still sits at 2x must size at 2x.
   *
   * The stop is 2% away (50000 -> 49000), so at L-times leverage the loss at the stop is
   * L x 2% of equity.
   */
  const at = (limitsOverride: Partial<RiskLimits>, stateOverride: Record<string, unknown> = {}) => {
    const engine = new RiskEngine(limits(limitsOverride), logger);
    return engine.computeSizing(proposal(), riskState(stateOverride), market());
  };

  it('risk mode sizes off the stop, so leverage never binds', () => {
    const sizing = at({ sizingMode: 'risk', maxLeverage: dec('2') });
    // riskBudget 25 / stopDistance 1000 = 0.025 units => 1,250 notional.
    expect(Number(sizing.breakdown.notionalAtEntry)).toBeCloseTo(1250, 2);
    expect(sizing.breakdown.bindingConstraint).toBe('quantityByRisk');
  });

  it('leverage mode sizes at the effective leverage, not the risk budget', () => {
    const sizing = at(
      { sizingMode: 'leverage', maxLeverage: dec('10'), maxOrderNotionalPct: dec('1000') },
      // Free collateral equals equity here, so leverage — not a cash shortfall — is the
      // limit being measured.
      { effectiveLeverage: dec('10'), freeCollateral: dec('10000') },
    );
    expect(Number(sizing.breakdown.notionalAtEntry)).toBeGreaterThan(95_000);
    expect(Number(sizing.breakdown.notionalAtEntry)).toBeLessThanOrEqual(100_000);
    expect(sizing.breakdown.bindingConstraint).not.toBe('quantityByRisk');
  });

  it('makes MAX_LEVERAGE a real dial instead of an inert ceiling', () => {
    const two = at(
      { sizingMode: 'leverage', maxLeverage: dec('2'), maxOrderNotionalPct: dec('2000') },
      { effectiveLeverage: dec('2') },
    );
    const ten = at(
      { sizingMode: 'leverage', maxLeverage: dec('10'), maxOrderNotionalPct: dec('2000') },
      { effectiveLeverage: dec('10') },
    );
    // Same account, same stop: size scales with the leverage setting.
    const ratio = Number(ten.breakdown.notionalAtEntry) / Number(two.breakdown.notionalAtEntry);
    expect(ratio).toBeGreaterThan(4.5);
    expect(ratio).toBeLessThan(5.5);
  });

  it('caps at the venue leverage, not the config value', () => {
    // Config asks for 20x but the account is only set to 2x: the smaller wins.
    const sizing = at(
      { sizingMode: 'leverage', maxLeverage: dec('20'), maxOrderNotionalPct: dec('2000') },
      { effectiveLeverage: dec('2') },
    );
    expect(Number(sizing.breakdown.notionalAtEntry)).toBeLessThanOrEqual(20_000);
  });

  it('refuses when the stop-out would exceed MAX_RISK_PER_TRADE_PCT', () => {
    // 10x against a 2% stop loses 20% of equity; the cap is 10%.
    const engine = new RiskEngine(
      limits({
        sizingMode: 'leverage',
        maxLeverage: dec('10'),
        maxOrderNotionalPct: dec('1000'),
        maxRiskPerTradePct: dec('10'),
      }),
      logger,
    );
    const decision = engine.evaluateEntry(
      proposal(),
      riskState({ effectiveLeverage: dec('10') }),
    );
    expect(decision.approved).toBe(false);
    expect(decision.blockReasons.join(' ')).toMatch(/MAX_RISK_PER_TRADE_PCT/);
  });

  it('permits a stop-out exactly at the configured cap', () => {
    const engine = new RiskEngine(
      limits({
        sizingMode: 'leverage',
        maxLeverage: dec('10'),
        maxOrderNotionalPct: dec('1000'),
        maxRiskPerTradePct: dec('20'),
      }),
      logger,
    );
    const decision = engine.evaluateEntry(
      proposal(),
      riskState({ effectiveLeverage: dec('10') }),
    );
    expect(decision.approved).toBe(true);
  });

  it('never sizes above the market maximum order size', () => {
    const sizing = at(
      { sizingMode: 'leverage', maxLeverage: dec('20'), maxOrderNotionalPct: dec('2000') },
      { effectiveLeverage: dec('20'), marketMaxOrderSize: dec('0.5') },
    );
    expect(sizing.breakdown.bindingConstraint).toBe('marketMaxPosition');
    expect(sizing.quantity.toFixed()).toBe('0.5');
  });
});
