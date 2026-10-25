/**
 * Runtime configuration.
 *
 * Design rules, all of them safety-critical:
 *
 *  - **DRY_RUN is the default and LIVE_TRADING defaults to false.** There is no
 *    environment variable combination that turns on live trading implicitly.
 *    `liveTradingEnabled` additionally requires an explicit `--confirm-live` CLI
 *    flag, checked in `bootstrap`, so a stray `LIVE_TRADING=true` in a shell
 *    profile cannot arm the system on its own.
 *  - **Secrets are read lazily and never stored in the printed config.**
 *    `describeConfig()` is what gets logged; it renders secrets as
 *    `"<set>"/"<unset>"` only. The raw values live behind `secrets`.
 *  - **TARGET_VOLUME_USD is deliberately absent.** Volume is an output of real
 *    strategy trades, never an input. Setting a volume target is the definition of
 *    wash trading and is not representable in this config.
 *  - Anything the brief left blank (depth / spread / volume thresholds) is given
 *    an explicit, documented default and flagged as such, rather than left
 *    undefined and silently measuring against `NaN`.
 */

import { z } from 'zod';
import { registerSecret } from '../util/redact';

/** Thrown when configuration is missing or inconsistent. Fail closed, always. */
export class ConfigError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const boolFromEnv = z
  .union([z.boolean(), z.string()])
  .transform((value, ctx) => {
    if (typeof value === 'boolean') return value;
    const v = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true;
    if (['0', 'false', 'no', 'n', 'off', ''].includes(v)) return false;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `not a boolean: ${JSON.stringify(value)}` });
    return z.NEVER;
  });

const intFromEnv = (min: number, max: number) =>
  z
    .union([z.number(), z.string()])
    .transform((value, ctx) => {
      const n = typeof value === 'number' ? value : Number(value.trim());
      if (!Number.isInteger(n)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `not an integer: ${String(value)}` });
        return z.NEVER;
      }
      if (n < min || n > max) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `out of range [${min},${max}]: ${n}` });
        return z.NEVER;
      }
      return n;
    });

/**
 * Numeric input kept as a STRING all the way through.
 *
 * Config decimals (risk bps, thresholds) feed Decimal arithmetic; round-tripping
 * them through `number` first would introduce exactly the binary-float error the
 * decimal layer exists to avoid. Validated as a decimal string and left alone.
 */
const decimalFromEnv = z
  .union([z.number(), z.string()])
  .transform((value, ctx) => {
    const raw = typeof value === 'number' ? String(value) : value.trim();
    if (!/^-?\d+(\.\d+)?$/.test(raw)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `not a plain decimal: ${JSON.stringify(value)}` });
      return z.NEVER;
    }
    return raw;
  });

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

/* ------------------------------------------------------------------ *
 * Schema
 * ------------------------------------------------------------------ */

const tradeModeSchema = z.enum(['dry_run', 'shadow', 'live']).default('dry_run');
const logLevelSchema = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info');

