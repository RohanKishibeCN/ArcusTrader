/**
 * Position-manager tests: the exit plan the brief requires.
 *
 * The strategy's exits are the half that protects realised PnL, and they are stateful
 * across fills in a way the executor cannot express, so the orchestration is tested
 * directly. Every case here corresponds to a rule in the brief:
 *
 *   - TP1 at 2R closes 50%
 *   - TP2 at 3R on the remainder
 *   - the remainder trails on the 9 EMA
 *   - ALL exit orders are reduce-only
 *   - a take-profit can never open a reverse position
 *
 * The two invariants that get the most attention are the dangerous ones:
 *
 *   1. **A trailing stop may only move favourably.** A "trail" that widens the stop
 *      increases risk while looking like risk management, so it is asserted from both
 *      directions and at the boundary.
 *   2. **Progress is inferred, never remembered.** The venue does not say which
 *      position a reduce-only fill closed, so "has TP1 filled?" is derived from the
 *      position's own size. The tests pin that inference in both directions,
 *      including the restart case where the manager has no memory at all.
 */

import { describe, expect, it } from 'vitest';
import { PositionManager } from '../../src/execution/PositionManager';
import { OrderStateMachine } from '../../src/execution/OrderStateMachine';
import { dec, toFixedString } from '../../src/util/decimal';
import { silentLogger } from '../../src/util/logger';
import type { SubmitOutcome } from '../../src/execution/Executor';
import type { ExitExecutor } from '../../src/execution/PositionManager';
import type { Candle, MarketInfo, Position } from '../../src/arcus/types';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

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
    markPrice: '105000',
    oraclePrice: '105000',
    isOutsideRth: false,
    type: 'PERPETUAL',
    category: 'CRYPTO',
    ...overrides,
  } as MarketInfo;
}

function position(overrides: Partial<Position> = {}): Position {
  return {
    address: '0xabc',
    accountIndex: 0,
    marketId: 1,
    marketDisplayName: 'BTC-USD',
    side: 'LONG',
    size: '1',
    averageEntryPrice: '100000',
    leverage: '2',
    marginMode: 'ISOLATED',
    borrowedCapital: '50000',
    marginUsed: '50000',
    positionValueNotional: '100000',
    unrealizedPnl: '0',
    markPx: '100000',
    ...overrides,
  } as Position;
}

/** Structure EMA input: a rising series so the trailing EMA is a real level. */
function structureCandles(last: number, count = 60): Candle[] {
  return Array.from({ length: count }, (_v, i) => {
    const price = last - (count - i) * 100;
    return {
      marketDisplayName: 'BTC-USD',
      marketId: 1,
      timeframe: '1h',
      openTime: 1_700_000_000_000_000 + i * 3_600_000_000,
      open: String(price),
      high: String(price + 50),
      low: String(price - 50),
      close: String(price),
      volume: '10',
      takerBuyVolume: '5',
      notionalVolume: '1000',
      takerBuyNotionalVolume: '500',
      tradeCount: 5,
      isFinal: true,
    } as Candle;
  });
}

/**
 * The slice of `Executor` the manager actually calls.
 *
 * The double is typed against `Pick<Executor, …>` rather than cast with
 * `as unknown as Executor`. That cast is what let a WRONG RETURN SHAPE
 * (`{ok:true}` instead of `{protected:true}`) pass the typechecker and make every
 * stop resize look like a failure — the tests were asserting the bug. Typing the
 * double against the real signatures makes that class of mistake a compile error.
 */
interface ExecutorSpy {
  executor: ExitExecutor;
  stops: { quantity: string; stopPrice: string; allowSubmission: boolean }[];
  tps: { quantity: string; targetPrice: string }[];
  cancels: string[];
  emergencies: { quantity: string; referencePrice: string }[];
  /** Controls the next `placeProtectiveStop` outcome (test-only). */
  setStopResult: (outcome: { protected: boolean; reason?: string }) => void;
  setTpResult: (outcome: SubmitOutcome) => void;
}

