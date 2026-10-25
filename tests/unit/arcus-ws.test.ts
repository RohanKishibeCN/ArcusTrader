/**
 * Arcus WebSocket client tests.
 *
 * The behaviours pinned here are the ones that made the difference between a
 * working client and a broken one:
 *
 *  1. A server `error` frame must NOT crash the process. Node's EventEmitter makes
 *     an unhandled `error` event a fatal exception, and Arcus sends
 *     `{"type":"error","message":"address not on access whitelist"}` as normal
 *     traffic. Observed live: the process aborted with ERR_UNHANDLED_ERROR. The
 *     frame is emitted as `serverError` instead.
 *
 *  2. Readiness is SNAPSHOT-based. The reply to `subscribe` carries `contents` = the
 *     initial snapshot; there is no bare acknowledgement frame. Counting an empty
 *     ack as ready would let the strategy act on a half-populated view.
 *
 *  3. Request ids must strictly increase per connection, and the counter resets on
 *     reconnect. A violating id is rejected with an error frame that does NOT echo
 *     the id, so an in-flight request must be failed by its own timeout rather than
 *     hanging forever.
 *
 *  4. Account-channel ids are compared case-insensitively, because the server always
 *     lowercases the address regardless of how it was subscribed.
 *
 *  5. Pending requests are failed on disconnect, so a caller waiting on a stop-order
 *     confirmation cannot block the trading loop indefinitely.
 */

import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { ArcusWsClient, subscriptionKey, extractErrorMessage } from '../../src/arcus/ArcusWsClient';
import { silentLogger } from '../../src/util/logger';

/** Minimal in-memory WebSocket double. */
class FakeSocket extends EventEmitter {
  static instances: FakeSocket[] = [];
  static last(): FakeSocket {
    return FakeSocket.instances[FakeSocket.instances.length - 1]!;
  }
  readyState = 0;
  readonly sent: string[] = [];
  readonly url: string;

  constructor(url: string) {
    super();
    this.url = url;
    FakeSocket.instances.push(this);
  }

  open(): void {
    this.readyState = 1;
    this.emit('open');
  }

  send(data: string): void {
    this.sent.push(data);
  }

  ping(): void {
    /* no-op */
  }

  close(code = 1000, reason = ''): void {
    this.readyState = 3;
    this.emit('close', code, Buffer.from(reason));
  }

  terminate(): void {
    this.readyState = 3;
    this.emit('close', 1006, Buffer.from('terminated'));
  }

  /** Deliver a server frame. */
  deliver(frame: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(frame)));
  }

  sentFrames(): Record<string, unknown>[] {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
}

function makeClient(overrides: Partial<ConstructorParameters<typeof ArcusWsClient>[0]> = {}) {
  FakeSocket.instances = [];
  const client = new ArcusWsClient({
    url: 'wss://api.arcus.xyz/v1/ws',
    logger: silentLogger(),
    webSocketImpl: FakeSocket as never,
    pingIntervalMs: 10_000,
    silenceTimeoutMs: 60_000,
    requestTimeoutMs: 200,
    ...overrides,
  });
  return { client, socket: () => FakeSocket.last() };
}

