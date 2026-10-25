/**
 * Daily report.
 *
 * The brief enumerates the fields this must contain, and several of them exist
 * specifically to make categorisation mistakes VISIBLE rather than to inform:
 *
 *   - Trading PnL, funding, fees, deposits and withdrawals are reported as
 *     SEPARATE lines and never summed into a single "profit" number. A deposit
 *     that appears as profit is the classic way a losing system looks break-even.
 *   - Points is reported as `UNAVAILABLE` and explicitly as a NON-CASH observation
 *     metric, with a line stating whether Points changed any trading decision.
 *     The brief requires that answer to be displayable as NO, and it is hardcoded
 *     from the design rather than inferred: no code path reads a Points value, so
 *     there is nothing to infer from. The Arcus docs fetched for this project
 *     contain no Points API at all, so the value is genuinely unavailable.
 *
 * Idempotency: the key is `reportDate|wallet|accountIndex`. The send is recorded
 * in SQLite before the message goes out, so a PM2 restart cannot re-send. The
 * check happens in the caller (`Runtime.maybeSendDailyReport`), not here, so this
 * module stays a pure renderer and is trivially testable.
 */

import { Decimal, dec, toFixedString } from '../util/decimal';
import { buildMarkdownCard, type LarkCard } from '../notifications/LarkClient';

/** Every input the report renders. Assembled by the runtime. */
export interface DailyReportInput {
  /** The reporting day, `YYYY-MM-DD` in REPORT_TIMEZONE. */
  readonly reportDate: string;
  readonly generatedAtMs: number;
  readonly timezone: string;
  readonly wallet: string;
  readonly accountIndex: number;
  readonly exchange: string;
  readonly tradingMode: string;
  readonly liveTrading: boolean;

  /* Account */
  readonly equity: Decimal;
  readonly freeCollateral: Decimal;
  readonly usedMargin: Decimal;
  readonly netQuoteBalance: Decimal;
  readonly maintenanceMargin: Decimal;

  /* Cash flows — reported separately from PnL, never merged */
  readonly depositsToday: Decimal;
  readonly withdrawalsToday: Decimal;
  readonly netDepositsLifetime: Decimal;

  /* PnL split */
  readonly realizedPnl: Decimal;
  readonly unrealizedPnl: Decimal;
  readonly fees: Decimal;
  readonly funding: Decimal;
  readonly estimatedSlippage: Decimal;
  readonly netTradingPnl: Decimal;
  /**
   * Return for the day, adjusted for cash flow: pnl / (equity - net flow).
   * `undefined` when equity net of flow is not positive, i.e. the ratio is
   * meaningless rather than zero.
   */
  readonly cashFlowAdjustedReturnPct: Decimal | undefined;

  /* Volume / activity */
  readonly fillCount: number;
  readonly grossVolumeNotional: Decimal;
  readonly makerRatio: Decimal;
  readonly winRate: Decimal;
  readonly profitFactor: Decimal | undefined;
  readonly maxDrawdownPct: Decimal;
  readonly consecutiveLosses: number;
  readonly averageHoldMs: number;

  /* Positions */
  readonly positions: readonly {
    readonly symbol: string;
    readonly direction: 'long' | 'short';
    readonly size: string;
    readonly entryPrice: string;
    readonly markPrice: string;
    readonly stopPrice?: string;
    readonly target1?: string;
    readonly target2?: string;
    readonly liquidationDistancePct?: string;
    readonly unrealizedPnl: string;
    readonly fundingRate?: string;
    readonly category: string;
  }[];

