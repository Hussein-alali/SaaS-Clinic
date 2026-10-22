'use strict';
// Frontend compatibility against the REAL API and schema (plan tasks 2.6 +
// 2.8): src/apiclient.jsx and src/supabase.jsx are loaded into a node:vm
// "browser" exactly as the bundle concatenates them (both are plain JS),
// with a real fetch to the API on an ephemeral port and a cookie jar for
// cs_session. Every Supabase call chain of src/supabase.jsx,
// src/screens1.jsx (audit_events insert) and src/import.jsx (getAuthStaff →
// KineticData.upsert/list → uploadPatientFile) is driven through the
// data-layer functions the screens call, signed in with ?org=demo-physio.
//
// FRONTEND_COMPAT_REPORT=1 prints one line per call: label, requests and
// HTTP statuses, result.

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { webcrypto } = require('crypto');
const { setup, USER, ORG, BRANCH, PASSWORD } = require('./helpers');

const SRC = path.resolve(__dirname, '..', '..', 'src');
const CODE = ['apiclient.jsx', 'supabase.jsx'].map((f) => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n;\n');
const REPORT = process.env.FRONTEND_COMPAT_REPORT === '1';
const report = [];

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}

class TestCustomEvent extends Event {
  constructor(type, init = {}) {
    super(type);
    this.detail = init.detail;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A vm "browser" at http://localhost/<search> running the app's data layer.
 * Requests to /api/* go to the test API with the jar's cookies; any other
 * URL (api.ipify.org in __clientIP) fails like an offline network.
 */
function browser(h, { who, search = '?org=demo-physio' } = {}) {
  const base = `http://127.0.0.1:${h.port}`;
  const jar = new Map();
  const log = [];
  let inflight = 0;
  let label = 'boot';
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

  function storeCookies(res) {
    const lines = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const line of lines) {
      const pair = line.split(';')[0];
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1);
      if (!value || /expires=thu, 01 jan 1970/i.test(line)) jar.delete(name);
      else jar.set(name, value);
    }
  }

  async function bfetch(url, init = {}) {
    const u = String(url);
    if (!u.startsWith('/api/')) throw new TypeError('Failed to fetch');
    inflight += 1;
    try {
      const headers = { ...(init.headers || {}) };
      if (jar.size) headers.Cookie = cookieHeader();
      const res = await fetch(base + u, { ...init, headers });
      storeCookies(res);
      let body = null;
      if (typeof init.body === 'string') {
        try { body = JSON.parse(init.body); } catch (_) { body = null; }
      }
      let answer = null;
      try { answer = JSON.parse(await res.clone().text()); } catch (_) { answer = null; }
      const error = answer && answer.error;
      log.push({
        label,
        method: init.method || 'GET',
        path: u.split('?')[0],
        table: body && body.table,
        action: body && body.action,
        status: res.status,
        code: error && typeof error === 'object' ? error.code : typeof error === 'string' ? error : null,
        org: headers['X-Org-Slug'] || null,
        branch: headers['X-Branch-Id'] || null,
      });
      return res;
    } finally {
      inflight -= 1;
    }
  }

  const events = new EventTarget();
  const quiet = () => {};
  const win = {
    console: { log: quiet, info: quiet, warn: quiet, error: quiet, debug: quiet },
    setTimeout, clearTimeout, setInterval, clearInterval,
    URLSearchParams, FormData, Blob, Response, Headers, TextEncoder, TextDecoder, Event,
    CustomEvent: TestCustomEvent,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    location: { search, hostname: 'localhost', origin: 'http://localhost', pathname: '/', href: `http://localhost/${search}` },
    sessionStorage: memoryStorage(),
    localStorage: memoryStorage(),
    crypto: webcrypto,
    fetch: bfetch,
  };
  win.window = win;
  win.self = win;
  // src/core.jsx (loaded before the screens) creates the in-memory mirror.
  win.DATA = {
    patients: [], appts: [], therapists: [], departments: [], doctors: [], receptionists: [], schedules: [],
    packages: [], payments: [], campaigns: [], sessions: [], paymentHistory: [], subscriptions: [], treatmentMethods: [],
  };
  vm.createContext(win);
  vm.runInContext(CODE, win, { filename: 'apiclient.jsx+supabase.jsx' });

  /** Waits until no request is in flight (and stays so for a few ticks). */
  async function idle(timeoutMs = 15000) {
    const until = Date.now() + timeoutMs;
    let quietTicks = 0;
    while (quietTicks < 4) {
      if (Date.now() > until) throw new Error('requests still in flight');
      await sleep(5);
      quietTicks = inflight === 0 ? quietTicks + 1 : 0;
    }
  }

  /** Runs fn(window) as one labelled frontend call; returns {out, error, reqs}. */
  async function call(name, fn) {
    await idle();
    label = name;
    const start = log.length;
    let out;
    let error = null;
    try {
      out = await fn(win);
    } catch (err) {
      error = err;
    }
    await idle();
    const reqs = log.slice(start);
    report.push({ who, name, reqs, out, error });
    return { out, error, reqs };
  }

  return { win, log, jar, idle, call, base, cookieHeader };
}

// Values created inside the vm have their own prototypes: compare plain copies.
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const statuses = (reqs) => reqs.map((r) => r.status);
const describeReq = (r) => `${r.method} ${r.path}${r.table ? `[${r.action}:${r.table}]` : ''} ${r.status}${r.code ? ` ${r.code}` : ''}`;
const fileBlob = (text, type, name) => Object.assign(new Blob([text], { type }), { name });
/** Asserts every request of a call answered `status` (default 200). */
function allOk(res, status = 200) {
  assert.ok(res.reqs.length > 0, 'the call reached the API');
  for (const r of res.reqs) assert.equal(r.status, status, describeReq(r));
}

