'use strict';
// Races through the API (docs/06 S4, 0010_concurrency), with requests that
// commit side by side: two receptionists confirming one therapist slot,
// twenty quick payments at once, and a payment sent twice with the same
// Idempotency-Key. setup() wipes and re-seeds the database for this file.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, newRecordId, BRANCH } = require('./helpers');

let h, admin, recep, recep2, dental;
before(async () => {
  h = await setup();
  admin = await h.as('physioAdmin', { slug: 'demo-physio', branch: BRANCH.physio1 });
  recep = await h.as('physioReception', { slug: 'demo-physio' });
  recep2 = await h.as('physioReception2', { slug: 'demo-physio', branch: BRANCH.physio1 });
  dental = await h.as('dentalReception', { slug: 'demo-dental' });
});
after(() => h.close());

const booking = (values) => ({
  table: 'bookings', action: 'insert',
  values: { booking_id: newRecordId('A-'), patient_id: 'P-PHY-01', date: '2099-03-03', time: '11:00', status: 'مؤكد', ...values },
});
const pay = (who, id, amount, headers) => who.rpc('record_quick_payment',
  { p_patient_id: 'P-PHY-01', p_allocations: [{ type: 'appointment', id, amount }], p_method: 'cash' }, headers);
async function priced(price) {
  const values = { booking_id: newRecordId('A-'), patient_id: 'P-PHY-01', date: '2099-04-04', time: '09:00', price };
  const r = await admin.data({ table: 'bookings', action: 'insert', values });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return values.booking_id;
}

test('two receptionists confirm the same therapist slot at the same moment: one booking, the other 409 slot_taken', async () => {
  for (let round = 0; round < 5; round++) {
    const time = `1${round}:30`;
    const [a, b] = await Promise.all([
      recep.data(booking({ therapist_id: 'ST-PHY-THERAPIST', time })),
      recep2.data(booking({ therapist_id: 'ST-PHY-THERAPIST', time, patient_id: 'P-PHY-02' })),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409], JSON.stringify([a.body, b.body]));
    assert.deepEqual((a.status === 409 ? a : b).body.error, { message: 'This time slot is already booked', code: 'slot_taken' });
    const { rows } = await h.asSystem(
      `select count(*)::int n from bookings where therapist_id = 'ST-PHY-THERAPIST' and date = '2099-03-03' and time = $1`, [time]);
    assert.equal(rows[0].n, 1, `round ${round}`);
  }
});

test('twenty quick payments at once: twenty receipts RCT-<today>-00001…00020 in the clinic; the other clinic has its own 00001', async () => {
  const ids = [];
  for (let i = 0; i < 20; i++) ids.push(await priced(10));
  const pays = await Promise.all(ids.map((id, i) => pay(i % 2 ? recep : admin, id, 10)));
  for (const p of pays) assert.equal(p.status, 200, JSON.stringify(p.body));
  const day = (await h.sql(`select to_char(now(), 'YYYYMMDD') d`)).rows[0].d;
  assert.deepEqual(pays.map((p) => p.body.receipt_no).sort(),
    Array.from({ length: 20 }, (_, i) => `RCT-${day}-${String(i + 1).padStart(5, '0')}`));
  assert.equal(new Set(pays.map((p) => p.body.payment_id)).size, 20);

  const den = await dental.rpc('record_quick_payment',
    { p_patient_id: 'P-DEN-01', p_allocations: [{ type: 'invoice', id: 'INV-DEN-B1-1', amount: 1 }], p_method: 'cash' });
  assert.equal(den.status, 200, JSON.stringify(den.body));
  assert.equal(den.body.receipt_no, `RCT-${day}-00001`);
});

test('Idempotency-Key: a payment sent twice (or twice at once) is made once, and the repeat gets the same answer', async () => {
  const id = await priced(100);
  const key = newRecordId('qp-');
  const first = await pay(recep, id, 20, { 'idempotency-key': key });
  const again = await pay(recep, id, 20, { 'idempotency-key': key });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(again.status, 200);
  assert.equal(first.headers['idempotency-replayed'], undefined);
  assert.equal(again.headers['idempotency-replayed'], 'true');
  assert.deepEqual(again.body, first.body);

  const key2 = newRecordId('qp-');
  const both = await Promise.all([pay(recep, id, 30, { 'idempotency-key': key2 }), pay(recep, id, 30, { 'idempotency-key': key2 })]);
  assert.deepEqual(both.map((r) => r.status), [200, 200]);
  assert.deepEqual(both[0].body, both[1].body);
  assert.deepEqual(both.map((r) => r.headers['idempotency-replayed'] || 'no').sort(), ['no', 'true']);

  const { rows: [b] } = await h.asSystem('select paid::numeric::float8 as paid from bookings where booking_id = $1', [id]);
  assert.equal(b.paid, 50, 'two payments (20 + 30), not four');
  const { rows: [n] } = await h.asSystem(
    `select count(*)::int n from payments where allocations @> $1::jsonb`, [JSON.stringify([{ id }])]);
  assert.equal(n.n, 2);

  // Without a key, the same request is a new payment.
  assert.equal((await pay(recep, id, 5)).status, 200);
  // Another user's key, a malformed key.
  const stolen = await pay(recep2, id, 20, { 'idempotency-key': key });
  assert.equal(stolen.status, 409);
  assert.equal(stolen.body.error.code, 'idempotency_conflict');
  for (const bad of ['short', 'has space inside', 'x'.repeat(101), 'slash/in/key']) {
    const r = await pay(recep, id, 1, { 'idempotency-key': bad });
    assert.equal(r.status, 400, bad);
    assert.equal(r.body.error.code, 'invalid_idempotency_key');
  }
  // A refused call keeps nothing: the same key then runs the corrected payment.
  const key3 = newRecordId('qp-');
  assert.equal((await pay(recep, id, 10000, { 'idempotency-key': key3 })).status, 400);
  const fixed = await pay(recep, id, 10, { 'idempotency-key': key3 });
  assert.equal(fixed.status, 200);
  assert.equal(fixed.headers['idempotency-replayed'], undefined);
});

// Security audit (25 Oct 2026, CWE-501): the payment's IP address used to
// come from the browser (which asked api.ipify.org); it is the request's
// now, whatever the client sends.
test('record_quick_payment stores the request\'s IP address, never the one the client claims', async () => {
  const id = await priced(5);
  const r = await recep.rpc('record_quick_payment',
    { p_patient_id: 'P-PHY-01', p_allocations: [{ type: 'appointment', id, amount: 5 }], p_method: 'cash', p_ip_address: '203.0.113.66' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const { rows: [p] } = await h.asSystem('select ip_address from payments where payment_id = $1', [r.body.payment_id]);
  assert.match(p.ip_address, /^(::ffff:)?127\.0\.0\.1$|^::1$/);
  const { rows: [a] } = await h.asSystem(
    `select payload->>'ip_address' as ip from audit_events where action = 'quick_payment' and row_pk = $1`, [r.body.payment_id]);
  assert.equal(a.ip, p.ip_address, 'the audit row too');
});
