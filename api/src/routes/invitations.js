'use strict';
// /api/invitations/:token — public view/accept of an invitation
// (docs/02-TRD.md "الدعوات (عام)", plan task 2.7). Mounted by app.js at
// /api/invitations; no routes yet. Accepting signs the user in with
// require('../auth').issueSession(res, config, userRow, remember).
// See routes/admin.js for the helpers available to route authors.

const express = require('express');

const router = express.Router();

module.exports = router;
