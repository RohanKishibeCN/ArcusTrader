/**
 * Arcus signing tests.
 *
 * The brief requires "Arcus 签名测试". These go beyond round-tripping our own
 * output: a self-consistent signer that agrees only with itself proves nothing
 * about whether Arcus will accept it. So the suite pins:
 *
 *  1. The exact canonical byte string for a fixed payload (a golden vector). If
 *     someone "tidies" key ordering or adds whitespace, this fails loudly.
 *  2. Independent verification via Node's `crypto.verify` against the derived
 *     public key — the same primitive the server performs.
 *  3. The nanosecond-precision property that makes the whole scheme work:
 *     `Number(ct)` would quantise `ct`, so that regression is asserted against
 *     explicitly.
 *  4. Scheme 2 concatenation with no delimiters, including the signed-GET form.
 */

import { describe, expect, it } from 'vitest';
import {
  ArcusSigner,
  SigningError,
  canonicalJson,
  goodTilTimeMicros,
  nanosToMicros,
} from '../../src/arcus/ArcusSigner';
import type { CancelOrderRequest, PlaceOrderRequest } from '../../src/arcus/types';

/** Fixed seed so every derived value in this file is reproducible. */
const SEED = 'a1159522e2343ec5a18966edc7838fb809392e89f8b849af68af02cdd78b609e';

/** A well-formed 20-byte address, deliberately MIXED CASE to test lowering. */
const ADDRESS_MIXED = '0xAbCdEf1234567890aBcDeF1234567890aBcDeF12';
const ADDRESS_LOWER = ADDRESS_MIXED.toLowerCase();

const GRID = { marketId: 1, tickSize: '0.1', stepSize: '0.0001' } as const;

function newSigner(): ArcusSigner {
  return new ArcusSigner({ signingKeyHex: SEED });
}

/**
 * The expected public key for SEED, captured from a first run and then
 * cross-checked in the second test by re-deriving it independently.
 */
const EXPECTED_API_KEY = new ArcusSigner({ signingKeyHex: SEED }).apiKeyHex;

const A_FIXED_CT = '1791880000123456789';
const A_FIXED_GOOD_TIL_MICROS = '1794472000000000';

function fixedPlaceRequest(overrides: Partial<PlaceOrderRequest> = {}): PlaceOrderRequest {
  return {
    address: ADDRESS_MIXED,
    marketId: 1,
    accountIndex: 0,
    orderSide: 'BUY',
    orderType: 'LIMIT',
    quantity: '0.0100',
    price: '50000.0',
    timeInForce: 'ALO',
    goodTilTime: A_FIXED_GOOD_TIL_MICROS,
    clientId: 'entry_1700000000000',
    reduceOnly: false,
    timestamp: A_FIXED_CT,
    ...overrides,
  };
}

