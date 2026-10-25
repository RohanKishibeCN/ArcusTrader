/**
 * Market and account data provider.
 *
 * Two jobs:
 *
 *  1. Cache market metadata and candle history, and serve them with an explicit
 *     freshness verdict rather than a bare value. Freshness is the input the
 *     RiskEngine needs, so making it a first-class return type (rather than
 *     something a caller has to remember to check) removes a whole class of
 *     "traded on a 40-second-old mark price" bugs.
 *
 *  2. Own the shared clock. Every timestamp in the system comes from here so a
 *     test can drive time deterministically and so the daily report cannot
 *     disagree with the risk checks about "now".
 *
 * Freshness policy: a snapshot older than `MAX_DATA_AGE_MS` (default 3000) is
 * STALE and unusable for a trading decision. Market METADATA additionally has a
 * much longer tolerance (`MAX_MARKET_METADATA_AGE_MS`, default 5 min) because
 * tick/step sizes are static config, not live prices — but a stale metadata
 * snapshot still blocks trading, because sizing against a market whose grid may
 * have changed is exactly the kind of silent error the brief forbids.
 */

import type { Logger } from '../util/logger';
import { Decimal, dec, midPrice, spreadBps, toFixedString } from '../util/decimal';
import type { ArcusRestClient } from '../arcus/ArcusRestClient';
import { ArcusHttpError, ArcusValidationError } from '../arcus/ArcusRestClient';
import type {
  Account,
  BBO,
  Candle,
  MarketInfo,
  NormalizedLevel,
  OrderbookLevel,
  OrderbookSnapshot,
  Position,
  Timeframe,
} from '../arcus/types';
import { isRwaCategory } from '../arcus/types';

/** Freshness verdict returned alongside every cached snapshot. */
export interface Fresh<T> {
  readonly value: T;
  readonly ageMs: number;
  readonly maxAgeMs: number;
  readonly fresh: boolean;
  /** Why the datum is unusable, when it is not fresh. */
  readonly reason?: string;
}

export function isFresh<T>(snapshot: Fresh<T>): boolean {
  return snapshot.fresh;
}

/** Effective best bid/ask with an explicit validity verdict. */
export interface Quote {
  readonly bid: Decimal;
  readonly ask: Decimal;
  readonly mid: Decimal;
  readonly spreadBps: Decimal | undefined;
  readonly ageMs: number;
  readonly fresh: boolean;
  readonly reason?: string;
}

/** Why a market may not be traded right now. */
export interface MarketTradability {
  readonly marketId: number;
  readonly symbol: string;
  readonly tradable: boolean;
  readonly reasons: readonly string[];
  /** Market classification, used by the candidate pool and the daily report. */
  readonly category: MarketInfo['category'];
  readonly isRwa: boolean;
  /**
   * Off-hours flag straight from the venue payload, never computed locally.
   * `null` means the venue did not report a session, which is treated as unknown.
   */
  readonly isOutsideRth: boolean | null;
}

export interface MarketProviderOptions {
  readonly rest: ArcusRestClient;
  readonly logger: Logger;
  /** Max age for live data (prices, book, account). */
  readonly maxDataAgeMs: number;
  /** Max age for static market metadata. */
  readonly maxMetadataAgeMs: number;
  /** Injectable clock. */
  readonly now?: () => number;
}

export class MarketProvider {
  private readonly rest: ArcusRestClient;
  private readonly logger: Logger;
  private readonly maxDataAgeMs: number;
  private readonly maxMetadataAgeMs: number;
  private readonly now: () => number;

  private markets = new Map<number, MarketInfo>();
  private marketsBySymbol = new Map<string, MarketInfo>();
  private marketsFetchedAtMs = 0;

  private readonly candles = new Map<string, { bars: Candle[]; fetchedAtMs: number }>();
  private readonly quotes = new Map<number, { quote: Quote; fetchedAtMs: number }>();
  private readonly books = new Map<number, { book: OrderbookSnapshot; fetchedAtMs: number }>();

  private account?: { account: Account | undefined; fetchedAtMs: number };
  private positions?: { positions: readonly Position[]; fetchedAtMs: number };

