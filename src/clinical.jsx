// ══════════════════════════════════════════════════════════════
// Clinical records of the patient file (0018_clinical_records; docs/05
// «assessments», «dental_findings», «prescriptions»; owner request 26 Oct
// 2026): the diagnosis and the patient file follow the clinic's department.
//
//   clinicForm()   → "physio" | "dental" | "general" (the Super Admin's
//                    choice for the clinic's specialty)
//   ClinicalAPI    → the patient's diagnoses, tooth findings and
//                    prescriptions, read when the file opens (not at
//                    startup, docs/06 S9); localStorage in demo mode
//   BodyDiagram    → the body picture with the pain points
//
// The pain points are coordinates only: [[x, y], ...] in percent of
// assets/body-diagram.jpeg (one decimal); the picture is never stored, and
// its view (left side / back / front / right side) follows from x.
// ══════════════════════════════════════════════════════════════

const CLINICAL_FORMS = ["physio", "dental", "general"];

function clinicForm() {
  const org = window.TENANT_ORG || {};
  if (CLINICAL_FORMS.includes(org.diagnosis_form)) return org.diagnosis_form;
  if (org.specialty_code === "physio" || org.specialty_code === "dental") return org.specialty_code;
  // Demo mode and the single-clinic product: physiotherapy.
  return org.specialty_code ? "general" : "physio";
}

// Admin, doctor and therapist read and write the clinical record; a
// prescription is written by admin and doctor (owner decision, 0018).
function clinicalRole() {
  const r = window.TENANT_ROLE || (window.ME && window.ME.role) || "";
  return { admin: "admin", "مدير": "admin", doctor: "doctor", "طبيب": "doctor",
    therapist: "therapist", "الأخصائي": "therapist", receptionist: "receptionist", "موظف استقبال": "receptionist" }[r] || r || "admin";
}
function canReadClinical() { return ["admin", "doctor", "therapist"].includes(clinicalRole()); }
function canPrescribe() { return ["admin", "doctor"].includes(clinicalRole()); }

// ── pain points ────────────────────────────────────────────────
const BODY_VIEW_LABELS = { left: "الجانب الأيسر", back: "الخلف", front: "الأمام", right: "الجانب الأيمن" };
function bodyView(x) { return x < 25 ? "left" : x < 50 ? "back" : x < 75 ? "front" : "right"; }
const round1 = (n) => Math.round(Math.min(100, Math.max(0, Number(n))) * 10) / 10;

// {x, y} or [x, y] → [[x, y], ...] as stored (0–100, one decimal, ≤ 200).
function encodeMarkers(list) {
  return (Array.isArray(list) ? list : [])
    .map(m => (Array.isArray(m) ? m : m && [m.x, m.y]))
    .filter(p => p && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])))
    .slice(0, 200)
    .map(([x, y]) => [round1(x), round1(y)]);
}
// Stored → [{x, y, view}] for the picture.
function decodeMarkers(stored) {
  return encodeMarkers(stored).map(([x, y]) => ({ x, y, view: bodyView(x) }));
}

// ── the physio diagnosis form ↔ an assessments row ─────────────
// (PhysioSessionForm, src/screens2.jsx)
const PHYSIO_EMPTY = {
  diagnosis: "",
  cervical:  { on: false, mode: null },  // supine | sitting
  thll:      { on: false, mode: null },  // unilat | Bilat
  thpl:      { on: false, mode: null },  // flat   | 90/90
  shortWave: false,
  tractionNotes: "",
  modalities: {},                        // { [name]: true }
  modalitiesNotes: "",
  nGlide: false,
  nGlideNotes: "",
  msRelease: "",
  positioning: "",
  exercises: "",
  manualNotes: "",
  markers: [],                           // [{ view, x, y }]
};

// The form's fields kept in assessments.data (besides diagnosis and markers).
const PHYSIO_DATA_KEYS = ["cervical", "thll", "thpl", "shortWave", "tractionNotes", "modalitiesNotes",
  "nGlide", "nGlideNotes", "msRelease", "positioning", "exercises", "manualNotes"];

// The form → an assessments row: the form's fields in data, the pain points
// as [[x, y]] (encodeMarkers), never the picture.
function physioRowFromForm(form, { patientId, therapistId, therapistName, id }) {
  const data = {};
  for (const k of PHYSIO_DATA_KEYS) data[k] = form[k];
  data.modalities = Object.keys(form.modalities || {}).filter(k => form.modalities[k]);
  return {
    ...(id ? { assessment_id: id } : {}),
    patient_id: patientId,
    kind: "physio",
    clinician_id: therapistId || null,
    clinician_name: therapistName || null,
    diagnosis: (form.diagnosis || "").trim() || null,
    data,
    markers: encodeMarkers(form.markers),
  };
}

// An assessments row (or an old device draft) → the form.
function physioFormFromRow(row) {
  const d = (row && row.data) || {};
  const form = { ...PHYSIO_EMPTY, diagnosis: (row && row.diagnosis) || "" };
  for (const k of PHYSIO_DATA_KEYS) if (d[k] !== undefined && d[k] !== null) form[k] = d[k];
  form.modalities = Object.fromEntries((Array.isArray(d.modalities) ? d.modalities : []).map(n => [n, true]));
  form.markers = decodeMarkers(row && row.markers);
  return form;
}

