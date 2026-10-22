'use strict';
// /api/org/invitations (clinic admin) and /api/invitations/:token (public
// view + accept), against the real schema + seed.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { setup, sessionCookie, USER, ORG, BRANCH, PASSWORD } = require('./helpers');

let h;
before(async () => {
  h = await setup();
});
after(async () => {
  await h.close();
});

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const physioAdmin = () => h.as('physioAdmin', { slug: 'demo-physio' });

/** The invitation token from the newest e-mail sent to `email`. */
function tokenFor(email) {
  const mails = h.outbox().filter((m) => m.to === email);
  assert.ok(mails.length, `an e-mail was sent to ${email}`);
  const m = /[?&]invite=([A-Za-z0-9_-]+)/.exec(mails[mails.length - 1].text);
  assert.ok(m, 'the e-mail carries the invitation link');
  return m[1];
}

/** An invitation inserted directly, with a known token. */
async function rawInvitation({ orgId = ORG.physio, email, role = 'doctor', branchIds = [BRANCH.physio1], expires = "now() + interval '7 days'" }) {
  const token = crypto.randomBytes(24).toString('base64url');
  const { rows: [row] } = await h.sql(
    `insert into invitations (organization_id, email, token_hash, role, branch_ids, invited_by, expires_at)
     values ($1, $2, $3, $4, $5, $6, ${expires}) returning id`,
    [orgId, email, sha256(token), role, branchIds, USER.physioAdmin.id],
  );
  return { token, id: row.id };
}

async function member(orgId, email) {
  const { rows } = await h.sql(
    `select m.id, m.role, m.status,
            coalesce((select array_agg(mb.branch_id order by mb.branch_id) from member_branches mb where mb.member_id = m.id), '{}') as branches
       from organization_members m join auth.users u on u.id = m.user_id
      where m.organization_id = $1 and lower(u.email) = lower($2)`,
    [orgId, email],
  );
  return rows[0] || null;
}

const audits = async (action, orgId = ORG.physio) =>
  (await h.asSystem('select * from audit_events where action = $1 and organization_id = $2 order by id', [action, orgId])).rows;

test('admin invites: 201, token only in the e-mail (SHA-256 stored), 7 days, link with ?invite= (+ ?org= in dev), audited', async () => {
  const admin = await physioAdmin();
  const before = Date.now();
  const res = await admin.post('/api/org/invitations', { email: ' New.Doctor@Demo-Physio.test ', role: 'doctor', branch_ids: [BRANCH.physio2] });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.body.email_sent, true);
  const inv = res.body.invitation;
  assert.equal(inv.email, 'new.doctor@demo-physio.test');
  assert.equal(inv.role, 'doctor');
  assert.deepEqual(inv.branch_ids, [BRANCH.physio2]);
  assert.equal(inv.status, 'pending');
  assert.equal(inv.organization_id, ORG.physio);
  assert.equal(inv.invited_by, USER.physioAdmin.id);
  const days = (Date.parse(inv.expires_at) - before) / 86400000;
  assert.ok(days > 6.99 && days < 7.01, `expires in 7 days (${days})`);
  assert.ok(!('token' in inv) && !('token_hash' in inv) && !res.text.includes('invite='));

  const mails = h.outbox().filter((m) => m.to === 'new.doctor@demo-physio.test');
  assert.equal(mails.length, 1);
  const token = tokenFor('new.doctor@demo-physio.test');
  assert.ok(mails[0].text.includes(`http://demo-physio.localhost:${h.port}/?invite=${token}&org=demo-physio`), mails[0].text);
  assert.match(mails[0].subject, /عيادة العلاج الطبيعي التجريبية/);
  const { rows: [row] } = await h.sql('select token_hash from invitations where id = $1', [inv.id]);
  assert.equal(row.token_hash, sha256(token));
  const { rowCount } = await h.sql('select 1 from invitations where token_hash = $1', [token]);
  assert.equal(rowCount, 0, 'the plain token is not stored');

  const [a] = await audits('invitation.create');
  assert.equal(a.row_pk, inv.id);
  assert.equal(a.actor_uid, USER.physioAdmin.id);
  assert.equal(a.payload.email, 'new.doctor@demo-physio.test');

  const list = await admin.get('/api/org/invitations');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.map((i) => i.id), [inv.id]);
});

