/**
 * Exact decimal arithmetic for prices, sizes and money.
 *
 * Arcus sends every numeric field as a decimal STRING and validates that order
 * prices land exactly on a `tickSize` multiple and quantities exactly on a
 * `stepSize` multiple. Two consequences drive this module:
 *
 *  1. JavaScript `number` must never touch a price or a size. `0.1 + 0.2 !== 0.3`
 *     is not a curiosity here — it is the difference between an accepted and a
 *     rejected order, and between a correct and an incorrect PnL.
 *  2. Rounding must be explicit and directional. Quantities round DOWN (never
 *     risk more size than risk budget allows); prices are snapped and, where the
 *     strategy cares about not overpaying, snapped conservatively.
 *
 * Decimal.js is configured with 40 significant digits and ROUND_HALF_UP as the
 * global default, but every rate-sensitive helper below chooses its own rounding
 * mode explicitly rather than relying on that default.
 */

import Decimal from 'decimal.js';

Decimal.set({
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -30,
  toExpPos: 40,
});

export { Decimal };
export type DecimalValue = Decimal;

/** Anything that can become a Decimal without a lossy intermediate float. */
export type DecimalLike = string | number | Decimal;

export class DecimalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecimalError';
  }
}

/**
 * Parse into a Decimal.
 *
 * Strings are the intended input. Numbers are accepted for convenience (config
 * values, integer counts) but are stringified first so `Decimal(0.1)` — which
 * would otherwise capture the binary float — is still interpreted as the literal
 * `0.1` the caller wrote. Callers holding a wire value should always pass the
 * original string.
 */
export function dec(value: DecimalLike): Decimal {
  if (value instanceof Decimal) return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new DecimalError(`non-finite number: ${value}`);
    }
    return new Decimal(String(value));
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') throw new DecimalError('empty string is not a decimal');
    try {
      return new Decimal(trimmed);
    } catch {
      throw new DecimalError(`not a decimal: ${JSON.stringify(value)}`);
    }
  }
  throw new DecimalError(`unsupported decimal input: ${typeof value}`);
}

/** Parse, returning `undefined` instead of throwing. For untrusted optional wire fields. */
export function tryDec(value: unknown): Decimal | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  try {
    return dec(value as DecimalLike);
  } catch {
    return undefined;
  }
}

/**
 * True only for a strictly positive value.
 *
 * decimal.js's own `Decimal.prototype.isPositive()` returns **true for +0** (it is
 * sign-based, not magnitude-based), which makes a bare call a NaN hazard: guarding
 * a division with it lets a zero divisor through and yields `Infinity`/`NaN` that
 * can then flow into a price or a size. This helper is the safe form, and every
 * guard in this module uses `greaterThan(0)` for the same reason.
 */
export function isPositive(value: DecimalLike): boolean {
  return dec(value).greaterThan(0);
}

/** True only for a strictly negative value. Excludes -0 for symmetry. */
export function isNegative(value: DecimalLike): boolean {
  const d = dec(value);
  return d.isNegative() && !d.isZero();
}

/**
 * Render a Decimal as a plain (non-exponential) string.
 *
 * Decimal.js switches to exponential notation outside its `toExpNeg`/`toExpPos`
 * window. Either would be sent verbatim and rejected by the API's
 * `^(0|0\.[0-9]*[1-9][0-9]*|[1-9][0-9]*\.?[0-9]*)$` pattern, so this always
 * produces positional notation.
 */
export function toFixedString(value: DecimalLike, dp?: number): string {
  const d = dec(value);
  if (d.isNaN() || !d.isFinite()) {
    throw new DecimalError(`cannot serialise non-finite decimal: ${d.toString()}`);
  }
  if (dp !== undefined) return d.toFixed(dp, Decimal.ROUND_DOWN);
  const s = d.toFixed();
  // Decimal.prototype.toFixed() on an integer yields e.g. "5"; on a fraction the
  // exact positional representation. Guard against a stray exponent anyway.
  return s.includes('e') || s.includes('E') ? d.toFixed(Math.max(0, -d.e + 10)) : s;
}