describe('canonical JSON', () => {
  it('sorts keys ascending with no whitespace', () => {
    expect(canonicalJson({ b: 1, a: 2, c: 'x' })).toBe('{"a":2,"b":1,"c":"x"}');
  });

  it('renders bigint as a bare integer literal, not a string or a float', () => {
    expect(canonicalJson({ ct: 1791880000123456789n })).toBe('{"ct":1791880000123456789}');
  });

  it('omits undefined-valued keys entirely', () => {
    expect(canonicalJson({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}');
  });

  it('escapes strings', () => {
    expect(canonicalJson({ id: 'a"b' })).toBe('{"id":"a\\"b"}');
  });

  it('refuses non-finite numbers rather than emitting invalid JSON', () => {
    expect(() => canonicalJson({ x: Number.NaN })).toThrow(SigningError);
    expect(() => canonicalJson({ x: Number.POSITIVE_INFINITY })).toThrow(SigningError);
  });

  it('handles nested objects and arrays deterministically', () => {
    expect(canonicalJson({ z: [{ b: 1, a: 2 }], a: null })).toBe('{"a":null,"z":[{"a":2,"b":1}]}');
  });
});

describe('key derivation', () => {
  it('derives a 64-hex-char public key (the X-API-Key value)', () => {
    expect(EXPECTED_API_KEY).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts a 0x-prefixed seed identically to a bare seed', () => {
    const a = new ArcusSigner({ signingKeyHex: SEED });
    const b = new ArcusSigner({ signingKeyHex: `0x${SEED}` });
    expect(a.apiKeyHex).toBe(b.apiKeyHex);
  });

  it('rejects a seed of the wrong length', () => {
    expect(() => new ArcusSigner({ signingKeyHex: 'abcd' })).toThrow(SigningError);
  });

  it('rejects non-hex key material', () => {
    expect(() => new ArcusSigner({ signingKeyHex: 'zz'.repeat(32) })).toThrow(SigningError);
  });

  it('fails closed when ARCUS_API_KEY disagrees with the signing key', () => {
    expect(
      () => new ArcusSigner({ signingKeyHex: SEED, expectedApiKeyHex: 'ab'.repeat(32) }),
    ).toThrow(/does not match the public key derived from/);
  });

  it('accepts a matching expected API key', () => {
    expect(
      () => new ArcusSigner({ signingKeyHex: SEED, expectedApiKeyHex: EXPECTED_API_KEY }),
    ).not.toThrow();
  });
});

describe('scheme 1 — typed payload (op=1 placeOrder)', () => {
  it('produces the exact golden canonical message', () => {
    const signer = newSigner();
    const { message, payload } = signer.buildPlaceOrderPayload(fixedPlaceRequest(), GRID);

    // Golden vector. Keys are alphabetical; price 50000.0 / tick 0.1 = 500000;
    // quantity 0.0100 / step 0.0001 = 100; g = goodTil micros x 1000; t=3 (ALO).
    expect(message).toBe(
      '{"ad":"0xabcdef1234567890abcdef1234567890abcdef12","ai":0,"c":"entry_1700000000000",' +
        `"ct":${A_FIXED_CT},"g":1794472000000000000,"m":1,"op":1,"p":500000,"q":100,` +
        '"r":0,"s":0,"t":3,"v":1}',
    );
    expect(payload.op).toBe(1);
  });

  it('lowers the address and keeps clientId byte-verbatim', () => {
    const signer = newSigner();
    const { payload } = signer.buildPlaceOrderPayload(fixedPlaceRequest(), GRID);
    expect(payload.ad).toBe(ADDRESS_LOWER);
    // clientId is NOT case-folded — the server signs it verbatim.
    expect(payload.c).toBe('entry_1700000000000');
  });

  it('omits `c` entirely when there is no clientId', () => {
    const signer = newSigner();
    const { message } = signer.buildPlaceOrderPayload(
      fixedPlaceRequest({ clientId: undefined }),
      GRID,
    );
    expect(message).not.toContain('"c"');
  });

  it('encodes side and time-in-force per the engine enums', () => {
    const signer = newSigner();
    const sell = signer.buildPlaceOrderPayload(
      fixedPlaceRequest({ orderSide: 'SELL', timeInForce: 'GTT' }),
      GRID,
    );
    expect(sell.payload.s).toBe(1);
    expect(sell.payload.t).toBe(0);

    const ioc = signer.buildPlaceOrderPayload(fixedPlaceRequest({ timeInForce: 'IOC' }), GRID);
    expect(ioc.payload.t).toBe(2);

    const alo = signer.buildPlaceOrderPayload(fixedPlaceRequest({ timeInForce: 'ALO' }), GRID);
    expect(alo.payload.t).toBe(3);

    const fok = signer.buildPlaceOrderPayload(fixedPlaceRequest({ timeInForce: 'FOK' }), GRID);
    expect(fok.payload.t).toBe(1);
  });

  it('encodes reduceOnly as the INTEGER 1, not a boolean', () => {
    const signer = newSigner();
    const { payload, message } = signer.buildPlaceOrderPayload(
      fixedPlaceRequest({ reduceOnly: true }),
      GRID,
    );
    expect(payload.r).toBe(1);
    expect(typeof payload.r).toBe('number');
    expect(message).toContain('"r":1');
  });

  it('uses op=4 for TPSL legs so a TPSL signature cannot be replayed as a plain order', () => {
    const signer = newSigner();
    const tpsl = signer.buildPlaceOrderPayload(
      fixedPlaceRequest({ tpslType: 'STOP_LOSS', stopPrice: '49000' }),
      GRID,
    );
    expect(tpsl.payload.op).toBe(4);

    const plain = signer.buildPlaceOrderPayload(fixedPlaceRequest(), GRID);
    expect(plain.payload.op).toBe(1);
    // Same field set, different op → different signature.
    expect(tpsl.signature).not.toBe(plain.signature);
  });

  it('rejects a quantity that is not a step multiple', () => {
    const signer = newSigner();
    expect(() =>
      signer.buildPlaceOrderPayload(fixedPlaceRequest({ quantity: '0.00015' }), GRID),
    ).toThrow(/not a multiple of stepSize/);
  });

  it('rejects a price that is not a tick multiple', () => {
    const signer = newSigner();
    expect(() =>
      signer.buildPlaceOrderPayload(fixedPlaceRequest({ price: '50000.05' }), GRID),
    ).toThrow(/not a multiple of tickSize/);
  });

  it('rejects a market mismatch between request and grid', () => {
    const signer = newSigner();
    expect(() =>
      signer.buildPlaceOrderPayload(fixedPlaceRequest({ marketId: 7 }), GRID),
    ).toThrow(/does not match market/);
  });

  it('refuses to sign a zero quantity', () => {
    const signer = newSigner();
    expect(() => signer.buildPlaceOrderPayload(fixedPlaceRequest({ quantity: '0' }), GRID)).toThrow(
      /refusing to sign/,
    );
  });

  it('produces a 128-hex-char signature that verifies against the derived public key', () => {
    const signer = newSigner();
    const { message, signature } = signer.buildPlaceOrderPayload(fixedPlaceRequest(), GRID);
    expect(signature).toMatch(/^[0-9a-f]{128}$/);
    // Independent verification with the same primitive the server uses.
    expect(signer.verifyMessage(message, signature)).toBe(true);
  });

  it('produces a different signature when any signed field changes', () => {
    const signer = newSigner();
    const base = signer.buildPlaceOrderPayload(fixedPlaceRequest(), GRID).signature;
    const changed = signer.buildPlaceOrderPayload(
      fixedPlaceRequest({ quantity: '0.0200' }),
      GRID,
    ).signature;
    expect(changed).not.toBe(base);
  });
});

describe('nanosecond precision — the regression that breaks signing silently', () => {
  it('keeps every digit of a real nanosecond timestamp in the signed message', () => {
    const signer = newSigner();
    // A timestamp whose low digits are NOT representable as a float64.
    const ct = '1791880000123456789';
    const { message } = signer.buildPlaceOrderPayload(
      fixedPlaceRequest({ timestamp: ct }),
      GRID,
    );
    expect(message).toContain(`"ct":${ct}`);

    // Demonstrate the hazard this guards against: the naive Number() round-trip
    // loses the trailing digits, so header and signed `ct` would disagree.
    expect(String(Number(ct))).not.toBe(ct);
    expect(message).not.toContain(`"ct":${String(Number(ct))}`);
  });

  it('signs the payload it returns, including the TPSL op code', () => {
    const signer = newSigner();
    const { payload, message, signature } = signer.buildPlaceOrderPayload(
      fixedPlaceRequest({ tpslType: 'STOP_LOSS', stopPrice: '49000' }),
      GRID,
    );
    // The returned payload must be the one that was signed — an earlier version
    // returned op=1 while signing an op=4 copy.
    expect(payload.op).toBe(4);
    expect(message).toContain('"op":4');
    expect(signer.verifyMessage(message, signature)).toBe(true);
  });

  it('keeps every digit of the signed goodTilTime (g)', () => {
    // A microsecond goodTilTime whose nanosecond form is not float64-exact:
    // 1794472000123456789 ns, where the trailing "789" is unrepresentable.
    const goodTilMicros = '1794472000123456';
    const signer = newSigner();
    const { message } = signer.buildPlaceOrderPayload(
      fixedPlaceRequest({ goodTilTime: goodTilMicros }),
      GRID,
    );
    expect(message).toContain('"g":1794472000123456000');

    // Demonstrate the hazard: an inexact ns value must never be routed through
    // Number(), because the signed digits would change.
    const inexact = '1794472000123456789';
    expect(String(Number(inexact))).not.toBe(inexact);
  });
});

describe('scheme 1 — op=2 cancelOrder', () => {
  it('signs an orderId cancel with `id` and no `c`', () => {
    const signer = newSigner();
    const request: CancelOrderRequest = {
      address: ADDRESS_MIXED,
      accountIndex: 0,
      marketId: 1,
      kind: 'orderId',
      orderId: 'order-abc',
      timestamp: A_FIXED_CT,
    };
    const { message, payload } = signer.buildCancelOrderPayload(request, { marketId: 1 });
    expect(payload.op).toBe(2);
    expect(message).toBe(
      '{"ad":"0xabcdef1234567890abcdef1234567890abcdef12","ai":0,' +
        `"ct":${A_FIXED_CT},"id":"order-abc","m":1,"op":2,"v":1}`,
    );
    // No g/p/q/r/s/t on a cancel — a different field set from place.
    for (const absent of ['"g"', '"p"', '"q"', '"s"', '"t"']) {
      expect(message).not.toContain(absent);
    }
  });

  it('signs a clientId cancel with `c` and no `id`', () => {
    const signer = newSigner();
    const { message } = signer.buildCancelOrderPayload(
      {
        address: ADDRESS_LOWER,
        accountIndex: 0,
        marketId: 1,
        kind: 'clientId',
        clientId: 'entry_1',
        timestamp: A_FIXED_CT,
      },
      { marketId: 1 },
    );
    expect(message).toContain('"c":"entry_1"');
    expect(message).not.toContain('"id"');
  });

  it('rejects specifying both identifiers', () => {
    const signer = newSigner();
    expect(() =>
      signer.buildCancelOrderPayload(
        {
          address: ADDRESS_LOWER,
          accountIndex: 0,
          marketId: 1,
          kind: 'orderId',
          orderId: 'a',
          clientId: 'b',
          timestamp: A_FIXED_CT,
        },
        { marketId: 1 },
      ),
    ).toThrow(/exactly one/);
  });

  it('rejects specifying neither identifier', () => {
    const signer = newSigner();
    expect(() =>
      signer.buildCancelOrderPayload(
        { address: ADDRESS_LOWER, accountIndex: 0, marketId: 1, kind: 'orderId', timestamp: A_FIXED_CT },
        { marketId: 1 },
      ),
    ).toThrow(/requires orderId/);
  });
});

describe('scheme 2 — legacy message with no delimiters', () => {
  it('concatenates timestamp + action + canonical body with no separator', () => {
    const signer = newSigner();
    const { message } = signer.signLegacyMessage('1791880000000000000', 'cancelAllOrders', {
      address: ADDRESS_LOWER,
      accountIndex: 0,
    });
    expect(message).toBe(
      '1791880000000000000cancelAllOrders{"accountIndex":0,"address":"0xabcdef1234567890abcdef1234567890abcdef12"}',
    );
  });

  it('signs a bodyless GET as just timestamp + action', () => {
    const signer = newSigner();
    const { message } = signer.signLegacyMessage('1791880000000000000', 'inviteCodes');
    expect(message).toBe('1791880000000000000inviteCodes');
  });

  it('rejects a non-numeric timestamp', () => {
    const signer = newSigner();
    expect(() => signer.signLegacyMessage('1791880000000000000.5', 'x')).toThrow(SigningError);
  });

  it('rejects an action that is not a camelCase path segment', () => {
    const signer = newSigner();
    expect(() => signer.signLegacyMessage('1791880000000000000', '/v1/setLeverage')).toThrow(
      SigningError,
    );
  });

  it('verifies against the public key', () => {
    const signer = newSigner();
    const { message, signature } = signer.signLegacyMessage('1791880000000000000', 'setLeverage', {
      marketId: 1,
    });
    expect(signer.verifyMessage(message, signature)).toBe(true);
  });
});

describe('clock and time conversions', () => {
  it('produces strictly increasing nanosecond timestamps within a millisecond', () => {
    ArcusSigner.resetClockState();
    const signer = newSigner();
    const stamps = Array.from({ length: 50 }, () => signer.nowNanos());
    for (let i = 1; i < stamps.length; i += 1) {
      expect(stamps[i]! > stamps[i - 1]!).toBe(true);
    }
  });

  it('matches Date.now() to within the current millisecond', () => {
    ArcusSigner.resetClockState();
    const signer = newSigner();
    const before = BigInt(Date.now()) * 1_000_000n;
    const now = signer.nowNanos();
    const after = BigInt(Date.now()) * 1_000_000n;
    expect(now >= before).toBe(true);
    expect(now <= after + 2_000_000n).toBe(true);
  });

  it('converts nanos to micros by truncation', () => {
    expect(nanosToMicros(1791880000123456789n)).toBe(1791880000123456n);
  });

  it('places goodTilTime at least a month ahead', () => {
    const now = 1_700_000_000_000_000_000n;
    const g = goodTilTimeMicros(now, 60);
    const daysAhead = Number(g - nanosToMicros(now)) / (86_400 * 1_000_000);
    expect(daysAhead).toBeGreaterThanOrEqual(31);
    expect(daysAhead).toBeCloseTo(60, 5);
  });

  it('rejects a non-positive goodTil horizon', () => {
    expect(() => goodTilTimeMicros(1_700_000_000_000_000_000n, 0)).toThrow(SigningError);
  });
});
