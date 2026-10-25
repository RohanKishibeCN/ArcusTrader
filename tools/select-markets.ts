/**
 * Rank tradable markets by measured liquidity, for pinning MARKET_ALLOWLIST.
 *
 * WHY THIS EXISTS
 *
 * Market selection turned out to be a strategy parameter, not a preference. The same
 * `swing` strategy over the same account and window:
 *
 *   tight-spread majors (BTC/ETH/SOL/SPY/NVDA/QQQ)  ->  net -29.34, PF 0.54, -12.4 bps
 *   wider-spread crypto   (SOL/ZEC/NEAR/ENA/SUI/FART) ->  net  +2.41, PF 1.04,  +2.2 bps
 *
 * That is a ~15 bps swing in PnL per unit of volume from market choice alone. The
 * built-in liquidity score ranks tightness FIRST, which would re-select the losing
 * basket, so an operator needs a way to pin a different universe — and a reproducible
 * way to produce that universe rather than picking yesterday's winners by hand.
 *
 * This tool measures, it does not choose: it prints the candidates and a ready-to-paste
 * allowlist, and the operator is expected to backtest the pinned set before trusting it.
 *
 * Usage:
 *   pnpm tsx tools/select-markets.ts [--top 8] [--band-bps 25] [--min-vol 250000]
 *                                   [--min-depth 25000] [--max-spread 15]
 */

import { Decimal, dec } from '../src/util/decimal';

const BASE = process.env.ARCUS_REST_URL ?? 'https://api.arcus.xyz';

interface MarketRow {
  readonly symbol: string;
  readonly category: string;
  readonly volume24h: number;
  readonly spreadBps: number;
  readonly depthUsd: number;
  readonly isOutsideRth: boolean | null;
}

function arg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1]! : fallback;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Sum of bid notional within `bandBps` of mid — the same measure the runtime uses. */
function depthWithinBand(
  levels: readonly (readonly [string, string])[],
  mid: Decimal,
  bandBps: number,
): number {
  let total = dec('0');
  for (const [priceRaw, sizeRaw] of levels) {
    const price = dec(priceRaw);
    if (!price.greaterThan(0)) continue;
    const distanceBps = mid.minus(price).abs().div(mid).times(10_000);
    if (distanceBps.greaterThan(bandBps)) continue;
    total = total.plus(price.times(dec(sizeRaw)));
  }
  return Number(total.toFixed(0));
}

async function main(): Promise<void> {
  const top = Number(arg('top', '8'));
  const bandBps = Number(arg('band-bps', '25'));
  const minVol = Number(arg('min-vol', '250000'));
  const minDepth = Number(arg('min-depth', '25000'));
  const maxSpread = Number(arg('max-spread', '15'));

  const { markets } = await getJson<{ markets: { marketDisplayName: string; status: string; category: string; volume24hNotional?: string; isOutsideRth?: boolean | null }[] }>(
    '/v1/markets',
  );

  const rows: MarketRow[] = [];
  for (const market of markets) {
    if (market.status !== 'ONLINE') continue;
    const symbol = market.marketDisplayName;
    try {
      const bbo = await getJson<{ bestBid: { price: string }; bestAsk: { price: string } }>(
        `/v1/bbo/${encodeURIComponent(symbol)}`,
      );
      const bid = dec(bbo.bestBid.price);
      const ask = dec(bbo.bestAsk.price);
      if (!bid.greaterThan(0) || !ask.greaterThan(0)) continue;
      const mid = bid.plus(ask).div(2);
      const spreadBps = Number(ask.minus(bid).div(mid).times(10_000).toFixed(2));

      const book = await getJson<{ bids: [string, string][] }>(
        `/v1/l2OrderBook/${encodeURIComponent(symbol)}`,
      );
      const depthUsd = depthWithinBand(book.bids ?? [], mid, bandBps);

      rows.push({
        symbol,
        category: market.category,
        volume24h: Number(market.volume24hNotional ?? 0),
        spreadBps,
        depthUsd,
        isOutsideRth: market.isOutsideRth ?? null,
      });
    } catch {
      // One unreadable market must not abort the scan; it is simply not a candidate.
      continue;
    }
  }

  const pass = rows.filter(
    (r) =>
      r.volume24h >= minVol && r.depthUsd >= minDepth && r.spreadBps <= maxSpread && r.spreadBps > 0,
  );

  // Ranked by measured spread: among markets that clear the quality gates, a wider
  // spread is the variable the backtest rewarded, because the entry is post-only and
  // therefore earns rather than pays it.
  pass.sort((a, b) => b.spreadBps - a.spreadBps);

  const pad = (v: string | number, n: number): string => String(v).padEnd(n);

  console.log(
    `scanned ${rows.length} markets | pass vol>=${minVol} depth>=${minDepth} spread<=${maxSpread}bps: ${pass.length}\n`,
  );
  console.log(
    `${pad('symbol', 14)}${pad('cat', 12)}${pad('spread_bps', 12)}${pad('depth_usd', 12)}${pad('vol24h($M)', 12)}rth`,
  );
  for (const r of pass.slice(0, Math.max(top, 15))) {
    console.log(
      pad(r.symbol, 14) +
        pad(r.category, 12) +
        pad(r.spreadBps.toFixed(2), 12) +
        pad(r.depthUsd, 12) +
        pad((r.volume24h / 1e6).toFixed(2), 12) +
        (r.isOutsideRth === null ? 'unknown' : r.isOutsideRth ? 'off' : 'open'),
    );
  }

  const allowlist = pass.slice(0, top).map((r) => r.symbol).join(',');
  console.log(`\nPIN with (backtest it first):\nMARKET_ALLOWLIST=${allowlist}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
