/**
 * Bootstrap.
 *
 * Assembles the system and runs the brief's mandated startup sequence IN ORDER,
 * refusing to proceed when a step cannot be completed:
 *
 *   1. validate environment variables            (fail fast, all issues at once)
 *   2. validate the wallet address and accountIndex
 *   3. fetch markets                             (no hardcoded market list)
 *   4. fetch account, positions, openOrders, fills
 *   5. reconcile local state against the venue
 *   6. establish the WebSocket and wait for snapshots
 *   7. run shadow / dry-run
 *   8. check the kill switch
 *   9. only an explicit `--confirm-live` permits live trading
 *
 * Every failure before step 9 leaves the system in a state that CANNOT place an
 * entry order, because `orderSubmissionAllowed` is derived from config and live
 * submission additionally requires the CLI confirmation. There is no partially
 * armed state.
 */

import { existsSync } from 'node:fs';
import { ArcusHttpError, ArcusRestClient, ppmToBps } from '../arcus/ArcusRestClient';
import { ArcusSigner } from '../arcus/ArcusSigner';
import { ArcusWsClient } from '../arcus/ArcusWsClient';
import { TradingPoolGuard, WeightBudget } from '../arcus/RateLimiter';
import { loadConfig, describeConfig, type Config } from '../config/config';
import { DecisionPipeline } from '../app/DecisionPipeline';
import { Executor } from '../execution/Executor';
import { OrderStateMachine } from '../execution/OrderStateMachine';
import { PositionManager } from '../execution/PositionManager';
import { AlertRouter } from '../notifications/AlertRouter';
import { LarkClient } from '../notifications/LarkClient';
import { MarketProvider } from '../market/MarketProvider';
import { KillSwitch } from '../risk/KillSwitch';
import { Reconciler } from '../risk/Reconciliation';
import { RiskEngine, type RiskLimits } from '../risk/RiskEngine';
import { Store } from '../store/Store';
import { dec, toFixedString } from '../util/decimal';
import { createLogger, describeSecret, type Logger } from '../util/logger';
import type { FeeTierConfigRow } from '../arcus/types';
import type { StrategyConfig } from '../strategy/PullbackStrategy';
import type { CostModelConfig } from '../strategy/CostModel';

/** Modes the CLI can request. Live is only reachable with `--confirm-live`. */
export type RunMode = 'dry-run' | 'shadow' | 'live' | 'reconcile' | 'preflight' | 'report' | 'kill' | 'reset-kill';

/** Everything assembled, handed to the Runtime. */
export interface AppContext {
  readonly config: Config;
  readonly logger: Logger;
  readonly store: Store;
  readonly rest: ArcusRestClient;
  readonly ws: ArcusWsClient;
  readonly markets: MarketProvider;
  readonly riskEngine: RiskEngine;
  readonly killSwitch: KillSwitch;
  readonly reconciler: Reconciler;
  readonly orderStateMachine: OrderStateMachine;
  readonly executor: Executor;
  /** Owns the exit plan (TP1/TP2, stop reduction, trailing) for every position. */
  readonly positionManager: PositionManager;
  readonly larkClient: LarkClient;
  readonly alertRouter: AlertRouter;
  readonly decisionPipeline: DecisionPipeline;
  readonly poolGuard: TradingPoolGuard;
  readonly weightBudget: WeightBudget;
  readonly strategyConfig: StrategyConfig;
  readonly costConfig: CostModelConfig;
  /**
   * Fee rates. Mutable on purpose: the fallback defaults are replaced in place
   * once `GET /v1/feetiers` is read during the startup sequence, and the decision
   * pipeline reads them through this same object.
   */
  readonly feeRates: {
    makerFeeBps: ReturnType<typeof dec>;
    takerFeeBps: ReturnType<typeof dec>;
    source: 'table' | 'fallback';
    note?: string;
  };
  /**
   * The ONLY authority on whether an order may be submitted.
   *
   * False unless the mode is live, LIVE_TRADING is true, the config permits
   * submission, AND the CLI supplied `--confirm-live`.
   */
  readonly orderSubmissionAllowed: boolean;
  /** Non-fatal startup findings, echoed into the first report. */
  readonly startupNotes: readonly string[];
}

export interface BootstrapOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly mode: RunMode;
  /** From the CLI `--confirm-live` flag. */
  readonly confirmLive: boolean;
  readonly argv?: readonly string[];
}

export class BootstrapError extends Error {
  readonly step: string;
  constructor(step: string, message: string) {
    super(`startup failed at "${step}": ${message}`);
    this.name = 'BootstrapError';
    this.step = step;
  }
}