/** Number of decimal places actually present in a string, e.g. "0.0010" -> 4. */
export function decimalPlacesOf(value: DecimalLike): number {
  const d = dec(value);
  const s = d.toFixed();
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}

/* ------------------------------------------------------------------ *
 * Grid alignment
 * ------------------------------------------------------------------ */

/**
 * Snap a price to the nearest tick multiple.
 *
 * Arcus validates that a submitted price is an exact multiple of `tickSize`
 * (and within the applicable `tickTiers` band), so a price that is merely close
 * is rejected. The default HALF_UP mode is the neutral choice; callers with a
 * directional preference should use `floorToTick`/`ceilToTick`.
 */
export function snapToTick(price: DecimalLike, tickSize: DecimalLike): Decimal {
  const tick = dec(tickSize);
  if (!tick.greaterThan(0)) throw new DecimalError(`tickSize must be positive, got ${tick}`);
  return dec(price).div(tick).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).mul(tick);
}

/** Snap DOWN to a tick multiple. Buying: never pay more than intended. */
export function floorToTick(price: DecimalLike, tickSize: DecimalLike): Decimal {
  const tick = dec(tickSize);
  if (!tick.greaterThan(0)) throw new DecimalError(`tickSize must be positive, got ${tick}`);
  return dec(price).div(tick).toDecimalPlaces(0, Decimal.ROUND_FLOOR).mul(tick);
}

/** Snap UP to a tick multiple. Selling: never receive less than intended. */
export function ceilToTick(price: DecimalLike, tickSize: DecimalLike): Decimal {
  const tick = dec(tickSize);
  if (!tick.greaterThan(0)) throw new DecimalError(`tickSize must be positive, got ${tick}`);
  return dec(price).div(tick).toDecimalPlaces(0, Decimal.ROUND_CEIL).mul(tick);
}

/**
 * Floor a quantity to a step multiple.
 *
 * This is THE sizing primitive. It rounds down unconditionally so that rounding
 * can only ever reduce risk, never inflate it past the (equity x risk%) budget or
 * past the notional cap.
 */
export function floorToStep(quantity: DecimalLike, stepSize: DecimalLike): Decimal {
  const step = dec(stepSize);
  if (!step.greaterThan(0)) throw new DecimalError(`stepSize must be positive, got ${step}`);
  const q = dec(quantity);
  if (q.isNegative()) {
    // Signed quantities appear when working with position sizes; floor toward
    // zero on the magnitude so a short's size is never silently enlarged.
    return q.abs().div(step).toDecimalPlaces(0, Decimal.ROUND_FLOOR).mul(step).neg();
  }
  return q.div(step).toDecimalPlaces(0, Decimal.ROUND_FLOOR).mul(step);
}

/** True when `value` is an exact multiple of `unit`. */
export function isMultipleOf(value: DecimalLike, unit: DecimalLike): boolean {
  const u = dec(unit);
  if (!u.greaterThan(0)) return false;
  return dec(value).div(u).isInteger();
}

/**
 * Verify a price/quantity pair against a market's grid.
 *
 * The signing layer converts prices to integer ticks and quantities to integer
 * quantums, and a non-multiple cannot be represented. This is asserted before
 * signing so a grid violation surfaces as a local, diagnosable error rather than
 * an opaque engine rejection.
 */
export function assertOnGrid(
  value: DecimalLike,
  unit: DecimalLike,
  label: string,
): void {
  if (!isMultipleOf(value, unit)) {
    throw new DecimalError(
      `${label}=${toFixedString(value)} is not a multiple of ${toFixedString(unit)}`,
    );
  }
}

