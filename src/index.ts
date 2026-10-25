#!/usr/bin/env node
/**
 * CLI entrypoint.
 *
 * Usage:
 *   arcus-trader dry-run     [--once] [--ticks N]     (default; no orders ever)
 *   arcus-trader shadow      [--once]                 (full pipeline, no orders)
 *   arcus-trader live        --confirm-live           (REQUIRED to submit orders)
 *   arcus-trader reconcile                             (read + reconcile, then exit)
 *   arcus-trader preflight                             (self-test, then exit)
 *   arcus-trader report      --once                    (render + send one report)
 *   arcus-trader kill        [--reason "..."]         (engage the kill switch)
 *   arcus-trader reset-kill                            (clear file + automatic latch)
 *
 * `live` demands `--confirm-live` in addition to LIVE_TRADING=true and
 * TRADING_MODE=live. That redundancy is intentional: it forces a human to type
 * the flag at start time rather than inheriting "live" from an env file.
 */

import { bootstrap, runStartupSequence, type RunMode } from './app/bootstrap';
import { Runtime } from './app/runtime';
import { ArcusSigner } from './arcus/ArcusSigner';
import { createLogger, describeSecret, silentLogger } from './util/logger';
import { dec, toFixedString } from './util/decimal';
import { renderReportText } from './notifications/DailyReport';
import { ArcusHttpError, ArcusRateLimitError, ArcusValidationError, ppmToBps } from './arcus/ArcusRestClient';

interface CliArgs {
  readonly mode: RunMode;
  readonly confirmLive: boolean;
  readonly once: boolean;
  readonly ticks: number | undefined;
  readonly reason: string | undefined;
  readonly help: boolean;
}

const MODES: readonly RunMode[] = [
  'dry-run',
  'shadow',
  'live',
  'reconcile',
  'preflight',
  'report',
  'kill',
  'reset-kill',
];

export function parseArgs(argv: readonly string[]): CliArgs {
  const args = argv.slice(2);
  let mode: RunMode = 'dry-run';
  let modeSet = false;
  let confirmLive = false;
  let once = false;
  let ticks: number | undefined;
  let reason: string | undefined;
  let help = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--confirm-live') {
      confirmLive = true;
      continue;
    }
    if (arg === '--once') {
      once = true;
      continue;
    }
    if (arg === '--ticks') {
      const raw = args[i + 1];
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`--ticks requires a positive integer, got ${JSON.stringify(raw)}`);
      }
      ticks = parsed;
      i += 1;
      continue;
    }
    if (arg === '--reason') {
      const raw = args[i + 1];
      if (raw === undefined) throw new Error('--reason requires a value');
      reason = raw;
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`unknown flag ${arg}. Use --help.`);
    }
    if (MODES.includes(arg as RunMode)) {
      mode = arg as RunMode;
      modeSet = true;
      continue;
    }
    throw new Error(`unknown mode ${JSON.stringify(arg)}. Valid modes: ${MODES.join(', ')}`);
  }
  void modeSet;
  return { mode, confirmLive, once, ticks, reason, help };
}

function usage(): string {
  return [
    'ArcusTrader — Arcus Perpetuals pullback system',
    '',
    'Usage: arcus-trader <mode> [options]',
    '',
    'Modes:',
    '  dry-run      (default) Read live data, evaluate fully, submit NOTHING.',
    '  shadow       Same as dry-run but exercises the full decision pipeline.',
    '  live         Submit orders. Requires --confirm-live, LIVE_TRADING=true, TRADING_MODE=live.',
    '  reconcile    Read account/positions/openOrders, reconcile, print the verdict, exit.',
    '  preflight    Self-test config, signing, connectivity and credentials, then exit.',
    '  report       Render and send one daily report, then exit.',
    '  kill         Engage the kill switch (writes the STOP_TRADING sentinel).',
    '  reset-kill   Clear the sentinel and the automatic latch.',
    '',
    'Options:',
    '  --confirm-live   Required for live order submission.',
    '  --once           Run one tick (or one report) and exit.',
    '  --ticks N        Run N ticks and exit.',
    '  --reason "..."   Reason string for `kill`.',
    '  --help, -h       Show this help.',
    '',
    'Safety: DRY_RUN is the default. No environment variable combination enables',
    'live trading without an explicit --confirm-live on the command line.',
  ].join('\n');
}