let h;
before(async () => {
  h = await setup();
});
after(async () => {
  if (REPORT) {
    for (const r of report) {
      const out = r.error ? `THROWS ${r.error.message}` : JSON.stringify(r.out === undefined ? null : r.out);
      console.log(`[${r.who}] ${r.name}\n    ${r.reqs.map(describeReq).join('\n    ') || '(no request)'}\n    → ${String(out).slice(0, 240)}`);
    }
  }
  await h.close();
});

// ════════════════════════════════════════════════════════════════════════
describe('clinic admin (admin@demo-physio.test, ?org=demo-physio)', () => {
  let b;
  let W;
  const S = {};

  before(async () => {
    b = browser(h, { who: 'admin' });
    W = b.win;
    await b.idle();
  });

  test('boot before sign-in: loadClinic/loadSections/loadBranches/hydrate answer 401, nothing breaks', () => {
    const boot = b.log.filter((r) => r.label === 'boot');
    assert.equal(boot.length, 18, boot.map(describeReq).join('\n'));
    for (const r of boot) {
      assert.equal(r.status, 401, describeReq(r));
      assert.equal(r.org, 'demo-physio', 'X-Org-Slug from ?org=');
    }
    assert.deepEqual([...new Set(boot.map((r) => r.table))].sort(), [
      'bookings', 'branches', 'campaigns', 'clinic_settings', 'custom_sections', 'departments', 'doctors', 'invoices',
      'packages', 'patient_schedules', 'patient_subscriptions', 'patients', 'payments', 'receptionists', 'sessions',
      'staff', 'therapists', 'treatment_methods',
    ]);
  });

  test('signInEmail → POST /api/auth/login + staff by auth_uid (maybeSingle)', async () => {
    const res = await b.call('signInEmail', (w) => w.signInEmail(USER.physioAdmin.email, PASSWORD));
    assert.deepEqual(res.reqs.map(describeReq), ['POST /api/auth/login 200', 'POST /api/data[select:staff] 200']);
    assert.equal(res.out.ok, true);
    assert.equal(res.out.role, 'admin');
    assert.equal(res.out.staff.staff_id, 'ST-PHY-ADMIN');
    assert.equal(res.out.user.id, USER.physioAdmin.id);
    assert.equal(res.out.session.memberships[0].slug, 'demo-physio');
    assert.ok(b.jar.has('cs_session'));
    // What App.handleLogin does with the result.
    W.ME = { id: res.out.user.id, email: res.out.user.email, name: res.out.staff.name, role: 'admin', staff_id: res.out.staff.staff_id };
  });

  test('getSession / getAuthStaff / onAuthChange', async () => {
    const s = await b.call('getSession', (w) => w.getSession());
    assert.equal(s.reqs.length, 0, 'answered from the login');
    assert.equal(s.out.user.email, USER.physioAdmin.email);
    const a = await b.call('getAuthStaff', (w) => w.getAuthStaff());
    assert.deepEqual(a.reqs.map(describeReq), ['GET /api/auth/session 200', 'POST /api/data[select:staff] 200']);
    assert.equal(a.out.ok, true);
    assert.equal(a.out.role, 'admin');
    const o = await b.call('onAuthChange', (w) => {
      const off = w.onAuthChange(() => {});
      off();
      return typeof off;
    });
    assert.equal(o.out, 'function');
  });

  test('clinic_settings: loadClinic (eq id 1, maybeSingle) and saveClinic (update … select maybeSingle)', async () => {
    const l = await b.call('loadClinic', (w) => w.loadClinic());
    allOk(l);
    assert.equal(l.out.name, 'عيادة العلاج الطبيعي التجريبية');
    assert.equal(l.out.organization_id, ORG.physio);
    const s = await b.call('saveClinic', (w) => w.saveClinic({ subtitle: 'حفظ من اختبار التوافق', appointment_duration: 45 }));
    assert.deepEqual(s.reqs.map(describeReq), ['POST /api/data[update:clinic_settings] 200']);
    assert.equal(s.out.subtitle, 'حفظ من اختبار التوافق');
    assert.equal(s.out.appointment_duration, 45);
    const { rows } = await h.asSystem('select organization_id, subtitle from clinic_settings where subtitle = $1', ['حفظ من اختبار التوافق']);
    assert.deepEqual(rows.map((r) => r.organization_id), [ORG.physio], 'only this clinic\'s row changed');
  });

  test('custom_sections: load (order position), add (insert with "group"), update, remove', async () => {
    allOk(await b.call('loadSections', (w) => w.loadSections()));
    const add = await b.call('addSection', (w) => w.addSection({ label: 'قسم التوافق' }));
    allOk(add);
    const upd = await b.call('updateSection', (w) => w.updateSection(add.out.id, { label: 'قسم التوافق 2' }));
    allOk(upd);
    const check = await b.call('loadSections (verify)', (w) => w.loadSections());
    const row = check.out.find((s) => s.id === add.out.id);
    assert.equal(row.label, 'قسم التوافق 2');
    assert.equal(row.group, 'مخصص');
    assert.equal(row.organization_id, ORG.physio);
    allOk(await b.call('removeSection', (w) => w.removeSection(add.out.id)));
    const after = await b.call('loadSections (after remove)', (w) => w.loadSections());
    assert.ok(!after.out.some((s) => s.id === add.out.id));
  });

  test('branches: load (order created_at), add, update, remove', async () => {
    const l = await b.call('loadBranches', (w) => w.loadBranches());
    allOk(l);
    assert.deepEqual(plain(l.out.map((x) => x.id)), [BRANCH.physio1, BRANCH.physio2]);
    const add = await b.call('addBranch', (w) => w.addBranch({ name: 'فرع التوافق', rooms: 3 }));
    allOk(add);
    allOk(await b.call('updateBranch', (w) => w.updateBranch(add.out.id, { phone: '0225550000' })));
    const { rows } = await h.asSystem('select organization_id, phone, rooms from branches where id = $1', [add.out.id]);
    assert.deepEqual(rows, [{ organization_id: ORG.physio, phone: '0225550000', rooms: 3 }]);
    // The UI deletes a branch nothing references (0001 policy "admin write
    // branches"); docs/05 prefers status = 'inactive' (open decision).
    allOk(await b.call('removeBranch', (w) => w.removeBranch(add.out.id)));
  });

  test('hydrate: every DATA_TABLES table through selectAllRows (count exact), only this clinic', async () => {
    const res = await b.call('KineticData.list ×15', async (w) => {
      const out = {};
      for (const name of Object.keys(w.KineticData.tables)) out[name] = await w.KineticData.list(name);
      return out;
    });
    allOk(res);
    assert.equal(res.reqs.length, 15);
    const lists = res.out;
    assert.ok(lists.patients.length >= 4);
    assert.ok(lists.patients.every((p) => /^P-PHY-/.test(p.patient_id)), 'no other clinic rows');
    for (const [name, rows] of Object.entries(lists)) {
      for (const row of rows) {
        // Global treatment methods (organization_id null) are shared and read-only.
        if (name === 'treatmentMethods' && row.organization_id === null) continue;
        assert.equal(row.organization_id, ORG.physio, `${name} row of another clinic`);
      }
    }
    assert.ok(lists.treatmentMethods.some((m) => m.organization_id === null), 'global library methods visible');
    // Value formats the screens rely on (PostgREST JSON).
    const pay = lists.paymentHistory.find((p) => p.payment_id === 'PMT-PHY-B1-1');
    assert.ok(Array.isArray(pay.allocations));
    assert.equal(typeof pay.amount, 'number');
    assert.match(lists.appts[0].date, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(lists.patients[0].created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?\+00:00$/);
    assert.ok(Array.isArray(lists.schedules[0].days));
  });

  test('selectAllRows reads past the 1000-row cap: count exact, then pages ordered by the primary key', async () => {
    await h.asSystem(
      `insert into patients (patient_id, organization_id, name, phone)
       select 'P-BULK-' || lpad(g::text, 4, '0'), $1, 'bulk ' || g, '0100' from generate_series(1, 1100) g`,
      [ORG.physio],
    );
    try {
      const res = await b.call('KineticData.list patients (1104 rows)', (w) => w.KineticData.list('patients'));
      allOk(res);
      assert.equal(res.out.length, 1104);
      assert.equal(new Set(plain(res.out.map((p) => p.patient_id))).size, 1104, 'no duplicates across pages');
      assert.equal(res.reqs.length, 3, 'one counted request + two pages of 1000');
    } finally {
      await h.asSystem("delete from patients where patient_id like 'P-BULK-%'");
    }
  });

  test('KineticData.upsert (onConflict pk) for every DATA_TABLES table: insert, then update', async () => {
    const id = (p) => W.newRecordId(p);
    S.pid = id('P-');
    S.bid = id('A-');
    S.invId = id('INV-');
    S.rows = {
      patients: { patient_id: S.pid, name: 'مريض التوافق', phone: '01009998877', age: 30, gender: 'M', diagnosis: 'آلام الرقبة', notes: '', therapist_id: 'ST-PHY-THERAPIST', created_at: new Date().toISOString(), status: 'نشط', diag: 'UI only', th: 'UI only' },
      appts: { booking_id: S.bid, patient_id: S.pid, therapist_id: 'ST-PHY-THERAPIST', date: '2026-10-25', time: '10:30', status: 'pending', notes: '', created_at: new Date().toISOString(), patient: 'UI only' },
      schedules: { schedule_id: id('SCH-'), patient_id: S.pid, therapist_id: 'ST-PHY-THERAPIST', days: ['sat', 'mon'], time: '10:30', sessions_per_week: 2, allow_consecutive: false, active: true },
      sessions: { session_id: id('S-' + S.pid + '-'), patient_id: S.pid, therapist_id: 'ST-PHY-THERAPIST', date: '2026-10-25', pain_score: 4, mood: 2, goals: ['مرونة'], completed_exercises: ['تمدد'], session_notes: '', session_number: 1, status: 'in_progress', started_at: new Date().toISOString() },
      payments: { invoice_id: S.invId, patient_id: S.pid, amount: 500, paid: 0, payment_method: 'نقدي', status: 'pending', created_at: new Date().toISOString() },
      paymentHistory: { payment_id: id('PMT-'), patient_id: S.pid, cashier_id: 'ST-PHY-ADMIN', cashier_name: 'admin', amount: 25, method: 'cash', receipt_no: id('RCT-'), allocations: [], status: 'completed' },
      subscriptions: { subscription_id: id('PSUB-'), patient_id: S.pid, package_id: 'PKG-PHY-1', package_name: 'باقة', total_sessions: 10, used_sessions: 0, price: 1000, paid: 0, status: 'active' },
      staff: { staff_id: id('U-'), name: 'موظف بلا حساب', role: 'receptionist', phone: '0100', email: `${id('u').toLowerCase()}@demo-physio.test`, auth_uid: null, status: 'active', created_at: new Date().toISOString() },
      therapists: { id: id('TH-'), name: 'أخصائي التوافق', spec: 'عام', department_id: 'DEP-PHY-1', phone: null, license_number: null, notes: null, color: '#3366ff', max: 8, active: true, auth_uid: null },
      departments: { id: id('D-'), name_ar: 'قسم التوافق', name_en: 'Compat', description: '', icon: 'Layers', color: '#123456', sort_order: 2, active: true },
      doctors: { id: id('DR-'), name: 'طبيب التوافق', department_id: 'DEP-PHY-1', specialization: null, experience_years: 3, schedule: 'السبت - الخميس', status: 'متاح', color: '#654321', active: true, phone: null, license_number: null, notes: null, auth_uid: null },
      receptionists: { id: id('RC-'), name: 'استقبال التوافق', phone: null, notes: null, active: true, auth_uid: null },
      packages: { id: id('PK-'), name: 'باقة التوافق', sessions: 8, price: 1600, active: true, popular: false, color: '#00aa88', sold: 0 },
      campaigns: { id: id('CM-'), name: 'حملة التوافق', audience: 12, sent: 0, read: 0, replied: 0, status: 'مجدول', template: 'مرحبًا', schedule: 'غدًا', best: false },
      treatmentMethods: { method_id: id('TM-'), name: 'طريقة التوافق', category: 'يدوي', description: null, duration_minutes: 20, notes: null, status: 'active', created_by_name: 'admin' },
    };
    for (const [name, row] of Object.entries(S.rows)) {
      const ins = await b.call(`KineticData.upsert ${name} (insert)`, (w) => w.KineticData.upsert(name, row));
      allOk(ins);
      assert.equal(ins.out._ok, true, `${name}: ${ins.out._error}`);
    }
    // Partial upserts the screens send (status changes, edits).
    const updates = {
      appts: { booking_id: S.bid, patient_id: S.pid, status: 'مؤكد' },
      patients: { ...S.rows.patients, name: 'مريض التوافق (معدل)', updated_at: new Date().toISOString() },
      packages: { ...S.rows.packages, active: false },
      campaigns: { ...S.rows.campaigns, status: 'جارٍ' },
    };
    for (const [name, row] of Object.entries(updates)) {
      const upd = await b.call(`KineticData.upsert ${name} (update)`, (w) => w.KineticData.upsert(name, row));
      allOk(upd);
      assert.equal(upd.out._ok, true, `${name}: ${upd.out._error}`);
    }
    const { rows: [bk] } = await h.asSystem('select organization_id, branch_id, status, time from bookings where booking_id = $1', [S.bid]);
    assert.deepEqual(bk, { organization_id: ORG.physio, branch_id: BRANCH.physio1, status: 'مؤكد', time: '10:30' });
  });

  test('QuickPay: searchPatients, loadFinancials (3 selects), loadHistory (order desc + range), recordPayment (RPC)', async () => {
    const s = await b.call('QuickPay.searchPatients', (w) => w.QuickPay.searchPatients('التوافق'));
    assert.ok(s.out.some((p) => p.patient_id === S.pid));
    const f = await b.call('QuickPay.loadFinancials', (w) => w.QuickPay.loadFinancials(S.pid));
    allOk(f);
    assert.deepEqual(f.reqs.map((r) => r.table).sort(), ['bookings', 'invoices', 'patient_subscriptions']);
    assert.deepEqual(plain(f.out.invoices.map((i) => i.invoice_id)), [S.invId]);
    const hist = await b.call('QuickPay.loadHistory', (w) => w.QuickPay.loadHistory(S.pid));
    allOk(hist);
    const pay = await b.call('QuickPay.recordPayment', (w) =>
      w.QuickPay.recordPayment({ patient_id: S.pid, method: 'cash', reference: 'ref-1', allocations: [{ type: 'invoice', id: S.invId, amount: 100 }] }));
    allOk(pay);
    assert.equal(pay.reqs[0].path, '/api/rpc/record_quick_payment');
    assert.equal(pay.out.ok, true, pay.out.error);
    assert.match(pay.out.payment_id, /^PMT-/);
    const { rows: [p] } = await h.asSystem('select organization_id, branch_id, allocations from payments where payment_id = $1', [pay.out.payment_id]);
    assert.equal(p.organization_id, ORG.physio);
    assert.equal(p.branch_id, BRANCH.physio1);
    assert.deepEqual(p.allocations, [{ type: 'invoice', id: S.invId, amount: 100 }]);
  });

  test('InvoicesAPI.listFiltered (list_invoices_filtered RPC)', async () => {
    const all = await b.call('InvoicesAPI.listFiltered', (w) => w.InvoicesAPI.listFiltered({}));
    allOk(all);
    assert.ok(all.out.rows.some((r) => r.invoice_id === S.invId));
    assert.ok(all.out.rows.every((r) => !/^INV-DEN/.test(r.invoice_id)));
    const some = await b.call('InvoicesAPI.listFiltered (range+search+status)', (w) =>
      w.InvoicesAPI.listFiltered({ from: '2000-01-01', to: '2999-12-31', search: 'التوافق', status: 'partial' }));
    allOk(some);
    assert.deepEqual(plain(some.out.rows.map((r) => r.invoice_id)), [S.invId]);
  });

  test('PaymentReceipts: receive (upload + RPC + insert), history, list (is null + eq + order), remove (RPC)', async () => {
    const inv = { invoice_id: S.invId, patient_id: S.pid, amount: 500, paid: 100 };
    const rec = await b.call('PaymentReceipts.receive', (w) =>
      w.PaymentReceipts.receive({ invoice: inv, amount: 50, method: 'cash', file: fileBlob('%PDF-1.4 receipt', 'application/pdf', 'إيصال.pdf') }));
    allOk(rec);
    assert.equal(rec.out.ok, true, rec.out.error);
    assert.ok(!rec.out.warning, rec.out.warning);
    assert.ok(rec.reqs.some((r) => r.path === '/api/files/upload'));
    assert.ok(rec.reqs.some((r) => r.table === 'payment_receipts' && r.action === 'insert'));
    S.receiptId = rec.out.receipt_id;
    const hist = await b.call('PaymentReceipts.history', (w) => w.PaymentReceipts.history(S.invId));
    allOk(hist);
    assert.equal(hist.out.length, 2);
    const list = await b.call('PaymentReceipts.list', (w) => w.PaymentReceipts.list(S.invId));
    allOk(list);
    assert.deepEqual(plain(list.out.map((r) => r.receipt_id)), [S.receiptId]);
    // receipt_url opens with the session alone (an <a href>): ?org= in development.
    const url = list.out[0].file_url;
    assert.match(url, /^\/api\/files\/object\/patient-files\/receipts\/.+\?org=demo-physio$/);
    const get = await fetch(b.base + url, { headers: { Cookie: b.cookieHeader() } });
    assert.equal(get.status, 200);
    const del = await b.call('PaymentReceipts.remove', (w) => w.PaymentReceipts.remove(S.receiptId));
    allOk(del);
    assert.deepEqual(plain(del.out), { ok: true, receipt_id: S.receiptId, deleted: true });
  });

  test('patient files (also the import.jsx flow): upload, list, signed URL, file_url, remove', async () => {
    const up = await b.call('uploadPatientFile', (w) => w.uploadPatientFile(S.pid, fileBlob('%PDF-1.4 report', 'application/pdf', 'تقرير طبي.pdf')));
    allOk(up);
    assert.deepEqual(up.reqs.map(describeReq), ['POST /api/files/upload 200', 'POST /api/data[insert:patient_files] 200']);
    assert.equal(up.out.ok, true, up.out.error);
    const row = up.out.row;
    assert.equal(row.organization_id, ORG.physio);
    assert.equal(row.uploaded_by, USER.physioAdmin.id);
    const list = await b.call('listPatientFiles', (w) => w.listPatientFiles(S.pid));
    allOk(list);
    assert.deepEqual(plain(list.out.map((f) => f.file_id)), [row.file_id]);
    const signed = await b.call('getPatientFileUrl (createSignedUrl 3600 → 600)', (w) => w.getPatientFileUrl(row));
    allOk(signed);
    assert.match(signed.out, /^\/api\/files\/signed\?token=/);
    const bySigned = await fetch(b.base + signed.out); // no cookie: a plain link
    assert.equal(bySigned.status, 200);
    assert.equal(await bySigned.text(), '%PDF-1.4 report');
    const byUrl = await fetch(b.base + row.file_url, { headers: { Cookie: b.cookieHeader() } });
    assert.equal(byUrl.status, 200, `file_url ${row.file_url} must open with the session only`);
    const rm = await b.call('removePatientFile', (w) => w.removePatientFile(row.file_id));
    assert.deepEqual(rm.reqs.map(describeReq), [
      'POST /api/data[select:patient_files] 200', 'POST /api/data[delete:patient_files] 200', 'POST /api/files/remove 200',
    ]);
    assert.equal(rm.out.ok, true);
    assert.equal((await fetch(b.base + signed.out)).status, 404, 'the file is gone');
  });

  test('known limitation (task 2.11): a file name with ".." is refused by the API (400 invalid_path)', async () => {
    const up = await b.call('uploadPatientFile (name with ..)', (w) => w.uploadPatientFile(S.pid, fileBlob('x', 'application/pdf', 'تقرير..نهائي.pdf')));
    assert.deepEqual(up.reqs.map(describeReq), ['POST /api/files/upload 400 invalid_path']);
    assert.equal(up.out.ok, false);
  });

  test('TxMethods: list, create/update (upsert_treatment_method), archive/restore, remove; global rows are read-only', async () => {
    allOk(await b.call('TxMethods.list', (w) => w.TxMethods.list(true)));
    const c = await b.call('TxMethods.create', (w) => w.TxMethods.create({ name: 'طريقة مختبرة', category: 'يدوي', duration_minutes: 15 }));
    assert.equal(c.out.ok, true, c.out.error);
    allOk(c);
    const u = await b.call('TxMethods.update', (w) => w.TxMethods.update(c.out.method_id, { name: 'طريقة مختبرة 2', category: 'يدوي' }));
    assert.equal(u.out.ok, true, u.out.error);
    for (const [label, fn] of [['archive', 'archive'], ['restore', 'restore'], ['remove', 'remove']]) {
      const r = await b.call(`TxMethods.${label}`, (w) => w.TxMethods[fn](c.out.method_id));
      assert.equal(r.out.ok, true, r.out.error);
      allOk(r);
    }
    const g = await b.call('TxMethods.archive (global TM-DFLT-*)', (w) => w.TxMethods.archive('TM-DFLT-001'));
    assert.equal(g.out.ok, false);
    assert.deepEqual(statuses(g.reqs), [400]);
  });

  test('Templates: list, get, create, update, duplicate, archive/restore, apply, remove; global rows are read-only', async () => {
    const l = await b.call('Templates.list', (w) => w.Templates.list({}));
    allOk(l);
    assert.ok(l.out.rows.some((t) => t.template_id === 'TPL-SEED-SPN-01'), 'global library');
    assert.ok(l.out.rows.some((t) => t.template_id === 'TPL-PHY-1'), 'own template');
    assert.ok(!l.out.rows.some((t) => /^TPL-DEN/.test(t.template_id)), 'no other clinic templates');
    const g = await b.call('Templates.get', (w) => w.Templates.get('TPL-SEED-SPN-01'));
    allOk(g);
    assert.equal(g.out.template.template_id, 'TPL-SEED-SPN-01');
    const input = {
      name: 'قالب التوافق', category: 'العمود الفقري', diagnosis: 'Neck pain', body_part: 'الرقبة',
      goals: ['تقليل الألم'], exercises: [{ name: 'Chin tuck', sets: 3, reps: 10 }], methods: ['TENS'],
      estimated_sessions: 8, weekly_frequency: 2,
    };
    const c = await b.call('Templates.create', (w) => w.Templates.create(input));
    assert.equal(c.out.ok, true, c.out.error);
    S.tplId = c.out.template_id;
    const u = await b.call('Templates.update', (w) => w.Templates.update(S.tplId, { ...input, name: 'قالب التوافق (معدل)' }, 'تعديل'));
    assert.equal(u.out.ok, true, u.out.error);
    const d = await b.call('Templates.duplicate', (w) => w.Templates.duplicate('TPL-SEED-SPN-01', 'نسخة من المكتبة'));
    assert.equal(d.out.ok, true, d.out.error);
    for (const fn of ['archive', 'restore']) {
      const r = await b.call(`Templates.${fn}`, (w) => w.Templates[fn](S.tplId));
      assert.equal(r.out.ok, true, r.out.error);
    }
    const a = await b.call('Templates.apply', (w) => w.Templates.apply(S.tplId, S.pid, null));
    assert.equal(a.out.ok, true, a.out.error);
    const rm = await b.call('Templates.remove (the unused copy)', (w) => w.Templates.remove(d.out.template_id));
    assert.equal(rm.out.ok, true, rm.out.error);
    const gu = await b.call('Templates.update (global → refused)', (w) => w.Templates.update('TPL-SEED-SPN-01', input));
    assert.equal(gu.out.ok, false);
    const gr = await b.call('Templates.remove (global → refused)', (w) => w.Templates.remove('TPL-SEED-SPN-01'));
    assert.equal(gr.out.ok, false);
    const { rows } = await h.asSystem("select count(*)::int as n from treatment_templates where template_id = 'TPL-SEED-SPN-01' and organization_id is null");
    assert.equal(rows[0].n, 1);
  });

  test('TreatmentsAPI: create (from a global template), update, list, get, activeFor, delete', async () => {
    const c = await b.call('TreatmentsAPI.create', (w) => w.TreatmentsAPI.create({
      patient_id: S.pid, therapist_id: 'ST-PHY-THERAPIST', template_id: 'TPL-SEED-SPN-01', status: 'active', notes: 'خطة اختبار',
    }));
    allOk(c);
    assert.equal(c.out.ok, true, c.out.error);
    S.trtId = c.out.treatment_id;
    const { rows: [t] } = await h.asSystem('select organization_id, branch_id, template_id from treatments where treatment_id = $1', [S.trtId]);
    assert.deepEqual(t, { organization_id: ORG.physio, branch_id: BRANCH.physio1, template_id: 'TPL-SEED-SPN-01' });
    const u = await b.call('TreatmentsAPI.update', (w) => w.TreatmentsAPI.update(S.trtId, { notes: 'تحديث', status: 'active' }));
    assert.equal(u.out.ok, true, u.out.error);
    const l = await b.call('TreatmentsAPI.list', (w) => w.TreatmentsAPI.list({ patientId: S.pid }));
    allOk(l);
    assert.deepEqual(plain(l.out.rows.map((r) => r.treatment_id)), [S.trtId]);
    const g = await b.call('TreatmentsAPI.get', (w) => w.TreatmentsAPI.get(S.trtId));
    allOk(g);
    assert.ok(g.out, 'get_treatment returned the record');
    const a = await b.call('TreatmentsAPI.activeFor', (w) => w.TreatmentsAPI.activeFor(S.pid));
    assert.equal(a.out.treatment_id, S.trtId);
    const d = await b.call('TreatmentsAPI.delete', (w) => w.TreatmentsAPI.delete(S.trtId));
    allOk(d);
    assert.equal(d.error, null);
  });

  test('TplCategories: list, create, update, archive/restore, remove', async () => {
    const l = await b.call('TplCategories.list', (w) => w.TplCategories.list(true));
    assert.equal(l.out.ok, true);
    assert.ok(l.out.rows.length >= 2);
    const c = await b.call('TplCategories.create', (w) => w.TplCategories.create({ name: 'فئة التوافق', description: 'd' }));
    assert.equal(c.out.ok, true, c.out.error);
    assert.ok(c.out.category_id, 'upsert_template_category returned the new id');
    for (const [label, fn] of [
      ['update', (w) => w.TplCategories.update(c.out.category_id, { name: 'فئة التوافق 2' })],
      ['archive', (w) => w.TplCategories.archive(c.out.category_id)],
      ['restore', (w) => w.TplCategories.restore(c.out.category_id)],
      ['remove', (w) => w.TplCategories.remove(c.out.category_id)],
    ]) {
      const r = await b.call(`TplCategories.${label}`, fn);
      allOk(r);
      assert.equal(r.out.ok, true, `${label}: ${r.out.error}`);
    }
  });

  test('screens1.jsx patient edit audit row (sb.from("audit_events").insert)', async () => {
    const res = await b.call('audit_events insert', (w) =>
      w.SB.from('audit_events').insert({
        actor_uid: w.ME.id, actor_role: 'مدير', action: 'patient.edit', table_name: 'patients', row_pk: S.pid,
        payload: { actor_name: w.ME.name, patient_id: S.pid, changed: ['name'], at: new Date().toISOString() },
      }));
    allOk(res);
    assert.equal(res.out.error, null);
    const { rows } = await h.asSystem("select organization_id, actor_uid, actor_role from audit_events where action = 'patient.edit' and row_pk = $1", [S.pid]);
    assert.deepEqual(rows, [{ organization_id: ORG.physio, actor_uid: USER.physioAdmin.id, actor_role: 'admin' }]);
  });

  test('staff administration: adminCreateUser, adminResetPassword, adminSetStaffStatus, updateStaffMember, listAvailableAuthUsers', async () => {
    const email = `compat-${Date.now()}@demo-physio.test`;
    const c = await b.call('adminCreateUser', (w) => w.adminCreateUser({ email, password: 'Secret123', name: 'أخصائي جديد', role: 'therapist', phone: '0101' }));
    assert.deepEqual(c.reqs.map(describeReq), ['POST /api/admin/create-user 200']);
    assert.equal(c.out.ok, true, c.out.error);
    const { rows: [st] } = await h.asSystem('select staff_id from staff where email = $1', [email]);
    const r = await b.call('adminResetPassword', (w) => w.adminResetPassword({ staff_id: st.staff_id, password: 'Secret456' }));
    assert.equal(r.out.ok, true, r.out.error);
    const off = await b.call('adminSetStaffStatus (deactivate)', (w) => w.adminSetStaffStatus({ staff_id: st.staff_id, active: false }));
    assert.deepEqual(plain(off.out), { ok: true, status: 'inactive' });
    const on = await b.call('adminSetStaffStatus (activate)', (w) => w.adminSetStaffStatus({ staff_id: st.staff_id, active: true }));
    assert.deepEqual(plain(on.out), { ok: true, status: 'active' });
    const dup = await b.call('adminCreateUser (existing member)', (w) => w.adminCreateUser({ email, password: 'Secret123', name: 'x', role: 'therapist' }));
    assert.deepEqual(dup.reqs.map(describeReq), ['POST /api/admin/create-user 409 email_exists']);
    assert.equal(dup.out.ok, false);
    const self = await b.call('adminSetStaffStatus (self → refused)', (w) => w.adminSetStaffStatus({ staff_id: 'ST-PHY-ADMIN', active: false }));
    assert.equal(self.out.ok, false);
    assert.equal(self.out.error, 'لا يمكنك تعطيل حسابك الخاص');
    const m = await b.call('updateStaffMember', (w) => w.updateStaffMember(st.staff_id, { phone: '0111' }));
    assert.deepEqual(plain(m.out), { ok: true });
    const avail = await b.call('listAvailableAuthUsers', (w) => w.listAvailableAuthUsers('therapist', []));
    assert.ok(avail.out.some((u) => u.email === email));
    // The new account signs in with the reset password.
    const login = await h.client().post('/api/auth/login', { email, password: 'Secret456' });
    assert.equal(login.status, 200);
  });

  test('own account: sendPasswordReset, updateOwnProfile (+staff sync), updateOwnPassword keeps the session', async () => {
    const r = await b.call('sendPasswordReset', (w) => w.sendPasswordReset(USER.physioReception.email));
    assert.deepEqual(r.reqs.map(describeReq), ['POST /api/auth/reset/request 204']);
    assert.deepEqual(plain(r.out), { ok: true });
    const p = await b.call('updateOwnProfile', (w) => w.updateOwnProfile({ name: 'مدير التوافق' }));
    assert.equal(p.out.ok, true);
    assert.equal(p.reqs[0].path, '/api/auth/profile');
    const { rows: [st] } = await h.asSystem("select name from staff where staff_id = 'ST-PHY-ADMIN'");
    assert.equal(st.name, 'مدير التوافق');
    const pw = await b.call('updateOwnPassword', (w) => w.updateOwnPassword(PASSWORD));
    assert.deepEqual(pw.reqs.map(describeReq), ['POST /api/auth/password 204']);
    const again = await b.call('getAuthStaff (after password change)', (w) => w.getAuthStaff());
    assert.equal(again.out.ok, true, 'the re-issued cookie is still valid');
  });

  test('KineticData.remove (delete eq pk) for every table, children first', async () => {
    const order = ['sessions', 'schedules', 'subscriptions', 'paymentHistory', 'appts', 'doctors', 'therapists', 'departments',
      'receptionists', 'packages', 'campaigns', 'treatmentMethods', 'staff'];
    for (const name of order) {
      const cfg = W.KineticData.tables[name];
      const res = await b.call(`KineticData.remove ${name}`, (w) => w.KineticData.remove(name, S.rows[name][cfg.pk]));
      assert.equal(res.error, null, `${name}: ${res.error && res.error.message}`);
      allOk(res);
    }
    for (const name of ['payments', 'patients']) {
      const cfg = W.KineticData.tables[name];
      const res = await b.call(`KineticData.remove ${name}`, (w) => w.KineticData.remove(name, S.rows[name][cfg.pk]));
      assert.equal(res.error, null, `${name}: ${res.error && res.error.message}`);
    }
    const { rows } = await h.asSystem('select count(*)::int as n from patients where patient_id = $1', [S.pid]);
    assert.equal(rows[0].n, 0);
  });

  test('signOut → POST /api/auth/logout; then no session and data calls are 401', async () => {
    const out = await b.call('signOut', (w) => w.signOut());
    assert.deepEqual(out.reqs.map(describeReq), ['POST /api/auth/logout 204']);
    assert.ok(!b.jar.has('cs_session'));
    const s = await b.call('getSession (after signOut)', (w) => w.getSession());
    assert.equal(s.out, null);
    const l = await b.call('loadBranches (after signOut)', (w) => w.loadBranches());
    assert.deepEqual(l.reqs.map(describeReq), ['POST /api/data[select:branches] 401 unauthorized']);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('other roles of demo-physio through the same data layer', () => {
  async function signedIn(user, opts = {}) {
    const b = browser(h, { who: user, ...opts });
    await b.idle();
    const res = await b.call('signInEmail', (w) => w.signInEmail(USER[user].email, PASSWORD));
    assert.equal(res.out.ok, true, res.out.error);
    b.win.ME = { id: res.out.user.id, email: res.out.user.email, name: (res.out.staff && res.out.staff.name) || 'x', role: res.out.role, staff_id: res.out.staff && res.out.staff.staff_id };
    return b;
  }
  const hydrate = (b) => b.call('KineticData.list ×15', async (w) => {
    const out = {};
    for (const name of Object.keys(w.KineticData.tables)) out[name] = await w.KineticData.list(name);
    return out;
  });

  test('receptionist (branch 1): hydrate, register a patient + appointment, take a payment, upload a file', async () => {
    const b = await signedIn('physioReception');
    const all = await hydrate(b);
    allOk(all);
    assert.ok(all.out.appts.length > 0);
    assert.ok(all.out.appts.every((a) => a.branch_id === BRANCH.physio1), 'branch 1 only');
    const pid = b.win.newRecordId('P-');
    const p = await b.call('KineticData.upsert patients', (w) => w.KineticData.upsert('patients', { patient_id: pid, name: 'مريض الاستقبال', phone: '0122', created_at: new Date().toISOString() }));
    assert.equal(p.out._ok, true, p.out._error);
    const a = await b.call('KineticData.upsert appts', (w) => w.KineticData.upsert('appts', { booking_id: w.newRecordId('A-'), patient_id: pid, therapist_id: 'ST-PHY-THERAPIST', date: '2026-10-26', time: '09:00', status: 'pending' }));
    assert.equal(a.out._ok, true, a.out._error);
    const inv = await b.call('KineticData.upsert payments', (w) => w.KineticData.upsert('payments', { invoice_id: w.newRecordId('INV-'), patient_id: pid, amount: 300, paid: 0, status: 'pending' }));
    assert.equal(inv.out._ok, true, inv.out._error);
    const pay = await b.call('QuickPay.recordPayment', (w) => w.QuickPay.recordPayment({ patient_id: pid, method: 'cash', allocations: [{ type: 'invoice', id: inv.out.invoice_id, amount: 300 }] }));
    assert.equal(pay.out.ok, true, pay.out.error);
    const up = await b.call('uploadPatientFile', (w) => w.uploadPatientFile(pid, fileBlob('png', 'image/png', 'scan.png')));
    assert.equal(up.out.ok, true, up.out.error);
    const tx = await b.call('TxMethods.create (not allowed for reception)', (w) => w.TxMethods.create({ name: 'طريقة الاستقبال' }));
    assert.equal(tx.out.ok, false);
    await b.call('signOut', (w) => w.signOut());
  });

  test('doctor: hydrate, templates and treatment plans', async () => {
    const b = await signedIn('physioDoctor');
    allOk(await hydrate(b));
    const c = await b.call('Templates.create', (w) => w.Templates.create({ name: 'قالب الطبيب', category: 'العمود الفقري', estimated_sessions: 6 }));
    assert.equal(c.out.ok, true, c.out.error);
    const tm = await b.call('TxMethods.create', (w) => w.TxMethods.create({ name: 'طريقة الطبيب' }));
    assert.equal(tm.out.ok, true, tm.out.error);
    const t = await b.call('TreatmentsAPI.create', (w) => w.TreatmentsAPI.create({ patient_id: 'P-PHY-01', therapist_id: 'ST-PHY-THERAPIST', template_id: c.out.template_id }));
    assert.equal(t.out.ok, true, t.out.error);
    const l = await b.call('TreatmentsAPI.list', (w) => w.TreatmentsAPI.list({ patientId: 'P-PHY-01' }));
    assert.ok(l.out.rows.some((r) => r.treatment_id === t.out.treatment_id));
    await b.call('signOut', (w) => w.signOut());
  });

  test('therapist: hydrate, own plans, start/finish a session (sessions upsert), apply a template', async () => {
    const b = await signedIn('physioTherapist');
    allOk(await hydrate(b));
    const l = await b.call('TreatmentsAPI.list', (w) => w.TreatmentsAPI.list({}));
    allOk(l);
    assert.equal(l.out.error, undefined);
    const sid = b.win.newRecordId('S-P-PHY-01-');
    const s = await b.call('KineticData.upsert sessions', (w) => w.KineticData.upsert('sessions', {
      session_id: sid, patient_id: 'P-PHY-01', therapist_id: 'ST-PHY-THERAPIST', date: '2026-10-22', session_number: 2,
      goals: [], completed_exercises: [], session_notes: '', status: 'in_progress', started_at: new Date().toISOString(),
    }));
    assert.equal(s.out._ok, true, s.out._error);
    const done = await b.call('KineticData.upsert sessions (complete)', (w) => w.KineticData.upsert('sessions', {
      session_id: sid, patient_id: 'P-PHY-01', therapist_id: 'ST-PHY-THERAPIST', pain_score: 3, duration_minutes: 30, status: 'completed',
    }));
    assert.equal(done.out._ok, true, done.out._error);
    const a = await b.call('Templates.apply', (w) => w.Templates.apply('TPL-SEED-SPN-01', 'P-PHY-01', null));
    assert.equal(a.out.ok, true, a.out.error);
    await b.call('signOut', (w) => w.signOut());
  });

  test('a member of another clinic (?org=demo-dental as the physio admin): every data call is refused, nothing leaks', async () => {
    const b = browser(h, { who: 'physio admin @ demo-dental', search: '?org=demo-dental' });
    await b.idle();
    const res = await b.call('signInEmail', (w) => w.signInEmail(USER.physioAdmin.email, PASSWORD));
    assert.equal(res.reqs[0].status, 200, 'the account itself is valid');
    assert.deepEqual(res.reqs.slice(1).map(describeReq), ['POST /api/data[select:staff] 403 not_a_member']);
    const staff = await b.call('getAuthStaff', (w) => w.getAuthStaff());
    assert.equal(staff.out.ok, false);
    assert.equal(staff.out.reason, 'staff-lookup-failed');
    const all = await hydrate(b);
    for (const r of all.reqs) assert.equal(`${r.status} ${r.code}`, '403 not_a_member', describeReq(r));
    assert.ok(Object.values(all.out).every((rows) => Array.isArray(rows) && rows.every((row) => row.organization_id !== ORG.dental)));
  });

  test('a deactivated member (former@demo-physio.test): signs in, but every data call is refused', async () => {
    // Under Supabase the own staff row (status inactive) was still readable,
    // so signInEmail answered "account-inactive". Now the membership is
    // disabled and requireOrg refuses before RLS: src/supabase.jsx has to
    // use the login memberships instead (open frontend task).
    const b = browser(h, { who: 'former' });
    await b.idle();
    const res = await b.call('signInEmail', (w) => w.signInEmail(USER.former.email, PASSWORD));
    assert.deepEqual(res.reqs.map(describeReq), ['POST /api/auth/login 200', 'POST /api/data[select:staff] 403 not_a_member']);
    assert.equal(res.out.session.memberships.length, 0, 'the login payload already says: no clinic');
    const all = await hydrate(b);
    for (const r of all.reqs) assert.equal(`${r.status} ${r.code}`, '403 not_a_member', describeReq(r));
  });
});