// ── data ───────────────────────────────────────────────────────
const CLINICAL_LS = "kinetic.clinical.v1";
const CLINICAL_TABLES = {
  assessments:     { pk: "assessment_id",   prefix: "ASM-", order: ["visit_date", "created_at"] },
  dental_findings: { pk: "finding_id",      prefix: "DF-",  order: ["recorded_on", "created_at"] },
  prescriptions:   { pk: "prescription_id", prefix: "RX-",  order: ["prescribed_on", "created_at"] },
};

function clinicalLocal() {
  try { return JSON.parse(localStorage.getItem(CLINICAL_LS) || "{}") || {}; } catch (_) { return {}; }
}
function clinicalLocalSave(store) {
  try { localStorage.setItem(CLINICAL_LS, JSON.stringify(store)); } catch (_) {}
}
const newestFirst = (cols) => (a, b) => {
  for (const c of cols) {
    const d = String(b[c] || "").localeCompare(String(a[c] || ""));
    if (d) return d;
  }
  return 0;
};

// A refused write in the page language (RLS, a module the clinic does not
// have, a value the database refuses).
function clinicalError(error, fallback) {
  const code = (error && error.code) || "";
  if (code === "42501") return tt("السجل السريري للطبيب والأخصائي والمدير فقط");
  if (code === "module_disabled") return tt("هذه الوحدة غير مفعّلة لعيادتك");
  if (code === "23514") return tt("بعض البيانات غير صالحة — راجعها ثم احفظ");
  return (window.__refusalText && window.__refusalText(error)) || fallback;
}

function clinicalUpdated(table, patientId) {
  window.dispatchEvent(new CustomEvent("kinetic:clinical-updated", { detail: { table, patientId } }));
}

const ClinicalAPI = {
  // The patient's rows of one table, newest first.
  async list(table, patientId) {
    const meta = CLINICAL_TABLES[table];
    if (!meta || !patientId) return [];
    const sb = window.SB;
    if (!sb) {
      return (clinicalLocal()[table] || []).filter(r => r.patient_id === patientId).sort(newestFirst(meta.order));
    }
    let q = sb.from(table).select("*").eq("patient_id", patientId);
    for (const c of meta.order) q = q.order(c, { ascending: false });
    const { data, error } = await q.range(0, 499);
    if (error) throw Object.assign(new Error(clinicalError(error, tt("تعذّر تحميل السجل السريري"))), { code: error.code });
    return data || [];
  },

  // Insert (no id) or update (id): only the given columns are sent; the
  // author and the clinic come from the session on the server.
  async save(table, row) {
    const meta = CLINICAL_TABLES[table];
    const id = row[meta.pk];
    const values = { ...row };
    for (const k of ["author_uid", "author_name", "created_at", "updated_at", "organization_id"]) delete values[k];
    const sb = window.SB;
    if (!sb) {
      const store = clinicalLocal();
      const rows = store[table] || [];
      const now = new Date().toISOString();
      const me = window.ME || {};
      let saved;
      if (id) {
        saved = { ...(rows.find(r => r[meta.pk] === id) || {}), ...values, updated_at: now };
        store[table] = rows.map(r => (r[meta.pk] === id ? saved : r));
      } else {
        const day = now.slice(0, 10);
        saved = { visit_date: day, recorded_on: day, prescribed_on: day, ...values,
          [meta.pk]: newRecordId(meta.prefix), author_name: me.name || me.email || "", created_at: now, updated_at: now };
        store[table] = [saved, ...rows];
      }
      clinicalLocalSave(store);
      clinicalUpdated(table, saved.patient_id);
      return saved;
    }
    const { data, error } = id
      ? await sb.from(table).update(values).eq(meta.pk, id).select().single()
      : await sb.from(table).insert(values).select().single();
    if (error) throw Object.assign(new Error(clinicalError(error, tt("تعذّر الحفظ"))), { code: error.code });
    clinicalUpdated(table, data && data.patient_id);
    return data;
  },

  async remove(table, id, patientId) {
    const meta = CLINICAL_TABLES[table];
    const sb = window.SB;
    if (!sb) {
      const store = clinicalLocal();
      store[table] = (store[table] || []).filter(r => r[meta.pk] !== id);
      clinicalLocalSave(store);
      clinicalUpdated(table, patientId);
      return;
    }
    const { data, error } = await sb.from(table).delete().eq(meta.pk, id).select();
    if (error) throw Object.assign(new Error(clinicalError(error, tt("تعذّر الحذف"))), { code: error.code });
    if (!data || !data.length) throw new Error(tt("لا يمكنك حذف هذا السجل — يحذفه كاتبه أو الطبيب أو المدير"));
    clinicalUpdated(table, patientId);
  },
};