async function main(): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usage()}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  /* ---- reset-kill needs no bootstrap (and must work when config is broken) ---- */
  if (args.mode === 'reset-kill') {
    // Load config directly so a broken unrelated value cannot block clearing the halt.
    const { loadConfig } = await import('./config/config');
    const { KillSwitch } = await import('./risk/KillSwitch');
    const logger = silentLogger();
    let stopPath = './STOP_TRADING';
    try {
      stopPath = loadConfig(process.env).raw.STOP_FILE;
    } catch {
      process.stdout.write('warning: configuration is invalid; using the default stop path ./STOP_TRADING\n');
    }
    const killSwitch = new KillSwitch({ stopFilePath: stopPath, logger });
    const result = killSwitch.clearStopFile();
    process.stdout.write(
      result.cleared
        ? `kill switch cleared (removed ${stopPath} if present; automatic latch reset)\n`
        : `failed to clear kill switch: ${result.error}\n`,
    );
    return result.cleared ? 0 : 1;
  }

  /* ---- kill can also work with minimal config ------------------------------- */
  if (args.mode === 'kill') {
    const { loadConfig } = await import('./config/config');
    const { KillSwitch } = await import('./risk/KillSwitch');
    const logger = silentLogger();
    const reason = args.reason ?? 'engaged manually via CLI';
    let stopPath = './STOP_TRADING';
    try {
      stopPath = loadConfig(process.env).raw.STOP_FILE;
    } catch {
      process.stdout.write('warning: configuration is invalid; using the default stop path ./STOP_TRADING\n');
    }
    const killSwitch = new KillSwitch({ stopFilePath: stopPath, logger });
    killSwitch.writeStopFile(reason);
    process.stdout.write(`kill switch engaged: ${reason}\nNew positions are blocked. Run \`reset-kill\` to clear.\n`);
    return 0;
  }

  /* ---- full bootstrap ------------------------------------------------------- */
  let context;
  try {
    context = bootstrap({ mode: args.mode, confirmLive: args.confirmLive, argv: process.argv });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const { logger, killSwitch } = context;

  try {
    switch (args.mode) {
      case 'preflight':
        return await runPreflight(context);
      case 'reconcile':
        return await runReconcile(context);
      case 'report':
        return await runReport(context, true);
      case 'dry-run':
      case 'shadow':
      case 'live': {
        if (killSwitch.engaged) {
          logger.error(
            { source: killSwitch.status.source, reason: killSwitch.status.reason },
            'kill switch is engaged; new positions are blocked (existing positions will still be managed)',
          );
        }
        const runtime = new Runtime(context, {
          once: args.once,
          ...(args.ticks !== undefined ? { maxTicks: args.ticks } : {}),
        });
        const shutdown = (): void => {
          logger.warn('shutdown signal received; stopping after the current tick');
          runtime.stop();
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
        process.on('unhandledRejection', (reason) => {
          logger.error({ err: String(reason) }, 'unhandled rejection; continuing (fail-closed checks still apply)');
        });
        const startup = await runtime.start();
        if (args.once) {
          process.stdout.write(`${JSON.stringify(startup, null, 2)}\n`);
        }
        return 0;
      }
      default: {
        process.stderr.write(`unhandled mode ${String(args.mode)}\n`);
        return 2;
      }
    }
  } catch (error) {
    logger.fatal(
      { err: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined },
      'fatal error',
    );
    return 1;
  } finally {
    if (args.mode !== 'dry-run' && args.mode !== 'shadow' && args.mode !== 'live') {
      // The runtime closes the store itself on normal shutdown.
      try {
        context.store.close();
      } catch {
        /* already closed */
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * preflight
 * ------------------------------------------------------------------ */

/**
 * Self-test.
 *
 * Proves the things that are cheap to prove locally and expensive to discover in
 * production: the signing key is usable and matches the configured API key, the
 * canonicaliser is deterministic, the REST host answers, credentials authenticate
 * (or fail with a clear status). Exits non-zero when a REQUIRED check fails.
 */
export async function runPreflight(context: Awaited<ReturnType<typeof bootstrap>>): Promise<number> {
  const { logger, config, rest } = context;
  let failures = 0;
  const lines: string[] = [];

  /* 1. config */
  lines.push(
    `[ok]   configuration validated (mode=${config.raw.TRADING_MODE}, ` +
      `strategy=${config.raw.STRATEGY_MODE} ${config.raw.TREND_TIMEFRAME}/${config.raw.STRUCTURE_TIMEFRAME}/${config.raw.TRIGGER_TIMEFRAME}, ` +
      `live=${config.liveRequested})`,
  );
  for (const note of config.notes) lines.push(`[note] ${note}`);

  /* 2. kill switch */
  lines.push(
    context.killSwitch.engaged
      ? `[warn] kill switch is ENGAGED (${context.killSwitch.status.reason ?? 'no reason'})`
      : '[ok]   kill switch is clear',
  );

  /* 3. signing */
  if (config.secrets.arcusApiSigningKey) {
    try {
      ArcusSigner.resetClockState();
      const signer = new ArcusSigner({
        signingKeyHex: config.secrets.arcusApiSigningKey,
        ...(config.secrets.arcusApiKey ? { expectedApiKeyHex: config.secrets.arcusApiKey } : {}),
      });
      const payload = { ad: '0x'.padEnd(42, '1'), ai: 0, ct: signer.nowNanos(), m: 1, op: 2, v: 1 };
      const first = signer.signTypedPayload(payload);
      const second = signer.signTypedPayload(payload);
      const deterministic = first.signature === second.signature;
      const verifies = signer.verifyMessage(first.message, first.signature);
      lines.push(
        `[ok]   signing key loaded (${describeSecret(signer.apiKeyHex)}); canonicalisation deterministic=${deterministic}; self-verify=${verifies}`,
      );
      if (!deterministic || !verifies) {
        failures += 1;
        lines.push('[FAIL] signature is not deterministic or does not verify');
      }
      if (config.secrets.arcusApiKey) {
        lines.push('[ok]   ARCUS_API_KEY matches the key derived from ARCUS_API_SIGNING_KEY');
      }
    } catch (error) {
      failures += 1;
      lines.push(`[FAIL] signing key unusable: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    lines.push('[warn] ARCUS_API_SIGNING_KEY is unset: only public reads are possible (fine for dry-run)');
  }

  /* 4. REST connectivity */
  try {
    const started = Date.now();
    await rest.health();
    lines.push(`[ok]   REST /health reachable at ${config.raw.ARCUS_REST_URL} (${Date.now() - started}ms)`);
  } catch (error) {
    failures += 1;
    lines.push(`[FAIL] REST /health unreachable: ${error instanceof Error ? error.message : String(error)}`);
  }

  /* 5. markets + server clock */
  try {
    const markets = await rest.getMarkets();
    lines.push(`[ok]   GET /v1/markets returned ${markets.length} markets`);
    const categories = new Map<string, number>();
    for (const market of markets) {
      categories.set(market.category, (categories.get(market.category) ?? 0) + 1);
      if (market.isOutsideRth) {
        // Reading the flag proves the off-hours input is present and live.
      }
    }
    lines.push(`[ok]   market categories: ${[...categories.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`);
    const outsideRth = markets.filter((m) => m.isOutsideRth).length;
    lines.push(`[info] markets currently outside RTH: ${outsideRth}/${markets.length}`);
  } catch (error) {
    failures += 1;
    lines.push(`[FAIL] markets read failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const time = await rest.serverTimeNanos();
    const skewMs = Math.abs(Number(BigInt(time) / 1_000_000n) - Date.now());
    lines.push(
      skewMs < 30_000
        ? `[ok]   server clock skew ${skewMs}ms (within the +/-30,000ms signing window)`
        : `[FAIL] server clock skew ${skewMs}ms exceeds the +/-30,000ms signing window`,
    );
    if (skewMs >= 30_000) failures += 1;
  } catch (error) {
    lines.push(`[warn] server time read failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  /* 6. authenticated read (proves the key authenticates) */
  const address = config.raw.ARCUS_WALLET_ADDRESS;
  if (address) {
    try {
      const account = await rest.getAccount(address, config.raw.ARCUS_ACCOUNT_INDEX);
      lines.push(
        account
          ? `[ok]   GET /v1/account ok: equity=${account.equity} freeCollateral=${account.freeCollateral}`
          : '[info] GET /v1/account returned 404 (account has no activity yet)',
      );
      const positions = await rest.getPositions(address, config.raw.ARCUS_ACCOUNT_INDEX);
      lines.push(`[ok]   GET /v1/positions ok: ${positions.length} position row(s)`);
      const orders = await rest.getOpenOrders({ address, accountIndex: config.raw.ARCUS_ACCOUNT_INDEX });
      lines.push(`[ok]   GET /v1/openOrders ok: ${orders.length} open order(s)`);
      const pool = await rest.getRateLimit({ address, accountIndex: config.raw.ARCUS_ACCOUNT_INDEX });
      lines.push(
        `[ok]   GET /v1/rateLimit ok: order pool ${pool.order?.remaining ?? '?'}/${pool.order?.capacity ?? '?'}, ` +
          `cancel pool ${pool.cancel?.remaining ?? '?'}/${pool.cancel?.capacity ?? '?'}`,
      );
    } catch (error) {
      const detail = describeArcusError(error);
      failures += 1;
      lines.push(`[FAIL] account read failed: ${detail}`);
    }
  } else {
    lines.push('[warn] ARCUS_WALLET_ADDRESS is unset; account checks skipped');
  }

  /* 7. fee tiers */
  try {
    const fees = await rest.getFeeTiers();
    const first = fees.feeTiers[0];
    // The live payload quotes fees in ppm (`maker_fee_ppm`); the spec uses bps-named
    // fields. Report whichever is present, always converted to bps, so the unit on
    // screen is unambiguous — reading 225 ppm as 225 bps would be a 100x error.
    const makerBps =
      first?.maker_fee_ppm !== undefined ? ppmToBps(first.maker_fee_ppm) : (first?.makerFeeBps ?? '?');
    const takerBps =
      first?.taker_fee_ppm !== undefined ? ppmToBps(first.taker_fee_ppm) : (first?.takerFeeBps ?? '?');
    lines.push(
      first
        ? `[ok]   GET /v1/feetiers ok: ${fees.feeTiers.length} tier(s), base tier ` +
            `maker=${makerBps}bps taker=${takerBps}bps` +
            `${first.maker_fee_ppm !== undefined ? ' (converted from ppm)' : ''}`
        : '[warn] GET /v1/feetiers returned no tiers; the cost model will use configured fallback rates',
    );
  } catch (error) {
    lines.push(`[warn] fee tiers unavailable: ${describeArcusError(error)}`);
  }

  /* 7b. affiliate / referral standing — SIGNED read
   *
   * Read-only, but it needs the Ed25519 key: `X-API-Key` alone proves nothing because
   * API keys are public keys that anyone can list. Two things this establishes that
   * nothing else can:
   *
   *  - that the configured key can produce a signature the venue accepts (the first
   *    end-to-end proof of the signing path short of placing an order), and
   *  - the wallet-level 30-day volume and fee tier, which the account endpoints do not
   *    expose. `/v1/affiliate/info` takes no accountIndex, so its volume spans every
   *    subaccount — unlike the fee-tier volume credit, which is per subaccount.
   */
  if (!address) {
    lines.push('[note] GET /v1/affiliate/info skipped: ARCUS_WALLET_ADDRESS is unset');
  } else {
    try {
      const affiliate = await rest.getAffiliateInfo(address);
      // Deliberately NOT described as proof that signing works: verified live on
      // 2026-10-25, this endpoint returns 200 with NO auth headers at all (see
      // docs/API_CONTRACTS.md §9.15). It reports standing; it does not verify the key.
      lines.push(
        `[ok]   GET /v1/affiliate/info ok: fee tier level ${affiliate.tradingFeeTier?.level ?? affiliate.tier}` +
          `${affiliate.tradingFeeTier?.makerFeeBps !== undefined ? `, maker ${affiliate.tradingFeeTier.makerFeeBps.toString()}bps` : ''}` +
          `${affiliate.tradingFeeTier?.takerFeeBps !== undefined ? `, taker ${affiliate.tradingFeeTier.takerFeeBps.toString()}bps` : ''}`,
      );
      lines.push(
        `[info] 30d own volume (wallet-level, includes every subaccount): $${affiliate.volume30dUsd.toFixed(2)}` +
          ` | referral code: ${affiliate.code === '' ? 'none' : affiliate.code}` +
          ` | referees: ${affiliate.traderCount}`,
      );
      lines.push(
        `[info] commission: lifetime $${affiliate.totalCommissionUsd.toFixed(2)}` +
          ` | pending $${affiliate.pendingCommissionUsd.toFixed(2)}` +
          ` | 30d $${affiliate.commission30dUsd.toFixed(2)}`,
      );
    } catch (error) {
      // 404 simply means the wallet has no affiliate record yet, which is normal for a
      // trading-only account and is not a failure.
      const isNotFound =
        error instanceof ArcusHttpError ? error.status === 404 : /404/.test(describeArcusError(error));
      const unauthorised =
        error instanceof ArcusHttpError ? error.status === 401 : /\b401\b/.test(describeArcusError(error));
      lines.push(
        isNotFound
          ? '[info] GET /v1/affiliate/info returned 404: no affiliate record for this wallet (normal)'
          : unauthorised
            ? '[warn] GET /v1/affiliate/info now REQUIRES auth (it did not on 2026-10-25); ' +
              'set a signing key to keep the referral readout'
            : `[warn] GET /v1/affiliate/info failed: ${describeArcusError(error)}`,
      );
    }
  }

  /* 8. Lark */
  if (config.raw.REPORT_ENABLED) {
    if (!context.larkClient.configured) {
      lines.push('[warn] Lark reporting enabled but LARK_APP_ID / LARK_APP_SECRET / LARK_CHAT_ID are incomplete');
    } else {
      lines.push(`[ok]   Lark credentials present (chatId set, appId ${describeSecret(config.secrets.larkAppId)})`);
      lines.push('[info] no test message is sent by preflight; the first report validates delivery end-to-end');
    }
  }

  /* 9. live-arm summary */
  lines.push(
    context.orderSubmissionAllowed
      ? '[ok]   ORDER SUBMISSION IS ARMED (live)'
      : '[ok]   order submission is disabled (safe default)',
  );

  const output = lines.join('\n');
  process.stdout.write(`${output}\n`);
  process.stdout.write(
    failures === 0
      ? '\npreflight: PASS\n'
      : `\npreflight: FAIL (${failures} problem(s))\n`,
  );
  logger.info({ failures, checks: lines.length }, 'preflight complete');
  return failures === 0 ? 0 : 1;
}

/* ------------------------------------------------------------------ *
 * reconcile
 * ------------------------------------------------------------------ */

async function runReconcile(context: Awaited<ReturnType<typeof bootstrap>>): Promise<number> {
  const startup = await runStartupSequence(context);
  const result = context.reconciler.lastReconciliation;
  process.stdout.write(
    `${JSON.stringify(
      {
        startup,
        reconciliation: result
          ? {
              reconciled: result.reconciled,
              blockingCount: result.blockingCount,
              reason: result.reason,
              discrepancies: result.discrepancies,
            }
          : null,
      },
      null,
      2,
    )}\n`,
  );
  return startup.reconciled ? 0 : 1;
}

/* ------------------------------------------------------------------ *
 * report
 * ------------------------------------------------------------------ */

async function runReport(context: Awaited<ReturnType<typeof bootstrap>>, send: boolean): Promise<number> {
  await runStartupSequence(context);
  const runtime = new Runtime(context, { once: true });
  const nowMs = Date.now();
  const reportDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: context.config.raw.REPORT_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(nowMs));
  // The CLI path collects the same wallet-wide extras as the scheduled path, so
  // `report --once` shows exactly what Lark would receive.
  const extras = await runtime.collectReportExtras(context.config.raw.ARCUS_WALLET_ADDRESS ?? '');
  const input = runtime.buildReportInput(reportDate, nowMs, extras);
  const text = renderReportText(input);
  process.stdout.write(`${text}\n`);

  if (send) {
    const address = context.config.raw.ARCUS_WALLET_ADDRESS;
    if (!address) {
      process.stdout.write('\nreport not sent: no wallet address configured\n');
      return 0;
    }
    const result = await context.larkClient.sendText(text.slice(0, 100_000), {
      uuid: `${reportDate}|${address.toLowerCase()}|${context.config.raw.ARCUS_ACCOUNT_INDEX}`.slice(0, 50),
    });
    process.stdout.write(
      result.ok ? `\nreport sent (messageId=${result.messageId})\n` : `\nreport send failed: ${result.error.message}\n`,
    );
    return result.ok ? 0 : 1;
  }
  return 0;
}

/** Actionable one-liner for an Arcus error, without leaking credentials. */
function describeArcusError(error: unknown): string {
  if (error instanceof ArcusRateLimitError) {
    return `HTTP 429 rate limited (reason=${error.reason ?? 'ip'}, retryAfterMs=${error.retryAfterMs})`;
  }
  if (error instanceof ArcusValidationError) {
    return `schema mismatch: ${error.issues.slice(0, 3).join('; ')}`;
  }
  if (error instanceof ArcusHttpError) {
    return `HTTP ${error.status}: ${JSON.stringify(error.body).slice(0, 200)}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Exposed for tests. */
export const __testing = { parseArgs, usage, describeArcusError };

if (require.main === module) {
  /**
   * Exit EXPLICITLY on a short timer rather than by letting the event loop drain.
   *
   * better-sqlite3's native `Statement` finalizers run during V8 garbage
   * collection, and if that collection happens while Node is tearing down the
   * environment the destructor trips `node::RemoveEnvironmentCleanupHook`
   * (`Assertion failed: (env) != nullptr`), aborting the process with SIGABRT
   * after all work has already completed. Giving the loop a tick to drain and
   * then calling `process.exit` keeps every native object's lifetime inside a
   * live environment.
   */
  const finish = (code: number): void => {
    process.exitCode = code;
    setTimeout(() => process.exit(code), 50).unref();
  };
  main()
    .then((code) => finish(code))
    .catch((error) => {
      const logger = createLogger({ level: 'error', pretty: false });
      logger.fatal(
        { err: error instanceof Error ? error.message : String(error) },
        'unhandled top-level error',
      );
      finish(1);
    });
}

export { main };
export { dec, toFixedString };
