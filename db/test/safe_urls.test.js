// 0017_safe_file_urls (security audit, 25 Oct 2026): file_url of
// patient_files and payment_receipts is written by any clinic member
// through /api/data and opened by another one (window.open, <a href>), so
// the database accepts only an http(s) URL or a path of the site: a
// `javascript:` or `data:` link would run script in the reader's session
// (CWE-79). Rows written before the constraint are not re-checked (NOT VALID).
// Every test runs inside BEGIN ... ROLLBACK.
'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { ensureDatabase, inTx, expectError, loadFixtures, actAs, suffix } = require('./helpers');

let fx;
before(async () => {
  await ensureDatabase();
  await inTx(async (c) => { fx = await loadFixtures(c); });
});

const BAD = [
  'javascript:alert(document.cookie)',
  'JavaScript:alert(1)',
  ' javascript:alert(1)',
  'java\tscript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'vbscript:msgbox(1)',
  '//evil.example/x',
  '/\\evil.example/x',
];
const GOOD = [
  null,
  '',
  '/api/files/object/patient-files/P-1/a.pdf',
  'https://abc.supabase.co/storage/v1/object/public/patient-files/P-1/a.pdf',
  'http://localhost:3000/api/files/object/patient-files/P-1/a.pdf',
];

test('0017: patient_files.file_url refuses script URLs on insert and update, keeps http(s) and site paths', async () => {
  await inTx(async (c) => {
    // The therapist may add files (staff insert patient_files); the receptionist may edit them.
    await actAs(c, fx, 'therapist', 'demo-physio');
    for (const url of BAD) {
      await expectError(c, `insert into patient_files (file_id, patient_id, file_name, file_url) values ($1, null, 'x.pdf', $2)`,
        [`pf-bad-${suffix()}`, url], /^23514 .*patient_files_file_url_safe/);
    }
    const ids = [];
    for (const url of GOOD) {
      const id = `pf-ok-${suffix()}`;
      await c.query(`insert into patient_files (file_id, patient_id, file_name, file_url) values ($1, null, 'x.pdf', $2)`, [id, url]);
      ids.push(id);
    }
    await actAs(c, fx, 'receptionist', 'demo-physio');
    for (const url of BAD) {
      await expectError(c, 'update patient_files set file_url = $2 where file_id = $1', [ids[2], url], /^23514 .*patient_files_file_url_safe/);
    }
    assert.equal((await c.query('update patient_files set file_url = $2 where file_id = $1', [ids[2], GOOD[3]])).rowCount, 1);
  });
});

test('0017: payment_receipts.file_url refuses script URLs too', async () => {
  await inTx(async (c) => {
    await actAs(c, fx, 'receptionist', 'demo-physio');
    for (const url of BAD) {
      await expectError(c, `insert into payment_receipts (receipt_id, file_url) values ($1, $2)`,
        [`rcpt-bad-${suffix()}`, url], /^23514 .*payment_receipts_file_url_safe/);
    }
    for (const url of GOOD) {
      await c.query('insert into payment_receipts (receipt_id, file_url) values ($1, $2)', [`rcpt-ok-${suffix()}`, url]);
    }
  });
});

test('0017: the constraints are NOT VALID (old rows are not re-checked by the migration)', async () => {
  await inTx(async (c) => {
    const { rows } = await c.query(`
      select conname, convalidated from pg_constraint
       where conname in ('patient_files_file_url_safe', 'payment_receipts_file_url_safe') order by conname`);
    assert.deepEqual(rows.map((r) => ({ ...r })), [
      { conname: 'patient_files_file_url_safe', convalidated: false },
      { conname: 'payment_receipts_file_url_safe', convalidated: false },
    ]);
  });
});
