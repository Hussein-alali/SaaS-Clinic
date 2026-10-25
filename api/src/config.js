'use strict';
// Environment configuration for the API (docs/02-TRD.md "Repository layout",
// environment variables). Every value has a development default so
// `cd api && npm start` works against scripts/dev-db.sh; in production
// (NODE_ENV=production) the API refuses to start without its secrets.

const os = require('os');
const path = require('path');

function readReleaseFile() {
  try {
    return require('fs').readFileSync(path.resolve(__dirname, '..', '..', 'RELEASE'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

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

/** localhost, *.localhost, *.test and loopback addresses (RFC 2606 / 6761 names). */
function isLocalDomain(domain) {
  return (
    domain === 'localhost' ||
    domain.endsWith('.localhost') ||
    domain.endsWith('.test') ||
    /^127(?:\.\d{1,3}){3}$/.test(domain) ||
    domain === '::1' ||
    domain === '[::1]'
  );
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

  // The development secrets are public (they are in this file). A server
  // started outside production mode on a real domain (e.g. cPanel
  // "Application mode: Development") would accept session cookies anyone
  // can sign, Super Admin included. Defaults are only allowed on local names.
  if (!production && !isLocalDomain(appBaseDomain)) {
    const usingDefaults = ['JWT_SECRET', 'FILES_SIGNING_SECRET'].filter((n) => !str(env[n], ''));
    if (usingDefaults.length) {
      const err = new Error(
        `Invalid API configuration:\n  - ${usingDefaults.join(' and ')} must be set: the built-in development ` +
          `secrets are only allowed when APP_BASE_DOMAIN is a local name (got "${appBaseDomain}")`,
      );
      err.code = 'CONFIG_INVALID';
      throw err;
    }
  }

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
    // TRD: Secure in production. Default on in production (COOKIE_SECURE=false
    // turns it off explicitly), off in development (http://localhost).
    cookieSecure: bool(env.COOKIE_SECURE, production),
    trustProxy: trustProxy(env.TRUST_PROXY),
    // Requests per session (or IP) a minute, per process; 0 = no cap (docs/06 S5).
    apiRatePerMin: Math.max(0, Number(str(env.API_RATE_PER_MIN, '600')) || 0),
    // Resource alerts (docs/06 S8): the account's disk quota, the SMTP budget,
    // and where scripts/backup.sh writes (its size counts against the quota).
    diskQuotaMb: Math.max(1, Number(str(env.DISK_QUOTA_MB, '30720')) || 30720),
    smtpHourlyLimit: Math.max(1, Number(str(env.SMTP_HOURLY_LIMIT, '100')) || 100),
    smtpDailyLimit: Math.max(1, Number(str(env.SMTP_DAILY_LIMIT, '1000')) || 1000),
    backupDir: path.resolve(str(env.BACKUP_DIR, path.join(os.homedir(), 'clinicsys-backups'))),
    filesDir: path.resolve(API_ROOT, str(env.FILES_DIR, 'uploads')),
    filesSigningSecret,
    distDir: path.resolve(API_ROOT, str(env.DIST_DIR, '../dist')),
    // The deployed release name (/api/health shows it): RELEASE, else the
    // RELEASE file scripts/deploy.sh writes at the release root.
    release: str(env.RELEASE, '') || readReleaseFile(),
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
