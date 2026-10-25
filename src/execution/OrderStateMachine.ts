/**
 * Local order state machine.
 *
 * The brief lists a required order-state vocabulary:
 *   NEW, ACKNOWLEDGED, PARTIALLY_FILLED, FILLED, CANCEL_REQUESTED, CANCELED,
 *   REJECTED, EXPIRED, UNKNOWN_RECONCILE_REQUIRED
 *
 * Those are LOCAL states. The venue reports its own two overlapping vocabularies:
 *
 *   - `order.status` — a wide, event-flavoured enum that includes transient ACKs
 *     (`ACK`, `CANCEL_PENDING`, `PENDING`, `ERROR`) and TPSL-specific values.
 *   - `order.state`  — the engine-authoritative lifecycle position, documented as
 *     "stamped on every streaming update" with exactly five values:
 *     OPEN | PARTIALLY_FILLED | FILLED | CANCELED | REJECTED.
 *
 * Mapping is driven off `state` where present, and falls back to `status` only
 * for the ACK-shaped frames that arrive before the engine has spoken. This
 * matters because `status` alone cannot distinguish "cancel acknowledged" from
 * "canceled", and treating an acknowledgement as terminal would let the system
 * believe an entry order is dead while it still rests on the book.
 *
 * Anything unrecognised becomes UNKNOWN_RECONCILE_REQUIRED, which the runtime
 * treats as drift and therefore blocks new entries.
 */

import type { Order, OrderState, OrderStatus } from '../arcus/types';
import { normalizeTif } from '../arcus/types';

/** Local lifecycle state. */
export type LocalOrderState =
  | 'NEW'
  | 'ACKNOWLEDGED'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCEL_REQUESTED'
  | 'CANCELED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'UNKNOWN_RECONCILE_REQUIRED';

/** Is this local state still capable of producing a fill? */
export function isLocalLive(state: LocalOrderState): boolean {
  return (
    state === 'NEW' ||
    state === 'ACKNOWLEDGED' ||
    state === 'PARTIALLY_FILLED' ||
    state === 'CANCEL_REQUESTED' ||
    state === 'UNKNOWN_RECONCILE_REQUIRED'
  );
}

/** Is this local state terminal? */
export function isLocalTerminal(state: LocalOrderState): boolean {
  return state === 'FILLED' || state === 'CANCELED' || state === 'REJECTED' || state === 'EXPIRED';
}

/** What the order was created for. Drives kill-switch and exit behaviour. */
export type OrderPurpose = 'entry' | 'stop' | 'take_profit' | 'trailing_stop' | 'emergency_exit';

export interface LocalOrder {
  /** Stable local key. Prefers clientId, which we always set on entries. */
  readonly key: string;
  readonly clientId?: string;
  /** Venue order id, once known. */
  readonly orderId?: string;
  readonly marketId: number;
  readonly symbol: string;
  readonly purpose: OrderPurpose;
  /** Entry orders are the only kind that can increase exposure. */
  readonly reduceOnly: boolean;
  readonly side: 'BUY' | 'SELL';
  state: LocalOrderState;
  /** Last venue status seen, retained for diagnostics. */
  readonly lastVenueStatus?: OrderStatus;
  readonly lastVenueState?: OrderState;
  readonly price?: string;
  readonly triggerPrice?: string;
  quantity: string;
  filledQuantity: string;
  remainingQuantity: string;
  avgFillPrice?: string;
  readonly createdAtMs: number;
  updatedAtMs: number;
  rejectionReason?: string;
  cancelReason?: string;
  /** Number of times a cancel has been requested; >1 means we retried. */
  cancelAttempts: number;
  /** Time-in-force as reported (read paths say GTC for resting GTT orders). */
  readonly timeInForce?: string;
}

/** A single state transition, recorded for the audit trail. */
export interface OrderTransition {
  readonly at: number;
  readonly from: LocalOrderState;
  readonly to: LocalOrderState;
  readonly reason: string;
  readonly venueStatus?: string;
}

export class OrderStateMachine {
  private readonly orders = new Map<string, LocalOrder>();
  private readonly transitions: OrderTransition[] = [];
  private readonly now: () => number;

  constructor(options?: { now?: () => number }) {
    this.now = options?.now ?? (() => Date.now());
  }

  /* ---------------------------------------------------------------- *
   * Creation
   * ---------------------------------------------------------------- */

