// Structured JSON logging with automatic redaction of secrets and payment data.
const config = require('./config');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;
const REDACT = /pass(word)?|secret|token|authorization|cookie|card|cvv|cvc|pin\b|iban|account_number|api[_-]?key|hashstring|signature/i;

function redact(value, depth = 0) {
  if (value === null || value === undefined || depth > 6) return value;
  if (value instanceof Error) return { name: value.name, message: value.message, stack: config.isProd ? undefined : value.stack };
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = REDACT.test(k) ? '[REDACTED]' : redact(v, depth + 1);
    return out;
  }
  if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}…`;
  return value;
}

let sink = (line) => process.stdout.write(`${line}\n`);

function write(level, event, fields) {
  if (LEVELS[level] < threshold) return;
  sink(JSON.stringify({ ts: new Date().toISOString(), level, event, ...redact(fields || {}) }));
}

module.exports = {
  debug: (event, f) => write('debug', event, f),
  info: (event, f) => write('info', event, f),
  warn: (event, f) => write('warn', event, f),
  error: (event, f) => write('error', event, f),
  redact,
  // tests capture or silence output
  setSink: (fn) => { sink = fn; },
};
