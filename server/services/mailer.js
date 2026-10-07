// Transactional email (password reset, email verification) over SMTP.
// In development without SMTP the message is written to the log instead; in production a missing SMTP
// configuration is reported as an error and nothing is sent.
const nodemailer = require('nodemailer');
const config = require('../config');
const logger = require('../logger');

let transport = null;
function getTransport() {
  if (transport || !config.mail.host) return transport;
  transport = nodemailer.createTransport({
    host: config.mail.host, port: config.mail.port, secure: config.mail.secure,
    auth: config.mail.user ? { user: config.mail.user, pass: config.mail.pass } : undefined,
  });
  return transport;
}

// Tests replace this to capture outgoing mail.
let outbox = null;
const captureMail = (fn) => { outbox = fn; };

async function sendMail({ to, subject, text, devLink }) {
  if (outbox) { outbox({ to, subject, text, devLink }); return true; }
  const t = getTransport();
  if (!t) {
    if (config.isProd) { logger.error('mail.not_configured', { subject }); return false; }
    logger.info('mail.dev_outbox', { to, subject, devLink });
    return true;
  }
  try {
    await t.sendMail({ from: config.mail.from || config.mail.user, to, subject, text });
    logger.info('mail.sent', { subject });
    return true;
  } catch (e) {
    logger.error('mail.failed', { subject, error: e });
    return false;
  }
}

module.exports = { sendMail, captureMail };
