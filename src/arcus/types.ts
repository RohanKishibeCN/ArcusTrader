/**
 * Arcus wire types.
 *
 * DERIVED, not invented. Every field name and enum member here was taken from the
 * OpenAPI fragments in `docs/arcus/*.md`, reassembled by `tools/merge-openapi.py`
 * into `docs/arcus/arcus.openapi.merged.json` (32 operations, 89 schemas).
 * See `docs/API_CONTRACTS.md` for the audit trail and for what remains unconfirmed.
 *
 * Two conventions worth internalising before reading further:
 *
 *  1. Every money / price / size field is a DECIMAL STRING on the wire, never a
 *     JSON number. `"price": "50000.5"`. Parsing into `number` loses precision and
 *     is a correctness bug, so these stay `string` at the boundary and are only
 *     ever converted to Decimal.
 *  2. Timestamps are epoch MICROSECONDS except the signing timestamp (`ct`),
 *     which is epoch NANOSECONDS, and `nextFundingAt`, which is epoch SECONDS.
 *     Mixing these up silently produces orders that are rejected or mis-fire.
 */

import type { Decimal } from '../util/decimal';

/** Unsigned 16-bit market identifier. Map to a ticker via `GET /v1/markets`. */
export type MarketId = number;

/** Subaccount index, 0-9. Arcus scopes keys, orders and balances to (address, index). */
export type AccountIndex = number;

/** Epoch microseconds, as delivered on order/fill/candle reads. */
export type EpochMicros = number;

/** Epoch nanoseconds, used only for request signing. */
export type EpochNanos = bigint;

export type OrderSide = 'BUY' | 'SELL';

/** Engine-native side encoding used inside a signed payload. NOT the wire enum. */
export const SIGNED_SIDE = { BUY: 0, SELL: 1 } as const;
export type SignedSide = (typeof SIGNED_SIDE)[OrderSide];

export type OrderType = 'LIMIT' | 'MARKET';

/**
 * Time-in-force as ACCEPTED ON WRITES: GTT / IOC / FOK / ALO.
 *
 * ALO is "Add Liquidity Only" (post-only) — the engine rejects the order with
 * POST_ONLY_WOULD_CROSS if it would take. This is how maker entries are enforced.
 */
export type TimeInForce = 'GTT' | 'IOC' | 'FOK' | 'ALO';

/**
 * Time-in-force as REPORTED ON READS.
 *
 * Arcus reports resting orders as `GTC` — the legacy name for the same bucket —
 * so a naive `order.timeInForce === 'GTT'` check is always false for a live order.
 * Read paths must normalise through `normalizeTif()`.
 */
export type TimeInForceResponse = 'GTC' | 'GTT' | 'IOC' | 'FOK' | 'ALO';

/** Engine-native TIF encoding used inside a signed payload. */
export const SIGNED_TIF = { GTT: 0, FOK: 1, IOC: 2, ALO: 3 } as const;
export type SignedTif = (typeof SIGNED_TIF)[TimeInForce];

/** Signed-payload operation enum. */
export const SIGNED_OP = {
  PLACE: 1,
  CANCEL: 2,
  MODIFY: 3,
  PLACE_UNTRIGGERED: 4,
} as const;
export type SignedOp = (typeof SIGNED_OP)[keyof typeof SIGNED_OP];

export type TpslType = 'STOP_LOSS' | 'TAKE_PROFIT';
export type MarginMode = 'CROSS' | 'ISOLATED';
export type PositionSide = 'LONG' | 'SHORT';
export type LiquidityRole = 'MAKER' | 'TAKER';

/** Underlying asset class. This is what drives RWA vs crypto classification. */
export type MarketCategory = 'CRYPTO' | 'INDICES' | 'EQUITIES' | 'FOREX' | 'COMMODITIES';

/** Venue kind. Currently only PERPETUAL is listed. */
export type MarketType = 'PERPETUAL';

