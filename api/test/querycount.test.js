'use strict';
// No N+1 (docs/06 S9): every list endpoint runs the same number of SQL
// statements for a handful of rows as for many. db.queryCount() counts the
// statements of every pooled connection (BEGIN, set_config and COMMIT
// included); the requests here run one after another, so the difference
// around a request is that request's statements. setup() wipes and
// re-seeds the database for this file.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, ORG, USER } = require('./helpers');

let h, admin, sa;
before(async () => {
  h = await setup();
  admin = await h.as('physioAdmin', { slug: 'demo-physio' });
  sa = await h.as('superAdmin', { platform: true });
});
after(async () => { await h.close(); });

const ENDPOINTS = () => [
  [admin, '/api/org/members'],
  [admin, '/api/org/invitations'],
  [admin, '/api/org/usage'],
  [sa, '/api/platform/organizations?limit=200'],
  [sa, `/api/platform/organizations/${ORG.physio}`],
  [sa, `/api/platform/organizations/${ORG.physio}/invitations`],
  [sa, '/api/platform/audit?limit=200'],
  [sa, '/api/platform/plans'],
  [sa, '/api/platform/errors?status=all&limit=200'],
];

async function statements(client, url) {
  const db = h.app.locals.db;
  const start = db.queryCount();
  const res = await client.get(url);
  assert.equal(res.status, 200, `${url}: ${res.text}`);
  return { n: db.queryCount() - start, body: res.body };
}

const rows = (body) => (Array.isArray(body) ? body.length : Array.isArray(body.data) ? body.data.length
  : Array.isArray(body.members) ? body.members.length : 1);

async function addRows(n) {
  // Seats: the plan of the demo clinics would refuse 60 more members (PL422).
  await h.sql('update public.subscription_plans set max_users = null');
  await h.sql(
    `insert into auth.users (id, email, encrypted_password, raw_user_meta_data, status)
     select gen_random_uuid(), 'n1-' || i || '@bulk.test', 'x', '{}', 'active' from generate_series(1, $1) i`, [n]);
  await h.sql(
    `insert into public.organization_members (organization_id, user_id, role, status, joined_at)
     select $1, u.id, 'receptionist', 'active', now() from auth.users u where u.email like 'n1-%@bulk.test'`, [ORG.physio]);
  await h.sql(
    `insert into public.member_branches (member_id, branch_id, organization_id)
     select m.id, 'br-demo-physio-1', m.organization_id from public.organization_members m
       join auth.users u on u.id = m.user_id where u.email like 'n1-%@bulk.test'`);
  await h.sql(
    `insert into public.invitations (organization_id, email, token_hash, role, branch_ids, invited_by)
     select $1, 'n1-invite-' || i || '@bulk.test', md5('n1-' || i), 'receptionist', '{br-demo-physio-1}', $2
       from generate_series(1, $3) i`, [ORG.physio, USER.physioAdmin.id, n]);
  await h.sql(
    `insert into public.organizations (name, slug, primary_specialty_id, status, plan_id, created_by)
     select 'N1 ' || i, 'apitest-n1-' || i, s.id, 'active', p.id, $2::uuid
       from generate_series(1, $1) i, public.specialties s, public.subscription_plans p
      where s.code = 'physio' and p.code = 'default'`, [n, USER.superAdmin.id]);
  await h.asSystem(
    `insert into public.audit_events (organization_id, actor_uid, actor_role, action, table_name, row_pk, result)
     select $1, $2, 'admin', 'n1.test', 'organizations', i::text, 'success' from generate_series(1, $3) i`,
    [ORG.physio, USER.physioAdmin.id, n]);
  await h.sql(
    `insert into public.error_groups (fingerprint, source, message)
     select md5('n1-' || i), 'api', 'n1 error ' || i from generate_series(1, $1) i`, [n]);
}

test('list endpoints: the same number of SQL statements with a few rows and with 60 more of each', async () => {
  const few = [];
  for (const [client, url] of ENDPOINTS()) few.push(await statements(client, url));
  await addRows(60);
  for (const [i, [client, url]] of ENDPOINTS().entries()) {
    const many = await statements(client, url);
    if (!url.includes('/usage') && !url.includes('/plans') && !/organizations\/[0-9a-f-]{36}$/.test(url)) {
      assert.ok(rows(many.body) >= rows(few[i].body) + 60, `${url}: 60 more rows (${rows(few[i].body)} → ${rows(many.body)})`);
    }
    assert.equal(many.n, few[i].n, `${url}: ${few[i].n} statements with ${rows(few[i].body)} rows, ${many.n} with ${rows(many.body)}`);
  }
});

test('the counter sees statements inside transactions too (BEGIN … COMMIT)', async () => {
  const db = h.app.locals.db;
  const start = db.queryCount();
  await db.withContext({ system: true }, async (c) => { await c.query('select 1'); await c.query('select 2'); });
  assert.equal(db.queryCount() - start, 5, 'BEGIN, set_config, 2 selects, COMMIT');
  const s2 = db.queryCount();
  await db.query('select 1');
  assert.equal(db.queryCount() - s2, 1);
});
