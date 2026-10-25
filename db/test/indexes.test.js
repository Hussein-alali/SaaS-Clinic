// Indexes for bounded loading (docs/06 S9, 0015_indexes): the screens read
// the time-series tables of one branch from a date onwards (the startup
// window) and one patient's rows on demand (patient history: patient ids are
// unique on the whole platform, so the patient_id indexes serve it). RLS alone
// cannot narrow an index scan to one clinic: tenant_isolation reaches the
// planner as `app_is_system() OR organization_id = app_org_id()`, and an OR
// is no index condition. So /api/data also sends `organization_id = <the
// current clinic>` (api/src/data-query.js), and the indexes lead with it.
// Every test works inside rolled-back transactions.
'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { ensureDatabase, inTx, loadFixtures, actAs, setContext } = require('./helpers');

let fx;
before(async () => {
  await ensureDatabase();
  await inTx(async (c) => { fx = await loadFixtures(c); });
});

// Index name and columns of every index on public.<table>.
async function indexesOf(c, table) {
  const { rows } = await c.query(
    `select i.relname as name,
            (select array_agg(a.attname::text order by k.ord)
               from unnest(x.indkey::int2[]) with ordinality k(attnum, ord)
               join pg_attribute a on a.attrelid = x.indrelid and a.attnum = k.attnum) as cols
       from pg_index x
       join pg_class i on i.oid = x.indexrelid
       join pg_class t on t.oid = x.indrelid
       join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = 'public' and t.relname = $1`, [table]);
  return rows;
}

const WINDOW = { bookings: 'date', sessions: 'date', invoices: 'created_at', payments: 'created_at' };
const BY_PATIENT = ['bookings', 'sessions', 'invoices', 'payments', 'patient_files', 'treatments'];

test('(organization_id, branch_id, <date>) on the time-series tables; a patient_id index for patient history', async () => {
  await inTx(async (c) => {
    for (const [table, col] of Object.entries(WINDOW)) {
      const idx = await indexesOf(c, table);
      assert.ok(idx.some((i) => i.cols.join() === `organization_id,branch_id,${col}`),
        `${table}: (organization_id, branch_id, ${col}) — has ${idx.map((i) => `(${i.cols})`).join(' ')}`);
    }
    for (const table of BY_PATIENT) {
      const idx = await indexesOf(c, table);
      assert.ok(idx.some((i) => i.cols[0] === 'patient_id'), `${table}: (patient_id) — has ${idx.map((i) => `(${i.cols})`).join(' ')}`);
    }
  });
});

// Ten years of a clinic's rows over its two branches and 50 patients (in
// the test's transaction, rolled back). Both demo clinics get them, and
// fresh statistics, so the planner chooses as it would on the live
// platform rather than on the seed.
async function tenYears(c, slug, n = 2000) {
  const org = fx.orgs[slug];
  const [b1, b2] = fx.branches[slug];
  await setContext(c, { system: true });
  const each = (sql) => c.query(sql.replace(/-IDX-/g, `-IDX-${slug === 'demo-physio' ? 'P' : 'D'}-`), [org, b1, b2, n]);
  await each(`insert into patients (organization_id, patient_id, name)
              select $1, 'P-IDX-' || i, 'idx ' || i from generate_series(1, 50) i where $2::text <> $3 and $4 > 0`);
  const common = `from generate_series(1, $4) i`;
  const branch = 'case when i % 2 = 0 then $2 else $3 end';
  const patient = `'P-IDX-' || (1 + i % 50)`;
  await each(`insert into bookings (organization_id, branch_id, booking_id, patient_id, date, time, status)
              select $1, ${branch}, 'B-IDX-' || i, ${patient}, current_date - (i % 3650), '10:00', 'مكتمل' ${common}`);
  await each(`insert into sessions (organization_id, branch_id, session_id, patient_id, date)
              select $1, ${branch}, 'S-IDX-' || i, ${patient}, current_date - (i % 3650) ${common}`);
  await each(`insert into invoices (organization_id, branch_id, invoice_id, patient_id, amount, paid, status, created_at)
              select $1, ${branch}, 'INV-IDX-' || i, ${patient}, 100, 100, 'مدفوع', now() - (i % 3650) * interval '1 day' ${common}`);
  await each(`insert into payments (organization_id, branch_id, payment_id, patient_id, amount, method, created_at)
              select $1, ${branch}, 'PMT-IDX-' || i, ${patient}, 100, 'cash', now() - (i % 3650) * interval '1 day' ${common}`);
  await each(`insert into patient_files (organization_id, file_id, patient_id, file_name)
              select $1, 'F-IDX-' || i, ${patient}, 'f' || i || '.pdf' from generate_series(1, $4 / 4) i where $2::text is not null and $3::text is not null`);
  await each(`insert into treatments (organization_id, branch_id, treatment_id, patient_id, therapist_id)
              select $1, ${branch}, 'TX-IDX-' || i, ${patient}, 'ST-PHY-THERAPIST' from generate_series(1, $4 / 4) i`);
}

// What is checked is that the queries of the screens, under RLS, are served
// by the new indexes with the clinic in the index condition.
async function plan(c, sql, params) {
  const { rows } = await c.query(`explain (format json) ${sql}`, params);
  return JSON.stringify(rows[0]['QUERY PLAN']);
}

const indexCond = (p, name) => {
  const node = p.match(new RegExp(`"Index Name":"${name}"[^}]*?"Index Cond":"([^"]*)"`));
  return node ? node[1] : null;
};

test('the screens\' queries (as /api/data sends them, under RLS) use them for the clinic, branch and date', async () => {
  await inTx(async (c) => {
    await tenYears(c, 'demo-physio');
    await tenYears(c, 'demo-dental');
    await c.query('analyze bookings, sessions, invoices, payments, patient_files, treatments, patients');
    await actAs(c, fx, 'admin', 'demo-physio');
    const org = fx.orgs['demo-physio'];
    const branch = fx.branches['demo-physio'][0];
    for (const [table, col] of Object.entries(WINDOW)) {
      const name = `${table}_org_branch_${col === 'date' ? 'date' : 'created'}_idx`;
      const p = await plan(c, `select * from ${table} where organization_id = $1 and branch_id = $2 and ${col} >= $3`,
        [org, branch, '2026-01-01']);
      const cond = indexCond(p, name);
      assert.ok(cond && /organization_id/.test(cond) && /branch_id/.test(cond) && new RegExp(col).test(cond), `${table}: ${p}`);
    }
    for (const table of BY_PATIENT) {
      const p = await plan(c, `select * from ${table} where organization_id = $1 and patient_id = $2`, [org, 'P-IDX-P-7']);
      assert.match(p, /"Index Cond":"[^"]*patient_id = /, `${table}: ${p}`);
    }
  });
});