export type MarketStatus = 'ONLINE' | 'OFFLINE' | (string & {});

/**
 * Engine-authoritative order lifecycle position, stamped on every streaming
 * update. The local order state machine is driven off THIS field, not `status`.
 */
export type OrderState = 'OPEN' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'REJECTED';

/**
 * Broader, event-level status. Includes transient ACK states that are not
 * lifecycle positions of their own — see OrderState for the authoritative one.
 */
export type OrderStatus =
  | 'PENDING'
  | 'OPEN'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCELED'
  | 'MARGIN_CANCELED'
  | 'REJECTED'
  | 'UNTRIGGERED'
  | 'TPSL_PLACED'
  | 'TPSL_TRIGGERED'
  | 'TPSL_CANCELED'
  | 'LIQUIDATED'
  | 'ADL'
  | 'ACK'
  | 'CANCEL_ACKNOWLEDGED'
  | 'CANCEL_ALL_ACKNOWLEDGED'
  | 'CANCEL_PENDING'
  | 'ERROR';

/** Full engine rejection vocabulary. Includes SELF_TRADE and POST_ONLY_WOULD_CROSS. */
export type RejectionReason =
  | 'POST_ONLY_WOULD_CROSS'
  | 'SELF_TRADE'
  | 'UNDERCOLLATERALIZED'
  | 'COULD_NOT_FILL'
  | 'IOC_CANCELED'
  | 'FOK_FAILED'
  | 'REDUCE_ONLY_WOULD_INCREASE'
  | 'TOO_MANY_CLIENT_IDS'
  | 'DUPLICATE_CLIENT_ID'
  | 'POSITION_TPSL_ALREADY_EXISTS'
  | 'ENTRY_TPSL_CANNOT_BE_POSITION_TPSL'
  | 'ORDER_WILL_TAKE_LIQUIDITY_DURING_MARKET_HALT'
  | 'ORDER_NOT_FOUND_FOR_MODIFY'
  | 'MODIFY_CHANGED_IMMUTABLE_FIELD'
  | 'MODIFY_ZERO_SIZE'
  | 'PRICE_WILL_EXCEED_MAXIMUM_OUTSIDE_RTH_TRADING_BOUND'
  | 'MODIFY_WOULD_CROSS_OUTSIDE_RTH_TRADING_BOUNDARY'
  | 'FILL_WILL_EXCEED_TRADING_BOUND'
  | 'OPEN_INTEREST_CAP_EXCEEDED'
  | 'POSITION_SIZE_CAP_EXCEEDED'
  | 'MODIFY_TPSL_NOT_SUPPORTED'
  | 'MODIFY_SUPERSEDED_BY_CANCEL'
  | 'MODIFY_SIZE_ALREADY_FILLED'
  | 'ORDER_NOT_FOUND'
  | 'OPEN_ORDER_CAP_EXCEEDED'
  | 'EXPIRED';

/**
 * One price band of the placement grid.
 *
 * Semantics verified against the live `GET /v1/markets` response and the docs:
 *
 *   - `upToPrice` is an EXCLUSIVE upper bound for the band, in decimal USD, and is
 *     omitted for the unbounded top band.
 *   - `tick` is the minimum price increment accepted for prices in that band.
 *   - Bands ascend by `upToPrice`.
 *
 * Two DISTINCT rules apply, and conflating them is a real bug (the field is named
 * `tick`, not `tickSize`, and an earlier version of this file assumed the latter):
 *
 *   1. SIGNING always divides by the market's top-level `tickSize`, at every
 *      price. The tier ladder never changes the signed integer `p`.
 *   2. ACCEPTANCE additionally requires a limit price to be a multiple of its own
 *      band's `tick`, or the engine rejects it with
 *      "… is not a multiple of tick size … for its price tier".
 *
 * `tickSize` equals the base (first) tier, so a client that reads only `tickSize`
 * remains correct for prices in the base band.
 */
