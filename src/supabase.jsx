// ===== src/supabase.jsx =====
// Supabase client + clinic branding + custom sections store.
// Runs before every other file so window.SB, window.CLINIC, and
// window.CUSTOM_SECTIONS are available to Sidebar / SettingsPage / App.
//
// Falls back to localStorage transparently if Supabase env is not set,
// so the app remains fully functional offline / in demo mode.

// ── Config ────────────────────────────────────────────────────
const SUPABASE_URL = window.SUPABASE_URL || "https://iwqnhajzjudmhseurwmh.supabase.co";
const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY || "sb_publishable_fOuGESwDv4iQSRz0mPs2Bw_Of7zk58R";
const LS_CLINIC = "kinetic.clinic";
const LS_SECTIONS = "kinetic.sections";
const LS_BRANCHES = "kinetic.branches";
const LS_ACTIVE_BRANCH = "kinetic.active_branch";

// ── Supabase client (nullable) ────────────────────────────────
// Demo mode (?demo=1) forces the localStorage fallback so the app stays
// interactive without a live Supabase backend (schema/RLS may not match).
let sb = null;
if (SUPABASE_URL && SUPABASE_ANON_KEY && window.supabase && window.supabase.createClient) {
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}
window.SB = sb;
// Demo mode removed — all data flows through PostgreSQL. IS_DEMO is
// kept as a stable `false` so any lingering call sites become no-ops.
window.IS_DEMO = false;

// ── Default clinic branding ───────────────────────────────────
// Empty placeholders only — the authoritative values live in the
// `clinic_settings` singleton row. If loadClinic() has not resolved yet
// (the very first frame after boot) the sidebar shows the placeholder
// name for one paint, then re-renders on the `kinetic:clinic-updated`
// event. No hardcoded "Kinetic" / "كينيتك" name leaks into the DB or the
// exported PDFs — those all go through `window.CLINIC.name`.
const DEFAULT_CLINIC = {
  name: "",
  subtitle: "",
  logo: null,
  primary: "#7BBDE8",
  // Calendar working window — used by every calendar view and slot picker.
  calendar_start: "08:00",
  calendar_end: "18:00",
  appointment_duration: 30,
};

// ── Default custom sections (empty) ───────────────────────────
const DEFAULT_SECTIONS = [];

// ── Local persistence helpers ─────────────────────────────────
function readLS(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) { console.warn("readLS failed", key, e); return fallback; }
}
function writeLS(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch (e) { console.warn("writeLS failed", key, e); }
}
// Escape untrusted text for interpolation into HTML.
function escHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ── Clinic branding: load / save ──────────────────────────────
// Reads the singleton row (id = 1). Postgres is the single source of
// truth — no localStorage fallback for the branding fields, because a
// stale LS value was the reason the Settings page appeared to save
// then revert on refresh.
async function loadClinic() {
  if (!sb) {
    window.CLINIC = { ...DEFAULT_CLINIC };
    return window.CLINIC;
  }
  const { data, error } = await sb.from("clinic_settings").select("*").eq("id", 1).maybeSingle();
  if (error) {
    console.error("[clinic] loadClinic failed", error);
    throw new Error(error.message || "تعذّر تحميل بيانات العيادة");
  }
  const merged = { ...DEFAULT_CLINIC, ...(data || {}) };
  window.CLINIC = merged;
  window.dispatchEvent(new CustomEvent("kinetic:clinic-updated", { detail: merged }));
  return merged;
}

// Columns that actually exist on `clinic_settings`. Anything the form
// adds outside this list is UI-only and must not be sent to PostgREST —
// unknown columns 400 the upsert, which is the bug that made saves
// appear successful but revert on reload.
const CLINIC_COLS = [
  "id","name","subtitle","logo","primary_color","branch","phone","email",
  "address","tax_id","hours","website","currency","timezone",
  "appointment_duration","calendar_start","calendar_end","updated_at",
];

// ── Calendar working window (from clinic settings) ────────────
// Single source of truth for every calendar grid and time-slot picker.
// Reads window.CLINIC (hydrated by loadClinic) with safe fallbacks, so
// no screen ever hardcodes working hours or slot duration again.
function hmToMinutes(t) {
  const [h, m] = String(t || "").split(":").map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}
function minutesToHm(min) {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}
function calendarConfig() {
  const c = window.CLINIC || DEFAULT_CLINIC;
  const valid = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t || "");
  let start = valid(c.calendar_start) ? c.calendar_start : "08:00";
  let end   = valid(c.calendar_end)   ? c.calendar_end   : "18:00";
  if (end <= start) { start = "08:00"; end = "18:00"; }
  let slotMinutes = parseInt(c.appointment_duration, 10);
  if (!Number.isFinite(slotMinutes) || slotMinutes < 5 || slotMinutes > 240) slotMinutes = 30;
  return {
    start, end, slotMinutes,
    startMinutes: hmToMinutes(start),
    endMinutes: hmToMinutes(end),
  };
}
// Bookable time slots between start (inclusive) and end (inclusive),
// stepped by the configured slot duration (or an explicit step).
function calendarSlots(stepMinutes) {
  const cfg = calendarConfig();
  const step = Number.isFinite(stepMinutes) && stepMinutes > 0 ? stepMinutes : cfg.slotMinutes;
  const out = [];
  for (let m = cfg.startMinutes; m <= cfg.endMinutes; m += step) out.push(minutesToHm(m));
  return out;
}
// Hour-row labels for the calendar grids (whole hours covering the window).
function calendarHours() {
  const cfg = calendarConfig();
  const out = [];
  for (let m = cfg.startMinutes - (cfg.startMinutes % 60); m <= cfg.endMinutes; m += 60) {
    out.push(minutesToHm(m));
  }
  return out;
}
Object.assign(window, { calendarConfig, calendarSlots, calendarHours });

async function saveClinic(patch) {
  if (!sb) throw new Error("قاعدة البيانات غير متصلة");
  const merged = { ...(window.CLINIC || DEFAULT_CLINIC), ...patch };

  // Whitelist projection so PostgREST never sees a stray column.
  const dbRow = { id: 1 };
  for (const k of CLINIC_COLS) if (merged[k] !== undefined) dbRow[k] = merged[k];
  dbRow.updated_at = new Date().toISOString();

  console.info("[clinic] outbound clinic_settings payload", dbRow);
  // UPDATE the singleton by primary key. The migration guarantees the row
  // exists, so we do NOT need upsert — an UPDATE that affects 0 rows must
  // surface as a real failure (either RLS blocked us or the row was
  // deleted out from under us), and the caller must see that.
  const { data, error, status } = await sb
    .from("clinic_settings")
    .update(dbRow)
    .eq("id", 1)
    .select("*")
    .maybeSingle();
  console.info("[clinic] update result", { status, error, data });
  if (error) throw new Error(error.message || "تعذّر حفظ بيانات العيادة");
  if (!data) throw new Error("لم يتم تحديث أي صف — تحقق من صلاحيات الحفظ");

  const authoritative = { ...DEFAULT_CLINIC, ...data };
  window.CLINIC = authoritative;
  window.dispatchEvent(new CustomEvent("kinetic:clinic-updated", { detail: authoritative }));
  return authoritative;
}

// ── Custom sections: load / save / add / remove / update ──────
async function loadSections() {
  if (sb) {
    const { data, error } = await sb.from("custom_sections").select("*").order("position", { ascending: true });
    if (!error && Array.isArray(data)) {
      window.CUSTOM_SECTIONS = data;
      writeLS(LS_SECTIONS, data);
      return data;
    }
  }
  const cached = readLS(LS_SECTIONS, DEFAULT_SECTIONS);
  window.CUSTOM_SECTIONS = cached;
  return cached;
}

function nextSectionId() {
  return "sec_" + Math.random().toString(36).slice(2, 9);
}

async function addSection(section) {
  const list = window.CUSTOM_SECTIONS || [];
  // Slug collision guard: schema enforces UNIQUE on custom_sections.slug.
  const baseSlug = (section.slug || section.label || "")
    .toString().trim().toLowerCase()
    .replace(/\s+/g, "-").replace(/[^a-z0-9\-_\u0600-\u06FF]/g, "") || "section";
  const existing = new Set(list.map(s => s.slug));
  let slug = baseSlug, n = 2;
  while (existing.has(slug)) { slug = `${baseSlug}-${n++}`; }
  const item = {
    id: section.id || nextSectionId(),
    slug,
    label: section.label || "قسم جديد",
    icon: section.icon || "Layers",
    group: section.group || "مخصص",
    description: section.description || "",
    content: section.content || "",
    position: section.position ?? list.length,
    visible: section.visible !== false,
    created_at: new Date().toISOString(),
  };
  const next = [...list, item];
  window.CUSTOM_SECTIONS = next;
  writeLS(LS_SECTIONS, next);
  if (sb) {
    const { error } = await sb.from("custom_sections").insert(item);
    if (error) console.warn("addSection insert failed", error);
  }
  window.dispatchEvent(new CustomEvent("kinetic:sections-updated", { detail: next }));
  return item;
}

async function updateSection(id, patch) {
  const list = window.CUSTOM_SECTIONS || [];
  const next = list.map(s => s.id === id ? { ...s, ...patch, updated_at: new Date().toISOString() } : s);
  window.CUSTOM_SECTIONS = next;
  writeLS(LS_SECTIONS, next);
  if (sb) await sb.from("custom_sections").update(patch).eq("id", id);
  window.dispatchEvent(new CustomEvent("kinetic:sections-updated", { detail: next }));
}

async function removeSection(id) {
  const list = window.CUSTOM_SECTIONS || [];
  const next = list.filter(s => s.id !== id);
  window.CUSTOM_SECTIONS = next;
  writeLS(LS_SECTIONS, next);
  if (sb) await sb.from("custom_sections").delete().eq("id", id);
  window.dispatchEvent(new CustomEvent("kinetic:sections-updated", { detail: next }));
}

// ── Branches (multi-branch support) ───────────────────────────
// Neutral placeholder until the clinic defines its branches in Settings.
const DEFAULT_BRANCHES = [
  { id: "br_main", name: "الفرع الرئيسي", therapists: 0, rooms: 0, address: "", phone: "" },
];

function nextBranchId() {
  return "br_" + Math.random().toString(36).slice(2, 9);
}

async function loadBranches() {
  if (sb) {
    const { data, error } = await sb.from("branches").select("*").order("created_at", { ascending: true });
    if (!error && Array.isArray(data) && data.length) {
      window.BRANCHES = data;
      writeLS(LS_BRANCHES, data);
      window.dispatchEvent(new CustomEvent("kinetic:branches-updated", { detail: data }));
      return data;
    }
    if (error) console.warn("loadBranches failed", error.message || error);
  }
  const cached = readLS(LS_BRANCHES, DEFAULT_BRANCHES);
  window.BRANCHES = cached;
  return cached;
}

async function addBranch(branch) {
  const list = window.BRANCHES || [];
  const item = {
    id: branch.id || nextBranchId(),
    name: (branch.name || "فرع جديد").trim(),
    therapists: Number(branch.therapists) || 0,
    rooms: Number(branch.rooms) || 0,
    address: branch.address || "",
    phone: branch.phone || "",
    created_at: new Date().toISOString(),
  };
  const next = [...list, item];
  window.BRANCHES = next;
  writeLS(LS_BRANCHES, next);
  if (sb) {
    const { error } = await sb.from("branches").insert(item);
    if (error) console.warn("addBranch insert failed", error.message || error);
  }
  window.dispatchEvent(new CustomEvent("kinetic:branches-updated", { detail: next }));
  return item;
}

async function updateBranch(id, patch) {
  const list = window.BRANCHES || [];
  const cleanPatch = { ...patch, updated_at: new Date().toISOString() };
  if (cleanPatch.therapists !== undefined) cleanPatch.therapists = Number(cleanPatch.therapists) || 0;
  if (cleanPatch.rooms !== undefined) cleanPatch.rooms = Number(cleanPatch.rooms) || 0;
  if (typeof cleanPatch.name === "string") cleanPatch.name = cleanPatch.name.trim();
  const next = list.map(b => b.id === id ? { ...b, ...cleanPatch } : b);
  window.BRANCHES = next;
  writeLS(LS_BRANCHES, next);
  if (sb) {
    const { error } = await sb.from("branches").update(cleanPatch).eq("id", id);
    if (error) console.warn("updateBranch failed", error.message || error);
  }
  window.dispatchEvent(new CustomEvent("kinetic:branches-updated", { detail: next }));
  return next.find(b => b.id === id);
}

function setActiveBranch(id) {
  const list = window.BRANCHES || [];
  if (!list.some(b => b.id === id)) return;
  window.ACTIVE_BRANCH_ID = id;
  writeLS(LS_ACTIVE_BRANCH, id);
  window.dispatchEvent(new CustomEvent("kinetic:branches-updated", { detail: { activeId: id } }));
}

async function removeBranch(id) {
  const list = window.BRANCHES || [];
  if (list.length <= 1) return; // never allow removing the last branch
  const next = list.filter(b => b.id !== id);
  window.BRANCHES = next;
  writeLS(LS_BRANCHES, next);
  if (window.ACTIVE_BRANCH_ID === id) {
    window.ACTIVE_BRANCH_ID = next[0].id;
    writeLS(LS_ACTIVE_BRANCH, next[0].id);
  }
  if (sb) {
    const { error } = await sb.from("branches").delete().eq("id", id);
    if (error) console.warn("removeBranch failed", error.message || error);
  }
  window.dispatchEvent(new CustomEvent("kinetic:branches-updated", { detail: next }));
}

// ── Kick off initial hydration (fire-and-forget, but log failures) ─
// Clinic branding is DB-only — do NOT seed from localStorage. A stale LS
// value was the reason the Settings page appeared to save then revert
// on refresh. The first paint may render placeholders for one frame;
// loadClinic() below fires the `kinetic:clinic-updated` event which
// causes Sidebar / login / PDF header to re-render with the DB values.
window.CLINIC = { ...DEFAULT_CLINIC };
try { localStorage.removeItem(LS_CLINIC); } catch (_) {}
window.CUSTOM_SECTIONS = readLS(LS_SECTIONS, DEFAULT_SECTIONS);
window.BRANCHES = readLS(LS_BRANCHES, DEFAULT_BRANCHES);
window.ACTIVE_BRANCH_ID = readLS(LS_ACTIVE_BRANCH, window.BRANCHES[0]?.id || null);
loadClinic().catch(e => console.warn("loadClinic failed", e));
loadSections().catch(e => console.warn("loadSections failed", e));
loadBranches().catch(e => console.warn("loadBranches failed", e));

// ══════════════════════════════════════════════════════════════
// Supabase Auth wrappers (PRD 4.3)
// ══════════════════════════════════════════════════════════════
async function signInEmail(email, password) {
  if (!sb) return { ok: false, error: "supabase-not-configured" };
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) return { ok: false, error: error.message };
  let role = null, staffRow = null;
  const uid = data.user && data.user.id;
  const meta = (data.user && data.user.user_metadata) || {};
  if (uid) {
    const q = await sb.from("staff").select("*").eq("auth_uid", uid).maybeSingle();
    if (!q.error && q.data) { staffRow = q.data; role = q.data.role || null; }
  }
  // A deactivated account must never establish a session. Sign the just-
  // created session back out and report a clear reason — the RLS layer
  // (app_role() → NULL for inactive) is the server-side backstop, this is
  // the friendly front door.
  if (staffRow && String(staffRow.status || "active") !== "active") {
    try { await sb.auth.signOut({ scope: "local" }); } catch {}
    return { ok: false, reason: "account-inactive",
             error: "هذا الحساب معطّل. تواصل مع مدير النظام لإعادة تفعيله." };
  }
  // The staff table in PostgreSQL is authoritative (it's what RLS's
  // app_role() reads); user_metadata is only a display fallback for
  // accounts whose staff row hasn't been provisioned yet.
  role = role || meta.role || null;
  return { ok: true, session: data.session, user: data.user, role, staff: staffRow };
}

