// ===== src/tenant.jsx =====
// Clinic context and entry screens (docs/03-App-Flow.md S01-S06): resolving the
// clinic from the host or ?org=, status pages, login routing and clinic picker,
// and invitation acceptance (?invite=).
//
//   tenantContext()        where the address points (App in src/screens2.jsx
//                          routes on .kind): demo | import | invite | reset |
//                          platform | clinic | root
//   TenantRootPortal       S01 + S02 + S04 on the bare base domain
//   TenantStatusScreen     S06: unknown / suspended / pending clinic, no membership
//   TenantInviteScreen     S03 (?invite=<token>)
//   TenantResetScreen      new password from the e-mailed link (?reset=<token>)
//   TenantForgotForm       «نسيت كلمة المرور» (POST /api/auth/reset/request)
//   TenantPlatformGate     window.PlatformApp (src/platform.jsx) on admin.<base> / ?platform=1
//   tenantResolveOrg, tenantRestoreSession, tenantLoginVerdict,
//   tenantLoadClinicData   the clinic gate ClinicApp (src/screens2.jsx) runs
//   tenantRouteFromHash, tenantWriteRouteHash
//                          the workspace page in the address (#/<route>)
//   TenantModuleDisabled   a page of a module the clinic has not enabled
//
// Production: <slug>.clinicsyseg.com is a clinic, admin.clinicsyseg.com the
// platform, clinicsyseg.com the main site. Development (no wildcard DNS):
// ?org=<slug> / ?platform=1 on localhost, or <slug>.localhost.

const TENANT_BASE_DOMAINS = ["clinicsyseg.com", "staging.clinicsyseg.com"];
const TENANT_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TENANT_KEYS = {
  org: "clinicsys.org",                 // src/apiclient.jsx: X-Org-Slug from ?org=
  platform: "clinicsys.platform",       // src/apiclient.jsx: X-Platform from ?platform=1
  flash: "clinicsys.flash",             // one-shot message for the next login screen
  branchChoice: "clinicsys.branch_choice", // {"<slug>|<user id>": "<branch id>"}
  activeBranch: "kinetic.active_branch",   // src/supabase.jsx LS_ACTIVE_BRANCH
};
const TENANT_ROLE_AR = { admin: "مدير", receptionist: "موظف استقبال", doctor: "طبيب", therapist: "الأخصائي", staff: "موظف" };
const TENANT_UI_ROLES = { admin: "مدير", receptionist: "موظف استقبال", doctor: "طبيب", therapist: "الأخصائي" };
const TENANT_SPECIALTY_AR = { physio: "علاج طبيعي", dental: "طب أسنان", general: "طب عام" };
const TENANT_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TENANT_RESET_SENT = "إن كان هذا البريد مسجّلًا لدينا فستصلك خلال دقائق رسالة فيها رابط لإعادة تعيين كلمة المرور، صالح لساعة واحدة. إن لم تجدها فتحقق من مجلد الرسائل غير المرغوب فيها.";

// ── Small storage helpers (private windows may refuse storage) ─
function tenantStorage(kind) {
  try { return kind === "local" ? window.localStorage : window.sessionStorage; } catch (_) { return null; }
}
function tenantStoreGet(kind, key) {
  const s = tenantStorage(kind);
  try { return s ? s.getItem(key) : null; } catch (_) { return null; }
}
function tenantStoreSet(kind, key, value) {
  const s = tenantStorage(kind);
  try { if (s) s.setItem(key, value); } catch (_) {}
}
function tenantStoreRemove(kind, key) {
  const s = tenantStorage(kind);
  try { if (s) s.removeItem(key); } catch (_) {}
}

function tenantNormSlug(value) {
  if (typeof value !== "string") return null;
  const s = value.trim().toLowerCase();
  return TENANT_SLUG_RE.test(s) ? s : null;
}

// ── Where does the address point? ─────────────────────────────
// {host, base, label, known}: label = the first DNS label when the host is
// <label>.<base> (a clinic slug, or "admin"); known = a production base.
function tenantHostInfo(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  const bases = [window.APP_BASE_DOMAIN].concat(TENANT_BASE_DOMAINS)
    .filter(b => typeof b === "string" && b)
    .map(b => b.toLowerCase())
    .sort((a, b) => b.length - a.length);
  const pick = (label) => (label && label !== "www" && !label.includes(".") ? label : null);
  for (const base of bases) {
    if (host === base) return { host, base, label: null, known: true };
    if (host.endsWith("." + base)) return { host, base, label: pick(host.slice(0, -(base.length + 1))), known: true };
  }
  if (host.endsWith(".localhost")) {
    return { host, base: "localhost", label: pick(host.slice(0, -".localhost".length)), known: false };
  }
  // localhost, an IP, or an unknown (preview) domain: no subdomain routing.
  return { host, base: host, label: null, known: false };
}

// ?demo=1 and ?import=1 keep their old behaviour and come first; then the
// e-mailed links (?invite=, ?reset=); then the platform; then a clinic from
// the host (wins, as on the server) or ?org=; else the main site.
function tenantContext() {
  const loc = window.location || {};
  let params;
  try { params = new URLSearchParams(loc.search || ""); } catch (_) { params = new URLSearchParams(""); }
  const host = tenantHostInfo(loc.hostname);
  const hostPlatform = host.label === "admin";
  const hostSlug = hostPlatform ? null : tenantNormSlug(host.label || "");
  const rawOrg = (params.get("org") || "").trim();
  const querySlug = tenantNormSlug(rawOrg);
  const slug = hostSlug || (hostPlatform ? null : querySlug);
  const ctx = {
    host, slug,
    slugSource: hostSlug ? "host" : (slug ? "query" : null),
    // ?org=<not a slug>: a clinic link that cannot exist (shown as "not found").
    invalidSlug: !hostSlug && !hostPlatform && !!rawOrg && !querySlug ? rawOrg : null,
  };
  if (params.get("demo") === "1") return { ...ctx, kind: "demo" };
  if (params.get("import") === "1") return { ...ctx, kind: "import" };
  const invite = params.get("invite");
  if (invite) return { ...ctx, kind: "invite", token: invite };
  const reset = params.get("reset");
  if (reset) return { ...ctx, kind: "reset", token: reset };
  if (hostPlatform) return { ...ctx, kind: "platform" };
  if (!slug && !ctx.invalidSlug) {
    const flag = params.get("platform");
    if (flag === "1") return { ...ctx, kind: "platform" };
    // src/apiclient.jsx remembers ?platform=1 for the tab; ?platform=0 leaves it.
    if (flag !== "0" && tenantStoreGet("session", TENANT_KEYS.platform) === "1") return { ...ctx, kind: "platform" };
  }
  if (slug || ctx.invalidSlug) return { ...ctx, kind: "clinic" };
  return { ...ctx, kind: "root" };
}

// ── URLs of the other contexts ────────────────────────────────
function tenantPort() { return window.location.port ? ":" + window.location.port : ""; }
function tenantOrigin() { return window.location.protocol + "//" + window.location.host; }