test('public view + accept with a NEW account: membership, branches, staff row, signed in, audited; then 410', async () => {
  const token = tokenFor('new.doctor@demo-physio.test');
  const view = await h.client().get(`/api/invitations/${token}`);
  assert.equal(view.status, 200, view.text);
  assert.deepEqual(
    { ...view.body, expires_at: typeof view.body.expires_at },
    {
      organization: { name: 'عيادة العلاج الطبيعي التجريبية', slug: 'demo-physio' },
      email: 'new.doctor@demo-physio.test', role: 'doctor', status: 'pending', expires_at: 'string', account_exists: false,
    },
  );
  const weak = await h.client().post(`/api/invitations/${token}/accept`, { password: '123', name: 'Doc' });
  assert.equal(weak.status, 400);
  assert.equal(weak.body.error.code, 'weak_password');
  const noName = await h.client().post(`/api/invitations/${token}/accept`, { password: 'Doctor#2026' });
  assert.equal(noName.status, 400);
  assert.equal(noName.body.error.code, 'invalid_name');

  const res = await h.client().post(`/api/invitations/${token}/accept`, { password: 'Doctor#2026', name: 'د. جديد' });
  assert.equal(res.status, 200, res.text);
  const cookie = sessionCookie(res);
  assert.ok(cookie, 'signed in');
  assert.equal(res.body.user.email, 'new.doctor@demo-physio.test');
  assert.equal(res.body.user.name, 'د. جديد');
  assert.equal(res.body.role, 'doctor');
  assert.deepEqual(res.body.memberships.map((m) => [m.slug, m.role]), [['demo-physio', 'doctor']]);
  assert.deepEqual(res.body.organization, { id: ORG.physio, slug: 'demo-physio', name: 'عيادة العلاج الطبيعي التجريبية', status: 'active' });

  const m = await member(ORG.physio, 'new.doctor@demo-physio.test');
  assert.equal(m.status, 'active');
  assert.equal(m.role, 'doctor');
  assert.deepEqual(m.branches, [BRANCH.physio2]);
  const { rows: [staff] } = await h.asSystem("select * from staff where organization_id = $1 and email = 'new.doctor@demo-physio.test'", [ORG.physio]);
  assert.equal(staff.role, 'doctor');
  assert.equal(staff.status, 'active');
  assert.equal(staff.name, 'د. جديد');
  assert.match(staff.staff_id, /^U-/);
  const { rows: [inv] } = await h.sql('select status from invitations where token_hash = $1', [sha256(token)]);
  assert.equal(inv.status, 'accepted');

  const current = await h.client({ cookie, slug: 'demo-physio' }).get('/api/orgs/current');
  assert.equal(current.body.role, 'doctor');
  assert.equal(current.body.current_branch_id, BRANCH.physio2);

  const [acc] = await audits('invitation.accept');
  assert.equal(acc.actor_uid, res.body.user.id);
  assert.equal(acc.payload.account, 'created');
  assert.equal(acc.target_id, m.id);
  assert.equal((await audits('user.create')).length, 1);

  for (const r of [await h.client().get(`/api/invitations/${token}`), await h.client().post(`/api/invitations/${token}/accept`, { password: 'Doctor#2026', name: 'x' })]) {
    assert.equal(r.status, 410);
    assert.equal(r.body.error.code, 'invitation_used');
  }
  const list = await (await physioAdmin()).get('/api/org/invitations');
  assert.equal(list.body[0].status, 'accepted');
});

