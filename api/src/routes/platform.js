'use strict';
// /api/platform/* — Super Admin (docs/02-TRD.md "Super Admin", plan task 2.7).
// Mounted by app.js at /api/platform; no routes yet. Guard every route with
// require('../auth').requireSuperAdmin. See routes/admin.js for the helpers
// available to route authors.

const express = require('express');

const router = express.Router();

module.exports = router;