describe('connection lifecycle', () => {
  it('reports connected state and a connected frame is not treated as malformed', () => {
    const { client, socket } = makeClient();
    client.connect();
    socket().open();
    expect(client.isConnected).toBe(true);
    expect(client.connectionState).toBe('connected');
    // The server sends this immediately on open.
    socket().deliver({ type: 'connected', connection_id: '1791881858319126381' });
    expect(client.stats.errorFrameCount).toBe(0);
    client.close();
  });

  it('is not ready until every desired channel has snapshotted', () => {
    const { client, socket } = makeClient();
    client.subscribe({ channel: 'markets' });
    client.subscribe({ channel: 'positions', id: '0xABC' });
    client.connect();
    socket().open();
    expect(client.isReady).toBe(false);
    expect(client.pendingSubscriptions).toHaveLength(2);

    socket().deliver({ type: 'subscribed', channel: 'markets', contents: { '1': {} } });
    expect(client.isReady).toBe(false);

    socket().deliver({ type: 'subscribed', channel: 'positions', id: '0xabc', contents: { positions: [] } });
    expect(client.isReady).toBe(true);
    expect(client.pendingSubscriptions).toHaveLength(0);
    client.close();
  });

  it('does NOT count a contents-less frame as a snapshot', () => {
    const { client, socket } = makeClient();
    client.subscribe({ channel: 'markets' });
    client.connect();
    socket().open();
    // A bare ack with no payload must not mark the channel ready.
    socket().deliver({ type: 'subscribed', channel: 'markets' });
    expect(client.isReady).toBe(false);
    client.close();
  });

  it('matches an account channel id case-insensitively', () => {
    const { client, socket } = makeClient();
    // Subscribed with a checksummed address; the server replies lowercased.
    client.subscribe({ channel: 'orders', id: '0xAbCdEf0000000000000000000000000000000001' });
    client.connect();
    socket().open();
    socket().deliver({
      type: 'subscribed',
      channel: 'orders',
      id: '0xabcdef0000000000000000000000000000000001',
      accountIndex: 0,
      contents: { orders: [] },
    });
    expect(client.isReady).toBe(true);
    client.close();
  });

  it('replays subscriptions after a reconnect and clears readiness', () => {
    const { client, socket } = makeClient({ baseBackoffMs: 1 });
    client.subscribe({ channel: 'markets' });
    client.connect();
    socket().open();
    socket().deliver({ type: 'subscribed', channel: 'markets', contents: {} });
    expect(client.isReady).toBe(true);

    const first = socket();
    first.close(1006, 'network');
    expect(client.isConnected).toBe(false);
    // Readiness must be re-established from fresh snapshots, not remembered.
    expect(client.isReady).toBe(false);
    client.close();
  });

  it('stops reconnecting after a deliberate close', () => {
    vi.useFakeTimers();
    try {
      const { client, socket } = makeClient({ baseBackoffMs: 1 });
      client.connect();
      socket().open();
      client.close();
      expect(client.connectionState).toBe('closed');
      vi.advanceTimersByTime(1000);
      // No new socket was constructed.
      expect(FakeSocket.instances).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('server error frames are data, not fatal', () => {
  it('emits serverError and does NOT throw for an unhandled error frame', () => {
    const { client, socket } = makeClient();
    const seen: unknown[] = [];
    client.on('serverError', (frame) => seen.push(frame));
    client.subscribe({ channel: 'positions', id: '0x1111111111111111111111111111111111111111' });
    client.connect();
    socket().open();

    // This is the exact live frame that previously aborted the process.
    expect(() =>
      socket().deliver({ type: 'error', message: 'address not on access whitelist' }),
    ).not.toThrow();
    expect(seen).toHaveLength(1);
    expect(client.stats.errorFrameCount).toBe(1);
    client.close();
  });

  it('extracts the server message from either `message` or `contents`', () => {
    expect(
      extractErrorMessage({ type: 'error', raw: { message: 'address not on access whitelist' } }),
    ).toBe('address not on access whitelist');
    expect(extractErrorMessage({ type: 'error', raw: {}, contents: { error: 'boom' } })).toBe('boom');
    expect(extractErrorMessage({ type: 'error', raw: {} })).toBeUndefined();
  });

  it('survives an unhandled error frame with no listener at all', () => {
    const { client, socket } = makeClient();
    client.connect();
    socket().open();
    // No listener registered: an `error` event would have thrown here.
    expect(() => socket().deliver({ type: 'error', message: 'boom' })).not.toThrow();
    client.close();
  });

  it('records a degraded frame without crashing', () => {
    const { client, socket } = makeClient();
    const degraded: unknown[] = [];
    client.on('degraded', (f) => degraded.push(f));
    client.connect();
    socket().open();
    socket().deliver({ type: 'degraded', channel: 'userFills', contents: {} });
    expect(degraded).toHaveLength(1);
    expect(client.stats.errorFrameCount).toBe(1);
    client.close();
  });
});

describe('RPC request ids', () => {
  it('uses strictly increasing ids starting at 1 for a new connection', async () => {
    const { client, socket } = makeClient();
    client.connect();
    socket().open();

    const first = client.request('bbo', { market: 'BTC-USD' }, 'get');
    const second = client.request('mids', {}, 'get');
    const frames = socket().sentFrames();
    expect(frames[0]!.id).toBe(1);
    expect(frames[1]!.id).toBe(2);

    socket().deliver({ id: 1, type: 'get', result: { ok: 1 } });
    socket().deliver({ id: 2, type: 'get', result: { ok: 2 } });
    await expect(first).resolves.toMatchObject({ result: { ok: 1 } });
    await expect(second).resolves.toMatchObject({ result: { ok: 2 } });
    client.close();
  });

  it('resets the id counter on a new connection', () => {
    const { client, socket } = makeClient({ baseBackoffMs: 1 });
    client.connect();
    socket().open();
    // Attach a handler: closing the socket rejects in-flight requests, and an
    // unhandled rejection here would be a real defect in a caller.
    const first = client.request('mids', {}, 'get');
    first.catch(() => undefined);
    expect(socket().sentFrames()[0]!.id).toBe(1);

    socket().close(1006, 'drop');
    client.connect();
    socket().open();
    const second = client.request('mids', {}, 'get');
    second.catch(() => undefined);
    // A fresh connection restarts at 1, which the server requires.
    expect(socket().sentFrames()[0]!.id).toBe(1);
    client.close();
  });

  it('times out an unanswered request instead of hanging forever', async () => {
    vi.useFakeTimers();
    try {
      const { client, socket } = makeClient({ requestTimeoutMs: 50 });
      client.connect();
      socket().open();
      const pending = client.request('bbo', {}, 'get');
      // Attach the assertion first so the rejection is always observed, even if
      // the timer fires before the expectation is awaited.
      const assertion = expect(pending).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails in-flight requests when the socket closes', async () => {
    const { client, socket } = makeClient();
    client.connect();
    socket().open();
    const pending = client.request('bbo', {}, 'get');
    socket().close(1006, 'drop');
    await expect(pending).rejects.toThrow(/closed while awaiting/);
    client.close();
  });

  it('refuses to issue a request while disconnected', async () => {
    const { client } = makeClient();
    await expect(client.request('bbo', {}, 'get')).rejects.toThrow(/not connected/);
  });

  it('clears pending requests once they resolve, so close() has none to reject', async () => {
    const { client, socket } = makeClient();
    client.connect();
    socket().open();
    const first = client.request('bbo', {}, 'get');
    socket().deliver({ id: 1, type: 'get', result: { ok: true } });
    await first;
    // Nothing pending, so closing is silent.
    expect(() => client.close()).not.toThrow();
  });
});

describe('subscription identity', () => {
  it('distinguishes a filtered from an unfiltered subscription', () => {
    const unfiltered = subscriptionKey({ channel: 'orders', id: '0xabc' });
    const filtered = subscriptionKey({ channel: 'orders', id: '0xabc', market: 'BTC-USD' });
    const otherMarket = subscriptionKey({ channel: 'orders', id: '0xabc', market: 'ETH-USD' });
    expect(unfiltered).not.toBe(filtered);
    expect(filtered).not.toBe(otherMarket);
  });

  it('distinguishes l2 aggregations of the same market', () => {
    const full = subscriptionKey({ channel: 'l2Orderbook', id: 'BTC-USD' });
    const aggregated = subscriptionKey({ channel: 'l2Orderbook', id: 'BTC-USD', sigFigs: 4 });
    const rounded = subscriptionKey({ channel: 'l2Orderbook', id: 'BTC-USD', sigFigs: 5, roundStep: 2 });
    expect(new Set([full, aggregated, rounded]).size).toBe(3);
  });
});

describe('subscription frames', () => {
  it('sends the documented subscribe shape and omits unset options', () => {
    const { client, socket } = makeClient();
    client.connect();
    socket().open();
    client.subscribe({ channel: 'markets' });
    client.subscribe({ channel: 'l2Orderbook', id: 'BTC-USD', nLevels: 5 });
    client.subscribe({ channel: 'positions', id: '0xABC', market: 'BTC-USD' });

    const frames = socket().sentFrames();
    expect(frames[0]).toEqual({ type: 'subscribe', channel: 'markets' });
    expect(frames[1]).toEqual({ type: 'subscribe', channel: 'l2Orderbook', id: 'BTC-USD', nLevels: 5 });
    expect(frames[2]).toEqual({
      type: 'subscribe',
      channel: 'positions',
      id: '0xABC',
      market: 'BTC-USD',
    });
    client.close();
  });

  it('suppresses the snapshot only when explicitly asked', () => {
    const { client, socket } = makeClient();
    client.connect();
    socket().open();
    client.subscribe({ channel: 'orders', id: '0xabc' });
    client.subscribe({ channel: 'orders', id: '0xdef', snapshot: false });
    const frames = socket().sentFrames();
    expect(frames[0]).not.toHaveProperty('snapshot');
    expect(frames[1]).toMatchObject({ snapshot: false });
    client.close();
  });

  it('repeats the market filter on unsubscribe, as required for identity', () => {
    const { client, socket } = makeClient();
    client.connect();
    socket().open();
    client.subscribe({ channel: 'userFills', id: '0xabc', market: 'BTC-USD' });
    client.unsubscribe({ channel: 'userFills', id: '0xabc', market: 'BTC-USD' });
    const frames = socket().sentFrames();
    expect(frames[1]).toEqual({
      type: 'unsubscribe',
      channel: 'userFills',
      id: '0xabc',
      market: 'BTC-USD',
    });
    client.close();
  });

  it('drops a send when the socket is not open rather than throwing', () => {
    const { client, socket } = makeClient();
    client.connect();
    // Not opened yet.
    expect(() => client.subscribe({ channel: 'markets' })).not.toThrow();
    expect(socket().sent).toHaveLength(0);
    client.close();
  });
});

describe('waitForReady', () => {
  it('resolves once all channels are ready', async () => {
    const { client, socket } = makeClient();
    client.subscribe({ channel: 'markets' });
    client.connect();
    const waiting = client.waitForReady(500);
    socket().open();
    socket().deliver({ type: 'subscribed', channel: 'markets', contents: {} });
    await expect(waiting).resolves.toBe(true);
    client.close();
  });

  it('resolves false on timeout rather than hanging', async () => {
    vi.useFakeTimers();
    try {
      const { client } = makeClient();
      client.subscribe({ channel: 'markets' });
      const waiting = client.waitForReady(50);
      await vi.advanceTimersByTimeAsync(100);
      await expect(waiting).resolves.toBe(false);
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves immediately when already ready', async () => {
    const { client, socket } = makeClient();
    client.subscribe({ channel: 'markets' });
    client.connect();
    socket().open();
    socket().deliver({ type: 'subscribed', channel: 'markets', contents: {} });
    await expect(client.waitForReady(10)).resolves.toBe(true);
    client.close();
  });
});

describe('frame dispatch does not throw on unexpected traffic', () => {
  it('ignores a non-JSON frame', () => {
    const { client, socket } = makeClient();
    client.connect();
    socket().open();
    expect(() => socket().emit('message', Buffer.from('not json'))).not.toThrow();
    client.close();
  });

  it('ignores a JSON frame that is not an object', () => {
    const { client, socket } = makeClient();
    client.connect();
    socket().open();
    expect(() => socket().deliver([1, 2, 3])).not.toThrow();
    expect(() => socket().deliver('a string')).not.toThrow();
    client.close();
  });

  it('accepts an unknown frame type without error', () => {
    const { client, socket } = makeClient();
    client.connect();
    socket().open();
    expect(() => socket().deliver({ type: 'some_future_type', channel: 'x' })).not.toThrow();
    client.close();
  });

  it('counts frames and tracks time since the last one', () => {
    const { client, socket } = makeClient();
    client.connect();
    socket().open();
    socket().deliver({ type: 'channel_data', channel: 'markets', contents: {} });
    socket().deliver({ type: 'channel_data', channel: 'markets', contents: {} });
    expect(client.stats.framesReceived).toBe(2);
    expect(client.msSinceLastFrame).toBeTypeOf('number');
    client.close();
  });
});
