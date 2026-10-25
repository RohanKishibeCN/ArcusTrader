/**
 * Runtime.
 *
 * The trading loop, and the place where the brief's "任何情况禁止新开仓" list is
 * actually enforced. That list is implemented as ONE function,
 * `deriveEntryGate`, which returns either an empty reason set (entry permitted) or
 * the reasons it is not. Every condition is checked there, in one place, so the
 * list can be audited against the brief line by line instead of being scattered
 * across the codebase where a missed branch is invisible.
 *
 * Loop structure per tick:
 *
 *   1. refresh volatile data (positions, quotes, pools) within the rate budget
 *   2. drain WebSocket-driven events: fills and order updates
 *   3. MANAGE existing positions FIRST — protective stops outrank new entries
 *   4. evaluate candidates for a new entry, only if the gate permits
 *   5. update circuit breakers
 *
 * Step 3 before step 4 is deliberate. If the process is short on time or budget, a
 * position without a confirmed stop is the emergency; a missed entry is not.
 */

import { Decimal, dec, toFixedString } from '../util/decimal';
import type { Logger } from '../util/logger';
import type { AppContext } from './bootstrap';
import { runStartupSequence, type StartupReport } from './bootstrap';
import type { Fill, MarketInfo, Order, Position } from '../arcus/types';
import { ArcusHttpError } from '../arcus/ArcusRestClient';
import { isRwaCategory } from '../arcus/types';
import { collectAccountOverview, type AccountOverview } from './AccountOverview';
import type { AffiliateInfo } from '../arcus/types';
import { dayKey } from '../store/Store';
import type { DecisionOutcome } from './DecisionPipeline';
import type { RiskEngineState, TradeProposal } from '../risk/RiskEngine';
import { isEntryOrderExpired } from '../execution/Executor';
import { HealthServer, type HealthSnapshot } from './HealthServer';
import {
  buildDailyReportCard,
  renderReportText,
  reportDateInTimezone,
  reportIdempotencyKey,
  type DailyReportInput,
  type ReportExtras,
} from '../notifications/DailyReport';

/** Candidate market with its liquidity score. */
export interface MarketCandidate {
  readonly market: MarketInfo;
  readonly symbol: string;
  readonly score: Decimal;
  readonly spreadBps: Decimal | undefined;
  readonly depthUsd: Decimal;
  readonly isRwa: boolean;
  /** Tri-state: `null` means the venue did not report a session (treated as unknown). */
  readonly isOutsideRth: boolean | null;
  readonly components: Record<string, string>;
}

/** The entry gate verdict. `blocked` is empty only when entry is permitted. */
export interface EntryGate {
  readonly allowed: boolean;
  readonly blocked: readonly string[];
}

export interface RuntimeOptions {
  /** Tick interval for the decision loop. */
  readonly tickIntervalMs?: number;
  /** Cadence for the candle refresh. */
  readonly candleRefreshMs?: number;
  /** Run one tick then return. Used by tests and by `reconcile`. */
  readonly once?: boolean;
  /** Maximum ticks before stopping; used by tests. */
  readonly maxTicks?: number;
}

export class Runtime {

  private readonly context: AppContext;
  private readonly logger: Logger;
  private readonly tickIntervalMs: number;
  private readonly candleRefreshMs: number;
  private readonly once: boolean;
  private readonly maxTicks: number;

  private running = false;
  private tickCount = 0;
  private completedTicks = 0;

  /**
   * How many ticks have STARTED. Used for the per-tick log line.
   */
  get ticksStarted(): number {
    return this.tickCount;
  }

  /**
   * How many ticks have FINISHED.
   *
   * Distinct from `ticksStarted` on purpose: `tickCount` is incremented at the top of
   * `tick()`, so reporting it as "completed" made the health payload claim
   * `ticksCompleted: 1` while simultaneously reporting "no tick has completed yet". A
   * half-finished tick is not a completed one, and the loop-regression test asserts
   * against this counter.
   */
  get ticksCompleted(): number {
    return this.completedTicks;
  }
  private lastCandleRefreshMs = 0;
  private lastPoolRefreshMs = 0;
  private lastRerankMs = 0;
  private lastReportCheckMs = 0;
  /** Outbox retry pacing, so a failing Lark endpoint is not hammered every tick. */
  private lastOutboxFlushMs = 0;
  private previousEquity?: Decimal;
  private recalibrating = false;
  private recalibrationReason?: string;
  private recalibrationDay?: string;

  /**
   * Approved proposals awaiting a fill, keyed by the entry order's clientId.
   *
   * Without this, the fill path has to re-derive the stop and the targets from current
   * structure — which silently substitutes DIFFERENT levels than the ones the
   * RiskEngine sized against. Keeping the proposal means the stop, the R multiples and
   * the size all refer to the same decision.
   */
  private readonly pendingProposals = new Map<string, { proposal: TradeProposal; quantity: Decimal }>();

  private candidates: MarketCandidate[] = [];
  private activeMarketId?: number;
  private lastActiveMarketSwitchMs = 0;

  /** Circuit-breaker / drift state surfaced in the report. */
  /** Opt-in monitoring endpoint. Disabled unless HEALTHCHECK_PORT is set. */
  private healthServer?: HealthServer;
  private lastTickCompletedAtMs?: number;

  private reconciliationOk = false;
  private reconciliationReason?: string;
  private strategyState = 'starting';
  private readonly anomalies: string[] = [];

  constructor(context: AppContext, options: RuntimeOptions = {}) {
    this.context = context;
    this.logger = context.logger;
    this.tickIntervalMs = options.tickIntervalMs ?? context.config.raw.TICK_INTERVAL_MS;
    this.candleRefreshMs = options.candleRefreshMs ?? context.config.raw.CANDLE_REFRESH_MS;
    this.once = options.once ?? false;
    this.maxTicks = options.maxTicks ?? Number.POSITIVE_INFINITY;
  }

  /* ---------------------------------------------------------------- *
   * Lifecycle
   * ---------------------------------------------------------------- */

