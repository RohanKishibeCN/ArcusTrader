/**
 * Lark (Feishu / open.larksuite.com) outbound reporting client.
 *
 * Only the pieces of the Open Platform API this system needs are implemented:
 * an internal tenant access token and `im/v1/messages` sends. The official SDK is
 * deliberately NOT used — it is not a dependency of this project, and every
 * request shape below is taken verbatim from
 * <https://open.larksuite.com/document/server-docs/im-v1/message/create> and
 * <https://open.larksuite.com/document/server-docs/authentication-management/access-token/tenant_access_token_internal>
 * (see `docs/API_CONTRACTS.md`). Node's global `fetch` is the only transport.
 *
 * Four integration hazards are pinned here on purpose, because each of them is
 * silent in production and each of them has bitten real integrations:
 *
 *  1. **`content` is a JSON STRING, not an object.** The message endpoint wants
 *     `{"msg_type":"text","content":"{\"text\":\"hi\"}"}`. Passing the object
 *     directly yields `code 230001 invalid parameter` at runtime while looking
 *     perfectly reasonable in the code. `sendText`/`sendCard` always
 *     `JSON.stringify()` the payload exactly once; the tests assert that the
 *     serialised request still parses back to the intended object.
 *  2. **The token endpoint has no `data` wrapper.** Its body is FLAT:
 *     `{code, msg, tenant_access_token, expire}` with `expire` in SECONDS, while
 *     `im/v1/messages` DOES nest its payload under `data`. Both are parsed
 *     explicitly rather than through one shared "unwrap" helper.
 *  3. **HTTP status is not the error channel.** Business errors arrive as
 *     HTTP 400 (or even 200) with the real reason in `code`; HTTP 429 carries a
 *     business rate-limit code. Every response is therefore parsed and checked
 *     for `code !== 0` regardless of status, AND non-2xx is treated as failure.
 *     Branching is always on `code`, never on `msg` (official instruction).
 *  4. **The tenant token is a bearer credential.** It is never logged, never
 *     interpolated into an error message, and scrubbed out of anything the
 *     server echoes back. See `redactLarkSecrets` and the secret-safety tests.
 *
 * Every public send method obeys a hard never-throw contract: reporting is a
 * side-channel and must never break the trading loop, so expected failures are
 * returned as `{ok:false, error}` for the caller (normally `AlertRouter`) to
 * queue in the local outbox.
 */

import { describeSecret, type Logger } from '../util/logger';

/* ------------------------------------------------------------------ *
 * Constants (documented so callers can reason about the policy)
 * ------------------------------------------------------------------ */

/** Card JSON schema version used by default. 2.0 puts elements under `body`. */
export type LarkCardSchemaVersion = '2.0' | '1.0';

/**
 * Switchable card schema version. Cards 1.0 (top-level `elements`) still work on
 * Lark, so the version is a documented constant rather than a literal buried in
 * the builder: flipping this one value (or passing an explicit `card.schema`)
 * migrates the reporting surface without touching call sites.
 */
export const DEFAULT_CARD_SCHEMA_VERSION: LarkCardSchemaVersion = '2.0';

/**
 * Proactive refresh margin. Lark returns a NEW token from the same endpoint when
 * the cached one has under 30 minutes of validity left, and two tokens stay valid
 * simultaneously during the overlap, so refreshing inside this margin is safe and
 * avoids a mid-send 99991663.
 */
export const TOKEN_REFRESH_MARGIN_MS = 30 * 60 * 1000;

/** Lark caps the idempotency key at 50 characters. */
export const MAX_UUID_LENGTH = 50;

export const DEFAULT_MAX_ATTEMPTS = 4;
export const DEFAULT_BASE_BACKOFF_MS = 500;
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Upper bound on any single retry wait. A rate-limit reset header can legally ask
 * for an hour; sleeping for an hour inside the trading loop's reporting path is
 * worse than failing the send and letting the outbox retry it later.
 */
export const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

/**
 * Codes that mean "the tenant access token is stale/not usable" and are worth
 * exactly ONE refresh-and-retry (never a loop).
 */
export const INVALID_TOKEN_CODES: readonly number[] = [
  99991663, 99991677, 99991671, 99991661, 99991665, 20005, 4001,
];

