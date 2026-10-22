'use strict';
// /api/files/* (docs/02-TRD.md "الملفات"):
//   POST /upload              multipart: bucket, path, file, upsert
//   POST /sign                {bucket, path, expiresIn <= 600} → {signedUrl}
//   GET  /object/:bucket/*    download with session + current clinic
//   GET  /signed?token=       download with a signed link (no session)
//   POST /remove              {bucket, paths:[...]} → {removed:[...]}
// Every route answers 403 module_disabled while the bucket's module
// (patient-files → core.files, api/src/modules.js) is off for the clinic;
// the files stay on disk.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { HttpError, badRequest, forbidden, notFound } = require('../errors');
const { requireOrg } = require('../tenant');
const files = require('../files');
const { assertModule, bucketModule } = require('../modules');

const router = express.Router();

const allow = (action) => (req, res, next) => {
  if (!files.FILE_ROLES[action].includes(req.ctx.role)) throw forbidden('forbidden', 'Your role cannot do this with files');
  next();
};

// Uploads land in FILES_DIR/.tmp (same file system as the target, so the
// final link/rename is atomic), then move once bucket/path are validated.
const storage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = path.join(req.app.locals.config.filesDir, '.tmp');
    fs.promises.mkdir(dir, { recursive: true }).then(() => cb(null, dir), cb);
  },
  filename(req, file, cb) {
    cb(null, `${Date.now()}-${crypto.randomBytes(12).toString('hex')}`);
  },
});
const uploadParser = multer({
  storage,
  limits: { fileSize: files.MAX_FILE_BYTES, files: 1, fields: 10, fieldSize: 8 * 1024, parts: 12 },
}).single('file');

function parseUpload(req, res) {
  return new Promise((resolve, reject) => {
    uploadParser(req, res, (err) => {
      if (!err) return resolve();
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') return reject(new HttpError(413, 'file_too_large', 'File is larger than 20 MB'));
        return reject(badRequest('invalid_upload', err.message));
      }
      // File-system failures (disk full, permissions) are server errors;
      // anything else from the multipart parser is a malformed request.
      if (err && err.syscall) return reject(err);
      return reject(badRequest('invalid_upload', 'Malformed multipart body'));
    });
  });
}

const unlinkQuiet = (p) => fs.promises.unlink(p).catch(() => {});

/** 403 module_disabled when the bucket's module is off for the clinic (AT-07). */
const assertBucketModule = (db, orgId, bucket) => assertModule(db, orgId, bucketModule(bucket));

/** Storage limit of the clinic's plan (subscription_plans.max_storage_mb). */
async function storageLimitBytes(db, orgId) {
  const { rows } = await db.query(
    `select sp.max_storage_mb
       from organizations o
       left join subscription_plans sp on sp.id = o.plan_id
      where o.id = $1`,
    [orgId],
  );
  const mb = rows[0] && rows[0].max_storage_mb;
  return mb === null || mb === undefined ? null : Number(mb) * 1024 * 1024;
}

router.post('/upload', requireOrg(), allow('upload'), async (req, res) => {
  const { config, db } = req.app.locals;
  await parseUpload(req, res);
  const tmp = req.file && req.file.path;
  try {
    if (!req.file) throw badRequest('file_required', 'Missing file');
    const body = req.body || {};
    const bucket = files.validateBucket(body.bucket);
    await assertBucketModule(db, req.ctx.orgId, bucket);
    const objectPath = files.validateObjectPath(body.path);
    const upsert = /^(true|1)$/i.test(String(body.upsert || ''));
    const loc = files.locate(config, req.ctx.orgId, bucket, objectPath);

    const existing = await files.statFile(loc.file);
    if (existing && !upsert) throw new HttpError(409, 'already_exists', 'The resource already exists');
    if (existing && !files.FILE_ROLES.overwrite.includes(req.ctx.role)) {
      throw forbidden('forbidden', 'Your role cannot replace files');
    }

    const limit = await storageLimitBytes(db, req.ctx.orgId);
    if (limit !== null) {
      const used = await files.directorySize(loc.orgRoot);
      if (used - (existing ? existing.size : 0) + req.file.size > limit) {
        throw new HttpError(422, 'plan_limit_storage', 'Storage limit of the subscription plan reached');
      }
    }

    await fs.promises.mkdir(path.dirname(loc.file), { recursive: true });
    if (upsert) {
      await fs.promises.rename(tmp, loc.file);
    } else {
      try {
        await fs.promises.link(tmp, loc.file); // fails with EEXIST: no overwrite race
      } catch (err) {
        if (err.code === 'EEXIST') throw new HttpError(409, 'already_exists', 'The resource already exists');
        if (!['EPERM', 'ENOTSUP', 'EXDEV', 'EMLINK', 'ENOSYS'].includes(err.code)) throw err;
        try {
          await fs.promises.copyFile(tmp, loc.file, fs.constants.COPYFILE_EXCL);
        } catch (copyErr) {
          if (copyErr.code === 'EEXIST') throw new HttpError(409, 'already_exists', 'The resource already exists');
          throw copyErr;
        }
      }
    }
    await fs.promises.mkdir(path.dirname(loc.meta), { recursive: true });
    await fs.promises.writeFile(
      loc.meta,
      JSON.stringify({
        owner: req.ctx.userId,
        contentType: String(req.file.mimetype || '').slice(0, 200),
        size: req.file.size,
        uploadedAt: new Date().toISOString(),
      }),
    );
    res.json({ path: objectPath, fullPath: `${bucket}/${objectPath}` });
  } finally {
    if (tmp) await unlinkQuiet(tmp);
  }
});