  async start(): Promise<StartupReport> {
    const { logger, ws } = this.context;

    const startup = await runStartupSequence(this.context);
    this.reconciliationOk = startup.reconciled;
    this.reconciliationReason = startup.reconciliationReason;

    // WebSocket event wiring. Fills drive the ledger; order updates drive the
    // local state machine. Both are idempotent, so a snapshot plus a live frame
    // for the same event is harmless.
    ws.on('update', (frame) => this.handleFrame(frame));

    logger.info(
      {
        orderSubmissionAllowed: this.context.orderSubmissionAllowed,
        reconciled: startup.reconciled,
        failures: startup.failures,
      },
      'runtime starting',
    );

    // Start monitoring before the loop, so a system that fails to trade is observable.
    if (this.context.config.raw.HEALTHCHECK_PORT > 0) {
      this.healthServer = new HealthServer({
        port: this.context.config.raw.HEALTHCHECK_PORT,
        logger,
        snapshot: () => this.healthSnapshot(),
        stallThresholdMs:
          this.context.config.raw.HEALTH_STALL_THRESHOLD_MS > 0
            ? this.context.config.raw.HEALTH_STALL_THRESHOLD_MS
            : Math.max(60_000, this.tickIntervalMs * 12),
      });
      await this.healthServer.start();
    }

    this.running = true;
    let ticks = 0;
    this.logger.info(
      { maxTicks: this.maxTicks === Number.POSITIVE_INFINITY ? 'unbounded' : this.maxTicks, tickIntervalMs: this.tickIntervalMs, once: this.once },
      'entering the trading loop',
    );
    while (this.running && ticks < this.maxTicks) {
      ticks += 1;
      try {
        await this.tick();
      } catch (error) {
        // A thrown tick must NOT kill the process: the protective-order management
        // in the next tick is more important than the error that broke this one.
        logger.error({ err: error instanceof Error ? error.message : String(error) }, 'tick failed');
        this.anomalies.push(`tick failure: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.logger.debug(
        { ticks, running: this.running, once: this.once },
        'loop iteration finished',
      );
      if (this.once || !this.running) break;
      await this.sleep(this.tickIntervalMs);
    }
    this.logger.info(
      { ticksStarted: ticks, ticksCompleted: this.completedTicks, running: this.running },
      'trading loop exited',
    );

    await this.shutdown();
    return startup;
  }

  stop(): void {
    this.running = false;
  }

  private async shutdown(): Promise<void> {
    if (this.healthServer) {
      await this.healthServer.stop();
      this.healthServer = undefined;
    }
    this.context.ws.close();
    try {
      await this.context.alertRouter.flushOutbox();
    } catch (error) {
      this.logger.warn({ err: String(error) }, 'outbox flush failed during shutdown');
    }
    this.context.store.close();
    this.logger.info({ ticks: this.tickCount }, 'runtime stopped');
  }

  /**
   * Sleep between ticks.
   *
   * The timer is deliberately REFERENCED. `unref()` would let Node exit as soon as
   * nothing else holds the event loop open, so with no WebSocket attached (the
   * read-only posture, where every account subscription is refused) the process
   * ended silently after the FIRST tick while `--ticks 6` was requested. Under PM2
   * that presents as a clean-looking start/exit loop rather than as a crash.
   *
   * Rule applied here: a timer that represents pending WORK must be referenced; only
   * timers that are merely housekeeping (reconnect delays, heartbeats) may be
   * unref'd, because their absence should never keep a finished process alive.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  /* ---------------------------------------------------------------- *
   * One tick
   * ---------------------------------------------------------------- */

  async tick(): Promise<void> {
    this.tickCount += 1;
    const nowMs = Date.now();

    /* ---- 1. volatility-aware refreshes ---------------------------- */
    await this.refreshRateLimitPools(nowMs);
    // NOTE: account/positions are refreshed AFTER the candle work below. See the
    // ordering comment there — reading them first made them stale at gate time.
    await this.refreshQuotes(nowMs);

    /**
     * ORDER MATTERS HERE: ranking runs BEFORE the candle refresh.
     *
     * Two dependencies make the reverse order wrong:
     *
     *  - Ranking needs quotes, which the step above has just fetched.
     *  - The candle refresh iterates the CANDIDATE list. Before the first ranking
     *    that list is empty, so refreshing candles first fetched nothing; the list
     *    was then populated by the ranking that followed, meaning no candidate had
     *    any candle history until the next refresh — up to a full `candleRefreshMs`
     *    later. The strategy reported "incomplete candle history" for its first
     *    minute of life, which is exactly what the live dry-run showed.
     *
     * Ranking also retries much sooner while the pool is empty, because at startup
     * no quotes exist yet and the first pass necessarily finds nothing.
     */
    const rerankDue = nowMs - this.lastRerankMs >= this.context.config.raw.MARKET_RERANK_INTERVAL_MS;
    const poolEmptyRetryDue = this.candidates.length === 0 && nowMs - this.lastRerankMs >= 15_000;
    if (rerankDue || poolEmptyRetryDue) {
      await this.rerankCandidates(nowMs);
      this.lastRerankMs = nowMs;
      // A newly populated pool needs its history immediately, not next minute.
      await this.refreshCandles(nowMs);
      this.lastCandleRefreshMs = nowMs;
    } else if (nowMs - this.lastCandleRefreshMs >= this.candleRefreshMs) {
      await this.refreshCandles(nowMs);
      this.lastCandleRefreshMs = nowMs;
    }

    /**
     * Refresh the account LAST, immediately before any decision is made.
     *
     * This ordering is load-bearing. The candle refresh issues up to nine requests
     * (~2s each) and used to run AFTER the account read, so by the time the entry gate
     * evaluated freshness the account snapshot was 8-16 seconds old against a 3-second
     * limit — the gate could never pass on a tick that refreshed candles. Reading the
     * account after all the slow work bounds its age to roughly one request.
     */
    await this.refreshAccountAndPositions(nowMs);

    /* ---- 2. reconcile --------------------------------------------- */
    await this.reconcileNow();

    /* ---- 3. MANAGE EXISTING POSITIONS FIRST ----------------------- */
    await this.managePositions(nowMs);

    /* ---- 4. kill-switch-driven cleanup ---------------------------- */
    const kill = this.context.killSwitch.decide();
    if (!kill.allowNewPositions) {
      await this.context.executor.cancelWorkingEntries({
        markets: new Map(this.context.markets.getMarkets().value.map((m) => [m.marketId, m])),
        allowSubmission: this.context.orderSubmissionAllowed,
      });
      this.strategyState = `halted (${kill.status.reason ?? 'kill switch engaged'})`;
    }

    /* ---- 5. circuit breakers -------------------------------------- */
    this.updateCircuitBreakers();

    /* ---- 6. new entries, only when the gate permits --------------- */
    const gate = this.deriveEntryGate();
    if (!gate.allowed) {
      this.logger.debug({ blocked: gate.blocked.slice(0, 4) }, 'entry gate closed');
    } else {
      await this.evaluateForEntry();
    }

    /* ---- 7. housekeeping ------------------------------------------ */
    await this.expireEntryOrders(nowMs);
    await this.maybeSendDailyReport(nowMs);
    // Paced retry: the in-loop alert path already enqueues failures, so this only needs
    // to run on the configured cadence rather than every tick.
    if (nowMs - this.lastOutboxFlushMs >= this.context.config.raw.LARK_OUTBOX_RETRY_MS) {
      await this.context.alertRouter.flushOutbox();
      this.lastOutboxFlushMs = nowMs;
    }

    // One line per tick. Without it there is no way to tell a running loop from a
    // stalled one, because a healthy tick can legitimately emit no other output.
    this.completedTicks += 1;
    this.lastTickCompletedAtMs = this.now();
    this.logger.info(
      {
        tick: this.tickCount,
        strategyState: this.strategyState,
        activeMarket: this.activeMarketId !== undefined
          ? this.context.markets.getMarketById(this.activeMarketId)?.marketDisplayName
          : undefined,
        candidates: this.candidates.length,
        openPositions: this.context.markets.getPositions()?.value.length ?? 0,
        workingOrders: this.context.orderStateMachine.liveOrders().length,
        ws: this.context.ws.stats.state,
        wsReady: this.context.ws.isReady,
        reconciled: this.reconciliationOk,
        killSwitch: this.context.killSwitch.engaged,
        weightAvailable: this.context.weightBudget.snapshot().available,
      },
      'tick complete',
    );
  }

  /* ---------------------------------------------------------------- *
   * Data refreshes
   * ---------------------------------------------------------------- */

  private async refreshRateLimitPools(nowMs: number): Promise<void> {
    if (nowMs - this.lastPoolRefreshMs < 60_000) return;
    this.lastPoolRefreshMs = nowMs;
    const address = this.context.config.raw.ARCUS_WALLET_ADDRESS;
    if (!address) return;
    try {
      const limit = await this.context.rest.getRateLimit({
        address,
        accountIndex: this.context.config.raw.ARCUS_ACCOUNT_INDEX,
      });
      this.context.poolGuard.update({
        orderRemaining: limit.order?.remaining ?? 0,
        cancelRemaining: limit.cancel?.remaining ?? 0,
        orderCapacity: limit.order?.capacity ?? 0,
        cancelCapacity: limit.cancel?.capacity ?? 0,
      });
    } catch (error) {
      const status = error instanceof ArcusHttpError ? error.status : undefined;
      if (status === 403 || status === 400) {
        this.context.poolGuard.markUndisclosed(`GET /v1/rateLimit refused with HTTP ${status}`);
      }
      // A failed read either leaves the previous (ageing) reading in place — which
      // TradingPoolGuard then treats as stale — or records the disclosure failure.
      this.logger.warn({ err: String(error), status }, 'rate-limit pool read failed');
    }
  }

  private async refreshAccountAndPositions(nowMs: number): Promise<void> {
    // Unconditional: `account` + `positions` are weight 2 each, so a 5s tick costs
    // 0.8 weight/s against a 25/s budget. Freshness here is what the entry gate reads,
    // so throttling it was trading the wrong resource for the wrong thing.
    void nowMs;
    const address = this.context.config.raw.ARCUS_WALLET_ADDRESS;
    if (!address) return;
    const accountIndex = this.context.config.raw.ARCUS_ACCOUNT_INDEX;
    try {
      const account = await this.context.markets.refreshAccount(address, accountIndex);
      if (account) {
        const equity = dec(account.equity);
        this.checkRecalibration(equity);
        this.context.store.recordEquitySnapshot({
          capturedAtMs: nowMs,
          equity,
          freeCollateral: dec(account.freeCollateral),
          usedMargin: Object.values(account.positions).reduce(
            (acc, p) => acc.plus(dec(p.marginUsed)),
            dec('0'),
          ),
          unrealizedPnl: Object.values(account.positions).reduce(
            (acc, p) => acc.plus(dec(p.unrealizedPnl)),
            dec('0'),
          ),
        });
      }
      await this.context.markets.refreshPositions(address, accountIndex);
    } catch (error) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'account/positions refresh failed; entry gate will see stale data and refuse',
      );
    }
  }

  /**
   * Keep quotes warm.
   *
   * Two populations need quotes, for different reasons:
   *
   *  - The active market and the top candidates, because the decision pipeline
   *    reads their spread and depth.
   *  - A BREADTH sample, because candidate ranking filters on spread and depth.
   *    Without priming, the first ranking pass sees no quotes at all and selects
   *    nothing, which leaves the strategy idle until the next hourly rerank.
   *
   * BBO is the cheapest read available (weight 2, so ~0.4 weight/s at this
   * cadence), and the breadth sample is bounded so the per-IP budget cannot be
   * drained by it.
   */
  private async refreshQuotes(nowMs: number): Promise<void> {
    const wanted = new Set<number>();
    if (this.activeMarketId !== undefined) wanted.add(this.activeMarketId);
    for (const candidate of this.candidates.slice(0, this.context.config.raw.MAX_CANDIDATE_MARKETS)) {
      wanted.add(candidate.market.marketId);
    }
    for (const market of this.breadthSample()) wanted.add(market.marketId);

    for (const marketId of wanted) {
      const market = this.context.markets.getMarketById(marketId);
      if (!market) continue;
      if (market.marketDisplayName) {
        await this.context.markets.refreshQuote(marketId, market.marketDisplayName);
      }
    }
    void nowMs;
  }

  /**
   * The markets worth quoting before ranking has run.
   *
   * Ordered by published 24h notional, so the sample covers the markets most
   * likely to qualify on liquidity, and capped by `MAX_BREADTH_QUOTES`.
   */
  private breadthSample(): readonly MarketInfo[] {
    const raw = this.context.config.raw;
    const markets = this.context.markets.getMarkets().value;
    return [...markets]
      .filter((market) => market.status === 'ONLINE')
      .filter((market) => {
        const isRwa = isRwaCategory(market.category);
        if (isRwa && !raw.PREFER_RWA) return false;
        if (!isRwa && !raw.ALLOW_CRYPTO) return false;
        return true;
      })
      .sort((a, b) => {
        const av = a.volume24hNotional ? dec(a.volume24hNotional) : dec('0');
        const bv = b.volume24hNotional ? dec(b.volume24hNotional) : dec('0');
        return bv.comparedTo(av);
      })
      .slice(0, this.context.config.raw.MAX_BREADTH_QUOTES);
  }

  private async refreshCandles(nowMs: number): Promise<void> {
    const raw = this.context.config.raw;
    const targets = this.candidates.slice(0, raw.MAX_CANDIDATE_MARKETS);
    this.candleRefreshRuns += 1;
    this.logger.debug(
      { run: this.candleRefreshRuns, targets: targets.map((c) => c.symbol), timeframes: [raw.TREND_TIMEFRAME, raw.STRUCTURE_TIMEFRAME, raw.TRIGGER_TIMEFRAME] },
      'refreshing candle history for candidates',
    );
    for (const candidate of targets) {
      const symbol = candidate.symbol;
      try {
        // `countback` is capped at 1500 by the API. Ask for a comfortable history
        // on the trend timeframe and enough bars on the others for the swings.
        await this.context.markets.fetchCandles({
          symbol,
          timeframe: raw.TREND_TIMEFRAME,
          countback: Math.min(1500, Math.max(raw.MIN_HISTORY_BARS + 50, 300)),
        });
        await this.context.markets.fetchCandles({
          symbol,
          timeframe: raw.STRUCTURE_TIMEFRAME,
          countback: 400,
        });
        await this.context.markets.fetchCandles({
          symbol,
          timeframe: raw.TRIGGER_TIMEFRAME,
          countback: 200,
        });
      } catch (error) {
        this.logger.warn(
          { symbol, err: error instanceof Error ? error.message : String(error) },
          'candle refresh failed for candidate',
        );
      }
    }
    this.logger.debug({ run: this.candleRefreshRuns, refreshed: targets.length }, 'candle refresh finished');
    void nowMs;
  }

  /** How many candle-refresh passes have run. Diagnostics only. */
  private candleRefreshRuns = 0;

  /* ---------------------------------------------------------------- *
   * Candidate selection
   * ---------------------------------------------------------------- */

  /**
   * Rank markets by liquidity and refresh the candidate pool.
   *
   * Ranking is refreshed on a slow cadence and the ACTIVE market is sticky for a
   * cooldown, because the brief requires that markets not be churned. All
   * hard numbers come from market metadata and live book depth — the market list
   * itself is always fetched, never hardcoded.
   */
  async rerankCandidates(nowMs: number): Promise<void> {
    const raw = this.context.config.raw;
    const marketsSnapshot = this.context.markets.getMarkets();
    if (!marketsSnapshot.fresh) {
      this.logger.warn(
        { reason: marketsSnapshot.reason },
        'market metadata is stale; candidate pool left unchanged',
      );
      return;
    }

    const scored: MarketCandidate[] = [];
    /**
     * Candidate markets that passed the cheap gates, in metadata order, before
     * ranking. The orderbook fetch is the expensive step and is only performed for
     * these, bounded by `MAX_ORDERBOOK_FETCHES`, so read cost stays flat as the
     * market list grows.
     */
    const depthEvaluated: MarketInfo[] = [];
    let orderbookFetches = 0;

    for (const market of marketsSnapshot.value) {
      if (market.status !== 'ONLINE') continue;
      const isRwa = isRwaCategory(market.category);
      if (isRwa && !raw.PREFER_RWA && !raw.ALLOW_CRYPTO) continue;
      if (!isRwa && !raw.ALLOW_CRYPTO) continue;
      if (isRwa && market.isOutsideRth && !raw.ALLOW_RWA_OFF_HOURS) continue;

      // Volume gate: the effective floor is the STRICTER of the two configured
      // thresholds, so raising either one tightens the candidate pool. They are kept
      // separate because `MIN_24H_NOTIONAL_USD` describes the tradable universe while
      // `MIN_RECENT_VOLUME_USD` describes what is worth ranking.
      const volume24h = market.volume24hNotional ? dec(market.volume24hNotional) : dec('0');
      const volumeFloor = Decimal.max(dec(raw.MIN_24H_NOTIONAL_USD), dec(raw.MIN_RECENT_VOLUME_USD));
      if (volume24h.lessThan(volumeFloor)) continue;

      const quote = this.context.markets.getQuote(market.marketId);
      const spread = quote?.spreadBps;
      if (!quote || spread === undefined) continue; // no quote means no spread measurement

      /**
       * Depth requires an orderbook, and an absent orderbook is NOT zero depth —
       * treating it as zero silently excluded every market and left the pool empty
       * forever. So the book is fetched here, on demand, for markets that already
       * cleared the cheap gates.
       */
      let book = this.context.markets.getOrderbook(market.marketId);
      if (!book.value && orderbookFetches < this.context.config.raw.MAX_ORDERBOOK_FETCHES) {
        orderbookFetches += 1;
        const fetched = await this.context.markets.refreshOrderbook(
          market.marketId,
          market.marketDisplayName,
          20,
        );
        if (fetched) book = this.context.markets.getOrderbook(market.marketId);
      }
      if (!book.value) continue;
      depthEvaluated.push(market);

      const depth = this.context.markets.depthUsdWithinBand(book.value, 25);
      const depthUsd = Decimal.min(depth.bidUsd, depth.askUsd);

      // Hard gates: depth and spread. A market that fails either is not a
      // candidate at all, regardless of how attractive its score would be.
      const depthFloor = isRwa && market.isOutsideRth
        ? dec(raw.MIN_ORDERBOOK_DEPTH_USD).times(dec(raw.OFF_HOURS_DEPTH_MULTIPLIER))
        : dec(raw.MIN_ORDERBOOK_DEPTH_USD);
      if (depthUsd.lessThan(depthFloor)) continue;
      if (spread) {
        const spreadCeiling =
          isRwa && market.isOutsideRth
            ? dec(raw.MAX_SPREAD_BPS).times(dec(raw.OFF_HOURS_SPREAD_MULTIPLIER))
            : dec(raw.MAX_SPREAD_BPS);
        if (spread.greaterThan(spreadCeiling)) continue;
      } else {
        continue; // no usable quote means no spread measurement
      }

      // Component scores, each normalised to [0,1] and documented.
      const spreadScore = clamp01(dec('1').minus(spread.div(dec(raw.MAX_SPREAD_BPS))));
      // Depth/volume saturate at `floor * multiple`, so a market far above the floor
      // scores the same as one just above it — the score ranks sufficiency, not size.
      const depthScore = clamp01(depthUsd.div(depthFloor.times(dec(raw.DEPTH_SCORE_SATURATION_MULTIPLE))));
      const volumeScore = clamp01(
        volume24h.div(dec(raw.MIN_24H_NOTIONAL_USD).times(dec(raw.VOLUME_SCORE_SATURATION_MULTIPLE))),
      );
      const freshnessScore = quote.fresh && book.fresh ? dec('1') : dec('0');
      const fillQualityScore =
        quote.spreadBps !== undefined && quote.spreadBps.lessThan(dec(raw.MAX_SPREAD_BPS).div(2))
          ? dec('1')
          : dec(raw.SCORE_FILL_QUALITY_PARTIAL);

      // Weights are normalised by their sum, so operators can adjust their RELATIVE
      // size without having to keep the five values summing to exactly 1.
      const weightTotal = dec(raw.SCORE_WEIGHT_SPREAD)
        .plus(dec(raw.SCORE_WEIGHT_DEPTH))
        .plus(dec(raw.SCORE_WEIGHT_VOLUME))
        .plus(dec(raw.SCORE_WEIGHT_FRESHNESS))
        .plus(dec(raw.SCORE_WEIGHT_FILL_QUALITY));
      const score = spreadScore
        .times(dec(raw.SCORE_WEIGHT_SPREAD))
        .plus(depthScore.times(dec(raw.SCORE_WEIGHT_DEPTH)))
        .plus(volumeScore.times(dec(raw.SCORE_WEIGHT_VOLUME)))
        .plus(freshnessScore.times(dec(raw.SCORE_WEIGHT_FRESHNESS)))
        .plus(fillQualityScore.times(dec(raw.SCORE_WEIGHT_FILL_QUALITY)))
        .div(weightTotal);

      scored.push({
        market,
        symbol: market.marketDisplayName,
        score,
        spreadBps: spread,
        depthUsd,
        isRwa,
        isOutsideRth: market.isOutsideRth,
        components: {
          spreadScore: toFixedString(spreadScore),
          topBookDepthScore: toFixedString(depthScore),
          recentVolumeScore: toFixedString(volumeScore),
          freshnessScore: toFixedString(freshnessScore),
          fillQualityScore: toFixedString(fillQualityScore),
        },
      });
    }

    scored.sort((a, b) => b.score.comparedTo(a.score));
    this.candidates = scored.slice(0, raw.MAX_CANDIDATE_MARKETS);

    // Active-market stickiness: only switch when the current active market is no
    // longer a candidate AND the cooldown has elapsed.
    const activeStillCandidate = this.candidates.some((c) => c.market.marketId === this.activeMarketId);
    const cooldownElapsed = nowMs - this.lastActiveMarketSwitchMs >= raw.MARKET_SWITCH_COOLDOWN_MS;
    if (!activeStillCandidate || this.activeMarketId === undefined) {
      if (cooldownElapsed && this.candidates[0]) {
        if (this.activeMarketId !== this.candidates[0].market.marketId) {
          this.logger.info(
            {
              from: this.activeMarketId,
              to: this.candidates[0].market.marketId,
              symbol: this.candidates[0].symbol,
              score: toFixedString(this.candidates[0].score),
            },
            'active market changed',
          );
        }
        this.activeMarketId = this.candidates[0].market.marketId;
        this.lastActiveMarketSwitchMs = nowMs;
      }
    }

    this.logger.info(
      {
        candidates: this.candidates.map((c) => ({
          symbol: c.symbol,
          score: toFixedString(c.score),
          spreadBps: c.spreadBps ? toFixedString(c.spreadBps) : null,
          depthUsd: toFixedString(c.depthUsd),
          category: c.market.category,
          offHours: c.isOutsideRth,
        })),
        activeMarketId: this.activeMarketId,
      },
      'candidate pool refreshed',
    );
  }

  /* ---------------------------------------------------------------- *
   * Reconciliation & circuit breakers
   * ---------------------------------------------------------------- */

  private async reconcileNow(): Promise<void> {
    const address = this.context.config.raw.ARCUS_WALLET_ADDRESS;
    if (!address) {
      this.reconciliationOk = false;
      this.reconciliationReason = 'no wallet address configured';
      return;
    }
    const accountIndex = this.context.config.raw.ARCUS_ACCOUNT_INDEX;
    let venueOrders: readonly Order[];
    try {
      venueOrders = await this.context.rest.getOpenOrders({ address, accountIndex });
    } catch (error) {
      this.reconciliationOk = false;
      this.reconciliationReason = `openOrders read failed: ${error instanceof Error ? error.message : String(error)}`;
      return;
    }
    const result = this.context.reconciler.reconcile({
      venuePositions: this.context.markets.getPositions()?.value ?? [],
      venueOrders,
      localOrders: this.context.orderStateMachine.liveOrders(),
      localPurposeByKey: new Map(
        this.context.orderStateMachine.all().map((o) => [o.key, o.purpose] as const),
      ),
    });
    this.reconciliationOk = result.reconciled;
    this.reconciliationReason = result.reason;
    if (result.reconciled) {
      // Reconcile venue orders into the local machine so protective orders placed
      // by a previous process are recognised.
      for (const order of venueOrders) this.context.orderStateMachine.applyVenueOrder(order);
    } else {
      this.strategyState = `blocked: reconciliation failed (${result.blockingCount} discrepancies)`;
    }
  }

  /** Daily loss and consecutive-loss breakers, checked every tick. */
  private updateCircuitBreakers(): void {
    const account = this.context.markets.getAccount();
    const equity = account?.value ? dec(account.value.equity) : undefined;
    if (!equity || !equity.greaterThan(0)) return;

    const realizedToday = this.context.store.realizedTradingPnlForDay(dayKey(Date.now()));
    const breaker = this.context.riskEngine.checkDailyLossBreaker({
      accountEquity: equity,
      realizedPnlToday: realizedToday,
    });
    if (breaker.tripped) {
      this.context.killSwitch.engageAutomatic(
        `daily loss limit reached: realized ${toFixedString(breaker.observed)} vs limit -${toFixedString(breaker.limit)}`,
      );

      /**
       * Persist the halt ONLY when this process could actually have opened an order.
       *
       * The sentinel file outlives the process and blocks the NEXT start, which is
       * correct for a live bot. It is wrong for a dry-run: a read-only `dry-run`
       * inspecting an account that happens to have realised losses today would write a
       * kill-switch file and leave the next live start halted for a decision this
       * process never made.
       *
       * Note that the breaker counts EVERY fill on the account, including the operator's
       * own manual trading. Sharing a subaccount with manual trades therefore shares the
       * loss budget — use a dedicated subaccount for the bot if that is not wanted.
       */
      if (this.context.orderSubmissionAllowed) {
        this.context.killSwitch.writeStopFile(
          `daily loss limit reached: realized ${toFixedString(breaker.observed)}`,
        );
      } else {
        this.logger.warn(
          {
            observed: toFixedString(breaker.observed),
            limit: toFixedString(breaker.limit),
            submissionAllowed: false,
          },
          'daily loss limit reached in a no-order mode: latching in-process only, no sentinel written',
        );
      }

      void this.context.alertRouter.alert({
        severity: 'critical',
        title: 'ArcusTrader: daily loss limit reached',
        body:
          `Realized trading PnL for ${dayKey(Date.now())} is ${toFixedString(breaker.observed)}, ` +
          `at or beyond the limit of -${toFixedString(breaker.limit)}. New entries are halted.`,
        key: `daily-loss-${dayKey(Date.now())}`,
      });
    }

    const consecutiveLosses = this.context.store.consecutiveLosses();
    if (consecutiveLosses >= this.context.config.raw.MAX_CONSECUTIVE_LOSSES) {
      this.context.killSwitch.engageAutomatic(
        `consecutive losses ${consecutiveLosses} reached the limit of ${this.context.config.raw.MAX_CONSECUTIVE_LOSSES}`,
      );
    }
  }

  /* ---------------------------------------------------------------- *
   * The entry gate — the brief's fail-closed list, in one place
   * ---------------------------------------------------------------- */

  /**
   * Conditions under which NO new position may be opened.
   *
   * Mapped one-to-one against the brief:
   *   - WebSocket 断开                      → websocket not ready
   *   - 数据超过 MAX_DATA_AGE_MS            → account/positions/quote freshness
   *   - account 查询失败                    → account never read / read failed
   *   - positions 与本地不一致              → reconciliation
   *   - openOrders 与本地不一致             → reconciliation
   *   - 止损订单缺失                        → reconciliation (missing_protective_stop)
   *   - 触发日亏损限制                      → kill switch / daily breaker
   *   - 连续亏损达到上限                    → kill switch
   *   - 账户权益不足                        → RiskEngine (also pre-checked here)
   *   - RWA off-hours 且未开启              → per-market tradability + here
   *   - rate-limit pool 接近耗尽            → pool guard
   *   - market metadata 过期                → metadata freshness
   *   - API 签名失败                        → no signer / submission disallowed
   */
  deriveEntryGate(): EntryGate {
    const blocked: string[] = [];
    const raw = this.context.config.raw;
    const account = this.context.markets.getAccount();
    const positions = this.context.markets.getPositions();
    const metadata = this.context.markets.getMarkets();

    /* kill switch */
    const kill = this.context.killSwitch.decide();
    if (!kill.allowNewPositions) {
      blocked.push(`kill switch engaged: ${kill.status.reason ?? 'reason not recorded'}`);
    }

    /* websocket */
    const wsStats = this.context.ws.stats;
    if (!this.context.ws.isConnected) {
      blocked.push(`websocket is ${wsStats.state}`);
    } else if (!this.context.ws.isReady) {
      blocked.push(
        `websocket has not delivered all snapshots (${wsStats.readySubscriptions}/${wsStats.desiredSubscriptions})`,
      );
    }

    /* reconciliation */
    if (!this.reconciliationOk) {
      blocked.push(`reconciliation failed: ${this.reconciliationReason ?? 'unknown'}`);
    }

    /* account freshness */
    if (!account) {
      blocked.push('account has never been read');
    } else if (!account.fresh) {
      blocked.push(`account data stale: ${account.reason ?? 'unknown'}`);
    }

    /* positions freshness */
    if (!positions) {
      blocked.push('positions have never been read');
    } else if (!positions.fresh) {
      blocked.push(`positions stale: ${positions.reason ?? 'unknown'}`);
    }

    /* market metadata freshness */
    if (!metadata.fresh) {
      blocked.push(`market metadata stale: ${metadata.reason ?? 'unknown'}`);
    }

    /* equity */
    if (account?.value && !dec(account.value.equity).greaterThan(0)) {
      blocked.push(`account equity is not positive (${account.value.equity})`);
    }

    /* rate-limit pool */
    const pool = this.context.poolGuard.canSubmitOrder();
    if (!pool.allowed) blocked.push(`order pool unavailable: ${pool.reason ?? 'unknown'}`);

    /* signature authority */
    if (!this.context.orderSubmissionAllowed) {
      blocked.push('order submission is disabled by configuration (dry-run or unconfirmed live)');
    }
    if (this.context.orderSubmissionAllowed && !this.context.rest.canSign) {
      blocked.push('order submission is enabled but no signing key is configured');
    }

    /* recalibration */
    if (this.recalibrating) {
      blocked.push(`recalibrating: ${this.recalibrationReason ?? 'recent large equity change'}`);
    }

    /* candidate pool */
    if (this.candidates.length === 0) {
      blocked.push('no market passed the liquidity and spread filters');
    }

    /* every candidate off-hours while off-hours entries are disabled */
    if (
      this.candidates.length > 0 &&
      !raw.ALLOW_RWA_OFF_HOURS &&
      this.candidates.every((c) => c.isOutsideRth)
    ) {
      blocked.push('every candidate market is outside regular trading hours');
    }

    return { allowed: blocked.length === 0, blocked };
  }

  /* ---------------------------------------------------------------- *
   * Position management (runs BEFORE new entries)
   * ---------------------------------------------------------------- */

  /**
   * Ensure every open position has a live protective stop, and manage exits.
   *
   * This is the highest-priority work in the loop. A position discovered without a
   * confirmed stop is flagged, alerted, and — where submission is allowed —
   * immediately given one. Exposure is never increased until that succeeds.
   */
  private async managePositions(nowMs: number): Promise<void> {
    const positions = this.context.markets.getPositions()?.value ?? [];
    const raw = this.context.config.raw;
    // A FLAT row (size "0") is not an open position; the venue emits one on close.
    const live = positions.filter((p) => !dec(p.size).isZero());

    // Release plans for markets whose position has closed, so a later re-entry starts
    // from a clean baseline rather than inheriting a stale TP1 threshold.
    const openMarketIds = new Set(live.map((p) => p.marketId));
    for (const tracked of this.context.positionManager.planSnapshot) {
      if (!openMarketIds.has(tracked.marketId)) {
        this.context.positionManager.releasePlan(tracked.marketId);
      }
    }

    if (live.length === 0) {
      this.strategyState = this.strategyState.startsWith('blocked') ? this.strategyState : 'flat';
      return;
    }

    const kill = this.context.killSwitch.status;
    // A position whose stop was never confirmed is an emergency, not merely a
    // warning: it is the one case where flattening beats waiting.
    for (const position of live) {
      const market = this.context.markets.getMarketById(position.marketId);
      if (!market) {
        this.anomalies.push(
          `open position in market ${position.marketId} has no metadata; it cannot be managed`,
        );
        continue;
      }

      const protective = this.context.orderStateMachine.protectiveOrders(position.marketId);
      const liveStop = protective.find((o) => o.purpose === 'stop');

      /* ---- register / refresh the exit plan ---- */
      this.context.positionManager.registerPlan({
        market,
        position,
        ...(liveStop?.triggerPrice ? { stopTriggerPrice: dec(liveStop.triggerPrice) } : {}),
        tp1RMultiple: dec(raw.TP1_R_MULTIPLE),
        tp2RMultiple: dec(raw.TP2_R_MULTIPLE),
      });

      /* ---- decide whether this is an emergency ---- */
      let emergency: { reason: string } | undefined;
      if (!liveStop && !this.context.executor.isMarketProtected(market.marketId)) {
        // Previously flagged unprotected and still no stop at the venue.
        emergency = { reason: 'protective stop is absent and the position was flagged unprotected' };
      } else if (kill.engaged && kill.source === 'automatic' && this.reconciliationFailureIsFatal()) {
        emergency = { reason: `reconciliation failed while the kill switch is engaged (${kill.reason ?? 'no reason'})` };
      }

      // No stop yet at all: establish one before any other exit work. This is the
      // brief's "止损未确认，禁止继续扩大仓位" made concrete — the missing stop is the
      // first problem solved, not the last.
      if (!liveStop && !emergency) {
        const stopPrice = await this.deriveFallbackStop(market, position);
        if (!stopPrice) {
          this.context.executor.markUnprotected(market.marketId);
          this.anomalies.push(
            `position in ${market.marketDisplayName} has no stop and no ATR is available to place one`,
          );
          continue;
        }
        this.logger.error(
          {
            marketId: market.marketId,
            symbol: market.marketDisplayName,
            size: position.size,
            stopPrice: toFixedString(stopPrice),
          },
          'OPEN POSITION WITHOUT A CONFIRMED STOP — placing a reconstructed stop now',
        );
        void this.context.alertRouter.alert({
          severity: 'critical',
          title: 'ArcusTrader: unprotected position',
          body:
            `Position in ${market.marketDisplayName} (size ${position.size}) had no confirmed stop. ` +
            `Placing a reconstructed stop at ${toFixedString(stopPrice)}. No further exposure will be added ` +
            'until it is confirmed.',
          key: `unprotected-${market.marketId}`,
        });
        const result = await this.context.executor.placeProtectiveStop({
          market,
          direction: position.side === 'LONG' ? 'long' : 'short',
          quantity: dec(position.size).abs(),
          stopPrice,
          allowSubmission: this.context.orderSubmissionAllowed,
        });
        if (!result.protected) {
          this.anomalies.push(
            `failed to place a protective stop for ${market.marketDisplayName}: ${result.reason ?? 'unknown'}`,
          );
        }
        // Re-register so the plan learns the stop it now has.
        this.context.positionManager.registerPlan({
          market,
          position,
          stopTriggerPrice: stopPrice,
          tp1RMultiple: dec(raw.TP1_R_MULTIPLE),
          tp2RMultiple: dec(raw.TP2_R_MULTIPLE),
        });
        continue; // do not stack exit actions in the same tick
      }

      /* ---- full exit management ---- */
      const outcome = await this.context.positionManager.manage({
        market,
        position,
        allowSubmission: this.context.orderSubmissionAllowed,
        ...(emergency ? { emergency } : {}),
      });
      if (outcome.submitted || outcome.action === 'blocked') {
        this.logger.info(
          {
            marketId: outcome.marketId,
            symbol: outcome.symbol,
            action: outcome.action,
            reason: outcome.reason,
            detail: outcome.detail,
          },
          'position management action',
        );
      }
      if (outcome.action === 'emergency_exit') {
        this.anomalies.push(`emergency exit submitted for ${outcome.symbol}: ${emergency?.reason ?? 'unspecified'}`);
        void this.context.alertRouter.alert({
          severity: 'critical',
          title: `ArcusTrader: emergency exit ${outcome.symbol}`,
          body: `Flattened ${outcome.symbol} with a reduce-only IOC order. Reason: ${emergency?.reason ?? 'unspecified'}.`,
          key: `emergency-${outcome.marketId}`,
        });
      }
    }

    this.strategyState = `managing ${live.length} position(s)`;
    void nowMs;
  }

  /**
   * Whether a reconciliation failure should escalate to flattening.
   *
   * Deliberately narrow. Reconciliation drift blocks NEW entries, which is the
   * documented requirement. Flattening on drift alone would turn a bookkeeping
   * discrepancy into a realised loss — the opposite of failing safe. It escalates only
   * when the drift is combined with an automatic kill-switch trip, i.e. when the
   * system has already decided it does not trust its own view AND trading is halted.
   */
  private reconciliationFailureIsFatal(): boolean {
    const last = this.context.reconciler.lastReconciliation;
    if (!last || last.reconciled) return false;
    return last.discrepancies.some(
      (d) => d.blocking && (d.kind === 'missing_protective_stop' || d.kind === 'position_size_mismatch'),
    );
  }

  /**
   * ATR-based fallback stop when the original structural stop is unknown.
   *
   * Uses the structure timeframe ATR and a 1.5x multiple, which is wider than the
   * strategy's own buffer: without the structure to anchor to, a wider stop is the
   * safer error, since a stop that is too tight converts noise into a loss.
   */
  private async deriveFallbackStop(market: MarketInfo, position: Position): Promise<Decimal | undefined> {
    const bars = this.context.markets.getCandlesClosed(
      market.marketDisplayName,
      this.context.config.raw.STRUCTURE_TIMEFRAME,
    );
    if (bars.length < 20) return undefined;
    const { atr } = await import('../strategy/StrategyIndicators');
    const series = atr(bars, this.context.config.raw.ATR_PERIOD);
    const last = [...series].reverse().find((v) => v !== null && v !== undefined);
    if (!last || !last.greaterThan(0)) return undefined;
    const mark = dec(position.markPx);
    const buffer = last.times('1.5');
    // For a long the stop sits below the mark; for a short, above.
    const stop = position.side === 'LONG' ? mark.minus(buffer) : mark.plus(buffer);
    return stop.greaterThan(0) ? stop : undefined;
  }

  /* ---------------------------------------------------------------- *
   * New entries
   * ---------------------------------------------------------------- */

  private async evaluateForEntry(): Promise<void> {
    const raw = this.context.config.raw;
    const target = this.candidates[0];
    if (!target) return;

    const market = target.market;
    const tradability = this.context.markets.isTradable(market.marketId, {
      allowOffHours: raw.ALLOW_RWA_OFF_HOURS,
    });
    if (!tradable(tradability)) {
      this.strategyState = `candidate ${target.symbol} not tradable: ${tradability.reasons[0] ?? 'unknown'}`;
      return;
    }

    const trendCandles = this.context.markets.getCandlesClosed(target.symbol, raw.TREND_TIMEFRAME);
    const structureCandles = this.context.markets.getCandlesClosed(target.symbol, raw.STRUCTURE_TIMEFRAME);
    const triggerCandles = this.context.markets.getCandlesClosed(target.symbol, raw.TRIGGER_TIMEFRAME);
    if (trendCandles.length === 0 || structureCandles.length === 0 || triggerCandles.length === 0) {
      this.strategyState = `candidate ${target.symbol} has incomplete candle history`;
      return;
    }

    const quote = this.context.markets.getQuote(market.marketId);
    if (!quote || !quote.fresh) {
      this.strategyState = `candidate ${target.symbol} has no fresh quote`;
      return;
    }

    const book = this.context.markets.getOrderbook(market.marketId);
    const depth = book.value ? this.context.markets.depthUsdWithinBand(book.value, 25) : undefined;

    const outcome: DecisionOutcome = await this.context.decisionPipeline.decide({
      snapshot: {
        market,
        trendCandles,
        structureCandles,
        triggerCandles,
        bid: quote.bid,
        ask: quote.ask,
        quoteAgeMs: quote.ageMs,
        ...(depth ? { bidDepthUsd: depth.bidUsd, askDepthUsd: depth.askUsd } : {}),
        ...(market.fundingRate ? { fundingRate: dec(market.fundingRate) } : {}),
        ...(market.nextFundingAt
          ? {
              hoursToNextFunding: new Decimal(
                Math.max(0, market.nextFundingAt * 1000 - Date.now()) / 3_600_000,
              ),
            }
          : {}),
        expectedHoldHours: dec(raw.EXPECTED_HOLD_HOURS),
      },
      buildRiskState: (proposal) => this.buildRiskState(proposal, market),
    });

    switch (outcome.kind) {
      case 'no_signal':
        this.strategyState = `flat — ${outcome.signal.flatReason ?? 'no setup'}`;
        return;
      case 'rejected':
        this.strategyState = `flat — rejected at ${outcome.stage}: ${outcome.reasons[0] ?? 'unknown'}`;
        this.logger.info(
          { symbol: outcome.symbol, stage: outcome.stage, reasons: outcome.reasons.slice(0, 3) },
          'setup rejected',
        );
        return;
      case 'approved':
        await this.submitApprovedEntry(outcome, market);
        return;
    }
  }

  private async submitApprovedEntry(
    outcome: Extract<DecisionOutcome, { kind: 'approved' }>,
    market: MarketInfo,
  ): Promise<void> {
    this.strategyState = `entering ${outcome.symbol} ${outcome.proposal.direction}`;
    const result = await this.context.executor.submitEntry({
      market,
      proposal: outcome.proposal,
      quantity: outcome.quantity,
      allowSubmission: this.context.orderSubmissionAllowed,
    });
    if (result.ok) {
      // Retain the proposal so the fill path uses these exact levels.
      this.pendingProposals.set(result.localKey, {
        proposal: outcome.proposal,
        quantity: outcome.quantity,
      });
      this.logger.info(
        {
          symbol: outcome.symbol,
          direction: outcome.proposal.direction,
          quantity: toFixedString(outcome.quantity),
          entry: toFixedString(outcome.proposal.entryPrice),
          stop: toFixedString(outcome.proposal.stopPrice),
          tp1: toFixedString(outcome.proposal.target1),
          clientId: result.localKey,
        },
        'entry order working',
      );
      void this.context.alertRouter.alert({
        severity: 'info',
        title: `ArcusTrader: entry placed ${outcome.symbol}`,
        body:
          `${outcome.proposal.direction.toUpperCase()} ${outcome.symbol} ${toFixedString(outcome.quantity)} @ ` +
          `${toFixedString(outcome.proposal.entryPrice)} (ALO). Stop ${toFixedString(outcome.proposal.stopPrice)}, ` +
          `TP1 ${toFixedString(outcome.proposal.target1)}.`,
        key: `entry-${result.localKey}`,
      });
    } else {
      this.strategyState = `entry rejected: ${result.reason}`;
      this.logger.warn({ symbol: outcome.symbol, reason: result.reason }, 'entry submission failed');
    }
  }

  /**
   * Assemble the RiskEngine state.
   *
   * Every freshness field comes from the provider, so the engine sees exactly the
   * age of the data a human would. Nothing here is defaulted to "fresh".
   */
  private buildRiskState(_proposal: TradeProposal, market: MarketInfo): RiskEngineState {
    const raw = this.context.config.raw;
    const account = this.context.markets.getAccount();
    const positions = this.context.markets.getPositions();
    const metadata = this.context.markets.getMarkets();
    const quote = this.context.markets.getQuote(market.marketId);
    const pool = this.context.poolGuard.canSubmitOrder();

    const openPositions = positions?.value ?? [];
    const usedMargin = openPositions.reduce((acc, p) => acc.plus(dec(p.marginUsed)), dec('0'));
    const unrealized = openPositions.reduce((acc, p) => acc.plus(dec(p.unrealizedPnl)), dec('0'));

    // Effective leverage for this market: the position's own setting when one
    // exists, otherwise the configured cap. Per-market overrides live on the
    // position row, not in a separate call, so no extra request is needed.
    const positionHere = openPositions.find((p) => p.marketId === market.marketId);
    const effectiveLeverage = positionHere ? dec(positionHere.leverage) : dec(raw.MAX_LEVERAGE);

    return {
      accountEquity: account?.value ? dec(account.value.equity) : dec('0'),
      freeCollateral: account?.value ? dec(account.value.freeCollateral) : dec('0'),
      usedMargin,
      unrealizedPnl: unrealized,
      openPositions,
      workingEntryOrders: this.context.orderStateMachine.workingEntryOrders().map((o) => ({
        marketId: o.marketId,
        orderId: o.orderId ?? o.key,
        ...(o.clientId !== undefined ? { clientId: o.clientId } : {}),
      })),
      // Realized TRADING PnL only: deposits and withdrawals live in a separate
      // ledger and therefore cannot reset this.
      realizedPnlToday: this.context.store.realizedTradingPnlForDay(dayKey(Date.now())),
      consecutiveLosses: this.context.store.consecutiveLosses(),
      recalibrating: this.recalibrating,
      ...(this.recalibrationReason !== undefined ? { recalibrationReason: this.recalibrationReason } : {}),
      accountFresh: account
        ? { value: account.value, ageMs: account.ageMs, maxAgeMs: account.maxAgeMs, fresh: account.fresh, ...(account.reason ? { reason: account.reason } : {}) }
        : undefined,
      positionsFresh: positions
        ? { value: positions.value, ageMs: positions.ageMs, maxAgeMs: positions.maxAgeMs, fresh: positions.fresh, ...(positions.reason ? { reason: positions.reason } : {}) }
        : undefined,
      metadataFresh: {
        value: metadata.value,
        ageMs: metadata.ageMs,
        maxAgeMs: metadata.maxAgeMs,
        fresh: metadata.fresh,
        ...(metadata.reason ? { reason: metadata.reason } : {}),
      },
      marketMaxOrderSize: market.maxOrderSize ? dec(market.maxOrderSize) : undefined,
      quoteFresh: quote?.fresh ?? false,
      ...(quote?.reason !== undefined ? { quoteReason: quote.reason } : {}),
      // null (unknown session) counts as off-hours for entry purposes: fail closed.
      isOutsideRth: market.isOutsideRth !== false,
      allowOffHours: raw.ALLOW_RWA_OFF_HOURS,
      websocketReady: this.context.ws.isReady,
      ...(this.context.ws.isConnected ? {} : { websocketReason: `state=${this.context.ws.connectionState}` }),
      reconciled: this.reconciliationOk,
      ...(this.reconciliationReason !== undefined ? { reconciliationReason: this.reconciliationReason } : {}),
      killSwitchEngaged: this.context.killSwitch.engaged,
      ...(this.context.killSwitch.status.reason !== undefined
        ? { killSwitchReason: this.context.killSwitch.status.reason }
        : {}),
      orderPoolAllowed: pool.allowed,
      ...(pool.reason !== undefined ? { orderPoolReason: pool.reason } : {}),
      market,
      effectiveLeverage,
    };
  }

  /* ---------------------------------------------------------------- *
   * Entry-order expiry
   * ---------------------------------------------------------------- */

  private async expireEntryOrders(nowMs: number): Promise<void> {
    const raw = this.context.config.raw;
    const barsMs = timeframeToMs(raw.TRIGGER_TIMEFRAME);
    const ttlMs = barsMs * raw.ENTRY_ORDER_TTL_BARS;
    for (const order of this.context.orderStateMachine.workingEntryOrders()) {
      if (!isEntryOrderExpired(order, nowMs, ttlMs)) continue;
      const market = this.context.markets.getMarketById(order.marketId);
      if (!market) continue;
      this.logger.info(
        { clientId: order.clientId, ageMs: nowMs - order.createdAtMs, ttlMs },
        'entry order exceeded its TTL; cancelling',
      );
      await this.context.executor.cancelOrder({
        market,
        localKey: order.key,
        allowSubmission: this.context.orderSubmissionAllowed,
        reason: 'entry TTL expired',
      });
    }
  }

  /* ---------------------------------------------------------------- *
   * WebSocket frame handling
   * ---------------------------------------------------------------- */

  private handleFrame(frame: { channel?: string; contents?: unknown }): void {
    try {
      switch (frame.channel) {
        case 'userFills': {
          const fills = extractArray(frame.contents, 'fills') as Fill[];
          for (const fill of fills) {
            const isNew = this.context.store.recordFill(fill);
            if (isNew) {
              this.logger.info(
                {
                  tradeId: fill.tradeId,
                  symbol: fill.marketDisplayName,
                  role: fill.role,
                  size: fill.size,
                  price: fill.price,
                  fee: fill.fee,
                  closedPnl: fill.closedPnl,
                },
                'fill ingested',
              );
            }
          }
          break;
        }
        case 'orders': {
          const orders = extractArray(frame.contents, 'orders') as Order[];
          for (const order of orders) {
            const transition = this.context.orderStateMachine.applyVenueOrder(order);
            if (transition) {
              this.logger.info(
                {
                  orderId: order.orderId,
                  clientId: order.clientId,
                  from: transition.from,
                  to: transition.to,
                  venueStatus: transition.venueStatus,
                  rejectionReason: order.rejectionReason,
                },
                'order state transition',
              );
            }
            // A just-filled ENTRY is the moment to attach protection. The
            // executor refuses to add exposure until this succeeds.
            if (transition?.to === 'FILLED' && order.clientId?.includes('en')) {
              void this.protectAfterFill(order);
            }
          }
          break;
        }
        case 'accountTransferUpdates': {
          const transfers = extractArray(frame.contents, 'transfers') as CashFlowFrame[];
          for (const transfer of transfers) {
            const isNew = this.context.store.recordCashFlow({
              id: `${transfer.type}|${transfer.accountIndex}|${transfer.time}|${transfer.txHash ?? transfer.amount}`,
              type: transfer.type,
              amount: transfer.amount,
              accountIndex: transfer.accountIndex,
              occurredAtMs: Math.round(transfer.time / 1000),
              recordedAtMs: Date.now(),
            });
            if (isNew && (transfer.type === 'DEPOSIT' || transfer.type === 'WITHDRAWAL')) {
              this.logger.warn(
                { type: transfer.type, amount: transfer.amount },
                'cash flow observed; daily loss accounting is unaffected by design',
              );
            }
          }
          break;
        }
        case 'positions': {
          // Positions are refreshed by REST every tick, immediately before the entry
          // gate, so a stream frame needs no special handling here. Acting on the raw
          // frame would bypass the freshness verdict the gate relies on.
          break;
        }
        default:
          break;
      }
    } catch (error) {
      this.anomalies.push(
        `frame handling failed for channel ${frame.channel ?? 'unknown'}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Bring a just-filled entry under full exit management.
   *
   * Placing the stop is the first action, because it is the only thing standing between
   * an open position and an unbounded loss. Take-profits and trailing follow from the
   * normal management pass, which now has a registered plan carrying the ORIGINAL
   * proposal's levels.
   */
  private async protectAfterFill(order: Order): Promise<void> {
    const market = this.context.markets.getMarketById(order.marketId);
    if (!market) return;
    const clientId = order.clientId;
    const pending = clientId ? this.pendingProposals.get(clientId) : undefined;
    const filled = dec(order.filledSize ?? order.originalSize);
    const direction: 'long' | 'short' = order.side === 'BUY' ? 'long' : 'short';

    // The stop level: the proposal's own structural stop when we still hold it, else a
    // reconstructed ATR-based stop. Which one was used is logged, because a
    // reconstructed stop is a materially weaker control and the operator should see it.
    const stopPrice = pending?.proposal.stopPrice ?? (await this.deriveFallbackStop(market, {
      address: order.address ?? '',
      accountIndex: order.accountIndex ?? 0,
      marketId: order.marketId,
      marketDisplayName: order.marketDisplayName,
      side: order.side === 'BUY' ? 'LONG' : 'SHORT',
      size: order.side === 'BUY' ? order.originalSize : `-${order.originalSize}`,
      averageEntryPrice: order.avgFillPrice ?? order.price,
      leverage: '0',
      marginMode: 'ISOLATED',
      borrowedCapital: '0',
      marginUsed: '0',
      positionValueNotional: '0',
      unrealizedPnl: '0',
      markPx: order.avgFillPrice ?? order.price,
    }));

    if (!stopPrice) {
      this.context.executor.markUnprotected(market.marketId);
      this.anomalies.push(
        `entry ${order.orderId} filled but no stop price could be derived for ${market.marketDisplayName}`,
      );
      return;
    }

    const result = await this.context.executor.placeProtectiveStop({
      market,
      direction,
      quantity: filled,
      stopPrice,
      allowSubmission: this.context.orderSubmissionAllowed,
    });
    if (result.protected) {
      this.logger.info(
        {
          orderId: order.orderId,
          marketId: market.marketId,
          stopPrice: toFixedString(stopPrice),
          levelSource: pending ? 'original proposal' : 'reconstructed from ATR',
        },
        'position protected after fill',
      );
    } else {
      this.anomalies.push(
        `failed to protect ${market.marketDisplayName} after fill: ${result.reason ?? 'unknown'}`,
      );
    }

    // Register the plan so TP placement and trailing can proceed, then run one
    // management pass immediately rather than waiting for the next tick.
    const position = this.context.markets
      .getPositions()
      ?.value.find((p) => p.marketId === market.marketId);
    if (position && !dec(position.size).isZero()) {
      this.context.positionManager.registerPlan({
        market,
        position,
        stopTriggerPrice: stopPrice,
        ...(pending
          ? {
              proposal: {
                entryPrice: pending.proposal.entryPrice,
                stopPrice: pending.proposal.stopPrice,
                target1: pending.proposal.target1,
                ...(pending.proposal.target2 ? { target2: pending.proposal.target2 } : {}),
              },
            }
          : {}),
        tp1RMultiple: dec(this.context.config.raw.TP1_R_MULTIPLE),
        tp2RMultiple: dec(this.context.config.raw.TP2_R_MULTIPLE),
      });
      if (clientId) this.pendingProposals.delete(clientId);
      await this.context.positionManager.manage({
        market,
        position,
        allowSubmission: this.context.orderSubmissionAllowed,
      });
    }
  }

  /* ---------------------------------------------------------------- *
   * Recalibration
   * ---------------------------------------------------------------- */

  private checkRecalibration(equity: Decimal): void {
    const raw = this.context.config.raw;
    const today = dayKey(Date.now());
    if (this.recalibrationDay !== today) {
      // A new UTC day clears recalibration; open positions and their stops were
      // never touched by it in the first place.
      this.recalibrationDay = today;
      this.recalibrating = false;
      this.recalibrationReason = undefined;
    }
    const result = this.context.riskEngine.checkEquityChange({
      previousEquity: this.previousEquity,
      currentEquity: equity,
      thresholdBps: dec(raw.EQUITY_CHANGE_PAUSE_BPS),
    });
    if (result.recalibrate && !this.recalibrating) {
      // A large equity move means deposits/withdrawals changed the risk base.
      // Pausing NEW entries while continuing to manage existing positions is the
      // required behaviour; the existing stop logic is never altered.
      this.recalibrating = true;
      this.recalibrationReason = result.reason;
      this.logger.warn(
        { changeBps: toFixedString(result.changeBps), reason: result.reason },
        'entering recalibration: new entries paused, existing positions still managed',
      );
    }
    this.previousEquity = equity;
  }

  /* ---------------------------------------------------------------- *
   * Health
   * ---------------------------------------------------------------- */

  private now(): number {
    return Date.now();
  }

  /**
   * The state the health endpoint reports.
   *
   * Credentials are reduced to presence booleans here, at the source, so no downstream
   * serialisation can leak one even by accident.
   */
  healthSnapshot(): HealthSnapshot {
    const account = this.context.markets.getAccount();
    const raw = this.context.config.raw;
    return {
      tradingMode: raw.TRADING_MODE,
      liveTrading: this.context.orderSubmissionAllowed,
      killSwitchEngaged: this.context.killSwitch.engaged,
      ...(this.context.killSwitch.status.reason
        ? { killSwitchReason: this.context.killSwitch.status.reason }
        : {}),
      reconciled: this.reconciliationOk,
      ...(this.reconciliationReason ? { reconciliationReason: this.reconciliationReason } : {}),
      websocketState: this.context.ws.stats.state,
      websocketReady: this.context.ws.isReady,
      strategyState: this.strategyState,
      ticksCompleted: this.completedTicks,
      ...(this.lastTickCompletedAtMs !== undefined ? { lastTickAtMs: this.lastTickCompletedAtMs } : {}),
      ...(account ? { dataAgeMs: account.ageMs } : {}),
      maxDataAgeMs: raw.MAX_DATA_AGE_MS,
      openPositions: this.context.markets.getPositions()?.value.filter((p) => !dec(p.size).isZero()).length ?? 0,
      liveOrders: this.context.orderStateMachine.liveOrders().length,
      unknownOrders: this.context.orderStateMachine.unknownOrders().length,
      credentialsConfigured: {
        arcusSigningKey: Boolean(this.context.config.secrets.arcusApiSigningKey),
        walletAddress: Boolean(raw.ARCUS_WALLET_ADDRESS),
        lark: Boolean(this.context.config.secrets.larkAppId && this.context.config.secrets.larkAppSecret && raw.LARK_CHAT_ID),
      },
      sqliteDriver: this.context.store.driver,
      version: '0.1.0',
    };
  }

  /* ---------------------------------------------------------------- *
   * Daily report
   * ---------------------------------------------------------------- */

  private async maybeSendDailyReport(nowMs: number): Promise<void> {
    if (!this.context.config.raw.REPORT_ENABLED) return;
    // Check at most once a minute; the send itself is idempotent.
    if (nowMs - this.lastReportCheckMs < this.context.config.raw.REPORT_CHECK_INTERVAL_MS) return;
    this.lastReportCheckMs = nowMs;

    const raw = this.context.config.raw;
    const address = raw.ARCUS_WALLET_ADDRESS;
    if (!address) return;

    const reportDate = reportDateInTimezone(nowMs, raw.REPORT_TIMEZONE);
    const idempotencyKey = reportIdempotencyKey({
      reportDate,
      wallet: address,
      accountIndex: raw.ARCUS_ACCOUNT_INDEX,
    });

    // Idempotency: the DB record is the authority, so a PM2 restart cannot resend.
    if (this.context.store.hasReportBeenSent({ reportDate, wallet: address, accountIndex: raw.ARCUS_ACCOUNT_INDEX })) {
      return;
    }

    const scheduledHour = parseCronHour(raw.REPORT_CRON);
    const localHour = hourInTimezone(nowMs, raw.REPORT_TIMEZONE);
    if (scheduledHour !== undefined && localHour < scheduledHour) return;

    const extras = await this.collectReportExtras(address);
    const input = this.buildReportInput(reportDate, nowMs, extras);
    const card = buildDailyReportCard(input);
    const result = await this.context.larkClient.sendCard(card, { uuid: idempotencyKey.slice(0, 50) });
    if (result.ok) {
      this.context.store.markReportSent({
        reportDate,
        wallet: address,
        accountIndex: raw.ARCUS_ACCOUNT_INDEX,
        messageId: result.messageId,
      });
      this.logger.info({ reportDate, messageId: result.messageId }, 'daily report sent');
    } else {
      // Fall back to text, and if that also fails the AlertRouter's outbox keeps
      // the payload for retry. A reporting failure never affects the trading loop.
      const textResult = await this.context.larkClient.sendText(renderReportText(input).slice(0, 100_000), {
        uuid: `${idempotencyKey}-text`.slice(0, 50),
      });
      if (textResult.ok) {
        this.context.store.markReportSent({
          reportDate,
          wallet: address,
          accountIndex: raw.ARCUS_ACCOUNT_INDEX,
          messageId: textResult.messageId,
        });
        this.logger.info({ reportDate }, 'daily report sent as text fallback');
      } else {
        this.logger.error({ reportDate, err: result.error.message }, 'daily report delivery failed');
      }
    }
  }

  /**
   * Read the wallet-wide figures the daily report shows beyond the active account:
   * the consolidated subaccount overview and, when a signing key is configured, the
   * affiliate/referral standing.
   *
   * Read-only and called only on the report path (once a day), never per tick: the
   * overview issues up to `ACCOUNT_OVERVIEW_MAX_INDEX + 1` account reads, which would
   * be pure waste in the decision loop.
   *
   * Failures are swallowed into `undefined` on purpose. A report must still go out if
   * the affiliate endpoint is 404/503 — losing a Trading section is much better than
   * losing the whole report.
   */
  async collectReportExtras(address: string): Promise<ReportExtras> {
    const raw = this.context.config.raw;
    let overview: AccountOverview | undefined;
    let affiliate: AffiliateInfo | undefined;

    if (raw.REPORT_INCLUDE_ACCOUNT_OVERVIEW) {
      try {
        overview = await collectAccountOverview({
          reader: this.context.rest,
          address,
          maxIndex: raw.ACCOUNT_OVERVIEW_MAX_INDEX,
          logger: this.logger,
        });
      } catch (error) {
        this.logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          'account overview unavailable; report omits the subaccount breakdown',
        );
      }
    }

    // No signing key required: verified live 2026-10-25 that this endpoint answers
    // without auth headers (docs say otherwise — see API_CONTRACTS §9.15). The client
    // signs when a key exists and degrades to a 401 warning if the venue enforces it.
    if (raw.REPORT_INCLUDE_AFFILIATE && address !== '') {
      try {
        affiliate = await this.context.rest.getAffiliateInfo(address);
      } catch (error) {
        this.logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          'affiliate info unavailable; report omits referral standing',
        );
      }
    }

    return {
      ...(overview ? { overview } : {}),
      ...(affiliate ? { affiliate } : {}),
    };
  }

  /** Assemble the report input from live state and the store. */
  buildReportInput(reportDate: string, nowMs: number, extras: ReportExtras = {}): DailyReportInput {
    const raw = this.context.config.raw;
    const stats = this.context.decisionPipeline.stats;
    const today = dayKey(nowMs);
    const account = this.context.markets.getAccount();
    const positions = this.context.markets.getPositions()?.value ?? [];
    const ledger = this.context.store.ledgerForDay(today);
    const closedTrades = this.context.store.closedTradeStats({});
    const drawdown = this.context.store.maxDrawdown({});
    const equity = account?.value ? dec(account.value.equity) : dec('0');
    const freeCollateral = account?.value ? dec(account.value.freeCollateral) : dec('0');
    const usedMargin = positions.reduce((acc, p) => acc.plus(dec(p.marginUsed)), dec('0'));
    const unrealized = positions.reduce((acc, p) => acc.plus(dec(p.unrealizedPnl)), dec('0'));
    const netCashFlow = this.context.store.netCashFlowForDay(today);

    // Maintenance buffer: per-position notional times the maintenance fraction,
    // falling back to a documented 0.5% when the market payload omits it.
    const maintenanceMargin = positions.reduce((acc, p) => {
      const market = this.context.markets.getMarketById(p.marketId);
      const mmf = market ? this.context.markets.maintenanceMarginFraction(market) : undefined;
      return acc.plus(
        dec(p.size).abs().times(dec(p.markPx)).times(mmf ?? dec(raw.DEFAULT_MAINTENANCE_MARGIN_FRACTION)),
      );
    }, dec('0'));

    // Worst case: every open position stopped out at its reconstructed stop. The
    // reconstructed stop is used because a live stop order's trigger price is not
    // reliably associated with a position by the API.
    const worstCaseStopLoss = positions.reduce((acc, p) => {
      const stop = this.context.orderStateMachine
        .protectiveOrders(p.marketId)
        .find((o) => o.triggerPrice !== undefined);
      if (!stop?.triggerPrice) return acc;
      return acc.plus(dec(p.size).abs().times(dec(stop.triggerPrice).minus(dec(p.markPx)).abs()));
    }, dec('0'));

    const withdrawable = this.context.riskEngine.computeWithdrawable({
      equity,
      usedMargin,
      positions: positions.map((p) => {
        const market = this.context.markets.getMarketById(p.marketId);
        const mmf = market ? this.context.markets.maintenanceMarginFraction(market) : undefined;
        return {
          size: dec(p.size),
          markPx: dec(p.markPx),
          ...(mmf ? { maintenanceMarginFraction: mmf } : {}),
        };
      }),
      worstCaseStopLoss,
      safetyReservePct: dec(raw.WITHDRAWABLE_SAFETY_RESERVE_PCT),
    });

    const base = equity.minus(netCashFlow);
    const cashFlowAdjustedReturnPct = base.greaterThan(0)
      ? ledger.netPnl.div(base).times(100)
      : undefined;

    return {
      reportDate,
      generatedAtMs: nowMs,
      timezone: raw.REPORT_TIMEZONE,
      wallet: raw.ARCUS_WALLET_ADDRESS ?? 'unconfigured',
      accountIndex: raw.ARCUS_ACCOUNT_INDEX,
      exchange: raw.ARCUS_REST_URL,
      tradingMode: raw.TRADING_MODE,
      liveTrading: this.context.orderSubmissionAllowed,
      strategyMode: raw.STRATEGY_MODE,
      strategyTimeframes: {
        trend: raw.TREND_TIMEFRAME,
        structure: raw.STRUCTURE_TIMEFRAME,
        trigger: raw.TRIGGER_TIMEFRAME,
      },
      equity,
      freeCollateral,
      usedMargin,
      netQuoteBalance: account?.value ? dec(account.value.netQuoteBalance) : dec('0'),
      maintenanceMargin,
      depositsToday: this.context.store.cashFlowForDay(today, ['DEPOSIT', 'REFERRAL_CLAIM']),
      withdrawalsToday: this.context.store.cashFlowForDay(today, ['WITHDRAWAL']),
      netDepositsLifetime: this.context.store.lifetimeNetDeposits(),
      realizedPnl: ledger.tradingPnl,
      unrealizedPnl: unrealized,
      fees: ledger.fees,
      funding: ledger.funding,
      estimatedSlippage: dec('0'),
      netTradingPnl: ledger.netPnl,
      cashFlowAdjustedReturnPct,
      fillCount: ledger.fillCount,
      grossVolumeNotional: ledger.grossVolumeNotional,
      ...(extras.overview ? { accountOverview: extras.overview } : {}),
      ...(extras.affiliate ? { affiliate: extras.affiliate } : {}),
      makerRatio: this.context.store.makerRatioForDay(today),
      winRate: closedTrades.winRate,
      profitFactor: closedTrades.profitFactor,
      maxDrawdownPct: drawdown.fraction.times(100),
      consecutiveLosses: this.context.store.consecutiveLosses(),
      averageHoldMs: closedTrades.avgHoldMs,
      positions: positions.map((p) => {
        const market = this.context.markets.getMarketById(p.marketId);
        const stop = this.context.orderStateMachine
          .protectiveOrders(p.marketId)
          .find((o) => o.triggerPrice !== undefined);
        const direction: 'long' | 'short' = p.side === 'LONG' ? 'long' : 'short';
        const liq =
          market && this.context.markets.maintenanceMarginFraction(market)
            ? this.context.riskEngine.estimateLiquidationDistance({
                entryPrice: dec(p.averageEntryPrice),
                size: dec(p.size),
                marginUsed: dec(p.marginUsed),
                maintenanceMarginFraction: this.context.markets.maintenanceMarginFraction(market)!,
                direction,
              })
            : undefined;
        return {
          symbol: p.marketDisplayName,
          direction,
          size: p.size,
          entryPrice: p.averageEntryPrice,
          markPrice: p.markPx,
          ...(stop?.triggerPrice ? { stopPrice: stop.triggerPrice } : {}),
          ...(market?.fundingRate ? { fundingRate: market.fundingRate } : {}),
          ...(liq ? { liquidationDistancePct: toFixedString(liq.distancePct) } : {}),
          unrealizedPnl: p.unrealizedPnl,
          category: market?.category ?? 'UNKNOWN',
        };
      }),
      strategyState: this.strategyState,
      ...(this.activeMarketId !== undefined
        ? { activeMarket: this.context.markets.getMarketById(this.activeMarketId)?.marketDisplayName }
        : {}),
      candidateMarkets: this.candidates.map((c) => ({
        symbol: c.symbol,
        category: c.market.category,
        score: toFixedString(c.score),
        isOutsideRth: c.isOutsideRth,
      })),
      pipeline: {
        evaluations: stats.evaluations,
        noSignal: stats.noSignal,
        rejectedByCost: stats.rejectedByCost,
        rejectedByRisk: stats.rejectedByRisk,
        approved: stats.approved,
        ...(stats.lastReason !== undefined ? { lastReason: stats.lastReason } : {}),
      },
      dataAgeMs: account?.ageMs,
      websocket: {
        state: this.context.ws.stats.state,
        ready: this.context.ws.isReady,
        reconnects: this.context.ws.stats.reconnectCount,
        errorFrames: this.context.ws.stats.errorFrameCount,
      },
      rateLimit: {
        weightAvailable: this.context.weightBudget.snapshot().available,
        weightCapacity: this.context.weightBudget.snapshot().capacity,
        ...(this.context.poolGuard.snapshotState
          ? {
              orderPoolRemaining: this.context.poolGuard.snapshotState.orderRemaining,
              cancelPoolRemaining: this.context.poolGuard.snapshotState.cancelRemaining,
            }
          : {}),
        throttledCount: this.context.weightBudget.snapshot().throttledCount,
      },
      reconciliation: {
        reconciled: this.reconciliationOk,
        blockingCount: this.reconciliationOk ? 0 : 1,
        ...(this.reconciliationReason ? { reason: this.reconciliationReason } : {}),
      },
      unknownOrders: this.context.orderStateMachine.unknownOrders().length,
      exitPlan: {
        tp1Placed: this.context.positionManager.counters.tp1Placed,
        tp2Placed: this.context.positionManager.counters.tp2Placed,
        stopsReduced: this.context.positionManager.counters.stopsReduced,
        stopsTrailed: this.context.positionManager.counters.stopsTrailed,
        emergencyExits: this.context.positionManager.counters.emergencyExits,
        blockedActions: this.context.positionManager.counters.blockedActions,
        plans: this.context.positionManager.planSnapshot.map((entry) => ({
          symbol: entry.symbol,
          direction: entry.direction,
          baselineSize: entry.baselineSize,
          tp1Done: entry.tp1Done,
          tp2Done: entry.tp2Done,
          stop: entry.lastRequestedStop ?? `initial ${entry.entryPrice}`,
        })),
      },
      killSwitch: {
        engaged: this.context.killSwitch.engaged,
        ...(this.context.killSwitch.status.reason ? { reason: this.context.killSwitch.status.reason } : {}),
      },
      isOutsideRthAny: positions.some((p) => {
        const market = this.context.markets.getMarketById(p.marketId);
        return market?.isOutsideRth !== false;
      }),
      offHoursEntriesAllowed: raw.ALLOW_RWA_OFF_HOURS,
      withdrawable: { amount: withdrawable.withdrawable, components: withdrawable.components },
      anomalies: [...this.anomalies, ...this.context.startupNotes],
      recommendations: this.buildRecommendations(),
    };
  }

  private buildRecommendations(): string[] {
    const recommendations: string[] = [];
    const raw = this.context.config.raw;
    if (!this.reconciliationOk) {
      recommendations.push(
        'Reconciliation is failing. Investigate the discrepancy list before re-enabling entries; ' +
          'do not clear the kill switch until positions and orders agree with the venue.',
      );
    }
    if (raw.TRADING_MODE !== 'live') {
      recommendations.push(
        `Running in ${raw.TRADING_MODE}. Live trading additionally requires --confirm-live at startup.`,
      );
    }
    if (this.context.executor.unprotected.length > 0) {
      recommendations.push(
        `Markets currently UNPROTECTED (no confirmed stop): ${this.context.executor.unprotected.join(', ')}. ` +
          'No further exposure will be added to these markets.',
      );
    }
    if (recommendations.length === 0) {
      recommendations.push('No action required.');
    }
    return recommendations;
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function clamp01(value: Decimal): Decimal {
  if (value.lessThan(0)) return dec('0');
  if (value.greaterThan(1)) return dec('1');
  return value;
}

function tradable(result: { tradable: boolean }): boolean {
  return result.tradable;
}

function timeframeToMs(timeframe: string): number {
  const match = /^(\d+)([mhdw])$/.exec(timeframe);
  if (!match) return 15 * 60_000;
  const amount = Number(match[1]);
  const unit = match[2];
  const base = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : unit === 'd' ? 86_400_000 : 604_800_000;
  return amount * base;
}

/**
 * Best-effort array extraction from a channel frame's `contents`.
 *
 * Account channels are inconsistent by design: `orders` and `userFills` send a
 * snapshot as `{orders:[...]}` / `{fills:[...]}` but a live update as a single
 * object per frame. Both shapes are handled, and callers narrow the element type.
 * Returning `unknown[]` rather than a fabricated intersection forces that
 * narrowing to be explicit.
 */
function extractArray(contents: unknown, key: string): unknown[] {
  if (typeof contents !== 'object' || contents === null) return [];
  const record = contents as Record<string, unknown>;
  const candidate = record[key] ?? record.items ?? record.data;
  if (Array.isArray(candidate)) return candidate;
  // A single-object frame: recognised by a field every one of these shapes has.
  if (
    record.orderId !== undefined ||
    record.tradeId !== undefined ||
    record.type !== undefined
  ) {
    return [record];
  }
  return [];
}

interface CashFlowFrame {
  readonly type: string;
  readonly amount: string;
  readonly accountIndex: number;
  readonly time: number;
  readonly txHash?: string;
}

function parseCronHour(cron: string): number | undefined {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 2) return undefined;
  const hourField = parts[1];
  if (!hourField) return undefined;
  const hour = Number(hourField);
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : undefined;
}

function hourInTimezone(epochMs: number, timezone: string): number {
  try {
    const formatted = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      hour12: false,
    }).format(new Date(epochMs));
    return Number(formatted);
  } catch {
    return new Date(epochMs).getUTCHours();
  }
}