  /** Counters surfaced in the daily report. */
  readonly counters = { marketFetches: 0, candleFetches: 0, bboFetches: 0, bookFetches: 0, accountFetches: 0 };

  constructor(options: MarketProviderOptions) {
    this.rest = options.rest;
    this.logger = options.logger;
    this.maxDataAgeMs = options.maxDataAgeMs;
    this.maxMetadataAgeMs = options.maxMetadataAgeMs;
    this.now = options.now ?? (() => Date.now());
  }

  /* ---------------------------------------------------------------- *
   * Market metadata
   * ---------------------------------------------------------------- */

  /**
   * Refresh the market list.
   *
   * Called at startup and periodically. Returns false (without throwing) when
   * the refresh failed but a previous snapshot exists, because continuing on
   * slightly stale metadata is acceptable while trading is blocked — whereas
   * losing the metadata entirely would be worse.
   */
  async refreshMarkets(): Promise<boolean> {
    this.counters.marketFetches += 1;
    try {
      const list = await this.rest.getMarkets();
      const next = new Map<number, MarketInfo>();
      const bySymbol = new Map<string, MarketInfo>();
      for (const market of list) {
        next.set(market.marketId, market);
        bySymbol.set(market.marketDisplayName.toUpperCase(), market);
      }
      this.markets = next;
      this.marketsBySymbol = bySymbol;
      this.marketsFetchedAtMs = this.now();
      this.logger.info({ markets: next.size }, 'market metadata refreshed');
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ err: message }, 'failed to refresh market metadata');
      return false;
    }
  }

  /** All known markets, as a fresh-annotated snapshot. */
  getMarkets(): Fresh<readonly MarketInfo[]> {
    const ageMs = this.now() - this.marketsFetchedAtMs;
    const fresh = this.markets.size > 0 && this.marketsFetchedAtMs > 0 && ageMs <= this.maxMetadataAgeMs;
    return {
      value: [...this.markets.values()],
      ageMs,
      maxAgeMs: this.maxMetadataAgeMs,
      fresh,
      ...(fresh
        ? {}
        : {
            reason:
              this.markets.size === 0
                ? 'market metadata never fetched'
                : `market metadata is ${ageMs}ms old (limit ${this.maxMetadataAgeMs}ms)`,
          }),
    };
  }

  getMarketById(marketId: number): MarketInfo | undefined {
    return this.markets.get(marketId);
  }

  getMarketBySymbol(symbol: string): MarketInfo | undefined {
    return this.marketsBySymbol.get(symbol.toUpperCase());
  }

  /** Metadata version stamp, so cached candles can be invalidated on a grid change. */
  get metadataAgeMs(): number {
    return this.now() - this.marketsFetchedAtMs;
  }

  /* ---------------------------------------------------------------- *
   * Candle history
   * ---------------------------------------------------------------- */

  private candleKey(symbol: string, timeframe: string): string {
    return `${symbol.toUpperCase()}::${timeframe}`;
  }

  /**
   * Fetch candle history.
   *
   * `to` is REQUIRED by the API and is epoch microseconds; `countback` and `from`
   * are mutually exclusive. Only closed bars (`isFinal`) are retained for
   * indicator use — a forming bar would make indicators repaint and signals
   * flicker, so the forming bar is cached separately and never fed to a signal.
   */
  async fetchCandles(params: {
    symbol: string;
    timeframe: Timeframe | string;
    countback: number;
  }): Promise<readonly Candle[]> {
    this.counters.candleFetches += 1;
    const key = this.candleKey(params.symbol, String(params.timeframe));
    const to = Math.floor(this.now() * 1000); // ms -> µs
    try {
      const bars = await this.rest.getCandles({
        market: params.symbol,
        timeframe: String(params.timeframe),
        to,
        countback: params.countback,
      });
      // Sort ascending by openTime defensively; indicators assume chronology.
      const sorted = [...bars].sort((a, b) => a.openTime - b.openTime);
      this.candles.set(key, { bars: sorted, fetchedAtMs: this.now() });
      return sorted;
    } catch (error) {
      if (error instanceof ArcusValidationError) {
        this.logger.error(
          { symbol: params.symbol, timeframe: params.timeframe, err: error.message },
          'candle response failed schema validation; treating history as unavailable',
        );
      } else if (error instanceof ArcusHttpError) {
        this.logger.warn(
          { symbol: params.symbol, timeframe: params.timeframe, status: error.status },
          'candle request rejected',
        );
      } else {
        this.logger.warn(
          { symbol: params.symbol, timeframe: params.timeframe, err: String(error) },
          'candle request failed',
        );
      }
      throw error;
    }
  }

  /** Cached candles, annotated with freshness. Closed bars only. */
  getCandles(symbol: string, timeframe: Timeframe | string): Fresh<readonly Candle[]> {
    const key = this.candleKey(symbol, String(timeframe));
    const entry = this.candles.get(key);
    if (!entry) {
      return {
        value: [],
        ageMs: Number.POSITIVE_INFINITY,
        maxAgeMs: this.maxDataAgeMs,
        fresh: false,
        reason: `no candle history cached for ${symbol} ${timeframe}`,
      };
    }
    const ageMs = this.now() - entry.fetchedAtMs;
    // Candle history is refreshed on a bar cadence, so its tolerance is the
    // caller's decision (see StrategyEvaluator). Here we report age only.
    return { value: entry.bars, ageMs, maxAgeMs: this.maxDataAgeMs, fresh: true };
  }

  getCandlesClosed(symbol: string, timeframe: Timeframe | string): readonly Candle[] {
    return this.getCandles(symbol, timeframe).value.filter((bar) => bar.isFinal);
  }

  /* ---------------------------------------------------------------- *
   * Quote / book
   * ---------------------------------------------------------------- */

  /**
   * Fetch and cache best bid/offer.
   *
   * A BBO with a missing side is unusable rather than merely stale: `bestBid`
   * and `bestAsk` are documented nullable, and treating a null ask as "0" would
   * produce an infinite spread and a nonsensical limit price.
   */
  async refreshQuote(marketId: number, symbol: string): Promise<Quote | undefined> {
    this.counters.bboFetches += 1;
    let bbo: BBO;
    try {
      bbo = await this.rest.getBbo(symbol);
    } catch (error) {
      this.logger.warn({ symbol, err: String(error) }, 'bbo request failed');
      return undefined;
    }
    const bid = bbo.bestBid?.price;
    const ask = bbo.bestAsk?.price;
    if (bid === undefined || ask === undefined) {
      this.quotes.delete(marketId);
      this.logger.warn({ symbol, bid, ask }, 'bbo missing a side; quote unusable');
      return undefined;
    }
    const bidDec = dec(bid);
    const askDec = dec(ask);
    const quote: Quote = {
      bid: bidDec,
      ask: askDec,
      mid: midPrice(bidDec, askDec),
      spreadBps: spreadBps(bidDec, askDec),
      ageMs: 0,
      fresh: true,
    };
    this.quotes.set(marketId, { quote, fetchedAtMs: this.now() });
    return quote;
  }

  /** Cached quote with a freshness verdict. */
  getQuote(marketId: number): Quote | undefined {
    const entry = this.quotes.get(marketId);
    if (!entry) return undefined;
    const ageMs = this.now() - entry.fetchedAtMs;
    const fresh = ageMs <= this.maxDataAgeMs;
    return {
      ...entry.quote,
      ageMs,
      fresh,
      ...(fresh ? {} : { reason: `quote is ${ageMs}ms old (limit ${this.maxDataAgeMs}ms)` }),
    };
  }

  async refreshOrderbook(marketId: number, symbol: string, nLevels = 20): Promise<OrderbookSnapshot | undefined> {
    this.counters.bookFetches += 1;
    try {
      const book = await this.rest.getL2Orderbook(symbol, nLevels);
      this.books.set(marketId, { book, fetchedAtMs: this.now() });
      return book;
    } catch (error) {
      this.logger.warn({ symbol, err: String(error) }, 'l2 orderbook request failed');
      return undefined;
    }
  }

  getOrderbook(marketId: number): Fresh<OrderbookSnapshot | undefined> {
    const entry = this.books.get(marketId);
    if (!entry) {
      return {
        value: undefined,
        ageMs: Number.POSITIVE_INFINITY,
        maxAgeMs: this.maxDataAgeMs,
        fresh: false,
        reason: 'no orderbook snapshot cached',
      };
    }
    const ageMs = this.now() - entry.fetchedAtMs;
    const fresh = ageMs <= this.maxDataAgeMs;
    return {
      value: entry.book,
      ageMs,
      maxAgeMs: this.maxDataAgeMs,
      fresh,
      ...(fresh ? {} : { reason: `orderbook is ${ageMs}ms old (limit ${this.maxDataAgeMs}ms)` }),
    };
  }

  /**
   * Usable dollar depth within `bandBps` of the mid on each side.
   *
   * This is the liquidity input for the candidate-pool scoring. Depth is summed
   * as `price * size` and reported per side, because a market with deep bids and
   * a thin ask is not "deep" for a buyer.
   */
  depthUsdWithinBand(book: OrderbookSnapshot, bandBps = 25): { bidUsd: Decimal; askUsd: Decimal } {
    // L2 levels are `[price, size]` tuples, ordered best-first on each side.
    const bestBid = book.bids[0]?.[0];
    const bestAsk = book.asks[0]?.[0];
    if (bestBid === undefined || bestAsk === undefined) {
      return { bidUsd: new Decimal(0), askUsd: new Decimal(0) };
    }
    const mid = midPrice(bestBid, bestAsk);
    if (!mid.greaterThan(0)) return { bidUsd: new Decimal(0), askUsd: new Decimal(0) };
    const band = mid.times(bandBps).div(10_000);
    const lower = mid.minus(band);
    const upper = mid.plus(band);

    // Depth is measured as the notional that could actually be traded within the
    // band, so a level outside it terminates the walk rather than being skipped:
    // the book is price-ordered, so nothing further can qualify.
    let bidUsd = new Decimal(0);
    for (const level of book.bids) {
      const price = dec(level[0]);
      if (price.lessThan(lower)) break;
      bidUsd = bidUsd.plus(price.times(dec(level[1])));
    }
    let askUsd = new Decimal(0);
    for (const level of book.asks) {
      const price = dec(level[0]);
      if (price.greaterThan(upper)) break;
      askUsd = askUsd.plus(price.times(dec(level[1])));
    }
    return { bidUsd, askUsd };
  }

  /** Normalised read of one side, for callers that want Decimals. */
  normalizeLevels(levels: readonly OrderbookLevel[]): NormalizedLevel[] {
    return levels.map((level) => ({ price: dec(level[0]), size: dec(level[1]) }));
  }

  /* ---------------------------------------------------------------- *
   * Account state
   * ---------------------------------------------------------------- */

  async refreshAccount(address: string, accountIndex: number): Promise<Account | undefined> {
    this.counters.accountFetches += 1;
    try {
      const account = await this.rest.getAccount(address, accountIndex);
      this.account = { account, fetchedAtMs: this.now() };
      return account;
    } catch (error) {
      // Deliberately do NOT clear the previous snapshot on failure: a failed read
      // must make the data STALE (blocking new entries), not disappear, so the
      // report can still show the last known state.
      this.logger.warn({ err: String(error) }, 'account read failed; previous snapshot left to age out');
      throw error;
    }
  }

  async refreshPositions(address: string, accountIndex: number): Promise<readonly Position[]> {
    const positions = await this.rest.getPositions(address, accountIndex);
    this.positions = { positions, fetchedAtMs: this.now() };
    return positions;
  }

  /** Account snapshot with freshness. `undefined` means "no account yet" (404). */
  getAccount(): Fresh<Account | undefined> | undefined {
    if (!this.account) return undefined;
    const ageMs = this.now() - this.account.fetchedAtMs;
    const fresh = ageMs <= this.maxDataAgeMs;
    return {
      value: this.account.account,
      ageMs,
      maxAgeMs: this.maxDataAgeMs,
      fresh,
      ...(fresh ? {} : { reason: `account snapshot is ${ageMs}ms old (limit ${this.maxDataAgeMs}ms)` }),
    };
  }

  getPositions(): Fresh<readonly Position[]> | undefined {
    if (!this.positions) return undefined;
    const ageMs = this.now() - this.positions.fetchedAtMs;
    const fresh = ageMs <= this.maxDataAgeMs;
    return {
      value: this.positions.positions,
      ageMs,
      maxAgeMs: this.maxDataAgeMs,
      fresh,
      ...(fresh ? {} : { reason: `positions are ${ageMs}ms old (limit ${this.maxDataAgeMs}ms)` }),
    };
  }

  /** Force the next read to be treated as stale, e.g. after a socket reconnect. */
  invalidateLiveData(): void {
    this.account = undefined;
    this.positions = undefined;
    this.quotes.clear();
  }

  /* ---------------------------------------------------------------- *
   * Tradability
   * ---------------------------------------------------------------- */

  /**
   * The tick tier a price falls into.
   *
   * Bands ascend by `upToPrice`, an EXCLUSIVE upper bound; the final band omits
   * `upToPrice` and is unbounded. Returns `undefined` when a market publishes no
   * tiers (some do not).
   */
  resolveTickTier(market: MarketInfo, price: Decimal): { tick: Decimal; upToPrice?: Decimal } | undefined {
    const tiers = market.tickTiers;
    if (!tiers || tiers.length === 0) return undefined;
    for (const tier of tiers) {
      if (tier.upToPrice === undefined) {
        // Unbounded top band.
        return { tick: dec(tier.tick) };
      }
      const bound = dec(tier.upToPrice);
      if (price.lessThan(bound)) {
        return { tick: dec(tier.tick), upToPrice: bound };
      }
    }
    // Price is at or beyond the last explicit bound and no unbounded band exists.
    const last = tiers[tiers.length - 1]!;
    return {
      tick: dec(last.tick),
      ...(last.upToPrice !== undefined ? { upToPrice: dec(last.upToPrice) } : {}),
    };
  }

  /**
   * The multiplier a limit price must satisfy to be ACCEPTED.
   *
   * Deliberately NOT the divisor used for signing. The docs are explicit that `p`
   * is always `price / tickSize` at every price, and that the tier ladder "only
   * constrains which prices are accepted". So:
   *
   *   - `tickSize` (always the market's top-level value) → signing divisor
   *   - the band's `tick`                               → extra acceptance rule
   *
   * The two coincide in the base band, which is exactly why a client that reads
   * only `tickSize` works until the price crosses a tier boundary.
   */
  acceptanceTickFor(market: MarketInfo, price: Decimal): Decimal {
    const tier = this.resolveTickTier(market, price);
    return tier ? tier.tick : dec(market.tickSize);
  }

  /**
   * Validate a limit price against BOTH the signing grid and the acceptance grid.
   * Returns a reason when rejected, `undefined` when acceptable.
   */
  validateLimitPrice(market: MarketInfo, price: Decimal): string | undefined {
    const signingTick = dec(market.tickSize);
    if (!signingTick.greaterThan(0)) return 'market tickSize is not positive';
    if (!price.greaterThan(0)) return `price ${toFixedString(price)} is not positive`;

    // Rule 1: signable as an integer number of base ticks.
    if (!price.div(signingTick).isInteger()) {
      return (
        `price ${toFixedString(price)} is not a multiple of the market tickSize ` +
        `${toFixedString(signingTick)}`
      );
    }
    // Rule 2: accepted for its price tier.
    const tier = this.resolveTickTier(market, price);
    if (tier && !price.div(tier.tick).isInteger()) {
      return (
        `price ${toFixedString(price)} is not a multiple of tick size ${toFixedString(tier.tick)} ` +
        `for its price tier${tier.upToPrice ? ` (band < ${toFixedString(tier.upToPrice)})` : ' (top band)'}`
      );
    }
    return undefined;
  }

  /** Minimum order notional for a market, when published. */
  minOrderNotional(market: MarketInfo): Decimal | undefined {
    return market.minOrderNotional ? dec(market.minOrderNotional) : undefined;
  }

  /**
   * Whether a market may be traded right now.
   *
   * `reasons` is non-empty whenever `tradable` is false, and is surfaced in the
   * daily report so a market that silently stopped qualifying is visible rather
   * than merely absent.
   */
  isTradable(marketId: number, options?: { allowOffHours?: boolean }): MarketTradability {
    const reasons: string[] = [];
    const market = this.markets.get(marketId);
    if (!market) {
      return {
        marketId,
        symbol: `market#${marketId}`,
        tradable: false,
        reasons: ['market not present in the latest metadata snapshot'],
        category: 'CRYPTO',
        isRwa: false,
        isOutsideRth: false,
      };
    }
    const symbol = market.marketDisplayName;
    const isRwa = isRwaCategory(market.category);

    const metadata = this.getMarkets();
    if (!metadata.fresh) reasons.push(metadata.reason ?? 'market metadata is stale');

    if (market.status !== 'ONLINE') {
      reasons.push(`market status is ${market.status}`);
    }
    if (!dec(market.tickSize).greaterThan(0)) reasons.push('tickSize is not positive');
    if (!dec(market.stepSize).greaterThan(0)) reasons.push('stepSize is not positive');

    // Off hours: refuse new exposure unless explicitly enabled. The venue's own
    // flag is authoritative — we never infer the session from wall-clock time.
    // A null flag is UNKNOWN and is treated as off-hours for ENTRY purposes
    // (fail closed) while still being reported distinctly so the cause is visible.
    if (market.isOutsideRth === null && !options?.allowOffHours) {
      reasons.push(
        'the venue did not report a trading session for this market (isOutsideRth=null); ' +
          'treating the session as unknown and refusing a new entry',
      );
    } else if (market.isOutsideRth === true && !options?.allowOffHours) {
      reasons.push('market is outside regular trading hours and off-hours entries are disabled');
    }

    const quote = this.getQuote(marketId);
    if (!quote) {
      reasons.push('no quote available');
    } else if (!quote.fresh) {
      reasons.push(quote.reason ?? 'quote is not fresh');
    }

    return {
      marketId,
      symbol,
      tradable: reasons.length === 0,
      reasons,
      category: market.category,
      isRwa,
      isOutsideRth: market.isOutsideRth,
    };
  }

  /**
   * Check a prospective limit price against the off-hours trading band.
   *
   * Outside RTH the engine enforces `lowerTradingBound`/`upperTradingBound` and
   * rejects orders beyond them with
   * `PRICE_WILL_EXCEED_MAXIMUM_OUTSIDE_RTH_TRADING_BOUND`. Checking locally turns
   * a guaranteed rejection into a clear local refusal.
   */
  checkTradingBounds(marketId: number, price: Decimal): { ok: boolean; reason?: string } {
    const market = this.markets.get(marketId);
    if (!market) return { ok: false, reason: 'market not found' };
    // Only enforce bounds when the venue actually says we are outside RTH.
    if (market.isOutsideRth !== true) return { ok: true };

    const lower = market.lowerTradingBound ? dec(market.lowerTradingBound) : undefined;
    const upper = market.upperTradingBound ? dec(market.upperTradingBound) : undefined;
    if (lower && price.lessThan(lower)) {
      return { ok: false, reason: `price ${toFixedString(price)} is below the off-hours lower bound ${toFixedString(lower)}` };
    }
    if (upper && price.greaterThan(upper)) {
      return { ok: false, reason: `price ${toFixedString(price)} is above the off-hours upper bound ${toFixedString(upper)}` };
    }
    return { ok: true };
  }

  /** Effective initial margin fraction: off-hours value applies when outside RTH. */
  effectiveInitialMarginFraction(market: MarketInfo): Decimal | undefined {
    if (market.isOutsideRth === true && market.offHoursInitialMarginFraction) {
      return dec(market.offHoursInitialMarginFraction);
    }
    return market.initialMarginFraction ? dec(market.initialMarginFraction) : undefined;
  }

  /**
   * Maintenance margin fraction, used for the liquidation-distance estimate and
   * the withdrawable-balance calculation.
   */
  maintenanceMarginFraction(market: MarketInfo): Decimal | undefined {
    return market.maintenanceMarginFraction ? dec(market.maintenanceMarginFraction) : undefined;
  }

  snapshotStats(): Record<string, unknown> {
    return {
      markets: this.markets.size,
      metadataAgeMs: this.metadataAgeMs,
      cachedCandles: this.candles.size,
      cachedQuotes: this.quotes.size,
      counters: this.counters,
    };
  }
}
