'use strict';
// Outgoing e-mail (invitations, password reset).
//   MAIL_TRANSPORT=smtp  nodemailer over the cPanel SMTP_* account
//   MAIL_TRANSPORT=file  one JSON file per message in MAIL_OUTBOX_DIR
//                        (default api/.outbox), for development and tests.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Deliberately strict (no quotes, comments, spaces or lists): recipient
// strings never reach nodemailer's address parser in a form that could be
// abused, and one call always means exactly one recipient.
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

function isValidEmail(email) {
  return typeof email === 'string' && email.length <= 254 && EMAIL_RE.test(email);
}

function createMailer(config) {
  let transport = null;

  function smtpTransport() {
    if (!transport) {
      // Loaded lazily: the file transport (dev/tests) never needs it.
      const nodemailer = require('nodemailer');
      const { host, port, secure, user, pass } = config.smtp;
      transport = nodemailer.createTransport({
        host,
        port,
        secure,
        auth: user ? { user, pass } : undefined,
      });
    }
    return transport;
  }

  /** send({to, subject, text, html}) → {id}. Throws on an invalid recipient. */
  async function send({ to, subject, text, html }) {
    if (!isValidEmail(to)) {
      const err = new Error('Invalid recipient address');
      err.code = 'invalid_email';
      throw err;
    }
    const message = {
      from: config.mailFrom,
      to,
      subject: String(subject || ''),
      text: String(text || ''),
      html: html ? String(html) : undefined,
    };
    if (config.mailTransport === 'file') {
      const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}`;
      await fs.promises.mkdir(config.mailOutboxDir, { recursive: true });
      const file = path.join(config.mailOutboxDir, `${id}.json`);
      await fs.promises.writeFile(file, JSON.stringify({ id, date: new Date().toISOString(), ...message }, null, 2));
      return { id, file };
    }
    const info = await smtpTransport().sendMail(message);
    return { id: info.messageId };
  }

  return { send, isValidEmail };
}

module.exports = { createMailer, isValidEmail };
