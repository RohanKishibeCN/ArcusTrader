/**
 * Arcus WebSocket client.
 *
 * One socket multiplexes channel subscriptions AND request/response RPC, so this
 * single client serves both the market-data and account-state needs of the
 * system. Protocol details are taken from `docs/arcus/asyncapi.yaml` and
 * `docs/arcus/api-reference__websocket.md`; see `docs/API_CONTRACTS.md` §6.
 *
 * Behaviours that are load-bearing for safety:
 *
 *  1. **Readiness is snapshot-based.** The reply to a `subscribe` is
 *     `{"type":"subscribed", …}` whose `contents` IS the initial snapshot — there
 *     is no bare acknowledgement frame. So a channel only counts as ready once a
 *     frame carrying `contents` has arrived. Treating the empty ack as "ready"
 *     would let the strategy act on an empty local view.
 *
 *  2. **Comparison of the subscription id is case-insensitive for addresses.**
 *     The server always lowercases the address in `id`, regardless of the
 *     spelling used to subscribe, so an exact string match would never fire for a
 *     checksummed address.
 *
 *  3. **Strictly increasing request ids per connection.** A `get`/`post` whose id
 *     is not greater than the previous one is rejected with an `error` frame that
 *     does NOT echo the id. That means a naive id-matching client hangs forever.
 *     The counter resets on every new connection, and pending requests are failed
 *     explicitly on disconnect rather than left dangling.
 *
 *  4. **Disconnect is a first-class state, not an error to swallow.** The system
 *     refuses new entries while the socket is down; protective stop orders are
 *     left on the venue deliberately (they are reduce-only and venue-side, so
 *     cancelling them on disconnect would remove protection).
 *
 *  5. **Subscriptions are unauthenticated upstream** (including account channels).
 *     Nothing here treats the socket as a trust boundary, and the address is
 *     therefore treated as a public identifier.
 */

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { Logger } from '../util/logger';

/** Channels this client knows how to route. */
export const WS_CHANNELS = [
  'markets',
  'prices',
  'oraclePrices',
  'bbo',
  'trades',
  'l2Orderbook',
  'l2OrderbookUpdates',
  'candles',
  'funding',
  'predictedFunding',
  'marketAttributes',
  'exchangeAttributeUpdates',
  'account',
  'positions',
  'orders',
  'userFills',
  'accountTransferUpdates',
  'accountAttributeUpdates',
  'orderOperations',
] as const;
export type WsChannel = (typeof WS_CHANNELS)[number];

/** Account-scoped channels carry `accountIndex` on every frame and an address `id`. */
export const ACCOUNT_CHANNELS: readonly WsChannel[] = [
  'account',
  'positions',
  'orders',
  'userFills',
  'accountTransferUpdates',
  'accountAttributeUpdates',
];

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'degraded'
  | 'closed'
  | 'failed';

/** A subscription request as sent on the wire. */
export interface SubscriptionSpec {
  readonly channel: WsChannel;
  /**
   * Channel id: the market ticker for per-market channels, the master address
   * for account-scoped channels. Omitted for global channels.
   */
  readonly id?: string;
  /** Suppress the initial snapshot on delta channels. Defaults to true server-side. */
  readonly snapshot?: boolean;
  readonly nLevels?: number;
  /** `l2Orderbook` aggregation. 2-5; omitted means a full-precision view. */
  readonly sigFigs?: number;
  readonly roundStep?: number;
  readonly nRecentClosed?: number;
  readonly nFills?: number;
  /** Market filter for orders/positions/userFills. Part of subscription identity. */
  readonly market?: string;
}

/** Stable key for a subscription, used for de-duplication and readiness tracking. */
export function subscriptionKey(spec: SubscriptionSpec): string {
  const parts = [spec.channel, spec.id ?? '_', spec.market ?? '_'];
  if (spec.nLevels !== undefined) parts.push(`l${spec.nLevels}`);
  if (spec.sigFigs !== undefined) parts.push(`s${spec.sigFigs}`);
  if (spec.roundStep !== undefined) parts.push(`r${spec.roundStep}`);
  return parts.join('|');
}

/** Full account-scoped envelope as delivered by the server. */
export interface ChannelFrame {
  readonly type:
    | 'connected'
    | 'subscribed'
    | 'channel_data'
    | 'unsubscribed'
    | 'error'
    | 'degraded';
  readonly channel?: string;
  readonly id?: string;
  /** Present on EVERY frame of an account-scoped channel, including 0. */
  readonly accountIndex?: number;
  readonly market?: string;
  readonly sigFigs?: number;
  readonly roundStep?: number;
  readonly contents?: unknown;
  /** Raw frame for diagnostics; never logged wholesale. */
  readonly raw: unknown;
}

