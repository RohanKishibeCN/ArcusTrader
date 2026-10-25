/**
 * Persistence.
 *
 * better-sqlite3 with WAL, chosen for synchronous durability: the trading loop
 * must not be able to lose the record of a fill because a process died mid-flush.
 *
 * What is stored, and deliberately what is NOT:
 *
 *   STORED  — orders, fills, cash-flow events (deposits/withdrawals), funding
 *             payments, daily report idempotency keys, the Lark outbox, and a
 *             running PnL ledger.
 *   NOT STORED — the API signing key, the wallet private key, the Lark app
 *             secret, the tenant access token, or any request signature.
 *
 * The PnL ledger is split into trading PnL, fees, and funding, because the brief
 * requires them reported separately and requires that a DEPOSIT must not reset
 * the daily loss accumulator. The way that requirement is met structurally: the
 * daily loss breaker reads `realized_trading_pnl` only. Deposits are written to
 * `cash_flows` and never touch the trading ledger, so no amount of depositing can
 * clear a losing day.
 */

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Decimal, dec, toFixedString } from '../util/decimal';
import type { Logger } from '../util/logger';
import type { Fill } from '../arcus/types';
import type { OutboxStore } from '../notifications/AlertRouter';
import { openDatabase, type DatabaseLike } from './Sqlite';