// production https://<slug>.<base>/ ; development /?org=<slug>
function tenantClinicUrl(slug) {
  const h = tenantHostInfo(window.location.hostname);
  const s = encodeURIComponent(slug);
  if (h.known) return `${window.location.protocol}//${slug}.${h.base}${tenantPort()}/`;
  // A <slug>.localhost page: the server takes the clinic from the host.
  if (h.label && h.base === "localhost") return `${window.location.protocol}//${slug}.localhost${tenantPort()}/?org=${s}`;
  return `${tenantOrigin()}/?org=${s}`;
}
function tenantRootUrl() {
  const h = tenantHostInfo(window.location.hostname);
  if (h.known) return `${window.location.protocol}//${h.base}${tenantPort()}/`;
  if (h.base === "localhost") return `${window.location.protocol}//localhost${tenantPort()}/`;
  return `${tenantOrigin()}/`;
}
function tenantPlatformUrl() {
  const h = tenantHostInfo(window.location.hostname);
  if (h.known) return `${window.location.protocol}//admin.${h.base}${tenantPort()}/`;
  if (h.base === "localhost") return `${window.location.protocol}//localhost${tenantPort()}/?platform=1`;
  return `${tenantOrigin()}/?platform=1`;
}
// The address bar form shown on the picker cards.
function tenantClinicLabel(slug) {
  return tenantClinicUrl(slug).replace(/^https?:\/\//, "").replace(/\/$/, "");
}
// Leaving a clinic (or the platform) for the main site: the tab must stop
// sending the remembered X-Org-Slug / X-Platform.
function tenantGoRoot() {
  tenantStoreRemove("session", TENANT_KEYS.org);
  tenantStoreRemove("session", TENANT_KEYS.platform);
  window.location.assign(tenantRootUrl());
}

// ── One-shot message for the next login screen ────────────────
function tenantSetFlash(kind, text) {
  tenantStoreSet("session", TENANT_KEYS.flash, JSON.stringify({ kind, text }));
}
function tenantTakeFlash() {
  const raw = tenantStoreGet("session", TENANT_KEYS.flash);
  if (!raw) return null;
  tenantStoreRemove("session", TENANT_KEYS.flash);
  try {
    const v = JSON.parse(raw);
    return v && typeof v.text === "string" ? v : null;
  } catch (_) { return null; }
}

// ── Plain JSON requests to /api ───────────────────────────────
// Resolves (never throws) to { ok, status, data, error: null | {message, code, status} }.
// Uses window.ClinicApi.request (src/apiclient.jsx) when present, else the
// same transport: cookie session, X-Requested-With, X-Lang, X-Org-Slug, X-Branch-Id.
function tenantRequest(method, path, body) {
  const api = window.ClinicApi;
  if (api && typeof api.request === "function") return api.request(method, path, body);
  const m = String(method || "GET").toUpperCase();
  const headers = { "Accept": "application/json", "X-Requested-With": "clinicsys", "X-Lang": LANG === "en" ? "en" : "ar" };
  const init = { method: m, credentials: "include", headers };
  if (body !== undefined && m !== "GET" && m !== "HEAD") {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const ctx = tenantContext();
  const slug = ctx.slugSource === "host" ? null : (ctx.slug || tenantNormSlug(tenantStoreGet("session", TENANT_KEYS.org)));
  if (slug) headers["X-Org-Slug"] = slug;
  const branch = window.ACTIVE_BRANCH_ID;
  if (typeof branch === "string" && /^[\x21-\x7e]{1,128}$/.test(branch)) headers["X-Branch-Id"] = branch;
  let started;
  try { started = window.fetch("/api" + path, init); }
  catch (err) { started = Promise.reject(err); }
  return Promise.resolve(started).then(async (res) => {
    let text = "";
    try { text = await res.text(); } catch (_) { text = ""; }
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
    if (res.ok) return { ok: true, status: res.status, data, error: null };
    const e = data && data.error;
    const code = e && typeof e === "object" ? (e.code || "") : (typeof e === "string" ? e : "");
    const message = (e && typeof e === "object" && e.message) || (data && data.detail) || ("HTTP " + res.status);
    return { ok: false, status: res.status, data, error: { message: String(message), code: String(code), status: res.status } };
  }, (err) => ({
    ok: false, status: 0, data: null,
    error: { message: String((err && err.message) || err), code: "network_error", status: 0 },
  }));
}

// The friendly text of an API error code (already in the page language), else
// `fallback` (Arabic source text, translated here).
function tenantFriendly(code, fallback) {
  const f = window.friendlyAuthError;
  const text = typeof f === "function" ? f(code, "") : "";
  return text || tt(fallback || "تعذّر تنفيذ العملية");
}

// UTF-8 length: the API accepts passwords of 6–72 BYTES (bcrypt).
function tenantPasswordProblem(pw) {
  let bytes = String(pw || "").length;
  try { bytes = new TextEncoder().encode(String(pw || "")).length; } catch (_) {}
  if (bytes < 6) return tt("كلمة المرور 6 أحرف على الأقل");
  if (bytes > 72) return tt("كلمة المرور طويلة جدًا (72 بايت كحد أقصى — الحرف العربي بايتان)");
  return "";
}

// ── The clinic of this page ───────────────────────────────────
// GET /api/orgs/resolve (public): → {state: active|pending|suspended|not-found|error, org}
async function tenantResolveOrg(slug, invalid) {
  if (invalid || !tenantNormSlug(slug || "")) return { state: "not-found" };
  const r = await tenantRequest("GET", "/orgs/resolve?slug=" + encodeURIComponent(slug));
  if (r.ok && r.data) {
    const status = r.data.status;
    if (status === "active") return { state: "active", org: r.data };
    if (status === "pending_activation") return { state: "pending", org: r.data };
    if (status === "suspended") return { state: "suspended" };
    return { state: "not-found" };
  }
  if (r.status === 404) return { state: "not-found" };
  return { state: "error", error: r.error };
}

// Branding (display name, logo) and enabled modules of the clinic, from
// resolve before sign-in and from /api/orgs/current after it.
function tenantApplyOrg(org) {
  if (!org) return;
  window.TENANT_ORG = org;
  window.TENANT_SLUG = org.slug || window.TENANT_SLUG || null;
  window.ORG_MODULES = Array.isArray(org.modules) ? org.modules.slice() : null;
  const s = org.settings || {};
  const prev = window.CLINIC || {};
  window.CLINIC = {
    ...prev,
    name: s.display_name || org.name || prev.name || "",
    subtitle: s.subtitle != null ? s.subtitle : (prev.subtitle || ""),
    logo: s.logo || prev.logo || null,
    primary_color: s.primary_color || prev.primary_color,
  };
  window.dispatchEvent(new CustomEvent("kinetic:clinic-updated", { detail: window.CLINIC }));
}

function tenantSetSession(session) {
  window.TENANT_SESSION = session || null;
}

// The active membership of `session` (or a memberships array) in `slug`.
function tenantMembershipFor(session, slug) {
  const list = Array.isArray(session) ? session : ((session && session.memberships) || []);
  const s = String(slug || "").toLowerCase();
  if (!s) return null;
  return list.find(m => m && String(m.slug || "").toLowerCase() === s && (!m.status || m.status === "active")) || null;
}

// The `user` object the app shell works with (Arabic role names drive
// navigation in src/roles.jsx). null for roles without a staff UI.
function tenantBuildUser({ user, staff, role }) {
  const arRole = TENANT_UI_ROLES[role];
  if (!arRole || !user) return null;
  const prof = (window.ROLE_PROFILES || {})[arRole] || {};
  const meta = user.user_metadata || {};
  const name = (staff && staff.name) || meta.name || user.email || "";
  const clinician = arRole === "طبيب" || arRole === "الأخصائي";
  return {
    id: user.id,
    staff_id: (staff && staff.staff_id) || null,
    name,
    role: arRole,
    email: user.email || "",
    // Clinicians scope their caseload by their own name (src/roles.jsx).
    match: clinician ? name : (prof.match || null),
    title: prof.title,
    color: prof.color,
    scope: window.roleScope ? window.roleScope(arRole) : "all",
    verifiedAt: Date.now(),
  };
}

// After signInEmail() on a clinic page: may this account enter THIS clinic?
// The login payload lists only active memberships in active clinics, so a
// non-member and a deactivated member are both refused here.
function tenantLoginVerdict(res, slug) {
  slug = slug || tenantContext().slug;
  if (!slug) return { ok: false, code: "org_required", error: tenantFriendly("org_required") };
  const m = tenantMembershipFor(res.memberships || res.session, slug);
  if (!m) {
    return {
      ok: false, code: "not_a_member",
      error: tt("ليست لديك عضوية نشطة في هذه العيادة. إن كانت عضويتك معطّلة فتواصل مع مدير العيادة."),
    };
  }
  const user = tenantBuildUser({ user: res.user, staff: res.staff, role: m.role || res.role });
  if (!user) {
    return { ok: false, code: "role_unsupported", error: tt("دورك في هذه العيادة لا يتيح استخدام هذه الواجهة بعد — تواصل مع مدير العيادة.") };
  }
  tenantSetSession(res.session);
  return { ok: true, user, membership: m };
}

// An existing session on a clinic page (reload, link from the root):
// → {state: member, user} | {state: not-member, session} | {state: none, notice?} | {state: error}
async function tenantRestoreSession(slug) {
  const client = window.SB;
  if (!client) return { state: "none" };
  let session = null;
  try {
    const r = await client.auth.getSession();
    if (r.error) return { state: "error" };
    session = r.data && r.data.session;
  } catch (_) { return { state: "error" }; }
  if (!session) return { state: "none" };
  tenantSetSession(session);
  if (!tenantMembershipFor(session, slug)) return { state: "not-member", session };

  const res = await window.getAuthStaff();
  const fresh = res.session || session;
  tenantSetSession(fresh);
  if (res.ok || res.reason === "no-staff-role" || res.reason === "role-not-staff") {
    const m = tenantMembershipFor(fresh, slug);
    if (!m) return { state: "not-member", session: fresh };
    const user = tenantBuildUser({ user: res.user || fresh.user, staff: res.staff, role: m.role });
    if (!user) {
      await window.signOut();
      return { state: "none", notice: { kind: "error", text: tt("دورك في هذه العيادة لا يتيح استخدام هذه الواجهة بعد — تواصل مع مدير العيادة.") } };
    }
    return { state: "member", user, session: fresh };
  }
  if (res.reason === "no-session" || res.reason === "invalid-session") return { state: "none" };
  // The session lists this clinic but the API refuses its data (membership
  // disabled or clinic stopped meanwhile): sign out, say why.
  if (res.reason === "account-inactive" || res.reason === "staff-lookup-failed") {
    try { await window.signOut(); } catch (_) {}
    const text = res.reason === "account-inactive" ? res.error
      : (res.code === "org_inactive" ? tenantFriendly("org_inactive")
        : tt("ليست لديك عضوية نشطة في هذه العيادة. إن كانت عضويتك معطّلة فتواصل مع مدير العيادة."));
    return { state: "none", notice: { kind: "error", text } };
  }
  return { state: "error" };
}

// ── Page links inside the clinic (#/<route>) ──────────────────
// The workspace keeps its page in the address (e.g. /?org=x#/sessions), so
// a page can be linked to, reloaded, and reached with Back / Forward.
// → "sessions" | "custom:<id>" | null
function tenantRouteFromHash(hash) {
  const h = String(hash != null ? hash : (window.location && window.location.hash) || "");
  const m = h.match(/^#\/?([a-z][a-z0-9_-]{0,40}|custom:[A-Za-z0-9_-]{1,80})\/?$/);
  return m ? m[1] : null;
}
// Writes #/<route> (pushState = a new history entry for Back).
function tenantWriteRouteHash(route, push) {
  if (!route || tenantRouteFromHash() === route) return;
  try {
    const url = window.location.pathname + window.location.search + "#/" + route;
    if (push) window.history.pushState(null, "", url);
    else window.history.replaceState(null, "", url);
  } catch (_) {}
}
// Signing out on purpose: the next account starts from its own home page.
function tenantClearRouteHash() {
  if (!tenantRouteFromHash()) return;
  try { window.history.replaceState(null, "", window.location.pathname + window.location.search); } catch (_) {}
}

// Last branch this user picked in this clinic.
function tenantBranchChoiceKey() {
  const slug = window.TENANT_SLUG || tenantContext().slug;
  const s = window.TENANT_SESSION;
  const uid = (s && s.user && s.user.id) || (window.ME && window.ME.id);
  return slug && uid ? `${slug}|${uid}` : null;
}
function tenantRememberedBranch() {
  const key = tenantBranchChoiceKey();
  if (!key) return null;
  try { return (JSON.parse(tenantStoreGet("local", TENANT_KEYS.branchChoice) || "{}") || {})[key] || null; }
  catch (_) { return null; }
}
function tenantRememberBranch(id) {
  const key = tenantBranchChoiceKey();
  if (!key || !id) return;
  let map = {};
  try { map = JSON.parse(tenantStoreGet("local", TENANT_KEYS.branchChoice) || "{}") || {}; } catch (_) { map = {}; }
  map[key] = id;
  tenantStoreSet("local", TENANT_KEYS.branchChoice, JSON.stringify(map));
}

// After sign-in (or a restored session): GET /api/orgs/current gives the
// role, the enabled modules and the branches this member may use; the
// active branch (X-Branch-Id) is set to one of them BEFORE the data loads.
async function tenantLoadClinicData() {
  const cur = await tenantRequest("GET", "/orgs/current");
  if (!cur.ok) {
    const code = (cur.error && cur.error.code) || "";
    return { ok: false, status: cur.status, code, error: tenantFriendly(code) };
  }
  const d = cur.data || {};
  if (d.organization) tenantApplyOrg(d.organization);
  window.TENANT_ROLE = d.role || null;
  const branches = (Array.isArray(d.branches) ? d.branches : []).filter(b => b && b.id);
  const ids = branches.map(b => b.id);
  window.ACCESSIBLE_BRANCH_IDS = ids;
  // Active branches only (an inactive branch takes no new work), unless the
  // member has no active one.
  const activeIds = branches.filter(b => String(b.status || "active") !== "inactive").map(b => b.id);
  const usable = activeIds.length ? activeIds : ids;
  const pick = [tenantRememberedBranch(), d.current_branch_id].find(id => id && usable.includes(id)) || usable[0] || null;
  window.ACTIVE_BRANCH_ID = pick;
  if (pick) tenantStoreSet("local", TENANT_KEYS.activeBranch, JSON.stringify(pick));
  // Rows the member cannot read come back as {id} only: show them by id
  // until loadBranches() (inside loadClinicData) has the readable rows.
  window.BRANCHES = branches.map(b => (b.name != null ? b : { ...b, name: b.id }));
  window.dispatchEvent(new CustomEvent("kinetic:branches-updated", { detail: window.BRANCHES }));
  if (window.loadClinicData) await window.loadClinicData();
  return { ok: true };
}

// The picker's choice survives reloads (per user and clinic).
window.addEventListener("kinetic:branches-updated", (e) => {
  const id = e && e.detail && e.detail.activeId;
  if (id) tenantRememberBranch(id);
});

// The app owns the boot sequence: src/supabase.jsx would otherwise load
// every table on boot, before there is a session (each request a 401).
// Demo mode has no backend and keeps its local boot.
(function tenantTakeOverBoot() {
  let kind = "root";
  try { kind = tenantContext().kind; } catch (_) {}
  if (kind !== "demo" && window.__kineticBootTimer) {
    clearTimeout(window.__kineticBootTimer);
    window.__kineticBootTimer = null;
  }
})();


// ══════════════════════════════════════════════════════════════
// Shared pieces of the entry screens
// ══════════════════════════════════════════════════════════════
function TenantNotice({ notice }) {
  if (!notice || !notice.text) return null;
  const tones = {
    error: { bg: "var(--red-bg)", fg: "#A8443A" },
    success: { bg: "var(--green-bg)", fg: "#2C8067" },
    info: { bg: "var(--blue-100)", fg: "var(--blue-900)" },
  };
  const t = tones[notice.kind] || tones.info;
  return (
    <div role={notice.kind === "error" ? "alert" : "status"} className="tenant-notice" data-kind={notice.kind || "info"}
      style={{ background: t.bg, color: t.fg, borderRadius: 10, padding: "10px 12px", fontSize: 13, lineHeight: 1.6, marginBottom: 16 }}>
      {notice.text}
    </div>
  );
}

function TenantField({ id, label, type = "text", value, onChange, error, hint, autoComplete, dir, readOnly, required, autoFocus }) {
  const errId = error ? id + "-error" : undefined;
  const hintId = hint ? id + "-hint" : undefined;
  return (
    <div style={{ marginBottom: 14 }}>
      <label className="label" htmlFor={id} style={{ display: "block" }}>
        {label}{required && <span aria-hidden="true" style={{ color: "var(--red)" }}> *</span>}
      </label>
      <input id={id} name={id} className="input" type={type} value={value} dir={dir} readOnly={readOnly}
        autoComplete={autoComplete} autoFocus={autoFocus} required={required}
        onChange={e => onChange && onChange(e.target.value)}
        aria-invalid={error ? "true" : undefined}
        aria-describedby={[errId, hintId].filter(Boolean).join(" ") || undefined}
        style={{ height: 42, borderColor: error ? "var(--red)" : undefined, background: readOnly ? "var(--ink-50)" : undefined }} />
      {hint && !error && <div id={hintId} className="muted" style={{ fontSize: 12, marginTop: 5 }}>{hint}</div>}
      {error && <div id={errId} style={{ color: "#A8443A", fontSize: 12, marginTop: 5 }}>{error}</div>}
    </div>
  );
}

function TenantSubmit({ busy, children, disabled }) {
  return (
    <button type="submit" className="btn btn-blue" disabled={busy || disabled} aria-busy={busy ? "true" : undefined}
      style={{ width: "100%", height: 44, justifyContent: "center", marginTop: 6, fontSize: 14, opacity: busy ? 0.85 : 1, cursor: busy ? "progress" : "pointer" }}>
      {busy && <span className="spin" aria-hidden="true" style={{ width: 14, height: 14, border: "2px solid #fff", borderTopColor: "transparent", borderRadius: "50%" }} />}
      {children}
    </button>
  );
}

function TenantLoading({ text }) {
  return (
    <div role="status" style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, background: "var(--ink-50)" }}>
      <span className="spin" aria-hidden="true" style={{ width: 18, height: 18, border: "2px solid var(--blue-500)", borderTopColor: "transparent", borderRadius: "50%" }} />
      <span className="muted" style={{ fontSize: 13.5 }}>{text || tt("جارٍ التحميل…")}</span>
    </div>
  );
}

// Left half of the split entry screens (the same look as the clinic login).
function TenantBrandPanel({ title, lead, points, brand, subtitle, logo }) {
  return (
    <div className="auth-brand" style={{
      background: "linear-gradient(155deg, #7BBDE8 0%, #BDD8E9 60%, #E8F1F7 100%)",
      position: "relative", padding: "clamp(24px, 4vw, 40px) clamp(20px, 5vw, 48px)", overflow: "hidden",
      display: "flex", flexDirection: "column", justifyContent: "space-between", gap: 28,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {logo
          ? <img src={logo} alt="" style={{ width: 36, height: 36, borderRadius: 10, objectFit: "cover", background: "rgba(255,255,255,.6)" }} />
          : <I.Logo size={36} aria-hidden="true" />}
        <div>
          <div style={{ fontWeight: 600, fontSize: 20, color: "#0F1E2B" }}>{brand || "ClinicSystem EG"}</div>
          <div style={{ fontSize: 11.5, color: "#1E4A6E" }}>{subtitle || tt("نظام إدارة العيادات")}</div>
        </div>
      </div>
      <div className="auth-brand-extra" style={{ maxWidth: 460 }}>
        <div className="serif" style={{ fontSize: "clamp(28px, 4.6vw, 42px)", lineHeight: 1.2, color: "#0F1E2B", marginBottom: 16 }}>{title}</div>
        {lead && <p style={{ fontSize: 14.5, color: "#1E4A6E", lineHeight: 1.7, margin: 0 }}>{lead}</p>}
        {points && points.length > 0 && (
          <ul style={{ listStyle: "none", padding: 0, margin: "22px 0 0", display: "flex", flexDirection: "column", gap: 10 }}>
            {points.map((p, i) => (
              <li key={i} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13.5, color: "#0F1E2B" }}>
                <span aria-hidden="true" style={{ width: 22, height: 22, borderRadius: 7, background: "rgba(255,255,255,.65)", display: "flex", alignItems: "center", justifyContent: "center", color: "#1E4A6E" }}>
                  <I.Check size={13} />
                </span>
                {p}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="auth-brand-extra" style={{ fontSize: 12, color: "#1E4A6E" }}>© {new Date().getFullYear()} ClinicSystem EG</div>
    </div>
  );
}

// The language switch of the entry screens (docs/04 «اللغتان»): always the
// top end corner of the page — above the form on wide screens, on the brand
// bar on phones — with a 44px touch target. AuthScreen (src/ui.jsx) can use
// the same window.TenantLangCorner inside a position:relative page.
function TenantLangCorner() {
  return (
    <div className="tenant-lang" style={{ position: "absolute", top: 12, insetInlineEnd: 12, zIndex: 5 }}>
      <LangSwitch className="btn btn-secondary"
        style={{ minHeight: 44, minWidth: 44, padding: "0 14px", justifyContent: "center", fontSize: 13 }} />
    </div>
  );
}

function TenantSplit({ panel, children }) {
  return (
    <div className="auth-grid" style={{ position: "relative" }}>
      <TenantLangCorner />
      {panel}
      <main style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "clamp(20px, 5vw, 40px)" }}>
        <div style={{ width: "100%", maxWidth: 420 }}>{children}</div>
      </main>
    </div>
  );
}

// «العودة»: the arrow points to where the reading started (right in Arabic).
function TenantBackIcon() {
  const Ico = I[IS_RTL ? "ArrowRight" : "ArrowLeft"];
  return <Ico size={13} />;
}
// «افتح / التالي»: towards the end of the line (left in Arabic).
function TenantForwardIcon(props) {
  const Ico = I[IS_RTL ? "ArrowLeft" : "ArrowRight"];
  return <Ico {...props} />;
}

// «نسيت كلمة المرور»: one generic answer whatever the address (the API
// never reveals whether an account exists).
function TenantForgotForm({ onBack, initialEmail }) {
  const [email, setEmail] = React.useState(initialEmail || "");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [sent, setSent] = React.useState(false);

  async function submit(e) {
    e && e.preventDefault();
    const value = email.trim();
    if (!TENANT_EMAIL_RE.test(value)) { setError(tt("أدخل بريدًا إلكترونيًا صحيحًا")); return; }
    setBusy(true); setError("");
    const res = window.sendPasswordReset ? await window.sendPasswordReset(value) : { ok: false, error: tenantFriendly("network_error") };
    setBusy(false);
    if (!res.ok) { setError(res.error || tenantFriendly("network_error")); return; }
    setSent(true);
  }

  return (
    <>
      <h1 className="h1" style={{ fontSize: 28, marginBottom: 6 }}>{tt("إعادة تعيين كلمة المرور")}</h1>
      <div className="muted" style={{ fontSize: 14, marginBottom: 24 }}>{tt("أدخل بريدك المسجّل وسنرسل إليه رابطًا لمرة واحدة.")}</div>
      {sent
        ? <TenantNotice notice={{ kind: "success", text: tt(TENANT_RESET_SENT) }} />
        : (
          <form onSubmit={submit} noValidate>
            <TenantField id="forgot-email" label={tt("البريد الإلكتروني")} type="email" dir="ltr" autoComplete="email" autoFocus
              value={email} onChange={setEmail} error={error} />
            <TenantSubmit busy={busy}>{tt("إرسال رابط الإعادة")}</TenantSubmit>
          </form>
        )}
      <button type="button" onClick={onBack}
        style={{ background: "none", border: "none", color: "var(--blue-700)", fontSize: 13, marginTop: 8, minHeight: 40, cursor: "pointer", display: "flex", alignItems: "center", gap: 6, padding: 0 }}>
        <TenantBackIcon /> {tt("العودة لتسجيل الدخول")}
      </button>
    </>
  );
}


// ══════════════════════════════════════════════════════════════
// S06 — status pages
// ══════════════════════════════════════════════════════════════
// Titles and texts are Arabic source text, translated where shown.
const TENANT_STATUS = {
  "not-found":      { icon: "MapPin",   tone: "grey",  title: "لا توجد عيادة بهذا الرابط",
                      body: "تأكد من كتابة الرابط كما وصلك، أو ارجع إلى الموقع الرئيسي." },
  suspended:        { icon: "Lock",     tone: "red",   title: "العيادة متوقفة",
                      body: "هذه العيادة متوقفة حاليًا. تواصل مع إدارة المنصة." },
  pending:          { icon: "Clock",    tone: "amber", title: "العيادة بانتظار التفعيل",
                      body: "تُفعَّل العيادة عندما يقبل مديرها الدعوة المرسلة إلى بريده. إن كنت المدير فافتح رابط الدعوة من بريدك الإلكتروني." },
  "no-membership":  { icon: "Users",    tone: "amber", title: "لا توجد عضوية نشطة",
                      body: "ليست لديك عضوية نشطة في هذه العيادة. إن كانت عضويتك معطّلة فتواصل مع مدير العيادة." },
  "no-clinic":      { icon: "Users",    tone: "amber", title: "حسابك غير مرتبط بعيادة",
                      body: "لا توجد لحسابك عضوية نشطة في أي عيادة حاليًا. يُضاف الموظفون بدعوة من مدير العيادة." },
  error:            { icon: "X",        tone: "red",   title: "تعذّر الاتصال بالخادم",
                      body: "تحقق من اتصالك بالإنترنت ثم أعد المحاولة." },
  "platform-unavailable": { icon: "Settings", tone: "grey", title: "لوحة إدارة المنصة غير متاحة حاليًا",
                      body: "لم تُحمَّل لوحة إدارة المنصة في هذا الإصدار. أعد تحميل الصفحة، أو تواصل مع فريق المنصة." },
  "invitation_not_found": { icon: "Mail", tone: "grey", title: "رابط الدعوة غير صحيح",
                      body: "تأكد من فتح الرابط كاملًا كما وصلك في البريد، أو اطلب دعوة جديدة من مدير العيادة." },
  "invitation_used":      { icon: "Check", tone: "grey", title: "هذه الدعوة استُخدمت من قبل",
                      body: "إن كنت قبلتها فسجّل الدخول من رابط عيادتك. وإلا فاطلب دعوة جديدة من مدير العيادة." },
  "invitation_expired":   { icon: "Clock", tone: "amber", title: "انتهت صلاحية هذه الدعوة",
                      body: "الدعوة صالحة لسبعة أيام. اطلب دعوة جديدة من مدير العيادة." },
  "invitation_revoked":   { icon: "X", tone: "amber", title: "أُلغيت هذه الدعوة",
                      body: "ألغى مدير العيادة هذه الدعوة. اطلب دعوة جديدة إن كنت ما زلت تحتاج الوصول." },
  "invitation_org_inactive": { icon: "Lock", tone: "red", title: "العيادة غير نشطة حاليًا",
                      body: "لا يمكن قبول الدعوة الآن لأن العيادة غير نشطة. تواصل مع إدارة المنصة." },
};
const TENANT_TONES = {
  grey: { bg: "var(--ink-100)", fg: "var(--ink-700)" },
  red: { bg: "var(--red-bg)", fg: "#A8443A" },
  amber: { bg: "var(--amber-bg)", fg: "#9B6321" },
  green: { bg: "var(--green-bg)", fg: "#2C8067" },
};

function TenantStatusScreen({ status, email, isSuperAdmin, onLogout, onRetry, children }) {
  const t = TENANT_STATUS[status] || TENANT_STATUS.error;
  const tone = TENANT_TONES[t.tone] || TENANT_TONES.grey;
  const Ico = I[t.icon] || I.X;
  React.useEffect(() => { document.title = tt(t.title) + " — ClinicSystem EG"; }, [t.title]);
  const linkBtn = { height: 40, justifyContent: "center" };
  return (
    <main className="tenant-status" data-status={status}
      style={{ position: "relative", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: "68px 24px 24px", background: "var(--ink-50)" }}>
      <TenantLangCorner />
      <div className="card" style={{ maxWidth: 480, width: "100%", textAlign: "center", padding: "32px 28px" }}>
        <div aria-hidden="true" style={{ width: 52, height: 52, borderRadius: 14, margin: "0 auto 16px", display: "flex", alignItems: "center", justifyContent: "center", background: tone.bg, color: tone.fg }}>
          <Ico size={22} />
        </div>
        <h1 className="h2" style={{ marginBottom: 10 }}>{tt(t.title)}</h1>
        <p className="muted" style={{ fontSize: 14, lineHeight: 1.7, margin: "0 0 8px" }}>{tt(t.body)}</p>
        {email && <p style={{ fontSize: 13, margin: "0 0 8px", color: "var(--ink-700)" }}>{ttx("الحساب: {email}", { email: <bdi className="mono" dir="ltr">{email}</bdi> })}</p>}
        {isSuperAdmin && (
          <p style={{ fontSize: 13, margin: "0 0 8px", color: "var(--ink-700)" }}>{tt("أنت مدير المنصة: يمكنك فتح لوحة إدارة المنصة.")}</p>
        )}
        {children}
        <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap", marginTop: 18 }}>
          {onRetry && <button type="button" className="btn btn-blue" style={linkBtn} onClick={onRetry}>{tt("إعادة المحاولة")}</button>}
          {isSuperAdmin && <a className="btn btn-blue" style={linkBtn} href={tenantPlatformUrl()}><I.Settings size={14} /> {tt("لوحة إدارة المنصة")}</a>}
          {onLogout && <button type="button" className="btn btn-secondary" style={linkBtn} onClick={onLogout}><I.Logout size={14} /> {tt("تسجيل الخروج")}</button>}
          <a className="btn btn-secondary" style={linkBtn} href={tenantRootUrl()}
            onClick={(e) => { e.preventDefault(); tenantGoRoot(); }}>{tt("الموقع الرئيسي")}</a>
        </div>
      </div>
    </main>
  );
}


// ══════════════════════════════════════════════════════════════
// S01 + S02 + S04 — the main site: login, then the clinic
// ══════════════════════════════════════════════════════════════
function TenantClinicPicker({ session, onLogout }) {
  const ms = (session && session.memberships) || [];
  return (
    <>
      <h1 className="h1" style={{ fontSize: 28, marginBottom: 6 }}>{tt("اختر العيادة")}</h1>
      <div className="muted" style={{ fontSize: 14, marginBottom: 20 }}>{tt("حسابك عضو في أكثر من عيادة. اختر العيادة التي تريد فتحها الآن.")}</div>
      <ul aria-label={tt("عياداتك")} style={{ listStyle: "none", padding: 0, margin: "0 0 18px", display: "flex", flexDirection: "column", gap: 10 }}>
        {ms.map(m => (
          <li key={m.organization_id || m.slug}>
            <a href={tenantClinicUrl(m.slug)} className="card tenant-clinic-card" data-slug={m.slug}
              style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", color: "inherit", minHeight: 44 }}>
              <span aria-hidden="true" style={{ width: 40, height: 40, borderRadius: 11, background: "var(--blue-100)", color: "var(--blue-700)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <I.Stethoscope size={18} />
              </span>
              <span style={{ flex: 1, minWidth: 0, display: "block" }}>
                <span style={{ display: "block", fontWeight: 600, fontSize: 14.5, color: "var(--ink-900)" }}>{m.name}</span>
                <span style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                  {TENANT_SPECIALTY_AR[m.specialty_code] && <span className="badge b-violet">{tt(TENANT_SPECIALTY_AR[m.specialty_code])}</span>}
                  <span className="badge b-grey">{tt(TENANT_ROLE_AR[m.role] || m.role)}</span>
                </span>
                {/* dir=ltr on the address itself: align it with the page's start edge. */}
                <bdi className="mono" dir="ltr" style={{ display: "block", fontSize: 11.5, color: "var(--ink-500)", marginTop: 6, textAlign: IS_RTL ? "right" : "left" }}>{tenantClinicLabel(m.slug)}</bdi>
              </span>
              <TenantForwardIcon size={16} style={{ color: "var(--ink-400)", flexShrink: 0 }} />
            </a>
          </li>
        ))}
      </ul>
      {session && session.is_super_admin && (
        <a href={tenantPlatformUrl()} className="btn btn-secondary" style={{ width: "100%", justifyContent: "center", height: 40, marginBottom: 10 }}>
          <I.Settings size={14} /> {tt("لوحة إدارة المنصة")}
        </a>
      )}
      <button type="button" className="btn btn-ghost" onClick={onLogout} style={{ width: "100%", justifyContent: "center", height: 40 }}>
        <I.Logout size={14} /> {tt("تسجيل الخروج")}
      </button>
    </>
  );
}

function TenantRootPortal() {
  // checking | login | forgot | picker | none | redirecting
  const [phase, setPhase] = React.useState("checking");
  const [session, setSession] = React.useState(null);
  const [notice, setNotice] = React.useState(() => tenantTakeFlash());
  const [email, setEmail] = React.useState("");
  const [pw, setPw] = React.useState("");
  const [remember, setRemember] = React.useState(true);
  const [errors, setErrors] = React.useState({});
  const [busy, setBusy] = React.useState(false);

  // J3: one clinic → straight there; several → S04; none → S06.
  function route(s) {
    setSession(s);
    tenantSetSession(s);
    const ms = (s && s.memberships) || [];
    if (ms.length === 1) {
      setPhase("redirecting");
      window.location.assign(tenantClinicUrl(ms[0].slug));
      return;
    }
    setPhase(ms.length > 1 ? "picker" : "none");
  }

  React.useEffect(() => {
    document.title = "ClinicSystem EG — " + tt("نظام إدارة العيادات");
    // The main site has no clinic: stop sending a remembered X-Org-Slug.
    tenantStoreRemove("session", TENANT_KEYS.org);
    let cancelled = false;
    (async () => {
      const client = window.SB;
      if (!client) { setPhase("login"); return; }
      let s = null;
      try {
        const r = await client.auth.getSession();
        s = r && r.data ? r.data.session : null;
      } catch (_) { s = null; }
      if (cancelled) return;
      if (s) route(s); else setPhase("login");
    })();
    return () => { cancelled = true; };
  }, []);

  async function submit(e) {
    e && e.preventDefault();
    const v = email.trim();
    const errs = {};
    if (!TENANT_EMAIL_RE.test(v)) errs.email = tt("أدخل بريدًا إلكترونيًا صحيحًا");
    if (!pw) errs.pw = tt("أدخل كلمة المرور");
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const client = window.SB;
    if (!client) { setNotice({ kind: "error", text: tenantFriendly("network_error") }); return; }
    setBusy(true); setNotice(null);
    const credentials = { email: v, password: pw };
    if (remember) credentials.options = { remember: true };
    const { data, error } = await client.auth.signInWithPassword(credentials);
    setBusy(false);
    if (error) {
      const code = error.code || (error.status === 0 ? "network_error" : "");
      setNotice({ kind: "error", text: tenantFriendly(code, "تعذّر تسجيل الدخول") });
      return;
    }
    setPw("");
    route(data.session);
  }

  async function logout() {
    try { if (window.signOut) await window.signOut(); } catch (_) {}
    setSession(null);
    setNotice(null);
    setPhase("login");
  }

  if (phase === "checking") return <TenantLoading text={tt("جارٍ التحقق من الجلسة…")} />;
  if (phase === "redirecting") return <TenantLoading text={tt("جارٍ فتح عيادتك…")} />;
  if (phase === "none") {
    return <TenantStatusScreen status="no-clinic" email={session && session.user && session.user.email}
      isSuperAdmin={!!(session && session.is_super_admin)} onLogout={logout} />;
  }

  const panel = (
    <TenantBrandPanel
      title={ttx("عيادتك كلها، {em}.", { em: <em>{tt("في مكان واحد")}</em> })}
      lead={tt("المواعيد، والمرضى، والجلسات، والفواتير، والفروع — لكل عيادة مساحتها الخاصة ورابطها الخاص.")}
      points={[tt("الدخول بدعوة فقط من مدير العيادة"), tt("كل عيادة ترى بياناتها فقط"), tt("يعمل على الحاسوب والجوال")]} />
  );

  return (
    <TenantSplit panel={panel}>
      <TenantNotice notice={notice} />
      {phase === "picker" && <TenantClinicPicker session={session} onLogout={logout} />}
      {phase === "forgot" && <TenantForgotForm initialEmail={email} onBack={() => setPhase("login")} />}
      {phase === "login" && (
        <>
          <h1 className="h1" style={{ fontSize: 30, marginBottom: 6 }}>{tt("تسجيل الدخول")}</h1>
          <div className="muted" style={{ fontSize: 14, marginBottom: 24 }}>
            {tt("سجّل الدخول وسننقلك إلى عيادتك. ليس لديك حساب؟ يُنشأ الحساب بدعوة من مدير العيادة.")}
          </div>
          <form onSubmit={submit} noValidate>
            <TenantField id="root-email" label={tt("البريد الإلكتروني")} type="email" dir="ltr" autoComplete="username"
              value={email} onChange={setEmail} error={errors.email} />
            <TenantField id="root-password" label={tt("كلمة المرور")} type="password" autoComplete="current-password"
              value={pw} onChange={setPw} error={errors.pw} />
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, margin: "2px 0 14px" }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "var(--ink-700)", minHeight: 32 }}>
                <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} /> {tt("أبقني مسجلاً لمدة 30 يومًا")}
              </label>
              <button type="button" className="auth-link" onClick={() => { setNotice(null); setPhase("forgot"); }}
                style={{ background: "none", border: "none", color: "var(--blue-700)", fontSize: 12.5, cursor: "pointer", padding: 0 }}>{tt("نسيت كلمة المرور؟")}</button>
            </div>
            <TenantSubmit busy={busy}>{tt("تسجيل الدخول")}</TenantSubmit>
          </form>
        </>
      )}
    </TenantSplit>
  );
}


// ══════════════════════════════════════════════════════════════
// S03 — accept an invitation (?invite=<token>)
// ══════════════════════════════════════════════════════════════
function TenantInviteScreen({ token }) {
  // loading | ready | gone | error | entering
  const [state, setState] = React.useState({ phase: "loading" });
  const [name, setName] = React.useState("");
  const [pw, setPw] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [errors, setErrors] = React.useState({});
  const [notice, setNotice] = React.useState(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    setState({ phase: "loading" });
    const r = await tenantRequest("GET", "/invitations/" + encodeURIComponent(token));
    if (r.ok && r.data) {
      setState({ phase: "ready", inv: r.data });
      document.title = tt("دعوة للانضمام إلى {clinic}", { clinic: (r.data.organization && r.data.organization.name) || tt("العيادة") }) + " — ClinicSystem EG";
      return;
    }
    if (r.status === 404 || r.status === 410 || r.status === 403) {
      const code = (r.error && r.error.code) || "";
      setState({ phase: "gone", code: code === "org_inactive" ? "invitation_org_inactive" : (TENANT_STATUS[code] ? code : "invitation_not_found") });
      return;
    }
    setState({ phase: "error" });
  }, [token]);

  React.useEffect(() => { load(); }, [load]);

  if (state.phase === "loading") return <TenantLoading text={tt("جارٍ التحقق من الدعوة…")} />;
  if (state.phase === "entering") return <TenantLoading text={tt("تم قبول الدعوة — جارٍ فتح العيادة…")} />;
  if (state.phase === "gone") return <TenantStatusScreen status={state.code} />;
  if (state.phase === "error") return <TenantStatusScreen status="error" onRetry={load} />;

  const inv = state.inv;
  const org = inv.organization || {};
  const exists = !!inv.account_exists;
  const roleAr = TENANT_ROLE_AR[inv.role] || inv.role;

  async function submit(e) {
    e && e.preventDefault();
    const errs = {};
    if (exists) {
      if (!pw) errs.pw = tt("أدخل كلمة مرور حسابك");
    } else {
      if (!name.trim()) errs.name = tt("أدخل اسمك الكامل");
      else if (name.trim().length > 120) errs.name = tt("الاسم حتى 120 حرفًا");
      const p = tenantPasswordProblem(pw);
      if (p) errs.pw = p;
      else if (confirm !== pw) errs.confirm = tt("كلمتا المرور غير متطابقتين");
    }
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true); setNotice(null);
    const body = exists ? { password: pw } : { password: pw, name: name.trim() };
    const r = await tenantRequest("POST", "/invitations/" + encodeURIComponent(token) + "/accept", body);
    setBusy(false);
    if (r.ok) {
      const slug = (r.data && r.data.organization && r.data.organization.slug) || org.slug;
      setState({ phase: "entering" });
      window.location.assign(tenantClinicUrl(slug));
      return;
    }
    const code = (r.error && r.error.code) || "";
    if (r.status === 410 || r.status === 404 || code === "org_inactive") {
      setState({ phase: "gone", code: code === "org_inactive" ? "invitation_org_inactive" : (TENANT_STATUS[code] ? code : "invitation_not_found") });
      return;
    }
    if (code === "invalid_credentials") { setErrors({ pw: tt("كلمة المرور غير صحيحة لهذا الحساب") }); return; }
    if (code === "weak_password") { setErrors({ pw: tenantFriendly("weak_password") }); return; }
    if (code === "invalid_name") { setErrors({ name: tenantFriendly("invalid_name") }); return; }
    setNotice({ kind: "error", text: tenantFriendly(code || (r.status ? "" : "network_error"), "تعذّر قبول الدعوة — أعد المحاولة") });
  }

  const panel = (
    <TenantBrandPanel
      title={ttx("دعوة للانضمام إلى {clinic}", { clinic: <em>{org.name}</em> })}
      lead={exists
        ? tt("ستُضاف هذه العيادة إلى حسابك الحالي، وتدخل إليها بالبريد وكلمة المرور نفسيهما.")
        : tt("أنشئ حسابك لتبدأ العمل في العيادة. ستدخل بهذا البريد وكلمة المرور التي تختارها الآن.")} />
  );

  return (
    <TenantSplit panel={panel}>
      <h1 className="h1" style={{ fontSize: 28, marginBottom: 6 }}>{tt("قبول الدعوة")}</h1>
      <div className="muted" style={{ fontSize: 14, marginBottom: 18 }}>
        {exists
          ? tt("لديك حساب بهذا البريد بالفعل. أدخل كلمة مرور حسابك الحالية لقبول الدعوة — لن تتغير كلمة مرورك.")
          : tt("اكتب اسمك واختر كلمة مرور لحسابك الجديد.")}
      </div>
      <dl className="card tenant-invite-summary" style={{ padding: "12px 16px", margin: "0 0 18px", display: "grid", gridTemplateColumns: "auto 1fr", gap: "8px 14px", fontSize: 13 }}>
        <dt className="muted">{tt("العيادة")}</dt><dd style={{ margin: 0, fontWeight: 600 }}>{org.name}</dd>
        <dt className="muted">{tt("البريد")}</dt><dd style={{ margin: 0 }}><bdi className="mono" dir="ltr">{inv.email}</bdi></dd>
        <dt className="muted">{tt("الدور")}</dt><dd style={{ margin: 0 }}><span className="badge b-grey">{tt(roleAr)}</span></dd>
      </dl>
      <TenantNotice notice={notice} />
      <form onSubmit={submit} noValidate data-mode={exists ? "existing" : "new"}>
        {!exists && (
          <TenantField id="invite-name" label={tt("الاسم الكامل")} autoComplete="name" required
            value={name} onChange={setName} error={errors.name} />
        )}
        <TenantField id="invite-password" label={exists ? tt("كلمة مرور حسابك") : tt("كلمة المرور")} type="password" required
          autoComplete={exists ? "current-password" : "new-password"}
          hint={exists ? "" : tt("6 أحرف على الأقل")}
          value={pw} onChange={setPw} error={errors.pw} />
        {!exists && (
          <TenantField id="invite-confirm" label={tt("تأكيد كلمة المرور")} type="password" autoComplete="new-password" required
            value={confirm} onChange={setConfirm} error={errors.confirm} />
        )}
        <TenantSubmit busy={busy}>{exists ? tt("قبول الدعوة والدخول") : tt("تفعيل الحساب والدخول")}</TenantSubmit>
      </form>
    </TenantSplit>
  );
}


