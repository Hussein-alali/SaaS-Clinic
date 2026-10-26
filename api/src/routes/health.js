'use strict';
// GET /api/health (docs/06 S2): {ok, db, release}. 200 when one `select 1`
// answers within HEALTH_DB_TIMEOUT_MS, else 503. No session, no clinic: it is
// what scripts/deploy.sh polls after a restart and what monitoring calls.

const express = require('express');

const HEALTH_DB_TIMEOUT_MS = 2000;
const router = express.Router();

router.get('/', async (req, res) => {
  const { db, config } = req.app.locals;
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), HEALTH_DB_TIMEOUT_MS); });
  let up = true;
  try {
    await Promise.race([db.query('select 1'), timeout]);
  } catch {
    up = false;
  } finally {
    clearTimeout(timer);
  }
  res.status(up ? 200 : 503).json({ ok: up, db: up ? 'ok' : 'down', release: config.release || null });
});

module.exports = router;
