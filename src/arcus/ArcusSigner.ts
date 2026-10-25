/**
 * Arcus request signing.
 *
 * Implements both documented schemes exactly as specified in
 * `docs/arcus/api-reference__authentication.md` and the runnable reference in
 * `docs/arcus/guides__rest-trading.md`. The reference snippets there are the
 * ground truth this file was written against; see `docs/API_CONTRACTS.md` §3.
 *
 *   Scheme 1 — typed payload (placeOrder / cancelOrder / modifyOrder):
 *     signature = ed25519_hex( canonical_payload )
 *     The signing message IS the payload: compact, keys sorted ascending, no
 *     whitespace, no prefix. Prices/sizes are integer ticks/quantums.
 *
 *   Scheme 2 — legacy message (cancelAllOrders / setLeverage / WS authenticate):
 *     signature = ed25519_hex( timestamp + action + canonical_json(body) )
 *     Concatenated with NO delimiters. `action` is the camelCase final path
 *     segment. A signed GET has no body, so the message is `timestamp + action`.
 *
 * Key format: the API signing key is the 32-byte raw Ed25519 SEED in hex, as
 * produced by
 *   openssl genpkey -algorithm ed25519 -out private.pem
 *   openssl pkey -in private.pem -pubout -outform DER | tail -c 32 | xxd -p -c 32
 *
 * Node cannot import a bare seed via JWK (the `x` member is mandatory, verified),
 * so the seed is wrapped in a minimal PKCS#8 PrivateKeyInfo. The public half is
 * then DERIVED from the seed rather than supplied, which removes a whole class of
 * misconfiguration: a config where the stated `ARCUS_API_KEY` disagrees with the
 * signing key is detected at startup instead of surfacing as a 401 mid-session.
 */

import { createPrivateKey, createPublicKey, sign as ed25519Sign, verify as ed25519Verify, type KeyObject } from 'node:crypto';
import {
  SIGNED_OP,
  SIGNED_SIDE,
  SIGNED_TIF,
  type CancelOrderRequest,
  type EpochNanos,
  type MarketId,
  type PlaceOrderRequest,
} from '../arcus/types';
import { toFixedString, toQuantums, toTicks } from '../util/decimal';

/** DER prefix for `PrivateKeyInfo { version 0, Ed25519, SEED }`. 16 bytes. */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export class SigningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SigningError';
  }
}

/**
 * Deterministic JSON with keys sorted ascending and no whitespace.
 *
 * This is the `canonical_json` of Scheme 2 and the construction used for Scheme 1
 * payloads. Sorting is by UTF-16 code unit, which for the ASCII-only field names
 * in these payloads is identical to lexicographic byte order — matching what the
 * server's own canonicaliser produces.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new SigningError(`non-finite number in payload: ${value}`);
    return Number.isInteger(value) ? String(value) : JSON.stringify(value);
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'undefined') {
    throw new SigningError('undefined is not representable in canonical JSON');
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== undefined,
    );
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  throw new SigningError(`cannot canonicalise value of type ${typeof value}`);
}

/** Minimal market grid info required to build a signed payload. */
export interface MarketGrid {
  readonly marketId: MarketId;
  readonly tickSize: string;
  readonly stepSize: string;
}

export interface SignerKeyMaterial {
  /** 32-byte Ed25519 seed, hex (optionally 0x-prefixed). */
  readonly signingKeyHex: string;
  /**
   * Expected API key (hex public key). When provided, it is cross-checked
   * against the derived public key and a mismatch is fatal.
   */
  readonly expectedApiKeyHex?: string;
}

/** Result of a signed request, ready to place on the wire. */
export interface SignedRequest {
  /** The exact UTF-8 bytes that were signed. Useful in tests; never log wholesale. */
  readonly message: string;
  /** Lowercase hex, 128 chars. */
  readonly signature: string;
  /** Unix nanoseconds as a decimal string. */
  readonly timestamp: string;
  /** Unix nanoseconds as a number, for embedding in a request body. */
  readonly timestampNanos: number;
}

