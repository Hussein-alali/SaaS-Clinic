'use strict';
// Serves the built frontend (DIST_DIR, default ../dist) for every non-/api
// GET/HEAD request, on every domain (clinicsyseg.com, *.clinicsyseg.com,
// admin.clinicsyseg.com). Unknown routes get index.html (SPA); a missing
// file with an extension is a real 404. Dotfiles are never served.

const fs = require('fs');
const path = require('path');
const express = require('express');

const HASHED_ASSET = /\.[0-9a-f]{8,}\.(?:js|mjs|css)$/i; // app.4ee0f65b03.js
const CSP_META = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/;

// The page's Content-Security-Policy is the <meta> the build writes into
// index.html (scripts/build.mjs); it is sent as a header too, with
// frame-ancestors, which a <meta> cannot carry. Read again when index.html
// changes; none when the build has no policy.
function pagePolicy(indexFile) {
  let cached = { mtimeMs: null, value: null };
  return () => {
    try {
      const { mtimeMs } = fs.statSync(indexFile);
      if (mtimeMs !== cached.mtimeMs) {
        const m = CSP_META.exec(fs.readFileSync(indexFile, 'utf8'));
        cached = { mtimeMs, value: m ? `${m[1]}; frame-ancestors 'none'` : null };
      }
    } catch (_) {
      cached = { mtimeMs: null, value: null };
    }
    return cached.value;
  };
}

function notFoundText(res) {
  res.status(404).type('text/plain; charset=utf-8').set('Cache-Control', 'no-cache').send('Not found');
}

function isApiPath(p) {
  return p === '/api' || p.startsWith('/api/');
}

function hasDotSegment(p) {
  let decoded = p;
  try {
    decoded = decodeURIComponent(p);
  } catch (_) {
    return true; // malformed escapes: refuse
  }
  return decoded.split(/[\\/]/).some((seg) => seg.startsWith('.'));
}

function staticHandlers(config) {
  const dist = config.distDir;
  const indexFile = path.join(dist, 'index.html');
  const policy = pagePolicy(indexFile);
  const pageHeaders = (res) => {
    res.setHeader('Cache-Control', 'no-cache');
    const csp = policy();
    if (csp) res.setHeader('Content-Security-Policy', csp);
  };
  const isRead = (req) => req.method === 'GET' || req.method === 'HEAD';

  const guard = (req, res, next) => {
    if (!isRead(req) || isApiPath(req.path)) return next();
    if (hasDotSegment(req.path)) return notFoundText(res);
    next();
  };

  const serve = express.static(dist, {
    dotfiles: 'ignore',
    index: false,
    redirect: false,
    fallthrough: true,
    setHeaders(res, filePath) {
      const base = path.basename(filePath);
      if (base === 'index.html') pageHeaders(res);
      else if (HASHED_ASSET.test(base)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      else res.setHeader('Cache-Control', 'public, max-age=3600');
    },
  });

  const spaFallback = (req, res, next) => {
    if (!isRead(req) || isApiPath(req.path)) return next();
    const last = req.path.split('/').pop() || '';
    if (last.includes('.')) return notFoundText(res);
    pageHeaders(res);
    res.sendFile(indexFile, { dotfiles: 'allow' }, (err) => {
      if (err && !res.headersSent) {
        res.status(404).type('text/plain; charset=utf-8').send('Frontend not built: run "npm run build" (dist/ missing)');
      }
    });
  };

  return [guard, serve, spaFallback];
}

module.exports = { staticHandlers, HASHED_ASSET };