export interface PendingRequest {
  readonly id: number;
  readonly method: string;
  readonly issuedAtMs: number;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export interface ArcusWsClientOptions {
  readonly url: string;
  readonly logger: Logger;
  /** Injectable WebSocket implementation for tests. */
  readonly webSocketImpl?: typeof WebSocket;
  /** Reconnect backoff base. Default 500ms, doubling, capped by maxBackoffMs. */
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
  /** Application-level ping interval. Default 20s. */
  readonly pingIntervalMs?: number;
  /** Consider the socket dead if no frame arrives for this long. Default 60s. */
  readonly silenceTimeoutMs?: number;
  /** Per-RPC timeout. Default 15s. */
  readonly requestTimeoutMs?: number;
  readonly now?: () => number;
}

export interface ArcusWsEvents {
  connected: [];
  disconnected: [{ code: number; reason: string; willReconnect: boolean }];
  stateChanged: [{ from: ConnectionState; to: ConnectionState }];
  /** A channel delivered its snapshot (or a snapshot-equivalent global frame). */
  snapshot: [ChannelFrame, SubscriptionSpec];
  /** A live update for a subscribed channel. */
  update: [ChannelFrame, SubscriptionSpec];
  /**
   * Server-sent error frame.
   *
   * Deliberately NOT named `error`. Node's EventEmitter makes an unhandled `error`
   * event a fatal exception, and this frame is a normal, expected server response
   * (for example `{"type":"error","message":"address not on access whitelist"}`).
   * Emitting it as `error` crashed the process; as `serverError` it is just data.
   */
  serverError: [ChannelFrame];
  /** A channel reported a degraded state. */
  degraded: [ChannelFrame];
}

/**
 * Pull the human-readable reason out of an error frame.
 *
 * The server uses `message` (verified live:
 * `{"type":"error","message":"address not on access whitelist"}`), while other
 * frames carry their payload under `contents`. Both are checked so the log line
 * always explains WHY the subscribe was refused.
 */
export function extractErrorMessage(frame: ChannelFrame): string | undefined {
  const raw = frame.raw as Record<string, unknown> | undefined;
  if (raw && typeof raw.message === 'string') return raw.message;
  if (raw && typeof raw.error === 'string') return raw.error;
  if (frame.contents && typeof frame.contents === 'object') {
    const contents = frame.contents as Record<string, unknown>;
    if (typeof contents.message === 'string') return contents.message;
    if (typeof contents.error === 'string') return contents.error;
  }
  return undefined;
}

/**
 * WebSocket client with explicit readiness tracking.
 *
 * Extends EventEmitter with typed overloads so consumers get compile-time
 * checked event payloads without pulling in a typed-emitter dependency.
 */
export class ArcusWsClient extends EventEmitter {
  private readonly url: string;
  private readonly logger: Logger;
  private readonly WebSocketImpl: typeof WebSocket;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly pingIntervalMs: number;
  private readonly silenceTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly now: () => number;

  private socket?: WebSocket;
  private state: ConnectionState = 'idle';

  /** Request id counter. MUST strictly increase within a connection. */
  private requestIdCounter = 0;
  private readonly pending = new Map<number, PendingRequest>();

  /** Desired subscriptions, replayed verbatim after every reconnect. */
  private readonly desired = new Map<string, SubscriptionSpec>();
  /** Channels that have delivered a frame with `contents`. */
  private readonly readyKeys = new Set<string>();

  private reconnectAttempt = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private pingTimer?: NodeJS.Timeout;
  private silenceTimer?: NodeJS.Timeout;
  private lastFrameAtMs = 0;
  private closedByUs = false;

  /** Frame counters for the daily report. */
  private framesReceived = 0;
  private reconnectCount = 0;
  private errorFrameCount = 0;

  constructor(options: ArcusWsClientOptions) {
    super();
    this.url = options.url;
    this.logger = options.logger;
    this.WebSocketImpl = options.webSocketImpl ?? WebSocket;
    this.baseBackoffMs = options.baseBackoffMs ?? 500;
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.pingIntervalMs = options.pingIntervalMs ?? 20_000;
    this.silenceTimeoutMs = options.silenceTimeoutMs ?? 60_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.now = options.now ?? (() => Date.now());
  }

