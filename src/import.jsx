// ===== src/import.jsx =====
// TEMPORARY historical patient import page — isolated route "?import=1".
// Built for speed: one screen, keyboard-first, continuous entry of ~5,000
// paper records, with multi-file document upload per patient.
//
// This page is intentionally standalone and NOT wired into the sidebar.
// To remove it after the migration: delete this file, its <script> tag in
// index.html, and the `importMode` guard in App() (src/screens2.jsx).
//
// Access: EVERY authenticated staff member (admin, receptionist, doctor,
// therapist). ImportAuthGate (bottom of this file) verifies the Supabase
// session and reads the role from the `staff` table in PostgreSQL before
// rendering — localStorage is never trusted; anonymous users get the
// login screen. RLS on `patients` / `patient_files` / the storage bucket
// is the real enforcement.
//
// Persistence reuses the existing backend:
//   • patient  → window.KineticData.upsert("patients", row)
//                (PostgreSQL first; files only after the row exists)
//   • files    → window.uploadPatientFile(patient_id, file, onProgress)
//                (Supabase Storage + patient_files table)

function HistoricalImportPage() {
  const blankForm = () => ({
    name: "", phone: "", gender: "F", age: "", dob: "", address: "",
    diagnosis: "", assigned: "", notes: "",
    registered: new Date().toISOString().slice(0, 10),
    status: "نشط",
  });

  const [form, setForm] = React.useState(blankForm);
  const [files, setFiles] = React.useState([]);   // { id, file, progress, status }
  const [saving, setSaving] = React.useState(false);
  const [errors, setErrors] = React.useState({});
  const [dragOver, setDragOver] = React.useState(false);
  // Session-only counter (in memory) — the patient workflow keeps nothing
  // authoritative in localStorage.
  const [count, setCount] = React.useState(0);
  const [last, setLast] = React.useState(null);   // {name, pid, files}

  const nameRef = React.useRef(null);
  const fileInputRef = React.useRef(null);
  const formRef = React.useRef(null);

  React.useEffect(() => { nameRef.current && nameRef.current.focus(); }, []);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // Care-team suggestions pulled from existing clinic data (input aid only).
  const teamOptions = React.useMemo(() => {
    const D = window.DATA || {};
    const set = new Set();
    (D.therapists || []).forEach(t => t && t.name && set.add(t.name));
    (D.appts || []).forEach(a => { if (a && a.dr) set.add(a.dr); if (a && a.th) set.add(a.th); });
    return [...set];
  }, []);

  // ── File staging ──────────────────────────────────────────────
  const OK_RE = /\.(pdf|jpe?g|png|webp|gif|bmp|tiff?|dcm|doc|docx|txt|heic|xls|xlsx)$/i;
  function isSupported(f) {
    return f.type.startsWith("image/") || f.type === "application/pdf" || OK_RE.test(f.name);
  }
  function addFiles(list) {
    const incoming = Array.from(list || []);
    if (!incoming.length) return;
    const valid = [], bad = [];
    for (const f of incoming) (isSupported(f) ? valid : bad).push(f);
    if (bad.length && window.showToast) window.showToast(`نوع غير مدعوم: ${bad.map(b => b.name || b).join("، ")}`, "error");
    if (valid.length) setFiles(prev => [
      ...prev,
      ...valid.map(f => ({ id: Math.random().toString(36).slice(2), file: f, progress: 0, status: "pending" })),
    ]);
  }
  function removeStaged(id) { setFiles(prev => prev.filter(x => x.id !== id)); }
  function onDrop(e) {
    e.preventDefault(); setDragOver(false);
    if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
  }

  // ── Save ──────────────────────────────────────────────────────
  function validate() {
    const e = {};
    if (!form.name.trim()) e.name = "الاسم مطلوب";
    if (!form.phone.trim()) e.phone = "رقم الهاتف مطلوب";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  // Try to resolve the assigned name to an existing therapist or doctor id
  // so the record links to the real care team, not just free text.
  function resolveAssigned(name) {
    const q = String(name || "").trim().toLowerCase();
    if (!q) return { therapist_id: null, doctor_id: null };
    const eq = (x) => String(x || "").trim().toLowerCase() === q;
    const th = ((window.DATA && window.DATA.therapists) || []).find(t => eq(t.name));
    const dr = ((window.DATA && window.DATA.doctors) || []).find(d => eq(d.name));
    return {
      therapist_id: th ? (th.id || th.therapist_id || null) : null,
      doctor_id:    dr ? (dr.id || null) : null,
    };
  }
  function normalizePhone(p) {
    return String(p || "").replace(/[^\d]/g, "");
  }

  async function save() {
    if (saving) return;
    if (!validate()) {
      if (window.showToast) window.showToast("أكمل الحقول المطلوبة", "error");
      const firstBad = !form.name.trim() ? nameRef.current
        : (formRef.current && formRef.current.querySelector('[name="phone"]'));
      firstBad && firstBad.focus();
      return;
    }

    // ── Preflight: verify auth before we touch the DB. ─────────
    // Without a session, the Supabase client falls back to the anon
    // key, `auth.uid()` in Postgres is null, `public.app_role()`
    // returns null, and the RLS staff policies reject the INSERT
    // (code 42501). Fail fast with a clear message instead of a
    // silent DB reject. The role is read from the `staff` table in
    // PostgreSQL (getAuthStaff) — never from localStorage or
    // user_metadata — and EVERY staff role may register patients.
    const sb = window.SB;
    if (!sb) {
      console.error("[import] save aborted — Supabase client not configured");
      if (window.showToast) window.showToast("لم يتم تكوين قاعدة البيانات", "error");
      return;
    }
    const auth = window.getAuthStaff
      ? await window.getAuthStaff()
      : { ok: false, reason: "no-database", error: "getAuthStaff غير متاح" };
    console.info("[import] verified auth state before insert", {
      ok:      auth.ok,
      reason:  auth.reason || null,
      userId:  auth.user && auth.user.id,
      email:   auth.user && auth.user.email,
      dbRole:  auth.role || "(no staff row)",
    });
    if (!auth.ok) {
      if (auth.reason === "no-session" || auth.reason === "invalid-session") {
        if (window.showToast) window.showToast("انتهت الجلسة — سجّل الدخول من جديد", "error");
        // Kick back to the login screen instead of letting a dead session linger.
        setTimeout(() => window.location.reload(), 1200);
      } else {
        if (window.showToast) window.showToast(auth.error || "تعذّر التحقق من الصلاحيات", "error");
      }
      return;
    }

    // Fast dedup: warn if the same phone is already in memory.
    const phoneKey = normalizePhone(form.phone);
    if (phoneKey) {
      const existing = ((window.DATA && window.DATA.patients) || []).find(
        p => normalizePhone(p.phone) === phoneKey
      );
      if (existing && !window.confirm(`يوجد مريض بنفس رقم الهاتف: ${existing.name}. متابعة إضافة سجل جديد؟`)) {
        return;
      }
    }

    setSaving(true);
    try {
      const pid = "P-" + Date.now().toString().slice(-8);
      const ageNum = form.age
        ? Number(form.age)
        : (form.dob ? Math.max(0, new Date().getFullYear() - new Date(form.dob).getFullYear()) : null);
      const assigned = resolveAssigned(form.assigned);

      const row = {
        patient_id: pid, id: pid,
        name: form.name.trim(),
        phone: form.phone.trim(),
        gender: (form.gender === "M" || form.gender === "F") ? form.gender : null,
        age: Number.isFinite(ageNum) ? ageNum : null,
        date_of_birth: form.dob || null,
        address: form.address.trim() || null,
        diagnosis: form.diagnosis.trim(),
        notes: form.notes.trim(),
        therapist_id: assigned.therapist_id,
        doctor_id: assigned.doctor_id,
        status: form.status || null,
        created_at: form.registered ? new Date(form.registered).toISOString() : new Date().toISOString(),
        updated_at: new Date().toISOString(),
        // UI-only aliases the schema whitelist strips out but the mirror uses.
        diag: form.diagnosis.trim(),
        th: form.assigned.trim(),
        registered: form.registered,
        remain: 0,
      };

      console.info("[import] outbound patients payload", row);
      const res = window.KineticData ? await window.KineticData.upsert("patients", row) : null;
      console.info("[import] upsert result", {
        _ok:     res && res._ok,
        _error:  res && res._error,
        row:     res,
      });
      if (!res || res._ok === false) {
        // Surface the EXACT PostgreSQL/RLS error and the operation that
        // failed — never a fake success.
        const msg = (res && res._error) || "تعذّر حفظ المريض في قاعدة البيانات";
        console.error("[import] patient insert rejected by Postgres", {
          operation: "UPSERT patients (INSERT ON CONFLICT UPDATE)",
          error: msg, payload: row,
        });
        if (window.showToast) window.showToast(`فشل INSERT في جدول patients — ${msg}`, "error");
        return;
      }

      // Verify by reading back directly from Postgres — no cache, no LS.
      // If the row is missing here, an RLS policy silently swallowed the
      // write and we should surface it instead of showing "saved".
      try {
        const fresh = window.KineticData ? await window.KineticData.list("patients") : [];
        const found = Array.isArray(fresh) && fresh.find(p => p.patient_id === pid || p.id === pid);
        console.info("[import] postgres readback", {
          totalPatients: Array.isArray(fresh) ? fresh.length : 0,
          foundNewRow:   !!found,
          pid,
        });
        if (!found) {
          console.error("[import] patient saved but not readable back from Postgres — likely RLS SELECT policy");
          if (window.showToast) window.showToast("تم الإرسال لكن السجل غير مرئي — تحقق من صلاحيات RLS", "error");
          return;
        }
      } catch (e) {
        console.error("[import] readback failed", e);
      }

      // Save patient first, then upload + link every file by the new patient_id.
      let uploaded = 0;
      for (const item of files) {
        setFiles(prev => prev.map(x => x.id === item.id ? { ...x, status: "uploading" } : x));
        try {
          const res = window.uploadPatientFile
            ? await window.uploadPatientFile(pid, item.file, (p) =>
                setFiles(prev => prev.map(x => x.id === item.id ? { ...x, progress: p } : x)))
            : { ok: false, error: "unavailable" };
          if (res && res.ok) {
            uploaded++;
            setFiles(prev => prev.map(x => x.id === item.id ? { ...x, status: "done", progress: 100 } : x));
          } else {
            const fErr = (res && res.error) || "سبب غير معروف";
            console.error("[import] file upload rejected", { file: item.file.name, error: fErr });
            if (window.showToast) window.showToast(`فشل رفع ${item.file.name} — ${fErr}`, "error");
            setFiles(prev => prev.map(x => x.id === item.id ? { ...x, status: "error", error: fErr } : x));
          }
        } catch (err) {
          console.error("[import] file upload threw", { file: item.file.name, error: err });
          if (window.showToast) window.showToast(`فشل رفع ${item.file.name} — ${err.message || err}`, "error");
          setFiles(prev => prev.map(x => x.id === item.id ? { ...x, status: "error" } : x));
        }
      }

      setCount(n => n + 1);
      setLast({ name: row.name, pid, files: uploaded });
      if (window.showToast) window.showToast(`تم حفظ ${row.name} · ${pid}${uploaded ? ` · ${uploaded} ملف` : ""}`, "success");

      // Reset for the next record — keep therapist, date and status to save keystrokes.
      setForm({ ...blankForm(), assigned: form.assigned, registered: form.registered, status: form.status });
      setFiles([]);
      setErrors({});
      setTimeout(() => nameRef.current && nameRef.current.focus(), 20);
    } finally {
      setSaving(false);
    }
  }

  // Enter (outside textarea) or Ctrl/Cmd+Enter saves; Esc clears the form.
  function onKeyDown(e) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); return; }
    if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") { e.preventDefault(); save(); return; }
    if (e.key === "Escape") {
      e.preventDefault();
      setForm(blankForm()); setFiles([]); setErrors({});
      nameRef.current && nameRef.current.focus();
    }
  }

  function exitImport() {
    try {
      const u = new URL(window.location.href);
      u.searchParams.delete("import");
      window.location.href = u.pathname + (u.search || "") + u.hash;
    } catch { window.location.href = "./"; }
  }

  const fmtBytes = (b) => b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
  const errStyle = { borderColor: "var(--red)", boxShadow: "0 0 0 3px rgba(216,102,90,.15)" };

  return (
    <div style={{ minHeight: "100vh", background: "var(--ink-50)" }} onKeyDown={onKeyDown}>
      {/* ── Slim header ─────────────────────────────────────────── */}
      <header style={{
        position: "sticky", top: 0, zIndex: 10, background: "#fff",
        borderBottom: "1px solid var(--ink-200)", padding: "10px clamp(12px,3vw,24px)",
        display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap"
      }}>
        <I.Logo size={26} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 14.5, display: "flex", alignItems: "center", gap: 8 }}>
            إدخال المرضى التاريخي
            <span className="badge b-amber" style={{ fontSize: 10 }}>مؤقّت</span>
          </div>
          <div className="muted" style={{ fontSize: 11.5 }}>إدخال سريع للسجلات الورقية · Enter للحفظ · Esc للمسح</div>
        </div>
        <div style={{ flex: 1 }} />
        <span className="badge b-green" title="عدد السجلات المُدخلة في هذه الجلسة">
          <span className="dot"></span> تم إدخال <span className="mono" style={{ margin: "0 4px" }}>{count}</span> مريض
        </span>
        <button className="btn btn-secondary" onClick={exitImport}><I.ArrowLeft size={13} /> عودة للتطبيق</button>
      </header>

      <div style={{ maxWidth: 1080, margin: "0 auto", padding: "18px clamp(12px,3vw,24px) 120px" }}>
        {last && (
          <div className="card" style={{ padding: "10px 14px", marginBottom: 14, display: "flex", alignItems: "center", gap: 10, background: "var(--green-bg)", border: "1px solid #BCE0D1" }}>
            <I.Check size={15} style={{ color: "var(--green)" }} />
            <span style={{ fontSize: 13 }}>آخر حفظ: <strong>{last.name}</strong> <span className="mono muted">({last.pid})</span>{last.files ? ` · ${last.files} ملف` : ""}</span>
          </div>
        )}

        <div ref={formRef} className="card card-pad">
          <div className="rgrid c-sm" style={{ "--gtc": "1fr 1fr", gap: 14 }}>
            <Field label="اسم المريض" required span={2}>
              <input ref={nameRef} name="name" className="input" style={errors.name ? errStyle : null}
                placeholder="مثال: هناء مصطفى" value={form.name} onChange={e => set("name", e.target.value)} autoComplete="off" />
              {errors.name && <div style={{ color: "var(--red)", fontSize: 11.5, marginTop: 4 }}>{errors.name}</div>}
            </Field>

            <Field label="رقم الهاتف" required>
              <input name="phone" className="input" style={errors.phone ? errStyle : null}
                placeholder="+20 1XX XXX XXXX" value={form.phone} onChange={e => set("phone", e.target.value)} autoComplete="off" inputMode="tel" />
              {errors.phone && <div style={{ color: "var(--red)", fontSize: 11.5, marginTop: 4 }}>{errors.phone}</div>}
            </Field>

            <Field label="الجنس">
              <div style={{ display: "flex", gap: 6 }}>
                {[["F", "أنثى"], ["M", "ذكر"]].map(([v, l]) => (
                  <button key={v} type="button" className={"btn " + (form.gender === v ? "btn-primary" : "btn-secondary")}
                    style={{ flex: 1, justifyContent: "center" }} onClick={() => set("gender", v)}>{l}</button>
                ))}
              </div>
            </Field>

            <Field label="العمر">
              <input name="age" className="input" type="number" min="0" max="120" placeholder="34"
                value={form.age} onChange={e => set("age", e.target.value)} />
            </Field>
            <Field label="تاريخ الميلاد (اختياري)">
              <input name="dob" className="input" type="date" value={form.dob} onChange={e => set("dob", e.target.value)} />
            </Field>

            <Field label="العنوان" span={2}>
              <input name="address" className="input" placeholder="الشارع، الحي، المدينة"
                value={form.address} onChange={e => set("address", e.target.value)} autoComplete="off" />
            </Field>

            <Field label="التشخيص / نوع الحالة" span={2}>
              <window.DiagnosisAutocomplete name="diagnosis" placeholder="e.g. L4–L5 disc herniation"
                value={form.diagnosis} onChange={e => set("diagnosis", e.target.value)} />
            </Field>

            <Field label="الطبيب / الأخصائي المسؤول">
              <input name="assigned" className="input" list="import-team" placeholder="اكتب أو اختر"
                value={form.assigned} onChange={e => set("assigned", e.target.value)} autoComplete="off" />
              <datalist id="import-team">{teamOptions.map(t => <option key={t} value={t} />)}</datalist>
            </Field>

            <Field label="تاريخ التسجيل">
              <input name="registered" className="input" type="date" value={form.registered} onChange={e => set("registered", e.target.value)} />
            </Field>

            <Field label="حالة العلاج الحالية" span={2}>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {["نشط", "غير نشط", "مكتمل", "متوقف"].map(s => (
                  <button key={s} type="button" className="btn btn-secondary"
                    style={{
                      background: form.status === s ? "var(--blue-50)" : "#fff",
                      borderColor: form.status === s ? "var(--blue-500)" : "var(--ink-200)",
                      color: form.status === s ? "var(--blue-900)" : "var(--ink-700)",
                    }}
                    onClick={() => set("status", s)}>{s}</button>
                ))}
              </div>
            </Field>

            <Field label="ملاحظات" span={2}>
              <textarea name="notes" className="input" style={{ height: 64, padding: 10, resize: "vertical" }}
                placeholder="ملاحظات من السجل الورقي (اختياري)" value={form.notes} onChange={e => set("notes", e.target.value)} />
            </Field>
          </div>

          {/* ── Document upload ──────────────────────────────────── */}
          <div className="label" style={{ marginTop: 16 }}>المستندات (أشعة، رنين، تقارير، تحاليل، صور، PDF…)</div>
          <div
            onClick={() => fileInputRef.current && fileInputRef.current.click()}
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            style={{
              border: `2px dashed ${dragOver ? "var(--blue-500)" : "var(--blue-300)"}`,
              background: dragOver ? "var(--blue-100)" : "var(--blue-50)",
              borderRadius: 14, padding: "18px", display: "flex", alignItems: "center", gap: 14,
              cursor: "pointer", transition: "all .12s", flexWrap: "wrap"
            }}>
            <div style={{ width: 40, height: 40, borderRadius: 11, background: "#fff", border: "1px solid var(--blue-300)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--blue-700)" }}>
              <I.Upload size={18} />
            </div>
            <div style={{ flex: 1, minWidth: 180 }}>
              <div style={{ fontWeight: 500, fontSize: 13.5 }}>أفلت الملفات هنا أو اضغط للاختيار</div>
              <div className="muted" style={{ fontSize: 11.5 }}>متعدد · صور، PDF، DICOM، مستندات · يُرفع بعد حفظ المريض</div>
            </div>
            <input ref={fileInputRef} type="file" multiple style={{ display: "none" }}
              accept="image/*,application/pdf,.pdf,.doc,.docx,.dcm,.xls,.xlsx,.txt"
              onChange={e => { addFiles(e.target.files); e.target.value = ""; }} />
            <button type="button" className="btn btn-secondary" onClick={e => { e.stopPropagation(); fileInputRef.current && fileInputRef.current.click(); }}>تصفّح</button>
          </div>

          {files.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
              {files.map(item => (
                <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", border: "1px solid var(--ink-200)", borderRadius: 10 }}>
                  <div style={{ width: 30, height: 30, borderRadius: 8, background: "var(--blue-100)", color: "var(--blue-700)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <I.FileText size={14} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{item.file.name}</div>
                    <div className="muted mono" style={{ fontSize: 10.5 }}>{fmtBytes(item.file.size)}</div>
                    {(item.status === "uploading" || item.status === "done") && (
                      <div style={{ height: 3, background: "var(--ink-100)", borderRadius: 999, overflow: "hidden", marginTop: 4 }}>
                        <div style={{ height: "100%", width: `${item.progress}%`, background: item.status === "done" ? "var(--green)" : "var(--blue-500)", transition: "width .2s" }} />
                      </div>
                    )}
                  </div>
                  {item.status === "done" && <span className="badge b-green" style={{ fontSize: 10 }}><I.Check size={10} /> تم</span>}
                  {item.status === "error" && <span className="badge b-red" style={{ fontSize: 10 }}>فشل</span>}
                  {item.status === "uploading" && <span className="badge b-blue" style={{ fontSize: 10 }}>{item.progress}%</span>}
                  {(item.status === "pending") && (
                    <button type="button" className="btn btn-ghost btn-icon" title="إزالة" onClick={() => removeStaged(item.id)}><I.X size={13} /></button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Sticky action bar ───────────────────────────────────── */}
      <div style={{
        position: "fixed", bottom: 0, left: 0, right: 0, background: "#fff",
        borderTop: "1px solid var(--ink-200)", boxShadow: "0 -2px 14px rgba(15,30,43,.05)",
        padding: "10px clamp(12px,3vw,24px)", display: "flex", alignItems: "center", gap: 12, zIndex: 20
      }}>
        <div className="muted" style={{ fontSize: 12, flex: 1, minWidth: 0 }}>
          <span className="mono">Enter</span> حفظ ومتابعة · <span className="mono">Esc</span> مسح · {files.length} ملف بالانتظار
        </div>
        <button type="button" className="btn btn-ghost" onClick={() => { setForm(blankForm()); setFiles([]); setErrors({}); nameRef.current && nameRef.current.focus(); }}>مسح</button>
        <button type="button" className="btn btn-blue" disabled={saving} onClick={save} style={{ minWidth: 160, justifyContent: "center" }}>
          {saving ? <span className="spin" style={{ width: 14, height: 14, border: "2px solid #fff", borderTopColor: "transparent", borderRadius: "50%" }} /> : <I.Check size={14} />}
          {saving ? "جارٍ الحفظ…" : "حفظ ومتابعة"}
        </button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// ImportAuthGate — authentication + authorization for ?import=1.
//
// Before rendering the page it:
//   1. verifies a Supabase Auth session exists and is valid server-side,
//   2. reads the user's role from the `staff` table in PostgreSQL,
//   3. allows EVERY staff role (admin, receptionist, doctor, therapist).
// No session → the Login screen. localStorage / sessionStorage /
// frontend variables are never consulted, so the gate can't be bypassed
// by forging cached state. (RLS remains the real enforcement layer.)
// ══════════════════════════════════════════════════════════════
function ImportAuthGate() {
  const [gate, setGate] = React.useState({ phase: "checking" });

  const runCheck = React.useCallback(async () => {
    setGate({ phase: "checking" });
    if (!window.getAuthStaff) {
      setGate({ phase: "error", error: "طبقة المصادقة غير محمّلة" });
      return;
    }
    const res = await window.getAuthStaff();
    console.info("[import] gate check", { ok: res.ok, reason: res.reason || null, role: res.role || null });
    if (res.ok) {
      // Expose the VERIFIED identity to data-scoping helpers. save()
      // re-verifies independently before every insert.
      window.ME = {
        id: res.staff.staff_id || res.user.id,
        name: res.staff.name || res.user.email,
        email: res.user.email,
        role: res.role,
        scope: window.roleScope ? window.roleScope(res.role) : "all",
      };
      setGate({ phase: "ok", auth: res });
      return;
    }
    if (res.reason === "no-session" || res.reason === "invalid-session") {
      setGate({ phase: "login" });
      return;
    }
    if (res.reason === "no-database") {
      setGate({ phase: "error", error: res.error });
      return;
    }
    // staff-lookup-failed / no-staff-role / role-not-staff
    setGate({ phase: "denied", error: res.error, role: res.role || null });
  }, []);

  React.useEffect(() => { runCheck(); }, [runCheck]);

  function exitToApp() {
    try {
      const u = new URL(window.location.href);
      u.searchParams.delete("import");
      window.location.href = u.pathname + (u.search || "") + u.hash;
    } catch { window.location.href = "./"; }
  }

  if (gate.phase === "checking") {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--ink-50)", gap: 10 }}>
        <span className="spin" style={{ width: 18, height: 18, border: "2px solid var(--blue-500)", borderTopColor: "transparent", borderRadius: "50%" }} />
        <span className="muted" style={{ fontSize: 13.5 }}>جارٍ التحقق من الجلسة والصلاحيات…</span>
      </div>
    );
  }

  // No valid session → the Login page. On success re-run the DB check
  // (the Supabase session set by signInEmail is what actually matters).
  if (gate.phase === "login") {
    return <AuthScreen onLogin={() => runCheck()} onBookAsGuest={() => {}} />;
  }

  if (gate.phase === "denied" || gate.phase === "error") {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--ink-50)", padding: 24 }}>
        <div className="card card-pad" style={{ maxWidth: 460, textAlign: "center" }}>
          <div style={{ fontSize: 34, marginBottom: 10 }}>🔒</div>
          <div className="h3" style={{ marginBottom: 6 }}>لا يمكن فتح صفحة الإدخال</div>
          <div className="muted" style={{ fontSize: 13.5, marginBottom: 8 }}>
            الصفحة متاحة لكل الموظفين (مدير، استقبال، طبيب، أخصائي) بعد التحقق من الدور في قاعدة البيانات.
          </div>
          <div style={{ fontSize: 12.5, color: "var(--red)", marginBottom: 16, direction: "rtl" }}>
            {gate.error || "سبب غير معروف"}{gate.role ? ` — الدور الحالي: ${gate.role}` : ""}
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
            <button className="btn btn-secondary" onClick={() => runCheck()}>إعادة المحاولة</button>
            <button className="btn btn-blue" onClick={exitToApp}>عودة للتطبيق</button>
          </div>
        </div>
      </div>
    );
  }

  return <HistoricalImportPage />;
}

window.HistoricalImportPage = HistoricalImportPage;
window.ImportAuthGate = ImportAuthGate;
