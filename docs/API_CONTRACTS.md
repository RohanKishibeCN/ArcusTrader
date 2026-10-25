# Arcus integration research — findings and confirmations

Status: **research complete for the paths this system uses**.
Snapshot date: see `docs/arcus/manifest.json` (`fetchedAt`).
Method: `node tools/fetch-arcus-docs.mjs && python3 tools/merge-openapi.py`.
Sources: `docs/arcus/` (official docs, fetched verbatim).

This file records what was verified against upstream, and what remains unconfirmed.
Nothing here is inferred from memory.

---

## 1. The brief's endpoint list does not match the live docs

The task brief listed paths such as `/api-reference/public/get-markets`,
`/api-reference/public/get-funding-rates`, `/api-reference/public/get-open-orders`.
**Those names are not the current doc URLs.** The live sitemap
(`https://docs.arcus.xyz/sitemap.xml`) uses different slugs, e.g.
`/api-reference/market-data/markets` for the `markets` WebSocket channel.

Per the brief's own instruction ("如果某个 endpoint 名称或字段与上述路径不一致：以 Arcus
当前文档实际页面为准"), the live docs win. The mapping below is what this codebase
actually uses.

### Brief path → actual live path

| Brief said | Live path (used here) |
| --- | --- |
| `/guides/rest-trading` | `/guides/rest-trading` ✅ same |
| `/api-reference/authentication` | `/api-reference/authentication` ✅ same |
| `/api-reference/rate-limits` | `/api-reference/rate-limits` ✅ same |
| `/concepts/perpetuals/order-types` | `/concepts/perpetuals/order-types` ✅ same |
| `/concepts/perpetuals/margin` | `/concepts/perpetuals/margin` ✅ same |
| `/concepts/perpetuals/margin-modes` | `/concepts/perpetuals/margin-modes` ✅ same |
| `/concepts/perpetuals/liquidations` | `/concepts/perpetuals/liquidations` ✅ same |
| `/api-reference/public/get-markets` | `/api-reference/public/get-markets` (page exists) — REST op is `GET /v1/markets` |
| `/api-reference/public/get-ohlcv-candles` | page exists — REST op is `GET /v1/candles` |
| `/api-reference/public/get-bbo` | **page is `/api-reference/public/get-best-bid-offer-bbo`** — op `GET /v1/bbo/{market}` |
| `/api-reference/public/get-l2-orderbook-snapshot` | page exists — op `GET /v1/l2OrderBook/{market}` |
| `/api-reference/public/get-funding-rates` | **page is `/api-reference/public/get-market-funding-rates`** — op `GET /v1/fundingRates` |
| `/api-reference/public/get-positions` | page exists — op `GET /v1/positions` |
| `/api-reference/public/get-account` | page exists — op `GET /v1/account` |
| `/api-reference/public/get-fills` | page exists — op `GET /v1/fills` |
| `/api-reference/public/get-open-orders` | page exists — op `GET /v1/openOrders` |
| `/api-reference/websocket` | `/api-reference/websocket` ✅ same |

---

## 2. Verified REST endpoint inventory (32 operations)

Extracted from the OpenAPI fragments embedded in each doc page — see
`docs/arcus/arcus.openapi.merged.json`.

### Public reads (no API key)

| Method | Path | Weight | Notes |
| --- | --- | --- | --- |
| GET | `/health` | 0 | liveness only |
| GET | `/v1/time` | 1 | server time, Unix **nanoseconds** |
| GET | `/v1/markets` | 20 | optional `?market=` |
| GET | `/v1/prices` | 20 | oracle/mark + sequence per market, keyed by marketId string |
| GET | `/v1/mids` | 2 | |
| GET | `/v1/bbo/{market}` | 2 | path param, not query |
| GET | `/v1/l2OrderBook/{market}` | 2 | path param |
| GET | `/v1/candles` | 20 | `market`, `timeframe`, `to` **required** (µs) |
| GET | `/v1/trades` | 20 | recent public trades |
| GET | `/v1/feetiers` | 2 | fee tier table |
| GET | `/v1/fundingRates` | 20 | historical funding rates |
| GET | `/v1/account` | 2 | `?address=&accountIndex=` |
| GET | `/v1/positions` | 2 | `?address=` |
| GET | `/v1/openOrders` | 20 | |
| GET | `/v1/orders` | 20 | order history |
| GET | `/v1/order/{orderId}` | 2 | requires `address` |
| GET | `/v1/fills` | 20 | |
| GET | `/v1/funding` | 20 | funding **payments** for the account |
| GET | `/v1/accountTransferUpdates` | 20 | deposits/withdrawals/transfers |
| GET | `/v1/account/stats` | 2 | |
| GET | `/v1/portfolio` | 20 | |
| GET | `/v1/leverages` | 2 | leverage + margin mode across markets |
| GET | `/v1/rateLimit` | 2 | both per-subaccount pools |