export class ArcusSigner {
  private readonly privateKey: KeyObject;
  /** Hex-encoded Ed25519 public key. This IS the `X-API-Key` value. */
  readonly apiKeyHex: string;

  constructor(material: SignerKeyMaterial) {
    const seed = ArcusSigner.parseSeed(material.signingKeyHex);
    this.privateKey = createPrivateKey({
      key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
      format: 'der',
      type: 'pkcs8',
    });
    this.apiKeyHex = ArcusSigner.derivePublicKeyHex(this.privateKey);

    if (material.expectedApiKeyHex) {
      const expected = ArcusSigner.normalizeHex(material.expectedApiKeyHex, 'ARCUS_API_KEY');
      if (expected !== this.apiKeyHex) {
        throw new SigningError(
          'ARCUS_API_KEY does not match the public key derived from ARCUS_API_SIGNING_KEY. ' +
            'Refusing to start: the configured key cannot authenticate with this signing key.',
        );
      }
    }
  }

  private static parseSeed(hex: string): Buffer {
    if (typeof hex !== 'string' || hex.trim() === '') {
      throw new SigningError('signing key is empty');
    }
    const normalized = ArcusSigner.normalizeHex(hex, 'ARCUS_API_SIGNING_KEY');
    if (normalized.length !== 64) {
      throw new SigningError(
        `signing key must be a 32-byte Ed25519 seed (64 hex chars); got ${normalized.length} hex chars`,
      );
    }
    return Buffer.from(normalized, 'hex');
  }

  private static normalizeHex(hex: string, label: string): string {
    const stripped = hex.trim().replace(/^0[xX]/, '').toLowerCase();
    if (!/^[0-9a-f]*$/.test(stripped)) {
      throw new SigningError(`${label} contains non-hex characters`);
    }
    return stripped;
  }

  private static derivePublicKeyHex(privateKey: KeyObject): string {
    const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
    // Ed25519 SPKI is a fixed 12-byte header followed by the 32-byte raw key.
    return spki.subarray(spki.length - 32).toString('hex');
  }

  /* ---------------------------------------------------------------- *
   * Low-level signing
   * ---------------------------------------------------------------- */

  /** Sign arbitrary UTF-8 bytes, returning lowercase hex (128 chars). */
  signMessage(message: string): string {
    return ed25519Sign(null, Buffer.from(message, 'utf8'), this.privateKey).toString('hex');
  }

  /**
   * Verify a signature against this key pair. Used by the known-answer tests and
   * by the preflight self-test; the trading path never verifies its own output.
   */
  verifyMessage(message: string, signatureHex: string): boolean {
    try {
      return ed25519Verify(
        null,
        Buffer.from(message, 'utf8'),
        createPublicKey(this.privateKey),
        Buffer.from(signatureHex, 'hex'),
      );
    } catch {
      return false;
    }
  }

  /**
   * Scheme 1: sign a canonical typed payload.
   *
   * The message signed is exactly `canonicalJson(payload)`, with no trailing
   * delimiter — matching the reference implementation, which signs
   * `payload.encode()` on a string that has no appended newline.
   */
  signTypedPayload(payload: Record<string, unknown>): { message: string; signature: string } {
    const message = canonicalJson(payload);
    return { message, signature: this.signMessage(message) };
  }

