'use strict';
// Serves the built frontend (DIST_DIR, default ../dist) for every non-/api
// GET/HEAD request, on every domain (clinicsyseg.com, *.clinicsyseg.com,
// admin.clinicsyseg.com). Unknown routes get index.html (SPA); a missing
// file with an extension is a real 404. Dotfiles are never served.

const path = require('path');
const express = require('express');

const HASHED_ASSET = /\.[0-9a-f]{8,}\.(?:js|mjs|css)$/i; // app.4ee0f65b03.js

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
      if (base === 'index.html') res.setHeader('Cache-Control', 'no-cache');
      else if (HASHED_ASSET.test(base)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      else res.setHeader('Cache-Control', 'public, max-age=3600');
    },
  });

  const spaFallback = (req, res, next) => {
    if (!isRead(req) || isApiPath(req.path)) return next();
    const last = req.path.split('/').pop() || '';
    if (last.includes('.')) return notFoundText(res);
    res.sendFile(indexFile, { headers: { 'Cache-Control': 'no-cache' }, dotfiles: 'allow' }, (err) => {
      if (err && !res.headersSent) {
        res.status(404).type('text/plain; charset=utf-8').send('Frontend not built: run "npm run build" (dist/ missing)');
      }
    });
  };

  return [guard, serve, spaFallback];
}

module.exports = { staticHandlers, HASHED_ASSET };