### Signed writes

| Method | Path | Weight | Signing scheme |
| --- | --- | --- | --- |
| POST | `/v1/placeOrder` | 0 (pool) | Scheme 1, `op=1` |
| POST | `/v1/cancelOrder` | 0 (pool) | Scheme 1, `op=2` |
| POST | `/v1/modifyOrder` | 0 (pool) | Scheme 1, `op=3` |
| POST | `/v1/cancelAllOrders` | 0 (pool; charges **1000** to the cancel pool) | Scheme 2 |
| POST | `/v1/setLeverage` | 125 | Scheme 2 |
| POST | `/v1/adjustIsolatedMargin` | — | Scheme 2 |
| POST | `/v1/scheduleCancel` | — | dead man's switch |
| POST | `/v1/withdraw` | 125 | **not used** by this system |
| POST | `/v1/transfer` | 125 | **not used** by this system |

> This system never calls `/v1/withdraw` or `/v1/transfer`. They are documented
> for completeness only; `ALLOW_AUTO_WITHDRAW=false` is enforced in code.

---

## 3. Signing — verified against the official reference implementation

From `/api-reference/authentication` and the runnable code in
`/guides/rest-trading` § Step 3.

### Scheme 1 (typed payload) — `placeOrder`, `cancelOrder`, `modifyOrder`

`signature = ed25519_hex( canonical_payload )` where the message is **the payload
itself**, UTF-8, keys sorted ascending, no whitespace, no prefix.

```
placeOrder   {"ad":"0x…","ai":N,"c":"…","ct":N,"g":N,"m":N,"op":1,"p":N,"q":N,"r":0|1,"s":N,"t":N,"v":1}
cancelOrder  {"ad":"0x…","ai":N,"c":"…","ct":N,"id":"…","m":N,"op":2,"v":1}
modifyOrder  {"ad":"0x…","ai":N,"c":"…","ct":N,"g":N,"id":"…","m":N,"op":3,"p":N,"q":N,"r":0|1,"s":N,"t":N,"v":1}
```

Verified field semantics:

- `ad` — master Ethereum address, **lowercased** (the only case-folded field).
- `ai` — account (subaccount) index, 0–9.
- `c` — client id, **omitted entirely when empty**. Charset `[A-Za-z0-9_-]`, max 36.
  Signed byte-for-byte verbatim, so a mixed-case clientId must be sent in the same case.
- `ct` — client timestamp, Unix **nanoseconds** (integer). Must equal the
  `X-Timestamp` header. Millisecond/second values → 401.
- `g` — `goodTilTime` in **nanoseconds** = request's microsecond `goodTilTime` × 1000.
  **Required on every order**, including IOC/FOK. Must be ≥ 1 month ahead.
- `p` — price in integer **ticks** = `price / market.tickSize`.
- `q` — quantity in integer **quantums** = `size / market.stepSize`.
- `r` — reduce-only as integer `0`/`1`, **not** a boolean.
- `s` — side: `0` = buy, `1` = sell.
- `t` — TIF: `0` = GTT, `1` = FOK, `2` = IOC, `3` = ALO.
- `v` — payload version, currently `1`.
- `op` — `1` place, `2` cancel, `3` modify, `4` untriggered TPSL.

For `cancelOrder`, exactly one of `id` (server order id) or `c` (client id) — omitted
when cancelling by the other. For `modifyOrder`, `id` is always required, and
`g`/`r`/`s`/`t` **echo the resting order's immutable attributes**; passing a new `g`
performs a cancel-replace with a fresh expiry.

> Confirmed by direct probe: `POST https://api.testnet.arcus.xyz/v1/placeOrder`
> with `X-API-Key` / `X-Timestamp` / `X-Signature` headers and a full body
> validates the **body** first (`{"error":"address is required"}` with an empty
> body), i.e. the gateway returns business validation errors before auth failures.

### Scheme 2 (legacy) — everything else

```
signature = ed25519_hex( timestamp + action + canonical_json(body) )
```