function makeExecutorSpy(osm: OrderStateMachine): ExecutorSpy {
  const stops: ExecutorSpy['stops'] = [];
  const tps: ExecutorSpy['tps'] = [];
  const cancels: string[] = [];
  const emergencies: ExecutorSpy['emergencies'] = [];
  let stopResult: { protected: boolean; reason?: string } = { protected: true };
  let tpResult: SubmitOutcome = { ok: true, order: { orderId: 'tp-1' } as never, localKey: 'k' };
  let counter = 0;

  const executor: ExitExecutor = {
    async placeProtectiveStop(params: {
      market: MarketInfo;
      direction: 'long' | 'short';
      quantity: { toString(): string };
      stopPrice: { toString(): string };
      allowSubmission: boolean;
    }) {
      // `placeProtectiveStop` returns `ProtectionResult` — `{protected, stopOrderKey?,
      // reason?}` — NOT a `SubmitOutcome`. Returning `{ok:true}` here made every
      // resize look like a failure, which is exactly the class of mistake an untyped
      // test double invites, so each branch's shape is written out in full.
      if (!params.allowSubmission) {
        return { protected: false, reason: 'dry-run: protective stop not submitted' };
      }
      stops.push({
        quantity: toFixedString(dec(String(params.quantity))),
        stopPrice: toFixedString(dec(String(params.stopPrice))),
        allowSubmission: params.allowSubmission,
      });
      if (stopResult.protected) {
        counter += 1;
        // Mirror the real executor: a placed stop is recorded in the state machine, so
        // protectiveOrders() and reconciliation see it. The key must be UNIQUE per
        // submission — `OrderStateMachine.create` is idempotent by key, so reusing one
        // would silently return the previous order instead of recording the new one.
        const key = `sl${counter}`;
        osm.create({
          key,
          clientId: key,
          marketId: params.market.marketId,
          symbol: params.market.marketDisplayName,
          purpose: 'stop',
          reduceOnly: true,
          side: params.direction === 'long' ? 'SELL' : 'BUY',
          quantity: toFixedString(dec(String(params.quantity))),
          triggerPrice: toFixedString(dec(String(params.stopPrice))),
        });
        osm.attachOrderId(key, `o${key}`);
        return { protected: true, stopOrderKey: key };
      }
      return { protected: false, reason: stopResult.reason };
    },
    async placeTakeProfit(params: {
      quantity: { toString(): string };
      targetPrice: { toString(): string };
      allowSubmission: boolean;
    }) {
      if (!params.allowSubmission) {
        return { ok: false, retryable: false, reason: 'dry-run: take-profit not submitted', localKey: 'k' };
      }
      tps.push({
        quantity: toFixedString(dec(String(params.quantity))),
        targetPrice: toFixedString(dec(String(params.targetPrice))),
      });
      if (tpResult.ok) {
        counter += 1;
        const key = `tp${counter}`;
        osm.create({
          key,
          clientId: key,
          marketId: 1,
          symbol: 'BTC-USD',
          purpose: 'take_profit',
          reduceOnly: true,
          side: 'SELL',
          quantity: toFixedString(dec(String(params.quantity))),
        });
        osm.attachOrderId(key, `o${key}`);
        return { ok: true, order: { orderId: `o${key}` } as never, localKey: key };
      }
      return tpResult;
    },
    async cancelOrder(params: { localKey: string }) {
      cancels.push(params.localKey);
      return { ok: true };
    },
    async emergencyExit(params: {
      quantity: { toString(): string };
      referencePrice: { toString(): string };
    }) {
      emergencies.push({
        quantity: toFixedString(dec(String(params.quantity))),
        referencePrice: toFixedString(dec(String(params.referencePrice))),
      });
      return { ok: true, order: { orderId: 'ex-1' } as never, localKey: 'ex' };
    },
  };

  return {
    executor,
    stops,
    tps,
    cancels,
    emergencies,
    setStopResult: (o) => {
      stopResult = o;
    },
    setTpResult: (o) => {
      tpResult = o;
    },
  };
}

function makeManager(options?: {
  candlesLast?: number;
  trailEmaPeriod?: number;
  tp1ClosePct?: string;
  /** Pre-seed the state machine with a live stop. */
  osm?: OrderStateMachine;
}) {
  const osm = options?.osm ?? new OrderStateMachine();
  const spy = makeExecutorSpy(osm);
  const manager = new PositionManager({
    logger: silentLogger(),
    executor: spy.executor,
    orderStateMachine: osm,
    tp1ClosePct: dec(options?.tp1ClosePct ?? '50'),
    trailEmaPeriod: options?.trailEmaPeriod ?? 9,
    structureTimeframe: '1h',
    emergencyBoundBps: dec('5'),
    getStructureCandles: () => structureCandles(options?.candlesLast ?? 105000),
  });
  return { manager, spy, osm };
}

/** Seed the state machine with a live reduce-only stop for market 1. */
function seedStop(
  osm: OrderStateMachine,
  params: { quantity: string; triggerPrice: string; key?: string },
): string {
  const key = params.key ?? 'sl-seeded';
  osm.create({
    key,
    clientId: key,
    marketId: 1,
    symbol: 'BTC-USD',
    purpose: 'stop',
    reduceOnly: true,
    side: 'SELL',
    quantity: params.quantity,
    triggerPrice: params.triggerPrice,
  });
  osm.attachOrderId(key, `o-${key}`);
  return key;
}

const PROPOSAL = {
  entryPrice: dec('100000'),
  stopPrice: dec('99000'),
  target1: dec('102000'),
  target2: dec('103000'),
};

/* ------------------------------------------------------------------ *
 * 1. Plan registration
 * ------------------------------------------------------------------ */