export const configSchema = z
  .object({
    /* ---- environment ------------------------------------------------ */
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    /**
     * REST/WS origins. Mainnet is the default per the deployment decision; the
     * LIVE guard below, not the hostname, is what keeps this from trading.
     */
    ARCUS_REST_URL: z.string().url().default('https://api.arcus.xyz'),
    ARCUS_WS_URL: z.string().url().default('wss://api.arcus.xyz/v1/ws'),
    /** Testnet alternative, for reference:
     *  https://api.testnet.arcus.xyz + wss://api.testnet.arcus.xyz/v1/ws */

    ARCUS_WALLET_ADDRESS: optionalString,
    ARCUS_ACCOUNT_INDEX: intFromEnv(0, 9).default(0),

    /* ---- safety switches ------------------------------------------- */
    TRADING_MODE: tradeModeSchema,
    LIVE_TRADING: boolFromEnv.default(false),
    /** Master switch for order submission of any kind. */
    ALLOW_ORDER_SUBMISSION: boolFromEnv.default(true),
    /** Refuse to start if the REST host is a mainnet host without live flags. */
    REQUIRE_EXPLICIT_LIVE_CONFIRMATION: boolFromEnv.default(true),

    /* ---- risk ------------------------------------------------------- */
    MAX_LEVERAGE: decimalFromEnv.default('2'),
    RISK_PER_TRADE_BPS: decimalFromEnv.default('25'),
    DAILY_LOSS_LIMIT_BPS: decimalFromEnv.default('100'),
    MAX_NOTIONAL_PCT: decimalFromEnv.default('30'),
    MAX_OPEN_POSITIONS: intFromEnv(0, 50).default(1),
    MAX_MARKETS_PER_ACCOUNT: intFromEnv(1, 50).default(1),
    MAX_CONSECUTIVE_LOSSES: intFromEnv(1, 100).default(3),
    MAX_DATA_AGE_MS: intFromEnv(100, 600_000).default(3000),
    /** Recalibration trigger: equity move beyond this fraction pauses new entries. */
    EQUITY_CHANGE_PAUSE_BPS: decimalFromEnv.default('1000'),
    /** Absolute floor on free collateral below which no new position is sized. */
    MIN_FREE_COLLATERAL_USD: decimalFromEnv.default('50'),
    /** Safety reserve excluded from the theoretical withdrawable balance. */
    WITHDRAWABLE_SAFETY_RESERVE_PCT: decimalFromEnv.default('20'),
    /** Explicitly NOT configurable to a non-zero value by env; see config.ts guard. */
    TARGET_VOLUME_USD: decimalFromEnv.default('0'),
    ALLOW_AUTO_WITHDRAW: boolFromEnv.default(false),

    /* ---- strategy --------------------------------------------------- */
    TREND_TIMEFRAME: z.enum(['1h', '2h', '4h', '8h', '12h', '1d']).default('4h'),
    STRUCTURE_TIMEFRAME: z.enum(['15m', '30m', '1h', '2h', '4h']).default('1h'),
    TRIGGER_TIMEFRAME: z.enum(['5m', '15m', '30m']).default('15m'),
    EMA_FAST: intFromEnv(2, 400).default(9),
    EMA_MID: intFromEnv(2, 400).default(21),
    EMA_SLOW: intFromEnv(2, 400).default(50),
    ATR_PERIOD: intFromEnv(2, 200).default(14),
    /** Minimum bars of history before any signal is considered. */
    MIN_HISTORY_BARS: intFromEnv(50, 5000).default(250),
    /** ATR buffer added beyond the structural stop. */
    STOP_ATR_BUFFER: decimalFromEnv.default('0.5'),
    /** Max distance from EMA21, in ATRs, before a trend is "extended" and skipped. */
    MAX_EXTENSION_ATR: decimalFromEnv.default('3.0'),
    /** How far beyond the trigger bar's extreme we may chase with a limit order. */
    MAX_CHASE_ATR: decimalFromEnv.default('0.25'),
    /** Proximity to EMA21/AVWAP that counts as "in the pullback zone", in ATRs. */
    PULLBACK_ZONE_ATR: decimalFromEnv.default('1.0'),
    /** TP1 in R multiples, and the fraction closed there. */
    TP1_R_MULTIPLE: decimalFromEnv.default('2'),
    TP1_CLOSE_PCT: decimalFromEnv.default('50'),
    TP2_R_MULTIPLE: decimalFromEnv.default('3'),
    /** Trailing stop period on the remainder, in trigger-TF bars. */
    TRAIL_EMA_PERIOD: intFromEnv(2, 200).default(9),
    /** Bars a resting entry order may live before cancellation. */
    ENTRY_ORDER_TTL_BARS: intFromEnv(1, 100).default(4),

    /* ---- structure & target geometry ------------------------------- */
    /** Swing-confirmation window on the structure timeframe (bars each side). */
    SWING_LEFT_BARS: intFromEnv(1, 20).default(2),
    SWING_RIGHT_BARS: intFromEnv(1, 20).default(2),
    /** Bars scanned for swing structure / AVWAP anchoring. 0 = derive from MIN_HISTORY_BARS. */
    STRUCTURE_LOOKBACK_BARS: intFromEnv(0, 5000).default(0),
    /**
     * Fraction of the TP1 distance treated as realistically reachable. This is the
     * `expectedMove` the cost gate compares against total estimated cost; lowering it
     * makes the gate stricter.
     */
    PROJECTABLE_FRACTION: decimalFromEnv.default('0.6'),
    /** Assumed holding time, used to estimate the funding cost of a trade. */
    EXPECTED_HOLD_HOURS: decimalFromEnv.default('4'),
    /** Funding payment interval, in hours. Arcus is hourly. */
    FUNDING_INTERVAL_HOURS: decimalFromEnv.default('1'),

    /* ---- trailing exit -------------------------------------------- */
    /** Favourable move in R before the trailing stop may engage. */
    TRAIL_ACTIVATION_R: decimalFromEnv.default('0.5'),
    /** Buffer placed beyond the trailing EMA, in bps of price. */
    TRAIL_STOP_BUFFER_BPS: decimalFromEnv.default('5'),
    /** Protective bound placed around a stop trigger, in bps of the trigger price. */
    EMERGENCY_BOUND_BPS: decimalFromEnv.default('50'),

    /* ---- market selection ------------------------------------------ */
    PREFER_RWA: boolFromEnv.default(true),
    ALLOW_CRYPTO: boolFromEnv.default(true),
    ALLOW_RWA_OFF_HOURS: boolFromEnv.default(false),
    MAX_CANDIDATE_MARKETS: intFromEnv(1, 50).default(3),
    MAX_ACTIVE_MARKET: intFromEnv(1, 10).default(1),
    /** Defaulted by us; the brief left these blank. */
    MIN_ORDERBOOK_DEPTH_USD: decimalFromEnv.default('25000'),
    MAX_SPREAD_BPS: decimalFromEnv.default('8'),
    MIN_RECENT_VOLUME_USD: decimalFromEnv.default('100000'),
    /** Minimum 24h notional for a market to enter the candidate pool at all. */
    MIN_24H_NOTIONAL_USD: decimalFromEnv.default('250000'),
    /** Off-hours tightening multipliers applied when ALLOW_RWA_OFF_HOURS=true. */
    OFF_HOURS_SPREAD_MULTIPLIER: decimalFromEnv.default('0.5'),
    OFF_HOURS_DEPTH_MULTIPLIER: decimalFromEnv.default('2'),
    /**
     * Maximum concurrently ACTIVE markets.
     *
     * Validated to 1 at load time, because the runtime tracks a single `activeMarketId`
     * by construction. The setting is kept (rather than removed) so an operator raising
     * it gets a clear refusal instead of a silently ignored request.
     */
    /** Re-rank cadence; deliberately slow so markets are not churned. */
    MARKET_RERANK_INTERVAL_MS: intFromEnv(60_000, 86_400_000).default(3_600_000),
    /** A newly chosen market may not replace the active one before this. */
    MARKET_SWITCH_COOLDOWN_MS: intFromEnv(0, 86_400_000).default(6 * 3_600_000),

    /* ---- cost model ------------------------------------------------- */
    /** Assumed taker slippage in bps, used when the entry cannot be maker. */
    ASSUMED_SLIPPAGE_BPS: decimalFromEnv.default('3'),
    /** Safety multiplier applied to the whole cost estimate. */
    COST_SAFETY_BUFFER_BPS: decimalFromEnv.default('2'),
    /** Default maker/taker rates used only until the fee tier table is fetched. */
    FALLBACK_MAKER_FEE_BPS: decimalFromEnv.default('1.0'),
    FALLBACK_TAKER_FEE_BPS: decimalFromEnv.default('3.5'),

    /* ---- order execution ------------------------------------------- */
    /** Hard cap on a single order's notional, as a fraction of equity. */
    MAX_ORDER_NOTIONAL_PCT: decimalFromEnv.default('30'),
    /** Floor on order notional. The market's own `minOrderNotional` also applies. */
    MIN_ORDER_NOTIONAL_USD: decimalFromEnv.default('10'),
    /**
     * Maintenance-margin fraction used when a market payload omits it. Only affects
     * the reported liquidation distance and withdrawable balance, never sizing.
     */
    DEFAULT_MAINTENANCE_MARGIN_FRACTION: decimalFromEnv.default('0.005'),
    /** Stop-order trigger offset beyond the stop price, in bps of price. */
    STOP_TRIGGER_OFFSET_BPS: decimalFromEnv.default('5'),
    /** Good-til-time horizon for resting orders, in days (must exceed 30). */
    ORDER_GOOD_TIL_DAYS: intFromEnv(31, 180).default(60),
    /** Weight budget we allow ourselves against the 1500/min per-IP bucket. */
    RATE_LIMIT_WEIGHT_BUDGET_PER_MIN: intFromEnv(100, 1500).default(900),
    /** Refuse new entries when a per-subaccount pool drops below this. */
    MIN_ORDER_POOL_REMAINING: intFromEnv(0, 10_000).default(50),

    /* ---- liquidity scoring ---------------------------------------- */
    /** Band around mid used to measure usable book depth. */
    DEPTH_BAND_BPS: intFromEnv(1, 1000).default(25),
    /** Depth at `floor * multiple` scores 1.0. */
    DEPTH_SCORE_SATURATION_MULTIPLE: decimalFromEnv.default('10'),
    /** 24h notional at `floor * multiple` scores 1.0. */
    VOLUME_SCORE_SATURATION_MULTIPLE: decimalFromEnv.default('20'),
    /**
     * Component weights for `liquidityScore`. They are normalised at runtime, so only
     * their relative size matters; each must be >= 0 and the sum must be > 0.
     */
    SCORE_WEIGHT_SPREAD: decimalFromEnv.default('0.3'),
    SCORE_WEIGHT_DEPTH: decimalFromEnv.default('0.3'),
    SCORE_WEIGHT_VOLUME: decimalFromEnv.default('0.2'),
    SCORE_WEIGHT_FRESHNESS: decimalFromEnv.default('0.1'),
    SCORE_WEIGHT_FILL_QUALITY: decimalFromEnv.default('0.1'),
    /** Score for a market whose spread is wider than half the configured ceiling. */
    SCORE_FILL_QUALITY_PARTIAL: decimalFromEnv.default('0.5'),
    /** Markets quoted per tick purely to inform ranking. */
    MAX_BREADTH_QUOTES: intFromEnv(1, 100).default(12),
    /** Orderbook fetches allowed per ranking pass. */
    MAX_ORDERBOOK_FETCHES: intFromEnv(1, 100).default(12),
    /**
     * When true (default), an unreadable `GET /v1/rateLimit` blocks new entries.
     * Set false only if the account is not whitelisted for that endpoint (403),
     * since otherwise no entry could ever be placed. Observed-429 handling and the
     * local weight budget still apply either way.
     */
    REQUIRE_ORDER_POOL_READ: boolFromEnv.default(true),

    /* ---- Lark reporting -------------------------------------------- */
    LARK_BASE_URL: z.string().url().default('https://open.larksuite.com'),
    LARK_CHAT_ID: optionalString,
    REPORT_TIMEZONE: z.string().default('Asia/Shanghai'),
    REPORT_CRON: z.string().default('0 9 * * *'),
    REPORT_ENABLED: boolFromEnv.default(true),
    /** Retry cadence for the local outbox. */
    LARK_OUTBOX_RETRY_MS: intFromEnv(10_000, 3_600_000).default(300_000),

    /* ---- persistence / logging ------------------------------------- */
    DB_PATH: z.string().default('./data/arcustrader.db'),
    LOG_LEVEL: logLevelSchema,
    LOG_PRETTY: boolFromEnv.default(false),
    /** STOP_TRADING sentinel file; presence halts new entries. */
    STOP_FILE: z.string().default('./STOP_TRADING'),
    /** Fail-closed if the trailing market-metadata refresh is older than this. */
    MAX_MARKET_METADATA_AGE_MS: intFromEnv(1000, 3_600_000).default(300_000),
    HEALTHCHECK_PORT: intFromEnv(0, 65_535).default(0),
    /** Decision-loop interval. */
    TICK_INTERVAL_MS: intFromEnv(500, 300_000).default(5_000),
    /** Candle-history refresh interval. */
    CANDLE_REFRESH_MS: intFromEnv(10_000, 3_600_000).default(60_000),
    /** How often the daily-report gate is evaluated. */
    REPORT_CHECK_INTERVAL_MS: intFromEnv(10_000, 3_600_000).default(60_000),
    /** Include the consolidated multi-subaccount balance/ROI block in the report. */
    REPORT_INCLUDE_ACCOUNT_OVERVIEW: boolFromEnv.default(true),
    /** Include affiliate/referral standing (referral volume is wallet-level). */
    REPORT_INCLUDE_AFFILIATE: boolFromEnv.default(true),
    /**
     * Highest `accountIndex` scanned for the overview. Arcus allows 0-9; unused
     * indexes return 404 and are skipped, so scanning the full range is cheap.
     */
    ACCOUNT_OVERVIEW_MAX_INDEX: intFromEnv(0, 9).default(9),
    /** Health endpoint stale-loop threshold. 0 = derive from TICK_INTERVAL_MS. */
    HEALTH_STALL_THRESHOLD_MS: intFromEnv(0, 86_400_000).default(0),

    /* ---- transport resilience ------------------------------------- */
    /** Per-request HTTP timeout. */
    HTTP_TIMEOUT_MS: intFromEnv(500, 120_000).default(10_000),
    /** Consecutive 429s before the client stops issuing that class of request. */
    CIRCUIT_BREAKER_THRESHOLD: intFromEnv(1, 100).default(3),
    CIRCUIT_BREAKER_COOLDOWN_MS: intFromEnv(100, 600_000).default(2_000),
    CIRCUIT_BREAKER_MAX_COOLDOWN_MS: intFromEnv(1_000, 3_600_000).default(60_000),
    /** How long a per-subaccount pool reading stays trustworthy. */
    POOL_STATE_MAX_AGE_MS: intFromEnv(1_000, 3_600_000).default(300_000),

    /* ---- Lark transport ------------------------------------------- */
    LARK_MAX_ATTEMPTS: intFromEnv(1, 10).default(4),
    LARK_BASE_BACKOFF_MS: intFromEnv(50, 30_000).default(500),
    LARK_REQUEST_TIMEOUT_MS: intFromEnv(1_000, 120_000).default(10_000),
  })
  /**
   * Unknown keys are STRIPPED, not rejected.
   *
   * `loadConfig` is handed the whole process environment, which always contains
   * PATH, HOME, TERM and whatever the supervisor injects. Rejecting unknowns made
   * startup fail on `PATH`, which is a usability bug whose only effect is to train
   * operators to weaken validation. The strictness that actually matters — the
   * cross-field safety checks (volume target, auto-withdraw, live-flag
   * consistency, timeframe ordering) — lives in `loadConfig` below.
   */
  .strip();