- `timestamp` is the same nanosecond value as the `X-Timestamp` header.
- `action` is the camelCase **final path segment** (`/v1/cancelAllOrders` → `cancelAllOrders`).
- Concatenated with **no delimiters**.
- `canonical_json` = sorted keys, no whitespace.
- A signed GET has no body, so the message is just `timestamp + action`.
- Over WebSocket, `action` is the request `type`.

### Headers

| Header | Value |
| --- | --- |
| `X-API-Key` | API key = hex-encoded Ed25519 **public** key (64 chars) |
| `X-Timestamp` | Unix **nanoseconds**, decimal string, within ±30,000 ms of server clock |
| `X-Signature` | lowercase hex Ed25519 signature (128 chars) |

### Key encoding

The API signing key is the **32-byte raw Ed25519 seed** (hex), as produced by
`openssl genpkey -algorithm ed25519` → `pkey -pubout -outform DER | tail -c 32`.
Node's `crypto.createPrivateKey` **cannot** import a bare seed via JWK without the
`x` (public) member, so the signer builds a PKCS#8 DER wrapper around the seed.
The public key is derived from the seed rather than read from config, avoiding
key/public-key mismatch.

---

## 4. Rate limits — verified

Two independent layers; a request must pass both.

- **Per-IP weight bucket**: 1,500 weight, refilling 1,500/min (**25 weight/s**).
  Keyed on source IP, shared by every account queried from that IP.
- **Per-subaccount trading pools**: separate order and cancel pools, replenished by
  realized volume. `cancelAllOrders` charges the cancel pool a flat **1,000**.

