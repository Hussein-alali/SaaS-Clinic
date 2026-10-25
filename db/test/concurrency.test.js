// Race conditions in the database (docs/06 S4, 0010_concurrency): two
// receptionists confirming the same therapist / doctor slot at the same
// moment get one booking, and the other a BK409 'slot_taken'; receipt
// numbers come from a per-clinic, per-day counter instead of 5 random
// digits; payment ids from new_record_id(). Every test works inside
// rolled-back transactions; the races that need commits are in
// api/test/concurrency.test.js (its database is wiped and re-seeded).
'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { ensureDatabase, inTx, connect, setContext, expectError, loadFixtures, actAs, suffix } = require('./helpers');

let fx;
before(async () => {
  await ensureDatabase();
  await inTx(async (c) => { fx = await loadFixtures(c); });
});

// A date and time no seeded or other test booking uses, so the slots below
// are free (bookings.therapist_id / doctor_id reference the seeded staff).
const pad = (n) => String(n).padStart(2, '0');
const rnd = (n) => Math.floor(Math.random() * n);
const farDate = () => `2099-${pad(1 + rnd(12))}-${pad(1 + rnd(28))}`;
const farTime = () => `${pad(rnd(24))}:${pad(rnd(60))}`;
const TH = 'ST-PHY-THERAPIST', TH2 = 'TH-PHY-2', DR = 'DR-PHY-1';
const book = (c, row) => c.query(
  `insert into bookings (booking_id, patient_id, therapist_id, doctor_id, date, time, status)
   values ($1, $2, $3, $4, $5, $6, $7)`,
  [row.id, row.patient || 'P-PHY-01', row.therapist || null, row.doctor || null, row.date, row.time, row.status || 'مؤكد']);
// The screens save with INSERT ... ON CONFLICT DO UPDATE (src/supabase.jsx upsertRow).
const upsert = (c, row) => c.query(
  `insert into bookings (booking_id, patient_id, therapist_id, doctor_id, date, time, status, paid)
   values ($1, $2, $3, $4, $5, $6, $7, $8)
   on conflict (booking_id) do update set therapist_id = excluded.therapist_id, doctor_id = excluded.doctor_id,
     date = excluded.date, time = excluded.time, status = excluded.status, paid = excluded.paid`,
  [row.id, row.patient || 'P-PHY-01', row.therapist || null, row.doctor || null, row.date, row.time, row.status || 'مؤكد', row.paid || 0]);
const TAKEN = /^BK409 slot_taken/;

test('slot guard: one active booking per therapist and per doctor slot; cancelled and «متاح» rows do not count', async () => {
  await inTx(async (c) => {
    await actAs(c, fx, 'receptionist', 'demo-physio');
    const s = suffix(), date = farDate(), time = farTime(), later = `${time}x`;
    await book(c, { id: `BK-${s}-a`, therapist: TH, date, time });
    await expectError(c, `insert into bookings (booking_id, patient_id, therapist_id, date, time, status) values ($1, 'P-PHY-02', $2, $3, $4, 'pending')`,
      [`BK-${s}-b`, TH, date, ` ${time} `], TAKEN);
    await book(c, { id: `BK-${s}-c`, therapist: TH, date, time, status: 'ملغي' });
    await book(c, { id: `BK-${s}-d`, therapist: TH, date, time, status: 'متاح' });
    await book(c, { id: `BK-${s}-e`, therapist: TH, date, time: later });
    await book(c, { id: `BK-${s}-f`, therapist: TH2, date, time });
    // The doctor of a slot is checked the same way, on its own.
    await book(c, { id: `BK-${s}-g`, doctor: DR, date, time });
    await expectError(c, `insert into bookings (booking_id, patient_id, doctor_id, date, time) values ($1, 'P-PHY-03', $2, $3, $4)`,
      [`BK-${s}-h`, DR, date, time], TAKEN);
    // Saving the booking again (paid, completed) is not a second booking.
    await upsert(c, { id: `BK-${s}-a`, therapist: TH, date, time, paid: 100 });
    await c.query(`update bookings set status = 'مكتمل' where booking_id = $1`, [`BK-${s}-a`]);
    // Re-activating a cancelled booking, or moving one, into a taken slot is refused.
    await expectError(c, `update bookings set status = 'مؤكد' where booking_id = $1`, [`BK-${s}-c`], TAKEN);
    await expectError(c, `update bookings set time = $2 where booking_id = $1`, [`BK-${s}-e`, time], TAKEN);
    await expectError(c, `insert into bookings (booking_id, patient_id, therapist_id, date, time, status) values ($1, 'P-PHY-01', $2, $3, $4, 'متاح')
                          on conflict (booking_id) do update set status = 'مؤكد'`, [`BK-${s}-d`, TH, date, time], TAKEN);
    // Once the first is cancelled, the slot is free again.
    await c.query(`update bookings set status = 'cancelled' where booking_id = $1`, [`BK-${s}-a`]);
    await c.query(`update bookings set status = 'مؤكد' where booking_id = $1`, [`BK-${s}-c`]);
  });
});

