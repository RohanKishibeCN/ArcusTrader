/**
 * SQLite backend adapter.
 *
 * WHY THIS EXISTS
 *
 * The project was written against `better-sqlite3`, as the brief allows. Under
 * **Node 24** that library aborts the process with
 *
 *     Assertion failed: (env) != nullptr
 *     node::RemoveEnvironmentCleanupHook  ... in Database::~Database()
 *
 * Verified on both `better-sqlite3@11.10.0` and `@12.11.1`, and reproducible with
 * nothing but a loop that opens and closes in-memory databases — so it is a
 * library/Node-version incompatibility, not a misuse. The crash is a native
 * destructor running during V8 garbage collection, i.e. it can fire at ANY point
 * in a long-running trading process, which makes it unacceptable rather than
 * merely annoying.
 *
 * Node's built-in `node:sqlite` (`DatabaseSync`) is available and stable from
 * Node 22.5, exposes the same synchronous shape, and survives 200 open/close
 * cycles under the same stress. So this module prefers it and falls back to
 * `better-sqlite3`, which keeps the documented Node 20 floor working while making
 * the deployed Node 24 path crash-free.
 *
 * The two drivers differ in exactly three ways that matter here, all normalised
 * by this adapter:
 *
 *   1. `changes` — better-sqlite3 returns `{changes, lastInsertRowid}` from
 *      `run()`, `node:sqlite` does too, but the field is `changes` on both; we
 *      read `changes` defensively and default to 0.
 *   2. `pragma()` — only better-sqlite3 has it; `PRAGMA` goes through `exec()`.
 *   3. Binding — NEITHER accepts `undefined`, and NEITHER accepts a boolean.
 *      Callers must pass `null` and numbers. `node:sqlite` additionally coerces a
 *      boolean to the string `"true"`, silently writing the wrong type, so the
 *      adapter REJECTS booleans instead of letting a driver decide.
 */

import type { Logger } from '../util/logger';

/** Minimal result shape shared by both drivers' `run()`. */
export interface RunResult {
  readonly changes: number;
  readonly lastInsertRowid?: number | bigint;
}

export interface StatementLike {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface DatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): StatementLike;
  close(): void;
  /** Which driver is in use, for the startup log and the daily report. */
  readonly driver: 'node:sqlite' | 'better-sqlite3';
}

/** Thrown when a bound value would be silently mistyped by a driver. */
export class SqliteBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqliteBindingError';
  }
}

/**
 * Normalise a bind value.
 *
 * `undefined` becomes `NULL` because both drivers reject it and a rejection on
 * the write path could lose a fill record. Booleans are rejected loudly: neither
 * driver stores them as integers, and `node:sqlite` would quietly store `'true'`.
 */
function normalizeBind(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'boolean') {
    throw new SqliteBindingError(
      'booleans cannot be bound to SQLite by either driver; pass Number(value) (0/1) explicitly',
    );
  }
  return value;
}

function normalizeParams(params: unknown[]): unknown[] {
  // A single object argument is a named-parameter map.
  if (params.length === 1 && typeof params[0] === 'object' && params[0] !== null && !Array.isArray(params[0])) {
    const record = params[0] as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) out[key] = normalizeBind(value);
    return [out];
  }
  return params.map(normalizeBind);
}

function wrapStatement(statement: {
  run: (...args: never[]) => unknown;
  get: (...args: never[]) => unknown;
  all: (...args: never[]) => unknown[];
}): StatementLike {
  return {
    run(...params: unknown[]): RunResult {
      const result = statement.run(...(normalizeParams(params) as never[])) as
        | { changes?: number | bigint; lastInsertRowid?: number | bigint }
        | undefined;
      const changes = result?.changes;
      return {
        changes: typeof changes === 'bigint' ? Number(changes) : (changes ?? 0),
        ...(result?.lastInsertRowid !== undefined ? { lastInsertRowid: result.lastInsertRowid } : {}),
      };
    },
    get(...params: unknown[]): unknown {
      return statement.get(...(normalizeParams(params) as never[]));
    },
    all(...params: unknown[]): unknown[] {
      return statement.all(...(normalizeParams(params) as never[]));
    },
  };
}

interface NodeSqliteModule {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      run: (...args: never[]) => unknown;
      get: (...args: never[]) => unknown;
      all: (...args: never[]) => unknown[];
    };
    close(): void;
  };
}

/**
 * Open a database, preferring `node:sqlite`.
 *
 * `node:sqlite` may be unavailable (Node < 22.5) or behind a flag on some builds,
 * so the require is guarded. When the built-in is present, `better-sqlite3` is not
 * loaded at all, which is what avoids the native abort.
 */
export function openDatabase(params: { path: string; logger: Logger }): DatabaseLike {
  const { path, logger } = params;

  const builtin = tryLoadNodeSqlite();
  if (builtin) {
    const db = new builtin.DatabaseSync(path);
    logger.info({ path, driver: 'node:sqlite' }, 'sqlite opened via the node built-in driver');
    return {
      driver: 'node:sqlite',
      exec: (sql) => db.exec(sql),
      prepare: (sql) => wrapStatement(db.prepare(sql)),
      close: () => db.close(),
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const BetterSqlite = require('better-sqlite3') as new (p: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      run: (...args: never[]) => unknown;
      get: (...args: never[]) => unknown;
      all: (...args: never[]) => unknown[];
    };
    close(): void;
  };
  const db = new BetterSqlite(path);
  logger.warn(
    { path, driver: 'better-sqlite3' },
    'node:sqlite is unavailable (requires Node >= 22.5); falling back to better-sqlite3. ' +
      'On Node 24 this driver can abort the process during garbage collection — see src/store/Sqlite.ts.',
  );
  return {
    driver: 'better-sqlite3',
    exec: (sql) => db.exec(sql),
    prepare: (sql) => wrapStatement(db.prepare(sql)),
    close: () => db.close(),
  };
}

function tryLoadNodeSqlite(): NodeSqliteModule | undefined {
  try {
    // `require` (not a static import) so Node 20 builds without the module still load.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('node:sqlite') as Partial<NodeSqliteModule>;
    return typeof mod.DatabaseSync === 'function' ? (mod as NodeSqliteModule) : undefined;
  } catch {
    return undefined;
  }
}