Rejection contract:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 2
{"error":"rate limited"}
```

The body distinguishes the layer:

| Body | Layer |
| --- | --- |
| `{"error":"rate limited"}` | per-IP weight, read endpoint |
| `{"error":"rate limited","reason":"ip",…}` | per-IP weight, order write |
| `{"error":"rate limited","reason":"account_empty",…}` | per-subaccount pool exhausted |
| `{"error":"rate limited","reason":"account_partial",…}` | pool can't cover the charge |

Order-write rejections add `retryAfterMs` plus the echoed `clientId`/`clientIds`.

Weight tiers used by this system:

| Weight | Endpoints |
| --- | --- |
| 0 | `health`, all order writes (`placeOrder`/`modifyOrder`/`cancelOrder`) |
| 1 | `/`, `time` |
| 2 | `bbo`, `mids`, `account`, `positions`, `order`, `feetiers`, `leverages`, `accountStats`, `rateLimit` |
| 20 | `prices`, `markets`, `trade`, `trades`, `candles`, `portfolio`, `openOrders`, `orders`, `fills`, `funding`, `fundingR` |
| 125 | `setLeverage`, `withdraw`, `transfer` |

Arcus does **not** return `X-RateLimit-*` headers; the budget is published in the docs
and the live state is readable from `GET /v1/rateLimit`. Consequence for design: a 4 req/s
poll against weight-20 endpoints costs 80 weight/s against a 25/s refill and throttles in
~25 s even while the trading path is idle — so this system budgets weight client-side and
prefers WebSocket streams over polling.

---

## 5. Field-name confirmations that matter for correctness

All numeric money/quantity fields are **decimal strings**, never JSON numbers.

### `MarketInfo` (from `GET /v1/markets`)

`marketDisplayName`, `marketId` (uint16), `status`, `baseAsset`, `quoteAsset`,
`tickSize`, `stepSize`, `tickTiers`, `minOrderNotional`, `minOrderSize`, `maxOrderSize`,
`oraclePrice`, `markPrice`, `lastTradePrice`, `fundingRate`, `nextFundingRate`,
`nextFundingAt`, `priceChange24h`, `volume24h`, `volume24hNotional`, `high24h`, `low24h`,
`trades24h`, `openInterest`, `openInterestCapNotional`, `initialMarginFraction`,
`maintenanceMarginFraction`, `offHoursInitialMarginFraction`, `regularTradingHours`,
`isOutsideRth`, `currentSettlementPrice`, `upperTradingBound`, `lowerTradingBound`,
`nextUpperTradingBound`, `nextLowerTradingBound`, `isUpperInExpansionZone`,
`isLowerInExpansionZone`, `upperZoneEnteredAt`, `upperExpectedExpansionAt`,
`lowerZoneEnteredAt`, `lowerExpectedExpansionAt`, `type`, `category`, `addedTimestamp`,
`assetResolution`, `pythId`.

- `category` enum: `CRYPTO | INDICES | EQUITIES | FOREX | COMMODITIES`.
  → this is how RWA vs crypto classification is driven; **no hardcoded list**.
- `isOutsideRth` is read from the market payload, not computed locally.
- `offHoursInitialMarginFraction` is read from the market payload; the off-hours margin
  multiplier is **never hardcoded**.

### `account` (from `GET /v1/account`)

`accountIndex`, `address`, `netQuoteBalance`, `equity`, `freeCollateral`,
`netDeposits`, `pendingDeposits`, `pendingWithdrawals`, `positions` (object keyed by
marketId), `sequenceNumber`.

### `position`

`address`, `accountIndex`, `marketId`, `marketDisplayName`, `side` (`LONG|SHORT`),
`size` (**signed**; positive long, negative short), `averageEntryPrice`,
`cumulativeFunding`, `leverage`, `marginMode` (`CROSS|ISOLATED`), `borrowedCapital`,
`marginUsed`, `positionValueNotional` (signed), `unrealizedPnl`, `markPx`, `sequenceNumber`.

### `order`

`orderId`, `clientId`, `address`, `accountIndex`, `marketId`, `marketDisplayName`,
`side`, `type` (`LIMIT|MARKET`), `status`, `price`, `originalSize`, `filledSize`,
`remainingSize`, `avgFillPrice`, `timeInForce`, `goodTilTime`, `reduceOnly`,
`triggerPrice`, `tpslType`, `isPositionTPSL`, `parentOrderId`, `rejectionReason`,
`cancelReason`, `state`, `positionEffect`, `createdAt`, `updatedAt`, `sequenceNumber`.

- `order.status` enum: `PENDING, OPEN, PARTIALLY_FILLED, FILLED, CANCELED,
  MARGIN_CANCELED, REJECTED, UNTRIGGERED, TPSL_PLACED, TPSL_TRIGGERED, TPSL_CANCELED,
  LIQUIDATED, ADL, ACK, CANCEL_ACKNOWLEDGED, CANCEL_ALL_ACKNOWLEDGED, CANCEL_PENDING, ERROR`.
- `order.state` (engine-authoritative, stamped on every streaming update):
  `OPEN | PARTIALLY_FILLED | FILLED | CANCELED | REJECTED`. **This is what drives the
  local order state machine**, not `status`.
- `timeInForce` on **reads** reports resting orders as `GTC` (legacy name for GTT) for
  backward compatibility — see `TimeInForceResponse` = `GTC|GTT|IOC|FOK|ALO`.
  Writes must send `GTT`. A naive string comparison here is a real bug source.
- Timestamps `createdAt`/`updatedAt` are epoch **microseconds**.

### `fill`

`tradeId`, `orderId`, `address`, `accountIndex`, `marketId`, `marketDisplayName`,
`clientId`, `side`, `originalSize`, `size`, `price`, `fee`, `closedPnl`, `role`
(`MAKER|TAKER`), `remainingSize`, `positionEffect`, `createdAt` (µs), `sequenceNumber`,
`liquidation`.

### `Candle`

`marketDisplayName`, `marketId`, `timeframe`, `openTime` (µs), `open`, `high`, `low`,
`close`, `volume`, `takerBuyVolume`, `notionalVolume`, `takerBuyNotionalVolume`,
`tradeCount`, `isFinal`.

- `isFinal` distinguishes a closed bar from a forming one — required so indicators never
  compute on a half-formed bar.

### `RejectionReason` enum (full)

`POST_ONLY_WOULD_CROSS, SELF_TRADE, UNDERCOLLATERALIZED, COULD_NOT_FILL, IOC_CANCELED,
FOK_FAILED, REDUCE_ONLY_WOULD_INCREASE, TOO_MANY_CLIENT_IDS, DUPLICATE_CLIENT_ID,
POSITION_TPSL_ALREADY_EXISTS, ENTRY_TPSL_CANNOT_BE_POSITION_TPSL,
ORDER_WILL_TAKE_LIQUIDITY_DURING_MARKET_HALT, ORDER_NOT_FOUND_FOR_MODIFY,
MODIFY_CHANGED_IMMUTABLE_FIELD, MODIFY_ZERO_SIZE,
PRICE_WILL_EXCEED_MAXIMUM_OUTSIDE_RTH_TRADING_BOUND,
MODIFY_WOULD_CROSS_OUTSIDE_RTH_TRADING_BOUNDARY, FILL_WILL_EXCEED_TRADING_BOUND,
OPEN_INTEREST_CAP_EXCEEDED, POSITION_SIZE_CAP_EXCEEDED, MODIFY_TPSL_NOT_SUPPORTED,
MODIFY_SUPERSEDED_BY_CANCEL, MODIFY_SIZE_ALREADY_FILLED, ORDER_NOT_FOUND,
OPEN_ORDER_CAP_EXCEEDED, EXPIRED`.

Note `SELF_TRADE` and `POST_ONLY_WOULD_CROSS` exist as engine-side guards — the engine
independently enforces the no-self-trade property this system relies on.

### `OrderRequest` (write body)

`address, marketId, accountIndex, orderSide, orderType, quantity, price, timeInForce,
goodTilTime, minSize, stopPrice, tpslType, isPositionTPSL, parentOrderId, clientId,
clientTime, fillMode, reduceOnly, signature, timestamp`.

- `quantity` pattern disallows exponent/leading-plus forms; plain decimal string.
- `timestamp` in the **body** is also Unix nanoseconds and must equal `ct`/`X-Timestamp`.
- `goodTilTime` in the **body** is epoch **microseconds** (× 1000 in the signed payload).
- `orderType: MARKET` requires `timeInForce: IOC` and still requires `price` as a
  protective bound within 10% of mark (or of `stopPrice` for TPSL legs).

### `GET /v1/candles` parameters

`market` (required), `timeframe` (required; enum `1m,3m,5m,15m,30m,1h,2h,4h,8h,12h,1d,3d,1w`),
`to` (**required**, µs), `from` (µs, mutually exclusive with `countback`),
`countback` (1–1500, mutually exclusive with `from`).

`to` being required is easy to miss — an omitted `to` is a 400, not a default.

---

## 6. WebSocket — verified

- Endpoints: `wss://api.arcus.xyz/v1/ws` (mainnet), `wss://api.testnet.arcus.xyz/v1/ws` (testnet).
- One socket multiplexes channel subscriptions **and** RPC (`post`/`get`).
- **Subscriptions are unauthenticated** — including account-scoped channels. Any
  connection may subscribe to any address and receive its balances, positions, open
  orders and fills. This is deliberate upstream. See "Security implications" below.