  /* ---------------------------------------------------------------- *
   * State
   * ---------------------------------------------------------------- */

  get connectionState(): ConnectionState {
    return this.state;
  }

  get isConnected(): boolean {
    return this.state === 'connected' && this.socket?.readyState === 1;
  }

  /** True only when every desired channel has delivered a snapshot. */
  get isReady(): boolean {
    return this.isConnected && this.desired.size > 0 && this.readyKeys.size >= this.desired.size;
  }

  /** Channels still awaiting a snapshot. Empty means fully ready. */
  get pendingSubscriptions(): SubscriptionSpec[] {
    return [...this.desired.entries()]
      .filter(([key]) => !this.readyKeys.has(key))
      .map(([, spec]) => spec);
  }

  /** Milliseconds since the last frame, or undefined if none received yet. */
  get msSinceLastFrame(): number | undefined {
    if (this.lastFrameAtMs === 0) return undefined;
    return this.now() - this.lastFrameAtMs;
  }

  get stats(): {
    state: ConnectionState;
    framesReceived: number;
    reconnectCount: number;
    errorFrameCount: number;
    desiredSubscriptions: number;
    readySubscriptions: number;
    msSinceLastFrame: number | undefined;
  } {
    return {
      state: this.state,
      framesReceived: this.framesReceived,
      reconnectCount: this.reconnectCount,
      errorFrameCount: this.errorFrameCount,
      desiredSubscriptions: this.desired.size,
      readySubscriptions: this.readyKeys.size,
      msSinceLastFrame: this.msSinceLastFrame,
    };
  }

  private setState(next: ConnectionState): void {
    if (this.state === next) return;
    const from = this.state;
    this.state = next;
    this.logger.info({ from, to: next }, 'websocket state changed');
    this.emit('stateChanged', { from, to: next });
  }

  /* ---------------------------------------------------------------- *
   * Connection lifecycle
   * ---------------------------------------------------------------- */

