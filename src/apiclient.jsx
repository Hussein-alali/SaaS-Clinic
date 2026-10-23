// ===== src/apiclient.jsx =====
// Browser client for the ClinicSystem EG Node API (docs/02-TRD.md
// "API contract"). It replaces @supabase/supabase-js: window.supabase
// .createClient() returns an object with exactly the part of the
// supabase-js v2 API that src/ uses, so src/supabase.jsx and the screens
// run unchanged while every call goes to /api/* on the same origin:
//
//   sb.from(t).select/insert/update/upsert/delete + eq/is/... → POST /api/data
//   sb.rpc(fn, args)                                         → POST /api/rpc/:fn
//   sb.storage.from(bucket).upload/getPublicUrl/
//     createSignedUrl/remove                                 → /api/files/*
//   sb.auth.*                                                → /api/auth/*
//   sb.functions.invoke("admin-<name>", {body})              → POST /api/admin/<name>
//   window.ClinicApi.request(method, path, body)             → /api/<path> (plain JSON,
//                                                               e.g. the Super Admin panel)
//
// Like supabase-js, nothing here throws for an HTTP or network error:
// every call resolves to { data, error, ... }.
//
// Must load before src/supabase.jsx (first text/babel script in index.html).
// Also defines newRecordId(prefix), the generator for text primary keys
// (docs/05-Backend-Schema.md, convention 10).

// prefix + Date.now() in base 36 + 6 random base-36 characters from
// crypto.getRandomValues. Record IDs must be unique across every clinic,
// because the text primary keys are shared by the whole database.
function newRecordId(prefix) {
  var ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
  var c = (typeof window !== "undefined" && window.crypto) || (typeof crypto !== "undefined" ? crypto : null);
  var rand = "";
  while (rand.length < 6) {
    if (c && typeof c.getRandomValues === "function") {
      var bytes = c.getRandomValues(new Uint8Array(12));
      for (var i = 0; i < bytes.length && rand.length < 6; i++) {
        // 252 = 7 * 36: dropping 252..255 keeps every character equally likely.
        if (bytes[i] < 252) rand += ALPHABET[bytes[i] % 36];
      }
    } else {
      // Only for environments without Web Crypto (none of the supported browsers).
      rand += ALPHABET[Math.floor(Math.random() * 36)];
    }
  }
  return String(prefix == null ? "" : prefix) + Date.now().toString(36) + rand;
}
window.newRecordId = newRecordId;