- Subscribe: `{"type":"subscribe","channel":"<name>","id":"<subscription_id>"}`.
  The reply `{"type":"subscribed",…}` carries `contents` = the **initial snapshot**;
  there is no bare ack frame. Health checks must count channels that delivered
  `contents`, not empty acks.
- Stream: `{"type":"channel_data","channel":…,"id":…,"contents":…}`.
- Request/response: `{"type":"get"|"post","id":<numeric>,"request":{"type":…,"payload":…}}`.
  IDs must be **strictly increasing per connection**; a violation is rejected with an
  `error` frame that **does not echo the id** — so a client matching by id sees the
  request as unanswered rather than failed.
- Subscribe options: `snapshot` (false suppresses the initial snapshot on delta
  channels), `nLevels` (l2Orderbook, 1–100, default 20), `nRecentClosed` (orders,
  default 100), `nFills` (userFills, default 500/max 500), `market` (orders/positions/
  userFills only; an unknown market or use on another channel is an `error` frame).
- Account-scoped frames carry `accountIndex` on **every** frame including `0`, so
  several subaccounts of one address are demuxable on one connection. `id` is the
  lowercase master address on those channels.
- Recommended sizing: ≥ 2 CPU cores and 4 GB RAM for a real-time client.
- Snapshot-only channels (`markets`) are full maps keyed by `marketId`, ~5 s cadence,
  no diffs — replace the whole view.
- `l2Orderbook` is snapshot + deltas, with sequence contiguity rules for resync.

### Security implications (design consequences, accepted deliberately)

Because account channels are unauthenticated, **the wallet address is a public
identifier and its positions and fills are observable by anyone who knows it.** This
system therefore:

- treats address exposure as a given, not as a secret;
- still keeps every credential out of logs (keys are secrets; the address is not);
- does not attempt "activity privacy", because the API offers no per-address read
  restriction. The docs explicitly suggest separating by address if attribution matters.

---

## 7. Order type and margin semantics — verified

- `timeInForce`: `GTT` (default resting), `IOC`, `FOK`, **`ALO`** = Add Liquidity Only
  (post-only). Writes must use `GTT` for resting orders; reads report them as `GTC`.
- `tpslType`: `STOP_LOSS | TAKE_PROFIT`, orthogonal to `orderType`. `stopPrice` is
  required when `tpslType` is set and must be omitted otherwise.