// The patient's rows of `tables`, reloaded when one of them changes.
// → { rows: {table: [...]}, loading, error, reload }
function useClinical(patientId, tables) {
  const key = tables.join(",");
  const [state, setState] = React.useState({ rows: {}, loading: true, error: "" });
  const load = React.useCallback(async () => {
    if (!patientId || !canReadClinical()) { setState({ rows: {}, loading: false, error: "" }); return; }
    setState(s => ({ ...s, loading: true, error: "" }));
    try {
      const lists = await Promise.all(tables.map(t => ClinicalAPI.list(t, patientId)));
      setState({ rows: Object.fromEntries(tables.map((t, i) => [t, lists[i]])), loading: false, error: "" });
    } catch (e) {
      setState(s => ({ ...s, loading: false, error: e.message || tt("تعذّر تحميل السجل السريري") }));
    }
  }, [patientId, key]);
  React.useEffect(() => { load(); }, [load]);
  React.useEffect(() => {
    const on = (e) => { const d = e.detail || {}; if (!d.patientId || d.patientId === patientId) load(); };
    window.addEventListener("kinetic:clinical-updated", on);
    return () => window.removeEventListener("kinetic:clinical-updated", on);
  }, [load, patientId]);
  return { ...state, reload: load };
}

// ═══════════════════════════════════════════════════════════════════
// BodyDiagram — the body picture with percentage-based pain points.
// The image holds 4 figures in a row (left side, back, front, right side);
// a tap adds a point, a tap near one (HIT_RADIUS %) removes it. Positions are
// physical (left/top of the picture) on purpose: never mirrored in RTL.
// readOnly: the saved points only (patient file).
// ═══════════════════════════════════════════════════════════════════
function BodyDiagram({ markers, onChange, readOnly = false, label }) {
  const wrapRef = React.useRef(null);
  const HIT_RADIUS = 3;
  const points = markers || [];

  function pointFromEvent(e) {
    const el = wrapRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const pt = (e.changedTouches && e.changedTouches[0]) || (e.touches && e.touches[0]) || e;
    if (pt.clientX == null) return null;
    const x = ((pt.clientX - rect.left) / rect.width) * 100;
    const y = ((pt.clientY - rect.top) / rect.height) * 100;
    if (x < 0 || x > 100 || y < 0 || y > 100) return null;
    return { x: round1(x), y: round1(y) };
  }

  function handleTap(e) {
    if (readOnly || !onChange) return;
    const p = pointFromEvent(e);
    if (!p) return;
    const hitIdx = points.findIndex(m => Math.hypot(m.x - p.x, m.y - p.y) < HIT_RADIUS);
    if (hitIdx >= 0) { onChange(points.filter((_, i) => i !== hitIdx)); return; }
    if (points.length >= 200) return;
    onChange([...points, { view: bodyView(p.x), x: p.x, y: p.y }]);
  }

  return (
    <div ref={wrapRef} dir="ltr" data-body-diagram={readOnly ? "view" : "edit"}
      role={readOnly ? "img" : undefined}
      aria-label={label || (readOnly ? tt("مخطط الجسم: {n} موضع ألم", { n: points.length }) : undefined)}
      onClick={handleTap}
      onTouchEnd={readOnly ? undefined : (e) => { e.preventDefault(); handleTap(e); }}
      style={{
        position: "relative", width: "100%", background: "#fff",
        border: "1px solid var(--ink-200)", borderRadius: 12, overflow: "hidden",
        userSelect: "none", touchAction: "manipulation", cursor: readOnly ? "default" : "crosshair",
      }}>
      <img src="/assets/body-diagram.jpeg" alt={readOnly ? "" : tt("مخطط الجسم")} draggable={false}
        style={{ width: "100%", display: "block", pointerEvents: "none" }}/>
      {points.map((m, i) => (
        <div key={i} data-marker={`${m.x},${m.y}`} style={{
          position: "absolute", left: `${m.x}%`, top: `${m.y}%`,
          width: 14, height: 14, marginLeft: -7, marginTop: -7, borderRadius: "50%",
          background: "var(--red)", border: "2px solid #fff", boxShadow: "0 1px 4px rgba(0,0,0,0.35)",
          pointerEvents: "none",
        }}/>
      ))}
    </div>
  );
}

// "12 أكتوبر 2026 · د. أحمد" for a record.
function clinicalByline(date, name) {
  return [date ? fmtDate(date) : "", name || ""].filter(Boolean).join(" · ");
}

// ── the patient file of the clinic's department ────────────────
// physio: PatientDetail (src/screens1.jsx) with its «التشخيص» tab;
// dental: DentalPatientDetail (src/dental.jsx); general: GeneralPatientDetail
// (src/general.jsx).
function PatientFile(props) {
  const form = clinicForm();
  if (form === "dental" && window.DentalPatientDetail) return <window.DentalPatientDetail {...props}/>;
  if (form === "general" && window.GeneralPatientDetail) return <window.GeneralPatientDetail {...props}/>;
  return <PatientDetail {...props}/>;
}

function ClinicalRow({ k, v }) {
  if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) return null;
  return (
    <div style={{display:"grid",gridTemplateColumns:"140px 1fr",gap:8,padding:"7px 0",borderBottom:"1px dashed var(--ink-100)",fontSize:12.5}}>
      <span className="muted">{k}</span>
      <span style={{color:"var(--ink-900)",whiteSpace:"pre-wrap"}}>{v}</span>
    </div>
  );
}

