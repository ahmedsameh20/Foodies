// Money helpers. Everything is an integer number of minor units (cents). No floating point is used
// for amounts; basis points (1 bp = 0.01 %) are used for rates.

const isCents = (n) => Number.isSafeInteger(n);

function assertCents(n, what = 'amount') {
  if (!isCents(n)) throw new Error(`${what} must be an integer number of cents (got ${n})`);
  return n;
}

// round-half-up for non-negative integers: round(a * b / d) using integer maths only
function mulDiv(a, b, d) {
  if (d <= 0) throw new Error('divisor must be positive');
  const sign = (a < 0) !== (b < 0) ? -1 : 1;
  const na = BigInt(Math.abs(a)) * BigInt(Math.abs(b));
  const q = (na * 2n + BigInt(d)) / (BigInt(d) * 2n); // half-up
  return sign * Number(q);
}

const pctOf = (cents, bp) => mulDiv(cents, bp, 10000);

// 1999 -> "19.99" (decimal string for provider APIs and CSV exports; never parsed back through floats)
function toDecimalString(cents) {
  assertCents(cents);
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

// "19.99" | "19.9" | "19" -> 1999. Returns null for anything that is not a plain decimal amount.
function fromDecimalString(s) {
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(String(s).trim());
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0') || 0);
}

// Order totals. total = subtotal - discount + tax + delivery + service fee.
// Tax applies to the discounted food value. Commission is charged on the discounted food value only
// (not on tax, delivery or the customer's service fee), so the restaurant never pays commission on pass-through money.
function computeOrderTotals({ subtotalCents, discountCents = 0, taxRateBp = 0, deliveryFeeCents = 0, serviceFee = {}, commissionBp = 0, commissionFixedCents = 0 }) {
  assertCents(subtotalCents, 'subtotal');
  if (discountCents < 0 || discountCents > subtotalCents) throw new Error('discount out of range');
  const foodValue = subtotalCents - discountCents;
  const tax = pctOf(foodValue, taxRateBp);
  const platformFee = pctOf(foodValue, serviceFee.bp || 0) + (serviceFee.fixedCents || 0);
  const total = foodValue + tax + deliveryFeeCents + platformFee;
  assertCents(commissionFixedCents, 'fixed commission');
  // percentage + fixed, never more than the food value it is charged on
  const commission = Math.min(foodValue, pctOf(foodValue, commissionBp) + commissionFixedCents);
  return {
    subtotalCents, discountCents, taxCents: tax, deliveryFeeCents, platformFeeCents: platformFee,
    totalCents: total, commissionCents: commission,
    // what the restaurant is entitled to before provider fees
    restaurantAmountCents: total - commission - platformFee,
  };
}

// Split `amount` out of `whole` proportionally for a partial refund, keeping cumulative rounding exact:
// the portion released after refunding `refundedAfter` in total, minus what was released before.
function proportionalShare(partCents, wholeCents, refundedBefore, refundedAfter) {
  if (wholeCents === 0) return 0;
  const target = (r) => mulDiv(partCents, r, wholeCents);
  return target(refundedAfter) - target(refundedBefore);
}

module.exports = { assertCents, mulDiv, pctOf, toDecimalString, fromDecimalString, computeOrderTotals, proportionalShare };