export interface TickTier {
  /** Exclusive upper bound in decimal USD; absent on the unbounded top band. */
  readonly upToPrice?: string;
  readonly tick: string;
}

/** Session window during which the BASE margin fractions apply. Often `null`. */
export type RegularTradingHours = Record<string, unknown> | null;

/**
 * `GET /v1/markets` -> `markets[]`.
 *
 * All numeric fields are decimal strings. `isOutsideRth` and
 * `offHoursInitialMarginFraction` are read from here rather than derived locally,
 * so the off-hours margin regime is never hardcoded.
 */
export interface MarketInfo {
  readonly marketDisplayName: string;
  readonly fullAssetName?: string;
  readonly marketId: MarketId;
  readonly status: MarketStatus;
  readonly baseAsset: string;
  readonly quoteAsset: string;
  /** Minimum price increment. Prices must be exact multiples. */
  readonly tickSize: string;
  /** Minimum size increment. Quantities must be exact multiples. */
  readonly stepSize: string;
  readonly tickTiers: readonly TickTier[];
  readonly minOrderNotional: string;
  readonly minOrderSize: string;
  readonly maxOrderSize: string;
  readonly oraclePrice?: string;
  readonly markPrice?: string;
  readonly lastTradePrice?: string;
  readonly fundingRate?: string;
  readonly nextFundingRate?: string;
  /** Epoch SECONDS (not microseconds). */
  readonly nextFundingAt?: number;
  readonly priceChange24h?: string;
  readonly volume24h?: string;
  readonly volume24hNotional?: string;
  readonly high24h?: string;
  readonly low24h?: string;
  readonly trades24h?: number;
  readonly openInterest?: string;
  readonly openInterestCapNotional?: string | null;
  readonly initialMarginFraction?: string;
  readonly maintenanceMarginFraction?: string;
  /** Initial margin the engine enforces while the underlying is closed. */
  readonly offHoursInitialMarginFraction?: string;
  readonly regularTradingHours?: RegularTradingHours;
  /**
   * Off-hours flag sourced from the exchange calendar. Read, never computed.
   *
   * `null` when the venue does not report a session for the market. A null is
   * treated as UNKNOWN and therefore blocks off-hours entry rather than assuming
   * the session is open — assuming "open" is how an off-hours order slips past the
   * rule that exists to prevent it.
   */
  readonly isOutsideRth: boolean | null;
  readonly currentSettlementPrice?: string | null;
  readonly upperTradingBound?: string;
  readonly lowerTradingBound?: string;
  readonly nextUpperTradingBound?: string;
  readonly nextLowerTradingBound?: string;
  readonly isUpperInExpansionZone?: boolean;
  readonly isLowerInExpansionZone?: boolean;
  readonly upperZoneEnteredAt?: number;
  readonly upperExpectedExpansionAt?: number;
  readonly lowerZoneEnteredAt?: number;
  readonly lowerExpectedExpansionAt?: number;
  readonly type: MarketType;
  readonly category: MarketCategory;
  readonly addedTimestamp?: number;
  readonly assetResolution?: string;
  readonly pythId?: string;
}

export interface MarketsResponse {
  readonly markets: readonly MarketInfo[];
}

export interface Candle {
  readonly marketDisplayName: string;
  readonly marketId: MarketId;
  readonly timeframe: string;
  /** Epoch microseconds of the bar open. */
  readonly openTime: EpochMicros;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volume: string;
  readonly takerBuyVolume: string;
  readonly notionalVolume: string;
  readonly takerBuyNotionalVolume: string;
  readonly tradeCount: number;
  /** True once the interval has closed. Indicators must not consume forming bars. */
  readonly isFinal: boolean;
}

export interface GetCandlesResponse {
  readonly candles: readonly Candle[];
  readonly [key: string]: unknown;
}

/** Supported candle intervals, from the `/v1/candles` `timeframe` enum. */
export const TIMEFRAMES = [
  '1m', '3m', '5m', '15m', '30m',
  '1h', '2h', '4h', '8h', '12h',
  '1d', '3d', '1w',
] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

