'use strict';
// Resource ("spend") alerts inside hosting.com (docs/06 S8, 0014_usage).
// What stops the platform on shared hosting is not a bill but the
// account's disk quota (database + clinic files + backups: DISK_QUOTA_MB)
// and the SMTP sending limits (SMTP_HOURLY_LIMIT, SMTP_DAILY_LIMIT).
//
//   collectUsage(db, config) → {dbBytes, filesBytes, backupsBytes,
//                               diskTotalBytes, diskFreeBytes, emailsLastHour, emailsToday}
//   checkUsage(deps, { usage }) → {usage, levels, sent}: stores a snapshot;
//     a level (70 / 85 / 95 %) crossed upward e-mails every platform admin,
//     at most once per level a day; back below 70 % sends «انتهى الخطر»
//     once per alert actually sent.
//   emailBudgetLeft(db, config) → e-mails still allowed this hour (≥ 0)
//
// The hourly job usage.check (src/job-handlers.js) runs checkUsage().

const fs = require('fs');
const path = require('path');
const { bilingualMessage } = require('./mailer');

const LEVELS = [95, 85, 70];
const DAY_MS = 24 * 3600 * 1000;

// Bytes under dir (files only, links not followed); 0 when it is missing.
async function folderBytes(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = await fs.promises.readdir(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        try { total += (await fs.promises.stat(p)).size; } catch (_) { /* removed meanwhile */ }
      }
    }
  }
  return total;
}

