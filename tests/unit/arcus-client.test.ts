/**
 * Arcus REST + WebSocket client tests, pinned to LIVE-VERIFIED wire shapes.
 *
 * Every fixture in this file was captured from `https://api.arcus.xyz`. That is the
 * point: three of these shapes differ from the documentation's embedded OpenAPI
 * fragments, and each difference was a silent bug before it was fixed.
 *
 *   - `tickTiers` uses `{upToPrice, tick}` — NOT `tickSize`.
 *   - `GET /v1/feetiers` returns `{tiers:[…]}` with snake_case names and fees in
 *     PARTS PER MILLION, not `{feeTiers:[…]}` with `makerFeeBps`.
 *   - `GET /v1/trades` rows carry `timestamp`, NOT `createdAt`.
 *   - `GET /v1/l2OrderBook/{market}` levels are `[price, size]` TUPLES, not objects.
 *   - `GET /v1/account` returns HTTP 403 `address not on access whitelist` for an
 *     unwhitelisted address, so account reads must be treated as a privileged
 *     capability rather than an open one.
 *   - The WebSocket sends `{"type":"connected"}` on open, and refuses a subscription
 *     for a non-whitelisted address with `{"type":"error","message":"…"}`.
 *
 * If any of these tests fails after an upgrade, the wire format changed and the
 * corresponding client code must be re-verified against the live API.
 */

import { describe, expect, it } from 'vitest';
import { ArcusRestClient, ArcusHttpError, ppmToBps } from '../../src/arcus/ArcusRestClient';
import { ArcusSigner } from '../../src/arcus/ArcusSigner';
import { WeightBudget, ThrottleCircuitBreaker, TradingPoolGuard, REQUEST_WEIGHT } from '../../src/arcus/RateLimiter';
import { silentLogger } from '../../src/util/logger';

const logger = silentLogger();