test('accept with an EXISTING account requires that account\'s password and never overwrites it', async () => {
  const admin = await physioAdmin();
  const res = await admin.post('/api/org/invitations', { email: USER.dentalAdmin.email, role: 'therapist', branch_ids: [BRANCH.physio1] });
  assert.equal(res.status, 201, res.text);
  const token = tokenFor(USER.dentalAdmin.email);
  const view = await h.client().get(`/api/invitations/${token}`);
  assert.equal(view.body.account_exists, true);

  const wrong = await h.client().post(`/api/invitations/${token}/accept`, { password: 'Overwrite#1', name: 'Hijack' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error.code, 'invalid_credentials');
  assert.equal(sessionCookie(wrong), null);
  assert.equal(await member(ORG.physio, USER.dentalAdmin.email), null);
  await h.login(USER.dentalAdmin.email); // old password still works

  const ok = await h.client().post(`/api/invitations/${token}/accept`, { password: PASSWORD, name: 'ignored' });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body.user.name, 'مدير العيادة — DEN', 'the existing name is kept');
  assert.deepEqual(ok.body.memberships.map((m) => `${m.slug}:${m.role}`).sort(), ['demo-dental:admin', 'demo-physio:therapist']);
  const m = await member(ORG.physio, USER.dentalAdmin.email);
  assert.deepEqual(m.branches, [BRANCH.physio1]);
  await h.login(USER.dentalAdmin.email);
  const [acc] = (await audits('invitation.accept')).slice(-1);
  assert.equal(acc.payload.account, 'existing');
});

test('create validation: email, role, branches, already a member, duplicate pending; roles and clinic checks', async () => {
  const admin = await physioAdmin();
  const cases = [
    [{ email: 'bad', role: 'doctor', branch_ids: [BRANCH.physio1] }, 400, 'invalid_email'],
    [{ email: 'a@demo-physio.test', role: 'owner', branch_ids: [BRANCH.physio1] }, 400, 'invalid_role'],
    [{ email: 'a@demo-physio.test', role: 'doctor' }, 400, 'branch_required'],
    [{ email: 'a@demo-physio.test', role: 'doctor', branch_ids: [] }, 400, 'branch_required'],
    [{ email: 'a@demo-physio.test', role: 'doctor', branch_ids: [BRANCH.dental1] }, 400, 'invalid_branch'],
    [{ email: 'a@demo-physio.test', role: 'doctor', branch_ids: 'br' }, 400, 'invalid_branch_ids'],
    [{ email: USER.physioReception.email, role: 'doctor', branch_ids: [BRANCH.physio1] }, 409, 'already_member'],
  ];
  for (const [body, status, code] of cases) {
    const res = await admin.post('/api/org/invitations', body);
    assert.equal(res.status, status, `${code}: ${res.text}`);
    assert.equal(res.body.error.code, code);
  }
  const adminInvite = await admin.post('/api/org/invitations', { email: 'co.admin@demo-physio.test', role: 'admin' });
  assert.equal(adminInvite.status, 201, 'admin role: no branches needed (every branch)');
  assert.deepEqual(adminInvite.body.invitation.branch_ids, []);
  const dup = await admin.post('/api/org/invitations', { email: 'CO.ADMIN@demo-physio.test', role: 'doctor', branch_ids: [BRANCH.physio1] });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'invitation_exists');

  for (const who of ['physioReception', 'physioDoctor']) {
    const c = await h.as(who, { slug: 'demo-physio' });
    assert.equal((await c.get('/api/org/invitations')).status, 403, who);
    assert.equal((await c.post('/api/org/invitations', { email: 'z@demo-physio.test', role: 'doctor', branch_ids: [BRANCH.physio1] })).status, 403);
  }
  const dentalAdmin = await h.as('dentalAdmin', { slug: 'demo-dental' });
  const theirs = await dentalAdmin.get('/api/org/invitations');
  assert.ok(theirs.body.every((i) => i.organization_id === ORG.dental), 'only the own clinic');
  const physioInv = adminInvite.body.invitation.id;
  for (const r of [
    await dentalAdmin.post(`/api/org/invitations/${physioInv}/resend`, {}),
    await dentalAdmin.del(`/api/org/invitations/${physioInv}`),
  ]) {
    assert.equal(r.status, 404, 'another clinic\'s invitation does not exist here');
  }
});