async function signOut() {
  if (sb) await sb.auth.signOut();
  // Clear identity + any cached role-scoped domain data so the next login
  // doesn't see the previous session's patients/appts/etc.
  window.ME = null;
  try {
    for (const cfg of Object.values(DATA_TABLES)) {
      localStorage.removeItem(cfg.ls);
      if (window.DATA) window.DATA[friendlyName(cfg.key)] = [];
    }
  } catch (e) { console.warn("signOut cache clear failed", e); }
  window.dispatchEvent(new CustomEvent("kinetic:data-updated", { detail: { table: "*" } }));
}

async function getSession() {
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  return data.session || null;
}

// ── Verified staff identity (server-side truth) ───────────────
// Single source of truth for permission checks: the session comes from
// Supabase Auth (revalidated server-side via getUser) and the role is
// read from the `staff` table in PostgreSQL by auth_uid. NEVER derived
// from localStorage, sessionStorage, or frontend state — those are
// forgeable and are UI hints only. Mirrors public.app_role() in RLS.
// Returns:
//   { ok:true,  session, user, role, staff }
//   { ok:false, reason:'no-database'|'no-session'|'invalid-session'
//              |'staff-lookup-failed'|'no-staff-role'|'role-not-staff',
//     error, role? }
const STAFF_ROLES = ["admin", "receptionist", "doctor", "therapist"];
async function getAuthStaff() {
  if (!sb) return { ok: false, reason: "no-database", error: "لم يتم تكوين قاعدة البيانات" };

  let session = null;
  try {
    const { data, error } = await sb.auth.getSession();
    if (error) throw error;
    session = data && data.session;
  } catch (e) {
    return { ok: false, reason: "no-session", error: e.message || String(e) };
  }
  if (!session || !session.user) {
    return { ok: false, reason: "no-session", error: "لا توجد جلسة مسجّلة" };
  }

  // Revalidate against the Auth server — a locally cached but revoked or
  // tampered session must not pass.
  let user = null;
  try {
    const { data, error } = await sb.auth.getUser();
    if (error || !data || !data.user) {
      return { ok: false, reason: "invalid-session", error: (error && error.message) || "الجلسة غير صالحة" };
    }
    user = data.user;
  } catch (e) {
    return { ok: false, reason: "invalid-session", error: e.message || String(e) };
  }

  // Role from PostgreSQL — the same row RLS's app_role() reads. The self
  // read policy (auth_uid = auth.uid()) still returns the row for an
  // inactive account, so we can distinguish "disabled" from "no record".
  const q = await sb.from("staff").select("staff_id,name,role,email,status").eq("auth_uid", user.id).maybeSingle();
  if (q.error) {
    return { ok: false, reason: "staff-lookup-failed", session, user,
             error: q.error.message || "تعذّرت قراءة سجل الموظف" };
  }
  if (!q.data || !q.data.role) {
    return { ok: false, reason: "no-staff-role", session, user,
             error: "لا يوجد سجل موظف مرتبط بهذا الحساب في قاعدة البيانات" };
  }
  // Deactivated accounts lose access even with a still-valid token.
  if (String(q.data.status || "active") !== "active") {
    return { ok: false, reason: "account-inactive", session, user, staff: q.data,
             error: "هذا الحساب معطّل. تواصل مع مدير النظام لإعادة تفعيله." };
  }
  const role = String(q.data.role).trim();
  if (!STAFF_ROLES.includes(role)) {
    return { ok: false, reason: "role-not-staff", session, user, role, staff: q.data,
             error: `الدور «${role}» ليس دور موظف` };
  }
  return { ok: true, session, user, role, staff: q.data };
}

// ── Admin user management (PRD 4.3) ───────────────────────────
// A static client holds only the anon key, so it cannot use the
// service-role admin API (force-set another user's password, delete an
// auth user). What IS possible with the anon key, and what these do:
//   • adminCreateUser  → signUp on a SECONDARY client so the admin's own
//     session is never replaced. Role goes into user_metadata (what RLS
//     reads) and a linked staff row is written.
//   • sendPasswordReset → emails a reset link to any address.
//   • updateOwnPassword / updateOwnProfile → change the CURRENT user's
//     own credentials/profile via the live session.
const ROLE_SLUGS = ["admin", "receptionist", "doctor", "therapist"];
function nextStaffId() {
  return "U-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Map machine error codes from the Edge Function (or raw GoTrue text)
// onto friendly Arabic messages. Never expose the raw Supabase error to
// the toast.
function __friendlyAuthError(code, fallback) {
  const table = {
    email_exists:        "هذا البريد مستخدم بالفعل — إن كان من محاولة سابقة فاشلة احذف المستخدم من Supabase → Authentication → Users ثم أعد المحاولة",
    weak_password:       "كلمة المرور ضعيفة — 6 أحرف على الأقل، ويفضّل مزيج أرقام وحروف",
    invalid_email:       "بريد إلكتروني غير صحيح",
    invalid_role:        "الدور المحدد غير صالح",
    missing_name:        "أدخل الاسم الكامل",
    forbidden:           "لا تملك صلاحية إنشاء المستخدمين — تحتاج دور «مدير»",
    missing_token:       "انتهت الجلسة — سجّل الدخول من جديد",
    invalid_token:       "انتهت الجلسة — سجّل الدخول من جديد",
    rate_limited:        "تم تجاوز حد إنشاء الحسابات المؤقت — جرّب بعد ساعة، أو فعّل خدمة إنشاء الحسابات غير المحدودة (انظر deploy-edge-function.sh)",
    server_misconfigured:"إعدادات الخادم غير مكتملة — تواصل مع الدعم",
    staff_insert_failed: "تم إنشاء الحساب لكن فشل حفظه في جدول الموظفين",
    method_not_allowed:  "طلب غير صالح",
  };
  if (code && table[code]) return table[code];
  // Common raw GoTrue error phrases.
  const t = String(fallback || "").toLowerCase();
  if (t.includes("rate limit"))       return table.rate_limited;
  if (t.includes("already registered")|| t.includes("duplicate")) return table.email_exists;
  if (t.includes("password"))         return table.weak_password;
  if (t.includes("invalid email"))    return table.invalid_email;
  return fallback || "تعذّر إنشاء الحساب";
}

async function adminCreateUser({ email, password, name, role, phone }) {
  email = (email || "").trim().toLowerCase();
  const roleSlug = ROLE_SLUGS.includes(role) ? role : "receptionist";
  const displayName = (name || "").trim() || email.split("@")[0];
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: __friendlyAuthError("invalid_email") };
  if (!password || password.length < 6)          return { ok: false, error: __friendlyAuthError("weak_password") };

  // Demo / offline: create a local staff row only (no auth backend).
  if (!sb) {
    const staffId = nextStaffId();
    await upsertRow("staff", {
      staff_id: staffId, name: displayName, email, role: roleSlug,
      phone: phone || null, auth_uid: null, status: "active",
      created_at: new Date().toISOString(),
    });
    return { ok: true, demo: true };
  }

  // ── Preferred path: Edge Function using service_role. ──
  // This is the ONLY path that avoids the anon signUp email rate limit
  // and creates the account already email-confirmed. If the function
  // isn't deployed we fall through to the legacy signUp below.
  try {
    const { data, error } = await sb.functions.invoke("admin-create-user", {
      body: { email, password, name: displayName, role: roleSlug, phone: phone || null },
    });
    if (!error && data && data.ok) {
      window.dispatchEvent(new CustomEvent("kinetic:data-updated", { detail: { table: "staff" } }));
      return { ok: true, uid: data.uid };
    }
    // If the function returned a structured failure, surface it verbatim.
    if (data && data.ok === false) {
      return { ok: false, error: __friendlyAuthError(data.error, data.detail) };
    }
    // A deployed function that answered 4xx/5xx surfaces as
    // FunctionsHttpError with `data` undefined — its JSON body (our
    // { ok:false, error, detail }) is only reachable via error.context.
    // Read it so real failures (forbidden / email_exists / …) are shown
    // instead of tripping the signUp fallback.
    if (error && error.name === "FunctionsHttpError" && error.context && error.context.json) {
      try {
        const body = await error.context.json();
        if (body && body.error) return { ok: false, error: __friendlyAuthError(body.error, body.detail) };
      } catch { /* non-JSON response — fall through to detection below */ }
    }
    // Only "function unreachable / not deployed" should trip the
    // fallback — every other error is authoritative. supabase-js reports
    // an undeployed function as FunctionsFetchError with the message
    // "Failed to send a request to the Edge Function", so check the
    // error NAME as well as the message.
    const msg = (String((error && error.message) || "") + " " +
                 String((error && error.name) || "")).toLowerCase();
    const missing = msg.includes("not found") || msg.includes("failed to fetch") ||
                    msg.includes("failed to send") || msg.includes("functionsfetch") ||
                    msg.includes("functionsrelay") || msg.includes("not deployed");
    if (!missing) return { ok: false, error: __friendlyAuthError(null, error && error.message) };
    console.info("admin-create-user edge function not reachable — falling back to signUp", msg);
  } catch (e) {
    console.info("edge function unavailable, using signUp fallback", e);
  }

  // ── Fallback path: anon signUp on a secondary client. ──
  // This is what the codebase used before the edge function existed.
  // Downsides that the operator must accept when using this path:
  //   1. Supabase project MUST have "Confirm email" OFF, or the user
  //      won't be able to log in until they click the email link.
  //   2. Subject to GoTrue rate limits (a handful of signups per hour
  //      per SMTP config) — that's what caused the earlier "email rate
  //      limit exceeded" errors.
  if (!window.supabase || !window.supabase.createClient) return { ok: false, error: "Supabase غير محمّل" };

  let uid = null, needsConfirm = false;
  try {
    const tmp = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, storageKey: "kinetic-provision" },
    });
    const { data, error } = await tmp.auth.signUp({
      email, password,
      options: { data: { role: roleSlug, name: displayName } },
    });
    if (error) return { ok: false, error: __friendlyAuthError(null, error.message) };
    uid = (data.user && data.user.id) || null;
    needsConfirm = !data.session;
    try { await tmp.auth.signOut({ scope: "local" }); } catch {}
  } catch (e) {
    return { ok: false, error: __friendlyAuthError(null, e.message || String(e)) };
  }

  // The staff row is what public.app_role() reads — without it the new
  // account can log in but has NO permissions. Surface a failed insert
  // loudly instead of pretending the account is ready.
  const staffId = nextStaffId();
  const staffRes = await upsertRow("staff", {
    staff_id: staffId, name: displayName, email, role: roleSlug,
    phone: phone || null, auth_uid: uid, status: "active",
    created_by: (window.ME && window.ME.id) || null,
    created_at: new Date().toISOString(),
  });
  if (!staffRes || staffRes._ok === false) {
    return {
      ok: false, uid, needsConfirm,
      error: __friendlyAuthError("staff_insert_failed", staffRes && staffRes._error) +
             (staffRes && staffRes._error ? ` — ${staffRes._error}` : ""),
    };
  }
  window.dispatchEvent(new CustomEvent("kinetic:data-updated", { detail: { table: "staff" } }));
  return { ok: true, needsConfirm, uid };
}