/**
 * One side of the best bid/offer, as `GET /v1/bbo/{market}` returns it.
 *
 * Verified against the live endpoint: both sides are OBJECTS with named fields
 * (`{"bestBid":{"price":"83587","size":"0.16"}}`). This differs from the L2
 * orderbook, which uses positional tuples — conflating the two is an easy and
 * silent mistake, so they are separate types.
 */
export interface BBOLevel {
  readonly price: string;
  readonly size: string;
}

export interface BBO {
  readonly bestBid?: BBOLevel | null;
  readonly bestAsk?: BBOLevel | null;
  /** Per-market sequence number, useful for detecting a stale snapshot. */
  readonly lastSequenceId?: number;
  readonly globalSequenceId?: number;
  /** Epoch microseconds. The freshness signal for this quote. */
  readonly timestamp?: EpochMicros;
  readonly [key: string]: unknown;
}

/**
 * One price level of the L2 book.
 *
 * Verified against the live endpoint, which returns POSITIONAL TUPLES:
 *   "bids": [["83587", "0.16191699"], ["83586.9", "0.00010005"], ...]
 * i.e. `[price, size]` as decimal strings — NOT `{price, size}` objects.
 */
export type OrderbookLevel = readonly [price: string, size: string];

export interface OrderbookSnapshot {
  readonly bids: readonly OrderbookLevel[];
  readonly asks: readonly OrderbookLevel[];
  readonly lastSequenceId?: number;
  readonly globalSequenceId?: number;
  /** Epoch microseconds. */
  readonly timestamp?: EpochMicros;
  readonly [key: string]: unknown;
}

/** Convenience view of a tuple level. */
export interface NormalizedLevel {
  readonly price: Decimal;
  readonly size: Decimal;
}

export interface PriceEntry {
  readonly oraclePrice?: string;
  readonly markPrice?: string;
  readonly sequenceNumber?: number;
  readonly [key: string]: unknown;
}

export interface PricesResponse {
  /** Keyed by numeric marketId rendered as a string. */
  readonly prices: Record<string, PriceEntry>;
  readonly [key: string]: unknown;
}

export interface AccountPosition extends Position {
  readonly [key: string]: unknown;
}

/**
 * `GET /v1/affiliate/info` — the caller's referral/affiliate standing.
 *
 * SCHEMA NOTE: the endpoint takes `address` only, with NO `accountIndex` parameter.
 * Its volume figures are therefore WALLET-LEVEL and include every subaccount — unlike
 * the fee-tier volume credit, which the docs describe as per-subaccount ("its own
 * volume credit for fee tiering").
 *
 * Amounts arrive as integer "quote quantums" with 1e9 = $1.
 */
export interface AffiliateInfo {
  readonly address: string;
  /** Active referral code, or '' when never created / revoked. */
  readonly code: string;
  /** Affiliate's kickback rate, 0-5000 bps. */
  readonly kickbackBps: number;
  /** Affiliate tier used to pick the commission rate. */
  readonly tier: number;
  readonly totalCommissionUsd: Decimal;
  readonly pendingCommissionUsd: Decimal;
  readonly commission30dUsd: Decimal;
  /** Own notional fill volume, trailing 30 days. Includes all subaccounts. */
  readonly volume30dUsd: Decimal;
  readonly referredVolume30dUsd: Decimal;
  readonly referredVolumeAllTimeUsd: Decimal;
  readonly traderCount: number;
  readonly tradingFeeTier?:
    | { readonly level: number; readonly makerFeeBps?: Decimal; readonly takerFeeBps?: Decimal }
    | undefined;
}

