// Restaurant earnings ledger. Append-only: every order's money split is recorded once, and every
// refund adds an offsetting entry, so any balance can be traced back to the orders behind it.
const config = require('../config');
const { proportionalShare, pctOf } = require('./money');

const nowIso = () => new Date().toISOString();

function estimateProviderFee(totalCents) {
  return pctOf(totalCents, config.paymentFeeBp) + config.paymentFeeFixedCents;
}

// Fee actually deducted from the restaurant's share (0 when the platform absorbs provider fees).
const restaurantBorneFee = (feeCents) => (config.paymentFeeBorneBy === 'restaurant' ? feeCents : 0);

// An online sale. Recorded when the provider confirms payment; payable once the order is delivered.
function recordSale(db, order, payment) {
  const fee = restaurantBorneFee(payment.estimated_fee_cents);
  db.prepare(
    `INSERT OR IGNORE INTO ledger_entries (restaurant_id, order_id, payment_id, entry_type, gross_amount_cents,
       platform_commission_cents, platform_fee_cents, payment_fee_cents, restaurant_amount_cents, currency, eligible_at)
     VALUES (?,?,?,'sale',?,?,?,?,?,?,?)`)
    .run(order.restaurant_id, order.id, payment.id, order.total_cents, order.commission_cents, order.platform_fee_cents, fee,
      order.total_cents - order.commission_cents - order.platform_fee_cents - fee, order.currency,
      order.status === 'delivered' ? nowIso() : null);
}

// Cash on delivery: the restaurant already holds the cash, so the platform is owed commission + service fee.
function recordCodCommission(db, order, payment) {
  db.prepare(
    `INSERT OR IGNORE INTO ledger_entries (restaurant_id, order_id, payment_id, entry_type, gross_amount_cents,
       platform_commission_cents, platform_fee_cents, payment_fee_cents, restaurant_amount_cents, currency, eligible_at)
     VALUES (?,?,?,'cod_commission',?,?,?,0,?,?,?)`)
    .run(order.restaurant_id, order.id, payment.id, order.total_cents, order.commission_cents, order.platform_fee_cents,
      -(order.commission_cents + order.platform_fee_cents), order.currency, nowIso());
}

// Delivered online order becomes payable.
function markSaleEligible(db, orderId) {
  const at = nowIso();
  // The sale and any partial refunds recorded before delivery become payable together; a refunded-then-cancelled
  // order never reaches here, so its sale and refund entries both stay out of statements.
  db.prepare("UPDATE ledger_entries SET eligible_at = ? WHERE order_id = ? AND entry_type IN ('sale','refund') AND eligible_at IS NULL").run(at, orderId);
}

// A refund reverses the commission, service fee and restaurant amount in proportion to the refunded share.
// Cumulative rounding is exact: the last partial refund releases precisely the remainder.
function recordRefund(db, order, payment, refund, refundedBefore) {
  const refundedAfter = refundedBefore + refund.amount_cents;
  const share = (part) => proportionalShare(part, payment.amount_cents, refundedBefore, refundedAfter);
  const commission = share(order.commission_cents);
  const platformFee = share(order.platform_fee_cents);
  const sale = db.prepare("SELECT eligible_at, payment_fee_cents FROM ledger_entries WHERE order_id = ? AND entry_type = 'sale'").get(order.id);
  const gross = -refund.amount_cents;
  db.prepare(
    `INSERT INTO ledger_entries (restaurant_id, order_id, payment_id, refund_id, entry_type, gross_amount_cents,
       platform_commission_cents, platform_fee_cents, payment_fee_cents, restaurant_amount_cents, currency, eligible_at)
     VALUES (?,?,?,?,'refund',?,?,?,0,?,?,?)`)
    .run(order.restaurant_id, order.id, payment.id, refund.id, gross, -commission, -platformFee,
      gross + commission + platformFee, order.currency, sale ? sale.eligible_at : null);
}

function restaurantBalance(db, restaurantId) {
  const q = (where) => db.prepare(`SELECT COALESCE(SUM(restaurant_amount_cents),0) s FROM ledger_entries WHERE restaurant_id = ? AND ${where}`).get(restaurantId).s;
  return {
    // earned online, delivered, not yet in a payout (negative entries = refunds/reversals)
    availableCents: q("entry_type != 'cod_commission' AND eligible_at IS NOT NULL AND payout_id IS NULL"),
    // earned online, order not delivered yet
    pendingCents: q("entry_type != 'cod_commission' AND eligible_at IS NULL"),
    inPayoutCents: q("entry_type != 'cod_commission' AND payout_status = 'in_payout'"),
    paidCents: q("entry_type != 'cod_commission' AND payout_status = 'paid'"),
    // commission owed to the platform by the restaurant on cash orders (positive number)
    codCommissionDueCents: -q("entry_type = 'cod_commission' AND settled_at IS NULL"),
  };
}

module.exports = { estimateProviderFee, restaurantBorneFee, recordSale, recordCodCommission, markSaleEligible, recordRefund, restaurantBalance };
