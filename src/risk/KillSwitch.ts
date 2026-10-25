/**
 * Kill switch.
 *
 * Three independent ways to stop the system opening new positions:
 *
 *   1. A sentinel file (`STOP_TRADING`) that exists on disk. This survives a
 *      process restart and is the operator's out-of-band switch.
 *   2. The CLI (`arcus-trader kill` / `arcus-trader reset-kill`).
 *   3. Automatic triggering from inside the running system — daily-loss breach,
 *      consecutive-loss streak, irreconcilable drift, repeated API failures.
 *
 * What "engaged" means, precisely:
 *
 *   - NO new positions and NO new entry orders.
 *   - Existing positions keep being managed: protective reduce-only stops and
 *     take-profits stay live and may still be placed or replaced, because
 *     removing protection is the opposite of failing safe.
 *   - Working ENTRY orders are cancelled (they are the only thing that could
 *     still open a new position).
 *
 * The automatic triggers are latched: once tripped they stay tripped until an
 * operator clears them, because a transient condition that auto-resets is how a
 * system quietly resumes trading after a blow-up.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Logger } from '../util/logger';

export type KillSwitchSource = 'none' | 'file' | 'cli' | 'automatic';

export interface KillSwitchStatus {
  readonly engaged: boolean;
  readonly source: KillSwitchSource;
  readonly reason?: string;
  /** Epoch ms at which the switch was engaged, when known. */
  readonly engagedAtMs?: number;
  /** True when the operator must clear it explicitly. */
  readonly latched: boolean;
}

export interface KillSwitchOptions {
  /** Path to the sentinel file. Presence means engaged. */
  readonly stopFilePath: string;
  readonly logger: Logger;
  readonly now?: () => number;
}

/** Human-readable summary, safe for logs and the daily report. */
export interface KillSwitchDecision {
  readonly allowNewPositions: boolean;
  readonly allowReduceOnly: boolean;
  readonly allowCancelEntryOrders: boolean;
  readonly status: KillSwitchStatus;
}

export class KillSwitch {
  private readonly stopFilePath: string;
  private readonly logger: Logger;
  private readonly now: () => number;

  private cliEngaged = false;
  private cliReason?: string;
  private autoEngaged = false;
  private autoReason?: string;
  private autoEngagedAtMs?: number;

  constructor(options: KillSwitchOptions) {
    this.stopFilePath = resolve(options.stopFilePath);
    this.logger = options.logger;
    this.now = options.now ?? (() => Date.now());
  }

  get path(): string {
    return this.stopFilePath;
  }

  /** Whether the sentinel file is present right now. */
  get fileEngaged(): boolean {
    try {
      return existsSync(this.stopFilePath);
    } catch {
      // An unreadable path is treated as ENGAGED. Fail closed: if we cannot prove
      // the switch is off, we must assume it is on.
      return true;
    }
  }

  get status(): KillSwitchStatus {
    if (this.fileEngaged) {
      return {
        engaged: true,
        source: 'file',
        reason: `sentinel file present at ${this.stopFilePath}`,
        latched: true,
      };
    }
    if (this.cliEngaged) {
      return { engaged: true, source: 'cli', reason: this.cliReason, latched: true };
    }
    if (this.autoEngaged) {
      return {
        engaged: true,
        source: 'automatic',
        reason: this.autoReason,
        ...(this.autoEngagedAtMs !== undefined ? { engagedAtMs: this.autoEngagedAtMs } : {}),
        latched: true,
      };
    }
    return { engaged: false, source: 'none', latched: false };
  }

  get engaged(): boolean {
    return this.status.engaged;
  }

  /**
   * What the caller may do.
   *
   * Note the asymmetry: cancelling entry orders is always allowed (it reduces
   * exposure) and reduce-only management is always allowed. Only new exposure is
   * blocked.
   */
  decide(): KillSwitchDecision {
    const status = this.status;
    return {
      allowNewPositions: !status.engaged,
      // Reduce-only stays permitted even when engaged: closing risk must never be
      // blocked by a switch that exists to reduce risk.
      allowReduceOnly: true,
      allowCancelEntryOrders: true,
      status,
    };
  }

  /** Engage from inside the running system. Latched until `clearAutomatic`. */
  engageAutomatic(reason: string): void {
    if (this.autoEngaged) return;
    this.autoEngaged = true;
    this.autoReason = reason;
    this.autoEngagedAtMs = this.now();
    this.logger.error({ reason }, 'KILL SWITCH ENGAGED (automatic): new positions are blocked');
  }

  /** Clear only the automatic latch. A sentinel file or CLI latch still applies. */
  clearAutomatic(): void {
    if (!this.autoEngaged) return;
    this.autoEngaged = false;
    this.autoReason = undefined;
    this.autoEngagedAtMs = undefined;
    this.logger.warn('automatic kill switch cleared');
  }

  /** Set the in-process CLI latch. Used by `arcus-trader kill` at startup. */
  engageCli(reason: string): void {
    this.cliEngaged = true;
    this.cliReason = reason;
    this.logger.error({ reason }, 'KILL SWITCH ENGAGED (cli)');
  }

  /**
   * Create the sentinel file.
   *
   * Written with an explanation rather than being empty, so an operator finding
   * it on a VPS at 3am knows why the bot stopped.
   */
  writeStopFile(reason: string): void {
    try {
      mkdirSync(dirname(this.stopFilePath), { recursive: true });
      const body = [
        'ArcusTrader kill switch',
        `engaged_at: ${new Date(this.now()).toISOString()}`,
        `reason: ${reason}`,
        '',
        'New positions are blocked while this file exists.',
        'Existing positions continue to be managed (reduce-only).',
        'Remove this file (or run `pnpm kill -- --reset`) to re-enable new entries.',
        '',
      ].join('\n');
      writeFileSync(this.stopFilePath, body, 'utf8');
      this.logger.error({ path: this.stopFilePath, reason }, 'kill switch sentinel file written');
    } catch (error) {
      // If we cannot write the sentinel we must still stop trading in-process.
      this.logger.error(
        { err: String(error), path: this.stopFilePath },
        'failed to write kill switch file; engaging in-process latch instead',
      );
      this.engageAutomatic(`could not write stop file: ${String(error)}`);
    }
  }

  /** Remove the sentinel file and clear the automatic latch. */
  clearStopFile(): { cleared: boolean; error?: string } {
    try {
      if (existsSync(this.stopFilePath)) rmSync(this.stopFilePath);
      this.clearAutomatic();
      this.cliEngaged = false;
      this.cliReason = undefined;
      this.logger.warn({ path: this.stopFilePath }, 'kill switch cleared');
      return { cleared: true };
    } catch (error) {
      return { cleared: false, error: String(error) };
    }
  }
}
