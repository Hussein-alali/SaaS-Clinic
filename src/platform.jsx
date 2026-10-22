// ===== src/platform.jsx =====
// Super Admin panel (docs/03-App-Flow.md A01-A07, docs/04-UI-UX-Brief.md,
// API: /api/platform/* in docs/02-TRD.md and api/README.md "Platform").
//
// Defines window.PlatformApp: a React component with no props that the boot
// router renders in the platform context (host admin.<base>, or ?platform=1
// in development — src/apiclient.jsx then sends X-Platform: 1 on every
// request). It handles its own session:
//   GET /api/auth/session → no session: super-admin login form;
//   signed in but not a Super Admin: "not authorized" + logout;
//   Super Admin: the panel.
// Screens are hash routes so the browser back button works without touching
// the boot router's URL (?platform=1 / host) and without the static server:
//   #/            A01 stats              #/clinics/<id>[/<tab>]  A04 details
//   #/clinics     A02 list (?q&status&specialty&page)
//   #/clinics/new A03 wizard             #/catalog  A05   #/plans  A06
//   #/audit       A07 (?organization_id&actor&action&from&to&page)
//
// Everything lives inside this IIFE: the only global it adds is
// window.PlatformApp (src/*.jsx share one global scope in the bundle). It
// uses window.ClinicApi (src/apiclient.jsx), the icon set (src/core.jsx) and
// the generic EmptyState / SkeletonRow / StatCard (src/ui.jsx).