test('slot guard: sees the whole clinic, not only the branches the caller can read', async () => {
  await inTx(async (c) => {
    // receptionist2 keeps branch 2 only (inside this transaction).
    await setContext(c, { system: true });
    await c.query(`delete from member_branches mb using organization_members m
                    where mb.member_id = m.id and m.user_id = $1 and mb.branch_id = 'br-demo-physio-1'`,
    [fx.user('receptionist2', 'demo-physio')]);
    const s = suffix(), date = farDate(), time = farTime();
    await actAs(c, fx, 'receptionist', 'demo-physio');
    await book(c, { id: `BK-${s}-1`, therapist: TH, date, time });
    await actAs(c, fx, 'receptionist2', 'demo-physio', { branch: 2 });
    assert.equal((await c.query(`select count(*)::int n from bookings where booking_id = $1`, [`BK-${s}-1`])).rows[0].n, 0,
      'branch 1 is out of sight');
    await expectError(c, `insert into bookings (booking_id, patient_id, therapist_id, date, time) values ($1, 'P-PHY-03', $2, $3, $4)`,
      [`BK-${s}-2`, TH, date, time], TAKEN);
  });
});

test('slot guard: the system context (seeds, data import) may write the history as it is; such duplicates stay editable', async () => {
  await inTx(async (c) => {
    const s = suffix(), date = farDate(), time = farTime();
    await setContext(c, { system: true, org: fx.orgs['demo-physio'], branch: fx.branches['demo-physio'][0] });
    await book(c, { id: `BK-${s}-1`, therapist: TH, date, time });
    await book(c, { id: `BK-${s}-2`, therapist: TH, date, time });
    await actAs(c, fx, 'receptionist', 'demo-physio');
    await upsert(c, { id: `BK-${s}-2`, therapist: TH, date, time, paid: 50 });
    await c.query(`update bookings set status = 'مكتمل', notes = 'done' where booking_id = $1`, [`BK-${s}-1`]);
  });
});

test('slot guard: two transactions booking the same slot wait for each other instead of both passing the check', async () => {
  const s = suffix(), date = farDate(), time = farTime();
  const a = await connect(), b = await connect();
  try {
    for (const c of [a, b]) {
      await c.query('begin');
      await actAs(c, fx, c === a ? 'receptionist' : 'admin', 'demo-physio');
    }
    await book(a, { id: `BK-${s}-a`, therapist: TH, date, time });
    let settled = false;
    const second = book(b, { id: `BK-${s}-b`, therapist: TH, date, time }).then(() => { settled = true; }, (e) => { settled = true; throw e; });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(settled, false, 'the second insert waits for the first transaction');
    await a.query('rollback'); // the first booking never happened: the second goes through
    await second;
  } finally {
    await a.query('rollback').catch(() => {});
    await b.query('rollback').catch(() => {});
    await a.end(); await b.end();
  }
});