(function () {
  "use strict";

  var API = "/api";
  var ORG_STORAGE_KEY = "clinicsys.org";           // set from ?org=<slug> (development, no wildcard DNS)
  var BRANCH_STORAGE_KEY = "kinetic.active_branch"; // written by setActiveBranch() in src/supabase.jsx
  var PLATFORM_STORAGE_KEY = "clinicsys.platform";  // "1" after ?platform=1 (development, no admin.<base> host)
  var SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  var BRANCH_ID_MAX = 128;
  // The real session is the httpOnly cs_session cookie, which scripts cannot
  // read. Sessions carry this placeholder so code that checks for a token
  // still sees one.
  var COOKIE_SESSION_TOKEN = "cs_session-cookie";
  var MAX_SIGNED_URL_SECONDS = 600;

  // ── Request context headers ─────────────────────────────────
  function normSlug(value) {
    if (typeof value !== "string") return null;
    var s = value.trim().toLowerCase();
    return SLUG_RE.test(s) ? s : null;
  }

  // ?org=<slug> wins and is remembered for the tab (sessionStorage), so the
  // parameter can be dropped from later URLs. In production the server takes
  // the clinic from the Host header and nothing is sent.
  function currentOrgSlug() {
    var fromUrl = null;
    try {
      var search = (window.location && window.location.search) || "";
      fromUrl = normSlug(new URLSearchParams(search).get("org"));
    } catch (_) { fromUrl = null; }
    if (fromUrl) {
      try { window.sessionStorage.setItem(ORG_STORAGE_KEY, fromUrl); } catch (_) {}
      return fromUrl;
    }
    try { return normSlug(window.sessionStorage.getItem(ORG_STORAGE_KEY)); }
    catch (_) { return null; }
  }

  // Super Admin (platform) context: the host admin.<APP_BASE_DOMAIN> in
  // production; in development (no wildcard DNS) ?platform=1, remembered for
  // the tab in sessionStorage so later URLs can drop it. An explicit
  // ?org=<slug> (a clinic — it wins over ?platform=1, as in the boot router,
  // src/tenant.jsx tenantContext) or ?platform=0 leaves it. Outside
  // production the API takes the platform context from the X-Platform: 1
  // header (/api/platform/* answers 403 platform_required without it);
  // every other route ignores the header.
  function isPlatformContext() {
    var host = "";
    try { host = String((window.location && window.location.hostname) || "").toLowerCase(); } catch (_) { host = ""; }
    if (host.indexOf("admin.") === 0) return true;
    var params = null;
    try { params = new URLSearchParams((window.location && window.location.search) || ""); } catch (_) { params = null; }
    var flag = params ? params.get("platform") : null;
    if (flag === "0" || (params && normSlug(params.get("org")))) {
      try { window.sessionStorage.removeItem(PLATFORM_STORAGE_KEY); } catch (_) {}
      return false;
    }
    if (flag === "1") {
      try { window.sessionStorage.setItem(PLATFORM_STORAGE_KEY, "1"); } catch (_) {}
      return true;
    }
    try { return window.sessionStorage.getItem(PLATFORM_STORAGE_KEY) === "1"; }
    catch (_) { return false; }
  }

  // The branch picker (Sidebar → setActiveBranch) keeps the selection in
  // window.ACTIVE_BRANCH_ID and mirrors it to localStorage as JSON.
  function currentBranchId() {
    var id = window.ACTIVE_BRANCH_ID;
    if (id == null || id === "") {
      var raw = null;
      try { raw = window.localStorage.getItem(BRANCH_STORAGE_KEY); } catch (_) { raw = null; }
      if (raw == null || raw === "") return null;
      try { id = JSON.parse(raw); } catch (_) { id = raw; }
    }
    if (typeof id === "number" && isFinite(id)) id = String(id);
    if (typeof id !== "string") return null;
    id = id.trim();
    // Header values must be printable ASCII; anything else is not a branch id.
    if (!id || id.length > BRANCH_ID_MAX || !/^[\x21-\x7e]+$/.test(id)) return null;
    return id;
  }

  // The interface language (LANG, src/i18n.jsx): the API writes the e-mails
  // a request sends (invitations, password resets) with this language first.
  function currentLang() {
    return typeof LANG !== "undefined" && LANG === "en" ? "en" : "ar";
  }

  function requestHeaders(hasJsonBody) {
    var h = { "Accept": "application/json", "X-Requested-With": "clinicsys", "X-Lang": currentLang() };
    if (hasJsonBody) h["Content-Type"] = "application/json";
    // Ignored by every route except /api/platform/*, and by the server in
    // production (where the admin.<base> host decides).
    if (isPlatformContext()) h["X-Platform"] = "1";
    var org = currentOrgSlug();
    if (org) h["X-Org-Slug"] = org;
    var branch = currentBranchId();
    if (branch) h["X-Branch-Id"] = branch;
    return h;
  }

  // ── Transport ───────────────────────────────────────────────
  // Resolves to { ok, status, statusText, text, body, isJson } or, when the
  // request never reached the server, { networkError, status: 0 }.
  function send(method, path, opts) {
    opts = opts || {};
    var hasJson = Object.prototype.hasOwnProperty.call(opts, "json");
    var init = { method: method, credentials: "include", headers: requestHeaders(hasJson) };
    if (hasJson) init.body = JSON.stringify(opts.json);
    else if (opts.form) init.body = opts.form;
    var started;
    try { started = window.fetch(API + path, init); }
    catch (err) { return Promise.resolve({ networkError: err, status: 0, statusText: "" }); }
    return Promise.resolve(started).then(function (res) {
      return Promise.resolve(res.text()).catch(function () { return ""; }).then(function (text) {
        var body = null, isJson = false;
        if (text) {
          try { body = JSON.parse(text); isJson = true; } catch (_) { body = null; }
        }
        // Every /api route answers JSON or an empty body. Anything else (an
        // HTML page from a proxy or a static server) is an error, not data.
        if (res.ok && text && !isJson) {
          return {
            ok: false, status: res.status, statusText: res.statusText || "", headers: res.headers,
            text: "Unexpected non-JSON response from " + API + path, body: null, isJson: false,
          };
        }
        return {
          ok: !!res.ok, status: res.status, statusText: res.statusText || "",
          headers: res.headers, text: text || "", body: body, isJson: isJson,
        };
      });
    }, function (err) {
      return { networkError: err, status: 0, statusText: "" };
    });
  }

  // Short plain-text bodies (e.g. "Not found" from a static server) are a
  // usable message; HTML error pages are not.
  function plainText(text) {
    var t = String(text || "").trim();
    return t && t.length <= 300 && t.charAt(0) !== "<" ? t : "";
  }

  // { message, code } from an API error response. The API answers
  // { error: { message, code } }; the admin routes keep the Edge Function
  // shape { ok: false, error: "<code>", detail }.
  function errorInfo(r) {
    var b = r.body, message = "", code = "";
    if (b && typeof b === "object" && !Array.isArray(b)) {
      if (b.error && typeof b.error === "object") {
        message = b.error.message || "";
        code = b.error.code || "";
      } else if (typeof b.error === "string") {
        code = b.error;
        message = b.detail || b.message || b.error;
      } else if (typeof b.message === "string") {
        message = b.message;
        code = b.code || "";
      }
    }
    if (!message) message = plainText(r.text) || ("HTTP " + r.status + (r.statusText ? " " + r.statusText : ""));
    return { message: String(message), code: code == null ? "" : String(code) };
  }

  // PostgREST-style error object (src/supabase.jsx reads code, message,
  // details and hint).
  function dataError(r) {
    if (r.networkError) {
      var e = r.networkError || {};
      return {
        message: (e.name || "Error") + ": " + (e.message || String(e)),
        details: String(e.stack || ""), hint: "", code: e.code ? String(e.code) : "",
      };
    }
    var info = errorInfo(r);
    return { message: info.message, details: null, hint: null, code: info.code };
  }

  function namedError(name, message, extra) {
    var err = new Error(message);
    err.name = name;
    if (extra) for (var k in extra) err[k] = extra[k];
    return err;
  }

  function thenable(run) {
    var p = null;
    var get = function () { return p || (p = run()); };
    return {
      then: function (onOk, onErr) { return get().then(onOk, onErr); },
      catch: function (onErr) { return get().catch(onErr); },
      finally: function (fn) { return get().finally(fn); },
    };
  }

  // ── Data: from(table) query builder → POST /api/data ────────
  var FILTER_OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "is", "in", "like", "ilike"];

  function QueryBuilder(table) {
    this._q = {
      table: table, action: "select", columns: "*", filters: [], order: [],
      range: null, count: null, head: false, single: null,
      values: undefined, onConflict: null, ignoreDuplicates: false, returning: false,
    };
    this._promise = null;
  }

  function normColumns(columns) {
    if (columns == null) return "*";
    var s = String(columns).replace(/\s+/g, "");
    return s || "*";
  }

  QueryBuilder.prototype.select = function (columns, opts) {
    var q = this._q;
    q.columns = normColumns(columns);
    // After insert/update/upsert/delete, select() asks for the written rows.
    if (q.action !== "select") q.returning = true;
    if (opts && opts.count) q.count = "exact"; // the API counts exactly; planned/estimated get the exact count
    if (opts && opts.head) q.head = true;
    return this;
  };
  QueryBuilder.prototype.insert = function (values, opts) {
    this._q.action = "insert";
    this._q.values = values;
    if (opts && opts.count) this._q.count = "exact";
    return this;
  };
  QueryBuilder.prototype.upsert = function (values, opts) {
    this._q.action = "upsert";
    this._q.values = values;
    if (opts && opts.onConflict) this._q.onConflict = String(opts.onConflict).replace(/\s+/g, "");
    if (opts && opts.ignoreDuplicates) this._q.ignoreDuplicates = true;
    if (opts && opts.count) this._q.count = "exact";
    return this;
  };
  QueryBuilder.prototype.update = function (values, opts) {
    this._q.action = "update";
    this._q.values = values;
    if (opts && opts.count) this._q.count = "exact";
    return this;
  };
  QueryBuilder.prototype["delete"] = function (opts) {
    this._q.action = "delete";
    if (opts && opts.count) this._q.count = "exact";
    return this;
  };
  FILTER_OPS.forEach(function (op) {
    QueryBuilder.prototype[op] = function (column, value) {
      this._q.filters.push({ column: column, op: op, value: value === undefined ? null : value });
      return this;
    };
  });
  QueryBuilder.prototype.order = function (column, opts) {
    var item = { column: column, ascending: !(opts && opts.ascending === false) };
    if (opts && typeof opts.nullsFirst === "boolean") item.nullsFirst = opts.nullsFirst;
    this._q.order.push(item);
    return this;
  };
  QueryBuilder.prototype.range = function (from, to) {
    this._q.range = { from: from, to: to };
    return this;
  };
  QueryBuilder.prototype.single = function () { this._q.single = "single"; return this; };
  QueryBuilder.prototype.maybeSingle = function () { this._q.single = "maybeSingle"; return this; };

  QueryBuilder.prototype._body = function () {
    var q = this._q;
    var body = { table: q.table, action: q.action, columns: q.columns, filters: q.filters };
    if (q.order.length) body.order = q.order;
    if (q.range) body.range = q.range;
    if (q.count) body.count = q.count;
    if (q.head) body.head = true;
    if (q.single) body.single = q.single;
    if (q.action !== "select") {
      if (q.action !== "delete") body.values = q.values;
      if (q.action === "upsert") {
        if (q.onConflict) body.onConflict = q.onConflict;
        if (q.ignoreDuplicates) body.ignoreDuplicates = true;
      }
      body.returning = q.returning;
    }
    return body;
  };

  QueryBuilder.prototype._execute = function () {
    if (this._promise) return this._promise;
    var q = this._q;
    this._promise = send("POST", "/data", { json: this._body() }).then(function (r) {
      if (!r.ok) return { data: null, error: dataError(r), count: null, status: r.status, statusText: r.statusText };
      var b = r.body;
      var data = null, count = null;
      if (Array.isArray(b)) data = b;
      else if (b && typeof b === "object") {
        data = b.data === undefined ? null : b.data;
        count = typeof b.count === "number" ? b.count : null;
      }
      if (q.action !== "select" && !q.returning) data = null;
      if (q.single && Array.isArray(data)) {
        // The API already answers a single row; this covers an array anyway.
        if (data.length > 1 || (q.single === "single" && data.length === 0)) {
          return {
            data: null, count: null, status: 406, statusText: "Not Acceptable",
            error: {
              message: "JSON object requested, multiple (or no) rows returned",
              details: "The result contains " + data.length + " rows", hint: null, code: "PGRST116",
            },
          };
        }
        data = data.length ? data[0] : null;
      }
      return { data: data, error: null, count: count, status: r.status, statusText: r.statusText };
    });
    return this._promise;
  };
  QueryBuilder.prototype.then = function (onOk, onErr) { return this._execute().then(onOk, onErr); };
  QueryBuilder.prototype.catch = function (onErr) { return this._execute().catch(onErr); };
  QueryBuilder.prototype.finally = function (fn) { return this._execute().finally(fn); };

  // ── RPC → POST /api/rpc/:fn ─────────────────────────────────
  // The API returns the function result itself (PostgREST shape): a value,
  // an object, or an array for set-returning functions.
  function rpc(fn, args) {
    return thenable(function () {
      return send("POST", "/rpc/" + encodeURIComponent(fn), { json: { args: args || {} } }).then(function (r) {
        if (!r.ok) return { data: null, error: dataError(r), count: null, status: r.status, statusText: r.statusText };
        return { data: r.body === undefined ? null : r.body, error: null, count: null, status: r.status, statusText: r.statusText };
      });
    });
  }

  // ── Storage → /api/files/* ──────────────────────────────────
  function storageError(r) {
    if (r.networkError) {
      return namedError("StorageUnknownError", (r.networkError && r.networkError.message) || "Network error",
        { status: 0, originalError: r.networkError });
    }
    var info = errorInfo(r);
    return namedError("StorageApiError", info.message, { status: r.status, statusCode: String(r.status), code: info.code });
  }

  function encodePath(path) {
    return String(path).split("/").map(encodeURIComponent).join("/");
  }

  function bucketApi(bucket) {
    return {
      // upload(path, file, { upsert, contentType, cacheControl }) — the API
      // stores files privately, so cacheControl has no effect.
      upload: function (path, file, opts) {
        opts = opts || {};
        var form = new FormData();
        form.append("bucket", bucket);
        form.append("path", path);
        form.append("upsert", opts.upsert ? "true" : "false");
        var blob = file;
        var isBlob = typeof Blob !== "undefined" && file instanceof Blob;
        if (!isBlob) blob = new Blob([file], { type: opts.contentType || "application/octet-stream" });
        else if (opts.contentType && file.type !== opts.contentType) blob = new Blob([file], { type: opts.contentType });
        var name = (file && file.name) || String(path).split("/").pop() || "file";
        form.append("file", blob, name);
        return send("POST", "/files/upload", { form: form }).then(function (r) {
          if (!r.ok) return { data: null, error: storageError(r) };
          var b = r.body || {};
          return { data: { id: null, path: b.path || path, fullPath: b.fullPath || (bucket + "/" + path) }, error: null };
        });
      },
      // Not public in fact: GET /api/files/object/* needs the session and the
      // current clinic (docs/02-TRD.md "الملفات"). The URL is used as
      // <img src> / <a href>, which cannot send X-Org-Slug, so when the
      // clinic comes from ?org=<slug> (development, no clinic subdomain) it
      // travels as ?org=<slug>, which the API accepts on this route. In
      // production the Host names the clinic and nothing is added.
      getPublicUrl: function (path) {
        var url = API + "/files/object/" + encodePath(bucket) + "/" + encodePath(path);
        var org = currentOrgSlug();
        if (org) url += "?org=" + encodeURIComponent(org);
        return { data: { publicUrl: url } };
      },
      createSignedUrl: function (path, expiresIn) {
        var seconds = Number(expiresIn);
        if (!isFinite(seconds) || seconds <= 0) seconds = MAX_SIGNED_URL_SECONDS;
        seconds = Math.min(Math.floor(seconds) || 1, MAX_SIGNED_URL_SECONDS); // signed links live at most 10 minutes
        return send("POST", "/files/sign", { json: { bucket: bucket, path: path, expiresIn: seconds } }).then(function (r) {
          if (!r.ok) return { data: null, error: storageError(r) };
          if (!r.body || typeof r.body.signedUrl !== "string") {
            return { data: null, error: namedError("StorageApiError", "The API returned no signedUrl", { status: r.status, statusCode: String(r.status), code: "" }) };
          }
          return { data: { signedUrl: r.body.signedUrl }, error: null };
        });
      },
      remove: function (paths) {
        var list = Array.isArray(paths) ? paths : [paths];
        return send("POST", "/files/remove", { json: { bucket: bucket, paths: list } }).then(function (r) {
          if (!r.ok) return { data: null, error: storageError(r) };
          var removed = (r.body && Array.isArray(r.body.removed)) ? r.body.removed : [];
          return { data: removed.map(function (p) { return { name: p }; }), error: null };
        });
      },
    };
  }

  // ── Edge Functions → /api/admin/* ───────────────────────────
  function functionPath(name) {
    var m = /^admin-([a-z0-9][a-z0-9-]*)$/.exec(String(name || ""));
    return m ? "/admin/" + m[1] : null;
  }

  // The admin routes keep the Edge Function contract: { ok, error, detail }.
  // Generic API errors ({ error: { message, code } }) are given the same
  // shape, and a 401 maps to the Edge Function's own "invalid_token".
  function functionErrorBody(r) {
    var b = r.body;
    if (b && typeof b === "object" && b.error && typeof b.error === "object") {
      return {
        ok: false,
        error: r.status === 401 ? "invalid_token" : (b.error.code || "error"),
        detail: b.error.message || "",
      };
    }
    return b;
  }

  function invoke(name, options) {
    options = options || {};
    var path = functionPath(name);
    if (!path) {
      return Promise.resolve({
        data: null,
        error: namedError("FunctionsFetchError", "Failed to send a request to the Edge Function", { context: { message: "Unknown function " + name } }),
      });
    }
    var body = options.body === undefined ? {} : options.body;
    // admin-set-status takes { staff_id, active }; the API contract also
    // names it { staff_id, status }, so both are sent.
    if (name === "admin-set-status" && body && typeof body === "object" &&
        typeof body.active === "boolean" && body.status === undefined) {
      body = Object.assign({}, body, { status: body.active ? "active" : "inactive" });
    }
    return send(options.method || "POST", path, { json: body }).then(function (r) {
      if (r.networkError) {
        return { data: null, error: namedError("FunctionsFetchError", "Failed to send a request to the Edge Function", { context: r.networkError }) };
      }
      if (!r.ok) {
        var context = {
          ok: false, status: r.status, statusText: r.statusText, headers: r.headers,
          json: function () {
            return r.isJson ? Promise.resolve(functionErrorBody(r))
              : Promise.reject(new SyntaxError("Response body is not JSON"));
          },
          text: function () { return Promise.resolve(r.text); },
        };
        return { data: null, error: namedError("FunctionsHttpError", "Edge Function returned a non-2xx status code", { context: context }) };
      }
      return { data: r.isJson ? r.body : (r.text || null), error: null };
    });
  }

  // ── Auth → /api/auth/* (cookie session) ─────────────────────
  // One state for every client on the page: the browser has one cs_session
  // cookie, whichever client signed in.
  var authState = { loaded: false, session: null, inflight: null, generation: 0, listeners: [] };

  function toUser(u) {
    u = u || {};
    var meta = {};
    if (typeof u.name === "string") meta.name = u.name;
    return { id: u.id, email: u.email, user_metadata: meta, app_metadata: {}, aud: "authenticated", role: "authenticated" };
  }

  // Session from the login / session payload {user, is_super_admin, memberships}.
  function toSession(payload) {
    payload = payload || {};
    return {
      access_token: COOKIE_SESSION_TOKEN,
      token_type: "cookie",
      user: toUser(payload.user),
      is_super_admin: !!payload.is_super_admin,
      memberships: Array.isArray(payload.memberships) ? payload.memberships : [],
    };
  }

  function authError(r) {
    if (r.networkError) {
      return namedError("AuthRetryableFetchError", (r.networkError && r.networkError.message) || "Network error", { status: 0 });
    }
    var info = errorInfo(r);
    return namedError("AuthApiError", info.message, { status: r.status, code: info.code });
  }

  function emit(event, session) {
    authState.listeners.slice().forEach(function (l) {
      try { l.callback(event, session); }
      catch (e) { if (window.console) console.warn("onAuthStateChange callback failed", e); }
    });
  }

  function setSession(session) {
    authState.generation += 1;
    authState.session = session;
    authState.loaded = true;
  }

  // GET /api/auth/session. A sign in/out that happens meanwhile wins over
  // this (older) answer.
  function fetchSession() {
    var gen = authState.generation;
    return send("GET", "/auth/session").then(function (r) {
      if (r.ok) {
        var session = toSession(r.body);
        if (gen === authState.generation) { authState.session = session; authState.loaded = true; }
        return { session: session, r: r };
      }
      if (r.status === 401) {
        if (gen === authState.generation) { authState.session = null; authState.loaded = true; }
        return { session: null, r: r };
      }
      return { session: null, r: r, error: authError(r) };
    });
  }

  function createAuth(ephemeral) {
    var signedInHere = false;
    var api = {
      signInWithPassword: function (credentials) {
        credentials = credentials || {};
        var body = { email: credentials.email, password: credentials.password };
        if (credentials.options && credentials.options.remember === true) body.remember = true;
        return send("POST", "/auth/login", { json: body }).then(function (r) {
          if (!r.ok) return { data: { user: null, session: null }, error: authError(r) };
          var session = toSession(r.body);
          signedInHere = true;
          setSession(session);
          emit("SIGNED_IN", session);
          return { data: { user: session.user, session: session }, error: null };
        });
      },

      // No self sign-up: accounts come from invitations or the clinic admin.
      signUp: function () {
        return Promise.resolve({
          data: { user: null, session: null },
          error: namedError("AuthApiError", tt("التسجيل الذاتي غير متاح — يُنشأ الحساب بدعوة أو من مدير العيادة"),
            { status: 403, code: "signup_disabled" }),
        });
      },

      signOut: function () {
        // A secondary client (persistSession: false) that never signed in
        // must not end the page's real session.
        if (ephemeral && !signedInHere) return Promise.resolve({ error: null });
        return send("POST", "/auth/logout").then(function (r) {
          if (!r.ok && r.status !== 401) return { error: authError(r) };
          signedInHere = false;
          setSession(null);
          emit("SIGNED_OUT", null);
          return { error: null };
        });
      },

      // Asks the server once, then answers from memory until this client
      // signs in or out.
      getSession: function () {
        if (authState.loaded) return Promise.resolve({ data: { session: authState.session }, error: null });
        if (!authState.inflight) {
          authState.inflight = fetchSession().then(function (res) {
            authState.inflight = null;
            return res;
          });
        }
        return authState.inflight.then(function (res) {
          if (res.error) return { data: { session: null }, error: res.error };
          return { data: { session: authState.loaded ? authState.session : res.session }, error: null };
        });
      },

      // Always asks the server (revalidates the cookie).
      getUser: function () {
        return fetchSession().then(function (res) {
          if (res.error) return { data: { user: null }, error: res.error };
          if (!res.session) return { data: { user: null }, error: authError(res.r) };
          return { data: { user: res.session.user }, error: null };
        });
      },

      onAuthStateChange: function (callback) {
        var sub = { id: newRecordId("sub-"), callback: callback, unsubscribe: null };
        sub.unsubscribe = function () {
          authState.listeners = authState.listeners.filter(function (l) { return l !== sub; });
        };
        authState.listeners.push(sub);
        return { data: { subscription: sub } };
      },

      // The API builds the reset link itself; redirectTo is not used.
      resetPasswordForEmail: function (email) {
        return send("POST", "/auth/reset/request", { json: { email: email } }).then(function (r) {
          if (!r.ok) return { data: null, error: authError(r) };
          return { data: {}, error: null };
        });
      },

      // { password } → POST /api/auth/password; { data: { name } } → PATCH /api/auth/profile.
      updateUser: function (attributes) {
        attributes = attributes || {};
        if (attributes.email !== undefined || attributes.phone !== undefined) {
          return Promise.resolve({ data: { user: null }, error: namedError("AuthApiError", "Changing the e-mail or phone is not supported", { status: 400, code: "not_supported" }) });
        }
        var name = attributes.data && attributes.data.name;
        return api.getSession().then(function () {
          var step = Promise.resolve(null);
          if (attributes.password !== undefined) {
            step = send("POST", "/auth/password", { json: { password: attributes.password } }).then(function (r) {
              return r.ok ? null : authError(r);
            });
          }
          return step.then(function (err) {
            if (err || name === undefined) return err;
            return send("PATCH", "/auth/profile", { json: { name: name } }).then(function (r) {
              if (!r.ok) return authError(r);
              var u = (r.body && r.body.user) || {};
              var s = authState.session;
              if (s && s.user && (u.id === undefined || u.id === s.user.id)) {
                var next = Object.assign({}, s, {
                  user: Object.assign({}, s.user, { user_metadata: Object.assign({}, s.user.user_metadata, { name: u.name !== undefined ? u.name : name }) }),
                });
                authState.session = next;
              }
              return null;
            });
          }).then(function (err) {
            if (err) return { data: { user: null }, error: err };
            var session = authState.session;
            emit("USER_UPDATED", session);
            return { data: { user: session ? session.user : null }, error: null };
          });
        });
      },
    };
    return api;
  }

  // createClient(url, key, options): url and key are the old Supabase
  // settings in src/supabase.jsx and are ignored — the API is same-origin
  // /api and the session is a cookie.
  function createClient(_url, _key, options) {
    var ephemeral = !!(options && options.auth && options.auth.persistSession === false);
    return {
      from: function (table) { return new QueryBuilder(table); },
      rpc: rpc,
      storage: { from: bucketApi },
      functions: { invoke: invoke },
      auth: createAuth(ephemeral),
    };
  }

  window.supabase = { createClient: createClient };

  // ── Plain JSON requests → /api/* ────────────────────────────
  // For screens that call API routes directly rather than through the
  // supabase-js surface (the Super Admin panel → /api/platform/*). Same
  // transport as the client: cookie session, X-Requested-With, X-Platform /
  // X-Org-Slug / X-Branch-Id. Never throws; resolves to
  //   { ok, status, data, error: null | { message, code, status } }
  // where data is the JSON body (null for 204), also on errors.
  function request(method, path, body) {
    var m = String(method || "GET").toUpperCase();
    var p = String(path || "");
    var route = p.split("?")[0];
    if (route.charAt(0) !== "/" || route.indexOf("//") !== -1 || route.indexOf("..") !== -1) {
      return Promise.resolve({ ok: false, status: 0, data: null,
        error: { message: "Invalid API path: " + p, code: "invalid_path", status: 0 } });
    }
    var opts = (body === undefined || m === "GET" || m === "HEAD") ? {} : { json: body };
    return send(m, p, opts).then(function (r) {
      if (r.networkError) {
        var e = r.networkError || {};
        return { ok: false, status: 0, data: null,
          error: { message: (e.name || "Error") + ": " + (e.message || String(e)), code: "network_error", status: 0 } };
      }
      if (!r.ok) {
        var info = errorInfo(r);
        return { ok: false, status: r.status, data: r.isJson ? r.body : null,
          error: { message: info.message, code: info.code, status: r.status } };
      }
      return { ok: true, status: r.status, data: r.isJson ? r.body : null, error: null };
    });
  }

  // { q: "x", limit: 50, empty: "" } → "?q=x&limit=50" (null, undefined and
  // "" are left out); "" when nothing is left.
  function queryString(params) {
    var parts = [];
    if (params && typeof params === "object") {
      Object.keys(params).forEach(function (k) {
        var v = params[k];
        if (v === null || v === undefined || v === "") return;
        parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(v)));
      });
    }
    return parts.length ? "?" + parts.join("&") : "";
  }

  window.ClinicApi = { request: request, query: queryString, isPlatformContext: isPlatformContext };
})();