router.post('/sign', requireOrg(), allow('read'), async (req, res) => {
  const { config, db } = req.app.locals;
  const body = req.body || {};
  const bucket = files.validateBucket(body.bucket);
  await assertBucketModule(db, req.ctx.orgId, bucket);
  const objectPath = files.validateObjectPath(body.path);
  let seconds = body.expiresIn === undefined || body.expiresIn === null ? files.MAX_SIGN_SECONDS : body.expiresIn;
  if (!Number.isFinite(seconds) || seconds <= 0) throw badRequest('invalid_expires_in', 'expiresIn must be a positive number of seconds');
  seconds = Math.min(Math.floor(seconds), files.MAX_SIGN_SECONDS) || 1; // links never outlive 10 minutes
  const loc = files.locate(config, req.ctx.orgId, bucket, objectPath);
  if (!(await files.statFile(loc.file))) throw notFound('not_found', 'Object not found');
  const token = files.signToken(config, {
    orgId: req.ctx.orgId,
    bucket,
    objectPath,
    expiresAt: Math.floor(Date.now() / 1000) + seconds,
  });
  res.json({ signedUrl: `/api/files/signed?token=${token}` });
});

// <img src> and <a href> cannot send X-Org-Slug, so in development the
// clinic may also be named with ?org=<slug>; membership is checked as usual.
router.get('/object/:bucket/*objectPath', requireOrg({ queryParam: 'org' }), allow('read'), async (req, res) => {
  const { config, db } = req.app.locals;
  await assertBucketModule(db, req.ctx.orgId, files.validateBucket(req.params.bucket));
  const segments = req.params.objectPath;
  const objectPath = Array.isArray(segments) ? segments.join('/') : String(segments || '');
  const loc = files.locate(config, req.ctx.orgId, req.params.bucket, objectPath);
  if (!(await files.statFile(loc.file))) throw notFound('not_found', 'Object not found');
  await files.sendObject(res, loc.file, objectPath, await files.readMeta(loc.meta));
});

router.get('/signed', async (req, res) => {
  const { config, db } = req.app.locals;
  const t = files.verifyToken(config, req.query.token);
  const loc = files.locate(config, t.orgId, t.bucket, t.objectPath);
  // A suspended or closed clinic loses access to its files immediately.
  const { rows } = await db.query('select status from organizations where id = $1', [t.orgId]);
  if (!rows[0] || rows[0].status !== 'active') throw forbidden('org_inactive', 'This clinic is not active');
  // ... and so does a clinic whose files module was turned off after signing.
  await assertBucketModule(db, t.orgId, t.bucket);
  if (!(await files.statFile(loc.file))) throw notFound('not_found', 'Object not found');
  await files.sendObject(res, loc.file, t.objectPath, await files.readMeta(loc.meta));
});

router.post('/remove', requireOrg(), async (req, res) => {
  const { config, db } = req.app.locals;
  const body = req.body || {};
  const bucket = files.validateBucket(body.bucket);
  await assertBucketModule(db, req.ctx.orgId, bucket);
  if (!Array.isArray(body.paths) || body.paths.length === 0 || body.paths.length > 1000) {
    throw badRequest('invalid_paths', 'paths must be an array of 1-1000 paths');
  }
  const objectPaths = body.paths.map((p) => files.validateObjectPath(p));
  const canRemoveAny = files.FILE_ROLES.removeAny.includes(req.ctx.role);
  const removed = [];
  for (const objectPath of [...new Set(objectPaths)]) {
    const loc = files.locate(config, req.ctx.orgId, bucket, objectPath);
    if (!(await files.statFile(loc.file))) continue;
    if (!canRemoveAny) {
      // Like the old storage policy: other roles may remove what they uploaded.
      const meta = await files.readMeta(loc.meta);
      if (!meta || meta.owner !== req.ctx.userId) continue;
    }
    await fs.promises.unlink(loc.file);
    await unlinkQuiet(loc.meta);
    removed.push(objectPath);
  }
  res.json({ removed });
});

module.exports = router;
