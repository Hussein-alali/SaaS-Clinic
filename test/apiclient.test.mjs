// Unit tests for src/apiclient.jsx (plan task 2.8): the supabase-js
// compatible client that talks to the Node API (docs/02-TRD.md "API contract").
//
// The client is compiled with esbuild (as scripts/build.mjs does) and run in
// a node:vm context with a fake window, storage, crypto and a fake fetch that
// records every request and answers with canned responses. The second half
// runs src/supabase.jsx on top of the client, the way the app loads it, so
// the data layer is exercised unchanged.
//
//   npm test        (node --test test/)

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

// Same transform as scripts/build.mjs: files joined in index.html order.
function compile(files) {
  return transformSync(files.map(read).join("\n;\n"), {
    loader: "jsx", target: "es2017", sourcefile: files.join("+"),
  }).code;
}
const CLIENT_JS = compile(["src/apiclient.jsx"]);
const WITH_DATA_LAYER_JS = compile(["src/apiclient.jsx", "src/supabase.jsx"]);

// Objects created inside the vm have their own prototypes; compare plain copies.
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() { for (let i = 0; i < 10; i++) await tick(); }

function makeStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}

function json(status, body, headers = {}) {
  if (status === 204) return new Response(null, { status });
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
function text(status, body, type = "text/plain; charset=utf-8", statusText = "") {
  return new Response(body, { status, statusText, headers: { "content-type": type } });
}

class TestCustomEvent extends Event {
  constructor(type, init = {}) { super(type); this.detail = init.detail; }
}

/**
 * Loads `code` into a fresh vm "browser". `handler(req)` answers each fetch
 * (Response, or a thrown error for a network failure).
 */
function boot({ code = CLIENT_JS, search = "", session = {}, local = {}, handler } = {}) {
  const requests = [];
  const crypto = { calls: 0, getRandomValues(a) { this.calls++; return webcrypto.getRandomValues(a); } };
  const events = new EventTarget();
  let respond = handler || (() => json(200, { data: [], count: null }));
  const win = {
    console: { log() {}, info() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    URLSearchParams, FormData, Blob, Response, TextEncoder, TextDecoder, Event,
    CustomEvent: TestCustomEvent,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    location: { search, hostname: "localhost", origin: "http://localhost:3000", pathname: "/", href: "http://localhost:3000/" + search },
    sessionStorage: makeStorage(session),
    localStorage: makeStorage(local),
    crypto,
    fetch: async (url, init = {}) => {
      const req = {
        url: String(url),
        path: String(url).split("?")[0],
        method: init.method || "GET",
        credentials: init.credentials,
        headers: { ...(init.headers || {}) },
        rawBody: init.body,
        body: undefined,
        form: null,
      };
      if (typeof init.body === "string") req.body = JSON.parse(init.body);
      else if (init.body instanceof FormData) req.form = init.body;
      requests.push(req);
      return respond(req);
    },
  };
  win.window = win;
  win.self = win;
  vm.createContext(win);
  vm.runInContext(code, win, { filename: "app.js" });
  return {
    win,
    requests,
    crypto,
    setHandler(fn) { respond = fn; },
    client: () => win.supabase.createClient("https://example.supabase.co", "anon-key"),
  };
}

const LOGIN_PAYLOAD = {
  user: { id: "11111111-1111-4111-8111-111111111111", email: "admin@demo-physio.test", name: "Admin" },
  is_super_admin: false,
  memberships: [{ organization_id: "o1", slug: "demo-physio", name: "Demo", role: "admin", status: "active", specialty_code: "physio" }],
};

// ════════════════════════════════════════════════════════════════
describe("src/apiclient.jsx — client surface", () => {
  test("defines window.supabase.createClient and the global newRecordId", () => {
    const { win, client } = boot();
    assert.equal(typeof win.supabase.createClient, "function");
    assert.equal(typeof win.newRecordId, "function");
    assert.equal(vm.runInContext("typeof newRecordId", win), "function", "newRecordId is a global function");
    assert.equal(vm.runInContext("newRecordId === window.newRecordId", win), true);
    const sb = client();
    for (const k of ["from", "rpc"]) assert.equal(typeof sb[k], "function", k);
    assert.equal(typeof sb.storage.from, "function");
    assert.equal(typeof sb.functions.invoke, "function");
    for (const k of ["signInWithPassword", "signOut", "getSession", "getUser", "onAuthStateChange",
      "resetPasswordForEmail", "updateUser", "signUp"]) {
      assert.equal(typeof sb.auth[k], "function", "auth." + k);
    }
  });

  test("builders are lazy and run once however often they are awaited", async () => {
    const { requests, client } = boot({ handler: () => json(200, { data: [{ id: 1 }], count: null }) });
    const q = client().from("patients").select("*");
    await tick();
    assert.equal(requests.length, 0, "nothing is sent before the builder is awaited");
    const a = await q;
    const b = await q;
    assert.equal(requests.length, 1);
    assert.deepEqual(plain(a.data), [{ id: 1 }]);
    assert.deepEqual(plain(b.data), [{ id: 1 }]);
  });
});

// ════════════════════════════════════════════════════════════════
describe("from(): POST /api/data", () => {
  const COMMON = (req) => {
    assert.equal(req.path, "/api/data");
    assert.equal(req.method, "POST");
    assert.equal(req.credentials, "include");
    assert.equal(req.headers["X-Requested-With"], "clinicsys");
    assert.equal(req.headers["Content-Type"], "application/json");
  };

  test("select('*').eq('id', 1).maybeSingle() — loadClinic", async () => {
    const { requests, client } = boot({ handler: () => json(200, { data: { id: 1, name: "Clinic" }, count: null }) });
    const res = await client().from("clinic_settings").select("*").eq("id", 1).maybeSingle();
    COMMON(requests[0]);
    assert.deepEqual(requests[0].body, {
      table: "clinic_settings", action: "select", columns: "*",
      filters: [{ column: "id", op: "eq", value: 1 }], single: "maybeSingle",
    });
    assert.deepEqual(plain(res.data), { id: 1, name: "Clinic" });
    assert.equal(res.error, null);
    assert.equal(res.status, 200);
    assert.equal(res.count, null);
  });

  test("maybeSingle() with no row → data null, no error", async () => {
    const { client } = boot({ handler: () => json(200, { data: null, count: null }) });
    const res = await client().from("staff").select("*").eq("auth_uid", "u1").maybeSingle();
    assert.equal(res.data, null);
    assert.equal(res.error, null);
  });

  test("select(cols) keeps the column list (whitespace removed)", async () => {
    const { requests, client } = boot({ handler: () => json(200, { data: null }) });
    await client().from("staff").select("staff_id, name,role ,email,status").eq("auth_uid", "u1").maybeSingle();
    assert.equal(requests[0].body.columns, "staff_id,name,role,email,status");
  });

  test("select('*', {count:'exact'}) → count; .order().range() — selectAllRows", async () => {
    const { requests, client } = boot({ handler: () => json(200, { data: [{ patient_id: "P-1" }], count: 2500 }) });
    const sb = client();
    const first = await sb.from("patients").select("*", { count: "exact" });
    assert.deepEqual(requests[0].body, { table: "patients", action: "select", columns: "*", filters: [], count: "exact" });
    assert.equal(first.count, 2500);
    await sb.from("patients").select("*").order("patient_id", { ascending: true }).range(1000, 1999);
    assert.deepEqual(requests[1].body, {
      table: "patients", action: "select", columns: "*", filters: [],
      order: [{ column: "patient_id", ascending: true }], range: { from: 1000, to: 1999 },
    });
  });

  test("order(col, {ascending:false}) and chained filters — loadPaymentHistory / listInvoiceReceipts", async () => {
    const { requests, client } = boot({ handler: () => json(200, { data: [] }) });
    const sb = client();
    let q = sb.from("payments").select("*");
    q = q.eq("patient_id", "P-1");
    await q.order("created_at", { ascending: false }).range(20, 39);
    assert.deepEqual(requests[0].body.filters, [{ column: "patient_id", op: "eq", value: "P-1" }]);
    assert.deepEqual(requests[0].body.order, [{ column: "created_at", ascending: false }]);
    assert.deepEqual(requests[0].body.range, { from: 20, to: 39 });

    await sb.from("payment_receipts").select("*").is("deleted_at", null)
      .eq("invoice_id", "INV-1").eq("payment_id", "PMT-1").order("uploaded_at", { ascending: false });
    assert.deepEqual(requests[1].body.filters, [
      { column: "deleted_at", op: "is", value: null },
      { column: "invoice_id", op: "eq", value: "INV-1" },
      { column: "payment_id", op: "eq", value: "PMT-1" },
    ]);
    assert.deepEqual(requests[1].body.order, [{ column: "uploaded_at", ascending: false }]);
  });

  test("order() passes nullsFirst only when given; the other contract operators map 1:1", async () => {
    const { requests, client } = boot({ handler: () => json(200, { data: [] }) });
    await client().from("bookings").select("*").neq("status", "cancelled").gt("price", 0).gte("date", "2026-01-01")
      .lt("date", "2027-01-01").lte("paid", 10).in("therapist_id", ["T1", "T2"]).like("notes", "%x%")
      .ilike("patient_id", "p-%").order("date", { ascending: true, nullsFirst: false });
    assert.deepEqual(requests[0].body.filters.map((f) => f.op), ["neq", "gt", "gte", "lt", "lte", "in", "like", "ilike"]);
    assert.deepEqual(requests[0].body.filters[5], { column: "therapist_id", op: "in", value: ["T1", "T2"] });
    assert.deepEqual(requests[0].body.order, [{ column: "date", ascending: true, nullsFirst: false }]);
  });

  test("Promise.all over several builders — loadPatientFinancials", async () => {
    const { requests, client } = boot({
      handler: (req) => json(200, { data: [{ table: req.body.table }] }),
    });
    const sb = client();
    const [a, i, s] = await Promise.all([
      sb.from("bookings").select("*").eq("patient_id", "P-1"),
      sb.from("invoices").select("*").eq("patient_id", "P-1"),
      sb.from("patient_subscriptions").select("*").eq("patient_id", "P-1"),
    ]);
    assert.equal(requests.length, 3);
    assert.deepEqual([a, i, s].map((r) => r.data[0].table), ["bookings", "invoices", "patient_subscriptions"]);
  });

  test("insert(row) without select() → returning:false, data null — addSection", async () => {
    const { requests, client } = boot({ handler: () => json(200, { data: null, count: null }) });
    const item = { id: "sec_1", slug: "x", label: "X", position: 0, visible: true };
    const res = await client().from("custom_sections").insert(item);
    COMMON(requests[0]);
    assert.deepEqual(requests[0].body, {
      table: "custom_sections", action: "insert", columns: "*", filters: [], values: item, returning: false,
    });
    assert.equal(res.data, null);
    assert.equal(res.error, null);
  });

  test("insert(row).select().single() → returning:true, single row — uploadPatientFile", async () => {
    const row = { file_id: "pf_1", patient_id: "P-1" };
    const { requests, client } = boot({ handler: () => json(200, { data: { ...row, organization_id: "o1" }, count: null }) });
    const res = await client().from("patient_files").insert(row).select().single();
    assert.deepEqual(requests[0].body, {
      table: "patient_files", action: "insert", columns: "*", filters: [], single: "single", values: row, returning: true,
    });
    assert.deepEqual(plain(res.data), { ...row, organization_id: "o1" });
  });

  test("update(patch).eq().select('*').maybeSingle() — saveClinic", async () => {
    const { requests, client } = boot({ handler: () => json(200, { data: { id: 1, name: "New" } }) });
    const res = await client().from("clinic_settings").update({ id: 1, name: "New" }).eq("id", 1).select("*").maybeSingle();
    assert.deepEqual(requests[0].body, {
      table: "clinic_settings", action: "update", columns: "*",
      filters: [{ column: "id", op: "eq", value: 1 }], single: "maybeSingle",
      values: { id: 1, name: "New" }, returning: true,
    });
    assert.deepEqual(plain(res.data), { id: 1, name: "New" });
  });

  test("update(patch).eq() without select() — updateSection / updateBranch", async () => {
    const { requests, client } = boot({ handler: () => json(200, { data: null }) });
    const res = await client().from("branches").update({ name: "B" }).eq("id", "br_1");
    assert.deepEqual(requests[0].body, {
      table: "branches", action: "update", columns: "*",
      filters: [{ column: "id", op: "eq", value: "br_1" }], values: { name: "B" }, returning: false,
    });
    assert.equal(res.data, null);
  });

  test("upsert(row, {onConflict}) — upsertRow", async () => {
    const { requests, client } = boot({ handler: () => json(200, { data: null }) });
    const row = { patient_id: "P-1", name: "Ali" };
    const res = await client().from("patients").upsert(row, { onConflict: "patient_id" });
    assert.deepEqual(requests[0].body, {
      table: "patients", action: "upsert", columns: "*", filters: [], values: row,
      onConflict: "patient_id", returning: false,
    });
    assert.equal(res.error, null);
  });

  test("delete().eq() — removeRow / removeSection / removeBranch", async () => {
    const { requests, client } = boot({ handler: () => json(200, { data: null }) });
    await client().from("patients").delete().eq("patient_id", "P-1");
    assert.deepEqual(requests[0].body, {
      table: "patients", action: "delete", columns: "*",
      filters: [{ column: "patient_id", op: "eq", value: "P-1" }], returning: false,
    });
  });

  test("406 PGRST116 from single() → error, data null, never throws", async () => {
    const { client } = boot({
      handler: () => json(406, { error: { message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116" } }),
    });
    const res = await client().from("patient_files").insert({ file_id: "x" }).select().single();
    assert.equal(res.data, null);
    assert.equal(res.status, 406);
    assert.equal(res.error.code, "PGRST116");
    assert.equal(res.error.message, "JSON object requested, multiple (or no) rows returned");
  });

  test("a server that answers an array to single()/maybeSingle() is coerced like PostgREST", async () => {
    const { client, setHandler } = boot();
    const sb = client();
    setHandler(() => json(200, { data: [] }));
    const none = await sb.from("staff").select("*").single();
    assert.equal(none.status, 406);
    assert.equal(none.error.code, "PGRST116");
    const maybeNone = await sb.from("staff").select("*").maybeSingle();
    assert.equal(maybeNone.data, null);
    assert.equal(maybeNone.error, null);
    setHandler(() => json(200, { data: [{ id: 1 }] }));
    const one = await sb.from("staff").select("*").single();
    assert.deepEqual(plain(one.data), { id: 1 });
    setHandler(() => json(200, { data: [{ id: 1 }, { id: 2 }] }));
    const many = await sb.from("staff").select("*").maybeSingle();
    assert.equal(many.error.code, "PGRST116");
  });

  test("RLS / SQL errors keep message and SQLSTATE code", async () => {
    const { client } = boot({
      handler: () => json(403, { error: { message: 'new row violates row-level security policy for table "patients"', code: "42501" } }),
    });
    const res = await client().from("patients").upsert({ patient_id: "P-1" }, { onConflict: "patient_id" });
    assert.equal(res.data, null);
    assert.equal(res.status, 403);
    assert.deepEqual(plain(res.error), {
      message: 'new row violates row-level security policy for table "patients"', details: null, hint: null, code: "42501",
    });
  });

  test("401 without a session → error with the API code", async () => {
    const { client } = boot({ handler: () => json(401, { error: { message: "Authentication required", code: "unauthorized" } }) });
    const res = await client().from("patients").select("*");
    assert.equal(res.status, 401);
    assert.equal(res.error.code, "unauthorized");
    assert.equal(res.error.message, "Authentication required");
  });

  test("non-JSON answers: plain-text 404 keeps its text; HTML or a 2xx page become errors", async () => {
    const { client, setHandler } = boot({ handler: () => text(404, "Not found") });
    const sb = client();
    const a = await sb.from("patients").select("*");
    assert.equal(a.status, 404);
    assert.equal(a.error.message, "Not found");
    setHandler(() => text(502, "<html><body>Bad gateway</body></html>", "text/html", "Bad Gateway"));
    const b = await sb.from("patients").select("*");
    assert.equal(b.error.message, "HTTP 502 Bad Gateway");
    setHandler(() => text(200, "<!doctype html><html></html>", "text/html"));
    const c = await sb.from("patients").select("*");
    assert.equal(c.data, null);
    assert.match(c.error.message, /non-JSON response from \/api\/data/);
  });

  test("network failure → status 0 and a TypeError message, never throws", async () => {
    const { client } = boot({ handler: () => { throw new TypeError("Failed to fetch"); } });
    const res = await client().from("patients").select("*");
    assert.equal(res.status, 0);
    assert.equal(res.data, null);
    assert.equal(res.error.message, "TypeError: Failed to fetch");
  });
});

// ════════════════════════════════════════════════════════════════
describe("rpc(): POST /api/rpc/:fn", () => {
  test("named args in {args}; object result — record_quick_payment", async () => {
    const { requests, client } = boot({ handler: () => json(200, { payment_id: "PMT-1", receipt_no: "RCT-1" }) });
    const args = { p_patient_id: "P-1", p_allocations: [{ type: "invoice", id: "INV-1", amount: 50 }], p_method: "cash" };
    const res = await client().rpc("record_quick_payment", args);
    const req = requests[0];
    assert.equal(req.path, "/api/rpc/record_quick_payment");
    assert.equal(req.method, "POST");
    assert.equal(req.credentials, "include");
    assert.equal(req.headers["X-Requested-With"], "clinicsys");
    assert.deepEqual(req.body, { args });
    assert.deepEqual(plain(res.data), { payment_id: "PMT-1", receipt_no: "RCT-1" });
    assert.equal(res.error, null);
  });

  test("set-returning results stay arrays (.map works); scalar text stays a string (.trim works)", async () => {
    const { client, setHandler } = boot();
    const sb = client();
    setHandler(() => json(200, [{ category_id: "c1" }, { category_id: "c2" }]));
    const list = await sb.rpc("list_template_categories", { p_include_archived: false });
    assert.deepEqual(plain(list.data.map((r) => r.category_id)), ["c1", "c2"]);
    setHandler(() => json(200, "  TRT-abc  "));
    const scalar = await sb.rpc("get_treatment", { p_treatment_id: "TRT-abc" });
    assert.equal(scalar.data.trim(), "TRT-abc");
    setHandler(() => json(200, null));
    const voidFn = await sb.rpc("delete_treatment_method", { p_method_id: "TM-1" });
    assert.equal(voidFn.data, null);
    assert.equal(voidFn.error, null);
  });

  test("no args → {args:{}}; errors map like data errors", async () => {
    const { requests, client } = boot({ handler: () => json(400, { error: { message: "اسم القالب مطلوب", code: "P0001" } }) });
    const res = await client().rpc("list_treatments");
    assert.deepEqual(requests[0].body, { args: {} });
    assert.equal(res.data, null);
    assert.equal(res.error.message, "اسم القالب مطلوب");
    assert.equal(res.error.code, "P0001");
    assert.equal(res.status, 400);
  });

  test("function name is URL-encoded into the path", async () => {
    const { requests, client } = boot({ handler: () => json(200, null) });
    await client().rpc("weird/name", {});
    assert.equal(requests[0].path, "/api/rpc/weird%2Fname");
  });
});

// ════════════════════════════════════════════════════════════════
describe("storage: /api/files/*", () => {
  function fakeFile(content, name, type) {
    const b = new Blob([content], { type });
    Object.defineProperty(b, "name", { value: name });
    return b;
  }

  test("upload(path, file, opts) → multipart bucket/path/upsert/file", async () => {
    const { requests, client } = boot({ handler: () => json(200, { path: "P-1/pf_1-a.png", fullPath: "patient-files/P-1/pf_1-a.png" }) });
    const file = fakeFile("PNGDATA", "a.png", "image/png");
    const res = await client().storage.from("patient-files")
      .upload("P-1/pf_1-a.png", file, { cacheControl: "3600", upsert: false, contentType: "image/png" });
    const req = requests[0];
    assert.equal(req.path, "/api/files/upload");
    assert.equal(req.method, "POST");
    assert.equal(req.credentials, "include");
    assert.equal(req.headers["X-Requested-With"], "clinicsys");
    assert.equal(req.headers["Content-Type"], undefined, "the browser sets the multipart boundary");
    assert.equal(req.form.get("bucket"), "patient-files");
    assert.equal(req.form.get("path"), "P-1/pf_1-a.png");
    assert.equal(req.form.get("upsert"), "false");
    const sent = req.form.get("file");
    assert.equal(sent.name, "a.png");
    assert.equal(sent.type, "image/png");
    assert.equal(await sent.text(), "PNGDATA");
    assert.equal(res.error, null);
    assert.deepEqual(plain(res.data), { id: null, path: "P-1/pf_1-a.png", fullPath: "patient-files/P-1/pf_1-a.png" });
  });

  test("upload applies contentType when the file has none, and upsert:true", async () => {
    const { requests, client } = boot({ handler: () => json(200, { path: "x", fullPath: "b/x" }) });
    await client().storage.from("b").upload("receipts/P-1/r.pdf", fakeFile("%PDF", "r.pdf", ""), { upsert: true, contentType: "application/pdf" });
    assert.equal(requests[0].form.get("upsert"), "true");
    assert.equal(requests[0].form.get("file").type, "application/pdf");
    assert.equal(requests[0].form.get("file").name, "r.pdf");
  });

  test("upload errors → StorageApiError with message and status", async () => {
    const { client } = boot({ handler: () => json(409, { error: { message: "The resource already exists", code: "already_exists" } }) });
    const res = await client().storage.from("patient-files").upload("p", fakeFile("x", "x.txt", "text/plain"));
    assert.equal(res.data, null);
    assert.equal(res.error.name, "StorageApiError");
    assert.equal(res.error.message, "The resource already exists");
    assert.equal(res.error.status, 409);
    assert.equal(res.error.code, "already_exists");
  });

  test("getPublicUrl(path) → /api/files/object/<bucket>/<path>, no request", () => {
    const { requests, client } = boot();
    const store = client().storage.from("patient-files");
    assert.deepEqual(plain(store.getPublicUrl("receipts/P-1/rct_1-a.png")),
      { data: { publicUrl: "/api/files/object/patient-files/receipts/P-1/rct_1-a.png" } });
    assert.equal(store.getPublicUrl("P-1/pf_1-تقرير طبي.pdf").data.publicUrl,
      "/api/files/object/patient-files/P-1/pf_1-%D8%AA%D9%82%D8%B1%D9%8A%D8%B1%20%D8%B7%D8%A8%D9%8A.pdf");
    assert.equal(requests.length, 0);
  });

  test("createSignedUrl(path, 3600) → POST /api/files/sign with expiresIn capped at 600", async () => {
    const { requests, client } = boot({ handler: () => json(200, { signedUrl: "/api/files/signed?token=abc" }) });
    const store = client().storage.from("patient-files");
    const res = await store.createSignedUrl("P-1/pf_1-a.png", 3600);
    assert.equal(requests[0].path, "/api/files/sign");
    assert.deepEqual(requests[0].body, { bucket: "patient-files", path: "P-1/pf_1-a.png", expiresIn: 600 });
    assert.deepEqual(plain(res), { data: { signedUrl: "/api/files/signed?token=abc" }, error: null });
    await store.createSignedUrl("p", 120);
    assert.equal(requests[1].body.expiresIn, 120);
  });

  test("createSignedUrl error → data null", async () => {
    const { client } = boot({ handler: () => json(404, { error: { message: "Object not found", code: "not_found" } }) });
    const res = await client().storage.from("patient-files").createSignedUrl("missing", 60);
    assert.equal(res.data, null);
    assert.equal(res.error.message, "Object not found");
    assert.equal(res.error.status, 404);
  });

  test("remove(paths) → POST /api/files/remove {bucket, paths}", async () => {
    const { requests, client } = boot({ handler: () => json(200, { removed: ["P-1/a.png"] }) });
    const res = await client().storage.from("patient-files").remove(["P-1/a.png"]);
    assert.equal(requests[0].path, "/api/files/remove");
    assert.deepEqual(requests[0].body, { bucket: "patient-files", paths: ["P-1/a.png"] });
    assert.deepEqual(plain(res), { data: [{ name: "P-1/a.png" }], error: null });
  });
});

// ════════════════════════════════════════════════════════════════
describe("auth: /api/auth/*", () => {
  test("signInWithPassword → POST /api/auth/login; session shape; SIGNED_IN; session cached", async () => {
    const { requests, client } = boot({ handler: () => json(200, LOGIN_PAYLOAD) });
    const sb = client();
    const events = [];
    sb.auth.onAuthStateChange((evt, s) => events.push([evt, s && s.user.id]));
    const res = await sb.auth.signInWithPassword({ email: "admin@demo-physio.test", password: "Dev@12345" });
    const req = requests[0];
    assert.equal(req.path, "/api/auth/login");
    assert.equal(req.method, "POST");
    assert.equal(req.credentials, "include");
    assert.equal(req.headers["X-Requested-With"], "clinicsys");
    assert.deepEqual(req.body, { email: "admin@demo-physio.test", password: "Dev@12345" });
    assert.equal(res.error, null);
    assert.deepEqual(plain(res.data.user), {
      id: LOGIN_PAYLOAD.user.id, email: "admin@demo-physio.test", user_metadata: { name: "Admin" },
      app_metadata: {}, aud: "authenticated", role: "authenticated",
    });
    assert.equal(typeof res.data.session.access_token, "string");
    assert.ok(res.data.session.access_token.length > 0);
    assert.equal(res.data.session.user.id, LOGIN_PAYLOAD.user.id);
    assert.deepEqual(plain(res.data.session.memberships), LOGIN_PAYLOAD.memberships);
    assert.deepEqual(events, [["SIGNED_IN", LOGIN_PAYLOAD.user.id]]);

    const s = await sb.auth.getSession();
    assert.equal(s.data.session.user.id, LOGIN_PAYLOAD.user.id);
    assert.equal(requests.length, 1, "getSession after sign-in answers from memory");
  });

  test("signInWithPassword passes remember only when asked", async () => {
    const { requests, client } = boot({ handler: () => json(200, LOGIN_PAYLOAD) });
    await client().auth.signInWithPassword({ email: "a@b.co", password: "x", options: { remember: true } });
    assert.deepEqual(requests[0].body, { email: "a@b.co", password: "x", remember: true });
  });

  test("wrong credentials → AuthApiError, no session, no event", async () => {
    const { client } = boot({ handler: () => json(401, { error: { message: "Invalid login credentials", code: "invalid_credentials" } }) });
    const sb = client();
    const events = [];
    sb.auth.onAuthStateChange((e) => events.push(e));
    const res = await sb.auth.signInWithPassword({ email: "a@b.co", password: "bad" });
    assert.equal(res.data.user, null);
    assert.equal(res.data.session, null);
    assert.equal(res.error.name, "AuthApiError");
    assert.equal(res.error.message, "Invalid login credentials");
    assert.equal(res.error.status, 401);
    assert.equal(res.error.code, "invalid_credentials");
    assert.deepEqual(events, []);
  });

  test("429 lockout message is passed through", async () => {
    const { client } = boot({ handler: () => json(429, { error: { message: "Too many attempts, try again later", code: "too_many_attempts" } }) });
    const res = await client().auth.signInWithPassword({ email: "a@b.co", password: "x" });
    assert.equal(res.error.status, 429);
    assert.equal(res.error.message, "Too many attempts, try again later");
  });

  test("getSession → GET /api/auth/session once (concurrent calls share it), then cached", async () => {
    const { requests, client } = boot({ handler: () => json(200, LOGIN_PAYLOAD) });
    const sb = client();
    const [a, b] = await Promise.all([sb.auth.getSession(), sb.auth.getSession()]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].path, "/api/auth/session");
    assert.equal(requests[0].method, "GET");
    assert.equal(requests[0].credentials, "include");
    assert.equal(requests[0].body, undefined);
    assert.equal(a.data.session.user.email, "admin@demo-physio.test");
    assert.equal(b.data.session.user.id, LOGIN_PAYLOAD.user.id);
    assert.equal(a.error, null);
    await sb.auth.getSession();
    // A second client on the page shares the cookie session.
    const other = await client().auth.getSession();
    assert.equal(other.data.session.user.id, LOGIN_PAYLOAD.user.id);
    assert.equal(requests.length, 1);
  });

  test("getSession on 401 → {session:null} without error, cached", async () => {
    const { requests, client } = boot({ handler: () => json(401, { error: { message: "Authentication required", code: "unauthorized" } }) });
    const sb = client();
    const res = await sb.auth.getSession();
    assert.deepEqual(plain(res), { data: { session: null }, error: null });
    await sb.auth.getSession();
    assert.equal(requests.length, 1);
  });

  test("getSession network failure → error, not cached (next call retries)", async () => {
    const { requests, client, setHandler } = boot({ handler: () => { throw new TypeError("Failed to fetch"); } });
    const sb = client();
    const res = await sb.auth.getSession();
    assert.equal(res.data.session, null);
    assert.equal(res.error.name, "AuthRetryableFetchError");
    setHandler(() => json(200, LOGIN_PAYLOAD));
    const again = await sb.auth.getSession();
    assert.equal(again.data.session.user.id, LOGIN_PAYLOAD.user.id);
    assert.equal(requests.length, 2);
  });

  test("a sign-in that finishes while getSession is in flight wins", async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { client } = boot({
      handler: async (req) => {
        if (req.path === "/api/auth/session") { await gate; return json(401, { error: { message: "x", code: "unauthorized" } }); }
        return json(200, LOGIN_PAYLOAD);
      },
    });
    const sb = client();
    const pending = sb.auth.getSession();
    await sb.auth.signInWithPassword({ email: "a@b.co", password: "x" });
    release();
    const res = await pending;
    assert.equal(res.data.session.user.id, LOGIN_PAYLOAD.user.id);
    assert.equal((await sb.auth.getSession()).data.session.user.id, LOGIN_PAYLOAD.user.id);
  });

  test("getUser always revalidates; 401 → error and clears the cached session", async () => {
    const { requests, client, setHandler } = boot({ handler: () => json(200, LOGIN_PAYLOAD) });
    const sb = client();
    const u = await sb.auth.getUser();
    assert.equal(u.data.user.id, LOGIN_PAYLOAD.user.id);
    assert.equal(u.error, null);
    await sb.auth.getUser();
    assert.equal(requests.length, 2);
    assert.ok(requests.every((r) => r.path === "/api/auth/session" && r.method === "GET"));
    setHandler(() => json(401, { error: { message: "Session expired, please sign in again", code: "invalid_session" } }));
    const gone = await sb.auth.getUser();
    assert.equal(gone.data.user, null);
    assert.equal(gone.error.status, 401);
    assert.equal(gone.error.message, "Session expired, please sign in again");
    assert.equal((await sb.auth.getSession()).data.session, null);
    assert.equal(requests.length, 3);
  });

  test("signOut → POST /api/auth/logout; SIGNED_OUT; cache cleared; unsubscribe works", async () => {
    const { requests, client, setHandler } = boot({ handler: () => json(200, LOGIN_PAYLOAD) });
    const sb = client();
    const events = [];
    const { data } = sb.auth.onAuthStateChange((evt, s) => events.push([evt, s]));
    assert.equal(typeof data.subscription.unsubscribe, "function");
    await sb.auth.signInWithPassword({ email: "a@b.co", password: "x" });
    setHandler(() => json(204));
    const out = await sb.auth.signOut();
    assert.deepEqual(plain(out), { error: null });
    assert.equal(requests[1].path, "/api/auth/logout");
    assert.equal(requests[1].method, "POST");
    assert.equal(requests[1].headers["X-Requested-With"], "clinicsys");
    assert.deepEqual(events.map((e) => e[0]), ["SIGNED_IN", "SIGNED_OUT"]);
    assert.equal(events[1][1], null);
    assert.equal((await sb.auth.getSession()).data.session, null);
    assert.equal(requests.length, 2);
    data.subscription.unsubscribe();
    setHandler(() => json(200, LOGIN_PAYLOAD));
    await sb.auth.signInWithPassword({ email: "a@b.co", password: "x" });
    assert.equal(events.length, 2, "no events after unsubscribe");
  });

  test("signOut({scope:'local'}) uses the same endpoint; a 401 still signs out locally", async () => {
    const { requests, client } = boot({ handler: () => json(401, { error: { message: "Authentication required", code: "unauthorized" } }) });
    const res = await client().auth.signOut({ scope: "local" });
    assert.equal(res.error, null);
    assert.equal(requests[0].path, "/api/auth/logout");
  });

  test("signOut network failure → error, session kept", async () => {
    const { client, setHandler } = boot({ handler: () => json(200, LOGIN_PAYLOAD) });
    const sb = client();
    await sb.auth.signInWithPassword({ email: "a@b.co", password: "x" });
    setHandler(() => { throw new TypeError("Failed to fetch"); });
    const res = await sb.auth.signOut();
    assert.equal(res.error.name, "AuthRetryableFetchError");
    assert.equal((await sb.auth.getSession()).data.session.user.id, LOGIN_PAYLOAD.user.id);
  });

  test("a secondary client (persistSession:false) that never signed in does not end the page session", async () => {
    const { win, requests } = boot({ handler: () => json(204) });
    const tmp = win.supabase.createClient("u", "k", { auth: { persistSession: false, autoRefreshToken: false, storageKey: "kinetic-provision" } });
    const res = await tmp.auth.signOut({ scope: "local" });
    assert.equal(res.error, null);
    assert.equal(requests.length, 0);
  });

  test("resetPasswordForEmail → POST /api/auth/reset/request {email}", async () => {
    const { requests, client } = boot({ handler: () => json(204) });
    const res = await client().auth.resetPasswordForEmail("a@b.co", { redirectTo: "http://localhost:3000" });
    assert.equal(requests[0].path, "/api/auth/reset/request");
    assert.equal(requests[0].method, "POST");
    assert.deepEqual(requests[0].body, { email: "a@b.co" });
    assert.equal(res.error, null);
  });

  test("resetPasswordForEmail error → AuthApiError", async () => {
    const { client } = boot({ handler: () => json(400, { error: { message: "Invalid e-mail address", code: "invalid_email" } }) });
    const res = await client().auth.resetPasswordForEmail("nope");
    assert.equal(res.error.message, "Invalid e-mail address");
    assert.equal(res.error.status, 400);
  });

  test("updateUser({password}) → POST /api/auth/password; USER_UPDATED", async () => {
    const { requests, client, setHandler } = boot({ handler: () => json(200, LOGIN_PAYLOAD) });
    const sb = client();
    await sb.auth.signInWithPassword({ email: "a@b.co", password: "x" });
    const events = [];
    sb.auth.onAuthStateChange((e) => events.push(e));
    setHandler(() => json(204));
    const res = await sb.auth.updateUser({ password: "NewPass@1" });
    assert.equal(requests[1].path, "/api/auth/password");
    assert.equal(requests[1].method, "POST");
    assert.deepEqual(requests[1].body, { password: "NewPass@1" });
    assert.equal(res.error, null);
    assert.equal(res.data.user.id, LOGIN_PAYLOAD.user.id);
    assert.deepEqual(events, ["USER_UPDATED"]);
  });

  test("updateUser({password}) rejected → error, no event", async () => {
    const { client, setHandler } = boot({ handler: () => json(200, LOGIN_PAYLOAD) });
    const sb = client();
    await sb.auth.signInWithPassword({ email: "a@b.co", password: "x" });
    const events = [];
    sb.auth.onAuthStateChange((e) => events.push(e));
    setHandler(() => json(400, { error: { message: "Password must be at least 8 characters", code: "weak_password" } }));
    const res = await sb.auth.updateUser({ password: "x" });
    assert.equal(res.error.message, "Password must be at least 8 characters");
    assert.equal(res.error.code, "weak_password");
    assert.deepEqual(events, []);
  });

  test("updateUser({data:{name}}) → PATCH /api/auth/profile; cached user_metadata.name updated", async () => {
    const { requests, client, setHandler } = boot({ handler: () => json(200, LOGIN_PAYLOAD) });
    const sb = client();
    const events = [];
    sb.auth.onAuthStateChange((e, s) => events.push([e, s && s.user.user_metadata.name]));
    setHandler(() => json(200, { user: { id: LOGIN_PAYLOAD.user.id, email: "admin@demo-physio.test", name: "د. سارة" } }));
    // No cached session yet: the session is read first.
    setHandler((req) => (req.path === "/api/auth/session" ? json(200, LOGIN_PAYLOAD)
      : json(200, { user: { id: LOGIN_PAYLOAD.user.id, email: "admin@demo-physio.test", name: "د. سارة" } })));
    const res = await sb.auth.updateUser({ data: { name: "د. سارة" } });
    assert.deepEqual(requests.map((r) => [r.method, r.path]), [["GET", "/api/auth/session"], ["PATCH", "/api/auth/profile"]]);
    assert.deepEqual(requests[1].body, { name: "د. سارة" });
    assert.equal(res.error, null);
    assert.equal(res.data.user.user_metadata.name, "د. سارة");
    assert.equal((await sb.auth.getSession()).data.session.user.user_metadata.name, "د. سارة");
    assert.deepEqual(events, [["USER_UPDATED", "د. سارة"]]);
  });

  test("signUp is not supported: error object, no request", async () => {
    const { requests, client } = boot();
    const res = await client().auth.signUp({ email: "a@b.co", password: "x", options: { data: { role: "admin" } } });
    assert.equal(res.data.user, null);
    assert.equal(res.data.session, null);
    assert.equal(res.error.name, "AuthApiError");
    assert.equal(res.error.code, "signup_disabled");
    // __friendlyAuthError in src/supabase.jsx keys on these words; the
    // message must not be mistaken for a password/rate-limit problem.
    assert.doesNotMatch(res.error.message.toLowerCase(), /password|rate limit|already registered|duplicate|invalid email/);
    assert.equal(requests.length, 0);
  });
});

// ════════════════════════════════════════════════════════════════
describe("functions.invoke(): /api/admin/*", () => {
  test("admin-create-user → POST /api/admin/create-user with the JSON body; 2xx data", async () => {
    const { requests, client } = boot({ handler: () => json(200, { ok: true, uid: "u-9" }) });
    const body = { email: "r@demo.test", password: "Secret@123", name: "R", role: "receptionist", phone: null };
    const res = await client().functions.invoke("admin-create-user", { body });
    const req = requests[0];
    assert.equal(req.path, "/api/admin/create-user");
    assert.equal(req.method, "POST");
    assert.equal(req.credentials, "include");
    assert.equal(req.headers["X-Requested-With"], "clinicsys");
    assert.equal(req.headers["Content-Type"], "application/json");
    assert.deepEqual(req.body, body);
    assert.deepEqual(plain(res), { data: { ok: true, uid: "u-9" }, error: null });
  });

  test("admin-reset-password → POST /api/admin/reset-password, body unchanged", async () => {
    const { requests, client } = boot({ handler: () => json(200, { ok: true, staff_id: "U-1" }) });
    const body = { staff_id: "U-1", auth_uid: "u-1", password: "Secret@123" };
    const res = await client().functions.invoke("admin-reset-password", { body });
    assert.equal(requests[0].path, "/api/admin/reset-password");
    assert.deepEqual(requests[0].body, body);
    assert.equal(res.data.staff_id, "U-1");
  });

  test("admin-set-status → POST /api/admin/set-status with active and the matching status", async () => {
    const { requests, client } = boot({ handler: () => json(200, { ok: true, status: "inactive" }) });
    const sb = client();
    await sb.functions.invoke("admin-set-status", { body: { staff_id: "U-1", active: false } });
    assert.equal(requests[0].path, "/api/admin/set-status");
    assert.deepEqual(requests[0].body, { staff_id: "U-1", active: false, status: "inactive" });
    await sb.functions.invoke("admin-set-status", { body: { staff_id: "U-1", active: true } });
    assert.deepEqual(requests[1].body, { staff_id: "U-1", active: true, status: "active" });
  });

  test("non-2xx → FunctionsHttpError; error.context.json() gives the Edge Function body", async () => {
    const { client } = boot({ handler: () => json(403, { ok: false, error: "forbidden" }) });
    const res = await client().functions.invoke("admin-create-user", { body: {} });
    assert.equal(res.data, null);
    assert.equal(res.error.name, "FunctionsHttpError");
    assert.equal(res.error.message, "Edge Function returned a non-2xx status code");
    assert.equal(res.error.context.status, 403);
    assert.deepEqual(plain(await res.error.context.json()), { ok: false, error: "forbidden" });
  });

  test("generic API errors are given the Edge Function shape; 401 → invalid_token", async () => {
    const { client, setHandler } = boot({ handler: () => json(401, { error: { message: "Authentication required", code: "unauthorized" } }) });
    const sb = client();
    const a = await sb.functions.invoke("admin-reset-password", { body: {} });
    assert.deepEqual(plain(await a.error.context.json()), { ok: false, error: "invalid_token", detail: "Authentication required" });
    setHandler(() => json(422, { error: { message: "User limit of the subscription plan reached", code: "plan_limit_users" } }));
    const b = await sb.functions.invoke("admin-create-user", { body: {} });
    assert.deepEqual(plain(await b.error.context.json()),
      { ok: false, error: "plan_limit_users", detail: "User limit of the subscription plan reached" });
  });

  test("non-JSON error body: context.json() rejects like Response.json()", async () => {
    const { client } = boot({ handler: () => text(404, "Not found") });
    const res = await client().functions.invoke("admin-set-status", { body: { staff_id: "U-1", active: true } });
    assert.equal(res.error.name, "FunctionsHttpError");
    await assert.rejects(res.error.context.json());
    assert.equal(await res.error.context.text(), "Not found");
  });

  test("network failure → FunctionsFetchError (the message src/supabase.jsx checks for)", async () => {
    const { client } = boot({ handler: () => { throw new TypeError("Failed to fetch"); } });
    const res = await client().functions.invoke("admin-create-user", { body: {} });
    assert.equal(res.data, null);
    assert.equal(res.error.name, "FunctionsFetchError");
    assert.equal(res.error.message, "Failed to send a request to the Edge Function");
  });

  test("unknown function → FunctionsFetchError without a request", async () => {
    const { requests, client } = boot();
    const res = await client().functions.invoke("send-sms", { body: {} });
    assert.equal(res.error.name, "FunctionsFetchError");
    assert.equal(requests.length, 0);
  });
});

// ════════════════════════════════════════════════════════════════
describe("context headers: X-Org-Slug and X-Branch-Id", () => {
  const every = async (env) => {
    const sb = env.client();
    await sb.from("patients").select("*");
    await sb.rpc("list_treatments", {});
    await sb.storage.from("b").upload("p", new Blob(["x"]));
    await sb.storage.from("b").createSignedUrl("p", 60);
    await sb.storage.from("b").remove(["p"]);
    await sb.auth.getUser();
    await sb.auth.signInWithPassword({ email: "a@b.co", password: "x" });
    await sb.auth.updateUser({ data: { name: "N" } });
    await sb.auth.resetPasswordForEmail("a@b.co");
    await sb.auth.signOut();
    await sb.functions.invoke("admin-create-user", { body: {} });
    return env.requests;
  };

  test("?org=<slug> → header on every request, remembered in sessionStorage 'clinicsys.org'", async () => {
    const env = boot({ search: "?org=Demo-Physio&x=1", handler: () => json(200, { data: [], user: LOGIN_PAYLOAD.user, signedUrl: "/s" }) });
    const reqs = await every(env);
    assert.equal(reqs.length, 11);
    for (const r of reqs) {
      assert.equal(r.headers["X-Org-Slug"], "demo-physio", r.path);
      assert.equal(r.headers["X-Requested-With"], "clinicsys", r.path);
      assert.equal(r.credentials, "include", r.path);
    }
    assert.equal(env.win.sessionStorage.getItem("clinicsys.org"), "demo-physio");
  });

  test("without ?org the slug comes from sessionStorage; with neither no header is sent", async () => {
    const stored = boot({ session: { "clinicsys.org": "demo-dental" } });
    await stored.client().from("patients").select("*");
    assert.equal(stored.requests[0].headers["X-Org-Slug"], "demo-dental");

    const none = boot();
    await none.client().from("patients").select("*");
    assert.equal("X-Org-Slug" in none.requests[0].headers, false);
  });

  test("?org overrides and replaces a stored slug; dropping ?org later keeps it", async () => {
    const env = boot({ search: "?org=demo-dental", session: { "clinicsys.org": "demo-physio" } });
    const sb = env.client();
    await sb.from("patients").select("*");
    assert.equal(env.requests[0].headers["X-Org-Slug"], "demo-dental");
    env.win.location.search = "";
    await sb.from("patients").select("*");
    assert.equal(env.requests[1].headers["X-Org-Slug"], "demo-dental");
  });

  test("invalid slugs are neither sent nor stored", async () => {
    for (const bad of ["?org=", "?org=-bad", "?org=a%20b", "?org=%D8%B9%D9%8A%D8%A7%D8%AF%D8%A9", "?org=x".padEnd(80, "y")]) {
      const env = boot({ search: bad });
      await env.client().from("patients").select("*");
      assert.equal("X-Org-Slug" in env.requests[0].headers, false, bad);
      assert.equal(env.win.sessionStorage.getItem("clinicsys.org"), null, bad);
    }
    const env = boot({ session: { "clinicsys.org": "<script>" } });
    await env.client().from("patients").select("*");
    assert.equal("X-Org-Slug" in env.requests[0].headers, false);
  });

  test("blocked storage does not break requests", async () => {
    const env = boot({ search: "?org=demo-physio" });
    const boom = () => { throw new Error("SecurityError"); };
    env.win.sessionStorage = { getItem: boom, setItem: boom };
    env.win.localStorage = { getItem: boom, setItem: boom };
    await env.client().from("patients").select("*");
    assert.equal(env.requests[0].headers["X-Org-Slug"], "demo-physio");
    assert.equal("X-Branch-Id" in env.requests[0].headers, false);
  });

  test("X-Branch-Id follows window.ACTIVE_BRANCH_ID (the branch picker), on every request", async () => {
    const env = boot({ handler: () => json(200, { data: [], user: LOGIN_PAYLOAD.user, signedUrl: "/s" }) });
    env.win.ACTIVE_BRANCH_ID = "br_main2";
    const reqs = await every(env);
    for (const r of reqs) assert.equal(r.headers["X-Branch-Id"], "br_main2", r.path);
    env.win.ACTIVE_BRANCH_ID = "br_other";
    await env.client().from("bookings").select("*");
    assert.equal(env.requests.at(-1).headers["X-Branch-Id"], "br_other");
  });

  test("X-Branch-Id falls back to localStorage 'kinetic.active_branch' (JSON); absent when unset", async () => {
    const fromLs = boot({ local: { "kinetic.active_branch": JSON.stringify("br_saved") } });
    await fromLs.client().from("bookings").select("*");
    assert.equal(fromLs.requests[0].headers["X-Branch-Id"], "br_saved");

    const rawLs = boot({ local: { "kinetic.active_branch": "br_raw" } });
    await rawLs.client().from("bookings").select("*");
    assert.equal(rawLs.requests[0].headers["X-Branch-Id"], "br_raw");

    const none = boot();
    await none.client().from("bookings").select("*");
    assert.equal("X-Branch-Id" in none.requests[0].headers, false);
  });

  test("branch ids that cannot be a header value are not sent", async () => {
    for (const bad of ["فرع", "br 1", "x".repeat(129), "", null]) {
      const env = boot();
      env.win.ACTIVE_BRANCH_ID = bad;
      await env.client().from("bookings").select("*");
      assert.equal("X-Branch-Id" in env.requests[0].headers, false, String(bad));
    }
  });
});

// ════════════════════════════════════════════════════════════════
describe("newRecordId(prefix)", () => {
  test("prefix + Date.now() in base 36 + 6 random base-36 characters", () => {
    const { win } = boot();
    const before = Date.now();
    const id = win.newRecordId("P-");
    const after = Date.now();
    assert.match(id, /^P-[0-9a-z]+$/);
    const rest = id.slice(2);
    assert.equal(rest.length, Date.now().toString(36).length + 6);
    const ts = parseInt(rest.slice(0, -6), 36);
    assert.ok(ts >= before && ts <= after, "time part is Date.now()");
    assert.match(rest.slice(-6), /^[0-9a-z]{6}$/);
  });

  test("keeps any prefix as given", () => {
    const { win } = boot();
    for (const p of ["P-", "A-", "INV-", "SCH-", "S-P-123-", "TRT-", "pf_", "rct_", "br_", "sec_", "PK-1-Copy-", ""]) {
      const id = win.newRecordId(p);
      assert.ok(id.startsWith(p), p);
      assert.match(id.slice(p.length), /^[0-9a-z]{14,}$/, p);
    }
    assert.match(win.newRecordId(), /^[0-9a-z]{14,}$/);
  });

  test("uses crypto.getRandomValues and is unique over 20,000 calls in the same milliseconds", () => {
    const { win, crypto } = boot();
    const n = 20000;
    const ids = new Set();
    for (let i = 0; i < n; i++) ids.add(win.newRecordId("P-"));
    assert.equal(ids.size, n);
    assert.ok(crypto.calls >= n, "one getRandomValues call per id (at least)");
  });

  test("random characters are spread over the whole base-36 alphabet", () => {
    const { win } = boot();
    const seen = new Set();
    for (let i = 0; i < 2000; i++) for (const c of win.newRecordId("").slice(-6)) seen.add(c);
    assert.equal(seen.size, 36);
  });
});

// ════════════════════════════════════════════════════════════════
// src/supabase.jsx running on top of the client, as in the app bundle.
describe("src/supabase.jsx on top of the client", () => {
  // A small in-memory API: answers by path / table, records everything.
  function apiHandler(overrides = {}) {
    return async (req) => {
      if (overrides[req.path]) return overrides[req.path](req);
      if (req.url.startsWith("https://api.ipify.org")) return json(200, { ip: "203.0.113.7" });
      if (req.path === "/api/data") {
        const key = `${req.body.table}:${req.body.action}`;
        if (overrides[key]) return overrides[key](req);
        if (req.body.action === "select") {
          if (req.body.single) return json(200, { data: null, count: null });
          return json(200, { data: [], count: req.body.count ? 0 : null });
        }
        return json(200, { data: req.body.returning ? req.body.values : null, count: null });
      }
      if (req.path === "/api/auth/session") return json(401, { error: { message: "Authentication required", code: "unauthorized" } });
      return json(404, { error: { message: "Not found", code: "not_found" } });
    };
  }

  async function bootApp(overrides, opts = {}) {
    const env = boot({ code: WITH_DATA_LAYER_JS, handler: apiHandler(overrides), ...opts });
    await settle(); // boot-time loadClinic / loadSections / loadBranches / hydrateDomainTables
    env.bootRequests = env.requests.splice(0);
    return env;
  }

  test("window.SB is the API client; boot reads clinic, sections, branches and every domain table", async () => {
    const env = await bootApp({});
    assert.equal(typeof env.win.SB.from, "function");
    const bodies = env.bootRequests.filter((r) => r.path === "/api/data").map((r) => r.body);
    assert.deepEqual(bodies.find((b) => b.table === "clinic_settings"), {
      table: "clinic_settings", action: "select", columns: "*",
      filters: [{ column: "id", op: "eq", value: 1 }], single: "maybeSingle",
    });
    assert.deepEqual(bodies.find((b) => b.table === "custom_sections").order, [{ column: "position", ascending: true }]);
    assert.deepEqual(bodies.find((b) => b.table === "branches").order, [{ column: "created_at", ascending: true }]);
    const counted = bodies.filter((b) => b.count === "exact").map((b) => b.table).sort();
    const expected = Object.values(vm.runInContext("KineticData.tables", env.win)).map((c) => c.key).sort();
    assert.deepEqual(counted, expected);
    assert.ok(env.bootRequests.every((r) => !r.url.includes("supabase.co")), "nothing goes to Supabase");
  });

  test("KineticData.list pages past the 1000-row cap (selectAllRows)", async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => ({ patient_id: `P-${String(i).padStart(4, "0")}` }));
    const env = await bootApp({
      "patients:select": (req) => {
        if (req.body.count) return json(200, { data: rows.slice(0, 1000), count: rows.length });
        const { from, to } = req.body.range;
        return json(200, { data: rows.slice(from, to + 1), count: null });
      },
    });
    const list = await env.win.KineticData.list("patients");
    assert.equal(list.length, 2500);
    const pages = env.requests.filter((r) => r.body && r.body.table === "patients" && r.body.range);
    assert.deepEqual(pages.map((r) => r.body.range), [{ from: 0, to: 999 }, { from: 1000, to: 1999 }, { from: 2000, to: 2999 }]);
    assert.ok(pages.every((r) => r.body.order[0].column === "patient_id" && r.body.order[0].ascending === true));
  });

  test("signInEmail → login + staff lookup; getAuthStaff revalidates and reads the role", async () => {
    const staff = { staff_id: "U-1", name: "Admin", role: "admin", email: "admin@demo-physio.test", status: "active" };
    const env = await bootApp({
      "/api/auth/login": () => json(200, LOGIN_PAYLOAD),
      "/api/auth/session": () => json(200, LOGIN_PAYLOAD),
      "staff:select": () => json(200, { data: staff }),
    });
    const res = await env.win.signInEmail("admin@demo-physio.test", "Dev@12345");
    assert.equal(res.ok, true);
    assert.equal(res.role, "admin");
    assert.equal(res.user.id, LOGIN_PAYLOAD.user.id);
    const staffReq = env.requests.find((r) => r.body && r.body.table === "staff");
    assert.deepEqual(staffReq.body.filters, [{ column: "auth_uid", op: "eq", value: LOGIN_PAYLOAD.user.id }]);
    assert.equal(staffReq.body.single, "maybeSingle");

    env.requests.length = 0;
    const who = await env.win.getAuthStaff();
    assert.equal(who.ok, true);
    assert.equal(who.role, "admin");
    assert.deepEqual(env.requests.map((r) => r.path), ["/api/auth/session", "/api/data"]);
    assert.equal(env.requests[1].body.columns, "staff_id,name,role,email,status");
  });

  test("signInEmail with a wrong password reports the API message", async () => {
    const env = await bootApp({ "/api/auth/login": () => json(401, { error: { message: "Invalid login credentials", code: "invalid_credentials" } }) });
    const res = await env.win.signInEmail("a@b.co", "bad");
    assert.deepEqual(plain(res), { ok: false, error: "Invalid login credentials" });
  });

  test("getAuthStaff without a session → no-session", async () => {
    const env = await bootApp({});
    const res = await env.win.getAuthStaff();
    assert.equal(res.ok, false);
    assert.equal(res.reason, "no-session");
  });

  test("adminCreateUser: success, Edge-style 403, and an unreachable API (signUp fallback reports it)", async () => {
    let answer = () => json(200, { ok: true, uid: "u-9" });
    const env = await bootApp({ "/api/admin/create-user": (req) => answer(req) });
    const form = { email: "New@Demo.test", password: "Secret@123", name: "New", role: "receptionist", phone: "010" };
    const ok = await env.win.adminCreateUser(form);
    assert.deepEqual(plain(ok), { ok: true, uid: "u-9" });
    assert.deepEqual(env.requests.at(-1).body,
      { email: "new@demo.test", password: "Secret@123", name: "New", role: "receptionist", phone: "010" });

    answer = () => json(403, { ok: false, error: "forbidden" });
    const denied = await env.win.adminCreateUser(form);
    assert.equal(denied.ok, false);
    assert.equal(denied.error, "لا تملك صلاحية إنشاء المستخدمين — تحتاج دور «مدير»");

    answer = () => { throw new TypeError("Failed to fetch"); };
    const before = env.requests.length;
    const down = await env.win.adminCreateUser(form);
    assert.equal(down.ok, false);
    assert.match(down.error, /التسجيل الذاتي غير متاح/);
    assert.equal(env.requests.length, before + 1, "the signUp fallback sends nothing");
  });

  test("adminSetStaffStatus / adminResetPassword map onto /api/admin/*", async () => {
    const env = await bootApp({
      "/api/admin/set-status": () => json(200, { ok: true, staff_id: "U-2", status: "inactive" }),
      "/api/admin/reset-password": () => json(401, { error: { message: "Authentication required", code: "unauthorized" } }),
    });
    const st = await env.win.adminSetStaffStatus({ staff_id: "U-2", active: false });
    assert.deepEqual(plain(st), { ok: true, status: "inactive" });
    assert.deepEqual(env.requests.at(-1).body, { staff_id: "U-2", active: false, status: "inactive" });

    const pw = await env.win.adminResetPassword({ staff_id: "U-2", auth_uid: "u-2", password: "Secret@123" });
    assert.deepEqual(plain(pw), { ok: false, error: "انتهت الجلسة — سجّل الدخول من جديد" });
  });

  test("updateOwnPassword / updateOwnProfile / sendPasswordReset / signOut", async () => {
    const env = await bootApp({
      "/api/auth/password": () => json(204),
      "/api/auth/profile": () => json(200, { user: { id: LOGIN_PAYLOAD.user.id, email: "a@b.co", name: "Nour" } }),
      "/api/auth/reset/request": () => json(204),
      "/api/auth/logout": () => json(204),
      "/api/auth/session": () => json(200, LOGIN_PAYLOAD),
    });
    assert.deepEqual(plain(await env.win.updateOwnPassword("Secret@123")), { ok: true });
    assert.deepEqual(env.requests.find((r) => r.path === "/api/auth/password").body, { password: "Secret@123" });
    assert.deepEqual(plain(await env.win.updateOwnProfile({ name: "Nour" })), { ok: true });
    assert.deepEqual(env.requests.find((r) => r.path === "/api/auth/profile").body, { name: "Nour" });
    assert.deepEqual(plain(await env.win.sendPasswordReset("a@b.co")), { ok: true });
    assert.deepEqual(env.requests.find((r) => r.path === "/api/auth/reset/request").body, { email: "a@b.co" });
    await env.win.signOut();
    assert.ok(env.requests.some((r) => r.path === "/api/auth/logout" && r.method === "POST"));
  });

  test("saveClinic: update…select…maybeSingle; no row updated → error", async () => {
    let row = { id: 1, name: "Clinic B" };
    const env = await bootApp({ "clinic_settings:update": () => json(200, { data: row }) });
    const saved = await env.win.saveClinic({ name: "Clinic B" });
    assert.equal(saved.name, "Clinic B");
    const req = env.requests.find((r) => r.body && r.body.action === "update");
    assert.equal(req.body.returning, true);
    assert.equal(req.body.single, "maybeSingle");
    assert.deepEqual(req.body.filters, [{ column: "id", op: "eq", value: 1 }]);
    row = null;
    await assert.rejects(env.win.saveClinic({ name: "X" }), /لم يتم تحديث أي صف/);
  });

  test("KineticData.upsert / remove surface RLS errors", async () => {
    const env = await bootApp({
      "patients:upsert": () => json(403, { error: { message: "new row violates row-level security policy", code: "42501" } }),
      "patients:delete": () => json(403, { error: { message: "permission denied", code: "42501" } }),
    });
    const res = await env.win.KineticData.upsert("patients", { patient_id: "P-1", name: "Ali", ui_only: 1 });
    assert.equal(res._ok, false);
    assert.equal(res._error, "42501 · new row violates row-level security policy");
    const up = env.requests.find((r) => r.body && r.body.action === "upsert");
    assert.equal(up.body.onConflict, "patient_id");
    assert.deepEqual(up.body.values, { patient_id: "P-1", name: "Ali" });
    await assert.rejects(env.win.KineticData.remove("patients", "P-1"), /42501 · permission denied/);
  });

  test("uploadPatientFile: upload → insert().select().single(); a failed insert removes the file", async () => {
    let insert = (req) => json(200, { data: { ...req.body.values, organization_id: "o1" } });
    const env = await bootApp({
      "/api/files/upload": (req) => json(200, { path: req.form.get("path"), fullPath: "patient-files/" + req.form.get("path") }),
      "/api/files/remove": (req) => json(200, { removed: req.body.paths }),
      "patient_files:insert": (req) => insert(req),
    });
    const file = new Blob(["%PDF-1.4"], { type: "application/pdf" });
    Object.defineProperty(file, "name", { value: "report.pdf" });
    const res = await env.win.uploadPatientFile("P-1", file);
    assert.equal(res.ok, true);
    const up = env.requests.find((r) => r.path === "/api/files/upload");
    assert.equal(up.form.get("bucket"), "patient-files");
    assert.match(up.form.get("path"), /^P-1\/pf_[0-9a-z]{14,}-report\.pdf$/);
    const ins = env.requests.find((r) => r.body && r.body.table === "patient_files");
    assert.equal(ins.body.single, "single");
    assert.equal(ins.body.returning, true);
    assert.equal(ins.body.values.file_url, "/api/files/object/patient-files/" + up.form.get("path"));
    assert.match(ins.body.values.file_id, /^pf_[0-9a-z]{14,}$/);

    insert = () => json(403, { error: { message: "permission denied for table patient_files", code: "42501" } });
    const failed = await env.win.uploadPatientFile("P-1", file);
    assert.deepEqual(plain(failed), { ok: false, error: "permission denied for table patient_files" });
    const rm = env.requests.filter((r) => r.path === "/api/files/remove").at(-1);
    assert.equal(rm.body.bucket, "patient-files");
    assert.equal(rm.body.paths.length, 1);
  });

  test("getPatientFileUrl → signed URL (10 minutes at most)", async () => {
    const env = await bootApp({ "/api/files/sign": () => json(200, { signedUrl: "/api/files/signed?token=t" }) });
    const url = await env.win.getPatientFileUrl({ storage_path: "P-1/pf_1-a.pdf", file_url: "/api/files/object/patient-files/P-1/pf_1-a.pdf" });
    assert.equal(url, "/api/files/signed?token=t");
    assert.equal(env.requests.at(-1).body.expiresIn, 600);
  });

  test("QuickPay.recordPayment → rpc record_quick_payment", async () => {
    const env = await bootApp({ "/api/rpc/record_quick_payment": () => json(200, { payment_id: "PMT-9", receipt_no: "RCT-9" }) });
    env.win.ME = { name: "Cashier", staff_id: "U-1" };
    const res = await env.win.QuickPay.recordPayment({
      patient_id: "P-1", method: "cash", allocations: [{ type: "invoice", id: "INV-1", amount: 100 }],
    });
    assert.deepEqual(plain(res), { ok: true, payment_id: "PMT-9", receipt_no: "RCT-9", amount: 100 });
    const req = env.requests.find((r) => r.path === "/api/rpc/record_quick_payment");
    assert.equal(req.body.args.p_patient_id, "P-1");
    assert.deepEqual(req.body.args.p_allocations, [{ type: "invoice", id: "INV-1", amount: 100 }]);
    assert.equal(req.body.args.p_ip_address, "203.0.113.7");
  });

  test("TreatmentsAPI.create sends a newRecordId('TRT-') id; list reads {rows,count}", async () => {
    const env = await bootApp({
      "/api/rpc/create_treatment": (req) => json(200, { treatment_id: req.body.args.p_treatment_id }),
      "/api/rpc/list_treatments": () => json(200, { rows: [{ treatment_id: "TRT-1" }], count: 1 }),
    });
    const created = await env.win.TreatmentsAPI.create({ patient_id: "P-1" });
    assert.equal(created.ok, true);
    assert.match(created.treatment_id, /^TRT-[0-9a-z]{14,}$/);
    const list = await env.win.TreatmentsAPI.list({ patientId: "P-1" });
    assert.deepEqual(plain(list), { rows: [{ treatment_id: "TRT-1" }], count: 1 });
  });

  test("loadPaymentHistory and receipts list use order/range/is like before", async () => {
    const env = await bootApp({});
    await env.win.QuickPay.loadHistory("P-1", { limit: 20, offset: 40 });
    const hist = env.requests.find((r) => r.body && r.body.table === "payments");
    assert.deepEqual(hist.body.range, { from: 40, to: 59 });
    assert.deepEqual(hist.body.order, [{ column: "created_at", ascending: false }]);
    await env.win.PaymentReceipts.list("INV-1");
    const rec = env.requests.find((r) => r.body && r.body.table === "payment_receipts");
    assert.deepEqual(rec.body.filters, [{ column: "deleted_at", op: "is", value: null }, { column: "invoice_id", op: "eq", value: "INV-1" }]);
  });

  test("the active branch from setActiveBranch() is sent as X-Branch-Id", async () => {
    const env = await bootApp({
      "branches:select": () => json(200, { data: [{ id: "br_a", name: "A" }, { id: "br_b", name: "B" }] }),
    });
    await env.win.loadBranches();
    env.win.setActiveBranch("br_b");
    await env.win.KineticData.list("appts");
    assert.equal(env.requests.at(-1).headers["X-Branch-Id"], "br_b");
    assert.equal(env.win.localStorage.getItem("kinetic.active_branch"), JSON.stringify("br_b"));
  });
});

// ════════════════════════════════════════════════════════════════
describe("wiring", () => {
  test("index.html loads src/apiclient.jsx first and no longer loads supabase-js; CRLF kept", () => {
    const html = read("index.html");
    const scripts = [...html.matchAll(/<script type="text\/babel" src="([^"]+)"><\/script>/g)].map((m) => m[1]);
    assert.equal(scripts[0], "src/apiclient.jsx");
    assert.equal(scripts[1], "src/supabase.jsx");
    assert.doesNotMatch(html, /supabase-js/);
    assert.equal(html.split("\n").length - 1, html.split("\r\n").length - 1, "every line ends with CRLF");
  });

  test("record IDs in src/ come from newRecordId, not time/random fragments", () => {
    const files = fs.readdirSync(path.join(ROOT, "src")).filter((f) => f.endsWith(".jsx") && f !== "apiclient.jsx");
    const banned = [
      /["'][A-Za-z]{1,4}[-_]["']\s*\+\s*(Date\.now|Math\.random)\(\)/, // "INV-" + Date.now(), "sec_" + Math.random()
      /Date\.now\(\)\.toString\(\)\.slice\(-8\)/,                       // "P-" + Date.now().toString().slice(-8)
      /Math\.floor\(10000 \+ Math\.random\(\)\*90000\)/,
      /"S-"\+pid\+"-"\+Date\.now\(\)/,
      /const newId = \(p\) => p \+/,
      /`(TM|TPL|TRT|TU)-\$\{/,                                          // `TRT-${stamp}-${rand}`
      /"-(Copy|C)-"\+Math\.random\(\)/,
    ];
    for (const f of files) {
      const src = read("src/" + f);
      for (const re of banned) assert.doesNotMatch(src, re, `${f}: ${re}`);
    }
  });
});