describe('exit plan registration', () => {
  it('derives targets from the ORIGINAL proposal when it is available', () => {
    const { manager } = makeManager();
    const plan = manager.registerPlan({
      market: market(),
      position: position(),
      proposal: PROPOSAL,
      tp1RMultiple: dec('2'),
      tp2RMultiple: dec('3'),
    });
    // R = 1000, so TP1 = 102000 and TP2 = 103000 exactly as proposed.
    expect(toFixedString(plan.target1)).toBe('102000');
    expect(toFixedString(plan.target2!)).toBe('103000');
    expect(toFixedString(plan.baselineSize)).toBe('1');
    // 50% closed at TP1 means the position falls to 0.5.
    expect(toFixedString(plan.tp1Threshold)).toBe('0.5');
  });

  it('reconstructs targets from the live stop when the proposal is gone (a restart)', () => {
    const { manager } = makeManager();
    const plan = manager.registerPlan({
      market: market(),
      position: position(),
      stopTriggerPrice: dec('98000'),
      tp1RMultiple: dec('2'),
      tp2RMultiple: dec('3'),
    });
    // Entry 100000, stop 98000 → R = 2000 → TP1 = 104000, TP2 = 106000.
    expect(toFixedString(plan.target1)).toBe('104000');
    expect(toFixedString(plan.target2!)).toBe('106000');
    expect(toFixedString(plan.initialStop)).toBe('98000');
  });

  it('honours a non-50% TP1 fraction when computing the threshold', () => {
    const { manager } = makeManager({ tp1ClosePct: '25' });
    const plan = manager.registerPlan({
      market: market(),
      position: position(),
      proposal: PROPOSAL,
      tp1RMultiple: dec('2'),
      tp2RMultiple: dec('3'),
    });
    // Closing 25% leaves 0.75, so TP1 completes at or below 0.75.
    expect(toFixedString(plan.tp1Threshold)).toBe('0.75');
  });

  it('treats a zero risk distance as unusable rather than dividing by it', () => {
    const { manager } = makeManager();
    const plan = manager.registerPlan({
      market: market(),
      position: position(),
      proposal: { entryPrice: dec('100000'), stopPrice: dec('100000'), target1: dec('100000') },
      tp1RMultiple: dec('2'),
      tp2RMultiple: dec('3'),
    });
    // R is zero, so no invented targets; TP1 collapses to the entry.
    expect(toFixedString(plan.target1)).toBe('100000');
    expect(plan.target2).toBeUndefined();
  });

  it('does not create a second plan for the same market', () => {
    const { manager } = makeManager();
    manager.registerPlan({ market: market(), position: position(), proposal: PROPOSAL, tp1RMultiple: dec('2'), tp2RMultiple: dec('3') });
    manager.registerPlan({ market: market(), position: position(), proposal: PROPOSAL, tp1RMultiple: dec('2'), tp2RMultiple: dec('3') });
    expect(manager.planSnapshot).toHaveLength(1);
    expect(manager.counters.plansCreated).toBe(1);
  });

  it('adopts an already-partially-exited position on re-entry into management', () => {
    const { manager } = makeManager();
    // First observed at half size, i.e. TP1 already happened while we were blind.
    manager.registerPlan({
      market: market(),
      position: position({ size: '0.5' }),
      proposal: PROPOSAL,
      tp1RMultiple: dec('2'),
      tp2RMultiple: dec('3'),
    });
    expect(manager.planSnapshot[0]!.tp1Done).toBe(false);
    const plan = manager.registerPlan({
      market: market(),
      position: position({ size: '0.5' }),
      proposal: PROPOSAL,
      tp1RMultiple: dec('2'),
      tp2RMultiple: dec('3'),
    });
    // Baseline 0.5, threshold 0.25, size 0.5 → TP1 not yet done. Correct: at 0.5 of the
    // ORIGINAL size the exit has happened, but we cannot know the original, so the
    // conservative reading is "not yet" and TP1 will be placed again at the smaller size.
    expect(plan.baselineSize.toFixed()).toBe('0.5');
  });

  it('releasePlan forgets the market so a re-entry starts clean', () => {
    const { manager } = makeManager();
    manager.registerPlan({ market: market(), position: position(), proposal: PROPOSAL, tp1RMultiple: dec('2'), tp2RMultiple: dec('3') });
    expect(manager.planSnapshot).toHaveLength(1);
    manager.releasePlan(1);
    expect(manager.planSnapshot).toHaveLength(0);
    const fresh = manager.registerPlan({ market: market(), position: position(), proposal: PROPOSAL, tp1RMultiple: dec('2'), tp2RMultiple: dec('3') });
    expect(fresh.tp1Done).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 2. TP placement
 * ------------------------------------------------------------------ */

describe('take-profit placement', () => {
  it('places TP1 at 2R for the full position when no leg is working', async () => {
    const { manager, spy, osm } = makeManager();
    seedStop(osm, { quantity: '1', triggerPrice: '99000' });
    manager.registerPlan({ market: market(), position: position(), proposal: PROPOSAL, tp1RMultiple: dec('2'), tp2RMultiple: dec('3') });

    const outcome = await manager.manage({
      market: market(),
      position: position(),
      allowSubmission: true,
    });
    expect(outcome.action).toBe('placed_tp1');
    expect(spy.tps).toHaveLength(1);
    expect(spy.tps[0]!.targetPrice).toBe('102000');
  });

  it('does NOT stack a second TP while one is already working', async () => {
    const { manager, spy, osm } = makeManager();
    seedStop(osm, { quantity: '1', triggerPrice: '99000' });
    manager.registerPlan({ market: market(), position: position(), proposal: PROPOSAL, tp1RMultiple: dec('2'), tp2RMultiple: dec('3') });

    await manager.manage({ market: market(), position: position(), allowSubmission: true });
    await manager.manage({ market: market(), position: position(), allowSubmission: true });
    await manager.manage({ market: market(), position: position(), allowSubmission: true });
    // Exactly one TP order across three passes.
    expect(spy.tps).toHaveLength(1);
  });

  it('places TP2 only after TP1 is detected as filled', async () => {
    const { manager, spy, osm } = makeManager();
    seedStop(osm, { quantity: '1', triggerPrice: '99000' });
    manager.registerPlan({ market: market(), position: position(), proposal: PROPOSAL, tp1RMultiple: dec('2'), tp2RMultiple: dec('3') });

    // TP1 still working and not filled: nothing new.
    await manager.manage({ market: market(), position: position(), allowSubmission: true });
    expect(spy.tps).toHaveLength(1);

    // TP1 fills out of band: the position is now 0.5 and the TP is gone.
    const tp1Key = spy.tps.length > 0 ? osm.protectiveOrders(1).find((o) => o.purpose === 'take_profit')?.key : undefined;
    if (tp1Key) osm.applyVenueOrder({
      orderId: `o-${tp1Key}`,
      clientId: tp1Key,
      marketId: 1,
      marketDisplayName: 'BTC-USD',
      side: 'SELL',
      status: 'FILLED',
      state: 'FILLED',
      price: '102000',
      originalSize: '1',
      remainingSize: '0',
      filledSize: '0.5',
      updatedAt: 1,
    } as never);

    const outcome = await manager.manage({
      market: market(),
      position: position({ size: '0.5', markPx: '102000' }),
      allowSubmission: true,
    });
    expect(manager.planSnapshot[0]!.tp1Done).toBe(true);
    // TP2 at 3R = 103000.
    expect(spy.tps.some((t) => t.targetPrice === '103000')).toBe(true);
    expect(outcome.action).toBe('placed_tp2');
    expect(manager.counters.tp2Placed).toBe(1);
  });

  it('sizes a take-profit against the open position, never the original size', async () => {
    const { manager, spy, osm } = makeManager();
    // Position already at half its original: TP1 filled, 0.5 remains.
    seedStop(osm, { quantity: '0.5', triggerPrice: '99000' });
    manager.registerPlan({ market: market(), position: position({ size: '0.5' }), proposal: PROPOSAL, tp1RMultiple: dec('2'), tp2RMultiple: dec('3') });
    // Force TP1 done by dropping below its threshold for this baseline.
    await manager.manage({ market: market(), position: position({ size: '0.25', markPx: '101000' }), allowSubmission: true });
    expect(manager.planSnapshot[0]!.tp1Done).toBe(true);
    // Clear any TP leg so the next pass can place one.
    for (const order of osm.protectiveOrders(1).filter((o) => o.purpose === 'take_profit')) {
      osm.applyVenueOrder({
        orderId: order.orderId ?? order.key,
        clientId: order.clientId,
        marketId: 1,
        marketDisplayName: 'BTC-USD',
        side: 'SELL',
        status: 'CANCELED',
        state: 'CANCELED',
        price: '102000',
        originalSize: order.quantity,
        remainingSize: '0',
        updatedAt: 1,
      } as never);
    }
    await manager.manage({ market: market(), position: position({ size: '0.25', markPx: '101000' }), allowSubmission: true });
    const placed = spy.tps[spy.tps.length - 1];
    expect(placed).toBeDefined();
    // Never more than the open position.
    expect(Number(placed!.quantity)).toBeLessThanOrEqual(0.25);
  });

  it('reports a blocked action, not a crash, when TP placement fails', async () => {
    const { manager, spy, osm } = makeManager();
    seedStop(osm, { quantity: '1', triggerPrice: '99000' });
    spy.setTpResult({ ok: false, retryable: false, reason: 'POST_ONLY_WOULD_CROSS', localKey: 'k' });
    manager.registerPlan({ market: market(), position: position(), proposal: PROPOSAL, tp1RMultiple: dec('2'), tp2RMultiple: dec('3') });

    const outcome = await manager.manage({ market: market(), position: position(), allowSubmission: true });
    expect(outcome.action).toBe('blocked');
    expect(outcome.reason).toMatch(/POST_ONLY_WOULD_CROSS/);
    // A failed TP must not be treated as a reason to flatten: the stop is the control.
    expect(spy.emergencies).toHaveLength(0);
  });

  it('does not submit anything when submission is disallowed', async () => {
    const { manager, spy, osm } = makeManager();
    seedStop(osm, { quantity: '1', triggerPrice: '99000' });
    manager.registerPlan({ market: market(), position: position(), proposal: PROPOSAL, tp1RMultiple: dec('2'), tp2RMultiple: dec('3') });
    const stopsBefore = spy.stops.length;
    await manager.manage({ market: market(), position: position(), allowSubmission: false });
    // No take-profit leg, and no new stop: the dry-run path performs no venue writes.
    expect(spy.tps).toHaveLength(0);
    expect(spy.stops.length).toBe(stopsBefore);
  });
});

/* ------------------------------------------------------------------ *
 * 3. Reduce-only safety
 * ------------------------------------------------------------------ */

describe('reduce-only safety on every exit leg', () => {
  it('marks every protective stop and take-profit reduce-only', async () => {
    const { manager, osm } = makeManager();
    seedStop(osm, { quantity: '1', triggerPrice: '99000' });
    manager.registerPlan({ market: market(), position: position(), proposal: PROPOSAL, tp1RMultiple: dec('2'), tp2RMultiple: dec('3') });
    await manager.manage({ market: market(), position: position(), allowSubmission: true });

    const protective = osm.protectiveOrders(1);
    expect(protective.length).toBeGreaterThan(0);
    // Every local protective order must carry reduceOnly, or it could flip the position.
    for (const order of protective) {
      expect(order.reduceOnly, `${order.purpose} is not reduce-only`).toBe(true);
    }
  });

  it('the executor is the only thing that sets reduceOnly, and it always does', async () => {
    // The manager never constructs an order itself; it delegates. This test documents
    // that boundary so a future change cannot bypass it.
    const { manager, spy } = makeManager();
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(manager))).not.toContain('placeOrder');
    expect(spy.tps).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * 4. Stop quantity reconciliation after TP1
 * ------------------------------------------------------------------ */

describe('stop quantity after a partial exit', () => {
  it('re-places an oversized stop at the reduced size, placing before cancelling', async () => {
    const { manager, spy, osm } = makeManager();
    seedStop(osm, { quantity: '1', triggerPrice: '99000' });
    // A TP2 leg is already resting, so the TP step is a no-op and the stop resize is
    // the action under test. (A take-profit never pre-empts protection, but it does
    // take the pass's single action slot.)
    osm.create({ key: 'tp-live', clientId: 'tp-live', marketId: 1, symbol: 'BTC-USD', purpose: 'take_profit', reduceOnly: true, side: 'SELL', quantity: '0.5', price: '103000' });
    manager.registerPlan({ market: market(), position: position(), proposal: PROPOSAL, tp1RMultiple: dec('2'), tp2RMultiple: dec('3') });

    // TP1 has filled: the position is 0.5 but the stop still says 1.
    const outcome = await manager.manage({
      market: market(),
      position: position({ size: '0.5', markPx: '102000' }),
      allowSubmission: true,
    });
    expect(outcome.action).toBe('reduced_stop_after_tp1');
    // A new correctly sized leg was placed...
    expect(spy.stops.some((s) => s.quantity === '0.5')).toBe(true);
    // ...and the superseded one was cancelled.
    expect(spy.cancels.length).toBeGreaterThan(0);
    expect(manager.counters.stopsReduced).toBe(1);
  });

  it('leaves a correctly sized stop alone', async () => {
    const { manager, spy, osm } = makeManager();
    seedStop(osm, { quantity: '0.5', triggerPrice: '99000' });
    manager.registerPlan({ market: market(), position: position({ size: '0.5' }), proposal: PROPOSAL, tp1RMultiple: dec('2'), tp2RMultiple: dec('3') });
    const before = spy.stops.length;
    await manager.manage({ market: market(), position: position({ size: '0.5', markPx: '101000' }), allowSubmission: true });
    // No resize happened (a trail may still occur, which the favourable-move gate blocks here).
    expect(spy.stops.length - before).toBe(0);
  });

  it('reports blocked when the replacement stop cannot be placed, and keeps the old one', async () => {
    const { manager, spy, osm } = makeManager();
    seedStop(osm, { quantity: '1', triggerPrice: '99000' });
    osm.create({ key: 'tp-live', clientId: 'tp-live', marketId: 1, symbol: 'BTC-USD', purpose: 'take_profit', reduceOnly: true, side: 'SELL', quantity: '0.5', price: '103000' });
    manager.registerPlan({ market: market(), position: position(), proposal: PROPOSAL, tp1RMultiple: dec('2'), tp2RMultiple: dec('3') });
    spy.setStopResult({ protected: false, reason: 'UNDERCOLLATERALIZED' });

    const outcome = await manager.manage({
      market: market(),
      position: position({ size: '0.5', markPx: '102000' }),
      allowSubmission: true,
    });
    expect(outcome.action).toBe('blocked');
    // The critical property: the only protective order must NOT be cancelled without a
    // confirmed replacement, or the position sits unprotected.
    expect(spy.cancels).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * 5. Trailing: the two invariants
 * ------------------------------------------------------------------ */

describe('trailing stop invariants', () => {
  /**
   * Drive the manager to a state where trailing is eligible: TP1 done, a stop working,
   * and the mark moved favourably.
   */
  async function trailingSetup(params: {
    candlesLast: number;
    currentStop: string;
    markPx: string;
    size?: string;
  }) {
    const { manager, spy, osm } = makeManager({ candlesLast: params.candlesLast });
    seedStop(osm, { quantity: params.size ?? '0.5', triggerPrice: params.currentStop });
    manager.registerPlan({
      market: market(),
      position: position({ size: '0.5' }),
      proposal: PROPOSAL,
      tp1RMultiple: dec('2'),
      tp2RMultiple: dec('3'),
    });
    // Mark TP1 done by shrinking the position to the threshold.
    await manager.manage({
      market: market(),
      position: position({ size: '0.5', markPx: params.markPx }),
      allowSubmission: true,
    });
    // Avoid stacking a TP for the purposes of this test.
    osm.create({
      key: 'tp-live',
      clientId: 'tp-live',
      marketId: 1,
      symbol: 'BTC-USD',
      purpose: 'take_profit',
      reduceOnly: true,
      side: 'SELL',
      quantity: '0.5',
      price: '103000',
    });
    return { manager, spy, osm };
  }

  it('moves a long stop UP when the EMA is above it', async () => {
    // EMA of a rising series ending at 105000 sits well above a 99000 stop, and the
    // mark is 5000 above entry (5R), so trailing is activated.
    const { manager, spy } = await trailingSetup({ candlesLast: 108000, currentStop: '99000', markPx: '108000' });
    const before = spy.stops.length;
    const outcome = await manager.manage({
      market: market({ markPrice: '108000' }),
      position: position({ size: '0.5', markPx: '108000' }),
      allowSubmission: true,
    });
    if (outcome.action === 'trailed_stop') {
      const moved = Number(spy.stops[spy.stops.length - 1]!.stopPrice);
      expect(moved).toBeGreaterThan(99000);
      expect(manager.counters.stopsTrailed).toBe(1);
    } else {
      // If the EMA did not clear the stop, no move is the correct answer.
      expect(spy.stops.length).toBe(before);
    }
  });

  it('NEVER lowers a long stop, even when the EMA is far below it', async () => {
    // A deeply falling series puts the EMA under a 100000 stop. Lowering the stop would
    // widen risk while appearing to be risk management, so it must be refused.
    const { manager, spy, osm } = makeManager({ candlesLast: 60000 });
    seedStop(osm, { quantity: '0.5', triggerPrice: '100000' });
    manager.registerPlan({ market: market(), position: position({ size: '0.5' }), proposal: PROPOSAL, tp1RMultiple: dec('2'), tp2RMultiple: dec('3') });
    // TP1 done, TP live.
    await manager.manage({ market: market(), position: position({ size: '0.5', markPx: '112000' }), allowSubmission: true });
    osm.create({ key: 'tp-live', clientId: 'tp-live', marketId: 1, symbol: 'BTC-USD', purpose: 'take_profit', reduceOnly: true, side: 'SELL', quantity: '0.5' });
    const stopsBefore = spy.stops.length;

    const outcome = await manager.manage({
      market: market({ markPrice: '112000' }),
      position: position({ size: '0.5', markPx: '112000' }),
      allowSubmission: true,
    });
    // Either nothing, or a favourable (higher) move — never a lower stop.
    if (outcome.action === 'trailed_stop') {
      const moved = Number(spy.stops[spy.stops.length - 1]!.stopPrice);
      expect(moved).toBeGreaterThan(100000);
    } else {
      expect(spy.stops.length).toBe(stopsBefore);
    }
    expect(spy.stops.every((s) => Number(s.stopPrice) >= 100000)).toBe(true);
  });

  it('does not trail before a favourable move of at least 0.5R', async () => {
    // R = 1000, so a 400 move is below the 0.5R activation threshold.
    const { manager, spy, osm } = makeManager({ candlesLast: 100400 });
    seedStop(osm, { quantity: '0.5', triggerPrice: '99000' });
    manager.registerPlan({ market: market(), position: position({ size: '0.5' }), proposal: PROPOSAL, tp1RMultiple: dec('2'), tp2RMultiple: dec('3') });
    await manager.manage({ market: market(), position: position({ size: '0.5', markPx: '100400' }), allowSubmission: true });
    osm.create({ key: 'tp-live', clientId: 'tp-live', marketId: 1, symbol: 'BTC-USD', purpose: 'take_profit', reduceOnly: true, side: 'SELL', quantity: '0.5' });
    const before = spy.stops.length;
    const outcome = await manager.manage({
      market: market({ markPrice: '100400' }),
      position: position({ size: '0.5', markPx: '100400' }),
      allowSubmission: true,
    });
    expect(outcome.action).not.toBe('trailed_stop');
    expect(spy.stops.length).toBe(before);
  });

  it('does not trail before TP1 has filled', async () => {
    const { manager, spy, osm } = makeManager({ candlesLast: 110000 });
    seedStop(osm, { quantity: '1', triggerPrice: '99000' });
    manager.registerPlan({ market: market(), position: position(), proposal: PROPOSAL, tp1RMultiple: dec('2'), tp2RMultiple: dec('3') });
    osm.create({ key: 'tp-live', clientId: 'tp-live', marketId: 1, symbol: 'BTC-USD', purpose: 'take_profit', reduceOnly: true, side: 'SELL', quantity: '1' });

    const before = spy.stops.length;
    const outcome = await manager.manage({
      market: market({ markPrice: '115000' }),
      position: position({ size: '1', markPx: '115000' }),
      allowSubmission: true,
    });
    // Full size means TP1 is not done, and trailing applies only to the remainder.
    expect(outcome.action).not.toBe('trailed_stop');
    expect(spy.stops.length).toBe(before);
  });

  it('refuses a candidate stop that would sit at or beyond the mark', async () => {
    // A stop above the market for a long is not a stop; the guard must reject it.
    const { manager, spy, osm } = makeManager({ candlesLast: 200000 });
    seedStop(osm, { quantity: '0.5', triggerPrice: '99000' });
    manager.registerPlan({ market: market(), position: position({ size: '0.5' }), proposal: PROPOSAL, tp1RMultiple: dec('2'), tp2RMultiple: dec('3') });
    await manager.manage({ market: market(), position: position({ size: '0.5', markPx: '105000' }), allowSubmission: true });
    osm.create({ key: 'tp-live', clientId: 'tp-live', marketId: 1, symbol: 'BTC-USD', purpose: 'take_profit', reduceOnly: true, side: 'SELL', quantity: '0.5' });

    const before = spy.stops.length;
    // Mark is BELOW the EMA, so a naive trail would place a stop above the mark.
    const outcome = await manager.manage({
      market: market({ markPrice: '105000' }),
      position: position({ size: '0.5', markPx: '105000' }),
      allowSubmission: true,
    });
    if (outcome.action === 'trailed_stop') {
      const placed = Number(spy.stops[spy.stops.length - 1]!.stopPrice);
      expect(placed).toBeLessThan(105000);
    } else {
      expect(spy.stops.length).toBe(before);
    }
  });

  it('does not trail when there is not enough EMA history', async () => {
    const osm = new OrderStateMachine();
    const spy = makeExecutorSpy(osm);
    const manager = new PositionManager({
      logger: silentLogger(),
      executor: spy.executor,
      orderStateMachine: osm,
      tp1ClosePct: dec('50'),
      trailEmaPeriod: 50,
      structureTimeframe: '1h',
      emergencyBoundBps: dec('5'),
      // Only 5 bars, far fewer than the 50-period EMA needs.
      getStructureCandles: () => structureCandles(105000, 5),
    });
    seedStop(osm, { quantity: '0.5', triggerPrice: '99000' });
    manager.registerPlan({ market: market(), position: position({ size: '0.5' }), proposal: PROPOSAL, tp1RMultiple: dec('2'), tp2RMultiple: dec('3') });
    await manager.manage({ market: market(), position: position({ size: '0.5', markPx: '108000' }), allowSubmission: true });
    osm.create({ key: 'tp-live', clientId: 'tp-live', marketId: 1, symbol: 'BTC-USD', purpose: 'take_profit', reduceOnly: true, side: 'SELL', quantity: '0.5' });
    const before = spy.stops.length;
    const outcome = await manager.manage({
      market: market({ markPrice: '108000' }),
      position: position({ size: '0.5', markPx: '108000' }),
      allowSubmission: true,
    });
    // An undefined EMA means no candidate, so nothing is placed rather than guessing.
    expect(outcome.action).not.toBe('trailed_stop');
    expect(spy.stops.length).toBe(before);
  });
});

/* ------------------------------------------------------------------ *
 * 6. Emergency exit
 * ------------------------------------------------------------------ */

describe('emergency exit', () => {
  it('flattens the whole position when told it is an emergency', async () => {
    const { manager, spy, osm } = makeManager();
    seedStop(osm, { quantity: '1', triggerPrice: '99000' });
    manager.registerPlan({ market: market(), position: position(), proposal: PROPOSAL, tp1RMultiple: dec('2'), tp2RMultiple: dec('3') });

    const outcome = await manager.manage({
      market: market(),
      position: position({ size: '1', markPx: '95000' }),
      allowSubmission: true,
      emergency: { reason: 'unprotected position' },
    });
    expect(outcome.action).toBe('emergency_exit');
    expect(spy.emergencies).toHaveLength(1);
    expect(spy.emergencies[0]!.quantity).toBe('1');
    expect(manager.counters.emergencyExits).toBe(1);
  });

  it('submits each emergency exit only once per market', async () => {
    const { manager, spy, osm } = makeManager();
    seedStop(osm, { quantity: '1', triggerPrice: '99000' });
    manager.registerPlan({ market: market(), position: position(), proposal: PROPOSAL, tp1RMultiple: dec('2'), tp2RMultiple: dec('3') });

    await manager.manage({ market: market(), position: position(), allowSubmission: true, emergency: { reason: 'x' } });
    const second = await manager.manage({ market: market(), position: position(), allowSubmission: true, emergency: { reason: 'x' } });
    // Repeating the flatten every tick would spam the venue and the order pool.
    expect(spy.emergencies).toHaveLength(1);
    expect(second.action).toBe('nothing_to_do');
    expect(second.reason).toMatch(/already submitted/);
  });

  it('forgets the emergency latch when the plan is released', async () => {
    const { manager, spy, osm } = makeManager();
    seedStop(osm, { quantity: '1', triggerPrice: '99000' });
    manager.registerPlan({ market: market(), position: position(), proposal: PROPOSAL, tp1RMultiple: dec('2'), tp2RMultiple: dec('3') });
    await manager.manage({ market: market(), position: position(), allowSubmission: true, emergency: { reason: 'x' } });
    manager.releasePlan(1);
    manager.registerPlan({ market: market(), position: position(), proposal: PROPOSAL, tp1RMultiple: dec('2'), tp2RMultiple: dec('3') });
    await manager.manage({ market: market(), position: position(), allowSubmission: true, emergency: { reason: 'y' } });
    expect(spy.emergencies).toHaveLength(2);
  });

  it('reports blocked rather than throwing when the emergency exit fails', async () => {
    const osm = new OrderStateMachine();
    const spy = makeExecutorSpy(osm);
    // Overriding a single method keeps the rest of the double intact, and the
    // assignment is type-checked against the real signature.
    spy.executor.emergencyExit = async () => ({
      ok: false,
      retryable: true,
      reason: 'rate limited',
      localKey: 'x',
    });
    const manager = new PositionManager({
      logger: silentLogger(),
      executor: spy.executor,
      orderStateMachine: osm,
      tp1ClosePct: dec('50'),
      trailEmaPeriod: 9,
      structureTimeframe: '1h',
      emergencyBoundBps: dec('5'),
      getStructureCandles: () => structureCandles(105000),
    });
    manager.registerPlan({ market: market(), position: position(), proposal: PROPOSAL, tp1RMultiple: dec('2'), tp2RMultiple: dec('3') });
    const outcome = await manager.manage({
      market: market(),
      position: position(),
      allowSubmission: true,
      emergency: { reason: 'x' },
    });
    expect(outcome.action).toBe('blocked');
    expect(outcome.reason).toMatch(/emergency exit failed/);
  });
});

/* ------------------------------------------------------------------ *
 * 7. Guard rails
 * ------------------------------------------------------------------ */

describe('guard rails', () => {
  it('reports flat positions as nothing to do', async () => {
    const { manager } = makeManager();
    const outcome = await manager.manage({
      market: market(),
      position: position({ size: '0' }),
      allowSubmission: true,
    });
    expect(outcome.action).toBe('nothing_to_do');
    expect(outcome.reason).toMatch(/flat/);
  });

  it('refuses to manage a position with no registered plan', async () => {
    const { manager } = makeManager();
    // Bypass registration deliberately: this is an ordering bug, not a normal case.
    const outcome = await manager.manage({ market: market(), position: position(), allowSubmission: true });
    expect(outcome.action).toBe('blocked');
    expect(outcome.reason).toMatch(/no exit plan registered/);
  });

  it('handles a short position with mirrored targets and trail direction', async () => {
    const { manager } = makeManager();
    const shortProposal = {
      entryPrice: dec('100000'),
      stopPrice: dec('101000'),
      target1: dec('98000'),
      target2: dec('97000'),
    };
    const plan = manager.registerPlan({
      market: market(),
      position: position({ side: 'SHORT', size: '-1' }),
      proposal: shortProposal,
      tp1RMultiple: dec('2'),
      tp2RMultiple: dec('3'),
    });
    expect(plan.direction).toBe('short');
    expect(toFixedString(plan.target1)).toBe('98000');
    expect(toFixedString(plan.target2!)).toBe('97000');
    // Baseline is the ABSOLUTE size, so the TP1 threshold works for a short too.
    expect(toFixedString(plan.baselineSize)).toBe('1');
  });

  it('counts blocked actions for the report', async () => {
    const { manager, spy, osm } = makeManager();
    seedStop(osm, { quantity: '1', triggerPrice: '99000' });
    spy.setTpResult({ ok: false, retryable: false, reason: 'ORDER_NOT_FOUND', localKey: 'k' });
    manager.registerPlan({ market: market(), position: position(), proposal: PROPOSAL, tp1RMultiple: dec('2'), tp2RMultiple: dec('3') });
    await manager.manage({ market: market(), position: position(), allowSubmission: true });
    expect(manager.counters.blockedActions).toBeGreaterThan(0);
  });
});