/** Exported so a test can assert that config values actually reach the strategy. */
export function strategyConfigFrom(config: Config): StrategyConfig {
  const raw = config.raw;
  return {
    emaFastPeriod: raw.EMA_FAST,
    emaMidPeriod: raw.EMA_MID,
    emaSlowPeriod: raw.EMA_SLOW,
    atrPeriod: raw.ATR_PERIOD,
    minHistoryBars: raw.MIN_HISTORY_BARS,
    stopAtrBuffer: dec(raw.STOP_ATR_BUFFER),
    maxExtensionAtr: dec(raw.MAX_EXTENSION_ATR),
    maxChaseAtr: dec(raw.MAX_CHASE_ATR),
    pullbackZoneAtr: dec(raw.PULLBACK_ZONE_ATR),
    tp1RMultiple: dec(raw.TP1_R_MULTIPLE),
    tp1ClosePct: dec(raw.TP1_CLOSE_PCT),
    tp2RMultiple: dec(raw.TP2_R_MULTIPLE),
    // A zero means "derive from history", preserving the original behaviour while
    // letting an operator pin an explicit window.
    structureLookback:
      raw.STRUCTURE_LOOKBACK_BARS > 0 ? raw.STRUCTURE_LOOKBACK_BARS : Math.max(20, raw.MIN_HISTORY_BARS),
    swingLeftBars: raw.SWING_LEFT_BARS,
    swingRightBars: raw.SWING_RIGHT_BARS,
  };
}

function costConfigFrom(config: Config): CostModelConfig {
  const raw = config.raw;
  return {
    makerFeeBps: dec(raw.FALLBACK_MAKER_FEE_BPS),
    takerFeeBps: dec(raw.FALLBACK_TAKER_FEE_BPS),
    assumedSlippageBps: dec(raw.ASSUMED_SLIPPAGE_BPS),
    safetyBufferBps: dec(raw.COST_SAFETY_BUFFER_BPS),
  };
}

/** Exported so a test can assert that config values actually reach the RiskEngine. */
export function riskLimitsFrom(config: Config): RiskLimits {
  const raw = config.raw;
  return {
    riskPerTradeBps: dec(raw.RISK_PER_TRADE_BPS),
    dailyLossLimitBps: dec(raw.DAILY_LOSS_LIMIT_BPS),
    maxNotionalPct: dec(raw.MAX_NOTIONAL_PCT),
    maxLeverage: dec(raw.MAX_LEVERAGE),
    maxOpenPositions: raw.MAX_OPEN_POSITIONS,
    maxMarketsPerAccount: raw.MAX_MARKETS_PER_ACCOUNT,
    maxConsecutiveLosses: raw.MAX_CONSECUTIVE_LOSSES,
    minFreeCollateralUsd: dec(raw.MIN_FREE_COLLATERAL_USD),
    maxOrderNotionalPct: dec(raw.MAX_ORDER_NOTIONAL_PCT),
    minNotional: dec(raw.MIN_ORDER_NOTIONAL_USD),
    minOrderSize: undefined,
  };
}

/**
 * Decide whether order submission is permitted.
 *
 * Four independent conditions, ALL required. The `--confirm-live` flag is not
 * redundant with `LIVE_TRADING=true`: it forces a human to type the flag on the
 * command line at start time, which is the difference between "the env file says
 * live" and "an operator intended to go live right now".
 */
export function resolveOrderSubmission(params: {
  mode: RunMode;
  confirmLive: boolean;
  liveTrading: boolean;
  tradingMode: string;
  allowOrderSubmission: boolean;
  /**
   * When false, the `--confirm-live` requirement is waived.
   *
   * Defaults to TRUE when omitted, so the safe behaviour is what a caller gets by not
   * thinking about it. Set false only for a supervised, ephemeral run — never on a VPS
   * that restarts unattended, because the flag is the only thing distinguishing "the
   * env file says live" from "an operator intended to go live right now".
   */
  requireExplicitConfirmation?: boolean;
}): { allowed: boolean; reason: string } {
  if (params.mode !== 'live') {
    return { allowed: false, reason: `mode is ${params.mode}; order submission requires mode=live` };
  }
  if (!params.allowOrderSubmission) {
    return { allowed: false, reason: 'ALLOW_ORDER_SUBMISSION is false' };
  }
  if (!params.liveTrading || params.tradingMode !== 'live') {
    return {
      allowed: false,
      reason: `LIVE_TRADING=${String(params.liveTrading)} and TRADING_MODE=${params.tradingMode} must both be live`,
    };
  }
  const requireConfirmation = params.requireExplicitConfirmation ?? true;
  if (requireConfirmation && !params.confirmLive) {
    return {
      allowed: false,
      reason: 'live trading requires the explicit --confirm-live command-line flag',
    };
  }
  if (!requireConfirmation && !params.confirmLive) {
    // Allowed, but say so plainly: this is the one path where a LIVE process can start
    // from an environment file alone.
    return {
      allowed: true,
      reason:
        'live trading confirmed by mode and env flags without --confirm-live, because ' +
        'REQUIRE_EXPLICIT_LIVE_CONFIRMATION=false',
    };
  }
  return { allowed: true, reason: 'live trading confirmed by mode, env flags and --confirm-live' };
}