export interface Account {
  readonly accountIndex: AccountIndex;
  readonly address: string;
  readonly netQuoteBalance: string;
  readonly equity: string;
  readonly freeCollateral: string;
  /** Lifetime net deposits. Does NOT reset when the day rolls over. */
  readonly netDeposits: string;
  readonly pendingDeposits?: string;
  readonly pendingWithdrawals?: string;
  /** Open positions keyed by marketId. */
  readonly positions: Record<string, AccountPosition>;
  readonly sequenceNumber?: number;
}

export interface Position {
  readonly address: string;
  readonly accountIndex: AccountIndex;
  readonly marketId: MarketId;
  readonly marketDisplayName: string;
  readonly side: PositionSide;
  /** SIGNED size: positive long, negative short. */
  readonly size: string;
  readonly averageEntryPrice: string;
  readonly cumulativeFunding?: Record<string, unknown>;
  readonly leverage: string;
  readonly marginMode: MarginMode;
  readonly borrowedCapital: string;
  readonly marginUsed: string;
  /** Signed notional at mark. */
  readonly positionValueNotional: string;
  readonly unrealizedPnl: string;
  readonly markPx: string;
  readonly sequenceNumber?: number;
}

export interface GetPositionsResponse {
  readonly positions: readonly Position[];
  readonly [key: string]: unknown;
}

export interface Order {
  readonly orderId: string;
  readonly clientId?: string;
  readonly address?: string;
  readonly accountIndex?: AccountIndex;
  readonly marketId: MarketId;
  readonly marketDisplayName: string;
  readonly side: OrderSide;
  readonly type?: OrderType;
  readonly status: OrderStatus;
  readonly price: string;
  readonly originalSize: string;
  readonly filledSize?: string;
  readonly remainingSize: string;
  readonly avgFillPrice?: string;
  readonly timeInForce?: TimeInForceResponse;
  /** Epoch microseconds, as a string. */
  readonly goodTilTime?: string;
  readonly reduceOnly?: boolean;
  readonly triggerPrice?: string;
  readonly tpslType?: TpslType;
  readonly isPositionTPSL?: boolean;
  readonly parentOrderId?: string;
  readonly rejectionReason?: RejectionReason;
  readonly cancelReason?: string;
  readonly state?: OrderState;
  readonly positionEffect?: string;
  readonly createdAt?: EpochMicros;
  readonly updatedAt: EpochMicros;
  readonly sequenceNumber?: number;
}

export interface GetOpenOrdersResponse {
  readonly orders: readonly Order[];
  readonly [key: string]: unknown;
}

export interface GetOrdersResponse {
  readonly orders: readonly Order[];
  readonly [key: string]: unknown;
}

export interface Fill {
  readonly tradeId: string;
  readonly orderId: string;
  readonly address?: string;
  readonly accountIndex?: AccountIndex;
  readonly marketId: MarketId;
  readonly marketDisplayName: string;
  readonly clientId?: string;
  readonly side: OrderSide;
  readonly originalSize: string;
  readonly size: string;
  readonly price: string;
  /** Fee amount, quote currency. */
  readonly fee: string;
  readonly closedPnl?: string;
  readonly role: LiquidityRole;
  readonly remainingSize?: string;
  readonly positionEffect?: string;
  /** Epoch microseconds. */
  readonly createdAt: EpochMicros;
  readonly sequenceNumber?: number;
  readonly liquidation?: Record<string, unknown>;
}

export interface GetFillsResponse {
  readonly fills: readonly Fill[];
  readonly [key: string]: unknown;
}

export interface FundingPayment {
  readonly marketId: MarketId;
  readonly marketDisplayName?: string;
  readonly payment: string;
  /** Epoch microseconds. */
  readonly time: EpochMicros;
  readonly rate?: string;
  readonly [key: string]: unknown;
}

export interface GetFundingPaymentsResponse {
  readonly funding: readonly FundingPayment[];
  readonly [key: string]: unknown;
}

