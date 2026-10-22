'use strict';
// Private file storage on the hosting disk, replacing Supabase Storage
// (docs/02-TRD.md "الملفات"):
//   FILES_DIR/<organization_id>/<bucket>/<path>          the object
//   FILES_DIR/<organization_id>/.meta/<bucket>/<path>.json  {owner, contentType, size, uploadedAt}
// Objects are only served through /api/files/* after a session + clinic
// check, or with a short-lived HMAC-signed link.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { badRequest, forbidden } = require('./errors');

const BUCKETS = new Set(['patient-files']);
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_SIGN_SECONDS = 600;
const MAX_PATH_LENGTH = 1024;
const ORG_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Same rules as the old storage.objects policies on the patient-files bucket.
const FILE_ROLES = Object.freeze({
  read: ['admin', 'receptionist', 'doctor', 'therapist'],
  upload: ['admin', 'receptionist', 'doctor', 'therapist'],
  overwrite: ['admin', 'receptionist'],
  removeAny: ['admin', 'receptionist'], // others: only objects they uploaded
});

function validateBucket(bucket) {
  if (typeof bucket !== 'string' || !BUCKETS.has(bucket)) throw badRequest('invalid_bucket', 'Unknown bucket');
  return bucket;
}

/**
 * Object path relative to the bucket. Rejects '..', a leading '/',
 * backslashes, NUL and other control characters, empty segments and
 * segments starting with '.'.
 */
function validateObjectPath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > MAX_PATH_LENGTH) {
    throw badRequest('invalid_path', 'Invalid path');
  }
  // eslint-disable-next-line no-control-regex
  if (p.includes('..') || p.startsWith('/') || p.includes('\\') || /[\u0000-\u001f\u007f]/.test(p)) {
    throw badRequest('invalid_path', 'Invalid path');
  }
  if (p.split('/').some((seg) => seg === '' || seg.startsWith('.'))) throw badRequest('invalid_path', 'Invalid path');
  return p;
}

function orgRoot(config, orgId) {
  if (!ORG_ID_RE.test(String(orgId))) throw new Error('invalid organization id');
  return path.join(config.filesDir, String(orgId).toLowerCase());
}

function inside(root, rel) {
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root + path.sep)) throw badRequest('invalid_path', 'Invalid path');
  return abs;
}

/** Absolute paths of an object and of its metadata file. */
function locate(config, orgId, bucket, objectPath) {
  validateBucket(bucket);
  validateObjectPath(objectPath);
  const root = orgRoot(config, orgId);
  return {
    file: inside(path.join(root, bucket), objectPath),
    meta: inside(path.join(root, '.meta', bucket), `${objectPath}.json`),
    bucketRoot: path.join(root, bucket),
    orgRoot: root,
  };
}

async function readMeta(metaPath) {
  try {
    return JSON.parse(await fs.promises.readFile(metaPath, 'utf8'));
  } catch (_) {
    return null;
  }
}

async function statFile(p) {
  try {
    const st = await fs.promises.stat(p);
    return st.isFile() ? st : null;
  } catch (_) {
    return null;
  }
}

/** Total bytes under a directory (the clinic's storage use). */
async function directorySize(dir) {
  let total = 0;
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (_) {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await directorySize(p);
    else if (e.isFile()) total += (await fs.promises.stat(p)).size;
  }
  return total;
}

// ── Signed links ──────────────────────────────────────────────────────────

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function hmac(config, data) {
  return crypto.createHmac('sha256', config.filesSigningSecret).update(data).digest();
}

/** token = base64url(JSON {o,b,p,e}) + '.' + base64url(HMAC-SHA256). */
function signToken(config, { orgId, bucket, objectPath, expiresAt }) {
  const payload = b64url(JSON.stringify({ o: orgId, b: bucket, p: objectPath, e: expiresAt }));
  return `${payload}.${b64url(hmac(config, payload))}`;
}

/** Returns {orgId, bucket, objectPath, expiresAt} or throws 403. */
function verifyToken(config, token, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    throw forbidden('invalid_token', 'Invalid link');
  }
  const [payload, sig] = token.split('.');
  const expected = hmac(config, payload);
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    throw forbidden('invalid_token', 'Invalid link');
  }
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch (_) {
    throw forbidden('invalid_token', 'Invalid link');
  }
  if (!data || typeof data.e !== 'number' || data.e * 1000 <= now) throw forbidden('token_expired', 'Link expired');
  return { orgId: data.o, bucket: data.b, objectPath: data.p, expiresAt: data.e };
}

// ── Serving ───────────────────────────────────────────────────────────────

const TYPES = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.dcm': 'application/dicom',
  '.zip': 'application/zip',
  '.mp4': 'video/mp4',
};
// Only these render inline; anything else (HTML, SVG, XML, scripts...) is a
// download so an uploaded file can never run script on the clinic's origin.
const INLINE_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'text/plain; charset=utf-8',
  'video/mp4',
]);

function contentTypeFor(objectPath, meta) {
  const byExt = TYPES[path.extname(objectPath).toLowerCase()];
  if (byExt) return byExt;
  const stored = meta && typeof meta.contentType === 'string' ? meta.contentType.toLowerCase() : '';
  if (/^(image\/(png|jpeg|gif|webp|bmp)|application\/pdf)$/.test(stored)) return stored;
  return 'application/octet-stream';
}

/** Streams an object with safe headers (Range/ETag handled by res.sendFile). */
function sendObject(res, absFile, objectPath, meta) {
  return new Promise((resolve, reject) => {
    const type = contentTypeFor(objectPath, meta);
    const name = path.basename(objectPath);
    const disposition = INLINE_TYPES.has(type) ? 'inline' : 'attachment';
    res.sendFile(
      absFile,
      {
        dotfiles: 'allow', // the path was validated; FILES_DIR itself may sit under a dot directory
        cacheControl: false,
        lastModified: true,
        headers: {
          'Content-Type': type,
          'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(name)}`,
          'Cache-Control': 'private, max-age=0, must-revalidate',
          'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
          'Cross-Origin-Resource-Policy': 'same-origin',
        },
      },
      (err) => (err ? reject(err) : resolve()),
    );
  });
}

module.exports = {
  BUCKETS,
  MAX_FILE_BYTES,
  MAX_SIGN_SECONDS,
  FILE_ROLES,
  validateBucket,
  validateObjectPath,
  locate,
  orgRoot,
  readMeta,
  statFile,
  directorySize,
  signToken,
  verifyToken,
  contentTypeFor,
  sendObject,
};