// One diagnosis record, whatever its form (a clinic may change form later:
// each record keeps the fields it was written with).
function AssessmentDetails({ a }) {
  const d = a.data || {};
  const on = (row, name) => row && row.on ? [name, row.mode].filter(Boolean).join(" — ") : null;
  return (
    <div data-assessment={a.assessment_id}>
      <ClinicalRow k={tt("الشكوى الرئيسية")} v={a.complaint}/>
      <ClinicalRow k={tt("التشخيص")} v={a.diagnosis}/>
      {a.kind === "physio" && <>
        <ClinicalRow k="Traction" v={[on(d.cervical, "Cervical"), on(d.thll, "TH, LL"), on(d.thpl, "TH, PL"), d.shortWave ? "Short wave" : null].filter(Boolean).join(" · ")}/>
        <ClinicalRow k="Traction notes" v={d.tractionNotes}/>
        <ClinicalRow k="Modalities" v={(d.modalities || []).join(" · ")}/>
        <ClinicalRow k="Modalities notes" v={d.modalitiesNotes}/>
        <ClinicalRow k="N. Glide" v={d.nGlide ? (d.nGlideNotes || "✓") : null}/>
        <ClinicalRow k="Ms Release" v={d.msRelease}/>
        <ClinicalRow k="Positioning" v={d.positioning}/>
        <ClinicalRow k="Ex's, Stretching, Mobilization, Manipulation" v={d.exercises}/>
        <ClinicalRow k="Manual Techniques notes" v={d.manualNotes}/>
      </>}
      {a.kind !== "physio" && <>
        <ClinicalRow k={tt("الفحص")} v={d.examination}/>
        <ClinicalRow k={tt("ما تم اليوم")} v={d.treatment_done}/>
        <ClinicalRow k={tt("الخطة")} v={d.plan}/>
        <ClinicalRow k={tt("المتابعة")} v={d.follow_up || d.next_visit}/>
      </>}
      <ClinicalRow k={tt("ملاحظات")} v={a.notes}/>
    </div>
  );
}

// Where on the body: "الخلف: 2 · الأمام: 1".
function markerSummary(points) {
  const n = {};
  for (const m of points) n[m.view] = (n[m.view] || 0) + 1;
  return ["left", "back", "front", "right"].filter(v => n[v])
    .map(v => tt("{view}: {n}", { view: tt(BODY_VIEW_LABELS[v]), n: n[v] })).join(" · ");
}

