'use strict';
// POST /api/data — PostgREST replacement (docs/02-TRD.md "API contract").
// Needs a session and a current clinic; the statement runs inside
// withContext(req.ctx), so RLS decides which rows exist for this user.

const express = require('express');
const { HttpError, badRequest } = require('../errors');
const { requireOrg } = require('../tenant');
const { parseRequest, referencedColumns, checkOrganization, buildQuery } = require('../data-query');
const { assertModule, tableModule } = require('../modules');

const router = express.Router();

router.post('/', requireOrg(), async (req, res) => {
  const { db, catalog } = req.app.locals;
  const q = parseRequest(req.body);

  const meta = await catalog.getTable(q.table);
  if (!meta) throw badRequest('invalid_table', `Table "${q.table}" is not available`);
  // A table of a module the clinic has not enabled (AT-07): 403, rows kept.
  await assertModule(db, req.ctx.orgId, tableModule(q.table));
  const missing = await catalog.missingColumns(q.table, referencedColumns(q));
  if (missing.length) throw badRequest('invalid_column', `Unknown column(s) on ${q.table}: ${missing.join(', ')}`);
  // Re-read after a possible refresh so column metadata is current.
  const table = await catalog.getTable(q.table);
  checkOrganization(q, table, req.ctx.orgId);
  const plan = buildQuery(q, table, { orgId: req.ctx.orgId });

  const result = await db.withContext(req.ctx, async (client) => {
    let data = null;
    let count = null;
    if (q.action === 'select') {
      if (!q.head) data = (await client.query(plan.sql, plan.params)).rows;
      if (q.count) count = Number((await client.query(plan.countSql, plan.countParams)).rows[0].count);
    } else {
      const r = await client.query(plan.sql, plan.params);
      if (q.returning) data = r.rows;
      if (q.count) count = r.rowCount;
    }
    if (q.single && Array.isArray(data)) {
      // PostgREST semantics; thrown inside the transaction so a write that
      // fails the cardinality check is rolled back.
      if (data.length > 1 || (q.single === 'single' && data.length === 0)) {
        throw new HttpError(406, 'PGRST116', 'JSON object requested, multiple (or no) rows returned');
      }
      data = data.length ? data[0] : null;
    }
    return { data, count };
  });
  res.json(result);
});

module.exports = router;