test('expired → 410; resend issues a new token + 7 days (old token dead); revoke → 410; not pending → 409', async () => {
  const admin = await physioAdmin();
  const { token, id } = await rawInvitation({ email: 'late@demo-physio.test', expires: "now() - interval '1 minute'" });
  for (const r of [await h.client().get(`/api/invitations/${token}`), await h.client().post(`/api/invitations/${token}/accept`, { password: 'Late#2026', name: 'Late' })]) {
    assert.equal(r.status, 410);
    assert.equal(r.body.error.code, 'invitation_expired');
  }
  const listed = (await admin.get('/api/org/invitations')).body.find((i) => i.id === id);
  assert.equal(listed.status, 'expired');

  const resent = await admin.post(`/api/org/invitations/${id}/resend`, {});
  assert.equal(resent.status, 200, resent.text);
  assert.equal(resent.body.invitation.status, 'pending');
  assert.equal(resent.body.email_sent, true);
  const fresh = tokenFor('late@demo-physio.test');
  assert.notEqual(fresh, token);
  assert.equal((await h.client().get(`/api/invitations/${token}`)).status, 404, 'the old token is gone');
  assert.equal((await h.client().get(`/api/invitations/${fresh}`)).status, 200);
  assert.equal((await audits('invitation.resend')).length, 1);

  const del = await admin.del(`/api/org/invitations/${id}`);
  assert.equal(del.status, 204);
  const gone = await h.client().get(`/api/invitations/${fresh}`);
  assert.equal(gone.status, 410);
  assert.equal(gone.body.error.code, 'invitation_revoked');
  assert.equal((await admin.del(`/api/org/invitations/${id}`)).status, 409);
  const again = await admin.post(`/api/org/invitations/${id}/resend`, {});
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'invitation_not_pending');
  assert.equal((await audits('invitation.revoke')).length, 1);
  assert.equal((await admin.del('/api/org/invitations/not-a-uuid')).status, 404);
  const { rowCount } = await h.sql('select 1 from invitations where id = $1', [id]);
  assert.equal(rowCount, 1, 'revoked invitations are kept, not deleted');
});

test('plan user limit: a pending invitation holds a seat → 422 plan_limit:users; revoking frees it', async () => {
  const { rows: [{ n }] } = await h.sql(
    `select (select count(*) from organization_members where organization_id = $1 and status = 'active')
          + (select count(*) from invitations where organization_id = $1 and status = 'pending' and expires_at > now()) as n`,
    [ORG.physio],
  );
  const { rows: [plan] } = await h.sql(
    "insert into subscription_plans (code, name, max_users) values ('inv-limit', 'limit', $1) returning id",
    [Number(n) + 1],
  );
  const { rows: [{ plan_id: oldPlan }] } = await h.sql('select plan_id from organizations where id = $1', [ORG.physio]);
  await h.sql('update organizations set plan_id = $2 where id = $1', [ORG.physio, plan.id]);
  try {
    const admin = await physioAdmin();
    const first = await admin.post('/api/org/invitations', { email: 'seat1@demo-physio.test', role: 'doctor', branch_ids: [BRANCH.physio1] });
    assert.equal(first.status, 201, first.text);
    const second = await admin.post('/api/org/invitations', { email: 'seat2@demo-physio.test', role: 'doctor', branch_ids: [BRANCH.physio1] });
    assert.equal(second.status, 422);
    assert.deepEqual(second.body, { error: { message: 'plan_limit:users', code: 'PL422' } });
    assert.equal(h.outbox().filter((m) => m.to === 'seat2@demo-physio.test').length, 0);
    assert.equal((await admin.del(`/api/org/invitations/${first.body.invitation.id}`)).status, 204);
    const third = await admin.post('/api/org/invitations', { email: 'seat2@demo-physio.test', role: 'doctor', branch_ids: [BRANCH.physio1] });
    assert.equal(third.status, 201, third.text);
    // Re-sending an expired invitation takes a seat again.
    await h.sql("update invitations set expires_at = now() - interval '1 minute' where id = $1", [third.body.invitation.id]);
    await admin.post('/api/org/invitations', { email: 'seat3@demo-physio.test', role: 'doctor', branch_ids: [BRANCH.physio1] });
    const resend = await admin.post(`/api/org/invitations/${third.body.invitation.id}/resend`, {});
    assert.equal(resend.status, 422, resend.text);
  } finally {
    await h.sql("update invitations set status = 'revoked' where email like 'seat%' and status = 'pending'");
    await h.sql('update organizations set plan_id = $2 where id = $1', [ORG.physio, oldPlan]);
  }
});