test('receipt numbers: RCT-<day>-<5 digits> from a counter per clinic and day; payment ids from new_record_id()', async () => {
  await inTx(async (c) => {
    const s = suffix();
    const pay = async (slug, code, n) => {
      await actAs(c, fx, 'receptionist', slug);
      const booking = `BK-R-${s}-${code}-${n}`;
      await c.query(`insert into bookings (booking_id, patient_id, date, time, price) values ($1, $2, current_date, '09:00', 100)`, [booking, `P-${code}-01`]);
      return (await c.query(`select public.record_quick_payment(p_patient_id => $1, p_allocations => $2::jsonb, p_method => 'cash') as r`,
        [`P-${code}-01`, JSON.stringify([{ type: 'appointment', id: booking, amount: 10 }])])).rows[0].r;
    };
    const day = (await c.query(`select to_char(now(), 'YYYYMMDD') d`)).rows[0].d;
    const seq = (r) => { const m = new RegExp(`^RCT-${day}-(\\d{5,})$`).exec(r.receipt_no); assert.ok(m, r.receipt_no); return Number(m[1]); };
    const p1 = await pay('demo-physio', 'PHY', 1);
    const p2 = await pay('demo-physio', 'PHY', 2);
    const d1 = await pay('demo-dental', 'DEN', 1);
    const p3 = await pay('demo-physio', 'PHY', 3);
    assert.deepEqual([seq(p2) - seq(p1), seq(p3) - seq(p2)], [1, 1], 'consecutive in one clinic');
    await setContext(c, { system: true });
    const counters = (await c.query(`select o.slug, oc.value::int v from org_counters oc join organizations o on o.id = oc.organization_id
                                       where oc.name = $1`, [`receipt:${day}`])).rows;
    assert.deepEqual(Object.fromEntries(counters.map((r) => [r.slug, r.v])), { 'demo-physio': seq(p3), 'demo-dental': seq(d1) });
    for (const p of [p1, p2, p3, d1]) assert.match(p.payment_id, /^PMT-[0-9a-z]{8,9}[0-9a-z]{6}$/);
    assert.equal(new Set([p1, p2, p3, d1].map((p) => p.payment_id)).size, 4);
    // next_org_counter() is not reachable from a request: not in the RPC whitelist.
    assert.ok(!require('../../api/src/rpc-whitelist').RPC_WHITELIST.has('next_org_counter'));
  });
});

test('new_record_id(): the shape of newRecordId() in src/apiclient.jsx (prefix + base-36 time + 6 random)', async () => {
  await inTx(async (c) => {
    const { rows } = await c.query(`select public.new_record_id('A-') id, (extract(epoch from clock_timestamp()) * 1000)::bigint ms from generate_series(1, 200)`);
    const ids = rows.map((r) => r.id);
    assert.equal(new Set(ids).size, 200);
    for (const r of rows) {
      const m = /^A-([0-9a-z]+)([0-9a-z]{6})$/.exec(r.id);
      assert.ok(m, r.id);
      assert.ok(Math.abs(parseInt(m[1], 36) - Number(r.ms)) < 5000, `time part of ${r.id}`);
    }
  });
});

test('slot guard: a row of another clinic is refused by RLS, never answered with that clinic\'s slot', async () => {
  // A row of another clinic is refused by RLS first, never by the slot
  // guard (which would tell whether that clinic's slot is taken).
  await inTx(async (c) => {
    const s = suffix(), date = farDate(), time = farTime();
    await actAs(c, fx, 'receptionist', 'demo-dental');
    await book(c, { id: `BK-${s}-den`, patient: 'P-DEN-01', therapist: 'ST-DEN-THERAPIST', date, time });
    await actAs(c, fx, 'receptionist', 'demo-physio');
    const err = await expectError(c, `insert into bookings (booking_id, organization_id, patient_id, therapist_id, date, time) values ($1, $2, 'P-DEN-01', 'ST-DEN-THERAPIST', $3, $4)`,
      [`BK-${s}-x`, fx.orgs['demo-dental'], date, time]);
    assert.notEqual(err.code, 'BK409');
  });
});