- `isPositionTPSL` — TPSL closing the user's full open position.
- Margin modes: `CROSS | ISOLATED`. This system defaults to **ISOLATED**.
- Off-hours: `isOutsideRth` from the markets payload; `offHoursInitialMarginFraction`
  is the engine-enforced initial margin when the underlying is closed. This system
  refuses new entries outside RTH unless explicitly enabled, and never hardcodes the
  off-hours multiplier.

---

## 8. Still UNCONFIRMED

These are the honest gaps. None of them block DRY_RUN/shadow operation; each is
enumerated in `README.md` under "未确认的 API 字段" and none may gate LIVE.

1. **The OpenAPI root document is not retrievable.** `https://docs.arcus.xyz/api-reference/openapi.yml`
   (the URL `llms.txt` advertises) returns **404**. The AsyncAPI spec at
   `/api-reference/asyncapi.yaml` returns 200. Workaround: the per-endpoint pages embed
   complete OpenAPI fragments including a trailing `components:` block with 89 schemas;
   `tools/merge-openapi.py` reassembles them. Consequence: if a page omits a schema that
   it `$ref`s, the merged doc has a dangling ref. Checked — no dangling refs observed.
2. **`GET /v1/fundingRates` vs `GET /v1/funding`.** `/v1/funding` returns the account's
   funding **payments**; `/v1/fundingRates` returns historical **rates** for a market.
   The brief called the latter `get-funding-rates`; the live page is
   `get-market-funding-rates`. Both exist and are distinct — confirmed, but flagging the
   naming collision because it is easy to wire the wrong one.
3. **Exact `regularTradingHours` sub-field names** were not enumerated. The schema is
   present (`RegularTradingHours` object), but the system only ever reads the boolean
   `isOutsideRth` from the market payload, so no code depends on those internals. If a
   future feature needs session windows, resolve this first.
4. **`cumulativeFunding` sub-field names** on `position` were not enumerated. The system
   reads funding from `GET /v1/funding` payments instead, so nothing depends on it.
5. **L2 delta sequence-contiguity details** for `l2OrderbookUpdates` were skimmed. The
   implementation resyncs by re-requesting a full snapshot on any gap rather than
   trusting delta continuity, which is fail-closed and does not require this detail.
6. **No upstream confirmation of a public/testnet `POST /v1/createApiKey` flow being
   required** for this system — key generation is documented but out of scope here. The
   system consumes an existing key from the environment and never creates keys.
7. **Points.** The brief references a "Points boost" concept. Arcus docs fetched here
   contain **no** Points API or field. The value is therefore **unavailable**, and the
   daily report renders Points as `UNAVAILABLE` rather than inventing a number. Points is
   never a trading input — enforced in code.


---

## 9. Live-verification findings (added after probing the running API)

These were found by calling `https://api.arcus.xyz` directly. Each one contradicted
either the brief, the documentation's embedded OpenAPI fragments, or an earlier
assumption in this codebase. All are now pinned by tests in
`tests/unit/arcus-client.test.ts` and `tests/unit/arcus-ws.test.ts`.

### 9.1 Account-scoped reads are ACCESS-WHITELISTED, not merely unauthenticated

The docs say these reads take `?address=` and need no API key. True of
*authentication*; not true of *authorisation*. For an address that is not approved,
the API returns:

```http
HTTP/1.1 403 Forbidden
{"error":"address not on access whitelist"}
```

Verified for `/v1/account`, `/v1/positions`, `/v1/openOrders`, `/v1/orders`,
`/v1/fills`, `/v1/funding`, `/v1/accountTransferUpdates`, `/v1/leverages` **and**
`/v1/rateLimit`. Calling `/v1/rateLimit` with no address returns
`400 {"error":"address not on access whitelist"}` instead.

Consequences:

- The account-scoped schemas in this repository are implemented from the
  documentation and exercised with fixtures, but are **not live-verified**. This is
  the single most important open item before LIVE.
- `/v1/rateLimit` must be called WITH `address` (+ `accountIndex`); a bare call is a
  400.
- A non-whitelisted account cannot read its own equity, so `dry-run` against mainnet
  runs in an explicit **read-only posture**: public market data and the full strategy
  pipeline work, and the entry gate refuses every order because there is no account
  to size against. That refusal is logged as such.
