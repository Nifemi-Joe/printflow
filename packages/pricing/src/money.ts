/**
 * Money is always an integer number of kobo (1 NGN = 100 kobo).
 * Floats never enter a calculation; every arithmetic helper asserts safe integers.
 */
export type Kobo = number;

export class MoneyError extends Error {
  override readonly name = "MoneyError";
}

export function assertKobo(value: number, label = "amount"): Kobo {
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`${label} must be a safe integer number of kobo, got ${String(value)}`);
  }
  return value;
}

export function assertNonNegativeKobo(value: number, label = "amount"): Kobo {
  assertKobo(value, label);
  if (value < 0) throw new MoneyError(`${label} must not be negative, got ${value}`);
  return value;
}

export function addKobo(...values: Kobo[]): Kobo {
  let total = 0;
  for (const v of values) {
    total += assertKobo(v);
    assertKobo(total, "running total");
  }
  return total;
}

export function multiplyKobo(amount: Kobo, quantity: number): Kobo {
  assertKobo(amount);
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    throw new MoneyError(`quantity must be a non-negative integer, got ${String(quantity)}`);
  }
  return assertKobo(amount * quantity, "product");
}

/**
 * Applies a rate expressed in basis points (1 bp = 0.01%) using integer
 * arithmetic with round-half-up. 150 bps of 1_001 kobo = 15.015 -> 15.
 */
export function applyBasisPoints(amount: Kobo, bps: number): Kobo {
  assertNonNegativeKobo(amount);
  if (!Number.isSafeInteger(bps) || bps < 0 || bps > 10_000) {
    throw new MoneyError(`basis points must be an integer in [0, 10000], got ${String(bps)}`);
  }
  const numerator = BigInt(amount) * BigInt(bps);
  const rounded = (numerator + 5_000n) / 10_000n;
  return assertKobo(Number(rounded), "basis-point result");
}

export function formatNaira(amount: Kobo): string {
  assertKobo(amount);
  const negative = amount < 0;
  const abs = Math.abs(amount);
  const naira = Math.floor(abs / 100);
  const kobo = abs % 100;
  const nairaStr = naira.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}₦${nairaStr}.${kobo.toString().padStart(2, "0")}`;
}
