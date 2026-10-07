// Admin reports. Each report is a SQL query over a date range returning {columns, rows}; CSV export reuses the
// same data. Money columns are integer cents in JSON and decimal strings in CSV (never floats).
const { bad } = require('../utils');
const { toDecimalString } = require('./money');
const { platformFinance } = require('./finance');

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function range(q) {
  const from = q.from || '1970-01-01';
  const to = q.to || '2999-12-31';
  if (!DATE.test(from) || !DATE.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) throw bad('from/to: use YYYY-MM-DD', { field: 'from' });
  if (from > to) throw bad('from must not be after to', { field: 'from' });
  return { from: `${from}T00:00:00.000Z`, to: new Date(Date.parse(`${to}T00:00:00.000Z`) + 86400000).toISOString() };
}

const OK_ORDERS = "o.status NOT IN ('cancelled','rejected','awaiting_payment')";

const REPORTS = {
  finance: {
    columns: [['metric', 'Metric'], ['value', 'Value'], ['currency', 'Currency'], ['note', 'Note']],
    compute: (db, from, to) => platformFinance(db, { from, to }),
  },
  revenue: {
    columns: [['day', 'Day'], ['orders', 'Orders'], ['gmv_cents', 'Order value', true], ['online_cents', 'Online', true], ['cod_cents', 'Cash on delivery', true], ['commission_cents', 'Commission', true], ['service_fee_cents', 'Service fees', true]],
    sql: `SELECT substr(o.created_at,1,10) AS day, COUNT(*) orders, SUM(o.total_cents) gmv_cents,
            SUM(CASE WHEN o.payment_method='card' THEN o.total_cents ELSE 0 END) online_cents,
            SUM(CASE WHEN o.payment_method='cod' THEN o.total_cents ELSE 0 END) cod_cents,
            SUM(o.commission_cents) commission_cents, SUM(o.platform_fee_cents) service_fee_cents
          FROM orders o WHERE ${OK_ORDERS} AND o.created_at >= ? AND o.created_at < ? GROUP BY day ORDER BY day`,
  },
  orders: {
    columns: [['order_number', 'Order #'], ['restaurant', 'Restaurant'], ['customer', 'Customer'], ['created_at', 'Created'], ['status', 'Status'], ['payment_method', 'Payment'], ['payment_status', 'Payment status'], ['total_cents', 'Total', true], ['currency', 'Currency']],
    sql: `SELECT o.order_number, r.name restaurant, o.customer_name customer, o.created_at, o.status, o.payment_method, o.payment_status, o.total_cents, o.currency
          FROM orders o JOIN restaurants r ON r.id=o.restaurant_id WHERE o.status != 'awaiting_payment' AND o.created_at >= ? AND o.created_at < ? ORDER BY o.created_at DESC LIMIT 20000`,
  },
  restaurants: {
    columns: [['restaurant', 'Restaurant'], ['approval_status', 'Approval'], ['orders', 'Orders'], ['gmv_cents', 'Order value', true], ['commission_cents', 'Commission', true], ['cancelled', 'Cancelled/rejected']],
    sql: `SELECT r.name restaurant, r.approval_status,
            COUNT(CASE WHEN ${OK_ORDERS} THEN 1 END) orders,
            COALESCE(SUM(CASE WHEN ${OK_ORDERS} THEN o.total_cents END),0) gmv_cents,
            COALESCE(SUM(CASE WHEN ${OK_ORDERS} THEN o.commission_cents END),0) commission_cents,
            COUNT(CASE WHEN o.status IN ('cancelled','rejected') THEN 1 END) cancelled
          FROM restaurants r LEFT JOIN orders o ON o.restaurant_id=r.id AND o.created_at >= ? AND o.created_at < ? GROUP BY r.id ORDER BY gmv_cents DESC`,
  },
  customers: {
    columns: [['name', 'Customer'], ['email', 'Email'], ['orders', 'Orders'], ['spent_cents', 'Spent', true], ['last_order', 'Last order']],
    sql: `SELECT u.name, u.email, COUNT(o.id) orders, COALESCE(SUM(o.total_cents),0) spent_cents, MAX(o.created_at) last_order
          FROM users u JOIN orders o ON o.customer_id=u.id AND ${OK_ORDERS} AND o.created_at >= ? AND o.created_at < ?
          WHERE u.role='customer' GROUP BY u.id ORDER BY spent_cents DESC LIMIT 20000`,
  },
  payments: {
    columns: [['id', 'Payment'], ['order_number', 'Order #'], ['restaurant', 'Restaurant'], ['provider', 'Provider'], ['payment_method', 'Method'], ['status', 'Status'], ['amount_cents', 'Amount', true], ['refunded_cents', 'Refunded', true], ['provider_transaction_id', 'Provider ref'], ['created_at', 'Created']],
    sql: `SELECT p.id, o.order_number, r.name restaurant, p.provider, p.payment_method, p.status, p.amount_cents, p.refunded_cents, p.provider_transaction_id, p.created_at
          FROM payments p JOIN orders o ON o.id=p.order_id JOIN restaurants r ON r.id=p.restaurant_id WHERE p.created_at >= ? AND p.created_at < ? ORDER BY p.id DESC LIMIT 20000`,
  },
  commissions: {
    columns: [['restaurant', 'Restaurant'], ['entries', 'Entries'], ['commission_cents', 'Commission', true], ['service_fee_cents', 'Service fees', true], ['payment_fee_cents', 'Provider fees (restaurant-borne)', true], ['restaurant_cents', 'Restaurant net', true]],
    sql: `SELECT r.name restaurant, COUNT(*) entries, SUM(l.platform_commission_cents) commission_cents, SUM(l.platform_fee_cents) service_fee_cents,
            SUM(l.payment_fee_cents) payment_fee_cents, SUM(CASE WHEN l.entry_type != 'cod_commission' THEN l.restaurant_amount_cents ELSE 0 END) restaurant_cents
          FROM ledger_entries l JOIN restaurants r ON r.id=l.restaurant_id WHERE l.created_at >= ? AND l.created_at < ? GROUP BY r.id ORDER BY commission_cents DESC`,
  },
  payouts: {
    columns: [['id', 'Payout'], ['restaurant', 'Restaurant'], ['period_start', 'From'], ['period_end', 'To'], ['amount_cents', 'Amount', true], ['currency', 'Currency'], ['status', 'Status'], ['provider_payout_id', 'Reference'], ['paid_at', 'Paid at'], ['failure_reason', 'Failure']],
    sql: `SELECT p.id, r.name restaurant, p.period_start, p.period_end, p.amount_cents, p.currency, p.status, p.provider_payout_id, p.paid_at, p.failure_reason
          FROM payouts p JOIN restaurants r ON r.id=p.restaurant_id WHERE p.created_at >= ? AND p.created_at < ? ORDER BY p.period_start DESC, p.id DESC`,
  },
  refunds: {
    columns: [['id', 'Refund'], ['order_number', 'Order #'], ['restaurant', 'Restaurant'], ['amount_cents', 'Amount', true], ['status', 'Status'], ['reason', 'Reason'], ['provider_refund_id', 'Provider ref'], ['created_at', 'Created']],
    sql: `SELECT f.id, o.order_number, r.name restaurant, f.amount_cents, f.status, f.reason, f.provider_refund_id, f.created_at
          FROM refunds f JOIN orders o ON o.id=f.order_id JOIN restaurants r ON r.id=f.restaurant_id WHERE f.created_at >= ? AND f.created_at < ? ORDER BY f.id DESC`,
  },
  cod: {
    columns: [['order_number', 'Order #'], ['restaurant', 'Restaurant'], ['created_at', 'Created'], ['status', 'Order status'], ['payment_status', 'Cash status'], ['total_cents', 'Cash amount', true], ['commission_due_cents', 'Commission due', true], ['commission_settled', 'Commission collected']],
    sql: `SELECT o.order_number, r.name restaurant, o.created_at, o.status, o.payment_status, o.total_cents,
            COALESCE(-l.restaurant_amount_cents,0) commission_due_cents, CASE WHEN l.settled_at IS NULL THEN 'no' ELSE 'yes' END commission_settled
          FROM orders o JOIN restaurants r ON r.id=o.restaurant_id LEFT JOIN ledger_entries l ON l.order_id=o.id AND l.entry_type='cod_commission'
          WHERE o.payment_method='cod' AND o.created_at >= ? AND o.created_at < ? ORDER BY o.created_at DESC LIMIT 20000`,
  },
};

function runReport(db, type, query) {
  const def = REPORTS[type];
  if (!def) return null;
  const { from, to } = range(query);
  const rows = def.compute ? def.compute(db, from, to) : db.prepare(def.sql).all(from, to);
  return { type, columns: def.columns.map(([key, label, money]) => ({ key, label, money: !!money })), rows };
}

const csvCell = (v) => {
  let s = v === null || v === undefined ? '' : String(v);
  // neutralise spreadsheet formula injection (plain negative numbers are fine)
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function toCsv(report) {
  const head = report.columns.map((c) => csvCell(c.label)).join(',');
  const body = report.rows.map((r) => report.columns.map((c) => csvCell(c.money && Number.isInteger(r[c.key]) ? toDecimalString(r[c.key]) : r[c.key])).join(','));
  return [head, ...body].join('\n');
}

module.exports = { runReport, toCsv, csvCell, REPORT_TYPES: Object.keys(REPORTS), range };