export interface MarketFundingRate {
  readonly marketId: MarketId;
  readonly marketDisplayName?: string;
  /** Live field name (verified). */
  readonly fundingRate?: string;
  /** Spec field name, accepted as an alternative. */
  readonly rate?: string;
  /** Epoch microseconds. */
  readonly time: EpochMicros;
  readonly [key: string]: unknown;
}

export interface GetMarketFundingRatesResponse {
  readonly fundingRates: readonly MarketFundingRate[];
  readonly [key: string]: unknown;
}

export type AccountTransferUpdateType =
  | 'DEPOSIT'
  | 'WITHDRAWAL'
  | 'INTERNAL_TRANSFER'
  | 'SELF_ACCOUNT_TRANSFER'
  | 'REFERRAL_CLAIM';

export type AccountTransferUpdateStatus = string;

/**
 * A deposit / withdrawal / transfer event.
 *
 * Deposits must never reset the daily loss accumulator, so the ledger that
 * consumes these keeps cash-flow accounting separate from trading PnL.
 */
export interface AccountTransferUpdate {
  readonly type: AccountTransferUpdateType;
  readonly status: AccountTransferUpdateStatus;
  readonly amount: string;
  readonly accountIndex: AccountIndex;
  readonly time: EpochMicros;
  readonly txHash?: string;
  readonly [key: string]: unknown;
}

export interface GetAccountTransferUpdatesResponse {
  readonly transfers: readonly AccountTransferUpdate[];
  readonly [key: string]: unknown;
}

/** Per-subaccount trading pool state. `remaining` reaching ~0 must block new writes. */
export interface RateLimitPool {
  readonly capacity: number;
  readonly remaining: number;
  readonly refillRatePerSecond?: number;
  readonly [key: string]: unknown;
}

export interface GetRateLimitResponse {
  readonly order?: RateLimitPool;
  readonly cancel?: RateLimitPool;
  readonly [key: string]: unknown;
}

export interface FeeTierInfo {
  readonly makerFeeRate?: string;
  readonly takerFeeRate?: string;
  readonly [key: string]: unknown;
}

/**
 * One fee tier.
 *
 * VERIFIED LIVE from `GET /v1/feetiers`:
 *   {"level":0,"name":"Base","volume_threshold":0,"maker_fee_ppm":0,"taker_fee_ppm":225}
 *
 * Fees are in PARTS PER MILLION (1 bp = 100 ppm). The `*_bps` variants are the
 * spec's naming and are accepted for compatibility. A maker fee can be NEGATIVE
 * (the VIP tiers pay a rebate), so it must never be clamped at zero.
 */
export interface FeeTierConfigRow {
  readonly level?: number;
  readonly name?: string;
  readonly volume_threshold?: string | number;
  readonly maker_fee_ppm?: string | number;
  readonly taker_fee_ppm?: string | number;
  readonly tierLevel?: number;
  readonly makerFeeBps?: string;
  readonly takerFeeBps?: string;
  readonly volumeThreshold?: string;
  readonly [key: string]: unknown;
}

export interface FeeTiersResponse {
  readonly feeTiers: readonly FeeTierConfigRow[];
  readonly [key: string]: unknown;
}

export interface Trade {
  readonly tradeId: string;
  readonly marketId: MarketId;
  readonly marketDisplayName?: string;
  readonly price: string;
  readonly size: string;
  readonly side?: OrderSide;
  /** Epoch microseconds. Live field name (verified); `createdAt` also accepted. */
  readonly timestamp?: EpochMicros;
  readonly createdAt?: EpochMicros;
  readonly makerOrderId?: string;
  readonly takerOrderId?: string;
  readonly sequenceNumber?: number;
  readonly [key: string]: unknown;
}

export interface GetTradesResponse {
  readonly trades: readonly Trade[];
  readonly [key: string]: unknown;
}

export interface TimeResponse {
  /** Server wall-clock time in Unix NANOSECONDS, as a string. */
  readonly time: string;
  readonly [key: string]: unknown;
}

export interface LeverageEntry {
  readonly marketId: MarketId;
  readonly leverage: string;
  readonly marginMode: MarginMode;
  readonly [key: string]: unknown;
}

