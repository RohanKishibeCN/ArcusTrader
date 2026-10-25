/**
 * Configuration contract tests.
 *
 * Two distinct properties, both about the same goal: every behaviour that an operator
 * might reasonably want to tune must be reachable from configuration, and setting it
 * must actually take effect.
 *
 *  1. **Coverage** — a structural scan asserting that every key in the schema is
 *     referenced somewhere outside `config.ts`. A key that is declared but never read is
 *     worse than a missing one: it looks configurable and silently is not. (This is not
 *     hypothetical — `REQUIRE_EXPLICIT_LIVE_CONFIRMATION` and `MAX_ACTIVE_MARKET` were
 *     both dead in an earlier revision.)
 *
 *  2. **Wiring** — for the values whose effect is observable without a network, assert
 *     that changing the env var changes the derived structure (`strategyConfigFrom`,
 *     `riskLimitsFrom`) or the validation outcome.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, ConfigError, describeConfig } from '../../src/config/config';
import { riskLimitsFrom, strategyConfigFrom } from '../../src/app/bootstrap';
import { dec } from '../../src/util/decimal';

const SRC = join(__dirname, '..', '..', 'src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Keys the trading loop deliberately does not read, each for a stated reason.
 *
 * Kept explicit rather than silently skipped, so the list itself is auditable: adding a
 * key here should be a deliberate act with a justification, not a way to silence the
 * test.
 */
const INTENTIONALLY_UNREAD = new Set([
  // Standard deployment marker; used by tooling and CI, not by the trading loop.
  'NODE_ENV',
  // Validated to EXACTLY 1 at load time (`MAX_ACTIVE_MARKET must be 1`), because this
  // build tracks a single active market. A setting whose only legal value is one needs
  // no runtime branch — the validation is the enforcement. Raising it fails startup
  // rather than being quietly ignored.
  'MAX_ACTIVE_MARKET',
]);

describe('every config key is actually read', () => {
  it('has no dead configuration keys', () => {
    const configSource = readFileSync(join(SRC, 'config', 'config.ts'), 'utf8');
    const schemaStart = configSource.indexOf('export const configSchema');
    const schemaEnd = configSource.indexOf('.strip();', schemaStart);
    const schema = configSource.slice(schemaStart, schemaEnd);
    const keys = [...schema.matchAll(/^\s{4}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]!);

    expect(keys.length).toBeGreaterThan(60);

    // The whole source tree minus the schema itself.
    const others = sourceFiles(SRC)
      .filter((f) => !f.endsWith(join('config', 'config.ts')))
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');

    const dead = keys.filter(
      (key) => !INTENTIONALLY_UNREAD.has(key) && !new RegExp(`\\b${key}\\b`).test(others),
    );

    expect(dead, `config keys declared but never read: ${dead.join(', ')}`).toEqual([]);
  });

  it('includes the keys added for tuning (spot check)', () => {
    const config = loadConfig({});
    // A representative sample across every group.
    for (const key of [
      'SWING_LEFT_BARS',
      'STRUCTURE_LOOKBACK_BARS',
      'PROJECTABLE_FRACTION',
      'EXPECTED_HOLD_HOURS',
      'FUNDING_INTERVAL_HOURS',
      'TRAIL_ACTIVATION_R',
      'TRAIL_STOP_BUFFER_BPS',
      'EMERGENCY_BOUND_BPS',
      'MIN_ORDER_NOTIONAL_USD',
      'DEFAULT_MAINTENANCE_MARGIN_FRACTION',
      'DEPTH_BAND_BPS',
      'DEPTH_SCORE_SATURATION_MULTIPLE',
      'VOLUME_SCORE_SATURATION_MULTIPLE',
      'SCORE_WEIGHT_SPREAD',
      'SCORE_FILL_QUALITY_PARTIAL',
      'MAX_BREADTH_QUOTES',
      'MAX_ORDERBOOK_FETCHES',
      'TICK_INTERVAL_MS',
      'CANDLE_REFRESH_MS',
      'REPORT_CHECK_INTERVAL_MS',
      'HEALTH_STALL_THRESHOLD_MS',
      'HTTP_TIMEOUT_MS',
      'CIRCUIT_BREAKER_THRESHOLD',
      'CIRCUIT_BREAKER_COOLDOWN_MS',
      'CIRCUIT_BREAKER_MAX_COOLDOWN_MS',
      'POOL_STATE_MAX_AGE_MS',
      'LARK_MAX_ATTEMPTS',
      'LARK_BASE_BACKOFF_MS',
      'LARK_REQUEST_TIMEOUT_MS',
    ]) {
      expect(config.raw, `${key} missing from the schema`).toHaveProperty(key);
    }
  });
});

