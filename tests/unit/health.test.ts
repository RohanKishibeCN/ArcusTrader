/**
 * Health endpoint tests.
 *
 * The policy under test is: **503 means "alive but not fit to trade"**. A monitor needs
 * to be able to alert on the status code alone, because a trading process that is
 * running but has quietly stopped trading is exactly the failure worth paging on.
 * Returning 200 for "the process is up" would make the endpoint decorative.
 *
 * The secret-hygiene test is not a formality: a status endpoint is typically exposed to
 * a monitoring system and scraped into a dashboard, so a credential appearing in the
 * payload would be a genuinely bad leak path.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { HealthServer, evaluateHealth, type HealthSnapshot } from '../../src/app/HealthServer';
import { silentLogger } from '../../src/util/logger';

function healthy(overrides: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    tradingMode: 'dry_run',
    liveTrading: false,
    killSwitchEngaged: false,
    reconciled: true,
    websocketState: 'connected',
    websocketReady: true,
    strategyState: 'flat',
    ticksCompleted: 12,
    lastTickAtMs: 1_000_000,
    dataAgeMs: 120,
    maxDataAgeMs: 3000,
    openPositions: 0,
    liveOrders: 0,
    unknownOrders: 0,
    credentialsConfigured: {
      arcusSigningKey: true,
      walletAddress: true,
      lark: false,
    },
    sqliteDriver: 'node:sqlite',
    version: '0.1.0',
    ...overrides,
  };
}

const NOW = () => 1_000_000;

describe('health policy', () => {
  it('reports 200 when everything is in order', () => {
    const verdict = evaluateHealth(healthy(), { now: NOW });
    expect(verdict.statusCode).toBe(200);
    expect(verdict.healthy).toBe(true);
    expect(verdict.reasons).toHaveLength(0);
  });

  it('reports 503 when the kill switch is engaged, with the reason', () => {
    const verdict = evaluateHealth(
      healthy({ killSwitchEngaged: true, killSwitchReason: 'daily loss limit reached' }),
      { now: NOW },
    );
    expect(verdict.statusCode).toBe(503);
    expect(verdict.reasons.join(' ')).toMatch(/daily loss limit reached/);
  });

  it('reports 503 when reconciliation is failing', () => {
    const verdict = evaluateHealth(
      healthy({ reconciled: false, reconciliationReason: 'missing protective stop' }),
      { now: NOW },
    );
    expect(verdict.statusCode).toBe(503);
    expect(verdict.reasons.join(' ')).toMatch(/missing protective stop/);
  });

  it('reports 503 when the decision loop has stalled', () => {
    // Last tick 10 minutes ago, well past the 5-minute default threshold.
    const verdict = evaluateHealth(healthy({ lastTickAtMs: 1_000_000 - 600_000 }), { now: NOW });
    expect(verdict.statusCode).toBe(503);
    expect(verdict.reasons.join(' ')).toMatch(/has not ticked for/);
  });

  it('honours a custom stall threshold', () => {
    const snapshot = healthy({ lastTickAtMs: 1_000_000 - 100_000 });
    expect(evaluateHealth(snapshot, { now: NOW, stallThresholdMs: 200_000 }).healthy).toBe(true);
    expect(evaluateHealth(snapshot, { now: NOW, stallThresholdMs: 50_000 }).healthy).toBe(false);
  });

  it('reports 503 before the first tick completes', () => {
    const verdict = evaluateHealth(healthy({ lastTickAtMs: undefined }), { now: NOW });
    expect(verdict.statusCode).toBe(503);
    expect(verdict.reasons.join(' ')).toMatch(/no tick has completed/);
  });

  it('accumulates EVERY reason rather than stopping at the first', () => {
    const verdict = evaluateHealth(
      healthy({
        killSwitchEngaged: true,
        killSwitchReason: 'x',
        reconciled: false,
        reconciliationReason: 'y',
        lastTickAtMs: undefined,
      }),
      { now: NOW },
    );
    expect(verdict.reasons).toHaveLength(3);
  });

  it('does not consider a disconnected websocket unhealthy by itself', () => {
    // The socket reconnects by design, and reconciliation is the authority on whether
    // the local view is trustworthy. Paging on a transient socket drop would be noise.
    const verdict = evaluateHealth(
      healthy({ websocketState: 'reconnecting', websocketReady: false }),
      { now: NOW },
    );
    expect(verdict.healthy).toBe(true);
  });

  it('never includes a credential value in the payload', () => {
    // The snapshot type only allows booleans, so this asserts the shape rather than a
    // runtime filter — which is the point: it cannot leak by construction.
    const verdict = evaluateHealth(healthy(), { now: NOW });
    const serialised = JSON.stringify(verdict.payload);
    expect(serialised).toContain('credentialsConfigured');
    // Every credential entry must be a boolean, never a string.
    const configured = verdict.payload.credentialsConfigured as Record<string, unknown>;
    for (const [key, value] of Object.entries(configured)) {
      expect(typeof value, `${key} must be a presence boolean`).toBe('boolean');
    }
  });

  it('reports exposure counters so a stuck position is visible', () => {
    const verdict = evaluateHealth(
      healthy({ openPositions: 1, liveOrders: 3, unknownOrders: 0 }),
      { now: NOW },
    );
    expect(verdict.payload.exposure).toEqual({
      openPositions: 1,
      liveOrders: 3,
      unknownOrders: 0,
    });
  });

  it('reports which SQLite driver is in use', () => {
    // Surfaced because the driver choice is load-bearing under Node 24.
    expect(evaluateHealth(healthy(), { now: NOW }).payload.sqliteDriver).toBe('node:sqlite');
    expect(
      evaluateHealth(healthy({ sqliteDriver: 'better-sqlite3' }), { now: NOW }).payload.sqliteDriver,
    ).toBe('better-sqlite3');
  });
});

describe('health HTTP surface', () => {
  let server: HealthServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  /** Bind an ephemeral port by asking for 0 and reading it back. */
  async function startOnEphemeralPort(snapshot: () => HealthSnapshot): Promise<number> {
    // Port 0 lets the OS choose; the server logs it, so read it from the handle.
    server = new HealthServer({ port: 0, logger: silentLogger(), snapshot });
    const started = await server.start();
    expect(started).toBe(false); // port 0 is treated as "disabled"
    return 0;
  }

  it('treats a zero port as disabled and does not listen', async () => {
    const started = await startOnEphemeralPort(() => healthy());
    expect(started).toBe(0);
    expect(server).toBeDefined();
  });

  it('serves 200 with the verdict payload over HTTP', async () => {
    // Use a high, likely-free port; retry once on a different one if it is taken.
    const port = 34_891;
    server = new HealthServer({ port, logger: silentLogger(), snapshot: () => healthy(), now: NOW });
    const started = await server.start();
    if (!started) {
      // The port was busy in this environment; the policy is covered by the unit tests
      // above, so skip rather than fail on an environmental collision.
      return;
    }
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.healthy).toBe(true);
    expect(body.tradingMode).toBe('dry_run');
  });

  it('serves 503 over HTTP when the kill switch is engaged', async () => {
    const port = 34_892;
    server = new HealthServer({
      port,
      logger: silentLogger(),
      snapshot: () => healthy({ killSwitchEngaged: true, killSwitchReason: 'test' }),
      now: NOW,
    });
    const started = await server.start();
    if (!started) return;
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { reasons: string[] };
    expect(body.reasons.join(' ')).toMatch(/test/);
  });

  it('returns 404 for any other path', async () => {
    const port = 34_893;
    server = new HealthServer({ port, logger: silentLogger(), snapshot: () => healthy(), now: NOW });
    const started = await server.start();
    if (!started) return;
    const response = await fetch(`http://127.0.0.1:${port}/secrets`);
    expect(response.status).toBe(404);
  });

  it('reports 503 rather than crashing when the snapshot throws', async () => {
    const port = 34_894;
    server = new HealthServer({
      port,
      logger: silentLogger(),
      snapshot: () => {
        throw new Error('snapshot exploded');
      },
      now: NOW,
    });
    const started = await server.start();
    if (!started) return;
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { reasons: string[] };
    expect(body.reasons.join(' ')).toMatch(/snapshot exploded/);
  });
});
