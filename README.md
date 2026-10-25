# ArcusTrader

An automated pullback trading system for **Arcus Perpetuals**, written in TypeScript
and designed to run unattended on a VPS under PM2.

It buys strength on a discount — and sells weakness on a rally — by waiting for a
high-timeframe trend, a retracement into a real level, and a lower-timeframe
reversal confirmation. It is **not** a market-making system, **not** an arbitrage
system, and emphatically **not** a volume-generation system.

> **Safety first, and by default.** The process starts in `dry-run`, cannot submit an
> order, and live trading requires three independent conditions to be satisfied —
> including a flag typed on the command line. See [Safety model](#safety-model).

---

## Table of contents

1. [Status and what is verified](#status-and-what-is-verified)
2. [Two findings that will bite you](#two-findings-that-will-bite-you)
3. [Arcus endpoint mapping](#arcus-endpoint-mapping)
4. [Quick start (dry-run)](#quick-start-dry-run)
5. [Configuration](#configuration)
6. [State machine](#state-machine)
7. [Risk formulas](#risk-formulas)
8. [The entry gate: every "do not trade" condition](#the-entry-gate-every-do-not-trade-condition)
9. [Daily report](#daily-report)
11. [Replay and backtesting](#replay-and-backtesting)
12. [Backtest results](#backtest-results--the-strategy-is-not-viable-as-specified)
13. [Deployment readiness](#deployment-readiness)
14. [Testing](#testing)
15. [PM2 deployment](#pm2-deployment)
16. [Safety model](#safety-model)
17. [Unconfirmed API fields and open questions](#unconfirmed-api-fields-and-open-questions)
18. [Repository layout](#repository-layout)

---

## Status and what is verified

| Item | State |
| --- | --- |
| Arcus REST read paths | **Verified against live mainnet** (`/v1/markets`, `/v1/candles`, `/v1/bbo/{market}`, `/v1/l2OrderBook/{market}`, `/v1/trades`, `/v1/fundingRates`, `/v1/feetiers`, `/health`) |
| Arcus request signing | **Implemented from the official reference code**; both schemes, 41 tests including golden byte-vectors |
| Arcus order placement | **Implemented, not live-verified** — signing is proven by golden vectors, but no order has been submitted (the signing key is missing) |
| Arcus account reads | **Verified against a whitelisted mainnet account** (account, positions, openOrders, fills, funding, transfers, rateLimit) |
| Arcus WebSocket | **Verified**: connect, subscribe, snapshots, and the `error` frame path |
| Strategy | Implemented and unit-tested; exercised against live mainnet data in `dry-run` |
| RiskEngine | Implemented; every limit has a positive and a negative test |
| Lark reporting | **Implemented and unit-tested** (94 tests) with an in-repo outbox; no live message sent |
| Test suite | **522 tests passing** across 11 files |
| Live trading | **Never enabled.** Not attempted. |

### Two hard blockers, both environmental

Neither is a code defect. Both are documented here because pretending otherwise
would be worse than the limitation itself.

1. **Arcus mainnet account reads are access-whitelisted.** `GET /v1/account`,
   `/v1/positions`, `/v1/openOrders`, `/v1/orders`, `/v1/fills`, `/v1/funding`,
   `/v1/accountTransferUpdates`, `/v1/leverages` and `/v1/rateLimit` all return
   **HTTP 403 `{"error":"address not on access whitelist"}`** for an address that is
   not approved. The Arcus documentation describes these as "no authentication
   required" reads, which is true of *authentication* but not of *authorisation*.
   Consequence: the account-scoped half of the system has been exercised against
   fixtures and unit tests, not against live data. **A whitelisted address is a
   prerequisite for going live.**

2. **The API key could not be validated without the wallet address.** Mainnet's
   access-whitelist check runs BEFORE key validation, so a random key and a valid
   key both return `403 address not on access whitelist`; testnet returns
   `401 Invalid API key` for the key under test. See
   [Verifying the API connection](#verifying-the-api-connection).

---

## Verifying the API connection

Run this whenever a credential is added or rotated:

```bash
pnpm preflight          # full read-only self-test; exits non-zero on a real problem
```

### What was actually established

| Check | Result |
| --- | --- |
| DNS/TLS to `api.arcus.xyz` | **PASS** |
| `GET /health`, `/v1/time`, `/v1/markets` unauthenticated | **PASS** (67 markets, 5 categories) |
| Signing key parses as a 32-byte Ed25519 seed | **PASS** |
| Derived public key is 64 hex chars and self-verifies | **PASS** |
| Server clock within the ±30 s signing window | **PASS** (~87 ms skew) |
| Key accepted for a signed write on **mainnet** | **INCONCLUSIVE** |
| Key accepted for a signed write on **testnet** | **FAIL — `401 Invalid API key`** |

### Why mainnet is inconclusive, not green

A signed `POST /v1/cancelOrder` for a **nonexistent** order (non-destructive) was sent
with a made-up address. The gateway answered `403 address not on access whitelist`
**before** evaluating the key — proven by sending the same request with a randomly
generated key, a zero address, and a deliberately corrupted signature: all four
returned the identical 403. The whitelist gate therefore fires first and the key is
never examined.

**Consequence:** to confirm the key, supply the wallet address it was registered to and
ensure that address is whitelisted. Both are required; neither is discoverable from the
key itself. Until then the system runs read-only, which is the correct posture — it
refuses every order because it has no account to size against.

---

## Two findings that will bite you

Both were discovered by probing the live API rather than trusting the published
spec, and both would have caused silent, wrong behaviour.

### 1. `tickTiers` are an *acceptance* rule, not a *signing* divisor

The field is named **`tick`**, not `tickSize`:

```json
"tickTiers": [
  {"upToPrice": "500000", "tick": "0.1"},
  {"upToPrice": "1000000", "tick": "0.2"},
  {"tick": "5"}
]
```

Two distinct rules apply, and conflating them is a live bug:

- **Signing always divides by the market's top-level `tickSize`**, at every price.
  The tier ladder never changes the signed integer `p`.
- **Acceptance** additionally requires a limit price to be a multiple of *its own
  band's* `tick`, or the engine rejects it with
  `… is not a multiple of tick size … for its price tier`.

So a client that reads only `tickSize` stays correct for prices in the base band and
then starts getting rejections once a market's price crosses a tier boundary. This
codebase implements both rules and validates a price against both grids before
signing (`MarketProvider.validateLimitPrice`).

### 2. `Decimal.prototype.isPositive()` is `true` for `+0`

decimal.js's `isPositive()` is **sign-based**, so `new Decimal(0).isPositive() === true`.
Used as a division guard it lets a zero divisor through and produces
`Infinity`/`NaN`, which then flows into a price or a size. This was found the hard
way — five tests failed with `NaN` ATR, `Infinity` distance, and `NaN` bucket
indices — and it surfaced again in the cost model, where a **net edge of exactly
zero was reported as viable**.

The entire codebase has been swept: every guard is `greaterThan(0)`, and
`src/util/decimal.ts` documents the hazard at the helper. `tests/safety` includes a
regression test that pins the zero-edge case. If you add code, do not reintroduce a
bare `isPositive()`.

---

## Arcus endpoint mapping

The task brief listed endpoint *page paths* that do not all exist. Per the brief's
own instruction ("以 Arcus 当前文档实际页面为准"), the live docs win. The full audit
trail — every discrepancy, every verified field name — is in
[`docs/API_CONTRACTS.md`](docs/API_CONTRACTS.md), with the raw documentation snapshot
in [`docs/arcus/`](docs/arcus/) and a merged OpenAPI document in
[`docs/arcus/arcus.openapi.merged.json`](docs/arcus/arcus.openapi.merged.json).

### Brief path → actual path

| Brief listed | Actual |
| --- | --- |
| `/api-reference/public/get-markets` | page exists; **operation is `GET /v1/markets`** |
| `/api-reference/public/get-bbo` | **page is `/api-reference/public/get-best-bid-offer-bbo`**; op `GET /v1/bbo/{market}` |
| `/api-reference/public/get-l2-orderbook-snapshot` | page exists; op `GET /v1/l2OrderBook/{market}` |
| `/api-reference/public/get-funding-rates` | **page is `/api-reference/public/get-market-funding-rates`**; op `GET /v1/fundingRates` |
| `/api-reference/public/get-ohlcv-candles` | page exists; op `GET /v1/candles` |
| others | same |

Note the ambiguity the brief's naming creates: **`/v1/funding`** returns the
account's funding *payments*, while **`/v1/fundingRates`** returns historical
*rates* for a market. Both exist and are distinct.

### Operations this system uses

| Method | Path | Weight | Signing | Used for |
| --- | --- | --- | --- | --- |
| GET | `/health` | 0 | – | liveness |
| GET | `/v1/time` | 1 | – | clock-skew check at preflight |
| GET | `/v1/markets` | 20 | – | **the market universe; nothing is hardcoded** |
| GET | `/v1/candles` | 20 | – | 4h / 1h / 15m history |
| GET | `/v1/bbo/{market}` | 2 | – | spread, and the quote the strategy prices against |
| GET | `/v1/l2OrderBook/{market}` | 2 | – | depth for the liquidity score |
| GET | `/v1/trades` | 20 | – | recent-trade context |
| GET | `/v1/fundingRates` | 20 | – | funding cost input |
| GET | `/v1/feetiers` | 2 | – | real maker/taker rates for the cost model |
| GET | `/v1/rateLimit` | 2 | – | per-subaccount order/cancel pools |
| GET | `/v1/account` | 2 | – | equity, free collateral, positions |
| GET | `/v1/positions` | 2 | – | open positions |
| GET | `/v1/openOrders` | 20 | – | reconciliation |
| GET | `/v1/orders` | 20 | – | order history (fills ingest) |
| GET | `/v1/fills` | 20 | – | **the authoritative PnL source** |
| GET | `/v1/funding` | 20 | – | funding payments |
| GET | `/v1/accountTransferUpdates` | 20 | – | deposits / withdrawals ledger |
| POST | `/v1/placeOrder` | 0 | Scheme 1 (`op=1`; `op=4` for TPSL) | entries, stops, targets |
| POST | `/v1/cancelOrder` | 0 | Scheme 1 (`op=2`) | TTL expiry, kill switch |
| POST | `/v1/cancelAllOrders` | 0 | Scheme 2 | reserved for kill-switch paths |
| POST | `/v1/setLeverage` | 125 | Scheme 2 | implemented, not called automatically |

> **Never called:** `/v1/withdraw` and `/v1/transfer`. `ALLOW_AUTO_WITHDRAW=false` is
> enforced at config load, and a safety test asserts the client exposes no method
> for them.

### Signing, precisely

**Scheme 1** — `placeOrder` / `cancelOrder` / `modifyOrder`. The signature message
**is** the payload: compact JSON, keys sorted ascending, no whitespace, no prefix.

```
placeOrder   {"ad":"0x…","ai":N,"c":"…","ct":N,"g":N,"m":N,"op":1,"p":N,"q":N,"r":0|1,"s":N,"t":N,"v":1}
cancelOrder  {"ad":"0x…","ai":N,"c":"…","ct":N,"id":"…","m":N,"op":2,"v":1}
```

- `ad` lowercased (the only case-folded field); `c` **omitted entirely** when empty
  and otherwise signed byte-verbatim.
- `ct` = Unix **nanoseconds**, must equal the `X-Timestamp` header.
- `g` = the body's microsecond `goodTilTime` **× 1000**.
- `p` = `price / tickSize` (integer ticks); `q` = `size / stepSize` (integer quantums).
- `r` is the **integer** `0|1`, not a boolean. `s`: 0 buy, 1 sell. `t`: GTT 0, FOK 1,
  IOC 2, ALO 3.

**Scheme 2** — everything else: `timestamp + action + canonical_json(body)`,
concatenated with **no delimiters**; a signed GET is just `timestamp + action`.

The **`ct` and `g` fields are kept as `bigint`** until serialisation. This is
load-bearing: a nanosecond epoch is ~1.79e18, far beyond
`Number.MAX_SAFE_INTEGER` (9.007e15), so routing it through a JS `number` quantises
the low digits and the signed string stops matching the header. There is a test that
demonstrates the quantization and asserts the exact digits survive.

---

## Quick start (dry-run)

Requires **Node ≥ 20.11** (Node ≥ 22.5 recommended — see the SQLite note below) and
pnpm.

```bash
pnpm install
cp .env.example .env          # optional for dry-run
pnpm typecheck                # tsc, strict
pnpm test                     # 522 tests
pnpm dry-run --once           # one tick against live mainnet public data
pnpm preflight                # full self-test, exits non-zero on a real problem
```

No credentials are needed for `dry-run`. With no `ARCUS_WALLET_ADDRESS` the system
runs in an explicit **read-only posture**: it fetches markets, candles and books,
builds the candidate pool, evaluates the strategy, and refuses every order because
there is no account to size against. That refusal is logged as such rather than
silently skipping.

Useful invocations:

```bash
pnpm dry-run --ticks 5              # five ticks then exit
pnpm shadow --once                  # identical, but runs the full decision pipeline
LOG_LEVEL=debug pnpm dry-run --once # per-tick state line + every gate reason
pnpm reconcile                      # read + reconcile + print the verdict, exit
pnpm report --once                  # render the daily report to stdout
pnpm replay --help                  # offline backtester
pnpm kill --reason "manual stop"    # write the STOP_TRADING sentinel
pnpm reset-kill                     # clear the sentinel and the automatic latch
```

### The SQLite driver, and why it is chosen at runtime

`src/store/Sqlite.ts` prefers Node's built-in **`node:sqlite`** and falls back to
`better-sqlite3`.

This is not a preference. Under **Node 24**, `better-sqlite3` aborts the process:

```
Assertion failed: (env) != nullptr
node::RemoveEnvironmentCleanupHook … in Database::~Database()
```

Reproduced on both `11.10.0` and `12.11.1`, and reducible to a loop that opens and
closes in-memory databases — so it is a library/Node-version incompatibility, not
misuse. Because the abort happens in a native destructor during garbage collection,
it can fire at **any** point in a long-running process, which is disqualifying.
`node:sqlite` survives 200 open/close cycles under identical stress. The adapter
normalises the three real differences (no `pragma()` method, `undefined` and boolean
bindings rejected by both drivers) and logs which driver it selected.

---

## Configuration

Every setting is documented inline in [`.env.example`](.env.example) and validated in
[`src/config/config.ts`](src/config/config.ts). The three groups that matter most:

**Risk** — the only place leverage, per-trade risk and the daily loss limit are set.
Nothing else in the system can change them.

```
MAX_LEVERAGE=2            RISK_PER_TRADE_BPS=25      DAILY_LOSS_LIMIT_BPS=100
MAX_NOTIONAL_PCT=30       MAX_OPEN_POSITIONS=1       MAX_MARKETS_PER_ACCOUNT=1
MAX_CONSECUTIVE_LOSSES=3  MAX_DATA_AGE_MS=3000       EQUITY_CHANGE_PAUSE_BPS=1000
TARGET_VOLUME_USD=0       ALLOW_AUTO_WITHDRAW=false
```

**Safety** — `TRADING_MODE=dry_run`, `LIVE_TRADING=false`, `ALLOW_ORDER_SUBMISSION=true`.

**Strategy** — all timeframes configurable; `TRIGGER_TIMEFRAME` **excludes `1m` at
the schema level**, so a 1-minute primary trigger is not merely discouraged but
unrepresentable.

### Everything tunable lives in config — enforced by tests

There are **108 schema keys**, all documented in [`.env.example`](.env.example). No
behavioural constant is hidden in the code: swing window, structure lookback, projectable
fraction, funding interval, expected holding time, trailing activation and buffer, stop
and emergency bounds, the minimum order notional, the maintenance-margin fallback, the
depth band, all five liquidity-score weights and their saturation multiples, breadth
quote and orderbook fetch limits, tick/candle/report cadences, the health stall
threshold, HTTP timeouts, circuit-breaker thresholds and cooldowns, pool-state TTL, and
the Lark retry policy are all settings.

Two invariants keep it that way, and both are tests rather than conventions:

1. **No dead keys** — `tests/unit/config.test.ts` scans the schema and asserts every key
   is read somewhere outside `config.ts`. A declared-but-unread key is worse than a
   missing one: it looks configurable and silently is not. This caught three real
   offenders while the change was being made (`MIN_RECENT_VOLUME_USD`,
   `STOP_TRIGGER_OFFSET_BPS`, and a validated-only `MAX_ACTIVE_MARKET`, which is now
   explicitly allowlisted with its reason).
2. **No undocumented keys** — the same file asserts `.env.example` and the schema agree
   in both directions, so a new setting cannot be added without documenting it.

Changing a value demonstrably reaches the code: `TICK_INTERVAL_MS=1000` changes the
observed loop interval, `SWING_LEFT_BARS` changes the strategy's swing window, and
`MIN_ORDER_NOTIONAL_USD` changes the RiskEngine's floor.

Startup refuses to run when configuration is unsafe or inconsistent, and reports
*every* problem at once. The checks that will stop you:

| Condition | Why |
| --- | --- |
| `TARGET_VOLUME_USD != 0` | Targeting volume is wash trading. Volume is a by-product. |
| `ALLOW_AUTO_WITHDRAW=true` | This system never withdraws. |
| `LIVE_TRADING=true` without `TRADING_MODE=live` | Contradictory intent, almost certainly a mistake. |
| `TRADING_MODE=live` without a signing key or wallet address | Cannot work; must not start half-armed. |
| `ARCUS_API_KEY` disagreeing with the derived public key | Catches "right key, wrong file" before it becomes a 401 mid-session. |
| Non-positive `RISK_PER_TRADE_BPS` / `DAILY_LOSS_LIMIT_BPS`, absurd leverage | Misconfiguration. |
| Inverted timeframe ordering, or `EMA_FAST >= EMA_MID >= EMA_SLOW` | Nonsensical indicator stack. |
| `TRIGGER_TIMEFRAME=1m` | Disallowed for the first version. |
| `MAX_ACTIVE_MARKET != 1` | The runtime tracks a single active market; refusing beats silently ignoring the request. |

---

## State machine

### Order lifecycle

The engine publishes **two** overlapping vocabularies, and using the wrong one is a
real bug:

- `order.status` — wide, event-flavoured, includes transient ACKs (`ACK`,
  `PENDING`, `CANCEL_PENDING`, `ERROR`) and TPSL values.
- `order.state` — **engine-authoritative**, five values
  (`OPEN | PARTIALLY_FILLED | FILLED | CANCELED | REJECTED`), documented as stamped
  on every streaming update.

**The local machine is driven off `state`**, falling back to `status` only for the
ACK-shaped frames that arrive before the engine speaks.

```
        create()                                        venue REJECTED / ERROR
           │                                                      │
           ▼                                                      ▼
   ┌────────────┐  ACK / PENDING                        ┌──────────────┐
   │    NEW     │───────────────┐                       │   REJECTED   │
   └────────────┘               ▼                       └──────────────┘
                        ┌────────────────┐   state=PARTIALLY_FILLED
                        │ ACKNOWLEDGED   │───────────────┐
                        └────────────────┘               ▼
                              │  ▲                ┌──────────────────┐
      markCancelRequested()   │  │  state=OPEN    │ PARTIALLY_FILLED │
                              ▼  │  (never        └──────────────────┘
                     ┌───────────────────┐  downgrades      │ state=FILLED
                     │ CANCEL_REQUESTED  │  a cancel)       ▼
                     └───────────────────┘          ┌──────────────┐
                              │ state=CANCELED       │   FILLED     │
                              ▼                      └──────────────┘
                     ┌──────────────┐
                     │   CANCELED   │        local TTL expiry → EXPIRED
                     └──────────────┘
   any unrecognised status ────────────► ┌───────────────────────────────┐
                                          │ UNKNOWN_RECONCILE_REQUIRED    │
                                          └───────────────────────────────┘
                                                (blocks new positions)
```

Two details that are easy to get wrong, both implemented and tested:

- A **cancel request is never downgraded back to acknowledged** by a later `OPEN`
  frame — otherwise the system would re-send cancels forever.
- Read paths report resting GTT orders as **`GTC`** (the legacy name for the same
  bucket). Normalising through `normalizeTif()` is load-bearing: a naive string
  comparison would flag every resting order as drifted and block all trading.

### Connection lifecycle

```
idle → connecting → connected ⇄ reconnecting → degraded
                        │             │            │
                        └─────────────┴────────────┘
                              closed (deliberate)
```

Readiness is **snapshot-based**. The reply to `subscribe` carries `contents` = the
initial snapshot; there is no bare acknowledgement. A channel counts as ready only
once a frame with `contents` has arrived, so the strategy can never evaluate a
half-populated local view. `isReady` additionally requires *every* desired channel
to have delivered one.

### Position exit plan

`PositionManager` owns the exit half of a trade, because the executor cannot express it
— exit state is carried ACROSS fills. The brief's plan is implemented literally:

| Step | Implementation |
| --- | --- |
| TP1 at 2R closes 50% | a reduce-only `GTT` limit at `entry + 2R`, sized to the open position |
| TP2 at 3R | placed only once TP1 is **detected** as filled |
| remainder trails | on the 9 EMA of the structure timeframe, after a 0.5R activation move |
| all exits reduce-only | set by the executor on every exit leg and asserted in reconciliation |

**The inference problem, and how it is resolved.** The venue does not say which position
a reduce-only fill closed — a fill carries `closedPnl` and `positionEffect`, not a
position id. So progress is derived from the position's own numbers: the size and
average entry are captured when a position is first seen, and TP1 counts as filled once
the size falls to the configured remainder. Every inference is monotonic (once TP1 is
done it stays done) and every write is guarded, so a restart re-derives the same state
from the venue instead of replaying actions. When progress cannot be established, the
manager does nothing and logs why — a stop that quietly widens is far worse than a
missed trailing update.

**Two invariants get explicit enforcement:**

1. **A trailing stop may only move favourably.** For a long, up; never down. A "trail"
   that widens risk is the single most dangerous plausible bug here, so the comparison
   happens before any submission and a refusal is a log line, not an attempt.
2. **Take-profit legs never stack.** A partially filled TP keeps resting with a reduced
   `remainingSize` — that is the venue's semantics — so placing a second leg at the same
   target would double the exit intent. Whenever any TP leg is live, the manager leaves
   it alone.

Replacing a stop is ordered **place-then-cancel**, deliberately: cancelling first would
open a window with no protection, whereas the reverse can only ever over-protect for an
instant. Take-profit placement is also ordered to never pre-empt protection, and a
failed take-profit is a retried `blocked` action rather than a reason to flatten — the
stop is the risk control, not the target.

Emergency flattening is narrow on purpose. Reconciliation drift blocks NEW entries, which
is the documented requirement; flattening on drift alone would convert a bookkeeping
discrepancy into a realised loss. It escalates to a reduce-only IOC only when drift
coincides with an automatic kill-switch trip AND the discrepancy is a missing stop or a
position-size mismatch.

### Entry gate

`Runtime.deriveEntryGate()` is a single function returning the list of reasons new
positions are blocked. It exists as one function so the brief's fail-closed list can
be audited line by line instead of being scattered. It is empty only when entry is
permitted.

---

## Risk formulas

Position sizing, exactly as specified:

```
riskBudget          = accountEquity * RISK_PER_TRADE_BPS / 10000
stopDistance        = abs(entryPrice - stopPrice)
quantityByRisk      = riskBudget / stopDistance
quantityByNotional  = accountEquity * MAX_NOTIONAL_PCT / 100 / entryPrice
freeCollateralLimit = min(usableCollateral * MAX_LEVERAGE / entry, equity * MAX_LEVERAGE / entry)
                      where usableCollateral = max(freeCollateral - MIN_FREE_COLLATERAL_USD, 0)
leverageLimit       = accountEquity * effectiveLeverage / entry

finalQuantity = min( quantityByRisk, quantityByNotional, freeCollateralLimit,
                     marketMaxPosition, arcusMaxPosition, leverageLimit )
                floored to stepSize
```

Rounding is **always down** (`floorToStep`), so rounding can only ever reduce risk.
The winning constraint is reported by name (`bindingConstraint`), because "size is
zero" is otherwise impossible to attribute.

### Cost model

An entry is refused unless `expectedMove > totalEstimatedCost`, where

```
totalEstimatedCost = estimatedEntryFee     (maker rate only for an ALO entry)
                   + estimatedExitFee      (always taker: stops cross the book)
                   + estimatedSpreadCost   (half-spread × crossing legs)
                   + estimatedSlippage     (configured bps × crossing legs)
                   + expectedFundingCost   (|rate| × payment count, charged AGAINST us)
                   + safetyBuffer          (configured bps)
```

Deliberate assumptions: the exit is a **taker** (assuming a maker exit would
understate cost exactly when a fast move is against us); funding is charged as an
absolute value (a favourable sign can invert before exit); and a maker entry is
recorded as possibly **not filling at all**.

### Risk metrics

```
dailyLossLimit        = accountEquity * DAILY_LOSS_LIMIT_BPS / 10000
equityChangeBps       = abs(currentEquity - previousEquity) / previousEquity * 10000
riskAtStopBps         = (finalQuantity * stopDistance) / accountEquity * 10000
maxDrawdown           = max over the window of (peak - equity) / peak,
                        computed on equity with cash flows REMOVED
withdrawable          = equity - usedMargin - maintenanceBuffer
                        - worstCaseStopLoss - equity * WITHDRAWABLE_SAFETY_RESERVE_PCT/100
```

`maxDrawdown` and the daily-loss breaker both deliberately exclude cash flows: a
deposit must not clear a losing day, and a withdrawal must not masquerade as a
drawdown. The daily-loss breaker reads **realized trading PnL only**, which is
derived from fills — deposits live in a separate table and cannot reach it. There are
tests for both properties.

---

## The entry gate: every "do not trade" condition

Mapped one-to-one against the brief. Any one of these blocks new positions; none of
them blocks *reducing* risk.

| Condition | Enforced by |
| --- | --- |
| WebSocket 断开 | `ws.isConnected` / `isReady` |
| 数据超过 `MAX_DATA_AGE_MS` | account / positions / quote / metadata freshness |
| `account` 查询失败 | freshness, or a reconciliation failure |
| `positions` 与本地不一致 | `Reconciler` (`position_market_missing_locally`, `position_size_mismatch`, `position_side_mismatch`) |
| `openOrders` 与本地不一致 | `Reconciler` (`order_missing_locally`, `order_missing_at_venue`, `order_state_mismatch`) |
| 止损订单缺失 | `Reconciler` (`missing_protective_stop`) — blocking |
| 触发日亏损限制 | daily-loss breaker → latches the kill switch and writes the sentinel |
| 连续亏损达到上限 | `consecutiveLosses >= MAX_CONSECUTIVE_LOSSES` |
| 账户权益不足 | `RiskEngine` equity / free-collateral checks |
| RWA off-hours 且未开启 | `isOutsideRth` (read from the venue, never computed), plus the `null` rule below |
| rate-limit pool 接近耗尽 | `TradingPoolGuard` |
| market metadata 过期 | `MAX_MARKET_METADATA_AGE_MS` |
| API 签名失败 | no signer, or `orderSubmissionAllowed=false` |
| 止损未确认 | `Executor` marks the market UNPROTECTED; no further exposure may be added |
| reconciliation 无法执行 | `Reconciler.failed()` — a missing read is a FAILURE, not a pass |

One asymmetry is deliberate: **reduce-only exits and entry-order cancellation are
always permitted**, even with the kill switch engaged. A switch that exists to reduce
risk must never block reducing risk.

### Off-hours, including the `null` case

`isOutsideRth` is read from the market payload and is **never inferred from
wall-clock time**. The live payload returns `null` for markets without a session
calendar, and the safe reading of `null` is **unknown, not "open"** — so a `null`
flag is treated as off-hours for *entry* purposes and reported distinctly. Assuming
"open" is exactly how an off-hours order would slip past the rule meant to stop it.
The off-hours margin multiplier is read from `offHoursInitialMarginFraction`, never
hardcoded.

---

## Daily report

Sent to Lark as an interactive card (card JSON 2.0: `schema`, `header`, and
`body.elements` of `{tag:"markdown"}` blocks), with a text fallback.

**Idempotency** is `reportDate | wallet | accountIndex`, recorded in SQLite. A PM2
restart cannot resend. The failure path is layered: card → text → local outbox with
retry. **Reporting never blocks the trading loop**, and a send failure cannot
interrupt order management.

### Example output (real, from this repository)

Rendered by `pnpm report --once` against live mainnet public data, with an
unwhitelisted account so the account-scoped sections are honestly empty:

```text
ArcusTrader daily report — 2026-10-13

**Mode** `dry_run`  |  **LIVE** `false`  |  **Exchange** `https://api.arcus.xyz`
**Account** `0x11111111…` #0
**Generated** 2026-10-13T09:00:00.883Z (Asia/Shanghai)

**Account**
- Equity: **0**
- Free collateral: 0
- Used margin: 0
- Maintenance margin (est.): 0
- Net quote balance: 0

**PnL breakdown** (kept separate on purpose — a deposit is not profit)
- Trading PnL (realized): **0**  (n/a)
- Unrealized PnL: 0
- Fees: 0
- Funding: 0
- Estimated slippage: 0
- **Net trading PnL: 0**
- Deposits today: 0
- Withdrawals today: 0
- Net deposits (lifetime): 0
- Cash-flow adjusted return: n/a

**Activity**
- Fills: 0  |  Gross volume: 0
- Maker ratio: 0%
- Win rate: 0%  |  Profit factor: n/a
- Max drawdown: 0%
- Consecutive losses: 0
- Average hold: n/a

> Volume above is a **by-product** of real strategy trades. There is no volume
> target (`TARGET_VOLUME_USD=0`); this system does not trade to generate volume.

**Positions**
- None

**Strategy & system**
- Strategy state: `starting`
- Active market: none
- Data age: n/a (limit is MAX_DATA_AGE_MS)
- WebSocket: `connected` ready=false reconnects=0 errorFrames=5
- Kill switch: clear

**Decision pipeline**
- Evaluations: 0  |  no signal: 0
- Rejected by cost: 0  |  rejected by risk: 0
- Approved: 0

**Rate limits & reconciliation**
- IP weight: 900 / 900 remaining | throttled 0x
- Order pool remaining: not read | Cancel pool remaining: not read
- Reconciliation: **FAILED** (1 blocking)
- Unknown orders: 0

**Candidate markets**
- None
- Any market outside RTH: no  |  off-hours entries allowed: `false`

**Theoretical withdrawable balance** (informational only — this system never
withdraws)
- Withdrawable: **0**
- Deductions: equity=0, usedMargin=0, maintenanceBuffer=0, worstCaseStopLoss=0,
  safetyReserve=0, withdrawable=0

**Points** (non-cash observation metric — NOT revenue)
- Points status: `UNAVAILABLE` (no Points API was found in the Arcus documentation)
- Points are excluded from every PnL figure above.
- Did Points change any trading decision today? **NO** — no code path reads a
  Points value, and Points can never be a reason to trade.

**Anomalies & handling**
- REST host is MAINNET (https://api.arcus.xyz) but mode is dry_run…
```

Every field the brief requires is present. Note the structural choices:

- **Trading PnL, funding, fees, deposits and withdrawals are separate lines** and are
  never summed into a headline profit figure — a deposit that reads as profit is how
  a losing system looks break-even.
- **Points is `UNAVAILABLE`** and labelled non-cash, because the Arcus documentation
  fetched for this project contains no Points API. The brief requires the "did Points
  change a decision" answer to be displayable as NO; that is hardcoded from the
  design, since **no code path reads a Points value**, so there is nothing to infer.
- Volume is explicitly framed as a by-product, restating `TARGET_VOLUME_USD=0`.

### Lark integration facts (verified against `open.larksuite.com`)

- Token: `POST /open-apis/auth/v3/tenant_access_token/internal`, response is **flat**
  with no `data` wrapper; `expire` is **seconds** (7200). Refreshed proactively inside
  a 30-minute margin.
- Send: `POST /open-apis/im/v1/messages?receive_id_type=chat_id`, header
  `Authorization: Bearer <token>`.
- **`content` must be a JSON *string*, not an object** —
  `JSON.stringify({text})` / `JSON.stringify(card)`. This is the single most common
  integration bug and has a dedicated test.
- Branch on `code`, never on `msg`. HTTP 429 carries `code: 99991400` and
  `x-ogw-ratelimit-reset`. Invalid-token codes (99991663, 99991677, 99991671,
  99991661, 99991665, 20005, 4001) trigger **exactly one** refresh-and-retry, never a
  loop.
- The secret and token are never logged, and value-level redaction catches a token the
  server echoes back.

---

## Replay and backtesting

Two tools, deliberately separate:

- **`tools/backtest.ts`** — fetches real Arcus history and runs the strategy through the
  replay engine. This is the tool that answers "is the strategy viable?".
- **`tools/replay.ts`** — the offline, deterministic engine plus a CLI for a scenario
  file. It never touches the network.

```bash
# real history, 6 markets, ~4 months, three fill assumptions side by side
pnpm backtest --triple

# a single assumption, custom window
pnpm backtest --months 6 --markets BTC-USD,ETH-USD --maker-fill 0.7

# offline scenario file
pnpm replay --help
pnpm replay --file scenario.json --trades
```

The backtest pages `GET /v1/candles` backwards (the API caps a request at 1500 bars and
returns newest-first), drops forming bars, and sorts ascending so indicators see
chronology. `GET /v1/candles` returns bars in **descending** order — relying on the
delivery order would feed every indicator a reversed series.

Reported metrics: gross PnL, net PnL, fees, funding, slippage, win rate, profit
factor, max drawdown, **maker fill rate**, average holding time, **adverse selection
after fill**, results **grouped RWA vs crypto**, **grouped RTH vs off-hours**,
and per-category / per-session grouping.

Modeling rules are conservative and documented in-file (A1–A15):

- **No lookahead** — a signal is evaluated at a closed bar; the entry can only fill on
  a *later* bar whose range touches the limit.
- **Ambiguous bar → stop wins.** If a bar contains both the stop and a target, the
  stop is assumed. Never assume the favourable outcome when the outcome is unknown.
- **Maker fills are probabilistic and deterministic** (FNV-1a hash of
  market|bar|price, never `Math.random`), so replay is reproducible.
- **Fees are real** — the taker rate on exits; the taker rate on an entry that
  crossed. Funding is charged as an absolute value.
- **Points contribute exactly `'0'`**, with a test proving `netPnl` is unchanged when
  Points data is present.

> **Known modelling difference.** The replay runner applies a trailing stop once a
> configured ATR multiple is set, starting after TP1. The live `PositionManager` trails
> on the 9 EMA of the structure timeframe after a 0.5R activation move. The two are
> deliberately separate models — replay is for signal and cost analysis, not a
> bit-exact simulation of the live exit path — but a replay result should not be read as
> a prediction of the live trailing behaviour. Reconciling them is the first item in
> [Open questions](#unconfirmed-api-fields-and-open-questions).

---

## Backtest results — the strategy is NOT viable as specified

Measured on **real Arcus candles**: 6 liquid markets (BTC, ETH, SOL, SPY, NVDA, QQQ),
~4 months (2026-06-02 → 2026-10-24), 11,529 trigger bars per market, 50% of TP1 banked at
2R, TP2 at 3R, real base-tier fees (maker 0 / taker 2.25 bps), slippage 3 bps and funding
charged against us.

| Variant | Trades | Win rate | Profit factor | Net PnL | Stop exits | Net edge |
| --- | --- | --- | --- | --- | --- | --- |
| Baseline (stop = swing − 0.5 ATR), 2026-10-25 fees | 134 | 27.6% | 0.53 | **−900** | 78% | — |
| Stop 1.5 ATR | 82 | 30.5% | 0.69 | −389 | 74% | — |
| Stop 1.5 ATR + trail 2 ATR | 89 | 30.3% | **0.75** | −346 | 70% | — |
| Stop = 20-bar structure extreme | 54 | 29.6% | 0.44 | −519 | 76% | — |
| Stop = 40-bar structure extreme | 27 | 22.2% | 0.30 | −379 | 74% | — |
| 20-bar stop + trail | 64 | 29.7% | 0.58 | −442 | 69% | — |

The baseline row uses the fee tier read live on 2026-10-25: **maker 1.5 bps / taker 4.5 bps**
(150 / 450 ppm). The earlier rows in the table were produced with the tier that was live a
week before (0 / 2.25 bps); the strategy lost money under both, and the fee increase made
it worse (−784 → −900).

Figures are the sum over six independent per-market runs starting at 10,000 each, with
`--maker-fill 0.7`. **Every market lost money in the baseline run** (BTC −148, ETH −8,
SOL −94, SPY −85, NVDA −205, QQQ −243).

### What "the loss is small" actually means

A −900 total on 60,000 of deployed capital (−1.5%) looks tolerable, and the worst
single-market drawdown was 3.0%. Those numbers are small **because the trade count is
small**, not because risk is controlled. The correct unit is expectancy:

```
avg R per trade        = −0.45R
1R                     = RISK_PER_TRADE_BPS = 0.25% of equity
expectancy per trade   = −0.45 × 0.25% ≈ −0.11% of equity
≈22 trades / 4 months  ≈ −2.5% / 4 months
annualised             ≈ −7.5% / year, before compounding
```

A negative expectancy does not stay "within 10%" — it grinds down proportionally to the
number of trades taken. The comparison that matters is **not** "this lost less than my
manual trading", it is **"doing nothing returns 0%"**.

With the account's current 369 USDG and 25 bps risk, 1R is about 0.92 USD, so the expected
loss is roughly 0.41 USD per trade against a round-trip fee of about 0.06 USD on a ~92 USD
notional. The strategy has to be right about direction more often than 42% to pay for that,
and it was right 28% of the time.

### Why this is a real result, not a modelling artefact

Three checks were run specifically to try to invalidate it:

1. **Intrabar ambiguity.** When one 15m bar contains BOTH the stop and a target, the
   engine resolves to the stop. That rule could manufacture losses, so it is now counted:
   **1 of 106 stop exits (1%)** in the baseline and **0 of 62** in the best variant. The
   result does not rest on ambiguity.
2. **Fill assumptions.** Every touched ALO filling (upper bound), 70%, and 40% all lose:
   net −768 / −822 / −800, PF 0.58 / 0.56 / 0.58. Optimistic fills do not save it.
3. **Not merely costs.** Gross PnL before fees, funding and slippage is already negative
   (−501). Costs add a further 283, so the *signal itself* is unprofitable.

### The arithmetic

Observed payoff is **+1.61R on winners and −1.17R on losers**, which needs a **42% win
rate** to break even. The strategy delivered **28.9%** — about what an *unconditional*
entry with a 1R stop and 2R target produces. The four-gate confirmation (4h EMA stack,
pullback zone, 15m reversal, cost model) is not adding predictive information on this
sample.

### What was tried and did not work

Widening the stop and adding a trailing exit improved profitability (PF 0.57 → 0.75) but
never reached break-even. Deeper structural stops made it *worse*: with a wider
invalidation the 2R target moves further away, so the win rate falls faster than the
payoff ratio rises.

> **Do not keep tuning these parameters.** Six variants were tested and all lost; a
> seventh that looks positive on 135 trades would be a multiple-comparison artefact, not
> an edge. Any further search needs out-of-sample data and a pre-registered hypothesis.

### Recommended next experiments (in order)

1. **Replace the 15m trigger with a 1h close confirmation.** A single 15m rejection bar is
   a weak confirmation; requiring the *structure* timeframe to confirm removes one layer
   of noise.
2. **Add a volatility-regime filter.** Trade only when realised volatility or the ATR
   percentile sits inside a band, so the strategy is not fighting chop.
3. **Test the opposite hypothesis as a control.** If entering pullbacks loses, does
   *fading* the same setup win? A control tells you whether the signal is informative but
   inverted, or simply uninformative.
4. **Re-run on 12+ months and more markets** before believing any single variant. The
   current sample is ~135 trades — enough to reject, not enough to confirm a variant.
5. **Measure the adverse-selection mechanism directly.** Mean adverse excursion after
   fill was 0.28R, consistent with the limit order filling *because* price kept going —
   the price of a passive fill. Compare maker versus taker entries on the same signals.

**Conclusion: do not enable live trading on this strategy.** The system is safe to run in
`dry-run`/`shadow` and will correctly refuse every order, but the signal has no
demonstrated edge after costs.

---

## Deployment readiness

State as of 2026-10-25, tested against the live account
an account address (redacted — this repository is public; the address is public
on-chain data, but there is no reason to bundle it with the source).

| Check | Result |
| --- | --- |
| Address is whitelisted for account reads | **PASS** — `/v1/account` returns 200 |
| Account readable | **PASS** — equity 369.34 USDG, lifetime deposits 503.98, 0 positions, 0 open orders |
| `/v1/positions` | **PASS** after a schema fix: it returns a **map**, not the documented array |
| `/v1/rateLimit` | **PASS** after a schema fix: it returns `used`/`cap`, not `capacity`/`remaining` |
| Fee tier | **PASS** — base tier maker 1.5 bps / taker 4.5 bps |
| `GET /v1/markets` | **PASS** — 70 markets (28 crypto, 34 equities, 4 commodities, 4 indices) |
| Server clock skew | **PASS** — 139 ms |
| **Order signing** | **BLOCKED — see below** |
| Live trading | **DISABLED** |

### The one hard blocker: the signing key is missing

The value supplied is the **public API key**, not the private signing key:

- `GET /v1/apiKeys?address=…` lists the supplied value as the registered `apiKey`
  (the public half).
- Sending that value as `X-API-Key` is recognised by the gateway (it returns
  `invalid order signature`, not `Invalid API key`).
- Deriving a public key *from* that value and sending it instead returns `Invalid API key`,
  because the derived key was never registered.

So the gateway knows the key but no request can be signed with it. To trade you need the
**API Signing Key** — the 32-byte Ed25519 seed shown **once** when the key was created
(the web app labels it "API Signing Key" and labels the other value "API Key"). If it was
not saved, revoke the key and create a new one, saving the signing half this time.

Put it in `ARCUS_API_SIGNING_KEY` and nothing else: the system derives the public key from
it and refuses to start if `ARCUS_API_KEY` disagrees.

### Sharing a subaccount with manual trading halts the bot

The daily-loss breaker reads **every fill on the account**, including your own manual
trades. On this account it was observed tripping legitimately: realised PnL for the day
was **−49.19** against a limit of **−3.69** (100 bps of 369.34 equity). A bot with 369
equity therefore has a 3.69 USD daily loss budget, and one manual loss larger than that
halts it for the rest of the UTC day.

Two consequences:

- Use a **dedicated subaccount** (`ARCUS_ACCOUNT_INDEX`) for the bot, with its own API key,
  so manual trading and automated risk budgets do not share a limit.
- A dry-run no longer *writes* the `STOP_TRADING` sentinel when the breaker trips: a
  read-only process must not leave a persistent halt behind for the next live start. It
  latches in-process and says so. A live process still writes it, which is the point.

### Going-live checklist (all items required)

1. `ARCUS_API_SIGNING_KEY` set to the **signing** half, and `pnpm preflight` returns PASS.
2. `ARCUS_WALLET_ADDRESS` and `ARCUS_ACCOUNT_INDEX` set.
3. Strategy evidence: a strategy with positive expectancy, or an explicit written decision
   to trade a negative one. The current strategy does **not** have positive expectancy.
4. At least two weeks of `shadow` on this account, compared against the backtest.
5. `REQUIRE_ORDER_POOL_READ` set according to whether `/v1/rateLimit` is readable (it is,
   on this account).
6. `TRADING_MODE=live`, `LIVE_TRADING=true`, and `--confirm-live` on the command line.
7. Lark credentials set, and one test report delivered.
8. Kill switch rehearsed: `pnpm kill`, confirm entries are cancelled, then `pnpm reset-kill`.

---

## Testing

```bash
pnpm test             # 522 tests, 11 files
pnpm test:safety      # the fail-closed suite alone
pnpm test:unit        # unit suite
pnpm typecheck        # tsc --noEmit, strict + noUncheckedIndexedAccess
```

```
 ✓ tests/safety/fail-closed.test.ts (93 tests)
 ✓ tests/unit/replay.test.ts        (76 tests)
 ✓ tests/unit/lark.test.ts          (94 tests)
 ✓ tests/unit/indicators.test.ts    (84 tests)
 ✓ tests/unit/signer.test.ts        (41 tests)
 ✓ tests/unit/arcus-client.test.ts  (33 tests)   ← pins the live wire shapes
 ✓ tests/unit/arcus-ws.test.ts      (29 tests)   ← pins no-crash + readiness
 ✓ tests/unit/runtime-loop.test.ts  ( 7 tests)   ← pins the loop actually looping
 ✓ tests/unit/position-manager.test.ts (32 tests) ← pins the exit plan and its invariants
 ✓ tests/unit/health.test.ts        (16 tests)   ← pins the 200/503 policy
 ✓ tests/unit/config.test.ts        (17 tests)   ← pins no-dead-keys + wiring

 Test Files  11 passed (11)
      Tests  522 passed (522)
```

Coverage against the brief's required test list:

| Required | Where |
| --- | --- |
| Arcus 签名测试 | `signer.test.ts` — golden byte-vectors for both schemes, ns-precision regression |
| tickSize / stepSize 精度测试 | `fail-closed.test.ts` → *tick and step precision*, incl. a float-trap proof |
| EMA / ATR / AVWAP 测试 | `indicators.test.ts` — hand-computed vectors |
| 回调识别测试 | `replay.test.ts`, `fail-closed.test.ts` → *strategy symmetry* |
| 多空对称性测试 | `fail-closed.test.ts` → *strategy symmetry*; `replay.test.ts` mirror case |
| 动态账户权益测试 | `fail-closed.test.ts` → *dynamic equity* |
| 存取款不影响历史 PnL 统计 | `fail-closed.test.ts` → *deposits do not reset the daily loss* |
| RWA off-hours 测试 | `fail-closed.test.ts` → *RWA off-hours* (incl. the `null` case) |
| funding 成本测试 | `fail-closed.test.ts`, `replay.test.ts` (funding charged, never credited) |
| ALO 订单测试 | `fail-closed.test.ts` → *reduce-only enforcement* (`t=3` ALO, `t=2` IOC) |
| partial fill 测试 | `fail-closed.test.ts` → *order state machine* |
| reduce-only 测试 | `fail-closed.test.ts` → *reduce-only enforcement*, reconciliation |
| stop-loss 缺失时 fail-closed | `fail-closed.test.ts` → *missing protective stop* |
| Lark token 刷新测试 | `lark.test.ts` |
| 日报幂等测试 | `fail-closed.test.ts` (store), `lark.test.ts` (uuid/idempotency key) |
| WebSocket 断线测试 | `ArcusWsClient` reconnect + readiness logic; `serverError` frame not fatal |
| PM2 重启后 reconciliation | `fail-closed.test.ts` → *reconciliation*, `Reconciler.failed()` |
| daily loss circuit breaker | `fail-closed.test.ts` → *daily loss circuit breaker* |
| dry-run 与 live 隔离测试 | `fail-closed.test.ts` → *live trading is never the default* |
| 无刷量面 | `fail-closed.test.ts` → *no volume-targeting surface* (source scan) |
| Live wire shapes / whitelist / WS frames | `arcus-client.test.ts`, `arcus-ws.test.ts` |
| 止盈 (TP1/TP2) / 移动止损 / reduce-only 退出 | `position-manager.test.ts` |
| 健康检查与故障可见性 | `health.test.ts` |
| 配置集中化 / 无死配置 | `config.test.ts` |

The safety suite is written so the **failing** case is the dangerous one: if a test
there starts failing, the system is unsafe, not merely incorrect.

---

## PM2 deployment

```bash
pnpm install
pnpm build                       # tsc → dist/
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup                      # follow the printed instruction
pm2 logs arcustrader
pm2 restart arcustrader --update-env
```

[`ecosystem.config.cjs`](ecosystem.config.cjs) pins decisions that matter:

- **`exec_mode: 'fork'`, `instances: 1`.** Never cluster this. Two instances would
  both hold a view of one account, both reconcile it, and both try to place the same
  protective stop.
- **`args: 'dry-run'`.** Making live the default in the process file would defeat the
  CLI confirmation flag; an operator must edit `args` to add `--confirm-live`.
- **`kill_timeout: 30000`.** On SIGTERM the runtime finishes the current tick, flushes
  the Lark outbox, closes SQLite, then exits. Killing sooner risks a `-wal` needing
  recovery.
- **Finite `max_restarts` with `min_uptime: '60s'`.** A process that cannot start must
  stop retrying and stay visible in `pm2 list`, rather than flapping and spamming Lark.
- **`max_memory_restart: '1G'`.** Safe because of the next point.

**A PM2 restart does not resume trading.** Every start runs the full startup sequence
— validate env → validate account → markets → account/positions/openOrders/fills →
reconcile → WebSocket snapshots → kill-switch check → *only then* consider an entry.
An automatic kill-switch latch is re-derived from the `STOP_TRADING` sentinel and the
day's realized PnL, so a crash loop cannot produce a "resumed mid-strategy" state.

### Health check (optional)

Set `HEALTHCHECK_PORT` to open a read-only status endpoint on loopback:

```bash
curl -s localhost:9101/health | jq
```

The status code is the useful part, and it is deliberately strict:

| Code | Meaning |
| --- | --- |
| **200** | alive, kill switch clear, reconciliation passing, loop ticking |
| **503** | alive but **not fit to trade** — kill switch engaged, reconciliation failing, or the decision loop has stalled |

So a monitor can alert on `503` alone. Returning 200 for "the process is up" would make
the endpoint decorative, because a bot that has silently stopped trading is exactly the
failure worth paging on. It binds to `127.0.0.1` by default, serves only `/health`
(anything else is 404), and reports credentials as **presence booleans only** — never a
value, prefix or hash.

### Operating the kill switch

```bash
pnpm kill --reason "investigating"   # writes STOP_TRADING + latches in-process
touch STOP_TRADING                   # equally valid; the file is the authority
pnpm reset-kill                      # clears the file and the automatic latch
```

While engaged: **no new positions, no new entry orders, working entry orders
cancelled, existing positions still managed with reduce-only stops.** The automatic
latches (daily-loss, consecutive-loss) are deliberately sticky — a transient
condition that auto-resets is how a system quietly resumes after a blow-up.

---

## Safety model

**Live trading requires all of:**

1. `TRADING_MODE=live`
2. `LIVE_TRADING=true`
3. `--confirm-live` on the command line

The CLI flag is not redundant with the env var: it forces a human to type it at start
time, which is the difference between "the env file says live" and "an operator
intended to go live right now". `dry-run` disables submission regardless of any other
flag.

**Secrets.** `ARCUS_API_SIGNING_KEY`, the wallet private key, `LARK_APP_SECRET` are read from the environment only. They are never written to
code, logs, the database, or the report. Three layers protect them: key-name redaction,
**value-level registration** (so a credential a remote service echoes inside an error
message is still scrubbed), and shape rules for hex keys and `Bearer` tokens. A test
asserts the shipping logger does not emit a registered secret; another asserts a
`Bearer` token quoted in prose is removed.

**What this system deliberately does not do:**

- No volume target. `TARGET_VOLUME_USD` must be `0`, and a non-zero value fails
  startup. Volume is a by-product of real trades.
- No wash trading, self-trading, order-book churn, or cyclic trading. There is no code
  path for it; a source-scanning test asserts no such machinery exists.
- No multiple accounts, and no coordinated or offsetting trading across accounts. One
  `(address, accountIndex)` is configured; there is no second-account concept. (The
  Arcus engine independently rejects self-matches with `SELF_TRADE`.)
- No automatic withdrawals. `ALLOW_AUTO_WITHDRAW` must be `false`; the withdrawable
  balance is computed and **reported only**.
- No Points-driven decisions. Points is a non-cash observation field, reported as
  `UNAVAILABLE`, and never a trading input.
- No 1-minute primary trigger. Excluded at the schema level.
- No market orders for entries. Entries are ALO/post-only, and a signal that has run
  past `MAX_CHASE_ATR` is refused rather than chased.

**Fail-closed posture.** Every safety-relevant read carries an explicit freshness
verdict, and anything not positively verified is treated as drift. A reconciliation
that *cannot run* is a failure, not a pass. An unknown order state blocks trading. A
position without a confirmed stop is flagged UNPROTECTED and no further exposure may
be added to that market.

---

## Unconfirmed API fields and open questions

Honest gaps. None of these blocks `dry-run`; **none may gate `LIVE`.**

1. ~~Account-scoped reads could not be verified live.~~ **RESOLVED 2026-10-25** against a
   whitelisted account. Three wire shapes differed from the docs and were fixed:
   `/v1/positions` returns a **map** (not an array) and `/v1/rateLimit` returns
   `used`/`cap` (not `capacity`/`remaining`), and the fee tier changed from 0/2.25 bps to
   **1.5/4.5 bps**. See [`docs/API_CONTRACTS.md`](docs/API_CONTRACTS.md) §9.13.
2. **Order placement is not live-verified.** Signing is proven against golden vectors,
   and the gateway was probed (it validates the body before the signature), but no
   order has been submitted. Sign a real order on testnet first.
3. **`regularTradingHours` internals.** The live payload returns `null` for every
   market observed, so its sub-fields are unknown. Only the boolean `isOutsideRth` is
   read, and it too can be `null` (handled fail-closed). Session *windows* are not
   implemented.
4. **`cumulativeFunding` sub-fields** on a position were not enumerated. Funding is
   read from `/v1/funding` payments instead, so nothing depends on them.
5. **Which fee tier applies to an account** is not readable without volume data, so
   the **base tier** is used — the most expensive, hence conservative. The live table
   is `{"tiers":[...]}` with **ppm** rates and snake_case names, which differs from
   the spec fragment; both are handled.
6. **`/v1/orders` and `/v1/fills` pagination limits** were not exercised. Ingestion
   requests a bounded window and is idempotent by `tradeId`, so a truncated response
   under-reports rather than double-counts.
7. **`l2Orderbook` delta sequence contiguity** was skimmed. The client resyncs by
   requesting a full snapshot on any gap rather than trusting deltas.
8. **The upstream OpenAPI root document is not retrievable.** The URL `llms.txt`
   advertises (`/api-reference/openapi.yml`) returns **404**. The workaround is
   `tools/merge-openapi.py`, which reassembles the per-endpoint fragments embedded in
   the doc pages (32 operations, 89 schemas). AsyncAPI is intact at
   `/api-reference/asyncapi.yaml`.
9. **Points.** No Points API, field or concept appears in the Arcus documentation
   fetched for this project. The value is therefore genuinely unavailable and is
   reported as such rather than invented.
10. **The API key under test was never confirmed valid.** See
    [Verifying the API connection](#verifying-the-api-connection): mainnet gates on the
    address whitelist before it looks at the key, and testnet rejected it.
11. **The exit path has never touched a live venue.** TP placement, stop resizing and
    trailing are all unit-tested against a typed `Executor` double, and the manager's
    inference rules are tested from both directions — but no take-profit order has been
    submitted, so the venue's `MAP`/`GTT` interaction with a `STOP_LOSS` leg resting on
    the same position is unverified. Test this on testnet first.
12. **`topBookDepthScore` uses a 25 bps band** hardcoded in `depthUsdWithinBand` rather
    than a configurable band. That choice is arbitrary but conservative; a band that is
    too narrow understates depth and therefore excludes markets, which fails safe.
13. **Replay and live trailing differ** (see the note under
    [Replay and backtesting](#replay-and-backtesting)). Replay trails on an ATR multiple
    after TP1; live trails on the structure EMA after a 0.5R move. Making them agree is
    desirable before trusting replay numbers for exit-behaviour decisions.
14. **`MAX_ACTIVE_MARKET` is not enforced.** The active market is sticky for a single
    slot by construction (one `activeMarketId`), so the limit is effectively satisfied,
    but the setting itself is not read. If the system ever manages several active
    markets, this must be wired or removed.

---

## Repository layout

```
src/
  index.ts                     CLI entrypoint (modes, --confirm-live, preflight)
  config/config.ts             env validation, safety guards, secret handling
  app/
    bootstrap.ts               assembly + the mandated startup sequence
    runtime.ts                 the trading loop, the entry gate, position management
    DecisionPipeline.ts        strategy → cost → RiskEngine, in order
  arcus/
    types.ts                   wire types, DERIVED from the docs snapshot
    ArcusSigner.ts             both signing schemes (Scheme 1 / Scheme 2)
    ArcusRestClient.ts         zod-validated REST, typed errors, 429 handling
    ArcusWsClient.ts           snapshot-based readiness, reconnect, RPC ids
    RateLimiter.ts             weight budget, 429 circuit breaker, pool guard
  strategy/
    Indicators.ts              pure Decimal indicators (EMA, ATR, AVWAP, structure)
    StrategyIndicators.ts      the façade the strategy consumes
    PullbackStrategy.ts        trend → zone → trigger, with a full reason trail
    CostModel.ts               pessimistic round-trip cost estimate
  risk/
    RiskEngine.ts              the single mandatory gate; sizing and every limit
    KillSwitch.ts              sentinel file, CLI, automatic latches
    Reconciliation.ts          fail-closed comparison against venue truth
  execution/
    OrderStateMachine.ts       local lifecycle driven off engine `state`
    Executor.ts                ALO entries, reduce-only stops/targets, emergency exits
    PositionManager.ts         the exit plan: TP1/TP2, stop resize, trailing invariants
  market/MarketProvider.ts     metadata, candles, quotes, depth, freshness verdicts
  notifications/
    LarkClient.ts              token cache, retries, card 2.0, redaction
    AlertRouter.ts             dedupe, outbox, never-throw contract
    DailyReport.ts             every mandated report field
  store/
    Sqlite.ts                  driver selection (node:sqlite preferred)
    Store.ts                   fills, cash flows, ledger, report idempotency, outbox
  util/
    decimal.ts                 exact arithmetic, tick/step grids
    redact.ts                  credential redaction primitives
    logger.ts                  pino + unconditional line scrubbing
tools/
  fetch-arcus-docs.mjs         snapshot the official docs
  merge-openapi.py             reassemble the embedded OpenAPI fragments
  backtest.ts                  real-history backtest: fetch candles, run, report
  replay.ts                    offline deterministic replay engine + CLI
tests/
  unit/                        signer, indicators, lark, replay
  safety/fail-closed.test.ts   the properties that must never regress
docs/
  API_CONTRACTS.md             the verified endpoint/field audit trail
  arcus/                       verbatim documentation snapshot + merged OpenAPI
```

### Regenerating the API contracts

The documentation snapshot is a build input, not a vendored afterthought:

```bash
pnpm fetch-docs        # re-fetch docs/arcus/*.md + the AsyncAPI spec + manifest
pnpm merge-openapi     # rebuild docs/arcus/arcus.openapi.merged.json
```

`docs/arcus/manifest.json` records a SHA-256 prefix per file, so a diff after
re-fetching tells you exactly which upstream pages changed — which is how the three
schema discrepancies in this README were found.