export type RawConfig = z.infer<typeof configSchema>;

/* ------------------------------------------------------------------ *
 * Secrets — kept out of the logged config
 * ------------------------------------------------------------------ */

/**
 * Credentials, held separately from `RawConfig` so there is no code path that
 * logs the config object and accidentally emits a private key or app secret.
 * Never serialise, never interpolate into a log message, never persist.
 */
export interface Secrets {
  /** 32-byte Ed25519 seed as hex. Signs every mutating request. */
  readonly arcusApiSigningKey?: string;
  /** API key = hex public key. Derived from the signing key when absent. */
  readonly arcusApiKey?: string;
  readonly larkAppId?: string;
  readonly larkAppSecret?: string;
}

export interface Config {
  readonly raw: RawConfig;
  readonly secrets: Secrets;
  /** True when the process may submit orders at all. */
  readonly orderSubmissionAllowed: boolean;
  /** True only when TRADING_MODE=live AND LIVE_TRADING=true. */
  readonly liveRequested: boolean;
  /** Non-fatal notes surfaced in the daily report and at startup. */
  readonly notes: readonly string[];
}

/** Re-exported so existing importers keep working; the implementation lives in
 * `src/util/redact.ts` to avoid a config <-> logger import cycle. */
export {
  registerSecret,
  redactValue,
  redactString,
  looksLikeHexSecret,
  registeredSecretCount,
  SECRET_KEYS,
} from '../util/redact';

