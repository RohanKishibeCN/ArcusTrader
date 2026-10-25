/**
 * Lark client + alert router tests.
 *
 * Everything here runs against an injected fake `fetch`, an injected clock and an
 * injected sleep, so the suite is deterministic and touches no network and no real
 * timer (the one exception is the AbortController timeout test, which uses a 10 ms
 * real timeout because the timeout lives in the transport, not in a policy knob).
 *
 * The assertions worth calling out:
 *
 *  - `content` is asserted to be a JSON STRING that parses back to the intended
 *    object. Sending the object directly is the single most common Lark
 *    integration bug (it fails at runtime with `230001`), and it looks correct in
 *    review, so it needs an explicit regression test.
 *  - Refresh is asserted by FETCH CALL COUNT, not by internals: one refresh on an
 *    invalid-token code, never two, and no refresh on an ordinary success.
 *  - The app secret and the tenant token are asserted absent from every captured
 *    log line and from every returned error message, including when the server
 *    echoes them back.
 */

import { describe, expect, it } from 'vitest';
import {
  buildMarkdownCard,
  CARD_TEMPLATES,
  DEFAULT_CARD_SCHEMA_VERSION,
  INVALID_TOKEN_CODES,
  LarkClient,
  LarkError,
  MAX_UUID_LENGTH,
  normalizeCardForSend,
  RATE_LIMIT_CODES,
  redactLarkSecrets,
  TOKEN_REFRESH_MARGIN_MS,
  type LarkCard,
  type LarkSendResult,
} from '../../src/notifications/LarkClient';
import {
  AlertRouter,
  CRITICAL_DEDUPE_WINDOW_MS,
  DEFAULT_DEDUPE_WINDOW_MS,
  MAX_SENDS_PER_SECOND,
  MIN_SEND_INTERVAL_MS,
  type Alert,
  type OutboxStore,
} from '../../src/notifications/AlertRouter';
import { type Logger } from '../../src/util/logger';

/* ------------------------------------------------------------------ *
 * Fixtures and harnesses
 * ------------------------------------------------------------------ */

const BASE = 'https://open.larksuite.com';
const APP_ID = 'cli_test_app_id';
const APP_SECRET = 'super-secret-app-secret-must-never-be-logged';
const TOKEN = 't-tenant-token-must-never-be-logged-1234';
const CHAT_ID = 'oc_test_chat_id';
const T0 = 1_700_000_000_000;

interface RecordedCall {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

type Handler = (call: RecordedCall, index: number) => Response | Promise<Response>;

function makeFetch(handler: Handler): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input);
    let body: Record<string, unknown> = {};
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        body = { '<unparseable>': init.body };
      }
    }
    const call: RecordedCall = { url, init: init ?? {}, body };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function jsonRes(
  body: unknown,
  opts: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: opts.status ?? 200,
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
  });
}

function textRes(text: string, status = 200): Response {
  return new Response(text, { status, headers: { 'content-type': 'text/html' } });
}

const tokenOk = (token = TOKEN, expire = 7200): Response =>
  jsonRes({ code: 0, msg: 'ok', tenant_access_token: token, expire });

const sendOk = (messageId = 'om_test_1'): Response =>
  jsonRes({ code: 0, msg: 'success', data: { message_id: messageId } });

const isTokenCall = (call: RecordedCall): boolean =>
  call.url.includes('/open-apis/auth/v3/tenant_access_token/internal');

const isSendCall = (call: RecordedCall): boolean => call.url.includes('/open-apis/im/v1/messages');

const tokenCalls = (calls: RecordedCall[]): RecordedCall[] => calls.filter(isTokenCall);
const sendCalls = (calls: RecordedCall[]): RecordedCall[] => calls.filter(isSendCall);

function headerOf(call: RecordedCall, name: string): string | undefined {
  const headers = call.init.headers as Record<string, string> | undefined;
  if (!headers) return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : headers[key];
}

/** A logger that records every line as text so tests can assert on secrets. */
function capturingLogger(lines: string[]): Logger {
  const record =
    (level: string) =>
    (...args: unknown[]): void => {
      lines.push(`${level} ${args.map(stringifyArg).join(' ')}`);
    };
  const logger: Record<string, unknown> = {
    fatal: record('fatal'),
    error: record('error'),
    warn: record('warn'),
    info: record('info'),
    debug: record('debug'),
    trace: record('trace'),
    silent: () => undefined,
    child: () => logger,
    level: 'trace',
    isLevelEnabled: () => true,
  };
  return logger as unknown as Logger;
}