// ══════════════════════════════════════════════════════════════
// New password from the e-mailed link (?reset=<token>)
// ══════════════════════════════════════════════════════════════
function TenantResetScreen({ token }) {
  const [pw, setPw] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [errors, setErrors] = React.useState({});
  const [notice, setNotice] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { document.title = tt("كلمة مرور جديدة") + " — ClinicSystem EG"; }, []);

  function loginUrl() {
    try {
      const u = new URL(window.location.href);
      u.searchParams.delete("reset");
      return u.pathname + u.search + u.hash;
    } catch (_) { return "/"; }
  }

  async function submit(e) {
    e && e.preventDefault();
    const errs = {};
    const p = tenantPasswordProblem(pw);
    if (p) errs.pw = p;
    else if (confirm !== pw) errs.confirm = tt("كلمتا المرور غير متطابقتين");
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true); setNotice(null);
    const r = await tenantRequest("POST", "/auth/reset/confirm", { token, password: pw });
    setBusy(false);
    if (r.ok) {
      tenantSetFlash("success", tt("تم تغيير كلمة المرور. سجّل الدخول بكلمة المرور الجديدة."));
      window.location.replace(loginUrl());
      return;
    }
    const code = (r.error && r.error.code) || "";
    if (code === "weak_password") { setErrors({ pw: tenantFriendly("weak_password") }); return; }
    if (code === "invalid_token") {
      setNotice({ kind: "error", text: tt("رابط إعادة التعيين غير صالح أو انتهت صلاحيته (يعمل مرة واحدة خلال ساعة). اطلب رابطًا جديدًا من شاشة الدخول.") });
      return;
    }
    setNotice({ kind: "error", text: tenantFriendly(code || (r.status ? "" : "network_error"), "تعذّر تغيير كلمة المرور — أعد المحاولة") });
  }

  const panel = <TenantBrandPanel title={tt("كلمة مرور جديدة")} lead={tt("اختر كلمة مرور جديدة لحسابك. ستنتهي كل الجلسات المفتوحة على أجهزتك الأخرى.")} />;
  return (
    <TenantSplit panel={panel}>
      <h1 className="h1" style={{ fontSize: 28, marginBottom: 6 }}>{tt("تعيين كلمة مرور جديدة")}</h1>
      <div className="muted" style={{ fontSize: 14, marginBottom: 22 }}>{tt("اكتب كلمة المرور الجديدة مرتين.")}</div>
      <TenantNotice notice={notice} />
      <form onSubmit={submit} noValidate>
        <TenantField id="reset-password" label={tt("كلمة المرور الجديدة")} type="password" autoComplete="new-password" required autoFocus
          hint={tt("6 أحرف على الأقل")} value={pw} onChange={setPw} error={errors.pw} />
        <TenantField id="reset-confirm" label={tt("تأكيد كلمة المرور")} type="password" autoComplete="new-password" required
          value={confirm} onChange={setConfirm} error={errors.confirm} />
        <TenantSubmit busy={busy}>{tt("حفظ كلمة المرور")}</TenantSubmit>
      </form>
      <a href={loginUrl()} style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--blue-700)", fontSize: 13, marginTop: 8, minHeight: 40 }}>
        <TenantBackIcon /> {tt("العودة لتسجيل الدخول")}
      </a>
    </TenantSplit>
  );
}