/**
 * Build a Config from an environment-like record.
 *
 * Validation failures are collected and thrown together, so a misconfigured VPS
 * reports every problem in one pass instead of one restart at a time.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (i) => `${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new ConfigError(issues);
  }
  const raw = parsed.data;
  const notes: string[] = [];
  const issues: string[] = [];

  /* --- secrets ---------------------------------------------------- */
  const secrets: Secrets = {
    arcusApiSigningKey: env.ARCUS_API_SIGNING_KEY?.trim() || undefined,
    arcusApiKey: env.ARCUS_API_KEY?.trim() || undefined,
    larkAppId: env.LARK_APP_ID?.trim() || undefined,
    larkAppSecret: env.LARK_APP_SECRET?.trim() || undefined,
  };

  /* --- register credentials so no code path can log them ---------- */
  // Registered from the parsed values, so a secret that reaches a log line by any
  // route (including a third party echoing it) is scrubbed.
  registerSecret(secrets.arcusApiSigningKey);
  registerSecret(secrets.arcusApiKey);
  registerSecret(secrets.larkAppSecret);
  registerSecret(secrets.larkAppId);

  /* --- refuse a volume target ------------------------------------- */
  if (!raw.TARGET_VOLUME_USD.match(/^0(\.0+)?$/)) {
    issues.push(
      'TARGET_VOLUME_USD must be 0. Trading volume is a by-product of real strategy ' +
        'trades, never a target; targeting volume is wash trading.',
    );
  }
  if (raw.ALLOW_AUTO_WITHDRAW) {
    issues.push('ALLOW_AUTO_WITHDRAW must be false. This system never withdraws automatically.');
  }

  /* --- live-mode consistency -------------------------------------- */
  const liveRequested = raw.TRADING_MODE === 'live' && raw.LIVE_TRADING;
  if (raw.LIVE_TRADING && raw.TRADING_MODE !== 'live') {
    issues.push(
      `LIVE_TRADING=true requires TRADING_MODE=live (got TRADING_MODE=${raw.TRADING_MODE}).`,
    );
  }
  if (liveRequested && !secrets.arcusApiSigningKey) {
    issues.push('live mode requires ARCUS_API_SIGNING_KEY.');
  }
  if (liveRequested && !raw.ARCUS_WALLET_ADDRESS) {
    issues.push('live mode requires ARCUS_WALLET_ADDRESS.');
  }

  /* --- address sanity --------------------------------------------- */
  if (raw.ARCUS_WALLET_ADDRESS && !/^(0x|0X)?[0-9a-fA-F]{40}$/.test(raw.ARCUS_WALLET_ADDRESS)) {
    issues.push(
      `ARCUS_WALLET_ADDRESS is not a 20-byte hex address: ${raw.ARCUS_WALLET_ADDRESS.slice(0, 10)}…`,
    );
  }

  /* --- timeframe ordering ----------------------------------------- */
  const order = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d', '3d', '1w'];
  const idx = (tf: string) => order.indexOf(tf);
  if (!(idx(raw.STRUCTURE_TIMEFRAME) < idx(raw.TREND_TIMEFRAME))) {
    issues.push(
      `STRUCTURE_TIMEFRAME (${raw.STRUCTURE_TIMEFRAME}) must be lower than TREND_TIMEFRAME (${raw.TREND_TIMEFRAME}).`,
    );
  }
  if (!(idx(raw.TRIGGER_TIMEFRAME) < idx(raw.STRUCTURE_TIMEFRAME))) {
    issues.push(
      `TRIGGER_TIMEFRAME (${raw.TRIGGER_TIMEFRAME}) must be lower than STRUCTURE_TIMEFRAME (${raw.STRUCTURE_TIMEFRAME}).`,
    );
  }
  // NOTE: `TRIGGER_TIMEFRAME` deliberately excludes '1m' at the schema level, so
  // a 1-minute primary trigger is not merely discouraged but unrepresentable.
  // That is the brief's "第一版禁止使用 1 分钟作为主要触发周期" made structural.

  /* --- EMA ordering ------------------------------------------------ */
  if (!(raw.EMA_FAST < raw.EMA_MID && raw.EMA_MID < raw.EMA_SLOW)) {
    issues.push(
      `EMA periods must satisfy EMA_FAST < EMA_MID < EMA_SLOW (got ${raw.EMA_FAST}/${raw.EMA_MID}/${raw.EMA_SLOW}).`,
    );
  }

  /* --- numeric ranges --------------------------------------------- */
  const dec = (s: string) => Number(s);
  if (!(dec(raw.RISK_PER_TRADE_BPS) > 0)) issues.push('RISK_PER_TRADE_BPS must be > 0.');
  if (!(dec(raw.DAILY_LOSS_LIMIT_BPS) > 0)) issues.push('DAILY_LOSS_LIMIT_BPS must be > 0.');
  if (!(dec(raw.MAX_LEVERAGE) > 0) || dec(raw.MAX_LEVERAGE) > 20) {
    issues.push('MAX_LEVERAGE must be in (0, 20].');
  }
  if (dec(raw.RISK_PER_TRADE_BPS) > 2000) {
    issues.push('RISK_PER_TRADE_BPS above 2000 (20% per trade) is refused as a misconfiguration.');
  }
  if (!(dec(raw.MAX_NOTIONAL_PCT) > 0) || dec(raw.MAX_NOTIONAL_PCT) > 100) {
    issues.push('MAX_NOTIONAL_PCT must be in (0, 100].');
  }
  if (dec(raw.TP1_CLOSE_PCT) <= 0 || dec(raw.TP1_CLOSE_PCT) >= 100) {
    issues.push('TP1_CLOSE_PCT must be in (0, 100).');
  }
  if (dec(raw.TP2_R_MULTIPLE) < dec(raw.TP1_R_MULTIPLE)) {
    issues.push('TP2_R_MULTIPLE must be >= TP1_R_MULTIPLE.');
  }
  if (dec(raw.MIN_ORDERBOOK_DEPTH_USD) <= 0) {
    issues.push('MIN_ORDERBOOK_DEPTH_USD must be > 0.');
  }
  if (dec(raw.MIN_RECENT_VOLUME_USD) <= 0) {
    issues.push('MIN_RECENT_VOLUME_USD must be > 0.');
  }
  /* --- new geometry / scoring guards ------------------------------- */
  {
    const projectable = Number(raw.PROJECTABLE_FRACTION);
    if (!(projectable > 0) || projectable > 1) {
      issues.push('PROJECTABLE_FRACTION must be within (0, 1].');
    }
    if (Number(raw.TRAIL_ACTIVATION_R) < 0) {
      issues.push('TRAIL_ACTIVATION_R must be >= 0.');
    }
    if (!(Number(raw.MIN_ORDER_NOTIONAL_USD) > 0)) {
      issues.push('MIN_ORDER_NOTIONAL_USD must be > 0.');
    }
    const mmf = Number(raw.DEFAULT_MAINTENANCE_MARGIN_FRACTION);
    if (!(mmf > 0) || mmf >= 1) {
      issues.push('DEFAULT_MAINTENANCE_MARGIN_FRACTION must be within (0, 1).');
    }
    if (!(Number(raw.EXPECTED_HOLD_HOURS) > 0)) {
      issues.push('EXPECTED_HOLD_HOURS must be > 0.');
    }
    if (!(Number(raw.FUNDING_INTERVAL_HOURS) > 0)) {
      issues.push('FUNDING_INTERVAL_HOURS must be > 0.');
    }
    const weights = [
      raw.SCORE_WEIGHT_SPREAD,
      raw.SCORE_WEIGHT_DEPTH,
      raw.SCORE_WEIGHT_VOLUME,
      raw.SCORE_WEIGHT_FRESHNESS,
      raw.SCORE_WEIGHT_FILL_QUALITY,
    ].map(Number);
    if (weights.some((w) => w < 0)) {
      issues.push('SCORE_WEIGHT_* values must be >= 0.');
    }
    if (weights.reduce((a, b) => a + b, 0) <= 0) {
      // All-zero weights would make every market score 0 and rank arbitrarily.
      issues.push('SCORE_WEIGHT_* values must not all be zero.');
    }
    if (Number(raw.CIRCUIT_BREAKER_MAX_COOLDOWN_MS) < Number(raw.CIRCUIT_BREAKER_COOLDOWN_MS)) {
      issues.push('CIRCUIT_BREAKER_MAX_COOLDOWN_MS must be >= CIRCUIT_BREAKER_COOLDOWN_MS.');
    }
  }

  if (raw.MAX_ACTIVE_MARKET !== 1) {
    // Refusing beats ignoring: the runtime holds one active market, so a larger value
    // would be a request the system silently cannot honour.
    issues.push(
      `MAX_ACTIVE_MARKET must be 1 (got ${raw.MAX_ACTIVE_MARKET}). This build tracks a single ` +
        'active market; the configured maximum would otherwise be silently ignored.',
    );
  }

  /* --- mainnet guard ---------------------------------------------- */
  const isMainnetHost = /(^|\.)api\.arcus\.xyz$/.test(new URL(raw.ARCUS_REST_URL).hostname);
  if (isMainnetHost && !liveRequested) {
    notes.push(
      `REST host is MAINNET (${raw.ARCUS_REST_URL}) but mode is ${raw.TRADING_MODE}. ` +
        'Orders are disabled; public market data will be read from mainnet.',
    );
  }
  if (!isMainnetHost) {
    notes.push(`REST host is non-mainnet (${raw.ARCUS_REST_URL}).`);
  }

  /* --- Lark notes -------------------------------------------------- */
  if (raw.REPORT_ENABLED && (!secrets.larkAppId || !secrets.larkAppSecret || !raw.LARK_CHAT_ID)) {
    notes.push(
      'Lark reporting is enabled but LARK_APP_ID / LARK_APP_SECRET / LARK_CHAT_ID are incomplete; ' +
        'reports will queue to the local outbox and be retried.',
    );
  }

  if (issues.length) throw new ConfigError(issues);

  const orderSubmissionAllowed =
    raw.ALLOW_ORDER_SUBMISSION && raw.TRADING_MODE !== 'dry_run' ? true : raw.ALLOW_ORDER_SUBMISSION;

  return {
    raw,
    secrets,
    // In dry_run, order submission is refused regardless of other flags.
    orderSubmissionAllowed: raw.TRADING_MODE === 'dry_run' ? false : orderSubmissionAllowed,
    liveRequested,
    notes,
  };
}

/**
 * A loggable view of the configuration.
 *
 * Contains no secret material: credential presence is reported as a boolean. This
 * is the only form of the config that may be written to logs or the database.
 */
export function describeConfig(config: Config): Record<string, unknown> {
  const { raw, secrets, notes, liveRequested, orderSubmissionAllowed } = config;
  return {
    ...raw,
    liveRequested,
    orderSubmissionAllowed,
    secretsPresent: {
      arcusApiSigningKey: Boolean(secrets.arcusApiSigningKey),
      arcusApiKey: Boolean(secrets.arcusApiKey),
      larkAppId: Boolean(secrets.larkAppId),
      larkAppSecret: Boolean(secrets.larkAppSecret),
    },
    notes,
  };
}

/** Convenience accessor with the decimal-as-string ergonomics callers expect. */
export const cfg = {
  decimal: (v: string) => v,
} as const;