  /**
   * Scheme 2: `timestamp + action + canonical_json(body)`.
   *
   * `body` may be `undefined` for a signed GET, in which case the message is just
   * `timestamp + action`.
   */
  signLegacyMessage(
    timestampNanos: string,
    action: string,
    body?: unknown,
  ): { message: string; signature: string } {
    if (!/^[0-9]+$/.test(timestampNanos)) {
      throw new SigningError(`timestamp must be decimal nanoseconds, got ${JSON.stringify(timestampNanos)}`);
    }
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(action)) {
      throw new SigningError(`action must be a camelCase path segment, got ${JSON.stringify(action)}`);
    }
    const message = body === undefined ? `${timestampNanos}${action}` : `${timestampNanos}${action}${canonicalJson(body)}`;
    return { message, signature: this.signMessage(message) };
  }

  /* ---------------------------------------------------------------- *
   * Timestamps
   * ---------------------------------------------------------------- */

  /**
   * Current Unix time in nanoseconds.
   *
   * Derived as `Date.now() * 1e6` plus a small monotonic nudge. `Date.now()` has
   * millisecond resolution, so two orders signed in the same millisecond would
   * otherwise share a `ct` — harmless for the signature, but it makes
   * client-order correlation ambiguous. The nudge keeps `ct` strictly increasing
   * within a process while staying within the server's ±30 s window.
   *
   * Returned as a bigint for exactness: nanosecond epochs exceed 2^53, so a
   * `number` would silently lose precision.
   */
  nowNanos(): EpochNanos {
    const ms = BigInt(Date.now());
    const last = ArcusSigner.lastNanos;
    let candidate = ms * 1_000_000n + ArcusSigner.nanoCounter;
    if (last !== undefined && candidate <= last) {
      candidate = last + 1n;
    }
    ArcusSigner.lastNanos = candidate;
    ArcusSigner.nanoCounter = (ArcusSigner.nanoCounter + 1n) % 1_000_000n;
    return candidate;
  }

  private static lastNanos: bigint | undefined;
  private static nanoCounter = 0n;

  /** Reset the monotonic counter. Test-only; keeps test cases independent. */
  static resetClockState(): void {
    ArcusSigner.lastNanos = undefined;
    ArcusSigner.nanoCounter = 0n;
  }

  /* ---------------------------------------------------------------- *
   * Operation payload builders
   * ---------------------------------------------------------------- */

  /**
   * Build and sign a `placeOrder` (op=1) payload.
   *
   * Field construction notes, each one a documented requirement:
   *  - `ad` is lowercased (the ONLY case-folded field).
   *  - `c` is omitted entirely when there is no clientId.
   *  - `ct` equals the `X-Timestamp` value and the body's `timestamp`.
   *  - `g` is the body's microsecond `goodTilTime` multiplied by 1000.
   *  - `r` is the integer 0/1, not a boolean.
   *  - `p`/`q` are integer ticks/quantums, derived from the same decimal strings
   *    that go into the body, so body and signature cannot disagree.
   */
  buildPlaceOrderPayload(
    request: PlaceOrderRequest,
    market: MarketGrid,
  ): { payload: Record<string, unknown>; message: string; signature: string } {
    if (request.marketId !== market.marketId) {
      throw new SigningError(
        `request.marketId ${request.marketId} does not match market ${market.marketId}`,
      );
    }
    const price = toFixedString(request.price);
    const quantity = toFixedString(request.quantity);

    // Assert grid alignment BEFORE hashing anything: a non-multiple cannot be
    // represented as an integer and would be rejected by the engine.
    const p = toTicks(price, market.tickSize);
    const q = toQuantums(quantity, market.stepSize);

    if (q <= 0) throw new SigningError(`quantity resolves to ${q} quantums; refusing to sign`);
    if (p < 0) throw new SigningError(`price resolves to ${p} ticks; refusing to sign`);

    const goodTilMicros = ArcusSigner.requireMicros(request.goodTilTime, 'goodTilTime');
    const g = goodTilMicros * 1000n;
    const ct = BigInt(request.timestamp);
    if (ct < 1n) throw new SigningError('timestamp must be positive Unix nanoseconds');

    // `ct` and `g` are bigint, not number, and stay bigint through
    // `canonicalJson`, which renders them as bare integers. This is
    // load-bearing: a nanosecond epoch is ~1.79e18, far beyond
    // Number.MAX_SAFE_INTEGER (9.007e15), so `Number(ct)` quantises the low two
    // digits and the signed string would no longer equal the exact
    // `X-Timestamp` the server compares against — signatures would fail
    // nondeterministically as the clock advanced.
    const payload: Record<string, unknown> = {
      ad: request.address.toLowerCase(),
      ai: request.accountIndex,
      ct,
      g,
      m: request.marketId,
      op: SIGNED_OP.PLACE,
      p,
      q,
      r: request.reduceOnly ? 1 : 0,
      s: SIGNED_SIDE[request.orderSide],
      t: SIGNED_TIF[request.timeInForce],
      v: 1,
    };
    // `c` is omitted entirely when empty — not sent as an empty string.
    if (request.clientId) payload.c = request.clientId;

    // TPSL legs are signed with op=4 (OpPlaceUntriggered) over the SAME field set,
    // so a TPSL signature cannot be replayed as a plain order. The mutation
    // happens before signing, and the returned payload is the signed one — an
    // earlier version returned the op=1 object while signing an op=4 copy, which
    // would have made the caller's echoed payload disagree with the signature.
    if (request.tpslType) payload.op = SIGNED_OP.PLACE_UNTRIGGERED;

    return { payload, ...this.signTypedPayload(payload) };
  }

  /** Build and sign a `cancelOrder` (op=2) payload. Exactly one of id / c. */
  buildCancelOrderPayload(
    request: CancelOrderRequest,
    market: Pick<MarketGrid, 'marketId'>,
  ): { payload: Record<string, unknown>; message: string; signature: string } {
    if (request.marketId !== market.marketId) {
      throw new SigningError(
        `request.marketId ${request.marketId} does not match market ${market.marketId}`,
      );
    }
    const hasOrderId = Boolean(request.orderId);
    const hasClientId = Boolean(request.clientId);
    if (request.kind === 'orderId' && !hasOrderId) {
      throw new SigningError('cancelOrder by orderId requires orderId');
    }
    if (request.kind === 'clientId' && !hasClientId) {
      throw new SigningError('cancelOrder by clientId requires clientId');
    }
    if (hasOrderId && hasClientId) {
      throw new SigningError('cancelOrder must specify exactly one of orderId / clientId');
    }

    const ct = BigInt(request.timestamp);
    const payload: Record<string, unknown> = {
      ad: request.address.toLowerCase(),
      ai: request.accountIndex,
      ct,
      m: request.marketId,
      op: SIGNED_OP.CANCEL,
      v: 1,
    };
    if (hasOrderId) payload.id = request.orderId;
    if (hasClientId) payload.c = request.clientId;

    return { payload, ...this.signTypedPayload(payload) };
  }

  private static requireMicros(value: string, label: string): bigint {
    if (!/^[0-9]+$/.test(value)) {
      throw new SigningError(`${label} must be decimal epoch microseconds, got ${JSON.stringify(value)}`);
    }
    const micros = BigInt(value);
    if (micros < 1n) throw new SigningError(`${label} must be positive`);
    return micros;
  }
}

/**
 * Convert a nanosecond epoch to the microsecond resolution the REST bodies use.
 * Truncating (not rounding) keeps the derived value never in the future.
 */
export function nanosToMicros(nanos: EpochNanos): bigint {
  return nanos / 1000n;
}

/**
 * `goodTilTime` for a resting order: now + N days, in microseconds.
 *
 * Arcus requires at least one month ahead, so the default horizon is validated
 * against that floor by config (`ORDER_GOOD_TIL_DAYS >= 31`).
 */
export function goodTilTimeMicros(nowNanos: EpochNanos, days: number): bigint {
  if (!Number.isFinite(days) || days <= 0) throw new SigningError(`invalid goodTil days: ${days}`);
  return nanosToMicros(nowNanos) + BigInt(Math.round(days * 86_400 * 1_000_000));
}