  /** Open the socket. Idempotent: a second call while connecting is a no-op. */
  connect(): void {
    if (this.socket && (this.socket.readyState === 0 || this.socket.readyState === 1)) return;
    this.closedByUs = false;
    this.setState(this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting');

    let socket: WebSocket;
    try {
      socket = new this.WebSocketImpl(this.url);
    } catch (error) {
      this.logger.error({ err: String(error) }, 'websocket construction failed');
      this.setState('failed');
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.on('open', () => this.handleOpen(socket));
    socket.on('message', (data: WebSocket.RawData) => this.handleMessage(data));
    socket.on('close', (code: number, reason: Buffer) => this.handleClose(code, reason));
    socket.on('error', (error: Error) => {
      // 'error' is always followed by 'close', so reconnection is handled there.
      this.logger.warn({ err: error.message }, 'websocket error');
    });
    socket.on('pong', () => {
      this.lastFrameAtMs = this.now();
    });
  }

  private handleOpen(socket: WebSocket): void {
    this.reconnectAttempt = 0;
    this.lastFrameAtMs = this.now();
    // Request ids must strictly increase PER CONNECTION, so reset here.
    this.requestIdCounter = 0;
    this.readyKeys.clear();
    this.setState('connected');
    this.emit('connected');
    this.logger.info({ url: this.url, subscriptions: this.desired.size }, 'websocket connected');

    // Replay every desired subscription. `readyKeys` was cleared, so readiness
    // must be re-established from fresh snapshots before trading resumes.
    for (const spec of this.desired.values()) this.sendSubscribe(spec);

    this.startHeartbeat(socket);
  }

  private startHeartbeat(socket: WebSocket): void {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => {
      if (socket.readyState !== 1) return;
      try {
        socket.ping();
        // Silence detection: a half-open TCP connection looks connected forever
        // without this, and a stale local book is worse than no book.
        const silence = this.msSinceLastFrame;
        if (silence !== undefined && silence > this.silenceTimeoutMs) {
          this.logger.warn({ silenceMs: silence }, 'websocket silent past threshold; forcing reconnect');
          this.setState('degraded');
          socket.terminate();
        }
      } catch (error) {
        this.logger.warn({ err: String(error) }, 'websocket ping failed');
      }
    }, this.pingIntervalMs);
    this.pingTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = undefined;
  }

  private handleClose(code: number, reason: Buffer): void {
    const reasonText = reason.toString() || '(no reason)';
    this.stopHeartbeat();
    this.socket = undefined;
    this.readyKeys.clear();

    // Fail every in-flight RPC. Leaving them pending would hang a caller that is
    // waiting on the reply — and one of those callers waits for a stop-order
    // confirmation, which must never block the trading loop indefinitely.
    for (const [, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(new Error(`websocket closed while awaiting ${req.method} (request id ${req.id})`));
    }
    this.pending.clear();

    const willReconnect = !this.closedByUs;
    this.logger.warn({ code, reason: reasonText, willReconnect }, 'websocket closed');
    this.emit('disconnected', { code, reason: reasonText, willReconnect });
    this.setState(this.closedByUs ? 'closed' : 'reconnecting');
    if (willReconnect) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closedByUs || this.reconnectTimer) return;
    this.reconnectAttempt += 1;
    this.reconnectCount += 1;
    const exp = Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** (this.reconnectAttempt - 1));
    // Full jitter avoids a fleet of bots reconnecting in lockstep.
    const delay = Math.round(exp * (0.5 + Math.random() * 0.5));
    this.logger.info({ attempt: this.reconnectAttempt, delayMs: delay }, 'scheduling websocket reconnect');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  /** Close deliberately. Suppresses reconnection. */
  close(): void {
    this.closedByUs = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.stopHeartbeat();
    this.socket?.close(1000, 'client shutdown');
    this.socket = undefined;
    this.setState('closed');
  }

  /**
   * Wait until every desired channel has delivered a snapshot.
   *
   * Used at startup and after a reconnect so the strategy never evaluates a
   * half-populated local view. Times out rather than hanging.
   */
  async waitForReady(timeoutMs = 30_000): Promise<boolean> {
    if (this.isReady) return true;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.off('snapshot', onSnapshot);
        this.off('stateChanged', onState);
        resolve(false);
      }, timeoutMs);
      const check = (): void => {
        if (this.isReady) {
          clearTimeout(timer);
          this.off('snapshot', onSnapshot);
          this.off('stateChanged', onState);
          resolve(true);
        }
      };
      const onSnapshot = (): void => check();
      const onState = (): void => check();
      this.on('snapshot', onSnapshot);
      this.on('stateChanged', onState);
    });
  }

  /* ---------------------------------------------------------------- *
   * Subscriptions
   * ---------------------------------------------------------------- */

  /**
   * Register a subscription and send it if connected.
   *
   * Re-subscribing to an existing key is a no-op apart from refreshing the
   * desired spec, which keeps reconnect replay idempotent.
   */
  subscribe(spec: SubscriptionSpec): void {
    const key = subscriptionKey(spec);
    const existed = this.desired.has(key);
    this.desired.set(key, spec);
    if (!existed) this.readyKeys.delete(key);
    if (this.isConnected) this.sendSubscribe(spec);
  }

  unsubscribe(spec: SubscriptionSpec): void {
    const key = subscriptionKey(spec);
    if (!this.desired.delete(key)) return;
    this.readyKeys.delete(key);
    if (!this.isConnected) return;
    const frame: Record<string, unknown> = { type: 'unsubscribe', channel: spec.channel };
    if (spec.id) frame.id = spec.id;
    if (spec.market) frame.market = spec.market;
    this.send(frame);
  }

  private sendSubscribe(spec: SubscriptionSpec): void {
    const frame: Record<string, unknown> = { type: 'subscribe', channel: spec.channel };
    if (spec.id) frame.id = spec.id;
    if (spec.snapshot === false) frame.snapshot = false;
    if (spec.nLevels !== undefined) frame.nLevels = spec.nLevels;
    if (spec.nRecentClosed !== undefined) frame.nRecentClosed = spec.nRecentClosed;
    if (spec.nFills !== undefined) frame.nFills = spec.nFills;
    if (spec.market) frame.market = spec.market;
    this.send(frame);
  }

  private send(frame: unknown): void {
    if (!this.socket || this.socket.readyState !== 1) {
      this.logger.warn({ frame: 'dropped' }, 'websocket send attempted while not open');
      return;
    }
    try {
      this.socket.send(JSON.stringify(frame));
    } catch (error) {
      this.logger.warn({ err: String(error) }, 'websocket send failed');
    }
  }

  /* ---------------------------------------------------------------- *
   * RPC
   * ---------------------------------------------------------------- */

  /**
   * Issue a `get`/`post` RPC over the socket.
   *
   * The id counter is per-connection and strictly increasing, as required. The
   * server responds by echoing the id; an `error` frame does NOT echo it, so
   * error frames are surfaced on the `error` event and the request is failed by
   * its own timeout rather than hanging forever.
   */
  async request(method: string, payload: unknown, type: 'get' | 'post' = 'post'): Promise<unknown> {
    if (!this.isConnected) throw new Error(`websocket not connected; cannot issue ${method}`);
    this.requestIdCounter += 1;
    const id = this.requestIdCounter;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`websocket request ${method} (id ${id}) timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { id, method, issuedAtMs: this.now(), resolve, reject, timer });
      this.send({ type, id, request: { type: method, payload } });
    });
  }

  /* ---------------------------------------------------------------- *
   * Frame dispatch
   * ---------------------------------------------------------------- */

  private handleMessage(data: WebSocket.RawData): void {
    this.lastFrameAtMs = this.now();
    this.framesReceived += 1;

    let parsed: unknown;
    const text = typeof data === 'string' ? data : data.toString();
    try {
      parsed = JSON.parse(text);
    } catch {
      this.logger.warn({ bytes: text.length }, 'websocket frame was not JSON');
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    const envelope = parsed as Record<string, unknown>;

    // RPC replies carry the client-chosen numeric id and are handled first,
    // because their envelope has no `type: 'subscribed'|'channel_data'` value.
    if (typeof envelope.id === 'number' && this.pending.has(envelope.id)) {
      const req = this.pending.get(envelope.id)!;
      this.pending.delete(envelope.id);
      clearTimeout(req.timer);
      req.resolve(envelope);
      return;
    }

    const frame = this.toFrame(envelope);
    switch (frame.type) {
      case 'subscribed':
      case 'channel_data': {
        const spec = this.matchSpec(frame);
        if (frame.contents !== undefined) {
          if (spec) {
            this.readyKeys.add(subscriptionKey(spec));
          }
          this.emit('snapshot', frame, spec ?? { channel: (frame.channel ?? 'unknown') as WsChannel });
        }
        this.emit('update', frame, spec ?? { channel: (frame.channel ?? 'unknown') as WsChannel });
        break;
      }
      case 'unsubscribed':
        break;
      case 'degraded':
        this.errorFrameCount += 1;
        this.logger.warn({ channel: frame.channel, market: frame.market }, 'websocket channel degraded');
        this.emit('degraded', frame);
        break;
      case 'connected':
        // Sent immediately on open, before any subscription is acknowledged.
        // Handled explicitly so it is not mistaken for malformed traffic.
        this.logger.debug({ connectionId: (frame.raw as { connection_id?: string }).connection_id }, 'websocket connected frame');
        break;
      case 'error':
        this.errorFrameCount += 1;
        // Error frames do not carry the request id, so this cannot be matched to a
        // specific pending call. Log the surface and let timeouts fail callers.
        this.logger.warn(
          { channel: frame.channel, message: extractErrorMessage(frame) },
          'websocket error frame',
        );
        this.emit('serverError', frame);
        break;
      default:
        break;
    }
  }

  private toFrame(envelope: Record<string, unknown>): ChannelFrame {
    return {
      type: envelope.type as ChannelFrame['type'],
      channel: typeof envelope.channel === 'string' ? envelope.channel : undefined,
      id: typeof envelope.id === 'string' ? envelope.id : undefined,
      accountIndex: typeof envelope.accountIndex === 'number' ? envelope.accountIndex : undefined,
      market: typeof envelope.market === 'string' ? envelope.market : undefined,
      sigFigs: typeof envelope.sigFigs === 'number' ? envelope.sigFigs : undefined,
      roundStep: typeof envelope.roundStep === 'number' ? envelope.roundStep : undefined,
      contents: envelope.contents,
      raw: envelope,
    };
  }

  /**
   * Match a frame back to the subscription that requested it.
   *
   * Address comparisons are case-insensitive because the server lowercases the
   * address in `id` regardless of how it was spelled on subscribe.
   */
  private matchSpec(frame: ChannelFrame): SubscriptionSpec | undefined {
    for (const spec of this.desired.values()) {
      if (spec.channel !== frame.channel) continue;
      if (spec.id) {
        if (!frame.id) continue;
        const isAccount = ACCOUNT_CHANNELS.includes(spec.channel);
        if (isAccount) {
          if (spec.id.toLowerCase() !== frame.id.toLowerCase()) continue;
        } else if (spec.id !== frame.id) {
          continue;
        }
      }
      if (spec.market && frame.market && spec.market !== frame.market) continue;
      return spec;
    }
    return undefined;
  }
}