/**
 * Assemble the system. Does NOT start the trading loop.
 *
 * Steps 1-6 of the startup sequence happen here (or in `runStartupSequence`),
 * because they must complete before any loop runs.
 */
export function bootstrap(options: BootstrapOptions): AppContext {
  const env = options.env ?? process.env;

  /* ---- 1. environment ------------------------------------------- */
  let config: Config;
  try {
    config = loadConfig(env);
  } catch (error) {
    // Re-throw with the step name so the operator knows WHICH phase failed.
    throw new BootstrapError('validate environment variables', error instanceof Error ? error.message : String(error));
  }

  const logger = createLogger({
    level: config.raw.LOG_LEVEL,
    pretty: config.raw.LOG_PRETTY,
    name: 'arcustrader',
    base: { mode: options.mode },
  });
  const startupNotes: string[] = [...config.notes];

  logger.info(
    { config: describeConfig(config), argv: options.argv ?? [] },
    'configuration loaded',
  );

  /* ---- 2. wallet / account index -------------------------------- */
  const address = config.raw.ARCUS_WALLET_ADDRESS;
  const accountIndex = config.raw.ARCUS_ACCOUNT_INDEX;
  if (options.mode === 'live' && !address) {
    throw new BootstrapError('validate account', 'ARCUS_WALLET_ADDRESS is required for live mode');
  }
  if (address && !/^(0x|0X)?[0-9a-fA-F]{40}$/.test(address)) {
    throw new BootstrapError('validate account', `ARCUS_WALLET_ADDRESS is not a 20-byte hex address`);
  }
  if (address) {
    logger.info(
      { address: `${address.slice(0, 8)}…`, accountIndex, addressIsPublic: true },
      'account configured (note: the Arcus address is an unauthenticated read key — see README)',
    );
  }

  /* ---- signing -------------------------------------------------- */
  let signer: ArcusSigner | undefined;
  if (config.secrets.arcusApiSigningKey) {
    try {
      signer = new ArcusSigner({
        signingKeyHex: config.secrets.arcusApiSigningKey,
        ...(config.secrets.arcusApiKey ? { expectedApiKeyHex: config.secrets.arcusApiKey } : {}),
      });
      logger.info(
        {
          apiKey: describeSecret(signer.apiKeyHex),
          // Confirm the configured API key matched, without printing either key.
          apiKeyMatched: Boolean(config.secrets.arcusApiKey),
        },
        'signing key loaded from environment',
      );
    } catch (error) {
      throw new BootstrapError('load signing key', error instanceof Error ? error.message : String(error));
    }
  } else {
    startupNotes.push('ARCUS_API_SIGNING_KEY is not set: signing is unavailable, so only public reads are possible.');
  }

  /* ---- submission authority ------------------------------------- */
  const submission = resolveOrderSubmission({
    mode: options.mode,
    confirmLive: options.confirmLive,
    liveTrading: config.raw.LIVE_TRADING,
    tradingMode: config.raw.TRADING_MODE,
    allowOrderSubmission: config.raw.ALLOW_ORDER_SUBMISSION,
    requireExplicitConfirmation: config.raw.REQUIRE_EXPLICIT_LIVE_CONFIRMATION,
  });
  if (options.mode === 'live' && !config.raw.REQUIRE_EXPLICIT_LIVE_CONFIRMATION) {
    // Loud, because this is the single configuration that removes the human step.
    logger.error(
      'REQUIRE_EXPLICIT_LIVE_CONFIRMATION=false: live trading can start from the environment alone, ' +
        'without --confirm-live. This is intended only for supervised runs.',
    );
  }
  if (options.mode === 'live' && !submission.allowed) {
    // A live run that cannot submit is almost certainly operator error, so it is
    // fatal rather than a silent no-op.
    throw new BootstrapError('arm live trading', submission.reason);
  }
  if (options.mode === 'live' && !signer) {
    throw new BootstrapError('arm live trading', 'live mode requires ARCUS_API_SIGNING_KEY to sign orders');
  }
  logger.warn(
    { orderSubmissionAllowed: submission.allowed, reason: submission.reason },
    submission.allowed ? 'ORDER SUBMISSION IS ARMED' : 'order submission disabled',
  );

  /* ---- store ---------------------------------------------------- */
  const store = new Store({ path: config.raw.DB_PATH, logger });

  /* ---- HTTP + WS clients ---------------------------------------- */
  const weightBudget = new WeightBudget({
    capacity: config.raw.RATE_LIMIT_WEIGHT_BUDGET_PER_MIN,
    refillPerSecond: 25,
    logger,
  });
  const rest = new ArcusRestClient({
    baseUrl: config.raw.ARCUS_REST_URL,
    logger,
    weightBudget,
    timeoutMs: config.raw.HTTP_TIMEOUT_MS,
    circuitBreakerOptions: {
      threshold: config.raw.CIRCUIT_BREAKER_THRESHOLD,
      cooldownMs: config.raw.CIRCUIT_BREAKER_COOLDOWN_MS,
      maxCooldownMs: config.raw.CIRCUIT_BREAKER_MAX_COOLDOWN_MS,
    },
    ...(signer ? { signer } : {}),
  });
  const ws = new ArcusWsClient({ url: config.raw.ARCUS_WS_URL, logger });

  const markets = new MarketProvider({
    rest,
    logger,
    maxDataAgeMs: config.raw.MAX_DATA_AGE_MS,
    maxMetadataAgeMs: config.raw.MAX_MARKET_METADATA_AGE_MS,
    depthBandBps: config.raw.DEPTH_BAND_BPS,
  });

  /* ---- risk controls -------------------------------------------- */
  const riskEngine = new RiskEngine(riskLimitsFrom(config), logger);
  const killSwitch = new KillSwitch({ stopFilePath: config.raw.STOP_FILE, logger });
  const reconciler = new Reconciler({ logger });
  const orderStateMachine = new OrderStateMachine();
  const poolGuard = new TradingPoolGuard({
    minOrderRemaining: config.raw.MIN_ORDER_POOL_REMAINING,
    requirePoolReading: config.raw.REQUIRE_ORDER_POOL_READ,
    maxAgeMs: config.raw.POOL_STATE_MAX_AGE_MS,
  });

  const executor = new Executor({
    rest,
    logger,
    address: address ?? '0x0000000000000000000000000000000000000000',
    accountIndex,
    orderStateMachine,
    goodTilDays: config.raw.ORDER_GOOD_TIL_DAYS,
    emergencyBoundBps: dec(config.raw.EMERGENCY_BOUND_BPS),
    stopTriggerOffsetBps: dec(config.raw.STOP_TRIGGER_OFFSET_BPS),
  });

  /**
   * Position manager.
   *
   * Wired with a candle accessor rather than the provider itself, so the manager
   * cannot reach into market metadata or account state it has no business reading.
   */
  const positionManager = new PositionManager({
    logger,
    executor,
    orderStateMachine,
    tp1ClosePct: dec(config.raw.TP1_CLOSE_PCT),
    trailEmaPeriod: config.raw.TRAIL_EMA_PERIOD,
    structureTimeframe: config.raw.STRUCTURE_TIMEFRAME,
    trailBufferBps: dec(config.raw.TRAIL_STOP_BUFFER_BPS),
    trailActivationR: dec(config.raw.TRAIL_ACTIVATION_R),
    getStructureCandles: (symbol) => markets.getCandlesClosed(symbol, config.raw.STRUCTURE_TIMEFRAME),
    now: () => Date.now(),
  });

  /* ---- Lark ----------------------------------------------------- */
  const larkClient = new LarkClient({
    baseUrl: config.raw.LARK_BASE_URL,
    ...(config.secrets.larkAppId ? { appId: config.secrets.larkAppId } : {}),
    ...(config.secrets.larkAppSecret ? { appSecret: config.secrets.larkAppSecret } : {}),
    ...(config.raw.LARK_CHAT_ID ? { chatId: config.raw.LARK_CHAT_ID } : {}),
    logger,
    maxAttempts: config.raw.LARK_MAX_ATTEMPTS,
    baseBackoffMs: config.raw.LARK_BASE_BACKOFF_MS,
    requestTimeoutMs: config.raw.LARK_REQUEST_TIMEOUT_MS,
  });

  /**
   * Outbox adapter.
   *
   * Wraps the SQLite-backed store so the AlertRouter's `OutboxStore` contract is
   * satisfied without it knowing about SQLite. `pending` maps `lastError` from
   * `string | undefined` to the router's expected shape.
   */
  const outboxAdapter = {
    enqueue(record: {
      idempotencyKey: string;
      kind: 'text' | 'card';
      payload: string;
      createdAtMs: number;
      attempts: number;
      lastError?: string;
    }): void {
      store.enqueueOutbox(record);
    },
    pending(limit: number): {
      id: number;
      idempotencyKey: string;
      kind: 'text' | 'card';
      payload: string;
      attempts: number;
    }[] {
      return store.pendingOutbox(limit).map((row) => ({
        id: row.id,
        idempotencyKey: row.idempotencyKey,
        kind: row.kind,
        payload: row.payload,
        attempts: row.attempts,
      }));
    },
    markSent(id: number): void {
      store.markOutboxSent(id);
    },
    markFailed(id: number, error: string): void {
      store.markOutboxFailed(id, error);
    },
  };

  const alertRouter = new AlertRouter({
    client: larkClient,
    logger,
    outbox: outboxAdapter,
    maxOutboxPerFlush: 20,
  });

  /* ---- strategy / cost / decision ------------------------------- */
  const strategyConfig = strategyConfigFrom(config);
  const costConfig = costConfigFrom(config);

  const decisionPipeline = new DecisionPipeline({
    logger,
    strategyConfig,
    costConfig,
    riskEngine,
    projectableFraction: dec(config.raw.PROJECTABLE_FRACTION),
    maxDataAgeMs: config.raw.MAX_DATA_AGE_MS,
    fundingIntervalHours: dec(config.raw.FUNDING_INTERVAL_HOURS),
    feeRates: {
      makerFeeBps: costConfig.makerFeeBps,
      takerFeeBps: costConfig.takerFeeBps,
      source: 'fallback',
    },
  });

  if (config.raw.TRADING_MODE !== options.mode && options.mode !== 'report' && options.mode !== 'preflight' && options.mode !== 'reconcile' && options.mode !== 'kill' && options.mode !== 'reset-kill') {
    startupNotes.push(
      `CLI mode "${options.mode}" differs from TRADING_MODE="${config.raw.TRADING_MODE}". ` +
        'Order submission follows the CLI mode and the live-confirmation rule, not TRADING_MODE alone.',
    );
  }

  return {
    config,
    logger,
    store,
    rest,
    ws,
    markets,
    riskEngine,
    killSwitch,
    reconciler,
    orderStateMachine,
    executor,
    positionManager,
    larkClient,
    alertRouter,
    decisionPipeline,
    poolGuard,
    weightBudget,
    strategyConfig,
    costConfig,
    feeRates: {
      makerFeeBps: costConfig.makerFeeBps,
      takerFeeBps: costConfig.takerFeeBps,
      source: 'fallback',
      note: 'defaults until the fee tier table is fetched at startup',
    },
    orderSubmissionAllowed: submission.allowed,
    startupNotes,
  };
}