test('accept: suspended clinic → 403, disabled account → 403, role staff → staff row without role, malformed token → 404', async () => {
  const susp = await rawInvitation({ orgId: ORG.suspended, email: 'x@demo-suspended.test', role: 'admin', branchIds: [] });
  for (const r of [await h.client().get(`/api/invitations/${susp.token}`), await h.client().post(`/api/invitations/${susp.token}/accept`, { password: 'Pass#2026', name: 'X' })]) {
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'org_inactive');
  }
  const dis = await rawInvitation({ email: USER.disabled.email });
  const d = await h.client().post(`/api/invitations/${dis.token}/accept`, { password: PASSWORD });
  assert.equal(d.status, 403);
  assert.equal(d.body.error.code, 'account_disabled');
  assert.equal(await member(ORG.physio, USER.disabled.email), null);

  const st = await rawInvitation({ email: 'plain.staff@demo-physio.test', role: 'staff' });
  const ok = await h.client().post(`/api/invitations/${st.token}/accept`, { password: 'Staff#2026', name: 'موظف' });
  assert.equal(ok.status, 200, ok.text);
  assert.equal((await member(ORG.physio, 'plain.staff@demo-physio.test')).role, 'staff');
  const { rows: [staff] } = await h.asSystem("select role, status from staff where email = 'plain.staff@demo-physio.test'");
  assert.deepEqual(staff, { role: null, status: 'active' }, "staff.role has no 'staff' value in 0001's CHECK");

  for (const t of ['short', 'x'.repeat(300), 'bad token with spaces!!!!!!!!!']) {
    assert.equal((await h.client().get(`/api/invitations/${encodeURIComponent(t)}`)).status, 404);
  }
  const csrf = await h.request('POST', `/api/invitations/${st.token}/accept`, { json: { password: 'x' } });
  assert.equal(csrf.status, 403, 'accept needs the CSRF header');
});

test('accept: wrong passwords for an existing account count like failed logins (429)', async () => {
  const inv = await rawInvitation({ email: USER.outsider.email });
  const c = h.client({ ip: '203.0.113.77' });
  for (let i = 0; i < 10; i += 1) {
    const r = await c.post(`/api/invitations/${inv.token}/accept`, { password: `wrong-${i}` });
    assert.equal(r.status, 401);
  }
  const blocked = await c.post(`/api/invitations/${inv.token}/accept`, { password: PASSWORD });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers['retry-after']) > 0);
  assert.equal(await member(ORG.physio, USER.outsider.email), null);
});

test('e-mail failures never lose the invitation: email_sent false (error) or null (slow SMTP)', async () => {
  const invites = require('../src/invites');
  const org = { slug: 'demo-physio', name: 'x' };
  const invitation = { email: 'slow@demo-physio.test', role: 'doctor' };
  const never = { send: () => new Promise(() => {}) };
  const t0 = Date.now();
  assert.equal(await invites.sendInvitationEmail({ mailer: never, config: h.config }, { org, invitation, token: 't'.repeat(43) }, 50), null);
  assert.ok(Date.now() - t0 < 2000);
  const broken = { send: async () => { throw new Error('SMTP down'); } };
  assert.equal(await invites.sendInvitationEmail({ mailer: broken, config: h.config }, { org, invitation, token: 't'.repeat(43) }), false);

  const real = h.app.locals.mailer;
  h.app.locals.mailer = broken;
  const origError = console.error;
  console.error = () => {};
  try {
    const admin = await physioAdmin();
    const res = await admin.post('/api/org/invitations', { email: 'nomail@demo-physio.test', role: 'doctor', branch_ids: [BRANCH.physio1] });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.email_sent, false);
    const resent = await admin.post(`/api/org/invitations/${res.body.invitation.id}/resend`, {});
    assert.equal(resent.body.email_sent, false);
  } finally {
    h.app.locals.mailer = real;
    console.error = origError;
  }
  const { rows: [inv] } = await h.sql("select status from invitations where email = 'nomail@demo-physio.test'");
  assert.equal(inv.status, 'pending');
});