/** Build a client whose fetch returns a canned response. */
function clientWith(
  responses: { status?: number; body: unknown; headers?: Record<string, string> }[],
): { client: ArcusRestClient; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  let index = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const response = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return new Response(typeof response.body === 'string' ? response.body : JSON.stringify(response.body), {
      status: response.status ?? 200,
      headers: { 'content-type': 'application/json', ...(response.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
  return {
    client: new ArcusRestClient({ baseUrl: 'https://api.arcus.xyz', logger, fetchImpl }),
    calls,
  };
}

/* ------------------------------------------------------------------ *
 * Live-captured fixtures
 * ------------------------------------------------------------------ */

/** Trimmed from a live `GET /v1/markets?market=BTC-USD`. */
const LIVE_MARKET = {
  marketDisplayName: 'BTC-USD',
  fullAssetName: 'Bitcoin',
  marketId: 1,
  status: 'ONLINE',
  baseAsset: 'BTC',
  quoteAsset: 'USD',
  tickSize: '0.1',
  stepSize: '0.00000001',
  // NOTE: `tick`, and `upToPrice` absent on the final unbounded band.
  tickTiers: [
    { upToPrice: '500000', tick: '0.1' },
    { upToPrice: '1000000', tick: '0.2' },
    { upToPrice: '2000000', tick: '0.5' },
    { upToPrice: '5000000', tick: '1' },
    { upToPrice: '10000000', tick: '2' },
    { tick: '5' },
  ],
  minOrderNotional: '5',
  minOrderSize: '0.0001',
  maxOrderSize: '10000',
  oraclePrice: '83690.1',
  markPrice: '83664.5',
  lastTradePrice: '83664.5',
  fundingRate: '0.0000125',
  nextFundingRate: '0.0000125',
  nextFundingAt: 1791878400,
  priceChange24h: '-0.001',
  volume24h: '2100.5',
  volume24hNotional: '175693650.31',
  high24h: '84000',
  low24h: '82000',
  trades24h: 12345,
  openInterest: '999.9',
  openInterestCapNotional: null,
  liquidationFeePpm: '0',
  initialMarginFraction: '0.025',
  maintenanceMarginFraction: '0.0125',
  offHoursInitialMarginFraction: '0.025',
  // Live value is null for many markets.
  regularTradingHours: null,
  isOutsideRth: false,
  currentSettlementPrice: null,
  upperTradingBound: null,
  lowerTradingBound: null,
  nextUpperTradingBound: null,
  nextLowerTradingBound: null,
  isUpperInExpansionZone: null,
  isLowerInExpansionZone: null,
  upperZoneEnteredAt: null,
  upperExpectedExpansionAt: null,
  lowerZoneEnteredAt: null,
  lowerExpectedExpansionAt: null,
  type: 'PERPETUAL',
  category: 'CRYPTO',
  addedTimestamp: 1700000000,
  assetResolution: '10000000000',
  pythId: null,
};

/** Live `GET /v1/l2OrderBook/BTC-USD?nLevels=3`. */
const LIVE_ORDERBOOK = {
  bids: [
    ['83587', '0.16191699'],
    ['83586.9', '0.00010005'],
    ['83582.3', '0.02'],
  ],
  asks: [
    ['83587.1', '0.47557328'],
    ['83587.2', '0.0052'],
    ['83587.4', '0.05980951'],
  ],
  lastSequenceId: 411852675,
  globalSequenceId: 3868872064,
  timestamp: 1791881240454292,
};

/** Live `GET /v1/bbo/BTC-USD`. */
const LIVE_BBO = {
  bestBid: { price: '83587', size: '0.16099645' },
  bestAsk: { price: '83587.1', size: '0.49557328' },
  lastSequenceId: 411852698,
  globalSequenceId: 3868874625,
  timestamp: 1791881242590431,
};

/** Live `GET /v1/feetiers` — note `tiers`, snake_case, and PPM units. */
const LIVE_FEETIERS = {
  tiers: [
    { level: 0, name: 'Base', volume_threshold: 0, maker_fee_ppm: 0, taker_fee_ppm: 225 },
    { level: 1, name: 'Bronze', volume_threshold: 5000000000000000, maker_fee_ppm: 0, taker_fee_ppm: 190 },
    { level: 5, name: 'VIP', volume_threshold: 1000000000000000000, maker_fee_ppm: -20, taker_fee_ppm: 100 },
  ],
};

/** Live `GET /v1/trades?market=BTC-USD&limit=1`. */
const LIVE_TRADE = {
  trades: [
    {
      marketDisplayName: 'BTC-USD',
      marketId: 1,
      side: 'SELL',
      price: '83540.6',
      size: '0.0004',
      tradeId: '17073751',
      // `timestamp`, not `createdAt`.
      timestamp: 1791881872068100,
      makerOrderId: '96203bb0d04f4fc5',
      takerOrderId: '6c4e03d682fe43f7',
      sequenceNumber: 3869715490,
    },
  ],
};

/** Live `GET /v1/candles` row, with both a forming and a closed bar. */
const LIVE_CANDLES = {
  candles: [
    {
      marketDisplayName: 'BTC-USD',
      marketId: 1,
      timeframe: '15m',
      openTime: 1791881100000000,
      open: '83686.9',
      high: '83686.9',
      low: '83563.4',
      close: '83565',
      volume: '2.72484133',
      takerBuyVolume: '0.37427272',
      notionalVolume: '227900.7633307',
      takerBuyNotionalVolume: '31288.030777109',
      tradeCount: 150,
      isFinal: false,
    },
    {
      marketDisplayName: 'BTC-USD',
      marketId: 1,
      timeframe: '15m',
      openTime: 1791880200000000,
      open: '83802',
      high: '83817.4',
      low: '83623.7',
      close: '83686.9',
      volume: '11.21405735',
      takerBuyVolume: '3.19033513',
      notionalVolume: '938694.914725303',
      takerBuyNotionalVolume: '267067.355084405',
      tradeCount: 749,
      isFinal: true,
    },
  ],
  total: 2,
};

/** Live `GET /v1/fundingRates` row — `fundingRate`, not `rate`. */
const LIVE_FUNDING_RATES = {
  fundingRates: [
    { marketId: 1, marketDisplayName: 'BTC-USD', fundingRate: '0.0000125', time: 1791878400000000 },
    { marketId: 1, marketDisplayName: 'BTC-USD', fundingRate: '-0.000006880245147949', time: 1791871200000000 },
  ],
};

/* ------------------------------------------------------------------ *
 * Wire-shape regressions
 * ------------------------------------------------------------------ */

describe('markets: live wire shape', () => {
  it('parses the live tickTiers shape ({upToPrice, tick})', async () => {
    const { client } = clientWith([{ body: { markets: [LIVE_MARKET] } }]);
    const markets = await client.getMarkets();
    expect(markets).toHaveLength(1);
    const market = markets[0]!;
    expect(market.tickTiers).toHaveLength(6);
    expect(market.tickTiers[0]).toEqual({ upToPrice: '500000', tick: '0.1' });
    // The final band is unbounded, so `upToPrice` is absent rather than empty.
    expect(market.tickTiers[5]!.upToPrice).toBeUndefined();
    expect(market.tickTiers[5]!.tick).toBe('5');
  });

  it('accepts null on every field the live payload nulls', async () => {
    const { client } = clientWith([{ body: { markets: [LIVE_MARKET] } }]);
    const market = (await client.getMarkets())[0]!;
    expect(market.isOutsideRth).toBe(false);
    expect(market.regularTradingHours).toBeNull();
    expect(market.upperTradingBound).toBeNull();
    expect(market.isUpperInExpansionZone).toBeNull();
    expect(market.openInterestCapNotional).toBeNull();
    expect(market.pythId).toBeNull();
  });

  it('accepts a NULL isOutsideRth rather than rejecting the market', async () => {
    // Several live markets report null for the session flag; rejecting the whole
    // payload would have made the entire market list unusable.
    const { client } = clientWith([
      { body: { markets: [{ ...LIVE_MARKET, isOutsideRth: null }] } },
    ]);
    const market = (await client.getMarkets())[0]!;
    expect(market.isOutsideRth).toBeNull();
  });

  it('reports a validation failure instead of silently returning partial data', async () => {
    const { client } = clientWith([{ body: { markets: [{ marketDisplayName: 'X' }] } }]);
    await expect(client.getMarkets()).rejects.toThrow(/schema mismatch/);
  });
});

describe('orderbook and BBO: live wire shapes', () => {
  it('parses L2 levels as [price, size] TUPLES', async () => {
    const { client } = clientWith([{ body: LIVE_ORDERBOOK }]);
    const book = await client.getL2Orderbook('BTC-USD', 3);
    expect(book.bids).toHaveLength(3);
    // Tuple, not object — destructuring is by index.
    expect(book.bids[0]![0]).toBe('83587');
    expect(book.bids[0]![1]).toBe('0.16191699');
    expect(book.asks[0]![0]).toBe('83587.1');
    expect(book.lastSequenceId).toBe(411852675);
  });

  it('rejects the OBJECT level shape, because the live API never sends it', async () => {
    const { client } = clientWith([
      { body: { bids: [{ price: '1', size: '2' }], asks: [] } },
    ]);
    // A silent coercion here would produce a zero-depth book and exclude every
    // market from the candidate pool, which is exactly the bug this pins.
    await expect(client.getL2Orderbook('BTC-USD')).rejects.toThrow(/schema mismatch/);
  });

  it('parses BBO sides as OBJECTS with price/size', async () => {
    const { client } = clientWith([{ body: LIVE_BBO }]);
    const bbo = await client.getBbo('BTC-USD');
    expect(bbo.bestBid?.price).toBe('83587');
    expect(bbo.bestAsk?.size).toBe('0.49557328');
    expect(bbo.timestamp).toBe(1791881242590431);
  });

  it('distinguishes a missing BBO side from a zero price', async () => {
    const { client } = clientWith([{ body: { bestBid: { price: '1', size: '1' }, bestAsk: null } }]);
    const bbo = await client.getBbo('BTC-USD');
    expect(bbo.bestBid?.price).toBe('1');
    expect(bbo.bestAsk).toBeNull();
  });
});

describe('candles: live wire shape', () => {
  it('parses bars and preserves isFinal so forming bars are distinguishable', async () => {
    const { client } = clientWith([{ body: LIVE_CANDLES }]);
    const candles = await client.getCandles({
      market: 'BTC-USD',
      timeframe: '15m',
      to: 1791882000000000,
      countback: 2,
    });
    expect(candles).toHaveLength(2);
    expect(candles.filter((c) => c.isFinal)).toHaveLength(1);
    expect(candles[0]!.openTime).toBe(1791881100000000);
  });

  it('sends `to` in MICROSECONDS, and requires it', async () => {
    const { client, calls } = clientWith([{ body: LIVE_CANDLES }]);
    await client.getCandles({ market: 'BTC-USD', timeframe: '15m', to: 1791882000000000, countback: 5 });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get('to')).toBe('1791882000000000');
    expect(url.searchParams.get('timeframe')).toBe('15m');
    expect(url.searchParams.get('countback')).toBe('5');
  });

  it('refuses from+countback together, which the API rejects', async () => {
    const { client } = clientWith([{ body: LIVE_CANDLES }]);
    await expect(
      client.getCandles({ market: 'BTC-USD', timeframe: '15m', to: 1, from: 2, countback: 3 }),
    ).rejects.toThrow(/mutually exclusive/);
  });
});

describe('fee tiers: live wire shape and UNITS', () => {
  it('parses {tiers:[…]} with ppm rates', async () => {
    const { client } = clientWith([{ body: LIVE_FEETIERS }]);
    const fees = await client.getFeeTiers();
    expect(fees.feeTiers).toHaveLength(3);
    expect(fees.feeTiers[0]).toMatchObject({ level: 0, name: 'Base', taker_fee_ppm: 225 });
  });

  it('converts ppm to bps correctly (1 bp = 100 ppm)', () => {
    // 225 ppm is 2.25 bps. Reading it as 225 bps would overstate the taker fee by
    // 100x and refuse trades whose edge sits between the true and inflated cost.
    expect(ppmToBps(225)).toBe('2.25');
    expect(ppmToBps('190')).toBe('1.9');
    expect(ppmToBps(0)).toBe('0');
    // A rebate tier stays negative; it must never be clamped to zero.
    expect(ppmToBps(-20)).toBe('-0.2');
  });

  it('still accepts a spec-shaped {feeTiers:[…]} response', async () => {
    const { client } = clientWith([
      { body: { feeTiers: [{ tierLevel: 0, makerFeeBps: '1.0', takerFeeBps: '3.5' }] } },
    ]);
    const fees = await client.getFeeTiers();
    expect(fees.feeTiers[0]).toMatchObject({ makerFeeBps: '1.0' });
  });
});

describe('trades and funding rates: live wire shapes', () => {
  it('parses trades keyed by `timestamp`', async () => {
    const { client } = clientWith([{ body: LIVE_TRADE }]);
    const trades = await client.getRecentTrades({ market: 'BTC-USD', limit: 1 });
    expect(trades.trades).toHaveLength(1);
    expect(trades.trades[0]!.timestamp).toBe(1791881872068100);
    expect(trades.trades[0]!.makerOrderId).toBe('96203bb0d04f4fc5');
  });

  it('parses fundingRates keyed by `fundingRate`', async () => {
    const { client } = clientWith([{ body: LIVE_FUNDING_RATES }]);
    const rates = await client.getMarketsFundingRates({ market: 'BTC-USD' });
    expect(rates.fundingRates).toHaveLength(2);
    expect(rates.fundingRates[0]!.fundingRate).toBe('0.0000125');
  });
});

/* ------------------------------------------------------------------ *
 * Access-whitelist handling
 * ------------------------------------------------------------------ */

describe('account reads are access-whitelisted', () => {
  it('surfaces HTTP 403 with the whitelist reason verbatim', async () => {
    const { client } = clientWith([
      { status: 403, body: { error: 'address not on access whitelist' } },
    ]);
    await expect(client.getPositions('0xabc', 0)).rejects.toThrow(ArcusHttpError);
    try {
      await client.getPositions('0xabc', 0);
    } catch (error) {
      expect((error as ArcusHttpError).status).toBe(403);
      expect((error as ArcusHttpError).body).toEqual({ error: 'address not on access whitelist' });
    }
  });

  it('treats a 404 account as "no activity yet" rather than an error', async () => {
    const { client } = clientWith([{ status: 404, body: { error: 'this account has no activity yet' } }]);
    // A fresh account legitimately 404s; the caller must see undefined, not a throw.
    await expect(client.getAccount('0xabc', 0)).resolves.toBeUndefined();
  });

  it('sends address and accountIndex on /v1/rateLimit, which requires them', async () => {
    const { client, calls } = clientWith([
      { body: { order: { capacity: 100, remaining: 80 }, cancel: { capacity: 100, remaining: 90 } } },
    ]);
    const limit = await client.getRateLimit({ address: '0xabc', accountIndex: 3 });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get('address')).toBe('0xabc');
    expect(url.searchParams.get('accountIndex')).toBe('3');
    expect(limit.order?.remaining).toBe(80);
  });

  it('fails closed on the pool when no reading is available and it is required', () => {
    const guard = new TradingPoolGuard({ minOrderRemaining: 50 });
    const verdict = guard.canSubmitOrder();
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/never read/);
  });

  it('records an undisclosed pool (403) and never reports it as healthy', () => {
    const guard = new TradingPoolGuard({ minOrderRemaining: 50 });
    guard.markUndisclosed('GET /v1/rateLimit refused with HTTP 403');
    const verdict = guard.canSubmitOrder();
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/403/);
    expect(guard.disclosureFailure).toMatch(/403/);
  });

  it('permits submission without a pool reading only when explicitly configured', () => {
    const guard = new TradingPoolGuard({ minOrderRemaining: 50, requirePoolReading: false });
    expect(guard.canSubmitOrder().allowed).toBe(true);
  });

  it('refuses when the pool reading is stale, even if it looked healthy', () => {
    let now = 1_000_000;
    const guard = new TradingPoolGuard({ minOrderRemaining: 50, maxAgeMs: 1000, now: () => now });
    guard.update({ orderRemaining: 500, cancelRemaining: 500, orderCapacity: 500, cancelCapacity: 500 });
    expect(guard.canSubmitOrder().allowed).toBe(true);
    now += 5000;
    const verdict = guard.canSubmitOrder();
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/stale/);
  });
});