(function () {
  "use strict";
  const { useState, useEffect, useRef, useCallback, useMemo } = React;
  const I = window.I;
  const Icon = window.Icon;

  // ── Icons not in src/core.jsx ────────────────────────────────
  const PI = {
    Copy: (p) => <Icon {...p} d={<><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></>}/>,
    Building: (p) => <Icon {...p} d={<><rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4M8 6h.01M12 6h.01M16 6h.01M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01"/></>}/>,
    Shield: (p) => <Icon {...p} d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>,
    Refresh: (p) => <Icon {...p} d={<><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></>}/>,
    Alert: (p) => <Icon {...p} d={<><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><path d="M12 9v4M12 17h.01"/></>}/>,
    Pause: (p) => <Icon {...p} d={<><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></>}/>,
    Play: (p) => <Icon {...p} d="m6 3 14 9-14 9V3z"/>,
  };

  // ── Rules and labels (same as the API: api/src/platform.js) ───
  const SLUG_RE = /^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])$/;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const PLAN_CODE_RE = /^[a-z0-9][a-z0-9_-]*$/;
  const MODULE_CODE_RE = /[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*/g;
  const TRANSITIONS = {
    draft: ["pending_activation"],
    pending_activation: ["active"],
    active: ["suspended"],
    suspended: ["active", "closed"],
    closed: [],
  };
  const INVITABLE = ["pending_activation", "active"];

  const ORG_STATUS = {
    draft: ["مسودة", "b-grey"],
    pending_activation: ["بانتظار التفعيل", "b-amber"],
    active: ["نشطة", "b-green"],
    suspended: ["موقوفة", "b-red"],
    closed: ["مغلقة", "pa-b-dark"],
  };
  const INVITE_STATUS = {
    pending: ["معلقة", "b-amber"],
    expired: ["منتهية", "b-grey"],
    accepted: ["مقبولة", "b-green"],
    revoked: ["ملغاة", "pa-b-dark"],
  };
  const MEMBER_STATUS = { invited: ["مدعو", "b-amber"], active: ["نشط", "b-green"], disabled: ["معطّل", "b-red"] };
  const BRANCH_STATUS = { active: ["نشط", "b-green"], inactive: ["معطّل", "b-grey"] };
  const PLAN_STATUS = { active: ["نشطة", "b-green"], archived: ["مؤرشفة", "b-grey"] };
  const CATALOG_STATUS = { active: ["متاح", "b-green"], planned: ["قريبًا", "b-amber"], inactive: ["غير متاح", "b-grey"] };
  const SUB_STATUS = { trial: "تجريبي", active: "نشط", past_due: "متأخر السداد", cancelled: "ملغى" };
  // Notes the API itself writes on subscriptions (POST /organizations).
  const SYSTEM_NOTES = { "created with the organization": "سُجّل تلقائيًا عند إنشاء العيادة" };
  const ROLE_LABEL = {
    admin: "مدير العيادة", receptionist: "موظف استقبال", doctor: "طبيب", therapist: "أخصائي", staff: "موظف",
    super_admin: "مدير المنصة",
  };
  const ACTION_LABEL = {
    "organization.create": "إنشاء عيادة",
    "organization.update": "تعديل بيانات العيادة",
    "organization.status": "تغيير حالة العيادة",
    "organization.modules": "تعديل الوحدات",
    "organization.activate": "تفعيل العيادة",
    "organization_seeded": "بذر بيانات التطوير",
    "dev_seed_applied": "بذر بيانات التطوير",
    "subscription.set": "تعديل الاشتراك",
    "plan.create": "إنشاء خطة",
    "plan.update": "تعديل خطة",
    "invitation.create": "إرسال دعوة",
    "invitation.resend": "إعادة إرسال دعوة",
    "invitation.revoke": "إلغاء دعوة",
    "invitation.accept": "قبول دعوة",
    "staff.create": "إضافة موظف",
    "staff.password_reset": "إعادة تعيين كلمة مرور",
    "staff.activate": "تفعيل موظف",
    "staff.deactivate": "تعطيل موظف",
    "member.update": "تعديل دور عضو أو فروعه",
    "user.create": "إنشاء حساب",
    "platform_admin.create": "إنشاء مدير منصة",
    "platform_admin.grant": "منح صلاحية مدير منصة",
  };
  const TARGET_LABEL = { organization: "عيادة", invitation: "دعوة", plan: "خطة", platform: "المنصة", staff: "موظف", user: "حساب", member: "عضو" };

  // ── Small helpers ────────────────────────────────────────────
  const P = (path) => "/platform" + path;
  const qs = (params) => (window.ClinicApi ? window.ClinicApi.query(params) : "");
  const pad = (n) => String(n).padStart(2, "0");
  function fmtDate(v) {
    if (!v) return "—";
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return String(v);
    const d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function fmtDateTime(v) {
    if (!v) return "—";
    const d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return fmtDate(d) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function todayIso() { return fmtDate(new Date()); }
  function plusMonths(months) { const d = new Date(); d.setMonth(d.getMonth() + months); return fmtDate(d); }
  const fmtLimit = (v, unit) => (v === null || v === undefined ? "غير محدود" : unit ? v + " " + unit : String(v));
  // "المقاعد: 3 من 10" / "المقاعد: 3 · بلا حد في الخطة" (a label first,
  // so no Arabic number agreement is needed).
  const usageText = (n, max, label) => (label ? label + ": " : "") + (max === null || max === undefined
    ? n + " · بلا حد في الخطة"
    : n + " من " + max);
  const quote = (code, names) => "«" + ((names && names[code]) || code) + "»";
  const codesIn = (text) => String(text || "").match(MODULE_CODE_RE) || [];
  const namesOf = (modules) => { const m = {}; (modules || []).forEach((x) => { m[x.code] = x.name_ar; }); return m; };
  const shortId = (id) => (id ? String(id).slice(0, 8) : "—");
  // "3 وحدات افتراضية" / "11 وحدة افتراضية" (Arabic number agreement).
  const modulesCount = (n) => (n === 0 ? "بلا وحدات افتراضية" : n === 1 ? "وحدة افتراضية واحدة" : n === 2 ? "وحدتان افتراضيتان"
    : n >= 3 && n <= 10 ? n + " وحدات افتراضية" : n + " وحدة افتراضية");

  // The clinic's address. Production: admin.<base> → <slug>.<base>. In
  // development (?platform=1 on localhost) the product domain is shown, and
  // the working development link next to it.
  function baseDomain() {
    const h = String(window.location.hostname || "").toLowerCase();
    return h.indexOf("admin.") === 0 ? h.slice(6) : "clinicsyseg.com";
  }
  function clinicUrl(slug) {
    const h = String(window.location.hostname || "").toLowerCase();
    if (h.indexOf("admin.") === 0) {
      return window.location.protocol + "//" + slug + "." + h.slice(6) + (window.location.port ? ":" + window.location.port : "") + "/";
    }
    return "https://" + slug + ".clinicsyseg.com/";
  }
  function devClinicUrl(slug) {
    const h = String(window.location.hostname || "").toLowerCase();
    if (h.indexOf("admin.") === 0) return null;
    return window.location.origin + "/?org=" + encodeURIComponent(slug);
  }

  // Arabic text for an API error {message, code, status} (no codes or
  // internals in the UI, docs/04 "Error"). `names` maps module codes to names.
  function errorText(err, names) {
    if (!err) return "";
    const code = err.code || "";
    const msg = err.message || "";
    const mods = () => codesIn(msg).map((c) => quote(c, names)).join("، ");
    switch (code) {
      case "network_error": return "تعذّر الاتصال بالخادم — تحقق من الاتصال وحاول مرة أخرى";
      case "invalid_credentials": return "بيانات الدخول غير صحيحة";
      case "too_many_attempts": return "محاولات دخول كثيرة — انتظر قليلًا ثم حاول مرة أخرى";
      case "invalid_request": return "أدخل البريد الإلكتروني وكلمة المرور";
      case "unauthorized": case "invalid_session": case "session_revoked": return "انتهت الجلسة — سجّل الدخول من جديد";
      case "not_super_admin": return "هذا الحساب ليس من مديري المنصة";
      case "platform_required": return "تعمل لوحة المنصة من عنوانها الخاص (admin) فقط";
      case "csrf_header_required": return "تعذّر إرسال الطلب — حدّث الصفحة وحاول مرة أخرى";
      case "slug_taken": return "هذا الرابط مستخدم لعيادة أخرى — اختر رابطًا آخر";
      case "slug_reserved": return "هذا الرابط محجوز للنظام — اختر رابطًا آخر";
      case "invalid_slug": return "الرابط غير صالح: من 3 إلى 32 حرفًا من a-z و 0-9 والشرطة (-)، دون شرطة في البداية أو النهاية";
      case "invalid_name": return "الاسم مطلوب (من 2 إلى 120 حرفًا)";
      case "invalid_specialty": return "اختر تخصصًا متاحًا";
      case "invalid_plan": return "اختر خطة نشطة";
      case "invalid_email": return "أدخل بريدًا إلكترونيًا صالحًا";
      case "invalid_role": return "اختر دورًا صالحًا";
      case "invalid_modules": return "قائمة الوحدات غير صالحة";
      case "unknown_module": return "وحدات غير معروفة: " + mods();
      case "module_unavailable": return "وحدات غير متاحة بعد: " + mods();
      case "module_dependency": {
        const pairs = [];
        const re = /([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*) needs ([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)/g;
        let m;
        while ((m = re.exec(msg))) pairs.push(quote(m[1], names) + " تحتاج " + quote(m[2], names));
        return "تبعيات الوحدات غير مستوفاة" + (pairs.length ? ": " + pairs.join("؛ ") : "");
      }
      case "plan_limit_modules": return "خطة العيادة لا تتضمن: " + mods();
      case "reason_required": return "اكتب سبب الإيقاف أو الإغلاق";
      case "invalid_reason": return "السبب طويل جدًا (1000 حرف على الأكثر)";
      case "invalid_transition": return "لا يمكن نقل العيادة إلى هذه الحالة من حالتها الحالية — حدّث الصفحة";
      case "invalid_status": return "حالة غير صالحة";
      case "already_member": return "هذا الشخص عضو بالفعل في العيادة";
      case "invitation_exists": return "توجد دعوة معلقة لهذا البريد — أعد إرسالها بدل إنشاء دعوة جديدة";
      case "invitation_not_pending": return "لم تعد الدعوة معلقة — حدّث القائمة";
      case "invitation_not_found": return "الدعوة غير موجودة";
      case "org_inactive": return "العيادة غير نشطة — لا يمكن إرسال دعوات لها";
      case "branch_required": return "اختر فرعًا واحدًا على الأقل لهذا الدور";
      case "invalid_branch": case "invalid_branch_ids": return "فرع غير صالح أو غير نشط";
      case "plan_limit_users": return "تجاوزت العيادة حد المستخدمين في خطتها";
      case "PL422":
        if (/branches/.test(msg)) return "تجاوزت العيادة حد الفروع في خطتها";
        if (/storage/.test(msg)) return "تجاوزت العيادة حد التخزين في خطتها";
        return "تجاوزت العيادة حد المستخدمين في خطتها";
      case "invalid_code": return "الرمز: أحرف لاتينية صغيرة وأرقام و _ أو - (40 حرفًا على الأكثر)";
      case "plan_code_taken": return "توجد خطة بالرمز نفسه";
      case "invalid_limit": return "الحدود أعداد صحيحة من 0 فأكثر، أو فارغة لغير محدود";
      case "invalid_date": return "تاريخ غير صالح — تاريخ النهاية لا يسبق تاريخ البداية";
      case "invalid_notes": return "الملاحظات طويلة جدًا (2000 حرف على الأكثر)";
      case "invalid_filter": return "قيمة تصفية غير صالحة — راجع المستخدم أو التاريخ";
      case "invalid_range": return "رقم صفحة غير صالح";
      case "nothing_to_update": return "لا توجد تغييرات للحفظ";
      case "org_not_found": return "العيادة غير موجودة";
      case "plan_not_found": return "الخطة غير موجودة";
      case "client_missing": return "تعذّر تحميل عميل الاتصال — حدّث الصفحة";
      default: break;
    }
    if (err.status === 429) return "طلبات كثيرة — انتظر قليلًا ثم حاول مرة أخرى";
    if (err.status >= 500) return "حدث خطأ في الخادم — حاول مرة أخرى";
    if (err.status === 404) return "العنصر المطلوب غير موجود";
    if (err.status === 403) return "ليست لديك صلاحية لهذه العملية";
    return "تعذّر تنفيذ العملية";
  }

  // ── API access ───────────────────────────────────────────────
  // Every panel request goes through call(): a 401 ends the panel session
  // (back to the login form); 403 not_super_admin / platform_required
  // replace the panel with the matching blocked screen.
  const sessionHooks = { lost: null, blocked: null };
  function call(method, path, body) {
    const api = window.ClinicApi;
    if (!api) {
      return Promise.resolve({ ok: false, status: 0, data: null, error: { code: "client_missing", message: "", status: 0 } });
    }
    return api.request(method, path, body).then((res) => {
      if (res.status === 401 && sessionHooks.lost) sessionHooks.lost();
      else if (res.status === 403 && res.error && sessionHooks.blocked &&
        (res.error.code === "not_super_admin" || res.error.code === "platform_required")) {
        sessionHooks.blocked(res.error.code);
      }
      return res;
    });
  }

  // Catalog reads that never change while the panel is open (A05 is
  // read-only) are cached for the page's lifetime.
  const apiCache = new Map();

  // GET `path` (null = nothing) → {loading, data, error, reload, setData}.
  // Data stays visible while a reload runs.
  function useApi(path, opts) {
    const cache = !!(opts && opts.cache);
    const [state, setState] = useState(() =>
      cache && path && apiCache.has(path)
        ? { loading: false, data: apiCache.get(path), error: null, path }
        : { loading: !!path, data: null, error: null, path });
    const [tick, setTick] = useState(0);
    useEffect(() => {
      if (!path) { setState({ loading: false, data: null, error: null, path }); return undefined; }
      if (cache && tick === 0 && apiCache.has(path)) {
        setState({ loading: false, data: apiCache.get(path), error: null, path });
        return undefined;
      }
      let alive = true;
      setState((s) => ({ loading: true, data: s.data, error: null, path }));
      call("GET", path).then((res) => {
        if (!alive) return;
        if (res.ok) {
          if (cache) apiCache.set(path, res.data);
          setState({ loading: false, data: res.data, error: null, path });
        } else {
          setState({ loading: false, data: null, error: res.error, path });
        }
      });
      return () => { alive = false; };
    }, [path, tick, cache]);
    const reload = useCallback(() => setTick((t) => t + 1), []);
    const setData = useCallback((data) => setState((s) => ({ ...s, data })), []);
    return { loading: state.loading, data: state.data, error: state.error, reload, setData };
  }

  // Shared supabase-compatible auth (src/apiclient.jsx): signing in and out
  // through it keeps the page's one auth state in step with the cookie.
  let authSb = null;
  function authApi() {
    if (!authSb && window.supabase && typeof window.supabase.createClient === "function") {
      authSb = window.supabase.createClient();
    }
    return authSb ? authSb.auth : null;
  }

  // ── Toasts (docs/04: top-left, 4 seconds) ────────────────────
  const toastHub = { push: null };
  function toast(msg, kind) { if (toastHub.push) toastHub.push(msg, kind || "success"); }

  // ── Navigation (hash routes) ─────────────────────────────────
  const nav = { go: (hash) => { window.location.hash = hash; } };
  function parseHash(hash) {
    const h = String(hash || "").replace(/^#/, "");
    const qi = h.indexOf("?");
    const pathPart = qi === -1 ? h : h.slice(0, qi);
    const query = {};
    if (qi !== -1) new URLSearchParams(h.slice(qi + 1)).forEach((v, k) => { query[k] = v; });
    const parts = pathPart.split("/").filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch (_) { return p; } });
    return { parts, query };
  }
  function routeOf(loc) {
    const { parts, query } = loc;
    if (!parts.length || parts[0] === "stats") return { name: "stats" };
    if (parts[0] === "clinics") {
      if (parts[1] === "new") return { name: "new" };
      if (parts[1]) return { name: "clinic", id: parts[1], tab: parts[2] || "general" };
      return { name: "clinics", query };
    }
    if (parts[0] === "catalog") return { name: "catalog" };
    if (parts[0] === "plans") return { name: "plans" };
    if (parts[0] === "audit") return { name: "audit", query };
    return { name: "notfound" };
  }
  const hashUrl = (hash) => window.location.pathname + window.location.search + hash;

  // ── Shared UI pieces ─────────────────────────────────────────
  function Badge({ map, value, title }) {
    const [label, cls] = (map && map[value]) || [value || "—", "b-grey"];
    return <span className={"badge " + cls} title={title}><span className="dot" aria-hidden="true"/>{label}</span>;
  }

  function Spinner({ size = 14 }) {
    return <span className="spin pa-spinner" style={{ width: size, height: size }} aria-hidden="true"/>;
  }

  const BTN_CLASS = {
    primary: "btn pa-btn-primary", secondary: "btn btn-secondary", ghost: "btn btn-ghost",
    danger: "btn pa-btn-danger", dark: "btn btn-primary",
  };
  function Btn({ kind = "secondary", busy = false, disabled = false, className = "", children, ...rest }) {
    return (
      <button type="button" {...rest} className={(BTN_CLASS[kind] || BTN_CLASS.secondary) + (className ? " " + className : "")}
        disabled={busy || disabled} aria-busy={busy ? "true" : undefined}>
        {busy && <Spinner/>}
        {children}
      </button>
    );
  }

  // Label above, error (red, announced) or help below — docs/04 "Forms".
  function Field({ id, label, required, error, help, children, style }) {
    return (
      <div className="pa-field" style={style}>
        <label className="label" htmlFor={id}>
          {label}{required && <span className="pa-req" aria-hidden="true"> *</span>}
        </label>
        {children}
        {error
          ? <div id={id + "-err"} className="pa-field-error" role="alert">{error}</div>
          : help ? <div id={id + "-help"} className="pa-help">{help}</div> : null}
      </div>
    );
  }
  const describe = (id, error, help) => ({
    id,
    "aria-invalid": error ? "true" : undefined,
    "aria-describedby": error ? id + "-err" : help ? id + "-help" : undefined,
    className: "input" + (error ? " pa-invalid" : ""),
  });

  function Alert({ kind = "blue", icon, children, action }) {
    return (
      <div className={"pa-alert pa-alert-" + kind} role={kind === "red" ? "alert" : "status"}>
        <span className="pa-alert-icon" aria-hidden="true">{icon || <PI.Alert size={16}/>}</span>
        <div className="grow">{children}</div>
        {action}
      </div>
    );
  }

  function ErrorBox({ error, onRetry, names }) {
    return (
      <Alert kind="red" action={onRetry && <Btn kind="secondary" onClick={onRetry}><PI.Refresh size={14}/> إعادة المحاولة</Btn>}>
        {errorText(error, names)}
      </Alert>
    );
  }

  function Empty({ icon, title, body, action }) {
    const E = window.EmptyState;
    if (E) return <E icon={icon} title={title} body={body} action={action}/>;
    return <div className="pa-empty"><div className="h3">{title}</div><div className="muted">{body}</div>{action}</div>;
  }

  function SkeletonRows({ count = 5 }) {
    const S = window.SkeletonRow;
    return <div aria-busy="true" aria-label="جارٍ التحميل">{S ? <S count={count}/> : <div className="skel" style={{ height: 120 }}/>}</div>;
  }

  // Accessible dialog: role=dialog, focus moved inside and trapped, Esc and
  // the backdrop close it (unless onClose is null, e.g. while saving).
  function PModal({ title, onClose, children, footer, width = 520, danger }) {
    const ref = useRef(null);
    const titleId = React.useId();
    const closeRef = useRef(onClose);
    closeRef.current = onClose;
    useEffect(() => {
      const prev = document.activeElement;
      const el = ref.current;
      const focusables = () => Array.from(el.querySelectorAll(
        'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'));
      const first = el.querySelector("[data-autofocus]") || el.querySelector("input:not([disabled]),select,textarea") || focusables()[0];
      if (first) first.focus();
      const onKey = (e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          if (closeRef.current) closeRef.current();
        } else if (e.key === "Tab") {
          const list = focusables();
          if (!list.length) return;
          const a = list[0], b = list[list.length - 1];
          if (e.shiftKey && document.activeElement === a) { e.preventDefault(); b.focus(); }
          else if (!e.shiftKey && document.activeElement === b) { e.preventDefault(); a.focus(); }
        }
      };
      document.addEventListener("keydown", onKey, true);
      return () => {
        document.removeEventListener("keydown", onKey, true);
        if (prev && typeof prev.focus === "function" && document.contains(prev)) prev.focus();
      };
    }, []);
    return (
      <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && closeRef.current) closeRef.current(); }}>
        <div className="modal" ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} style={{ width }}>
          <div className="pa-modal-head">
            <div className="h3" id={titleId} style={danger ? { color: "#A8443A" } : undefined}>{title}</div>
            <button type="button" className="btn btn-ghost btn-icon" aria-label="إغلاق" onClick={() => closeRef.current && closeRef.current()}
              disabled={!onClose}><I.X size={16}/></button>
          </div>
          <div className="pa-modal-body">{children}</div>
          {footer && <div className="pa-modal-foot">{footer}</div>}
        </div>
      </div>
    );
  }

  function ConfirmModal({ title, body, confirmLabel, kind = "primary", onConfirm, onClose }) {
    const [busy, setBusy] = useState(false);
    async function go() {
      setBusy(true);
      const keep = await onConfirm();
      if (keep === false) setBusy(false);
    }
    return (
      <PModal title={title} onClose={busy ? null : onClose} danger={kind === "danger"} footer={<>
        <Btn kind="secondary" onClick={onClose} disabled={busy}>رجوع</Btn>
        <Btn kind={kind} busy={busy} onClick={go} data-autofocus="">{confirmLabel}</Btn>
      </>}>
        <div style={{ fontSize: 13.5, lineHeight: 1.7 }}>{body}</div>
      </PModal>
    );
  }

  function CopyButton({ text, label = "نسخ الرابط" }) {
    const [done, setDone] = useState(false);
    async function copy() {
      let ok = false;
      try { await navigator.clipboard.writeText(text); ok = true; } catch (_) { ok = false; }
      if (!ok) {
        try {
          const ta = document.createElement("textarea");
          ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
          document.body.appendChild(ta); ta.select(); ok = document.execCommand("copy"); ta.remove();
        } catch (_) { ok = false; }
      }
      if (ok) { setDone(true); toast("نُسخ الرابط"); setTimeout(() => setDone(false), 1500); }
      else toast("تعذّر النسخ — انسخ الرابط يدويًا", "error");
    }
    return (
      <button type="button" className="btn btn-ghost btn-icon" aria-label={label} title={label} onClick={copy}>
        {done ? <I.Check size={14}/> : <PI.Copy size={14}/>}
      </button>
    );
  }

  function Pager({ offset, limit, count, loading, onPage }) {
    if (!count) return null;
    const page = Math.floor(offset / limit) + 1;
    const pages = Math.max(1, Math.ceil(count / limit));
    return (
      <nav className="pa-pager" aria-label="الصفحات">
        <span className="muted">عرض <span className="mono">{Math.min(offset + 1, count)}–{Math.min(offset + limit, count)}</span> من <span className="mono">{count}</span></span>
        <div className="row gap-2">
          <Btn kind="secondary" disabled={page <= 1 || loading} onClick={() => onPage(page - 1)}>السابق</Btn>
          <span className="mono" aria-live="polite">{page} / {pages}</span>
          <Btn kind="secondary" disabled={page >= pages || loading} onClick={() => onPage(page + 1)}>التالي</Btn>
        </div>
      </nav>
    );
  }

  function Kv({ rows }) {
    return (
      <dl className="pa-kv">
        {rows.filter(Boolean).map(([k, v], i) => (
          <React.Fragment key={i}><dt>{k}</dt><dd>{v}</dd></React.Fragment>
        ))}
      </dl>
    );
  }

  const Ltr = ({ children, className }) => <bdi dir="ltr" className={className}>{children}</bdi>;
  // Dates are isolated left-to-right: after Arabic text the bidi algorithm
  // would otherwise show 2027-04-22 as 22-04-2027. In plain strings
  // (toasts) ltrText() adds the Unicode isolates instead.
  const DateText = ({ value, time }) => <Ltr className="mono pa-nowrap">{time ? fmtDateTime(value) : fmtDate(value)}</Ltr>;
  const ltrText = (text) => "\u2066" + text + "\u2069";

  // A .tbl that becomes one card per row on phones (docs/04 "Layout rules":
  // < 640px tables turn into cards). After every render each cell gets its
  // column title as data-label, which the phone CSS shows before the value.
  function CardTable({ children, ...rest }) {
    const ref = useRef(null);
    React.useLayoutEffect(() => {
      const table = ref.current;
      if (!table) return;
      const heads = Array.from(table.querySelectorAll("thead th")).map((th) => (th.querySelector(".pa-sr") ? "" : th.textContent.trim()));
      table.querySelectorAll("tbody tr").forEach((tr) => {
        Array.from(tr.children).forEach((td, i) => {
          const label = td.colSpan > 1 ? "" : heads[i] || "";
          if (label) { if (td.getAttribute("data-label") !== label) td.setAttribute("data-label", label); }
          else if (td.hasAttribute("data-label")) td.removeAttribute("data-label");
        });
      });
    });
    return <table ref={ref} className="tbl pa-tbl" {...rest}>{children}</table>;
  }

  // ── Module dependencies (docs/05 "Data validation") ──────────
  // Enabling needs every depends_on (transitively); disabling is refused
  // while an enabled module depends on it. Returns null or {text, fix}.
  function moduleToggleProblem(catalog, enabled, code, next) {
    const byCode = new Map(catalog.map((m) => [m.code, m]));
    const names = namesOf(catalog);
    if (next) {
      const missing = [];
      const seen = new Set();
      const visit = (c) => {
        ((byCode.get(c) || {}).depends_on || []).forEach((d) => {
          if (seen.has(d)) return;
          seen.add(d);
          if (!enabled.has(d)) missing.push(d);
          visit(d);
        });
      };
      visit(code);
      if (!missing.length) return null;
      const fixable = missing.every((c) => byCode.has(c) && byCode.get(c).status === "active");
      return {
        text: "لا يمكن تفعيل " + quote(code, names) + " قبل تفعيل: " + missing.map((c) => quote(c, names)).join("، "),
        fix: fixable ? missing : null,
      };
    }
    const dependents = catalog.filter((m) => enabled.has(m.code) && (m.depends_on || []).indexOf(code) !== -1).map((m) => m.code);
    if (!dependents.length) return null;
    return { text: "لا يمكن تعطيل " + quote(code, names) + ": تعتمد عليها وحدات مفعّلة: " + dependents.map((c) => quote(c, names)).join("، "), fix: null };
  }

  // Grouped toggle list (docs/04 "Module toggle list"): core / specialty,
  // one switch per module, "depends on" chips, planned modules disabled.
  function ModuleList({ catalog, enabled, pending, errors, planModules, onToggle, onFix, disabled }) {
    const names = namesOf(catalog);
    const groups = [
      ["core", "النواة المشتركة", "متاحة لكل التخصصات"],
      ["specialty", "الوحدات التخصصية", "حسب تخصص العيادة"],
    ];
    return (
      <div className="pa-modules">
        {groups.map(([cat, title, sub]) => {
          const list = catalog.filter((m) => m.category === cat);
          if (!list.length) return null;
          return (
            <section key={cat} className="pa-mod-group" aria-label={title}>
              <div className="pa-mod-group-head"><span className="h3">{title}</span><span className="muted" style={{ fontSize: 12 }}>{sub}</span></div>
              {list.map((m) => {
                const isPending = pending && Object.prototype.hasOwnProperty.call(pending, m.code);
                const on = isPending ? pending[m.code] : enabled.has(m.code);
                const unavailable = m.status !== "active";
                const outsidePlan = !on && cat !== "core" && Array.isArray(planModules) && planModules.indexOf(m.code) === -1;
                const dis = disabled || isPending || (unavailable && !on) || outsidePlan;
                const err = errors && errors[m.code];
                const hintId = "pa-mod-" + m.code.replace(/\W/g, "-");
                return (
                  <div key={m.code} className="pa-mod-row" data-module={m.code}>
                    <button type="button" role="switch" aria-checked={on ? "true" : "false"} aria-label={m.name_ar}
                      aria-describedby={hintId} className={"switch pa-switch" + (on ? " on" : "")} disabled={dis}
                      onClick={() => onToggle(m.code, !on)}>
                      <span className="knob"/>
                    </button>
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="row gap-2" style={{ flexWrap: "wrap" }}>
                        <span style={{ fontWeight: 600 }}>{m.name_ar}</span>
                        <Ltr className="mono pa-code">{m.code}</Ltr>
                        {unavailable && <Badge map={CATALOG_STATUS} value={m.status}/>}
                        {isPending && <Spinner size={12}/>}
                      </div>
                      <div id={hintId} className="pa-help">
                        {(m.depends_on || []).length > 0 && <span>يعتمد على: {(m.depends_on || []).map((d) => (
                          <span key={d} className={"badge " + (on && !enabled.has(d) && !isPending ? "b-red" : "b-grey")} style={{ marginInlineStart: 4 }}>{names[d] || d}</span>
                        ))}</span>}
                        {unavailable && <span> لم تُطلق بعد ولا يمكن تفعيلها.</span>}
                        {outsidePlan && <span> غير مشمولة في الخطة.</span>}
                      </div>
                      {err && (
                        <div className="pa-field-error" role="alert">
                          {err.text}
                          {err.fix && onFix && <> <button type="button" className="pa-link" onClick={() => onFix(m.code, err.fix)}>فعّلها كلها معًا</button></>}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </section>
          );
        })}
      </div>
    );
  }

  // ══════════════════════════════════════════════════════════════
  // A01 — platform stats
  // ══════════════════════════════════════════════════════════════
  function StatsPage() {
    const stats = useApi(P("/stats"));
    const recent = useApi(P("/audit") + qs({ limit: 8 }));
    const s = stats.data;
    const StatCard = window.StatCard;
    const cards = [
      { key: "active", label: "عيادات نشطة", value: s && s.organizations.active, accent: "#3FA984", icon: <I.Check size={15}/>, href: "#/clinics?status=active" },
      { key: "suspended", label: "عيادات موقوفة", value: s && s.organizations.suspended, accent: "#D8665A", icon: <PI.Pause size={14}/>, href: "#/clinics?status=suspended" },
      { key: "pending_activation", label: "بانتظار التفعيل", value: s && s.organizations.pending_activation, accent: "#D49044", icon: <I.Clock size={15}/>, href: "#/clinics?status=pending_activation" },
      { key: "pending_invitations", label: "دعوات معلقة", value: s && s.pending_invitations, accent: "#7E6BD3", icon: <I.Mail size={15}/> },
      { key: "retention_overdue", label: "تجاوزت مدة الاحتفاظ", value: s && s.retention_overdue, accent: "#D8665A", icon: <PI.Alert size={15}/>, href: "#/clinics?status=suspended" },
    ];
    return (
      <>
        <div className="page-head">
          <div>
            <h1 className="h1">مؤشرات المنصة</h1>
            <div className="muted" style={{ marginTop: 4 }}>
              {s ? <>إجمالي العيادات: <span className="mono">{s.organizations.total}</span>{s.organizations.closed ? <> · مغلقة: <span className="mono">{s.organizations.closed}</span></> : null}</> : " "}
            </div>
          </div>
          <div className="page-actions">
            <a className="btn pa-btn-primary" href="#/clinics/new"><I.Plus size={15}/> إنشاء عيادة</a>
          </div>
        </div>
        {stats.error && <ErrorBox error={stats.error} onRetry={stats.reload}/>}
        <div className="grid-stats" style={{ marginBottom: 22 }} aria-busy={stats.loading ? "true" : undefined}>
          {cards.map((c) => {
            const body = s && StatCard
              ? <StatCard label={c.label} value={c.value} accent={c.accent} icon={c.icon}/>
              : <div className="card" style={{ padding: 18 }}><div className="skel" style={{ height: 12, width: "60%", marginBottom: 14 }}/><div className="skel" style={{ height: 24, width: 50 }}/></div>;
            const label = c.label + ": " + (c.value === undefined || c.value === null ? "…" : c.value);
            return c.href
              ? <a key={c.key} href={c.href} className="pa-card-link" data-stat={c.key} aria-label={label}>{body}</a>
              : <div key={c.key} data-stat={c.key} role="group" aria-label={label}>{body}</div>;
          })}
        </div>
        <div className="card">
          <div className="pa-card-head">
            <h2 className="h3">أحدث العمليات</h2>
            <a href="#/audit" className="pa-link">عرض السجل كاملًا</a>
          </div>
          {recent.error ? <div style={{ padding: 16 }}><ErrorBox error={recent.error} onRetry={recent.reload}/></div>
            : <AuditTable rows={recent.data ? recent.data.data : null} loading={recent.loading && !recent.data} compact/>}
        </div>
      </>
    );
  }

  // ══════════════════════════════════════════════════════════════
  // A02 — clinics list
  // ══════════════════════════════════════════════════════════════
  const CLINICS_PAGE = 20;
  function ClinicsPage({ query }) {
    const specs = useApi(P("/specialties"), { cache: true });
    const q = query.q || "";
    const status = ORG_STATUS[query.status] ? query.status : "";
    const specialty = query.specialty || "";
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const offset = (page - 1) * CLINICS_PAGE;
    const [text, setText] = useState(q);
    useEffect(() => { setText(q); }, [q]);
    const setQuery = useCallback((patch) => {
      const next = { q, status, specialty, page: String(page), ...patch };
      if (next.page === "1" || next.page === 1) delete next.page;
      nav.go("#/clinics" + qs(next), { replace: true });
    }, [q, status, specialty, page]);
    useEffect(() => {
      if (text.trim() === q) return undefined;
      const t = setTimeout(() => setQuery({ q: text.trim(), page: 1 }), 300);
      return () => clearTimeout(t);
    }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

    const list = useApi(P("/organizations") + qs({ q: q || null, status: status || null, specialty: specialty || null, limit: CLINICS_PAGE, offset }));
    const specName = useMemo(() => {
      const m = {};
      (specs.data || []).forEach((s) => { m[s.code] = s.name_ar; });
      return m;
    }, [specs.data]);
    const rows = list.data ? list.data.data : null;
    const filtered = !!(q || status || specialty);
    const searchId = React.useId(), statusId = React.useId(), specId = React.useId();

    return (
      <>
        <div className="page-head">
          <div>
            <h1 className="h1">العيادات</h1>
            <div className="muted" style={{ marginTop: 4 }}>
              {list.data ? <><span className="mono">{list.data.count}</span> عيادة{filtered ? " مطابقة" : ""}</> : " "}
            </div>
          </div>
          <div className="page-actions">
            <a className="btn pa-btn-primary" href="#/clinics/new"><I.Plus size={15}/> إنشاء عيادة</a>
          </div>
        </div>

        <div className="card">
          <div className="pa-filters" role="search">
            <div className="pa-filter pa-filter-grow">
              <label className="label" htmlFor={searchId}>بحث بالاسم أو الرابط</label>
              <div style={{ position: "relative" }}>
                <I.Search size={15} style={{ position: "absolute", insetInlineStart: 11, top: "50%", transform: "translateY(-50%)", color: "var(--ink-400)" }}/>
                <input id={searchId} className="input" type="search" value={text} onChange={(e) => setText(e.target.value)}
                  placeholder="اسم العيادة أو الرابط" style={{ paddingInlineStart: 34 }}/>
              </div>
            </div>
            <div className="pa-filter">
              <label className="label" htmlFor={statusId}>الحالة</label>
              <select id={statusId} className="input" value={status} onChange={(e) => setQuery({ status: e.target.value, page: 1 })}>
                <option value="">كل الحالات</option>
                {Object.keys(ORG_STATUS).map((k) => <option key={k} value={k}>{ORG_STATUS[k][0]}</option>)}
              </select>
            </div>
            <div className="pa-filter">
              <label className="label" htmlFor={specId}>التخصص</label>
              <select id={specId} className="input" value={specialty} onChange={(e) => setQuery({ specialty: e.target.value, page: 1 })}>
                <option value="">كل التخصصات</option>
                {(specs.data || []).map((s) => <option key={s.code} value={s.code}>{s.name_ar}</option>)}
              </select>
            </div>
            {filtered && (
              <div className="pa-filter" style={{ alignSelf: "flex-end" }}>
                <Btn kind="ghost" onClick={() => { setText(""); nav.go("#/clinics", { replace: true }); }}><I.X size={14}/> مسح التصفية</Btn>
              </div>
            )}
          </div>

          {list.error ? <div style={{ padding: 16 }}><ErrorBox error={list.error} onRetry={list.reload}/></div> : (
            <div className="tbl-scroll" aria-busy={list.loading ? "true" : undefined}>
              <CardTable>
                <thead>
                  <tr><th>العيادة</th><th>التخصص</th><th>الحالة</th><th>الخطة</th><th>الأعضاء</th><th>دعوات معلقة</th><th>أُنشئت</th></tr>
                </thead>
                <tbody>
                  {!rows && <tr><td colSpan={7} style={{ padding: 0 }}><SkeletonRows count={6}/></td></tr>}
                  {rows && rows.length === 0 && (
                    <tr><td colSpan={7} className="tbl-empty">
                      {filtered
                        ? <Empty icon={<I.Search size={22}/>} title="لا نتائج مطابقة" body="غيّر كلمات البحث أو التصفية."
                            action={<Btn kind="secondary" onClick={() => { setText(""); nav.go("#/clinics", { replace: true }); }}>مسح التصفية</Btn>}/>
                        : <Empty icon={<PI.Building size={22}/>} title="لا توجد عيادات بعد" body="أنشئ أول عيادة وأرسل دعوة لمديرها."
                            action={<a className="btn pa-btn-primary" href="#/clinics/new"><I.Plus size={15}/> أنشئ أول عيادة</a>}/>}
                    </td></tr>
                  )}
                  {rows && rows.map((o) => (
                    <tr key={o.id} data-clickable="true" tabIndex={0} data-slug={o.slug}
                      onClick={(e) => { if (!e.target.closest("a")) nav.go("#/clinics/" + o.id); }}
                      onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) nav.go("#/clinics/" + o.id); }}>
                      <td>
                        <a href={"#/clinics/" + o.id} style={{ fontWeight: 600, color: "var(--ink-900)" }}>{o.name}</a>
                        <div><Ltr className="mono pa-code">{o.slug}</Ltr></div>
                      </td>
                      <td><span className="badge b-violet">{specName[o.specialty_code] || o.specialty_code}</span></td>
                      <td>
                        <Badge map={ORG_STATUS} value={o.status}/>
                        {o.status === "suspended" && o.retention_until && (
                          <div className={new Date(o.retention_until).getTime() < Date.now() ? "pa-bad" : "muted"} style={{ fontSize: 11.5, marginTop: 3 }} data-retention-until="">
                            محفوظة حتى <DateText value={o.retention_until}/>
                          </div>
                        )}
                      </td>
                      <td>{o.plan_name || <span className="muted">—</span>}</td>
                      <td className="mono">{o.active_members}</td>
                      <td className="mono">{o.pending_invitations}</td>
                      <td><DateText value={o.created_at}/></td>
                    </tr>
                  ))}
                </tbody>
              </CardTable>
            </div>
          )}
          {list.data && <Pager offset={offset} limit={CLINICS_PAGE} count={list.data.count} loading={list.loading} onPage={(p) => setQuery({ page: p })}/>}
        </div>
      </>
    );
  }

  // ══════════════════════════════════════════════════════════════
  // A03 — create a clinic (4-step wizard)
  // ══════════════════════════════════════════════════════════════
  const SLUG_MESSAGES = {
    checking: ["checking", "جارٍ التحقق من الرابط…"],
    available: ["ok", "متاح"],
    taken: ["bad", "مستخدم — اختر رابطًا آخر"],
    reserved: ["bad", "محجوز للنظام — اختر رابطًا آخر"],
    invalid: ["bad", "غير صالح: من 3 إلى 32 حرفًا من a-z و 0-9 والشرطة (-)، دون شرطة في البداية أو النهاية"],
    error: ["bad", "تعذّر التحقق من الرابط — حاول مرة أخرى"],
  };

  // Live availability (docs/03 "فحص الـ slug"): format checked locally, then
  // GET /slug-available after 400 ms of no typing; stale answers ignored.
  function useSlugCheck(slug, nonce) {
    const [st, setSt] = useState({ state: "idle", slug: "" });
    useEffect(() => {
      if (!slug) { setSt({ state: "idle", slug }); return undefined; }
      if (!SLUG_RE.test(slug)) { setSt({ state: "invalid", slug }); return undefined; }
      setSt({ state: "checking", slug });
      let alive = true;
      const t = setTimeout(() => {
        call("GET", P("/slug-available") + qs({ slug })).then((res) => {
          if (!alive) return;
          if (!res.ok) { setSt({ state: "error", slug, error: res.error }); return; }
          const d = res.data || {};
          const state = d.available ? "available" : d.reason === "invalid_format" ? "invalid" : d.reason === "reserved" ? "reserved" : "taken";
          setSt({ state, slug });
        });
      }, 400);
      return () => { alive = false; clearTimeout(t); };
    }, [slug, nonce]);
    return st;
  }

  function SlugField({ value, onChange, check, error, onRetry }) {
    const id = React.useId();
    const current = check.slug === value ? check.state : value ? "checking" : "idle";
    const msg = SLUG_MESSAGES[current];
    const showError = error && (current === "idle" || current === "available" || current === "checking");
    const bad = (msg && msg[0] === "bad") || !!showError;
    return (
      <div className="pa-field">
        <label className="label" htmlFor={id}>رابط العيادة<span className="pa-req" aria-hidden="true"> *</span></label>
        <div className="pa-slug" dir="ltr">
          <input id={id} className={"input mono" + (bad ? " pa-invalid" : "")} dir="ltr" value={value} autoComplete="off" spellCheck={false}
            inputMode="url" maxLength={63} placeholder="ahmad" aria-invalid={bad ? "true" : undefined}
            aria-describedby={id + "-msg " + id + "-help"} onChange={(e) => onChange(e.target.value.toLowerCase().replace(/\s+/g, ""))}/>
          <span className="pa-slug-suffix mono">.{baseDomain()}</span>
        </div>
        <div id={id + "-msg"} className="pa-slug-msg" role="status" aria-live="polite" data-state={current}>
          {current === "checking" && <><Spinner size={12}/> {msg[1]}</>}
          {current === "available" && !showError && <span className="pa-ok"><I.Check size={13}/> {msg[1]}</span>}
          {msg && msg[0] === "bad" && <span className="pa-bad"><I.X size={13}/> {msg[1]}</span>}
          {current === "error" && onRetry && <button type="button" className="pa-link" onClick={onRetry}>إعادة المحاولة</button>}
          {showError && <span className="pa-bad">{error}</span>}
        </div>
        <div id={id + "-help"} className="pa-help">أحرف لاتينية صغيرة وأرقام وشرطة؛ يصبح عنوان العيادة ولا يتغير لاحقًا بسهولة.</div>
      </div>
    );
  }

  const WIZARD_STEPS = ["البيانات", "التخصص والميزات", "الخطة", "أول مدير"];

  function slugFromName(name) {
    if (!/^[\x20-\x7e]+$/.test(name)) return "";
    return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "");
  }

  function planOutside(plan, modules) {
    if (!plan || !Array.isArray(plan.included_modules)) return [];
    return [...modules].filter((c) => c.indexOf("core.") !== 0 && plan.included_modules.indexOf(c) === -1);
  }

  function WizardPage({ guardRef }) {
    const specs = useApi(P("/specialties"), { cache: true });
    const mods = useApi(P("/modules"), { cache: true });
    const plans = useApi(P("/plans"));
    const [step, setStep] = useState(1);
    const [f, setF] = useState({ name: "", slug: "", slugEdited: false, specialty: "", modules: new Set(), planId: "", email: "" });
    const [errors, setErrors] = useState({});
    const [modErrors, setModErrors] = useState({});
    const [specNote, setSpecNote] = useState("");
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState(null);
    const [confirmCancel, setConfirmCancel] = useState(false);
    const [slugNonce, setSlugNonce] = useState(0);
    const slugCheck = useSlugCheck(f.slug, slugNonce);
    const headingRef = useRef(null);

    const catalog = mods.data || [];
    const names = useMemo(() => namesOf(catalog), [catalog]);
    const activePlans = (plans.data || []).filter((p) => p.status === "active");
    const plan = activePlans.find((p) => p.id === f.planId) || null;
    const spec = (specs.data || []).find((s) => s.code === f.specialty) || null;

    const dirty = !done && !!(f.name.trim() || f.slug || f.email.trim() || step > 1);
    const dirtyRef = useRef(dirty);
    dirtyRef.current = dirty;
    useEffect(() => {
      guardRef.current = () => dirtyRef.current;
      const onUnload = (e) => { if (dirtyRef.current) { e.preventDefault(); e.returnValue = ""; } };
      window.addEventListener("beforeunload", onUnload);
      return () => { guardRef.current = null; window.removeEventListener("beforeunload", onUnload); };
    }, [guardRef]);

    const defaultsFor = useCallback((s) => {
      const active = new Set(catalog.filter((m) => m.status === "active").map((m) => m.code));
      return new Set(((s && s.default_modules) || []).filter((c) => active.has(c)));
    }, [catalog]);

    // Preselected once the catalogs arrive: the 'default' plan, and the
    // active specialty with the most launched default modules (today
    // physio; dental / general modules are still 'planned').
    const firstSpecialty = useCallback(() => {
      let best = null, bestSize = -1;
      (specs.data || []).forEach((s) => {
        if (s.status !== "active") return;
        const size = defaultsFor(s).size;
        if (size > bestSize) { best = s; bestSize = size; }
      });
      return best;
    }, [specs.data, defaultsFor]);
    useEffect(() => {
      if (!specs.data || !mods.data || f.specialty) return;
      const first = firstSpecialty();
      if (first) setF((x) => ({ ...x, specialty: first.code, modules: defaultsFor(first) }));
    }, [specs.data, mods.data]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => {
      if (!plans.data || f.planId) return;
      const def = activePlans.find((p) => p.code === "default") || activePlans[0];
      if (def) setF((x) => ({ ...x, planId: def.id }));
    }, [plans.data]); // eslint-disable-line react-hooks/exhaustive-deps

    // Move focus to the step heading when the step changes (not on first load).
    const firstFocus = useRef(true);
    useEffect(() => {
      if (firstFocus.current) { firstFocus.current = false; return; }
      if (headingRef.current) headingRef.current.focus();
    }, [step, !!done]);

    const set = (patch) => setF((x) => ({ ...x, ...patch }));

    function onName(v) {
      const patch = { name: v };
      if (!f.slugEdited) patch.slug = slugFromName(v.trim());
      set(patch);
      if (errors.name) setErrors((e) => ({ ...e, name: null }));
    }
    function onSlug(v) {
      set({ slug: v, slugEdited: !!v });
      if (errors.slug) setErrors((e) => ({ ...e, slug: null }));
    }
    function pickSpecialty(s) {
      if (s.status !== "active" || s.code === f.specialty) return;
      set({ specialty: s.code, modules: defaultsFor(s) });
      setModErrors({});
      setSpecNote("اختيرت الوحدات الافتراضية لتخصص «" + s.name_ar + "» — يمكنك تعديلها.");
    }
    function toggleModule(code, next) {
      const problem = moduleToggleProblem(catalog, f.modules, code, next);
      if (problem) { setModErrors({ [code]: problem }); return; }
      const s = new Set(f.modules);
      if (next) s.add(code); else s.delete(code);
      set({ modules: s });
      setModErrors({});
    }
    function fixModule(code, deps) {
      const s = new Set(f.modules);
      deps.concat(code).forEach((c) => s.add(c));
      set({ modules: s });
      setModErrors({});
    }

    function validate(n) {
      const e = {};
      if (n === 1) {
        const nm = f.name.trim();
        if (nm.length < 2 || nm.length > 120) e.name = "اكتب اسم العيادة (من 2 إلى 120 حرفًا)";
        if (!f.slug) e.slug = "اختر رابط العيادة";
        else if (slugCheck.slug !== f.slug || slugCheck.state === "checking") e.slug = "انتظر انتهاء التحقق من الرابط";
        else if (slugCheck.state !== "available") e.slug = SLUG_MESSAGES[slugCheck.state] ? SLUG_MESSAGES[slugCheck.state][1] : "الرابط غير متاح";
      }
      if (n === 2 && !f.specialty) e.specialty = "اختر تخصص العيادة";
      if (n === 3) {
        if (!f.planId) e.plan = "اختر خطة";
        else {
          const outside = planOutside(plan, f.modules);
          if (outside.length) e.plan = "الخطة المختارة لا تتضمن: " + outside.map((c) => quote(c, names)).join("، ") + " — اختر خطة أخرى أو عدّل الميزات";
        }
      }
      if (n === 4 && !EMAIL_RE.test(f.email.trim())) e.email = "أدخل بريدًا إلكترونيًا صالحًا لأول مدير";
      setErrors(e);
      return !Object.keys(e).length;
    }
    function next() { if (validate(step)) setStep(step + 1); }
    function back() { setErrors({}); setStep(step - 1); }
    function cancel() { if (dirty) setConfirmCancel(true); else nav.go("#/clinics"); }

    async function create() {
      if (!validate(4)) return;
      setBusy(true);
      const res = await call("POST", P("/organizations"), {
        name: f.name.trim(), slug: f.slug, specialty_code: f.specialty, modules: [...f.modules].sort(),
        plan_id: f.planId || null, admin_email: f.email.trim().toLowerCase(),
      });
      setBusy(false);
      if (res.ok) {
        setDone(res.data);
        toast("أُنشئت العيادة «" + res.data.organization.name + "»");
        return;
      }
      const text = errorText(res.error, names);
      const where = {
        slug_taken: [1, "slug"], slug_reserved: [1, "slug"], invalid_slug: [1, "slug"], invalid_name: [1, "name"],
        invalid_specialty: [2, "specialty"], module_dependency: [2, "modules"], module_unavailable: [2, "modules"],
        unknown_module: [2, "modules"], invalid_modules: [2, "modules"], plan_limit_modules: [3, "plan"],
        invalid_plan: [3, "plan"], invalid_email: [4, "email"],
      }[res.error && res.error.code];
      if (where) {
        if (where[1] === "slug") setSlugNonce((n) => n + 1);
        setStep(where[0]);
        setErrors({ [where[1]]: text });
      } else {
        setErrors({ form: text });
      }
      toast(text, "error");
    }

    function reset() {
      setDone(null); setStep(1); setErrors({}); setModErrors({}); setSpecNote("");
      const first = firstSpecialty();
      setF({ name: "", slug: "", slugEdited: false, specialty: first ? first.code : "", modules: first ? defaultsFor(first) : new Set(), planId: f.planId, email: "" });
    }

    const loadError = specs.error || mods.error || plans.error;
    const loading = !specs.data || !mods.data || !plans.data;
    const nameId = React.useId(), emailId = React.useId();

    if (done) {
      const o = done.organization;
      const inv = done.invitation || {};
      const dev = devClinicUrl(o.slug);
      return (
        <div className="card pa-wizard" data-wizard-done="">
          <div className="pa-done">
            <div className="pa-done-icon" aria-hidden="true"><I.Check size={26}/></div>
            <h1 className="h2" tabIndex={-1} ref={headingRef}>أُنشئت العيادة «{o.name}»</h1>
            <Kv rows={[
              ["الرابط", <span className="row gap-2" style={{ flexWrap: "wrap" }}><Ltr className="mono" >{clinicUrl(o.slug)}</Ltr><CopyButton text={clinicUrl(o.slug)}/></span>],
              dev && ["رابط التطوير", <Ltr className="mono">{dev}</Ltr>],
              ["الحالة", <Badge map={ORG_STATUS} value={o.status}/>],
              ["الفرع", (done.branches && done.branches[0] && done.branches[0].name) || "الفرع الرئيسي"],
              ["الدعوة", done.email_sent === false
                ? <span className="pa-bad">أُنشئت الدعوة إلى <Ltr>{inv.email}</Ltr> لكن تعذّر إرسال البريد — أعد الإرسال من صفحة العيادة.</span>
                : <span data-invite-sent="">{done.email_sent === null ? "البريد قيد الإرسال إلى " : "أُرسلت دعوة إلى "}<Ltr className="mono">{inv.email}</Ltr> بدور «مدير العيادة»، صالحة حتى <DateText value={inv.expires_at}/>.</span>],
            ]}/>
            <div className="pa-help" style={{ marginTop: 4 }}>تصبح العيادة نشطة عندما يقبل المدير الدعوة ويعيّن كلمة المرور.</div>
            <div className="row gap-2" style={{ marginTop: 18, flexWrap: "wrap", justifyContent: "center" }}>
              <a className="btn pa-btn-primary" href={"#/clinics/" + o.id}>فتح صفحة العيادة</a>
              <Btn kind="secondary" onClick={reset}><I.Plus size={14}/> إنشاء عيادة أخرى</Btn>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="card pa-wizard">
        <ol className="stepper pa-steps" aria-label="خطوات إنشاء العيادة">
          {WIZARD_STEPS.map((label, i) => {
            const n = i + 1;
            const state = n < step ? "done" : n === step ? "current" : "next";
            return (
              <li key={label} className={"pa-step pa-step-" + state} aria-current={n === step ? "step" : undefined}>
                <span className="pa-step-num" aria-hidden="true">{n < step ? <I.Check size={12}/> : n}</span>
                <span className="step-label">{label}</span>
              </li>
            );
          })}
        </ol>

        <div className="pa-wizard-body">
          {loadError ? <ErrorBox error={loadError} onRetry={() => { specs.reload(); mods.reload(); plans.reload(); }}/> : loading ? <SkeletonRows count={4}/> : (
            <>
              <h2 className="h2" tabIndex={-1} ref={headingRef} style={{ marginBottom: 14, outline: "none" }}>
                الخطوة {step} من 4: {WIZARD_STEPS[step - 1]}
              </h2>
              {errors.form && <div style={{ marginBottom: 14 }}><Alert kind="red">{errors.form}</Alert></div>}

              {step === 1 && (
                <div className="rgrid c-sm" style={{ "--gtc": "1fr 1fr" }}>
                  <Field id={nameId} label="اسم العيادة" required error={errors.name} help="كما يظهر للموظفين في شاشة الدخول.">
                    <input {...describe(nameId, errors.name, "x")} value={f.name} maxLength={120} onChange={(e) => onName(e.target.value)} placeholder="عيادة د. أحمد للعلاج الطبيعي"/>
                  </Field>
                  <SlugField value={f.slug} onChange={onSlug} check={slugCheck} error={errors.slug} onRetry={() => setSlugNonce((n) => n + 1)}/>
                </div>
              )}

              {step === 2 && (
                <>
                  <div className="label" id="pa-spec-label">التخصص<span className="pa-req" aria-hidden="true"> *</span></div>
                  <div className="pa-choices" role="radiogroup" aria-labelledby="pa-spec-label">
                    {(specs.data || []).map((s) => {
                      const dis = s.status !== "active";
                      const count = defaultsFor(s).size;
                      return (
                        <button key={s.code} type="button" role="radio" aria-checked={f.specialty === s.code ? "true" : "false"}
                          className="pa-choice" disabled={dis} onClick={() => pickSpecialty(s)}>
                          <span className="row gap-2" style={{ justifyContent: "space-between", width: "100%" }}>
                            <b>{s.name_ar}</b>{dis && <Badge map={CATALOG_STATUS} value={s.status}/>}
                          </span>
                          <span className="muted" style={{ fontSize: 12 }}><Ltr>{s.name_en || s.code}</Ltr> · {modulesCount(count)}</span>
                        </button>
                      );
                    })}
                  </div>
                  {errors.specialty && <div className="pa-field-error" role="alert">{errors.specialty}</div>}
                  <div className="row gap-2" style={{ justifyContent: "space-between", margin: "20px 0 8px", flexWrap: "wrap" }}>
                    <div className="h3">الميزات المفعّلة ({f.modules.size})</div>
                    {spec && <Btn kind="ghost" onClick={() => { set({ modules: defaultsFor(spec) }); setModErrors({}); setSpecNote("أُعيدت الوحدات الافتراضية للتخصص."); }}><PI.Refresh size={13}/> الوحدات الافتراضية</Btn>}
                  </div>
                  {specNote && <div className="pa-help" role="status" style={{ marginBottom: 8 }}>{specNote}</div>}
                  {errors.modules && <div style={{ marginBottom: 8 }}><Alert kind="red">{errors.modules}</Alert></div>}
                  <div className="pa-box">
                    <ModuleList catalog={catalog} enabled={f.modules} errors={modErrors} onToggle={toggleModule} onFix={fixModule}/>
                  </div>
                </>
              )}

              {step === 3 && (
                <>
                  <div className="label" id="pa-plan-label">الخطة<span className="pa-req" aria-hidden="true"> *</span></div>
                  {activePlans.length === 0 && <Alert kind="amber">لا توجد خطط نشطة — أنشئ خطة من صفحة «الخطط».</Alert>}
                  <div className="pa-choices" role="radiogroup" aria-labelledby="pa-plan-label">
                    {activePlans.map((p) => (
                      <button key={p.id} type="button" role="radio" aria-checked={f.planId === p.id ? "true" : "false"}
                        className="pa-choice" onClick={() => { set({ planId: p.id }); setErrors({}); }}>
                        <span className="row gap-2" style={{ justifyContent: "space-between", width: "100%" }}>
                          <b>{p.name}</b><Ltr className="mono pa-code">{p.code}</Ltr>
                        </span>
                        <PlanLimits plan={p}/>
                      </button>
                    ))}
                  </div>
                  {errors.plan && <div className="pa-field-error" role="alert">{errors.plan}</div>}
                  <div style={{ marginTop: 16 }}>
                    <Alert kind="amber" icon={<I.Clock size={16}/>}>
                      الحالة عند الإنشاء: <Badge map={ORG_STATUS} value="pending_activation"/> — تصبح العيادة نشطة عندما يقبل أول مدير دعوته.
                    </Alert>
                  </div>
                </>
              )}

              {step === 4 && (
                <div className="rgrid c-lg" style={{ "--gtc": "1fr 1.2fr" }}>
                  <div>
                    <Field id={emailId} label="بريد أول مدير للعيادة" required error={errors.email} help="تُرسل إليه دعوة بدور «مدير العيادة» صالحة 7 أيام.">
                      <input {...describe(emailId, errors.email, "x")} type="email" dir="ltr" autoComplete="off" value={f.email}
                        onChange={(e) => { set({ email: e.target.value }); if (errors.email) setErrors({}); }}
                        onKeyDown={(e) => { if (e.key === "Enter") create(); }} placeholder="admin@clinic.com"/>
                    </Field>
                  </div>
                  <div className="pa-summary" aria-label="ملخص قبل الإنشاء">
                    <div className="h3" style={{ marginBottom: 10 }}>ملخص قبل الإنشاء</div>
                    <Kv rows={[
                      ["الاسم", f.name.trim()],
                      ["الرابط", <Ltr className="mono">{f.slug}.{baseDomain()}</Ltr>],
                      ["التخصص", spec ? spec.name_ar : f.specialty],
                      ["الميزات", <span className="pa-chips">{[...f.modules].sort().map((c) => <span key={c} className="badge b-blue">{names[c] || c}</span>)}</span>],
                      ["الخطة", plan ? plan.name : "—"],
                      ["الحالة", <Badge map={ORG_STATUS} value="pending_activation"/>],
                      ["الفرع", "الفرع الرئيسي (يُنشأ تلقائيًا)"],
                    ]}/>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="pa-wizard-foot">
          {/* LTR icon names: index.html mirrors ArrowLeft/ArrowRight inside .btn in RTL. */}
          <Btn kind="ghost" onClick={cancel} disabled={busy}>إلغاء</Btn>
          <div className="row gap-2">
            {step > 1 && <Btn kind="secondary" onClick={back} disabled={busy}><I.ArrowLeft size={14}/> السابق</Btn>}
            {step < 4 && <Btn kind="primary" onClick={next} disabled={loading || !!loadError}>التالي <I.ArrowRight size={14}/></Btn>}
            {step === 4 && <Btn kind="primary" busy={busy} onClick={create}>إنشاء العيادة</Btn>}
          </div>
        </div>

        {confirmCancel && (
          <ConfirmModal title="تجاهل التغييرات؟" kind="danger" confirmLabel="تجاهل والخروج"
            body="لن تُنشأ أي عيادة، وستضيع البيانات التي أدخلتها."
            onClose={() => setConfirmCancel(false)}
            onConfirm={() => { guardRef.current = null; dirtyRef.current = false; nav.go("#/clinics"); }}/>
        )}
      </div>
    );
  }

  function PlanLimits({ plan }) {
    const specialtyCount = Array.isArray(plan.included_modules) ? plan.included_modules.filter((c) => c.indexOf("core.") !== 0).length : null;
    return (
      <span className="pa-limits">
        <span>المستخدمون: <b>{fmtLimit(plan.max_users)}</b></span>
        <span>الفروع: <b>{fmtLimit(plan.max_branches)}</b></span>
        <span>التخزين: <b><Ltr>{fmtLimit(plan.max_storage_mb, "MB")}</Ltr></b></span>
        <span>الوحدات: <b>{specialtyCount === null ? "كل الوحدات" : "النواة + " + specialtyCount + " تخصصية"}</b></span>
      </span>
    );
  }

  // ══════════════════════════════════════════════════════════════
  // A04 — clinic details
  // ══════════════════════════════════════════════════════════════
  const CLINIC_TABS = [
    ["general", "عام"], ["modules", "الميزات"], ["branches", "الفروع"],
    ["members", "الأعضاء والدعوات"], ["subscription", "الاشتراك"], ["audit", "السجل"],
  ];

  function statusAction(from, to) {
    if (to === "suspended") return { label: "إيقاف العيادة", kind: "danger", icon: <PI.Pause size={14}/> };
    if (to === "closed") return { label: "إغلاق نهائي", kind: "danger", icon: <I.Lock size={14}/> };
    if (to === "active" && from === "suspended") return { label: "إعادة تفعيل", kind: "primary", icon: <PI.Play size={13}/> };
    if (to === "active") return { label: "تفعيل يدويًا", kind: "secondary", icon: <PI.Play size={13}/> };
    return { label: "نقل إلى «بانتظار التفعيل»", kind: "secondary", icon: <I.Clock size={14}/> };
  }

  function ClinicPage({ id, tab }) {
    const det = useApi(P("/organizations/" + encodeURIComponent(id)));
    const specs = useApi(P("/specialties"), { cache: true });
    const plans = useApi(P("/plans"));
    const [statusTo, setStatusTo] = useState(null);
    const d = det.data;
    const active = CLINIC_TABS.some(([k]) => k === tab) ? tab : "general";
    const tabRefs = useRef({});

    if (det.error && !d) {
      if (det.error.code === "org_not_found" || det.error.status === 404) {
        return <div className="card"><Empty icon={<PI.Building size={22}/>} title="العيادة غير موجودة" body="ربما حُذف الرابط أو أُدخل خطأ."
          action={<a className="btn btn-secondary" href="#/clinics">العودة إلى العيادات</a>}/></div>;
      }
      return <ErrorBox error={det.error} onRetry={det.reload}/>;
    }
    if (!d) {
      return (
        <div aria-busy="true">
          <div className="skel" style={{ height: 14, width: 120, marginBottom: 12 }}/>
          <div className="skel" style={{ height: 28, width: 260, marginBottom: 20 }}/>
          <div className="card"><SkeletonRows count={5}/></div>
        </div>
      );
    }
    const o = d.organization;
    const specName = ((specs.data || []).find((s) => s.code === o.specialty_code) || {}).name_ar || o.specialty_code;
    const overdue = o.status === "suspended" && o.retention_until && new Date(o.retention_until).getTime() < Date.now();
    const onTabKey = (e, i) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
      e.preventDefault();
      // RTL: ArrowLeft moves to the next tab.
      let n = e.key === "Home" ? 0 : e.key === "End" ? CLINIC_TABS.length - 1 : i + (e.key === "ArrowLeft" ? 1 : -1);
      n = (n + CLINIC_TABS.length) % CLINIC_TABS.length;
      const k = CLINIC_TABS[n][0];
      nav.go("#/clinics/" + o.id + "/" + k, { replace: true });
      setTimeout(() => { if (tabRefs.current[k]) tabRefs.current[k].focus(); }, 0);
    };

    return (
      <>
        <div className="crumb"><a href="#/clinics">العيادات</a><I.Chevron size={11}/><span>{o.name}</span></div>
        <div className="page-head" style={{ alignItems: "flex-start" }}>
          <div style={{ minWidth: 0 }}>
            <div className="row gap-2" style={{ flexWrap: "wrap" }}>
              <h1 className="h1" data-clinic-name="">{o.name}</h1>
              <Badge map={ORG_STATUS} value={o.status}/>
              <span className="badge b-violet">{specName}</span>
            </div>
            <div className="row gap-2" style={{ marginTop: 6, flexWrap: "wrap" }}>
              <Ltr className="mono pa-link-text">{o.slug}.{baseDomain()}</Ltr>
              <CopyButton text={clinicUrl(o.slug)}/>
              {o.plan && <span className="muted" style={{ fontSize: 12.5 }}>الخطة: {o.plan.name}</span>}
            </div>
          </div>
          <div className="page-actions">
            {(TRANSITIONS[o.status] || []).map((to) => {
              const a = statusAction(o.status, to);
              return <Btn key={to} kind={a.kind} onClick={() => setStatusTo(to)}>{a.icon}{a.label}</Btn>;
            })}
          </div>
        </div>

        {o.status === "suspended" && (
          <div style={{ marginBottom: 16 }}>
            <Alert kind="red" icon={<PI.Pause size={16}/>}>
              <div data-retention="">هذه العيادة موقوفة منذ <DateText value={o.suspended_at}/> — البيانات محفوظة حتى <b><DateText value={o.retention_until}/></b>.</div>
              {o.status_reason && <div>السبب: {o.status_reason}</div>}
              {overdue && <div><b>تجاوزت العيادة مدة الاحتفاظ.</b> لا حذف آليًا حتى قرار المالك.</div>}
            </Alert>
          </div>
        )}
        {o.status === "closed" && (
          <div style={{ marginBottom: 16 }}>
            <Alert kind="grey" icon={<I.Lock size={16}/>}>
              هذه العيادة مغلقة{o.status_reason ? " — السبب: " + o.status_reason : ""}.
              {o.retention_until && <> البيانات محفوظة حتى <DateText value={o.retention_until}/>.</>}
            </Alert>
          </div>
        )}
        {o.status === "pending_activation" && (
          <div style={{ marginBottom: 16 }}>
            <Alert kind="amber" icon={<I.Clock size={16}/>}>
              بانتظار التفعيل: تصبح العيادة نشطة عندما يقبل أول مدير دعوته
              {d.usage.pending_invitations ? <> (دعوات معلقة: <span className="mono">{d.usage.pending_invitations}</span>)</> : <> — لا توجد دعوة معلقة، أرسل دعوة من تبويب «الأعضاء والدعوات»</>}.
            </Alert>
          </div>
        )}

        <div className="pa-tabs" role="tablist" aria-label="أقسام العيادة">
          {CLINIC_TABS.map(([k, label], i) => (
            <a key={k} role="tab" id={"pa-tab-" + k} aria-selected={active === k ? "true" : "false"} aria-controls="pa-tabpanel"
              tabIndex={active === k ? 0 : -1} className="pa-tab" href={"#/clinics/" + o.id + "/" + k}
              ref={(el) => { tabRefs.current[k] = el; }} onKeyDown={(e) => onTabKey(e, i)}>{label}</a>
          ))}
        </div>
        <div id="pa-tabpanel" role="tabpanel" aria-labelledby={"pa-tab-" + active}>
          {active === "general" && <GeneralTab detail={d} onDetail={det.setData} specialties={specs.data || []} plans={plans.data || []}/>}
          {active === "modules" && <ModulesTab detail={d} onDetail={det.setData}/>}
          {active === "branches" && <BranchesTab detail={d}/>}
          {active === "members" && <MembersTab detail={d} reload={det.reload}/>}
          {active === "subscription" && <SubscriptionTab detail={d} onDetail={det.setData} plans={plans.data} plansError={plans.error}/>}
          {active === "audit" && <OrgAuditTab orgId={o.id}/>}
        </div>

        {statusTo && <StatusModal org={o} to={statusTo} onClose={() => setStatusTo(null)}
          onDone={(detail, to) => {
            det.setData(detail);
            setStatusTo(null);
            const r = detail.organization.retention_until;
            toast(to === "suspended" ? "أُوقفت العيادة — البيانات محفوظة حتى " + ltrText(fmtDate(r))
              : to === "closed" ? "أُغلقت العيادة" : to === "active" ? "العيادة نشطة الآن" : "تم تغيير الحالة");
          }}/>}
      </>
    );
  }

  function StatusModal({ org, to, onClose, onDone }) {
    const needReason = to === "suspended" || to === "closed";
    const [reason, setReason] = useState("");
    const [err, setErr] = useState("");
    const [busy, setBusy] = useState(false);
    const formId = React.useId();
    const reasonId = React.useId();
    const a = statusAction(org.status, to);
    const copy = {
      suspended: ["إيقاف «" + org.name + "»؟", <>يُمنع كل موظفي العيادة من الدخول فورًا، وتُحفظ بياناتها 6 أشهر (حتى <DateText value={plusMonths(6)}/>)، ويمكن إعادة تفعيلها في أي وقت خلالها.</>],
      closed: ["إغلاق «" + org.name + "» نهائيًا؟", <>لا يمكن إعادة فتح عيادة مغلقة. تبقى البيانات محفوظة حتى <DateText value={org.retention_until}/>.</>],
      active: org.status === "suspended"
        ? ["إعادة تفعيل «" + org.name + "»؟", "يعود موظفو العيادة إلى الدخول فورًا ويُلغى تاريخ الاحتفاظ."]
        : ["تفعيل «" + org.name + "» يدويًا؟", "عادةً تُفعَّل العيادة تلقائيًا عند قبول أول مدير دعوته."],
      pending_activation: ["نقل «" + org.name + "» إلى «بانتظار التفعيل»؟", "تصبح العيادة جاهزة لقبول دعوة أول مدير."],
    }[to];
    async function submit(e) {
      if (e) e.preventDefault();
      if (needReason && !reason.trim()) { setErr(to === "suspended" ? "اكتب سبب الإيقاف" : "اكتب سبب الإغلاق"); return; }
      setBusy(true);
      setErr("");
      const res = await call("POST", P("/organizations/" + org.id + "/status"), { status: to, reason: reason.trim() });
      setBusy(false);
      if (!res.ok) { setErr(errorText(res.error)); return; }
      onDone(res.data, to);
    }
    return (
      <PModal title={copy[0]} danger={a.kind === "danger"} onClose={busy ? null : onClose} footer={<>
        <Btn kind="secondary" onClick={onClose} disabled={busy}>رجوع</Btn>
        <Btn kind={a.kind === "danger" ? "danger" : "primary"} type="submit" form={formId} busy={busy}>{a.label}</Btn>
      </>}>
        <form id={formId} onSubmit={submit} noValidate>
          <p style={{ marginTop: 0, lineHeight: 1.7 }}>{copy[1]}</p>
          <Field id={reasonId} label={needReason ? (to === "suspended" ? "سبب الإيقاف" : "سبب الإغلاق") : "ملاحظة (اختياري)"} required={needReason} error={err}
            help={needReason ? "يظهر في صفحة العيادة وسجل التدقيق." : null}>
            <textarea {...describe(reasonId, err, needReason ? "x" : null)} rows={3} maxLength={1000} value={reason}
              onChange={(e) => { setReason(e.target.value); if (err) setErr(""); }} style={{ height: "auto", padding: "8px 12px" }}/>
          </Field>
        </form>
      </PModal>
    );
  }

  function GeneralTab({ detail, onDetail, specialties, plans }) {
    const o = detail.organization;
    const [name, setName] = useState(o.name);
    const [spec, setSpec] = useState(o.specialty_code);
    const [planId, setPlanId] = useState(o.plan_id || "");
    const [err, setErr] = useState({});
    const [busy, setBusy] = useState(false);
    const [confirmSpec, setConfirmSpec] = useState(false);
    useEffect(() => { setName(o.name); setSpec(o.specialty_code); setPlanId(o.plan_id || ""); }, [o.name, o.specialty_code, o.plan_id]);
    const nameId = React.useId(), specId = React.useId(), planSel = React.useId();
    const changes = {};
    if (name.trim() !== o.name) changes.name = name.trim();
    if (spec !== o.specialty_code) changes.specialty_code = spec;
    if ((planId || null) !== (o.plan_id || null)) changes.plan_id = planId || null;
    const changed = Object.keys(changes).length > 0;
    const planOptions = plans.filter((p) => p.status === "active" || p.id === o.plan_id);
    const names = namesOf(detail.modules);
    const enabled = detail.modules.filter((m) => m.enabled).map((m) => m.code);
    const newSpec = specialties.find((s) => s.code === spec);
    const activeCodes = new Set(detail.modules.filter((m) => m.status === "active").map((m) => m.code));
    const newDefaults = newSpec ? newSpec.default_modules.filter((c) => activeCodes.has(c)) : [];
    const notEnabled = newDefaults.filter((c) => enabled.indexOf(c) === -1);
    const extra = enabled.filter((c) => newDefaults.indexOf(c) === -1);

    async function save() {
      setBusy(true);
      const res = await call("PATCH", P("/organizations/" + o.id), changes);
      setBusy(false);
      setConfirmSpec(false);
      if (!res.ok) {
        const text = errorText(res.error);
        const field = { invalid_name: "name", invalid_specialty: "spec", invalid_plan: "plan" }[res.error.code];
        setErr(field ? { [field]: text } : { form: text });
        toast(text, "error");
        return false;
      }
      onDetail(res.data);
      setErr({});
      toast("تم حفظ التغييرات");
      return true;
    }
    function submit(e) {
      e.preventDefault();
      const nm = name.trim();
      if (nm.length < 2 || nm.length > 120) { setErr({ name: "الاسم مطلوب (من 2 إلى 120 حرفًا)" }); return; }
      if (!changed) return;
      if (changes.specialty_code) { setConfirmSpec(true); return; }
      save();
    }
    const u = detail.usage;
    const plan = o.plan || {};
    return (
      <div className="rgrid c-lg" style={{ "--gtc": "1.3fr 1fr" }}>
        <form className="card card-pad" onSubmit={submit} noValidate>
          <h2 className="h3" style={{ marginBottom: 14 }}>بيانات العيادة</h2>
          {err.form && <div style={{ marginBottom: 12 }}><Alert kind="red">{err.form}</Alert></div>}
          <Field id={nameId} label="الاسم" required error={err.name}>
            <input {...describe(nameId, err.name)} value={name} maxLength={120} onChange={(e) => { setName(e.target.value); if (err.name) setErr({}); }}/>
          </Field>
          <Field id={specId} label="التخصص" required error={err.spec} help="تغيير التخصص لا يغيّر الوحدات المفعّلة تلقائيًا.">
            <select {...describe(specId, err.spec, "x")} value={spec} onChange={(e) => setSpec(e.target.value)}>
              {specialties.filter((s) => s.status === "active" || s.code === o.specialty_code).map((s) => <option key={s.code} value={s.code}>{s.name_ar}</option>)}
            </select>
          </Field>
          <Field id={planSel} label="الخطة" error={err.plan} help="للاشتراك اليدوي (الفترة والحالة) استخدم تبويب «الاشتراك».">
            <select {...describe(planSel, err.plan, "x")} value={planId} onChange={(e) => setPlanId(e.target.value)}>
              {!o.plan_id && <option value="">بدون خطة</option>}
              {planOptions.map((p) => <option key={p.id} value={p.id}>{p.name}{p.status !== "active" ? " (مؤرشفة)" : ""}</option>)}
            </select>
          </Field>
          <div className="row gap-2" style={{ justifyContent: "flex-end" }}>
            {changed && <Btn kind="ghost" onClick={() => { setName(o.name); setSpec(o.specialty_code); setPlanId(o.plan_id || ""); setErr({}); }}>تراجع</Btn>}
            <Btn kind="primary" type="submit" busy={busy && !confirmSpec} disabled={!changed}>حفظ التغييرات</Btn>
          </div>
        </form>
        <div className="card card-pad">
          <h2 className="h3" style={{ marginBottom: 14 }}>معلومات</h2>
          <Kv rows={[
            ["المعرّف", <Ltr className="mono pa-code">{o.id}</Ltr>],
            ["الرابط", <Ltr className="mono">{clinicUrl(o.slug)}</Ltr>],
            ["أُنشئت", <DateText value={o.created_at} time/>],
            ["آخر تحديث", <DateText value={o.updated_at} time/>],
            ["الأعضاء النشطون", <span className="tnum">{usageText(u.active_members, plan.max_users)}</span>],
            ["دعوات معلقة", <span className="mono">{u.pending_invitations}</span>],
            ["الفروع النشطة", <span className="tnum">{usageText(u.active_branches, plan.max_branches)}</span>],
            o.status_reason && ["سبب آخر تغيير حالة", o.status_reason],
          ]}/>
        </div>
        {confirmSpec && (
          <ConfirmModal title="تغيير التخصص؟" confirmLabel="حفظ التخصص الجديد" onClose={() => setConfirmSpec(false)} onConfirm={save}
            body={<>
              <p style={{ marginTop: 0 }}>من {quote(o.specialty_code, namesOf(specialties.map((s) => ({ code: s.code, name_ar: s.name_ar }))))} إلى {quote(spec, namesOf(specialties.map((s) => ({ code: s.code, name_ar: s.name_ar }))))}. الوحدات المفعّلة تبقى كما هي؛ الفرق مع الوحدات الافتراضية للتخصص الجديد:</p>
              <div className="pa-help">افتراضية وغير مفعّلة: {notEnabled.length ? notEnabled.map((c) => quote(c, names)).join("، ") : "لا شيء"}</div>
              <div className="pa-help">مفعّلة وليست افتراضية: {extra.length ? extra.map((c) => quote(c, names)).join("، ") : "لا شيء"}</div>
              <div className="pa-help">عدّل الوحدات من تبويب «الميزات» بعد الحفظ.</div>
            </>}/>
        )}
      </div>
    );
  }

  function ModulesTab({ detail, onDetail }) {
    const o = detail.organization;
    const catalog = detail.modules;
    const names = namesOf(catalog);
    const enabled = useMemo(() => new Set(catalog.filter((m) => m.enabled).map((m) => m.code)), [catalog]);
    const [pending, setPending] = useState({});
    const [errors, setErrors] = useState({});
    const [confirmOff, setConfirmOff] = useState(null);
    const busy = Object.keys(pending).length > 0;
    const planModules = o.plan && Array.isArray(o.plan.included_modules) ? o.plan.included_modules : null;

    async function save(codes, changed, code) {
      setPending(changed);
      const res = await call("PUT", P("/organizations/" + o.id + "/modules"), { codes: [...codes].sort() });
      setPending({});
      if (!res.ok) {
        const text = errorText(res.error, names);
        setErrors({ [code]: { text, fix: null } });
        toast(text, "error");
        return false;
      }
      onDetail(res.data);
      setErrors({});
      toast("تم الحفظ");
      return true;
    }
    function toggle(code, next) {
      const problem = moduleToggleProblem(catalog, enabled, code, next);
      if (problem) { setErrors({ [code]: problem }); return; }
      setErrors({});
      if (!next) { setConfirmOff(code); return; }
      const s = new Set(enabled);
      s.add(code);
      save(s, { [code]: true }, code);
    }
    function fix(code, deps) {
      const s = new Set(enabled);
      const changed = {};
      deps.concat(code).forEach((c) => { s.add(c); changed[c] = true; });
      setErrors({});
      save(s, changed, code);
    }
    return (
      <div className="card">
        <div className="pa-card-head">
          <div>
            <h2 className="h3">الميزات المفعّلة <span className="mono muted">({enabled.size})</span></h2>
            <div className="pa-help">تعطيل وحدة يخفيها عن العيادة وتبقى بياناتها محفوظة.</div>
          </div>
          {planModules && <span className="badge b-grey">الخطة تحدد الوحدات التخصصية المتاحة</span>}
        </div>
        <ModuleList catalog={catalog} enabled={enabled} pending={pending} errors={errors} planModules={planModules}
          onToggle={toggle} onFix={fix} disabled={busy}/>
        {confirmOff && (
          <ConfirmModal title={"تعطيل " + quote(confirmOff, names) + "؟"} kind="danger" confirmLabel="تعطيل الوحدة"
            body={<>ستختفي الوحدة {quote(confirmOff, names)} من «{o.name}» فورًا، <b>وتبقى بياناتها محفوظة</b> وتعود عند إعادة التفعيل.</>}
            onClose={() => setConfirmOff(null)}
            onConfirm={async () => {
              const code = confirmOff;
              const s = new Set(enabled);
              s.delete(code);
              setConfirmOff(null);
              await save(s, { [code]: false }, code);
            }}/>
        )}
      </div>
    );
  }

  function BranchesTab({ detail }) {
    const rows = detail.branches || [];
    const plan = detail.organization.plan || {};
    return (
      <div className="card">
        <div className="pa-card-head">
          <div>
            <h2 className="h3">الفروع</h2>
            <div className="pa-help">يديرها مدير العيادة من شاشة الفروع. العرض هنا للقراءة فقط.</div>
          </div>
          <span className="badge b-grey tnum">{usageText(detail.usage.active_branches, plan.max_branches, "الفروع النشطة")}</span>
        </div>
        <div className="tbl-scroll">
          <CardTable>
            <thead><tr><th>الفرع</th><th>الحالة</th><th>العنوان</th><th>الهاتف</th><th>أُضيف</th></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={5} className="tbl-empty">لا توجد فروع لهذه العيادة.</td></tr>}
              {rows.map((b) => (
                <tr key={b.id}>
                  <td><b>{b.name}</b><div><Ltr className="mono pa-code">{b.id}</Ltr></div></td>
                  <td><Badge map={BRANCH_STATUS} value={b.status}/></td>
                  <td>{b.address || <span className="muted">—</span>}</td>
                  <td>{b.phone ? <Ltr className="mono">{b.phone}</Ltr> : <span className="muted">—</span>}</td>
                  <td><DateText value={b.created_at}/></td>
                </tr>
              ))}
            </tbody>
          </CardTable>
        </div>
      </div>
    );
  }

  function MembersTab({ detail, reload }) {
    const o = detail.organization;
    const branchName = {};
    (detail.branches || []).forEach((b) => { branchName[b.id] = b.name; });
    const branchList = (ids) => (ids && ids.length ? ids.map((i) => branchName[i] || i).join("، ") : "كل الفروع");
    const [inviteOpen, setInviteOpen] = useState(false);
    const [rowBusy, setRowBusy] = useState(null);
    const [revoke, setRevoke] = useState(null);
    const plan = o.plan || {};
    const seats = detail.usage.active_members + detail.usage.pending_invitations;
    const canInvite = INVITABLE.indexOf(o.status) !== -1;

    async function resend(inv) {
      setRowBusy(inv.id);
      const res = await call("POST", P("/organizations/" + o.id + "/invitations/" + inv.id + "/resend"));
      setRowBusy(null);
      if (!res.ok) { toast(errorText(res.error), "error"); return; }
      if (res.data && res.data.email_sent === false) toast("جُددت الدعوة لكن تعذّر إرسال البريد — حاول مرة أخرى", "error");
      else toast("أُعيد إرسال الدعوة إلى " + inv.email);
      reload();
    }
    return (
      <>
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="pa-card-head">
            <h2 className="h3">الأعضاء <span className="mono muted">({detail.members.length})</span></h2>
            <span className="badge b-grey tnum" data-seats="" title="الأعضاء النشطون + الدعوات المعلقة">{usageText(seats, plan.max_users, "المقاعد")}</span>
          </div>
          <div className="tbl-scroll">
            <CardTable>
              <thead><tr><th>الاسم</th><th>البريد</th><th>الدور</th><th>الفروع</th><th>الحالة</th><th>انضم</th></tr></thead>
              <tbody>
                {detail.members.length === 0 && <tr><td colSpan={6} className="tbl-empty">لا يوجد أعضاء بعد — ينضم أول مدير عند قبول دعوته.</td></tr>}
                {detail.members.map((m) => (
                  <tr key={m.id}>
                    <td><b>{m.name || "—"}</b></td>
                    <td><Ltr className="mono">{m.email}</Ltr></td>
                    <td><span className="badge b-grey">{ROLE_LABEL[m.role] || m.role}</span></td>
                    <td>{m.role === "admin" ? "كل الفروع" : branchList(m.branch_ids)}</td>
                    <td><Badge map={MEMBER_STATUS} value={m.status}/></td>
                    <td><DateText value={m.joined_at || m.created_at}/></td>
                  </tr>
                ))}
              </tbody>
            </CardTable>
          </div>
        </div>

        <div className="card">
          <div className="pa-card-head">
            <h2 className="h3">الدعوات <span className="mono muted">({detail.invitations.length})</span></h2>
            <Btn kind="primary" disabled={!canInvite} title={canInvite ? undefined : "لا يمكن الدعوة لعيادة " + ORG_STATUS[o.status][0]}
              onClick={() => setInviteOpen(true)}><I.Send size={14}/> دعوة مستخدم</Btn>
          </div>
          {!canInvite && <div style={{ padding: "0 16px 12px" }}><Alert kind="grey">العيادة {ORG_STATUS[o.status][0]} — لا يمكن إرسال دعوات أو إعادة إرسالها.</Alert></div>}
          <div className="tbl-scroll">
            <CardTable>
              <thead><tr><th>البريد</th><th>الدور</th><th>الفروع</th><th>الحالة</th><th>تنتهي</th><th><span className="pa-sr">إجراءات</span></th></tr></thead>
              <tbody>
                {detail.invitations.length === 0 && <tr><td colSpan={6} className="tbl-empty">لا توجد دعوات.</td></tr>}
                {detail.invitations.map((inv) => {
                  const open = inv.status === "pending" || inv.status === "expired";
                  return (
                    <tr key={inv.id} data-invite={inv.email}>
                      <td><Ltr className="mono">{inv.email}</Ltr></td>
                      <td><span className="badge b-grey">{ROLE_LABEL[inv.role] || inv.role}</span></td>
                      <td>{inv.role === "admin" ? "كل الفروع" : branchList(inv.branch_ids)}</td>
                      <td><Badge map={INVITE_STATUS} value={inv.status}/></td>
                      <td><DateText value={inv.expires_at}/></td>
                      <td>
                        {open && canInvite && (
                          <div className="row gap-2" style={{ justifyContent: "flex-end" }}>
                            <Btn kind="ghost" busy={rowBusy === inv.id} onClick={() => resend(inv)} aria-label={"إعادة إرسال الدعوة إلى " + inv.email}>إعادة الإرسال</Btn>
                            <Btn kind="ghost" disabled={rowBusy === inv.id} onClick={() => setRevoke(inv)} aria-label={"إلغاء الدعوة إلى " + inv.email}>إلغاء</Btn>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </CardTable>
          </div>
        </div>

        {inviteOpen && <InviteModal org={o} branches={(detail.branches || []).filter((b) => b.status === "active")}
          onClose={() => setInviteOpen(false)} onDone={() => { setInviteOpen(false); reload(); }}/>}
        {revoke && (
          <ConfirmModal title="إلغاء الدعوة؟" kind="danger" confirmLabel="إلغاء الدعوة"
            body={<>لن يستطيع <Ltr className="mono">{revoke.email}</Ltr> استخدام رابط الدعوة بعد الآن. يبقى سجلها محفوظًا.</>}
            onClose={() => setRevoke(null)}
            onConfirm={async () => {
              const res = await call("DELETE", P("/organizations/" + o.id + "/invitations/" + revoke.id));
              if (!res.ok) { toast(errorText(res.error), "error"); return false; }
              toast("أُلغيت الدعوة");
              setRevoke(null);
              reload();
              return true;
            }}/>
        )}
      </>
    );
  }

  function InviteModal({ org, branches, onClose, onDone }) {
    const [email, setEmail] = useState("");
    const [role, setRole] = useState("admin");
    const [picked, setPicked] = useState(() => new Set(branches.length === 1 ? [branches[0].id] : []));
    const [err, setErr] = useState({});
    const [busy, setBusy] = useState(false);
    const formId = React.useId(), emailId = React.useId(), roleId = React.useId();
    async function submit(e) {
      e.preventDefault();
      const e2 = {};
      if (!EMAIL_RE.test(email.trim())) e2.email = "أدخل بريدًا إلكترونيًا صالحًا";
      if (role !== "admin" && picked.size === 0) e2.branches = "اختر فرعًا واحدًا على الأقل لهذا الدور";
      setErr(e2);
      if (Object.keys(e2).length) return;
      setBusy(true);
      const res = await call("POST", P("/organizations/" + org.id + "/invitations"), {
        email: email.trim().toLowerCase(), role, branch_ids: role === "admin" ? [] : [...picked],
      });
      setBusy(false);
      if (!res.ok) {
        const text = errorText(res.error);
        const field = { invalid_email: "email", already_member: "email", invitation_exists: "email", invalid_role: "role", branch_required: "branches", invalid_branch: "branches", invalid_branch_ids: "branches" }[res.error.code];
        setErr(field ? { [field]: text } : { form: text });
        return;
      }
      if (res.data && res.data.email_sent === false) toast("أُنشئت الدعوة لكن تعذّر إرسال البريد — استخدم «إعادة الإرسال»", "error");
      else toast("أُرسلت الدعوة إلى " + email.trim().toLowerCase());
      onDone();
    }
    return (
      <PModal title={"دعوة مستخدم إلى «" + org.name + "»"} onClose={busy ? null : onClose} footer={<>
        <Btn kind="secondary" onClick={onClose} disabled={busy}>رجوع</Btn>
        <Btn kind="primary" type="submit" form={formId} busy={busy}><I.Send size={14}/> إرسال الدعوة</Btn>
      </>}>
        <form id={formId} onSubmit={submit} noValidate>
          {err.form && <div style={{ marginBottom: 12 }}><Alert kind="red">{err.form}</Alert></div>}
          <Field id={emailId} label="البريد الإلكتروني" required error={err.email}>
            <input {...describe(emailId, err.email)} type="email" dir="ltr" value={email} onChange={(e) => { setEmail(e.target.value); if (err.email) setErr({}); }} placeholder="name@clinic.com"/>
          </Field>
          <Field id={roleId} label="الدور" required error={err.role}>
            <select {...describe(roleId, err.role)} value={role} onChange={(e) => setRole(e.target.value)}>
              {["admin", "receptionist", "doctor", "therapist", "staff"].map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>
          </Field>
          {role !== "admin" && (
            <fieldset className="pa-fieldset" aria-describedby={err.branches ? "pa-inv-br-err" : undefined}>
              <legend className="label">الفروع<span className="pa-req" aria-hidden="true"> *</span></legend>
              {branches.length === 0 && <div className="pa-help">لا توجد فروع نشطة — يمكن دعوة مدير العيادة فقط.</div>}
              {branches.map((b) => (
                <label key={b.id} className="pa-check">
                  <input type="checkbox" checked={picked.has(b.id)} onChange={(e) => {
                    const s = new Set(picked);
                    if (e.target.checked) s.add(b.id); else s.delete(b.id);
                    setPicked(s);
                    if (err.branches) setErr({});
                  }}/> {b.name}
                </label>
              ))}
              {err.branches && <div id="pa-inv-br-err" className="pa-field-error" role="alert">{err.branches}</div>}
            </fieldset>
          )}
        </form>
      </PModal>
    );
  }

  function SubscriptionTab({ detail, onDetail, plans, plansError }) {
    const o = detail.organization;
    const sub = detail.subscription;
    const [planId, setPlanId] = useState(o.plan_id || "");
    const [status, setStatus] = useState((sub && sub.status) || "active");
    const [start, setStart] = useState((sub && sub.period_start) || todayIso());
    const [end, setEnd] = useState((sub && sub.period_end) || "");
    const [notes, setNotes] = useState("");
    const [err, setErr] = useState({});
    const [busy, setBusy] = useState(false);
    const ids = { plan: React.useId(), status: React.useId(), start: React.useId(), end: React.useId(), notes: React.useId() };
    const list = plans || [];
    const planOf = (pid) => list.find((p) => p.id === pid) || (o.plan && o.plan.id === pid ? o.plan : null);
    const chosen = planOf(planId);
    async function submit(e) {
      e.preventDefault();
      const e2 = {};
      if (!planId) e2.plan = "اختر خطة";
      if (end && start && end < start) e2.end = "تاريخ النهاية قبل تاريخ البداية";
      setErr(e2);
      if (Object.keys(e2).length) return;
      setBusy(true);
      const res = await call("PUT", P("/organizations/" + o.id + "/subscription"), {
        plan_id: planId, status, period_start: start || null, period_end: end || null, notes: notes.trim() || null,
      });
      setBusy(false);
      if (!res.ok) {
        const text = errorText(res.error);
        const field = { invalid_plan: "plan", invalid_status: "status", invalid_date: "end", invalid_notes: "notes" }[res.error.code];
        setErr(field ? { [field]: text } : { form: text });
        toast(text, "error");
        return;
      }
      onDetail(res.data);
      setNotes("");
      toast("تم حفظ الاشتراك");
    }
    const subPlan = sub ? planOf(sub.plan_id) : null;
    return (
      <div className="rgrid c-lg" style={{ "--gtc": "1fr 1.2fr" }}>
        <div className="card card-pad">
          <h2 className="h3" style={{ marginBottom: 14 }}>الاشتراك الحالي</h2>
          {sub ? (
            <Kv rows={[
              ["الخطة", subPlan ? subPlan.name : <Ltr className="mono">{shortId(sub.plan_id)}</Ltr>],
              ["الحالة", <span className="badge b-blue" data-sub-status="">{SUB_STATUS[sub.status] || sub.status}</span>],
              ["الفترة", <span data-sub-period="">{sub.period_start ? <>من <DateText value={sub.period_start}/> </> : null}{sub.period_end ? <>إلى <DateText value={sub.period_end}/></> : "(فترة مفتوحة)"}</span>],
              ["ملاحظات", (sub.notes && (SYSTEM_NOTES[sub.notes] || sub.notes)) || <span className="muted">—</span>],
              ["سُجّل في", <DateText value={sub.created_at} time/>],
            ]}/>
          ) : <div className="muted">لا يوجد اشتراك مسجّل بعد.</div>}
          {chosen && (
            <div style={{ marginTop: 16 }}>
              <div className="label">حدود الخطة {chosen.id === o.plan_id ? "الحالية" : "المختارة"}</div>
              <PlanLimits plan={chosen}/>
            </div>
          )}
        </div>
        <form className="card card-pad" onSubmit={submit} noValidate>
          <h2 className="h3" style={{ marginBottom: 4 }}>تسجيل اشتراك يدوي</h2>
          <div className="pa-help" style={{ marginBottom: 14, marginTop: 0 }}>يُحفظ كسجل جديد (يبقى السجل السابق)، ويغيّر خطة العيادة.</div>
          {plansError && <div style={{ marginBottom: 12 }}><ErrorBox error={plansError}/></div>}
          {err.form && <div style={{ marginBottom: 12 }}><Alert kind="red">{err.form}</Alert></div>}
          <div className="rgrid c-sm" style={{ "--gtc": "1fr 1fr" }}>
            <Field id={ids.plan} label="الخطة" required error={err.plan}>
              <select {...describe(ids.plan, err.plan)} value={planId} onChange={(e) => setPlanId(e.target.value)}>
                {!planId && <option value="">اختر خطة</option>}
                {list.filter((p) => p.status === "active" || p.id === o.plan_id).map((p) => <option key={p.id} value={p.id}>{p.name}{p.status !== "active" ? " (مؤرشفة)" : ""}</option>)}
              </select>
            </Field>
            <Field id={ids.status} label="حالة الاشتراك" required error={err.status}>
              <select {...describe(ids.status, err.status)} value={status} onChange={(e) => setStatus(e.target.value)}>
                {Object.keys(SUB_STATUS).map((k) => <option key={k} value={k}>{SUB_STATUS[k]}</option>)}
              </select>
            </Field>
            <Field id={ids.start} label="بداية الفترة" error={err.start}>
              <input {...describe(ids.start, err.start)} type="date" dir="ltr" value={start} onChange={(e) => setStart(e.target.value)}/>
            </Field>
            <Field id={ids.end} label="نهاية الفترة" error={err.end} help="فارغة = فترة مفتوحة.">
              <input {...describe(ids.end, err.end, "x")} type="date" dir="ltr" value={end} min={start || undefined} onChange={(e) => { setEnd(e.target.value); if (err.end) setErr({}); }}/>
            </Field>
          </div>
          <Field id={ids.notes} label="ملاحظات" error={err.notes} help="مثل رقم الإيصال أو طريقة الدفع.">
            <textarea {...describe(ids.notes, err.notes, "x")} rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} style={{ height: "auto", padding: "8px 12px" }}/>
          </Field>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <Btn kind="primary" type="submit" busy={busy}>حفظ الاشتراك</Btn>
          </div>
        </form>
      </div>
    );
  }

  function OrgAuditTab({ orgId }) {
    const [query, setQuery] = useState({});
    return <AuditView fixedOrgId={orgId} query={query} setQuery={setQuery}/>;
  }

  // ══════════════════════════════════════════════════════════════
  // A05 — specialties and modules catalog (read-only)
  // ══════════════════════════════════════════════════════════════
  function CatalogPage() {
    const specs = useApi(P("/specialties"), { cache: true });
    const mods = useApi(P("/modules"), { cache: true });
    const names = namesOf(mods.data || []);
    return (
      <>
        <div className="page-head">
          <div>
            <h1 className="h1">التخصصات والوحدات</h1>
            <div className="muted" style={{ marginTop: 4 }}>الكتالوج للعرض فقط حاليًا. الوحدات «قريبًا» لا يمكن تفعيلها لأي عيادة.</div>
          </div>
        </div>
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="pa-card-head"><h2 className="h3">التخصصات</h2></div>
          {specs.error ? <div style={{ padding: 16 }}><ErrorBox error={specs.error} onRetry={specs.reload}/></div> : (
            <div className="tbl-scroll">
              <CardTable>
                <thead><tr><th>التخصص</th><th>الرمز</th><th>الحالة</th><th>الوحدات الافتراضية</th></tr></thead>
                <tbody>
                  {!specs.data && <tr><td colSpan={4} style={{ padding: 0 }}><SkeletonRows count={3}/></td></tr>}
                  {specs.data && specs.data.map((s) => (
                    <tr key={s.code}>
                      <td><b>{s.name_ar}</b>{s.name_en && <div className="muted" style={{ fontSize: 12 }}><Ltr>{s.name_en}</Ltr></div>}</td>
                      <td><Ltr className="mono pa-code">{s.code}</Ltr></td>
                      <td><Badge map={CATALOG_STATUS} value={s.status}/></td>
                      <td><span className="pa-chips">{(s.default_modules || []).map((c) => {
                        const planned = (mods.data || []).some((m) => m.code === c && m.status !== "active");
                        return <span key={c} className={"badge " + (planned ? "b-grey" : "b-blue")} title={planned ? "قريبًا" : undefined}>{names[c] || c}{planned ? " (قريبًا)" : ""}</span>;
                      })}</span></td>
                    </tr>
                  ))}
                </tbody>
              </CardTable>
            </div>
          )}
        </div>
        <div className="card">
          <div className="pa-card-head"><h2 className="h3">الوحدات</h2></div>
          {mods.error ? <div style={{ padding: 16 }}><ErrorBox error={mods.error} onRetry={mods.reload}/></div> : (
            <div className="tbl-scroll">
              <CardTable>
                <thead><tr><th>الوحدة</th><th>الرمز</th><th>الفئة</th><th>يعتمد على</th><th>الحالة</th></tr></thead>
                <tbody>
                  {!mods.data && <tr><td colSpan={5} style={{ padding: 0 }}><SkeletonRows count={6}/></td></tr>}
                  {mods.data && mods.data.map((m) => (
                    <tr key={m.code}>
                      <td><b>{m.name_ar}</b></td>
                      <td><Ltr className="mono pa-code">{m.code}</Ltr></td>
                      <td>{m.category === "core" ? "النواة المشتركة" : "تخصصية"}</td>
                      <td><span className="pa-chips">{(m.depends_on || []).length ? m.depends_on.map((d) => <span key={d} className="badge b-grey">{names[d] || d}</span>) : <span className="muted">—</span>}</span></td>
                      <td><Badge map={CATALOG_STATUS} value={m.status}/></td>
                    </tr>
                  ))}
                </tbody>
              </CardTable>
            </div>
          )}
        </div>
      </>
    );
  }

  // ══════════════════════════════════════════════════════════════
  // A06 — plans
  // ══════════════════════════════════════════════════════════════
  function PlansPage() {
    const plans = useApi(P("/plans"));
    const mods = useApi(P("/modules"), { cache: true });
    const [editing, setEditing] = useState(null);
    const names = namesOf(mods.data || []);
    const rows = plans.data;
    return (
      <>
        <div className="page-head">
          <div>
            <h1 className="h1">الخطط</h1>
            <div className="muted" style={{ marginTop: 4 }}>حدود كل خطة؛ الحد الفارغ = غير محدود.</div>
          </div>
          <div className="page-actions">
            <Btn kind="primary" onClick={() => setEditing({ mode: "create" })} disabled={!mods.data}><I.Plus size={15}/> خطة جديدة</Btn>
          </div>
        </div>
        <div className="card">
          {plans.error ? <div style={{ padding: 16 }}><ErrorBox error={plans.error} onRetry={plans.reload}/></div> : (
            <div className="tbl-scroll">
              <CardTable>
                <thead><tr><th>الخطة</th><th>المستخدمون</th><th>الفروع</th><th>التخزين</th><th>الوحدات</th><th>الحالة</th><th>العيادات</th><th><span className="pa-sr">إجراءات</span></th></tr></thead>
                <tbody>
                  {!rows && <tr><td colSpan={8} style={{ padding: 0 }}><SkeletonRows count={3}/></td></tr>}
                  {rows && rows.length === 0 && <tr><td colSpan={8} className="tbl-empty">
                    <Empty icon={<I.CreditCard size={22}/>} title="لا توجد خطط" body="أنشئ أول خطة لتحديد حدود العيادات." action={<Btn kind="primary" onClick={() => setEditing({ mode: "create" })}>خطة جديدة</Btn>}/>
                  </td></tr>}
                  {rows && rows.map((p) => (
                    <tr key={p.id} data-plan={p.code}>
                      <td><b>{p.name}</b><div><Ltr className="mono pa-code">{p.code}</Ltr></div></td>
                      <td className="tnum" data-col="max_users">{fmtLimit(p.max_users)}</td>
                      <td className="tnum" data-col="max_branches">{fmtLimit(p.max_branches)}</td>
                      <td className="tnum" data-col="max_storage_mb"><Ltr>{fmtLimit(p.max_storage_mb, "MB")}</Ltr></td>
                      <td>{Array.isArray(p.included_modules)
                        ? <span className="pa-chips">{p.included_modules.length ? p.included_modules.map((c) => <span key={c} className="badge b-blue">{names[c] || c}</span>) : <span className="muted">النواة فقط</span>}</span>
                        : "كل الوحدات"}</td>
                      <td><Badge map={PLAN_STATUS} value={p.status}/></td>
                      <td className="mono">{p.organizations}</td>
                      <td><Btn kind="ghost" onClick={() => setEditing({ mode: "edit", plan: p })} disabled={!mods.data} aria-label={"تعديل الخطة " + p.name}><I.Edit size={14}/> تعديل</Btn></td>
                    </tr>
                  ))}
                </tbody>
              </CardTable>
            </div>
          )}
        </div>
        {editing && <PlanModal mode={editing.mode} plan={editing.plan} modules={mods.data || []}
          onClose={() => setEditing(null)}
          onSaved={(p) => { setEditing(null); toast(editing.mode === "create" ? "أُنشئت الخطة «" + p.name + "»" : "تم حفظ الخطة «" + p.name + "»"); plans.reload(); }}/>}
      </>
    );
  }

  const limitText = (v) => (v === null || v === undefined ? "" : String(v));
  function parseLimit(s) {
    const t = String(s || "").trim();
    if (!t) return { value: null };
    if (!/^\d+$/.test(t) || Number(t) > 1000000) return { error: "عدد صحيح من 0 إلى 1000000، أو فارغ لغير محدود" };
    return { value: Number(t) };
  }

  function PlanModal({ mode, plan, modules, onClose, onSaved }) {
    const p = plan || {};
    const [form, setForm] = useState({
      name: p.name || "", code: p.code || "",
      max_users: limitText(p.max_users), max_branches: limitText(p.max_branches), max_storage_mb: limitText(p.max_storage_mb),
      all: !Array.isArray(p.included_modules), included: new Set(p.included_modules || []), status: p.status || "active",
    });
    const [err, setErr] = useState({});
    const [busy, setBusy] = useState(false);
    const formId = React.useId();
    const ids = { name: React.useId(), code: React.useId(), max_users: React.useId(), max_branches: React.useId(), max_storage_mb: React.useId(), status: React.useId() };
    const specialty = modules.filter((m) => m.category !== "core");
    const set = (patch) => { setForm((f) => ({ ...f, ...patch })); setErr({}); };

    async function submit(e) {
      e.preventDefault();
      const e2 = {};
      const name = form.name.trim();
      if (!name || name.length > 120) e2.name = "الاسم مطلوب (120 حرفًا على الأكثر)";
      if (mode === "create" && (!PLAN_CODE_RE.test(form.code) || form.code.length > 40)) e2.code = "أحرف لاتينية صغيرة وأرقام و _ أو - (40 حرفًا على الأكثر)";
      const limits = {};
      ["max_users", "max_branches", "max_storage_mb"].forEach((k) => {
        const r = parseLimit(form[k]);
        if (r.error) e2[k] = r.error; else limits[k] = r.value;
      });
      setErr(e2);
      if (Object.keys(e2).length) return;
      const included = form.all ? null : [...form.included].sort();
      const body = { name, ...limits, included_modules: included, status: form.status };
      if (mode === "create") body.code = form.code;
      else {
        // PATCH only what changed, so the audit row lists real changes.
        const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
        const before = { name: p.name, max_users: p.max_users, max_branches: p.max_branches, max_storage_mb: p.max_storage_mb,
          included_modules: Array.isArray(p.included_modules) ? [...p.included_modules].sort() : null, status: p.status };
        Object.keys(before).forEach((k) => { if (same(before[k], body[k])) delete body[k]; });
        if (!Object.keys(body).length) { toast("لا توجد تغييرات للحفظ", "info"); onClose(); return; }
      }
      setBusy(true);
      const res = mode === "create" ? await call("POST", P("/plans"), body) : await call("PATCH", P("/plans/" + p.id), body);
      setBusy(false);
      if (!res.ok) {
        const text = errorText(res.error, namesOf(modules));
        const field = { invalid_code: "code", plan_code_taken: "code", invalid_name: "name", invalid_status: "status" }[res.error.code];
        setErr(field ? { [field]: text } : { form: text });
        return;
      }
      onSaved(res.data);
    }
    const limitField = (k, label, unit) => (
      <Field id={ids[k]} label={label} error={err[k]} help={"فارغ = غير محدود" + (unit ? " · " + unit : "")}>
        <input {...describe(ids[k], err[k], "x")} inputMode="numeric" dir="ltr" value={form[k]} placeholder="غير محدود"
          onChange={(e) => set({ [k]: e.target.value.replace(/[^\d]/g, "") })}/>
      </Field>
    );
    return (
      <PModal title={mode === "create" ? "خطة جديدة" : "تعديل الخطة «" + p.name + "»"} width={620} onClose={busy ? null : onClose} footer={<>
        <Btn kind="secondary" onClick={onClose} disabled={busy}>رجوع</Btn>
        <Btn kind="primary" type="submit" form={formId} busy={busy}>{mode === "create" ? "إنشاء الخطة" : "حفظ الخطة"}</Btn>
      </>}>
        <form id={formId} onSubmit={submit} noValidate>
          {err.form && <div style={{ marginBottom: 12 }}><Alert kind="red">{err.form}</Alert></div>}
          <div className="rgrid c-sm" style={{ "--gtc": "1fr 1fr" }}>
            <Field id={ids.name} label="الاسم" required error={err.name}>
              <input {...describe(ids.name, err.name)} value={form.name} maxLength={120} onChange={(e) => set({ name: e.target.value })}/>
            </Field>
            <Field id={ids.code} label="الرمز" required={mode === "create"} error={err.code} help={mode === "create" ? "مثل basic أو pro-2026؛ لا يتغير لاحقًا." : "لا يتغير بعد الإنشاء."}>
              <input {...describe(ids.code, err.code, "x")} className={"input mono" + (err.code ? " pa-invalid" : "")} dir="ltr" value={form.code} maxLength={40}
                readOnly={mode !== "create"} onChange={(e) => set({ code: e.target.value.toLowerCase().trim() })}/>
            </Field>
            {limitField("max_users", "حد المستخدمين")}
            {limitField("max_branches", "حد الفروع")}
            {limitField("max_storage_mb", "حد التخزين", "ميغابايت")}
            <Field id={ids.status} label="الحالة" error={err.status} help="الخطة المؤرشفة لا تُختار لعيادات جديدة.">
              <select {...describe(ids.status, err.status, "x")} value={form.status} onChange={(e) => set({ status: e.target.value })}>
                <option value="active">نشطة</option>
                <option value="archived">مؤرشفة</option>
              </select>
            </Field>
          </div>
          <fieldset className="pa-fieldset">
            <legend className="label">الوحدات المشمولة</legend>
            <label className="pa-check"><input type="radio" name={formId + "-mods"} checked={form.all} onChange={() => set({ all: true })}/> كل الوحدات</label>
            <label className="pa-check"><input type="radio" name={formId + "-mods"} checked={!form.all} onChange={() => set({ all: false })}/> وحدات تخصصية محددة (وحدات النواة متاحة دائمًا)</label>
            {!form.all && (
              <div className="pa-checks">
                {specialty.map((m) => (
                  <label key={m.code} className="pa-check">
                    <input type="checkbox" checked={form.included.has(m.code)} onChange={(e) => {
                      const s = new Set(form.included);
                      if (e.target.checked) s.add(m.code); else s.delete(m.code);
                      set({ included: s });
                    }}/> {m.name_ar} <Ltr className="mono pa-code">{m.code}</Ltr>{m.status !== "active" && <span className="badge b-amber" style={{ marginInlineStart: 4 }}>قريبًا</span>}
                  </label>
                ))}
              </div>
            )}
          </fieldset>
        </form>
      </PModal>
    );
  }

  // ══════════════════════════════════════════════════════════════
  // A07 — audit log
  // ══════════════════════════════════════════════════════════════
  const AUDIT_PAGE = 25;
  // audit_events.result (0003): success is the norm and shows nothing.
  const AUDIT_RESULT_LABEL = { denied: "مرفوضة", error: "فشلت" };

  function AuditTable({ rows, loading, compact, showOrg = true, onEmpty }) {
    const [payload, setPayload] = useState(null);
    const cols = compact ? 4 : showOrg ? 6 : 5;
    return (
      <>
        <div className="tbl-scroll">
          <CardTable data-audit="">
            <thead>
              <tr>
                <th>الوقت</th>
                {showOrg && <th>العيادة</th>}
                <th>المستخدم</th>
                <th>العملية</th>
                {!compact && <th>الهدف</th>}
                {!compact && <th><span className="pa-sr">التفاصيل</span></th>}
              </tr>
            </thead>
            <tbody>
              {(loading || !rows) && <tr><td colSpan={cols} style={{ padding: 0 }}><SkeletonRows count={compact ? 4 : 6}/></td></tr>}
              {!loading && rows && rows.length === 0 && <tr><td colSpan={cols} className="tbl-empty">{onEmpty || "لا توجد عمليات مسجلة."}</td></tr>}
              {!loading && rows && rows.map((a) => (
                <tr key={a.id} data-action={a.action}>
                  <td style={{ whiteSpace: "nowrap" }}><DateText value={a.created_at} time/></td>
                  {showOrg && <td>{a.organization_id
                    ? <a className="pa-link" href={"#/clinics/" + a.organization_id}><Ltr className="mono">{a.organization_slug || shortId(a.organization_id)}</Ltr></a>
                    : <span className="muted">المنصة</span>}</td>}
                  <td>
                    {a.actor_email ? <Ltr className="mono">{a.actor_email}</Ltr> : <span className="muted">النظام</span>}
                    {a.actor_role && <div className="muted" style={{ fontSize: 11.5 }}>{ROLE_LABEL[a.actor_role] || a.actor_role}</div>}
                  </td>
                  <td>
                    <span>{ACTION_LABEL[a.action] || a.action}</span>
                    {a.result && a.result !== "success" && <span className="badge b-red" data-result={a.result} style={{ marginInlineStart: 6 }}>{AUDIT_RESULT_LABEL[a.result] || a.result}</span>}
                    <div><Ltr className="mono pa-code">{a.action}</Ltr></div>
                  </td>
                  {!compact && <td>{a.target_type ? <>{TARGET_LABEL[a.target_type] || a.target_type} <Ltr className="mono pa-code">{shortId(a.target_id || a.row_pk)}</Ltr></> : <span className="muted">—</span>}</td>}
                  {!compact && <td>{a.payload && <Btn kind="ghost" onClick={() => setPayload(a)} aria-label="عرض تفاصيل العملية"><I.Eye size={14}/> التفاصيل</Btn>}</td>}
                </tr>
              ))}
            </tbody>
          </CardTable>
        </div>
        {payload && (
          <PModal title={ACTION_LABEL[payload.action] || payload.action} width={620} onClose={() => setPayload(null)}>
            <Kv rows={[
              ["الوقت", <DateText value={payload.created_at} time/>],
              ["المستخدم", <Ltr className="mono">{payload.actor_email || "—"}</Ltr>],
              ["الجدول", <Ltr className="mono">{payload.table_name || "—"}</Ltr>],
            ]}/>
            <pre className="pa-json" dir="ltr">{JSON.stringify(payload.payload, null, 2)}</pre>
          </PModal>
        )}
      </>
    );
  }

  const KNOWN_ACTIONS = Object.keys(ACTION_LABEL).concat(["organization.*", "invitation.*", "plan.*", "staff.*"]);

  // Filters are applied on «تطبيق» (A07 keeps them in the URL hash, so the
  // back button returns to the previous filter).
  function AuditView({ fixedOrgId, query, setQuery }) {
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const offset = (page - 1) * AUDIT_PAGE;
    const pick = (q) => ({ organization_id: q.organization_id || "", actor: q.actor || "", action: q.action || "", from: q.from || "", to: q.to || "" });
    const [form, setForm] = useState(() => pick(query));
    const [err, setErr] = useState("");
    useEffect(() => { setForm(pick(query)); }, [query.organization_id, query.actor, query.action, query.from, query.to]); // eslint-disable-line react-hooks/exhaustive-deps
    const path = P("/audit") + qs({
      organization_id: fixedOrgId || query.organization_id || null, actor: query.actor || null, action: query.action || null,
      from: query.from || null, to: query.to || null, limit: AUDIT_PAGE, offset,
    });
    const res = useApi(path);
    const orgs = useApi(fixedOrgId ? null : P("/organizations") + qs({ limit: 200 }));
    const ids = { org: React.useId(), actor: React.useId(), action: React.useId(), from: React.useId(), to: React.useId(), list: React.useId() };
    const filtered = !!(query.organization_id || query.actor || query.action || query.from || query.to);

    function apply(e) {
      e.preventDefault();
      if (form.from && form.to && form.from > form.to) { setErr("تاريخ البداية بعد تاريخ النهاية"); return; }
      setErr("");
      const next = {};
      Object.keys(form).forEach((k) => { const v = String(form[k] || "").trim(); if (v) next[k] = v; });
      if (fixedOrgId) delete next.organization_id;
      setQuery(next);
    }
    function clear() { setErr(""); setForm(pick({})); setQuery({}); }
    const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

    return (
      <div className="card">
        <form className="pa-filters" role="search" aria-label="تصفية السجل" onSubmit={apply} noValidate>
          {!fixedOrgId && (
            <div className="pa-filter">
              <label className="label" htmlFor={ids.org}>العيادة</label>
              <select id={ids.org} className="input" value={form.organization_id} onChange={set("organization_id")}>
                <option value="">كل العيادات</option>
                {((orgs.data && orgs.data.data) || []).map((o) => <option key={o.id} value={o.id}>{o.name} ({o.slug})</option>)}
              </select>
            </div>
          )}
          <div className="pa-filter pa-filter-grow">
            <label className="label" htmlFor={ids.actor}>المستخدم</label>
            <input id={ids.actor} className="input" dir="ltr" value={form.actor} onChange={set("actor")} placeholder="البريد أو المعرّف"/>
          </div>
          <div className="pa-filter">
            <label className="label" htmlFor={ids.action}>نوع العملية</label>
            <input id={ids.action} className="input mono" dir="ltr" list={ids.list} value={form.action} onChange={set("action")} placeholder="organization.*"/>
            <datalist id={ids.list}>{KNOWN_ACTIONS.map((a) => <option key={a} value={a}>{ACTION_LABEL[a] || "كل العمليات التي تبدأ بـ " + a.slice(0, -1)}</option>)}</datalist>
          </div>
          <div className="pa-filter">
            <label className="label" htmlFor={ids.from}>من تاريخ</label>
            <input id={ids.from} className={"input" + (err ? " pa-invalid" : "")} type="date" dir="ltr" value={form.from} onChange={set("from")}/>
          </div>
          <div className="pa-filter">
            <label className="label" htmlFor={ids.to}>إلى تاريخ</label>
            <input id={ids.to} className={"input" + (err ? " pa-invalid" : "")} type="date" dir="ltr" value={form.to} onChange={set("to")}/>
          </div>
          <div className="pa-filter row gap-2" style={{ alignSelf: "flex-end" }}>
            <Btn kind="primary" type="submit"><I.Filter size={14}/> تطبيق</Btn>
            {filtered && <Btn kind="ghost" onClick={clear}>مسح</Btn>}
          </div>
          {err && <div className="pa-field-error" role="alert" style={{ flexBasis: "100%" }}>{err}</div>}
        </form>
        {res.error ? <div style={{ padding: 16 }}><ErrorBox error={res.error} onRetry={res.reload}/></div> : (
          <AuditTable rows={res.data ? res.data.data : null} loading={res.loading && !res.data} showOrg={!fixedOrgId}
            onEmpty={filtered ? "لا توجد عمليات مطابقة للتصفية." : "لا توجد عمليات مسجلة."}/>
        )}
        {res.data && <Pager offset={offset} limit={AUDIT_PAGE} count={res.data.count} loading={res.loading}
          onPage={(p) => setQuery({ ...query, page: String(p) })}/>}
      </div>
    );
  }

  function AuditPage({ query }) {
    const setQuery = useCallback((q) => {
      const next = { ...q };
      if (next.page === "1") delete next.page;
      nav.go("#/audit" + qs(next));
    }, []);
    return (
      <>
        <div className="page-head">
          <div>
            <h1 className="h1">سجل التدقيق</h1>
            <div className="muted" style={{ marginTop: 4 }}>كل عمليات المنصة والعيادات، الأحدث أولًا. في «نوع العملية» يطابق <Ltr className="mono">organization.*</Ltr> كل العمليات التي تبدأ بـ <Ltr className="mono">organization.</Ltr></div>
          </div>
        </div>
        <AuditView query={query} setQuery={setQuery}/>
      </>
    );
  }

  // ══════════════════════════════════════════════════════════════
  // Login, blocked screens, shell
  // ══════════════════════════════════════════════════════════════
  function BrandPanel() {
    return (
      <div className="pa-brand-panel">
        <div className="row gap-3" style={{ position: "relative" }}>
          <I.Logo size={36}/>
          <div>
            <div style={{ fontWeight: 700, fontSize: 19, color: "#0F1E2B" }}>ClinicSystem EG</div>
            <div style={{ fontSize: 12, color: "#1E4A6E" }}>لوحة إدارة المنصة</div>
          </div>
        </div>
        <div style={{ position: "relative", maxWidth: 420 }}>
          <div className="serif" style={{ fontSize: "clamp(28px, 4.5vw, 42px)", lineHeight: 1.15, color: "#0F1E2B", marginBottom: 14 }}>
            عيادات كثيرة، <em>لوحة واحدة</em>.
          </div>
          <p style={{ fontSize: 14.5, color: "#1E4A6E", lineHeight: 1.7, margin: 0 }}>
            أنشئ العيادات وفعّل ميزاتها، وحدّد خططها، وراجع سجل العمليات — لفريق المنصة فقط.
          </p>
        </div>
        <div style={{ position: "relative", fontSize: 12, color: "#1E4A6E" }}>© {new Date().getFullYear()} ClinicSystem EG</div>
      </div>
    );
  }

  function LoginScreen({ notice, onSignedIn }) {
    const [email, setEmail] = useState("");
    const [pw, setPw] = useState("");
    const [remember, setRemember] = useState(false);
    const [show, setShow] = useState(false);
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState({});
    const emailId = React.useId(), pwId = React.useId();
    async function submit(e) {
      e.preventDefault();
      const e2 = {};
      if (!EMAIL_RE.test(email.trim())) e2.email = "أدخل بريدًا إلكترونيًا صالحًا";
      if (!pw) e2.pw = "أدخل كلمة المرور";
      setErr(e2);
      if (Object.keys(e2).length) return;
      setBusy(true);
      let session = null, error = null;
      const a = authApi();
      if (a) {
        const r = await a.signInWithPassword({ email: email.trim(), password: pw, options: remember ? { remember: true } : undefined });
        if (r.error) error = { code: r.error.code, status: r.error.status, message: r.error.message };
        else {
          const s = r.data.session || {};
          session = { user: { id: s.user.id, email: s.user.email, name: (s.user.user_metadata || {}).name }, is_super_admin: !!s.is_super_admin };
        }
      } else {
        const r = await window.ClinicApi.request("POST", "/auth/login", { email: email.trim(), password: pw, remember });
        if (r.ok) session = r.data; else error = r.error;
      }
      setBusy(false);
      if (error) {
        setErr({ form: error.status === 401 ? "بيانات الدخول غير صحيحة" : errorText(error) });
        setPw("");
        return;
      }
      onSignedIn(session);
    }
    return (
      <div className="auth-grid">
        <BrandPanel/>
        <div className="pa-auth-form-wrap">
          <form className="pa-auth-form" onSubmit={submit} noValidate aria-labelledby="pa-login-title">
            <div className="pa-chip-platform"><PI.Shield size={14}/> مديرو المنصة فقط</div>
            <h1 className="h1" id="pa-login-title" style={{ fontSize: 28, margin: "10px 0 6px" }}>دخول لوحة المنصة</h1>
            <div className="muted" style={{ marginBottom: 22 }}>سجّل الدخول بحساب مدير المنصة.</div>
            {notice && <div style={{ marginBottom: 14 }}><Alert kind="amber">{notice}</Alert></div>}
            {err.form && <div style={{ marginBottom: 14 }}><Alert kind="red">{err.form}</Alert></div>}
            <Field id={emailId} label="البريد الإلكتروني" error={err.email}>
              <input {...describe(emailId, err.email)} type="email" dir="ltr" autoComplete="username" value={email}
                onChange={(e) => { setEmail(e.target.value); if (err.email || err.form) setErr({}); }} style={{ height: 42 }}/>
            </Field>
            <Field id={pwId} label="كلمة المرور" error={err.pw}>
              <div style={{ position: "relative" }}>
                <input {...describe(pwId, err.pw)} type={show ? "text" : "password"} dir="ltr" autoComplete="current-password" value={pw}
                  onChange={(e) => { setPw(e.target.value); if (err.pw || err.form) setErr({}); }} style={{ height: 42, paddingInlineEnd: 40 }}/>
                <button type="button" className="pa-eye" onClick={() => setShow(!show)} aria-label={show ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"} aria-pressed={show ? "true" : "false"}>
                  <I.Eye size={15}/>
                </button>
              </div>
            </Field>
            <label className="pa-check" style={{ marginTop: 4 }}>
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)}/> أبقني مسجلًا لمدة 30 يومًا
            </label>
            <Btn kind="primary" type="submit" busy={busy} className="pa-btn-block" style={{ marginTop: 18 }}>تسجيل الدخول</Btn>
          </form>
        </div>
      </div>
    );
  }

  function CenterCard({ icon, title, children, actions }) {
    return (
      <div className="pa-center">
        <div className="card pa-center-card" role="alert">
          <div className="pa-center-icon" aria-hidden="true">{icon}</div>
          <h1 className="h2" style={{ marginBottom: 8 }}>{title}</h1>
          <div className="muted" style={{ lineHeight: 1.7 }}>{children}</div>
          <div className="row gap-2" style={{ justifyContent: "center", marginTop: 20, flexWrap: "wrap" }}>{actions}</div>
        </div>
      </div>
    );
  }

  function Shell({ user, onLogout }) {
    const [loc, setLoc] = useState(() => parseHash(window.location.hash));
    const [navOpen, setNavOpen] = useState(false);
    const [leaveTo, setLeaveTo] = useState(null);
    const [loggingOut, setLoggingOut] = useState(false);
    const guardRef = useRef(null);
    const mainRef = useRef(null);
    const dirty = () => !!(guardRef.current && guardRef.current());

    useEffect(() => {
      const onHash = () => {
        const next = parseHash(window.location.hash);
        if (dirty() && routeOf(next).name !== "new") {
          // Leaving the wizard with unsaved input (e.g. the back button):
          // stay on it and ask first.
          const target = window.location.hash || "#/";
          window.history.pushState(null, "", hashUrl("#/clinics/new"));
          setLeaveTo(target);
          return;
        }
        setLoc(next);
        setNavOpen(false);
      };
      window.addEventListener("hashchange", onHash);
      nav.go = (hash, opts) => {
        const target = hash || "#/";
        if (dirty() && routeOf(parseHash(target)).name !== "new") { setLeaveTo(target); return; }
        if (opts && opts.replace) {
          window.history.replaceState(null, "", hashUrl(target));
          setLoc(parseHash(target));
        } else if (window.location.hash === target) {
          setLoc(parseHash(target));
        } else {
          window.location.hash = target;
        }
      };
      return () => {
        window.removeEventListener("hashchange", onHash);
        nav.go = (hash) => { window.location.hash = hash; };
      };
    }, []);

    const r = routeOf(loc);
    useEffect(() => { window.scrollTo(0, 0); }, [r.name, r.id]);
    const section = { stats: "stats", clinics: "clinics", new: "clinics", clinic: "clinics", catalog: "catalog", plans: "plans", audit: "audit" }[r.name];
    const NAV = [
      ["stats", "#/", "المؤشرات", <I.Dashboard size={16}/>],
      ["clinics", "#/clinics", "العيادات", <PI.Building size={16}/>],
      ["catalog", "#/catalog", "التخصصات والوحدات", <I.Layers size={16}/>],
      ["plans", "#/plans", "الخطط", <I.CreditCard size={16}/>],
      ["audit", "#/audit", "سجل التدقيق", <I.FileText size={16}/>],
    ];
    const titles = {
      stats: "المؤشرات", clinics: "العيادات", new: "إنشاء عيادة", clinic: "تفاصيل العيادة",
      catalog: "التخصصات والوحدات", plans: "الخطط", audit: "سجل التدقيق", notfound: "صفحة غير موجودة",
    };
    let page;
    switch (r.name) {
      case "stats": page = <StatsPage/>; break;
      case "clinics": page = <ClinicsPage query={r.query}/>; break;
      case "new": page = <WizardPage guardRef={guardRef}/>; break;
      case "clinic": page = <ClinicPage key={r.id} id={r.id} tab={r.tab}/>; break;
      case "catalog": page = <CatalogPage/>; break;
      case "plans": page = <PlansPage/>; break;
      case "audit": page = <AuditPage query={r.query}/>; break;
      default: page = <div className="card"><Empty title="الصفحة غير موجودة" body="الرابط غير معروف في لوحة المنصة." action={<a className="btn btn-secondary" href="#/">المؤشرات</a>}/></div>;
    }
    async function logout() {
      setLoggingOut(true);
      const ok = await onLogout();
      if (!ok) setLoggingOut(false);
    }
    const email = (user && user.email) || "";
    return (
      <div className="pa-root">
        <a className="pa-skip" href="#pa-main" onClick={(e) => { e.preventDefault(); if (mainRef.current) mainRef.current.focus(); }}>تخطَّ إلى المحتوى</a>
        <div className={"sidebar-backdrop" + (navOpen ? " open" : "")} onClick={() => setNavOpen(false)} aria-hidden="true"/>
        <aside className={"sidebar pa-sidebar" + (navOpen ? " open" : "")} aria-label="قائمة المنصة">
          <div className="pa-brand">
            <I.Logo size={30}/>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 14.5 }}>ClinicSystem EG</div>
              <div className="muted" style={{ fontSize: 11.5 }}>لوحة إدارة المنصة</div>
            </div>
          </div>
          <div className="nav-section">الإدارة</div>
          <nav aria-label="أقسام المنصة">
            {NAV.map(([key, href, label, icon]) => (
              <a key={key} href={href} className={"nav-item" + (section === key ? " active" : "")} aria-current={section === key ? "page" : undefined}
                onClick={() => setNavOpen(false)}>
                {icon}<span>{label}</span>
              </a>
            ))}
          </nav>
          <div className="grow"/>
          <div className="pa-userbox">
            <span className="av md" aria-hidden="true">{(email[0] || "?").toUpperCase()}</span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 12.5 }}>{(user && user.name) || "مدير المنصة"}</div>
              <div className="muted pa-ellipsis" style={{ fontSize: 11.5 }}><Ltr>{email}</Ltr></div>
            </div>
          </div>
        </aside>
        <div className="pa-main">
          <header className="topbar">
            <button type="button" className="mobile-menu-btn" aria-label="القائمة" aria-expanded={navOpen ? "true" : "false"} onClick={() => setNavOpen(!navOpen)}>
              <I.Menu size={18}/>
            </button>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="crumb" style={{ marginBottom: 0 }}><PI.Shield size={12}/> لوحة المنصة</div>
              <div className="h2 pa-ellipsis">{titles[r.name]}</div>
            </div>
            <span className="pa-who muted"><Ltr>{email}</Ltr></span>
            <Btn kind="secondary" busy={loggingOut} onClick={logout}><I.Logout size={15}/><span className="pa-hide-sm">تسجيل الخروج</span></Btn>
          </header>
          <main className="page pa-page" id="pa-main" ref={mainRef} tabIndex={-1}>{page}</main>
        </div>
        {leaveTo && (
          <ConfirmModal title="تجاهل التغييرات؟" kind="danger" confirmLabel="تجاهل والخروج"
            body="لن تُنشأ أي عيادة، وستضيع البيانات التي أدخلتها في المعالج."
            onClose={() => setLeaveTo(null)}
            onConfirm={() => {
              const target = leaveTo;
              guardRef.current = null;
              setLeaveTo(null);
              nav.go(target);
            }}/>
        )}
      </div>
    );
  }

  function Toasts({ items, onDismiss }) {
    return (
      <div className="pa-toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={"pa-toast pa-toast-" + t.kind} data-kind={t.kind}>
            <span className="pa-toast-dot" aria-hidden="true"/>
            <span className="grow">{t.msg}</span>
            <button type="button" className="pa-toast-x" aria-label="إغلاق الإشعار" onClick={() => onDismiss(t.id)}><I.X size={12}/></button>
          </div>
        ))}
      </div>
    );
  }

  // ══════════════════════════════════════════════════════════════
  // PlatformApp — session gate
  // ══════════════════════════════════════════════════════════════
  function PlatformApp() {
    // checking | anon | denied | blocked | error | ready
    const [auth, setAuth] = useState({ state: "checking" });
    const [toasts, setToasts] = useState([]);

    useEffect(() => {
      let n = 0;
      toastHub.push = (msg, kind) => {
        const id = ++n;
        setToasts((list) => list.concat({ id, msg, kind }).slice(-4));
        setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 4000);
      };
      return () => { toastHub.push = null; };
    }, []);

    const check = useCallback(async () => {
      setAuth({ state: "checking" });
      if (!window.ClinicApi) { setAuth({ state: "error", error: { code: "client_missing", status: 0 } }); return; }
      const res = await window.ClinicApi.request("GET", "/auth/session");
      if (res.ok) {
        const d = res.data || {};
        setAuth(d.is_super_admin ? { state: "ready", user: d.user } : { state: "denied", user: d.user });
      } else if (res.status === 401) {
        setAuth({ state: "anon" });
      } else {
        setAuth({ state: "error", error: res.error });
      }
    }, []);
    useEffect(() => { check(); }, [check]);

    useEffect(() => {
      sessionHooks.lost = () => setAuth((a) => (a.state === "ready" ? { state: "anon", notice: "انتهت الجلسة — سجّل الدخول من جديد" } : a));
      sessionHooks.blocked = (code) => setAuth((a) => ({ state: code === "not_super_admin" ? "denied" : "blocked", user: a.user, code }));
      return () => { sessionHooks.lost = null; sessionHooks.blocked = null; };
    }, []);

    useEffect(() => {
      const prev = document.title;
      document.title = "لوحة المنصة — ClinicSystem EG";
      return () => { document.title = prev; };
    }, []);

    const logout = useCallback(async () => {
      const a = authApi();
      let failed = false;
      if (a) {
        const r = await a.signOut();
        failed = !!r.error;
      } else {
        const r = await window.ClinicApi.request("POST", "/auth/logout");
        failed = !r.ok && r.status !== 401;
      }
      if (failed) { toast("تعذّر تسجيل الخروج — تحقق من الاتصال", "error"); return false; }
      apiCache.clear();
      setAuth({ state: "anon" });
      return true;
    }, []);

    let content;
    if (auth.state === "checking") {
      content = (
        <div className="pa-center" aria-busy="true">
          <div className="row gap-2 muted" role="status"><Spinner/> جارٍ التحقق من الجلسة…</div>
        </div>
      );
    } else if (auth.state === "anon") {
      content = <LoginScreen notice={auth.notice} onSignedIn={(s) => {
        setAuth(s.is_super_admin ? { state: "ready", user: s.user } : { state: "denied", user: s.user });
        if (s.is_super_admin) toast("مرحبًا بك في لوحة المنصة");
      }}/>;
    } else if (auth.state === "denied") {
      content = (
        <CenterCard icon={<I.Lock size={24}/>} title="ليست لديك صلاحية لوحة المنصة"
          actions={<>
            <LogoutButton onLogout={logout}/>
            <a className="btn btn-secondary" href="/">الموقع الرئيسي</a>
          </>}>
          <span data-not-authorized="">أنت مسجّل الدخول بالحساب <Ltr className="mono">{(auth.user && auth.user.email) || ""}</Ltr>، وهذا الحساب ليس من مديري المنصة. سجّل الخروج ثم ادخل بحساب مدير المنصة.</span>
        </CenterCard>
      );
    } else if (auth.state === "blocked") {
      content = (
        <CenterCard icon={<PI.Shield size={24}/>} title="افتح لوحة المنصة من عنوانها"
          actions={<LogoutButton onLogout={logout}/>}>
          تعمل لوحة المنصة من العنوان <Ltr className="mono">admin.{baseDomain()}</Ltr> فقط.
        </CenterCard>
      );
    } else if (auth.state === "error") {
      content = (
        <CenterCard icon={<PI.Alert size={24}/>} title="تعذّر التحقق من الجلسة"
          actions={<Btn kind="primary" onClick={check}><PI.Refresh size={14}/> إعادة المحاولة</Btn>}>
          {auth.error && (auth.error.status === 0 || auth.error.status === 429)
            ? errorText(auth.error)
            : "تعذّر الوصول إلى خادم المنصة — حاول مرة أخرى بعد قليل."}
        </CenterCard>
      );
    } else {
      content = <Shell user={auth.user} onLogout={logout}/>;
    }
    return (
      <div className="pa-app" data-platform-app="" data-auth={auth.state} dir="rtl" lang="ar">
        <style>{PLATFORM_CSS}</style>
        {content}
        <Toasts items={toasts} onDismiss={(id) => setToasts((l) => l.filter((t) => t.id !== id))}/>
      </div>
    );
  }

  function LogoutButton({ onLogout }) {
    const [busy, setBusy] = useState(false);
    return <Btn kind="primary" busy={busy} onClick={async () => { setBusy(true); const ok = await onLogout(); if (!ok) setBusy(false); }}><I.Logout size={15}/> تسجيل الخروج</Btn>;
  }

  // Panel styles: index.html tokens and classes (.btn, .card, .tbl, .badge,
  // .sidebar, .topbar, .modal, .switch …) plus these pa-* additions.
  const PLATFORM_CSS = `
.pa-app{min-height:100vh;min-height:100dvh;background:var(--ink-50)}
.pa-root{display:flex;min-height:100vh;min-height:100dvh}
.pa-sidebar{border-right:none;border-left:1px solid var(--ink-200);padding-bottom:12px}
.pa-brand{display:flex;align-items:center;gap:10px;padding:18px 18px 8px}
.pa-sidebar nav{display:flex;flex-direction:column;gap:2px}
.pa-userbox{display:flex;align-items:center;gap:10px;margin:0 10px;padding:10px;border-top:1px solid var(--ink-100)}
.pa-main{flex:1;min-width:0;display:flex;flex-direction:column}
.pa-page{width:100%;outline:none}
.pa-skip{position:absolute;inset-inline-start:-9999px;top:8px;z-index:400;background:#fff;padding:8px 12px;border-radius:8px;box-shadow:var(--shadow-md)}
.pa-skip:focus{inset-inline-start:8px}
.pa-who{font-size:12.5px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pa-ellipsis{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pa-nowrap{white-space:nowrap}
.pa-app .btn:disabled{opacity:.5;cursor:not-allowed}
.pa-btn-primary{background:var(--blue-700);color:#fff}
.pa-btn-primary:hover:not(:disabled){background:var(--blue-900)}
.pa-btn-danger{background:var(--red);color:#fff}
.pa-btn-danger:hover:not(:disabled){background:#B9473C}
.pa-btn-block{width:100%;height:44px;justify-content:center;font-size:14px}
.pa-app button:focus-visible,.pa-app a:focus-visible,.pa-app [role=switch]:focus-visible,.pa-app .input:focus-visible{outline:2px solid var(--blue-700);outline-offset:2px}
.pa-spinner{display:inline-block;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;flex-shrink:0}
.pa-field{margin-bottom:14px}
.pa-req{color:#A8443A}
.pa-field-error{color:#A8443A;font-size:12px;margin-top:5px;line-height:1.5}
.pa-help{color:var(--ink-500);font-size:12px;margin-top:5px;line-height:1.6}
.pa-app .input.pa-invalid{border-color:var(--red)}
.pa-app textarea.input{height:auto;min-height:70px;line-height:1.6;resize:vertical}
.pa-link{background:none;border:none;padding:0;color:var(--blue-700);font-weight:500;cursor:pointer;font-size:inherit;font-family:inherit}
.pa-link:hover{color:var(--blue-900);text-decoration:underline}
.pa-code{font-size:11.5px;color:var(--ink-500)}
.pa-link-text{color:var(--ink-700);font-size:13px}
.pa-ok{color:#2C8067;display:inline-flex;align-items:center;gap:4px}
.pa-bad{color:#A8443A;display:inline-flex;align-items:center;gap:4px}
.pa-b-dark{background:var(--ink-700);color:#fff}
.pa-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.pa-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:16px 18px}
.pa-card-link{display:block;border-radius:var(--radius-lg);transition:transform .12s}
.pa-card-link:hover .card{border-color:var(--ink-300);box-shadow:var(--shadow-md)}
.pa-filters{display:flex;flex-wrap:wrap;gap:12px;padding:16px 18px;border-bottom:1px solid var(--ink-100)}
.pa-filter{display:flex;flex-direction:column;min-width:150px}
.pa-filter-grow{flex:1 1 220px}
.pa-tbl tbody tr{height:48px}
.pa-pager{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:12px 18px;border-top:1px solid var(--ink-100);font-size:12.5px}
.pa-alert{display:flex;gap:10px;align-items:flex-start;padding:12px 14px;border-radius:12px;font-size:13px;line-height:1.7;border:1px solid}
.pa-alert-icon{display:inline-flex;margin-top:2px}
.pa-alert-red{background:var(--red-bg);border-color:#F1C4BE;color:#8E3A31}
.pa-alert-amber{background:var(--amber-bg);border-color:#EFD5AE;color:#7D4F18}
.pa-alert-blue{background:var(--blue-50);border-color:var(--blue-100);color:var(--blue-900)}
.pa-alert-grey{background:var(--ink-100);border-color:var(--ink-200);color:var(--ink-700)}
.pa-tabs{display:flex;gap:2px;border-bottom:1px solid var(--ink-200);overflow-x:auto;margin:6px 0 18px;scrollbar-width:none}
.pa-tab{border-bottom:2px solid transparent;padding:10px 14px;font-size:13.5px;font-weight:500;color:var(--ink-500);white-space:nowrap;margin-bottom:-1px}
.pa-tab:hover{color:var(--ink-900)}
.pa-tab[aria-selected="true"]{color:var(--blue-900);border-bottom-color:var(--blue-700)}
.pa-kv{display:grid;grid-template-columns:max-content 1fr;gap:9px 18px;margin:0;font-size:13px}
.pa-kv dt{color:var(--ink-500)}
.pa-kv dd{margin:0;min-width:0;overflow-wrap:anywhere}
.pa-chips{display:inline-flex;flex-wrap:wrap;gap:4px}
.pa-box{border:1px solid var(--ink-200);border-radius:12px;overflow:hidden}
.pa-mod-group-head{display:flex;align-items:baseline;gap:10px;padding:12px 16px;background:var(--ink-50);border-bottom:1px solid var(--ink-100)}
.pa-mod-row{display:flex;align-items:flex-start;gap:14px;padding:12px 16px;border-bottom:1px solid var(--ink-100)}
.pa-mod-group:last-child .pa-mod-row:last-child{border-bottom:none}
.pa-switch{border:none;padding:0;margin-top:2px}
.pa-switch:disabled{opacity:.5;cursor:not-allowed}
.pa-steps{list-style:none;margin:0;padding:16px 18px;gap:8px;border-bottom:1px solid var(--ink-100)}
.pa-step{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--ink-500);flex-shrink:0}
.pa-step + .pa-step::before{content:"";width:28px;height:1px;background:var(--ink-200);margin-inline-end:4px}
.pa-step-num{width:24px;height:24px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:var(--ink-100);color:var(--ink-700);font-size:12px;font-weight:600}
.pa-step-current{color:var(--ink-900);font-weight:600}
.pa-step-current .pa-step-num{background:var(--blue-700);color:#fff}
.pa-step-done .pa-step-num{background:var(--green-bg);color:#2C8067}
.pa-wizard-body{padding:20px 22px}
.pa-wizard-foot{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;padding:14px 22px;border-top:1px solid var(--ink-100);background:var(--ink-50);border-radius:0 0 var(--radius-lg) var(--radius-lg)}
.pa-slug{display:flex;align-items:stretch}
.pa-slug .input{border-top-right-radius:0;border-bottom-right-radius:0;min-width:0}
.pa-slug-suffix{display:flex;align-items:center;padding:0 12px;border:1px solid var(--ink-200);border-left:none;border-radius:0 10px 10px 0;background:var(--ink-100);color:var(--ink-700);font-size:12.5px;white-space:nowrap}
.pa-slug-msg{min-height:20px;font-size:12px;margin-top:5px;display:flex;align-items:center;gap:6px;color:var(--ink-500)}
.pa-choices{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px}
.pa-choice{display:flex;flex-direction:column;align-items:flex-start;gap:6px;text-align:start;border:1px solid var(--ink-200);border-radius:12px;padding:14px;background:#fff;cursor:pointer;font:inherit;color:inherit;transition:border-color .12s,background .12s}
.pa-choice:hover:not(:disabled){border-color:var(--ink-300)}
.pa-choice[aria-checked="true"]{border-color:var(--blue-700);background:var(--blue-50);box-shadow:0 0 0 3px rgba(58,127,181,.14)}
.pa-choice:disabled{opacity:.55;cursor:not-allowed}
.pa-limits{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:12px;color:var(--ink-500)}
.pa-limits b{color:var(--ink-900);font-weight:600}
.pa-summary{background:var(--ink-50);border:1px solid var(--ink-200);border-radius:12px;padding:16px}
.pa-done{display:flex;flex-direction:column;align-items:center;text-align:center;padding:32px 22px;gap:10px}
.pa-done .pa-kv{text-align:start;margin-top:8px}
.pa-done-icon{width:56px;height:56px;border-radius:50%;background:var(--green-bg);color:#2C8067;display:flex;align-items:center;justify-content:center}
.pa-modal-head{padding:18px 22px;border-bottom:1px solid var(--ink-100);display:flex;align-items:center;justify-content:space-between;gap:10px}
.pa-modal-body{padding:20px 22px}
.pa-modal-foot{padding:14px 22px;border-top:1px solid var(--ink-100);display:flex;justify-content:flex-end;gap:10px;background:var(--ink-50);border-radius:0 0 18px 18px}
.pa-fieldset{border:1px solid var(--ink-200);border-radius:12px;padding:10px 14px 12px;margin:4px 0 14px}
.pa-fieldset legend{padding:0 6px;margin-bottom:0}
.pa-check{display:flex;align-items:center;gap:8px;font-size:13px;padding:5px 0;cursor:pointer}
.pa-checks{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:2px 12px;margin-top:6px;padding-top:6px;border-top:1px dashed var(--ink-200)}
.pa-json{background:var(--ink-900);color:#E6EDF3;border-radius:10px;padding:12px 14px;font-family:var(--font-mono);font-size:12px;overflow:auto;max-height:50vh;margin:14px 0 0;text-align:left}
.pa-toasts{position:fixed;top:72px;left:16px;z-index:300;display:flex;flex-direction:column;gap:8px;max-width:min(380px,calc(100vw - 32px))}
.pa-toast{display:flex;align-items:center;gap:10px;background:#fff;border:1px solid var(--ink-200);border-radius:12px;box-shadow:var(--shadow-lg);padding:11px 12px 11px 14px;font-size:13.5px;animation:popin .2s}
.pa-toast-dot{width:8px;height:8px;border-radius:50%;background:var(--green);flex-shrink:0}
.pa-toast-error .pa-toast-dot{background:var(--red)}
.pa-toast-info .pa-toast-dot{background:var(--blue-700)}
.pa-toast-error{border-color:#F1C4BE}
.pa-toast-x{background:none;border:none;color:var(--ink-400);cursor:pointer;padding:4px;border-radius:6px;display:inline-flex}
.pa-toast-x:hover{background:var(--ink-100);color:var(--ink-700)}
.pa-center{min-height:100vh;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px 16px}
.pa-center-card{max-width:460px;width:100%;padding:32px 28px;text-align:center}
.pa-center-icon{width:56px;height:56px;border-radius:14px;background:var(--blue-100);color:var(--blue-700);display:flex;align-items:center;justify-content:center;margin:0 auto 14px}
.pa-brand-panel{background:linear-gradient(155deg,#7BBDE8 0%,#BDD8E9 60%,#E8F1F7 100%);padding:clamp(24px,4vw,40px) clamp(20px,5vw,48px);display:flex;flex-direction:column;justify-content:space-between;gap:28px;position:relative;overflow:hidden}
.pa-auth-form-wrap{display:flex;align-items:center;justify-content:center;padding:clamp(20px,5vw,40px)}
.pa-auth-form{width:100%;max-width:400px}
.pa-chip-platform{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;background:var(--violet-bg);color:#5A4BAD;font-size:12px;font-weight:500}
.pa-eye{position:absolute;inset-inline-end:6px;top:5px;padding:6px;border:none;background:transparent;cursor:pointer;color:var(--ink-500);border-radius:6px}
.pa-empty{padding:40px 16px;text-align:center}
@media (max-width:768px){
  .pa-hide-sm{display:none}
  .pa-who{display:none}
  .pa-sidebar{border-left:none}
  .pa-filter{min-width:0;flex:1 1 140px}
  .pa-wizard-body{padding:16px 14px}
  .pa-wizard-foot{padding:12px 14px}
  .pa-kv{grid-template-columns:1fr;gap:2px}
  .pa-kv dd{margin-bottom:8px}
  .pa-toasts{left:10px;right:10px;top:64px;max-width:none}
}
@media (max-width:640px){
  .pa-app .tbl-scroll{max-height:none;overflow:visible}
  .tbl-scroll > .pa-tbl,.pa-tbl{min-width:0;display:block}
  .pa-tbl thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
  .pa-tbl tbody{display:block}
  .pa-tbl tbody tr{display:block;height:auto;padding:8px 0;border-bottom:1px solid var(--ink-100)}
  .pa-tbl tbody tr:last-child{border-bottom:none}
  .pa-tbl tbody td{display:grid;grid-template-columns:max-content minmax(0,1fr);justify-items:end;align-items:center;column-gap:12px;row-gap:0;padding:5px 14px;border-bottom:none;background:transparent !important;text-align:end;min-height:32px}
  .pa-tbl tbody td > *{grid-column:2;max-width:100%}
  .pa-tbl tbody td[data-label]::before{content:attr(data-label);grid-column:1;grid-row:1 / span 4;justify-self:start;color:var(--ink-500);font-size:11.5px;font-weight:500;text-align:start}
  .pa-tbl tbody td:not([data-label]){grid-template-columns:minmax(0,1fr)}
  .pa-tbl tbody td:not([data-label]) > *{grid-column:1}
  .pa-tbl tbody td[colspan]{display:block;text-align:center}
  .pa-pager{justify-content:center}
}
`;

  window.PlatformApp = PlatformApp;
})();