/**
 * Rate-limit codes. `99991400` is the one that accompanies HTTP 429; the others
 * are documented rate-limit/frequency codes that arrive with other statuses.
 */
export const RATE_LIMIT_CODES: readonly number[] = [
  99991400, 1000004, 1000005, 190005, 230020, 232019, 11232, 11233, 11247, 90217,
];

/** Every template the card header accepts. Anything else is clamped to `blue`. */
export const CARD_TEMPLATES: readonly string[] = [
  'blue', 'wathet', 'turquoise', 'green', 'yellow', 'orange', 'red',
  'carmine', 'violet', 'purple', 'indigo', 'grey', 'default',
];

const DEFAULT_CARD_TEMPLATE = 'blue';
const TENANT_TOKEN_PATH = '/open-apis/auth/v3/tenant_access_token/internal';
const SEND_MESSAGE_PATH = '/open-apis/im/v1/messages';

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

export interface LarkErrorOptions {
  /** Business code from the response body. `undefined` for transport failures. */
  code?: number;
  /** HTTP status, when a response was received. */
  httpStatus?: number;
  /**
   * Whether this failure is worth another attempt. Transport errors, 429 and 5xx
   * are retryable; ordinary business rejections (230001, 230002, 230099, …) are
   * not, and retrying them just burns quota.
   */
  retryable?: boolean;
}

/** A Lark failure, always carrying enough context to act on without the body. */
export class LarkError extends Error {
  readonly code?: number;
  readonly httpStatus?: number;
  readonly retryable: boolean;

  constructor(message: string, options: LarkErrorOptions = {}) {
    super(message);
    this.name = 'LarkError';
    this.code = options.code;
    this.httpStatus = options.httpStatus;
    this.retryable = options.retryable ?? false;
  }
}

/* ------------------------------------------------------------------ *
 * Secret redaction
 * ------------------------------------------------------------------ */

/**
 * Scrub credential material out of any free-form text (error messages, echoed
 * response bodies, transport error strings).
 *
 * Lark never intentionally echoes a token, but a proxy, a misrouted request or a
 * future API change could, and error strings are logged and surfaced. The
 * `Bearer …` pattern is removed unconditionally as defence in depth.
 */