function stringifyArg(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function makeClock(startMs: number): { readonly t: number; advance(ms: number): void } {
  const state = { t: startMs };
  return {
    get t() {
      return state.t;
    },
    advance(ms: number) {
      state.t += ms;
    },
  };
}

interface ClientSetup {
  client: LarkClient;
  calls: RecordedCall[];
  sleeps: number[];
  logs: string[];
  clock: { readonly t: number; advance(ms: number): void };
}

interface ClientOverrides {
  handler: Handler;
  maxAttempts?: number;
  baseBackoffMs?: number;
  requestTimeoutMs?: number;
  maxRetryDelayMs?: number;
  randomImpl?: () => number;
  appId?: string | undefined;
  appSecret?: string | undefined;
  chatId?: string | undefined;
  startMs?: number;
}

function setupClient(overrides: ClientOverrides): ClientSetup {
  const { fetchImpl, calls } = makeFetch(overrides.handler);
  const sleeps: number[] = [];
  const logs: string[] = [];
  const clock = makeClock(overrides.startMs ?? T0);
  const client = new LarkClient({
    baseUrl: BASE,
    appId: 'appId' in overrides ? overrides.appId : APP_ID,
    appSecret: 'appSecret' in overrides ? overrides.appSecret : APP_SECRET,
    chatId: 'chatId' in overrides ? overrides.chatId : CHAT_ID,
    logger: capturingLogger(logs),
    fetchImpl,
    now: () => clock.t,
    sleepImpl: async (ms: number) => {
      sleeps.push(ms);
    },
    maxAttempts: overrides.maxAttempts ?? 4,
    baseBackoffMs: overrides.baseBackoffMs ?? 500,
    // 0 disables the AbortController timer entirely for the deterministic tests.
    requestTimeoutMs: overrides.requestTimeoutMs ?? 0,
    maxRetryDelayMs: overrides.maxRetryDelayMs,
    randomImpl: overrides.randomImpl ?? (() => 0.5),
  });
  return { client, calls, sleeps, logs, clock };
}

const happyHandler: Handler = (call) => (isTokenCall(call) ? tokenOk() : sendOk());

/* ------------------------------------------------------------------ *
 * LarkClient — configuration
 * ------------------------------------------------------------------ */

describe('LarkClient configuration', () => {
  it('is configured only when app id, app secret and chat id are all present', () => {
    const full = setupClient({ handler: happyHandler });
    expect(full.client.configured).toBe(true);

    expect(setupClient({ handler: happyHandler, appId: undefined }).client.configured).toBe(false);
    expect(setupClient({ handler: happyHandler, appSecret: undefined }).client.configured).toBe(
      false,
    );
    expect(setupClient({ handler: happyHandler, chatId: undefined }).client.configured).toBe(false);
    expect(setupClient({ handler: happyHandler, chatId: '' }).client.configured).toBe(false);
  });

  it('returns a failure and makes no request at all when it is not configured', async () => {
    const { client, calls } = setupClient({ handler: happyHandler, chatId: undefined });
    const result = await client.sendText('hello');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.attempts).toBe(0);
    expect(result.error.retryable).toBe(true);
    expect(result.error.message).toContain('not configured');
    expect(calls).toHaveLength(0);
  });

  it('trims trailing slashes from the base URL so paths are not doubled', async () => {
    const { fetchImpl, calls } = makeFetch(happyHandler);
    const client = new LarkClient({
      baseUrl: `${BASE}//`,
      appId: APP_ID,
      appSecret: APP_SECRET,
      chatId: CHAT_ID,
      logger: capturingLogger([]),
      fetchImpl,
      now: () => T0,
      sleepImpl: async () => undefined,
      requestTimeoutMs: 0,
    });
    await client.sendText('hi');
    expect(calls[0]?.url).toBe(`${BASE}/open-apis/auth/v3/tenant_access_token/internal`);
  });

  it('exposes LarkError fields for the caller to branch on', () => {
    const err = new LarkError('boom', { code: 230001, httpStatus: 400, retryable: false });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('LarkError');
    expect(err.code).toBe(230001);
    expect(err.httpStatus).toBe(400);
    expect(err.retryable).toBe(false);
    expect(new LarkError('plain').retryable).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * LarkClient — token lifecycle
 * ------------------------------------------------------------------ */

describe('tenant access token lifecycle', () => {
  it('fetches a token once and caches it across sends', async () => {
    const { client, calls } = setupClient({ handler: happyHandler });
    expect(client.tokenState).toEqual({ hasToken: false, expiresAtMs: 0 });

    await client.sendText('one');
    const state = client.tokenState;
    expect(state.hasToken).toBe(true);
    expect(state.expiresAtMs).toBe(T0 + 7200 * 1000);
    await client.sendText('two');

    expect(tokenCalls(calls)).toHaveLength(1);
    expect(sendCalls(calls)).toHaveLength(2);
  });

  it('posts the flat token request with no Authorization header and the charset content type', async () => {
    const { client, calls } = setupClient({ handler: happyHandler });
    await client.sendText('hi');
    const call = tokenCalls(calls)[0];
    expect(call).toBeDefined();
    if (!call) return;
    expect(call.init.method).toBe('POST');
    expect(headerOf(call, 'Content-Type')).toBe('application/json; charset=utf-8');
    expect(headerOf(call, 'Authorization')).toBeUndefined();
    expect(call.body).toEqual({ app_id: APP_ID, app_secret: APP_SECRET });
  });

  it('sends the Bearer token on the message call only', async () => {
    const { client, calls } = setupClient({ handler: happyHandler });
    await client.sendText('hi');
    expect(headerOf(tokenCalls(calls)[0]!, 'Authorization')).toBeUndefined();
    expect(headerOf(sendCalls(calls)[0]!, 'Authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('refreshes proactively when fewer than 30 minutes of validity remain', async () => {
    const { client, calls, clock } = setupClient({ handler: happyHandler });
    await client.sendText('one');
    clock.advance(7200 * 1000 - (TOKEN_REFRESH_MARGIN_MS - 1000));
    await client.sendText('two');
    expect(tokenCalls(calls)).toHaveLength(2);
    expect(sendCalls(calls)).toHaveLength(2);
  });

  it('does not refresh while more than 30 minutes of validity remain', async () => {
    const { client, calls, clock } = setupClient({ handler: happyHandler });
    await client.sendText('one');
    clock.advance(7200 * 1000 - (TOKEN_REFRESH_MARGIN_MS + 60_000));
    await client.sendText('two');
    expect(tokenCalls(calls)).toHaveLength(1);
  });

  it('refreshToken() forces a fetch even when the cached token is still fresh', async () => {
    const { client, calls } = setupClient({ handler: happyHandler });
    await client.sendText('one');
    await client.refreshToken();
    expect(tokenCalls(calls)).toHaveLength(2);
  });

  it('treats a non-zero token code as a failure and does not retry a credential error', async () => {
    const { client, calls, sleeps } = setupClient({
      handler: () => jsonRes({ code: 10003, msg: 'invalid app_secret' }),
    });
    const result = await client.sendText('hi');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(10003);
    expect(result.error.retryable).toBe(false);
    // One token attempt, one send attempt, no sleeps: a wrong secret stays wrong.
    expect(tokenCalls(calls)).toHaveLength(1);
    expect(sendCalls(calls)).toHaveLength(0);
    expect(sleeps).toEqual([]);
  });

  it('retries a 5xx token endpoint up to maxAttempts and then fails the send', async () => {
    const { client, calls, sleeps } = setupClient({
      maxAttempts: 3,
      randomImpl: () => 0,
      handler: () => jsonRes({ code: 0, msg: 'oops' }, { status: 503 }),
    });
    const result = await client.sendText('hi');
    expect(result.ok).toBe(false);
    // Token acquisition retries internally and is TERMINAL for the send: the
    // budgets must not multiply into maxAttempts token requests per send attempt.
    expect(result.attempts).toBe(1);
    expect(tokenCalls(calls)).toHaveLength(3);
    expect(sendCalls(calls)).toHaveLength(0);
    expect(sleeps).toEqual([500, 1000]);
  });

  it('reports a flat token response with a missing token field as retryable', async () => {
    const { client, calls } = setupClient({
      maxAttempts: 2,
      randomImpl: () => 0,
      handler: () => jsonRes({ code: 0, msg: 'ok', expire: 7200 }),
    });
    const result = await client.sendText('hi');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('tenant_access_token');
    expect(tokenCalls(calls)).toHaveLength(2);
  });

  it('coalesces concurrent cold-start sends into a single token request', async () => {
    const { client, calls } = setupClient({ handler: happyHandler });
    await Promise.all([client.sendText('a'), client.sendText('b'), client.sendText('c')]);
    expect(tokenCalls(calls)).toHaveLength(1);
    expect(sendCalls(calls)).toHaveLength(3);
  });
});

/* ------------------------------------------------------------------ *
 * Refresh-once policy
 * ------------------------------------------------------------------ */

describe('invalid-token codes refresh exactly once', () => {
  const codes = [...INVALID_TOKEN_CODES];

  it.each(codes)('refreshes once and retries the send for code %i', async (code) => {
    let sends = 0;
    const { client, calls, sleeps } = setupClient({
      handler: (call) => {
        if (isTokenCall(call)) return tokenOk();
        sends += 1;
        return sends === 1 ? jsonRes({ code, msg: 'invalid access token' }) : sendOk('om_ok');
      },
    });
    const result = await client.sendText('hi');
    expect(result).toEqual({ ok: true, messageId: 'om_ok', attempts: 2 });
    expect(tokenCalls(calls)).toHaveLength(2);
    expect(sendCalls(calls)).toHaveLength(2);
    // No backoff for a credential refresh: the delay cannot fix a stale token.
    expect(sleeps).toEqual([]);
  });

  it('never refreshes twice: the second invalid-token reply is terminal', async () => {
    const { client, calls, sleeps } = setupClient({
      handler: (call) =>
        isTokenCall(call) ? tokenOk() : jsonRes({ code: 99991663, msg: 'invalid access token' }),
    });
    const result = await client.sendText('hi');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(99991663);
    expect(result.attempts).toBe(2);
    expect(tokenCalls(calls)).toHaveLength(2);
    expect(calls).toHaveLength(4);
    expect(sleeps).toEqual([]);
  });

  it('does not refresh on an ordinary success', async () => {
    const { client, calls } = setupClient({ handler: happyHandler });
    await client.sendText('hi');
    expect(tokenCalls(calls)).toHaveLength(1);
  });

  it('surfaces a failed refresh without burning further send attempts', async () => {
    let tokens = 0;
    const { client, calls } = setupClient({
      handler: (call) => {
        if (!isTokenCall(call)) return jsonRes({ code: 4001, msg: 'token expired' });
        tokens += 1;
        return tokens === 1 ? tokenOk() : jsonRes({ code: 10003, msg: 'invalid app_secret' });
      },
    });
    const result = await client.sendText('hi');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(10003);
    expect(sendCalls(calls)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * Message shapes — content must be a JSON string
 * ------------------------------------------------------------------ */

describe('message request shapes', () => {
  it('sends `content` as a JSON STRING that parses back to {text}', async () => {
    const { client, calls } = setupClient({ handler: happyHandler });
    const result = await client.sendText('hello "world"\nsecond line');
    expect(result).toEqual({ ok: true, messageId: 'om_test_1', attempts: 1 });

    const send = sendCalls(calls)[0]!;
    expect(typeof send.body.content).toBe('string');
    expect(JSON.parse(send.body.content as string)).toEqual({ text: 'hello "world"\nsecond line' });
  });

  it('addresses the chat by id with receive_id_type=chat_id in the query string', async () => {
    const { client, calls } = setupClient({ handler: happyHandler });
    await client.sendText('hi');
    const send = sendCalls(calls)[0]!;
    expect(send.url).toBe(`${BASE}/open-apis/im/v1/messages?receive_id_type=chat_id`);
    expect(send.body.receive_id).toBe(CHAT_ID);
    expect(send.body.msg_type).toBe('text');
    expect(headerOf(send, 'Content-Type')).toBe('application/json; charset=utf-8');
  });

  it('sends an interactive card as a JSON string with schema 2.0 and body.elements', async () => {
    const card = buildMarkdownCard('Daily report', 'Asia/Shanghai', ['**PnL** +12.50', 'trades: 3'], 'green');
    const { client, calls } = setupClient({ handler: happyHandler });
    const result = await client.sendCard(card, { uuid: 'daily-report-2024-01-01' });
    expect(result.ok).toBe(true);

    const send = sendCalls(calls)[0]!;
    expect(send.body.msg_type).toBe('interactive');
    expect(typeof send.body.content).toBe('string');
    const parsed = JSON.parse(send.body.content as string) as Record<string, unknown>;
    expect(parsed.schema).toBe('2.0');
    const body = parsed.body as { elements: unknown[] };
    expect(body.elements).toHaveLength(2);
    expect(body.elements[0]).toEqual({ tag: 'markdown', content: '**PnL** +12.50' });
    const header = parsed.header as { template: string; title: { content: string } };
    expect(header.template).toBe('green');
    expect(header.title.content).toBe('Daily report');
  });

  it('builds a 2.0 card with a title, subtitle and markdown sections', () => {
    const card = buildMarkdownCard('T', 'S', ['a', 'b']);
    expect(DEFAULT_CARD_SCHEMA_VERSION).toBe('2.0');
    expect(card.schema).toBe('2.0');
    expect(card.header?.title).toEqual({ tag: 'plain_text', content: 'T' });
    expect(card.header?.subtitle).toEqual({ tag: 'plain_text', content: 'S' });
    expect(card.header?.template).toBe('blue');
    expect(card.body?.elements).toEqual([
      { tag: 'markdown', content: 'a' },
      { tag: 'markdown', content: 'b' },
    ]);
  });

  it('accepts every documented template and clamps an unknown one', () => {
    for (const template of CARD_TEMPLATES) {
      expect(buildMarkdownCard('t', 's', [], template).header?.template).toBe(template);
    }
    expect(buildMarkdownCard('t', 's', [], 'chartreuse').header?.template).toBe('blue');
    expect(buildMarkdownCard('t', 's', []).header?.template).toBe('blue');
  });

  it('normalizes a card 1.0 to top-level elements and drops the schema field', () => {
    const card: LarkCard = {
      schema: '1.0',
      header: { template: 'red', title: { tag: 'plain_text', content: 'T' } },
      body: { elements: [{ tag: 'markdown', content: 'x' }] },
    };
    const wire = normalizeCardForSend(card);
    expect(wire.schema).toBeUndefined();
    expect(wire.elements).toEqual([{ tag: 'markdown', content: 'x' }]);
    expect(wire.body).toBeUndefined();
  });

  it('sends a card declared as 1.0 with top-level elements', async () => {
    const { client, calls } = setupClient({ handler: happyHandler });
    await client.sendCard({
      schema: '1.0',
      header: { template: 'orange', title: { tag: 'plain_text', content: 'Legacy' } },
      elements: [{ tag: 'markdown', content: 'legacy body' }],
    });
    const parsed = JSON.parse(sendCalls(calls)[0]!.body.content as string) as Record<string, unknown>;
    expect(parsed.schema).toBeUndefined();
    expect(parsed.elements).toEqual([{ tag: 'markdown', content: 'legacy body' }]);
  });

  it('defaults a card with no schema to the documented version', () => {
    const wire = normalizeCardForSend({ body: { elements: [{ tag: 'markdown', content: 'x' }] } });
    expect(wire.schema).toBe(DEFAULT_CARD_SCHEMA_VERSION);
  });

  it('refuses a non-string text body without touching the network', async () => {
    const { client, calls } = setupClient({ handler: happyHandler });
    const result = await client.sendText(42 as unknown as string);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.attempts).toBe(0);
    expect(result.error.message).toContain('requires a string');
    expect(calls).toHaveLength(0);
  });

  it('returns a failure rather than throwing when the card cannot be serialised', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const { client, calls } = setupClient({ handler: happyHandler });
    const result = await client.sendCard({ body: { elements: [circular] } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.attempts).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * uuid / idempotency
 * ------------------------------------------------------------------ */

describe('uuid idempotency key', () => {
  it('passes a uuid through on the send body', async () => {
    const { client, calls } = setupClient({ handler: happyHandler });
    await client.sendText('hi', { uuid: 'report-2024-01-01' });
    expect(sendCalls(calls)[0]!.body.uuid).toBe('report-2024-01-01');
  });

  it('reuses the same uuid on every retry of one logical send', async () => {
    let sends = 0;
    const { client, calls } = setupClient({
      handler: (call) => {
        if (isTokenCall(call)) return tokenOk();
        sends += 1;
        return sends === 1 ? jsonRes({ code: 190005, msg: 'too many requests' }) : sendOk();
      },
    });
    const result = await client.sendText('hi', { uuid: 'stable-key' });
    expect(result.ok).toBe(true);
    expect(sendCalls(calls).map((c) => c.body.uuid)).toEqual(['stable-key', 'stable-key']);
  });

  it('omits uuid entirely when none is given', async () => {
    const { client, calls } = setupClient({ handler: happyHandler });
    await client.sendText('hi');
    expect('uuid' in sendCalls(calls)[0]!.body).toBe(false);
  });

  it(`rejects a uuid longer than ${MAX_UUID_LENGTH} characters before any request`, async () => {
    const { client, calls } = setupClient({ handler: happyHandler });
    const result = await client.sendText('hi', { uuid: 'x'.repeat(MAX_UUID_LENGTH + 1) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.attempts).toBe(0);
    expect(result.error.message).toContain(String(MAX_UUID_LENGTH));
    expect(calls).toHaveLength(0);
  });

  it(`accepts a uuid of exactly ${MAX_UUID_LENGTH} characters`, async () => {
    const { client, calls } = setupClient({ handler: happyHandler });
    const result = await client.sendText('hi', { uuid: 'y'.repeat(MAX_UUID_LENGTH) });
    expect(result.ok).toBe(true);
    expect(sendCalls(calls)).toHaveLength(1);
  });

  it('rejects an empty uuid', async () => {
    const { client, calls } = setupClient({ handler: happyHandler });
    const result = await client.sendText('hi', { uuid: '' });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * Response classification
 * ------------------------------------------------------------------ */

describe('response classification', () => {
  it('treats HTTP 200 with code != 0 as a failure', async () => {
    const { client } = setupClient({
      handler: (call) =>
        isTokenCall(call) ? tokenOk() : jsonRes({ code: 230002, msg: 'bot is not in the group' }),
    });
    const result = await client.sendText('hi');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(230002);
    expect(result.error.httpStatus).toBe(200);
    expect(result.error.message).toContain('230002');
  });

  it('treats a non-2xx response with code 0 as a failure', async () => {
    const { client, sleeps } = setupClient({
      handler: (call) =>
        isTokenCall(call) ? tokenOk() : jsonRes({ code: 0, msg: 'ok' }, { status: 400 }),
    });
    const result = await client.sendText('hi');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.httpStatus).toBe(400);
    expect(result.error.retryable).toBe(false);
    expect(sleeps).toEqual([]);
  });

  it('retries a 5xx response that carries code 0', async () => {
    const { client, sleeps } = setupClient({
      maxAttempts: 2,
      randomImpl: () => 0,
      handler: (call) =>
        isTokenCall(call) ? tokenOk() : jsonRes({ code: 0, msg: 'internal' }, { status: 502 }),
    });
    const result = await client.sendText('hi');
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(2);
    expect(sleeps).toEqual([500]);
  });

  it('retries an unparseable success body', async () => {
    const { client, sleeps } = setupClient({
      maxAttempts: 3,
      randomImpl: () => 0,
      handler: (call) => (isTokenCall(call) ? tokenOk() : textRes('<html>gateway</html>')),
    });
    const result = await client.sendText('hi');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('unparseable');
    expect(result.attempts).toBe(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  it('reports a missing data.message_id as an empty success id rather than a failure', async () => {
    const { client } = setupClient({
      handler: (call) => (isTokenCall(call) ? tokenOk() : jsonRes({ code: 0, msg: 'success' })),
    });
    expect(await client.sendText('hi')).toEqual({ ok: true, messageId: '', attempts: 1 });
  });

  it('fails immediately on the documented non-retryable business codes', async () => {
    for (const code of [230001, 230002, 230099]) {
      const { client, calls, sleeps } = setupClient({
        handler: (call) =>
          isTokenCall(call) ? tokenOk() : jsonRes({ code, msg: 'bad' }, { status: 400 }),
      });
      const result = await client.sendText('hi');
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe(code);
      expect(result.error.retryable).toBe(false);
      expect(result.attempts).toBe(1);
      expect(sendCalls(calls)).toHaveLength(1);
      expect(sleeps).toEqual([]);
    }
  });

  it('treats an unknown business code as non-retryable', async () => {
    const { client, calls } = setupClient({
      handler: (call) => (isTokenCall(call) ? tokenOk() : jsonRes({ code: 999999, msg: 'weird' })),
    });
    const result = await client.sendText('hi');
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(1);
    expect(sendCalls(calls)).toHaveLength(1);
  });

  it.each([99991400, 1000004, 230020])('retries documented rate-limit code %i', async (code) => {
    let sends = 0;
    const { client, sleeps } = setupClient({
      handler: (call) => {
        if (isTokenCall(call)) return tokenOk();
        sends += 1;
        return sends === 1 ? jsonRes({ code, msg: 'rate limited' }) : sendOk('om_after_limit');
      },
    });
    const result = await client.sendText('hi');
    expect(result).toEqual({ ok: true, messageId: 'om_after_limit', attempts: 2 });
    expect(sleeps).toHaveLength(1);
  });

  it('covers every documented rate-limit code in the constant list', () => {
    expect(RATE_LIMIT_CODES).toContain(99991400);
    expect(RATE_LIMIT_CODES).toContain(90217);
    expect(RATE_LIMIT_CODES).toHaveLength(10);
  });
});

/* ------------------------------------------------------------------ *
 * Rate limiting, backoff and transport failures
 * ------------------------------------------------------------------ */

describe('rate limiting and retry pacing', () => {
  it('waits the x-ogw-ratelimit-reset interval before retrying a 429', async () => {
    let sends = 0;
    const { client, calls, sleeps } = setupClient({
      handler: (call) => {
        if (isTokenCall(call)) return tokenOk();
        sends += 1;
        return sends === 1
          ? jsonRes(
              { code: 99991400, msg: 'rate limited' },
              { status: 429, headers: { 'x-ogw-ratelimit-reset': '2', 'x-ogw-ratelimit-limit': '60' } },
            )
          : sendOk('om_after_429');
      },
    });
    const result = await client.sendText('hi');
    expect(result).toEqual({ ok: true, messageId: 'om_after_429', attempts: 2 });
    expect(sleeps).toEqual([2000]);
    expect(sendCalls(calls)).toHaveLength(2);
  });

  it('honours Retry-After when the rate-limit reset header is absent', async () => {
    let sends = 0;
    const { client, sleeps } = setupClient({
      handler: (call) => {
        if (isTokenCall(call)) return tokenOk();
        sends += 1;
        return sends === 1
          ? jsonRes({ code: 99991400, msg: 'rate limited' }, { status: 429, headers: { 'Retry-After': '3' } })
          : sendOk();
      },
    });
    expect((await client.sendText('hi')).ok).toBe(true);
    expect(sleeps).toEqual([3000]);
  });

  it('takes the larger of Retry-After and x-ogw-ratelimit-reset', async () => {
    let sends = 0;
    const { client, sleeps } = setupClient({
      handler: (call) => {
        if (isTokenCall(call)) return tokenOk();
        sends += 1;
        return sends === 1
          ? jsonRes(
              { code: 99991400, msg: 'rate limited' },
              {
                status: 429,
                headers: { 'Retry-After': '4', 'x-ogw-ratelimit-reset': '1' },
              },
            )
          : sendOk();
      },
    });
    expect((await client.sendText('hi')).ok).toBe(true);
    expect(sleeps).toEqual([4000]);
  });

  it('falls back to exponential jittered backoff when no pacing header is present', async () => {
    let sends = 0;
    const { client, sleeps } = setupClient({
      randomImpl: () => 0.5,
      handler: (call) => {
        if (isTokenCall(call)) return tokenOk();
        sends += 1;
        return sends === 1 ? jsonRes({ code: 99991400, msg: 'rate limited' }, { status: 429 }) : sendOk();
      },
    });
    expect((await client.sendText('hi')).ok).toBe(true);
    // base 500 * 1 * (1 + 0.5*0.5) = 625
    expect(sleeps).toEqual([625]);
  });

  it('retries repeated 5xx with strictly increasing backoff and gives up after maxAttempts', async () => {
    const { client, calls, sleeps } = setupClient({
      maxAttempts: 4,
      randomImpl: () => 0,
      handler: (call) =>
        isTokenCall(call) ? tokenOk() : jsonRes({ code: 0, msg: 'bad gateway' }, { status: 500 }),
    });
    const result = await client.sendText('hi');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.attempts).toBe(4);
    expect(sendCalls(calls)).toHaveLength(4);
    expect(sleeps).toEqual([500, 1000, 2000]);
  });

  it('keeps the backoff sequence monotonic under full jitter', async () => {
    const jitter = [0.1, 0.9, 0.5, 0.2];
    let i = 0;
    const { client, sleeps } = setupClient({
      maxAttempts: 4,
      randomImpl: () => jitter[i++ % jitter.length] ?? 0,
      handler: (call) =>
        isTokenCall(call) ? tokenOk() : jsonRes({ code: 0, msg: 'boom' }, { status: 503 }),
    });
    await client.sendText('hi');
    expect(sleeps).toHaveLength(3);
    for (let k = 1; k < sleeps.length; k += 1) {
      expect(sleeps[k]! > sleeps[k - 1]!).toBe(true);
    }
  });

  it('makes exactly one attempt when maxAttempts is 1', async () => {
    const { client, calls, sleeps } = setupClient({
      maxAttempts: 1,
      handler: (call) =>
        isTokenCall(call) ? tokenOk() : jsonRes({ code: 0, msg: 'boom' }, { status: 500 }),
    });
    const result = await client.sendText('hi');
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(1);
    expect(sendCalls(calls)).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('caps a very long server-requested wait at maxRetryDelayMs', async () => {
    let sends = 0;
    const { client, sleeps } = setupClient({
      maxRetryDelayMs: 5000,
      handler: (call) => {
        if (isTokenCall(call)) return tokenOk();
        sends += 1;
        return sends === 1
          ? jsonRes(
              { code: 99991400, msg: 'rate limited' },
              { status: 429, headers: { 'x-ogw-ratelimit-reset': '3600' } },
            )
          : sendOk();
      },
    });
    expect((await client.sendText('hi')).ok).toBe(true);
    expect(sleeps).toEqual([5000]);
  });

  it('retries a network rejection and then returns ok:false without throwing', async () => {
    const { client, calls, sleeps } = setupClient({
      maxAttempts: 3,
      randomImpl: () => 0,
      handler: (call) => {
        if (isTokenCall(call)) return tokenOk();
        throw new Error('ECONNRESET');
      },
    });
    const result = await client.sendText('hi');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.retryable).toBe(true);
    expect(result.error.message).toContain('ECONNRESET');
    expect(result.attempts).toBe(3);
    expect(sendCalls(calls)).toHaveLength(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  it('recovers when a transient network error is followed by a success', async () => {
    let sends = 0;
    const { client } = setupClient({
      handler: (call) => {
        if (isTokenCall(call)) return tokenOk();
        sends += 1;
        if (sends === 1) throw new Error('socket hang up');
        return sendOk('om_recovered');
      },
    });
    expect(await client.sendText('hi')).toEqual({
      ok: true,
      messageId: 'om_recovered',
      attempts: 2,
    });
  });

  it('retries a token-endpoint network rejection instead of failing the send outright', async () => {
    let tokens = 0;
    const { client } = setupClient({
      handler: (call) => {
        if (!isTokenCall(call)) return sendOk('om_ok');
        tokens += 1;
        if (tokens === 1) throw new Error('getaddrinfo ENOTFOUND');
        return tokenOk();
      },
    });
    expect((await client.sendText('hi')).ok).toBe(true);
    expect(tokens).toBe(2);
  });

  it('aborts a hung request at requestTimeoutMs and reports a retryable timeout', async () => {
    const { client, sleeps } = setupClient({
      maxAttempts: 2,
      requestTimeoutMs: 10,
      randomImpl: () => 0,
      handler: (call) => {
        if (isTokenCall(call)) return tokenOk();
        return new Promise<Response>((_resolve, reject) => {
          const signal = call.init.signal as AbortSignal | undefined;
          if (!signal) {
            reject(new Error('no abort signal was passed'));
            return;
          }
          signal.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError')),
          );
        });
      },
    });
    const result = await client.sendText('hi');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.retryable).toBe(true);
    expect(result.error.message).toContain('timed out or was aborted');
    expect(result.attempts).toBe(2);
    expect(sleeps).toEqual([500]);
  });
});

/* ------------------------------------------------------------------ *
 * Secret safety
 * ------------------------------------------------------------------ */

describe('secret safety', () => {
  it('redactLarkSecrets removes the token, the secret and any Bearer value', () => {
    const message = `failed with ${TOKEN} / ${APP_SECRET} / Bearer ${TOKEN}`;
    const redacted = redactLarkSecrets(message, { token: TOKEN, appSecret: APP_SECRET });
    expect(redacted).not.toContain(TOKEN);
    expect(redacted).not.toContain(APP_SECRET);
    expect(redacted).toContain('<redacted-token>');
    expect(redacted).toContain('<redacted-app-secret>');
    expect(redacted).toContain('Bearer <redacted>');
    expect(redactLarkSecrets('nothing to hide', {})).toBe('nothing to hide');
  });

  it('never logs the app secret or the tenant token, on success or failure', async () => {
    const { client, logs, calls } = setupClient({
      handler: (call) =>
        isTokenCall(call)
          ? tokenOk()
          : jsonRes({ code: 99991663, msg: `rejected token ${TOKEN} secret ${APP_SECRET}` }),
    });
    const failed = await client.sendText('hi');
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error.message).not.toContain(TOKEN);
      expect(failed.error.message).not.toContain(APP_SECRET);
    }

    // A succeeding send too, so the success path is covered by the same assertion.
    const ok = setupClient({ handler: happyHandler });
    await ok.client.sendText('hi');

    for (const lines of [logs, ok.logs]) {
      expect(lines.length).toBeGreaterThan(0);
      const joined = lines.join('\n');
      expect(joined).not.toContain(APP_SECRET);
      expect(joined).not.toContain(TOKEN);
      expect(joined).not.toContain(`Bearer ${TOKEN}`);
    }
    expect(calls.length).toBeGreaterThan(0);
  });

  it('keeps the secret out of the error message when the token endpoint echoes it', async () => {
    const secret = 'app-secret-echoed-by-server';
    const token = 't-token-echoed-by-server';
    const { client } = setupClient({
      appSecret: secret,
      handler: () =>
        jsonRes({ code: 99991663, msg: `bad app_secret=${secret} token=${token}` }),
    });
    const result = await client.sendText('hi');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).not.toContain(secret);
    expect(result.error.message).not.toContain(token);
    expect(result.error.message).toContain('99991663');
  });

  it('logs only token presence and length, never the value', async () => {
    const { client, logs } = setupClient({ handler: happyHandler });
    await client.sendText('hi');
    const joined = logs.join('\n');
    expect(joined).toContain('tenant access token acquired');
    expect(joined).toContain(`<set len=${TOKEN.length}>`);
    expect(joined).not.toContain(TOKEN);
  });

  it('returns a failure result instead of throwing for every send when unconfigured', async () => {
    const { client } = setupClient({ handler: happyHandler, appId: undefined, appSecret: undefined });
    const results: LarkSendResult[] = [
      await client.sendText('a'),
      await client.sendCard(buildMarkdownCard('t', 's', ['b'])),
      await client.sendText('c', { uuid: 'u' }),
    ];
    for (const result of results) {
      expect(result.ok).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ *
 * AlertRouter
 * ------------------------------------------------------------------ */

/** In-memory outbox that can be made to throw on demand. */
class MemoryOutbox implements OutboxStore {
  readonly records: {
    id: number;
    idempotencyKey: string;
    kind: 'text' | 'card';
    payload: string;
    createdAtMs: number;
    attempts: number;
    lastError?: string;
    sent: boolean;
  }[] = [];
  throwOnEnqueue = false;
  throwOnPending = false;
  throwOnMarkFailed = false;
  private nextId = 1;

  enqueue(record: {
    idempotencyKey: string;
    kind: 'text' | 'card';
    payload: string;
    createdAtMs: number;
    attempts: number;
    lastError?: string;
  }): void {
    if (this.throwOnEnqueue) throw new Error('outbox write failed');
    this.records.push({ id: this.nextId++, ...record, sent: false });
  }

  pending(limit: number): {
    id: number;
    idempotencyKey: string;
    kind: 'text' | 'card';
    payload: string;
    attempts: number;
  }[] {
    if (this.throwOnPending) throw new Error('outbox read failed');
    return this.records
      .filter((r) => !r.sent)
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        idempotencyKey: r.idempotencyKey,
        kind: r.kind,
        payload: r.payload,
        attempts: r.attempts,
      }));
  }

  markSent(id: number): void {
    const record = this.records.find((r) => r.id === id);
    if (!record) throw new Error(`no outbox record ${id}`);
    record.sent = true;
  }

  markFailed(id: number, error: string): void {
    if (this.throwOnMarkFailed) throw new Error('outbox markFailed failed');
    const record = this.records.find((r) => r.id === id);
    if (!record) throw new Error(`no outbox record ${id}`);
    record.attempts += 1;
    record.lastError = error;
  }

  get pendingCount(): number {
    return this.records.filter((r) => !r.sent).length;
  }
}

interface RouterSetup extends ClientSetup {
  router: AlertRouter;
  outbox: MemoryOutbox;
}

function setupRouter(overrides: {
  handler?: Handler;
  client?: LarkClient;
  outbox?: MemoryOutbox;
  dedupeWindowMs?: number;
  maxOutboxPerFlush?: number;
  startMs?: number;
  clientOverrides?: Partial<ClientOverrides>;
}): RouterSetup {
  const handler = overrides.handler ?? happyHandler;
  const { fetchImpl, calls } = makeFetch(handler);
  const sleeps: number[] = [];
  const logs: string[] = [];
  const clock = makeClock(overrides.startMs ?? T0);
  const client =
    overrides.client ??
    new LarkClient({
      baseUrl: BASE,
      appId: APP_ID,
      appSecret: APP_SECRET,
      chatId: CHAT_ID,
      logger: capturingLogger(logs),
      fetchImpl,
      now: () => clock.t,
      sleepImpl: async (ms: number) => {
        sleeps.push(ms);
      },
      maxAttempts: overrides.clientOverrides?.maxAttempts ?? 4,
      baseBackoffMs: 500,
      requestTimeoutMs: 0,
      randomImpl: () => 0.5,
      ...(overrides.clientOverrides ?? {}),
    });
  const outbox = overrides.outbox ?? new MemoryOutbox();
  const router = new AlertRouter({
    client,
    logger: capturingLogger(logs),
    outbox,
    now: () => clock.t,
    dedupeWindowMs: overrides.dedupeWindowMs,
    maxOutboxPerFlush: overrides.maxOutboxPerFlush,
  });
  return { router, client, calls, sleeps, logs, clock, outbox };
}

describe('AlertRouter dedupe and throttling', () => {
  it('uses the documented dedupe window and pacing constants', () => {
    expect(DEFAULT_DEDUPE_WINDOW_MS).toBe(5 * 60 * 1000);
    expect(CRITICAL_DEDUPE_WINDOW_MS).toBe(30 * 1000);
    expect(MAX_SENDS_PER_SECOND).toBe(5);
    expect(MIN_SEND_INTERVAL_MS).toBe(200);
  });

  it('suppresses an identical alert inside the dedupe window', async () => {
    const { router, calls, outbox } = setupRouter({});
    const alert: Alert = { severity: 'info', title: 'Market switch', body: 'moved to ETH' };
    const first = await router.alert(alert);
    const second = await router.alert(alert);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.retryable).toBe(false);
    expect(router.suppressedCount).toBe(1);
    expect(sendCalls(calls)).toHaveLength(1);
    expect(outbox.pendingCount).toBe(0);
  });

  it('sends again once the dedupe window has elapsed', async () => {
    const { router, calls, clock } = setupRouter({});
    const alert: Alert = { severity: 'warning', title: 'Drawdown', body: '-2%' };
    await router.alert(alert);
    clock.advance(DEFAULT_DEDUPE_WINDOW_MS);
    const second = await router.alert(alert);
    expect(second.ok).toBe(true);
    expect(router.suppressedCount).toBe(0);
    expect(sendCalls(calls)).toHaveLength(2);
  });

  it('dedupes on an explicit key across different titles', async () => {
    const { router, calls } = setupRouter({});
    await router.alert({ severity: 'info', title: 'A', body: 'first', key: 'shared' });
    const second = await router.alert({ severity: 'info', title: 'B', body: 'second', key: 'shared' });
    expect(second.ok).toBe(false);
    expect(router.suppressedCount).toBe(1);
    expect(sendCalls(calls)).toHaveLength(1);
  });

  it('defers non-critical alerts that arrive inside the local rate limit', async () => {
    const { router, calls, outbox } = setupRouter({});
    await router.alert({ severity: 'info', title: 'First', body: 'x' });
    const throttled = await router.alert({ severity: 'warning', title: 'Second', body: 'y' });

    expect(throttled.ok).toBe(false);
    if (!throttled.ok) expect(throttled.error.retryable).toBe(true);
    expect(sendCalls(calls)).toHaveLength(1);
    expect(outbox.pendingCount).toBe(1);
    expect(outbox.records[0]?.lastError).toContain('rate limit');
  });

  it('sends the deferred alert once the pacing interval has passed', async () => {
    const { router, calls, clock } = setupRouter({});
    await router.alert({ severity: 'info', title: 'First', body: 'x' });
    clock.advance(MIN_SEND_INTERVAL_MS);
    const second = await router.alert({ severity: 'info', title: 'Second', body: 'y' });
    expect(second.ok).toBe(true);
    expect(sendCalls(calls)).toHaveLength(2);
  });

  it('lets a critical alert bypass the throttle and colours it red', async () => {
    const { router, calls } = setupRouter({});
    await router.alert({ severity: 'info', title: 'First', body: 'x' });
    const critical = await router.alert({ severity: 'critical', title: 'Stop failed', body: 'urgent' });

    expect(critical.ok).toBe(true);
    const sends = sendCalls(calls);
    expect(sends).toHaveLength(2);
    const card = JSON.parse(sends[1]!.body.content as string) as {
      header: { template: string };
    };
    expect(card.header.template).toBe('red');
  });

  it('suppresses a second identical critical inside 30s but not after it', async () => {
    const { router, calls, clock } = setupRouter({});
    const alert: Alert = { severity: 'critical', title: 'Position unprotected', body: 'no stop' };
    expect((await router.alert(alert)).ok).toBe(true);

    const duplicate = await router.alert(alert);
    expect(duplicate.ok).toBe(false);
    expect(router.suppressedCount).toBe(1);

    clock.advance(CRITICAL_DEDUPE_WINDOW_MS + 1000);
    const later = await router.alert(alert);
    expect(later.ok).toBe(true);
    expect(router.suppressedCount).toBe(1);
    expect(sendCalls(calls)).toHaveLength(2);
  });

  it('sends info alerts that differ only in severity', async () => {
    const { router, outbox } = setupRouter({});
    const info = await router.alert({ severity: 'info', title: 'Same', body: 'b' });
    const warning = await router.alert({ severity: 'warning', title: 'Same', body: 'b' });
    expect(info.ok).toBe(true);
    // Severity is part of the derived dedupe key, so the warning is NOT a
    // duplicate — it is merely deferred by the local rate limit.
    expect(router.suppressedCount).toBe(0);
    expect(warning.ok).toBe(false);
    expect(outbox.pendingCount).toBe(1);
  });

  it('counts every suppression in suppressedCount', async () => {
    const { router } = setupRouter({});
    const alert: Alert = { severity: 'info', title: 'Chatty', body: 'b' };
    await router.alert(alert);
    await router.alert(alert);
    await router.alert(alert);
    expect(router.suppressedCount).toBe(2);
  });
});

describe('AlertRouter outbox behaviour', () => {
  it('enqueues instead of sending when the client is not configured', async () => {
    const outbox = new MemoryOutbox();
    const logs: string[] = [];
    const client = new LarkClient({
      baseUrl: BASE,
      appId: undefined,
      appSecret: undefined,
      chatId: undefined,
      logger: capturingLogger(logs),
      fetchImpl: makeFetch(happyHandler).fetchImpl,
      now: () => T0,
      sleepImpl: async () => undefined,
      requestTimeoutMs: 0,
    });
    const { calls } = makeFetch(happyHandler);
    const router = new AlertRouter({
      client,
      logger: capturingLogger(logs),
      outbox,
      now: () => T0,
    });

    const result = await router.alert({ severity: 'warning', title: 'Unconfigured', body: 'b' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.retryable).toBe(true);
    expect(outbox.pendingCount).toBe(1);
    expect(calls).toHaveLength(0);
    expect(outbox.records[0]?.lastError).toContain('not configured');
  });

  it('enqueues a failed send with the error attached', async () => {
    const { router, outbox } = setupRouter({
      handler: (call) =>
        isTokenCall(call) ? tokenOk() : jsonRes({ code: 230002, msg: 'bot is not in the group' }, { status: 400 }),
    });
    const result = await router.alert({ severity: 'warning', title: 'Failure', body: 'b' });
    expect(result.ok).toBe(false);
    expect(outbox.pendingCount).toBe(1);
    expect(outbox.records[0]?.lastError).toContain('230002');
    expect(outbox.records[0]?.attempts).toBe(1);
  });

  it('generates idempotency keys within the 50 character limit', async () => {
    const { router, outbox } = setupRouter({
      handler: (call) =>
        isTokenCall(call) ? tokenOk() : jsonRes({ code: 230002, msg: 'nope' }, { status: 400 }),
    });
    await router.alert({ severity: 'info', title: 'x'.repeat(200), body: 'b' });
    const key = outbox.records[0]?.idempotencyKey ?? '';
    expect(key.length).toBeGreaterThan(0);
    expect(key.length).toBeLessThanOrEqual(MAX_UUID_LENGTH);
  });

  it('never throws when the outbox refuses to accept a record', async () => {
    const outbox = new MemoryOutbox();
    outbox.throwOnEnqueue = true;
    const { router, logs } = setupRouter({
      outbox,
      handler: (call) =>
        isTokenCall(call) ? tokenOk() : jsonRes({ code: 230002, msg: 'nope' }, { status: 400 }),
    });
    const result = await router.alert({ severity: 'warning', title: 'Full', body: 'b' });
    expect(result.ok).toBe(false);
    expect(outbox.pendingCount).toBe(0);
    expect(logs.join('\n')).toContain('failed to enqueue');
  });

  it('never throws when the client throws while sending an alert', async () => {
    const throwingClient = {
      configured: true,
      sendCard: () => {
        throw new Error('client exploded');
      },
    } as unknown as LarkClient;
    const outbox = new MemoryOutbox();
    const router = new AlertRouter({
      client: throwingClient,
      logger: capturingLogger([]),
      outbox,
      now: () => T0,
    });
    const result = await router.alert({ severity: 'info', title: 'Boom', body: 'b' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('client exploded');
    expect(outbox.pendingCount).toBe(1);
  });

  it('round-trips an outbox record, preserving the idempotency key', () => {
    const outbox = new MemoryOutbox();
    const payload = JSON.stringify(buildMarkdownCard('T', 'S', ['body']));
    outbox.enqueue({
      idempotencyKey: 'ar-key-1',
      kind: 'card',
      payload,
      createdAtMs: T0,
      attempts: 0,
    });
    const pending = outbox.pending(10);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.idempotencyKey).toBe('ar-key-1');
    expect(pending[0]?.kind).toBe('card');
    expect(pending[0]?.payload).toBe(payload);
  });
});

describe('AlertRouter.flushOutbox', () => {
  it('retries a pending card and marks it sent, reusing the idempotency key', async () => {
    const outbox = new MemoryOutbox();
    outbox.enqueue({
      idempotencyKey: 'flush-key-1',
      kind: 'card',
      payload: JSON.stringify(buildMarkdownCard('T', 'S', ['body'])),
      createdAtMs: T0,
      attempts: 0,
    });
    const { router, calls, clock } = setupRouter({ outbox });
    clock.advance(60_000); // past any pacing window

    const result = await router.flushOutbox();
    expect(result).toEqual({ sent: 1, failed: 0, pending: 0 });
    expect(outbox.records[0]?.sent).toBe(true);
    expect(sendCalls(calls)).toHaveLength(1);
    expect(sendCalls(calls)[0]?.body.uuid).toBe('flush-key-1');
    expect(sendCalls(calls)[0]?.body.msg_type).toBe('interactive');
  });

  it('retries a pending text record with its payload intact', async () => {
    const outbox = new MemoryOutbox();
    outbox.enqueue({
      idempotencyKey: 'flush-text-1',
      kind: 'text',
      payload: JSON.stringify({ text: 'queued message' }),
      createdAtMs: T0,
      attempts: 0,
    });
    const { router, calls } = setupRouter({ outbox });
    const result = await router.flushOutbox();
    expect(result).toEqual({ sent: 1, failed: 0, pending: 0 });
    const send = sendCalls(calls)[0]!;
    expect(send.body.msg_type).toBe('text');
    expect(JSON.parse(send.body.content as string)).toEqual({ text: 'queued message' });
    expect(send.body.uuid).toBe('flush-text-1');
  });

  it('marks a record failed when the retry is rejected', async () => {
    const outbox = new MemoryOutbox();
    outbox.enqueue({
      idempotencyKey: 'flush-key-2',
      kind: 'card',
      payload: JSON.stringify(buildMarkdownCard('T', 'S', ['body'])),
      createdAtMs: T0,
      attempts: 2,
    });
    const { router } = setupRouter({
      outbox,
      handler: (call) =>
        isTokenCall(call) ? tokenOk() : jsonRes({ code: 230099, msg: 'malformed card' }, { status: 400 }),
    });
    const result = await router.flushOutbox();
    expect(result).toEqual({ sent: 0, failed: 1, pending: 1 });
    expect(outbox.records[0]?.attempts).toBe(3);
    expect(outbox.records[0]?.lastError).toContain('230099');
  });

  it('never throws when the client throws during a flush', async () => {
    const outbox = new MemoryOutbox();
    outbox.enqueue({
      idempotencyKey: 'flush-throw',
      kind: 'card',
      payload: JSON.stringify(buildMarkdownCard('T', 'S', ['body'])),
      createdAtMs: T0,
      attempts: 0,
    });
    const throwingClient = {
      configured: true,
      sendCard: () => {
        throw new Error('boom during flush');
      },
      sendText: () => {
        throw new Error('boom during flush');
      },
    } as unknown as LarkClient;
    const router = new AlertRouter({
      client: throwingClient,
      logger: capturingLogger([]),
      outbox,
      now: () => T0,
    });
    const result = await router.flushOutbox();
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
    expect(outbox.records[0]?.lastError).toContain('boom during flush');
  });

  it('never throws when the outbox cannot even list pending records', async () => {
    const outbox = new MemoryOutbox();
    outbox.enqueue({
      idempotencyKey: 'flush-read-fail',
      kind: 'card',
      payload: JSON.stringify(buildMarkdownCard('T', 'S', ['body'])),
      createdAtMs: T0,
      attempts: 0,
    });
    outbox.throwOnPending = true;
    const { router, logs } = setupRouter({ outbox });
    const result = await router.flushOutbox();
    expect(result).toEqual({ sent: 0, failed: 0, pending: 0 });
    expect(logs.join('\n')).toContain('could not read pending records');
  });

  it('never throws when markFailed itself throws', async () => {
    const outbox = new MemoryOutbox();
    outbox.enqueue({
      idempotencyKey: 'flush-markfail',
      kind: 'card',
      payload: JSON.stringify(buildMarkdownCard('T', 'S', ['body'])),
      createdAtMs: T0,
      attempts: 0,
    });
    outbox.throwOnMarkFailed = true;
    const { router, logs } = setupRouter({
      outbox,
      handler: (call) =>
        isTokenCall(call) ? tokenOk() : jsonRes({ code: 230001, msg: 'bad param' }, { status: 400 }),
    });
    const result = await router.flushOutbox();
    expect(result.failed).toBe(1);
    expect(logs.join('\n')).toContain('markFailed failed');
  });

  it('fails a record whose payload is not JSON without calling the client', async () => {
    const outbox = new MemoryOutbox();
    outbox.enqueue({
      idempotencyKey: 'flush-bad-payload',
      kind: 'card',
      payload: 'not json at all',
      createdAtMs: T0,
      attempts: 0,
    });
    const { router, calls } = setupRouter({ outbox });
    const result = await router.flushOutbox();
    expect(result).toEqual({ sent: 0, failed: 1, pending: 1 });
    expect(calls).toHaveLength(0);
    expect(outbox.records[0]?.lastError).toContain('unparseable payload');
  });

  it('reports the number of records still pending after a partial flush', async () => {
    const outbox = new MemoryOutbox();
    for (let i = 0; i < 3; i += 1) {
      outbox.enqueue({
        idempotencyKey: `multi-${i}`,
        kind: 'card',
        payload: JSON.stringify(buildMarkdownCard('T', 'S', [`body ${i}`])),
        createdAtMs: T0,
        attempts: 0,
      });
    }
    const { router } = setupRouter({ outbox, maxOutboxPerFlush: 2 });
    const result = await router.flushOutbox();
    expect(result).toEqual({ sent: 2, failed: 0, pending: 1 });
  });

  it('flushes an alert that was deferred by the local rate limit', async () => {
    const { router, calls, outbox, clock } = setupRouter({});
    await router.alert({ severity: 'info', title: 'First', body: 'a' });
    await router.alert({ severity: 'info', title: 'Second', body: 'b' });
    expect(outbox.pendingCount).toBe(1);

    clock.advance(60_000);
    const result = await router.flushOutbox();
    expect(result).toEqual({ sent: 1, failed: 0, pending: 0 });
    expect(sendCalls(calls)).toHaveLength(2);
  });

  it('is a no-op with an empty outbox', async () => {
    const { router, calls } = setupRouter({});
    expect(await router.flushOutbox()).toEqual({ sent: 0, failed: 0, pending: 0 });
    expect(calls).toHaveLength(0);
  });
});