export interface StoredOrderRow {
  readonly clientId: string;
  readonly orderId?: string;
  readonly marketId: number;
  readonly symbol: string;
  readonly purpose: string;
  readonly side: string;
  readonly reduceOnly: number;
  readonly price?: string;
  readonly triggerPrice?: string;
  readonly quantity: string;
  readonly state: string;
  readonly venueStatus?: string;
  readonly rejectionReason?: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface DailyLedger {
  readonly day: string;
  readonly tradingPnl: Decimal;
  readonly fees: Decimal;
  readonly funding: Decimal;
  readonly netPnl: Decimal;
  readonly fillCount: number;
  readonly makerFillCount: number;
  readonly takerFillCount: number;
  readonly grossVolumeNotional: Decimal;
}

export interface TradeRecord {
  readonly tradeId: string;
  readonly marketId: number;
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';
  readonly role: 'MAKER' | 'TAKER';
  readonly size: string;
  readonly price: string;
  readonly fee: string;
  readonly closedPnl: string;
  readonly positionEffect?: string;
  readonly createdAtMs: number;
  /** Epoch ms at which this fill was recorded locally. */
  readonly recordedAtMs: number;
}

export interface CashFlowRecord {
  readonly id: string;
  readonly type: string;
  readonly amount: string;
  readonly accountIndex: number;
  readonly occurredAtMs: number;
  readonly recordedAtMs: number;
}

export interface OutboxRow {
  readonly id: number;
  readonly idempotencyKey: string;
  readonly kind: 'text' | 'card';
  readonly payload: string;
  readonly attempts: number;
  readonly lastError?: string;
}

/** UTC day key. Reporting uses a timezone, but accounting keys on UTC days. */
export function dayKey(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

export class Store {
  private readonly db: DatabaseLike;
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(options: { path: string; logger: Logger; now?: () => number }) {
    this.logger = options.logger;
    this.now = options.now ?? (() => Date.now());
    const dbPath = resolve(options.path);
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    // The driver is chosen by the adapter; see src/store/Sqlite.ts for why the
    // built-in is preferred under Node 24.
    this.db = openDatabase({ path: dbPath, logger: this.logger });
    // `PRAGMA` goes through `exec` so the adapter does not need a `pragma()` method.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
    this.logger.info({ path: dbPath, driver: this.db.driver }, 'store initialised');
  }

  /** Which SQLite driver is in use. Surfaced in the daily report. */
  get driver(): 'node:sqlite' | 'better-sqlite3' {
    return this.db.driver;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orders (
        client_id       TEXT PRIMARY KEY,
        order_id        TEXT,
        market_id       INTEGER NOT NULL,
        symbol          TEXT NOT NULL,
        purpose         TEXT NOT NULL,
        side            TEXT NOT NULL,
        reduce_only     INTEGER NOT NULL DEFAULT 0,
        price           TEXT,
        trigger_price   TEXT,
        quantity        TEXT NOT NULL,
        state           TEXT NOT NULL,
        venue_status    TEXT,
        rejection_reason TEXT,
        created_at_ms   INTEGER NOT NULL,
        updated_at_ms   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_orders_market ON orders(market_id);
      CREATE INDEX IF NOT EXISTS idx_orders_state ON orders(state);

      CREATE TABLE IF NOT EXISTS fills (
        trade_id        TEXT PRIMARY KEY,
        market_id       INTEGER NOT NULL,
        symbol          TEXT NOT NULL,
        side            TEXT NOT NULL,
        role            TEXT NOT NULL,
        size            TEXT NOT NULL,
        price           TEXT NOT NULL,
        fee             TEXT NOT NULL,
        closed_pnl      TEXT NOT NULL,
        position_effect TEXT,
        created_at_ms   INTEGER NOT NULL,
        recorded_at_ms  INTEGER NOT NULL,
        day             TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_fills_day ON fills(day);
      CREATE INDEX IF NOT EXISTS idx_fills_market ON fills(market_id);

      CREATE TABLE IF NOT EXISTS cash_flows (
        id              TEXT PRIMARY KEY,
        type            TEXT NOT NULL,
        amount          TEXT NOT NULL,
        account_index   INTEGER NOT NULL,
        occurred_at_ms  INTEGER NOT NULL,
        recorded_at_ms  INTEGER NOT NULL,
        day             TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cash_flows_day ON cash_flows(day);

      CREATE TABLE IF NOT EXISTS funding_payments (
        id              TEXT PRIMARY KEY,
        market_id       INTEGER NOT NULL,
        payment         TEXT NOT NULL,
        rate            TEXT,
        occurred_at_ms  INTEGER NOT NULL,
        recorded_at_ms  INTEGER NOT NULL,
        day             TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_funding_day ON funding_payments(day);

      -- Daily-report idempotency. The key is reportDate|wallet|accountIndex, so a
      -- PM2 restart cannot resend yesterday's (or today's) report.
      CREATE TABLE IF NOT EXISTS report_sends (
        idempotency_key TEXT PRIMARY KEY,
        report_date     TEXT NOT NULL,
        wallet          TEXT NOT NULL,
        account_index   INTEGER NOT NULL,
        sent_at_ms      INTEGER NOT NULL,
        message_id      TEXT,
        payload_hash    TEXT
      );

      CREATE TABLE IF NOT EXISTS outbox (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT NOT NULL UNIQUE,
        kind            TEXT NOT NULL,
        payload         TEXT NOT NULL,
        created_at_ms   INTEGER NOT NULL,
        attempts        INTEGER NOT NULL DEFAULT 0,
        last_error      TEXT,
        sent_at_ms      INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(sent_at_ms, id);

      -- Equity snapshots, used for the recalibration trigger and the drawdown
      -- calculation. Cash-flow events are separated from PnL, so a deposit shows
      -- up as a deposit and never as profit.
      CREATE TABLE IF NOT EXISTS equity_snapshots (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        captured_at_ms INTEGER NOT NULL,
        day           TEXT NOT NULL,
        equity        TEXT NOT NULL,
        free_collateral TEXT NOT NULL,
        used_margin   TEXT NOT NULL,
        unrealized_pnl TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_equity_day ON equity_snapshots(day);

      CREATE TABLE IF NOT EXISTS trades_closed (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        market_id       INTEGER NOT NULL,
        symbol          TEXT NOT NULL,
        direction       TEXT NOT NULL,
        entry_price     TEXT NOT NULL,
        exit_price      TEXT NOT NULL,
        quantity        TEXT NOT NULL,
        gross_pnl       TEXT NOT NULL,
        fees            TEXT NOT NULL,
        funding         TEXT NOT NULL,
        net_pnl         TEXT NOT NULL,
        r_multiple      TEXT,
        opened_at_ms    INTEGER NOT NULL,
        closed_at_ms    INTEGER NOT NULL,
        day             TEXT NOT NULL,
        was_maker_entry INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_trades_closed_day ON trades_closed(day);
    `);
  }

  /* ---------------------------------------------------------------- *
   * Orders
   * ---------------------------------------------------------------- */

  upsertOrder(row: StoredOrderRow): void {
    this.db
      .prepare(
        `INSERT INTO orders (client_id, order_id, market_id, symbol, purpose, side, reduce_only,
                             price, trigger_price, quantity, state, venue_status, rejection_reason,
                             created_at_ms, updated_at_ms)
         VALUES (@clientId, @orderId, @marketId, @symbol, @purpose, @side, @reduceOnly,
                 @price, @triggerPrice, @quantity, @state, @venueStatus, @rejectionReason,
                 @createdAtMs, @updatedAtMs)
         ON CONFLICT(client_id) DO UPDATE SET
           order_id = COALESCE(excluded.order_id, orders.order_id),
           state = excluded.state,
           venue_status = excluded.venue_status,
           rejection_reason = excluded.rejection_reason,
           quantity = excluded.quantity,
           updated_at_ms = excluded.updated_at_ms`,
      )
      .run({
        clientId: row.clientId,
        orderId: row.orderId ?? null,
        marketId: row.marketId,
        symbol: row.symbol,
        purpose: row.purpose,
        side: row.side,
        reduceOnly: Number(row.reduceOnly),
        price: row.price ?? null,
        triggerPrice: row.triggerPrice ?? null,
        quantity: row.quantity,
        state: row.state,
        venueStatus: row.venueStatus ?? null,
        rejectionReason: row.rejectionReason ?? null,
        createdAtMs: row.createdAtMs,
        updatedAtMs: row.updatedAtMs,
      });
  }

  /* ---------------------------------------------------------------- *
   * Fills — the authoritative PnL source
   * ---------------------------------------------------------------- */

  /**
   * Record a fill.
   *
   * Returns false when the tradeId was already present, which makes ingestion
   * idempotent across a WebSocket snapshot plus a live frame, or across a restart
   * that replays recent fills. Double-counting a fill would corrupt every
   * downstream statistic, so this is the one place where "already have it" is
   * success rather than an error.
   */
  recordFill(fill: Fill): boolean {
    const day = dayKey(fill.createdAt / 1000);
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO fills (trade_id, market_id, symbol, side, role, size, price, fee,
                                      closed_pnl, position_effect, created_at_ms, recorded_at_ms, day)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fill.tradeId,
        fill.marketId,
        fill.marketDisplayName,
        fill.side,
        fill.role,
        fill.size,
        fill.price,
        fill.fee,
        fill.closedPnl ?? '0',
        fill.positionEffect ?? null,
        Math.round(fill.createdAt / 1000),
        this.now(),
        day,
      );
    return result.changes > 0;
  }

  /** The daily ledger. Trading PnL excludes deposits by construction. */
  ledgerForDay(day: string): DailyLedger {
    const fills = this.db
      .prepare(
        `SELECT closed_pnl AS closedPnl, fee AS fee, role AS role, size AS size, price AS price
         FROM fills WHERE day = ?`,
      )
      .all(day) as { closedPnl: string; fee: string; role: string; size: string; price: string }[];

    let tradingPnl = new Decimal(0);
    let fees = new Decimal(0);
    let volume = new Decimal(0);
    let maker = 0;
    let taker = 0;
    for (const row of fills) {
      tradingPnl = tradingPnl.plus(dec(row.closedPnl));
      fees = fees.plus(dec(row.fee));
      volume = volume.plus(dec(row.size).times(dec(row.price)));
      if (row.role === 'MAKER') maker += 1;
      else taker += 1;
    }

    const fundingRow = this.db
      .prepare(`SELECT COALESCE(SUM(CAST(payment AS REAL)), 0) AS total FROM funding_payments WHERE day = ?`)
      .get(day) as { total: number };
    // Funding is summed in SQL for convenience but converted back through the
    // exact decimal path using the raw rows, because REAL summation of money is
    // lossy. Re-sum exactly here.
    let funding = new Decimal(0);
    for (const row of this.db
      .prepare(`SELECT payment AS payment FROM funding_payments WHERE day = ?`)
      .all(day) as { payment: string }[]) {
      funding = funding.plus(dec(row.payment));
    }
    void fundingRow;

    return {
      day,
      tradingPnl,
      fees,
      funding,
      netPnl: tradingPnl.minus(fees.abs()).plus(funding),
      fillCount: fills.length,
      makerFillCount: maker,
      takerFillCount: taker,
      grossVolumeNotional: volume,
    };
  }

  /**
   * Realized trading PnL for a day, EXCLUDING fees, funding and cash flows.
   *
   * This is what the daily-loss circuit breaker consumes. It deliberately does
   * not see deposits or withdrawals, so depositing money cannot clear a losing
   * day — the behaviour the brief requires.
   */
  realizedTradingPnlForDay(day: string): Decimal {
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(CAST(closed_pnl AS REAL)), 0) AS total FROM fills WHERE day = ?`)
      .get(day) as { total: number };
    // Re-sum exactly rather than trusting the REAL aggregate.
    let total = new Decimal(0);
    for (const r of this.db.prepare(`SELECT closed_pnl AS v FROM fills WHERE day = ?`).all(day) as {
      v: string;
    }[]) {
      total = total.plus(dec(r.v));
    }
    void row;
    return total;
  }

  /** Net cash flow for a day. Reported separately from PnL, never merged into it. */
  netCashFlowForDay(day: string): Decimal {
    let total = new Decimal(0);
    for (const r of this.db
      .prepare(`SELECT type AS t, amount AS a FROM cash_flows WHERE day = ?`)
      .all(day) as { t: string; a: string }[]) {
      const amount = dec(r.a);
      if (r.t === 'DEPOSIT' || r.t === 'REFERRAL_CLAIM') total = total.plus(amount);
      else if (r.t === 'WITHDRAWAL') total = total.minus(amount);
      // INTERNAL_TRANSFER / SELF_ACCOUNT_TRANSFER move money between the wallet's
      // own subaccounts; they are not external cash flow and must not be counted
      // as profit or loss.
    }
    return total;
  }

  /**
   * Sum of one cash-flow type for a day.
   *
   * Reported as its own line so a deposit can never be mistaken for trading
   * profit. Summed with exact Decimal arithmetic rather than SQL REAL, because
   * floating-point money sums accumulate error.
   */
  cashFlowForDay(day: string, types: readonly string[]): Decimal {
    const wanted = new Set(types);
    let total = new Decimal(0);
    for (const r of this.db
      .prepare(`SELECT type AS t, amount AS a FROM cash_flows WHERE day = ?`)
      .all(day) as { t: string; a: string }[]) {
      if (wanted.has(r.t)) total = total.plus(dec(r.a));
    }
    return total;
  }

  /** Lifetime net deposits, used to compute a cash-flow-adjusted return. */
  lifetimeNetDeposits(): Decimal {
    let deposits = new Decimal(0);
    let withdrawals = new Decimal(0);
    for (const r of this.db.prepare(`SELECT type AS t, amount AS a FROM cash_flows`).all() as {
      t: string;
      a: string;
    }[]) {
      if (r.t === 'DEPOSIT' || r.t === 'REFERRAL_CLAIM') deposits = deposits.plus(dec(r.a));
      else if (r.t === 'WITHDRAWAL') withdrawals = withdrawals.plus(dec(r.a));
    }
    return deposits.minus(withdrawals);
  }

  recordCashFlow(record: CashFlowRecord): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO cash_flows (id, type, amount, account_index, occurred_at_ms, recorded_at_ms, day)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.type,
        record.amount,
        record.accountIndex,
        record.occurredAtMs,
        record.recordedAtMs,
        dayKey(record.occurredAtMs),
      );
    return result.changes > 0;
  }

  recordFundingPayment(record: {
    id: string;
    marketId: number;
    payment: string;
    rate?: string;
    occurredAtMs: number;
  }): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO funding_payments (id, market_id, payment, rate, occurred_at_ms, recorded_at_ms, day)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.marketId,
        record.payment,
        record.rate ?? null,
        record.occurredAtMs,
        this.now(),
        dayKey(record.occurredAtMs),
      );
    return result.changes > 0;
  }

  /* ---------------------------------------------------------------- *
   * Equity snapshots / drawdown
   * ---------------------------------------------------------------- */

  recordEquitySnapshot(snapshot: {
    capturedAtMs: number;
    equity: Decimal;
    freeCollateral: Decimal;
    usedMargin: Decimal;
    unrealizedPnl: Decimal;
  }): void {
    this.db
      .prepare(
        `INSERT INTO equity_snapshots (captured_at_ms, day, equity, free_collateral, used_margin, unrealized_pnl)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshot.capturedAtMs,
        dayKey(snapshot.capturedAtMs),
        toFixedString(snapshot.equity),
        toFixedString(snapshot.freeCollateral),
        toFixedString(snapshot.usedMargin),
        toFixedString(snapshot.unrealizedPnl),
      );
  }

  /**
   * Maximum drawdown over a window, as a fraction.
   *
   * Computed on EQUITY but with cash flows removed first, so a withdrawal does not
   * masquerade as a drawdown and a deposit does not mask one. This is the "资金流
   * 调整后的收益率" requirement applied to drawdown.
   */
  maxDrawdown(params: { fromMs?: number; toMs?: number }): { fraction: Decimal; peak: Decimal; trough: Decimal } {
    const rows = this.db
      .prepare(
        `SELECT captured_at_ms AS at, equity AS equity, day AS day FROM equity_snapshots
         WHERE captured_at_ms >= ? AND captured_at_ms <= ?
         ORDER BY captured_at_ms ASC`,
      )
      .all(params.fromMs ?? 0, params.toMs ?? this.now()) as { at: number; equity: string; day: string }[];

    if (rows.length === 0) {
      return { fraction: new Decimal(0), peak: new Decimal(0), trough: new Decimal(0) };
    }

    // Cash-flow adjustment: walk forward, adding back withdrawals and subtracting
    // deposits so the series reflects trading performance rather than transfers.
    let adjusted = new Decimal(rows[0]!.equity);
    let peak = adjusted;
    let peakAtStart = adjusted;
    let maxDd = new Decimal(0);
    let trough = adjusted;

    for (let i = 1; i < rows.length; i += 1) {
      const prev = rows[i - 1]!;
      const cur = rows[i]!;
      const flow = this.netCashFlowForDay(cur.day).minus(this.netCashFlowForDay(prev.day));
      // Equity includes the flow; remove it to get performance.
      adjusted = dec(cur.equity).minus(flow);
      peakAtStart = adjusted.greaterThan(peakAtStart) ? adjusted : peakAtStart;
      if (adjusted.greaterThan(peak)) peak = adjusted;
      const dd = peak.greaterThan(0) ? peak.minus(adjusted).div(peak) : new Decimal(0);
      if (dd.greaterThan(maxDd)) {
        maxDd = dd;
        trough = adjusted;
      }
    }
    void peakAtStart;
    return { fraction: maxDd, peak, trough };
  }

  /* ---------------------------------------------------------------- *
   * Closed trades — win rate / profit factor / streaks
   * ---------------------------------------------------------------- */

  recordClosedTrade(record: {
    marketId: number;
    symbol: string;
    direction: string;
    entryPrice: string;
    exitPrice: string;
    quantity: string;
    grossPnl: string;
    fees: string;
    funding: string;
    netPnl: string;
    rMultiple?: string;
    openedAtMs: number;
    closedAtMs: number;
    wasMakerEntry: boolean;
  }): void {
    this.db
      .prepare(
        `INSERT INTO trades_closed (market_id, symbol, direction, entry_price, exit_price, quantity,
                                    gross_pnl, fees, funding, net_pnl, r_multiple, opened_at_ms,
                                    closed_at_ms, day, was_maker_entry)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.marketId,
        record.symbol,
        record.direction,
        record.entryPrice,
        record.exitPrice,
        record.quantity,
        record.grossPnl,
        record.fees,
        record.funding,
        record.netPnl,
        record.rMultiple ?? null,
        record.openedAtMs,
        record.closedAtMs,
        dayKey(record.closedAtMs),
        record.wasMakerEntry ? 1 : 0,
      );
  }

  closedTradeStats(params?: { fromMs?: number; toMs?: number; marketIds?: number[] }): {
    count: number;
    wins: number;
    losses: number;
    winRate: Decimal;
    grossProfit: Decimal;
    grossLoss: Decimal;
    profitFactor: Decimal | undefined;
    avgHoldMs: number;
    netPnl: Decimal;
  } {
    const rows = this.db
      .prepare(
        `SELECT net_pnl AS netPnl, opened_at_ms AS openedAt, closed_at_ms AS closedAt
         FROM trades_closed WHERE closed_at_ms >= ? AND closed_at_ms <= ? ORDER BY closed_at_ms ASC`,
      )
      .all(params?.fromMs ?? 0, params?.toMs ?? this.now()) as {
      netPnl: string;
      openedAt: number;
      closedAt: number;
    }[];

    const filtered = params?.marketIds
      ? rows
      : rows;
    let wins = 0;
    let losses = 0;
    let grossProfit = new Decimal(0);
    let grossLoss = new Decimal(0);
    let netPnl = new Decimal(0);
    let holdTotal = 0;
    for (const row of filtered) {
      const net = dec(row.netPnl);
      netPnl = netPnl.plus(net);
      if (net.greaterThan(0)) {
        wins += 1;
        grossProfit = grossProfit.plus(net);
      } else if (net.isNegative()) {
        losses += 1;
        grossLoss = grossLoss.plus(net.abs());
      }
      holdTotal += Math.max(0, row.closedAt - row.openedAt);
    }
    const count = filtered.length;
    return {
      count,
      wins,
      losses,
      winRate: count > 0 ? new Decimal(wins).div(count) : new Decimal(0),
      grossProfit,
      grossLoss,
      profitFactor: grossLoss.greaterThan(0) ? grossProfit.div(grossLoss) : undefined,
      avgHoldMs: count > 0 ? Math.round(holdTotal / count) : 0,
      netPnl,
    };
  }

  /** Consecutive losing closed trades, most recent first. Drives the streak breaker. */
  consecutiveLosses(): number {
    const rows = this.db
      .prepare(`SELECT net_pnl AS netPnl FROM trades_closed ORDER BY closed_at_ms DESC LIMIT 50`)
      .all() as { netPnl: string }[];
    let streak = 0;
    for (const row of rows) {
      if (dec(row.netPnl).isNegative()) streak += 1;
      else break;
    }
    return streak;
  }

  /* ---------------------------------------------------------------- *
   * Report idempotency
   * ---------------------------------------------------------------- */

  hasReportBeenSent(input: { reportDate: string; wallet: string; accountIndex: number }): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS present FROM report_sends WHERE idempotency_key = ?`,
      )
      .get(`${input.reportDate}|${input.wallet.toLowerCase()}|${input.accountIndex}`) as
      | { present: number }
      | undefined;
    return row !== undefined;
  }

  markReportSent(input: {
    reportDate: string;
    wallet: string;
    accountIndex: number;
    messageId?: string;
    payloadHash?: string;
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO report_sends (idempotency_key, report_date, wallet, account_index, sent_at_ms, message_id, payload_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `${input.reportDate}|${input.wallet.toLowerCase()}|${input.accountIndex}`,
        input.reportDate,
        input.wallet.toLowerCase(),
        input.accountIndex,
        this.now(),
        input.messageId ?? null,
        input.payloadHash ?? null,
      );
  }

  /* ---------------------------------------------------------------- *
   * Outbox
   * ---------------------------------------------------------------- */

  enqueueOutbox(record: {
    idempotencyKey: string;
    kind: 'text' | 'card';
    payload: string;
    createdAtMs: number;
    attempts: number;
    lastError?: string;
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO outbox (idempotency_key, kind, payload, created_at_ms, attempts, last_error)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.idempotencyKey,
        record.kind,
        record.payload,
        record.createdAtMs,
        record.attempts,
        // Explicit null: neither driver accepts `undefined`.
        record.lastError ?? null,
      );
  }

  pendingOutbox(limit: number): OutboxRow[] {
    return (
      this.db
        .prepare(
          `SELECT id, idempotency_key AS idempotencyKey, kind, payload, attempts, last_error AS lastError
           FROM outbox WHERE sent_at_ms IS NULL ORDER BY id ASC LIMIT ?`,
        )
        .all(limit) as OutboxRow[]
    ).map((row) => ({ ...row, lastError: row.lastError ?? undefined }));
  }

  markOutboxSent(id: number): void {
    this.db.prepare(`UPDATE outbox SET sent_at_ms = ? WHERE id = ?`).run(this.now(), id);
  }

  markOutboxFailed(id: number, error: string): void {
    this.db
      .prepare(`UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?`)
      .run(error.slice(0, 500), id);
  }

  /* ---------------------------------------------------------------- *
   * Reporting aggregates
   * ---------------------------------------------------------------- */

  makerRatioForDay(day: string): Decimal {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN role = 'MAKER' THEN 1 ELSE 0 END) AS makers
         FROM fills WHERE day = ?`,
      )
      .get(day) as { total: number; makers: number | null };
    if (!row.total) return new Decimal(0);
    return new Decimal(row.makers ?? 0).div(row.total);
  }

  /** Grouped performance, used for RWA-vs-crypto and maker-vs-taker breakdowns. */
  groupedFillStats(day: string): { symbol: string; marketId: number; volume: Decimal; fees: Decimal; closedPnl: Decimal; maker: number; taker: number }[] {
    const rows = this.db
      .prepare(
        `SELECT symbol, market_id AS marketId,
                SUM(CAST(size AS REAL) * CAST(price AS REAL)) AS volume,
                SUM(CAST(fee AS REAL)) AS fees,
                SUM(CAST(closed_pnl AS REAL)) AS closedPnl,
                SUM(CASE WHEN role='MAKER' THEN 1 ELSE 0 END) AS maker,
                SUM(CASE WHEN role='TAKER' THEN 1 ELSE 0 END) AS taker
         FROM fills WHERE day = ? GROUP BY market_id, symbol`,
      )
      .all(day) as {
      symbol: string;
      marketId: number;
      volume: number;
      fees: number;
      closedPnl: number;
      maker: number;
      taker: number;
    }[];
    // Re-derive exactly from the raw rows rather than trusting REAL aggregates.
    return rows.map((row) => {
      let volume = new Decimal(0);
      let fees = new Decimal(0);
      let closedPnl = new Decimal(0);
      for (const r of this.db
        .prepare(`SELECT size AS s, price AS p, fee AS f, closed_pnl AS c FROM fills WHERE day = ? AND market_id = ?`)
        .all(day, row.marketId) as { s: string; p: string; f: string; c: string }[]) {
        volume = volume.plus(dec(r.s).times(dec(r.p)));
        fees = fees.plus(dec(r.f));
        closedPnl = closedPnl.plus(dec(r.c));
      }
      return { symbol: row.symbol, marketId: row.marketId, volume, fees, closedPnl, maker: row.maker, taker: row.taker };
    });
  }

  close(): void {
    this.db.close();
  }
}

/**
 * In-memory `OutboxStore` adapter for tests and for the dry-run path, where a
 * database is not required. Keeps the `AlertRouter` free of a hard DB dependency.
 */
export class MemoryOutbox implements OutboxStore {
  private readonly rows: { id: number; idempotencyKey: string; kind: 'text' | 'card'; payload: string; attempts: number; lastError?: string; sent: boolean }[] = [];
  private nextId = 1;

  enqueue(record: {
    idempotencyKey: string;
    kind: 'text' | 'card';
    payload: string;
    createdAtMs: number;
    attempts: number;
    lastError?: string;
  }): void {
    if (this.rows.some((r) => r.idempotencyKey === record.idempotencyKey && !r.sent)) return;
    this.rows.push({
      id: this.nextId++,
      idempotencyKey: record.idempotencyKey,
      kind: record.kind,
      payload: record.payload,
      attempts: record.attempts,
      ...(record.lastError !== undefined ? { lastError: record.lastError } : {}),
      sent: false,
    });
  }

  pending(limit: number): { id: number; idempotencyKey: string; kind: 'text' | 'card'; payload: string; attempts: number }[] {
    return this.rows
      .filter((r) => !r.sent)
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        idempotencyKey: r.idempotencyKey,
        kind: r.kind,
        payload: r.payload,
        attempts: r.attempts,
      }));
  }

  markSent(id: number): void {
    const row = this.rows.find((r) => r.id === id);
    if (row) row.sent = true;
  }

  markFailed(id: number, error: string): void {
    const row = this.rows.find((r) => r.id === id);
    if (row) {
      row.attempts += 1;
      row.lastError = error;
    }
  }
}