// ══════════════════════════════════════════════════════════════
// Platform context and module gating
// ══════════════════════════════════════════════════════════════
// The Super Admin panel is window.PlatformApp (src/platform.jsx), which
// handles its own sign-in. In the production build it is a separate chunk
// (KINETIC_CHUNKS.platform, scripts/build.mjs) that only this context
// downloads (task 3.12); in `npm run dev` index.html has loaded it already.
function TenantPlatformGate() {
  const chunk = window.KINETIC_CHUNKS && window.KINETIC_CHUNKS.platform;
  const [state, setState] = React.useState(() => (typeof window.PlatformApp === "function" ? "ready" : chunk ? "loading" : "missing"));
  React.useEffect(() => {
    if (state !== "loading") return;
    loadScriptOnce(chunk)
      .then(() => setState(typeof window.PlatformApp === "function" ? "ready" : "missing"))
      .catch(() => setState("missing"));
  }, [state]);
  if (state === "ready") return <window.PlatformApp />;
  if (state === "loading") return <TenantLoading text={tt("جارٍ تحميل لوحة المنصة…")} />;
  return <TenantStatusScreen status="platform-unavailable" />;
}

// A route whose module is disabled for this clinic (docs/03 "وحدة معطلة").
function TenantModuleDisabled({ go }) {
  return (
    <Page>
      <div className="card tenant-module-off" role="status"
        style={{ maxWidth: 520, margin: "60px auto", textAlign: "center", padding: "32px 28px" }}>
        <div aria-hidden="true" style={{ width: 52, height: 52, borderRadius: 14, margin: "0 auto 16px", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--ink-100)", color: "var(--ink-700)" }}>
          <I.Lock size={22} />
        </div>
        <h1 className="h2" style={{ marginBottom: 10 }}>{tt("هذه الميزة غير مفعلة لعيادتك")}</h1>
        <p className="muted" style={{ fontSize: 14, lineHeight: 1.7, margin: "0 0 18px" }}>
          {tt("تُفعَّل ميزات العيادة من إدارة المنصة. بيانات هذه الميزة — إن وُجدت — محفوظة ولم تُحذف.")}
        </p>
        <button type="button" className="btn btn-blue" onClick={() => go && go("dashboard")}>
          {tt("العودة إلى لوحة التحكم")}
        </button>
      </div>
    </Page>
  );
}

Object.assign(window, {
  tenantContext, tenantHostInfo, tenantClinicUrl, tenantRootUrl, tenantPlatformUrl, tenantGoRoot,
  tenantRequest, tenantResolveOrg, tenantApplyOrg, tenantMembershipFor, tenantBuildUser,
  tenantLoginVerdict, tenantRestoreSession, tenantLoadClinicData, tenantSetFlash, tenantTakeFlash,
  tenantSetSession, tenantRouteFromHash, tenantWriteRouteHash, tenantClearRouteHash,
  TenantRootPortal, TenantStatusScreen, TenantInviteScreen, TenantResetScreen, TenantForgotForm,
  TenantPlatformGate, TenantModuleDisabled, TenantLoading, TenantNotice, TenantLangCorner,
});