  /* Strategy / system state */
  readonly strategyState: string;
  readonly activeMarket?: string;
  readonly candidateMarkets: readonly {
    symbol: string;
    category: string;
    score: string;
    /** `null` when the venue did not report a session for the market. */
    isOutsideRth: boolean | null;
  }[];
  /**
   * Decision-pipeline counters, so the report shows WHY the strategy did or did not act
   * rather than only what it did.
   */
  readonly pipeline: {
    readonly evaluations: number;
    readonly noSignal: number;
    readonly rejectedByCost: number;
    readonly rejectedByRisk: number;
    readonly approved: number;
    readonly lastReason?: string;
  };
  readonly dataAgeMs: number | undefined;
  readonly websocket: {
    readonly state: string;
    readonly ready: boolean;
    readonly reconnects: number;
    readonly errorFrames: number;
  };
  readonly rateLimit: {
    readonly weightAvailable: number;
    readonly weightCapacity: number;
    readonly orderPoolRemaining?: number;
    readonly cancelPoolRemaining?: number;
    readonly throttledCount: number;
  };
  readonly reconciliation: {
    readonly reconciled: boolean;
    readonly blockingCount: number;
    readonly reason?: string;
  };
  readonly unknownOrders: number;
  /**
   * Exit-plan progress, so the TP/trailing machinery is auditable rather than only
   * observable through the venue's order list. Optional because a fresh process with no
   * positions has nothing to report.
   */
  readonly exitPlan?: {
    readonly tp1Placed: number;
    readonly tp2Placed: number;
    readonly stopsReduced: number;
    readonly stopsTrailed: number;
    readonly emergencyExits: number;
    readonly blockedActions: number;
    readonly plans: readonly {
      readonly symbol: string;
      readonly direction: string;
      readonly baselineSize: string;
      readonly tp1Done: boolean;
      readonly tp2Done: boolean;
      readonly stop: string;
    }[];
  };
  readonly killSwitch: { readonly engaged: boolean; readonly reason?: string };
  readonly isOutsideRthAny: boolean;
  readonly offHoursEntriesAllowed: boolean;
  readonly withdrawable: { readonly amount: Decimal; readonly components: Record<string, string> };
  readonly anomalies: readonly string[];
  readonly recommendations: readonly string[];
}

/** Points are not available from the Arcus API, and must never be a trading input. */
export const POINTS_STATUS = 'UNAVAILABLE' as const;

function bps(value: Decimal, base: Decimal): string {
  if (!base.greaterThan(0)) return 'n/a';
  return `${toFixedString(value.div(base).times(10_000))} bps`;
}

