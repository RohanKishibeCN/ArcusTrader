/**
 * Wallet overview across subaccounts, and how it reaches the daily report.
 *
 * The property that matters most here is the SCOPE DISCIPLINE: equity is consolidated,
 * but the two volume figures are reported at the scope the venue actually uses. Getting
 * this wrong would produce a report that looks right and means something else, so the
 * tests pin the distinction rather than just the arithmetic.
 */

import { describe, expect, it } from 'vitest';
import { collectAccountOverview, lifetimeRoiPct } from '../../src/app/AccountOverview';
import { dec } from '../../src/util/decimal';
import type { Account } from '../../src/arcus/types';
import { renderReportText, type DailyReportInput } from '../../src/notifications/DailyReport';
import { loadConfig } from '../../src/config/config';

function account(accountIndex: number, equity: string, netDeposits: string): Account {
  return {
    accountIndex: accountIndex as Account['accountIndex'],
    address: '0x0000000000000000000000000000000000000001',
    netQuoteBalance: equity,
    equity,
    freeCollateral: equity,
    netDeposits,
    positions: {},
  };
}

/** Records which indexes were asked for and returns the configured accounts. */
function readerFor(accounts: readonly Account[]) {
  const asked: number[] = [];
  return {
    asked,
    async getAccount(_address: string, accountIndex: number) {
      asked.push(accountIndex);
      return accounts.find((a) => a.accountIndex === accountIndex);
    },
  };
}

describe('lifetimeRoiPct', () => {
  it('is equity over deposits, as a percentage', () => {
    expect(lifetimeRoiPct(dec('369.34'), dec('503.98'))?.toFixed(2)).toBe('-26.72');
    expect(lifetimeRoiPct(dec('120'), dec('100'))?.toFixed(2)).toBe('20.00');
  });

  it('is undefined without deposits, rather than a fabricated 0%', () => {
    // A 0% here would read as "flat" when the account is simply unfunded.
    expect(lifetimeRoiPct(dec('0'), dec('0'))).toBeUndefined();
    expect(lifetimeRoiPct(dec('10'), dec('0'))).toBeUndefined();
  });

  it('reports a total loss as -100%, not as undefined', () => {
    expect(lifetimeRoiPct(dec('0'), dec('500'))?.toFixed(2)).toBe('-100.00');
  });
});

