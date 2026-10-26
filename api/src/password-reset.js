'use strict';
// The password-reset e-mail (docs/02 «المصادقة والجلسة»): a new single-use
// token (stored as sha256, 1 hour) and its link, both languages with the
// requester's first. Used by POST /api/auth/reset/request and by the job
// that sends it again when SMTP failed (src/job-handlers.js, docs/06 S7).

const crypto = require('crypto');
const { bilingualMessage } = require('./mailer');
const { sha256 } = require('./auth');

const RESET_TTL_SQL = "interval '1 hour'";

/** The reset e-mail: {subject, text, html}, both languages, `lang` first. */
function resetMessage(link, lang) {
  const a = link.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return bilingualMessage(lang, {
    ar: {
      subject: 'إعادة تعيين كلمة المرور',
      text: [
        'طلبتَ إعادة تعيين كلمة المرور لحسابك في ClinicSystem EG.',
        `افتح الرابط التالي خلال ساعة واحدة: ${link}`,
        'إن لم تطلب ذلك فتجاهل هذه الرسالة.',
      ],
      html:
        '<p>طلبتَ إعادة تعيين كلمة المرور لحسابك في ClinicSystem EG.</p>' +
        `<p><a href="${a}">إعادة تعيين كلمة المرور</a> (صالح لمدة ساعة واحدة)</p>` +
        '<p>إن لم تطلب ذلك فتجاهل هذه الرسالة.</p>',
    },
    en: {
      subject: 'Reset your password',
      text: [
        'You asked to reset your ClinicSystem EG password.',
        `Open this link within one hour: ${link}`,
        'If you did not ask for this, ignore this e-mail.',
      ],
      html:
        '<p>You asked to reset your ClinicSystem EG password.</p>' +
        `<p><a href="${a}">Reset your password</a> (valid for one hour)</p>` +
        '<p>If you did not ask for this, ignore this e-mail.</p>',
    },
  });
}


// client: the pool or a transaction; throws when the e-mail fails.
async function sendResetLink({ config, mailer }, client, user, lang) {
  const token = crypto.randomBytes(32).toString('base64url');
  await client.query(
    `insert into auth.password_reset_tokens (token_hash, user_id, expires_at) values ($1, $2, now() + ${RESET_TTL_SQL})`,
    [sha256(token), user.id],
  );
  const link = `${config.publicBaseUrl}/?reset=${encodeURIComponent(token)}`;
  await mailer.send({ to: user.email, kind: 'password_reset', ...resetMessage(link, lang) });
}

module.exports = { resetMessage, sendResetLink, RESET_TTL_SQL };