function duration(ms: number): string {
  if (ms <= 0) return 'n/a';
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

/**
 * Render the report as markdown sections.
 *
 * Exported separately from the card so the same content can go out as `text`
 * when a card send is rejected, and so a test can assert on the content without
 * constructing a card.
 */
export function renderReportMarkdown(input: DailyReportInput): string[] {
  const sections: string[] = [];

  sections.push(
    [
      `**Mode** \`${input.tradingMode}\`  |  **LIVE** \`${input.liveTrading ? 'true' : 'false'}\`  |  **Exchange** \`${input.exchange}\``,
      `**Account** \`${input.wallet.slice(0, 10)}…\` #${input.accountIndex}`,
      `**Generated** ${new Date(input.generatedAtMs).toISOString()} (${input.timezone})`,
    ].join('\n'),
  );

  /* ---- Account ---------------------------------------------------- */
  sections.push(
    [
      '**Account**',
      `- Equity: **${toFixedString(input.equity)}**`,
      `- Free collateral: ${toFixedString(input.freeCollateral)}`,
      `- Used margin: ${toFixedString(input.usedMargin)}`,
      `- Maintenance margin (est.): ${toFixedString(input.maintenanceMargin)}`,
      `- Net quote balance: ${toFixedString(input.netQuoteBalance)}`,
    ].join('\n'),
  );

  /* ---- PnL, with cash flows kept apart ---------------------------- */
  sections.push(
    [
      '**PnL breakdown** (kept separate on purpose — a deposit is not profit)',
      `- Trading PnL (realized): **${toFixedString(input.realizedPnl)}**  (${bps(input.realizedPnl, input.equity)})`,
      `- Unrealized PnL: ${toFixedString(input.unrealizedPnl)}`,
      `- Fees: ${toFixedString(input.fees)}`,
      `- Funding: ${toFixedString(input.funding)}`,
      `- Estimated slippage: ${toFixedString(input.estimatedSlippage)}`,
      `- **Net trading PnL: ${toFixedString(input.netTradingPnl)}**`,
      `- Deposits today: ${toFixedString(input.depositsToday)}`,
      `- Withdrawals today: ${toFixedString(input.withdrawalsToday)}`,
      `- Net deposits (lifetime): ${toFixedString(input.netDepositsLifetime)}`,
      `- Cash-flow adjusted return: ${
        input.cashFlowAdjustedReturnPct !== undefined
          ? `${toFixedString(input.cashFlowAdjustedReturnPct)}%`
          : 'n/a'
      }`,
    ].join('\n'),
  );

  /* ---- Activity --------------------------------------------------- */
  sections.push(
    [
      '**Activity**',
      `- Fills: ${input.fillCount}  |  Gross volume: ${toFixedString(input.grossVolumeNotional)}`,
      `- Maker ratio: ${toFixedString(input.makerRatio.times(100))}%`,
      `- Win rate: ${toFixedString(input.winRate.times(100))}%  |  Profit factor: ${
        input.profitFactor !== undefined ? toFixedString(input.profitFactor) : 'n/a'
      }`,
      `- Max drawdown: ${toFixedString(input.maxDrawdownPct)}%`,
      `- Consecutive losses: ${input.consecutiveLosses}`,
      `- Average hold: ${duration(input.averageHoldMs)}`,
      '',
      '> Volume above is a **by-product** of real strategy trades. There is no volume target ' +
        '(`TARGET_VOLUME_USD=0`); this system does not trade to generate volume.',
    ].join('\n'),
  );

  /* ---- Positions -------------------------------------------------- */
  if (input.positions.length === 0) {
    sections.push('**Positions**\n- None');
  } else {
    const lines = ['**Positions**'];
    for (const position of input.positions) {
      lines.push(
        `- \`${position.symbol}\` **${position.direction.toUpperCase()}** size ${position.size} ` +
          `| entry ${position.entryPrice} → mark ${position.markPrice}`,
      );
      lines.push(
        `  - stop: ${position.stopPrice ?? 'MISSING'} | TP1: ${position.target1 ?? '-'} | TP2: ${position.target2 ?? '-'}`,
      );
      lines.push(
        `  - liq. distance: ${position.liquidationDistancePct ?? 'n/a'} | uPnL: ${position.unrealizedPnl} ` +
          `| funding: ${position.fundingRate ?? 'n/a'} | ${position.category}`,
      );
    }
    sections.push(lines.join('\n'));
  }

  /* ---- Strategy and system --------------------------------------- */
  sections.push(
    [
      '**Strategy & system**',
      `- Strategy state: \`${input.strategyState}\``,
      `- Active market: ${input.activeMarket ?? 'none'}`,
      `- Data age: ${input.dataAgeMs !== undefined ? `${input.dataAgeMs} ms` : 'n/a'} (limit is MAX_DATA_AGE_MS)`,
      `- WebSocket: \`${input.websocket.state}\` ready=${input.websocket.ready} ` +
        `reconnects=${input.websocket.reconnects} errorFrames=${input.websocket.errorFrames}`,
      `- Kill switch: ${input.killSwitch.engaged ? `**ENGAGED** (${input.killSwitch.reason ?? 'n/a'})` : 'clear'}`,
    ].join('\n'),
  );

  /* ---- Decision pipeline ------------------------------------------ */
  sections.push(
    [
      '**Decision pipeline**',
      `- Evaluations: ${input.pipeline.evaluations}  |  no signal: ${input.pipeline.noSignal}`,
      `- Rejected by cost: ${input.pipeline.rejectedByCost}  |  rejected by risk: ${input.pipeline.rejectedByRisk}`,
      `- Approved: ${input.pipeline.approved}`,
      ...(input.pipeline.lastReason ? [`- Last outcome: ${input.pipeline.lastReason}`] : []),
    ].join('\n'),
  );

  /* ---- Rate limits / reconciliation -------------------------------- */
  sections.push(
    [
      '**Rate limits & reconciliation**',
      `- IP weight: ${input.rateLimit.weightAvailable.toFixed(0)} / ${input.rateLimit.weightCapacity} remaining ` +
        `| throttled ${input.rateLimit.throttledCount}x`,
      `- Order pool remaining: ${input.rateLimit.orderPoolRemaining ?? 'not read'} ` +
        `| Cancel pool remaining: ${input.rateLimit.cancelPoolRemaining ?? 'not read'}`,
      `- Reconciliation: ${input.reconciliation.reconciled ? 'OK' : `**FAILED** (${input.reconciliation.blockingCount} blocking)`}`,
      ...(input.reconciliation.reason ? [`- Reconciliation detail: ${input.reconciliation.reason}`] : []),
      `- Unknown orders: ${input.unknownOrders}`,
    ].join('\n'),
  );

  /* ---- Exit plan --------------------------------------------------- */
  if (input.exitPlan) {
    const plan = input.exitPlan;
    const lines = [
      '**Exit plan** (TP1 at 2R, TP2 at 3R, trailing on the structure EMA)',
      `- TP1 placed: ${plan.tp1Placed}  |  TP2 placed: ${plan.tp2Placed}`,
      `- Stops resized after TP1: ${plan.stopsReduced}  |  Stops trailed: ${plan.stopsTrailed}`,
      `- Emergency exits: ${plan.emergencyExits}  |  Blocked exit actions: ${plan.blockedActions}`,
    ];
    if (plan.plans.length === 0) {
      lines.push('- No open position is under exit management');
    } else {
      for (const entry of plan.plans) {
        lines.push(
          `- \`${entry.symbol}\` ${entry.direction.toUpperCase()} base=${entry.baselineSize} ` +
            `TP1=${entry.tp1Done ? 'filled' : 'working'} TP2=${entry.tp2Done ? 'filled' : 'pending'} ` +
            `stop=${entry.stop}`,
        );
      }
    }
    sections.push(lines.join('\n'));
  }

  /* ---- Markets ---------------------------------------------------- */
  const candidateLines =
    input.candidateMarkets.length === 0
      ? ['- None']
      : input.candidateMarkets.map(
          (c) => `- \`${c.symbol}\` ${c.category} score=${c.score}${
              c.isOutsideRth === null ? ' (session unknown)' : c.isOutsideRth ? ' (off-hours)' : ''
            }`,
        );
  sections.push(
    [
      '**Candidate markets**',
      ...candidateLines,
      `- Any market outside RTH: ${input.isOutsideRthAny ? 'yes' : 'no'}  |  ` +
        `off-hours entries allowed: \`${input.offHoursEntriesAllowed}\``,
    ].join('\n'),
  );

  /* ---- Withdrawable ----------------------------------------------- */
  sections.push(
    [
      '**Theoretical withdrawable balance** (informational only — this system never withdraws)',
      `- Withdrawable: **${toFixedString(input.withdrawable.amount)}**`,
      `- Deductions: ${Object.entries(input.withdrawable.components)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')}`,
      `- \`ALLOW_AUTO_WITHDRAW\` is false; no withdrawal is ever initiated automatically.`,
    ].join('\n'),
  );

  /* ---- Points — explicitly non-cash ------------------------------- */
  sections.push(
    [
      '**Points** (non-cash observation metric — NOT revenue)',
      `- Points status: \`${POINTS_STATUS}\` (no Points API was found in the Arcus documentation)`,
      `- Points are excluded from every PnL figure above.`,
      `- Did Points change any trading decision today? **NO** — no code path reads a Points value, ` +
        'and Points can never be a reason to trade.',
    ].join('\n'),
  );

  /* ---- Anomalies -------------------------------------------------- */
  sections.push(
    [
      '**Anomalies & handling**',
      ...(input.anomalies.length === 0 ? ['- None recorded'] : input.anomalies.map((a) => `- ${a}`)),
      '',
      '**Suggested actions**',
      ...(input.recommendations.length === 0
        ? ['- None']
        : input.recommendations.map((r) => `- ${r}`)),
    ].join('\n'),
  );

  return sections;
}

/**
 * Build the interactive card.
 *
 * Uses card JSON 2.0 via `buildMarkdownCard` (header + `body.elements` of
 * `markdown` blocks), which is what the current Lark docs describe for new
 * integrations.
 */
export function buildDailyReportCard(input: DailyReportInput): LarkCard {
  const title = `ArcusTrader daily report — ${input.reportDate}`;
  const subtitle = `${input.tradingMode}${input.liveTrading ? ' (LIVE)' : ' (not live)'} · ${input.timezone}`;
  const template = input.killSwitch.engaged
    ? 'red'
    : !input.reconciliation.reconciled
      ? 'orange'
      : input.netTradingPnl.isNegative()
        ? 'yellow'
        : 'green';
  return buildMarkdownCard(title, subtitle, renderReportMarkdown(input), template);
}

/** Plain-text fallback, used when a card send fails and for the log. */
export function renderReportText(input: DailyReportInput): string {
  return [`ArcusTrader daily report — ${input.reportDate}`, ...renderReportMarkdown(input)].join('\n\n');
}

/**
 * Idempotency key. Exactly the shape the brief requires:
 * `reportDate + wallet + accountIndex`.
 */
export function reportIdempotencyKey(input: {
  reportDate: string;
  wallet: string;
  accountIndex: number;
}): string {
  return `${input.reportDate}|${input.wallet.toLowerCase()}|${input.accountIndex}`;
}

/** The reporting day in a specific IANA timezone, as `YYYY-MM-DD`. */
export function reportDateInTimezone(epochMs: number, timezone: string): string {
  try {
    // `en-CA` renders ISO-like `YYYY-MM-DD`, which avoids a manual reassembly.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(epochMs));
  } catch {
    // An invalid timezone must not silently produce a wrong day; fall back to UTC
    // AND make the fallback visible in the rendered date.
    return `${new Date(epochMs).toISOString().slice(0, 10)} (UTC fallback: invalid timezone ${timezone})`;
  }
}

/** Convenience for tests and the report builder. */
export function pct(numerator: Decimal, denominator: Decimal): Decimal | undefined {
  if (!denominator.greaterThan(0)) return undefined;
  return numerator.div(denominator).times(100);
}

/** Re-exported so the runtime and tests share one decimal entry point. */
export { dec };