// «التشخيص» in the physio patient file: the body picture with the saved
// pain points of a diagnosis (the latest, or one picked from the list) and
// its fields; «تشخيص جديد» opens the form for this patient.
function PhysioDiagnosisTab({ p, onNew }) {
  const pid = p.patient_id || p.id;
  const { rows, loading, error, reload } = useClinical(pid, ["assessments"]);
  const list = rows.assessments || [];
  const [sel, setSel] = React.useState(null);
  const cur = list.find(a => a.assessment_id === sel) || list[0] || null;
  const points = cur ? decodeMarkers(cur.markers) : [];
  return (
    <div data-tab="diagnosis">
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,marginBottom:14,flexWrap:"wrap"}}>
        <div>
          <h2 className="h3" style={{margin:0}}>{tt("مخطط الألم والتشخيص")}</h2>
          <div className="muted" style={{fontSize:12.5,marginTop:2}}>{tt("المواضع التي حددها الأخصائي على مخطط الجسم عند التشخيص.")}</div>
        </div>
        <button className="btn btn-blue" onClick={onNew}><I.Activity size={13}/> {tt("تشخيص جديد")}</button>
      </div>
      {loading && !list.length && <div className="muted" role="status" style={{fontSize:13}}>{tt("جارٍ التحميل…")}</div>}
      {error && <div role="alert" style={{color:"#A8443A",fontSize:13,marginBottom:10}}>{error} <button className="btn btn-ghost" onClick={reload}>{tt("إعادة المحاولة")}</button></div>}
      {!loading && !error && !list.length && (
        <EmptyState icon={<I.Activity size={22}/>} title={tt("لا تشخيص محفوظ بعد")} body={tt("سجّل أول تشخيص لهذا المريض وحدد مواضع الألم على مخطط الجسم.")}/>
      )}
      {cur && (
        <div className="rgrid c-md" style={{"--gtc":"minmax(0,1.5fr) minmax(0,1fr)",gap:20}}>
          <div>
            <BodyDiagram readOnly markers={points}/>
            <div className="muted" style={{fontSize:12,marginTop:8}}>
              {tt("المواضع المحددة: {n}", { n: points.length })}{points.length ? " — " + markerSummary(points) : ""}
            </div>
          </div>
          <div>
            {list.length > 1 && (
              <div role="listbox" aria-label={tt("التشخيصات السابقة")} style={{display:"flex",flexDirection:"column",gap:6,marginBottom:14}}>
                {list.map(a => {
                  const active = a.assessment_id === cur.assessment_id;
                  return (
                    <button key={a.assessment_id} type="button" role="option" aria-selected={active ? "true" : "false"}
                      onClick={() => setSel(a.assessment_id)}
                      style={{textAlign:"start",padding:"8px 12px",borderRadius:10,cursor:"pointer",
                        border:"1px solid " + (active ? "var(--blue-500)" : "var(--ink-200)"),
                        background: active ? "var(--blue-50)" : "#fff"}}>
                      <div style={{fontSize:12.5,fontWeight:600}}>{clinicalByline(a.visit_date, a.clinician_name || a.author_name)}</div>
                      <div className="muted" style={{fontSize:12,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{a.diagnosis || "—"}</div>
                    </button>
                  );
                })}
              </div>
            )}
            <div className="muted" style={{fontSize:12,marginBottom:6}}>{clinicalByline(cur.visit_date, cur.clinician_name || cur.author_name)}</div>
            <AssessmentDetails a={cur}/>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// Shared by the dental (src/dental.jsx) and general (src/general.jsx)
// patient files: the header with the medical alerts, the visit note (the
// diagnosis of those departments), prescriptions and appointments.
// ═══════════════════════════════════════════════════════════════════

// Allergies, medications, chronic diseases and history from the patient
// record: what a clinician must see before treating.
function medicalAlerts(p) {
  const out = [];
  const text = (v) => (typeof v === "string" ? v.trim() : "");
  if (text(p.allergies)) out.push({ tone: "red", label: tt("حساسية: {x}", { x: text(p.allergies) }) });
  for (const c of (Array.isArray(p.chronic) ? p.chronic : [])) if (c) out.push({ tone: "amber", label: c });
  if (text(p.medications)) out.push({ tone: "amber", label: tt("أدوية: {x}", { x: text(p.medications) }) });
  if (text(p.medical_history)) out.push({ tone: "amber", label: tt("تاريخ مرضي: {x}", { x: text(p.medical_history) }) });
  return out;
}

function ClinicalPatientHeader({ p, onBack, actions }) {
  const alerts = medicalAlerts(p);
  const fileNo = p.medical_file_no || p.id;
  return (
    <>
      <button type="button" className="btn btn-ghost" onClick={onBack} style={{marginBottom:8,paddingInline:6}}>
        {IS_RTL ? <I.ArrowRight size={14}/> : <I.ArrowLeft size={14}/>} {tt("كل المرضى")}
      </button>
      <div className="card" style={{padding:22,marginBottom:16}} data-clinical-header>
        <div style={{display:"flex",gap:16,alignItems:"flex-start",flexWrap:"wrap"}}>
          <div className="av lg" style={{width:60,height:60,fontSize:20,background:"var(--blue-100)",color:"var(--blue-700)"}}>
            {initialsOf(p.name)}
          </div>
          <div style={{flex:1,minWidth:220}}>
            <h1 className="h1" style={{fontSize:24,margin:0}}>{p.name}</h1>
            <div style={{display:"flex",gap:"6px 18px",marginTop:6,fontSize:13,color:"var(--ink-500)",flexWrap:"wrap"}}>
              <span style={{display:"inline-flex",alignItems:"center",gap:6}}><I.FileText size={13}/> {ttx("ملف رقم {no}", { no: <bdi className="mono">{fileNo}</bdi> })}</span>
              {p.age ? <span style={{display:"inline-flex",alignItems:"center",gap:6}}><I.User size={13}/> {tt("{n} سنة", { n: p.age })}</span> : null}
              {p.phone ? <span style={{display:"inline-flex",alignItems:"center",gap:6}}><I.Phone size={13}/> <bdi dir="ltr">{p.phone}</bdi></span> : null}
              {p.phone ? <span style={{display:"inline-flex",alignItems:"center",gap:6,color:"var(--green)"}}><I.WhatsApp size={13}/> {tt("تذكيرات واتساب مفعّلة")}</span> : null}
            </div>
            <div style={{display:"flex",gap:6,marginTop:10,flexWrap:"wrap"}} data-medical-alerts={alerts.length}>
              {alerts.length
                ? alerts.map((a, i) => <span key={i} className={"badge " + (a.tone === "red" ? "b-red" : "b-amber")}><span className="dot"></span>{a.label}</span>)
                : <span className="badge b-green"><span className="dot"></span>{tt("لا تنبيهات طبية")}</span>}
            </div>
          </div>
        </div>
        {actions && <div style={{display:"flex",gap:8,marginTop:16,flexWrap:"wrap"}}>{actions}</div>}
      </div>
    </>
  );
}

// Tabs of a patient file (buttons with role=tab inside a tablist).
function ClinicalTabs({ tabs, value, onChange }) {
  return (
    <div className="stepper" role="tablist" style={{borderBottom:"1px solid var(--ink-200)",padding:"0 14px",gap:4,overflowX:"auto"}}>
      {tabs.map(t => (
        <button key={t.key} type="button" role="tab" aria-selected={value === t.key ? "true" : "false"} data-tab-key={t.key}
          onClick={() => onChange(t.key)} style={{
            border:"none",background:"transparent",padding:"14px 12px",fontSize:13.5,fontWeight:500,whiteSpace:"nowrap",flexShrink:0,
            color: value === t.key ? "var(--blue-700)" : "var(--ink-500)",
            borderBottom: value === t.key ? "2px solid var(--blue-500)" : "2px solid transparent", cursor:"pointer",
          }}>{t.label}</button>
      ))}
    </div>
  );
}

// The visit note: the diagnosis of the dental and general departments.
// kind "dental": complaint, examination, diagnosis, what was done, next visit;
// kind "general": complaint, examination, diagnosis (required), plan, follow-up.
const VISIT_FIELDS = {
  dental: [
    ["complaint", "الشكوى الرئيسية"], ["examination", "الفحص"], ["diagnosis", "التشخيص"],
    ["treatment_done", "ما تم اليوم"], ["next_visit", "الزيارة القادمة"], ["notes", "ملاحظات"],
  ],
  general: [
    ["complaint", "الشكوى الرئيسية"], ["examination", "الفحص"], ["diagnosis", "التشخيص"],
    ["plan", "الخطة"], ["follow_up", "المتابعة"], ["notes", "ملاحظات"],
  ],
};
const VISIT_COLUMNS = ["complaint", "diagnosis", "notes"];

function VisitNoteModal({ kind, patient, onClose, onSaved, title }) {
  const fields = VISIT_FIELDS[kind] || VISIT_FIELDS.general;
  const [f, setF] = React.useState(() => ({ visit_date: new Date().toISOString().slice(0, 10) }));
  const [err, setErr] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const set = (k, v) => setF(x => ({ ...x, [k]: v }));
  async function save() {
    const filled = fields.some(([k]) => (f[k] || "").trim());
    if (kind === "general" && !(f.diagnosis || "").trim()) { setErr(tt("أدخل التشخيص")); return; }
    if (!filled) { setErr(tt("اكتب الشكوى أو التشخيص أو ما تم اليوم")); return; }
    const row = { patient_id: patient.patient_id || patient.id, kind, visit_date: f.visit_date, data: {} };
    for (const [k] of fields) {
      const v = (f[k] || "").trim() || null;
      if (VISIT_COLUMNS.includes(k)) row[k] = v; else if (v) row.data[k] = v;
    }
    setBusy(true); setErr("");
    try {
      const saved = await ClinicalAPI.save("assessments", row);
      window.showToast && window.showToast(tt("تم حفظ ملاحظة الزيارة"), "success");
      onSaved && onSaved(saved);
    } catch (e) { setErr(e.message || tt("تعذّر الحفظ")); }
    finally { setBusy(false); }
  }
  return (
    <Modal onClose={onClose} title={title || (kind === "dental" ? tt("ملاحظة زيارة جديدة") : tt("تشخيص جديد"))} width={620}
      footer={<>
        <button className="btn btn-ghost" onClick={onClose}>{tt("إلغاء")}</button>
        <button className="btn btn-blue" onClick={save} disabled={busy} aria-busy={busy ? "true" : undefined}><I.Check size={13}/> {tt("حفظ")}</button>
      </>}>
      <div style={{display:"flex",flexDirection:"column",gap:12}} data-visit-form={kind}>
        <label style={{display:"flex",flexDirection:"column",gap:4,maxWidth:220}}>
          <span className="label">{tt("تاريخ الزيارة")}</span>
          <input className="input" type="date" value={f.visit_date} onChange={e => set("visit_date", e.target.value)}/>
        </label>
        {fields.map(([k, label]) => (
          <label key={k} style={{display:"flex",flexDirection:"column",gap:4}}>
            <span className="label">{tt(label)}{kind === "general" && k === "diagnosis" ? <span style={{color:"#A8443A"}}> *</span> : null}</span>
            <textarea className="input" rows={k === "notes" || k === "examination" ? 3 : 2} value={f[k] || ""}
              onChange={e => set(k, e.target.value)} style={{resize:"vertical",minHeight:52}}/>
          </label>
        ))}
        {err && <div role="alert" style={{color:"#A8443A",fontSize:13}}>{err}</div>}
      </div>
    </Modal>
  );
}

// Visit notes / diagnoses of a patient, newest first.
function VisitNotesTab({ p, kind, onNew }) {
  const pid = p.patient_id || p.id;
  const { rows, loading, error, reload } = useClinical(pid, ["assessments"]);
  const list = rows.assessments || [];
  return (
    <div data-tab="visits">
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,marginBottom:14,flexWrap:"wrap"}}>
        <h2 className="h3" style={{margin:0}}>{kind === "dental" ? tt("ملاحظات الزيارات") : tt("التشخيصات")}</h2>
        <button className="btn btn-blue" onClick={onNew}><I.Edit size={13}/> {kind === "dental" ? tt("ملاحظة زيارة جديدة") : tt("تشخيص جديد")}</button>
      </div>
      {loading && !list.length && <div className="muted" role="status" style={{fontSize:13}}>{tt("جارٍ التحميل…")}</div>}
      {error && <div role="alert" style={{color:"#A8443A",fontSize:13}}>{error} <button className="btn btn-ghost" onClick={reload}>{tt("إعادة المحاولة")}</button></div>}
      {!loading && !error && !list.length && (
        <EmptyState icon={<I.FileText size={22}/>} title={kind === "dental" ? tt("لا ملاحظات زيارات بعد") : tt("لا تشخيص محفوظ بعد")}
          body={kind === "dental" ? tt("سجّل ما وجدته وما عملته في كل زيارة.") : tt("سجّل شكوى المريض وفحصه وتشخيصه وخطته.")}/>
      )}
      <div style={{display:"flex",flexDirection:"column",gap:12}}>
        {list.map(a => (
          <div key={a.assessment_id} className="card" style={{padding:16}}>
            <div style={{display:"flex",justifyContent:"space-between",gap:8,marginBottom:6,flexWrap:"wrap"}}>
              <b style={{fontSize:13.5}}>{clinicalByline(a.visit_date, a.clinician_name || a.author_name)}</b>
            </div>
            <AssessmentDetails a={a}/>
            {a.kind === "physio" && decodeMarkers(a.markers).length > 0 && (
              <div style={{maxWidth:520,marginTop:10}}><BodyDiagram readOnly markers={decodeMarkers(a.markers)}/></div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── prescriptions ──────────────────────────────────────────────
const RX_FIELDS = [["name", "الدواء"], ["dose", "الجرعة"], ["frequency", "عدد المرات"], ["duration", "المدة"], ["notes", "ملاحظات"]];
const RX_EMPTY = { name: "", dose: "", frequency: "", duration: "", notes: "" };

function PrescriptionModal({ patient, onClose, onSaved }) {
  const [items, setItems] = React.useState([{ ...RX_EMPTY }]);
  const [notes, setNotes] = React.useState("");
  const [err, setErr] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const setItem = (i, k, v) => setItems(list => list.map((it, j) => (j === i ? { ...it, [k]: v } : it)));
  async function save() {
    const clean = items.map(it => Object.fromEntries(RX_FIELDS.map(([k]) => [k, (it[k] || "").trim()]).filter(([, v]) => v)))
      .filter(it => Object.keys(it).length);
    if (!clean.length || clean.some(it => !it.name)) { setErr(tt("اكتب اسم كل دواء")); return; }
    setBusy(true); setErr("");
    try {
      const saved = await ClinicalAPI.save("prescriptions", { patient_id: patient.patient_id || patient.id, items: clean, notes: notes.trim() || null });
      window.showToast && window.showToast(tt("تم حفظ الوصفة"), "success");
      onSaved && onSaved(saved);
    } catch (e) { setErr(e.message || tt("تعذّر الحفظ")); }
    finally { setBusy(false); }
  }
  return (
    <Modal onClose={onClose} title={tt("وصفة جديدة")} width={760}
      footer={<>
        <button className="btn btn-ghost" onClick={onClose}>{tt("إلغاء")}</button>
        <button className="btn btn-blue" onClick={save} disabled={busy} aria-busy={busy ? "true" : undefined}><I.Check size={13}/> {tt("حفظ الوصفة")}</button>
      </>}>
      <div data-rx-form style={{display:"flex",flexDirection:"column",gap:10}}>
        {items.map((it, i) => (
          <fieldset key={i} style={{border:"1px solid var(--ink-200)",borderRadius:12,padding:12,margin:0}}>
            <legend style={{fontSize:12.5,color:"var(--ink-500)",padding:"0 6px"}}>{tt("الدواء {n}", { n: i + 1 })}</legend>
            <div className="rgrid c-sm" style={{"--gtc":"2fr 1fr 1fr 1fr",gap:8}}>
              {RX_FIELDS.slice(0, 4).map(([k, label]) => (
                <label key={k} style={{display:"flex",flexDirection:"column",gap:4}}>
                  <span className="label">{tt(label)}{k === "name" ? <span style={{color:"#A8443A"}}> *</span> : null}</span>
                  <input className="input" value={it[k]} maxLength={200} onChange={e => setItem(i, k, e.target.value)}/>
                </label>
              ))}
            </div>
            <div style={{display:"flex",gap:8,marginTop:8,alignItems:"flex-end"}}>
              <label style={{display:"flex",flexDirection:"column",gap:4,flex:1}}>
                <span className="label">{tt("ملاحظات")}</span>
                <input className="input" value={it.notes} maxLength={200} onChange={e => setItem(i, "notes", e.target.value)}/>
              </label>
              {items.length > 1 && (
                <button type="button" className="btn btn-ghost btn-icon" aria-label={tt("حذف الدواء {n}", { n: i + 1 })}
                  onClick={() => setItems(list => list.filter((_, j) => j !== i))}><I.Trash size={14}/></button>
              )}
            </div>
          </fieldset>
        ))}
        {items.length < 30 && (
          <button type="button" className="btn btn-secondary" style={{alignSelf:"flex-start"}} onClick={() => setItems(list => [...list, { ...RX_EMPTY }])}>
            <I.Plus size={13}/> {tt("إضافة دواء")}
          </button>
        )}
        <label style={{display:"flex",flexDirection:"column",gap:4}}>
          <span className="label">{tt("تعليمات للمريض")}</span>
          <textarea className="input" rows={2} value={notes} maxLength={2000} onChange={e => setNotes(e.target.value)}/>
        </label>
        {err && <div role="alert" style={{color:"#A8443A",fontSize:13}}>{err}</div>}
      </div>
    </Modal>
  );
}

// A printable prescription (printHTML escapes nothing in the body: every
// value goes through escHtml here).
function printPrescription(rx, patient) {
  const esc = window.escHtml;
  const rows = (rx.items || []).map(it => `<tr>${RX_FIELDS.map(([k]) => `<td>${esc(it[k] || "")}</td>`).join("")}</tr>`).join("");
  const body = `
    <div style="margin-bottom:12px"><b>${esc(tt("المريض"))}:</b> ${esc(patient.name)} · <span class="mono">${esc(patient.medical_file_no || patient.id)}</span></div>
    <div style="margin-bottom:12px"><b>${esc(tt("التاريخ"))}:</b> ${esc(fmtDate(rx.prescribed_on))} · <b>${esc(tt("الطبيب"))}:</b> ${esc(rx.author_name || "")}</div>
    <table><thead><tr>${RX_FIELDS.map(([, l]) => `<th>${esc(tt(l))}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>
    ${rx.notes ? `<div style="margin-top:14px"><b>${esc(tt("تعليمات للمريض"))}:</b> ${esc(rx.notes)}</div>` : ""}`;
  window.printHTML(tt("وصفة طبية"), body);
}

function PrescriptionsTab({ p, onNew }) {
  const pid = p.patient_id || p.id;
  const { rows, loading, error, reload } = useClinical(pid, ["prescriptions"]);
  const list = rows.prescriptions || [];
  const mayWrite = canPrescribe();
  return (
    <div data-tab="prescriptions">
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,marginBottom:14,flexWrap:"wrap"}}>
        <h2 className="h3" style={{margin:0}}>{tt("الوصفات الطبية")}</h2>
        {mayWrite && <button className="btn btn-blue" onClick={onNew}><I.Plus size={13}/> {tt("وصفة جديدة")}</button>}
      </div>
      {loading && !list.length && <div className="muted" role="status" style={{fontSize:13}}>{tt("جارٍ التحميل…")}</div>}
      {error && <div role="alert" style={{color:"#A8443A",fontSize:13}}>{error} <button className="btn btn-ghost" onClick={reload}>{tt("إعادة المحاولة")}</button></div>}
      {!loading && !error && !list.length && <EmptyState icon={<I.FileText size={22}/>} title={tt("لا وصفات بعد")} body={mayWrite ? tt("اكتب أول وصفة لهذا المريض.") : tt("يكتب الوصفات الطبيب أو المدير.")}/>}
      <div style={{display:"flex",flexDirection:"column",gap:12}}>
        {list.map(rx => (
          <div key={rx.prescription_id} className="card" style={{padding:16}} data-rx={rx.prescription_id}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,marginBottom:8,flexWrap:"wrap"}}>
              <b style={{fontSize:13.5}}>{clinicalByline(rx.prescribed_on, rx.author_name)}</b>
              <button className="btn btn-secondary" onClick={() => printPrescription(rx, p)}><I.Print size={13}/> {tt("طباعة")}</button>
            </div>
            <div className="tbl-scroll">
              <table className="tbl">
                <thead><tr>{RX_FIELDS.map(([k, l]) => <th key={k}>{tt(l)}</th>)}</tr></thead>
                <tbody>{(rx.items || []).map((it, i) => <tr key={i}>{RX_FIELDS.map(([k]) => <td key={k}>{it[k] || "—"}</td>)}</tr>)}</tbody>
              </table>
            </div>
            {rx.notes && <div className="muted" style={{fontSize:12.5,marginTop:8,whiteSpace:"pre-wrap"}}>{rx.notes}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

// The patient's appointments (window.DATA, plus older ones loaded by the
// file with useOlderRows), newest first.
function PatientAppointmentsTab({ p, go }) {
  window.useDataVersion && window.useDataVersion();
  const pid = p.patient_id || p.id;
  const list = (DATA.appts || []).filter(a => a.pid === pid || a.patient_id === pid)
    .slice().sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")) || String(b.time || "").localeCompare(String(a.time || "")));
  return (
    <div data-tab="appointments">
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,marginBottom:14,flexWrap:"wrap"}}>
        <h2 className="h3" style={{margin:0}}>{tt("المواعيد")}</h2>
        {go && <button className="btn btn-blue" onClick={() => go("appointments")}><I.Calendar size={13}/> {tt("حجز موعد")}</button>}
      </div>
      {!list.length ? <EmptyState icon={<I.Calendar size={22}/>} title={tt("لا مواعيد بعد")} body={tt("المواعيد المحجوزة لهذا المريض تظهر هنا.")}/> : (
        <div className="tbl-scroll">
          <table className="tbl">
            <thead><tr><th>{tt("التاريخ")}</th><th>{tt("الوقت")}</th><th>{tt("الطبيب")}</th><th>{tt("الحالة")}</th></tr></thead>
            <tbody>{list.map(a => (
              <tr key={a.id}><td className="mono">{a.date ? fmtDate(a.date) : tt("اليوم")}</td><td className="mono">{a.time || "—"}</td>
                <td>{a.dr || a.th || "—"}</td><td>{a.status ? tt(a.status) : "—"}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

Object.assign(window, {
  medicalAlerts, ClinicalPatientHeader, ClinicalTabs, VisitNoteModal, VisitNotesTab,
  PrescriptionModal, PrescriptionsTab, printPrescription, PatientAppointmentsTab,
});

Object.assign(window, {
  CLINICAL_FORMS, clinicForm, clinicalRole, canReadClinical, canPrescribe,
  bodyView, encodeMarkers, decodeMarkers, BODY_VIEW_LABELS,
  PHYSIO_EMPTY, physioRowFromForm, physioFormFromRow,
  ClinicalAPI, useClinical, BodyDiagram, clinicalByline, clinicalError,
  PatientFile, AssessmentDetails, ClinicalRow, PhysioDiagnosisTab, markerSummary,
});
