#!/usr/bin/env node
/**
 * Fetch the Arcus documentation snapshot used as the source of truth for this
 * project's API contracts.
 *
 * Why this exists: the endpoint list in the original task brief does not match
 * the live Arcus doc paths (e.g. the brief says
 * `/api-reference/public/get-markets`, the live site serves
 * `/api-reference/market-data/markets`). Rather than guess field names, we
 * snapshot the official markdown (Mintlify serves a `.md` rendition of every
 * page) and derive contracts from that.
 *
 * Usage:
 *   node tools/fetch-arcus-docs.mjs            # fetch pages listed in PAGES
 *   node tools/fetch-arcus-docs.mjs --index    # only fetch llms.txt
 *
 * Output: docs/arcus/*.md plus docs/arcus/manifest.json (url -> sha256 + size).
 * The manifest makes it obvious when upstream docs change: re-run and diff.
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'arcus');
const BASE = 'https://docs.arcus.xyz';

/** Pages we depend on. Keep in sync with README "Documentation sources". */
const PAGES = [
  // API fundamentals
  'api-reference/introduction',
  'api-reference/authentication',
  'api-reference/websocket',
  'api-reference/rate-limits',
  // Market data (REST)
  'api-reference/market-data/markets',
  'api-reference/public/get-markets',
  'api-reference/public/get-ohlcv-candles',
  'api-reference/public/get-best-bid-offer-bbo',
  'api-reference/public/get-l2-orderbook-snapshot',
  'api-reference/public/get-market-funding-rates',
  'api-reference/public/get-live-prices-for-all-markets',
  'api-reference/public/get-all-mid-prices',
  'api-reference/public/get-fee-tier-table',
  'api-reference/public/get-recent-public-trades',
  'api-reference/public/get-current-server-time',
  'api-reference/public/get-current-rate-limit-usage',
  'api-reference/public/health-check',
  // Account (REST)
  'api-reference/public/get-account',
  'api-reference/public/get-positions',
  'api-reference/public/get-open-orders',
  'api-reference/public/get-fills',
  'api-reference/public/get-order-status',
  'api-reference/public/get-order-history',
  'api-reference/public/get-account-transfer-updates',
  'api-reference/public/get-funding-payments',
  'api-reference/public/get-account-stats',
  'api-reference/public/get-portfolio-history',
  'api-reference/public/get-leverage-and-margin-mode-for-an-account-across-all-markets',
  // Exchange (REST, signed)
  'api-reference/exchange/place-order',
  'api-reference/exchange/cancel-order',
  'api-reference/exchange/modify-order',
  'api-reference/exchange/cancel-all-open-orders',
  'api-reference/exchange/set-leverage-for-a-market',
  'api-reference/exchange/add-or-remove-margin-on-an-isolated-mode-position',
  'api-reference/exchange/schedule-cancel-all-dead-mans-switch',
  'api-reference/exchange/submit-withdrawal',
  'api-reference/exchange/submit-internal-transfer',
  // WebSocket channels
  'api-reference/market-data/l2orderbook',
  'api-reference/market-data/l2orderbookupdates',
  'api-reference/market-data/trades',
  'api-reference/market-data/marketattributes',
  'api-reference/market-data/predictedfunding',
  'api-reference/market-data/candles',
  'api-reference/market-data/bbo',
  'api-reference/market-data/oracleprices',
  'api-reference/account/account',
  'api-reference/account/positions',
  'api-reference/account/orders',
  'api-reference/account/userfills',
  'api-reference/account/funding',
  'api-reference/account/accounttransferupdates',
  'api-reference/account/accountattributeupdates',
  'api-reference/trading/orderoperations',
  // Concepts
  'concepts/perpetuals/overview',
  'concepts/perpetuals/order-types',
  'concepts/perpetuals/margin',
  'concepts/perpetuals/margin-modes',
  'concepts/perpetuals/liquidations',
  'concepts/perpetuals/prices',
  'concepts/perpetuals/funding',
  'concepts/perpetuals/fees',
  'concepts/perpetuals/real-world-assets',
  'concepts/subaccounts',
  // Guides
  'guides/rest-trading',
  'guides/websocket-trading',
  'guides/latency',
];

/** Raw spec artifacts (no `.md` rendition). */
const SPECS = ['api-reference/asyncapi.yaml'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, { retries = 3 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': 'arcustrader-doc-snapshot/1.0' },
        signal: AbortSignal.timeout(45_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(500 * 2 ** (attempt - 1));
    }
  }
  throw lastErr;
}

async function main() {
  const indexOnly = process.argv.includes('--index');
  await mkdir(OUT, { recursive: true });

  const manifest = { fetchedAt: new Date().toISOString(), base: BASE, files: {} };

  const entries = [];
  if (indexOnly) {
    entries.push({ url: `${BASE}/llms.txt`, name: 'llms.txt' });
  } else {
    entries.push({ url: `${BASE}/llms.txt`, name: 'llms.txt' });
    for (const p of PAGES) entries.push({ url: `${BASE}/${p}.md`, name: `${p}.md` });
    for (const s of SPECS) entries.push({ url: `${BASE}/${s}`, name: s.replace(/\//g, '__') });
  }

  let ok = 0;
  const failed = [];
  for (const entry of entries) {
    try {
      const text = await fetchText(entry.url);
      const name = entry.name.replace(/\//g, '__');
      await writeFile(join(OUT, name), text, 'utf8');
      manifest.files[name] = {
        url: entry.url,
        bytes: Buffer.byteLength(text, 'utf8'),
        sha256: createHash('sha256').update(text).digest('hex').slice(0, 16),
      };
      ok += 1;
      process.stdout.write('.');
    } catch (err) {
      failed.push({ url: entry.url, error: String(err.message ?? err) });
      process.stdout.write('x');
    }
    await sleep(120); // be polite; also stays under per-IP weight limits
  }

  await writeFile(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  process.stdout.write('\n');
  console.log(`fetched ${ok}/${entries.length} -> ${OUT}`);
  if (failed.length) {
    console.log('failed:');
    for (const f of failed) console.log(`  ${f.url} :: ${f.error}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
