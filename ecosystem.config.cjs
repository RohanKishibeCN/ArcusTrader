/**
 * PM2 process definition.
 *
 * Design decisions that matter operationally:
 *
 *  1. **`autorestart: true` but NOT for the trading state.** PM2 restarting the
 *     process does NOT resume trading by itself: every start runs the full startup
 *     sequence (markets, account, positions, openOrders, reconciliation) before any
 *     entry is considered, and an automatic kill-switch latch is re-derived from the
 *     STOP_TRADING sentinel + the day's realized PnL. So a crash-loop cannot produce
 *     a "resumed mid-strategy" state.
 *
 *  2. **`kill_timeout` generous enough for a clean shutdown.** On SIGTERM the runtime
 *     finishes the current tick, flushes the Lark outbox, closes SQLite and exits.
 *     Killing it sooner risks a .db-wal that needs recovery.
 *
 *  3. **`max_restarts` + `min_uptime` are deliberately finite.** A process that
 *     cannot start (bad config, revoked key) must stop retrying and stay visible in
 *     `pm2 list` rather than flapping forever and spamming Lark.
 *
 *  4. **Memory cap.** A leak should surface as a restart, and a restart is safe here
 *     because of (1).
 *
 *  5. **`args` defaults to `dry-run`.** Making live the default in the process file
 *     would defeat the whole point of the CLI confirmation flag; an operator must
 *     edit `args` to add `--confirm-live`.
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *   pm2 logs arcustrader
 *   pm2 restart arcustrader --update-env
 */

const path = require('node:path');

/** Absolute DB path so PM2's cwd does not silently relocate the ledger. */
const APP_ROOT = __dirname;

module.exports = {
  apps: [
    {
      name: 'arcustrader',
      script: path.join(APP_ROOT, 'dist', 'index.js'),
      // `tsx` is only needed when running TypeScript directly. Prefer the compiled
      // output in production: it starts faster and has no transpiler in the hot path.
      // To run from source instead, set:
      //   script: 'node_modules/tsx/dist/cli.mjs'
      //   args: 'src/index.ts dry-run'
      args: 'dry-run',
      cwd: APP_ROOT,

      instances: 1,
      // NEVER cluster this: two instances would both hold a view of the same
      // account, both reconcile it, and both try to place the same protective stop.
      exec_mode: 'fork',

      autorestart: true,
      max_restarts: 10,
      min_uptime: '60s',
      restart_delay: 5000,
      // SIGTERM, then SIGKILL only if the current tick has not finished. The runtime
      // performs an outbox flush and a SQLite close inside this window.
      kill_timeout: 30000,
      listen_timeout: 10000,
      wait_ready: false,

      max_memory_restart: '1G',

      env: {
        NODE_ENV: 'production',
        // Safe defaults, restated here so a missing .env cannot silently change
        // posture. Anything sensitive (keys, secrets) comes from the environment
        // injected by the supervisor, never from this file.
        TRADING_MODE: 'dry_run',
        LIVE_TRADING: 'false',
        ALLOW_ORDER_SUBMISSION: 'true',
        LOG_LEVEL: 'info',
        LOG_PRETTY: 'false',
        DB_PATH: path.join(APP_ROOT, 'data', 'arcustrader.db'),
        STOP_FILE: path.join(APP_ROOT, 'STOP_TRADING'),
        REPORT_TIMEZONE: 'Asia/Shanghai',
        REPORT_CRON: '0 9 * * *',
      },

      // Uncomment to switch to mainnet + live. Note that `--confirm-live` is still
      // required in `args`; this block alone does not arm the system.
      // env_production: {
      //   NODE_ENV: 'production',
      //   TRADING_MODE: 'live',
      //   LIVE_TRADING: 'true',
      // },

      merge_logs: true,
      time: true,
      out_file: path.join(APP_ROOT, 'logs', 'out.log'),
      error_file: path.join(APP_ROOT, 'logs', 'error.log'),

      // Do not let a graceful shutdown look like a crash loop to PM2's heuristics.
      exp_backoff_restart_delay: 500,
      // Surface the operator-facing kill switch in `pm2 describe`.
      source_map_support: true,
    },
  ],
};