async function sendPasswordReset(email) {
  email = (email || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "بريد إلكتروني غير صحيح" };
  if (!sb) return { ok: true, demo: true };
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

async function updateOwnPassword(newPassword) {
  if (!newPassword || newPassword.length < 6) return { ok: false, error: "كلمة المرور 6 أحرف على الأقل" };
  if (!sb) return { ok: true, demo: true };
  const { error } = await sb.auth.updateUser({ password: newPassword });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

async function updateOwnProfile({ name }) {
  const displayName = (name || "").trim();
  if (!displayName) return { ok: false, error: "أدخل الاسم" };
  if (sb) {
    const { error } = await sb.auth.updateUser({ data: { name: displayName } });
    if (error) return { ok: false, error: error.message };
  }
  // Mirror onto the staff row + live identity so the UI updates immediately.
  const me = window.ME || {};
  if (me.email) {
    try {
      const rows = await listTable("staff");
      const match = (rows || []).find(r => r.email === me.email);
      if (match) await upsertRow("staff", { ...match, name: displayName });
    } catch (e) { console.warn("updateOwnProfile staff sync failed", e); }
  }
  if (window.ME) window.ME.name = displayName;
  return { ok: true };
}

// Update a teammate's staff row (name/role). Note: this changes the app's
// fallback role + display name, but a user's EFFECTIVE login permissions
// come from their auth user_metadata.role, which only they (or a
// service-role admin) can change — surfaced as a hint in the UI.
async function updateStaffMember(staffId, patch) {
  try {
    const rows = await listTable("staff");
    const match = (rows || []).find(r => (r.staff_id || r.id) === staffId);
    if (!match) return { ok: false, error: "المستخدم غير موجود" };
    await upsertRow("staff", { ...match, ...patch });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message || String(e) }; }
}

// Read an Edge Function's structured JSON error body regardless of whether
// supabase-js surfaced it as `data` (2xx) or wrapped it in a
// FunctionsHttpError (4xx/5xx). Returns { error, detail } or null.
async function __edgeErrorBody(data, error) {
  if (data && data.ok === false) return { error: data.error, detail: data.detail };
  if (error && error.context && typeof error.context.json === "function") {
    try { const b = await error.context.json(); if (b && b.error) return b; } catch {}
  }
  return null;
}

const __ADMIN_ACTION_ERRORS = {
  forbidden:             "لا تملك صلاحية هذا الإجراء — يتطلب دور «مدير»",
  missing_token:         "انتهت الجلسة — سجّل الدخول من جديد",
  invalid_token:         "انتهت الجلسة — سجّل الدخول من جديد",
  weak_password:         "كلمة المرور ضعيفة — 6 أحرف على الأقل",
  missing_target:        "لم يتم تحديد الموظف",
  staff_not_found:       "الموظف غير موجود",
  no_auth_account:       "لا يوجد حساب دخول مرتبط بهذا الموظف",
  cannot_deactivate_self:"لا يمكنك تعطيل حسابك الخاص",
  server_misconfigured:  "إعدادات الخادم غير مكتملة — تواصل مع الدعم",
  update_failed:         "تعذّر تنفيذ العملية",
  lookup_failed:         "تعذّرت قراءة سجل الموظف",
};
function __adminActionError(code, fallback) {
  return (code && __ADMIN_ACTION_ERRORS[code]) || fallback || "تعذّر تنفيذ العملية";
}

// Admin: force-set another staff member's password (no current password
// needed). Runs through the admin-reset-password Edge Function which uses
// the Auth Admin API + service role — the browser anon key cannot do this.
// Password hashes are NEVER read or returned. Admin-only (enforced server
// side, re-checked here as a UX guard).
async function adminResetPassword({ staff_id, auth_uid, password }) {
  if (!password || password.length < 6)
    return { ok: false, error: __adminActionError("weak_password") };
  if (!staff_id && !auth_uid)
    return { ok: false, error: __adminActionError("missing_target") };
  if (!sb) return { ok: true, demo: true };
  try {
    const { data, error } = await sb.functions.invoke("admin-reset-password", {
      body: { staff_id, auth_uid, password },
    });
    if (!error && data && data.ok) return { ok: true, staff_id: data.staff_id };
    const eb = await __edgeErrorBody(data, error);
    if (eb) return { ok: false, error: __adminActionError(eb.error, eb.detail) };
    return { ok: false, error: "خدمة إعادة تعيين كلمة المرور غير منشورة — انشر admin-reset-password (انظر deploy-edge-function.sh)" };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

// Admin: activate / deactivate a staff account. Deactivation blocks sign
// in, revokes data access via RLS (app_role() → null), and bans token
// refresh — all server side through the admin-set-status Edge Function.
// Historical data is untouched.
async function adminSetStaffStatus({ staff_id, active }) {
  if (!staff_id) return { ok: false, error: __adminActionError("missing_target") };
  const newStatus = active ? "active" : "inactive";
  // Reflect the change in the in-memory mirror so the Staff Management
  // table updates immediately (the data-updated event only re-renders; it
  // does not re-fetch). The DB is already authoritative via the Edge
  // Function / upsert below.
  const syncMemory = () => {
    if (window.DATA && Array.isArray(window.DATA.staff)) {
      window.DATA.staff = window.DATA.staff.map(r =>
        ((r.staff_id || r.id) === staff_id) ? { ...r, status: newStatus } : r);
    }
    window.dispatchEvent(new CustomEvent("kinetic:data-updated", { detail: { table: "staff" } }));
  };
  // Demo / offline: just flip the local row.
  if (!sb) {
    await updateStaffMember(staff_id, { status: newStatus });
    syncMemory();
    return { ok: true, demo: true, status: newStatus };
  }
  try {
    const { data, error } = await sb.functions.invoke("admin-set-status", {
      body: { staff_id, active: !!active },
    });
    if (!error && data && data.ok) {
      syncMemory();
      return { ok: true, status: data.status };
    }
    const eb = await __edgeErrorBody(data, error);
    if (eb) return { ok: false, error: __adminActionError(eb.error, eb.detail) };
    return { ok: false, error: "خدمة تغيير حالة الحساب غير منشورة — انشر admin-set-status (انظر deploy-edge-function.sh)" };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

function onAuthChange(cb) {
  if (!sb) return () => {};
  const sub = sb.auth.onAuthStateChange((_evt, session) => {
    try { window.__authSession = session || null; } catch {}
    cb(session);
  });
  // Prime the cache with the current session so window.__authSession is
  // available before the first onAuthStateChange fires.
  sb.auth.getSession().then(({ data }) => {
    try { window.__authSession = (data && data.session) || null; } catch {}
  }).catch(() => {});
  return () => sub.data.subscription.unsubscribe();
}

// ══════════════════════════════════════════════════════════════
// Voice dictation (PRD 9.3) — single shared helper
// Usage: const stop = startDictation({ onText, lang, onEnd })
// Call stop() to abort mid-recognition (e.g. component unmount).
// ══════════════════════════════════════════════════════════════
function startDictation(opts) {
  const { onText, lang = "ar-EG", onEnd } = opts || {};
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    if (window.showToast) window.showToast("المتصفح لا يدعم الإملاء الصوتي", "error");
    return () => {};
  }
  const r = new SR();
  r.lang = lang;
  r.continuous = false;
  r.interimResults = false;
  let aborted = false;
  r.onresult = (e) => {
    try { onText && onText(e.results[0][0].transcript); }
    catch (err) { console.warn("dictation onText failed", err); }
  };
  r.onerror = (e) => {
    if (!aborted && window.showToast) window.showToast("خطأ في الإملاء الصوتي", "error");
    console.warn("dictation error", e && e.error);
  };
  r.onend = () => { onEnd && onEnd(); };
  try { r.start(); }
  catch (e) { console.warn("dictation start failed", e); return () => {}; }
  if (window.showToast) window.showToast("الإملاء الصوتي نشط…", "success");
  return () => { aborted = true; try { r.abort(); } catch {} };
}

// ══════════════════════════════════════════════════════════════
// Print / PDF helper (PRD 5.11)
// Opens a print window with brand chrome; user picks "Save as PDF"
// ══════════════════════════════════════════════════════════════
// title is treated as UNTRUSTED text (escaped). bodyHtml is treated as
// pre-sanitized HTML — callers MUST escape any user-controlled substrings.
function printHTML(title, bodyHtml) {
  const w = window.open("", "_blank", "width=900,height=1000");
  if (!w) { if (window.showToast) window.showToast("متصفح النافذة المنبثقة محجوب", "error"); return; }
  // Brand name comes from the DB singleton — never a hardcoded fallback.
  // Empty string keeps the PDF header sane if the clinic hasn't set a
  // name yet, without leaking the placeholder into the export.
  const brand = escHtml((window.CLINIC && window.CLINIC.name) || "");
  const safeTitle = escHtml(title);
  w.document.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"/>
    <title>${safeTitle}</title>
    <style>
      body{font-family:'IBM Plex Sans Arabic', system-ui, sans-serif; color:#0F1E2B; padding:32px; background:#fff}
      h1{font-size:20px;margin:0 0 4px}
      .sub{color:#647686;font-size:12px;margin-bottom:24px}
      table{width:100%;border-collapse:collapse;font-size:12.5px}
      th,td{border-bottom:1px solid #EEF2F6;padding:8px 10px;text-align:right}
      th{background:#F7F9FB;font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:.04em;color:#647686}
      @media print { .no-print{display:none} body{padding:12px} }
    </style></head><body>
    <h1>${brand} — ${safeTitle}</h1>
    <div class="sub">${escHtml(new Date().toLocaleString("ar-EG"))}</div>
    ${bodyHtml || ""}
    <div class="no-print" style="margin-top:24px"><button onclick="window.print()">طباعة / حفظ PDF</button></div>
    </body></html>`);
  w.document.close();
  // Wait for load rather than fixed 250ms; falls back to timeout for older browsers.
  const doPrint = () => { try { w.focus(); w.print(); } catch (e) { console.warn("print failed", e); } };
  if (w.document.readyState === "complete") doPrint();
  else {
    w.addEventListener("load", doPrint, { once: true });
    setTimeout(doPrint, 800);
  }
}

// ══════════════════════════════════════════════════════════════
// Domain data API (PRD Section 6)
// Same LS-fallback pattern used for clinic branding. Each table
// mirrors to `window.DATA[key]` so existing UI keeps working.
// ══════════════════════════════════════════════════════════════
// The client uses friendly names ("appts", "payments") while the DB uses
// canonical names ("bookings", "invoices"). Seeds use `id` as a legacy PK;
// we translate to the real PK column on every read/write so LS and DB stay
// in sync and Supabase never sees a stray `id` column.
// `cols` whitelists which columns to actually send to Supabase — anything
// else in the row is UI-only seed metadata (patient name, doctor, room…)
// that would trip PGRST204 on the strict schema.
const DATA_TABLES = {
  patients:   { key: "patients",   pk: "patient_id",  ls: "kinetic.patients",
                cols: ["patient_id","name","phone","age","gender","diagnosis","notes","therapist_id","created_at",
                       "medical_file_no","national_id","whatsapp","email","date_of_birth","address","occupation",
                       "emergency_name","emergency_phone","doctor_id","medical_history","allergies","medications",
                       "insurance_info","status","updated_at"] },
  appts:      { key: "bookings",   pk: "booking_id",  ls: "kinetic.bookings",
                cols: ["booking_id","patient_id","therapist_id","doctor_id","department_id","date","time","status","notes","created_at"] },
  schedules:  { key: "patient_schedules", pk: "schedule_id", ls: "kinetic.patient_schedules",
                cols: ["schedule_id","patient_id","therapist_id","days","time","sessions_per_week",
                       "allow_consecutive","active","notes","created_at","updated_at"] },
  sessions:   { key: "sessions",   pk: "session_id",  ls: "kinetic.sessions",
                cols: ["session_id","patient_id","therapist_id","treatment_id","booking_id","date","pain_score",
                       "mood","duration_minutes","goals","completed_exercises","session_notes","session_number",
                       "status","started_at","created_at"] },
  payments:   { key: "invoices",   pk: "invoice_id",  ls: "kinetic.invoices",
                cols: ["invoice_id","patient_id","amount","paid","payment_method","status","created_at"] },
  paymentHistory: { key: "payments", pk: "payment_id", ls: "kinetic.payment_history",
                cols: ["payment_id","patient_id","cashier_id","cashier_name","amount","method",
                       "reference","transaction_id","notes","receipt_no","allocations",
                       "ip_address","status","created_at"] },
  subscriptions: { key: "patient_subscriptions", pk: "subscription_id", ls: "kinetic.subscriptions",
                cols: ["subscription_id","patient_id","package_id","package_name",
                       "total_sessions","used_sessions","price","paid","status",
                       "expires_at","created_at","updated_at"] },
  staff:      { key: "staff",      pk: "staff_id",    ls: "kinetic.staff",
                cols: ["staff_id","name","role","phone","email","auth_uid","status","created_by","created_at"] },
  therapists: { key: "therapists", pk: "id",          ls: "kinetic.therapists",
                cols: ["id","name","spec","load","max","color","department_id","phone","email",
                       "license_number","notes","active","auth_uid","created_at","updated_at"] },
  departments:{ key: "departments",pk: "id",          ls: "kinetic.departments",
                cols: ["id","name_ar","name_en","description","icon","color","sort_order","active"] },
  doctors:    { key: "doctors",    pk: "id",          ls: "kinetic.doctors",
                cols: ["id","name","department_id","specialization","experience_years","photo","schedule",
                       "status","color","active","phone","email","license_number","notes","auth_uid",
                       "created_at","updated_at"] },
  receptionists: { key: "receptionists", pk: "id",    ls: "kinetic.receptionists",
                cols: ["id","name","phone","email","notes","active","auth_uid","created_at","updated_at"] },
  packages:   { key: "packages",   pk: "id",          ls: "kinetic.packages",
                cols: ["id","name","sessions","price","active","popular","color","sold"] },
  campaigns:  { key: "campaigns",  pk: "id",          ls: "kinetic.campaigns",
                cols: ["id","name","audience","sent","read","replied","status","template","schedule","best"] },
  treatmentMethods: { key: "treatment_methods", pk: "method_id", ls: "kinetic.tx_methods",
                cols: ["method_id","name","category","description","duration_minutes","notes",
                       "status","created_by","created_by_name","created_at","updated_at"] },
};

// Map a DATA_TABLES key back to its window.DATA.* alias. Two friendly names
// diverge from the DB name (bookings→appts, invoices→payments); everything
// else matches. Used by signOut cache clear.
function friendlyName(key) {
  if (key === "bookings") return "appts";
  if (key === "patient_schedules") return "schedules";
  if (key === "invoices") return "payments";
  if (key === "payments") return "paymentHistory";
  if (key === "patient_subscriptions") return "subscriptions";
  if (key === "treatment_methods") return "treatmentMethods";
  return key;
}

// Legacy alias: some seeds use `id` instead of the real PK. Read PK from
// either, prefer the real one.
function pkOf(cfg, row) {
  return row[cfg.pk] != null ? row[cfg.pk] : row.id;
}

async function listTable(name) {
  const cfg = DATA_TABLES[name];
  if (!cfg) return [];
  if (sb) {
    const { data, error } = await sb.from(cfg.key).select("*");
    // On success (no error), trust the server — even if the response is [].
    // That way a deleted row on the server actually clears the LS cache.
    if (!error && Array.isArray(data)) {
      writeLS(cfg.ls, data);
      return data;
    }
    if (error) console.warn(`listTable ${name} failed`, error.message || error);
  }
  return readLS(cfg.ls, (window.DATA && window.DATA[name]) || []);
}

async function upsertRow(name, row) {
  const cfg = DATA_TABLES[name];
  if (!cfg) throw new Error("unknown table: " + name);
  const list = (window.DATA && window.DATA[name]) || readLS(cfg.ls, []);

  // Normalize: ensure the row carries both the real PK and the legacy `id`
  // (some UI code still filters/matches on `id`).
  const pk = pkOf(cfg, row);
  const normalized = { ...row };
  if (pk != null) { normalized[cfg.pk] = pk; normalized.id = pk; }

  const idx = list.findIndex(r => pkOf(cfg, r) === pk);
  const next = idx === -1
    ? [...list, normalized]
    : list.map((r, i) => i === idx ? { ...r, ...normalized } : r);
  if (window.DATA) window.DATA[name] = next;
  writeLS(cfg.ls, next);

  let __ok = true, __error = null;
  if (sb) {
    // Only send columns the DB knows about.
    const dbRow = {};
    for (const c of cfg.cols) {
      if (normalized[c] !== undefined) dbRow[c] = normalized[c];
    }
    if (dbRow[cfg.pk] == null) {
      __ok = false; __error = `missing PK ${cfg.pk}`;
      console.warn(`upsertRow ${name}: missing PK ${cfg.pk}`, row);
    } else {
      const { error } = await sb.from(cfg.key).upsert(dbRow, { onConflict: cfg.pk });
      if (error) {
        __ok = false;
        // Keep the FULL PostgreSQL error (code + message + details + hint)
        // so callers can show exactly why the write was rejected — e.g.
        // 42501 is an RLS policy violation.
        __error = [error.code, error.message, error.details, error.hint]
          .filter(Boolean).join(" · ") || String(error);
        console.warn(`upsertRow ${name} failed`, { table: cfg.key, op: "UPSERT (INSERT ON CONFLICT UPDATE)", error });
      }
    }
  } else {
    __ok = false;
    __error = "no database connection";
  }
  // Attach ok/error so callers who care (import, forms) can react;
  // fire-and-forget callers keep working unchanged.
  normalized._ok = __ok;
  normalized._error = __error;
  // Rows written schema-shaped (e.g. bulk import) need the UI aliases too.
  if (window.normalizeDomainData && window.DATA) window.normalizeDomainData(window.DATA);
  window.dispatchEvent(new CustomEvent("kinetic:data-updated", { detail: { table: name } }));
  return normalized;
}

async function removeRow(name, id) {
  const cfg = DATA_TABLES[name];
  if (!cfg) throw new Error("unknown table: " + name);
  const list = (window.DATA && window.DATA[name]) || readLS(cfg.ls, []);

  // Delete on the SERVER first — the database is the source of truth. If the
  // server rejects the delete (RLS 42501, FK 23503, missing row, network…)
  // we must NOT drop the row locally, or the UI would falsely show success
  // while the record still exists. Surface the full PostgreSQL error instead.
  if (sb) {
    const { error } = await sb.from(cfg.key).delete().eq(cfg.pk, id);
    if (error) {
      console.warn(`removeRow ${name} failed`, { table: cfg.key, error });
      throw new Error(
        [error.code, error.message, error.details, error.hint].filter(Boolean).join(" · ")
        || "تعذّر الحذف"
      );
    }
  } else {
    throw new Error("لا يوجد اتصال بقاعدة البيانات");
  }

  // Server delete succeeded — now mirror it into local state + LS cache.
  const next = list.filter(r => pkOf(cfg, r) !== id);
  if (window.DATA) window.DATA[name] = next;
  writeLS(cfg.ls, next);
  window.dispatchEvent(new CustomEvent("kinetic:data-updated", { detail: { table: name } }));
}

// ── Row normalization ─────────────────────────────────────────
// DB rows are schema-shaped (patient_id, pain_score, payment_method…)
// while the UI reads friendly aliases (id, pain, method, patient name…).
// Normalize after hydration so every screen renders real rows unchanged.
const BOOKING_STATUS_AR = { pending:"معلّق", confirmed:"مؤكد", completed:"مكتمل", cancelled:"ملغي", "no-show":"لم يحضر", available:"متاح" };
const INVOICE_STATUS_AR = { paid:"مدفوع", partial:"جزئي", pending:"معلّق", overdue:"متأخر" };

function normalizeDomainData(D) {
  const patients = D.patients || [];
  const nameOfPatient = (pid) => {
    const p = patients.find(x => (x.patient_id ?? x.id) === pid);
    return p ? p.name : "";
  };
  const nameOfTherapist = (tid) => {
    const t = (D.therapists || []).find(x => x.id === tid)
      || (D.staff || []).find(x => x.staff_id === tid);
    return t ? t.name : "";
  };
  const nameOfDoctor = (did) => {
    const d = (D.doctors || []).find(x => x.id === did);
    return d ? d.name : "";
  };
  const nameOfDept = (deid) => {
    const d = (D.departments || []).find(x => x.id === deid);
    return d ? d.name_ar : "";
  };
  D.patients = patients.map(p => ({
    ...p,
    id: p.patient_id ?? p.id,
    diag: p.diag ?? p.diagnosis ?? "",
    status: p.status ?? "نشط",
    registered: p.registered ?? String(p.created_at || "").slice(0, 10),
    chronic: Array.isArray(p.chronic) ? p.chronic : [],
    surgeries: Array.isArray(p.surgeries) ? p.surgeries : [],
    dr: p.dr ?? "—", th: p.th ?? (nameOfTherapist(p.therapist_id) || "—"), job: p.job ?? "—",
    visited: p.visited ?? "—", payment: p.payment ?? "معلّق",
  }));
  D.appts = (D.appts || []).map(a => ({
    ...a,
    id: a.booking_id ?? a.id,
    pid: a.pid ?? a.patient_id ?? null,
    patient: a.patient ?? (nameOfPatient(a.patient_id) || "—"),
    th: a.th ?? nameOfTherapist(a.therapist_id),
    dr: a.dr ?? nameOfDoctor(a.doctor_id),
    dept: a.dept ?? nameOfDept(a.department_id),
    time: a.time ?? "", dur: a.dur ?? 30,
    room: a.room ?? "", type: a.type ?? "",
    status: BOOKING_STATUS_AR[a.status] ?? a.status ?? "معلّق",
  }));
  D.schedules = (D.schedules || []).map(s => ({
    ...s,
    id: s.schedule_id ?? s.id,
    // jsonb may round-trip as a string via LS/older drivers.
    days: Array.isArray(s.days) ? s.days
        : (typeof s.days === "string"
            ? (function(){ try { return JSON.parse(s.days); } catch { return []; } })()
            : []),
  }));
  const jsonArr = (v) => Array.isArray(v) ? v
    : (typeof v === "string"
        ? (function(){ try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } })()
        : []);
  D.sessions = (D.sessions || []).map(s => ({
    ...s,
    id: s.session_id ?? s.id,
    session: s.session ?? s.session_number ?? 0,
    pain: s.pain ?? s.pain_score ?? 0,
    notes: s.notes ?? s.session_notes ?? "",
    mood: s.mood ?? "—",
    date: s.date ?? String(s.created_at || "").slice(0, 10),
    patient: s.patient ?? nameOfPatient(s.patient_id),
    therapist: s.therapist ?? nameOfTherapist(s.therapist_id),
    goals: jsonArr(s.goals),
    done: Array.isArray(s.done) ? s.done : jsonArr(s.completed_exercises),
  }));
  D.payments = (D.payments || []).map(v => ({
    ...v,
    id: v.invoice_id ?? v.id,
    patient: v.patient ?? (nameOfPatient(v.patient_id) || "—"),
    date: v.date ?? String(v.created_at || "").slice(0, 10),
    method: v.method ?? v.payment_method ?? "—",
    amount: Number(v.amount) || 0,
    paid: Number(v.paid) || 0,
    status: INVOICE_STATUS_AR[v.status] ?? v.status ?? "معلّق",
  }));
  D.paymentHistory = (D.paymentHistory || []).map(v => ({
    ...v,
    id: v.payment_id ?? v.id,
    patient: v.patient ?? (nameOfPatient(v.patient_id) || "—"),
    amount: Number(v.amount) || 0,
    date: v.date ?? String(v.created_at || "").slice(0, 10),
    allocations: Array.isArray(v.allocations) ? v.allocations
                : (typeof v.allocations === "string"
                    ? (function(){ try { return JSON.parse(v.allocations); } catch { return []; } })()
                    : []),
  }));
  D.subscriptions = (D.subscriptions || []).map(s => ({
    ...s,
    id: s.subscription_id ?? s.id,
    patient: s.patient ?? (nameOfPatient(s.patient_id) || "—"),
    total_sessions: Number(s.total_sessions) || 0,
    used_sessions: Number(s.used_sessions) || 0,
    price: Number(s.price) || 0,
    paid: Number(s.paid) || 0,
    status: s.status ?? "active",
  }));
  D.treatmentMethods = (D.treatmentMethods || []).map(m => ({
    ...m,
    id: m.method_id ?? m.id,
    name: String(m.name || "").trim(),
    category: m.category ?? "",
    status: m.status ?? "active",
    duration_minutes: m.duration_minutes != null ? Number(m.duration_minutes) : null,
  }));
}
window.normalizeDomainData = normalizeDomainData;

// Hydrate domain tables from Supabase (if configured) into window.DATA
// on boot. Non-blocking: the UI renders first, real data swaps in.
async function hydrateDomainTables() {
  if (!sb) return;
  const fetched = {};
  for (const name of Object.keys(DATA_TABLES)) {
    try {
      const rows = await listTable(name);
      // Trust the database as the single source of truth — an empty table
      // means empty UI, not "keep whatever was in memory before".
      if (Array.isArray(rows)) fetched[name] = rows;
    } catch (e) { console.warn("hydrate", name, "failed", e); }
  }
  if (window.DATA) {
    for (const [name, rows] of Object.entries(fetched)) window.DATA[name] = rows;
    // Normalize even when nothing was fetched: rows restored from the LS
    // cache (listTable fallback) are schema-shaped too.
    normalizeDomainData(window.DATA);
  }
  window.dispatchEvent(new CustomEvent("kinetic:data-updated", { detail: { table: "*" } }));
}
setTimeout(() => hydrateDomainTables().catch(e => console.warn("hydrate failed", e)), 0);

const KineticData = {
  list: listTable,
  upsert: upsertRow,
  remove: removeRow,
  tables: DATA_TABLES,
};

// ══════════════════════════════════════════════════════════════
// Quick Payment API (PRD "دفع سريع")
// ══════════════════════════════════════════════════════════════
// Digits-only phone comparison so "+20 100…" matches "0100…" etc.
// (Duplicated from screens1.jsx so the data layer stays self-contained.)
function __normPhone(p) {
  return String(p || "").replace(/\D/g, "").replace(/^0+/, "");
}

// Search patients by name (substring, case-insensitive), phone (digit
// suffix match), or patient ID (prefix). Live data only — reads from
// window.DATA.patients which is kept in sync with Supabase.
async function searchPatientsFor(term) {
  const q = String(term || "").trim();
  if (!q) return [];
  const list = (window.DATA && window.DATA.patients) || await listTable("patients");
  const qLower = q.toLowerCase();
  const qDigits = __normPhone(q);
  const results = list.filter(p => {
    const name = String(p.name || "").toLowerCase();
    const pid  = String(p.patient_id || p.id || "").toLowerCase();
    const ph   = __normPhone(p.phone);
    if (name.includes(qLower)) return true;
    if (pid.includes(qLower)) return true;
    if (qDigits && ph && (ph.endsWith(qDigits) || ph.includes(qDigits))) return true;
    return false;
  });
  return results.slice(0, 25);
}

// Load every outstanding financial item for one patient.
// Returns { appointments, invoices, subscriptions } — each row includes
// a computed `remaining` field (never trust a stale UI cache; always
// re-read from Supabase when available).
async function loadPatientFinancials(patientId) {
  if (!patientId) return { appointments: [], invoices: [], subscriptions: [] };

  let appts = [], invoices = [], subs = [];
  if (sb) {
    // Force a fresh read — the modal shows real remaining balances.
    const [aRes, iRes, sRes] = await Promise.all([
      sb.from("bookings").select("*").eq("patient_id", patientId),
      sb.from("invoices").select("*").eq("patient_id", patientId),
      sb.from("patient_subscriptions").select("*").eq("patient_id", patientId),
    ]);
    if (!aRes.error && Array.isArray(aRes.data)) appts = aRes.data;
    if (!iRes.error && Array.isArray(iRes.data)) invoices = iRes.data;
    if (!sRes.error && Array.isArray(sRes.data)) subs = sRes.data;
  } else {
    appts = (window.DATA?.appts || []).filter(a =>
      (a.patient_id || a.pid) === patientId);
    invoices = (window.DATA?.payments || []).filter(v =>
      (v.patient_id) === patientId || v.pid === patientId);
    subs = (window.DATA?.subscriptions || []).filter(s =>
      s.patient_id === patientId);
  }

  const outstandingAppts = appts.map(a => {
    const price = Number(a.price) || 0;
    const paid  = Number(a.paid) || 0;
    return { ...a, price, paid, remaining: Math.max(0, price - paid) };
  }).filter(a => a.remaining > 0 && a.status !== "cancelled" && a.status !== "ملغي");

  const outstandingInvoices = invoices.map(v => {
    const amount = Number(v.amount) || 0;
    const paid   = Number(v.paid) || 0;
    return { ...v, amount, paid, remaining: Math.max(0, amount - paid) };
  }).filter(v => v.remaining > 0);

  const outstandingSubs = subs.map(s => {
    const price = Number(s.price) || 0;
    const paid  = Number(s.paid) || 0;
    return { ...s,
      price, paid, remaining: Math.max(0, price - paid),
      total_sessions: Number(s.total_sessions) || 0,
      used_sessions:  Number(s.used_sessions)  || 0,
    };
  }).filter(s => s.status !== "cancelled" && s.status !== "expired");

  return {
    appointments:  outstandingAppts,
    invoices:      outstandingInvoices,
    subscriptions: outstandingSubs,
  };
}

// Load a patient's payment history (most recent first). Used by the
// "سجل الدفع" tab; paginated to keep the payload small.
async function loadPaymentHistory(patientId, opts) {
  const limit = (opts && opts.limit) || 20;
  const offset = (opts && opts.offset) || 0;
  if (sb) {
    let q = sb.from("payments").select("*");
    if (patientId) q = q.eq("patient_id", patientId);
    const { data, error } = await q
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    if (!error && Array.isArray(data)) return data;
  }
  const src = (window.DATA?.paymentHistory || [])
    .filter(p => !patientId || p.patient_id === patientId)
    .slice()
    .sort((a,b) => String(b.created_at||"").localeCompare(String(a.created_at||"")));
  return src.slice(offset, offset + limit);
}

// Best-effort IP capture. Not sensitive — used only for the audit log.
async function __clientIP() {
  try {
    const r = await fetch("https://api.ipify.org?format=json", { cache: "no-store" });
    if (r.ok) { const j = await r.json(); return j.ip || null; }
  } catch {}
  return null;
}

function __receiptNo() {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}`;
  return `RCT-${stamp}-${String(Math.floor(Math.random()*100000)).padStart(5,"0")}`;
}
function __paymentId() {
  return "PMT-" + Date.now().toString() + "-" + Math.random().toString(36).slice(2,6);
}

// Record a Quick Payment. Prefers the transactional RPC (record_quick_payment);
// falls back to a best-effort sequential write in demo / offline mode.
//
// input: {
//   patient_id, method, reference, transaction_id, notes,
//   allocations: [{ type:'appointment'|'invoice'|'subscription', id, amount }]
// }
// output: { ok, payment_id, receipt_no, amount, error? }
async function recordQuickPayment(input) {
  const patientId = input && input.patient_id;
  const allocs = Array.isArray(input && input.allocations) ? input.allocations : [];
  const method = input && input.method;

  // ── Client-side validation (defensive) ───────────────────────
  if (!patientId) return { ok: false, error: "لم يتم اختيار المريض" };
  if (allocs.length === 0) return { ok: false, error: "اختر عنصرًا واحدًا على الأقل للدفع" };
  if (!method) return { ok: false, error: "اختر طريقة الدفع" };
  const total = allocs.reduce((s, a) => s + (Number(a.amount) || 0), 0);
  if (total <= 0) return { ok: false, error: "المبلغ يجب أن يكون أكبر من صفر" };
  for (const a of allocs) {
    const amt = Number(a.amount);
    if (!(amt > 0)) return { ok: false, error: "المبلغ لكل عنصر يجب أن يكون موجبًا" };
    if (!["appointment","invoice","subscription"].includes(a.type))
      return { ok: false, error: "نوع عنصر غير معروف" };
    if (!a.id) return { ok: false, error: "معرّف العنصر مفقود" };
  }

  const me = window.ME || {};
  const cashierId = me.staff_id || me.id || me.email || null;
  const cashierName = me.name || me.email || "غير معروف";
  const ipAddress = await __clientIP();

  // ── Transactional path (Supabase RPC) ────────────────────────
  if (sb) {
    const { data, error } = await sb.rpc("record_quick_payment", {
      p_patient_id: patientId,
      p_allocations: allocs.map(a => ({
        type: a.type, id: String(a.id), amount: Number(a.amount),
      })),
      p_method: method,
      p_reference: (input.reference || "").trim() || null,
      p_transaction_id: (input.transaction_id || "").trim() || null,
      p_notes: (input.notes || "").trim() || null,
      p_cashier_id: cashierId,
      p_cashier_name: cashierName,
      p_ip_address: ipAddress,
    });
    if (error) {
      console.warn("record_quick_payment failed", error.message || error);
      return { ok: false, error: error.message || "تعذّر تسجيل الدفع" };
    }
    // Refresh mirrors so tiles/tables update without a page reload.
    await hydrateDomainTables().catch(()=>{});
    return {
      ok: true,
      payment_id: (data && data.payment_id) || null,
      receipt_no: (data && data.receipt_no) || null,
      amount: total,
    };
  }

  // ── Offline / demo fallback (no true transaction) ────────────
  // Applies allocations sequentially and rolls back the local mirror on
  // failure. Not atomic; documented as best-effort.
  const snapshot = {
    appts:          JSON.parse(JSON.stringify(window.DATA?.appts || [])),
    payments:       JSON.parse(JSON.stringify(window.DATA?.payments || [])),
    subscriptions:  JSON.parse(JSON.stringify(window.DATA?.subscriptions || [])),
    paymentHistory: JSON.parse(JSON.stringify(window.DATA?.paymentHistory || [])),
  };
  try {
    for (const a of allocs) {
      const amt = Number(a.amount);
      if (a.type === "appointment") {
        const row = (window.DATA.appts || []).find(r => (r.booking_id || r.id) === a.id);
        if (!row) throw new Error(`الموعد ${a.id} غير موجود`);
        const price = Number(row.price) || 0;
        const paidNow = (Number(row.paid) || 0) + amt;
        if (amt > (price - (Number(row.paid) || 0)) + 0.001) throw new Error("المبلغ يتجاوز المتبقي على الموعد");
        await upsertRow("appts", { ...row,
          paid: paidNow,
          payment_status: paidNow >= price ? "paid" : (paidNow > 0 ? "partial" : "pending"),
        });
      } else if (a.type === "invoice") {
        const row = (window.DATA.payments || []).find(r => (r.invoice_id || r.id) === a.id);
        if (!row) throw new Error(`الفاتورة ${a.id} غير موجودة`);
        const amount = Number(row.amount) || 0;
        const remaining = amount - (Number(row.paid) || 0);
        if (remaining <= 0) throw new Error("الفاتورة مدفوعة بالكامل");
        if (amt > remaining + 0.001) throw new Error("المبلغ يتجاوز المتبقي على الفاتورة");
        const paidNow = (Number(row.paid) || 0) + amt;
        await upsertRow("payments", { ...row,
          paid: paidNow,
          payment_method: method,
          status: paidNow >= amount ? "paid" : (paidNow > 0 ? "partial" : "pending"),
        });
      } else if (a.type === "subscription") {
        const row = (window.DATA.subscriptions || []).find(r => (r.subscription_id || r.id) === a.id);
        if (!row) throw new Error(`الاشتراك ${a.id} غير موجود`);
        const price = Number(row.price) || 0;
        const remaining = price - (Number(row.paid) || 0);
        if (remaining <= 0) throw new Error("الاشتراك مدفوع بالكامل");
        if (amt > remaining + 0.001) throw new Error("المبلغ يتجاوز المتبقي على الاشتراك");
        const paidNow = (Number(row.paid) || 0) + amt;
        await upsertRow("subscriptions", { ...row,
          paid: paidNow,
          status: paidNow >= price ? "paid" : "active",
          updated_at: new Date().toISOString(),
        });
      }
    }
    const payment_id = __paymentId();
    const receipt_no = __receiptNo();
    await upsertRow("paymentHistory", {
      payment_id, patient_id: patientId,
      cashier_id: cashierId, cashier_name: cashierName,
      amount: total, method,
      reference: (input.reference || "").trim() || null,
      transaction_id: (input.transaction_id || "").trim() || null,
      notes: (input.notes || "").trim() || null,
      receipt_no, allocations: allocs,
      ip_address: ipAddress,
      status: "completed",
      created_at: new Date().toISOString(),
    });
    return { ok: true, payment_id, receipt_no, amount: total };
  } catch (e) {
    // Rollback local mirror.
    if (window.DATA) {
      window.DATA.appts = snapshot.appts;
      window.DATA.payments = snapshot.payments;
      window.DATA.subscriptions = snapshot.subscriptions;
      window.DATA.paymentHistory = snapshot.paymentHistory;
    }
    writeLS(DATA_TABLES.appts.ls, snapshot.appts);
    writeLS(DATA_TABLES.payments.ls, snapshot.payments);
    writeLS(DATA_TABLES.subscriptions.ls, snapshot.subscriptions);
    writeLS(DATA_TABLES.paymentHistory.ls, snapshot.paymentHistory);
    window.dispatchEvent(new CustomEvent("kinetic:data-updated", { detail: { table: "*" } }));
    return { ok: false, error: e.message || String(e) };
  }
}

const QuickPay = {
  searchPatients:      searchPatientsFor,
  loadFinancials:      loadPatientFinancials,
  loadHistory:         loadPaymentHistory,
  recordPayment:       recordQuickPayment,
};

// ══════════════════════════════════════════════════════════════
// Treatment Methods API ("طرق علاج أخرى")
// Shared library of treatment methods that doctors can extend at run-time.
// The list is stored in DATA.treatmentMethods; every write also
// hits the DB (via RPC when Supabase is on) so custom methods are
// available to every terminal and every future treatment plan.
// ══════════════════════════════════════════════════════════════
function __txMethodId() {
  const d = new Date();
  const pad = (n, w=2) => String(n).padStart(w, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `TM-${stamp}-${rand}`;
}

// Case/whitespace-insensitive dedupe.
function __normName(s) {
  return String(s || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("ar");
}

// Load once, then use DATA.treatmentMethods as the live cache. `force`
// re-hits the DB (used after a save so RLS-filtered rows show up).
async function listTxMethods(force) {
  if (!force && Array.isArray(window.DATA?.treatmentMethods) && window.DATA.treatmentMethods.length) {
    return window.DATA.treatmentMethods;
  }
  const rows = await listTable("treatmentMethods");
  if (window.DATA) {
    window.DATA.treatmentMethods = rows || [];
    if (window.normalizeDomainData) window.normalizeDomainData(window.DATA);
  }
  window.dispatchEvent(new CustomEvent("kinetic:data-updated", { detail: { table: "treatmentMethods" } }));
  return window.DATA?.treatmentMethods || rows || [];
}

// Client-side search over the cached list. Matches on name, category,
// description (case-insensitive, Arabic-aware). Returns active rows
// first, archived last so the picker never accidentally reuses a
// retired method.
function searchTxMethods(term) {
  const list = window.DATA?.treatmentMethods || [];
  const q = __normName(term);
  if (!q) return list.slice().sort((a,b)=>(a.status==='archived')-(b.status==='archived'));
  return list.filter(m =>
    __normName(m.name).includes(q)
    || __normName(m.category).includes(q)
    || __normName(m.description).includes(q)
  ).sort((a,b)=>(a.status==='archived')-(b.status==='archived'));
}

// Distinct categories seen in the library — used by the modal's
// category picker so it stays in sync with whatever doctors have
// actually added.
function listTxCategories() {
  const seen = new Map(); // preserve first-seen order
  for (const m of (window.DATA?.treatmentMethods || [])) {
    const c = String(m.category || "").trim();
    if (c && !seen.has(c)) seen.set(c, true);
  }
  return Array.from(seen.keys());
}

// Client-side duplicate check so the modal can flag it before the
// user hits حفظ. The RPC also enforces this server-side.
function findTxMethodByName(name, excludeId) {
  const n = __normName(name);
  if (!n) return null;
  return (window.DATA?.treatmentMethods || []).find(m =>
    __normName(m.name) === n && (m.method_id !== excludeId)
  ) || null;
}

function __txPayload(input) {
  const trim = (v) => String(v || "").trim();
  const numOrNull = (v) => (v == null || v === "") ? null : Number(v);
  return {
    name:             trim(input?.name),
    category:         trim(input?.category)         || null,
    description:      trim(input?.description)      || null,
    notes:            trim(input?.notes)            || null,
    icon:             trim(input?.icon)             || null,
    color:            trim(input?.color)            || null,
    duration_minutes: numOrNull(input?.duration_minutes),
    display_order:    numOrNull(input?.display_order),
    is_active:        (input?.is_active === false ? "false" : "true"),
  };
}

async function createTxMethod(input) {
  const payload = __txPayload(input);
  if (!payload.name) return { ok: false, error: "الاسم مطلوب" };
  if (findTxMethodByName(payload.name)) {
    return { ok: false, error: "اسم طريقة العلاج موجود مسبقًا" };
  }
  const method_id = __txMethodId();

  if (sb) {
    const { data, error } = await sb.rpc("upsert_treatment_method", {
      p_method_id: method_id,
      p_payload:   payload,
    });
    if (error) return { ok: false, error: error.message || "تعذّر إنشاء طريقة العلاج" };
    await listTxMethods(true);
    return { ok: true, method_id: (data && data.method_id) || method_id, name: payload.name };
  }

  const now = new Date().toISOString();
  const cashierName = (window.ME && (window.ME.name || window.ME.email)) || "طبيب";
  await upsertRow("treatmentMethods", {
    method_id,
    name:             payload.name,
    category:         payload.category,
    description:      payload.description,
    duration_minutes: payload.duration_minutes,
    notes:            payload.notes,
    icon:             payload.icon,
    color:            payload.color,
    display_order:    payload.display_order,
    status:           payload.is_active === "false" ? "archived" : "active",
    created_by_name:  cashierName,
    created_at: now, updated_at: now,
  });
  return { ok: true, method_id, name: payload.name };
}

async function updateTxMethod(method_id, patch) {
  if (!method_id) return { ok: false, error: "معرّف مفقود" };
  const payload = __txPayload(patch);
  if (!payload.name) return { ok: false, error: "الاسم مطلوب" };
  if (findTxMethodByName(payload.name, method_id)) {
    return { ok: false, error: "اسم طريقة العلاج موجود مسبقًا" };
  }

  if (sb) {
    const { data, error } = await sb.rpc("upsert_treatment_method", {
      p_method_id: method_id,
      p_payload:   payload,
    });
    if (error) return { ok: false, error: error.message || "تعذّر تحديث طريقة العلاج" };
    await listTxMethods(true);
    return { ok: true, method_id: (data && data.method_id) || method_id };
  }

  const list = window.DATA?.treatmentMethods || [];
  const row  = list.find(m => (m.method_id || m.id) === method_id);
  if (!row) return { ok: false, error: "طريقة العلاج غير موجودة" };
  await upsertRow("treatmentMethods", {
    ...row,
    name:             payload.name,
    category:         payload.category,
    description:      payload.description,
    duration_minutes: payload.duration_minutes,
    notes:            payload.notes,
    icon:             payload.icon,
    color:            payload.color,
    display_order:    payload.display_order,
    status:           payload.is_active === "false" ? "archived" : (row.status || "active"),
    updated_at:       new Date().toISOString(),
  });
  return { ok: true, method_id };
}

async function removeTxMethod(method_id) {
  if (!method_id) return { ok: false, error: "معرّف مفقود" };
  if (sb) {
    const { error } = await sb.rpc("delete_treatment_method", { p_method_id: method_id });
    if (error) return { ok: false, error: error.message || "تعذّر الحذف" };
    await listTxMethods(true);
    return { ok: true, method_id };
  }
  // LS mode: block if any template references this method_id or name.
  const list = window.DATA?.treatmentMethods || [];
  const row  = list.find(m => (m.method_id || m.id) === method_id);
  if (!row) return { ok: false, error: "غير موجود" };
  const templates = readLS(LS_TEMPLATES, []);
  const nm = String(row.name || "").toLowerCase();
  const used = templates.some(t => (t.methods || []).some(m => (m.method_id === method_id) || (String(m.name || m || "").toLowerCase() === nm)));
  if (used) return { ok: false, error: "لا يمكن حذف طريقة مستخدمة في القوالب — استخدم الأرشفة بدلاً منها" };
  const next = list.filter(m => (m.method_id || m.id) !== method_id);
  window.DATA.treatmentMethods = next;
  writeLS('kinetic.treatment_methods.v1', next);
  window.dispatchEvent(new CustomEvent("kinetic:data-updated", { detail: { table: "treatmentMethods" } }));
  return { ok: true, method_id };
}

async function setTxMethodStatus(method_id, status) {
  if (!method_id) return { ok: false, error: "معرّف مفقود" };
  if (status !== "active" && status !== "archived") {
    return { ok: false, error: "حالة غير صحيحة" };
  }
  if (sb) {
    const { error } = await sb.rpc("set_treatment_method_status", {
      p_method_id: method_id, p_status: status,
    });
    if (error) return { ok: false, error: error.message || "تعذّر التحديث" };
    await listTxMethods(true);
    return { ok: true, method_id, status };
  }
  const list = window.DATA?.treatmentMethods || [];
  const row  = list.find(m => (m.method_id || m.id) === method_id);
  if (!row) return { ok: false, error: "غير موجود" };
  await upsertRow("treatmentMethods", { ...row, status, updated_at: new Date().toISOString() });
  return { ok: true, method_id, status };
}

const TxMethods = {
  list:       listTxMethods,
  search:     searchTxMethods,
  categories: listTxCategories,
  findByName: findTxMethodByName,
  create:     createTxMethod,
  update:     updateTxMethod,
  archive:    (id) => setTxMethodStatus(id, "archived"),
  restore:    (id) => setTxMethodStatus(id, "active"),
  remove:     removeTxMethod,
};
window.TxMethods = TxMethods;

// ══════════════════════════════════════════════════════════════
// Invoices filter API — powers the date filter on Payments page.
// Tries the DB RPC `list_invoices_filtered` first (server-side range +
// aggregates in one round-trip), falls back to filtering DATA.payments
// on the client so demo/LS mode keeps working. Returns a stable shape:
//   { rows, stats:{ total_invoices, paid_amount, outstanding,
//                    overdue_amount, avg_amount, revenue,
//                    count, due_total }, count, limit, offset }
// ══════════════════════════════════════════════════════════════
function __asIsoStart(d) {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString();
  const s = String(d);
  // Accept "YYYY-MM-DD"
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00.000Z`;
  return new Date(s).toISOString();
}
function __asIsoEnd(d) {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString();
  const s = String(d);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T23:59:59.999Z`;
  return new Date(s).toISOString();
}
function __invoiceCreatedAt(row) {
  return row && (row.created_at || row.date || row.updated_at || "");
}
function __rowMatchesSearch(row, term) {
  if (!term) return true;
  const t = String(term).trim().toLowerCase();
  if (!t) return true;
  const hay = [row.invoice_id, row.id, row.patient, row.patient_name, row.patient_id]
    .filter(Boolean).join(" ").toLowerCase();
  return hay.includes(t);
}
function __computeClientStats(rows) {
  const s = {
    total_invoices: 0, paid_amount: 0, outstanding: 0,
    overdue_amount: 0, avg_amount: 0, revenue: 0,
    count: rows.length, due_total: 0,
  };
  for (const r of rows) {
    const amt = Number(r.amount || 0);
    const paid = Number(r.paid || 0);
    const due = Math.max(0, amt - paid);
    s.total_invoices += amt;
    s.paid_amount    += paid;
    s.outstanding    += due;
    s.due_total      += due;
    if (r.status === "متأخر") s.overdue_amount += due;
  }
  s.revenue = s.paid_amount;
  s.avg_amount = rows.length ? s.total_invoices / rows.length : 0;
  return s;
}

async function listInvoicesFiltered({ from, to, search, status, limit, offset } = {}) {
  const fromIso = __asIsoStart(from);
  const toIso   = __asIsoEnd(to);
  const lim = Math.max(1, Math.min(500, Number(limit) || 500));
  const off = Math.max(0, Number(offset) || 0);
  const trimSearch = (search || "").trim();
  const st = status && status !== "الكل" ? status : null;

  if (sb) {
    try {
      const { data, error } = await sb.rpc("list_invoices_filtered", {
        p_from:   fromIso,
        p_to:     toIso,
        p_search: trimSearch || null,
        p_status: st,
        p_limit:  lim,
        p_offset: off,
      });
      if (!error && data) {
        const rows = Array.isArray(data.rows) ? data.rows : [];
        const stats = data.stats || {};
        const count = Number(data.count || rows.length) || 0;
        return {
          rows: rows.map(r => ({
            invoice_id: r.invoice_id,
            id:         r.invoice_id,
            patient_id: r.patient_id,
            patient:    r.patient_name || "",
            amount:     Number(r.amount || 0),
            paid:       Number(r.paid || 0),
            method:     r.payment_method || "",
            payment_method: r.payment_method || "",
            status:     r.status || "معلّق",
            date:       (r.created_at || "").slice(0, 10),
            created_at: r.created_at,
          })),
          stats: {
            total_invoices: Number(stats.total_invoices || 0),
            paid_amount:    Number(stats.paid_amount || 0),
            outstanding:    Number(stats.outstanding || 0),
            overdue_amount: Number(stats.overdue_amount || 0),
            avg_amount:     Number(stats.avg_amount || 0),
            revenue:        Number(stats.paid_amount || 0),
            count:          Number(stats.count || count),
            due_total:      Number(stats.outstanding || 0),
          },
          count, limit: lim, offset: off,
        };
      }
      if (error) console.warn("list_invoices_filtered rpc failed", error.message || error);
    } catch (e) { console.warn("list_invoices_filtered rpc failed", e); }
  }

  // Fallback: filter the in-memory DATA.payments. Honours scopePayments
  // when the current user is a therapist, so visibility rules match.
  const src = (window.scopePayments ? window.scopePayments(window.DATA?.payments || [])
                                    : (window.DATA?.payments || []));
  const filtered = src.filter(r => {
    const created = __invoiceCreatedAt(r);
    if (fromIso && created && created < fromIso) return false;
    if (toIso   && created && created > toIso) return false;
    if (st && r.status !== st) return false;
    if (!__rowMatchesSearch(r, trimSearch)) return false;
    return true;
  }).sort((a, b) => String(__invoiceCreatedAt(b)).localeCompare(String(__invoiceCreatedAt(a))));

  const stats = __computeClientStats(filtered);
  const page  = filtered.slice(off, off + lim);
  return { rows: page, stats, count: filtered.length, limit: lim, offset: off };
}

const InvoicesAPI = { listFiltered: listInvoicesFiltered };
window.InvoicesAPI = InvoicesAPI;

// ══════════════════════════════════════════════════════════════
// Receive Payment — patient-profile invoice payments with receipt
// upload. Every operation is DB-backed:
//   1. Upload the receipt file to Supabase Storage (patient-files
//      bucket under the "receipts/" prefix). If no storage backend is
//      configured we fall back to inlined data URLs so demo mode still
//      records the receipt row.
//   2. Call the existing `record_quick_payment` RPC to move money
//      (invoice update + payment row + audit inside one DB TX).
//   3. Insert a `payment_receipts` metadata row linking the file to
//      the payment/invoice/patient.
//   4. If step 3 fails, remove the uploaded file so no orphans stay
//      behind. If step 2 fails, we do the same for step 1.
// ══════════════════════════════════════════════════════════════
const RECEIPT_ALLOWED_TYPES = ["image/jpeg","image/jpg","image/png","application/pdf"];
const RECEIPT_ALLOWED_EXT   = /\.(jpe?g|png|pdf)$/i;
const RECEIPT_MAX_BYTES     = 8 * 1024 * 1024; // 8MB cap — receipts are small
const LS_RECEIPTS           = "kinetic.payment_receipts";

function __nextReceiptId() {
  return "rct_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function __receiptValid(file) {
  if (!file) return "لم يتم اختيار ملف";
  if (file.size > RECEIPT_MAX_BYTES) return "حجم الملف يتجاوز 8MB";
  const okType = RECEIPT_ALLOWED_TYPES.includes(file.type);
  const okExt  = RECEIPT_ALLOWED_EXT.test(file.name || "");
  if (!okType && !okExt) return "نوع الملف غير مدعوم — JPG/PNG/PDF فقط";
  return null;
}

// Upload one receipt file → Supabase Storage. Returns
// { storage_path, file_url } on success, or throws with a clear message.
async function __uploadReceiptFile(patientId, receiptId, file) {
  if (!sb) throw new Error("لم يتم تكوين قاعدة البيانات");
  const safe = sanitizeFileName(file.name);
  const path = `receipts/${patientId}/${receiptId}-${safe}`;
  const { error: upErr } = await sb.storage.from(PATIENT_FILES_BUCKET)
    .upload(path, file, { cacheControl: "3600", upsert: false, contentType: file.type || undefined });
  if (upErr) throw new Error(upErr.message || "تعذّر رفع الإيصال");
  const { data: pub } = sb.storage.from(PATIENT_FILES_BUCKET).getPublicUrl(path);
  return { storage_path: path, file_url: (pub && pub.publicUrl) || "" };
}

async function __removeReceiptFile(storage_path) {
  if (!sb || !storage_path) return;
  try { await sb.storage.from(PATIENT_FILES_BUCKET).remove([storage_path]); }
  catch (e) { console.warn("cleanup receipt file failed", e); }
}

async function __insertReceiptRow(row) {
  const localRow = { ...row };
  const idx = readLS(LS_RECEIPTS, []);
  idx.unshift(localRow);
  writeLS(LS_RECEIPTS, idx);
  if (sb) {
    const dbRow = {
      receipt_id:       row.receipt_id,
      payment_id:       row.payment_id,
      invoice_id:       row.invoice_id,
      patient_id:       row.patient_id,
      file_name:        row.file_name,
      stored_name:      row.stored_name,
      storage_path:     row.storage_path,
      file_url:         row.file_url,
      file_type:        row.file_type,
      file_size:        row.file_size,
      uploaded_by_name: row.uploaded_by_name,
    };
    const { error } = await sb.from("payment_receipts").insert(dbRow);
    if (error) {
      console.warn("insert payment_receipts failed", error.message || error);
      // Roll back the LS mirror if the DB rejected.
      writeLS(LS_RECEIPTS, readLS(LS_RECEIPTS, []).filter(r => r.receipt_id !== row.receipt_id));
      return { ok: false, error: error.message || "تعذّر حفظ الإيصال" };
    }
  }
  return { ok: true };
}

// Public: receive one payment against a specific invoice with an
// optional receipt file. Returns { ok, payment_id, receipt_no,
// receipt_id, receipt_url, remaining } on success.
async function receiveInvoicePayment(input) {
  const invoice = input && input.invoice;
  const amount  = Number(input && input.amount) || 0;
  const method  = input && input.method;
  const file    = input && input.file || null;

  // ── Client-side validation ──
  if (!invoice || !(invoice.invoice_id || invoice.id))
    return { ok: false, error: "الفاتورة غير موجودة" };
  if (!method) return { ok: false, error: "اختر طريقة الدفع" };
  const total     = Number(invoice.amount || 0);
  const paidSoFar = Number(invoice.paid   || 0);
  const remaining = Math.max(0, total - paidSoFar);
  if (!(amount > 0)) return { ok: false, error: "المبلغ يجب أن يكون أكبر من صفر" };
  if (amount > remaining + 0.0001) return { ok: false, error: "المبلغ يتجاوز الرصيد المتبقي" };
  if (file) {
    const err = __receiptValid(file);
    if (err) return { ok: false, error: err };
  }

  const me = window.ME || {};
  const uploaderName = me.name || me.email || "غير معروف";
  const patientId    = invoice.patient_id || invoice.pid || (input.patient && input.patient.patient_id);

  // ── 1. Upload the receipt first so the payment TX only fires when
  //       we have a file locked in. If there's no file, skip.
  let uploaded = null;
  const receiptId = __nextReceiptId();
  if (file) {
    try {
      uploaded = await __uploadReceiptFile(patientId, receiptId, file);
    } catch (e) {
      console.warn("receipt upload failed", e);
      return { ok: false, error: "تعذّر رفع الإيصال" };
    }
    if (!uploaded || (!uploaded.file_url && !uploaded.storage_path)) {
      return { ok: false, error: "تعذّر رفع الإيصال" };
    }
  }

  // ── 2. Record the payment atomically via the existing RPC.
  const payRes = await recordQuickPayment({
    patient_id: patientId,
    allocations: [{
      type:   "invoice",
      id:     invoice.invoice_id || invoice.id,
      amount: amount,
    }],
    method:         method,
    reference:      input.reference || "",
    transaction_id: input.transaction_id || "",
    notes:          input.notes || "",
  });
  if (!payRes || !payRes.ok) {
    // Payment failed → clean up any uploaded file so we don't leave
    // orphaned receipts in storage.
    if (uploaded && uploaded.storage_path) await __removeReceiptFile(uploaded.storage_path);
    return { ok: false, error: (payRes && payRes.error) || "تعذّر تسجيل الدفع" };
  }

  // ── 3. Persist receipt metadata linked to the new payment_id.
  let receiptRow = null;
  if (uploaded) {
    receiptRow = {
      receipt_id:       receiptId,
      payment_id:       payRes.payment_id,
      invoice_id:       invoice.invoice_id || invoice.id,
      patient_id:       patientId,
      file_name:        file.name,
      stored_name:      sanitizeFileName(file.name),
      storage_path:     uploaded.storage_path,
      file_url:         uploaded.file_url,
      file_type:        file.type || "",
      file_size:        file.size || 0,
      uploaded_by_name: uploaderName,
      uploaded_at:      new Date().toISOString(),
    };
    const ins = await __insertReceiptRow(receiptRow);
    if (!ins.ok) {
      // The payment succeeded but the metadata insert failed. Do NOT
      // roll back the payment (it's already committed); best-effort
      // clean up the file so we don't leak. Warn caller.
      if (uploaded.storage_path) await __removeReceiptFile(uploaded.storage_path);
      window.dispatchEvent(new CustomEvent("kinetic:data-updated", { detail: {} }));
      return { ok: true, warning: "تم تسجيل الدفع لكن تعذّر حفظ ملف الإيصال",
        payment_id: payRes.payment_id, receipt_no: payRes.receipt_no,
        remaining: Math.max(0, remaining - amount) };
    }
  }

  window.dispatchEvent(new CustomEvent("kinetic:data-updated", { detail: {} }));
  window.dispatchEvent(new CustomEvent("kinetic:payment-receipt-updated", { detail: { invoice_id: invoice.invoice_id || invoice.id } }));
  return {
    ok: true,
    payment_id:  payRes.payment_id,
    receipt_no:  payRes.receipt_no,
    receipt_id:  receiptRow ? receiptRow.receipt_id : null,
    receipt_url: receiptRow ? receiptRow.file_url   : null,
    remaining:   Math.max(0, remaining - amount),
    invoice_id:  invoice.invoice_id || invoice.id,
  };
}

// List all payments for a given invoice, newest first. Merges DB rows
// with the LS mirror so offline/demo mode also renders history.
async function listInvoicePayments(invoiceId) {
  if (!invoiceId) return [];
  const wanted = String(invoiceId);
  const rows = [];
  if (sb) {
    try {
      const { data, error } = await sb.from("payments")
        .select("*").order("created_at", { ascending: false });
      if (!error && Array.isArray(data)) {
        data.forEach(p => {
          const allocs = Array.isArray(p.allocations) ? p.allocations
                       : (typeof p.allocations === "string" ? JSON.parse(p.allocations || "[]") : []);
          if (allocs.some(a => a.type === "invoice" && String(a.id) === wanted)) rows.push(p);
        });
        return rows;
      }
      if (error) console.warn("listInvoicePayments failed", error.message || error);
    } catch (e) { console.warn("listInvoicePayments failed", e); }
  }
  const mirror = readLS(DATA_TABLES.paymentHistory.ls, []);
  mirror.forEach(p => {
    const allocs = Array.isArray(p.allocations) ? p.allocations
                 : (typeof p.allocations === "string" ? JSON.parse(p.allocations || "[]") : []);
    if (allocs.some(a => a.type === "invoice" && String(a.id) === wanted)) rows.push(p);
  });
  return rows;
}

async function listInvoiceReceipts(invoiceId, paymentId) {
  const rows = [];
  const wantedInv = invoiceId ? String(invoiceId) : null;
  const wantedPay = paymentId ? String(paymentId) : null;
  if (sb) {
    try {
      let q = sb.from("payment_receipts").select("*").is("deleted_at", null);
      if (wantedInv) q = q.eq("invoice_id", wantedInv);
      if (wantedPay) q = q.eq("payment_id", wantedPay);
      const { data, error } = await q.order("uploaded_at", { ascending: false });
      if (!error && Array.isArray(data)) return data;
      if (error) console.warn("listInvoiceReceipts failed", error.message || error);
    } catch (e) { console.warn("listInvoiceReceipts failed", e); }
  }
  const mirror = readLS(LS_RECEIPTS, []);
  mirror.forEach(r => {
    if (r.deleted_at) return;
    if (wantedInv && String(r.invoice_id) !== wantedInv) return;
    if (wantedPay && String(r.payment_id) !== wantedPay) return;
    rows.push(r);
  });
  return rows;
}

async function deletePaymentReceipt(receiptId) {
  if (!receiptId) return { ok: false, error: "معرّف الإيصال مفقود" };
  const me = window.ME || {};
  if (me.role && me.role !== "مدير" && me.role !== "admin")
    return { ok: false, error: "الحذف مقتصر على المدير" };
  if (sb) {
    const { data, error } = await sb.rpc("delete_payment_receipt", { p_receipt_id: receiptId });
    if (error) {
      console.warn("delete_payment_receipt rpc failed", error.message || error);
      return { ok: false, error: error.message || "تعذّر الحذف" };
    }
    // Update LS mirror to match.
    const idx = readLS(LS_RECEIPTS, []);
    writeLS(LS_RECEIPTS, idx.map(r => r.receipt_id === receiptId ? { ...r, deleted_at: new Date().toISOString() } : r));
    window.dispatchEvent(new CustomEvent("kinetic:payment-receipt-updated", { detail: {} }));
    return { ok: true, receipt_id: receiptId, deleted: !!(data && data.deleted) };
  }
  const idx = readLS(LS_RECEIPTS, []);
  writeLS(LS_RECEIPTS, idx.map(r => r.receipt_id === receiptId ? { ...r, deleted_at: new Date().toISOString() } : r));
  window.dispatchEvent(new CustomEvent("kinetic:payment-receipt-updated", { detail: {} }));
  return { ok: true, receipt_id: receiptId, deleted: true };
}

const PaymentReceipts = {
  receive:  receiveInvoicePayment,
  history:  listInvoicePayments,
  list:     listInvoiceReceipts,
  remove:   deletePaymentReceipt,
  validate: __receiptValid,
};
window.PaymentReceipts = PaymentReceipts;

// ══════════════════════════════════════════════════════════════
// Patient files — `patient_files` table (metadata) + Supabase
// Storage bucket "patient-files" (binary). PostgreSQL never stores
// file bytes; only path/URL and audit fields.
//
// Upload contract:  validate → put object → insert metadata row.
//   If the DB insert fails we delete the just-uploaded object to
//   keep both systems in sync (compensating rollback).
// Delete contract:  delete DB row → delete object.
//   If the object delete fails we log it; the DB row is already
//   gone so the UI is consistent.
// ══════════════════════════════════════════════════════════════
const PATIENT_FILES_BUCKET   = "patient-files";
const MAX_FILE_BYTES         = 25 * 1024 * 1024; // 25 MB per file
const ALLOWED_MIME_PREFIXES  = ["image/"];
const ALLOWED_MIME_EXACT     = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/dicom",
  "text/plain",
]);
const ALLOWED_EXT_RE = /\.(jpe?g|png|gif|webp|bmp|pdf|docx?|xlsx?|dcm|txt)$/i;

function nextFileId() {
  return "pf_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function sanitizeFileName(name) {
  return String(name || "file").replace(/[^\w.\-؀-ۿ]+/g, "_").slice(0, 120);
}
function validatePatientFile(file) {
  if (!file || typeof file.size !== "number") return "ملف غير صالح";
  if (file.size <= 0) return "الملف فارغ";
  if (file.size > MAX_FILE_BYTES) return `حجم الملف يتجاوز ${Math.round(MAX_FILE_BYTES / (1024*1024))} ميغابايت`;
  const mime = String(file.type || "").toLowerCase();
  const okMime = mime && (ALLOWED_MIME_EXACT.has(mime) || ALLOWED_MIME_PREFIXES.some(p => mime.startsWith(p)));
  const okExt  = ALLOWED_EXT_RE.test(file.name || "");
  if (!okMime && !okExt) return "نوع الملف غير مسموح";
  return null;
}
function currentUploader() {
  try {
    const s = (typeof window !== "undefined" && window.__authSession) || null;
    const u = s && s.user;
    if (!u) return { id: null, name: "" };
    const md = u.user_metadata || {};
    return { id: u.id || null, name: md.name || md.full_name || u.email || "" };
  } catch { return { id: null, name: "" }; }
}

// Upload one file for a patient. Requires Supabase. Persists metadata
// only; the binary lives in Storage. Rolls the Storage upload back if
// the DB insert fails. Returns { ok, row?, error? }.
async function uploadPatientFile(patientId, file, onProgress) {
  if (!sb) return { ok: false, error: "لم يتم تكوين قاعدة البيانات" };
  if (!patientId) return { ok: false, error: "معرّف المريض غير محدد" };
  const bad = validatePatientFile(file);
  if (bad) { try { window.showToast && window.showToast(bad, "error"); } catch {} return { ok: false, error: bad }; }

  const fileId = nextFileId();
  const path   = `${patientId}/${fileId}-${sanitizeFileName(file.name)}`;
  const uploader = currentUploader();
  try { onProgress && onProgress(5); } catch {}

  const { error: upErr } = await sb.storage.from(PATIENT_FILES_BUCKET)
    .upload(path, file, { cacheControl: "3600", upsert: false, contentType: file.type || undefined });
  if (upErr) {
    const msg = upErr.message || "تعذّر رفع الملف إلى التخزين";
    console.warn("uploadPatientFile storage failed", msg);
    return { ok: false, error: msg };
  }

  const { data: pub } = sb.storage.from(PATIENT_FILES_BUCKET).getPublicUrl(path);
  const publicUrl = (pub && pub.publicUrl) || "";
  const row = {
    file_id:          fileId,
    patient_id:       patientId,
    file_name:        file.name,
    original_name:    file.name,
    storage_path:     path,
    file_url:         publicUrl,
    file_type:        file.type || "",
    mime_type:        file.type || "",
    file_size:        file.size,
    uploaded_by:      uploader.id,
    uploaded_by_name: uploader.name,
    uploaded_at:      new Date().toISOString(),
  };

  const { data: inserted, error: insErr } = await sb.from("patient_files").insert(row).select().single();
  if (insErr) {
    // Compensating rollback — delete the storage object we just uploaded.
    try { await sb.storage.from(PATIENT_FILES_BUCKET).remove([path]); }
    catch (e) { console.warn("uploadPatientFile rollback failed", e); }
    const msg = insErr.message || "تعذّر حفظ بيانات الملف";
    console.warn("uploadPatientFile insert failed", msg);
    return { ok: false, error: msg };
  }

  try { onProgress && onProgress(100); } catch {}
  console.info("patient file uploaded", { file_id: fileId, patient_id: patientId, size: file.size });
  window.dispatchEvent(new CustomEvent("kinetic:patient-files-updated", { detail: { patientId } }));
  return { ok: true, row: inserted || row };
}

// List a patient's files from PostgreSQL. Newest first.
async function listPatientFiles(patientId) {
  if (!patientId) return [];
  if (!sb) return [];
  const { data, error } = await sb.from("patient_files")
    .select("*").eq("patient_id", patientId)
    .order("uploaded_at", { ascending: false });
  if (error) {
    console.warn("listPatientFiles failed", error.message || error);
    return [];
  }
  return Array.isArray(data) ? data : [];
}

// Delete a file: DB row first, then Storage object. If the object delete
// fails we surface a warning but keep the DB delete (UI stays consistent).
async function removePatientFile(fileId) {
  if (!sb) return { ok: false, error: "لم يتم تكوين قاعدة البيانات" };
  if (!fileId) return { ok: false, error: "معرّف الملف غير محدد" };

  const { data: existing, error: readErr } = await sb.from("patient_files")
    .select("storage_path,file_url,patient_id").eq("file_id", fileId).maybeSingle();
  if (readErr) {
    console.warn("removePatientFile lookup failed", readErr.message || readErr);
    return { ok: false, error: readErr.message || "تعذّر قراءة بيانات الملف" };
  }

  const { error: delErr } = await sb.from("patient_files").delete().eq("file_id", fileId);
  if (delErr) {
    console.warn("removePatientFile db delete failed", delErr.message || delErr);
    return { ok: false, error: delErr.message || "تعذّر حذف السجل" };
  }

  const path = existing && existing.storage_path;
  if (path) {
    const { error: sErr } = await sb.storage.from(PATIENT_FILES_BUCKET).remove([path]);
    if (sErr) console.warn("removePatientFile storage delete failed", sErr.message || sErr);
  }

  console.info("patient file deleted", { file_id: fileId });
  window.dispatchEvent(new CustomEvent("kinetic:patient-files-updated", { detail: { patientId: existing && existing.patient_id } }));
  return { ok: true };
}

// Signed URL for private buckets (falls back to whatever file_url already
// holds, which is a public URL when the bucket is public).
async function getPatientFileUrl(row, expiresSeconds = 3600) {
  if (!row) return "";
  if (!sb || !row.storage_path) return row.file_url || "";
  try {
    const { data, error } = await sb.storage.from(PATIENT_FILES_BUCKET)
      .createSignedUrl(row.storage_path, expiresSeconds);
    if (error) { console.warn("createSignedUrl failed", error.message || error); return row.file_url || ""; }
    return (data && data.signedUrl) || row.file_url || "";
  } catch (e) { console.warn("createSignedUrl failed", e); return row.file_url || ""; }
}

// ══════════════════════════════════════════════════════════════
// Treatment Plan Templates API
// Reads / writes public.treatment_templates via RPCs. In demo/LS
// mode, mirrors state under `kinetic.treatment_templates.v1` so
// the UI works identically without a Supabase connection.
// ══════════════════════════════════════════════════════════════
const LS_TEMPLATES         = 'kinetic.treatment_templates.v1';
const LS_TEMPLATE_USAGE    = 'kinetic.template_usage.v1';

function __tplId() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `TPL-${stamp}-${rand}`;
}
function __currentEditorName() {
  return (window.ME && (window.ME.name || window.ME.email)) || '—';
}
function __normalizeTemplate(input) {
  const errors = [];
  const name = String(input?.name || '').trim();
  if (!name) errors.push('اسم القالب مطلوب');
  const arr = (v) => Array.isArray(v) ? v : [];
  const num = (v) => (v == null || v === '') ? null : Number(v);
  return {
    errors,
    payload: {
      name,
      category:              input?.category || '',
      diagnosis:             input?.diagnosis || '',
      body_part:             input?.body_part || '',
      goals:                 arr(input?.goals).map(g => String(g||'').trim()).filter(Boolean),
      exercises:             arr(input?.exercises).map(e => ({
        name:        String(e?.name || '').trim(),
        description: String(e?.description || '').trim(),
        sets:        e?.sets || '',
        reps:        e?.reps || '',
        duration:    e?.duration || '',
        hold_time:   e?.hold_time || '',
        rest_time:   e?.rest_time || '',
        equipment:   e?.equipment || '',
        notes:       e?.notes || '',
      })).filter(e => e.name),
      methods:               arr(input?.methods).map(m => (typeof m === 'string') ? { name: m } : m).filter(m => m && m.name),
      home_instructions:     input?.home_instructions || '',
      notes:                 input?.notes || '',
      warnings:              input?.warnings || '',
      followup_instructions: input?.followup_instructions || '',
      estimated_sessions:    num(input?.estimated_sessions),
      weekly_frequency:      num(input?.weekly_frequency),
      expected_recovery_days: num(input?.expected_recovery_days),
    },
  };
}
function __tplDispatch(action, template_id) {
  window.dispatchEvent(new CustomEvent('kinetic:templates-updated', { detail: { action, template_id } }));
  window.dispatchEvent(new CustomEvent('kinetic:data-updated', { detail: { table: 'treatment_templates' } }));
}

async function listTreatmentTemplates(opts = {}) {
  const { status = '', category = '', creator = null, search = '', sort = 'recent', limit = 100, offset = 0 } = opts;
  if (sb) {
    try {
      const { data, error } = await sb.rpc('list_treatment_templates', {
        p_status:   status || null,
        p_category: category || null,
        p_creator:  creator || null,
        p_search:   search || null,
        p_sort:     sort || 'recent',
        p_limit:    limit,
        p_offset:   offset,
      });
      if (!error && data) return { rows: data.rows || [], count: data.count || 0 };
      if (error) console.warn('list_treatment_templates failed', error.message || error);
    } catch (e) { console.warn('list_treatment_templates failed', e); }
  }
  const all = readLS(LS_TEMPLATES, []);
  const q = String(search || '').toLowerCase();
  let rows = all.filter(t =>
       (!status   || t.status === status)
    && (!category || t.category === category)
    && (!q || [t.name, t.diagnosis, t.category, t.body_part, JSON.stringify(t.exercises||[]), JSON.stringify(t.methods||[])].join(' ').toLowerCase().includes(q))
  );
  if (sort === 'usage')  rows.sort((a, b) => (b.usage_count || 0) - (a.usage_count || 0));
  else if (sort === 'name') rows.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ar'));
  else if (sort === 'oldest') rows.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
  else rows.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  return { rows: rows.slice(offset, offset + limit), count: rows.length };
}

async function getTreatmentTemplate(templateId) {
  if (sb) {
    try {
      const { data, error } = await sb.rpc('get_treatment_template', { p_template_id: templateId });
      if (!error && data) return data;
      if (error) console.warn('get_treatment_template failed', error.message || error);
    } catch (e) { console.warn('get_treatment_template failed', e); }
  }
  const all = readLS(LS_TEMPLATES, []);
  const template = all.find(t => t.template_id === templateId);
  if (!template) return null;
  const uses = readLS(LS_TEMPLATE_USAGE, []).filter(u => u.template_id === templateId);
  const completed = uses.filter(u => u.completed_at).length;
  return {
    template,
    stats: {
      usage_count:     uses.length,
      completion_rate: uses.length ? Math.round(completed / uses.length * 1000) / 10 : 0,
      avg_recovery:    uses.length ? Math.round(uses.reduce((s, u) => s + (u.recovery_days || 0), 0) / uses.length * 10) / 10 : 0,
      last_used_at:    uses.reduce((a, u) => (u.applied_at > a ? u.applied_at : a), ''),
    },
  };
}

async function createTreatmentTemplate(input) {
  const { errors, payload } = __normalizeTemplate(input);
  if (errors.length) return { ok: false, error: errors[0] };
  payload.created_by_name = __currentEditorName();
  const template_id = __tplId();

  if (sb) {
    try {
      const { data, error } = await sb.rpc('create_treatment_template', {
        p_template_id: template_id, p_payload: payload,
      });
      if (error) return { ok: false, error: error.message || 'تعذّر إنشاء القالب' };
      const outId = (data && data.template_id) || template_id;
      __tplDispatch('create', outId);
      return { ok: true, template_id: outId };
    } catch (e) { return { ok: false, error: e.message || 'تعذّر إنشاء القالب' }; }
  }

  const now = new Date().toISOString();
  const row = {
    template_id, ...payload,
    status: 'active', version: 1, usage_count: 0, last_used_at: null,
    created_by_name: payload.created_by_name,
    updated_by_name: payload.created_by_name,
    created_at: now, updated_at: now,
  };
  writeLS(LS_TEMPLATES, [...readLS(LS_TEMPLATES, []), row]);
  __tplDispatch('create', template_id);
  return { ok: true, template_id };
}

async function updateTreatmentTemplate(templateId, input, changeSummary) {
  if (!templateId) return { ok: false, error: 'معرّف مفقود' };
  const { errors, payload } = __normalizeTemplate(input);
  if (errors.length) return { ok: false, error: errors[0] };
  payload.updated_by_name = __currentEditorName();

  if (sb) {
    try {
      const { data, error } = await sb.rpc('update_treatment_template', {
        p_template_id: templateId, p_payload: payload, p_change_summary: changeSummary || null,
      });
      if (error) return { ok: false, error: error.message || 'تعذّر التحديث' };
      __tplDispatch('update', templateId);
      return { ok: true, template_id: (data && data.template_id) || templateId };
    } catch (e) { return { ok: false, error: e.message || 'تعذّر التحديث' }; }
  }

  const all = readLS(LS_TEMPLATES, []);
  const idx = all.findIndex(t => t.template_id === templateId);
  if (idx < 0) return { ok: false, error: 'القالب غير موجود' };
  const now = new Date().toISOString();
  const nextVersion = (all[idx].version || 1) + 1;
  const updated = { ...all[idx], ...payload, version: nextVersion, updated_at: now, updated_by_name: payload.updated_by_name };
  all[idx] = updated;
  writeLS(LS_TEMPLATES, all);
  __tplDispatch('update', templateId);
  return { ok: true, template_id: templateId };
}

async function duplicateTreatmentTemplate(templateId, newName) {
  if (!templateId) return { ok: false, error: 'معرّف مفقود' };
  if (sb) {
    try {
      const { data, error } = await sb.rpc('duplicate_treatment_template', {
        p_template_id: templateId, p_new_name: (newName || '').trim() || null,
      });
      if (error) return { ok: false, error: error.message || 'تعذّر النسخ' };
      const newId = data && data.template_id;
      __tplDispatch('duplicate', newId);
      return { ok: true, template_id: newId };
    } catch (e) { return { ok: false, error: e.message || 'تعذّر النسخ' }; }
  }
  const all = readLS(LS_TEMPLATES, []);
  const src = all.find(t => t.template_id === templateId);
  if (!src) return { ok: false, error: 'القالب غير موجود' };
  const now = new Date().toISOString();
  const new_id = __tplId();
  const copy = {
    ...src, template_id: new_id,
    name: (newName || '').trim() || `${src.name} — نسخة`,
    status: 'active', version: 1, usage_count: 0, last_used_at: null,
    created_by_name: __currentEditorName(), updated_by_name: __currentEditorName(),
    created_at: now, updated_at: now,
  };
  writeLS(LS_TEMPLATES, [...all, copy]);
  __tplDispatch('duplicate', new_id);
  return { ok: true, template_id: new_id };
}

async function setTreatmentTemplateStatus(templateId, status) {
  if (!templateId) return { ok: false, error: 'معرّف مفقود' };
  if (!['active', 'archived'].includes(status)) return { ok: false, error: 'حالة غير صحيحة' };
  if (sb) {
    try {
      const { data, error } = await sb.rpc('set_treatment_template_status', {
        p_template_id: templateId, p_status: status,
      });
      if (error) return { ok: false, error: error.message || 'تعذّر التحديث' };
      __tplDispatch('status', templateId);
      return { ok: true, template_id: (data && data.template_id) || templateId, status };
    } catch (e) { return { ok: false, error: e.message || 'تعذّر التحديث' }; }
  }
  const all = readLS(LS_TEMPLATES, []);
  const idx = all.findIndex(t => t.template_id === templateId);
  if (idx < 0) return { ok: false, error: 'القالب غير موجود' };
  all[idx] = { ...all[idx], status, updated_at: new Date().toISOString() };
  writeLS(LS_TEMPLATES, all);
  __tplDispatch('status', templateId);
  return { ok: true, template_id: templateId, status };
}

async function deleteTreatmentTemplate(templateId) {
  if (!templateId) return { ok: false, error: 'معرّف مفقود' };
  if (sb) {
    try {
      const { data, error } = await sb.rpc('delete_treatment_template', { p_template_id: templateId });
      if (error) return { ok: false, error: error.message || 'تعذّر الحذف' };
      __tplDispatch('delete', templateId);
      return { ok: true, template_id: templateId };
    } catch (e) { return { ok: false, error: e.message || 'تعذّر الحذف' }; }
  }
  const all = readLS(LS_TEMPLATES, []);
  const src = all.find(t => t.template_id === templateId);
  if (!src) return { ok: false, error: 'القالب غير موجود' };
  const uses = readLS(LS_TEMPLATE_USAGE, []).filter(u => u.template_id === templateId);
  if (uses.length > 0 || (src.usage_count || 0) > 0) {
    return { ok: false, error: 'لا يمكن حذف قالب مستخدم — استخدم الأرشفة بدلاً منه' };
  }
  writeLS(LS_TEMPLATES, all.filter(t => t.template_id !== templateId));
  __tplDispatch('delete', templateId);
  return { ok: true, template_id: templateId };
}

async function applyTreatmentTemplate(templateId, patientId, planId) {
  if (!templateId) return { ok: false, error: 'معرّف القالب مفقود' };
  if (sb) {
    try {
      const { data, error } = await sb.rpc('apply_template_to_patient', {
        p_template_id: templateId,
        p_patient_id:  patientId || null,
        p_plan_id:     planId || null,
      });
      if (error) return { ok: false, error: error.message || 'تعذّر التطبيق' };
      __tplDispatch('apply', templateId);
      return { ok: true, use_id: data && data.use_id };
    } catch (e) { return { ok: false, error: e.message || 'تعذّر التطبيق' }; }
  }
  const now = new Date().toISOString();
  const use_id = `TU-${now.replace(/[^0-9]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  writeLS(LS_TEMPLATE_USAGE, [...readLS(LS_TEMPLATE_USAGE, []), {
    use_id, template_id: templateId, patient_id: patientId || null, plan_id: planId || null,
    applied_by_name: __currentEditorName(), applied_at: now,
  }]);
  const all = readLS(LS_TEMPLATES, []);
  const idx = all.findIndex(t => t.template_id === templateId);
  if (idx >= 0) {
    all[idx] = { ...all[idx], usage_count: (all[idx].usage_count || 0) + 1, last_used_at: now };
    writeLS(LS_TEMPLATES, all);
  }
  __tplDispatch('apply', templateId);
  return { ok: true, use_id };
}

const Templates = {
  list:            listTreatmentTemplates,
  get:             getTreatmentTemplate,
  create:          createTreatmentTemplate,
  update:          updateTreatmentTemplate,
  duplicate:       duplicateTreatmentTemplate,
  archive:         (id) => setTreatmentTemplateStatus(id, 'archived'),
  restore:         (id) => setTreatmentTemplateStatus(id, 'active'),
  remove:          deleteTreatmentTemplate,
  apply:           applyTreatmentTemplate,
};
window.Templates = Templates;

// ══════════════════════════════════════════════════════════════
// Treatments API — real treatment records (سجلات العلاج)
// PostgreSQL only: every read/write goes through the security-definer
// RPCs (create_treatment / update_treatment / list_treatments /
// get_treatment). No localStorage mirror — a treatment is a clinical
// record, so it must never exist only in a browser.
// Creating from a template happens server-side: the RPC copies every
// clinical field of the template, merges the doctor's edits on top,
// stores template_id + version + snapshot for audit, and logs
// template_usage in the same transaction. The template row itself is
// never modified by any of these calls.
// ══════════════════════════════════════════════════════════════
function __treatmentId() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `TRT-${stamp}-${rand}`;
}
function __trtDispatch(action, treatment_id) {
  window.dispatchEvent(new CustomEvent('kinetic:treatments-updated', { detail: { action, treatment_id } }));
  window.dispatchEvent(new CustomEvent('kinetic:data-updated', { detail: { table: 'treatments' } }));
}
const __TRT_NO_DB = 'قاعدة البيانات غير متصلة — لا يمكن حفظ سجلات العلاج';

async function createTreatment(payload) {
  if (!sb) return { ok: false, error: __TRT_NO_DB };
  const treatment_id = __treatmentId();
  try {
    const { data, error } = await sb.rpc('create_treatment', {
      p_treatment_id: treatment_id, p_payload: payload || {},
    });
    if (error) return { ok: false, error: error.message || 'تعذّر حفظ العلاج' };
    __trtDispatch('create', treatment_id);
    // The RPC bumped the template's usage counter — refresh template UIs.
    if (payload && payload.template_id) __tplDispatch('apply', payload.template_id);
    return { ok: true, treatment_id, row: data || null };
  } catch (e) { return { ok: false, error: e.message || 'تعذّر حفظ العلاج' }; }
}

async function updateTreatment(treatmentId, payload) {
  if (!treatmentId) return { ok: false, error: 'معرّف العلاج مفقود' };
  if (!sb) return { ok: false, error: __TRT_NO_DB };
  try {
    const { data, error } = await sb.rpc('update_treatment', {
      p_treatment_id: treatmentId, p_payload: payload || {},
    });
    if (error) return { ok: false, error: error.message || 'تعذّر التحديث' };
    __trtDispatch('update', treatmentId);
    return { ok: true, treatment_id: treatmentId, row: data || null };
  } catch (e) { return { ok: false, error: e.message || 'تعذّر التحديث' }; }
}

async function listTreatments(opts = {}) {
  if (!sb) return { rows: [], count: 0, error: __TRT_NO_DB };
  const { patientId = null, status = '', search = '', limit = 200, offset = 0 } = opts;
  try {
    const { data, error } = await sb.rpc('list_treatments', {
      p_patient_id: patientId || null,
      p_status:     status || null,
      p_search:     search || null,
      p_limit:      limit,
      p_offset:     offset,
    });
    if (error) { console.warn('list_treatments failed', error.message || error); return { rows: [], count: 0, error: error.message }; }
    return { rows: (data && data.rows) || [], count: (data && data.count) || 0 };
  } catch (e) { console.warn('list_treatments failed', e); return { rows: [], count: 0, error: e.message }; }
}

async function getTreatment(treatmentId) {
  if (!sb || !treatmentId) return null;
  try {
    const { data, error } = await sb.rpc('get_treatment', { p_treatment_id: treatmentId });
    if (error) { console.warn('get_treatment failed', error.message || error); return null; }
    return data || null;
  } catch (e) { console.warn('get_treatment failed', e); return null; }
}

// Permanently delete one treatment plan. Linked sessions are unlinked
// server-side (FK on delete set null) — never deleted. Returns the RPC
// payload ({ deleted, sessions_unlinked }). Throws on any server error so
// the UI can show a real failure toast instead of a false success.
async function deleteTreatment(treatmentId) {
  if (!treatmentId) throw new Error('معرّف السجل مفقود');
  if (!sb) throw new Error('لا يوجد اتصال بقاعدة البيانات');
  const { data, error } = await sb.rpc('delete_treatment', { p_treatment_id: treatmentId });
  if (error) {
    console.warn('delete_treatment failed', error);
    throw new Error([error.code, error.message, error.details, error.hint].filter(Boolean).join(' · ') || 'تعذّر حذف السجل');
  }
  // Notify every listener (plans list, patient plan view, stats) to reload
  // from the database — never trust local state as the source of truth.
  window.dispatchEvent(new CustomEvent('kinetic:treatments-updated'));
  window.dispatchEvent(new CustomEvent('kinetic:data-updated', { detail: { table: 'sessions' } }));
  return data || { treatment_id: treatmentId, deleted: true };
}

// The patient's active treatment plan (خطة العلاج) — the single source the
// session screen populates itself from. Latest active plan wins.
async function activeTreatmentFor(patientId) {
  if (!patientId) return null;
  const res = await listTreatments({ patientId, status: 'active', limit: 1 });
  return (res.rows && res.rows[0]) || null;
}

const TreatmentsAPI = {
  list:      listTreatments,
  get:       getTreatment,
  create:    createTreatment,
  update:    updateTreatment,
  delete:    deleteTreatment,
  activeFor: activeTreatmentFor,
};
window.TreatmentsAPI = TreatmentsAPI;

// ══════════════════════════════════════════════════════════════
// TplCategories — DB-authoritative categories for treatment plan
// templates. Managed from Settings → قوالب خطط العلاج. Renaming
// propagates to templates.category server-side so the picker stays
// consistent. LS mirror keeps demo/offline mode working.
// ══════════════════════════════════════════════════════════════
const LS_TPL_CATEGORIES = 'kinetic.template_categories.v1';

function __tplCatDispatch() {
  window.dispatchEvent(new CustomEvent('kinetic:tpl-categories-updated'));
}

async function listTemplateCategories(includeArchived = false) {
  if (sb) {
    const { data, error } = await sb.rpc('list_template_categories', {
      p_include_archived: !!includeArchived,
    });
    if (error) return { ok: false, error: error.message, rows: [] };
    const rows = (data && data.rows) || [];
    writeLS(LS_TPL_CATEGORIES, rows);
    return { ok: true, rows };
  }
  const rows = readLS(LS_TPL_CATEGORIES, []);
  const filtered = includeArchived ? rows : rows.filter(r => r.status !== 'archived');
  return { ok: true, rows: filtered };
}

async function upsertTemplateCategory(category_id, payload) {
  const name = String((payload && payload.name) || '').trim();
  if (!name) return { ok: false, error: 'اسم الفئة مطلوب' };
  if (sb) {
    const { data, error } = await sb.rpc('upsert_template_category', {
      p_category_id: category_id || null,
      p_payload: payload,
    });
    if (error) return { ok: false, error: error.message || 'تعذّر الحفظ' };
    __tplCatDispatch();
    return { ok: true, category_id: data && data.category_id, name };
  }
  // LS fallback
  const rows = readLS(LS_TPL_CATEGORIES, []);
  const dupIdx = rows.findIndex(r =>
    String(r.name || '').trim().toLowerCase() === name.toLowerCase()
    && r.category_id !== category_id);
  if (dupIdx >= 0) return { ok: false, error: 'اسم الفئة موجود مسبقًا' };
  const id = category_id || ('TPC-LS-' + Date.now().toString(36));
  const existing = rows.find(r => r.category_id === id);
  const now = new Date().toISOString();
  const next = existing
    ? rows.map(r => r.category_id === id ? {
        ...r, name,
        description: (payload && payload.description) || null,
        sort_order: (payload && payload.sort_order != null) ? Number(payload.sort_order) : r.sort_order,
        updated_at: now,
      } : r)
    : [...rows, {
        category_id: id, name,
        description: (payload && payload.description) || null,
        sort_order: (payload && payload.sort_order != null) ? Number(payload.sort_order) : null,
        status: 'active', created_at: now, updated_at: now,
      }];
  // If renaming, propagate to LS-mirrored templates
  if (existing && existing.name !== name) {
    const tpls = readLS(LS_TEMPLATES, []);
    writeLS(LS_TEMPLATES, tpls.map(t => t.category === existing.name ? { ...t, category: name } : t));
    __tplDispatch('update', null);
  }
  writeLS(LS_TPL_CATEGORIES, next);
  __tplCatDispatch();
  return { ok: true, category_id: id, name };
}

async function setTemplateCategoryStatus(category_id, status) {
  if (!category_id) return { ok: false, error: 'معرّف مفقود' };
  if (status !== 'active' && status !== 'archived') return { ok: false, error: 'حالة غير صحيحة' };
  if (sb) {
    const { error } = await sb.rpc('set_template_category_status', {
      p_category_id: category_id, p_status: status,
    });
    if (error) return { ok: false, error: error.message || 'تعذّر التنفيذ' };
    __tplCatDispatch();
    return { ok: true, category_id, status };
  }
  const rows = readLS(LS_TPL_CATEGORIES, []);
  const next = rows.map(r => r.category_id === category_id
    ? { ...r, status, updated_at: new Date().toISOString() } : r);
  writeLS(LS_TPL_CATEGORIES, next);
  __tplCatDispatch();
  return { ok: true, category_id, status };
}

// Hard-delete a category. Blocked server-side (and in the LS mirror) when
// any template still references its name, so no template is orphaned.
async function deleteTemplateCategory(category_id) {
  if (!category_id) return { ok: false, error: 'معرّف مفقود' };
  if (sb) {
    const { data, error } = await sb.rpc('delete_template_category', {
      p_category_id: category_id,
    });
    if (error) return { ok: false, error: error.message || 'تعذّر الحذف' };
    __tplCatDispatch();
    return { ok: true, category_id: data && data.category_id };
  }
  // LS fallback: refuse when a mirrored template uses this category's name.
  const rows = readLS(LS_TPL_CATEGORIES, []);
  const cat = rows.find(r => r.category_id === category_id);
  if (!cat) return { ok: false, error: 'الفئة غير موجودة' };
  const tpls = readLS(LS_TEMPLATES, []);
  const used = tpls.filter(t => t.category === cat.name).length;
  if (used > 0) return { ok: false, error: `لا يمكن حذف الفئة — يستخدمها ${used} قالب. أعد تصنيف القوالب أو أرشِف الفئة بدلًا من حذفها.` };
  writeLS(LS_TPL_CATEGORIES, rows.filter(r => r.category_id !== category_id));
  __tplCatDispatch();
  return { ok: true, category_id };
}

const TplCategories = {
  list:    listTemplateCategories,
  create:  (payload) => upsertTemplateCategory(null, payload),
  update:  upsertTemplateCategory,
  archive: (id) => setTemplateCategoryStatus(id, 'archived'),
  restore: (id) => setTemplateCategoryStatus(id, 'active'),
  remove:  deleteTemplateCategory,
};
window.TplCategories = TplCategories;

// ── Auth-user picker helper (used by staff modals) ────────────
// Returns unlinked staff (auth) accounts of the given role — i.e.
// accounts that could still be assigned to a roster row. `linkedField`
// is the roster column that stores the FK (auth_uid). `linkedRows` is
// the current roster to filter against.
async function listAvailableAuthUsers(roleSlug, linkedRows) {
  const staff = await listTable("staff");
  const takenUids = new Set(
    (linkedRows || [])
      .map(r => r && r.auth_uid)
      .filter(Boolean)
  );
  return (staff || [])
    .filter(s => s && s.role === roleSlug && s.auth_uid && !takenUids.has(s.auth_uid))
    .map(s => ({
      auth_uid: s.auth_uid,
      staff_id: s.staff_id || s.id,
      name: s.name || "",
      email: s.email || "",
      role: s.role,
      phone: s.phone || "",
    }));
}

// ── Public API ────────────────────────────────────────────────
Object.assign(window, {
  loadClinic, saveClinic,
  loadSections, addSection, updateSection, removeSection,
  loadBranches, addBranch, updateBranch, setActiveBranch, removeBranch,
  signInEmail, signOut, getSession, getAuthStaff, STAFF_ROLES, onAuthChange,
  adminCreateUser, sendPasswordReset, updateOwnPassword, updateOwnProfile, updateStaffMember,
  adminResetPassword, adminSetStaffStatus,
  listAvailableAuthUsers,
  startDictation, printHTML, escHtml,
  KineticData, QuickPay, TxMethods, InvoicesAPI, PaymentReceipts, Templates, TplCategories, TreatmentsAPI,
  uploadPatientFile, listPatientFiles, removePatientFile, getPatientFileUrl,
});