describe('collectAccountOverview', () => {
  it('scans 0..max and skips indexes with no activity', async () => {
    const reader = readerFor([account(0, '369.34', '503.98'), account(2, '100', '100')]);
    const overview = await collectAccountOverview({ reader, address: '0xabc', maxIndex: 3 });

    expect(reader.asked).toEqual([0, 1, 2, 3]);
    expect(overview.subaccounts.map((s) => s.accountIndex)).toEqual([0, 2]);
    expect(overview.scannedMaxIndex).toBe(3);
  });

  it('consolidates equity and deposits across subaccounts', async () => {
    const reader = readerFor([
      account(0, '369.34', '503.98'),
      account(1, '100', '100'),
      account(2, '30.66', '0'),
    ]);
    const overview = await collectAccountOverview({ reader, address: '0xabc', maxIndex: 2 });

    expect(overview.totalEquity.toFixed(2)).toBe('500.00');
    expect(overview.totalNetDeposits.toFixed(2)).toBe('603.98');
    // Deposits are positive, so the ratio is meaningful.
    expect(overview.totalLifetimeRoiPct?.toFixed(2)).toBe('-17.22');
  });

  it('is undefined for total ROI when no subaccount has deposits', async () => {
    const reader = readerFor([account(0, '0', '0')]);
    const overview = await collectAccountOverview({ reader, address: '0xabc', maxIndex: 1 });
    expect(overview.totalLifetimeRoiPct).toBeUndefined();
  });

  it('omits a subaccount it cannot read instead of failing the whole overview', async () => {
    const asked: number[] = [];
    const reader = {
      async getAccount(_a: string, i: number) {
        asked.push(i);
        if (i === 1) throw new Error('HTTP 500');
        return i === 0 ? account(0, '10', '10') : undefined;
      },
    };
    const overview = await collectAccountOverview({ reader, address: '0xabc', maxIndex: 2 });
    expect(asked).toEqual([0, 1, 2]);
    expect(overview.subaccounts.map((s) => s.accountIndex)).toEqual([0]);
  });

  it('reports an empty overview when nothing has activity', async () => {
    const reader = readerFor([]);
    const overview = await collectAccountOverview({ reader, address: '0xabc', maxIndex: 2 });
    expect(overview.subaccounts).toEqual([]);
    expect(overview.totalEquity.toFixed(2)).toBe('0.00');
    expect(overview.totalLifetimeRoiPct).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * Report rendering
 * ------------------------------------------------------------------ */

function baseInput(overrides: Partial<DailyReportInput> = {}): DailyReportInput {
  return {
    reportDate: '2026-10-25',
    generatedAtMs: 1_790_000_000_000,
    timezone: 'Asia/Shanghai',
    wallet: '0x0000000000000000000000000000000000000001',
    accountIndex: 0,
    exchange: 'https://api.arcus.xyz',
    tradingMode: 'dry_run',
    liveTrading: false,
    equity: dec('369.34'),
    freeCollateral: dec('369.34'),
    usedMargin: dec('0'),
    netQuoteBalance: dec('369.34'),
    maintenanceMargin: dec('0'),
    depositsToday: dec('0'),
    withdrawalsToday: dec('0'),
    netDepositsLifetime: dec('503.98'),
    realizedPnl: dec('0'),
    unrealizedPnl: dec('0'),
    fees: dec('0'),
    funding: dec('0'),
    estimatedSlippage: dec('0'),
    netTradingPnl: dec('0'),
    cashFlowAdjustedReturnPct: undefined,
    fillCount: 0,
    grossVolumeNotional: dec('0'),
    makerRatio: dec('0'),
    winRate: dec('0'),
    profitFactor: undefined,
    maxDrawdownPct: dec('0'),
    consecutiveLosses: 0,
    averageHoldMs: 0,
    positions: [],
    strategyState: 'flat',
    activeMarket: 'SOL-USD',
    candidateMarkets: [],
    offHoursEntriesAllowed: false,
    withdrawable: { amount: dec('300'), components: {} },
    anomalies: [],
    recommendations: [],
    isOutsideRthAny: false,
    dataAgeMs: 100,
    websocket: { state: 'open', ready: true, reconnects: 0, errorFrames: 0 },
    killSwitch: { engaged: false },
    pipeline: { evaluations: 0, noSignal: 0, rejectedByCost: 0, rejectedByRisk: 0, approved: 0 },
    rateLimit: { weightAvailable: dec('800'), weightCapacity: 900, throttledCount: 0 },
    reconciliation: { reconciled: true, blockingCount: 0 },
    unknownOrders: 0,
    ...overrides,
  } as DailyReportInput;
}

describe('report renders the wallet and referral sections', () => {
  it('shows consolidated equity, deposits and ROI', async () => {
    const overview = await collectAccountOverview({
      reader: readerFor([account(0, '369.34', '503.98'), account(1, '100', '100')]),
      address: '0xabc',
      maxIndex: 2,
    });
    const text = renderReportText(baseInput({ accountOverview: overview }));

    expect(text).toContain('Wallet across subaccounts');
    expect(text).toContain('Total equity: $469.34');
    expect(text).toContain('Lifetime net deposits: $603.98');
    expect(text).toContain('lifetime ROI: -22.29%');
    expect(text).toContain('#1: equity $100.00');
    // The active index is flagged so a reader knows which account is trading.
    expect(text).toContain('← active');
  });

  it('omits both sections entirely when the data is unavailable', () => {
    const text = renderReportText(baseInput());
    expect(text).not.toContain('Wallet across subaccounts');
    expect(text).not.toContain('Referral & fees');
  });

  it('labels the 30d volume as wallet-level, not per subaccount', () => {
    const text = renderReportText(
      baseInput({
        affiliate: {
          address: '0xabc',
          code: 'ABC123',
          kickbackBps: 500,
          tier: 2,
          totalCommissionUsd: dec('12.34'),
          pendingCommissionUsd: dec('1.00'),
          commission30dUsd: dec('2.00'),
          volume30dUsd: dec('250000'),
          referredVolume30dUsd: dec('1000'),
          referredVolumeAllTimeUsd: dec('5000'),
          traderCount: 3,
          tradingFeeTier: { level: 2, makerFeeBps: dec('0.8'), takerFeeBps: dec('3.2') },
        },
      }),
    );
    expect(text).toContain('30d own volume (all subaccounts): $250000.00');
    expect(text).toContain('maker 0.8 bps');
    expect(text).toContain('`ABC123`');
    expect(text).toContain('Referees: 3');
    expect(text).toContain('lifetime $12.34');
  });

  it('shows "none" for an absent referral code rather than an empty string', () => {
    const text = renderReportText(
      baseInput({
        affiliate: {
          address: '0xabc',
          code: '',
          kickbackBps: 0,
          tier: 0,
          totalCommissionUsd: dec('0'),
          pendingCommissionUsd: dec('0'),
          commission30dUsd: dec('0'),
          volume30dUsd: dec('0'),
          referredVolume30dUsd: dec('0'),
          referredVolumeAllTimeUsd: dec('0'),
          traderCount: 0,
        },
      }),
    );
    expect(text).toContain('Referral code: none');
  });
});

describe('report toggles follow configuration', () => {
  it('defaults both blocks on', () => {
    const config = loadConfig({});
    expect(config.raw.REPORT_INCLUDE_ACCOUNT_OVERVIEW).toBe(true);
    expect(config.raw.REPORT_INCLUDE_AFFILIATE).toBe(true);
    expect(config.raw.ACCOUNT_OVERVIEW_MAX_INDEX).toBe(9);
  });

  it('can be switched off independently', () => {
    const config = loadConfig({
      REPORT_INCLUDE_ACCOUNT_OVERVIEW: 'false',
      REPORT_INCLUDE_AFFILIATE: 'false',
    });
    expect(config.raw.REPORT_INCLUDE_ACCOUNT_OVERVIEW).toBe(false);
    expect(config.raw.REPORT_INCLUDE_AFFILIATE).toBe(false);
  });

  it('rejects an account index outside the venue range', () => {
    expect(() => loadConfig({ ACCOUNT_OVERVIEW_MAX_INDEX: '10' })).toThrow(/ACCOUNT_OVERVIEW_MAX_INDEX/);
  });
});