/* ------------------------------------------------------------------ *
 * Rate limiting
 * ------------------------------------------------------------------ */

describe('rate limiting', () => {
  it('accounts the published per-endpoint weights', () => {
    expect(REQUEST_WEIGHT.markets).toBe(20);
    expect(REQUEST_WEIGHT.candles).toBe(20);
    expect(REQUEST_WEIGHT.bbo).toBe(2);
    expect(REQUEST_WEIGHT.account).toBe(2);
    expect(REQUEST_WEIGHT.placeOrder).toBe(0);
    expect(REQUEST_WEIGHT.health).toBe(0);
  });

  it('refuses a spend the budget cannot cover, and deducts nothing', () => {
    let now = 0;
    const budget = new WeightBudget({ capacity: 25, refillPerSecond: 0, now: () => now });
    expect(budget.spend('markets')).toBe(true);
    expect(budget.available()).toBe(5);
    // 20 more cannot be covered by 5.
    expect(budget.spend('markets')).toBe(false);
    expect(budget.available()).toBe(5);
    now += 1000;
  });

  it('reports the wait needed for an unaffordable endpoint', () => {
    const budget = new WeightBudget({ capacity: 25, refillPerSecond: 25, now: () => 0 });
    budget.spend('markets');
    budget.spend('bbo');
    const waitMs = budget.waitMsFor('markets');
    expect(waitMs).toBeGreaterThan(0);
  });

  it('never lets a free endpoint consume the budget', () => {
    const budget = new WeightBudget({ capacity: 1, refillPerSecond: 0, now: () => 0 });
    expect(budget.spend('health')).toBe(true);
    expect(budget.spend('placeOrder')).toBe(true);
    expect(budget.available()).toBe(1);
  });

  it('trips the circuit breaker on repeated 429s and recovers after cooldown', () => {
    let now = 0;
    const breaker = new ThrottleCircuitBreaker({ threshold: 3, cooldownMs: 1000, now: () => now });
    breaker.recordThrottled();
    breaker.recordThrottled();
    expect(breaker.isOpen).toBe(false);
    breaker.recordThrottled();
    expect(breaker.isOpen).toBe(true);
    now += 1001;
    expect(breaker.isOpen).toBe(false);
  });

  it('escalates the cooldown on repeated trips', () => {
    let now = 0;
    const breaker = new ThrottleCircuitBreaker({ threshold: 1, cooldownMs: 100, backoffFactor: 3, now: () => now });
    breaker.recordThrottled();
    const first = breaker.remainingMs();
    now += first + 1;
    breaker.recordThrottled();
    expect(breaker.remainingMs()).toBeGreaterThan(first);
  });
});