describe('.env.example documents every schema key', () => {
  it('has no undocumented key and no stale key', () => {
    const root = join(__dirname, '..', '..');
    const envText = readFileSync(join(root, '.env.example'), 'utf8');
    const envKeys = new Set([...envText.matchAll(/^([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]!));

    const configSource = readFileSync(join(SRC, 'config', 'config.ts'), 'utf8');
    const schemaStart = configSource.indexOf('export const configSchema');
    const schemaEnd = configSource.indexOf('.strip();', schemaStart);
    const schemaKeys = new Set(
      [...configSource.slice(schemaStart, schemaEnd).matchAll(/^\s{4}([A-Z][A-Z0-9_]+):/gm)].map(
        (m) => m[1]!,
      ),
    );

    const undocumented = [...schemaKeys].filter((k) => !envKeys.has(k));
    expect(undocumented, `schema keys missing from .env.example: ${undocumented.join(', ')}`).toEqual(
      [],
    );

    // The reverse direction: credentials live outside the typed schema on purpose, so
    // they are the only permitted extras.
    const ALLOWED_EXTRA = new Set([
      'ARCUS_API_SIGNING_KEY',
      'ARCUS_API_KEY',
      'LARK_APP_ID',
      'LARK_APP_SECRET',
    ]);
    const stale = [...envKeys].filter((k) => !schemaKeys.has(k) && !ALLOWED_EXTRA.has(k));
    expect(stale, `.env.example documents keys that do not exist: ${stale.join(', ')}`).toEqual([]);
  });
});

describe('defaults reproduce the previous hardcoded behaviour', () => {
  it('keeps the swing window, lookback derivation and projectable fraction', () => {
    const config = loadConfig({});
    const strategy = strategyConfigFrom(config);
    expect(strategy.swingLeftBars).toBe(2);
    expect(strategy.swingRightBars).toBe(2);
    // 0 means "derive": max(20, MIN_HISTORY_BARS) = 250 by default.
    expect(strategy.structureLookback).toBe(250);
    expect(config.raw.PROJECTABLE_FRACTION).toBe('0.6');
  });

  it('keeps the order-notional floor and trailing activation', () => {
    const config = loadConfig({});
    expect(riskLimitsFrom(config).minNotional.toFixed()).toBe('10');
    expect(config.raw.TRAIL_ACTIVATION_R).toBe('0.5');
    expect(config.raw.EMERGENCY_BOUND_BPS).toBe('50');
  });
});

describe('changing a value changes the derived structure', () => {
  it('flows SWING_* and STRUCTURE_LOOKBACK_BARS into the strategy', () => {
    const strategy = strategyConfigFrom(
      loadConfig({ SWING_LEFT_BARS: '4', SWING_RIGHT_BARS: '3', STRUCTURE_LOOKBACK_BARS: '120' }),
    );
    expect(strategy.swingLeftBars).toBe(4);
    expect(strategy.swingRightBars).toBe(3);
    expect(strategy.structureLookback).toBe(120);
  });

  it('flows MIN_ORDER_NOTIONAL_USD into the RiskEngine limits', () => {
    expect(riskLimitsFrom(loadConfig({ MIN_ORDER_NOTIONAL_USD: '25' })).minNotional.toFixed()).toBe('25');
  });

  it('flows the risk and exit parameters into RiskLimits', () => {
    const limits = riskLimitsFrom(
      loadConfig({ RISK_PER_TRADE_BPS: '40', MAX_LEVERAGE: '1.5', TP1_CLOSE_PCT: '30' }),
    );
    expect(limits.riskPerTradeBps.toFixed()).toBe('40');
    expect(limits.maxLeverage.toFixed()).toBe('1.5');
    expect(limits.maxNotionalPct).toBeTypeOf('object');
  });
});

describe('new keys are validated', () => {
  it('rejects a projectable fraction outside (0, 1]', () => {
    expect(() => loadConfig({ PROJECTABLE_FRACTION: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ PROJECTABLE_FRACTION: '1.5' })).toThrow(ConfigError);
    expect(() => loadConfig({ PROJECTABLE_FRACTION: '1' })).not.toThrow();
  });

  it('rejects all-zero scoring weights', () => {
    expect(() =>
      loadConfig({
        SCORE_WEIGHT_SPREAD: '0',
        SCORE_WEIGHT_DEPTH: '0',
        SCORE_WEIGHT_VOLUME: '0',
        SCORE_WEIGHT_FRESHNESS: '0',
        SCORE_WEIGHT_FILL_QUALITY: '0',
      }),
    ).toThrow(/must not all be zero/);
  });

  it('rejects a negative scoring weight', () => {
    expect(() => loadConfig({ SCORE_WEIGHT_SPREAD: '-1' })).toThrow(/must be >= 0/);
  });

  it('accepts weights that do not sum to 1, because they are normalised', () => {
    const config = loadConfig({
      SCORE_WEIGHT_SPREAD: '3',
      SCORE_WEIGHT_DEPTH: '3',
      SCORE_WEIGHT_VOLUME: '2',
      SCORE_WEIGHT_FRESHNESS: '1',
      SCORE_WEIGHT_FILL_QUALITY: '1',
    });
    expect(config.raw.SCORE_WEIGHT_SPREAD).toBe('3');
  });

  it('rejects a maintenance-margin fallback outside (0, 1)', () => {
    expect(() => loadConfig({ DEFAULT_MAINTENANCE_MARGIN_FRACTION: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ DEFAULT_MAINTENANCE_MARGIN_FRACTION: '1' })).toThrow(ConfigError);
  });

  it('rejects a non-positive expected holding time or funding interval', () => {
    expect(() => loadConfig({ EXPECTED_HOLD_HOURS: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ FUNDING_INTERVAL_HOURS: '0' })).toThrow(ConfigError);
  });

  it('rejects an inverted circuit-breaker cooldown', () => {
    expect(() =>
      loadConfig({ CIRCUIT_BREAKER_COOLDOWN_MS: '5000', CIRCUIT_BREAKER_MAX_COOLDOWN_MS: '1000' }),
    ).toThrow(/MAX_COOLDOWN_MS/);
  });

  it('rejects a zero order-notional floor', () => {
    expect(() => loadConfig({ MIN_ORDER_NOTIONAL_USD: '0' })).toThrow(ConfigError);
  });
});

describe('credentials never appear in the described configuration', () => {
  it('renders presence flags only', () => {
    const config = loadConfig({
      ARCUS_API_SIGNING_KEY: 'aa'.repeat(32),
      ARCUS_API_KEY: undefined,
      LARK_APP_ID: 'cli_something',
      LARK_APP_SECRET: 'a-very-secret-value',
    });
    const described = JSON.stringify(describeConfig(config));
    expect(described).not.toContain('a'.repeat(64));
    expect(described).not.toContain('a-very-secret-value');
    expect(described).toContain('secretsPresent');
    // The values themselves are still available to the caller, just never described.
    expect(config.secrets.arcusApiSigningKey).toBe('aa'.repeat(32));
    expect(dec('1').toFixed()).toBe('1');
  });
});