async function diskOf(dir) {
  try {
    const s = await fs.promises.statfs(dir);
    return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch (_) {
    return { total: null, free: null }; // Node without statfs, or no such folder
  }
}

async function collectUsage(db, config) {
  const [{ rows: [size] }, { rows: [mail] }, filesBytes, backupsBytes, disk] = await Promise.all([
    db.query('select pg_database_size(current_database())::float8 as b'),
    db.query(`select count(*) filter (where sent_at > now() - interval '1 hour')::int as hour,
                     count(*) filter (where sent_at >= date_trunc('day', now()))::int as day
                from public.mail_log`),
    folderBytes(config.filesDir),
    folderBytes(config.backupDir),
    diskOf(config.filesDir),
  ]);
  return {
    dbBytes: size.b, filesBytes, backupsBytes,
    diskTotalBytes: disk.total, diskFreeBytes: disk.free,
    emailsLastHour: mail.hour, emailsToday: mail.day,
  };
}

const limitsOf = (config) => ({
  disk_bytes: config.diskQuotaMb * 1024 * 1024,
  emails_per_hour: config.smtpHourlyLimit,
  emails_per_day: config.smtpDailyLimit,
});

// Percent of each limit, and the level it reaches (0, 70, 85 or 95).
function measure(u, config) {
  const l = limitsOf(config);
  const pct = {
    disk: (100 * ((u.dbBytes || 0) + (u.filesBytes || 0) + (u.backupsBytes || 0))) / l.disk_bytes,
    email_hour: (100 * (u.emailsLastHour || 0)) / l.emails_per_hour,
    email_day: (100 * (u.emailsToday || 0)) / l.emails_per_day,
  };
  const levels = {};
  for (const [k, v] of Object.entries(pct)) levels[k] = LEVELS.find((x) => v >= x) || 0;
  return { pct, levels };
}

const NAMES = {
  disk: { ar: 'مساحة القرص (القاعدة + ملفات العيادات + النسخ)', en: 'disk space (database + clinic files + backups)' },
  email_hour: { ar: 'رسائل البريد في الساعة', en: 'e-mails this hour' },
  email_day: { ar: 'رسائل البريد اليوم', en: 'e-mails today' },
};

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const section = (subject, lines) => ({ subject, text: lines, html: lines.map((l) => `<p>${esc(l)}</p>`).join('') });

function alertMessage(key, level, pct) {
  const n = Math.round(pct);
  const name = NAMES[key];
  if (level === 0) {
    return bilingualMessage('ar', {
      ar: section(`انتهى الخطر: ${name.ar}`, [`انتهى الخطر: ${name.ar} عند ${n}% من الحد، أقل من 70%.`]),
      en: section(`Back to normal: ${name.en}`, [`Back below 70%: ${name.en} at ${n}% of the limit.`]),
    });
  }
  return bilingualMessage('ar', {
    ar: section(`تنبيه ${level}%: ${name.ar}`, [
      `وصلت ${name.ar} إلى ${n}% من الحد المسموح (مستوى ${level}%).`,
      'التفاصيل في لوحة المنصة ← المؤشرات ← الموارد، والإجراءات في docs/08 «Runbook».']),
    en: section(`${level}% alert: ${name.en}`, [
      `The ${name.en} reached ${n}% of the limit (${level}% level).`,
      'Details: platform panel → Overview → Resources. What to do: docs/08 «Runbook».']),
  });
}

async function adminEmails(db) {
  const { rows } = await db.query(
    "select u.email from public.platform_admins p join auth.users u on u.id = p.user_id where u.status = 'active' order by u.email");
  return rows.map((r) => r.email);
}

async function checkUsage(deps, { usage } = {}) {
  const { db, config, mailer } = deps;
  const u = usage || (await collectUsage(db, config));
  const { pct, levels } = measure(u, config);
  await db.query(
    `insert into public.usage_snapshots (db_bytes, files_bytes, backups_bytes, disk_total_bytes, disk_free_bytes,
                                         emails_last_hour, emails_today, levels)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [u.dbBytes, u.filesBytes, u.backupsBytes, u.diskTotalBytes, u.diskFreeBytes, u.emailsLastHour, u.emailsToday, JSON.stringify(levels)]);

  const { rows } = await db.query('select key, level, sent from public.alert_state');
  const state = Object.fromEntries(rows.map((r) => [r.key, r]));
  const sent = [];
  const now = Date.now();
  for (const key of Object.keys(levels)) {
    const level = levels[key];
    const prev = state[key] || { level: 0, sent: {} };
    const sentAt = { ...(prev.sent || {}) };
    let send = false;
    if (level > prev.level) send = !(sentAt[level] && now - Date.parse(sentAt[level]) < DAY_MS);
    else if (level === 0 && prev.level > 0) {
      // Back below 70 %: only after an alert that was actually sent since the
      // last «انتهى الخطر» (hovering around 70 % sends it once, not hourly).
      const lastAlert = Math.max(0, ...LEVELS.map((l) => (sentAt[l] ? Date.parse(sentAt[l]) : 0)));
      send = lastAlert > (sentAt[0] ? Date.parse(sentAt[0]) : 0);
    }
    if (send) {
      const to = await adminEmails(db);
      const message = alertMessage(key, level, pct[key]);
      for (const address of to) {
        try { await mailer.send({ to: address, kind: 'alert', ...message }); } catch (err) {
          console.error('[api] resource alert e-mail failed:', err && err.message);
        }
      }
      sentAt[level] = new Date(now).toISOString();
      sent.push({ key, level, pct: pct[key] });
    }
    if (send || level !== prev.level) {
      await db.query(
        `insert into public.alert_state (key, level, sent, updated_at) values ($1, $2, $3::jsonb, now())
         on conflict (key) do update set level = excluded.level, sent = excluded.sent, updated_at = now()`,
        [key, level, JSON.stringify(sentAt)]);
    }
  }
  return { usage: u, pct, levels, sent };
}

async function emailBudgetLeft(db, config) {
  const { rows: [r] } = await db.query("select count(*)::int as n from public.mail_log where sent_at > now() - interval '1 hour'");
  return Math.max(0, config.smtpHourlyLimit - r.n);
}

module.exports = { collectUsage, checkUsage, emailBudgetLeft, measure, limitsOf, folderBytes, LEVELS };
