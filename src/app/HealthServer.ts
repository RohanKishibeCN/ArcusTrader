/**
 * Health check endpoint.
 *
 * Opt-in via `HEALTHCHECK_PORT` (default `0`, disabled). Off by default because a
 * trading process should not open a listening socket it does not need; on when an
 * operator wants a supervisor or uptime monitor to see the system's state without
 * reading logs.
 *
 * The status code is the interesting part, and it is deliberately strict:
 *
 *   **200** — the process is alive, the kill switch is clear, and reconciliation passed.
 *   **503** — the process is alive but NOT fit to trade: the kill switch is engaged, or
 *              reconciliation is failing, or the decision loop has stalled.
 *
 * A monitor can therefore alert on `503` alone. Returning 200 for "process is running"
 * would make the endpoint useless for its purpose, because a process that has silently
 * stopped trading is exactly the failure worth paging on.
 *
 * SECRETS: the payload reports only booleans and counters about credentials
 * (`credentialsConfigured`), never a value, prefix, or hash. The listener binds to
 * loopback by default for the same reason — an unauthenticated status endpoint should not
 * be exposed to the internet.
 */

import { createServer, type Server } from 'node:http';
import type { Logger } from '../util/logger';

/** What the runtime must supply for the endpoint to describe itself. */
export interface HealthSnapshot {
  readonly tradingMode: string;
  readonly liveTrading: boolean;
  readonly killSwitchEngaged: boolean;
  readonly killSwitchReason?: string;
  readonly reconciled: boolean;
  readonly reconciliationReason?: string;
  readonly websocketState: string;
  readonly websocketReady: boolean;
  readonly strategyState: string;
  readonly ticksCompleted: number;
  /** Epoch ms of the last completed tick, or undefined before the first. */
  readonly lastTickAtMs?: number;
  readonly dataAgeMs?: number;
  readonly maxDataAgeMs: number;
  readonly openPositions: number;
  readonly liveOrders: number;
  readonly unknownOrders: number;
  /** Credential PRESENCE only. Never a value, prefix or hash. */
  readonly credentialsConfigured: {
    readonly arcusSigningKey: boolean;
    readonly walletAddress: boolean;
    readonly lark: boolean;
  };
  /** Which SQLite driver is in use, for the driver-compatibility issue. */
  readonly sqliteDriver: string;
  readonly version: string;
}

export interface HealthServerOptions {
  readonly port: number;
  /** Bind address. Loopback by default; override only deliberately. */
  readonly host?: string;
  readonly logger: Logger;
  readonly snapshot: () => HealthSnapshot;
  /**
   * A tick older than this marks the loop as stalled. Defaults to 5 minutes, which is
   * far longer than the tick interval yet short enough to catch a wedged loop.
   */
  readonly stallThresholdMs?: number;
  readonly now?: () => number;
}

export interface HealthVerdict {
  readonly statusCode: 200 | 503;
  readonly healthy: boolean;
  /** Every reason the system is not healthy. Empty when it is. */
  readonly reasons: readonly string[];
  readonly payload: Record<string, unknown>;
}

/**
 * Decide health from a snapshot.
 *
 * Split out from the HTTP server so the policy is unit-testable without binding a port.
 */
export function evaluateHealth(
  snapshot: HealthSnapshot,
  options?: { stallThresholdMs?: number; now?: () => number },
): HealthVerdict {
  const reasons: string[] = [];

  if (snapshot.killSwitchEngaged) {
    reasons.push(`kill switch engaged: ${snapshot.killSwitchReason ?? 'reason not recorded'}`);
  }
  if (!snapshot.reconciled) {
    reasons.push(`reconciliation failing: ${snapshot.reconciliationReason ?? 'unknown drift'}`);
  }

  const nowMs = options?.now?.() ?? Date.now();
  const stallThresholdMs = options?.stallThresholdMs ?? 300_000;
  if (snapshot.lastTickAtMs === undefined) {
    reasons.push('no tick has completed yet');
  } else {
    const sinceTick = nowMs - snapshot.lastTickAtMs;
    if (sinceTick > stallThresholdMs) {
      reasons.push(`the decision loop has not ticked for ${sinceTick}ms (limit ${stallThresholdMs}ms)`);
    }
  }

  const payload: Record<string, unknown> = {
    healthy: reasons.length === 0,
    tradingMode: snapshot.tradingMode,
    liveTrading: snapshot.liveTrading,
    strategyState: snapshot.strategyState,
    ticksCompleted: snapshot.ticksCompleted,
    lastTickAtMs: snapshot.lastTickAtMs ?? null,
    dataAgeMs: snapshot.dataAgeMs ?? null,
    maxDataAgeMs: snapshot.maxDataAgeMs,
    killSwitch: {
      engaged: snapshot.killSwitchEngaged,
      reason: snapshot.killSwitchReason ?? null,
    },
    reconciliation: {
      reconciled: snapshot.reconciled,
      reason: snapshot.reconciliationReason ?? null,
    },
    websocket: {
      state: snapshot.websocketState,
      ready: snapshot.websocketReady,
    },
    exposure: {
      openPositions: snapshot.openPositions,
      liveOrders: snapshot.liveOrders,
      unknownOrders: snapshot.unknownOrders,
    },
    // Presence flags only. A credential VALUE must never appear here.
    credentialsConfigured: snapshot.credentialsConfigured,
    sqliteDriver: snapshot.sqliteDriver,
    version: snapshot.version,
    reasons,
    checkedAtMs: nowMs,
  };

  return {
    statusCode: reasons.length === 0 ? 200 : 503,
    healthy: reasons.length === 0,
    reasons,
    payload,
  };
}

export class HealthServer {
  private readonly options: HealthServerOptions;
  private server?: Server;

  constructor(options: HealthServerOptions) {
    this.options = options;
  }

  /** Start listening. Returns false when the port could not be bound. */
  async start(): Promise<boolean> {
    if (this.options.port <= 0) return false;
    const host = this.options.host ?? '127.0.0.1';

    return new Promise<boolean>((resolve) => {
      const server = createServer((req, res) => {
        // Only /health is served; anything else is a 404 so the endpoint cannot be used
        // as an open query surface.
        if (req.method !== 'GET' || !req.url || !req.url.startsWith('/health')) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
          return;
        }
        try {
          const verdict = evaluateHealth(this.options.snapshot(), {
            stallThresholdMs: this.options.stallThresholdMs,
            ...(this.options.now ? { now: this.options.now } : {}),
          });
          res.writeHead(verdict.statusCode, { 'content-type': 'application/json' });
          res.end(`${JSON.stringify(verdict.payload)}\n`);
        } catch (error) {
          // A snapshot that throws must not 500 into an unhandled state; report it.
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              healthy: false,
              reasons: [`health snapshot failed: ${error instanceof Error ? error.message : String(error)}`],
            }),
          );
        }
      });

      server.on('error', (error) => {
        this.options.logger.error(
          { err: error.message, port: this.options.port, host },
          'health check server failed to start; continuing without it',
        );
        resolve(false);
      });

      server.listen(this.options.port, host, () => {
        this.options.logger.info(
          { port: this.options.port, host, path: '/health' },
          'health check endpoint listening',
        );
        this.server = server;
        resolve(true);
      });
      // A monitoring endpoint must never keep a finished process alive.
      server.unref?.();
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