/** Exact tick count, for the signed payload's `p`. Throws if not on grid. */
export function toTicks(price: DecimalLike, tickSize: DecimalLike): number {
  const ticks = dec(price).div(dec(tickSize));
  if (!ticks.isInteger()) {
    throw new DecimalError(
      `price ${toFixedString(price)} is not a multiple of tickSize ${toFixedString(tickSize)}`,
    );
  }
  return ticks.toNumber();
}

/** Exact quantum count, for the signed payload's `q`. Throws if not on grid. */
export function toQuantums(size: DecimalLike, stepSize: DecimalLike): number {
  const q = dec(size).div(dec(stepSize));
  if (!q.isInteger()) {
    throw new DecimalError(
      `size ${toFixedString(size)} is not a multiple of stepSize ${toFixedString(stepSize)}`,
    );
  }
  return q.toNumber();
}

/* ------------------------------------------------------------------ *
 * Small helpers used across risk / cost / reporting code
 * ------------------------------------------------------------------ */

export function dAdd(...values: DecimalLike[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(dec(v)), new Decimal(0));
}

export function dSub(a: DecimalLike, b: DecimalLike): Decimal {
  return dec(a).minus(dec(b));
}

export function dMul(a: DecimalLike, b: DecimalLike): Decimal {
  return dec(a).times(dec(b));
}

export function dDiv(a: DecimalLike, b: DecimalLike): Decimal {
  const divisor = dec(b);
  if (divisor.isZero()) throw new DecimalError('division by zero');
  return dec(a).div(divisor);
}

export function dMin(...values: DecimalLike[]): Decimal {
  if (values.length === 0) throw new DecimalError('dMin requires at least one value');
  return values.map(dec).reduce((a, b) => (a.lessThan(b) ? a : b));
}

export function dMax(...values: DecimalLike[]): Decimal {
  if (values.length === 0) throw new DecimalError('dMax requires at least one argument');
  return values.map(dec).reduce((a, b) => (a.greaterThan(b) ? a : b));
}

export function dAbs(value: DecimalLike): Decimal {
  return dec(value).abs();
}

export function dNeg(value: DecimalLike): Decimal {
  return dec(value).neg();
}

/** Clamp into [min, max], throwing if the bounds are inverted. */
export function dClamp(value: DecimalLike, min: DecimalLike, max: DecimalLike): Decimal {
  const lo = dec(min);
  const hi = dec(max);
  if (lo.greaterThan(hi)) throw new DecimalError(`dClamp: min ${lo} > max ${hi}`);
  return dMin(dMax(value, lo), hi);
}

/** Basis points to a fraction: 25 bps -> 0.0025. */
export function bpsToFraction(bps: DecimalLike): Decimal {
  return dec(bps).div(10000);
}

/** Fraction to basis points: 0.0025 -> 25. */
export function fractionToBps(fraction: DecimalLike): Decimal {
  return dec(fraction).times(10000);
}

/** Midpoint of two prices. */
export function midPrice(bid: DecimalLike, ask: DecimalLike): Decimal {
  return dec(bid).plus(dec(ask)).div(2);
}

/**
 * Spread in basis points relative to mid.
 *
 * Returns `undefined` when mid is non-positive, because a zero/negative mid makes
 * the ratio meaningless and callers must treat that as "no valid spread" rather
 * than as a very small one.
 */
export function spreadBps(bid: DecimalLike, ask: DecimalLike): Decimal | undefined {
  const b = dec(bid);
  const a = dec(ask);
  const mid = midPrice(b, a);
  if (!mid.greaterThan(0)) return undefined;
  return a.minus(b).div(mid).times(10000);
}

/** Percentage change from `from` to `to`, as a fraction. */
export function pctChange(from: DecimalLike, to: DecimalLike): Decimal | undefined {
  const f = dec(from);
  if (!f.greaterThan(0)) return undefined;
  return dec(to).minus(f).div(f);
}

/** Plain-object projection of a Decimal for logging/reporting. */
export function decToString(value: Decimal | undefined): string | undefined {
  return value === undefined ? undefined : toFixedString(value);
}