export interface GetLeveragesResponse {
  readonly leverages: readonly LeverageEntry[];
  readonly [key: string]: unknown;
}

/* ------------------------------------------------------------------ *
 * Write path
 * ------------------------------------------------------------------ */

/**
 * `POST /v1/placeOrder` body.
 *
 * `timestamp` is Unix NANOSECONDS and must equal the `ct` inside the signed
 * payload and the `X-Timestamp` header. It is typed as a DECIMAL STRING because a
 * nanosecond epoch (~1.79e18) exceeds `Number.MAX_SAFE_INTEGER`, so a JSON number
 * would not survive serialisation intact. `goodTilTime` here is epoch
 * MICROSECONDS, which the signer multiplies by 1000 to get the signed `g`.
 */
export interface PlaceOrderRequest {
  readonly address: string;
  readonly marketId: MarketId;
  readonly accountIndex: AccountIndex;
  readonly orderSide: OrderSide;
  readonly orderType: OrderType;
  /** Decimal string in base-asset units. */
  readonly quantity: string;
  /** Decimal string in quote units. Regarded as a protective bound for MARKET. */
  readonly price: string;
  readonly timeInForce: TimeInForce;
  /** Epoch microseconds. Required on every order, including IOC/FOK. */
  readonly goodTilTime: string;
  readonly stopPrice?: string;
  readonly tpslType?: TpslType;
  readonly isPositionTPSL?: boolean;
  readonly parentOrderId?: string;
  readonly clientId?: string;
  readonly reduceOnly?: boolean;
  /** Epoch nanoseconds, as a decimal string. */
  readonly timestamp: string;
}

export interface CancelOrderRequest {
  readonly address: string;
  readonly accountIndex: AccountIndex;
  readonly marketId: MarketId;
  /** Exactly one of orderId / clientId. */
  readonly kind: 'orderId' | 'clientId';
  readonly orderId?: string;
  readonly clientId?: string;
  /** Epoch nanoseconds, as a decimal string. */
  readonly timestamp: string;
}

export interface OrderResponse {
  readonly address: string;
  readonly accountIndex: AccountIndex;
  readonly orderId: string;
  readonly marketId: MarketId;
  readonly marketDisplayName: string;
  readonly side: OrderSide;
  readonly quantity: string;
  readonly price: string;
  readonly status: OrderStatus;
  readonly createdAt: EpochMicros;
  readonly clientId?: string;
  readonly updatedAt?: EpochMicros;
  readonly remainingSize?: string;
  readonly filledSize?: string;
  readonly rejectionReason?: RejectionReason;
  readonly [key: string]: unknown;
}

/* ------------------------------------------------------------------ *
 * Normalisation helpers
 * ------------------------------------------------------------------ */

/**
 * Map a read-side TIF onto the write-side vocabulary.
 *
 * Arcus reports resting GTT orders as `GTC`. Treating `GTC` as unknown would make
 * a live resting entry order look unrecognised to reconciliation, which
 * fail-closes the system, so this mapping is load-bearing rather than cosmetic.
 */
export function normalizeTif(tif: TimeInForceResponse | undefined): TimeInForce | undefined {
  if (!tif) return undefined;
  if (tif === 'GTC') return 'GTT';
  return tif;
}

/** True when the engine considers the order no longer live. */
export function isTerminalOrderState(state: OrderState | undefined): boolean {
  return state === 'FILLED' || state === 'CANCELED' || state === 'REJECTED';
}

/** True when the order still rests on the book and could still fill. */
export function isLiveOrderState(state: OrderState | undefined): boolean {
  return state === 'OPEN' || state === 'PARTIALLY_FILLED';
}

/** Markets whose underlying trades on an exchange calendar (equities/indices/commodities). */
export function isRwaCategory(category: MarketCategory): boolean {
  return category !== 'CRYPTO';
}
