'use strict';
// /api/admin/* — clinic administration replacing the Supabase Edge Functions
// (docs/02-TRD.md "الإدارة داخل العيادة", plan task 2.7). Mounted by app.js
// at /api/admin; no routes yet.
//
// Building blocks for route authors:
//   const { requireOrg } = require('../tenant');      // session + active membership → req.ctx
//   const auth = require('../auth');                    // validatePassword, hashPassword, requireSession
//   const { badRequest, forbidden, HttpError } = require('../errors');
//   req.app.locals: { config, db, mailer, catalog }
//   db.withContext(req.ctx, async (client) => ...)      // RLS as the caller
//   db.withContext({ ...req.ctx, system: true }, fn)    // internal API operation (app.system = 'on')
// Express 5: async handlers may throw; the error handler answers {error:{message, code}}.

const express = require('express');

const router = express.Router();

module.exports = router;
