'use strict';
// Environment configuration for the API (docs/02-TRD.md "Repository layout",
// environment variables). Every value has a development default so
// `cd api && npm start` works against scripts/dev-db.sh; in production
// (NODE_ENV=production) the API refuses to start without its secrets.

const path = require('path');

const API_ROOT = path.resolve(__dirname, '..');

const DEV_JWT_SECRET = 'dev-only-jwt-secret-change-me-0123456789abcdef';
const DEV_FILES_SECRET = 'dev-only-files-signing-secret-0123456789abcdef';
const MIN_SECRET_LENGTH = 32;

function bool(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

function int(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : dflt;
}

function str(v, dflt) {
  if (v === undefined || v === null) return dflt;
  const s = String(v).trim();
  return s === '' ? dflt : s;
}

// Express "trust proxy": a number of hops, a boolean, or a comma list of
// addresses/subnets ("loopback", "10.0.0.0/8", ...).
function trustProxy(v) {
  const s = str(v, 'loopback');
  if (/^(true|false)$/i.test(s)) return /^true$/i.test(s);
  if (/^\d+$/.test(s)) return Number(s);
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

function loadConfig(env = process.env) {
  const nodeEnv = str(env.NODE_ENV, 'development');
  const production = nodeEnv === 'production';

  const problems = [];
  const secret = (name, devDefault) => {
    const v = str(env[name], '');
    if (production) {
      if (!v) problems.push(`${name} is required in production`);
      else if (v.length < MIN_SECRET_LENGTH) problems.push(`${name} must be at least ${MIN_SECRET_LENGTH} characters`);
      return v;
    }
    return v || devDefault;
  };

  const jwtSecret = secret('JWT_SECRET', DEV_JWT_SECRET);
  const filesSigningSecret = secret('FILES_SIGNING_SECRET', DEV_FILES_SECRET);
  const databaseUrl = str(env.DATABASE_URL, production ? '' : 'postgres://clinic_owner:clinic_owner_dev@127.0.0.1:54329/clinicsys');
  if (!databaseUrl) problems.push('DATABASE_URL is required in production');
  if (production && jwtSecret && jwtSecret === filesSigningSecret) {
    problems.push('JWT_SECRET and FILES_SIGNING_SECRET must be different');
  }

  const mailTransport = str(env.MAIL_TRANSPORT, production ? 'smtp' : 'file').toLowerCase();
  if (!['smtp', 'file'].includes(mailTransport)) problems.push('MAIL_TRANSPORT must be "smtp" or "file"');
  const smtpPort = int(env.SMTP_PORT, 587);

  if (problems.length) {
    const err = new Error(`Invalid API configuration:\n  - ${problems.join('\n  - ')}`);
    err.code = 'CONFIG_INVALID';
    throw err;
  }

  const port = int(env.PORT, 3000);
  const appBaseDomain = str(env.APP_BASE_DOMAIN, 'localhost').toLowerCase().replace(/^\.+|\.+$/g, '');

  return Object.freeze({
    nodeEnv,
    production,
    port,
    databaseUrl,
    dbPoolMax: int(env.DB_POOL_MAX, 10),
    dbStatementTimeoutMs: int(env.DB_STATEMENT_TIMEOUT_MS, 15000),
    jwtSecret,
    appBaseDomain,
    // Base URL used in e-mails (password reset). Production: https://<base>;
    // development: http://<base>:<PORT>.
    publicBaseUrl: production ? `https://${appBaseDomain}` : `http://${appBaseDomain}:${port}`,
    cookieDomain: str(env.COOKIE_DOMAIN, ''),
    cookieSecure: bool(env.COOKIE_SECURE, false),
    trustProxy: trustProxy(env.TRUST_PROXY),
    filesDir: path.resolve(API_ROOT, str(env.FILES_DIR, 'uploads')),
    filesSigningSecret,
    distDir: path.resolve(API_ROOT, str(env.DIST_DIR, '../dist')),
    mailTransport,
    mailOutboxDir: path.resolve(API_ROOT, str(env.MAIL_OUTBOX_DIR, '.outbox')),
    mailFrom: str(env.MAIL_FROM, 'ClinicSystem EG <no-reply@localhost>'),
    smtp: Object.freeze({
      host: str(env.SMTP_HOST, 'localhost'),
      port: smtpPort,
      secure: bool(env.SMTP_SECURE, smtpPort === 465),
      user: str(env.SMTP_USER, ''),
      pass: str(env.SMTP_PASS, ''),
    }),
  });
}

module.exports = { loadConfig, API_ROOT };