/** Result of the startup read/reconcile sequence. */
export interface StartupReport {
  readonly marketsRead: boolean;
  readonly accountRead: boolean;
  readonly positionsRead: boolean;
  readonly openOrdersRead: boolean;
  readonly fillsRead: boolean;
  readonly rateLimitRead: boolean;
  readonly reconciled: boolean;
  readonly reconciliationBlockingCount: number;
  readonly reconciliationReason?: string;
  readonly marketCount: number;
  readonly equity?: string;
  readonly freeCollateral?: string;
  readonly openPositionCount: number;
  readonly openOrderCount: number;
  readonly dataAgeMs: number;
  readonly failures: readonly string[];
}

/**
 * Startup sequence steps 3-6: read the venue, reconcile, connect.
 *
 * Read failures are collected rather than thrown one at a time, so a single start
 * reports everything that is wrong. A failure here does not prevent the process
 * from RUNNING — it prevents it from TRADING, which is the correct fail-closed
 * posture: a bot that can read but not trade can still report and still manage
 * protective orders on any position it discovers.
 */
export async function runStartupSequence(context: AppContext): Promise<StartupReport> {
  const { config, logger, rest, markets, reconciler, ws, store, poolGuard } = context;
  const failures: string[] = [];
  const address = config.raw.ARCUS_WALLET_ADDRESS;
  const accountIndex = config.raw.ARCUS_ACCOUNT_INDEX;
  const startedAtMs = Date.now();

  /* ---- 3. markets ------------------------------------------------ */
  let marketCount = 0;
  const marketsRead = await markets.refreshMarkets();
  if (!marketsRead) failures.push('GET /v1/markets failed');
  marketCount = markets.getMarkets().value.length;

  /* ---- 4. account / positions / openOrders / fills -------------- */
  let accountRead = false;
  let positionsRead = false;
  let openOrdersRead = false;
  let fillsRead = false;
  let equity: string | undefined;
  let freeCollateral: string | undefined;
  let cashFlowsRead = false;
  let fundingRead = false;

  if (!address) {
    /**
     * No wallet configured.
     *
     * This is a legitimate READ-ONLY posture: market data, candle history and the
     * whole strategy pipeline work from public endpoints. What is impossible is
     * sizing against an account, so the entry gate refuses every order. We
     * therefore do NOT fail here — we skip the account-scoped reads and say why.
     * The gate, not this function, is what prevents trading.
     */
    const gate = reconciler.failed(
      'no ARCUS_WALLET_ADDRESS configured: account, positions, orders and fills cannot be read, ' +
        'so no position may be opened',
    );
    logger.warn(
      { posture: 'read-only' },
      'no wallet address configured; running read-only (market data + strategy only, orders impossible)',
    );
    return {
      marketsRead,
      accountRead: false,
      positionsRead: false,
      openOrdersRead: false,
      fillsRead: false,
      rateLimitRead: false,
      reconciled: false,
      reconciliationBlockingCount: gate.blockingCount,
      reconciliationReason: gate.reason,
      marketCount,
      openPositionCount: 0,
      openOrderCount: 0,
      dataAgeMs: Date.now() - startedAtMs,
      failures: [...failures, 'no wallet address configured (read-only mode)'],
    };
  }

  try {
    const account = await markets.refreshAccount(address, accountIndex);
    accountRead = account !== undefined || markets.getAccount()?.value === undefined;
    if (account) {
      equity = toFixedString(dec(account.equity));
      freeCollateral = toFixedString(dec(account.freeCollateral));
      // Record the equity snapshot that drives the recalibration trigger.
      store.recordEquitySnapshot({
        capturedAtMs: Date.now(),
        equity: dec(account.equity),
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
    } else {
      // 404 with no activity is a valid, expected state for a fresh account.
      logger.warn('account has no activity yet (HTTP 404); treating equity as 0');
      accountRead = true;
      equity = '0';
      freeCollateral = '0';
    }
  } catch (error) {
    failures.push(`account read failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    await markets.refreshPositions(address, accountIndex);
    positionsRead = true;
  } catch (error) {
    failures.push(`positions read failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  let venueOrders: readonly import('../arcus/types').Order[] = [];
  try {
    venueOrders = await rest.getOpenOrders({ address, accountIndex });
    openOrdersRead = true;
  } catch (error) {
    failures.push(`openOrders read failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const since = Date.now() * 1000 - 7 * 24 * 3600 * 1_000_000; // last 7 days, in µs
    const fills = await rest.getFills({ address, accountIndex, from: since });
    for (const fill of fills.fills) {
      if (store.recordFill(fill)) {
        logger.debug({ tradeId: fill.tradeId, market: fill.marketDisplayName }, 'fill ingested at startup');
      }
    }
    fillsRead = true;
  } catch (error) {
    failures.push(`fills read failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  /* ---- cash flows and funding ----------------------------------- */
  try {
    const since = Date.now() * 1000 - 30 * 24 * 3600 * 1_000_000;
    const transfers = await rest.getAccountTransferUpdates({ address, accountIndex, from: since });
    for (const transfer of transfers.transfers) {
      store.recordCashFlow({
        id: `${transfer.type}|${transfer.accountIndex}|${transfer.time}|${transfer.txHash ?? transfer.amount}`,
        type: transfer.type,
        amount: transfer.amount,
        accountIndex: transfer.accountIndex,
        occurredAtMs: Math.round(transfer.time / 1000),
        recordedAtMs: Date.now(),
      });
    }
    cashFlowsRead = true;
  } catch (error) {
    // Non-fatal: a missing cash-flow read affects the report, not safety, and the
    // trading ledger stays correct because it is derived from fills.
    logger.warn({ err: String(error) }, 'accountTransferUpdates read failed (reporting will note this)');
  }

  try {
    const since = Date.now() * 1000 - 30 * 24 * 3600 * 1_000_000;
    const funding = await rest.getFundingPayments({ address, accountIndex, from: since });
    for (const payment of funding.funding) {
      store.recordFundingPayment({
        id: `${payment.marketId}|${payment.time}|${payment.payment}`,
        marketId: payment.marketId,
        payment: payment.payment,
        ...(payment.rate !== undefined ? { rate: payment.rate } : {}),
        occurredAtMs: Math.round(payment.time / 1000),
      });
    }
    fundingRead = true;
  } catch (error) {
    logger.warn({ err: String(error) }, 'funding payments read failed (reporting will note this)');
  }

  /* ---- rate-limit pools ----------------------------------------- */
  let rateLimitRead = false;
  try {
    const limit = await rest.getRateLimit({ address, accountIndex });
    poolGuard.update({
      orderRemaining: limit.order?.remaining ?? 0,
      cancelRemaining: limit.cancel?.remaining ?? 0,
      orderCapacity: limit.order?.capacity ?? 0,
      cancelCapacity: limit.cancel?.capacity ?? 0,
    });
    rateLimitRead = true;
  } catch (error) {
    const status = error instanceof ArcusHttpError ? error.status : undefined;
    if (status === 403 || status === 400) {
      // Observed live: this endpoint is access-whitelisted, unlike the other
      // account reads. Record the fact so the refusal message is accurate.
      poolGuard.markUndisclosed(
        `GET /v1/rateLimit refused with HTTP ${status} (the address is not on the ` +
          'access whitelist for this endpoint)',
      );
      logger.warn(
        { status },
        'GET /v1/rateLimit is not available for this address; pool state stays unknown',
      );
    } else {
      poolGuard.markUndisclosed(`GET /v1/rateLimit failed: ${String(error)}`);
      logger.warn({ err: String(error) }, 'GET /v1/rateLimit failed');
    }
    if (config.raw.REQUIRE_ORDER_POOL_READ) {
      logger.error(
        'REQUIRE_ORDER_POOL_READ=true and pool state is unavailable: new orders will be blocked. ' +
          'Set REQUIRE_ORDER_POOL_READ=false to trade without the pre-emptive pool check.',
      );
    }
  }

  /* ---- fee tiers ------------------------------------------------ */
  try {
    const feeTiers = await rest.getFeeTiers();
    const resolved = resolveFeeRatesFromTable(feeTiers.feeTiers, config);
    context.feeRates.makerFeeBps = resolved.makerFeeBps;
    context.feeRates.takerFeeBps = resolved.takerFeeBps;
    context.feeRates.source = resolved.source;
    if (resolved.note) context.feeRates.note = resolved.note;
    logger.info(
      {
        makerFeeBps: toFixedString(resolved.makerFeeBps),
        takerFeeBps: toFixedString(resolved.takerFeeBps),
        source: resolved.source,
      },
      'fee rates resolved',
    );
  } catch (error) {
    logger.warn({ err: String(error) }, 'fee tier table unavailable; using configured fallback rates');
  }

  /* ---- 5. reconcile --------------------------------------------- */
  let reconciled = false;
  let reconciliationBlockingCount = 1;
  let reconciliationReason: string | undefined;
  if (positionsRead && openOrdersRead) {
    const result = reconciler.reconcile({
      venuePositions: markets.getPositions()?.value ?? [],
      venueOrders,
      localOrders: context.orderStateMachine.liveOrders(),
      localPurposeByKey: new Map(
        context.orderStateMachine.all().map((o) => [o.key, o.purpose] as const),
      ),
      // At startup there is no local intent to compare against, so a venue
      // position with no local record is expected for a restart. Protective-stop
      // presence is still enforced, because that is a property of the VENUE state.
      sizeToleranceBase: dec('0'),
    });
    reconciled = result.reconciled;
    reconciliationBlockingCount = result.blockingCount;
    reconciliationReason = result.reason;
  } else {
    const result = reconciler.failed(
      `cannot reconcile: positionsRead=${positionsRead} openOrdersRead=${openOrdersRead}`,
    );
    reconciliationReason = result.reason;
  }

  /* ---- 6. websocket --------------------------------------------- */
  if (address) {
    // Account-scoped channels are keyed by ADDRESS, not by (address, index):
    // every frame carries its own `accountIndex`, which is what makes several
    // subaccounts of one address demuxable on a single subscription. Passing an
    // accountIndex at subscribe time is neither documented nor accepted.
    ws.subscribe({ channel: 'markets' });
    ws.subscribe({ channel: 'positions', id: address });
    ws.subscribe({ channel: 'orders', id: address });
    ws.subscribe({ channel: 'userFills', id: address });
    ws.subscribe({ channel: 'account', id: address });
    ws.subscribe({ channel: 'accountTransferUpdates', id: address });
    ws.connect();
    const ready = await ws.waitForReady(20_000);
    if (!ready) {
      failures.push(
        `websocket did not deliver snapshots within 20s (state=${ws.connectionState}, ` +
          `pending=${ws.pendingSubscriptions.map((s) => s.channel).join(',') || 'none'})`,
      );
    }
  }

  const dataAgeMs = Date.now() - startedAtMs;
  logger.info(
    {
      marketsRead,
      accountRead,
      positionsRead,
      openOrdersRead,
      fillsRead,
      cashFlowsRead,
      fundingRead,
      rateLimitRead,
      reconciled,
      reconciliationBlockingCount,
      marketCount,
      failures,
    },
    'startup sequence complete',
  );

  return {
    marketsRead,
    accountRead,
    positionsRead,
    openOrdersRead,
    fillsRead,
    rateLimitRead,
    reconciled,
    reconciliationBlockingCount,
    ...(reconciliationReason ? { reconciliationReason } : {}),
    marketCount,
    ...(equity ? { equity } : {}),
    ...(freeCollateral ? { freeCollateral } : {}),
    openPositionCount: markets.getPositions()?.value.length ?? 0,
    openOrderCount: venueOrders.length,
    dataAgeMs,
    failures,
  };
}

/** Fee tier resolution, kept here to avoid a circular import with CostModel. */
/**
 * Resolve the account's fee rates from the tier table.
 *
 * The live endpoint returns fees in PARTS PER MILLION with snake_case names:
 *   {"tiers":[{"level":0,"maker_fee_ppm":0,"taker_fee_ppm":225}, ...]}
 * The published OpenAPI fragment names them `makerFeeBps`/`takerFeeBps` instead, so
 * both are accepted. Getting the unit wrong is not cosmetic: reading `225` as bps
 * would overstate the taker fee by 100x and would refuse every trade whose edge sits
 * between the true and the inflated cost. A maker rate may be NEGATIVE (rebate), so
 * it is passed through unclamped.
 *
 * The table is a LADDER by volume. Without the account's realized volume there is no
 * way to know which row applies, so the BASE (lowest-threshold) row is used — the
 * conservative choice, because it is the most expensive tier.
 */
function resolveFeeRatesFromTable(
  rows: readonly FeeTierConfigRow[],
  config: Config,
): { makerFeeBps: ReturnType<typeof dec>; takerFeeBps: ReturnType<typeof dec>; source: 'table' | 'fallback'; note?: string } {
  const thresholdOf = (row: FeeTierConfigRow): number => {
    const raw = row.volume_threshold ?? row.volumeThreshold ?? 0;
    const n = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(n) ? n : 0;
  };
  const levelOf = (row: FeeTierConfigRow): number => row.level ?? row.tierLevel ?? 0;

  const sorted = [...rows].sort((a, b) => thresholdOf(a) - thresholdOf(b) || levelOf(a) - levelOf(b));
  const row = sorted[0];
  if (!row) {
    return {
      makerFeeBps: dec(config.raw.FALLBACK_MAKER_FEE_BPS),
      takerFeeBps: dec(config.raw.FALLBACK_TAKER_FEE_BPS),
      source: 'fallback',
      note: 'fee tier table was empty; using configured fallback rates',
    };
  }

  const fromPpm = (ppm: string | number | undefined): string | undefined =>
    ppm === undefined ? undefined : ppmToBps(ppm);

  const makerBps = row.maker_fee_ppm !== undefined ? fromPpm(row.maker_fee_ppm) : row.makerFeeBps;
  const takerBps = row.taker_fee_ppm !== undefined ? fromPpm(row.taker_fee_ppm) : row.takerFeeBps;

  if (makerBps === undefined || takerBps === undefined) {
    return {
      makerFeeBps: dec(config.raw.FALLBACK_MAKER_FEE_BPS),
      takerFeeBps: dec(config.raw.FALLBACK_TAKER_FEE_BPS),
      source: 'fallback',
      note: 'fee tier table lacked rate columns; using configured fallback rates',
    };
  }

  return {
    makerFeeBps: dec(makerBps),
    takerFeeBps: dec(takerBps),
    source: 'table',
    note: `using the BASE tier (level ${levelOf(row)}${row.name ? `, ${row.name}` : ''}) because the account's realized volume tier is not readable`,
  };
}

/** True when the STOP_TRADING sentinel exists. Used by the CLI kill/reset paths. */
export function stopFileExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return true;
  }
}
