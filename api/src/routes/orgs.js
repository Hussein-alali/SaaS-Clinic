'use strict';
// /api/orgs/* (docs/02-TRD.md "العيادة الحالية").
//   GET /resolve?slug=   public: what the login page needs before sign-in
//   GET /current         member: the clinic + role + allowed branches

const express = require('express');
const { notFound } = require('../errors');
const tenant = require('../tenant');

const router = express.Router();

router.get('/resolve', async (req, res) => {
  const { config, db } = req.app.locals;
  let slug = typeof req.query.slug === 'string' ? req.query.slug.trim().toLowerCase() : '';
  if (!slug) {
    const t = tenant.resolveTenant(req, config);
    slug = t.slug || '';
  }
  res.set('Cache-Control', 'no-store');
  const org = tenant.isValidSlug(slug) ? await tenant.findOrganization(db, slug) : null;
  // Only active clinics, and clinics waiting for their first admin to accept
  // the invitation, are described. A suspended clinic reveals nothing but its
  // status; closed, draft and unknown clinics are indistinguishable (404).
  if (org && org.status === 'suspended') return res.json({ slug: org.slug, status: 'suspended' });
  if (!org || !['active', 'pending_activation'].includes(org.status)) throw notFound('org_not_found', 'Clinic not found');
  res.json(await tenant.organizationPublicInfo(db, org));
});

router.get('/current', tenant.requireOrg(), async (req, res) => {
  const { db } = req.app.locals;
  const org = await tenant.findOrganization(db, req.ctx.slug);
  const [info, branches] = await Promise.all([
    tenant.organizationPublicInfo(db, org),
    db.withContext({ userId: req.ctx.userId, orgId: req.ctx.orgId }, (client) => tenant.accessibleBranches(client, req.ctx, true)),
  ]);
  res.set('Cache-Control', 'no-store');
  res.json({ organization: info, role: req.ctx.role, branches, current_branch_id: req.ctx.branchId });
});

module.exports = router;