  /**
   * Record a locally-initiated order.
   *
   * Starts at NEW: the order exists in our intent but the venue has not
   * acknowledged it. ACK comes from the REST 202 or the `orders` channel.
   */
  create(input: {
    key: string;
    clientId?: string;
    marketId: number;
    symbol: string;
    purpose: OrderPurpose;
    reduceOnly: boolean;
    side: 'BUY' | 'SELL';
    quantity: string;
    price?: string;
    triggerPrice?: string;
  }): LocalOrder {
    const existing = this.orders.get(input.key);
    if (existing) return existing;
    const order: LocalOrder = {
      key: input.key,
      ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
      marketId: input.marketId,
      symbol: input.symbol,
      purpose: input.purpose,
      reduceOnly: input.reduceOnly,
      side: input.side,
      state: 'NEW',
      quantity: input.quantity,
      filledQuantity: '0',
      remainingQuantity: input.quantity,
      createdAtMs: this.now(),
      updatedAtMs: this.now(),
      cancelAttempts: 0,
      ...(input.price !== undefined ? { price: input.price } : {}),
      ...(input.triggerPrice !== undefined ? { triggerPrice: input.triggerPrice } : {}),
    };
    this.orders.set(input.key, order);
    this.record('NEW', 'NEW', 'created locally');
    return order;
  }

  /** Attach the venue order id once known. */
  attachOrderId(key: string, orderId: string): void {
    const order = this.orders.get(key);
    if (!order) return;
    // LocalOrder fields are readonly for identity; replace the entry instead.
    this.orders.set(key, { ...order, orderId, updatedAtMs: this.now() });
  }

  markCancelRequested(key: string): void {
    const order = this.orders.get(key);
    if (!order) return;
    if (isLocalTerminal(order.state)) return;
    order.cancelAttempts += 1;
    this.transition(key, 'CANCEL_REQUESTED', 'cancel requested locally');
  }

  /** Record a terminal failure such as a signing or transport error. */
  markLocalFailure(key: string, reason: string): void {
    this.transition(key, 'REJECTED', reason);
    const order = this.orders.get(key);
    if (order) order.rejectionReason = reason;
  }

  /* ---------------------------------------------------------------- *
   * Venue reconciliation
   * ---------------------------------------------------------------- */

  /**
   * Apply a venue order snapshot.
   *
   * Returns the transition when the state actually changed, so callers can react
   * to fills exactly once rather than on every repeated update.
   */
  applyVenueOrder(order: Order): OrderTransition | undefined {
    const key = this.keyForVenueOrder(order);
    const local = this.orders.get(key);
    if (!local) {
      // An order we did not create. This is drift: adopt it so reconciliation can
      // see it, and mark it as needing reconciliation rather than ignoring it.
      const adopted: LocalOrder = {
        key,
        ...(order.clientId !== undefined ? { clientId: order.clientId } : {}),
        orderId: order.orderId,
        marketId: order.marketId,
        symbol: order.marketDisplayName,
        purpose: order.reduceOnly ? 'stop' : 'entry',
        reduceOnly: order.reduceOnly ?? false,
        side: order.side,
        state: 'UNKNOWN_RECONCILE_REQUIRED',
        quantity: order.originalSize,
        filledQuantity: order.filledSize ?? '0',
        remainingQuantity: order.remainingSize,
        createdAtMs: order.createdAt ?? this.now(),
        updatedAtMs: this.now(),
        cancelAttempts: 0,
        ...(order.price !== undefined ? { price: order.price } : {}),
        ...(normalizeTif(order.timeInForce) !== undefined
          ? { timeInForce: normalizeTif(order.timeInForce) }
          : {}),
      };
      this.orders.set(key, adopted);
      this.record('UNKNOWN_RECONCILE_REQUIRED', 'UNKNOWN_RECONCILE_REQUIRED', 'adopted unknown venue order');
      return undefined;
    }

    const next = mapVenueOrderToLocal(order, local.state);
    const filled = order.filledSize ?? local.filledQuantity;
    const remaining = order.remainingSize;
    const updated: LocalOrder = {
      ...local,
      state: next,
      quantity: order.originalSize,
      filledQuantity: filled,
      remainingQuantity: remaining,
      updatedAtMs: this.now(),
      ...(order.avgFillPrice !== undefined ? { avgFillPrice: order.avgFillPrice } : {}),
      ...(order.rejectionReason !== undefined ? { rejectionReason: order.rejectionReason } : {}),
      ...(order.cancelReason !== undefined ? { cancelReason: order.cancelReason } : {}),
      lastVenueStatus: order.status,
      ...(order.state !== undefined ? { lastVenueState: order.state } : {}),
    };
    this.orders.set(key, updated);

    if (next !== local.state) {
      return this.record(
        local.state,
        next,
        `venue status=${order.status}${order.rejectionReason ? ` reason=${order.rejectionReason}` : ''}`,
        order.status,
      );
    }
    return undefined;
  }

  private keyForVenueOrder(order: Order): string {
    return order.clientId ?? order.orderId;
  }

