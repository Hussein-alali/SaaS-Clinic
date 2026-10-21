

// ===== src/treatments.jsx =====
// خطط العلاج + جلسات العلاج

// ── Utilities ─────────────────────────────────────────────────
function downloadCsv(rows, filename) {
  const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ── Excel export (styled, RTL, Arabic-safe) ───────────────────
// Builds a professional workbook from the ALREADY-FILTERED report rows:
// clinic name, report title, generated date, active filters, bold header
// band, bordered table, column widths, number/currency formats, and a
// totals row. Uses the xlsx-js-style global loaded in index.html. Handles
// thousands of rows (a single aoa_to_sheet + writeFile, no per-render DOM).
//
// columns: [{ key, label, type?: 'text'|'number'|'currency'|'date', total?, width? }]
function exportReportExcel({ filename, sheetName = "التقرير", title, filters = [], columns = [], rows = [] }) {
  const XLSX = window.XLSX;
  if (!XLSX || !XLSX.utils) {
    window.showToast && window.showToast("مكتبة Excel غير محمّلة — تحقق من الاتصال", "error");
    return false;
  }
  const clinic = (window.CLINIC && window.CLINIC.name) || "العيادة";
  const genDate = new Date().toLocaleString("ar-EG");
  const nCols = Math.max(columns.length, 1);

  const aoa = [];
  aoa.push([clinic]);
  aoa.push([title || sheetName]);
  aoa.push([`تاريخ الإنشاء: ${genDate}`]);
  const filterRow = filters.length ? aoa.length : -1;
  if (filters.length) aoa.push(["عوامل التصفية:  " + filters.map(f => `${f.label}: ${f.value}`).join("   |   ")]);
  aoa.push([]);                                   // spacer
  const headerRowIdx = aoa.length;
  aoa.push(columns.map(c => c.label));
  const dataStart = aoa.length;
  rows.forEach(r => aoa.push(columns.map(c => {
    const v = r[c.key];
    if (v == null) return "";
    if ((c.type === "number" || c.type === "currency")) { const n = Number(v); return Number.isFinite(n) ? n : v; }
    return v;
  })));
  const hasTotals = columns.some(c => c.total);
  let totalsRowIdx = -1;
  if (hasTotals && rows.length) {
    totalsRowIdx = aoa.length;
    aoa.push(columns.map((c, i) => {
      if (i === 0) return "الإجمالي";
      if (c.total) return rows.reduce((s, r) => s + (Number(r[c.key]) || 0), 0);
      return "";
    }));
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: nCols - 1 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: nCols - 1 } },
    { s: { r: 2, c: 0 }, e: { r: 2, c: nCols - 1 } },
  ];
  if (filterRow >= 0) ws["!merges"].push({ s: { r: filterRow, c: 0 }, e: { r: filterRow, c: nCols - 1 } });
  ws["!cols"] = columns.map(c => ({ wch: Math.max(12, (c.label || "").length + 2, c.width || 0) }));
  ws["!views"] = [{ RTL: true }];

  const bd = { style: "thin", color: { rgb: "FFD0D7DE" } };
  const borders = { top: bd, bottom: bd, left: bd, right: bd };
  const range = XLSX.utils.decode_range(ws["!ref"]);
  for (let R = range.s.r; R <= range.e.r; R++) {
    for (let C = range.s.c; C <= range.e.c; C++) {
      const cell = ws[XLSX.utils.encode_cell({ r: R, c: C })];
      if (!cell) continue;
      if (R === 0) cell.s = { font: { bold: true, sz: 16, color: { rgb: "FF1E4A6E" } }, alignment: { horizontal: "center" } };
      else if (R === 1) cell.s = { font: { bold: true, sz: 13, color: { rgb: "FF2E4458" } }, alignment: { horizontal: "center" } };
      else if (R === 2 || R === filterRow) cell.s = { font: { sz: 10, color: { rgb: "FF647686" } }, alignment: { horizontal: "center", wrapText: true } };
      else if (R === headerRowIdx) cell.s = { font: { bold: true, color: { rgb: "FFFFFFFF" } }, fill: { fgColor: { rgb: "FF3A7FB5" } }, alignment: { horizontal: "center" }, border: borders };
      else if (R >= dataStart) {
        const col = columns[C] || {};
        const numeric = col.type === "number" || col.type === "currency";
        cell.s = { border: borders, alignment: { horizontal: numeric ? "left" : "right", vertical: "center" } };
        if (R === totalsRowIdx) { cell.s.font = { bold: true }; cell.s.fill = { fgColor: { rgb: "FFEEF2F6" } }; }
        if (typeof cell.v === "number") cell.z = col.type === "currency" ? '#,##0 "EGP"' : "#,##0";
      }
    }
  }
  ws["!rows"] = [{ hpt: 24 }, { hpt: 20 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, String(sheetName).slice(0, 31));
  XLSX.writeFile(wb, filename || "report.xlsx");
  return true;
}

function Treatments({ go }) {
  window.useDataVersion && window.useDataVersion();
  const [view, setView] = React.useState("list");
  const [selected, setSelected] = React.useState(null);
  const [records, setRecords] = React.useState([]);
  const [loadingRecords, setLoadingRecords] = React.useState(true);

  // Real treatment records from PostgreSQL — one row per saved treatment
  // (created blank or from a template). No derived/fabricated fixtures.
  const reload = React.useCallback(async () => {
    if (!window.TreatmentsAPI) { setLoadingRecords(false); return; }
    const res = await window.TreatmentsAPI.list({ limit: 500 });
    setRecords(res.rows || []);
    setLoadingRecords(false);
  }, []);
  React.useEffect(() => {
    reload();
    const onUpd = () => reload();
    window.addEventListener('kinetic:treatments-updated', onUpd);
    return () => window.removeEventListener('kinetic:treatments-updated', onUpd);
  }, [reload]);

  // Derive the plan rows in one memoized pass. Two indices are built once
  // per data change so each record's session-heuristic and patient lookup
  // are O(1) instead of O(N) — a big win when the DB fills up (used to be
  // records×sessions + records×patients on every kinetic:data-updated tick).
  const plans = React.useMemo(() => {
    const sessions = DATA.sessions || [];
    const patients = DATA.patients || [];
    const sessionsByPatient = new Map();
    for (const s of sessions) {
      if ((s.status || "completed") === "in_progress") continue;
      let arr = sessionsByPatient.get(s.patient_id);
      if (!arr) { arr = []; sessionsByPatient.set(s.patient_id, arr); }
      arr.push(s);
    }
    const patientsById = new Map();
    for (const p of patients) patientsById.set(p.patient_id || p.id, p);
    return records.map(t => {
      const total = Number(t.estimated_sessions) || 0;
      // completed_sessions is maintained by the DB trigger from linked
      // sessions. Legacy sessions logged before linking existed carry no
      // treatment_id, so fall back to the old per-patient heuristic.
      const linkedDone = Number(t.completed_sessions) || 0;
      let heuristicDone = 0;
      if (linkedDone <= 0) {
        const bucket = sessionsByPatient.get(t.patient_id);
        if (bucket) {
          if (t.treatment_date) {
            for (const s of bucket) if (!s.date || s.date >= t.treatment_date) heuristicDone++;
          } else {
            heuristicDone = bucket.length;
          }
        }
      }
      const done = linkedDone > 0 ? linkedDone : heuristicDone;
      const progress = total ? Math.min(100, Math.round(done / total * 100)) : 0;
      const patientRow = patientsById.get(t.patient_id);
      const updatedAt = t.updated_at || t.created_at;
      return {
        id: t.treatment_id,
        patient: t.patient_name || (patientRow && patientRow.name) || t.patient_id,
        diag: t.diagnosis || "—",
        therapist: t.therapist_name || t.therapist_id || "—",
        goals: Array.isArray(t.goals) ? t.goals.length : 0,
        progress,
        sessions: total ? `${done}/${total}` : String(done),
        status: t.status === "completed" || (progress >= 100 && total) ? "مكتمل"
              : t.status === "draft" ? "مسودة" : "نشط",
        updated: updatedAt ? new Date(updatedAt).toLocaleDateString("ar-EG") : "—",
        p: patientRow || { patient_id: t.patient_id, name: t.patient_name || t.patient_id },
        t,
      };
    });
  }, [records, DATA.sessions, DATA.patients]);

  // Single pass for the header/stat counts — previously plans.filter ran
  // four separate times over the whole array on every render.
  const planStats = React.useMemo(() => {
    let active = 0, drafts = 0, done = 0, progressSum = 0;
    for (const p of plans) {
      if (p.status === "نشط") active++;
      else if (p.status === "مسودة") drafts++;
      else if (p.status === "مكتمل") done++;
      progressSum += p.progress;
    }
    const avgProgress = plans.length ? Math.round(progressSum / plans.length) : 0;
    return { active, drafts, done, avgProgress };
  }, [plans]);
  const avgProgress = planStats.avgProgress;

  // Only admins and doctors may delete a plan (mirrors the delete_treatment RPC).
  const role = (window.ME && window.ME.role) || "";
  const canDelete = role === "مدير" || role === "admin" || role === "طبيب" || role === "doctor";

  // Permanently delete a plan: confirm → delete on the server → toast → the
  // 'kinetic:treatments-updated' event fired by the RPC wrapper reloads the
  // list and its stats. Linked sessions are unlinked server-side, not lost.
  async function onDeletePlan(plan) {
    if (!window.TreatmentsAPI || !window.TreatmentsAPI.delete) return;
    const msg = `حذف خطة العلاج «${plan.diag}» للمريض ${plan.patient}؟\n`
      + "لن تُحذف الجلسات المرتبطة — سيُلغى ربطها فقط. لا يمكن التراجع عن هذا الإجراء.";
    if (!window.confirm(msg)) return;
    try {
      const res = await window.TreatmentsAPI.delete(plan.id);
      const n = res && res.sessions_unlinked ? res.sessions_unlinked : 0;
      window.showToast && window.showToast(
        n > 0 ? `تم حذف الخطة وإلغاء ربط ${n} جلسة` : "تم حذف الخطة", "success");
      if (view === "detail") setView("list");
      setSelected(null);
      reload();
    } catch (e) {
      console.warn("delete treatment failed", e);
      window.showToast && window.showToast(e.message || "تعذّر حذف الخطة", "error");
    }
  }

  if (view === "detail" && selected) return <TreatmentPlanDetail plan={selected} onBack={()=>setView("list")} canDelete={canDelete} onDelete={()=>onDeletePlan(selected)}/>;
  if (view === "physio-session") return <PhysioSessionForm onBack={()=>setView("list")}/>;

  return (
    <Page>
      <div className="page-head">
        <div>
          <div className="crumb"><span>الرئيسية</span><I.Chevron size={11}/><span>خطط العلاج</span></div>
          <div className="h1">خطط العلاج</div>
          <div className="muted" style={{fontSize:13.5,marginTop:4}}>{planStats.active} نشط · {planStats.drafts} مسودات · متوسط التقدم {avgProgress}%</div>
        </div>
        <div className="page-actions">
          <button className="btn btn-blue" onClick={()=>setView("physio-session")}><I.Activity size={14}/> تشخيص</button>
        </div>
      </div>

      <div className="grid-3" style={{marginBottom:18}}>
        <StatCard label="خطط نشطة" value={planStats.active} accent="#7BBDE8" icon={<I.Clipboard size={15}/>}/>
        <StatCard label="خطط مكتملة" value={String(planStats.done)} accent="#3FA984" icon={<I.Check size={15}/>}/>
        <StatCard label="متوسط التقدّم" value={`${avgProgress}%`} accent="#7E6BD3" icon={<I.Activity size={15}/>}/>
      </div>

      <div className="card" style={{overflow:"hidden"}}>
        <div className="tbl-scroll">
        <table className="tbl">
          <thead><tr><th>الخطة</th><th>المريض</th><th>التشخيص</th><th>الأخصائي</th><th>التقدّم</th><th>الجلسات</th><th>الحالة</th><th>آخر تحديث</th>{canDelete && <th></th>}</tr></thead>
          <tbody>
            {plans.length===0 && !loadingRecords && (
              <tr><td colSpan={canDelete?9:8}><EmptyState icon={<I.Clipboard size={22}/>} title="لا خطط علاج بعد" body="ستظهر خطط العلاج هنا بعد إنشائها."/></td></tr>
            )}
            {plans.map(p=>(
              <tr key={p.id} data-clickable="true" tabIndex={0} onClick={()=>{setSelected(p);setView("detail")}} onKeyDown={e=>{ if(e.key==="Enter"||e.key===" "){e.preventDefault();setSelected(p);setView("detail");} }}>
                <td className="mono" style={{fontWeight:600}}>{p.id}</td>
                <td>{p.patient}</td>
                <td>{p.diag}</td>
                <td>{p.therapist}</td>
                <td>
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <div style={{flex:1,maxWidth:100,height:5,background:"var(--ink-100)",borderRadius:999,overflow:"hidden"}}>
                      <div style={{height:"100%",width:`${p.progress}%`,background:p.progress===100?"var(--green)":"var(--blue-500)"}}/>
                    </div>
                    <span className="mono" style={{fontSize:11.5}}>{p.progress}%</span>
                  </div>
                </td>
                <td className="mono">{p.sessions}</td>
                <td>
                  <span className={"badge " + (p.status==="نشط"?"b-blue":p.status==="مكتمل"?"b-green":"b-grey")}>
                    <span className="dot"></span>{p.status}
                  </span>
                </td>
                <td className="muted">{p.updated}</td>
                {canDelete && (
                  <td style={{textAlign:"left"}} onClick={e=>e.stopPropagation()}>
                    <button className="btn btn-ghost btn-icon" title="حذف الخطة"
                      onClick={(e)=>{e.stopPropagation();onDeletePlan(p);}}>
                      <I.Trash size={13}/>
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    </Page>
  );
}

function TreatmentPlanDetail({ plan, onBack, canDelete, onDelete }) {
  // Editing happens inside PatientTreatmentPlan (which persists to the
  // patient's treatments row) — the old header button opened a blank
  // CREATE form and produced duplicate plans.
  return (
    <Page>
      <div className="crumb" style={{cursor:"pointer"}} onClick={onBack}><span>خطط العلاج</span><I.Chevron size={11}/><span style={{color:"var(--ink-700)"}}>{plan.id}</span></div>
      <div className="page-head" style={{alignItems:"flex-start"}}>
        <div>
          <div className="h1">{plan.diag}</div>
          <div className="muted" style={{fontSize:13.5,marginTop:4}}>المريض: {plan.patient} · الأخصائي: {plan.therapist}{plan.p && plan.p.registered ? ` · سُجّل ${plan.p.registered}` : ""}</div>
        </div>
        <div className="page-actions">
          <button className="btn btn-secondary" onClick={()=>window.print()}><I.Print size={13}/> طباعة</button>
          {canDelete && onDelete && (
            <button className="btn btn-secondary" style={{color:"var(--red)"}} onClick={onDelete}>
              <I.Trash size={13}/> حذف الخطة
            </button>
          )}
        </div>
      </div>

      <PatientTreatmentPlan p={plan.p} t={plan.t}/>
    </Page>
  );
}

// ═══════════════════════════════════════════════════════════════════
// PhysioSessionForm — self-contained physiotherapy session form added
// inside خطط العلاج. Captures therapist/patient, diagnosis, traction
// toggles, modalities, manual techniques, and interactive body
// locations. Markers + form state are persisted per patient in
// localStorage so reopening the form restores the last session.
// ═══════════════════════════════════════════════════════════════════
const PHYSIO_MODALITIES = [
  "TENS / FS / IF",
  "H.P / ICE",
  "Dry / Wet Cupping",
  "Chirogum",
  "Dry Needling",
  "Electro Needling",
  "Massage Gun",
  "Laser",
];

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

function physioStoreKey(patientId) {
  return `physio-session:${patientId || "_draft"}`;
}

// Stable helpers at module scope — if these were defined inside
// PhysioSessionForm, every state update would create new function refs
// and React would unmount+remount every child (including the focused
// textarea), kicking the user out of writing mode on each keystroke.
const PhysioCard = ({ title, children }) => (
  <div style={{
    background: "var(--ink-50)",
    border: "1px solid var(--ink-200)",
    borderRadius: 14,
    padding: 18,
    marginBottom: 16,
  }}>
    <div style={{
      fontSize: 15, fontWeight: 700, color: "var(--ink-900)",
      textAlign: "right", marginBottom: 14,
      borderBottom: "1px solid var(--ink-200)", paddingBottom: 8,
    }}>{title}</div>
    {children}
  </div>
);

const PhysioLabelRow = ({ label, required, control }) => (
  <div style={{display:"flex", alignItems:"center", gap:12, padding:"6px 0"}}>
    <div style={{flex:1, textAlign:"right", fontSize:13, fontWeight:500, color:"var(--ink-900)"}}>
      {label}{required && <span style={{color:"var(--red)", marginInlineStart:4}}>*</span>}
    </div>
    <div style={{display:"flex", gap:6, alignItems:"center"}}>{control}</div>
  </div>
);

const PhysioPill = ({ on, disabled, children, onClick }) => (
  <button type="button" onClick={onClick} disabled={disabled}
    style={{
      padding: "6px 14px", borderRadius: 999, fontSize: 12, fontWeight: 600,
      border: "1px solid " + (on ? "var(--blue-500)" : "var(--ink-200)"),
      background: on ? "var(--blue-500)" : "#fff",
      color: on ? "#fff" : "var(--ink-700)",
      cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.5 : 1,
    }}>{children}</button>
);

const PhysioChk = ({ checked, onChange, children }) => (
  <label style={{display:"flex", alignItems:"center", gap:10, cursor:"pointer", flex:1}}>
    <input type="checkbox" checked={!!checked} onChange={e=>onChange(e.target.checked)}
      style={{width:16, height:16, accentColor:"var(--blue-500)", cursor:"pointer", flexShrink:0}}/>
    <span style={{flex:1, textAlign:"right", fontSize:13, fontWeight:500, color:"var(--ink-900)"}}>
      {children}
    </span>
  </label>
);

const PhysioTA = (props) => (
  <textarea {...props}
    style={{
      width:"100%", minHeight: props.rows ? undefined : 70,
      padding: 10, borderRadius: 10, border: "1px solid var(--ink-200)",
      background: "#fff", resize: "vertical", textAlign: "right",
      direction: "rtl", fontFamily: "inherit", fontSize: 13,
      outline: "none",
      ...(props.style || {}),
    }}/>
);

function PhysioSessionForm({ onBack }) {
  window.useDataVersion && window.useDataVersion();

  const patients   = React.useMemo(
    () => (window.scopePatients ? window.scopePatients(DATA.patients) : DATA.patients) || [],
    [DATA.patients]
  );
  const therapists = React.useMemo(() => DATA.therapists || [], [DATA.therapists]);

  const [patientId, setPatientId]     = React.useState("");
  const [therapistId, setTherapistId] = React.useState("");
  const [form, setForm] = React.useState(PHYSIO_EMPTY);

  // Load any previously-saved session for this patient (markers +
  // everything else). Blank patient falls back to a shared draft slot.
  React.useEffect(() => {
    try {
      const raw = localStorage.getItem(physioStoreKey(patientId));
      if (raw) {
        const saved = JSON.parse(raw);
        setForm({ ...PHYSIO_EMPTY, ...saved });
        return;
      }
    } catch (_) {}
    setForm(PHYSIO_EMPTY);
  }, [patientId]);

  const update = (patch) => setForm(f => ({ ...f, ...patch }));

  function toggleModality(name) {
    setForm(f => {
      const next = { ...f.modalities };
      if (next[name]) delete next[name]; else next[name] = true;
      return { ...f, modalities: next };
    });
  }

  function setTractionRow(key, patch) {
    setForm(f => ({ ...f, [key]: { ...f[key], ...patch } }));
  }

  function save() {
    if (!therapistId) { window.showToast && window.showToast("اختر الأخصائي المسؤول", "error"); return; }
    if (!patientId)   { window.showToast && window.showToast("اختر المريض", "error"); return; }
    try {
      localStorage.setItem(physioStoreKey(patientId), JSON.stringify(form));
      window.showToast && window.showToast("تم حفظ نموذج الجلسة", "success");
    } catch (_) {
      window.showToast && window.showToast("تعذّر الحفظ محليًا", "error");
    }
  }

  const tractionRow = (key, label, options) => {
    const row = form[key];
    return (
      <PhysioLabelRow label={<PhysioChk checked={row.on}
        onChange={on => setTractionRow(key, { on, mode: on ? row.mode : null })}>{label}</PhysioChk>}
        control={options.map(o => (
          <PhysioPill key={o} disabled={!row.on} on={row.mode === o}
            onClick={() => setTractionRow(key, { mode: row.mode === o ? null : o })}>
            {o}
          </PhysioPill>
        ))}
      />
    );
  };

  return (
    <Page>
      <div className="crumb" style={{cursor:"pointer"}} onClick={onBack}>
        <span>خطط العلاج</span><I.Chevron size={11}/>
        <span style={{color:"var(--ink-700)"}}>تشخيص</span>
      </div>
      <div className="page-head">
        <div className="h1">تشخيص</div>
        <div className="page-actions">
          <button className="btn btn-ghost" onClick={onBack}>رجوع</button>
          <button className="btn btn-blue" onClick={save}><I.Check size={13}/> حفظ الجلسة</button>
        </div>
      </div>

      <div style={{maxWidth: 980, margin: "0 auto"}}>

        {/* 1. Patient & Therapist */}
        <PhysioCard title="المريض والأخصائي">
          <div className="rgrid c-sm" style={{"--gtc":"repeat(2,1fr)", gap:14}}>
            <div>
              <div className="label" style={{color:"var(--ink-900)", textAlign:"right"}}>
                الأخصائي المسؤول <span style={{color:"var(--red)"}}>*</span>
              </div>
              <TherapistCombobox value={therapistId} onChange={setTherapistId}
                therapists={therapists} placeholder="Select therapist…"/>
            </div>
            <div>
              <div className="label" style={{color:"var(--ink-900)", textAlign:"right"}}>
                المريض <span style={{color:"var(--red)"}}>*</span>
              </div>
              <PatientCombobox value={patientId} onChange={setPatientId}
                patients={patients} placeholder="Search patient by name or ID…"/>
            </div>
          </div>
        </PhysioCard>

        {/* 2. Diagnosis */}
        <PhysioCard title="التشخيص">
          <window.DiagnosisAutocomplete multiline value={form.diagnosis}
            onChange={e=>update({diagnosis:e.target.value})}
            placeholder="Clinical diagnosis" style={{minHeight:110, fontSize:13}}/>
        </PhysioCard>

        {/* 3. Traction */}
        <PhysioCard title="Traction">
          {tractionRow("cervical", "Cervical", ["supine", "sitting"])}
          {tractionRow("thll",     "TH, LL",   ["unilat", "Bilat"])}
          {tractionRow("thpl",     "TH, PL",   ["flat",   "90/90"])}
          <PhysioLabelRow label={
            <PhysioChk checked={form.shortWave}
              onChange={v => update({shortWave:v})}>Short wave</PhysioChk>
          } control={null}/>
          <div style={{marginTop:10}}>
            <div className="label" style={{color:"var(--ink-900)", textAlign:"right"}}>Traction notes</div>
            <PhysioTA value={form.tractionNotes} onChange={e=>update({tractionNotes:e.target.value})}/>
          </div>
        </PhysioCard>

        {/* 4. Modalities */}
        <PhysioCard title="Modalities">
          <div style={{display:"flex", flexDirection:"column", gap:4}}>
            {PHYSIO_MODALITIES.map(name => (
              <PhysioLabelRow key={name} label={
                <PhysioChk checked={!!form.modalities[name]}
                  onChange={()=>toggleModality(name)}>{name}</PhysioChk>
              } control={null}/>
            ))}
          </div>
          <div style={{marginTop:12}}>
            <div className="label" style={{color:"var(--ink-900)", textAlign:"right"}}>Modalities notes</div>
            <PhysioTA value={form.modalitiesNotes} onChange={e=>update({modalitiesNotes:e.target.value})}/>
          </div>
        </PhysioCard>

        {/* 5. Manual Techniques */}
        <PhysioCard title="Manual Techniques">
          <PhysioLabelRow
            label={<PhysioChk checked={form.nGlide}
              onChange={v=>update({nGlide:v})}>N. Glide</PhysioChk>}
            control={
              <input className="input" value={form.nGlideNotes}
                onChange={e=>update({nGlideNotes:e.target.value})}
                disabled={!form.nGlide}
                placeholder="N. Glide notes"
                style={{width:260, textAlign:"right", opacity: form.nGlide ? 1 : 0.5}}/>
            }/>
          <div style={{height:8}}/>
          <div className="label" style={{color:"var(--ink-900)", textAlign:"right"}}>Ms Release</div>
          <input className="input" value={form.msRelease}
            onChange={e=>update({msRelease:e.target.value})}
            style={{textAlign:"right"}}/>
          <div style={{height:10}}/>
          <div className="label" style={{color:"var(--ink-900)", textAlign:"right"}}>Positioning</div>
          <input className="input" value={form.positioning}
            onChange={e=>update({positioning:e.target.value})}
            style={{textAlign:"right"}}/>
          <div style={{height:10}}/>
          <div className="label" style={{color:"var(--ink-900)", textAlign:"right"}}>
            Ex's, Stretching, Mobilization, Manipulation
          </div>
          <PhysioTA value={form.exercises} onChange={e=>update({exercises:e.target.value})}/>
          <div style={{height:10}}/>
          <div className="label" style={{color:"var(--ink-900)", textAlign:"right"}}>Manual Techniques notes</div>
          <PhysioTA value={form.manualNotes} onChange={e=>update({manualNotes:e.target.value})}/>
        </PhysioCard>

        {/* 6. Treatment Plans — Interactive Body Diagram */}
        <PhysioCard title="Treatment Plans">
          <div style={{fontSize:12.5, color:"var(--ink-500)", textAlign:"right", marginBottom:10}}>
            اضغط على أي موضع لإضافة علامة. اضغط على علامة موجودة لإزالتها.
          </div>
          <BodyDiagram
            markers={form.markers}
            onChange={markers => update({ markers })}
          />
          <div style={{fontSize:12, color:"var(--ink-500)", textAlign:"right", marginTop:10}}>
            المواضع المحددة: {form.markers.length}
          </div>
        </PhysioCard>

      </div>
    </Page>
  );
}

// ═══════════════════════════════════════════════════════════════════
// BodyDiagram — single-image overlay with percentage-based markers.
// The image contains 4 figures in a horizontal row; the x% band
// determines `view`. Click/tap adds a marker; clicking near an
// existing one (within HIT_RADIUS %) removes it.
// ═══════════════════════════════════════════════════════════════════
function BodyDiagram({ markers, onChange }) {
  const wrapRef = React.useRef(null);
  const HIT_RADIUS = 3; // percent of image dimension

  function pointFromEvent(e) {
    const el = wrapRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const pt = (e.changedTouches && e.changedTouches[0])
            || (e.touches && e.touches[0])
            || e;
    if (pt.clientX == null) return null;
    const x = ((pt.clientX - rect.left) / rect.width)  * 100;
    const y = ((pt.clientY - rect.top)  / rect.height) * 100;
    if (x < 0 || x > 100 || y < 0 || y > 100) return null;
    return { x, y };
  }

  function handleTap(e) {
    const p = pointFromEvent(e);
    if (!p) return;
    const hitIdx = markers.findIndex(m =>
      Math.hypot((m.x - p.x), (m.y - p.y)) < HIT_RADIUS
    );
    if (hitIdx >= 0) {
      onChange(markers.filter((_, i) => i !== hitIdx));
      return;
    }
    const view = p.x < 25 ? "left"
               : p.x < 50 ? "back"
               : p.x < 75 ? "front"
               : "right";
    onChange([...markers, { view, x: p.x, y: p.y }]);
  }

  return (
    <div ref={wrapRef}
      onClick={handleTap}
      onTouchEnd={(e)=>{ e.preventDefault(); handleTap(e); }}
      style={{
        position: "relative",
        width: "100%",
        background: "#fff",
        border: "1px solid var(--ink-200)",
        borderRadius: 12,
        overflow: "hidden",
        userSelect: "none",
        touchAction: "manipulation",
        cursor: "crosshair",
      }}>
      <img src="/assets/body-diagram.jpeg" alt="Human body diagram"
        draggable={false}
        style={{width:"100%", display:"block", pointerEvents:"none"}}/>
      {markers.map((m, i) => (
        <div key={i} style={{
          position: "absolute",
          left: `${m.x}%`, top: `${m.y}%`,
          width: 14, height: 14,
          marginLeft: -7, marginTop: -7,
          borderRadius: "50%",
          background: "var(--red)",
          border: "2px solid #fff",
          boxShadow: "0 1px 4px rgba(0,0,0,0.35)",
          pointerEvents: "none",
        }}/>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// TxMethodModal — "طرق علاج أخرى"
// Doctors/admins add custom treatment methods to the shared library. Search
// existing rows first to avoid duplicates; the RPC also enforces the
// name uniqueness server-side. Edit + archive are inline actions on
// each result so managing the library never leaves the modal.
// ═══════════════════════════════════════════════════════════════════
// Whitelist of icons safe to use as method glyphs.
const TX_METHOD_ICONS = [
  "Activity","Heart","Wave","Sparkle","Sun","Moon",
  "Stethoscope","Clock","Package","Layers","Pin",
  "Users","Send","Mic","Megaphone","Image","Dollar",
];
// Palette of soft chip colors (hex → bg is used at ~15% alpha via inline style).
const TX_METHOD_COLORS = [
  "#3B82F6","#0EA5E9","#14B8A6","#22C55E","#84CC16",
  "#EAB308","#F59E0B","#F97316","#EF4444","#EC4899",
  "#A855F7","#6366F1","#64748B",
];

function TxMethodModal({ onClose, onSaved }) {
  window.useDataVersion && window.useDataVersion();
  const [query, setQuery] = React.useState("");
  const [editingId, setEditingId] = React.useState(null);
  const [name, setName]           = React.useState("");
  const [category, setCategory]   = React.useState("");
  const [description, setDescription] = React.useState("");
  const [duration, setDuration]   = React.useState("");
  const [notes, setNotes]         = React.useState("");
  const [icon, setIcon]           = React.useState("");
  const [color, setColor]         = React.useState("");
  const [displayOrder, setDisplayOrder] = React.useState("");
  const [saving, setSaving]       = React.useState(false);
  const [error, setError]         = React.useState("");
  const [showArchived, setShowArchived] = React.useState(false);
  const [deletingId, setDeletingId] = React.useState(null);
  const nameRef = React.useRef(null);

  // Pull the library on open. Non-blocking; the modal renders whatever
  // is already cached first.
  React.useEffect(() => {
    if (window.TxMethods) window.TxMethods.list().catch(()=>{});
    setTimeout(() => { try { nameRef.current && nameRef.current.focus(); } catch(_){} }, 40);
  }, []);

  const results = React.useMemo(() => {
    const rows = (window.TxMethods && window.TxMethods.search(query)) || [];
    return showArchived ? rows : rows.filter(r => r.status !== "archived");
  }, [query, showArchived, (DATA.treatmentMethods || []).length,
      (DATA.treatmentMethods || []).map(r=>r.status).join(",")]);

  const categories = (window.TxMethods && window.TxMethods.categories()) || [];
  // Live duplicate hint (server-side check is authoritative).
  const dupHint = React.useMemo(() => {
    if (!name.trim() || !window.TxMethods) return null;
    return window.TxMethods.findByName(name, editingId || undefined);
  }, [name, editingId, (DATA.treatmentMethods || []).length]);

  function resetForm() {
    setEditingId(null); setName(""); setCategory("");
    setDescription(""); setDuration(""); setNotes("");
    setIcon(""); setColor(""); setDisplayOrder(""); setError("");
  }
  function loadIntoForm(m) {
    setEditingId(m.method_id || m.id);
    setName(m.name || "");
    setCategory(m.category || "");
    setDescription(m.description || "");
    setDuration(m.duration_minutes != null ? String(m.duration_minutes) : "");
    setNotes(m.notes || "");
    setIcon(m.icon || "");
    setColor(m.color || "");
    setDisplayOrder(m.display_order != null ? String(m.display_order) : "");
    setError("");
    setTimeout(() => { try { nameRef.current && nameRef.current.focus(); } catch(_){} }, 40);
  }

  async function doSave(addAnother) {
    setError("");
    const trimmed = name.trim();
    if (!trimmed) { setError("الاسم مطلوب"); return; }
    if (!/\S/.test(trimmed)) { setError("الاسم لا يمكن أن يحتوي على مسافات فقط"); return; }
    setSaving(true);
    const payload = {
      name: trimmed, category, description, notes,
      duration_minutes: duration === "" ? null : Number(duration),
      icon: icon || null,
      color: color || null,
      display_order: displayOrder === "" ? null : Number(displayOrder),
    };
    let res;
    if (editingId) res = await window.TxMethods.update(editingId, payload);
    else           res = await window.TxMethods.create(payload);
    setSaving(false);
    if (!res.ok) { setError(res.error || "تعذّر الحفظ"); return; }
    if (window.showToast) window.showToast(editingId ? "تم تحديث طريقة العلاج" : "تمت إضافة طريقة العلاج", "success");
    if (onSaved && !editingId) onSaved({ method_id: res.method_id, name: trimmed });
    if (addAnother) {
      resetForm();
      setTimeout(() => { try { nameRef.current && nameRef.current.focus(); } catch(_){} }, 40);
    } else {
      onClose && onClose();
    }
  }

  async function doArchiveToggle(m) {
    const id = m.method_id || m.id;
    const next = m.status === "archived" ? "active" : "archived";
    const fn = next === "archived" ? window.TxMethods.archive : window.TxMethods.restore;
    const res = await fn(id);
    if (!res.ok) {
      if (window.showToast) window.showToast(res.error || "تعذّر التنفيذ", "error");
      return;
    }
    if (window.showToast) window.showToast(next === "archived" ? "تم أرشفة الطريقة" : "تمت الاستعادة", "success");
  }

  // Two-click confirm: first click sets deletingId; second click actually
  // deletes. The RPC blocks the delete if any template references the
  // method (both by method_id and by case-insensitive name).
  async function doDelete(m) {
    const id = m.method_id || m.id;
    if (deletingId !== id) { setDeletingId(id); return; }
    if (!window.TxMethods || !window.TxMethods.remove) {
      if (window.showToast) window.showToast("خدمة الحذف غير متاحة", "error");
      return;
    }
    const res = await window.TxMethods.remove(id);
    setDeletingId(null);
    if (!res.ok) {
      if (window.showToast) window.showToast(res.error || "تعذّر الحذف", "error");
      return;
    }
    if (editingId === id) resetForm();
    if (window.showToast) window.showToast("تم حذف طريقة العلاج", "success");
  }

  return (
    <Modal
      open onClose={onClose}
      title={editingId ? "تعديل طريقة العلاج" : "إضافة طريقة علاج جديدة"}
      width={720}
      footer={<>
        <button className="btn btn-ghost" onClick={onClose} disabled={saving}>إلغاء</button>
        {!editingId && (
          <button className="btn btn-secondary" onClick={()=>doSave(true)} disabled={saving}>
            {saving ? "جارٍ الحفظ…" : "حفظ وإضافة أخرى"}
          </button>
        )}
        <button className="btn btn-blue" onClick={()=>doSave(false)} disabled={saving}>
          <I.Check size={13}/> {saving ? "جارٍ الحفظ…" : "حفظ"}
        </button>
      </>}
    >
      <div style={{display:"grid",gap:14}}>
        {/* Search existing */}
        <div>
          <div style={{position:"relative"}}>
            <I.Search size={14} style={{position:"absolute",left:11,top:"50%",transform:"translateY(-50%)",color:"var(--ink-400)"}}/>
            <input
              className="input"
              placeholder="ابحث في طرق العلاج الموجودة قبل إنشاء طريقة جديدة…"
              value={query}
              onChange={e=>setQuery(e.target.value)}
              style={{paddingLeft:32}}
            />
          </div>
          {results.length > 0 && (
            <div style={{marginTop:8,maxHeight:170,overflowY:"auto",border:"1px solid var(--ink-100)",borderRadius:10,background:"var(--ink-50)"}}>
              {results.slice(0,25).map(m => {
                const id = m.method_id || m.id;
                const archived = m.status === "archived";
                const isConfirmingDelete = deletingId === id;
                const IconCmp = m.icon && I[m.icon];
                return (
                  <div key={id}
                       style={{display:"flex",alignItems:"center",gap:10,padding:"8px 12px",borderBottom:"1px solid var(--ink-100)",opacity: archived ? .6 : 1}}>
                    {(IconCmp || m.color) && (
                      <span style={{
                        width:26,height:26,borderRadius:8,display:"inline-flex",alignItems:"center",justifyContent:"center",
                        background: m.color ? `${m.color}22` : "var(--ink-100)",
                        color: m.color || "var(--ink-600)",
                        flexShrink:0,
                      }}>
                        {IconCmp ? <IconCmp size={13}/> : <span style={{fontSize:11,fontWeight:600}}>{(m.name||"?").slice(0,1)}</span>}
                      </span>
                    )}
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:13,fontWeight:500}}>{m.name}{archived && <span className="badge b-grey" style={{marginRight:8,fontSize:10.5}}>مؤرشف</span>}</div>
                      <div className="muted" style={{fontSize:11.5}}>
                        {m.category || "بدون فئة"}
                        {m.duration_minutes ? ` · ${m.duration_minutes} دقيقة` : ""}
                        {m.display_order != null ? ` · ترتيب ${m.display_order}` : ""}
                      </div>
                    </div>
                    <button className="btn btn-ghost" style={{fontSize:11.5,padding:"4px 8px"}} onClick={()=>loadIntoForm(m)}>تعديل</button>
                    <button className="btn btn-ghost" style={{fontSize:11.5,padding:"4px 8px",color:archived ? "var(--green)" : "var(--amber-700, #b45309)"}} onClick={()=>doArchiveToggle(m)}>
                      {archived ? "استعادة" : "أرشفة"}
                    </button>
                    <button
                      className="btn btn-ghost"
                      style={{fontSize:11.5,padding:"4px 8px",color:"var(--red)",fontWeight:isConfirmingDelete?600:400}}
                      onClick={()=>doDelete(m)}
                      onBlur={()=>{ if (deletingId === id) setDeletingId(null); }}
                    >
                      {isConfirmingDelete ? "تأكيد الحذف؟" : "حذف"}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          <div style={{marginTop:6,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <label style={{display:"flex",alignItems:"center",gap:6,fontSize:12,color:"var(--ink-600)"}}>
              <input type="checkbox" checked={showArchived} onChange={e=>setShowArchived(e.target.checked)}/>
              عرض المؤرشفة
            </label>
            {editingId && (
              <button className="btn btn-ghost" style={{fontSize:12}} onClick={resetForm}>
                <I.Plus size={12}/> إضافة طريقة جديدة بدل التعديل
              </button>
            )}
          </div>
        </div>

        {/* Form */}
        <div className="rgrid c-sm" style={{"--gtc":"repeat(2,1fr)",gap:12}}>
          <Field label="اسم طريقة العلاج" required span={2}>
            <input ref={nameRef} className="input" value={name} onChange={e=>setName(e.target.value)} placeholder="مثال: علاج إبر جافة"/>
            {dupHint && (
              <div style={{marginTop:6,fontSize:12,color:"var(--amber-700, #b45309)"}}>
                يوجد طريقة بنفس الاسم مسبقًا:
                <button className="btn btn-ghost" style={{fontSize:12,padding:"2px 6px",marginRight:6}} onClick={()=>loadIntoForm(dupHint)}>
                  فتح "{dupHint.name}"
                </button>
              </div>
            )}
          </Field>
          <Field label="الفئة">
            <input
              className="input"
              value={category}
              onChange={e=>setCategory(e.target.value)}
              list="tx-method-categories"
              placeholder="اختر أو اكتب فئة جديدة"
            />
            <datalist id="tx-method-categories">
              {["علاج يدوي","تمارين علاجية","أجهزة علاجية","علاج مائي","تأهيل رياضي","علاج عصبي","علاج أطفال","أخرى", ...categories]
                .filter((v,i,arr)=>arr.indexOf(v)===i)
                .map(c => <option key={c} value={c}/>) }
            </datalist>
          </Field>
          <Field label="مدة الجلسة (دقيقة)">
            <input className="input" type="number" min="0" value={duration} onChange={e=>setDuration(e.target.value)} placeholder="مثال: 30"/>
          </Field>
          <Field label="ترتيب العرض">
            <input className="input" type="number" value={displayOrder} onChange={e=>setDisplayOrder(e.target.value)} placeholder="اترك فارغًا للترتيب الأبجدي"/>
          </Field>
          <Field label="الأيقونة" span={2}>
            <div style={{display:"flex",flexWrap:"wrap",gap:6,alignItems:"center"}}>
              <button type="button" onClick={()=>setIcon("")} className="btn btn-secondary" style={{fontSize:11.5,padding:"5px 9px",background:!icon?"var(--blue-50)":"#fff",borderColor:!icon?"var(--blue-500)":"var(--ink-200)"}}>
                بدون
              </button>
              {TX_METHOD_ICONS.map(nm => {
                const IconCmp = I[nm]; if (!IconCmp) return null;
                const on = icon === nm;
                return (
                  <button key={nm} type="button" onClick={()=>setIcon(nm)} title={nm}
                    className="btn btn-secondary"
                    style={{padding:"5px 8px",background:on?"var(--blue-50)":"#fff",borderColor:on?"var(--blue-500)":"var(--ink-200)",color:on?"var(--blue-700)":"var(--ink-600)"}}>
                    <IconCmp size={14}/>
                  </button>
                );
              })}
            </div>
          </Field>
          <Field label="اللون" span={2}>
            <div style={{display:"flex",flexWrap:"wrap",gap:6,alignItems:"center"}}>
              <button type="button" onClick={()=>setColor("")} className="btn btn-secondary" style={{fontSize:11.5,padding:"5px 9px",background:!color?"var(--blue-50)":"#fff",borderColor:!color?"var(--blue-500)":"var(--ink-200)"}}>
                بدون
              </button>
              {TX_METHOD_COLORS.map(c => {
                const on = color === c;
                return (
                  <button key={c} type="button" onClick={()=>setColor(c)} title={c}
                    style={{width:26,height:26,borderRadius:8,padding:0,cursor:"pointer",
                      background:`${c}33`,
                      border: on ? `2px solid ${c}` : "1px solid var(--ink-200)"}}>
                    <span style={{display:"block",width:12,height:12,borderRadius:4,background:c,margin:"auto"}}/>
                  </button>
                );
              })}
              <input type="color" value={color || "#3B82F6"} onChange={e=>setColor(e.target.value)}
                style={{width:34,height:32,padding:0,border:"1px solid var(--ink-200)",borderRadius:8,background:"transparent",cursor:"pointer"}}/>
            </div>
          </Field>
          <Field label="الوصف" span={2}>
            <textarea className="input" style={{height:70,padding:10}} value={description} onChange={e=>setDescription(e.target.value)} placeholder="وصف موجز يظهر للفريق"/>
          </Field>
          <Field label="ملاحظات" span={2}>
            <textarea className="input" style={{height:60,padding:10}} value={notes} onChange={e=>setNotes(e.target.value)} placeholder="ملاحظات إضافية (اختياري)"/>
          </Field>
        </div>

        {error && (
          <div style={{padding:"10px 12px",background:"var(--red-50, #fef2f2)",border:"1px solid var(--red-100, #fecaca)",borderRadius:10,color:"var(--red, #b91c1c)",fontSize:12.5}}>
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}

// ───────────────── جلسات العلاج ─────────────────

function Sessions({ go }) {
  const [tab, setTab] = React.useState("current");
  const CC = window.ConcurrentSessions;

  return (
    <Page>
      <div className="page-head">
        <div>
          <div className="crumb"><span>الرئيسية</span><I.Chevron size={11}/><span>جلسات العلاج</span></div>
          <div className="h1">جلسات العلاج</div>
          <div className="muted" style={{fontSize:13.5,marginTop:4}}>شغّل عدة جلسات في وقت واحد، سجّل الألم والملاحظات، ووقّع.</div>
        </div>
        <div className="seg">
          <button className={tab==="current"?"on":""} onClick={()=>setTab("current")}>الجلسات الجارية</button>
          <button className={tab==="السجل"?"on":""} onClick={()=>setTab("السجل")}>سجل الجلسات</button>
        </div>
      </div>

      {tab==="current" && <CC/>}
      {tab==="السجل" && <SessionHistoryList/>}
    </Page>
  );
}

function PainTrendChart() {
  const data = DATA.sessions.slice().reverse().map((s,i) => ({ label: `S${i+1}`, v: 11 - (s.pain ?? s.pain_score ?? 0) }));
  return <AreaChart data={data} height={140} color="#3FA984" fill="rgba(63,169,132,.18)"/>;
}

function SessionHistoryList() {
  return (
    <div>
      <div className="card" style={{padding:14,marginBottom:14,display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
        <div style={{position:"relative",flex:"1 1 320px",maxWidth:380}}>
          <I.Search size={14} style={{position:"absolute",left:11,top:"50%",transform:"translateY(-50%)",color:"var(--ink-400)"}}/>
          <input className="input" placeholder="ابحث بالمريض أو الملاحظة…" style={{paddingLeft:32}}/>
        </div>
        <select className="input" style={{width:"auto",minWidth:150,flex:"0 1 180px"}}><option>كل الأخصائيين</option>{DATA.therapists.map(t=><option key={t.id||t.name}>{t.name}</option>)}</select>
        <select className="input" style={{width:"auto",minWidth:150,flex:"0 1 180px"}}><option>آخر 30 يوم</option><option>هذا الأسبوع</option></select>
      </div>

      <SessionTimeline/>
    </div>
  );
}

function SessionTimeline({ mini, p }) {
  window.useDataVersion && window.useDataVersion();
  const [notesModal, setNotesModal] = React.useState(null);
  // Only admins and the owning therapist may delete a session (the sessions
  // RLS policy enforces "own" server-side; the button is hidden for roles
  // that never pass it).
  const role = (window.ME && window.ME.role) || "";
  const canDelete = role === "مدير" || role === "admin" || role === "الأخصائي" || role === "therapist";

  // Permanently delete one session. removeRow deletes on the server first and
  // throws on any rejection (RLS/FK/network) — no false success. The DB
  // trigger recomputes the parent plan's completed-session count, and the
  // 'kinetic:data-updated' event (via useDataVersion) refreshes this list and
  // every stat derived from DATA.sessions.
  async function onDeleteSession(s) {
    const n = s.session ?? s.session_number ?? "";
    if (!window.confirm(`حذف الجلسة ${n ? "#"+n : ""} للمريض ${(p && p.name) || s.patient || ""}؟ لا يمكن التراجع.`)) return;
    try {
      await window.KineticData.remove("sessions", s.session_id ?? s.id);
      window.showToast && window.showToast("تم حذف الجلسة", "success");
    } catch (e) {
      console.warn("delete session failed", e);
      window.showToast && window.showToast(e.message || "تعذّر حذف الجلسة", "error");
    }
  }

  // Scope to one patient when rendered inside a patient profile. Running
  // sessions live in the "الجلسات الجارية" tab — history shows completed.
  const pid = p ? (p.patient_id || p.id) : null;
  const completed = (DATA.sessions || []).filter(s => (s.status || "completed") !== "in_progress");
  const rows = p
    ? completed.filter(s => s.patient_id === pid || s.patient === p.name)
    : completed;
  if (rows.length === 0) {
    return <EmptyState icon={<I.Activity size={22}/>} title="لا جلسات مسجلة بعد" body="ستظهر الجلسات هنا بعد تسجيلها من شاشة الجلسات."/>;
  }
  return (
    <div className="card" style={{padding:0,overflow:"hidden"}}>
      {rows.map((s,i)=>(
        <div key={s.id || i} className="rgrid sess-row" style={{
          padding:"16px 22px", borderBottom:i<rows.length-1?"1px solid var(--ink-100)":"none",
          "--gtc":"56px 1fr 110px 130px", gap:16, alignItems:"center"
        }}>
          <div style={{textAlign:"center"}}>
            <div className="mono" style={{fontSize:20,fontWeight:600,color:"var(--blue-700)"}}>#{s.session ?? s.session_number ?? "—"}</div>
            <div className="muted mono" style={{fontSize:10}}>{s.date}</div>
          </div>
          <div>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
              <span style={{fontSize:13,fontWeight:600}}>{(p && p.name) || s.patient || "—"} · جلسة #{s.session ?? s.session_number ?? "—"}</span>
              {(s.therapist || "") && <span className="muted" style={{fontSize:11.5}}>بواسطة {s.therapist}</span>}
            </div>
            <div style={{fontSize:13,color:"var(--ink-700)",lineHeight:1.5}}>{s.notes || s.session_notes || ""}</div>
            {s.done && s.done.length>0 && (
              <div style={{display:"flex",gap:6,marginTop:8,flexWrap:"wrap"}}>
                {s.done.map(d=><span key={d} className="badge b-green"><I.Check size={10}/>{d}</span>)}
              </div>
            )}
          </div>
          <div style={{textAlign:"center"}}>
            <div className="muted" style={{fontSize:11}}>الألم</div>
            <div className="mono" style={{fontSize:18,fontWeight:600, color: s.pain<=3?"var(--green)":s.pain<=6?"var(--amber)":"var(--red)"}}>{s.pain}/10</div>
            <div style={{fontSize:11,color:"var(--ink-500)"}}>{s.mood}</div>
          </div>
          <div style={{textAlign:"right",display:"flex",gap:6,justifyContent:"flex-end",alignItems:"center"}}>
            <button className="btn btn-secondary" style={{fontSize:12}} onClick={()=>setNotesModal(s)}>عرض الملاحظات <I.ArrowRight size={11}/></button>
            {canDelete && (
              <button className="btn btn-ghost btn-icon" title="حذف الجلسة" onClick={()=>onDeleteSession(s)}><I.Trash size={13}/></button>
            )}
          </div>
        </div>
      ))}
      {notesModal && (
        <Modal title={`ملاحظات الجلسة #${notesModal.session}`} onClose={()=>setNotesModal(null)}>
          <div style={{fontSize:13,color:"var(--ink-700)",lineHeight:1.7,marginBottom:12}}>{notesModal.notes}</div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            {(notesModal.done||[]).map(d=><span key={d} className="badge b-green"><I.Check size={10}/>{d}</span>)}
          </div>
          <div style={{marginTop:14,paddingTop:12,borderTop:"1px solid var(--ink-100)",display:"flex",justifyContent:"space-between",fontSize:12,color:"var(--ink-500)"}}>
            <span>التاريخ: {notesModal.date}</span>
            <span>مستوى الألم: {notesModal.pain}/10 · {notesModal.mood}</span>
          </div>
        </Modal>
      )}
    </div>
  );
}

Object.assign(window, { Treatments, Sessions, SessionTimeline, TxMethodModal });


// ===== src/payments.jsx =====
// Payments + invoices + Packages

// ── Date filter presets for the Payments page ───────────────
// Each preset returns { from, to } as YYYY-MM-DD strings (inclusive).
// "custom" and "range" are picker modes; their range is computed from
// user input in the DateFilterBar rather than here.
function __invPad(n){ return String(n).padStart(2,"0"); }
function __invIso(d){ return `${d.getFullYear()}-${__invPad(d.getMonth()+1)}-${__invPad(d.getDate())}`; }
function __invStartOfWeek(d){
  // Week starts Saturday (Arabic clinic convention). getDay(): Sat=6.
  const day = d.getDay();
  const diff = (day + 1) % 7; // days since Saturday
  const out = new Date(d); out.setDate(d.getDate() - diff); return out;
}
function invoiceDateRange(preset, custom, rangeStart, rangeEnd) {
  const now = new Date(); now.setHours(0,0,0,0);
  const y = now.getFullYear(), m = now.getMonth();
  switch (preset) {
    case "today":       return { from: __invIso(now), to: __invIso(now) };
    case "yesterday": {
      const y1 = new Date(now); y1.setDate(now.getDate()-1);
      return { from: __invIso(y1), to: __invIso(y1) };
    }
    case "thisWeek": {
      const s = __invStartOfWeek(now);
      return { from: __invIso(s), to: __invIso(now) };
    }
    case "lastWeek": {
      const s = __invStartOfWeek(now); s.setDate(s.getDate()-7);
      const e = new Date(s); e.setDate(s.getDate()+6);
      return { from: __invIso(s), to: __invIso(e) };
    }
    case "thisMonth": {
      const s = new Date(y, m, 1), e = new Date(y, m+1, 0);
      return { from: __invIso(s), to: __invIso(e) };
    }
    case "lastMonth": {
      const s = new Date(y, m-1, 1), e = new Date(y, m, 0);
      return { from: __invIso(s), to: __invIso(e) };
    }
    case "thisYear": {
      const s = new Date(y, 0, 1), e = new Date(y, 11, 31);
      return { from: __invIso(s), to: __invIso(e) };
    }
    case "lastYear": {
      const s = new Date(y-1, 0, 1), e = new Date(y-1, 11, 31);
      return { from: __invIso(s), to: __invIso(e) };
    }
    case "custom":
      return custom ? { from: custom, to: custom } : { from: null, to: null };
    case "range":
      return { from: rangeStart || null, to: rangeEnd || null };
    case "all":
    default:
      return { from: null, to: null };
  }
}

function InvoiceDateFilterBar({ preset, setPreset, custom, setCustom, rangeStart, setRangeStart, rangeEnd, setRangeEnd }) {
  const items = [
    { k:"today",     l:"اليوم" },
    { k:"yesterday", l:"أمس" },
    { k:"thisWeek",  l:"هذا الأسبوع" },
    { k:"lastWeek",  l:"الأسبوع الماضي" },
    { k:"thisMonth", l:"هذا الشهر" },
    { k:"lastMonth", l:"الشهر الماضي" },
    { k:"thisYear",  l:"هذه السنة" },
    { k:"lastYear",  l:"السنة الماضية" },
    { k:"custom",    l:"تاريخ مخصص" },
    { k:"range",     l:"نطاق تاريخ" },
    { k:"all",       l:"الكل" },
  ];
  return (
    <div style={{display:"flex",flexDirection:"column",gap:8,flex:"1 1 100%"}}>
      <div className="seg" style={{flexWrap:"wrap",gap:4}}>
        {items.map(it => (
          <button key={it.k}
            className={preset===it.k?"on":""}
            onClick={()=>setPreset(it.k)}
            style={{padding:"6px 10px",fontSize:12}}>{it.l}</button>
        ))}
      </div>
      {preset==="custom" && (
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <I.Calendar size={13} style={{color:"var(--ink-400)"}}/>
          <span className="muted" style={{fontSize:12}}>اليوم</span>
          <input className="input" type="date" value={custom||""}
            onChange={e=>setCustom(e.target.value)}
            style={{width:180}}/>
        </div>
      )}
      {preset==="range" && (
        <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
          <I.Calendar size={13} style={{color:"var(--ink-400)"}}/>
          <span className="muted" style={{fontSize:12}}>من</span>
          <input className="input" type="date" value={rangeStart||""}
            onChange={e=>setRangeStart(e.target.value)}
            style={{width:170}}/>
          <span className="muted" style={{fontSize:12}}>إلى</span>
          <input className="input" type="date" value={rangeEnd||""}
            onChange={e=>setRangeEnd(e.target.value)}
            style={{width:170}}/>
        </div>
      )}
    </div>
  );
}

function Payments({ go }) {
  window.useDataVersion && window.useDataVersion();
  const [tab, setTab] = React.useState("payments");
  const [statusFilter, setStatusFilter] = React.useState("الكل");
  const [methodFilter, setMethodFilter] = React.useState("الكل");
  const [selected, setSelected] = React.useState(null);
  const [search, setSearch] = React.useState("");
  const [preset, setPreset] = React.useState("thisMonth");
  const [customDate, setCustomDate] = React.useState("");
  const [rangeStart, setRangeStart] = React.useState("");
  const [rangeEnd, setRangeEnd] = React.useState("");
  const [page, setPage] = React.useState(0);
  const PAGE_SIZE = 20;

  // Debounce the search so we don't hammer the RPC on every keystroke.
  const [debouncedSearch, setDebouncedSearch] = React.useState("");
  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  React.useEffect(() => { setPage(0); }, [preset, customDate, rangeStart, rangeEnd, statusFilter, debouncedSearch]);

  const { from, to } = React.useMemo(
    () => invoiceDateRange(preset, customDate, rangeStart, rangeEnd),
    [preset, customDate, rangeStart, rangeEnd]
  );

  const [payload, setPayload] = React.useState({
    rows: [], stats: { total_invoices:0, paid_amount:0, outstanding:0, overdue_amount:0, avg_amount:0, revenue:0, count:0, due_total:0 },
    count: 0, limit: PAGE_SIZE, offset: 0,
  });
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!window.InvoicesAPI) return;
      setLoading(true);
      try {
        const res = await window.InvoicesAPI.listFiltered({
          from, to,
          search: debouncedSearch,
          status: statusFilter === "الكل" ? null : statusFilter,
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        });
        if (!cancelled) setPayload(res);
      } catch (e) {
        console.warn("listInvoicesFiltered failed", e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    run();
    return () => { cancelled = true; };
  }, [from, to, debouncedSearch, statusFilter, page]);

  // Client-side layer for method (kept off the server — small, local filter).
  const filtered = payload.rows.filter(p => methodFilter==="الكل" || p.method===methodFilter);
  const stats = payload.stats;
  const totalPages = Math.max(1, Math.ceil((payload.count||0) / PAGE_SIZE));

  const exportCsv = () => {
    const rows=["الفاتورة,المريض,التاريخ,المبلغ,مدفوع,الطريقة,الحالة",
      ...filtered.map(p=>`${p.id||p.invoice_id},${p.patient||""},${p.date||""},${p.amount||0},${p.paid||0},${p.method||""},${p.status||""}`)];
    downloadCsv(rows, "payments.csv");
    if(window.showToast)window.showToast("تم تصدير الفواتير","success");
  };

  return (
    <Page>
      <div className="page-head">
        <div>
          <div className="crumb"><span>الرئيسية</span><I.Chevron size={11}/><span>المدفوعات والفواتير</span></div>
          <div className="h1">المدفوعات والفواتير</div>
          <div className="muted" style={{fontSize:13.5,marginTop:4}}>نقدي، بطاقة، إنستاباي، فودافون كاش، تحويل بنكي</div>
        </div>
        <div className="page-actions">
          <button className="btn btn-secondary" onClick={exportCsv}><I.Download size={14}/> تصدير</button>
          <button className="btn btn-blue" onClick={()=>setSelected({mode:"new"})}><I.Plus size={14}/> فاتورة جديدة</button>
        </div>
      </div>

      <div className="grid-4" style={{marginBottom:18}}>
        <StatCard label="إجمالي الإيرادات" value={`EGP ${(Number(stats.revenue||0)/1000).toFixed(1)}K`} accent="#3FA984" icon={<I.Dollar size={15}/>}/>
        <StatCard label="المعلّق"          value={`EGP ${(Number(stats.outstanding||0)/1000).toFixed(1)}K`} accent="#D49044" icon={<I.Clock size={15}/>}/>
        <StatCard label="المتأخر"          value={`EGP ${(Number(stats.overdue_amount||0)/1000).toFixed(1)}K`} accent="#D8665A" icon={<I.X size={15}/>}/>
        <StatCard label="متوسط الفاتورة"   value={`EGP ${(Number(stats.avg_amount||0)/1000).toFixed(1)}K`} accent="#7BBDE8" icon={<I.FileText size={15}/>}/>
      </div>
      <div className="grid-4" style={{marginBottom:18}}>
        <StatCard label="إجمالي الفواتير"    value={`EGP ${(Number(stats.total_invoices||0)/1000).toFixed(1)}K`} accent="#7E6BD3" icon={<I.FileText size={15}/>}/>
        <StatCard label="المدفوع"            value={`EGP ${(Number(stats.paid_amount||0)/1000).toFixed(1)}K`} accent="#3FA984" icon={<I.Check size={15}/>}/>
        <StatCard label="عدد الفواتير"       value={`${Number(stats.count||0)}`} accent="#3A7FB5" icon={<I.Layers size={15}/>}/>
        <StatCard label="إجمالي المستحقات"   value={`EGP ${(Number(stats.due_total||0)/1000).toFixed(1)}K`} accent="#D49044" icon={<I.Clock size={15}/>}/>
      </div>

      <div className="seg" style={{marginBottom:14}}>
        <button className={tab==="payments"?"on":""} onClick={()=>setTab("payments")}>الفواتير</button>
        <button className={tab==="methods"?"on":""}  onClick={()=>setTab("methods")}>طرق الدفع</button>
        <button className={tab==="receipts"?"on":""} onClick={()=>setTab("receipts")}>الإيصالات</button>
      </div>

      {tab==="payments" && (
        <>
          <div className="card" style={{padding:14,marginBottom:14,display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
            <div style={{position:"relative",flex:"1 1 280px",maxWidth:340}}>
              <I.Search size={14} style={{position:"absolute",left:11,top:"50%",transform:"translateY(-50%)",color:"var(--ink-400)"}}/>
              <input className="input" placeholder="ابحث في الفواتير…" style={{paddingLeft:32}}
                value={search} onChange={e=>setSearch(e.target.value)}/>
            </div>
            <div className="seg">
              {["الكل","مدفوع","جزئي","معلّق","متأخر"].map(s=>(
                <button key={s} className={statusFilter===s?"on":""} onClick={()=>setStatusFilter(s)}>{s}</button>
              ))}
            </div>
            <select className="input" style={{width:160}} value={methodFilter} onChange={e=>setMethodFilter(e.target.value)}>
              <option>الكل</option><option>نقدي</option><option>فيزا</option><option>إنستاباي</option><option>فودافون كاش</option><option>تحويل بنكي</option>
            </select>
            <InvoiceDateFilterBar
              preset={preset} setPreset={setPreset}
              custom={customDate} setCustom={setCustomDate}
              rangeStart={rangeStart} setRangeStart={setRangeStart}
              rangeEnd={rangeEnd} setRangeEnd={setRangeEnd}/>
          </div>

          <div className="card" style={{overflow:"hidden"}}>
            <div className="tbl-scroll">
            <table className="tbl">
              <thead><tr>
                <th>فاتورة</th><th>المريض</th><th>التاريخ</th><th>المبلغ</th><th>مدفوع</th><th>الطريقة</th><th>الحالة</th><th></th>
              </tr></thead>
              <tbody>
                {filtered.length===0 && (
                  <tr><td colSpan={8}><EmptyState icon={<I.FileText size={22}/>} title="لا فواتير للفترة المحددة" body={loading ? "جارٍ التحميل…" : "لا توجد فواتير مطابقة لعوامل التصفية الحالية."}/></td></tr>
                )}
                {filtered.map(p=>{
                  const remaining = p.amount - p.paid;
                  const pct = p.amount ? p.paid/p.amount : 0;
                  return (
                    <tr key={p.id} data-clickable="true" tabIndex={0} onClick={()=>setSelected(p)} onKeyDown={e=>{ if(e.key==="Enter"||e.key===" "){e.preventDefault();setSelected(p);} }}>
                      <td className="mono" style={{fontWeight:600}}>{p.id}</td>
                      <td>
                        <div style={{display:"flex",alignItems:"center",gap:8}}>
                          <div className="av sm">{(p.patient||"—").split(" ").map(x=>x[0]).join("").slice(0,2)}</div>
                          {p.patient}
                        </div>
                      </td>
                      <td>{p.date}</td>
                      <td className="mono" style={{fontWeight:600}}>EGP {p.amount.toLocaleString()}</td>
                      <td>
                        <div>
                          <div className="mono" style={{fontSize:13}}>EGP {p.paid.toLocaleString()}</div>
                          <div style={{height:3,background:"var(--ink-100)",borderRadius:999,overflow:"hidden",marginTop:3}}>
                            <div style={{height:"100%",width:`${pct*100}%`,background:pct===1?"var(--green)":"var(--amber)"}}/>
                          </div>
                          {remaining>0 && <div className="muted mono" style={{fontSize:10.5,marginTop:2}}>EGP {remaining.toLocaleString()} due</div>}
                        </div>
                      </td>
                      <td>
                        <span className="pill" style={{fontSize:11}}>
                          {p.method==="نقدي" && <I.Dollar size={11}/>}
                          {p.method==="فيزا" && <I.CreditCard size={11}/>}
                          {(p.method==="إنستاباي" || p.method==="فودافون كاش") && <I.Phone size={11}/>}
                          {p.method==="تحويل بنكي" && <I.Layers size={11}/>}
                          {p.method}
                        </span>
                      </td>
                      <td><PayBadge s={p.status}/></td>
                      <td onClick={e=>e.stopPropagation()}>
                        <button className="btn btn-ghost btn-icon" title="عرض" onClick={()=>setSelected(p)}><I.Eye size={13}/></button>
                        <button className="btn btn-ghost btn-icon" title="تحميل" onClick={()=>{
                          const rows=["الفاتورة,المريض,التاريخ,المبلغ,مدفوع,الطريقة,الحالة",`${p.id},${p.patient},${p.date},${p.amount},${p.paid},${p.method},${p.status}`];
                          downloadCsv(rows, `invoice-${p.id}.csv`);
                        }}><I.Download size={13}/></button>
                        <RowMenu size={13} items={[
                          { label:"عرض التفاصيل", icon:<I.Eye size={13}/>, onClick:()=>setSelected(p) },
                          { label:"طباعة", icon:<I.Print size={13}/>, onClick:()=>window.print() },
                          { label:"تصدير CSV", icon:<I.Download size={13}/>, onClick:()=>{
                            const rows=["الفاتورة,المريض,التاريخ,المبلغ,مدفوع,الطريقة,الحالة",`${p.id},${p.patient},${p.date},${p.amount},${p.paid},${p.method},${p.status}`];
                            downloadCsv(rows, `invoice-${p.id}.csv`);
                            if(window.showToast)window.showToast("تم تصدير الفاتورة","success");
                          }},
                          { label:"حذف", icon:<I.X size={13}/>, danger:true, onClick:async ()=>{
                            if (!window.confirm(`حذف الفاتورة ${p.id}؟`)) return;
                            try {
                              if (window.KineticData) await window.KineticData.remove("payments", p.invoice_id || p.id);
                              if (window.showToast) window.showToast("تم حذف الفاتورة","success");
                            } catch (e) { console.warn("delete invoice failed", e); if (window.showToast) window.showToast("تعذّر الحذف","error"); }
                          }},
                        ]}/>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
            {payload.count > PAGE_SIZE && (
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 14px",borderTop:"1px solid var(--ink-100)",gap:8}}>
                <div className="muted" style={{fontSize:12}}>
                  {(page*PAGE_SIZE)+1}–{Math.min((page+1)*PAGE_SIZE, payload.count)} من {payload.count}
                </div>
                <div style={{display:"flex",gap:6}}>
                  <button className="btn btn-secondary" disabled={page===0} onClick={()=>setPage(p=>Math.max(0,p-1))} style={{padding:"5px 10px",fontSize:12}}>السابق</button>
                  <div className="muted mono" style={{fontSize:12,padding:"5px 10px"}}>{page+1} / {totalPages}</div>
                  <button className="btn btn-secondary" disabled={page>=totalPages-1} onClick={()=>setPage(p=>Math.min(totalPages-1,p+1))} style={{padding:"5px 10px",fontSize:12}}>التالي</button>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {tab==="methods" && <PaymentMethodsView/>}
      {tab==="receipts" && <ReceiptsView/>}

      {/* invoice preview modal */}
      {selected && selected.id && <InvoiceModal invoice={selected} onClose={()=>setSelected(null)}/>}
      {selected && selected.mode==="new" && <NewInvoiceModal onClose={()=>setSelected(null)}/>}
    </Page>
  );
}

function PaymentMethodsView() {
  // Real method mix computed from the invoices table.
  const colors = ["#7BBDE8","#3A7FB5","#7E6BD3","#D49044","#3FA984","#BDD8E9"];
  const byMethod = {};
  DATA.payments.forEach(p => {
    const m = p.method || p.payment_method || "—";
    byMethod[m] = (byMethod[m] || 0) + (p.paid || 0);
  });
  const totalPaid = Object.values(byMethod).reduce((s,v)=>s+v, 0);
  const data = Object.entries(byMethod).sort((a,b)=>b[1]-a[1]).map(([label, rev], i) => ({
    label,
    v: totalPaid ? Math.round(rev/totalPaid*100) : 0,
    color: colors[i % colors.length],
    revenue: rev.toLocaleString(),
  }));
  if (data.length === 0) {
    return <EmptyState icon={<I.CreditCard size={22}/>} title="لا مدفوعات بعد" body="سيظهر توزيع طرق الدفع هنا بعد تسجيل الفواتير."/>;
  }
  return (
    <div className="rgrid c-lg" style={{"--gtc":"1fr 1fr"}}>
      <div className="card card-pad">
        <div className="h2" style={{marginBottom:18}}>الطريقة mix · this month</div>
        <DonutChart data={data} size={200} centerLabel="ج.م محصلة" centerValue={totalPaid>=1000?`${(totalPaid/1000).toFixed(0)}K`:String(totalPaid)}/>
      </div>
      <div className="card card-pad">
        <div className="h2" style={{marginBottom:14}}>Revenue بواسطة method</div>
        {data.map(d=>(
          <div key={d.label} style={{padding:"11px 0",borderBottom:"1px dashed var(--ink-100)",display:"flex",alignItems:"center",gap:10}}>
            <span style={{width:8,height:8,borderRadius:3,background:d.color}}></span>
            <span style={{flex:1,fontSize:13}}>{d.label}</span>
            <span className="mono" style={{fontSize:13,fontWeight:600}}>EGP {d.revenue}</span>
            <span className="muted mono" style={{fontSize:11,minWidth:36,textAlign:"right"}}>{d.v}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReceiptsView() {
  return (
    <EmptyState icon={<I.FileText size={22}/>} title="لا توجد إيصالات بعد" body="Receipts will appear here when مريض pay invoices. You can also upload paper receipts manually." action={<button className="btn btn-blue"><I.Upload size={13}/> رفع إيصال</button>}/>
  );
}

function InvoiceModal({ invoice, onClose }) {
  const clinic = window.CLINIC || {};
  const clinicName = clinic.name || "العيادة";
  const lineDesc = invoice.desc || "خدمات علاجية";
  const waPhone = String(clinic.phone || "").replace(/\D/g, "");
  return (
    <Modal open onClose={onClose} title={`فاتورة ${invoice.id}`} width={680}
      footer={<>
        <button className="btn btn-secondary" onClick={()=>window.print()}><I.Print size={13}/> طباعة</button>
        <button className="btn btn-secondary" onClick={()=>{
          const rows=["البند,الكمية,السعر",`${lineDesc},1,${invoice.amount}`];
          downloadCsv(rows, `invoice-${invoice.id}.csv`);
          if(window.showToast)window.showToast("تم تحميل الفاتورة","success");
        }}><I.Download size={13}/> تحميل PDF</button>
        <button className="btn btn-blue" disabled={!waPhone} onClick={()=>{
          window.open(`https://wa.me/${waPhone}?text=فاتورة+${invoice.id}+بمبلغ+${invoice.amount}+جنيه+مصري`,"_blank");
        }}><I.Send size={13}/> Send via واتساب</button>
      </>}>
      <div style={{padding:"clamp(14px, 3vw, 24px)",background:"var(--ink-50)",border:"1px solid var(--ink-200)",borderRadius:12}}>
        {/* header */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:24,flexWrap:"wrap",gap:14}}>
          <div>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
              <I.Logo size={26}/>
              <span style={{fontSize:18,fontWeight:600}}>{clinicName}</span>
            </div>
            <div className="muted" style={{fontSize:12,lineHeight:1.5}}>
              {clinic.address && <>{clinic.address}<br/></>}
              {clinic.tax_id && <>الرقم الضريبي {clinic.tax_id}<br/></>}
              {clinic.email || ""}
            </div>
          </div>
          <div style={{textAlign:"right"}}>
            <div className="serif" style={{fontSize:30,lineHeight:1}}>فاتورة</div>
            <div className="mono" style={{marginTop:4,fontSize:13}}>{invoice.id}</div>
            <div className="muted" style={{fontSize:12,marginTop:6}}>صدرت في {invoice.date}</div>
            <PayBadge s={invoice.status}/>
          </div>
        </div>

        {/* bill to */}
        <div className="rgrid c-sm" style={{"--gtc":"1fr 1fr",marginBottom:24}}>
          <div>
            <div className="muted" style={{fontSize:11,textTransform:"uppercase",letterSpacing:".05em",marginBottom:4}}>فاتورة لـ</div>
            <div style={{fontWeight:600}}>{invoice.patient}</div>
            {(() => {
              const row = DATA.patients.find(p => p.name === invoice.patient || (p.patient_id||p.id) === invoice.patient_id) || {};
              return <div className="muted" style={{fontSize:12,lineHeight:1.5,marginTop:2}}>ملف {row.patient_id || row.id || "—"}<br/>{row.address || ""}{row.address ? <br/> : null}{row.phone || ""}</div>;
            })()}
          </div>
          <div>
            <div className="muted" style={{fontSize:11,textTransform:"uppercase",letterSpacing:".05em",marginBottom:4}}>فريق الرعاية</div>
            {(() => {
              const row = DATA.patients.find(p => p.name === invoice.patient || (p.patient_id||p.id) === invoice.patient_id) || {};
              return <>
                <div style={{fontSize:13}}>{row.dr && row.dr !== "—" ? row.dr : "—"}</div>
                <div className="muted" style={{fontSize:12}}>{row.th && row.th !== "—" ? row.th : ""}</div>
              </>;
            })()}
          </div>
        </div>

        {/* line items */}
        <div className="tbl-scroll" style={{background:"#fff",borderRadius:10,border:"1px solid var(--ink-200)",marginBottom:16}}>
          <table className="tbl" style={{fontSize:12.5,minWidth:420}}>
            <thead><tr><th>البند</th><th style={{textAlign:"right"}}>الكمية</th><th style={{textAlign:"right"}}>السعر</th><th style={{textAlign:"right"}}>الإجمالي</th></tr></thead>
            <tbody>
              <tr><td>{invoice.desc || "خدمات علاجية"}</td><td style={{textAlign:"right"}}>1</td><td style={{textAlign:"right"}} className="mono">{(invoice.amount||0).toLocaleString()}</td><td style={{textAlign:"right"}} className="mono">{(invoice.amount||0).toLocaleString()}</td></tr>
            </tbody>
          </table>
        </div>

        <div style={{display:"flex",justifyContent:"flex-end"}}>
          <div style={{minWidth:240}}>
            <div style={{display:"flex",justifyContent:"space-between",padding:"4px 0",fontSize:12.5}}><span className="muted">المجموع الفرعي</span><span className="mono">EGP {(invoice.amount||0).toLocaleString()}</span></div>
            <div style={{display:"flex",justifyContent:"space-between",padding:"4px 0",fontSize:12.5}}><span className="muted">ض.ق.م (14%)</span><span className="mono">EGP 0.00</span></div>
            <div style={{display:"flex",justifyContent:"space-between",padding:"10px 0",borderTop:"1px solid var(--ink-200)",marginTop:6}}><span style={{fontWeight:600}}>الإجمالي</span><span className="mono" style={{fontWeight:600,fontSize:16}}>EGP {invoice.amount.toLocaleString()}</span></div>
            <div style={{display:"flex",justifyContent:"space-between",padding:"4px 0",fontSize:12.5}}><span className="muted">مدفوعة عبر {invoice.method}</span><span className="mono">EGP {invoice.paid.toLocaleString()}</span></div>
            <div style={{display:"flex",justifyContent:"space-between",padding:"4px 0",fontSize:12.5,color: invoice.amount-invoice.paid>0?"var(--amber)":"var(--green)"}}><span>الرصيد المستحق</span><span className="mono" style={{fontWeight:600}}>EGP {(invoice.amount-invoice.paid).toLocaleString()}</span></div>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function NewInvoiceModal({ onClose }) {
  const patients = React.useMemo(
    () => (window.scopePatients ? window.scopePatients(DATA.patients) : DATA.patients) || [],
    [DATA.patients]
  );
  const today = new Date().toISOString().slice(0,10);
  const dueDefault = new Date(Date.now() + 14*86400000).toISOString().slice(0,10);
  const [items, setItems] = React.useState([{ name:"", qty:1, price:0 }]);
  const [patientId, setPatientId] = React.useState(patients[0] ? (patients[0].patient_id || patients[0].id) : "");
  const [date, setDate] = React.useState(today);
  const [due, setDue] = React.useState(dueDefault);
  const [method, setMethod] = React.useState("نقدي");
  const subtotal = items.reduce((s,i)=>s+i.qty*i.price,0);

  async function create() {
    if (!patientId) { if (window.showToast) window.showToast("اختر مريضًا", "error"); return; }
    if (subtotal <= 0) { if (window.showToast) window.showToast("أضف بندًا واحدًا على الأقل", "error"); return; }
    try {
      const invoiceId = "INV-" + Date.now();
      const row = {
        invoice_id: invoiceId,
        id: invoiceId,
        patient_id: patientId,
        amount: subtotal,
        paid: 0,
        payment_method: method,
        method,
        status: "معلّق",
        date,
        due,
      };
      if (window.KineticData) await window.KineticData.upsert("payments", row);
      if (window.showToast) window.showToast("تم إنشاء الفاتورة", "success");
      onClose();
    } catch (e) {
      console.warn("create invoice failed", e);
      if (window.showToast) window.showToast("تعذّر إنشاء الفاتورة", "error");
    }
  }

  return (
    <Modal open onClose={onClose} title="فاتورة جديدة" width={720}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose}>إلغاء</button>
        <button className="btn btn-secondary" onClick={()=>{ if (window.showToast) window.showToast("تم حفظ المسودة","success"); onClose(); }}>حفظ المسودة</button>
        <button className="btn btn-blue" onClick={create}><I.Check size={13}/> إنشاء الفاتورة</button>
      </>}>
      <div className="rgrid c-sm" style={{"--gtc":"1fr 1fr",gap:14,marginBottom:14}}>
        <Field label="مريض" required>
          <PatientCombobox
            value={patientId}
            onChange={setPatientId}
            patients={patients}
            placeholder={patients.length === 0 ? "لا يوجد مرضى" : "ابحث عن مريض بالاسم أو الرقم…"}
            disabled={patients.length === 0}
          />
        </Field>
        <Field label="التاريخ"><input className="input" type="date" value={date} onChange={e=>setDate(e.target.value)}/></Field>
        <Field label="تاريخ الاستحقاق"><input className="input" type="date" value={due} onChange={e=>setDue(e.target.value)}/></Field>
        <Field label="الدفع method">
          <select className="input" value={method} onChange={e=>setMethod(e.target.value)}>
            <option>نقدي</option><option>فيزا</option><option>إنستاباي</option><option>فودافون كاش</option><option>تحويل بنكي</option>
          </select>
        </Field>
      </div>

      <div className="label">بنود الفاتورة</div>
      <div className="card" style={{padding:0,boxShadow:"none",marginBottom:10}}>
        {items.map((it,i)=>(
          <div key={i} className="rgrid inv-item-row" style={{padding:10,"--gtc":"1fr 80px 100px 100px 28px",gap:10,alignItems:"center",borderBottom:i<items.length-1?"1px solid var(--ink-100)":"none"}}>
            <input className="input" value={it.name} onChange={e=>setItems(items.map((x,j)=>j===i?{...x,name:e.target.value}:x))}/>
            <input className="input" type="number" value={it.qty} onChange={e=>setItems(items.map((x,j)=>j===i?{...x,qty:+e.target.value}:x))}/>
            <input className="input mono" type="number" value={it.price} onChange={e=>setItems(items.map((x,j)=>j===i?{...x,price:+e.target.value}:x))}/>
            <span className="mono" style={{textAlign:"right",fontWeight:600}}>EGP {(it.qty*it.price).toLocaleString()}</span>
            <button className="btn btn-ghost btn-icon" onClick={()=>setItems(items.filter((_,j)=>j!==i))}><I.X size={13}/></button>
          </div>
        ))}
      </div>
      <button className="btn btn-secondary" onClick={()=>setItems([...items,{name:"",qty:1,price:0}])} style={{fontSize:12}}><I.Plus size={12}/> إضافة بند</button>

      <div style={{display:"flex",justifyContent:"flex-end",marginTop:18}}>
        <div style={{minWidth:240,padding:14,background:"var(--ink-50)",borderRadius:10}}>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:13,marginBottom:4}}><span className="muted">المجموع الفرعي</span><span className="mono">EGP {subtotal.toLocaleString()}</span></div>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:13,marginBottom:4}}><span className="muted">ض.ق.م (14%)</span><span className="mono">EGP 0</span></div>
          <hr className="sep" style={{margin:"8px 0"}}/>
          <div style={{display:"flex",justifyContent:"space-between"}}><span style={{fontWeight:600}}>الإجمالي</span><span className="mono" style={{fontWeight:600,fontSize:18}}>EGP {subtotal.toLocaleString()}</span></div>
        </div>
      </div>
    </Modal>
  );
}

// ───────────── Packages ─────────────
function Packages({ go }) {
  const [editing, setEditing] = React.useState(null);
  const toggleActive = async (p) => {
    const next = { ...p, active: !p.active };
    try { await window.KineticData.upsert("packages", next); }
    catch (e) { console.warn("toggle package failed", e); }
    if (window.showToast) window.showToast(next.active ? `تم تفعيل ${p.name}` : `تم إيقاف ${p.name}`, "success");
  };
  return (
    <Page>
      <div className="page-head">
        <div>
          <div className="crumb"><span>الرئيسية</span><I.Chevron size={11}/><span>الباقات</span></div>
          <div className="h1">باقات العلاج</div>
          <div className="muted" style={{fontSize:13.5,marginTop:4}}>{DATA.packages.filter(p=>p.active).length} نشط باقة</div>
        </div>
        <button className="btn btn-blue" onClick={()=>setEditing({mode:"new"})}><I.Plus size={14}/> باقة جديدة</button>
      </div>

      <div className="grid-3">
        {DATA.packages.map(p=>(
          <div key={p.id} className="card" style={{padding:0,overflow:"hidden",opacity:p.active?1:.6,position:"relative"}}>
            <div style={{height:90,background:`linear-gradient(135deg, ${p.color}, ${p.color}99)`,position:"relative",padding:18}}>
              {p.popular && <span style={{position:"absolute",top:14,right:14,background:"#fff",color:p.color,padding:"3px 10px",borderRadius:999,fontSize:11,fontWeight:600,boxShadow:"var(--shadow-sm)"}}>الأكثر طلبًا</span>}
              <div className="mono" style={{color:"#fff",opacity:.8,fontSize:10.5,letterSpacing:".06em",textTransform:"uppercase"}}>{p.id}</div>
              <div style={{color:"#fff",fontWeight:600,fontSize:18,marginTop:4,letterSpacing:"-.005em"}}>{p.name}</div>
            </div>
            <div style={{padding:18}}>
              <div style={{display:"flex",alignItems:"baseline",gap:6,marginBottom:12}}>
                <span className="mono" style={{fontSize:30,fontWeight:600,letterSpacing:"-.01em"}}>EGP {p.price.toLocaleString()}</span>
                <span className="muted" style={{fontSize:12}}>/ للباقة</span>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:14}}>
                <div style={{display:"flex",alignItems:"center",gap:8,fontSize:12.5}}><I.Check size={13} style={{color:p.color}}/> {p.sessions} جلسة{p.sessions>1?"s":""} متضمنة</div>
                <div style={{display:"flex",alignItems:"center",gap:8,fontSize:12.5}}><I.Check size={13} style={{color:p.color}}/> تقييم أولي مجاني</div>
                <div style={{display:"flex",alignItems:"center",gap:8,fontSize:12.5}}><I.Check size={13} style={{color:p.color}}/> صالحة لمدة 90 يوم</div>
                {p.sessions>=10 && <div style={{display:"flex",alignItems:"center",gap:8,fontSize:12.5}}><I.Check size={13} style={{color:p.color}}/> التقدّم reports متضمنة</div>}
              </div>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",fontSize:12,marginBottom:14}}>
                <span className="muted">مبيعة هذا الشهر</span>
                <span className="mono" style={{fontWeight:600}}>{p.sold}</span>
              </div>
              <div style={{display:"flex",gap:6}}>
                <button className="btn btn-secondary" style={{flex:1,justifyContent:"center"}} onClick={()=>setEditing(p)}><I.Edit size={12}/> تعديل</button>
                <RowMenu size={14} items={[
                  { label:"تعديل الباقة", icon:<I.Edit size={13}/>, onClick:()=>setEditing(p) },
                  { label:p.active?"إيقاف الباقة":"تفعيل الباقة", icon:<I.Check size={13}/>, onClick:()=>toggleActive(p) },
                  { label:"مضاعفة", icon:<I.Plus size={13}/>, onClick:async()=>{
                    const clone = { ...p, id: (p.id||"PK-")+"-Copy-"+Math.random().toString(36).slice(2,6), name:p.name+" — نسخة", sold:0 };
                    try { await window.KineticData.upsert("packages", clone); }
                    catch (e) { console.warn("clone package failed", e); }
                    if (window.showToast) window.showToast(`تم نسخ ${p.name}`,"success");
                  }},
                  { label:"حذف الباقة", icon:<I.X size={13}/>, danger:true, onClick:async()=>{
                    if (!window.confirm(`حذف ${p.name}؟`)) return;
                    try { await window.KineticData.remove("packages", p.id); }
                    catch (e) { console.warn("delete package failed", e); }
                    if (window.showToast) window.showToast(`تم حذف ${p.name}`,"success");
                  }},
                ]}/>
                <button onClick={()=>toggleActive(p)} className={`switch ${p.active?"on":""}`} style={{marginLeft:"auto",border:"none",padding:0,background:"transparent",cursor:"pointer"}} title={p.active?"إيقاف الباقة":"تفعيل الباقة"}>
                  <div className="knob"></div>
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <Modal open onClose={()=>setEditing(null)} title={editing.mode==="new"?"باقة جديدة":`تعديل ${editing.name}`}
          footer={<>
            <button className="btn btn-secondary" onClick={()=>setEditing(null)}>إلغاء</button>
            <button className="btn btn-blue" onClick={()=>setEditing(null)}><I.Check size={13}/> حفظ الباقة</button>
          </>}>
          <div className="rgrid c-sm" style={{"--gtc":"repeat(2,1fr)",gap:14}}>
            <Field label="الاسم" required span={2}><input className="input" defaultValue={editing.name||""} placeholder="مثال: الباقة الأساسية 10"/></Field>
            <Field label="الجلسات"><input className="input" type="number" defaultValue={editing.sessions||""}/></Field>
            <Field label="السعر (ج.م)"><input className="input" type="number" defaultValue={editing.price||""}/></Field>
            <Field label="اللون"><input className="input" type="color" defaultValue={editing.color||"#7BBDE8"}/></Field>
            <Field label="الصلاحية (أيام)"><input className="input" type="number" defaultValue="90"/></Field>
            <Field label="الوصف" span={2}><textarea className="input" style={{height:70,padding:10}} placeholder="ملاحظات داخلية"/></Field>
          </div>
        </Modal>
      )}
    </Page>
  );
}

// ══════════════════════════════════════════════════════════════
// Quick Payment (دفع سريع) — single-modal cash flow
// ══════════════════════════════════════════════════════════════
// Search → financial overview → selection with per-item amount →
// method → confirmation → transactional write → printable receipt.
// Everything reads from Supabase (fallback: local mirror in demo/offline
// mode). No fixture values are ever displayed as real.

const QP_METHODS = [
  { id: "cash",           label: "نقدي",         icon: "Dollar" },
  { id: "visa",           label: "فيزا",         icon: "CreditCard" },
  { id: "instapay",       label: "إنستاباي",     icon: "Phone" },
  { id: "vodafone_cash",  label: "فودافون كاش",  icon: "Phone" },
  { id: "bank_transfer",  label: "تحويل بنكي",   icon: "Layers" },
];

// PRD Section 6 — reference numbers appear on card/wallet/transfer payments.
const QP_REF_METHODS = new Set(["visa", "instapay", "vodafone_cash", "bank_transfer"]);

function qpMethodLabel(id) {
  const m = QP_METHODS.find(x => x.id === id);
  return m ? m.label : id;
}

// Selection key so appointments/invoices/subscriptions with the same
// underlying id never collide in the picks map.
function qpSelKey(type, id) { return `${type}:${id}`; }

function QuickPaymentModal({ onClose, onDone }) {
  // ── Search state ──────────────────────────────────────────
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState([]);
  const [searching, setSearching] = React.useState(false);

  // ── Selected patient + their financials ───────────────────
  const [patient, setPatient] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [fin, setFin] = React.useState({ appointments: [], invoices: [], subscriptions: [] });

  // ── Per-item allocations ──────────────────────────────────
  // picks[key] = { type, id, amount, max, label }
  const [picks, setPicks] = React.useState({});

  // ── Payment details ───────────────────────────────────────
  const [method, setMethod] = React.useState("");
  const [reference, setReference] = React.useState("");
  const [txId, setTxId] = React.useState("");
  const [notes, setNotes] = React.useState("");

  // ── Flow control ──────────────────────────────────────────
  const [confirming, setConfirming] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [receipt, setReceipt] = React.useState(null); // set on success
  const [error, setError] = React.useState("");

  // Debounced search — keystroke-driven, but only hits the store after
  // a short pause so a fast typist doesn't flicker the results list.
  React.useEffect(() => {
    if (patient) return; // search hidden once a patient is chosen
    if (!query.trim()) { setResults([]); return; }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const r = await (window.QuickPay && window.QuickPay.searchPatients(query));
        if (!cancelled) setResults(r || []);
      } finally { if (!cancelled) setSearching(false); }
    }, 180);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, patient]);

  async function pickPatient(p) {
    setPatient(p);
    setResults([]);
    setLoading(true);
    setError("");
    try {
      const f = await window.QuickPay.loadFinancials(p.patient_id || p.id);
      setFin(f);
    } catch (e) {
      console.warn("load financials failed", e);
      setError("تعذّر تحميل البيانات المالية");
    } finally { setLoading(false); }
  }

  function clearPatient() {
    setPatient(null);
    setFin({ appointments: [], invoices: [], subscriptions: [] });
    setPicks({});
    setError("");
  }

  function toggle(type, row, defaultAmount, label) {
    const key = qpSelKey(type, row);
    setPicks(prev => {
      const next = { ...prev };
      if (next[key]) {
        delete next[key];
      } else {
        const max = Number(defaultAmount) || 0;
        next[key] = { type, id: row, amount: max, max, label };
      }
      return next;
    });
  }

  function setAmount(key, raw) {
    setPicks(prev => {
      const cur = prev[key]; if (!cur) return prev;
      // Allow the user to clear the field temporarily.
      const num = raw === "" ? "" : Math.max(0, Number(raw) || 0);
      return { ...prev, [key]: { ...cur, amount: num } };
    });
  }

  // ── Derived: totals + validation ──────────────────────────
  const selected = Object.values(picks);
  const total = selected.reduce((s, a) => s + (Number(a.amount) || 0), 0);
  const hasOverpay = selected.some(a => (Number(a.amount) || 0) > a.max + 0.001);
  const hasZero    = selected.some(a => !(Number(a.amount) > 0));
  const readyToConfirm = patient && selected.length > 0 && method && !hasOverpay && !hasZero;

  const anyFinancialItems =
    fin.appointments.length + fin.invoices.length + fin.subscriptions.length > 0;

  // ── Submit ────────────────────────────────────────────────
  async function confirmPayment() {
    if (!readyToConfirm) return;
    if (QP_REF_METHODS.has(method) && !reference.trim() && !txId.trim()) {
      // Reference isn't strictly required by the schema, but the receptionist
      // is asking for card/wallet — flag missing reference as a soft prompt.
      if (!window.confirm("لم يُدخل رقم مرجعي — هل تريد المتابعة؟")) return;
    }
    setSaving(true);
    setError("");
    try {
      const allocations = selected.map(a => ({
        type: a.type, id: a.id, amount: Number(a.amount),
      }));
      const res = await window.QuickPay.recordPayment({
        patient_id: patient.patient_id || patient.id,
        method,
        reference: reference.trim(),
        transaction_id: txId.trim(),
        notes: notes.trim(),
        allocations,
      });
      if (!res.ok) { setError(res.error || "تعذّر تسجيل الدفع"); setSaving(false); return; }
      // Snapshot everything needed for the receipt BEFORE state resets.
      setReceipt({
        payment_id: res.payment_id,
        receipt_no: res.receipt_no,
        amount: res.amount,
        method,
        reference: reference.trim(),
        transaction_id: txId.trim(),
        notes: notes.trim(),
        allocations: selected.map(a => ({ ...a })),
        patient: {
          id: patient.patient_id || patient.id,
          name: patient.name,
          phone: patient.phone,
        },
        cashier: (window.ME && window.ME.name) || "—",
        date: new Date().toISOString(),
      });
      if (window.showToast) window.showToast(`تم تسجيل الدفع (${res.receipt_no})`, "success");
    } catch (e) {
      console.warn("quick payment failed", e);
      setError(e.message || "تعذّر تسجيل الدفع");
    } finally { setSaving(false); }
  }

  // ── Receipt view: paint over the whole modal on success ───
  if (receipt) {
    return (
      <QuickPaymentReceipt
        r={receipt}
        onClose={() => { onClose && onClose(); if (onDone) onDone(); }}
      />
    );
  }

  // ── Confirmation overlay ──────────────────────────────────
  if (confirming) {
    return (
      <Modal open onClose={() => setConfirming(false)} title="تأكيد الدفع" width={520}
        footer={<>
          <button className="btn btn-ghost" onClick={() => setConfirming(false)} disabled={saving}>رجوع</button>
          <button className="btn btn-blue" disabled={saving || !readyToConfirm} onClick={confirmPayment}>
            {saving ? <span className="spin" style={{width:14,height:14,border:"2px solid #fff",borderTopColor:"transparent",borderRadius:"50%"}}/>
                    : <><I.Check size={13}/> تأكيد الدفع</>}
          </button>
        </>}>
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          <QpSummaryRow label="المريض" value={patient.name} sub={patient.patient_id || patient.id}/>
          <div className="card" style={{padding:12,background:"var(--ink-50)"}}>
            <div className="muted" style={{fontSize:11,marginBottom:6,letterSpacing:".05em",textTransform:"uppercase"}}>العناصر المحددة</div>
            {selected.map(a => (
              <div key={qpSelKey(a.type, a.id)} style={{display:"flex",justifyContent:"space-between",fontSize:12.5,padding:"4px 0"}}>
                <span>{a.label}</span>
                <span className="mono">EGP {Number(a.amount).toLocaleString()}</span>
              </div>
            ))}
          </div>
          <QpSummaryRow label="طريقة الدفع" value={qpMethodLabel(method)}/>
          {(reference || txId) && (
            <QpSummaryRow label="رقم مرجعي" value={reference || txId}/>
          )}
          <div style={{display:"flex",justifyContent:"space-between",padding:"10px 12px",background:"var(--blue-50)",border:"1px solid var(--blue-100)",borderRadius:10}}>
            <span style={{fontWeight:600}}>الإجمالي</span>
            <span className="mono" style={{fontWeight:700,fontSize:16,color:"var(--blue-900)"}}>EGP {total.toLocaleString()}</span>
          </div>
          {error && <div style={{fontSize:12,color:"var(--red)"}}>{error}</div>}
        </div>
      </Modal>
    );
  }

  // ── Main modal ────────────────────────────────────────────
  return (
    <Modal open onClose={onClose} title="دفع سريع" width={760}
      footer={<>
        <button className="btn btn-ghost" onClick={onClose}>إلغاء</button>
        {patient && (
          <button className="btn btn-secondary" onClick={clearPatient}>مريض آخر</button>
        )}
        <button className="btn btn-blue" disabled={!readyToConfirm} onClick={() => setConfirming(true)}>
          <I.ArrowLeft size={13}/> مراجعة الدفع (EGP {total.toLocaleString()})
        </button>
      </>}>
      {!patient && (
        <QpPatientSearch
          query={query} setQuery={setQuery}
          results={results} searching={searching}
          onPick={pickPatient}
        />
      )}
      {patient && (
        <div style={{display:"flex",flexDirection:"column",gap:16}}>
          <QpPatientChip patient={patient} onClear={clearPatient}/>
          {loading && (
            <div className="muted" style={{padding:"24px 0",textAlign:"center",fontSize:13}}>
              <span className="spin" style={{display:"inline-block",width:16,height:16,border:"2px solid var(--ink-200)",borderTopColor:"var(--blue-500)",borderRadius:"50%",marginInlineEnd:8,verticalAlign:"middle"}}/>
              جارٍ تحميل الرصيد المالي…
            </div>
          )}
          {!loading && !anyFinancialItems && (
            <EmptyState icon={<I.Check size={22}/>} title="لا مستحقات على المريض"
              body="لا مواعيد أو فواتير أو اشتراكات بها رصيد متبقٍ."/>
          )}
          {!loading && anyFinancialItems && (
            <>
              <QpItemsSection
                title="مواعيد غير مدفوعة" icon={<I.Calendar size={14}/>}
                items={fin.appointments.map(a => ({
                  key: a.booking_id || a.id,
                  primary: `${a.type || "جلسة"} — ${a.date || "—"} ${a.time || ""}`.trim(),
                  secondary: `${a.dr || a.doctor_name || ""} ${a.th ? "· " + a.th : ""}`.trim() || "موعد",
                  remaining: a.remaining, badge: "b-amber",
                }))}
                type="appointment" picks={picks} toggle={toggle} setAmount={setAmount}
              />
              <QpItemsSection
                title="فواتير غير مدفوعة" icon={<I.FileText size={14}/>}
                items={fin.invoices.map(v => ({
                  key: v.invoice_id || v.id,
                  primary: `فاتورة ${v.invoice_id || v.id}`,
                  secondary: `إجمالي EGP ${Number(v.amount||0).toLocaleString()} · مدفوع EGP ${Number(v.paid||0).toLocaleString()}`,
                  remaining: v.remaining, badge: "b-blue",
                }))}
                type="invoice" picks={picks} toggle={toggle} setAmount={setAmount}
              />
              <QpItemsSection
                title="اشتراكات وباقات" icon={<I.Package size={14}/>}
                items={fin.subscriptions.map(s => {
                  const remainingSessions = Math.max(0, (s.total_sessions||0) - (s.used_sessions||0));
                  return {
                    key: s.subscription_id || s.id,
                    primary: s.package_name || "باقة",
                    secondary: `${s.used_sessions||0}/${s.total_sessions||0} جلسات · متبقٍ ${remainingSessions}` +
                               (s.expires_at ? ` · تنتهي ${s.expires_at}` : ""),
                    remaining: s.remaining, badge: "b-violet",
                    disabled: s.remaining <= 0,
                  };
                })}
                type="subscription" picks={picks} toggle={toggle} setAmount={setAmount}
              />

              <QpPaymentDetails
                method={method} setMethod={setMethod}
                reference={reference} setReference={setReference}
                txId={txId} setTxId={setTxId}
                notes={notes} setNotes={setNotes}
              />

              <div style={{
                display:"flex",alignItems:"center",justifyContent:"space-between",
                padding:"12px 14px",background:"var(--blue-50)",
                border:"1px solid var(--blue-100)",borderRadius:12
              }}>
                <div>
                  <div className="muted" style={{fontSize:11.5,letterSpacing:".05em",textTransform:"uppercase"}}>الإجمالي المستحق</div>
                  <div className="mono" style={{fontSize:22,fontWeight:700,color:"var(--blue-900)"}}>EGP {total.toLocaleString()}</div>
                </div>
                <div style={{textAlign:"right",fontSize:12,color:"var(--ink-500)"}}>
                  {selected.length} عنصر محدد
                  {hasOverpay && <div style={{color:"var(--red)",marginTop:4}}>مبلغ يتجاوز المتبقي</div>}
                  {!hasOverpay && hasZero && <div style={{color:"var(--red)",marginTop:4}}>أدخل مبلغًا أكبر من صفر</div>}
                </div>
              </div>

              {error && <div style={{fontSize:12,color:"var(--red)"}}>{error}</div>}
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

// ── Patient search UI ────────────────────────────────────────
function QpPatientSearch({ query, setQuery, results, searching, onPick }) {
  return (
    <div>
      <div className="muted" style={{fontSize:12.5,marginBottom:10,padding:"10px 12px",background:"var(--blue-50)",border:"1px solid var(--blue-100)",borderRadius:8}}>
        ابحث عن المريض بالاسم، رقم الهاتف، أو رقم الملف — ثم اختره لعرض المستحقات.
      </div>
      <div style={{position:"relative",marginBottom:12}}>
        <I.Search size={15} style={{position:"absolute",insetInlineStart:12,top:"50%",transform:"translateY(-50%)",color:"var(--ink-400)"}}/>
        <input className="input"
          style={{paddingInlineStart:34, height:44, fontSize:14}}
          placeholder="مثال: هناء، +20100…، P-10241"
          value={query} onChange={e => setQuery(e.target.value)} autoFocus/>
        {searching && (
          <span className="spin" style={{position:"absolute",insetInlineEnd:12,top:"50%",transform:"translateY(-50%)",width:14,height:14,border:"2px solid var(--ink-200)",borderTopColor:"var(--blue-500)",borderRadius:"50%"}}/>
        )}
      </div>
      {query.trim() && !searching && results.length === 0 && (
        <div className="muted" style={{textAlign:"center",padding:"32px 12px",fontSize:13}}>
          لا نتائج مطابقة.
        </div>
      )}
      {results.length > 0 && (
        <div style={{display:"flex",flexDirection:"column",gap:6,maxHeight:340,overflowY:"auto"}}>
          {results.map(p => (
            <button key={p.patient_id || p.id} type="button" onClick={() => onPick(p)}
              style={{
                display:"flex",alignItems:"center",gap:12,textAlign:"start",
                padding:"10px 12px",border:"1px solid var(--ink-200)",borderRadius:12,
                background:"#fff",cursor:"pointer",font:"inherit",
              }}>
              <div className="av md">{(p.name||"?").split(" ").map(x=>x[0]).join("").slice(0,2)}</div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:13.5,fontWeight:600}}>{p.name}</div>
                <div className="muted" style={{fontSize:11.5}}>
                  {p.phone || "—"} · <span className="mono">{p.patient_id || p.id}</span>
                </div>
              </div>
              <I.ArrowLeft size={14} style={{color:"var(--ink-400)"}}/>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Selected patient chip ────────────────────────────────────
function QpPatientChip({ patient, onClear }) {
  return (
    <div style={{
      display:"flex",alignItems:"center",gap:12,padding:"10px 12px",
      background:"var(--ink-50)",border:"1px solid var(--ink-200)",borderRadius:12
    }}>
      <div className="av md">{(patient.name||"?").split(" ").map(x=>x[0]).join("").slice(0,2)}</div>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontSize:13.5,fontWeight:600}}>{patient.name}</div>
        <div className="muted" style={{fontSize:11.5}}>
          {patient.phone || "—"} · <span className="mono">{patient.patient_id || patient.id}</span>
        </div>
      </div>
      <button className="btn btn-ghost" style={{fontSize:12}} onClick={onClear}>تغيير</button>
    </div>
  );
}

// ── One financial category (appts / invoices / subs) ─────────
function QpItemsSection({ title, icon, items, type, picks, toggle, setAmount }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="card" style={{padding:12}}>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
        {icon}
        <div className="h3">{title}</div>
        <span className="badge b-grey" style={{marginInlineStart:"auto"}}>{items.length}</span>
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:8}}>
        {items.map(it => {
          const key = qpSelKey(type, it.key);
          const on = !!picks[key];
          return (
            <div key={key} style={{
              display:"flex",alignItems:"center",gap:10,padding:"10px 12px",
              border:"1px solid " + (on ? "var(--blue-500)" : "var(--ink-200)"),
              borderRadius:10, background: on ? "var(--blue-50)" : "#fff",
              opacity: it.disabled ? 0.55 : 1,
            }}>
              <input type="checkbox" checked={on} disabled={it.disabled}
                onChange={() => toggle(type, it.key, it.remaining, it.primary)}
                style={{width:16,height:16,cursor: it.disabled ? "not-allowed":"pointer"}}/>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:13,fontWeight:500}}>{it.primary}</div>
                <div className="muted" style={{fontSize:11.5}}>{it.secondary}</div>
              </div>
              {on ? (
                <div style={{display:"flex",alignItems:"center",gap:6}}>
                  <span className="muted" style={{fontSize:11}}>مبلغ الدفع</span>
                  <input className="input mono"
                    style={{width:120,textAlign:"end"}}
                    type="number" min="0" step="1" max={it.remaining}
                    value={picks[key].amount === "" ? "" : picks[key].amount}
                    onChange={e => setAmount(key, e.target.value)}/>
                  <span className={"badge " + (it.badge || "b-grey")}>
                    من {Number(it.remaining||0).toLocaleString()}
                  </span>
                </div>
              ) : (
                <div className="mono" style={{fontSize:13,fontWeight:600,minWidth:110,textAlign:"end"}}>
                  EGP {Number(it.remaining||0).toLocaleString()}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Method + reference/notes ─────────────────────────────────
function QpPaymentDetails({ method, setMethod, reference, setReference, txId, setTxId, notes, setNotes }) {
  return (
    <div className="card" style={{padding:12}}>
      <div className="h3" style={{marginBottom:10}}>طريقة الدفع</div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:8,marginBottom:12}}>
        {QP_METHODS.map(m => {
          const Ic = (window.I && window.I[m.icon]) || window.I.Dollar;
          const on = method === m.id;
          return (
            <button key={m.id} type="button" onClick={() => setMethod(m.id)}
              style={{
                display:"flex",alignItems:"center",gap:8,padding:"10px 12px",
                border:"1px solid " + (on ? "var(--blue-500)" : "var(--ink-200)"),
                background: on ? "var(--blue-50)" : "#fff",
                borderRadius:10, cursor:"pointer", font:"inherit",
                textAlign:"start", color: on ? "var(--blue-900)" : "var(--ink-900)",
              }}>
              <Ic size={14}/> <span style={{fontSize:13, fontWeight:500}}>{m.label}</span>
            </button>
          );
        })}
      </div>
      {QP_REF_METHODS.has(method) && (
        <div className="rgrid c-sm" style={{"--gtc":"1fr 1fr",gap:10,marginBottom:8}}>
          <Field label="رقم مرجعي (اختياري)">
            <input className="input" value={reference} onChange={e => setReference(e.target.value)}
              placeholder="آخر 4 أرقام / رقم العملية"/>
          </Field>
          <Field label="رقم المعاملة (اختياري)">
            <input className="input" value={txId} onChange={e => setTxId(e.target.value)}
              placeholder="Transaction ID"/>
          </Field>
        </div>
      )}
      <Field label="ملاحظات (اختياري)">
        <textarea className="input" rows={2}
          style={{padding:10, resize:"vertical"}}
          value={notes} onChange={e => setNotes(e.target.value)}
          placeholder="أي تفاصيل تخص عملية الدفع…"/>
      </Field>
    </div>
  );
}

function QpSummaryRow({ label, value, sub }) {
  return (
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",fontSize:13}}>
      <div className="muted" style={{fontSize:12}}>{label}</div>
      <div style={{textAlign:"end",maxWidth:"60%"}}>
        <div style={{fontWeight:600}}>{value}</div>
        {sub && <div className="mono muted" style={{fontSize:11}}>{sub}</div>}
      </div>
    </div>
  );
}

// ── Receipt (post-success) ───────────────────────────────────
function QuickPaymentReceipt({ r, onClose }) {
  const clinic = window.CLINIC || {};
  const clinicName = clinic.name || "العيادة";
  const dateStr = new Date(r.date).toLocaleString("ar-EG");

  function printReceipt() {
    const esc = window.escHtml || (x => String(x||""));
    const rows = r.allocations.map(a => `
      <tr>
        <td>${esc(a.label || a.type + " " + a.id)}</td>
        <td style="text-align:end" class="mono">EGP ${Number(a.amount||0).toLocaleString()}</td>
      </tr>`).join("");
    const body = `
      <div style="border:1px solid #EEF2F6;border-radius:10px;padding:18px 20px;margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
          <div>
            <div style="font-size:18px;font-weight:600">${esc(clinicName)}</div>
            <div style="color:#647686;font-size:11.5px;margin-top:4px">${esc(clinic.address || "")}</div>
          </div>
          <div style="text-align:end">
            <div style="font-size:22px" class="serif">إيصال دفع</div>
            <div class="mono" style="margin-top:4px;font-size:12.5px">${esc(r.receipt_no || "")}</div>
            <div style="color:#647686;font-size:11.5px;margin-top:4px">${esc(dateStr)}</div>
          </div>
        </div>
      </div>
      <table>
        <tbody>
          <tr><th>المريض</th><td>${esc(r.patient.name)} <span class="mono" style="color:#647686">${esc(r.patient.id)}</span></td></tr>
          <tr><th>الهاتف</th><td>${esc(r.patient.phone || "—")}</td></tr>
          <tr><th>طريقة الدفع</th><td>${esc(qpMethodLabel(r.method))}</td></tr>
          ${r.reference ? `<tr><th>رقم مرجعي</th><td class="mono">${esc(r.reference)}</td></tr>`:""}
          ${r.transaction_id ? `<tr><th>رقم المعاملة</th><td class="mono">${esc(r.transaction_id)}</td></tr>`:""}
          <tr><th>الكاشير</th><td>${esc(r.cashier)}</td></tr>
        </tbody>
      </table>
      <div style="height:14px"></div>
      <table>
        <thead><tr><th>البند</th><th style="text-align:end">المبلغ</th></tr></thead>
        <tbody>${rows}
          <tr><th style="border-top:2px solid #0F1E2B">الإجمالي المدفوع</th>
              <td style="border-top:2px solid #0F1E2B;text-align:end;font-weight:600" class="mono">EGP ${Number(r.amount||0).toLocaleString()}</td></tr>
        </tbody>
      </table>
      ${r.notes ? `<div style="margin-top:16px;font-size:12.5px;color:#647686"><strong>ملاحظات:</strong> ${esc(r.notes)}</div>` : ""}
    `;
    (window.printHTML || (()=>{}))(`إيصال ${r.receipt_no}`, body);
  }

  function downloadCsv() {
    const rows = [
      "البند,المبلغ",
      ...r.allocations.map(a => `"${(a.label||a.type+" "+a.id).replace(/"/g,'""')}",${Number(a.amount||0)}`),
      `"الإجمالي المدفوع",${Number(r.amount||0)}`,
    ];
    const blob = new Blob([rows.join("\n")], { type:"text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${r.receipt_no || "receipt"}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Modal open onClose={onClose} title={`إيصال ${r.receipt_no || ""}`} width={600}
      footer={<>
        <button className="btn btn-ghost" onClick={onClose}>إغلاق</button>
        <button className="btn btn-secondary" onClick={downloadCsv}><I.Download size={13}/> تحميل CSV</button>
        <button className="btn btn-blue" onClick={printReceipt}><I.Print size={13}/> طباعة / PDF</button>
      </>}>
      <div style={{display:"flex",flexDirection:"column",gap:14}}>
        <div style={{
          display:"flex",alignItems:"center",gap:10,padding:"12px 14px",
          background:"var(--green-bg)",border:"1px solid rgba(63,169,132,.35)",
          borderRadius:12,color:"#2C8067"
        }}>
          <I.Check size={16}/>
          <div>
            <div style={{fontWeight:600,fontSize:13.5}}>تمت العملية بنجاح</div>
            <div style={{fontSize:11.5}}>تم تحديث الرصيد والإيرادات وسجل المدفوعات.</div>
          </div>
        </div>
        <QpSummaryRow label="المريض" value={r.patient.name} sub={r.patient.id}/>
        <QpSummaryRow label="طريقة الدفع" value={qpMethodLabel(r.method)}/>
        {r.reference && <QpSummaryRow label="رقم مرجعي" value={r.reference}/>}
        {r.transaction_id && <QpSummaryRow label="رقم المعاملة" value={r.transaction_id}/>}
        <QpSummaryRow label="الكاشير" value={r.cashier}/>
        <div className="card" style={{padding:12,background:"var(--ink-50)"}}>
          <div className="muted" style={{fontSize:11,marginBottom:6,letterSpacing:".05em",textTransform:"uppercase"}}>العناصر المدفوعة</div>
          {r.allocations.map((a, i) => (
            <div key={i} style={{display:"flex",justifyContent:"space-between",fontSize:12.5,padding:"4px 0"}}>
              <span>{a.label || `${a.type} ${a.id}`}</span>
              <span className="mono">EGP {Number(a.amount||0).toLocaleString()}</span>
            </div>
          ))}
        </div>
        <div style={{display:"flex",justifyContent:"space-between",padding:"10px 12px",background:"var(--blue-50)",border:"1px solid var(--blue-100)",borderRadius:10}}>
          <span style={{fontWeight:600}}>المبلغ المدفوع</span>
          <span className="mono" style={{fontWeight:700,fontSize:16,color:"var(--blue-900)"}}>EGP {Number(r.amount||0).toLocaleString()}</span>
        </div>
      </div>
    </Modal>
  );
}

Object.assign(window, { QuickPaymentModal, QuickPaymentReceipt });

Object.assign(window, { Payments, Packages, NewInvoiceModal });


// ===== src/campaigns.jsx =====
// واتساب الحملة System

function Campaigns({ go }) {
  const [view, setView] = React.useState("list"); // list | builder | analytics
  const [selected, setSelected] = React.useState(null);
  const [templatesOpen, setTemplatesOpen] = React.useState(false);
  const [initialTemplate, setInitialTemplate] = React.useState(null);

  if (view === "builder") return <CampaignBuilder initialTemplate={initialTemplate} onCancel={()=>{setInitialTemplate(null);setView("list");}} onSave={()=>{
    if (window.showToast) window.showToast("تم إطلاق الحملة", "success");
    setInitialTemplate(null);
    setView("list");
  }}/>;
  if (view === "analytics" && selected) return <CampaignAnalytics c={selected} onBack={()=>setView("list")}/>;

  return (
    <Page>
      <div className="page-head">
        <div>
          <div className="crumb"><span>الرئيسية</span><I.Chevron size={11}/><span>حملات واتساب</span></div>
          <div className="h1">حملات واتساب</div>
          <div className="muted" style={{fontSize:13.5,marginTop:4}}>تواصل مع مرضاك عبر التذكيرات والمتابعات والإعلانات.</div>
        </div>
        <div className="page-actions">
          <button className="btn btn-secondary" onClick={()=>setTemplatesOpen(true)}><I.FileText size={14}/> القوالب</button>
          <button className="btn btn-blue" onClick={()=>setView("builder")}><I.Plus size={14}/> حملة جديدة</button>
        </div>
      </div>

      {(() => {
        // Real campaign KPIs aggregated from the campaigns table.
        const sent = DATA.campaigns.reduce((s,c)=>s+(c.sent||0),0);
        const read = DATA.campaigns.reduce((s,c)=>s+(c.read||0),0);
        const replied = DATA.campaigns.reduce((s,c)=>s+(c.replied||0),0);
        const pct = (a,b)=> b ? `${Math.round(a/b*1000)/10}%` : "—";
        return (
      <div className="grid-4" style={{marginBottom:18}}>
        <StatCard label="رسائل مُرسلة"   value={sent.toLocaleString()} accent="#25D366" icon={<I.WhatsApp size={15}/>}/>
        <StatCard label="معدل القراءة"             value={pct(read, sent)} accent="#7BBDE8" icon={<I.Eye size={15}/>}/>
        <StatCard label="معدل الرد"         value={pct(replied, sent)} accent="#7E6BD3" icon={<I.Send size={15}/>}/>
        <StatCard label="الحملات النشطة"       value={String(DATA.campaigns.filter(c=>c.status==="جارٍ"||c.status==="مجدول").length)} accent="#D8665A" icon={<I.Megaphone size={15}/>}/>
      </div>
        );
      })()}

      <div className="card" style={{overflow:"hidden"}}>
        <div style={{padding:"12px 18px",borderBottom:"1px solid var(--ink-200)",display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
          <div className="h3">الحملات</div>
          <div style={{flex:1}}/>
          <div className="seg">
            <button className="on">الكل</button>
            <button>جارٍ</button>
            <button>مجدول</button>
            <button>مكتمل</button>
          </div>
        </div>
        <div className="tbl-scroll">
        <table className="tbl">
          <thead><tr><th>الحملة</th><th>الجمهور</th><th>مُرسلة</th><th>مقروءة</th><th>ردّ</th><th>القالب</th><th>الجدولة</th><th>الحالة</th><th></th></tr></thead>
          <tbody>
            {DATA.campaigns.length===0 && (
              <tr><td colSpan={9}><EmptyState icon={<I.Megaphone size={22}/>} title="لا حملات بعد" body="أطلق أول حملة واتساب من زر «حملة جديدة»."/></td></tr>
            )}
            {DATA.campaigns.map(c=>(
              <tr key={c.id} data-clickable="true" tabIndex={0} onClick={()=>{setSelected(c);setView("analytics")}} onKeyDown={e=>{ if(e.key==="Enter"||e.key===" "){e.preventDefault();setSelected(c);setView("analytics");} }}>
                <td>
                  <div style={{display:"flex",alignItems:"center",gap:10}}>
                    <div style={{width:32,height:32,borderRadius:8,background:c.best?"linear-gradient(135deg,#25D366,#1FA351)":"var(--blue-100)",color:"#fff",display:"flex",alignItems:"center",justifyContent:"center"}}>
                      <I.WhatsApp size={15} style={{color: c.best?"#fff":"var(--blue-700)"}}/>
                    </div>
                    <div>
                      <div style={{fontWeight:600,display:"flex",alignItems:"center",gap:6}}>
                        {c.name}
                        {c.best && <span className="badge b-green" style={{fontSize:10}}><I.Sparkle size={10}/>الأفضل أداءً</span>}
                      </div>
                      <div className="mono" style={{fontSize:11,color:"var(--ink-500)"}}>{c.id}</div>
                    </div>
                  </div>
                </td>
                <td className="mono">{c.audience.toLocaleString()}</td>
                <td className="mono">{c.sent.toLocaleString()}</td>
                <td>
                  <div>
                    <span className="mono">{c.read.toLocaleString()}</span>
                    {c.sent>0 && <div style={{height:3,background:"var(--ink-100)",borderRadius:999,overflow:"hidden",marginTop:3,width:80}}>
                      <div style={{height:"100%",width:`${c.read/c.sent*100}%`,background:"var(--blue-500)"}}/>
                    </div>}
                  </div>
                </td>
                <td className="mono">{c.replied} <span className="muted" style={{fontSize:11}}>{c.sent?`(${(c.replied/c.sent*100).toFixed(1)}%)`:""}</span></td>
                <td><span className="pill">{c.template}</span></td>
                <td><span style={{fontSize:12}}>{c.schedule}</span></td>
                <td>
                  <span className={"badge " + (c.status==="جارٍ"?"b-green":c.status==="مجدول"?"b-blue":c.status==="مكتمل"?"b-grey":"b-amber")}>
                    <span className="dot"></span>{c.status}
                  </span>
                </td>
                <td>
                  <button className="btn btn-ghost btn-icon" onClick={(e)=>{e.stopPropagation();setSelected(c);setView("analytics")}}><I.Chart size={13}/></button>
                  <RowMenu size={13} items={[
                    { label:"عرض التحليلات", icon:<I.Chart size={13}/>, onClick:()=>{setSelected(c);setView("analytics");} },
                    { label:"مضاعفة الحملة", icon:<I.Plus size={13}/>, onClick:async()=>{
                      const clone = { ...c, id: (c.id||"CM-")+"-C-"+Math.random().toString(36).slice(2,6), name: c.name+" — نسخة", status:"مسودة", sent:0, read:0, replied:0 };
                      try { await window.KineticData.upsert("campaigns", clone); }
                      catch (e) { console.warn("clone campaign failed", e); }
                      if (window.showToast) window.showToast(`تم نسخ الحملة`,"success");
                    }},
                    { label:c.status==="جارٍ"?"إيقاف مؤقت":"استئناف", icon:<I.X size={13}/>, onClick:async()=>{
                      const nextStatus = c.status==="جارٍ" ? "مجدول" : "جارٍ";
                      try { await window.KineticData.upsert("campaigns", { ...c, status: nextStatus }); }
                      catch (e) { console.warn("toggle campaign failed", e); }
                      if (window.showToast) window.showToast(nextStatus==="جارٍ"?"تم الاستئناف":"تم الإيقاف المؤقت","success");
                    }},
                    { label:"حذف الحملة", icon:<I.X size={13}/>, danger:true, onClick:async()=>{
                      if (!window.confirm(`حذف حملة ${c.name}؟`)) return;
                      try { await window.KineticData.remove("campaigns", c.id); }
                      catch (e) { console.warn("delete campaign failed", e); }
                      if (window.showToast) window.showToast("تم حذف الحملة","success");
                    }},
                  ]}/>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
      {templatesOpen && (
        <Modal title="قوالب الحملات" onClose={()=>setTemplatesOpen(false)}>
          {["تذكير موعد","متابعة ما بعد الجلسة","عرض خاص على الباقات","رسالة رمضان","استطلاع رضا المريض"].map((t,i)=>(
            <div key={i} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 0",borderBottom:"1px solid var(--ink-100)"}}>
              <span style={{fontSize:13}}>{t}</span>
              <button className="btn btn-secondary" style={{fontSize:12}} onClick={()=>{setInitialTemplate(t);setTemplatesOpen(false);setView("builder");if(window.showToast)window.showToast(`تم تحميل القالب: ${t}`,"success");}}>استخدام</button>
            </div>
          ))}
        </Modal>
      )}
    </Page>
  );
}

function CampaignBuilder({ onCancel, onSave, initialTemplate }) {
  const templateNameMap = { "تذكير موعد":1, "متابعة ما بعد الجلسة":2, "عرض خاص على الباقات":3, "رسالة رمضان":3, "استطلاع رضا المريض":0 };
  const [step, setStep] = React.useState(1);
  const [name, setName] = React.useState(initialTemplate || "متابعة ربع سنوية لمرضى أسفل الظهر");
  const [template, setTemplate] = React.useState(initialTemplate != null ? (templateNameMap[initialTemplate] || 0) : 0);
  const [previewOpen, setPreviewOpen] = React.useState(false);
  const [filters, setFilters] = React.useState({
    diag:"",
    age:[0,100],
    payment:"Any",
    chronic:"Any",
    lastVisit:"آخر 7 أيام",
    remaining:"أي",
    gender:"أي"
  });

  // Live audience estimate against the real patients table.
  const audiencePatients = DATA.patients.filter(p =>
    (!filters.diag || (p.diag || p.diagnosis || "").includes(filters.diag)) &&
    (filters.gender === "أي" || filters.gender === "Any" || !filters.gender
      || (filters.gender === "أنثى" ? p.gender === "F" : p.gender === "M"))
  );

  const templates = [
    { name:"متابعة ربع سنوية", body:"أهلاً {{first_name}} 👋 it's been a while! How is your {{condition}} feeling? Reply 1 to book a جلسة, 2 to chat مع a therapist." },
    { name:"تذكير بموعد", body:"أهلاً {{first_name}}, reminder for your جلسة tomorrow at {{time}} مع {{therapist}}. Reply CONFIRM to confirm or RESCHEDULE." },
    { name:"متابعة بعد العمليات", body:"أهلاً {{first_name}}, how's your recovery? Your therapist {{therapist}} wants to check in. Are you experiencing any discomfort?" },
    { name:"تهاني عيد الميلاد", body:"Happy birthday {{first_name}}! 🎉 Wishing you a year من pain-free movement. Enjoy 15% off your next package this month." },
  ];

  return (
    <Page>
      <div className="crumb" style={{cursor:"pointer"}} onClick={onCancel}><span>حملات واتساب</span><I.Chevron size={11}/><span style={{color:"var(--ink-700)"}}>حملة جديدة</span></div>
      <div className="h1" style={{marginBottom:6}}>إنشاء حملة</div>
      <div className="muted" style={{fontSize:13.5,marginBottom:22}}>ابنِ، استهدف وجدول في 4 خطوات.</div>

      <div className="card" style={{padding:18,marginBottom:18,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div className="stepper" style={{gap:0,flex:1}}>
          {["أساسيات","الجمهور","الرسالة","الجدولة"].map((s,i)=>(
            <React.Fragment key={i}>
              <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
                <div style={{
                  width:24,height:24,borderRadius:999,
                  background:i+1<step?"var(--green)":i+1===step?"var(--blue-500)":"var(--ink-100)",
                  color:i+1<=step?"#fff":"var(--ink-500)",
                  display:"flex",alignItems:"center",justifyContent:"center",
                  fontSize:11,fontWeight:600
                }}>{i+1<step ? <I.Check size={12}/> : i+1}</div>
                <span className="step-label" style={{fontSize:12.5,fontWeight:i+1===step?600:500,color:i+1===step?"var(--ink-900)":"var(--ink-500)"}}>{s}</span>
              </div>
              {i<3 && <div style={{flex:1,minWidth:12,height:1,background:i+1<step?"var(--green)":"var(--ink-200)",margin:"0 14px"}}/>}
            </React.Fragment>
          ))}
        </div>
      </div>

      <div className="rgrid c-lg" style={{"--gtc":"1fr 360px"}}>
        <div className="card card-pad" style={{minHeight:540}}>
          {step===1 && (
            <div>
              <div className="h2" style={{marginBottom:18}}>الحملة basics</div>
              <Field label="الاسم" required><input className="input" value={name} onChange={e=>setName(e.target.value)}/></Field>
              <div style={{height:14}}/>
              <Field label="الهدف">
                <div className="rgrid half-sm" style={{"--gtc":"repeat(4,1fr)",gap:8}}>
                  {["حجوزات","إعادة تفاعل","تذكيرات","إعلانات"].map((g,i)=>(
                    <button key={g} className="btn btn-secondary" style={{justifyContent:"flex-start",padding:12,background:i===1?"var(--blue-50)":"#fff",borderColor:i===1?"var(--blue-500)":"var(--ink-200)"}}>
                      {g}
                    </button>
                  ))}
                </div>
              </Field>
              <div style={{height:14}}/>
              <Field label="وصف داخلي"><textarea className="input" style={{height:70,padding:10}} placeholder="ما هدف هذه الحملة؟"/></Field>
            </div>
          )}

          {step===2 && (
            <div>
              <div className="h2" style={{marginBottom:18}}>الجمهور المستهدف</div>
              <div className="rgrid c-sm" style={{"--gtc":"repeat(2,1fr)",gap:14}}>
                <Field label="التشخيص"><input className="input" value={filters.diag} onChange={e=>setFilters({...filters,diag:e.target.value})}/></Field>
                <Field label="الحالة/نوع الإصابة"><select className="input"><option>أي</option><option>بعد العمليات</option><option>أمراض مزمنة pain</option></select></Field>
                <Field label="الفئة العمرية"><input className="input" defaultValue="35 – 75"/></Field>
                <Field label="الجنس"><select className="input" value={filters.gender} onChange={e=>setFilters({...filters,gender:e.target.value})}><option>أي</option><option>أنثى</option><option>ذكر</option></select></Field>
                <Field label="طبيب"><select className="input"><option>أي</option>{[...new Set(DATA.patients.map(p=>p.dr).filter(d=>d&&d!=="—"))].map(d=><option key={d}>{d}</option>)}</select></Field>
                <Field label="الأخصائي"><select className="input"><option>أي</option>{DATA.therapists.map(t=><option key={t.id||t.name}>{t.name}</option>)}</select></Field>
                <Field label="الجلسات المتبقية"><select className="input" value={filters.remaining} onChange={e=>setFilters({...filters,remaining:e.target.value})}><option>أي</option><option>0</option><option>1–2</option><option>≥ 3</option></select></Field>
                <Field label="آخر زيارة"><select className="input" value={filters.lastVisit} onChange={e=>setFilters({...filters,lastVisit:e.target.value})}><option>آخر 7 أيام</option><option>14+ days</option><option>30+ days</option><option>60+ days</option></select></Field>
                <Field label="أمراض مزمنة disease"><select className="input"><option>أي</option><option>سكري</option><option>ضغط دم</option></select></Field>
                <Field label="الدفع status"><select className="input"><option>أي</option><option>مدفوع</option><option>معلّق</option><option>متأخر</option></select></Field>
              </div>

              <div style={{padding:14,background:"var(--blue-50)",border:"1px solid var(--blue-100)",borderRadius:12,marginTop:18,display:"flex",alignItems:"center",gap:14,flexWrap:"wrap"}}>
                <div style={{width:42,height:42,borderRadius:11,background:"var(--blue-500)",color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                  <I.Users size={18}/>
                </div>
                <div style={{flex:1,minWidth:200}}>
                  <div style={{fontWeight:600,fontSize:13.5,color:"var(--blue-900)"}}>هذا الجمهور يشمل <span className="mono">{audiencePatients.length} مريض</span></div>
                  <div className="muted" style={{fontSize:12,marginTop:2}}>{filters.diag ? `تشخيص: ${filters.diag} · ` : ""}تكلفة تقديرية EGP {(audiencePatients.length * 0.5).toFixed(0)}</div>
                </div>
                <button className="btn btn-secondary" onClick={()=>setPreviewOpen(true)}>معاينة القائمة</button>
              </div>
            </div>
          )}

          {step===3 && (
            <div>
              <div className="h2" style={{marginBottom:18}}>الرسالة</div>
              <div className="label">القالب</div>
              <div className="rgrid c-sm" style={{"--gtc":"repeat(2,1fr)",gap:10,marginBottom:18}}>
                {templates.map((t,i)=>(
                  <button key={i} onClick={()=>setTemplate(i)} style={{
                    padding:14,textAlign:"left",cursor:"pointer",
                    border:`1px solid ${template===i?"var(--blue-500)":"var(--ink-200)"}`,
                    borderRadius:11,background: template===i?"var(--blue-50)":"#fff",
                  }}>
                    <div style={{fontWeight:600,fontSize:13}}>{t.name}</div>
                    <div className="muted" style={{fontSize:11.5,marginTop:4,lineHeight:1.5,display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical",overflow:"hidden"}}>{t.body}</div>
                  </button>
                ))}
              </div>

              <Field label="الرسالة body"><textarea className="input" style={{height:160,padding:14,resize:"vertical",fontSize:13.5,lineHeight:1.55}} defaultValue={templates[template].body}/></Field>
              <div className="muted" style={{fontSize:11.5,marginTop:6}}>استخدم <span className="mono">{"{{first_name}}"}</span>, <span className="mono">{"{{therapist}}"}</span>, <span className="mono">{"{{condition}}"}</span> للتخصيص.</div>

              <div style={{display:"flex",gap:8,marginTop:14,flexWrap:"wrap"}}>
                <button className="btn btn-secondary" style={{fontSize:12}}><I.Image size={13}/> إرفاق صورة</button>
                <button className="btn btn-secondary" style={{fontSize:12}}><I.FileText size={13}/> إرفاق PDF</button>
                <button className="btn btn-secondary" style={{fontSize:12}}><I.Plus size={13}/> زر رد سريع</button>
              </div>
            </div>
          )}

          {step===4 && (
            <div>
              <div className="h2" style={{marginBottom:18}}>الجدولة</div>
              <Field label="متى ترسل">
                <div className="rgrid c-sm" style={{"--gtc":"repeat(3,1fr)",gap:10}}>
                  {[
                    {l:"إرسال الآن",sub:"خلال 5 دقائق"},
                    {l:"الجدولة one-shot",sub:"اختر تاريخًا ووقتًا"},
                    {l:"متكررة",sub:"يومي، أسبوعي، شهري"},
                  ].map((s,i)=>(
                    <button key={i} className="btn btn-secondary" style={{flexDirection:"column",alignItems:"flex-start",padding:14,background:i===1?"var(--blue-50)":"#fff",borderColor:i===1?"var(--blue-500)":"var(--ink-200)"}}>
                      <div style={{fontWeight:600,fontSize:13.5}}>{s.l}</div>
                      <div className="muted" style={{fontSize:11.5,marginTop:3}}>{s.sub}</div>
                    </button>
                  ))}
                </div>
              </Field>
              <div className="rgrid c-sm" style={{"--gtc":"repeat(2,1fr)",gap:14,marginTop:14}}>
                <Field label="التاريخ"><input className="input" type="date" defaultValue="2026-06-02"/></Field>
                <Field label="الوقت"><input className="input" type="time" defaultValue="09:00"/></Field>
                <Field label="المنطقة الزمنية" span={2}><select className="input"><option>Cairo (GMT+2)</option></select></Field>
              </div>

              <div style={{padding:14,background:"var(--green-bg)",border:"1px solid #BCE0D1",borderRadius:12,marginTop:18,display:"flex",alignItems:"center",gap:14}}>
                <I.Check size={20} style={{color:"var(--green)"}}/>
                <div>
                  <div style={{fontWeight:600,fontSize:13.5,color:"#2C8067"}}>جاهزة للإطلاق</div>
                  <div className="muted" style={{fontSize:12}}>312 messages will be queued for Jun 2, 09:00 (Cairo) at ~EGP 156 total.</div>
                </div>
              </div>
            </div>
          )}

          <div style={{display:"flex",justifyContent:"space-between",marginTop:24,flexWrap:"wrap",gap:10}}>
            <button className="btn btn-secondary" disabled={step===1} onClick={()=>setStep(step-1)} style={{opacity:step===1?.5:1}}>
              <I.ArrowLeft size={13}/> رجوع
            </button>
            <div style={{display:"flex",gap:10}}>
              <button className="btn btn-ghost" onClick={onCancel}>إلغاء</button>
              {step<4 ? (
                <button className="btn btn-blue" onClick={()=>setStep(step+1)}>متابعة <I.ArrowRight size={13}/></button>
              ) : (
                <button className="btn btn-blue" onClick={onSave}><I.Send size={13}/> إطلاق الحملة</button>
              )}
            </div>
          </div>
        </div>

        {/* Live preview */}
        <div>
          <div className="label">Live preview · واتساب</div>
          <div style={{
            background:"#ECE5DD",
            borderRadius:18, padding:16,
            backgroundImage:"radial-gradient(circle at 20% 10%, rgba(255,255,255,.4) 0, transparent 50%)",
            border:"1px solid var(--ink-200)",
            minHeight:520
          }}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14,padding:"4px 4px"}}>
              <div className="av md" style={{background:"#25D366",color:"#fff"}}>
                <I.Logo size={20}/>
              </div>
              <div>
                <div style={{fontSize:13,fontWeight:600,color:"#075E54"}}>عيادة كينيتك</div>
                <div style={{fontSize:11,color:"#888"}}>متصل</div>
              </div>
            </div>
            <div style={{display:"flex",justifyContent:"flex-start",marginBottom:8}}>
              <div style={{
                background:"#fff",borderRadius:"12px 12px 12px 4px",
                padding:"10px 12px",fontSize:13,maxWidth:"86%",
                boxShadow:"0 1px 1px rgba(0,0,0,.1)",lineHeight:1.45
              }}>
                أهلاً <strong>{"{{first_name}}"}</strong> 👋<br/>
                مرّ وقت طويل! كيف حال <strong>{"{{condition}}"}</strong> مؤخرًا؟<br/><br/>
                اضغط <strong>1</strong> لحجز جلسة<br/>
                اضغط <strong>2</strong> للتحدث مع أخصائي
                <div style={{fontSize:10,color:"#888",textAlign:"right",marginTop:6}}>09:00 · ✓✓</div>
              </div>
            </div>
            <div style={{display:"flex",justifyContent:"flex-end",marginBottom:8}}>
              <div style={{background:"#DCF8C6",borderRadius:"12px 12px 4px 12px",padding:"10px 12px",fontSize:13}}>
                1 — book a جلسة
                <div style={{fontSize:10,color:"#888",textAlign:"right",marginTop:6}}>09:04 · ✓✓</div>
              </div>
            </div>
            <div style={{display:"flex",justifyContent:"flex-start",marginBottom:8}}>
              <div style={{background:"#fff",borderRadius:"12px 12px 12px 4px",padding:"10px 12px",fontSize:13,maxWidth:"86%",boxShadow:"0 1px 1px rgba(0,0,0,.1)"}}>
                تمام! {"{{time}}"} مع {"{{therapist}}"}؟<br/>
                اضغط <strong>نعم</strong> للتأكيد.
                <div style={{fontSize:10,color:"#888",textAlign:"right",marginTop:6}}>09:04 · ✓</div>
              </div>
            </div>

            <div style={{textAlign:"center",fontSize:11,color:"#888",marginTop:20}}>هذه معاينة توضيحية تلقائية</div>
          </div>
        </div>
      </div>
      {previewOpen && (
        <Modal title="معاينة جمهور الحملة" onClose={()=>setPreviewOpen(false)}>
          <div className="muted" style={{fontSize:12,marginBottom:10}}>عرض عيّنة من المرضى المطابقين للفلاتر الحالية:</div>
          <div style={{maxHeight:360,overflowY:"auto"}}>
            {(DATA.patients || []).slice(0,20).map((p,i)=>(
              <div key={p.patient_id||p.id||i} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 4px",borderBottom:"1px solid var(--ink-100)"}}>
                <div className="av sm" style={{background:"var(--blue-100)",color:"var(--blue-700)"}}>{(p.name||"?").split(" ").map(x=>x[0]).slice(0,2).join("")}</div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:13,fontWeight:500}}>{p.name}</div>
                  <div className="muted mono" style={{fontSize:11}}>{p.patient_id || p.id} · {p.phone || "—"}</div>
                </div>
                <span className="muted" style={{fontSize:11}}>{p.diagnosis || p.diag || "—"}</span>
              </div>
            ))}
            {(!DATA.patients || DATA.patients.length===0) && <div className="muted" style={{fontSize:12,padding:14,textAlign:"center"}}>لا يوجد مرضى في قاعدة البيانات بعد.</div>}
          </div>
        </Modal>
      )}
    </Page>
  );
}

function CampaignAnalytics({ c, onBack }) {
  const [status, setStatus] = React.useState(c.status);
  const flipStatus = (next, msg) => {
    c.status = next;
    setStatus(next);
    try { window.dispatchEvent(new CustomEvent("kinetic:data-updated", { detail: { table: "campaigns" } })); } catch(_) {}
    if (window.showToast) window.showToast(msg, "success");
  };
  const funnelData = [
    { label:"مستهدف", v:c.audience, color:"#BDD8E9" },
    { label:"مُرسلة",     v:c.sent,     color:"#7BBDE8" },
    { label:"مقروءة",     v:c.read,     color:"#3A7FB5" },
    { label:"ردّ",  v:c.replied,  color:"#1E4A6E" },
  ];
  const timeSeries = [
    { label:"يوم 1", v:240 }, { label:"يوم 2", v:320 }, { label:"يوم 3", v:280 },
    { label:"يوم 4", v:340 }, { label:"يوم 5", v:390 }, { label:"يوم 6", v:280 },
    { label:"يوم 7", v:120 },
  ];

  return (
    <Page>
      <div className="crumb" style={{cursor:"pointer"}} onClick={onBack}><span>الحملات</span><I.Chevron size={11}/><span style={{color:"var(--ink-700)"}}>{c.name}</span></div>
      <div className="page-head">
        <div>
          <div className="h1" style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
            {c.name}
            {c.best && <span className="badge b-green"><I.Sparkle size={12}/>الأفضل أداءً</span>}
            <span className={"badge " + (status==="جارٍ"?"b-green":status==="مجدول"?"b-blue":status==="مكتمل"?"b-grey":"b-amber")}><span className="dot"></span>{status}</span>
          </div>
          <div className="muted" style={{fontSize:13.5,marginTop:4}}>{c.id} · {c.schedule} · template "{c.template}"</div>
        </div>
        <div className="page-actions">
          {status==="جارٍ"
            ? <button className="btn btn-secondary" onClick={()=>flipStatus("مجدول","تم إيقاف الحملة مؤقتًا")}><I.X size={13}/> إيقاف مؤقت</button>
            : <button className="btn btn-secondary" onClick={()=>flipStatus("جارٍ","تم استئناف الحملة")}><I.Send size={13}/> استئناف</button>}
          <button className="btn btn-secondary" onClick={()=>onBack&&onBack()}><I.Edit size={13}/> تعديل</button>
          <button className="btn btn-blue" onClick={()=>flipStatus("جارٍ","تم تشغيل الحملة الآن")}><I.Send size={13}/> تشغيل الآن</button>
        </div>
      </div>

      <div className="grid-4" style={{marginBottom:18}}>
        <StatCard label="مُرسلة"        value={c.sent.toLocaleString()}    accent="#7BBDE8" icon={<I.Send size={15}/>}/>
        <StatCard label="مقروءة"        value={`${(c.read/c.sent*100).toFixed(0)}%`} accent="#3A7FB5" icon={<I.Eye size={15}/>}/>
        <StatCard label="ردّ"     value={`${(c.replied/c.sent*100).toFixed(1)}%`} accent="#7E6BD3" icon={<I.WhatsApp size={15}/>}/>
        <StatCard label="تحويلات" value="42" delta="+12" deltaKind="up" accent="#3FA984" icon={<I.Check size={15}/>}/>
      </div>

      <div className="rgrid c-lg" style={{"--gtc":"1.5fr 1fr",marginBottom:18}}>
        <div className="card card-pad">
          <div className="h2" style={{marginBottom:18}}>الرسائل بمرور الوقت</div>
          <AreaChart data={timeSeries} height={220} formatY={v=>v}/>
        </div>
        <div className="card card-pad">
          <div className="h2" style={{marginBottom:18}}>القمع</div>
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            {funnelData.map((f,i)=>{
              const w = f.v/funnelData[0].v*100;
              return (
                <div key={f.label}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                    <span style={{fontSize:12.5,fontWeight:500}}>{f.label}</span>
                    <span className="mono" style={{fontSize:12.5}}>{f.v.toLocaleString()} <span className="muted">({Math.round(w)}%)</span></span>
                  </div>
                  <div style={{height:24,background:"var(--ink-100)",borderRadius:6,overflow:"hidden"}}>
                    <div style={{height:"100%",width:`${w}%`,background:f.color,transition:"width .3s"}}/>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="rgrid c-sm" style={{"--gtc":"1fr 1fr"}}>
        <div className="card card-pad">
          <div className="h2" style={{marginBottom:14}}>أفضل الردود</div>
          <div className="muted" style={{fontSize:13,padding:"14px 0"}}>ستظهر ردود المرضى هنا بعد ربط واتساب للأعمال.</div>
        </div>
        <div className="card card-pad">
          <div className="h2" style={{marginBottom:14}}>رسائل فاشلة</div>
          <div className="muted" style={{fontSize:13,padding:"14px 0"}}>لا رسائل فاشلة — تُعرض التسليمات المرتدة هنا بعد ربط واتساب للأعمال.</div>
        </div>
      </div>
    </Page>
  );
}

Object.assign(window, { Campaigns });


// ===== src/reports.jsx =====
// Reports module + Settings + 404

// ── Report helpers (shared by all three report tabs) ──────────
const REPORT_PAGE_SIZE = 12;
function reportToday() { return new Date().toISOString().slice(0, 10); }
function reportDaysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); }
// ISO YYYY-MM-DD lexical compare doubles as chronological compare.
function reportInRange(dateStr, from, to) {
  const d = String(dateStr || "").slice(0, 10);
  if (!d) return false;
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}
// Shared filter + pagination state for a report tab.
function useReportState() {
  const [f, setF] = React.useState({
    from: reportDaysAgo(30), to: reportToday(),
    therapist: "all", doctor: "all", patient: "all", q: "",
  });
  const set = (k, v) => setF(s => ({ ...s, [k]: v }));
  const [page, setPage] = React.useState(1);
  React.useEffect(() => { setPage(1); }, [f.from, f.to, f.therapist, f.doctor, f.patient, f.q]);
  return { f, set, page, setPage };
}
// Dropdown option lists sourced live from Supabase-hydrated DATA.
function useReportOpts() {
  return {
    therapists: Array.from(new Set((DATA.therapists || []).map(t => t.name).filter(Boolean))),
    doctors: Array.from(new Set((DATA.doctors || []).map(d => d.name).filter(Boolean))),
    patients: (DATA.patients || []).map(p => ({ id: p.id || p.patient_id, name: p.name })).filter(p => p.id),
  };
}
// Human-readable filter list for the Excel header + on-screen summary.
function reportActiveFilters(f, show, opts) {
  const list = [{ label: "الفترة", value: `${f.from || "—"} ← ${f.to || "—"}` }];
  if (show.therapist && f.therapist !== "all") list.push({ label: "الأخصائي", value: f.therapist });
  if (show.doctor && f.doctor !== "all") list.push({ label: "الطبيب", value: f.doctor });
  if (show.patient && f.patient !== "all") {
    const p = (opts.patients || []).find(x => x.id === f.patient);
    list.push({ label: "المريض", value: p ? p.name : f.patient });
  }
  if (f.q) list.push({ label: "بحث", value: f.q });
  return list;
}

// Date-range + entity filter bar with search + Excel export button.
function ReportFilterBar({ f, set, opts, show, onExport, searchPlaceholder = "بحث…" }) {
  return (
    <div className="card card-pad" style={{ marginBottom: 18 }}>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div style={{ minWidth: 140 }}>
          <div className="label">من تاريخ</div>
          <input type="date" className="input" value={f.from} max={f.to || undefined} onChange={e => set("from", e.target.value)} />
        </div>
        <div style={{ minWidth: 140 }}>
          <div className="label">إلى تاريخ</div>
          <input type="date" className="input" value={f.to} min={f.from || undefined} onChange={e => set("to", e.target.value)} />
        </div>
        {show.therapist && (
          <div style={{ minWidth: 150 }}>
            <div className="label">الأخصائي</div>
            <select className="input" value={f.therapist} onChange={e => set("therapist", e.target.value)}>
              <option value="all">كل الأخصائيين</option>
              {opts.therapists.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
        )}
        {show.doctor && (
          <div style={{ minWidth: 150 }}>
            <div className="label">الطبيب</div>
            <select className="input" value={f.doctor} onChange={e => set("doctor", e.target.value)}>
              <option value="all">كل الأطباء</option>
              {opts.doctors.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
        )}
        {show.patient && (
          <div style={{ minWidth: 170 }}>
            <div className="label">المريض</div>
            <select className="input" value={f.patient} onChange={e => set("patient", e.target.value)}>
              <option value="all">كل المرضى</option>
              {opts.patients.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        )}
        <div style={{ flex: 1, minWidth: 170 }}>
          <div className="label">بحث</div>
          <input className="input" placeholder={searchPlaceholder} value={f.q} onChange={e => set("q", e.target.value)} />
        </div>
        <button className="btn btn-blue" onClick={onExport} style={{ whiteSpace: "nowrap" }}>
          <I.Download size={14} /> تصدير Excel
        </button>
      </div>
    </div>
  );
}

// Paginated table shell — sticky-header table + result count + pager.
function ReportTable({ columns, rows, page, setPage, empty }) {
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / REPORT_PAGE_SIZE));
  const safe = Math.min(page, pages);
  const view = rows.slice((safe - 1) * REPORT_PAGE_SIZE, safe * REPORT_PAGE_SIZE);
  return (
    <div className="card card-pad">
      <div className="tbl-scroll">
        <table className="tbl">
          <thead><tr>{columns.map(c => <th key={c.key} style={c.type === "number" || c.type === "currency" ? { textAlign: "start" } : undefined}>{c.label}</th>)}</tr></thead>
          <tbody>
            {view.length === 0 && (
              <tr><td colSpan={columns.length}><div className="tbl-empty"><I.Search size={20} /><div>{empty || "لا نتائج ضمن عوامل التصفية الحالية."}</div></div></td></tr>
            )}
            {view.map((r, i) => (
              <tr key={r.id || i}>
                {columns.map(c => (
                  <td key={c.key} className={(c.type === "number" || c.type === "currency") ? "mono tnum" : undefined}>
                    {c.render ? c.render(r) : (c.type === "currency" ? `EGP ${(Number(r[c.key]) || 0).toLocaleString()}` : (r[c.key] == null || r[c.key] === "" ? "—" : r[c.key]))}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {total > 0 && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 12, gap: 8, flexWrap: "wrap" }}>
          <div className="muted" style={{ fontSize: 12 }}>صفحة <span className="mono">{safe}</span> من <span className="mono">{pages}</span> · <span className="mono">{total.toLocaleString()}</span> نتيجة</div>
          <div style={{ display: "flex", gap: 4 }}>
            <button className="btn btn-secondary" style={{ fontSize: 12, padding: "4px 10px" }} disabled={safe <= 1} onClick={() => setPage(safe - 1)}>السابق</button>
            <button className="btn btn-secondary" style={{ fontSize: 12, padding: "4px 10px" }} disabled={safe >= pages} onClick={() => setPage(safe + 1)}>التالي</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Reports({ go }) {
  window.useDataVersion && window.useDataVersion();
  const [section, setSection] = React.useState("financial");

  const cats = [
    { id: "financial",   l: "المالية",     icon: <I.Dollar size={15} /> },
    { id: "medical",     l: "الطبي",       icon: <I.Heart size={15} /> },
    { id: "operational", l: "التشغيلية",   icon: <I.Activity size={15} /> },
  ];

  return (
    <Page>
      <div className="page-head">
        <div>
          <div className="crumb"><span>الرئيسية</span><I.Chevron size={11}/><span>التقارير</span></div>
          <div className="h1">التقارير</div>
          <div className="muted" style={{fontSize:13.5,marginTop:4}}>تحليلات مالية وطبية وتشغيلية — بيانات مباشرة من قاعدة البيانات.</div>
        </div>
      </div>

      <div className="rgrid c-lg" style={{"--gtc":"220px 1fr"}}>
        {/* Clean 3-category sidebar — no submenus. Clicking a category
            loads its full report in the main area. */}
        <div className="card side-tabs" style={{padding:8,height:"fit-content"}}>
          {cats.map(s=>(
            <div key={s.id} className={"nav-item" + (section===s.id?" active":"")} style={{margin:0,marginBottom:4}} onClick={()=>setSection(s.id)}>
              {s.icon}{s.l}
            </div>
          ))}
        </div>

        <div>
          {section==="financial" && <FinancialReport/>}
          {section==="medical" && <MedicalReport/>}
          {section==="operational" && <OperationalReport/>}
        </div>
      </div>
    </Page>
  );
}

// ── Financial report (payments / invoices) ────────────────────
function FinancialReport() {
  window.useDataVersion && window.useDataVersion();
  const { f, set, page, setPage } = useReportState();
  const opts = useReportOpts();
  const show = { therapist: false, doctor: false, patient: true };

  // Row-level financial data — one row per invoice, straight from the
  // Supabase-hydrated payments table. No mock/static values.
  const rows = React.useMemo(() => (DATA.payments || []).map(v => {
    const amount = Number(v.amount) || 0, paid = Number(v.paid) || 0;
    return {
      id: v.id || v.invoice_id,
      date: String(v.date || v.created_at || "").slice(0, 10),
      patient: v.patient || "—",
      patient_id: v.patient_id || null,
      method: v.method || "—",
      amount, paid, outstanding: Math.max(0, amount - paid),
      status: v.status || "—",
    };
  }), [DATA.payments]);

  const q = f.q.trim().toLowerCase();
  const filtered = React.useMemo(() => rows.filter(r =>
    reportInRange(r.date, f.from, f.to) &&
    (f.patient === "all" || r.patient_id === f.patient) &&
    (!q || [r.patient, r.method, r.id, r.status].some(x => String(x || "").toLowerCase().includes(q)))
  ).sort((a, b) => String(b.date).localeCompare(String(a.date))), [rows, f.from, f.to, f.patient, q]);

  const collected = filtered.reduce((s, r) => s + r.paid, 0);
  const invoiced = filtered.reduce((s, r) => s + r.amount, 0);
  const outstanding = filtered.reduce((s, r) => s + r.outstanding, 0);
  const avg = filtered.length ? invoiced / filtered.length : 0;
  const fmtK = (v) => v >= 1000 ? `EGP ${(v / 1000).toFixed(1)}K` : `EGP ${Math.round(v).toLocaleString()}`;

  // Monthly collected trend + payment-method split from the filtered set.
  const byMonth = {};
  filtered.forEach(r => { if (r.date) byMonth[r.date.slice(0, 7)] = (byMonth[r.date.slice(0, 7)] || 0) + r.paid; });
  const monthly = Object.keys(byMonth).sort().slice(-6).map(m => ({ label: m.slice(2), v: Math.round(byMonth[m] / 1000) }));
  const byMethod = {};
  filtered.forEach(r => { byMethod[r.method] = (byMethod[r.method] || 0) + r.paid; });
  const methodColors = ["#7BBDE8", "#7E6BD3", "#3FA984", "#D49044", "#3A7FB5", "#BDD8E9"];
  const methodData = Object.keys(byMethod).map((m, i) => ({ label: m, v: Math.round(byMethod[m]), color: methodColors[i % methodColors.length] })).filter(d => d.v > 0);

  const columns = [
    { key: "date", label: "التاريخ", type: "date", width: 12 },
    { key: "patient", label: "المريض", type: "text", width: 20 },
    { key: "method", label: "طريقة الدفع", type: "text", width: 14 },
    { key: "amount", label: "المبلغ", type: "currency", total: true, width: 14 },
    { key: "paid", label: "المدفوع", type: "currency", total: true, width: 14 },
    { key: "outstanding", label: "المتبقي", type: "currency", total: true, width: 14 },
    { key: "status", label: "الحالة", type: "text", width: 12 },
  ];
  function doExport() {
    const ok = exportReportExcel({
      filename: `تقرير-مالي-${reportToday()}.xlsx`, sheetName: "التقرير المالي",
      title: "التقرير المالي", filters: reportActiveFilters(f, show, opts), columns, rows: filtered,
    });
    if (ok && window.showToast) window.showToast(`تم تصدير ${filtered.length} صفًا إلى Excel`, "success");
  }

  return (
    <div>
      <ReportFilterBar f={f} set={set} opts={opts} show={show} onExport={doExport} searchPlaceholder="بحث بالمريض أو طريقة الدفع…" />

      <div className="grid-4" style={{ marginBottom: 18 }}>
        <StatCard label="محصّل" value={fmtK(collected)} accent="#3FA984" icon={<I.Check size={15} />} />
        <StatCard label="إجمالي مفوتر" value={fmtK(invoiced)} accent="#3A7FB5" icon={<I.Dollar size={15} />} />
        <StatCard label="متبقٍ" value={fmtK(outstanding)} accent="#D49044" icon={<I.Clock size={15} />} />
        <StatCard label="عدد الفواتير" value={filtered.length.toLocaleString()} accent="#7BBDE8" icon={<I.Chart size={15} />} />
      </div>

      <div className="rgrid c-lg" style={{ "--gtc": "1.5fr 1fr", marginBottom: 18 }}>
        <div className="card card-pad">
          <div className="h2" style={{ marginBottom: 14 }}>اتجاه المبالغ المحصّلة (شهريًا)</div>
          {monthly.length ? <AreaChart data={monthly} height={240} formatY={v => `${v}K`} /> : <div className="muted" style={{ fontSize: 13, padding: "40px 0", textAlign: "center" }}>لا بيانات ضمن الفترة المحددة.</div>}
        </div>
        <div className="card card-pad">
          <div className="h2" style={{ marginBottom: 14 }}>توزيع طرق الدفع</div>
          {methodData.length ? <DonutChart data={methodData} size={180} centerLabel="محصّل" centerValue={fmtK(collected)} /> : <div className="muted" style={{ fontSize: 13, padding: "40px 0", textAlign: "center" }}>لا بيانات.</div>}
        </div>
      </div>

      <ReportTable columns={columns} rows={filtered} page={page} setPage={setPage} empty="لا فواتير ضمن عوامل التصفية الحالية." />
    </div>
  );
}

// ── Medical report (treatment sessions / patients) ────────────
function MedicalReport() {
  window.useDataVersion && window.useDataVersion();
  const { f, set, page, setPage } = useReportState();
  const opts = useReportOpts();
  const show = { therapist: true, doctor: true, patient: true };

  // Patient lookup so each session can surface its diagnosis + doctor.
  const patientById = React.useMemo(() => {
    const m = {}; (DATA.patients || []).forEach(p => { m[p.id || p.patient_id] = p; }); return m;
  }, [DATA.patients]);

  // One row per treatment session, from the Supabase-hydrated sessions table.
  const rows = React.useMemo(() => (DATA.sessions || []).map(s => {
    const p = patientById[s.patient_id] || {};
    return {
      id: s.id || s.session_id,
      date: String(s.date || s.created_at || "").slice(0, 10),
      patient: s.patient || p.name || "—",
      patient_id: s.patient_id || null,
      therapist: s.therapist || "—",
      therapist_id: s.therapist_id || null,
      doctor: p.dr || "—",
      diagnosis: p.diag || p.diagnosis || "—",
      session: s.session ?? s.session_number ?? 0,
      pain: s.pain ?? s.pain_score ?? 0,
      notes: (s.notes || "").toString().slice(0, 120),
    };
  }), [DATA.sessions, patientById]);

  const q = f.q.trim().toLowerCase();
  const filtered = React.useMemo(() => rows.filter(r =>
    reportInRange(r.date, f.from, f.to) &&
    (f.therapist === "all" || r.therapist === f.therapist) &&
    (f.doctor === "all" || r.doctor === f.doctor) &&
    (f.patient === "all" || r.patient_id === f.patient) &&
    (!q || [r.patient, r.therapist, r.doctor, r.diagnosis, r.notes].some(x => String(x || "").toLowerCase().includes(q)))
  ).sort((a, b) => String(b.date).localeCompare(String(a.date))), [rows, f.from, f.to, f.therapist, f.doctor, f.patient, q]);

  const distinctPatients = new Set(filtered.map(r => r.patient_id).filter(Boolean)).size;
  const totalSessions = filtered.length;
  const avgPain = filtered.length ? (filtered.reduce((s, r) => s + (Number(r.pain) || 0), 0) / filtered.length).toFixed(1) : "0";
  const avgPer = distinctPatients ? (totalSessions / distinctPatients).toFixed(1) : "0";

  // Diagnosis mix (from the patients touched in the filtered sessions).
  const buckets = [
    { label: "أسفل الظهر / القطنية", re: /ظهر|قطن|غضروف|نسا/, color: "#7BBDE8" },
    { label: "الركبة", re: /ركبة|رباط|رضف/, color: "#3A7FB5" },
    { label: "الكتف", re: /كتف/, color: "#7E6BD3" },
    { label: "الرقبة / العنقية", re: /رقبة|عنق/, color: "#3FA984" },
  ];
  const counts = buckets.map(b => ({ ...b, v: 0 })); let other = 0;
  const seen = new Set();
  filtered.forEach(r => {
    if (!r.patient_id || seen.has(r.patient_id)) return;
    seen.add(r.patient_id);
    const hit = counts.find(b => b.re.test(r.diagnosis || ""));
    if (hit) hit.v += 1; else other += 1;
  });
  const diagData = counts.filter(b => b.v > 0).map(({ label, v, color }) => ({ label, v, color }));
  if (other > 0) diagData.push({ label: "أخرى", v: other, color: "#BDD8E9" });

  // Cohort pain trend: average pain per session number across filtered rows.
  const byNum = {};
  filtered.forEach(s => { const n = s.session; if (!n) return; (byNum[n] = byNum[n] || []).push(Number(s.pain) || 0); });
  const cohort = Object.keys(byNum).map(Number).sort((a, b) => a - b).slice(0, 12)
    .map(n => ({ label: `ج${n}`, v: byNum[n].reduce((s, v) => s + v, 0) / byNum[n].length }));

  const columns = [
    { key: "date", label: "التاريخ", type: "date", width: 12 },
    { key: "patient", label: "المريض", type: "text", width: 20 },
    { key: "therapist", label: "الأخصائي", type: "text", width: 18 },
    { key: "doctor", label: "الطبيب", type: "text", width: 16 },
    { key: "session", label: "رقم الجلسة", type: "number", width: 10 },
    { key: "pain", label: "مستوى الألم", type: "number", width: 10 },
    { key: "notes", label: "ملاحظات", type: "text", width: 30 },
  ];
  function doExport() {
    const ok = exportReportExcel({
      filename: `تقرير-طبي-${reportToday()}.xlsx`, sheetName: "التقرير الطبي",
      title: "التقرير الطبي", filters: reportActiveFilters(f, show, opts), columns, rows: filtered,
    });
    if (ok && window.showToast) window.showToast(`تم تصدير ${filtered.length} صفًا إلى Excel`, "success");
  }

  return (
    <div>
      <ReportFilterBar f={f} set={set} opts={opts} show={show} onExport={doExport} searchPlaceholder="بحث بالمريض أو التشخيص…" />

      <div className="grid-4" style={{ marginBottom: 18 }}>
        <StatCard label="مرضى تحت العلاج" value={String(distinctPatients)} accent="#7BBDE8" icon={<I.Users size={15} />} />
        <StatCard label="عدد الجلسات" value={totalSessions.toLocaleString()} accent="#3A7FB5" icon={<I.Activity size={15} />} />
        <StatCard label="متوسط الجلسات لكل مريض" value={avgPer} accent="#7E6BD3" icon={<I.Chart size={15} />} />
        <StatCard label="متوسط مستوى الألم" value={avgPain} accent="#D49044" icon={<I.Heart size={15} />} />
      </div>

      <div className="rgrid c-lg" style={{ "--gtc": "1fr 1fr", marginBottom: 18 }}>
        <div className="card card-pad">
          <div className="h2" style={{ marginBottom: 18 }}>توزيع التشخيصات</div>
          {diagData.length ? <DonutChart data={diagData} size={180} centerLabel="مريض" centerValue={String(distinctPatients)} /> : <div className="muted" style={{ fontSize: 13, padding: "40px 0", textAlign: "center" }}>لا بيانات ضمن الفترة المحددة.</div>}
        </div>
        <div className="card card-pad">
          <div className="h2" style={{ marginBottom: 6 }}>تقدّم العلاج · متوسط الألم</div>
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 14 }}>متوسط مستوى الألم حسب رقم الجلسة</div>
          {cohort.length ? <AreaChart data={cohort} height={200} color="#3FA984" fill="rgba(63,169,132,.16)" formatY={v => Number(v).toFixed(1)} /> : <div className="muted" style={{ fontSize: 13, padding: "40px 0", textAlign: "center" }}>لا جلسات ضمن الفترة المحددة.</div>}
        </div>
      </div>

      <ReportTable columns={columns} rows={filtered} page={page} setPage={setPage} empty="لا جلسات ضمن عوامل التصفية الحالية." />
    </div>
  );
}

// ── Operational report (appointments / attendance / rooms) ────
function OperationalReport() {
  window.useDataVersion && window.useDataVersion();
  const { f, set, page, setPage } = useReportState();
  const opts = useReportOpts();
  const show = { therapist: true, doctor: true, patient: true };

  // One row per booked appointment, from the Supabase-hydrated appts table.
  const rows = React.useMemo(() => (DATA.appts || [])
    .filter(a => a.status !== "متاح")
    .map(a => ({
      id: a.id || a.booking_id,
      date: String(a.date || "").slice(0, 10),
      time: a.time || "—",
      patient: a.patient || "—",
      patient_id: a.pid || a.patient_id || null,
      therapist: a.th || "—",
      doctor: a.dr || "—",
      room: a.room || "—",
      type: a.type || "—",
      status: a.status || "—",
    })), [DATA.appts]);

  const q = f.q.trim().toLowerCase();
  const filtered = React.useMemo(() => rows.filter(r =>
    reportInRange(r.date, f.from, f.to) &&
    (f.therapist === "all" || r.therapist === f.therapist) &&
    (f.doctor === "all" || r.doctor === f.doctor) &&
    (f.patient === "all" || r.patient_id === f.patient) &&
    (!q || [r.patient, r.therapist, r.doctor, r.room, r.type, r.status].some(x => String(x || "").toLowerCase().includes(q)))
  ).sort((a, b) => (String(b.date) + b.time).localeCompare(String(a.date) + a.time)), [rows, f.from, f.to, f.therapist, f.doctor, f.patient, q]);

  const booked = filtered.length;
  const completed = filtered.filter(a => a.status === "مكتمل").length;
  const noShow = filtered.filter(a => a.status === "لم يحضر").length;
  const attended = filtered.filter(a => a.status === "مكتمل" || a.status === "قيد التنفيذ").length;
  const attendRate = booked ? Math.round(attended / booked * 100) : 0;
  const noShowRate = booked ? (noShow / booked * 100).toFixed(1) : "0";
  const completedRate = booked ? Math.round(completed / booked * 100) : 0;

  const wd = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
  const byDay = wd.map(l => ({ label: l, v: 0, color: "#7BBDE8" }));
  filtered.forEach(a => { if (a.date) { const d = new Date(a.date); if (!isNaN(d)) byDay[d.getDay()].v += 1; } });
  const byHourMap = {};
  filtered.forEach(a => { const h = parseInt(String(a.time || "").split(":")[0], 10); if (Number.isFinite(h)) byHourMap[h] = (byHourMap[h] || 0) + 1; });
  const byHour = Object.keys(byHourMap).map(Number).sort((a, b) => a - b).map(h => ({ label: `${h}:00`, v: byHourMap[h] }));

  const columns = [
    { key: "date", label: "التاريخ", type: "date", width: 12 },
    { key: "time", label: "الوقت", type: "text", width: 8 },
    { key: "patient", label: "المريض", type: "text", width: 20 },
    { key: "therapist", label: "الأخصائي", type: "text", width: 18 },
    { key: "doctor", label: "الطبيب", type: "text", width: 16 },
    { key: "room", label: "الغرفة", type: "text", width: 10 },
    { key: "type", label: "النوع", type: "text", width: 14 },
    { key: "status", label: "الحالة", type: "text", width: 12 },
  ];
  function doExport() {
    const ok = exportReportExcel({
      filename: `تقرير-تشغيلي-${reportToday()}.xlsx`, sheetName: "التقرير التشغيلي",
      title: "التقرير التشغيلي", filters: reportActiveFilters(f, show, opts), columns, rows: filtered,
    });
    if (ok && window.showToast) window.showToast(`تم تصدير ${filtered.length} صفًا إلى Excel`, "success");
  }

  return (
    <div>
      <ReportFilterBar f={f} set={set} opts={opts} show={show} onExport={doExport} searchPlaceholder="بحث بالمريض أو الغرفة…" />

      <div className="grid-4" style={{ marginBottom: 18 }}>
        <StatCard label="مواعيد مسجلة" value={booked.toLocaleString()} accent="#7BBDE8" icon={<I.Calendar size={15} />} />
        <StatCard label="معدّل الحضور" value={`${attendRate}%`} accent="#3FA984" icon={<I.Check size={15} />} />
        <StatCard label="معدل عدم الحضور" value={`${noShowRate}%`} accent="#D49044" icon={<I.X size={15} />} />
        <StatCard label="نسبة الإكمال" value={`${completedRate}%`} accent="#7E6BD3" icon={<I.Activity size={15} />} />
      </div>

      <div className="rgrid c-lg" style={{ "--gtc": "1fr 1fr", marginBottom: 18 }}>
        <div className="card card-pad">
          <div className="h2" style={{ marginBottom: 14 }}>المواعيد حسب يوم الأسبوع</div>
          {byDay.some(d => d.v > 0) ? <BarChart data={byDay} height={220} /> : <div className="muted" style={{ fontSize: 13, padding: "40px 0", textAlign: "center" }}>لا مواعيد ضمن الفترة المحددة.</div>}
        </div>
        <div className="card card-pad">
          <div className="h2" style={{ marginBottom: 14 }}>المواعيد حسب الساعة</div>
          {byHour.length ? <AreaChart data={byHour} height={220} /> : <div className="muted" style={{ fontSize: 13, padding: "40px 0", textAlign: "center" }}>لا مواعيد ضمن الفترة المحددة.</div>}
        </div>
      </div>

      <ReportTable columns={columns} rows={filtered} page={page} setPage={setPage} empty="لا مواعيد ضمن عوامل التصفية الحالية." />
    </div>
  );
}

// ───────────────── Settings ─────────────────
function SettingsPage({ go }) {
  const role = (window.ME && window.ME.role) || "";
  const isAdmin = !role || role === "مدير";
  const [tab, setTab] = React.useState("clinic");

  if (!isAdmin) {
    return (
      <Page>
        <div className="crumb"><span>الرئيسية</span><I.Chevron size={11}/><span>الإعدادات</span></div>
        <div className="card card-pad" style={{textAlign:"center",padding:"60px 20px",maxWidth:520,margin:"40px auto"}}>
          <I.Lock size={36} style={{color:"var(--ink-400)",marginBottom:12}}/>
          <div className="h2" style={{marginBottom:8}}>الوصول مقيّد</div>
          <div className="muted" style={{fontSize:13.5,marginBottom:20}}>الإعدادات متاحة للمديرين فقط. تواصل مع مدير النظام إذا كنت تحتاج تعديلًا هنا.</div>
          <button className="btn btn-blue" style={{margin:"0 auto"}} onClick={()=>go && go("dashboard")}><I.ArrowLeft size={13}/> العودة</button>
        </div>
      </Page>
    );
  }

  const items = [
    { id:"clinic",    l:"بيانات العيادة",       ic:<I.MapPin size={14}/> },
    { id:"branding",  l:"الهوية البصرية",       ic:<I.Image size={14}/> },
    { id:"depts",     l:"الأقسام والفريق",       ic:<I.Stethoscope size={14}/> },
    { id:"users",     l:"المستخدمون والأدوار",    ic:<I.Users size={14}/> },
  ];

  return (
    <Page>
      <div className="crumb"><span>الرئيسية</span><I.Chevron size={11}/><span>الإعدادات</span></div>
      <div className="h1" style={{marginBottom:18}}>الإعدادات</div>

      <div className="rgrid c-lg" style={{"--gtc":"220px 1fr"}}>
        <div className="card side-tabs" style={{padding:8,height:"fit-content"}}>
          {items.map(s=>(
            <div key={s.id} className={"nav-item" + (tab===s.id?" active":"")} style={{margin:0}} onClick={()=>setTab(s.id)}>
              {s.ic}{s.l}
            </div>
          ))}
        </div>

        <div className="card card-pad">
          {tab==="clinic" && <ClinicDetailsPanel/>}
          {tab==="depts" && <DeptDoctorsPanel/>}
          {tab==="users" && <UsersPanel/>}
          {tab==="branding" && <BrandingPanel/>}
          {tab!=="clinic" && tab!=="users" && tab!=="branding" && tab!=="depts" && (
            <EmptyState icon={<I.Settings size={22}/>} title="قريبًا" body={`The "${tab}" section is part من the next release. Reach out to support if you need something configured.`}/>
          )}
        </div>
      </div>
    </Page>
  );
}

// ── Admin: departments & doctors CRUD ────────────────────────
// Full create/read/update/delete for the booking taxonomy. Everything
// writes through KineticData → Supabase (+ LS), and the booking module
// re-renders automatically via the kinetic:data-updated event, so a new
// department/doctor appears everywhere with no code change.
const DEPT_ICONS = ["Stethoscope","Activity","Heart","Users","Sparkle","Layers","Bone","Brain"];
const DOC_STATUS_OPTS = [
  { v:"available", l:"متاح" }, { v:"busy", l:"مشغول" }, { v:"leave", l:"في إجازة" },
];
const DOC_STATUS_AR = { available:"متاح", busy:"مشغول", leave:"في إجازة" };
const newId = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2,5);

// ── useRoster: shared search + pagination for staff tables ─────
// One hook for all three rosters (Doctors, Specialists, Receptionists)
// so pagination behaviour, page-size, and reset-on-search are identical.
function useRoster(rows, matchFn, pageSize = 10) {
  const [search, setSearch] = React.useState("");
  const [page, setPage] = React.useState(1);
  const q = search.trim().toLowerCase();
  const filtered = q
    ? (rows || []).filter(r => matchFn(r, q))
    : (rows || []).slice();
  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pages);
  // Reset to page 1 whenever the query changes.
  React.useEffect(() => { setPage(1); }, [q]);
  const view = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);
  return { search, setSearch, page: safePage, setPage, pages, total, view, pageSize };
}

function RosterToolbar({ title, subtitle, search, setSearch, onAdd, addLabel, addDisabled }) {
  return (
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12,gap:12,flexWrap:"wrap"}}>
      <div>
        <div className="h2">{title}</div>
        {subtitle && <div className="muted" style={{fontSize:12.5,marginTop:2}}>{subtitle}</div>}
      </div>
      <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
        <input className="input" style={{height:34,minWidth:200,fontSize:12.5}} placeholder="بحث…"
          value={search} onChange={e=>setSearch(e.target.value)}/>
        {onAdd && <button className="btn btn-blue" onClick={onAdd} disabled={addDisabled}><I.Plus size={14}/> {addLabel}</button>}
      </div>
    </div>
  );
}

function RosterPager({ page, pages, total, onPage }) {
  if (total === 0) return null;
  return (
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginTop:8,gap:8,flexWrap:"wrap"}}>
      <div className="muted" style={{fontSize:12}}>الإجمالي <span className="mono">{total}</span> · صفحة <span className="mono">{page}</span> من <span className="mono">{pages}</span></div>
      <div style={{display:"flex",gap:4}}>
        <button className="btn btn-secondary" style={{fontSize:12,padding:"4px 10px"}} disabled={page<=1} onClick={()=>onPage(page-1)}>السابق</button>
        <button className="btn btn-secondary" style={{fontSize:12,padding:"4px 10px"}} disabled={page>=pages} onClick={()=>onPage(page+1)}>التالي</button>
      </div>
    </div>
  );
}

function DeptDoctorsPanel() {
  // Subscribe to kinetic:data-updated so a successful upsert (which mutates
  // window.DATA and fires the event) triggers an immediate re-render —
  // this is what fulfils the "table refreshes automatically" contract.
  window.useDataVersion && window.useDataVersion();
  const depts = (DATA.departments || []).slice().sort((a,b)=>(a.sort_order||0)-(b.sort_order||0));
  const doctors      = DATA.doctors        || [];
  const specialists  = DATA.therapists     || [];
  const receptionists= DATA.receptionists  || [];
  const [deptModal, setDeptModal] = React.useState(null);   // dept row or {} for new
  const [docModal, setDocModal]   = React.useState(null);
  const [specModal, setSpecModal] = React.useState(null);
  const [rcpModal, setRcpModal]   = React.useState(null);

  const deptName = (id) => (depts.find(d=>d.id===id)||{}).name_ar || "—";
  const countDocs   = (id) => doctors.filter(d=>d.active!==false && d.department_id===id).length;
  const countSpecs  = (id) => specialists.filter(s=>s.active!==false && s.department_id===id).length;

  // Rosters with search + pagination.
  const doctorsRoster = useRoster(doctors, (r, q) =>
    (r.name||"").toLowerCase().includes(q) ||
    (r.specialization||"").toLowerCase().includes(q) ||
    (r.phone||"").toLowerCase().includes(q) ||
    (r.email||"").toLowerCase().includes(q) ||
    (deptName(r.department_id)||"").toLowerCase().includes(q));
  const specRoster = useRoster(specialists, (r, q) =>
    (r.name||"").toLowerCase().includes(q) ||
    (r.spec||"").toLowerCase().includes(q) ||
    (r.phone||"").toLowerCase().includes(q) ||
    (r.email||"").toLowerCase().includes(q) ||
    (deptName(r.department_id)||"").toLowerCase().includes(q));
  const rcpRoster = useRoster(receptionists, (r, q) =>
    (r.name||"").toLowerCase().includes(q) ||
    (r.phone||"").toLowerCase().includes(q) ||
    (r.email||"").toLowerCase().includes(q));

  async function removeDept(d) {
    if (doctors.some(x=>x.department_id===d.id) || specialists.some(x=>x.department_id===d.id)) {
      window.showToast && window.showToast("أزل أعضاء القسم أولاً","error"); return;
    }
    if (!window.confirm(`حذف قسم «${d.name_ar}»؟`)) return;
    try { await window.KineticData.remove("departments", d.id); window.showToast && window.showToast("تم حذف القسم","success"); }
    catch(e){ console.error(e); window.showToast && window.showToast(e.message || "تعذّر الحذف","error"); }
  }
  async function removeRow(table, row, label) {
    if (!window.confirm(`حذف ${label} «${row.name}»؟`)) return;
    try { await window.KineticData.remove(table, row.id); window.showToast && window.showToast(`تم حذف ${label}`,"success"); }
    catch(e){ console.error(e); window.showToast && window.showToast(e.message || "تعذّر الحذف","error"); }
  }
  async function toggleActive(table, row) {
    const next = row.active === false;
    try {
      const res = await window.KineticData.upsert(table, { ...row, active: next });
      if (res && res._ok === false) throw new Error(res._error || "تعذّر التحديث");
      window.showToast && window.showToast(next ? "تم التفعيل" : "تم الإيقاف", "success");
    }
    catch(e){ console.error(e); window.showToast && window.showToast(e.message || "تعذّر التحديث","error"); }
  }

  return (
    <div>
      {/* ── Departments ────────────────────────────────────────── */}
      <RosterToolbar
        title="الأقسام" subtitle="تظهر في صفحة الحجز تلقائيًا فور إضافتها."
        search="" setSearch={()=>{}}
        onAdd={()=>setDeptModal({})} addLabel="إضافة قسم"/>
      <div className="tbl-scroll" style={{marginBottom:26}}>
        <table className="tbl">
          <thead><tr><th>القسم</th><th>بالإنجليزية</th><th>الأطباء</th><th>الأخصائيون</th><th>الحالة</th><th></th></tr></thead>
          <tbody>
            {depts.length===0 && <tr><td colSpan={6}><EmptyState icon={<I.Layers size={22}/>} title="لا أقسام بعد" body="أضف أول قسم من زر «إضافة قسم»."/></td></tr>}
            {depts.map(d=>(
              <tr key={d.id}>
                <td><div style={{display:"flex",alignItems:"center",gap:8}}>
                  <span className="av sm" style={{background:(d.color||"#7BBDE8")+"22",color:d.color||"var(--blue-700)"}}>{(window.I[d.icon]||I.Layers)({size:14})}</span>
                  {d.name_ar}
                </div></td>
                <td className="muted" style={{fontSize:12.5}}>{d.name_en||"—"}</td>
                <td className="mono">{countDocs(d.id)}</td>
                <td className="mono">{countSpecs(d.id)}</td>
                <td>
                  <button className={"badge " + (d.active!==false?"b-green":"b-grey")} style={{cursor:"pointer",border:"none"}} onClick={()=>toggleActive("departments", d)}>
                    <span className="dot"></span>{d.active!==false?"نشط":"موقوف"}
                  </button>
                </td>
                <td><RowMenu size={13} items={[
                  { label:"تعديل", icon:<I.Edit size={13}/>, onClick:()=>setDeptModal(d) },
                  { label:"حذف", icon:<I.Trash size={13}/>, danger:true, onClick:()=>removeDept(d) },
                ]}/></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Doctors ───────────────────────────────────────────── */}
      <RosterToolbar
        title="الأطباء" subtitle="يظهرون في الحجز ضمن أقسامهم عند تفعيلهم."
        search={doctorsRoster.search} setSearch={doctorsRoster.setSearch}
        onAdd={()=>setDocModal({})} addLabel="إضافة طبيب"/>
      <div className="tbl-scroll">
        <table className="tbl">
          <thead><tr><th>الطبيب</th><th>القسم</th><th>التخصص</th><th>الهاتف</th><th>البريد</th><th>التوفر</th><th>الحالة</th><th></th></tr></thead>
          <tbody>
            {doctorsRoster.total===0 && <tr><td colSpan={8}><EmptyState icon={<I.Stethoscope size={22}/>} title="لا أطباء" body={depts.length? "أضف أول طبيب من زر «إضافة طبيب».":"أضف قسمًا أولاً ثم أضف الأطباء."}/></td></tr>}
            {doctorsRoster.view.map(d=>(
              <tr key={d.id}>
                <td><div style={{display:"flex",alignItems:"center",gap:8}}>
                  <span className="av sm" style={{background:(d.color||"#7BBDE8")+"33",color:d.color||"var(--blue-700)"}}>{(d.name||"").replace("د. ","").split(" ").map(x=>x[0]||"").join("").slice(0,2)}</span>
                  {d.name}
                </div></td>
                <td className="muted" style={{fontSize:12.5}}>{deptName(d.department_id)}</td>
                <td className="muted" style={{fontSize:12.5}}>{d.specialization||"—"}</td>
                <td className="mono" style={{fontSize:12}}>{d.phone||"—"}</td>
                <td className="mono" style={{fontSize:12}}>{d.email||"—"}</td>
                <td><span className={"badge " + (d.status==="available"?"b-green":d.status==="busy"?"b-amber":"b-grey")}><span className="dot"></span>{DOC_STATUS_AR[d.status]||d.status||"—"}</span></td>
                <td>
                  <button className={"badge " + (d.active!==false?"b-green":"b-grey")} style={{cursor:"pointer",border:"none"}} onClick={()=>toggleActive("doctors", d)}>
                    <span className="dot"></span>{d.active!==false?"مفعّل":"موقوف"}
                  </button>
                </td>
                <td><RowMenu size={13} items={[
                  { label:"تعديل", icon:<I.Edit size={13}/>, onClick:()=>setDocModal(d) },
                  { label:d.active!==false?"إيقاف":"تفعيل", icon:d.active!==false?<I.Lock size={13}/>:<I.Check size={13}/>, onClick:()=>toggleActive("doctors", d) },
                  { label:"حذف", icon:<I.Trash size={13}/>, danger:true, onClick:()=>removeRow("doctors", d, "الطبيب") },
                ]}/></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <RosterPager page={doctorsRoster.page} pages={doctorsRoster.pages} total={doctorsRoster.total} onPage={doctorsRoster.setPage}/>

      {/* ── Specialists (أخصائي) — persisted in `therapists` table ── */}
      <div style={{height:26}}/>
      <RosterToolbar
        title="الأخصائيون" subtitle="فريق العلاج الطبيعي المعيّن للحالات."
        search={specRoster.search} setSearch={specRoster.setSearch}
        onAdd={()=>setSpecModal({})} addLabel="إضافة أخصائي"/>
      <div className="tbl-scroll">
        <table className="tbl">
          <thead><tr><th>الأخصائي</th><th>القسم</th><th>التخصص</th><th>الهاتف</th><th>البريد</th><th>رقم الترخيص</th><th>الحالة</th><th></th></tr></thead>
          <tbody>
            {specRoster.total===0 && <tr><td colSpan={8}><EmptyState icon={<I.Activity size={22}/>} title="لا أخصائيين" body={depts.length? "أضف أول أخصائي من زر «إضافة أخصائي».":"أضف قسمًا أولاً ثم أضف الأخصائيين."}/></td></tr>}
            {specRoster.view.map(s=>(
              <tr key={s.id}>
                <td><div style={{display:"flex",alignItems:"center",gap:8}}>
                  <span className="av sm" style={{background:(s.color||"#7BBDE8")+"33",color:s.color||"var(--blue-700)"}}>{(s.name||"").split(" ").map(x=>x[0]||"").join("").slice(0,2)}</span>
                  {s.name}
                </div></td>
                <td className="muted" style={{fontSize:12.5}}>{deptName(s.department_id)}</td>
                <td className="muted" style={{fontSize:12.5}}>{s.spec||"—"}</td>
                <td className="mono" style={{fontSize:12}}>{s.phone||"—"}</td>
                <td className="mono" style={{fontSize:12}}>{s.email||"—"}</td>
                <td className="mono" style={{fontSize:12}}>{s.license_number||"—"}</td>
                <td>
                  <button className={"badge " + (s.active!==false?"b-green":"b-grey")} style={{cursor:"pointer",border:"none"}} onClick={()=>toggleActive("therapists", s)}>
                    <span className="dot"></span>{s.active!==false?"مفعّل":"موقوف"}
                  </button>
                </td>
                <td><RowMenu size={13} items={[
                  { label:"تعديل", icon:<I.Edit size={13}/>, onClick:()=>setSpecModal(s) },
                  { label:s.active!==false?"إيقاف":"تفعيل", icon:s.active!==false?<I.Lock size={13}/>:<I.Check size={13}/>, onClick:()=>toggleActive("therapists", s) },
                  { label:"حذف", icon:<I.Trash size={13}/>, danger:true, onClick:()=>removeRow("therapists", s, "الأخصائي") },
                ]}/></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <RosterPager page={specRoster.page} pages={specRoster.pages} total={specRoster.total} onPage={specRoster.setPage}/>

      {/* ── Receptionists ─────────────────────────────────────── */}
      <div style={{height:26}}/>
      <RosterToolbar
        title="موظفو الاستقبال" subtitle="يديرون الحجوزات والدفع من الواجهة الأمامية."
        search={rcpRoster.search} setSearch={rcpRoster.setSearch}
        onAdd={()=>setRcpModal({})} addLabel="إضافة موظف استقبال"/>
      <div className="tbl-scroll">
        <table className="tbl">
          <thead><tr><th>الاسم</th><th>الهاتف</th><th>البريد</th><th>ملاحظات</th><th>الحالة</th><th></th></tr></thead>
          <tbody>
            {rcpRoster.total===0 && <tr><td colSpan={6}><EmptyState icon={<I.Users size={22}/>} title="لا موظفي استقبال" body="أضف أول موظف من زر «إضافة موظف استقبال»."/></td></tr>}
            {rcpRoster.view.map(r=>(
              <tr key={r.id}>
                <td><div style={{display:"flex",alignItems:"center",gap:8}}>
                  <span className="av sm">{(r.name||"?").split(" ").map(x=>x[0]||"").join("").slice(0,2)}</span>
                  {r.name}
                </div></td>
                <td className="mono" style={{fontSize:12}}>{r.phone||"—"}</td>
                <td className="mono" style={{fontSize:12}}>{r.email||"—"}</td>
                <td className="muted" style={{fontSize:12.5,maxWidth:220,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}} title={r.notes||""}>{r.notes||"—"}</td>
                <td>
                  <button className={"badge " + (r.active!==false?"b-green":"b-grey")} style={{cursor:"pointer",border:"none"}} onClick={()=>toggleActive("receptionists", r)}>
                    <span className="dot"></span>{r.active!==false?"مفعّل":"موقوف"}
                  </button>
                </td>
                <td><RowMenu size={13} items={[
                  { label:"تعديل", icon:<I.Edit size={13}/>, onClick:()=>setRcpModal(r) },
                  { label:r.active!==false?"إيقاف":"تفعيل", icon:r.active!==false?<I.Lock size={13}/>:<I.Check size={13}/>, onClick:()=>toggleActive("receptionists", r) },
                  { label:"حذف", icon:<I.Trash size={13}/>, danger:true, onClick:()=>removeRow("receptionists", r, "موظف الاستقبال") },
                ]}/></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <RosterPager page={rcpRoster.page} pages={rcpRoster.pages} total={rcpRoster.total} onPage={rcpRoster.setPage}/>

      {deptModal && <DeptModal row={deptModal} onClose={()=>setDeptModal(null)}/>}
      {docModal  && <DoctorModal row={docModal} depts={depts} onClose={()=>setDocModal(null)}/>}
      {specModal && <SpecialistModal row={specModal} depts={depts} onClose={()=>setSpecModal(null)}/>}
      {rcpModal  && <ReceptionistModal row={rcpModal} onClose={()=>setRcpModal(null)}/>}
    </div>
  );
}

function DeptModal({ row, onClose }) {
  const isNew = !row.id;
  const [f, setF] = React.useState({
    name_ar: row.name_ar||"", name_en: row.name_en||"", description: row.description||"",
    icon: row.icon||"Stethoscope", color: row.color||"#7BBDE8",
    sort_order: row.sort_order||0, active: row.active!==false,
  });
  const [busy, setBusy] = React.useState(false);
  const set = (k,v)=>setF(s=>({...s,[k]:v}));
  async function save() {
    if (!f.name_ar.trim()) return window.showToast && window.showToast("أدخل اسم القسم","error");
    setBusy(true);
    try {
      await window.KineticData.upsert("departments", {
        id: row.id || newId("D-"), ...f, name_ar: f.name_ar.trim(),
        sort_order: Number(f.sort_order)||0,
      });
      window.showToast && window.showToast(isNew?"تمت إضافة القسم":"تم تحديث القسم","success");
      onClose();
    } catch(e){ console.warn(e); window.showToast && window.showToast("تعذّر الحفظ","error"); }
    finally { setBusy(false); }
  }
  return (
    <Modal title={isNew?"قسم جديد":"تعديل قسم"} onClose={onClose} width={520}
      footer={<><button className="btn btn-ghost" onClick={onClose}>إلغاء</button>
        <button className="btn btn-blue" disabled={busy} onClick={save}><I.Check size={13}/> حفظ</button></>}>
      <div className="rgrid c-sm" style={{"--gtc":"1fr 1fr",gap:12}}>
        <Field label="الاسم بالعربية" required><input className="input" value={f.name_ar} onChange={e=>set("name_ar",e.target.value)}/></Field>
        <Field label="الاسم بالإنجليزية"><input className="input" value={f.name_en} onChange={e=>set("name_en",e.target.value)} dir="ltr"/></Field>
      </div>
      <div style={{height:12}}/>
      <Field label="الوصف"><input className="input" value={f.description} onChange={e=>set("description",e.target.value)}/></Field>
      <div style={{height:12}}/>
      <div className="rgrid c-sm" style={{"--gtc":"1fr 1fr 1fr",gap:12}}>
        <Field label="الأيقونة"><select className="input" value={f.icon} onChange={e=>set("icon",e.target.value)}>{DEPT_ICONS.filter(n=>window.I[n]).map(n=><option key={n} value={n}>{n}</option>)}</select></Field>
        <Field label="اللون"><input className="input" type="color" value={f.color} onChange={e=>set("color",e.target.value)} style={{padding:4,height:40}}/></Field>
        <Field label="الترتيب"><input className="input" type="number" value={f.sort_order} onChange={e=>set("sort_order",e.target.value)}/></Field>
      </div>
      <label style={{display:"flex",alignItems:"center",gap:8,fontSize:13,marginTop:14,cursor:"pointer"}}>
        <input type="checkbox" checked={f.active} onChange={e=>set("active",e.target.checked)}/> قسم نشط (يظهر في الحجز)
      </label>
    </Modal>
  );
}

// ── Auth-user picker (shared by roster modals) ────────────────
// Loads existing auth accounts of the given role that aren't yet linked
// to any row in `linkedRows`. On selection, hands back the picked staff
// object so the modal can hydrate name/email/phone/auth_uid from it.
// Never asks the operator to type an email — the email always comes from
// the linked auth account.
function AuthUserPicker({ roleSlug, linkedRows, value, onChange, disabled }) {
  const [options, setOptions] = React.useState(null); // null = loading
  const [search, setSearch] = React.useState("");
  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const raw = window.listAvailableAuthUsers
          ? await window.listAvailableAuthUsers(roleSlug, linkedRows)
          : [];
        if (alive) setOptions(Array.isArray(raw) ? raw : []);
      } catch (e) {
        console.warn("listAvailableAuthUsers failed", e);
        if (alive) setOptions([]);
      }
    })();
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roleSlug]);
  if (disabled) {
    return (
      <div className="input" style={{opacity:.75,cursor:"not-allowed",background:"var(--ink-50)"}}>
        {value ? `${value.name || "—"} — ${value.email || "—"}` : "غير مربوط بحساب"}
      </div>
    );
  }
  if (options === null) {
    return <div className="muted" style={{fontSize:12}}>جاري تحميل الحسابات…</div>;
  }
  const q = search.trim().toLowerCase();
  const filtered = q
    ? options.filter(o =>
        (o.name || "").toLowerCase().includes(q) ||
        (o.email || "").toLowerCase().includes(q))
    : options;
  return (
    <div>
      <input className="input" style={{marginBottom:6,fontSize:12.5}} placeholder="بحث بالاسم أو البريد…"
        value={search} onChange={e=>setSearch(e.target.value)}/>
      <select className="input" value={(value && value.auth_uid) || ""}
        onChange={e => {
          const uid = e.target.value;
          const picked = options.find(o => o.auth_uid === uid) || null;
          onChange(picked);
        }}>
        <option value="">— اختر حسابًا مرتبطًا —</option>
        {filtered.map(o => (
          <option key={o.auth_uid} value={o.auth_uid}>
            {(o.name || o.email || o.auth_uid)} — {o.email || "—"} — {roleLabelAr(o.role)}
          </option>
        ))}
      </select>
      {options.length === 0 && (
        <div className="muted" style={{fontSize:11.5,marginTop:6,lineHeight:1.6,padding:"8px 10px",background:"var(--ink-50)",borderRadius:8}}>
          لا توجد حسابات متاحة بهذا الدور غير مرتبطة بسجل بعد. أنشئ حسابًا من «المستخدمون والأدوار» → «إنشاء مستخدم» أولاً.
        </div>
      )}
    </div>
  );
}

// Local role→AR label (mirrors ROLE_AR below; declared here so the picker
// works even before ROLE_AR's module-scope binding is reached in TDZ).
function roleLabelAr(slug) {
  const t = { admin:"مدير", receptionist:"موظف استقبال", doctor:"طبيب", therapist:"الأخصائي" };
  return t[slug] || slug || "—";
}

// Turn a PostgREST unique-violation into an Arabic explainer. This is the
// last line of defence against duplicate assignment: the DB unique index
// still rejects the write even if the client picker was stale.
function friendlyRosterError(msg, roleLabel) {
  const t = String(msg || "").toLowerCase();
  if (t.includes("23505") || t.includes("duplicate") || t.includes("unique")) {
    return `هذا الحساب مربوط بالفعل بسجل ${roleLabel} آخر — اختر حسابًا مختلفًا`;
  }
  return msg || "تعذّر الحفظ";
}

function DoctorModal({ row, depts, onClose }) {
  const isNew = !row.id;
  const doctorsAll = (window.DATA && window.DATA.doctors) || [];
  // For editing, exclude THIS row so its own auth_uid isn't reported as taken.
  const linkedRows = isNew ? doctorsAll : doctorsAll.filter(d => (d.id||d.pk) !== row.id);
  const [account, setAccount] = React.useState(
    isNew ? null : (row.auth_uid ? { auth_uid: row.auth_uid, name: row.name || "", email: row.email || "", role: "doctor" } : null)
  );
  const [f, setF] = React.useState({
    department_id: row.department_id || (depts[0] && depts[0].id) || "",
    specialization: row.specialization || "",
    experience_years: row.experience_years || 0,
    schedule: row.schedule || "",
    status: row.status || "available",
    color: row.color || "#7BBDE8",
    active: row.active !== false,
    phone: row.phone || "",
    license_number: row.license_number || "",
    notes: row.notes || "",
  });
  const [busy, setBusy] = React.useState(false);
  const set = (k,v) => setF(s => ({ ...s, [k]: v }));
  // When an account is picked, hydrate name/email/phone from it.
  function pickAccount(u) {
    setAccount(u);
    if (u && u.phone && !f.phone) set("phone", u.phone);
  }
  async function save() {
    if (isNew && (!account || !account.auth_uid)) {
      return window.showToast && window.showToast("اختر حسابًا مرتبطًا للطبيب","error");
    }
    if (!depts.length) return window.showToast && window.showToast("أضف قسمًا أولاً","error");
    if (!f.department_id) return window.showToast && window.showToast("اختر القسم","error");
    setBusy(true);
    try {
      const name = (account && account.name) ? account.name.trim() : (row.name || "").trim();
      const email = (account && account.email) ? account.email.trim() : (row.email || "").trim();
      const res = await window.KineticData.upsert("doctors", {
        id: row.id || newId("DR-"),
        auth_uid: (account && account.auth_uid) || row.auth_uid || null,
        name, email,
        department_id: f.department_id,
        specialization: f.specialization.trim() || null,
        experience_years: Number(f.experience_years) || 0,
        schedule: f.schedule.trim() || null,
        status: f.status,
        color: f.color,
        active: !!f.active,
        phone: (f.phone || "").trim() || null,
        license_number: f.license_number.trim() || null,
        notes: f.notes.trim() || null,
      });
      if (res && res._ok === false) throw new Error(friendlyRosterError(res._error, "طبيب"));
      window.showToast && window.showToast(isNew ? "تمت إضافة الطبيب" : "تم تحديث الطبيب", "success");
      onClose();
    } catch (e) { console.error(e); window.showToast && window.showToast(e.message || "تعذّر الحفظ","error"); }
    finally { setBusy(false); }
  }
  return (
    <Modal title={isNew?"طبيب جديد":"تعديل طبيب"} onClose={onClose} width={600}
      footer={<><button className="btn btn-ghost" onClick={onClose}>إلغاء</button>
        <button className="btn btn-blue" disabled={busy} onClick={save}><I.Check size={13}/> حفظ</button></>}>
      <Field label="الحساب المرتبط" required hint={isNew ? "يظهر فقط حسابات دور «طبيب» غير المربوطة" : "الحساب المرتبط لا يتغيّر بعد الحفظ"}>
        <AuthUserPicker roleSlug="doctor" linkedRows={linkedRows} value={account} onChange={pickAccount} disabled={!isNew}/>
      </Field>
      <div style={{height:12}}/>
      {(account || !isNew) && (
        <>
          <div className="rgrid c-sm" style={{"--gtc":"1fr 1fr",gap:12}}>
            <Field label="الاسم"><input className="input" value={(account && account.name) || row.name || ""} disabled style={{opacity:.75}}/></Field>
            <Field label="البريد الإلكتروني"><input className="input" value={(account && account.email) || row.email || ""} disabled dir="ltr" style={{opacity:.75}}/></Field>
          </div>
          <div style={{height:12}}/>
        </>
      )}
      <div className="rgrid c-sm" style={{"--gtc":"1fr 1fr",gap:12}}>
        <Field label="القسم" required>
          <select className="input" value={f.department_id} onChange={e=>set("department_id",e.target.value)}>
            <option value="">— اختر —</option>
            {depts.map(d=><option key={d.id} value={d.id}>{d.name_ar}</option>)}
          </select>
        </Field>
        <Field label="التخصص"><input className="input" value={f.specialization} onChange={e=>set("specialization",e.target.value)}/></Field>
      </div>
      <div style={{height:12}}/>
      <div className="rgrid c-sm" style={{"--gtc":"1fr 1fr",gap:12}}>
        <Field label="الهاتف"><input className="input" value={f.phone} onChange={e=>set("phone",e.target.value)} placeholder="+20 …"/></Field>
        <Field label="سنوات الخبرة"><input className="input" type="number" value={f.experience_years} onChange={e=>set("experience_years",e.target.value)}/></Field>
      </div>
      <div style={{height:12}}/>
      <div className="rgrid c-sm" style={{"--gtc":"1fr 1fr",gap:12}}>
        <Field label="رقم الترخيص"><input className="input" value={f.license_number} onChange={e=>set("license_number",e.target.value)}/></Field>
        <Field label="أوقات العمل"><input className="input" value={f.schedule} onChange={e=>set("schedule",e.target.value)} placeholder="الأحد–الخميس 09:00–17:00"/></Field>
      </div>
      <div style={{height:12}}/>
      <Field label="ملاحظات"><textarea className="input" rows={2} value={f.notes} onChange={e=>set("notes",e.target.value)}/></Field>
      <div style={{height:12}}/>
      <div className="rgrid c-sm" style={{"--gtc":"1fr 1fr",gap:12}}>
        <Field label="التوفر"><select className="input" value={f.status} onChange={e=>set("status",e.target.value)}>{DOC_STATUS_OPTS.map(o=><option key={o.v} value={o.v}>{o.l}</option>)}</select></Field>
        <Field label="اللون"><input className="input" type="color" value={f.color} onChange={e=>set("color",e.target.value)} style={{padding:4,height:40}}/></Field>
      </div>
      <label style={{display:"flex",alignItems:"center",gap:8,fontSize:13,marginTop:14,cursor:"pointer"}}>
        <input type="checkbox" checked={f.active} onChange={e=>set("active",e.target.checked)}/> طبيب مفعّل (متاح للحجز)
      </label>
    </Modal>
  );
}

// ── Specialist modal (persists to `therapists` table) ────────
function SpecialistModal({ row, depts, onClose }) {
  const isNew = !row.id;
  const thsAll = (window.DATA && window.DATA.therapists) || [];
  const linkedRows = isNew ? thsAll : thsAll.filter(t => (t.id||t.pk) !== row.id);
  const [account, setAccount] = React.useState(
    isNew ? null : (row.auth_uid ? { auth_uid: row.auth_uid, name: row.name || "", email: row.email || "", role: "therapist" } : null)
  );
  const [f, setF] = React.useState({
    department_id: row.department_id || (depts[0] && depts[0].id) || "",
    spec: row.spec || "",
    phone: row.phone || "",
    license_number: row.license_number || "",
    notes: row.notes || "",
    color: row.color || "#7BBDE8",
    max: row.max != null ? row.max : 8,
    active: row.active !== false,
  });
  const [busy, setBusy] = React.useState(false);
  const set = (k,v) => setF(s => ({ ...s, [k]: v }));
  function pickAccount(u) {
    setAccount(u);
    if (u && u.phone && !f.phone) set("phone", u.phone);
  }
  async function save() {
    if (isNew && (!account || !account.auth_uid)) {
      return window.showToast && window.showToast("اختر حسابًا مرتبطًا للأخصائي","error");
    }
    if (!depts.length) return window.showToast && window.showToast("أضف قسمًا أولاً","error");
    if (!f.department_id) return window.showToast && window.showToast("اختر القسم","error");
    setBusy(true);
    try {
      const name = (account && account.name) ? account.name.trim() : (row.name || "").trim();
      const email = (account && account.email) ? account.email.trim() : (row.email || "").trim();
      const res = await window.KineticData.upsert("therapists", {
        id: row.id || newId("TH-"),
        auth_uid: (account && account.auth_uid) || row.auth_uid || null,
        name, email,
        department_id: f.department_id,
        spec: f.spec.trim() || null,
        phone: (f.phone || "").trim() || null,
        license_number: f.license_number.trim() || null,
        notes: f.notes.trim() || null,
        color: f.color, max: Number(f.max) || 0,
        active: !!f.active,
      });
      if (res && res._ok === false) throw new Error(friendlyRosterError(res._error, "أخصائي"));
      window.showToast && window.showToast(isNew ? "تمت إضافة الأخصائي" : "تم تحديث الأخصائي", "success");
      onClose();
    } catch (e) { console.error(e); window.showToast && window.showToast(e.message || "تعذّر الحفظ","error"); }
    finally { setBusy(false); }
  }
  return (
    <Modal title={isNew?"أخصائي جديد":"تعديل أخصائي"} onClose={onClose} width={600}
      footer={<><button className="btn btn-ghost" onClick={onClose}>إلغاء</button>
        <button className="btn btn-blue" disabled={busy} onClick={save}><I.Check size={13}/> حفظ</button></>}>
      <Field label="الحساب المرتبط" required hint={isNew ? "يظهر فقط حسابات دور «الأخصائي» غير المربوطة" : "الحساب المرتبط لا يتغيّر بعد الحفظ"}>
        <AuthUserPicker roleSlug="therapist" linkedRows={linkedRows} value={account} onChange={pickAccount} disabled={!isNew}/>
      </Field>
      <div style={{height:12}}/>
      {(account || !isNew) && (
        <>
          <div className="rgrid c-sm" style={{"--gtc":"1fr 1fr",gap:12}}>
            <Field label="الاسم"><input className="input" value={(account && account.name) || row.name || ""} disabled style={{opacity:.75}}/></Field>
            <Field label="البريد الإلكتروني"><input className="input" value={(account && account.email) || row.email || ""} disabled dir="ltr" style={{opacity:.75}}/></Field>
          </div>
          <div style={{height:12}}/>
        </>
      )}
      <div className="rgrid c-sm" style={{"--gtc":"1fr 1fr",gap:12}}>
        <Field label="القسم" required>
          <select className="input" value={f.department_id} onChange={e=>set("department_id",e.target.value)}>
            <option value="">— اختر —</option>
            {depts.map(d=><option key={d.id} value={d.id}>{d.name_ar}</option>)}
          </select>
        </Field>
        <Field label="التخصص"><input className="input" value={f.spec} onChange={e=>set("spec",e.target.value)}/></Field>
      </div>
      <div style={{height:12}}/>
      <div className="rgrid c-sm" style={{"--gtc":"1fr 1fr",gap:12}}>
        <Field label="الهاتف"><input className="input" value={f.phone} onChange={e=>set("phone",e.target.value)} placeholder="+20 …"/></Field>
        <Field label="الحد الأقصى للجلسات/يوم"><input className="input" type="number" min="0" max="60" value={f.max} onChange={e=>set("max",e.target.value)}/></Field>
      </div>
      <div style={{height:12}}/>
      <div className="rgrid c-sm" style={{"--gtc":"1fr 1fr",gap:12}}>
        <Field label="رقم الترخيص (اختياري)"><input className="input" value={f.license_number} onChange={e=>set("license_number",e.target.value)}/></Field>
        <Field label="اللون"><input className="input" type="color" value={f.color} onChange={e=>set("color",e.target.value)} style={{padding:4,height:40}}/></Field>
      </div>
      <div style={{height:12}}/>
      <Field label="ملاحظات"><textarea className="input" rows={2} value={f.notes} onChange={e=>set("notes",e.target.value)}/></Field>
      <label style={{display:"flex",alignItems:"center",gap:8,fontSize:13,marginTop:14,cursor:"pointer"}}>
        <input type="checkbox" checked={f.active} onChange={e=>set("active",e.target.checked)}/> أخصائي مفعّل (متاح للتعيين)
      </label>
    </Modal>
  );
}

// ── Receptionist modal (persists to `receptionists` table) ───
function ReceptionistModal({ row, onClose }) {
  const isNew = !row.id;
  const rcpAll = (window.DATA && window.DATA.receptionists) || [];
  const linkedRows = isNew ? rcpAll : rcpAll.filter(r => (r.id||r.pk) !== row.id);
  const [account, setAccount] = React.useState(
    isNew ? null : (row.auth_uid ? { auth_uid: row.auth_uid, name: row.name || "", email: row.email || "", role: "receptionist" } : null)
  );
  const [f, setF] = React.useState({
    phone: row.phone || "",
    notes: row.notes || "",
    active: row.active !== false,
  });
  const [busy, setBusy] = React.useState(false);
  const set = (k,v) => setF(s => ({ ...s, [k]: v }));
  function pickAccount(u) {
    setAccount(u);
    if (u && u.phone && !f.phone) set("phone", u.phone);
  }
  async function save() {
    if (isNew && (!account || !account.auth_uid)) {
      return window.showToast && window.showToast("اختر حسابًا مرتبطًا لموظف الاستقبال","error");
    }
    setBusy(true);
    try {
      const name = (account && account.name) ? account.name.trim() : (row.name || "").trim();
      const email = (account && account.email) ? account.email.trim() : (row.email || "").trim();
      const res = await window.KineticData.upsert("receptionists", {
        id: row.id || newId("RC-"),
        auth_uid: (account && account.auth_uid) || row.auth_uid || null,
        name, email,
        phone: (f.phone || "").trim() || null,
        notes: f.notes.trim() || null,
        active: !!f.active,
      });
      if (res && res._ok === false) throw new Error(friendlyRosterError(res._error, "موظف استقبال"));
      window.showToast && window.showToast(isNew ? "تمت إضافة موظف الاستقبال" : "تم التحديث", "success");
      onClose();
    } catch (e) { console.error(e); window.showToast && window.showToast(e.message || "تعذّر الحفظ","error"); }
    finally { setBusy(false); }
  }
  return (
    <Modal title={isNew?"موظف استقبال جديد":"تعديل موظف استقبال"} onClose={onClose} width={520}
      footer={<><button className="btn btn-ghost" onClick={onClose}>إلغاء</button>
        <button className="btn btn-blue" disabled={busy} onClick={save}><I.Check size={13}/> حفظ</button></>}>
      <Field label="الحساب المرتبط" required hint={isNew ? "يظهر فقط حسابات دور «موظف الاستقبال» غير المربوطة" : "الحساب المرتبط لا يتغيّر بعد الحفظ"}>
        <AuthUserPicker roleSlug="receptionist" linkedRows={linkedRows} value={account} onChange={pickAccount} disabled={!isNew}/>
      </Field>
      <div style={{height:12}}/>
      {(account || !isNew) && (
        <>
          <div className="rgrid c-sm" style={{"--gtc":"1fr 1fr",gap:12}}>
            <Field label="الاسم"><input className="input" value={(account && account.name) || row.name || ""} disabled style={{opacity:.75}}/></Field>
            <Field label="البريد الإلكتروني"><input className="input" value={(account && account.email) || row.email || ""} disabled dir="ltr" style={{opacity:.75}}/></Field>
          </div>
          <div style={{height:12}}/>
        </>
      )}
      <Field label="الهاتف"><input className="input" value={f.phone} onChange={e=>set("phone",e.target.value)} placeholder="+20 …"/></Field>
      <div style={{height:12}}/>
      <Field label="ملاحظات"><textarea className="input" rows={3} value={f.notes} onChange={e=>set("notes",e.target.value)}/></Field>
      <label style={{display:"flex",alignItems:"center",gap:8,fontSize:13,marginTop:14,cursor:"pointer"}}>
        <input type="checkbox" checked={f.active} onChange={e=>set("active",e.target.checked)}/> موظف استقبال مفعّل
      </label>
    </Modal>
  );
}

// ── Admin: user management (create logins, reset passwords) ───
const ROLE_AR = { admin:"مدير", receptionist:"موظف استقبال", doctor:"طبيب", therapist:"الأخصائي" };
const ROLE_OPTIONS = [
  { slug:"admin", label:"مدير" },
  { slug:"receptionist", label:"موظف استقبال" },
  { slug:"doctor", label:"طبيب" },
  { slug:"therapist", label:"الأخصائي" },
];
const roleBadgeClass = (slug) => slug==="admin" ? "b-violet" : slug==="doctor" ? "b-blue" : slug==="therapist" ? "b-green" : "b-grey";

// Styled confirmation dialog (used before destructive / sensitive admin
// actions). Two-button footer, busy spinner, optional danger styling.
function ConfirmModal({ title, message, confirmLabel="تأكيد", cancelLabel="إلغاء", danger=false, busy=false, onConfirm, onClose }) {
  return (
    <Modal title={title} onClose={busy?undefined:onClose} width={440}
      footer={<>
        <button className="btn btn-ghost" onClick={onClose} disabled={busy}>{cancelLabel}</button>
        <button className={"btn " + (danger?"btn-secondary":"btn-blue")} style={danger?{color:"var(--red)",borderColor:"var(--red-bg)"}:undefined} disabled={busy} onClick={onConfirm}>
          {busy ? <span className="spin" style={{width:14,height:14,border:"2px solid currentColor",borderTopColor:"transparent",borderRadius:"50%"}}/> : <><I.Check size={13}/> {confirmLabel}</>}
        </button>
      </>}>
      <div style={{fontSize:13.5,color:"var(--ink-700)",lineHeight:1.7}}>{message}</div>
    </Modal>
  );
}

// Staff account status → badge metadata. Anything other than an explicit
// 'inactive' reads as active (matches the DB default).
function staffStatusMeta(s) {
  const active = String((s && s.status) || "active") !== "inactive";
  return active
    ? { active:true,  label:"نشط",   cls:"b-green" }
    : { active:false, label:"معطّل", cls:"b-grey"  };
}

function UsersPanel() {
  const me = window.ME || {};
  const staff = DATA.staff || [];
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editRow, setEditRow] = React.useState(null);   // staff row being edited
  const [pwOpen, setPwOpen] = React.useState(false);     // change MY password
  const [profileOpen, setProfileOpen] = React.useState(false); // edit MY name
  const [resetRow, setResetRow] = React.useState(null);  // admin reset a teammate's pw
  const [statusRow, setStatusRow] = React.useState(null);// { row, active } pending status change
  const [statusBusy, setStatusBusy] = React.useState(false);

  const isMe = (s) => me.email && (s.email || "").toLowerCase() === (me.email || "").toLowerCase();

  async function removeMember(s) {
    if (!window.confirm(`إزالة ${s.name}؟ (يزيل صف الموظف؛ حساب الدخول يُحذف من Supabase)`)) return;
    try {
      await window.KineticData.remove("staff", s.staff_id || s.id);
      window.showToast && window.showToast(`تم إزالة ${s.name}`, "success");
    } catch (e) { console.warn(e); window.showToast && window.showToast("تعذّر الإزالة", "error"); }
  }

  async function applyStatus() {
    if (!statusRow) return;
    const { row, active } = statusRow;
    setStatusBusy(true);
    const res = await window.adminSetStaffStatus({ staff_id: row.staff_id || row.id, active });
    setStatusBusy(false);
    if (res.ok) window.showToast && window.showToast(active ? `تم تفعيل حساب ${row.name}` : `تم تعطيل حساب ${row.name}`, "success");
    else window.showToast && window.showToast(res.error || "تعذّر تنفيذ العملية", "error");
    setStatusRow(null);
  }

  return (
    <div>
      {/* My account */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16,gap:12,flexWrap:"wrap"}}>
        <div>
          <div className="h2">المستخدمون والأدوار</div>
          <div className="muted" style={{fontSize:12.5,marginTop:2}}>أنشئ حسابات الدخول، عيّن الأدوار، أعد تعيين كلمات المرور، وفعّل أو عطّل الحسابات.</div>
        </div>
        <button className="btn btn-blue" onClick={()=>setCreateOpen(true)}><I.Plus size={14}/> إنشاء مستخدم</button>
      </div>

      <div className="card" style={{padding:14,marginBottom:18,display:"flex",alignItems:"center",gap:14,flexWrap:"wrap",background:"var(--blue-50)",border:"1px solid var(--blue-100)"}}>
        <div className="av md" style={{background:"var(--blue-500)",color:"#fff"}}>{(me.name||"?").split(" ").map(x=>x[0]||"").join("").slice(0,2)}</div>
        <div style={{flex:1,minWidth:160}}>
          <div style={{fontWeight:600,fontSize:13.5}}>{me.name || "حسابي"} <span className="badge b-violet" style={{marginInlineStart:6}}><span className="dot"></span>{me.role || "مدير"}</span></div>
          <div className="mono muted" style={{fontSize:12}}>{me.email || "—"}</div>
        </div>
        <button className="btn btn-secondary" style={{fontSize:12.5}} onClick={()=>setProfileOpen(true)}><I.Edit size={13}/> تعديل اسمي</button>
        <button className="btn btn-secondary" style={{fontSize:12.5}} onClick={()=>setPwOpen(true)}><I.Lock size={13}/> تغيير كلمة المرور</button>
      </div>

      {/* Team table */}
      <div className="tbl-scroll">
      <table className="tbl">
        <thead><tr><th>الاسم</th><th>البريد الإلكتروني</th><th>الدور</th><th>حالة الحساب</th><th></th></tr></thead>
        <tbody>
          {staff.length===0 && (
            <tr><td colSpan={5}><EmptyState icon={<I.Users size={22}/>} title="لا مستخدمين بعد" body="أنشئ أول حساب دخول من زر «إنشاء مستخدم»."/></td></tr>
          )}
          {staff.map((s,i)=>{
            const st = staffStatusMeta(s);
            const mine = isMe(s);
            return (
            <tr key={s.staff_id||s.id||i} data-selected={st.active?undefined:"true"} style={st.active?undefined:{opacity:.85}}>
              <td><div style={{display:"flex",alignItems:"center",gap:10}}>
                <div className="av sm">{(s.name||"?").split(" ").map(x=>x[0]||"").join("").slice(0,2)}</div>
                {s.name}{mine && <span className="muted" style={{fontSize:11}}>(أنا)</span>}
              </div></td>
              <td className="mono" style={{fontSize:12}}>{s.email || "—"}</td>
              <td><span className={"badge " + roleBadgeClass(s.role)}><span className="dot"></span>{ROLE_AR[s.role] || s.role || "—"}</span></td>
              <td><span className={"badge " + st.cls}><span className="dot"></span>{st.label}</span></td>
              <td>
                <RowMenu size={13} items={[
                  mine
                    ? { label:"تغيير كلمة المرور", icon:<I.Lock size={13}/>, onClick:()=>setPwOpen(true) }
                    : { label:"إعادة تعيين كلمة المرور", icon:<I.Lock size={13}/>, onClick:()=>setResetRow(s) },
                  { label:"تعديل البيانات", icon:<I.Edit size={13}/>, onClick:()=>setEditRow(s) },
                  ...(mine ? [] : [ st.active
                    ? { label:"تعطيل الحساب", icon:<I.Lock size={13}/>, danger:true, onClick:()=>setStatusRow({ row:s, active:false }) }
                    : { label:"إعادة تفعيل الحساب", icon:<I.Check size={13}/>, onClick:()=>setStatusRow({ row:s, active:true }) }
                  ]),
                  { label:"نسخ البريد", icon:<I.Mail size={13}/>, onClick:()=>{ try{ navigator.clipboard.writeText(s.email||""); window.showToast&&window.showToast("تم نسخ البريد","success"); }catch(_){} } },
                  ...(mine ? [] : [{ label:"إزالة الموظف", icon:<I.Trash size={13}/>, danger:true, onClick:()=>removeMember(s) }]),
                ]}/>
              </td>
            </tr>
          );})}
        </tbody>
      </table>
      </div>

      {createOpen && <CreateUserModal onClose={()=>setCreateOpen(false)}/>}
      {editRow && <EditUserModal row={editRow} onClose={()=>setEditRow(null)}/>}
      {pwOpen && <ChangePasswordModal onClose={()=>setPwOpen(false)}/>}
      {profileOpen && <EditProfileModal onClose={()=>setProfileOpen(false)}/>}
      {resetRow && <AdminResetPasswordModal row={resetRow} onClose={()=>setResetRow(null)}/>}
      {statusRow && (
        <ConfirmModal
          title={statusRow.active ? "إعادة تفعيل الحساب" : "تعطيل الحساب"}
          danger={!statusRow.active}
          busy={statusBusy}
          confirmLabel={statusRow.active ? "تفعيل" : "تعطيل"}
          onConfirm={applyStatus}
          onClose={()=>setStatusRow(null)}
          message={statusRow.active
            ? <>سيتمكّن <b>{statusRow.row.name}</b> ({statusRow.row.email || "—"}) من تسجيل الدخول مجددًا بنفس البريد وكلمة المرور. لا يتأثر أي من بياناته.</>
            : <>سيُمنع <b>{statusRow.row.name}</b> ({statusRow.row.email || "—"}) من تسجيل الدخول وستُنهى جلساته الحالية فورًا. تبقى جميع بياناته ومواعيده وجلساته وسجل التدقيق كما هي، ويمكن إعادة التفعيل لاحقًا.</>}
        />
      )}
    </div>
  );
}

// Admin: force-set a teammate's password without knowing the current one.
// Collects a new password, then requires an explicit confirmation step
// before calling the admin-reset-password Edge Function. Never displays or
// transmits any password hash.
function AdminResetPasswordModal({ row, onClose }) {
  const [pw, setPw] = React.useState("");
  const [pw2, setPw2] = React.useState("");
  const [showPw, setShowPw] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  function proceed() {
    if (pw.length < 6) { window.showToast && window.showToast("كلمة المرور 6 أحرف على الأقل", "error"); return; }
    if (pw !== pw2) { window.showToast && window.showToast("كلمتا المرور غير متطابقتين", "error"); return; }
    setConfirming(true);
  }
  async function submit() {
    setBusy(true);
    const res = await window.adminResetPassword({ staff_id: row.staff_id || row.id, auth_uid: row.auth_uid, password: pw });
    setBusy(false);
    if (res.ok) { window.showToast && window.showToast(res.demo ? "وضع تجريبي: لم تُحفظ" : `تم تغيير كلمة مرور ${row.name}`, "success"); onClose(); }
    else { window.showToast && window.showToast(res.error || "تعذّر التغيير", "error"); setConfirming(false); }
  }

  if (confirming) {
    return (
      <ConfirmModal
        title="تأكيد إعادة التعيين"
        busy={busy}
        confirmLabel="تأكيد وتغيير"
        onConfirm={submit}
        onClose={()=>setConfirming(false)}
        message={<>سيتم تعيين كلمة مرور جديدة للموظف <b>{row.name}</b> ({row.email || "—"}). سيستخدم كلمة المرور الجديدة في تسجيل الدخول القادم. لا يلزم إدخال كلمة المرور الحالية.</>}
      />
    );
  }

  return (
    <Modal title={`إعادة تعيين كلمة مرور — ${row.name}`} onClose={onClose}
      footer={<>
        <button className="btn btn-ghost" onClick={onClose}>إلغاء</button>
        <button className="btn btn-blue" onClick={proceed}><I.Lock size={13}/> متابعة</button>
      </>}>
      <div className="muted" style={{fontSize:12,marginBottom:14,padding:"10px 12px",background:"var(--ink-50)",borderRadius:8,lineHeight:1.6}}>
        <I.Lock size={11} style={{marginInlineEnd:4}}/> بصفتك مديرًا، يمكنك تعيين كلمة مرور جديدة لهذا الموظف دون معرفة كلمته الحالية. تُنفَّذ العملية عبر Supabase Auth الآمن.
      </div>
      <Field label="كلمة المرور الجديدة" required hint="6 أحرف على الأقل">
        <div style={{position:"relative"}}>
          <input className="input" type={showPw?"text":"password"} value={pw} onChange={e=>setPw(e.target.value)} style={{paddingRight:38}} autoFocus/>
          <button type="button" onClick={()=>setShowPw(s=>!s)} style={{position:"absolute",right:6,top:5,padding:6,border:"none",background:"transparent",cursor:"pointer",color:"var(--ink-500)"}}><I.Eye size={15}/></button>
        </div>
      </Field>
      <div style={{height:12}}/>
      <Field label="تأكيد كلمة المرور" required>
        <input className="input" type={showPw?"text":"password"} value={pw2} onChange={e=>setPw2(e.target.value)}/>
      </Field>
    </Modal>
  );
}

function CreateUserModal({ onClose }) {
  const [form, setForm] = React.useState({ name:"", email:"", password:"", role:"receptionist" });
  const [busy, setBusy] = React.useState(false);
  const [showPw, setShowPw] = React.useState(false);
  const set = (k,v)=>setForm(f=>({...f,[k]:v}));
  async function submit() {
    setBusy(true);
    const res = await window.adminCreateUser(form);
    setBusy(false);
    if (!res.ok) { window.showToast && window.showToast(res.error || "تعذّر إنشاء المستخدم", "error"); return; }
    if (res.needsConfirm) window.showToast && window.showToast("تم الإنشاء — على المستخدم تأكيد بريده قبل الدخول", "success");
    else window.showToast && window.showToast(res.demo ? "تم الإنشاء (وضع تجريبي)" : "تم إنشاء المستخدم", "success");
    onClose();
  }
  return (
    <Modal title="إنشاء مستخدم جديد" onClose={onClose}
      footer={<>
        <button className="btn btn-ghost" onClick={onClose}>إلغاء</button>
        <button className="btn btn-blue" disabled={busy} onClick={submit}>
          {busy ? <span className="spin" style={{width:14,height:14,border:"2px solid #fff",borderTopColor:"transparent",borderRadius:"50%"}}/> : <><I.Check size={13}/> إنشاء الحساب</>}
        </button>
      </>}>
      <Field label="الاسم الكامل" required>
        <input className="input" value={form.name} onChange={e=>set("name",e.target.value)} placeholder="مثال: دينا فؤاد"/>
      </Field>
      <div style={{height:12}}/>
      <Field label="البريد الإلكتروني" required>
        <input className="input" type="email" value={form.email} onChange={e=>set("email",e.target.value)} placeholder="user@clinic.eg"/>
      </Field>
      <div style={{height:12}}/>
      <Field label="كلمة المرور" required hint="6 أحرف على الأقل">
        <div style={{position:"relative"}}>
          <input className="input" type={showPw?"text":"password"} value={form.password} onChange={e=>set("password",e.target.value)} style={{paddingRight:38}}/>
          <button type="button" onClick={()=>setShowPw(s=>!s)} style={{position:"absolute",right:6,top:5,padding:6,border:"none",background:"transparent",cursor:"pointer",color:"var(--ink-500)"}}><I.Eye size={15}/></button>
        </div>
      </Field>
      <div style={{height:12}}/>
      <Field label="الدور" required>
        <select className="input" value={form.role} onChange={e=>set("role",e.target.value)}>
          {ROLE_OPTIONS.map(r=><option key={r.slug} value={r.slug}>{r.label}</option>)}
        </select>
      </Field>
      <div className="muted" style={{fontSize:11.5,marginTop:14,lineHeight:1.6,padding:"10px 12px",background:"var(--ink-50)",borderRadius:8}}>
        <I.Lock size={11} style={{marginInlineEnd:4}}/> لدخول فوري، عطّل «تأكيد البريد» في Supabase (Authentication → Providers → Email). وإلا يستلم المستخدم رابط تأكيد على بريده.
      </div>
    </Modal>
  );
}

function EditUserModal({ row, onClose }) {
  const [name, setName] = React.useState(row.name || "");
  const [role, setRole] = React.useState(row.role || "receptionist");
  const [busy, setBusy] = React.useState(false);
  async function submit() {
    setBusy(true);
    const res = await window.updateStaffMember(row.staff_id || row.id, { name: name.trim(), role });
    setBusy(false);
    if (res.ok) window.showToast && window.showToast("تم حفظ التغييرات", "success");
    else window.showToast && window.showToast(res.error || "تعذّر الحفظ", "error");
    onClose();
  }
  const roleChanged = role !== (row.role || "receptionist");
  return (
    <Modal title={`تعديل ${row.name || "المستخدم"}`} onClose={onClose}
      footer={<>
        <button className="btn btn-ghost" onClick={onClose}>إلغاء</button>
        <button className="btn btn-blue" disabled={busy} onClick={submit}><I.Check size={13}/> حفظ</button>
      </>}>
      <Field label="الاسم"><input className="input" value={name} onChange={e=>setName(e.target.value)}/></Field>
      <div style={{height:12}}/>
      <Field label="البريد الإلكتروني" hint="لا يمكن تغييره من هنا">
        <input className="input" value={row.email || "—"} disabled style={{opacity:.7}}/>
      </Field>
      <div style={{height:12}}/>
      <Field label="الدور">
        <select className="input" value={role} onChange={e=>setRole(e.target.value)}>
          {ROLE_OPTIONS.map(r=><option key={r.slug} value={r.slug}>{r.label}</option>)}
        </select>
      </Field>
      {roleChanged && (
        <div className="muted" style={{fontSize:11.5,marginTop:12,lineHeight:1.6,padding:"10px 12px",background:"var(--ink-50)",borderRadius:8}}>
          صلاحيات الدخول الفعلية تُقرأ من حساب Supabase الخاص بالمستخدم. لتفعيل الدور الجديد بالكامل يعيد المستخدم تسجيل الدخول، وقد يتطلب تحديث بيانات الحساب من لوحة Supabase.
        </div>
      )}
    </Modal>
  );
}

function ChangePasswordModal({ onClose }) {
  const [pw, setPw] = React.useState("");
  const [pw2, setPw2] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [showPw, setShowPw] = React.useState(false);
  async function submit() {
    if (pw !== pw2) { window.showToast && window.showToast("كلمتا المرور غير متطابقتين", "error"); return; }
    setBusy(true);
    const res = await window.updateOwnPassword(pw);
    setBusy(false);
    if (res.ok) { window.showToast && window.showToast(res.demo ? "وضع تجريبي: لم تُحفظ" : "تم تغيير كلمة المرور", "success"); onClose(); }
    else window.showToast && window.showToast(res.error || "تعذّر التغيير", "error");
  }
  return (
    <Modal title="تغيير كلمة المرور" onClose={onClose}
      footer={<>
        <button className="btn btn-ghost" onClick={onClose}>إلغاء</button>
        <button className="btn btn-blue" disabled={busy} onClick={submit}><I.Check size={13}/> حفظ</button>
      </>}>
      <Field label="كلمة المرور الجديدة" required hint="6 أحرف على الأقل">
        <div style={{position:"relative"}}>
          <input className="input" type={showPw?"text":"password"} value={pw} onChange={e=>setPw(e.target.value)} style={{paddingRight:38}}/>
          <button type="button" onClick={()=>setShowPw(s=>!s)} style={{position:"absolute",right:6,top:5,padding:6,border:"none",background:"transparent",cursor:"pointer",color:"var(--ink-500)"}}><I.Eye size={15}/></button>
        </div>
      </Field>
      <div style={{height:12}}/>
      <Field label="تأكيد كلمة المرور" required>
        <input className="input" type={showPw?"text":"password"} value={pw2} onChange={e=>setPw2(e.target.value)}/>
      </Field>
    </Modal>
  );
}

function EditProfileModal({ onClose }) {
  const [name, setName] = React.useState((window.ME && window.ME.name) || "");
  const [busy, setBusy] = React.useState(false);
  async function submit() {
    setBusy(true);
    const res = await window.updateOwnProfile({ name });
    setBusy(false);
    if (res.ok) { window.showToast && window.showToast("تم حفظ الملف", "success"); onClose(); }
    else window.showToast && window.showToast(res.error || "تعذّر الحفظ", "error");
  }
  return (
    <Modal title="تعديل ملفي" onClose={onClose}
      footer={<>
        <button className="btn btn-ghost" onClick={onClose}>إلغاء</button>
        <button className="btn btn-blue" disabled={busy} onClick={submit}><I.Check size={13}/> حفظ</button>
      </>}>
      <Field label="الاسم"><input className="input" value={name} onChange={e=>setName(e.target.value)}/></Field>
    </Modal>
  );
}

// ── Admin: Clinic details (name, contact, tax id) ────────────
function ClinicDetailsPanel() {
  // Production reads authoritatively from clinic_settings. No demo seed.
  const seedFromForm = (src) => ({
    name: src.name || "",
    branch: src.branch || "",
    phone: src.phone || "",
    email: src.email || "",
    address: src.address || "",
    tax_id: src.tax_id || "",
    hours: src.hours || "",
    website: src.website || "",
    currency: src.currency || "EGP",
    timezone: src.timezone || "Africa/Cairo",
    appointment_duration: src.appointment_duration != null ? String(src.appointment_duration) : "30",
    calendar_start: src.calendar_start || "08:00",
    calendar_end: src.calendar_end || "18:00",
  });
  const [form, setForm] = React.useState(() => seedFromForm(window.CLINIC || {}));
  const [saving, setSaving] = React.useState(false);
  const [loading, setLoading] = React.useState(true);

  // Fresh-fetch from DB on mount so what's rendered is what's persisted —
  // this is the fix for "settings appear saved then revert on refresh".
  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (window.loadClinic) {
          const fresh = await window.loadClinic();
          if (alive && fresh) setForm(seedFromForm(fresh));
        }
      } catch (e) {
        console.warn("clinic reload failed", e);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  async function onSave() {
    if (!form.name.trim()) { if (window.showToast) window.showToast("أدخل اسم العيادة","error"); return; }
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
      if (window.showToast) window.showToast("صيغة البريد الإلكتروني غير صحيحة","error"); return;
    }
    const dur = parseInt(form.appointment_duration, 10);
    if (!Number.isFinite(dur) || dur < 5 || dur > 240) {
      if (window.showToast) window.showToast("مدة الجلسة بين 5 و 240 دقيقة","error"); return;
    }
    const hm = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!hm.test(form.calendar_start) || !hm.test(form.calendar_end)) {
      if (window.showToast) window.showToast("أدخل بداية ونهاية دوام صحيحتين (HH:MM)","error"); return;
    }
    if (form.calendar_end <= form.calendar_start) {
      if (window.showToast) window.showToast("نهاية الدوام يجب أن تكون بعد بدايته","error"); return;
    }
    if (!window.saveClinic) {
      if (window.showToast) window.showToast("قاعدة البيانات غير متصلة","error");
      return;
    }
    setSaving(true);
    try {
      const payload = { ...form, appointment_duration: dur };
      const fresh = await window.saveClinic(payload);
      setForm(seedFromForm(fresh));
      if (window.showToast) window.showToast("تم حفظ التغييرات","success");
    } catch (e) {
      console.error("save clinic details failed", e);
      const msg = (e && e.message) ? e.message : "تعذّر حفظ التغييرات";
      if (window.showToast) window.showToast(msg, "error");
    } finally { setSaving(false); }
  }
  return (
    <div>
      <div className="h2" style={{marginBottom:18}}>بيانات العيادة</div>
      {loading && <div className="muted" style={{fontSize:12,marginBottom:10}}>جاري تحميل البيانات…</div>}
      <div className="rgrid c-sm" style={{"--gtc":"repeat(2,1fr)",gap:14,maxWidth:720}}>
        <Field label="اسم العيادة" span={2}><input className="input" value={form.name} onChange={e=>set("name", e.target.value)}/></Field>
        <Field label="الفرع" span={2}><input className="input" value={form.branch} onChange={e=>set("branch", e.target.value)}/></Field>
        <Field label="الهاتف"><input className="input" value={form.phone} onChange={e=>set("phone", e.target.value)}/></Field>
        <Field label="البريد الإلكتروني"><input className="input" value={form.email} onChange={e=>set("email", e.target.value)}/></Field>
        <Field label="العنوان" span={2}><input className="input" value={form.address} onChange={e=>set("address", e.target.value)}/></Field>
        <Field label="الرقم الضريبي"><input className="input" value={form.tax_id} onChange={e=>set("tax_id", e.target.value)}/></Field>
        <Field label="ساعات العمل"><input className="input" value={form.hours} onChange={e=>set("hours", e.target.value)}/></Field>
        <Field label="الموقع الإلكتروني" span={2}><input className="input" value={form.website} onChange={e=>set("website", e.target.value)} placeholder="https://…"/></Field>
        <Field label="العملة">
          <select className="input" value={form.currency} onChange={e=>set("currency", e.target.value)}>
            <option value="EGP">جنيه مصري (EGP)</option>
            <option value="SAR">ريال سعودي (SAR)</option>
            <option value="AED">درهم إماراتي (AED)</option>
            <option value="USD">دولار أمريكي (USD)</option>
            <option value="EUR">يورو (EUR)</option>
          </select>
        </Field>
        <Field label="المنطقة الزمنية">
          <select className="input" value={form.timezone} onChange={e=>set("timezone", e.target.value)}>
            <option value="Africa/Cairo">القاهرة (Africa/Cairo)</option>
            <option value="Asia/Riyadh">الرياض (Asia/Riyadh)</option>
            <option value="Asia/Dubai">دبي (Asia/Dubai)</option>
            <option value="Asia/Amman">عمّان (Asia/Amman)</option>
          </select>
        </Field>
        <Field label="بداية دوام التقويم" hint="أول موعد يظهر في التقويم">
          <input className="input" type="time" value={form.calendar_start}
                 onChange={e=>set("calendar_start", e.target.value)}/>
        </Field>
        <Field label="نهاية دوام التقويم" hint="آخر موعد يظهر في التقويم">
          <input className="input" type="time" value={form.calendar_end}
                 onChange={e=>set("calendar_end", e.target.value)}/>
        </Field>
        <Field label="مدة الجلسة (دقيقة)" span={2} hint="تُستخدم كمدة الخانة في التقويم وكل شاشات اختيار الوقت">
          <input className="input" type="number" min="5" max="240" step="5"
                 value={form.appointment_duration}
                 onChange={e=>set("appointment_duration", e.target.value)}/>
        </Field>
      </div>
      <button className="btn btn-blue" style={{marginTop:18}} disabled={saving||loading} onClick={onSave}>
        <I.Check size={13}/> {saving ? "جاري الحفظ…" : "حفظ التغييرات"}
      </button>
    </div>
  );
}

// 404
// ── Admin: Clinic branding (logo + name) ─────────────────────
function BrandingPanel() {
  // Seed from window.CLINIC (which loadClinic() hydrates from Postgres);
  // no hardcoded names — the name field starts empty until DB responds.
  const [clinic, setClinic] = React.useState(window.CLINIC || { name:"", subtitle:"", logo:null, primary_color:"#7BBDE8" });
  const [saving, setSaving] = React.useState(false);
  const fileRef = React.useRef(null);
  // Reload from Postgres on mount so we don't render a stale in-memory
  // copy — matches ClinicDetailsPanel's fresh-fetch guarantee.
  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (window.loadClinic) {
          const fresh = await window.loadClinic();
          if (alive && fresh) setClinic(fresh);
        }
      } catch (e) { console.warn("branding reload failed", e); }
    })();
    return () => { alive = false; };
  }, []);

  function onPickFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      if (window.showToast) window.showToast("يجب اختيار ملف صورة","error");
      return;
    }
    if (file.size > 512*1024) {
      if (window.showToast) window.showToast("حجم الصورة أكبر من 512KB","error");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setClinic(c => ({ ...c, logo: reader.result }));
    reader.readAsDataURL(file);
  }

  async function onSave() {
    if (!window.saveClinic) {
      if (window.showToast) window.showToast("قاعدة البيانات غير متصلة","error");
      return;
    }
    setSaving(true);
    try {
      const fresh = await window.saveClinic(clinic);
      setClinic(fresh);
      if (window.showToast) window.showToast("تم حفظ الهوية البصرية","success");
    } catch (e) {
      console.error("save branding failed", e);
      const msg = (e && e.message) ? e.message : "تعذّر حفظ الهوية البصرية";
      if (window.showToast) window.showToast(msg,"error");
    } finally { setSaving(false); }
  }

  return (
    <div>
      <div className="h2" style={{marginBottom:6}}>الهوية البصرية</div>
      <div className="muted" style={{fontSize:13,marginBottom:18}}>خصّص شعار العيادة واسمها الظاهر في كل الشاشات.</div>

      <div className="rgrid c-sm" style={{"--gtc":"180px 1fr",gap:24,alignItems:"start",maxWidth:720}}>
        <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:10}}>
          <div style={{width:140,height:140,borderRadius:20,border:"1px dashed var(--ink-300)",background:"var(--ink-50)",display:"flex",alignItems:"center",justifyContent:"center",overflow:"hidden"}}>
            {clinic.logo
              ? <img src={clinic.logo} alt="logo" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
              : <I.Image size={40} style={{color:"var(--ink-300)"}}/>}
          </div>
          <input ref={fileRef} type="file" accept="image/*" style={{display:"none"}} onChange={onPickFile}/>
          <div style={{display:"flex",gap:6}}>
            <button className="btn btn-secondary" style={{fontSize:12}} onClick={()=>fileRef.current && fileRef.current.click()}>
              <I.Upload size={12}/> رفع شعار
            </button>
            {clinic.logo && (
              <button className="btn btn-ghost" style={{fontSize:12}} onClick={()=>setClinic(c=>({...c,logo:null}))}>
                <I.Trash size={12}/> إزالة
              </button>
            )}
          </div>
          <div className="muted" style={{fontSize:11,textAlign:"center"}}>PNG/JPG · حتى 512KB</div>
        </div>

        <div className="rgrid c-sm" style={{"--gtc":"repeat(2,1fr)",gap:14}}>
          <Field label="اسم العيادة" span={2}>
            <input className="input" value={clinic.name||""} onChange={e=>setClinic(c=>({...c,name:e.target.value}))}/>
          </Field>
          <Field label="العنوان الفرعي" span={2}>
            <input className="input" value={clinic.subtitle||""} onChange={e=>setClinic(c=>({...c,subtitle:e.target.value}))}/>
          </Field>
          <Field label="اللون الأساسي">
            <input className="input" type="color" value={clinic.primary||"#7BBDE8"} onChange={e=>setClinic(c=>({...c,primary:e.target.value}))}/>
          </Field>
        </div>
      </div>

      <button className="btn btn-blue" style={{marginTop:22}} disabled={saving} onClick={onSave}>
        <I.Check size={13}/> {saving ? "جاري الحفظ…" : "حفظ التغييرات"}
      </button>
    </div>
  );
}

// ── Admin: Custom sections management ────────────────────────
const CUSTOM_SECTION_ICONS = ["Layers","Clipboard","FileText","Chart","Activity","Package","Heart","Sparkle","Pin","Megaphone","Users","Calendar"];

function CustomSectionsPanel() {
  const [sections, setSections] = React.useState(window.CUSTOM_SECTIONS || []);
  const [editing, setEditing] = React.useState(null);
  React.useEffect(()=>{
    const h = ()=> setSections([...(window.CUSTOM_SECTIONS || [])]);
    window.addEventListener("kinetic:sections-updated", h);
    return ()=> window.removeEventListener("kinetic:sections-updated", h);
  },[]);

  function startNew() {
    setEditing({ id:null, label:"", slug:"", icon:"Layers", group:"مخصص", description:"", content:"", visible:true });
  }
  async function onDelete(s) {
    if (!confirm(`حذف قسم "${s.label}"؟`)) return;
    if (window.removeSection) await window.removeSection(s.id);
    if (window.showToast) window.showToast("تم حذف القسم","success");
  }

  return (
    <div>
      <div className="page-head" style={{marginBottom:12}}>
        <div>
          <div className="h2" style={{marginBottom:4}}>أقسام مخصصة</div>
          <div className="muted" style={{fontSize:13}}>أضف أقسامًا تظهر في الشريط الجانبي للمدير وعدّل محتواها.</div>
        </div>
        <button className="btn btn-blue" onClick={startNew}><I.Plus size={13}/> قسم جديد</button>
      </div>

      {sections.length === 0 ? (
        <EmptyState icon={<I.Layers size={22}/>} title="لا توجد أقسام مخصصة بعد" body="اضغط «قسم جديد» لإضافة قسم يظهر في القائمة الجانبية."/>
      ) : (
        <div className="tbl-scroll">
        <table className="tbl">
          <thead><tr><th>القسم</th><th>المجموعة</th><th>الحالة</th><th></th></tr></thead>
          <tbody>
            {sections.map(s=>{
              const Ico = I[s.icon] || I.Layers;
              return (
                <tr key={s.id}>
                  <td>
                    <div style={{display:"flex",alignItems:"center",gap:10}}>
                      <div style={{width:30,height:30,borderRadius:8,background:"var(--blue-100)",color:"var(--blue-700)",display:"flex",alignItems:"center",justifyContent:"center"}}>
                        <Ico size={15}/>
                      </div>
                      <div>
                        <div style={{fontSize:13,fontWeight:600}}>{s.label}</div>
                        <div className="mono muted" style={{fontSize:11}}>/{s.slug}</div>
                      </div>
                    </div>
                  </td>
                  <td>{s.group}</td>
                  <td><span className={"badge " + (s.visible!==false?"b-green":"b-grey")}><span className="dot"></span>{s.visible!==false?"ظاهر":"مخفي"}</span></td>
                  <td style={{textAlign:"left"}}>
                    <button className="btn btn-ghost btn-icon" title="تعديل" onClick={()=>setEditing({...s})}><I.Edit size={13}/></button>
                    <button className="btn btn-ghost btn-icon" title="حذف" onClick={()=>onDelete(s)}><I.Trash size={13}/></button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      )}

      {editing && <SectionEditorModal draft={editing} onClose={()=>setEditing(null)}/>}
    </div>
  );
}

function SectionEditorModal({ draft, onClose }) {
  const [d, setD] = React.useState(draft);
  const [saving, setSaving] = React.useState(false);

  function set(k, v) { setD(x => ({ ...x, [k]: v })); }

  async function onSave() {
    if (!d.label || !d.label.trim()) { if(window.showToast) window.showToast("أدخل اسم القسم","error"); return; }
    setSaving(true);
    try {
      if (d.id && window.updateSection) {
        await window.updateSection(d.id, {
          label:d.label, slug:d.slug, icon:d.icon, group:d.group,
          description:d.description, content:d.content, visible:d.visible,
        });
      } else if (window.addSection) {
        await window.addSection(d);
      }
      if (window.showToast) window.showToast(d.id ? "تم تحديث القسم" : "تمت إضافة القسم","success");
      onClose();
    } finally { setSaving(false); }
  }

  return (
    <Modal title={d.id ? "تعديل قسم" : "قسم جديد"} onClose={onClose}
      footer={<>
        <button className="btn btn-ghost" onClick={onClose}>إلغاء</button>
        <button className="btn btn-blue" disabled={saving} onClick={onSave}>
          <I.Check size={13}/> {saving ? "جاري الحفظ…" : "حفظ"}
        </button>
      </>}>
      <div className="rgrid c-sm" style={{"--gtc":"repeat(2,1fr)",gap:12}}>
        <Field label="اسم القسم" required span={2}>
          <input className="input" value={d.label||""} onChange={e=>set("label",e.target.value)} placeholder="مثال: العلاج المائي"/>
        </Field>
        <Field label="المعرف (slug)" span={2}>
          <input className="input" value={d.slug||""} onChange={e=>set("slug",e.target.value)} placeholder="hydrotherapy"/>
        </Field>
        <Field label="المجموعة">
          <input className="input" value={d.group||""} onChange={e=>set("group",e.target.value)} placeholder="مخصص"/>
        </Field>
        <Field label="الأيقونة">
          <select className="input" value={d.icon||"Layers"} onChange={e=>set("icon",e.target.value)}>
            {CUSTOM_SECTION_ICONS.map(n=><option key={n} value={n}>{n}</option>)}
          </select>
        </Field>
        <Field label="الوصف" span={2}>
          <input className="input" value={d.description||""} onChange={e=>set("description",e.target.value)}/>
        </Field>
        <Field label="المحتوى" span={2} hint="نص حر يظهر داخل الصفحة">
          <textarea className="input" style={{height:120,padding:10}} value={d.content||""} onChange={e=>set("content",e.target.value)}/>
        </Field>
        <Field label="الحالة" span={2}>
          <label style={{display:"flex",alignItems:"center",gap:8,fontSize:13}}>
            <input type="checkbox" checked={d.visible!==false} onChange={e=>set("visible",e.target.checked)}/>
            ظاهر في القائمة الجانبية
          </label>
        </Field>
      </div>
    </Modal>
  );
}

// ── Renderer for a custom (admin-defined) section route ──────
function CustomSectionPage({ id }) {
  const list = window.CUSTOM_SECTIONS || [];
  const s = list.find(x => x.id === id);
  if (!s) return <NotFound go={()=>{}}/>;
  const Ico = I[s.icon] || I.Layers;
  return (
    <Page>
      <div className="crumb"><span>الرئيسية</span><I.Chevron size={11}/><span>{s.group||"مخصص"}</span><I.Chevron size={11}/><span>{s.label}</span></div>
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:12}}>
        <div style={{width:44,height:44,borderRadius:12,background:"var(--blue-100)",color:"var(--blue-700)",display:"flex",alignItems:"center",justifyContent:"center"}}>
          <Ico size={22}/>
        </div>
        <div>
          <div className="h1" style={{marginBottom:2}}>{s.label}</div>
          {s.description && <div className="muted" style={{fontSize:13.5}}>{s.description}</div>}
        </div>
      </div>
      <div className="card card-pad" style={{whiteSpace:"pre-wrap",fontSize:14,lineHeight:1.7,color:"var(--ink-700)"}}>
        {s.content || "لا يوجد محتوى بعد. يمكن للمدير تعديل هذا القسم من الإعدادات."}
      </div>
    </Page>
  );
}

function NotFound({ go }) {
  return (
    <Page>
      <div style={{display:"flex",flexDirection:"column",alignItems:"center",padding:"80px 0"}}>
        <div className="serif" style={{fontSize:120,lineHeight:1,color:"var(--blue-300)"}}>404</div>
        <div className="h1" style={{marginTop:18}}>هذه الصفحة في يوم تعافي.</div>
        <div className="muted" style={{marginTop:8,maxWidth:480,textAlign:"center"}}>الصفحة التي تبحث عنها غير موجودة أو تم نقلها. عُد إلى لوحة التحكم.</div>
        <button className="btn btn-blue" style={{marginTop:20}} onClick={()=>go("dashboard")}><I.ArrowLeft size={13}/> العودة إلى لوحة التحكم</button>
      </div>
    </Page>
  );
}

Object.assign(window, { Reports, SettingsPage, NotFound });


// ─────────── App entrypoint ───────────
// Main app — routing + auth gate

function App() {
  // Re-render the entire app when any DB table changes (upsert / remove /
  // hydrate). Cheap: it just bumps a state counter.
  window.useDataVersion();

  // Keep the document <title> in sync with the clinic name from Postgres,
  // so tabs, PDFs and any recent-clinic-name reads reflect the current
  // singleton value — no code change required when the admin renames.
  React.useEffect(() => {
    const applyTitle = () => {
      const c = window.CLINIC || {};
      const base = c.name || "";
      const sub  = c.subtitle || "";
      const t = [base, sub].filter(Boolean).join(" — ");
      if (t) document.title = t;
    };
    applyTitle();
    window.addEventListener("kinetic:clinic-updated", applyTitle);
    return () => window.removeEventListener("kinetic:clinic-updated", applyTitle);
  }, []);

  const [rawRoute, setRoute] = React.useState(() => {
    return localStorage.getItem("kinetic.route") || "dashboard";
  });
  const [user, setUser] = React.useState(() => {
    try {
      return JSON.parse(localStorage.getItem("kinetic.user")) || null;
    } catch { return null; }
  });
  const [publicBooking, setPublicBooking] = React.useState(false);
  const [toast, setToast] = React.useState(null);
  const [notifsOpen, setNotifsOpen] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);
  // TEMPORARY isolated route for the historical patient import page (?import=1).
  // Bypasses auth/nav entirely. Remove this line, the early return below, and
  // src/import.jsx after the paper-record migration is complete.
  const importMode = React.useMemo(() => {
    try { return new URLSearchParams(window.location.search).get("import") === "1"; }
    catch { return false; }
  }, []);

  // ⌘K / Ctrl+K opens the global command palette (PRD 5.10)
  React.useEffect(() => {
    const onKey = (e) => {
      const k = (e.key || "").toLowerCase();
      if ((e.metaKey || e.ctrlKey) && k === "k") {
        e.preventDefault();
        setPaletteOpen(o => !o);
      } else if (k === "escape" && paletteOpen) {
        setPaletteOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paletteOpen]);

  React.useEffect(()=>{
    localStorage.setItem("kinetic.route", rawRoute);
  },[rawRoute]);

  React.useEffect(()=>{
    window.showToast = (msg, kind="success") => {
      setToast({msg, kind});
      setTimeout(()=>setToast(null), 2400);
    };
  },[]);

  React.useEffect(()=>{
    if (user) localStorage.setItem("kinetic.user", JSON.stringify(user));
    else localStorage.removeItem("kinetic.user");
  },[user]);

  // Re-validate the restored session against the server. A deactivated
  // account (or a revoked / expired token) is forced to log out
  // immediately — its localStorage identity is stale and its data access
  // is already denied by RLS (app_role() → null). Skips demo/mock logins,
  // which have no Supabase session. Runs on mount + whenever the tab
  // regains focus, so deactivation takes effect the next time the user
  // touches the app.
  React.useEffect(() => {
    if (!user || user.role === "مريض") return;
    if (!window.getAuthStaff || isDemoMode()) return;
    let cancelled = false;
    async function check() {
      try {
        const res = await window.getAuthStaff();
        if (cancelled || res.ok) return;
        if (["account-inactive", "invalid-session", "no-session"].includes(res.reason)) {
          if (window.showToast) window.showToast(res.error || "انتهت الجلسة — سجّل الدخول من جديد", "error");
          try { window.signOut && window.signOut(); } catch {}
          setUser(null); setRoute("dashboard");
        }
      } catch {}
    }
    check();
    const onFocus = () => check();
    window.addEventListener("focus", onFocus);
    return () => { cancelled = true; window.removeEventListener("focus", onFocus); };
  }, [user]);

  function go(r) {
    if (r === "logout") {
      setUser(null);
      setRoute("dashboard");
      return;
    }
    setRoute(r);
    window.scrollTo({top:0, behavior:"smooth"});
  }
  // Expose the router to descendants that can't easily receive `go` via
  // props (e.g. modals opened deep inside pages).
  React.useEffect(() => { window.navigate = go; }, []);

  function handleLogin(u) {
    window.ME = u;
    setUser(u);
    setRoute(window.roleDefaultRoute ? window.roleDefaultRoute(u.role) : "dashboard");
    setToast({ msg: `أهلاً بعودتك, ${u.name.split(" ")[0]}`, kind:"success" });
    setTimeout(()=>setToast(null), 2400);
  }

  if (publicBooking) return <PublicBookingScreen onBack={()=>setPublicBooking(false)} onDone={()=>{
    setPublicBooking(false);
    setToast({ msg:"Booking confirmed — واتساب sent.", kind:"success" });
    setTimeout(()=>setToast(null), 3500);
  }}/>;

  // Historical import page (?import=1) — handled BEFORE the localStorage
  // user check on purpose: ImportAuthGate (src/import.jsx) verifies the
  // Supabase Auth session server-side and reads the role from the `staff`
  // table in PostgreSQL, so a forged `kinetic.user` in localStorage can
  // neither grant nor deny access. Every staff role (admin, receptionist,
  // doctor, therapist) is allowed; anonymous visitors get the login screen.
  if (importMode) {
    const Gate = window.ImportAuthGate;
    return <>{Gate ? <Gate/> : null}{toast && <Toast msg={toast.msg} kind={toast.kind}/>}</>;
  }

  if (!user) return <><AuthScreen onLogin={handleLogin} onBookAsGuest={()=>setPublicBooking(true)}/>{toast && <Toast msg={toast.msg} kind={toast.kind}/>}</>;

  // Patients get a totally different shell — focused on their care.
  // Set the identity BEFORE the early return so a page refresh (which
  // restores the user from localStorage without going through handleLogin)
  // still resolves the patient in getPatientMe().
  if (user.role === "مريض") {
    window.ME = user;
    return <PatientPortal onLogout={() => { setUser(null); setRoute("dashboard"); }}/>;
  }

  // Normalize identity (backfills scope/match for sessions created before role-scoping)
  const profile = (window.ROLE_PROFILES || {})[user.role] || {};
  const acct = {
    ...user,
    scope: user.scope !== undefined ? user.scope : (window.roleScope ? window.roleScope(user.role) : "all"),
    match: user.match !== undefined ? user.match : (profile.match || null),
    email: user.email || profile.email || "amir@kinetic.eg",
    color: user.color || profile.color,
  };
  // Make the logged-in identity available to data-scoping helpers.
  window.ME = acct;
  // Guard: if the stored route isn't allowed for this job, fall back to its home.
  const route = (window.roleAllows && !window.roleAllows(user.role, rawRoute))
    ? (window.roleDefaultRoute ? window.roleDefaultRoute(user.role) : "dashboard")
    : rawRoute;

  const titles = {
    dashboard:    { title:"لوحة التحكم",            crumb:["الرئيسية","لوحة التحكم"] },
    patients:     { title:"المرضى",             crumb:["الرئيسية","المرضى"] },
    appointments: { title:"المواعيد",         crumb:["الرئيسية","Appointments"] },
    treatments:   { title:"خطط العلاج",      crumb:["الرئيسية","خطط العلاج"] },
    sessions:     { title:"جلسات العلاج",     crumb:["الرئيسية","جلسات العلاج"] },
    payments:     { title:"المدفوعات والفواتير",  crumb:["الرئيسية","Finance","Payments"] },
    packages:     { title:"الباقات",             crumb:["الرئيسية","Finance","Packages"] },
    campaigns:    { title:"حملات واتساب",   crumb:["الرئيسية","Growth","الحملات"] },
    reports:      { title:"التقارير",              crumb:["الرئيسية","Reports"] },
    settings:     { title:"الإعدادات",             crumb:["الرئيسية","Settings"] },
  };

  // Notifications derived from real data — latest bookings, payments and
  // logged sessions (no canned entries).
  const notifs = [
    ...DATA.appts.filter(a=>a.status!=="متاح").slice(-2).map(a=>({ title:`موعد — ${a.patient}${a.time?` ${a.time}`:""}`, time:a.date||"", dot:"var(--blue-500)" })),
    ...DATA.payments.slice(-2).map(p=>({ title:`فاتورة ${p.id} — EGP ${(p.paid||0).toLocaleString()}`, time:p.date||"", dot:"var(--green)" })),
    ...DATA.sessions.slice(0,1).map(s=>({ title:`جلسة مسجلة — ${s.patient||""} #${s.session||""}`, time:s.date||"", dot:"var(--amber)" })),
  ].slice(0,5);

  return (
    <div style={{display:"flex",minHeight:"100vh",background:"var(--ink-50)"}}>
      <div className={"sidebar-backdrop" + (mobileNavOpen ? " open" : "")} onClick={()=>setMobileNavOpen(false)}/>
      <Sidebar active={route} onNav={(id)=>{ setMobileNavOpen(false); go(id); }} role={acct.role} user={acct} isOpen={mobileNavOpen}/>
      <div style={{flex:1,minWidth:0,display:"flex",flexDirection:"column"}}>
        {/* Inline topbar replaced — pages own their own headers for richer context */}
        <div className="topbar">
          <button type="button" className="mobile-menu-btn" aria-label="فتح القائمة" onClick={()=>setMobileNavOpen(o=>!o)}>
            <I.Menu size={18}/>
          </button>
          <div style={{flex:1,display:"flex",alignItems:"center",gap:12,minWidth:0}}>
            <span className="mono" style={{fontSize:11,color:"var(--ink-400)",letterSpacing:".05em",textTransform:"uppercase"}}>{acct.role}</span>
            <span style={{color:"var(--ink-300)"}}>·</span>
            <span style={{fontSize:13,color:"var(--ink-700)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{activeBranchName()}</span>
            <span className="badge b-green" style={{marginLeft:6}}><span className="dot"></span>متصل</span>
          </div>
          <button type="button" className="search-wrap" onClick={()=>setPaletteOpen(true)}
            style={{position:"relative",width:"min(340px, 32vw)",height:36,padding:"0 34px",borderRadius:10,
              border:"1px solid transparent",background:"var(--ink-50)",cursor:"pointer",
              alignItems:"center",gap:8,color:"var(--ink-500)",fontSize:13,fontFamily:"inherit"}}
            aria-label="فتح البحث الشامل">
            <I.Search size={15} style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",color:"var(--ink-400)"}}/>
            <span style={{flex:1,textAlign:"right"}}>ابحث عن مرضى، مواعيد، فواتير…</span>
            <span className="mono" style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",fontSize:10,color:"var(--ink-400)",background:"#fff",border:"1px solid var(--ink-200)",borderRadius:5,padding:"1px 5px"}}>⌘K</span>
          </button>
          {/* Phone: the full search bar collapses to this icon (opens the same palette) */}
          <button type="button" className="btn btn-ghost btn-icon mobile-search-btn" title="بحث" aria-label="فتح البحث الشامل" onClick={()=>setPaletteOpen(true)}>
            <I.Search size={17}/>
          </button>
          <div style={{position:"relative"}}>
            <button className="btn btn-ghost btn-icon" title="الإشعارات" style={{position:"relative"}} onClick={()=>setNotifsOpen(o=>!o)}>
              <I.Bell size={17}/>
              {notifs.length>0 && <span style={{position:"absolute",top:6,right:6,width:7,height:7,background:"var(--red)",borderRadius:"50%",border:"2px solid #fff"}}></span>}
            </button>
            {notifsOpen && (
              <div style={{position:"fixed",top:60,insetInlineEnd:"max(8px, min(56px, 4vw))",width:"min(320px, calc(100vw - 16px))",background:"#fff",border:"1px solid var(--ink-200)",borderRadius:14,boxShadow:"0 8px 32px rgba(0,0,0,.12)",zIndex:999,padding:"12px 0"}}>
                <div style={{padding:"4px 16px 10px",fontWeight:600,fontSize:13,borderBottom:"1px solid var(--ink-100)"}}>الإشعارات</div>
                {notifs.length===0 && <div className="muted" style={{padding:"14px 16px",fontSize:12.5}}>لا إشعارات جديدة.</div>}
                {notifs.map((n,i)=>(
                  <div key={i} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 16px",cursor:"pointer",borderBottom:"1px solid var(--ink-50)"}}
                    onClick={()=>setNotifsOpen(false)}>
                    <span style={{width:8,height:8,borderRadius:"50%",background:n.dot,flexShrink:0}}/>
                    <div style={{flex:1}}>
                      <div style={{fontSize:12.5,fontWeight:500}}>{n.title}</div>
                      <div style={{fontSize:11,color:"var(--ink-400)"}}>{n.time}</div>
                    </div>
                  </div>
                ))}
                <div style={{padding:"8px 16px 2px",textAlign:"center"}}>
                  <button className="btn btn-ghost" style={{fontSize:12,width:"100%"}} onClick={()=>setNotifsOpen(false)}>عرض كل الإشعارات</button>
                </div>
              </div>
            )}
          </div>
          <button className="btn btn-ghost btn-icon" title="مساعدة" onClick={()=>window.showToast&&window.showToast("فتح المساعدة — قريباً","success")}>
            <I.Sparkle size={17}/>
          </button>
        </div>

        <main style={{flex:1}}>
          {route==="dashboard" && <RoleHome role={acct.role} go={go} user={acct}/>}
          {route==="patients" && <Patients go={go}/>}
          {route==="appointments" && <Appointments go={go}/>}
          {route==="treatments" && <Treatments go={go}/>}
          {route==="sessions" && <Sessions go={go}/>}
          {route==="payments" && <Payments go={go}/>}
          {route==="packages" && <Packages go={go}/>}
          {route==="campaigns" && <Campaigns go={go}/>}
          {route==="reports" && <Reports go={go}/>}
          {route==="settings" && <SettingsPage go={go}/>}
          {typeof route === "string" && route.startsWith("custom:") && <CustomSectionPage id={route.slice(7)}/>}
          {!titles[route] && !(typeof route === "string" && route.startsWith("custom:")) && <NotFound go={go}/>}
        </main>
      </div>
      {toast && <Toast msg={toast.msg} kind={toast.kind}/>}
      <CommandPalette open={paletteOpen} onClose={()=>setPaletteOpen(false)} onNav={(r)=>{ setPaletteOpen(false); go(r); }}/>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App/>);


// ═══════════════════════════════════════════════════════════════
// PATIENT-FACING PORTAL — different shell, simpler nav, friendly tone
// ═══════════════════════════════════════════════════════════════

// Look up the logged-in patient from ME.patient_id (or ME.match) against the
// current DATA.patients cache (hydrated from PostgreSQL). No mock persona —
// an unmatched login gets a minimal identity derived from the account.
// Placeholder "next visit" when the patient has nothing booked — keeps the
// portal UI stable without inventing an appointment.
const NEXT_NONE = { none:true, date:"—", time:"—", dur:0, with:"—", room:"—", type:"لا حجز قادم" };

function getPatientMe(){
  const ME = window.ME || {};
  const patients = (window.DATA && window.DATA.patients) || [];
  const pid = ME.patient_id || ME.match || null;
  const row = pid ? patients.find(p => p.patient_id === pid || p.id === pid || p.name === pid) : null;
  if (!row) {
    const nm = ME.name || "مريض";
    return {
      name: nm,
      initials: nm.split(" ").map(x=>x[0]||"").join("").slice(0,2).toUpperCase() || "—",
      file: ME.patient_id || "—",
      phone: ME.phone || "—",
      diag: "—", doctor: "—", therapist: "—",
      remaining: 0, total: 0,
      next: NEXT_NONE,
    };
  }
  const initials = (row.name || "").split(" ").map(x=>x[0]||"").join("").slice(0,2).toUpperCase();
  const remaining = row.remain != null ? row.remain : 0;
  const total = row.total || (row.pkg && Number((row.pkg.match(/(\d+)/)||[])[1])) || 0;
  // Next visit from the real bookings table.
  const file = row.patient_id || row.id;
  const upcoming = ((window.DATA && window.DATA.appts) || []).find(a =>
    (a.pid === file || a.patient === row.name) && a.status !== "مكتمل" && a.status !== "ملغي" && a.status !== "متاح");
  const next = upcoming ? {
    date: upcoming.date || "اليوم", time: upcoming.time || "—", dur: upcoming.dur || 30,
    with: upcoming.th || "—", room: upcoming.room || "—", type: upcoming.type || "",
  } : NEXT_NONE;
  return {
    name: row.name,
    initials: initials || "—",
    file,
    phone: row.phone || "—",
    diag: row.diag || row.diagnosis || "—",
    doctor: row.doctor || row.dr || "—",
    therapist: row.th || row.therapist || "—",
    remaining,
    total,
    next,
  };
}
// Proxy so every property read hits getPatientMe() at that moment. Direct
// object destructuring still works. Without this, PATIENT_ME would freeze
// to whatever DATA.patients held at script-load time — before hydration.
const PATIENT_ME = new Proxy({}, {
  get(_, key){ return getPatientMe()[key]; },
});

function PatientPortal({ onLogout }) {
  const [route, setRoute] = React.useState("home");
  const [bookingOpen, setBookingOpen] = React.useState(false);
  const [toast, setToast] = React.useState(null);

  function go(r) {
    if (r === "book") { setBookingOpen(true); return; }
    if (r === "logout") { onLogout(); return; }
    setRoute(r);
    window.scrollTo({top:0, behavior:"smooth"});
  }

  function handleBookingComplete(slot) {
    setBookingOpen(false);
    setToast({ msg: `Appointment booked for ${slot.date} at ${slot.time}`, kind:"success" });
    setTimeout(()=>setToast(null), 3000);
    setRoute("appointments");
  }

  return (
    <div style={{minHeight:"100vh",background:"var(--blue-50)"}}>
      <PatientTopbar onNav={go} active={route}/>
      <main style={{maxWidth: 980, margin:"0 auto", padding:"clamp(16px, 3vw, 28px) clamp(14px, 3vw, 24px) 110px"}}>
        {route==="home"         && <PatientHome onBook={()=>setBookingOpen(true)} go={go}/>}
        {route==="appointments" && <PatientAppointments onBook={()=>setBookingOpen(true)}/>}
        {route==="plan"         && <PatientPlanView/>}
        {route==="messages"     && <PatientMessages/>}
        {route==="bills"        && <PatientBills/>}
        {route==="profile"      && <PatientProfile/>}
      </main>
      {bookingOpen && <PatientBookingFlow onClose={()=>setBookingOpen(false)} onDone={handleBookingComplete}/>}
      {toast && <Toast msg={toast.msg} kind={toast.kind}/>}

      {/* Mobile bottom nav (visible always — patient portal feels app-like) */}
      <div style={{
        position:"fixed",bottom:0,left:0,right:0,
        background:"#fff",borderTop:"1px solid var(--ink-200)",
        padding:"8px 12px calc(12px + env(safe-area-inset-bottom, 0px))",display:"flex",justifyContent:"space-around",
        boxShadow:"0 -2px 14px rgba(15,30,43,.05)", zIndex: 20
      }}>
        {[
          { id:"home", l:"الرئيسية", ic:<I.Heart size={18}/> },
          { id:"appointments", l:"زيارات", ic:<I.Calendar size={18}/> },
          { id:"book", l:"حجز", ic:<I.Plus size={20}/>, primary:true },
          { id:"messages", l:"messages", ic:<I.WhatsApp size={18}/> },
          { id:"profile", l:"حسابي", ic:<I.User size={18}/> },
        ].map(it => (
          <button key={it.id} onClick={()=>go(it.id)}
            style={{
              background:"transparent",border:"none",cursor:"pointer",padding:"4px 8px",
              display:"flex",flexDirection:"column",alignItems:"center",gap:3,
              color: route===it.id?"var(--blue-700)":"var(--ink-500)",
              position:"relative"
            }}>
            {it.primary ? (
              <div style={{
                width:46,height:46,borderRadius:14,
                background:"linear-gradient(135deg, var(--blue-500), var(--blue-700))",
                color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",
                boxShadow:"0 6px 18px rgba(123,189,232,.45)",
                marginTop:-22
              }}>
                {it.ic}
              </div>
            ) : it.ic}
            <span style={{fontSize:10.5,fontWeight: route===it.id?600:500}}>{it.l}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function PatientTopbar({ onNav, active }) {
  return (
    <header style={{
      background:"#fff",borderBottom:"1px solid var(--ink-200)",
      position:"sticky",top:0,zIndex:10
    }}>
      <div style={{maxWidth:980,margin:"0 auto",padding:"12px clamp(12px, 3vw, 24px)",display:"flex",alignItems:"center",gap:"clamp(8px, 1.5vw, 14px)"}}>
        <div style={{display:"flex",alignItems:"center",gap:10,cursor:"pointer",flexShrink:0}} onClick={()=>onNav("home")}>
          <I.Logo size={30}/>
          <div style={{display:"flex",flexDirection:"column",lineHeight:1.1}}>
            <span style={{fontWeight:600,fontSize:15,letterSpacing:"-.01em"}}>Kinetic</span>
            <span style={{fontSize:10,color:"var(--ink-500)",letterSpacing:".06em",textTransform:"uppercase"}}>بوابة المريض</span>
          </div>
        </div>
        <nav className="pt-nav" style={{marginLeft:12}}>
          {[
            { id:"home", l:"الرئيسية" },
            { id:"appointments", l:"زياراتي" },
            { id:"plan", l:"خطة العلاج" },
            { id:"messages", l:"messages" },
            { id:"bills", l:"الفواتير" },
          ].map(it=>(
            <button key={it.id} onClick={()=>onNav(it.id)} style={{
              border:"none",background: active===it.id?"var(--blue-100)":"transparent",
              color: active===it.id?"var(--blue-900)":"var(--ink-700)",
              padding:"7px 14px",borderRadius:9,fontSize:13.5,fontWeight:500,cursor:"pointer",
              fontFamily:"inherit"
            }}>{it.l}</button>
          ))}
        </nav>
        <button className="btn btn-ghost btn-icon" style={{position:"relative"}}>
          <I.Bell size={16}/>
          <span style={{position:"absolute",top:6,right:6,width:7,height:7,background:"var(--red)",borderRadius:"50%",border:"2px solid #fff"}}></span>
        </button>
        <button onClick={()=>onNav("profile")} style={{border:"none",background:"transparent",padding:0,cursor:"pointer",display:"flex",alignItems:"center",gap:8}}>
          <div className="av md" style={{background:"var(--blue-500)",color:"#fff"}}>{PATIENT_ME.initials}</div>
          <I.ChevronDown size={12} style={{color:"var(--ink-500)"}}/>
        </button>
        <button className="btn btn-ghost btn-icon" title="تسجيل الخروج" onClick={()=>onNav("logout")}>
          <I.Logout size={15}/>
        </button>
      </div>
    </header>
  );
}

function PatientHome({ onBook, go }) {
  const progress = PATIENT_ME.total - PATIENT_ME.remaining;
  const [nextCancelled, setNextCancelled] = React.useState(false);
  const [nextTime, setNextTime] = React.useState(PATIENT_ME.next.time);
  const [rescheduling, setRescheduling] = React.useState(false);
  const [reTime, setReTime] = React.useState(PATIENT_ME.next.time);
  const NEXT_ID = "B-NEXT-" + (PATIENT_ME.file || "me");
  const cancelNext = async () => {
    try {
      if (window.KineticData) {
        await window.KineticData.upsert("appts", {
          booking_id: NEXT_ID,
          patient_id: PATIENT_ME.file,
          status: "ملغى",
        });
      }
      setNextCancelled(true);
      if (window.showToast) window.showToast("تم إلغاء الموعد","success");
    } catch (e) {
      console.warn("cancel next appt failed", e);
      if (window.showToast) window.showToast("تعذّر إلغاء الموعد","error");
    }
  };
  const confirmReschedule = async () => {
    if (!reTime) { if (window.showToast) window.showToast("اختر وقتًا جديدًا","error"); return; }
    try {
      if (window.KineticData) {
        await window.KineticData.upsert("appts", {
          booking_id: NEXT_ID,
          patient_id: PATIENT_ME.file,
          time: reTime,
          status: "مؤكد",
        });
      }
      setNextTime(reTime);
      setRescheduling(false);
      if (window.showToast) window.showToast("تم إعادة جدولة الموعد","success");
    } catch (e) {
      console.warn("reschedule next appt failed", e);
      if (window.showToast) window.showToast("تعذّر إعادة الجدولة","error");
    }
  };
  return (
    <div>
      {/* Greeting */}
      <div style={{marginBottom:24}}>
        <div className="muted" style={{fontSize:13.5,marginBottom:4}}>الأحد، 24 مايو</div>
        <h1 style={{fontSize:"clamp(24px, 5.5vw, 32px)",fontWeight:600,letterSpacing:"-.015em",margin:0}}>
          أهلاً <span className="serif" style={{fontWeight:400, fontStyle:"italic"}}>{(PATIENT_ME.name||"").split(" ")[0]}</span> — نتمنى لك تحسّنًا دائمًا
        </h1>
      </div>

      {/* Next appointment hero */}
      {!nextCancelled && <div className="card" style={{padding:0,overflow:"hidden",marginBottom:24,position:"relative"}}>
        <div style={{
          background:"linear-gradient(135deg, #7BBDE8 0%, #BDD8E9 80%)",
          padding:"22px 26px", color:"#0F1E2B", position:"relative", overflow:"hidden"
        }}>
          <svg style={{position:"absolute",top:-40,right:-40,opacity:.25}} width="220" height="220" viewBox="0 0 200 200">
            <circle cx="100" cy="100" r="80" fill="none" stroke="#fff" strokeWidth="1.5"/>
            <circle cx="100" cy="100" r="50" fill="none" stroke="#fff" strokeWidth="1.5"/>
            <circle cx="100" cy="100" r="20" fill="#fff" opacity=".6"/>
          </svg>
          <div style={{position:"relative",display:"flex",alignItems:"center",justifyContent:"space-between",gap:18}}>
            <div>
              <div style={{fontSize:11.5,letterSpacing:".06em",textTransform:"uppercase",color:"#1E4A6E",marginBottom:4,display:"flex",alignItems:"center",gap:6}}>
                <span style={{width:6,height:6,borderRadius:999,background:"#1E4A6E",animation:"pulse 1.8s infinite"}}></span>
                Your next جلسة
              </div>
              <div className="serif" style={{fontSize:"clamp(28px, 6vw, 40px)",lineHeight:1.05,letterSpacing:"-.01em"}}>
                {PATIENT_ME.next.date}
              </div>
              <div className="mono" style={{fontSize:18,marginTop:6,color:"#1E4A6E",fontWeight:600}}>
                {nextTime} · {PATIENT_ME.next.dur} min
              </div>
              <div style={{display:"flex",alignItems:"center",gap:"6px 14px",marginTop:14,fontSize:13,flexWrap:"wrap"}}>
                <span style={{display:"flex",alignItems:"center",gap:6}}>
                  <div className="av sm" style={{background:"#fff",color:"var(--blue-700)"}}>KS</div>
                  مع {PATIENT_ME.next.with}
                </span>
                <span style={{color:"#1E4A6E",opacity:.7}}>·</span>
                <span style={{display:"flex",alignItems:"center",gap:6}}>
                  <I.MapPin size={13}/> {PATIENT_ME.next.room}
                </span>
                <span style={{color:"#1E4A6E",opacity:.7}}>·</span>
                <span>{PATIENT_ME.next.type}</span>
              </div>
            </div>
          </div>
        </div>
        <div style={{padding:"14px 26px",display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
          <button className="btn btn-blue" onClick={onBook}><I.Plus size={13}/> احجز موعدًا آخر</button>
          <button className="btn btn-secondary" onClick={()=>{setReTime(nextTime);setRescheduling(true);}}><I.Calendar size={13}/> إعادة جدولة</button>
          <button className="btn btn-secondary" onClick={cancelNext}><I.X size={13}/> إلغاء</button>
          <div style={{flex:1}}/>
          <button className="btn btn-ghost" style={{fontSize:12.5}} onClick={()=>{
            const ics=`BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nSUMMARY:جلسة كينيتك - ${PATIENT_ME.next.with}\nDTSTART:20260601T100000Z\nDTEND:20260601T110000Z\nLOCATION:${PATIENT_ME.next.room}\nEND:VEVENT\nEND:VCALENDAR`;
            const blob=new Blob([ics],{type:"text/calendar"});
            const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download="appointment.ics";a.click();URL.revokeObjectURL(url);
            if(window.showToast)window.showToast("تم تنزيل الموعد للتقويم","success");
          }}><I.Download size={13}/> أضف إلى التقويم</button>
        </div>
      </div>}
      {nextCancelled && (
        <div className="card card-pad" style={{marginBottom:24,display:"flex",alignItems:"center",justifyContent:"space-between",gap:12}}>
          <div>
            <div style={{fontWeight:600,fontSize:14}}>لا يوجد موعد قادم</div>
            <div className="muted" style={{fontSize:12,marginTop:4}}>احجزي زيارتك القادمة عند جاهزيتك.</div>
          </div>
          <button className="btn btn-blue" onClick={onBook}><I.Plus size={13}/> احجز زيارة</button>
        </div>
      )}
      {rescheduling && (
        <Modal title="إعادة جدولة الموعد" onClose={()=>setRescheduling(false)}
          footer={<>
            <button className="btn btn-ghost" onClick={()=>setRescheduling(false)}>إلغاء</button>
            <button className="btn btn-blue" onClick={confirmReschedule}><I.Check size={13}/> تأكيد</button>
          </>}>
          <Field label="الوقت الجديد"><input className="input" type="time" value={reTime} onChange={e=>setReTime(e.target.value)}/></Field>
          <div className="muted" style={{fontSize:12,marginTop:10}}>سيتم إبلاغ {PATIENT_ME.next.with}.</div>
        </Modal>
      )}

      {/* إجراءات سريعة */}
      <div className="rgrid c-sm" style={{"--gtc":"repeat(3,1fr)",gap:14,marginBottom:24}}>
        {[
          { l:"احجز زيارة",   sub:"45 ثانية للحجز",       ic:<I.Calendar size={20}/>, color:"#7BBDE8", onClick:onBook },
          { l:"الرسالة therapist", sub:"الرد عادةً خلال ساعتين", ic:<I.WhatsApp size={20}/>, color:"#25D366", onClick:()=>go("messages") },
          { l:"اعرض خطتي",   sub:"أهداف · تمارين · ملاحظات", ic:<I.Clipboard size={20}/>, color:"#7E6BD3", onClick:()=>go("plan") },
        ].map((q,i)=>(
          <button key={i} onClick={q.onClick} style={{
            background:"#fff",border:"1px solid var(--ink-200)",borderRadius:14,
            padding:"18px",textAlign:"left",cursor:"pointer",
            display:"flex",alignItems:"center",gap:14,transition:"all .15s",
            fontFamily:"inherit"
          }}
            onMouseEnter={e=>{e.currentTarget.style.borderColor=q.color;e.currentTarget.style.transform="translateY(-1px)";e.currentTarget.style.boxShadow="var(--shadow-md)";}}
            onMouseLeave={e=>{e.currentTarget.style.borderColor="var(--ink-200)";e.currentTarget.style.transform="translateY(0)";e.currentTarget.style.boxShadow="";}}
          >
            <div style={{width:44,height:44,borderRadius:12,background:q.color+"22",color:q.color,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
              {q.ic}
            </div>
            <div>
              <div style={{fontWeight:600,fontSize:14.5}}>{q.l}</div>
              <div className="muted" style={{fontSize:12,marginTop:2}}>{q.sub}</div>
            </div>
            <I.ArrowRight size={16} style={{color:"var(--ink-300)",marginLeft:"auto"}}/>
          </button>
        ))}
      </div>

      {/* التقدّم + recovery */}
      <div className="rgrid c-sm" style={{"--gtc":"1.3fr 1fr",marginBottom:24}}>
        <div className="card card-pad">
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:18}}>
            <div>
              <div className="h2">تعافيك</div>
              <div className="muted" style={{fontSize:12.5,marginTop:2}}>الألم has dropped بواسطة 4 points in 4 weeks 🎉</div>
            </div>
            <button className="btn btn-ghost" style={{fontSize:12}} onClick={()=>go("plan")}>افتح الخطة <I.ArrowRight size={11}/></button>
          </div>

          <div style={{display:"flex",alignItems:"baseline",gap:8,marginBottom:8}}>
            <span className="mono" style={{fontSize:38,fontWeight:600,letterSpacing:"-.01em"}}>{progress}</span>
            <span className="muted">من {PATIENT_ME.total} Sessions مكتملة</span>
          </div>
          <div style={{height:10,background:"var(--ink-100)",borderRadius:999,overflow:"hidden",marginBottom:16}}>
            <div style={{height:"100%",width:`${progress/PATIENT_ME.total*100}%`,background:"linear-gradient(90deg, var(--blue-500), var(--blue-700))",borderRadius:999,transition:"width .6s"}}/>
          </div>

          <div style={{padding:14,background:"var(--blue-50)",borderRadius:12,marginBottom:14}}>
            <div className="muted" style={{fontSize:11,textTransform:"uppercase",letterSpacing:".05em",marginBottom:6}}>الألم trend · last 7 Sessions</div>
            <PainTrendChart/>
          </div>

          {(() => {
            // Real pain trend bounds from the patient's logged sessions.
            const mySess = ((window.DATA && window.DATA.sessions) || [])
              .filter(s => s.patient_id === PATIENT_ME.file || s.patient === PATIENT_ME.name);
            const first = mySess[mySess.length-1], last = mySess[0];
            const painOf = (s) => s ? (s.pain ?? s.pain_score ?? "—") : "—";
            return (
              <div style={{display:"flex",justifyContent:"space-between",fontSize:12.5}}>
                <div><div className="muted">البداية</div><div>{painOf(first)}/10</div></div>
                <div><div className="muted">اليوم</div><div className="mono" style={{color:"var(--green)",fontWeight:600}}>{painOf(last)}/10</div></div>
                <div><div className="muted">الهدف</div><div>≤ 2/10</div></div>
              </div>
            );
          })()}
        </div>

        <div className="card card-pad">
          <div className="h2" style={{marginBottom:14}}>تمارين اليوم</div>
          <div className="muted" style={{fontSize:13,padding:"14px 0"}}>لا تمارين منزلية مسندة بعد — سيضيفها أخصائيك بعد الجلسة.</div>
        </div>
      </div>

      {/* فريق الرعاية */}
      <div className="card card-pad" style={{marginBottom:24}}>
        <div className="h2" style={{marginBottom:14}}>فريق الرعاية</div>
        <div className="rgrid c-sm" style={{"--gtc":"1fr 1fr",gap:14}}>
          {[
            { name:PATIENT_ME.doctor, role:"الطبيب المسؤول", color:"#7E6BD3" },
            { name:PATIENT_ME.therapist, role:"الأخصائي الأساسي", color:"#7BBDE8",
              spec:(((window.DATA&&window.DATA.therapists)||[]).find(t=>t.name===PATIENT_ME.therapist)||{}).spec },
          ].map((c,i)=>{
            const clinicPhone = ((window.BRANCHES||[])[0]||{}).phone || "";
            return (
            <div key={i} style={{display:"flex",alignItems:"center",gap:14,padding:14,border:"1px solid var(--ink-200)",borderRadius:12}}>
              <div className="av lg" style={{background:c.color+"33",color:c.color}}>{(c.name||"—").split(" ").slice(-2).map(x=>x[0]||"").join("")}</div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontWeight:600,fontSize:14}}>{c.name || "—"}</div>
                <div className="muted" style={{fontSize:12}}>{c.role}{c.spec ? ` · ${c.spec}` : ""}</div>
              </div>
              <button className="btn btn-ghost btn-icon" title="الرسالة" onClick={()=>window.open(`https://wa.me/${clinicPhone.replace(/[^\d]/g,"")}`,"_blank")}><I.WhatsApp size={15}/></button>
              <button className="btn btn-ghost btn-icon" title="اتصال" onClick={()=>window.open(`tel:${clinicPhone.replace(/[^\d+]/g,"")}`)}><I.Phone size={15}/></button>
            </div>
          );})}
        </div>
      </div>
    </div>
  );
}

function PatientAppointments({ onBook }) {
  const [notesModal, setNotesModal] = React.useState(null);
  // Real bookings for the logged-in patient (no seeded visit fixtures).
  const [upcoming, setUpcoming] = React.useState(() => {
    const me = getPatientMe();
    return ((window.DATA && window.DATA.appts) || [])
      .filter(a => (a.pid === me.file || a.patient === me.name)
        && a.status !== "مكتمل" && a.status !== "ملغي" && a.status !== "ملغى" && a.status !== "متاح")
      .map(a => ({ id: a.id, date: a.date || "اليوم", time: a.time || "—", dur: a.dur || 30,
        th: a.th || "—", type: a.type || "", status: a.status, room: a.room || "—" }));
  });
  const [rescheduling, setRescheduling] = React.useState(null);
  const [reTime, setReTime] = React.useState("");
  const cancelAppt = async (a) => {
    try {
      if (window.KineticData) {
        await window.KineticData.upsert("appts", {
          booking_id: a.id,
          patient_id: PATIENT_ME.file,
          status: "ملغى",
        });
      }
      setUpcoming(list => list.filter(x => x.id !== a.id));
      if (window.showToast) window.showToast("تم إلغاء الموعد","success");
    } catch (e) {
      console.warn("cancel appt failed", e);
      if (window.showToast) window.showToast("تعذّر إلغاء الموعد","error");
    }
  };
  const confirmReschedule = async () => {
    if (!reTime) { if (window.showToast) window.showToast("اختر وقتًا جديدًا","error"); return; }
    const a = rescheduling;
    try {
      if (window.KineticData) {
        await window.KineticData.upsert("appts", {
          booking_id: a.id,
          patient_id: PATIENT_ME.file,
          time: reTime,
          status: "مؤكد",
        });
      }
      setUpcoming(list => list.map(x => x.id === a.id ? { ...x, time: reTime, status: "مؤكد" } : x));
      if (window.showToast) window.showToast("تم إعادة جدولة الموعد","success");
      setRescheduling(null);
      setReTime("");
    } catch (e) {
      console.warn("reschedule appt failed", e);
      if (window.showToast) window.showToast("تعذّر إعادة الجدولة","error");
    }
  };
  // Past visits from the patient's real logged sessions.
  const past = (() => {
    const me = getPatientMe();
    return ((window.DATA && window.DATA.sessions) || [])
      .filter(s => s.patient_id === me.file || s.patient === me.name)
      .map(s => ({ date: s.date || "—", time: "", dur: 0, th: s.therapist || "—",
        type: `جلسة #${s.session ?? s.session_number ?? "—"}`, status: "مكتمل",
        pain: `${s.pain ?? s.pain_score ?? "—"}/10`, notes: s.notes || s.session_notes || "" }));
  })();

  return (
    <div>
      <div className="page-head" style={{alignItems:"flex-end"}}>
        <div>
          <h1 style={{fontSize:"clamp(22px, 5vw, 28px)",fontWeight:600,letterSpacing:"-.01em",margin:0}}>زياراتي</h1>
          <div className="muted" style={{fontSize:13.5,marginTop:4}}>{upcoming.length} قادمة · {past.length} مكتملة</div>
        </div>
        <button className="btn btn-blue" onClick={onBook}><I.Plus size={13}/> احجز زيارة</button>
      </div>

      <div className="h3" style={{marginBottom:10,marginTop:8}}>قادمة</div>
      <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:30}}>
        {upcoming.length===0 && <div className="card" style={{padding:20,textAlign:"center",color:"var(--ink-500)",fontSize:13}}>لا زيارات قادمة — احجز زيارتك الأولى.</div>}
        {upcoming.map((a,i)=>(
          <div key={i} className="card" style={{padding:16,display:"flex",alignItems:"center",gap:16,flexWrap:"wrap"}}>
            <div style={{
              width:64,height:64,borderRadius:14,
              background: i===0?"linear-gradient(135deg, var(--blue-500), var(--blue-700))":"var(--blue-50)",
              color: i===0?"#fff":"var(--blue-700)",
              display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",
              flexShrink:0
            }}>
              <div className="mono" style={{fontSize:11,opacity:.8,fontWeight:500}}>{/^\d{4}-\d{2}-\d{2}/.test(a.date) ? new Date(a.date).toLocaleDateString("ar-EG",{month:"short"}) : a.date.split("،")[0].slice(0,4)}</div>
              <div className="mono" style={{fontSize:22,fontWeight:600,lineHeight:1}}>{/^\d{4}-\d{2}-\d{2}/.test(a.date) ? a.date.slice(8,10) : (a.date.match(/\d+/)?.[0] || "—")}</div>
            </div>
            <div style={{flex:1,minWidth:200}}>
              <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:4,flexWrap:"wrap"}}>
                <span style={{fontWeight:600,fontSize:14.5}}>{a.date} · {a.time}</span>
                <ApptBadge s={a.status}/>
              </div>
              <div className="muted" style={{fontSize:12.5}}>
                {a.type} مع {a.th} · {a.dur} min · {a.room}
              </div>
            </div>
            <div style={{display:"flex",gap:6}}>
              <button className="btn btn-secondary" style={{fontSize:12}} onClick={()=>{setRescheduling(a);setReTime(a.time);}}> إعادة جدولة</button>
              <button className="btn btn-ghost btn-icon" title="إلغاء الموعد" onClick={()=>cancelAppt(a)}><I.X size={14}/></button>
            </div>
          </div>
        ))}
      </div>

      <div className="h3" style={{marginBottom:10}}>سابقة</div>
      <div className="card" style={{padding:0,overflow:"hidden"}}>
        {past.map((a,i)=>(
          <div key={i} className="rgrid pvisit-row" style={{padding:"14px 18px","--gtc":"140px 1fr 100px 110px 90px",alignItems:"center",gap:12,borderBottom:i<past.length-1?"1px solid var(--ink-100)":"none"}}>
            <div>
              <div style={{fontSize:13,fontWeight:500}}>{a.date}</div>
              <div className="mono" style={{fontSize:11.5,color:"var(--ink-500)"}}>{a.time} · {a.dur}m</div>
            </div>
            <div>
              <div style={{fontSize:13}}>{a.type}</div>
              <div className="muted" style={{fontSize:11.5}}>مع {a.th}</div>
            </div>
            <div style={{textAlign:"center"}}>
              <div className="muted" style={{fontSize:11}}>الألم</div>
              <div className="mono" style={{fontSize:13,fontWeight:600,color:"var(--green)"}}>{a.pain}</div>
            </div>
            <ApptBadge s={a.status}/>
            <button className="btn btn-ghost" style={{fontSize:12,justifyContent:"flex-end"}} onClick={()=>setNotesModal(a)}>عرض الملاحظات <I.ArrowRight size={11}/></button>
          </div>
        ))}
      </div>
      {notesModal && (
        <Modal title={`ملاحظات جلسة ${notesModal.date}`} onClose={()=>setNotesModal(null)}>
          <div style={{fontSize:13,lineHeight:1.7,marginBottom:12}}>
            <strong>{notesModal.type}</strong> مع {notesModal.th}<br/>
            مستوى الألم: <span style={{color:"var(--green)",fontWeight:600}}>{notesModal.pain}</span>
          </div>
          <div style={{padding:14,background:"var(--ink-50)",borderRadius:10,fontSize:13,color:"var(--ink-700)"}}>
            {notesModal.notes || "لا ملاحظات مسجلة لهذه الجلسة."}
          </div>
        </Modal>
      )}
      {rescheduling && (
        <Modal title={`إعادة جدولة موعد ${rescheduling.date}`} onClose={()=>{setRescheduling(null);setReTime("");}}
          footer={<>
            <button className="btn btn-ghost" onClick={()=>{setRescheduling(null);setReTime("");}}>إلغاء</button>
            <button className="btn btn-blue" onClick={confirmReschedule}><I.Check size={13}/> تأكيد</button>
          </>}>
          <Field label="الوقت الجديد"><input className="input" type="time" value={reTime} onChange={e=>setReTime(e.target.value)}/></Field>
          <div className="muted" style={{fontSize:12,marginTop:10}}>سيتم إشعار الأخصائي {rescheduling.th}.</div>
        </Modal>
      )}
    </div>
  );
}

function PatientPlanView() {
  const me = getPatientMe();
  const row = ((window.DATA && window.DATA.patients) || []).find(p => (p.patient_id||p.id) === me.file || p.name === me.name);
  return (
    <div>
      <h1 style={{fontSize:"clamp(22px, 5vw, 28px)",fontWeight:600,letterSpacing:"-.01em",margin:"0 0 4px"}}>خطة علاجك</h1>
      <div className="muted" style={{fontSize:13.5,marginBottom:20}}>{me.diag}{row && row.registered ? ` · بدأت ${row.registered}` : ""}</div>
      <PatientTreatmentPlan p={row}/>
    </div>
  );
}

function PatientMessages() {
  // No in-portal messaging backend yet — show the real contact channels
  // instead of a fabricated conversation.
  return (
    <div>
      <h1 style={{fontSize:"clamp(22px, 5vw, 28px)",fontWeight:600,letterSpacing:"-.01em",margin:"0 0 4px"}}>الرسائل</h1>
      <div className="muted" style={{fontSize:13.5,marginBottom:20}}>تحدّث مع فريق الرعاية.</div>
      <EmptyState icon={<I.WhatsApp size={22}/>} title="لا رسائل بعد"
        body="المراسلة داخل البوابة قادمة قريبًا — تواصل مع العيادة مباشرة عبر واتساب أو الهاتف."
        action={<button className="btn btn-blue" onClick={()=>window.open("https://wa.me/","_blank")}><I.WhatsApp size={13}/> تواصل عبر واتساب</button>}/>
    </div>
  );
}

function PatientBills() {
  // The patient's real invoices.
  const me = getPatientMe();
  const bills = ((window.DATA && window.DATA.payments) || [])
    .filter(b => b.patient === me.name || b.patient_id === me.file)
    .map(b => ({ id: b.id, date: b.date || "—", desc: b.desc || "فاتورة علاج",
      amount: b.amount || 0, paid: b.paid || 0, method: b.method || "—", status: b.status }));
  const yearNow = new Date().getFullYear();
  const paidThisYear = bills.filter(b => String(b.date).includes(String(yearNow))).reduce((s,b)=>s+b.paid,0);
  const pending = bills.reduce((s,b)=>s+Math.max(0,b.amount-b.paid),0);
  return (
    <div>
      <h1 style={{fontSize:"clamp(22px, 5vw, 28px)",fontWeight:600,letterSpacing:"-.01em",margin:"0 0 4px"}}>الفواتير</h1>
      <div className="muted" style={{fontSize:13.5,marginBottom:20}}>Your full payment history مع Kinetic.</div>

      <div className="rgrid c-sm" style={{"--gtc":"repeat(3,1fr)",gap:14,marginBottom:24}}>
        <div className="card card-pad">
          <div className="muted" style={{fontSize:11,textTransform:"uppercase",letterSpacing:".05em"}}>مدفوع هذه السنة</div>
          <div className="mono" style={{fontSize:26,fontWeight:600,marginTop:4}}>EGP {paidThisYear.toLocaleString()}</div>
        </div>
        <div className="card card-pad">
          <div className="muted" style={{fontSize:11,textTransform:"uppercase",letterSpacing:".05em"}}>معلّق</div>
          <div className="mono" style={{fontSize:26,fontWeight:600,marginTop:4,color:pending>0?"var(--red)":"var(--green)"}}>EGP {pending.toLocaleString()}</div>
        </div>
        <div className="card card-pad">
          <div className="muted" style={{fontSize:11,textTransform:"uppercase",letterSpacing:".05em"}}>جلسات متبقية</div>
          <div className="mono" style={{fontSize:26,fontWeight:600,marginTop:4}}>{PATIENT_ME.remaining} <span style={{fontSize:14,color:"var(--ink-500)"}}>/ {PATIENT_ME.total}</span></div>
        </div>
      </div>

      <div className="card" style={{overflow:"hidden"}}>
        <div className="tbl-scroll">
        <table className="tbl">
          <thead><tr><th>فاتورة</th><th>التاريخ</th><th>البند</th><th>المبلغ</th><th>الطريقة</th><th>الحالة</th><th></th></tr></thead>
          <tbody>
            {bills.length===0 && (
              <tr><td colSpan={7}><EmptyState icon={<I.FileText size={22}/>} title="لا فواتير بعد" body="ستظهر فواتيرك هنا بعد أول عملية دفع."/></td></tr>
            )}
            {bills.map(b=>(
              <tr key={b.id}>
                <td className="mono">{b.id}</td>
                <td>{b.date}</td>
                <td>{b.desc}</td>
                <td className="mono" style={{fontWeight:600}}>EGP {b.amount.toLocaleString()}</td>
                <td>{b.method}</td>
                <td><PayBadge s={b.status}/></td>
                <td><button className="btn btn-ghost btn-icon" onClick={()=>{
                  const rows=["الفاتورة,التاريخ,البند,المبلغ,الطريقة,الحالة",`${b.id},${b.date},${b.desc},${b.amount},${b.method},${b.status}`];
                  downloadCsv(rows, `${b.id}.csv`);
                  if(window.showToast)window.showToast("تم تحميل الفاتورة","success");
                }}><I.Download size={13}/></button></td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
}

function PatientProfile() {
  const [editOpen, setEditOpen] = React.useState(false);
  const [form, setForm] = React.useState(() => {
    const row = ((window.DATA && window.DATA.patients) || []).find(p => (p.patient_id||p.id) === PATIENT_ME.file) || {};
    return { name:PATIENT_ME.name, phone:PATIENT_ME.phone, email:(window.ME && window.ME.email) || "", address: row.address || "" };
  });
  return (
    <div>
      <h1 style={{fontSize:"clamp(22px, 5vw, 28px)",fontWeight:600,letterSpacing:"-.01em",margin:"0 0 4px"}}>ملفي الشخصي</h1>
      <div className="muted" style={{fontSize:13.5,marginBottom:20}}>بياناتك on file مع Kinetic.</div>

      <div className="rgrid c-sm" style={{"--gtc":"1fr 1fr"}}>
        <div className="card card-pad">
          <div className="h3" style={{marginBottom:14}}>البيانات الشخصية</div>
          <InfoRow k="رقم الملف" v={<span className="mono">{PATIENT_ME.file}</span>}/>
          <InfoRow k="الاسم الكامل" v={form.name}/>
          <InfoRow k="الهاتف" v={form.phone}/>
          <InfoRow k="البريد" v={form.email}/>
          <InfoRow k="التاريخ من birth" v="Mar 12, 1992"/>
          <InfoRow k="العنوان" v={form.address}/>
          <button className="btn btn-secondary" style={{marginTop:14}} onClick={()=>setEditOpen(true)}><I.Edit size={13}/> تعديل details</button>
        </div>
      {editOpen && (
        <Modal title="تعديل البيانات الشخصية" onClose={()=>setEditOpen(false)}
          footer={<>
            <button className="btn btn-ghost" onClick={()=>setEditOpen(false)}>إلغاء</button>
            <button className="btn btn-blue" onClick={async ()=>{
              if (!form.name.trim()) { if (window.showToast) window.showToast("أدخل الاسم","error"); return; }
              try {
                if (window.KineticData) {
                  await window.KineticData.upsert("patients", {
                    patient_id: PATIENT_ME.file,
                    name: form.name.trim(),
                    phone: form.phone || null,
                  });
                }
                if (window.showToast) window.showToast("تم حفظ التغييرات","success");
                setEditOpen(false);
              } catch (e) {
                console.warn("patient profile save failed", e);
                if (window.showToast) window.showToast("تعذّر حفظ التغييرات","error");
              }
            }}>
              <I.Check size={13}/> حفظ
            </button>
          </>}>
          <Field label="الاسم الكامل"><input className="input" value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/></Field>
          <div style={{height:10}}/>
          <Field label="الهاتف"><input className="input" value={form.phone} onChange={e=>setForm({...form,phone:e.target.value})}/></Field>
          <div style={{height:10}}/>
          <Field label="البريد الإلكتروني"><input className="input" type="email" value={form.email} onChange={e=>setForm({...form,email:e.target.value})}/></Field>
          <div style={{height:10}}/>
          <Field label="العنوان"><input className="input" value={form.address} onChange={e=>setForm({...form,address:e.target.value})}/></Field>
        </Modal>
      )}
        <div className="card card-pad">
          <div className="h3" style={{marginBottom:14}}>التفضيلات</div>
          {[
            { l:"تذكير appointments", sub:"رسالة واتساب قبل 24 ساعة", on:true },
            { l:"الأخصائي messages", sub:"بريد + إشعار عندما يراسلك الأخصائي", on:true },
            { l:"تسويق وعروض", sub:"عروض ومستجدات العيادة أحيانًا", on:false },
            { l:"مشاركة التقدّم مع الطبيب", sub:"إرسال ملخص أسبوعي للدكتورة ياسمين", on:true },
          ].map((p,i)=>(
            <div key={i} style={{display:"flex",alignItems:"center",gap:12,padding:"11px 0",borderBottom:i<3?"1px dashed var(--ink-100)":"none"}}>
              <div style={{flex:1}}>
                <div style={{fontSize:13.5,fontWeight:500}}>{p.l}</div>
                <div className="muted" style={{fontSize:11.5}}>{p.sub}</div>
              </div>
              <div className={`switch ${p.on?"on":""}`}><div className="knob"></div></div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ──────── المريض booking flow (focused, friendly) ────────
// Arabic calendar constants shared by the two booking flows below.
// PRD-mandated names (with hamza on الإثنين) — do not swap for locale
// output, which uses "الاثنين" in ar-EG.
const __BK_AR_WD = ["الأحد","الإثنين","الثلاثاء","الأربعاء","الخميس","الجمعة","السبت"];
const __BK_AR_MO = ["يناير","فبراير","مارس","أبريل","مايو","يونيو","يوليو","أغسطس","سبتمبر","أكتوبر","نوفمبر","ديسمبر"];
// Bookable slots from clinic settings (working window + slot duration) —
// falls back to the legacy fixed list only if settings aren't loaded yet.
function __bkSlots() {
  return window.calendarSlots ? window.calendarSlots() : [
    "08:30","09:00","09:30","10:00","10:30","11:00","11:30",
    "12:00","13:00","13:30","14:00","14:30","15:00","15:30","16:00","16:30","17:00"
  ];
}
function __bkIso(d){ const p=n=>String(n).padStart(2,"0"); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`; }
function __bkFormat(iso, offset) {
  const d = new Date(iso + "T00:00:00");
  const wd = __BK_AR_WD[d.getDay()], mo = __BK_AR_MO[d.getMonth()], day = d.getDate();
  const label = offset === 0 ? `اليوم، ${day} ${mo}`
              : offset === 1 ? `غدًا، ${day} ${mo}`
              : `${wd}، ${day} ${mo}`;
  return { iso, weekday: wd, day, month: mo, label };
}
// Build `count` rolling days starting today; each carries the ISO
// date and a per-day availability count derived from live bookings.
function __bkDays(count, therapistName, excludeId) {
  const now = new Date();
  const todayIso = __bkIso(now);
  const nowHM = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
  const all = (window.scopeAppts ? window.scopeAppts(DATA.appts || []) : (DATA.appts || []));
  const out = [];
  const base = new Date(todayIso + "T00:00:00");
  for (let i = 0; i < count; i++) {
    const d = new Date(base); d.setDate(base.getDate() + i);
    const iso = __bkIso(d);
    const info = __bkFormat(iso, i);
    const takenTimes = new Set(
      all.filter(a =>
        (a.date && String(a.date).slice(0,10) === iso) &&
        a.status !== "ملغي" && a.status !== "متاح" &&
        (!therapistName || a.th === therapistName) &&
        (excludeId == null || (a.booking_id || a.id) !== excludeId)
      ).map(a => a.time)
    );
    const slots = __bkSlots();
    const slotPool = iso === todayIso ? slots.filter(t => t > nowHM) : slots;
    const avail = Math.max(0, slotPool.filter(t => !takenTimes.has(t)).length);
    out.push({ ...info, slots: avail, takenTimes, todayIso, nowHM });
  }
  return out;
}

function PatientBookingFlow({ onClose, onDone }) {
  // Live tick so past-time gating stays honest across the top of the
  // hour, and useDataVersion so external booking mutations re-render.
  const [nowTick, setNowTick] = React.useState(() => Date.now());
  React.useEffect(() => { const id = setInterval(() => setNowTick(Date.now()), 60_000); return () => clearInterval(id); }, []);
  window.useDataVersion && window.useDataVersion();

  const [step, setStep] = React.useState(1);
  const [picks, setPicks] = React.useState({
    reason: null,
    therapist: null,
    date: __bkIso(new Date()),
    time: "",
  });
  const [confirming, setConfirming] = React.useState(false);

  function next() {
    // Validate the current step before advancing so incomplete state can't
    // silently slip through to booking. Each step guards its own field.
    if (step === 1 && !picks.reason) { if (window.showToast) window.showToast("اختر سبب الزيارة", "error"); return; }
    if (step === 2 && !picks.therapist) { if (window.showToast) window.showToast("اختر المعالج", "error"); return; }
    if (step === 3 && (!picks.date || !picks.time)) { if (window.showToast) window.showToast("اختر التاريخ والوقت", "error"); return; }
    // Reject past dates/times before persisting so the DB never sees them.
    if (step === 3) {
      const now = new Date(nowTick);
      const todayIso = __bkIso(now);
      const nowHM = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
      if (picks.date < todayIso || (picks.date === todayIso && picks.time <= nowHM)) {
        if (window.showToast) window.showToast("لا يمكن الحجز في وقت سابق", "error");
        return;
      }
    }
    if (step < 4) { setStep(step+1); return; }
    setConfirming(true);
    const me = getPatientMe();
    // Persist the booking so it appears in Appointments after the modal closes.
    if (window.KineticData) {
      const therapistRow = (DATA.therapists || []).find(t => t.name === picks.therapist);
      const bookingId = "B-" + Date.now();
      window.KineticData.upsert("appts", {
        booking_id: bookingId,
        id: bookingId,
        patient_id: me.file,
        therapist_id: (therapistRow && (therapistRow.staff_id || therapistRow.id)) || null,
        th: picks.therapist || null,
        date: picks.date,
        time: picks.time,
        status: "مؤكد",
        notes: picks.reason || "",
      }).catch(e => console.warn("booking persist failed", e));
    }
    setTimeout(()=>{
      onDone(picks);
    }, 1100);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{width:760,maxWidth:"calc(100% - 40px)",maxHeight:"calc(100vh - 60px)",padding:0,overflow:"hidden"}} onClick={e=>e.stopPropagation()}>
        {/* Header */}
        <div style={{padding:"18px 24px",borderBottom:"1px solid var(--ink-100)",display:"flex",alignItems:"center",gap:12}}>
          <div style={{width:34,height:34,borderRadius:10,background:"var(--blue-100)",color:"var(--blue-700)",display:"flex",alignItems:"center",justifyContent:"center"}}>
            <I.Calendar size={17}/>
          </div>
          <div style={{flex:1}}>
            <div className="h3">احجز زيارة</div>
            <div className="muted" style={{fontSize:12}}>خطوة {step} من 4 — تستغرق عادةً 30 ثانية</div>
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose}><I.X size={16}/></button>
        </div>

        {/* Stepper */}
        <div style={{padding:"14px 24px",background:"var(--ink-50)",borderBottom:"1px solid var(--ink-100)",display:"flex",gap:6}}>
          {[1,2,3,4].map(n=>(
            <div key={n} style={{
              flex:1,height:5,borderRadius:999,
              background: n<step?"var(--green)":n===step?"var(--blue-500)":"var(--ink-200)",
              transition:"background .25s"
            }}/>
          ))}
        </div>

        {/* Body */}
        <div style={{padding:"28px 28px 24px",minHeight:380,maxHeight:"60vh",overflowY:"auto"}}>
          {confirming ? (
            <div style={{textAlign:"center",padding:"40px 0"}}>
              <div style={{width:60,height:60,borderRadius:999,background:"var(--green-bg)",color:"var(--green)",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 18px"}}>
                <I.Check size={28}/>
              </div>
              <div className="serif" style={{fontSize:30,marginBottom:6}}>تم حجزك!</div>
              <div className="muted">Confirmation sent to {PATIENT_ME.phone} via واتساب.</div>
            </div>
          ) : step===1 ? (
            <div>
              <div className="serif" style={{fontSize:26,marginBottom:6}}>ما الذي يحضرك إلينا؟</div>
              <div className="muted" style={{fontSize:13.5,marginBottom:22}}>This helps us match you مع the right therapist.</div>

              <div className="rgrid c-sm" style={{"--gtc":"1fr 1fr",gap:10}}>
                {[
                  { id:"continue", l:"متابعة خطتي",     sub:`${PATIENT_ME.remaining} جلسات متبقية${PATIENT_ME.diag&&PATIENT_ME.diag!=="—"?` · ${PATIENT_ME.diag}`:""}`, ic:<I.Heart size={18}/>, primary:true },
                  { id:"new",      l:"مشكلة جديدة",            sub:"شيء جديد يضايقك",                                  ic:<I.Plus size={18}/> },
                  { id:"followup", l:"متابعة مع الطبيب", sub:PATIENT_ME.doctor&&PATIENT_ME.doctor!=="—"?`متابعة مع ${PATIENT_ME.doctor}`:"متابعة مع طبيبك",                                   ic:<I.Stethoscope size={18}/> },
                  { id:"assess",   l:"تقييم أولي",   sub:"أول زيارة",                                                  ic:<I.Sparkle size={18}/> },
                ].map(o=>(
                  <button key={o.id} onClick={()=>{setPicks({...picks,reason:o.id}); next();}} style={{
                    padding:18,textAlign:"left",cursor:"pointer",fontFamily:"inherit",
                    border:`1px solid ${picks.reason===o.id?"var(--blue-500)":"var(--ink-200)"}`,
                    background:picks.reason===o.id||o.primary?"var(--blue-50)":"#fff",
                    borderRadius:14,display:"flex",alignItems:"center",gap:14,transition:"all .15s"
                  }}>
                    <div style={{width:42,height:42,borderRadius:11,background:o.primary?"var(--blue-500)":"var(--blue-100)",color:o.primary?"#fff":"var(--blue-700)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                      {o.ic}
                    </div>
                    <div style={{flex:1}}>
                      <div style={{fontWeight:600,fontSize:14}}>{o.l} {o.primary && <span className="badge b-blue" style={{marginLeft:4,fontSize:10}}>موصى به</span>}</div>
                      <div className="muted" style={{fontSize:12,marginTop:3}}>{o.sub}</div>
                    </div>
                    <I.ArrowRight size={14} style={{color:"var(--ink-400)"}}/>
                  </button>
                ))}
              </div>
            </div>
          ) : step===2 ? (
            <div>
              <div className="serif" style={{fontSize:26,marginBottom:6}}>من تود زيارته؟</div>
              <div className="muted" style={{fontSize:13.5,marginBottom:22}}>أخصائيك المعتاد أو شخص جديد — الخيار لك.</div>

              <div className="rgrid c-sm" style={{"--gtc":"1fr 1fr",gap:10}}>
                {[
                  ...DATA.therapists.filter(t=>t.active!==false).map(t=>({ name:t.name, spec:t.spec||"", color:t.color||"#7BBDE8", yourUsual: t.name===PATIENT_ME.therapist })),
                  { name:"أي أخصائي", spec:"الأقرب توفرًا", color:"#BDD8E9", any:true },
                ].map((t,i)=>(
                  <button key={i} onClick={()=>{setPicks({...picks,therapist:t.name}); next();}} style={{
                    padding:16,textAlign:"left",cursor:"pointer",fontFamily:"inherit",
                    border:`1px solid ${picks.therapist===t.name?"var(--blue-500)":"var(--ink-200)"}`,
                    background: picks.therapist===t.name?"var(--blue-50)":"#fff",
                    borderRadius:14,display:"flex",alignItems:"center",gap:12,transition:"all .15s"
                  }}>
                    {t.any ? (
                      <div style={{width:44,height:44,borderRadius:12,background:"var(--ink-100)",display:"flex",alignItems:"center",justifyContent:"center",color:"var(--ink-700)",flexShrink:0}}>
                        <I.Users size={18}/>
                      </div>
                    ) : (
                      <div className="av lg" style={{background:t.color+"33",color:t.color}}>{t.name.split(" ").map(x=>x[0]).join("")}</div>
                    )}
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{display:"flex",alignItems:"center",gap:6}}>
                        <span style={{fontWeight:600,fontSize:14}}>{t.name}</span>
                        {t.yourUsual && <span className="badge b-blue" style={{fontSize:10}}>المعتاد</span>}
                      </div>
                      <div className="muted" style={{fontSize:11.5,marginTop:1}}>{t.spec}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ) : step===3 ? (
            <div>
              <div className="serif" style={{fontSize:26,marginBottom:6}}>ما الوقت المناسب لك؟</div>
              <div className="muted" style={{fontSize:13.5,marginBottom:22}}>Showing live availability for {picks.therapist}.</div>

              {(() => {
                const bookingDays = __bkDays(7, picks.therapist, null);
                const todayInfo   = bookingDays[0] || { todayIso: __bkIso(new Date()), nowHM: "00:00" };
                const dayInfo     = bookingDays.find(d => d.iso === picks.date);
                const takenTimes  = dayInfo ? dayInfo.takenTimes : new Set();
                return (
                  <>
                    <div className="label">اختيار سريع</div>
                    <div className="rgrid quarter-sm" style={{"--gtc":"repeat(4,1fr)",gap:8,marginBottom:18}}>
                      {bookingDays.map(d => {
                        const sel = picks.date === d.iso;
                        const full = d.slots === 0;
                        return (
                          <button key={d.iso} disabled={full} onClick={()=> !full && setPicks({...picks,date:d.iso})} style={{
                            padding:"10px 6px",cursor:full?"not-allowed":"pointer",fontFamily:"inherit",
                            border:`1px solid ${sel?"var(--blue-500)":"var(--ink-200)"}`,
                            background:sel?"var(--blue-500)":full?"var(--ink-50)":"#fff",
                            color:sel?"#fff":full?"var(--ink-400)":"var(--ink-900)",borderRadius:10,
                            opacity: full ? .6 : 1,
                          }}>
                            <div style={{fontWeight:600,fontSize:13}}>{d.weekday}</div>
                            <div className="mono" style={{fontSize:10.5,opacity:.7}}>{d.day} {d.month}</div>
                            <div style={{fontSize:10,marginTop:3,color:sel?"#fff":full?"var(--ink-400)":"var(--green)"}}>
                              ● {full ? "ممتلئ" : `${d.slots} متاح`}
                            </div>
                          </button>
                        );
                      })}
                    </div>

                    <div className="label">وقت</div>
                    <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                      {__bkSlots().map(t => {
                        const isPast  = picks.date === todayInfo.todayIso && t <= todayInfo.nowHM;
                        const isTaken = takenTimes.has(t);
                        const unavail = isPast || isTaken;
                        const sel     = picks.time === t && !unavail;
                        return (
                          <button key={t} disabled={unavail} onClick={()=> !unavail && setPicks({...picks,time:t})}
                            title={isPast?"وقت سابق":isTaken?"محجوز":""}
                            style={{
                              padding:"8px 14px",fontFamily:"inherit",cursor:unavail?"not-allowed":"pointer",
                              border:`1px solid ${sel?"var(--blue-500)":"var(--ink-200)"}`,
                              background:sel?"var(--blue-500)":unavail?"var(--ink-100)":"#fff",
                              color:sel?"#fff":unavail?"var(--ink-300)":"var(--ink-900)",
                              textDecoration:unavail?"line-through":"none",
                              borderRadius:9,fontSize:13,fontWeight:500
                            }} className="mono">{t}</button>
                        );
                      })}
                    </div>
                  </>
                );
              })()}
            </div>
          ) : (
            <div>
              <div className="serif" style={{fontSize:26,marginBottom:6}}>هل يبدو جيدًا؟</div>
              <div className="muted" style={{fontSize:13.5,marginBottom:22}}>مراجعة and confirm. You can reschedule or cancel up to 4 hours before.</div>

              <div style={{
                padding:20,
                background:"linear-gradient(135deg, var(--blue-50), #fff)",
                border:"1px solid var(--blue-100)",borderRadius:14,marginBottom:14
              }}>
                <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:14}}>
                  <div>
                    <div className="mono" style={{fontSize:10.5,letterSpacing:".06em",textTransform:"uppercase",color:"var(--ink-500)",marginBottom:4}}>موعدك</div>
                    <div className="serif" style={{fontSize:30,lineHeight:1.05}}>{picks.date}</div>
                    <div className="mono" style={{fontSize:18,marginTop:4,color:"var(--blue-700)",fontWeight:600}}>{picks.time} · 45 minutes</div>
                  </div>
                  <I.Calendar size={28} style={{color:"var(--blue-500)"}}/>
                </div>
                <hr className="sep" style={{margin:"14px 0"}}/>
                <div className="rgrid half-sm" style={{"--gtc":"1fr 1fr",gap:12,fontSize:13}}>
                  <div>
                    <div className="muted" style={{fontSize:11}}>الأخصائي</div>
                    <div style={{fontWeight:500}}>{picks.therapist}</div>
                  </div>
                  <div>
                    <div className="muted" style={{fontSize:11}}>النوع</div>
                    <div style={{fontWeight:500}}>{picks.reason==="new"?"مشكلة جديدة assessment":picks.reason==="followup"?"الطبيب follow-up":picks.reason==="assess"?"تقييم أولي":"علاج يدوي"}</div>
                  </div>
                  <div>
                    <div className="muted" style={{fontSize:11}}>المكان</div>
                    <div style={{fontWeight:500}}>Kinetic مصر الجديدة · غرفة 2</div>
                  </div>
                  <div>
                    <div className="muted" style={{fontSize:11}}>التكلفة</div>
                    <div style={{fontWeight:500}}>{picks.reason==="continue" ? "من الباقة" : "EGP 850"}</div>
                  </div>
                </div>
              </div>

              <label style={{display:"flex",alignItems:"flex-start",gap:10,padding:14,background:"var(--ink-50)",borderRadius:10,fontSize:12.5,cursor:"pointer"}}>
                <input type="checkbox" defaultChecked style={{marginTop:2}}/>
                <span>Send me a واتساب reminder 24 hours before this visit at <span className="mono">{PATIENT_ME.phone}</span>.</span>
              </label>
            </div>
          )}
        </div>

        {/* Footer */}
        {!confirming && (
          <div style={{padding:"14px 24px",borderTop:"1px solid var(--ink-100)",display:"flex",alignItems:"center",justifyContent:"space-between",background:"#fff",flexWrap:"wrap",gap:8}}>
            <button className="btn btn-ghost" onClick={step===1?onClose:()=>setStep(step-1)}>
              <I.ArrowLeft size={13}/> {step===1?"إلغاء":"رجوع"}
            </button>
            <div style={{display:"flex",alignItems:"center",gap:14}}>
              {step>=3 && (
                <span className="muted" style={{fontSize:12}}>
                  {picks.date} · {picks.time}
                </span>
              )}
              <button className="btn btn-blue" onClick={next} disabled={step===1 && !picks.reason}>
                {step<4 ? "متابعة" : "تأكيد الحجز"} <I.ArrowRight size={13}/>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

Object.assign(window, { PatientPortal });


// ═══════════════════════════════════════════════════════════════
// PUBLIC BOOKING — no account, accessible from login screen
// ═══════════════════════════════════════════════════════════════

function PublicBookingScreen({ onBack, onDone }) {
  // Live-tick so past-time gating stays honest; useDataVersion so
  // bookings created elsewhere flow into the availability counts.
  const [nowTick, setNowTick] = React.useState(() => Date.now());
  React.useEffect(() => { const id = setInterval(() => setNowTick(Date.now()), 60_000); return () => clearInterval(id); }, []);
  window.useDataVersion && window.useDataVersion();

  const [step, setStep] = React.useState(1); // 1..5
  const [picks, setPicks] = React.useState({
    reason: null,
    therapist: null,
    date: __bkIso(new Date()),
    time: "",
    name: "",
    phone: "",
    isExisting: null, // true / false / null
  });
  const [confirming, setConfirming] = React.useState(false);

  function update(k,v) { setPicks(p=>({...p,[k]:v})); }
  function next() {
    // Gate step 3 against past dates / past times so the DB never
    // receives an invalid booking.
    if (step === 3) {
      if (!picks.date || !picks.time) {
        if (window.showToast) window.showToast("اختر التاريخ والوقت", "error");
        return;
      }
      const now = new Date(nowTick);
      const todayIso = __bkIso(now);
      const nowHM = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
      if (picks.date < todayIso || (picks.date === todayIso && picks.time <= nowHM)) {
        if (window.showToast) window.showToast("لا يمكن الحجز في وقت سابق", "error");
        return;
      }
    }
    if (step < 5) { setStep(step+1); return; }
    setConfirming(true);
    // Persist the booking so it shows up in reception/dashboard views.
    if (window.KineticData) {
      const therapistRow = (DATA.therapists || []).find(t => t.name === picks.therapist);
      const bookingId = "B-" + Date.now();
      window.KineticData.upsert("appts", {
        booking_id: bookingId,
        id: bookingId,
        patient: picks.name || null,
        therapist_id: (therapistRow && (therapistRow.staff_id || therapistRow.id)) || null,
        th: picks.therapist || null,
        date: picks.date,
        time: picks.time,
        status: "معلّق",
        notes: (picks.reason || "") + (picks.phone ? ` · ${picks.phone}` : ""),
      }).catch(e => console.warn("public booking persist failed", e));
    }
    setTimeout(()=>{ onDone(picks); }, 1400);
  }

  const stepsMeta = ["السبب","الأخصائي","التاريخ & time","بياناتك","التأكيد"];

  return (
    <div style={{minHeight:"100vh",background:"var(--blue-50)",display:"flex",flexDirection:"column"}}>
      {/* Top */}
      <header style={{background:"#fff",borderBottom:"1px solid var(--ink-200)",padding:"12px clamp(12px, 3vw, 24px)",display:"flex",alignItems:"center",gap:14,flexWrap:"wrap"}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <I.Logo size={30}/>
          <div style={{display:"flex",flexDirection:"column",lineHeight:1.1}}>
            <span style={{fontWeight:600,fontSize:15,letterSpacing:"-.01em"}}>BeActive</span>
            <span style={{fontSize:10,color:"var(--ink-500)",letterSpacing:".06em",textTransform:"uppercase"}}>العلاج الطبيعي</span>
          </div>
        </div>
        <div style={{flex:1}}/>
        {(window.CLINIC && window.CLINIC.phone) && <span className="muted" style={{fontSize:13}}>تحتاج مساعدة؟ <a href={`tel:${String(window.CLINIC.phone).replace(/[^\d+]/g,"")}`} style={{color:"var(--blue-700)",fontWeight:500}}>{window.CLINIC.phone}</a></span>}
        <button className="btn btn-ghost" onClick={onBack}><I.X size={14}/> إغلاق</button>
      </header>

      <div style={{flex:1,display:"flex",justifyContent:"center",alignItems:"flex-start",padding:"32px 20px 60px"}}>
        <div style={{width:"100%",maxWidth:780}}>
          {/* Hero copy */}
          {!confirming && (
            <div style={{textAlign:"center",marginBottom:28}}>
              <div className="muted" style={{fontSize:13,letterSpacing:".06em",textTransform:"uppercase",marginBottom:8}}>احجز زيارة</div>
              <div className="serif" style={{fontSize:"clamp(28px, 6.5vw, 44px)",lineHeight:1.05,letterSpacing:"-.01em",color:"var(--ink-900)",maxWidth:560,margin:"0 auto"}}>
                {step===1 && <>هيا بنا نعيدك إلى <em>الحركة</em> من جديد.</>}
                {step===2 && <>اختر من تود زيارته.</>}
                {step===3 && <>ما الوقت المناسب لك؟</>}
                {step===4 && <>آخر خطوة — كيف نتواصل معك؟</>}
                {step===5 && <>جاهز للتأكيد.</>}
              </div>
            </div>
          )}

          {/* Stepper */}
          {!confirming && (
            <div style={{display:"flex",gap:6,marginBottom:22,maxWidth:560,marginLeft:"auto",marginRight:"auto"}}>
              {stepsMeta.map((s,i)=>(
                <div key={i} style={{flex:1}}>
                  <div style={{
                    height:5,borderRadius:999,
                    background: i+1<step?"var(--green)":i+1===step?"var(--blue-500)":"var(--ink-200)",
                    transition:"background .25s"
                  }}/>
                  <div style={{
                    fontSize:10.5,letterSpacing:".02em",
                    color:i+1===step?"var(--ink-900)":"var(--ink-500)",
                    fontWeight:i+1===step?600:500,
                    textAlign:"center",marginTop:6,
                    textTransform:"uppercase"
                  }}>{s}</div>
                </div>
              ))}
            </div>
          )}

          {/* Card */}
          <div className="card" style={{padding:0,boxShadow:"0 20px 50px rgba(15,30,43,.06)",overflow:"hidden"}}>
            <div style={{padding:"clamp(18px, 4vw, 32px) clamp(14px, 4vw, 36px)",minHeight:380}}>

              {confirming && (
                <div style={{textAlign:"center",padding:"40px 0"}}>
                  <div style={{width:64,height:64,borderRadius:999,background:"var(--green-bg)",color:"var(--green)",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 22px"}}>
                    <I.Check size={30}/>
                  </div>
                  <div className="serif" style={{fontSize:38,lineHeight:1.1,marginBottom:8}}>تم حجزك!</div>
                  <div className="muted" style={{fontSize:14,maxWidth:380,margin:"0 auto"}}>
                    A واتساب confirmation just went to <span className="mono">{picks.phone || "your phone"}</span> بكل التفاصيل.
                  </div>

                  <div style={{
                    marginTop:30, padding:18,
                    background:"linear-gradient(135deg, var(--blue-50), #fff)",
                    border:"1px solid var(--blue-100)",borderRadius:14,
                    maxWidth:380,margin:"30px auto 0",textAlign:"left"
                  }}>
                    <div className="muted" style={{fontSize:11,letterSpacing:".06em",textTransform:"uppercase",marginBottom:6}}>زيارتك</div>
                    <div className="serif" style={{fontSize:24,lineHeight:1.1}}>{(() => {
                      const d = new Date(picks.date + "T00:00:00");
                      if (isNaN(d)) return picks.date;
                      return `${__BK_AR_WD[d.getDay()]}، ${d.getDate()} ${__BK_AR_MO[d.getMonth()]}`;
                    })()}</div>
                    <div className="mono" style={{fontSize:16,color:"var(--blue-700)",fontWeight:600,marginTop:4}}>{picks.time || "—"}</div>
                    <hr className="sep" style={{margin:"12px 0"}}/>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,fontSize:12.5}}>
                      <div><div className="muted" style={{fontSize:10.5}}>الأخصائي</div>{picks.therapist || "أي متاح"}</div>
                      <div><div className="muted" style={{fontSize:10.5}}>المكان</div>مصر الجديدة · غرفة 2</div>
                    </div>
                  </div>

                  <button className="btn btn-secondary" style={{marginTop:24}} onClick={onBack}>رجوع to home</button>
                </div>
              )}

              {/* STEP 1 — reason / new vs existing */}
              {!confirming && step===1 && (
                <div>
                  <div className="label" style={{marginBottom:10}}>ما الذي يحضرك إلينا؟</div>
                  <div className="rgrid c-sm" style={{"--gtc":"1fr 1fr",gap:10}}>
                    {[
                      { id:"existing-pain",  l:"ألم أو إصابة موجودة", sub:"ظهر، رقبة، ركبة، كتف، إلخ.",      ic:<I.Heart size={18}/> },
                      { id:"post-op",        l:"التعافي بعد جراحة",  sub:"رباط صليبي، استبدال مفصل، إلخ.",          ic:<I.Activity size={18}/> },
                      { id:"sports",         l:"إصابة رياضية",           sub:"شدّ، التواء، العودة للنشاط",        ic:<I.Sparkle size={18}/> },
                      { id:"assess",         l:"تقييم فقط",      sub:"لست متأكدًا بعد — لنتحدث أولًا",        ic:<I.Stethoscope size={18}/> },
                    ].map(o=>(
                      <button key={o.id} onClick={()=>{update("reason",o.id); next();}} style={{
                        padding:18,textAlign:"left",cursor:"pointer",fontFamily:"inherit",
                        border:`1px solid ${picks.reason===o.id?"var(--blue-500)":"var(--ink-200)"}`,
                        background:picks.reason===o.id?"var(--blue-50)":"#fff",
                        borderRadius:14,display:"flex",alignItems:"center",gap:14,transition:"all .15s"
                      }}
                        onMouseEnter={e=>{e.currentTarget.style.borderColor="var(--blue-500)";}}
                        onMouseLeave={e=>{if(picks.reason!==o.id)e.currentTarget.style.borderColor="var(--ink-200)";}}
                      >
                        <div style={{width:44,height:44,borderRadius:12,background:"var(--blue-100)",color:"var(--blue-700)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                          {o.ic}
                        </div>
                        <div style={{flex:1}}>
                          <div style={{fontWeight:600,fontSize:14}}>{o.l}</div>
                          <div className="muted" style={{fontSize:12,marginTop:3}}>{o.sub}</div>
                        </div>
                        <I.ArrowRight size={15} style={{color:"var(--ink-400)"}}/>
                      </button>
                    ))}
                  </div>

                  <div style={{marginTop:22,padding:14,background:"var(--ink-50)",borderRadius:11,display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}>
                    <div style={{display:"flex",alignItems:"center",gap:10,fontSize:13}}>
                      <I.User size={15} style={{color:"var(--ink-500)"}}/>
                      <span>هل أنت مريض حالي؟</span>
                    </div>
                    <div className="seg">
                      <button className={picks.isExisting===true?"on":""}  onClick={()=>update("isExisting",true)}>نعم</button>
                      <button className={picks.isExisting===false?"on":""} onClick={()=>update("isExisting",false)}>لا، أول مرة</button>
                    </div>
                  </div>
                </div>
              )}

              {/* STEP 2 — therapist */}
              {!confirming && step===2 && (
                <div>
                  <div className="label" style={{marginBottom:10}}>اختر أخصائيًا</div>
                  <div className="rgrid c-sm" style={{"--gtc":"1fr 1fr",gap:10}}>
                    {[
                      { name:"أي أخصائي",  spec:"أقرب موعد",        color:"#BDD8E9", any:true, recommended:true },
                      ...DATA.therapists.filter(t=>t.active!==false).map(t=>({ name:t.name, spec:t.spec, color:t.color }))
                    ].map((t,i)=>(
                      <button key={i} onClick={()=>{update("therapist",t.any?null:t.name); next();}} style={{
                        padding:16,textAlign:"left",cursor:"pointer",fontFamily:"inherit",
                        border:`1px solid ${picks.therapist===(t.any?null:t.name)?"var(--blue-500)":"var(--ink-200)"}`,
                        background:picks.therapist===(t.any?null:t.name)?"var(--blue-50)":"#fff",
                        borderRadius:14,display:"flex",alignItems:"center",gap:12,transition:"all .15s"
                      }}>
                        {t.any ? (
                          <div style={{width:44,height:44,borderRadius:12,background:"var(--ink-100)",display:"flex",alignItems:"center",justifyContent:"center",color:"var(--ink-700)",flexShrink:0}}>
                            <I.Users size={18}/>
                          </div>
                        ) : (
                          <div className="av lg" style={{background:t.color+"33",color:t.color}}>{t.name.split(" ").map(x=>x[0]).join("")}</div>
                        )}
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{display:"flex",alignItems:"center",gap:6}}>
                            <span style={{fontWeight:600,fontSize:14}}>{t.name}</span>
                            {t.recommended && <span className="badge b-blue" style={{fontSize:10}}>الأسرع</span>}
                          </div>
                          <div className="muted" style={{fontSize:11.5,marginTop:1}}>{t.spec}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* STEP 3 — date & time (dynamic, DB-driven) */}
              {!confirming && step===3 && (() => {
                const bookingDays = __bkDays(7, picks.therapist, null);
                const todayInfo   = bookingDays[0] || { todayIso: __bkIso(new Date()), nowHM: "00:00" };
                const dayInfo     = bookingDays.find(d => d.iso === picks.date);
                const takenTimes  = dayInfo ? dayInfo.takenTimes : new Set();
                return (
                <div>
                  <div className="label" style={{marginBottom:10}}>اختر يومًا</div>
                  <div className="rgrid quarter-sm" style={{"--gtc":"repeat(7,1fr)",gap:6,marginBottom:22}}>
                    {bookingDays.map(d => {
                      const sel  = picks.date === d.iso;
                      const full = d.slots === 0;
                      return (
                        <button key={d.iso} disabled={full} onClick={()=> !full && update("date",d.iso)}
                          title={full?"لا تتوفر مواعيد":`${d.slots} موعد متاح`}
                          style={{
                            padding:"12px 4px",cursor:full?"not-allowed":"pointer",fontFamily:"inherit",
                            border:`1px solid ${sel?"var(--blue-500)":"var(--ink-200)"}`,
                            background:sel?"var(--blue-500)":full?"var(--ink-50)":"#fff",
                            color:sel?"#fff":full?"var(--ink-400)":"var(--ink-900)",borderRadius:10,
                            opacity: full?.6:1,
                          }}>
                          <div style={{fontWeight:600,fontSize:13}}>{d.weekday}</div>
                          <div className="mono" style={{fontSize:10.5,opacity:.7}}>{d.day} {d.month}</div>
                          <div style={{fontSize:10,marginTop:3,color:sel?"#fff":full?"var(--ink-400)":"var(--green)"}}>
                            ● {full ? "ممتلئ" : `${d.slots} متاح`}
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  <div className="label" style={{marginBottom:10}}>اختر وقتًا</div>
                  <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                    {__bkSlots().map(t => {
                      const isPast  = picks.date === todayInfo.todayIso && t <= todayInfo.nowHM;
                      const isTaken = takenTimes.has(t);
                      const unavail = isPast || isTaken;
                      const sel     = picks.time === t && !unavail;
                      return (
                        <button key={t} disabled={unavail} onClick={()=> !unavail && update("time",t)}
                          title={isPast?"وقت سابق":isTaken?"محجوز":""}
                          style={{
                            padding:"10px 16px",fontFamily:"inherit",cursor:unavail?"not-allowed":"pointer",
                            border:`1px solid ${sel?"var(--blue-500)":"var(--ink-200)"}`,
                            background:sel?"var(--blue-500)":unavail?"var(--ink-100)":"#fff",
                            color:sel?"#fff":unavail?"var(--ink-300)":"var(--ink-900)",
                            textDecoration:unavail?"line-through":"none",
                            borderRadius:10,fontSize:13,fontWeight:500
                          }} className="mono">{t}</button>
                      );
                    })}
                  </div>
                </div>
                );
              })()}

              {/* STEP 4 — contact info */}
              {!confirming && step===4 && (
                <div style={{maxWidth:480,margin:"0 auto"}}>
                  <div style={{display:"grid",gridTemplateColumns:"1fr",gap:14}}>
                    <Field label="الاسم الكامل" required>
                      <input className="input" style={{height:44,fontSize:14}}
                        placeholder="مثال: آية حسن"
                        value={picks.name} onChange={e=>update("name",e.target.value)} autoFocus/>
                    </Field>
                    <Field label="الموبايل (واتساب)" required hint="سنرسل التأكيد والتذكيرات هنا.">
                      <input className="input" style={{height:44,fontSize:14}}
                        placeholder="+20 1XX XXX XXXX"
                        value={picks.phone} onChange={e=>update("phone",e.target.value)}/>
                    </Field>
                    {picks.isExisting === false && (
                      <Field label="باختصار، ما الذي يضايقك؟" hint="اختياري — يساعد الأخصائي على التحضير">
                        <textarea className="input" style={{height:72,padding:10,resize:"vertical"}}
                          placeholder="مثال: ألم أسفل الظهر منذ رفع أثقال بالجيم الأسبوع الماضي"/>
                      </Field>
                    )}
                    <label style={{display:"flex",alignItems:"flex-start",gap:10,padding:12,background:"var(--ink-50)",borderRadius:10,fontSize:12.5,cursor:"pointer"}}>
                      <input type="checkbox" defaultChecked style={{marginTop:2}}/>
                      <span>I agree to receive a واتساب confirmation and a reminder 24 hours before my visit.</span>
                    </label>
                  </div>
                </div>
              )}

              {/* STEP 5 — confirm */}
              {!confirming && step===5 && (
                <div>
                  <div style={{
                    padding:24,
                    background:"linear-gradient(135deg, var(--blue-50), #fff)",
                    border:"1px solid var(--blue-100)",borderRadius:14,marginBottom:14
                  }}>
                    <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:16}}>
                      <div>
                        <div className="mono" style={{fontSize:10.5,letterSpacing:".06em",textTransform:"uppercase",color:"var(--ink-500)",marginBottom:4}}>موعدك</div>
                        <div className="serif" style={{fontSize:36,lineHeight:1.05}}>{picks.date}</div>
                        <div className="mono" style={{fontSize:20,marginTop:6,color:"var(--blue-700)",fontWeight:600}}>{picks.time} · 45 minutes</div>
                      </div>
                      <I.Calendar size={30} style={{color:"var(--blue-500)"}}/>
                    </div>
                    <hr className="sep" style={{margin:"14px 0"}}/>
                    <div className="rgrid half-sm" style={{"--gtc":"1fr 1fr",gap:14,fontSize:13}}>
                      <div>
                        <div className="muted" style={{fontSize:11}}>الأخصائي</div>
                        <div style={{fontWeight:500}}>{picks.therapist || "أي متاح"}</div>
                      </div>
                      <div>
                        <div className="muted" style={{fontSize:11}}>السبب</div>
                        <div style={{fontWeight:500}}>{({
                          "existing-pain":"ألم أو إصابة موجودة",
                          "post-op":"التعافي بعد جراحة",
                          "sports":"إصابة رياضية",
                          "assess":"Assessment",
                        })[picks.reason] || "—"}</div>
                      </div>
                      <div>
                        <div className="muted" style={{fontSize:11}}>الاسم</div>
                        <div style={{fontWeight:500}}>{picks.name || <span className="muted">غير مزوّد</span>}</div>
                      </div>
                      <div>
                        <div className="muted" style={{fontSize:11}}>واتساب</div>
                        <div className="mono" style={{fontWeight:500}}>{picks.phone || <span className="muted">غير مزوّد</span>}</div>
                      </div>
                      <div>
                        <div className="muted" style={{fontSize:11}}>المكان</div>
                        <div style={{fontWeight:500}}>BeActive مصر الجديدة · غرفة 2</div>
                      </div>
                      <div>
                        <div className="muted" style={{fontSize:11}}>التكلفة</div>
                        <div style={{fontWeight:500}}>850 ج.م — تُدفع بالعيادة</div>
                      </div>
                    </div>
                  </div>

                  <div style={{padding:14,background:"var(--green-bg)",border:"1px solid #BCE0D1",borderRadius:11,fontSize:12.5,color:"#2C8067",display:"flex",alignItems:"center",gap:10}}>
                    <I.Check size={15}/>
                    مجاناً لإعادة الجدولة أو الإلغاء قبل 4 ساعات من الزيارة.
                  </div>
                </div>
              )}

            </div>

            {/* Footer */}
            {!confirming && (
              <div style={{padding:"14px 24px",borderTop:"1px solid var(--ink-100)",display:"flex",justifyContent:"space-between",background:"var(--ink-50)",flexWrap:"wrap",gap:8}}>
                <button className="btn btn-secondary" onClick={step===1?onBack:()=>setStep(step-1)}>
                  <I.ArrowLeft size={13}/> {step===1?"إلغاء":"رجوع"}
                </button>
                <button className="btn btn-blue" onClick={next}
                  disabled={(step===1 && !picks.reason) || (step===4 && (!picks.name || !picks.phone))}>
                  {step<5 ? "متابعة" : "تأكيد الحجز"} <I.ArrowRight size={13}/>
                </button>
              </div>
            )}
          </div>

          {/* Trust strip */}
          {!confirming && (
            <div style={{display:"flex",justifyContent:"center",gap:32,marginTop:24,flexWrap:"wrap"}}>
              {[
                // { ic:<I.Check size={14}/>, t:"4.9 ★ from 1,400+ مريض" },
                // { ic:<I.Lock size={14}/>,  t:"طبي-grade privacy" },
                // { ic:<I.WhatsApp size={14}/>, t:"Confirmation بواسطة واتساب" },
              ].map((tr,i)=>(
                <div key={i} style={{display:"flex",alignItems:"center",gap:8,fontSize:12,color:"var(--ink-500)"}}>
                  <span style={{color:"var(--blue-700)"}}>{tr.ic}</span>{tr.t}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { PublicBookingScreen });

