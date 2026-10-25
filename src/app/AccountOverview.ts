/**
 * Read-only wallet overview across every subaccount.
 *
 * WHY THIS EXISTS
 *
 * The two volume figures Arcus exposes are scoped differently, and getting that wrong
 * changes what a report means:
 *
 *  - **Fee-tier volume is per subaccount.** The docs are explicit: every `accountIndex`
 *    is a self-contained account keeping "its own volume credit for fee tiering". So
 *    consolidating equity across subaccounts is right, but consolidating the fee-tier
 *    volume credit would be wrong.
 *  - **Referral volume is wallet-level.** `GET /v1/affiliate/info` accepts `address`
 *    only — no `accountIndex` — so its `volume30d` already spans every subaccount.
 *
 * This module therefore CONSOLIDATES BALANCE and computes return on total deposits,
 * and leaves each volume figure attributed to the scope the venue actually uses.
 *
 * It never writes: it is only ever called to build a report or a preflight readout.
 */

import { Decimal, dec } from '../util/decimal';
import type { Account } from '../arcus/types';

/** One subaccount's state, as read live. */
export interface SubaccountSnapshot {
  readonly accountIndex: number;
  readonly equity: Decimal;
  readonly freeCollateral: Decimal;
  readonly netQuoteBalance: Decimal;
  /** Lifetime net deposits. Never reset by the day rollover. */
  readonly netDeposits: Decimal;
  /**
   * (equity - netDeposits) / netDeposits, in percent.
   * `undefined` when there are no deposits: the ratio would divide by zero and a
   * fabricated 0% would read as "flat" when the account is simply unfunded.
   */
  readonly lifetimeRoiPct: Decimal | undefined;
}

export interface AccountOverview {
  readonly subaccounts: readonly SubaccountSnapshot[];
  readonly totalEquity: Decimal;
  readonly totalFreeCollateral: Decimal;
  readonly totalNetDeposits: Decimal;
  readonly totalLifetimeRoiPct: Decimal | undefined;
  /** Highest index scanned, so a reader knows the range (0..N) that was examined. */
  readonly scannedMaxIndex: number;
}

/** Narrow seam so the collector can be tested without a network or a client. */
export interface AccountReader {
  getAccount(address: string, accountIndex: number): Promise<Account | undefined>;
}

export interface LoggerLike {
  debug(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

/** (equity - deposits) / deposits * 100, or undefined when deposits are non-positive. */
export function lifetimeRoiPct(equity: Decimal, netDeposits: Decimal): Decimal | undefined {
  if (!netDeposits.greaterThan(0)) return undefined;
  return equity.minus(netDeposits).div(netDeposits).times(100);
}

/**
 * Scan `0..maxIndex` and return every subaccount that has activity.
 *
 * A subaccount is created implicitly on first use, and `GET /v1/account` returns 404
 * "this account has no activity yet" until then. `getAccount` maps that 404 to
 * `undefined`, so an unused index is simply skipped rather than reported as a zero
 * balance — a zero-balance row would be indistinguishable from a real empty account.
 */
export async function collectAccountOverview(args: {
  readonly reader: AccountReader;
  readonly address: string;
  readonly maxIndex: number;
  readonly logger?: LoggerLike;
}): Promise<AccountOverview> {
  const { reader, address, maxIndex, logger } = args;
  const subaccounts: SubaccountSnapshot[] = [];

  for (let accountIndex = 0; accountIndex <= maxIndex; accountIndex += 1) {
    let account: Account | undefined;
    try {
      account = await reader.getAccount(address, accountIndex);
    } catch (error) {
      // One unreadable subaccount must not blank the whole overview: report what can
      // be seen and say that a row is missing.
      logger?.warn(
        { accountIndex, error: error instanceof Error ? error.message : String(error) },
        'could not read subaccount; omitting it from the overview',
      );
      continue;
    }
    if (!account) continue;

    const equity = dec(account.equity);
    const netDeposits = dec(account.netDeposits);
    subaccounts.push({
      accountIndex,
      equity,
      freeCollateral: dec(account.freeCollateral),
      netQuoteBalance: dec(account.netQuoteBalance),
      netDeposits,
      lifetimeRoiPct: lifetimeRoiPct(equity, netDeposits),
    });
  }

  const totalEquity = subaccounts.reduce((acc, s) => acc.plus(s.equity), dec('0'));
  const totalFreeCollateral = subaccounts.reduce((acc, s) => acc.plus(s.freeCollateral), dec('0'));
  const totalNetDeposits = subaccounts.reduce((acc, s) => acc.plus(s.netDeposits), dec('0'));

  logger?.debug(
    { subaccounts: subaccounts.length, scannedMaxIndex: maxIndex },
    'collected account overview',
  );

  return {
    subaccounts,
    totalEquity,
    totalFreeCollateral,
    totalNetDeposits,
    totalLifetimeRoiPct: lifetimeRoiPct(totalEquity, totalNetDeposits),
    scannedMaxIndex: maxIndex,
  };
}