- `REQUIRE_ORDER_POOL_READ` exists because of this: with the default `true`, an
  unreadable pool blocks ALL new entries, which is correct but untradeable for a
  non-whitelisted account. Setting it `false` trades without the pre-emptive pool
  check while the local weight budget and the observed-429 circuit breaker remain.

### 9.2 `GET /v1/feetiers` — different keys, different units

```json
{"tiers":[{"level":0,"name":"Base","volume_threshold":0,"maker_fee_ppm":0,"taker_fee_ppm":225}]}
```

- The array key is **`tiers`**, not `feeTiers`.
- Field names are snake_case: **`volume_threshold`**, **`maker_fee_ppm`**,
  **`taker_fee_ppm`** — not `tierLevel`/`makerFeeBps`/`takerFeeBps`.
- Fees are in **parts per million**. `225 ppm` is `2.25 bps`. Reading `225` as bps
  would overstate the taker fee by **100×** and refuse every trade whose edge sits
  between the true and the inflated cost.
- `maker_fee_ppm` can be **negative** on the VIP tiers (a rebate), so it must never be
  clamped at zero.
- There is no readable "my tier" field, so the **base tier** is used: the most
  expensive row, hence conservative.

`ppmToBps()` performs the conversion and is unit-tested at the boundary.

### 9.3 `tickTiers` is an acceptance rule with a differently-named field

```json
"tickTiers": [{"upToPrice":"500000","tick":"0.1"}, …, {"tick":"5"}]
```

The field is **`tick`** (not `tickSize`), `upToPrice` is an exclusive upper bound, and
the final band omits `upToPrice` entirely. The documentation is explicit that the
**signing divisor is always the top-level `tickSize`** and that tiers "only constrain
which prices are *accepted*". Both rules are implemented
(`MarketProvider.validateLimitPrice`).

### 9.4 `GET /v1/trades` uses `timestamp`, not `createdAt`

```json
{"trades":[{"tradeId":"17073751","price":"83540.6","size":"0.0004","side":"SELL",
            "timestamp":1791881872068100,"makerOrderId":"…","takerOrderId":"…",
            "sequenceNumber":3869715490}]}
```

The endpoint's OpenAPI fragment names the field `createdAt`; the live payload sends
`timestamp` (epoch microseconds) plus maker/taker order ids and addresses.

### 9.5 `GET /v1/fundingRates` uses `fundingRate`, not `rate`

```json
{"fundingRates":[{"marketId":1,"marketDisplayName":"BTC-USD","fundingRate":"0.0000125","time":1791878400000000}]}
```

### 9.6 The L2 orderbook uses positional TUPLES

```json
{"bids":[["83587","0.16191699"],["83586.9","0.00010005"]],
 "asks":[["83587.1","0.47557328"]],
 "lastSequenceId":411852675,"globalSequenceId":3868872064,"timestamp":1791881240454292}
```

Levels are `[price, size]` arrays, not `{price, size}` objects. By contrast
`GET /v1/bbo/{market}` **does** use objects (`{"bestBid":{"price":…,"size":…}}`), so
the two shapes must not be conflated. The client **rejects** the object form for L2
rather than coercing it, because a silent coercion would produce a zero-depth book and
exclude every market from the candidate pool.

Both responses also carry `lastSequenceId`, `globalSequenceId` and a microsecond
`timestamp`, which are useful for staleness and gap detection.

### 9.7 The WebSocket sends `connected`, and its `error` frame is normal traffic

On open the server sends `{"type":"connected","connection_id":"…"}` before any
subscription. A subscription for a non-whitelisted address is refused with:

```json
{"type":"error","message":"address not on access whitelist"}
```

**This frame crashed the process.** Node's `EventEmitter` makes an unhandled `error`
event a fatal exception, and the frame was being emitted under that name — the process
aborted with `ERR_UNHANDLED_ERROR`. The event is now named **`serverError`**, the
`connected` frame is handled explicitly, and `extractErrorMessage()` reads the
server's `message` field so the reason reaches the log.

### 9.8 `isOutsideRth` can be `null`

Many markets report `null` rather than `true`/`false`, and `regularTradingHours` is
`null` for every market observed. Rejecting the payload would have made the whole
market list unusable, so the field is typed `boolean | null` and the **safe reading of
`null` is "unknown"**: it is treated as off-hours for ENTRY purposes and reported
distinctly. Assuming `null` means "RTH is open" is exactly how an off-hours order
would slip past the rule meant to stop it.

### 9.9 Nullable fields found on `MarketInfo`