  private transition(key: string, to: LocalOrderState, reason: string): OrderTransition | undefined {
    const order = this.orders.get(key);
    if (!order) return undefined;
    const from = order.state;
    if (from === to) return undefined;
    order.state = to;
    order.updatedAtMs = this.now();
    return this.record(from, to, reason);
  }

  private record(
    from: LocalOrderState,
    to: LocalOrderState,
    reason: string,
    venueStatus?: string,
  ): OrderTransition {
    const transition: OrderTransition = {
      at: this.now(),
      from,
      to,
      reason,
      ...(venueStatus !== undefined ? { venueStatus } : {}),
    };
    this.transitions.push(transition);
    return transition;
  }

  /* ---------------------------------------------------------------- *
   * Queries
   * ---------------------------------------------------------------- */

  get(key: string): LocalOrder | undefined {
    return this.orders.get(key);
  }

  getByOrderId(orderId: string): LocalOrder | undefined {
    for (const order of this.orders.values()) {
      if (order.orderId === orderId) return order;
    }
    return undefined;
  }

  all(): readonly LocalOrder[] {
    return [...this.orders.values()];
  }

  /** Orders that can still fill. These are what reconciliation compares. */
  liveOrders(): readonly LocalOrder[] {
    return this.all().filter((o) => isLocalLive(o.state));
  }

  /** Working ENTRY orders. The kill switch cancels exactly these. */
  workingEntryOrders(): readonly LocalOrder[] {
    return this.liveOrders().filter((o) => o.purpose === 'entry');
  }

  /** Protective orders for a market, used for the "stop is missing" check. */
  protectiveOrders(marketId: number): readonly LocalOrder[] {
    return this.liveOrders().filter(
      (o) => o.marketId === marketId && (o.purpose === 'stop' || o.purpose === 'take_profit' || o.purpose === 'trailing_stop'),
    );
  }

  /** Orders the system could not classify. Non-empty means drift. */
  unknownOrders(): readonly LocalOrder[] {
    return this.all().filter((o) => o.state === 'UNKNOWN_RECONCILE_REQUIRED');
  }

  get transitionLog(): readonly OrderTransition[] {
    return this.transitions;
  }

  clearTransitions(): void {
    this.transitions.length = 0;
  }
}

/**
 * Map a venue order onto the local lifecycle.
 *
 * `state` wins when present because it is engine-authoritative. `status` is only
 * consulted for frames that arrive before the engine has stamped a state, which
 * is exactly the ACK family.
 */
export function mapVenueOrderToLocal(order: Order, current: LocalOrderState): LocalOrderState {
  switch (order.state) {
    case 'FILLED':
      return 'FILLED';
    case 'CANCELED':
      return 'CANCELED';
    case 'REJECTED':
      return 'REJECTED';
    case 'PARTIALLY_FILLED':
      return 'PARTIALLY_FILLED';
    case 'OPEN':
      // A cancel we requested that has not yet been confirmed must not be
      // downgraded back to ACKNOWLEDGED, or we would re-send cancels forever.
      return current === 'CANCEL_REQUESTED' ? 'CANCEL_REQUESTED' : 'ACKNOWLEDGED';
    default:
      break;
  }

  switch (order.status) {
    case 'ACK':
    case 'PENDING':
      return current === 'NEW' ? 'ACKNOWLEDGED' : current;
    case 'OPEN':
      return current === 'CANCEL_REQUESTED' ? 'CANCEL_REQUESTED' : 'ACKNOWLEDGED';
    case 'PARTIALLY_FILLED':
      return 'PARTIALLY_FILLED';
    case 'FILLED':
    case 'TPSL_TRIGGERED':
    case 'LIQUIDATED':
    case 'ADL':
      return 'FILLED';
    case 'CANCELED':
    case 'MARGIN_CANCELED':
    case 'TPSL_CANCELED':
      return 'CANCELED';
    case 'CANCEL_ACKNOWLEDGED':
    case 'CANCEL_ALL_ACKNOWLEDGED':
    case 'CANCEL_PENDING':
      return 'CANCEL_REQUESTED';
    case 'REJECTED':
    case 'ERROR':
      return 'REJECTED';
    // NOTE: the wire `status` enum has no EXPIRED member (it appears only in
    // RejectionReason), so an expiry reaches us as status=REJECTED with
    // rejectionReason=EXPIRED. `EXPIRED` is therefore produced by the local
    // expiry path, not by this mapper.
    case 'UNTRIGGERED':
    case 'TPSL_PLACED':
      // A resting stop/TP leg: live, but not yet able to fill.
      return 'ACKNOWLEDGED';
    default:
      return 'UNKNOWN_RECONCILE_REQUIRED';
  }
}

/** Human-readable summary used in the daily report. */
export function summariseOrders(orders: readonly LocalOrder[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const order of orders) counts[order.state] = (counts[order.state] ?? 0) + 1;
  return counts;
}