export function redactLarkSecrets(
  message: string,
  secrets: { token?: string; appSecret?: string },
): string {
  // Order matters: the generic patterns run first so that a Bearer value is
  // reported as `<redacted>` rather than as a partially rewritten token.
  let out = message.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>');
  if (secrets.token) out = out.split(secrets.token).join('<redacted-token>');
  if (secrets.appSecret) out = out.split(secrets.appSecret).join('<redacted-app-secret>');
  // Last resort: the cached token may not be the one being echoed (a refreshed or
  // rejected credential, an error quoting the request). Lark tenant/user tokens
  // are `t-…`/`u-…`, so any such run is scrubbed on sight.
  return out.replace(/\b[tu]-[A-Za-z0-9._-]{8,}/g, '<redacted-token>');
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function isRetryableCode(code: number | undefined): boolean {
  return code !== undefined && RATE_LIMIT_CODES.includes(code);
}

/* ------------------------------------------------------------------ *
 * Card shapes
 * ------------------------------------------------------------------ */

export interface LarkCardText {
  tag: 'plain_text';
  content: string;
}

export interface LarkCardHeader {
  /** `CARD_TEMPLATES` member; colours the header bar. */
  template?: string;
  title: LarkCardText;
  subtitle?: LarkCardText;
}

export interface LarkCardBody {
  /** Card 2.0 element list, e.g. `{tag:'markdown', content:'…'}` blocks. */
  elements: unknown[];
}

/**
 * An interactive card. `schema:'2.0'` is the documented default; `elements` at the
 * top level is accepted for card 1.0 compatibility and is ignored by 2.0.
 */
export interface LarkCard {
  schema?: LarkCardSchemaVersion;
  header?: LarkCardHeader;
  body?: LarkCardBody;
  elements?: unknown[];
}

/** Clamp a caller-supplied template to one Lark accepts. */
export function normalizeCardTemplate(template: string | undefined): string {
  if (template !== undefined && CARD_TEMPLATES.includes(template)) return template;
  return DEFAULT_CARD_TEMPLATE;
}

/**
 * Build the card payload that is actually put on the wire for a given schema.
 *
 * Card 2.0 requires `{"schema":"2.0","body":{"elements":[…]}}`; card 1.0 has no
 * `schema` field and takes `elements` at the top level. Normalising in one place
 * keeps `sendCard` and the tests honest about which shape is being sent.
 */
export function normalizeCardForSend(card: LarkCard): Record<string, unknown> {
  const elements = card.body?.elements ?? card.elements ?? [];
  if (card.schema === '1.0') {
    const out: Record<string, unknown> = { elements };
    if (card.header) out.header = card.header;
    return out;
  }
  const out: Record<string, unknown> = {
    schema: card.schema ?? DEFAULT_CARD_SCHEMA_VERSION,
    body: { elements },
  };
  if (card.header) out.header = card.header;
  return out;
}

/**
 * Build a simple markdown card: title + subtitle in the header (subtitle becomes
 * the coloured severity line) and one `{tag:'markdown'}` block per section.
 *
 * `template` is optional and clamped via `normalizeCardTemplate`, so an alert
 * severity can be mapped straight onto a colour without an extra validation step
 * at the call site.
 */
export function buildMarkdownCard(
  title: string,
  subtitle: string,
  markdownSections: string[],
  template?: string,
): LarkCard {
  return {
    schema: DEFAULT_CARD_SCHEMA_VERSION,
    header: {
      template: normalizeCardTemplate(template),
      title: { tag: 'plain_text', content: title },
      subtitle: { tag: 'plain_text', content: subtitle },
    },
    body: {
      elements: markdownSections.map((content) => ({ tag: 'markdown', content })),
    },
  };
}

/* ------------------------------------------------------------------ *
 * Client
 * ------------------------------------------------------------------ */

export interface LarkClientOptions {
  /** `config.raw.LARK_BASE_URL`; trailing slashes are trimmed. */
  baseUrl: string;
  /** `secrets.larkAppId`. */
  appId?: string;
  /** `secrets.larkAppSecret`. */
  appSecret?: string;
  /** `config.raw.LARK_CHAT_ID` (`oc_…`). */
  chatId?: string;
  logger: Logger;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable clock (epoch ms). Defaults to Date.now. */
  now?: () => number;
  /** Max attempts per send including the first. Default 4. */
  maxAttempts?: number;
  /** Base backoff ms. Default 500, exponential with jitter. */
  baseBackoffMs?: number;
  /** Injectable sleep for tests. Defaults to a real timer. */
  sleepImpl?: (ms: number) => Promise<void>;
  requestTimeoutMs?: number;
  /** Hard ceiling on a single retry wait. Default 60s. */
  maxRetryDelayMs?: number;
  /** Injectable jitter source in [0,1). Defaults to Math.random. */
  randomImpl?: () => number;
}

export type LarkSendResult =
  | { ok: true; messageId: string; attempts: number }
  | { ok: false; error: LarkError; attempts: number };

/** Internal outcome of one HTTP round trip. Never escapes the client. */
type SendOutcome =
  | { ok: true; messageId: string }
  | { ok: false; error: LarkError; retryDelayMs?: number };

export class LarkClient {
  private readonly baseUrl: string;
  private readonly appId?: string;
  private readonly appSecret?: string;
  private readonly chatId?: string;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly requestTimeoutMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly random: () => number;

  /** Cached tenant token. Never logged, never returned by a public accessor. */
  private token?: string;
  private tokenExpiresAtMs = 0;
  /**
   * De-duplicates concurrent token fetches: a burst of sends after a cold start
   * must produce ONE token request, not one per send.
   */
  private inflightToken?: Promise<string>;

  constructor(opts: LarkClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.appId = opts.appId?.trim() || undefined;
    this.appSecret = opts.appSecret?.trim() || undefined;
    this.chatId = opts.chatId?.trim() || undefined;
    this.logger = opts.logger;
    const fetchImpl = opts.fetchImpl ?? (globalThis as { fetch?: typeof fetch }).fetch;
    if (!fetchImpl) {
      throw new LarkError(
        'no fetch implementation available: run Node.js >= 18 or pass options.fetchImpl',
      );
    }
    this.fetchImpl = fetchImpl;
    this.now = opts.now ?? (() => Date.now());
    this.maxAttempts = Math.max(1, Math.floor(opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
    this.baseBackoffMs = Math.max(0, opts.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS);
    this.sleepImpl = opts.sleepImpl ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    this.requestTimeoutMs = Math.max(0, opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    this.maxRetryDelayMs = Math.max(0, opts.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS);
    this.random = opts.randomImpl ?? Math.random;
  }

  /** true when appId+appSecret+chatId are all present. */
  get configured(): boolean {
    return Boolean(this.appId && this.appSecret && this.chatId);
  }

  /**
   * Exposed for tests and health checks: the cached token's PRESENCE and expiry,
   * never the token value itself.
   */
  get tokenState(): { hasToken: boolean; expiresAtMs: number } {
    return { hasToken: this.token !== undefined, expiresAtMs: this.tokenExpiresAtMs };
  }

  /**
   * Send a plain text message.
   *
   * The `text` is wrapped and stringified here — the endpoint's `content` field
   * must be a JSON STRING, and doing this in the client means no call site can
   * get it wrong.
   */
  async sendText(text: string, opts?: { uuid?: string }): Promise<LarkSendResult> {
    if (typeof text !== 'string') {
      return {
        ok: false,
        error: new LarkError(`sendText requires a string body, got ${typeof text}`),
        attempts: 0,
      };
    }
    return this.sendSafely('text', () => JSON.stringify({ text }), opts?.uuid);
  }

  /** Send an interactive card (`msg_type: 'interactive'`). */
  async sendCard(card: LarkCard, opts?: { uuid?: string }): Promise<LarkSendResult> {
    return this.sendSafely('interactive', () => JSON.stringify(normalizeCardForSend(card)), opts?.uuid);
  }

  /**
   * Force a token refresh, ignoring the cached value.
   *
   * Public because the reporting layer may want to pre-warm, and because the
   * invalid-token path needs a "refresh exactly once" primitive. Throws a
   * `LarkError` if the refresh ultimately fails; `sendText`/`sendCard` catch that
   * and return a failure result instead, preserving the never-throw contract.
   */
  async refreshToken(): Promise<void> {
    // Invalidate first: if the fetch below fails we must not keep serving a token
    // the server has already rejected.
    this.token = undefined;
    this.tokenExpiresAtMs = 0;
    this.inflightToken = undefined;
    const token = await this.fetchToken();
    this.logger.debug(
      { token: describeSecret(token) },
      'lark tenant access token refreshed',
    );
  }

  /* ---------------------------------------------------------------- *
   * send pipeline
   * ---------------------------------------------------------------- */

  /** Never-throw wrapper: stringify/transport surprises must not escape. */
  private async sendSafely(
    msgType: 'text' | 'interactive',
    buildContent: () => string,
    uuid: string | undefined,
  ): Promise<LarkSendResult> {
    try {
      const content = buildContent();
      return await this.send(msgType, content, uuid);
    } catch (err) {
      // A circular card, a getter that throws, a fetchImpl that rejects outside
      // the request wrapper — all end up here, and all must return, not throw.
      return { ok: false, error: this.toError(err), attempts: 0 };
    }
  }

  private async send(
    msgType: 'text' | 'interactive',
    content: string,
    uuid: string | undefined,
  ): Promise<LarkSendResult> {
    if (!this.configured) {
      return {
        ok: false,
        error: new LarkError(
          'lark is not configured (LARK_APP_ID / LARK_APP_SECRET / LARK_CHAT_ID incomplete); ' +
            'message was not sent',
          { retryable: true },
        ),
        attempts: 0,
      };
    }
    if (uuid !== undefined && (uuid.length === 0 || uuid.length > MAX_UUID_LENGTH)) {
      return {
        ok: false,
        error: new LarkError(
          `uuid must be 1..${MAX_UUID_LENGTH} characters (Lark caps the idempotency key at ` +
            `${MAX_UUID_LENGTH}), got ${uuid.length}`,
        ),
        attempts: 0,
      };
    }

    let lastError = new LarkError('lark send was never attempted', { retryable: true });
    /**
     * One refresh per send call, enforced by this flag rather than by attempt
     * counting: an invalid-token reply after a fresh token means the credential
     * itself is wrong (revoked app, wrong id/secret), and looping would hammer
     * the auth endpoint until the rate limiter bans the app.
     */
    let refreshedAfterInvalidToken = false;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      // Token acquisition is deliberately terminal for the send. `fetchToken`
      // already retried internally, so re-entering this loop on its failure would
      // multiply the budgets (maxAttempts token requests per send attempt) against
      // an auth endpoint we cannot use. The outbox retries the message later.
      let token: string;
      try {
        token = await this.getToken();
      } catch (err) {
        return { ok: false, error: this.toError(err), attempts: attempt };
      }

      let outcome: SendOutcome;
      try {
        outcome = await this.postMessage(token, msgType, content, uuid);
      } catch (err) {
        // Defensive: postMessage classifies its own transport failures, so this is
        // an unexpected defect. Treat it as transport-shaped and retry.
        lastError = this.toError(err);
        if (!lastError.retryable || attempt >= this.maxAttempts) {
          return { ok: false, error: lastError, attempts: attempt };
        }
        await this.sleepImpl(this.backoffMs(attempt));
        continue;
      }

      if (outcome.ok) return { ok: true, messageId: outcome.messageId, attempts: attempt };

      lastError = outcome.error;
      const code = outcome.error.code;
      if (code !== undefined && INVALID_TOKEN_CODES.includes(code)) {
        if (refreshedAfterInvalidToken) {
          this.logger.warn(
            { code, attempts: attempt },
            'lark still rejects the tenant token after a single refresh; giving up rather than looping',
          );
          return { ok: false, error: outcome.error, attempts: attempt };
        }
        refreshedAfterInvalidToken = true;
        this.logger.warn(
          { code, attempts: attempt },
          'lark rejected the tenant access token; refreshing once and retrying the send',
        );
        try {
          await this.refreshToken();
        } catch (err) {
          // The refresh itself already retried internally; surface it instead of
          // burning another attempt on a credential we could not obtain.
          return { ok: false, error: this.toError(err), attempts: attempt };
        }
        // Immediate retry with the fresh token — no backoff, the previous attempt
        // failed for a reason a delay cannot fix.
        continue;
      }

      if (!outcome.error.retryable || attempt >= this.maxAttempts) {
        return { ok: false, error: outcome.error, attempts: attempt };
      }
      // Honour the server's own pacing when it gave us one, but never sleep for
      // less than our own exponential backoff — and never for longer than
      // `maxRetryDelayMs`, which keeps reporting from stalling the caller.
      await this.sleepImpl(this.retryDelayMsFor(outcome.retryDelayMs, attempt));
    }

    return { ok: false, error: lastError, attempts: this.maxAttempts };
  }

  /* ---------------------------------------------------------------- *
   * token handling
   * ---------------------------------------------------------------- */

  /**
   * Cached token accessor with the proactive-refresh rule.
   *
   * Refresh happens when fewer than `TOKEN_REFRESH_MARGIN_MS` remain, which is
   * exactly the condition under which Lark hands out a new token while keeping the
   * old one valid — so an in-flight send using the previous token is not broken by
   * a concurrent refresh.
   */
  private async getToken(): Promise<string> {
    const nowMs = this.now();
    if (
      this.token !== undefined &&
      this.tokenExpiresAtMs - nowMs > TOKEN_REFRESH_MARGIN_MS
    ) {
      return this.token;
    }
    if (this.inflightToken) return this.inflightToken;
    const pending = this.fetchToken().finally(() => {
      if (this.inflightToken === pending) this.inflightToken = undefined;
    });
    this.inflightToken = pending;
    return pending;
  }

  /**
   * Fetch a tenant access token. Retries on transport errors, 429 and 5xx using
   * the same attempt budget as sends, then throws the last error.
   *
   * The response is FLAT (`{code,msg,tenant_access_token,expire}`) — there is no
   * `data` wrapper here, unlike `im/v1/messages`. `expire` is SECONDS.
   */
  private async fetchToken(): Promise<string> {
    if (!this.appId || !this.appSecret) {
      throw new LarkError(
        'cannot fetch a Lark tenant access token: LARK_APP_ID / LARK_APP_SECRET are not configured',
      );
    }
    let lastError = new LarkError('tenant access token was never requested', { retryable: true });

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      let retryDelayMs: number | undefined;
      try {
        const res = await this.request(`${this.baseUrl}${TENANT_TOKEN_PATH}`, {
          method: 'POST',
          // Note: no Authorization header on the token endpoint, ever.
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
        });
        const parsed = await this.readJson(res);
        const body = (parsed.body ?? {}) as Record<string, unknown>;
        const code = asNumber(body.code);

        if (res.ok && code === 0) {
          const token = asString(body.tenant_access_token);
          if (token !== undefined && token !== '') {
            const expireSeconds = asNumber(body.expire) ?? 7200;
            this.token = token;
            this.tokenExpiresAtMs = this.now() + expireSeconds * 1000;
            this.logger.debug(
              {
                token: describeSecret(token),
                expiresAtMs: this.tokenExpiresAtMs,
                expireSeconds,
              },
              'lark tenant access token acquired',
            );
            return token;
          }
          lastError = new LarkError(
            'lark token endpoint returned code 0 without a tenant_access_token',
            { httpStatus: res.status, retryable: true },
          );
        } else {
          retryDelayMs = this.retryDelayFromHeaders(res.headers);
          lastError = new LarkError(
            this.redact(
              `lark token request failed: code=${code ?? '<none>'} ` +
                `msg=${asString(body.msg) ?? '<none>'} http=${res.status}`,
            ),
            {
              code,
              httpStatus: res.status,
              // A business rejection on the token endpoint means the credential
              // is wrong, and retrying it only burns the app's auth quota; a
              // missing code means the response was unusable, which is worth
              // retrying.
              retryable: code === undefined
                ? true
                : isRetryableCode(code) || isRetryableStatus(res.status),
            },
          );
        }
      } catch (err) {
        lastError = this.toError(err);
      }

      if (!lastError.retryable || attempt >= this.maxAttempts) break;
      await this.sleepImpl(this.retryDelayMsFor(retryDelayMs, attempt));
    }
    throw lastError;
  }

  /* ---------------------------------------------------------------- *
   * HTTP
   * ---------------------------------------------------------------- */

  /**
   * POST an `im/v1/messages` request and classify the outcome.
   *
   * Classification rules, in order:
   *  - a body with `code !== 0` is a business failure (even on HTTP 200);
   *  - a non-2xx response without a business code is still a failure;
   *  - a 2xx with `code === 0` is a success, `data.message_id` and all.
   */
  private async postMessage(
    token: string,
    msgType: 'text' | 'interactive',
    content: string,
    uuid: string | undefined,
  ): Promise<SendOutcome> {
    const body: Record<string, unknown> = {
      receive_id: this.chatId,
      msg_type: msgType,
      // Already a JSON string. Do NOT re-stringify: that would send a quoted
      // JSON document and Lark would answer 230001.
      content,
    };
    if (uuid !== undefined) body.uuid = uuid;

    let res: Response;
    try {
      res = await this.request(`${this.baseUrl}${SEND_MESSAGE_PATH}?receive_id_type=chat_id`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const e = this.toError(err);
      return { ok: false, error: e };
    }

    let parsed: { body?: unknown; parseError?: string };
    try {
      parsed = await this.readJson(res);
    } catch (err) {
      return { ok: false, error: this.toError(err) };
    }
    const envelope = (parsed.body ?? {}) as Record<string, unknown>;
    const code = asNumber(envelope.code);
    const msg = asString(envelope.msg);

    if (code !== undefined && code !== 0) {
      const retryDelayMs = this.retryDelayFromHeaders(res.headers);
      return {
        ok: false,
        error: new LarkError(
          this.redact(
            `lark rejected the message: code=${code} msg=${msg ?? '<none>'} http=${res.status}`,
          ),
          {
            code,
            httpStatus: res.status,
            // Rate limits and 5xx-class stalls retry; ordinary parameter errors
            // (230001, 230002, 230099, …) do not.
            retryable: isRetryableCode(code) || isRetryableStatus(res.status),
          },
        ),
        retryDelayMs,
      };
    }

    if (!res.ok) {
      const retryDelayMs = this.retryDelayFromHeaders(res.headers);
      return {
        ok: false,
        error: new LarkError(
          this.redact(
            `lark returned HTTP ${res.status} with no business error code` +
              (parsed.parseError ? ` (${parsed.parseError})` : ''),
          ),
          { code, httpStatus: res.status, retryable: isRetryableStatus(res.status) },
        ),
        retryDelayMs,
      };
    }

    if (code === undefined) {
      return {
        ok: false,
        error: new LarkError(
          this.redact(
            `lark returned an unparseable success response (HTTP ${res.status}` +
              `${parsed.parseError ? `, ${parsed.parseError}` : ''})`,
          ),
          { httpStatus: res.status, retryable: true },
        ),
      };
    }

    const data = (envelope.data ?? {}) as Record<string, unknown>;
    return { ok: true, messageId: asString(data.message_id) ?? '' };
  }

  /** `fetch` with an AbortController-based timeout. */
  private async request(url: string, init: RequestInit): Promise<Response> {
    if (this.requestTimeoutMs <= 0) return this.fetchImpl(url, init);
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`lark request timed out after ${this.requestTimeoutMs}ms`)),
      this.requestTimeoutMs,
    );
    if (typeof timer.unref === 'function') timer.unref();
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Read a response body as JSON without ever throwing on malformed content. */
  private async readJson(res: Response): Promise<{ body?: unknown; parseError?: string }> {
    const text = await res.text();
    if (text.trim() === '') return {};
    try {
      return { body: JSON.parse(text) as unknown };
    } catch {
      return { parseError: 'response body was not JSON' };
    }
  }

  /**
   * Retry delay requested by the server, in ms.
   *
   * `x-ogw-ratelimit-reset` is seconds-until-recovery; `Retry-After` is seconds or
   * an HTTP date. When both are present the LARGER wins, because sleeping less
   * than either means the retry is rejected again and we have burned an attempt.
   */
  private retryDelayFromHeaders(headers: Headers): number | undefined {
    const candidates: number[] = [];
    const ogw = this.headerSeconds(headers.get('x-ogw-ratelimit-reset'));
    if (ogw !== undefined) candidates.push(ogw);
    const retryAfter = this.retryAfterSeconds(headers.get('Retry-After'));
    if (retryAfter !== undefined) candidates.push(retryAfter);
    if (candidates.length === 0) return undefined;
    return Math.max(...candidates) * 1000;
  }

  private headerSeconds(raw: string | null): number | undefined {
    if (raw === null || raw.trim() === '') return undefined;
    const n = Number(raw.trim());
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  }

  private retryAfterSeconds(raw: string | null): number | undefined {
    if (raw === null) return undefined;
    const value = raw.trim();
    if (value === '') return undefined;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric >= 0) return numeric;
    const asDate = Date.parse(value);
    if (Number.isNaN(asDate)) return undefined;
    return Math.max(0, (asDate - this.now()) / 1000);
  }

  /**
   * Combine the server's requested wait with our own backoff, then clamp.
   *
   * `Math.max` because sleeping less than the server asked means the retry is
   * rejected again and an attempt is wasted; the clamp because a rate-limit reset
   * header may legally ask for an hour, and a reporting path must never hold a
   * trading process for an hour — the outbox retries later instead.
   */
  private retryDelayMsFor(requestedMs: number | undefined, attempt: number): number {
    const combined = Math.max(requestedMs ?? 0, this.backoffMs(attempt));
    return Math.min(this.maxRetryDelayMs, combined);
  }

  /**
   * Exponential backoff with bounded jitter, in ms, for a 1-based attempt.
   *
   * `base * 2^(attempt-1) * [1, 1.5)` — the multiplier's floor is 1 so the delay
   * is monotonically increasing across attempts (each attempt's minimum exceeds
   * the previous attempt's maximum), which keeps the "gives up after n attempts"
   * behaviour predictable for both operators and tests.
   */
  private backoffMs(attempt: number): number {
    const ceiling = this.baseBackoffMs * 2 ** Math.max(0, attempt - 1);
    const jittered = ceiling * (1 + Math.max(0, Math.min(1, this.random())) * 0.5);
    return Math.min(this.maxRetryDelayMs, Math.round(jittered));
  }

  private redact(message: string): string {
    return redactLarkSecrets(message, { token: this.token, appSecret: this.appSecret });
  }

  private toError(err: unknown): LarkError {
    if (err instanceof LarkError) return err;
    const text = redactLarkSecrets(errorText(err), {
      token: this.token,
      appSecret: this.appSecret,
    });
    const aborted =
      err instanceof Error &&
      (err.name === 'AbortError' || /abort/i.test(err.message) || /timed out/i.test(err.message));
    return new LarkError(
      aborted ? `lark request timed out or was aborted: ${text}` : `lark request failed: ${text}`,
      { retryable: true },
    );
  }
}