`fullAssetName`, `oraclePrice`, `markPrice`, `lastTradePrice`, `fundingRate`,
`nextFundingRate`, `nextFundingAt`, `priceChange24h`, `volume24h`,
`volume24hNotional`, `high24h`, `low24h`, `openInterest`,
`openInterestCapNotional`, `initialMarginFraction`, `maintenanceMarginFraction`,
`offHoursInitialMarginFraction`, `currentSettlementPrice`, `upperTradingBound`,
`lowerTradingBound`, `nextUpperTradingBound`, `nextLowerTradingBound`,
`isUpperInExpansionZone`, `isLowerInExpansionZone`, `upperZoneEnteredAt`,
`upperExpectedExpansionAt`, `lowerZoneEnteredAt`, `lowerExpectedExpansionAt`,
`addedTimestamp`, `assetResolution`, `pythId`, and `regularTradingHours`.

One field appears live that the merged OpenAPI fragments do not describe:
**`liquidationFeePpm`**.

### 9.10 Environment notes

- **`better-sqlite3` aborts under Node 24.** `Assertion failed: (env) != nullptr` in
  `node::RemoveEnvironmentCleanupHook … Database::~Database()`. Reproduced on
  `11.10.0` and `12.11.1` and reducible to a loop opening/closing in-memory databases.
  Because it fires in a native destructor during garbage collection it can abort at any
  moment, so `src/store/Sqlite.ts` prefers Node's built-in **`node:sqlite`** and falls
  back to `better-sqlite3` (Node ≥ 22.5 recommended).
- **A signed write cannot be validated without the wallet address on mainnet.**
  The access-whitelist check runs BEFORE key validation, so a valid key and a
  randomly generated key both return `403 address not on access whitelist`, and a
  deliberately corrupted signature returns the same thing. On testnet the same key
  returns `401 Invalid API key`. Supply the registered wallet address (whitelisted)
  to complete the check.

### 9.13 Verified with a WHITELISTED account (2026-10-25)

The account `0x2caafa…5b9d` (redacted) is whitelisted, which finally
allowed the account-scoped half of the API to be exercised against real data. Three wire
shapes differ from the documentation and were fixed:

**`GET /v1/positions` returns a MAP, not an array**

```json
{"positions": {}, "total": 0}
```

The endpoint's OpenAPI fragment declares `positions` as an array. The live payload keys it
by marketId, exactly like `account.positions`. The client now accepts either and
normalises to an array. Before the fix, every position read failed schema validation —
which, because reconciliation depends on it, would have blocked all trading rather than
silently under-reporting.

**`GET /v1/rateLimit` uses `used` / `cap`, not `capacity` / `remaining`**

```json
{"order":{"used":96,"cap":4678349,"nextAvailableMs":0},
 "cancel":{"used":11000,"cap":4698349,"nextAvailableMs":0}}
```

`remaining` is derived as `cap - used`. Both spellings are accepted.

**The fee tier changed between 2026-10-18 and 2026-10-25**

| Date | Base maker | Base taker |
| --- | --- | --- |
| 2026-10-18 | 0 ppm (0 bps) | 225 ppm (2.25 bps) |
| 2026-10-25 | 150 ppm (1.5 bps) | 450 ppm (4.5 bps) |

This is why the cost model reads the table at startup instead of hardcoding rates: a
hardcoded 2.25 bps taker would now understate the real cost by half.

### 9.14 The API key value is public, and signing needs the private half

`GET /v1/apiKeys?address=…` returns the key **fingerprint/public half**:

```json
{"apiKeys":[{"apiKey":"168c72ee…","address":"0x2caa…","accountIndex":0,
             "allSubaccounts":false,"apiWalletName":"ArcusTrader","status":"ACTIVE",
             "validUntil":1808405632495,"createdAt":1792853635870}]}
```

Distinguishing a public key from a signing seed is possible without trying to trade:

| Request | Result | Meaning |
| --- | --- | --- |
| `X-API-Key: 168c72ee…`, signature made from it as a seed | `401 invalid order signature` | the gateway **recognises** the key; the signature does not verify |
| `X-API-Key: <derived from 168c72ee…>`, signature made from it | `401 Invalid API key` | the derived key was never registered |

So the supplied value is the public half. No request can be signed with it. The **API
Signing Key** — the Ed25519 seed shown once at creation — is what `ARCUS_API_SIGNING_KEY`
must contain, and the system derives the public key from it (refusing to start if
`ARCUS_API_KEY` disagrees).