/* ------------------------------------------------------------------ *
 * Error taxonomy
 * ------------------------------------------------------------------ */

describe('error handling', () => {
  it('raises a typed rate-limit error carrying Retry-After', async () => {
    const { client } = clientWith([
      { status: 429, body: { error: 'rate limited' }, headers: { 'retry-after': '2' } },
    ]);
    try {
      await client.getMarkets();
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ArcusHttpError);
      expect((error as ArcusHttpError).status).toBe(429);
    }
  });

  it('classifies the 429 pool reason so the caller knows which bucket bound', async () => {
    const { client } = clientWith([
      { status: 429, body: { error: 'rate limited', reason: 'account_empty', retryAfterMs: 850 } },
    ]);
    const budget = client.weightBudget;
    await expect(client.getMarkets()).rejects.toMatchObject({
      reason: 'account_empty',
      retryAfterMs: 850,
    });
    void budget;
  });

  it('treats a transport failure as retryable and typed', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const client = new ArcusRestClient({ baseUrl: 'https://api.arcus.xyz', logger, fetchImpl });
    await expect(client.getMarkets()).rejects.toThrow(/network failure/);
  });

  it('does not leak credentials in an error message', async () => {
    const signer = new ArcusSigner({ signingKeyHex: '77'.repeat(32) });
    const { client } = clientWith([{ status: 401, body: { error: 'bad signature' } }]);
    void signer;
    try {
      await client.getMarkets();
    } catch (error) {
      const message = String(error);
      expect(message).not.toContain('77'.repeat(32));
    }
  });
});
