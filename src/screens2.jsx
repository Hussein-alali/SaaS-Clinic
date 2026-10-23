

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

// Loads a classic script once and resolves after it has run. Used for code
// only some visits need (Excel export, the ?import=1 page) so it stays out
// of the first page load.
const scriptLoads = {};
function loadScriptOnce(src) {
  if (!scriptLoads[src]) {
    scriptLoads[src] = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => { delete scriptLoads[src]; reject(new Error("failed to load " + src)); };
      document.head.appendChild(s);
    });
  }
  return scriptLoads[src];
}

// ── Excel export (styled; right-to-left in Arabic, left-to-right in English) ──
// Builds a professional workbook from the ALREADY-FILTERED report rows:
// clinic name, report title, generated date, active filters, bold header
// band, bordered table, column widths, number/currency formats, and a
// totals row. Handles thousands of rows (a single aoa_to_sheet + writeFile,
// no per-render DOM).
//
// Uses the xlsx-js-style fork of SheetJS (community SheetJS can't write
// cell styles), fetched on the first export rather than on every page load.
//
// columns: [{ key, label, type?: 'text'|'number'|'currency'|'date', total?, width? }]
const XLSX_SRC = "https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js";
async function exportReportExcel({ filename, sheetName = tt("التقرير"), title, filters = [], columns = [], rows = [] }) {
  if (!window.XLSX) await loadScriptOnce(XLSX_SRC).catch(() => {});
  const XLSX = window.XLSX;
  if (!XLSX || !XLSX.utils) {
    window.showToast && window.showToast(tt("مكتبة Excel غير محمّلة — تحقق من الاتصال"), "error");
    return false;
  }
  const clinic = (window.CLINIC && window.CLINIC.name) || tt("العيادة");
  const genDate = fmtDate(new Date(), { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
  const nCols = Math.max(columns.length, 1);

  const aoa = [];
  aoa.push([clinic]);
  aoa.push([title || sheetName]);
  aoa.push([tt("تاريخ الإنشاء: {date}", { date: genDate })]);
  const filterRow = filters.length ? aoa.length : -1;
  if (filters.length) aoa.push([tt("عوامل التصفية:  {list}", { list: filters.map(f => `${f.label}: ${f.value}`).join("   |   ") })]);
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
      if (i === 0) return tt("الإجمالي");
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
  ws["!views"] = [{ RTL: IS_RTL }];

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
        // Numbers at the end of the cell, text at its start (physical sides in Excel).
        const endSide = IS_RTL ? "left" : "right", startSide = IS_RTL ? "right" : "left";
        cell.s = { border: borders, alignment: { horizontal: numeric ? endSide : startSide, vertical: "center" } };
        if (R === totalsRowIdx) { cell.s.font = { bold: true }; cell.s.fill = { fgColor: { rgb: "FFEEF2F6" } }; }
        // Money like fmtMoney: «1,250 ج.م» / «EGP 1,250».
        if (typeof cell.v === "number") cell.z = col.type === "currency" ? (IS_RTL ? '#,##0 "ج.م"' : '"EGP" #,##0') : "#,##0";
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
        updated: updatedAt ? fmtDate(updatedAt, { year: "numeric", month: "numeric", day: "numeric" }) : "—",
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
    const msg = tt("حذف خطة العلاج «{diag}» للمريض {patient}؟", { diag: plan.diag, patient: plan.patient }) + "\n"
      + tt("لن تُحذف الجلسات المرتبطة — سيُلغى ربطها فقط. لا يمكن التراجع عن هذا الإجراء.");
    if (!window.confirm(msg)) return;
    try {
      const res = await window.TreatmentsAPI.delete(plan.id);
      const n = res && res.sessions_unlinked ? res.sessions_unlinked : 0;
      window.showToast && window.showToast(
        n > 0 ? tt("تم حذف الخطة وإلغاء ربط {n} جلسة", { n }) : tt("تم حذف الخطة"), "success");
      if (view === "detail") setView("list");
      setSelected(null);
      reload();
    } catch (e) {
      console.warn("delete treatment failed", e);
      window.showToast && window.showToast(e.message || tt("تعذّر حذف الخطة"), "error");
    }
  }

  if (view === "detail" && selected) return <TreatmentPlanDetail plan={selected} onBack={()=>setView("list")} canDelete={canDelete} onDelete={()=>onDeletePlan(selected)}/>;
  if (view === "physio-session") return <PhysioSessionForm onBack={()=>setView("list")}/>;

  return (
    <Page>
      <div className="page-head">
        <div>
          <div className="crumb"><span>{tt("الرئيسية")}</span><I.Chevron size={11}/><span>{tt("خطط العلاج")}</span></div>
          <h1 className="h1">{tt("خطط العلاج")}</h1>
          <div className="muted" style={{fontSize:13.5,marginTop:4}}>{tt("{active} نشط · {drafts} مسودات · متوسط التقدم {avg}%", { active: planStats.active, drafts: planStats.drafts, avg: avgProgress })}</div>
        </div>
        <div className="page-actions">
          <button className="btn btn-blue" onClick={()=>setView("physio-session")}><I.Activity size={14}/> {tt("تشخيص")}</button>
        </div>
      </div>

      <div className="grid-3" style={{marginBottom:18}}>
        <StatCard label={tt("خطط نشطة")} value={planStats.active} accent="#7BBDE8" icon={<I.Clipboard size={15}/>}/>
        <StatCard label={tt("خطط مكتملة")} value={String(planStats.done)} accent="#3FA984" icon={<I.Check size={15}/>}/>
        <StatCard label={tt("متوسط التقدّم")} value={`${avgProgress}%`} accent="#7E6BD3" icon={<I.Activity size={15}/>}/>
      </div>

      <div className="card" style={{overflow:"hidden"}}>
        <div className="tbl-scroll">
        <CardTable>
          <thead><tr><th>{tt("الخطة")}</th><th>{tt("المريض")}</th><th>{tt("التشخيص")}</th><th>{tt("الأخصائي")}</th><th>{tt("التقدّم")}</th><th>{tt("الجلسات")}</th><th>{tt("الحالة")}</th><th>{tt("آخر تحديث")}</th>{canDelete && <th><span className="sr-only">{tt("إجراءات")}</span></th>}</tr></thead>
          <tbody>
            {plans.length===0 && !loadingRecords && (
              <tr><td colSpan={canDelete?9:8}><EmptyState icon={<I.Clipboard size={22}/>} title={tt("لا خطط علاج بعد")} body={tt("ستظهر خطط العلاج هنا بعد إنشائها.")}/></td></tr>
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
                    <span className="dot"></span>{tt(p.status)}
                  </span>
                </td>
                <td className="muted">{p.updated}</td>
                {canDelete && (
                  <td style={{textAlign:"end"}} onClick={e=>e.stopPropagation()}>
                    <button className="btn btn-ghost btn-icon" title={tt("حذف الخطة")} aria-label={tt("حذف الخطة")}
                      onClick={(e)=>{e.stopPropagation();onDeletePlan(p);}}>
                      <I.Trash size={13}/>
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </CardTable>
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
      <div className="crumb" style={{cursor:"pointer"}} onClick={onBack}><span>{tt("خطط العلاج")}</span><I.Chevron size={11}/><span style={{color:"var(--ink-700)"}}>{plan.id}</span></div>
      <div className="page-head" style={{alignItems:"flex-start"}}>
        <div>
          <h1 className="h1">{plan.diag}</h1>
          <div className="muted" style={{fontSize:13.5,marginTop:4}}>{tt("المريض: {patient} · الأخصائي: {therapist}", { patient: plan.patient, therapist: plan.therapist })}{plan.p && plan.p.registered ? " · " + tt("سُجّل {date}", { date: plan.p.registered }) : ""}</div>
        </div>
        <div className="page-actions">
          <button className="btn btn-secondary" onClick={()=>window.print()}><I.Print size={13}/> {tt("طباعة")}</button>
          {canDelete && onDelete && (
            <button className="btn btn-secondary" style={{color:"#A8443A"}} onClick={onDelete}>
              <I.Trash size={13}/> {tt("حذف الخطة")}
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
      textAlign: "start", marginBottom: 14,
      borderBottom: "1px solid var(--ink-200)", paddingBottom: 8,
    }}>{title}</div>
    {children}
  </div>
);

const PhysioLabelRow = ({ label, required, control }) => (
  <div style={{display:"flex", alignItems:"center", gap:12, padding:"6px 0"}}>
    <div style={{flex:1, textAlign:"start", fontSize:13, fontWeight:500, color:"var(--ink-900)"}}>
      {label}{required && <span style={{color:"#A8443A", marginInlineStart:4}}>*</span>}
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
    <span style={{flex:1, textAlign:"start", fontSize:13, fontWeight:500, color:"var(--ink-900)"}}>
      {children}
    </span>
  </label>
);

const PhysioTA = (props) => (
  <textarea {...props}
    style={{
      width:"100%", minHeight: props.rows ? undefined : 70,
      padding: 10, borderRadius: 10, border: "1px solid var(--ink-200)",
      background: "#fff", resize: "vertical", textAlign: "start",
      fontFamily: "inherit", fontSize: 13,
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
    if (!therapistId) { window.showToast && window.showToast(tt("اختر الأخصائي المسؤول"), "error"); return; }
    if (!patientId)   { window.showToast && window.showToast(tt("اختر المريض"), "error"); return; }
    try {
      localStorage.setItem(physioStoreKey(patientId), JSON.stringify(form));
      window.showToast && window.showToast(tt("تم حفظ نموذج الجلسة"), "success");
    } catch (_) {
      window.showToast && window.showToast(tt("تعذّر الحفظ محليًا"), "error");
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
        <span>{tt("خطط العلاج")}</span><I.Chevron size={11}/>
        <span style={{color:"var(--ink-700)"}}>{tt("تشخيص")}</span>
      </div>
      <div className="page-head">
        <h1 className="h1">{tt("تشخيص")}</h1>
        <div className="page-actions">
          <button className="btn btn-ghost" onClick={onBack}>{tt("رجوع")}</button>
          <button className="btn btn-blue" onClick={save}><I.Check size={13}/> {tt("حفظ الجلسة")}</button>
        </div>
      </div>

      <div style={{maxWidth: 980, margin: "0 auto"}}>

        {/* 1. Patient & Therapist */}
        <PhysioCard title={tt("المريض والأخصائي")}>
          <div className="rgrid c-sm" style={{"--gtc":"repeat(2,1fr)", gap:14}}>
            <div>
              <div className="label" style={{color:"var(--ink-900)", textAlign:"start"}}>
                {tt("الأخصائي المسؤول")} <span style={{color:"#A8443A"}}>*</span>
              </div>
              <TherapistCombobox value={therapistId} onChange={setTherapistId}
                therapists={therapists} placeholder="Select therapist…"/>
            </div>
            <div>
              <div className="label" style={{color:"var(--ink-900)", textAlign:"start"}}>
                {tt("المريض")} <span style={{color:"#A8443A"}}>*</span>
              </div>
              <PatientCombobox value={patientId} onChange={setPatientId}
                patients={patients} placeholder="Search patient by name or ID…"/>
            </div>
          </div>
        </PhysioCard>

        {/* 2. Diagnosis */}
        <PhysioCard title={tt("التشخيص")}>
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
            <div className="label" style={{color:"var(--ink-900)", textAlign:"start"}}>Traction notes</div>
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
            <div className="label" style={{color:"var(--ink-900)", textAlign:"start"}}>Modalities notes</div>
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
                style={{width:260, textAlign:"start", opacity: form.nGlide ? 1 : 0.5}}/>
            }/>
          <div style={{height:8}}/>
          <div className="label" style={{color:"var(--ink-900)", textAlign:"start"}}>Ms Release</div>
          <input className="input" value={form.msRelease}
            onChange={e=>update({msRelease:e.target.value})}
            style={{textAlign:"start"}}/>
          <div style={{height:10}}/>
          <div className="label" style={{color:"var(--ink-900)", textAlign:"start"}}>Positioning</div>
          <input className="input" value={form.positioning}
            onChange={e=>update({positioning:e.target.value})}
            style={{textAlign:"start"}}/>
          <div style={{height:10}}/>
          <div className="label" style={{color:"var(--ink-900)", textAlign:"start"}}>
            Ex's, Stretching, Mobilization, Manipulation
          </div>
          <PhysioTA value={form.exercises} onChange={e=>update({exercises:e.target.value})}/>
          <div style={{height:10}}/>
          <div className="label" style={{color:"var(--ink-900)", textAlign:"start"}}>Manual Techniques notes</div>
          <PhysioTA value={form.manualNotes} onChange={e=>update({manualNotes:e.target.value})}/>
        </PhysioCard>

        {/* 6. Treatment Plans — Interactive Body Diagram */}
        <PhysioCard title="Treatment Plans">
          <div style={{fontSize:12.5, color:"var(--ink-500)", textAlign:"start", marginBottom:10}}>
            {tt("اضغط على أي موضع لإضافة علامة. اضغط على علامة موجودة لإزالتها.")}
          </div>
          <BodyDiagram
            markers={form.markers}
            onChange={markers => update({ markers })}
          />
          <div style={{fontSize:12, color:"var(--ink-500)", textAlign:"start", marginTop:10}}>
            {tt("المواضع المحددة: {n}", { n: form.markers.length })}
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
// existing one (within HIT_RADIUS %) removes it. Positions are physical
// (left/top of the picture) on purpose: the picture is never mirrored.
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
    if (!trimmed) { setError(tt("الاسم مطلوب")); return; }
    if (!/\S/.test(trimmed)) { setError(tt("الاسم لا يمكن أن يحتوي على مسافات فقط")); return; }
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
    if (!res.ok) { setError(res.error || tt("تعذّر الحفظ")); return; }
    if (window.showToast) window.showToast(editingId ? tt("تم تحديث طريقة العلاج") : tt("تمت إضافة طريقة العلاج"), "success");
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
      if (window.showToast) window.showToast(res.error || tt("تعذّر التنفيذ"), "error");
      return;
    }
    if (window.showToast) window.showToast(next === "archived" ? tt("تم أرشفة الطريقة") : tt("تمت الاستعادة"), "success");
  }

  // Two-click confirm: first click sets deletingId; second click actually
  // deletes. The RPC blocks the delete if any template references the
  // method (both by method_id and by case-insensitive name).
  async function doDelete(m) {
    const id = m.method_id || m.id;
    if (deletingId !== id) { setDeletingId(id); return; }
    if (!window.TxMethods || !window.TxMethods.remove) {
      if (window.showToast) window.showToast(tt("خدمة الحذف غير متاحة"), "error");
      return;
    }
    const res = await window.TxMethods.remove(id);
    setDeletingId(null);
    if (!res.ok) {
      if (window.showToast) window.showToast(res.error || tt("تعذّر الحذف"), "error");
      return;
    }
    if (editingId === id) resetForm();
    if (window.showToast) window.showToast(tt("تم حذف طريقة العلاج"), "success");
  }

  return (
    <Modal
      open onClose={onClose}
      title={editingId ? tt("تعديل طريقة العلاج") : tt("إضافة طريقة علاج جديدة")}
      width={720}
      footer={<>
        <button className="btn btn-ghost" onClick={onClose} disabled={saving}>{tt("إلغاء")}</button>
        {!editingId && (
          <button className="btn btn-secondary" onClick={()=>doSave(true)} disabled={saving}>
            {saving ? tt("جارٍ الحفظ…") : tt("حفظ وإضافة أخرى")}
          </button>
        )}
        <button className="btn btn-blue" onClick={()=>doSave(false)} disabled={saving}>
          <I.Check size={13}/> {saving ? tt("جارٍ الحفظ…") : tt("حفظ")}
        </button>
      </>}
    >
      <div style={{display:"grid",gap:14}}>
        {/* Search existing */}
        <div>
          <div style={{position:"relative"}}>
            <I.Search size={14} style={{position:"absolute",insetInlineEnd:11,top:"50%",transform:"translateY(-50%)",color:"var(--ink-400)"}}/>
            <input
              className="input"
              placeholder={tt("ابحث في طرق العلاج الموجودة قبل إنشاء طريقة جديدة…")}
              aria-label={tt("ابحث في طرق العلاج الموجودة قبل إنشاء طريقة جديدة…")}
              value={query}
              onChange={e=>setQuery(e.target.value)}
              style={{paddingInlineEnd:32}}
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
                      <div style={{fontSize:13,fontWeight:500}}>{m.name}{archived && <span className="badge b-grey" style={{marginInlineStart:8,fontSize:10.5}}>{tt("مؤرشف")}</span>}</div>
                      <div className="muted" style={{fontSize:11.5}}>
                        {m.category || tt("بدون فئة")}
                        {m.duration_minutes ? " · " + tt("{n} دقيقة", { n: m.duration_minutes }) : ""}
                        {m.display_order != null ? " · " + tt("ترتيب {n}", { n: m.display_order }) : ""}
                      </div>
                    </div>
                    <button className="btn btn-ghost" style={{fontSize:11.5,padding:"4px 8px"}} onClick={()=>loadIntoForm(m)}>{tt("تعديل")}</button>
                    <button className="btn btn-ghost" style={{fontSize:11.5,padding:"4px 8px",color:archived ? "var(--green)" : "var(--amber-700, #b45309)"}} onClick={()=>doArchiveToggle(m)}>
                      {archived ? tt("استعادة") : tt("أرشفة")}
                    </button>
                    <button
                      className="btn btn-ghost"
                      style={{fontSize:11.5,padding:"4px 8px",color:"#A8443A",fontWeight:isConfirmingDelete?600:400}}
                      onClick={()=>doDelete(m)}
                      onBlur={()=>{ if (deletingId === id) setDeletingId(null); }}
                    >
                      {isConfirmingDelete ? tt("تأكيد الحذف؟") : tt("حذف")}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          <div style={{marginTop:6,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <label style={{display:"flex",alignItems:"center",gap:6,fontSize:12,color:"var(--ink-600)"}}>
              <input type="checkbox" checked={showArchived} onChange={e=>setShowArchived(e.target.checked)}/>
              {tt("عرض المؤرشفة")}
            </label>
            {editingId && (
              <button className="btn btn-ghost" style={{fontSize:12}} onClick={resetForm}>
                <I.Plus size={12}/> {tt("إضافة طريقة جديدة بدل التعديل")}
              </button>
            )}
          </div>
        </div>

        {/* Form */}
        <div className="rgrid c-sm" style={{"--gtc":"repeat(2,1fr)",gap:12}}>
          <Field label={tt("اسم طريقة العلاج")} required span={2}>
            <input ref={nameRef} className="input" value={name} onChange={e=>setName(e.target.value)} placeholder={tt("مثال: علاج إبر جافة")}/>
            {dupHint && (
              <div style={{marginTop:6,fontSize:12,color:"var(--amber-700, #b45309)"}}>
                {tt("يوجد طريقة بنفس الاسم مسبقًا:")}
                <button className="btn btn-ghost" style={{fontSize:12,padding:"2px 6px",marginInlineStart:6}} onClick={()=>loadIntoForm(dupHint)}>
                  {tt('فتح "{name}"', { name: dupHint.name })}
                </button>
              </div>
            )}
          </Field>
          <Field label={tt("الفئة")}>
            <input
              className="input"
              value={category}
              onChange={e=>setCategory(e.target.value)}
              list="tx-method-categories"
              placeholder={tt("اختر أو اكتب فئة جديدة")}
            />
            {/* Suggestions only: the category is free text, saved as typed. */}
            <datalist id="tx-method-categories">
              {[...["علاج يدوي","تمارين علاجية","أجهزة علاجية","علاج مائي","تأهيل رياضي","علاج عصبي","علاج أطفال","أخرى"].map(c => tt(c)), ...categories]
                .filter((v,i,arr)=>arr.indexOf(v)===i)
                .map(c => <option key={c} value={c}/>) }
            </datalist>
          </Field>
          <Field label={tt("مدة الجلسة (دقيقة)")}>
            <input className="input" type="number" min="0" value={duration} onChange={e=>setDuration(e.target.value)} placeholder={tt("مثال: 30")}/>
          </Field>
          <Field label={tt("ترتيب العرض")}>
            <input className="input" type="number" value={displayOrder} onChange={e=>setDisplayOrder(e.target.value)} placeholder={tt("اترك فارغًا للترتيب الأبجدي")}/>
          </Field>
          <Field label={tt("الأيقونة")} span={2}>
            <div style={{display:"flex",flexWrap:"wrap",gap:6,alignItems:"center"}}>
              <button type="button" onClick={()=>setIcon("")} className="btn btn-secondary" style={{fontSize:11.5,padding:"5px 9px",background:!icon?"var(--blue-50)":"#fff",borderColor:!icon?"var(--blue-500)":"var(--ink-200)"}}>
                {tt("بدون")}
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
          <Field label={tt("اللون")} span={2}>
            <div style={{display:"flex",flexWrap:"wrap",gap:6,alignItems:"center"}}>
              <button type="button" onClick={()=>setColor("")} className="btn btn-secondary" style={{fontSize:11.5,padding:"5px 9px",background:!color?"var(--blue-50)":"#fff",borderColor:!color?"var(--blue-500)":"var(--ink-200)"}}>
                {tt("بدون")}
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
          <Field label={tt("الوصف")} span={2}>
            <textarea className="input" style={{height:70,padding:10}} value={description} onChange={e=>setDescription(e.target.value)} placeholder={tt("وصف موجز يظهر للفريق")}/>
          </Field>
          <Field label={tt("ملاحظات")} span={2}>
            <textarea className="input" style={{height:60,padding:10}} value={notes} onChange={e=>setNotes(e.target.value)} placeholder={tt("ملاحظات إضافية (اختياري)")}/>
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
          <div className="crumb"><span>{tt("الرئيسية")}</span><I.Chevron size={11}/><span>{tt("جلسات العلاج")}</span></div>
          <h1 className="h1">{tt("جلسات العلاج")}</h1>
          <div className="muted" style={{fontSize:13.5,marginTop:4}}>{tt("شغّل عدة جلسات في وقت واحد، سجّل الألم والملاحظات، ووقّع.")}</div>
        </div>
        <Segmented label={tt("عرض الجلسات")} value={tab} onChange={setTab} options={[
          { value: "current", label: tt("الجلسات الجارية") },
          { value: "السجل", label: tt("سجل الجلسات") },
        ]}/>
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
          <I.Search size={14} style={{position:"absolute",insetInlineEnd:11,top:"50%",transform:"translateY(-50%)",color:"var(--ink-400)"}}/>
          <input className="input" placeholder={tt("ابحث بالمريض أو الملاحظة…")} aria-label={tt("ابحث بالمريض أو الملاحظة…")} style={{paddingInlineEnd:32}}/>
        </div>
        <select className="input" aria-label={tt("الأخصائي")} style={{width:"auto",minWidth:150,flex:"0 1 180px"}}><option>{tt("كل الأخصائيين")}</option>{DATA.therapists.map(t=><option key={t.id||t.name}>{t.name}</option>)}</select>
        <select className="input" aria-label={tt("الفترة")} style={{width:"auto",minWidth:150,flex:"0 1 180px"}}><option>{tt("آخر 30 يوم")}</option><option>{tt("هذا الأسبوع")}</option></select>
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
    if (!window.confirm(tt("حذف الجلسة {n} للمريض {patient}؟ لا يمكن التراجع.", { n: n ? "#"+n : "", patient: (p && p.name) || s.patient || "" }))) return;
    try {
      await window.KineticData.remove("sessions", s.session_id ?? s.id);
      window.showToast && window.showToast(tt("تم حذف الجلسة"), "success");
    } catch (e) {
      console.warn("delete session failed", e);
      window.showToast && window.showToast(e.message || tt("تعذّر حذف الجلسة"), "error");
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
    return <EmptyState icon={<I.Activity size={22}/>} title={tt("لا جلسات مسجلة بعد")} body={tt("ستظهر الجلسات هنا بعد تسجيلها من شاشة الجلسات.")}/>;
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
              <span style={{fontSize:13,fontWeight:600}}>{(p && p.name) || s.patient || "—"} · {tt("جلسة #{n}", { n: s.session ?? s.session_number ?? "—" })}</span>
              {(s.therapist || "") && <span className="muted" style={{fontSize:11.5}}>{tt("بواسطة {name}", { name: s.therapist })}</span>}
            </div>
            <div style={{fontSize:13,color:"var(--ink-700)",lineHeight:1.5}}>{s.notes || s.session_notes || ""}</div>
            {s.done && s.done.length>0 && (
              <div style={{display:"flex",gap:6,marginTop:8,flexWrap:"wrap"}}>
                {s.done.map(d=><span key={d} className="badge b-green"><I.Check size={10}/>{d}</span>)}
              </div>
            )}
          </div>
          <div style={{textAlign:"center"}}>
            <div className="muted" style={{fontSize:11}}>{tt("الألم")}</div>
            <div className="mono" style={{fontSize:18,fontWeight:600, color: s.pain<=3?"var(--green)":s.pain<=6?"var(--amber)":"var(--red)"}}>{s.pain}/10</div>
            <div style={{fontSize:11,color:"var(--ink-500)"}}>{s.mood}</div>
          </div>
          <div style={{textAlign:"start",display:"flex",gap:6,justifyContent:"flex-end",alignItems:"center"}}>
            <button className="btn btn-secondary" style={{fontSize:12}} onClick={()=>setNotesModal(s)}>{tt("عرض الملاحظات")} <I.ArrowRight size={11}/></button>
            {canDelete && (
              <button className="btn btn-ghost btn-icon" title={tt("حذف الجلسة")} aria-label={tt("حذف الجلسة")} onClick={()=>onDeleteSession(s)}><I.Trash size={13}/></button>
            )}
          </div>
        </div>
      ))}
      {notesModal && (
        <Modal title={tt("ملاحظات الجلسة #{n}", { n: notesModal.session })} onClose={()=>setNotesModal(null)}>
          <div style={{fontSize:13,color:"var(--ink-700)",lineHeight:1.7,marginBottom:12}}>{notesModal.notes}</div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            {(notesModal.done||[]).map(d=><span key={d} className="badge b-green"><I.Check size={10}/>{d}</span>)}
          </div>
          <div style={{marginTop:14,paddingTop:12,borderTop:"1px solid var(--ink-100)",display:"flex",justifyContent:"space-between",fontSize:12,color:"var(--ink-500)"}}>
            <span>{tt("التاريخ: {date}", { date: notesModal.date })}</span>
            <span>{tt("مستوى الألم: {pain}/10 · {mood}", { pain: notesModal.pain, mood: notesModal.mood })}</span>
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

// Payment methods are stored as the Arabic label (invoices: «نقدي»…) or as an
// id (quick payments, QP_METHODS: "cash"…); both are shown by their label.
const PAY_METHOD_AR = { cash: "نقدي", visa: "فيزا", card: "بطاقة", instapay: "إنستاباي", vodafone_cash: "فودافون كاش", bank_transfer: "تحويل بنكي" };
function payMethodAr(m) { return PAY_METHOD_AR[m] || m; }
function payMethodLabel(m) { return m == null || m === "" ? "" : tt(payMethodAr(m)); }
const PAY_METHOD_VALUES = ["نقدي", "فيزا", "إنستاباي", "فودافون كاش", "تحويل بنكي"];

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
      <Segmented label={tt("فترة الفواتير")} value={preset} onChange={setPreset} style={{flexWrap:"wrap",gap:4}}
        options={items.map(it => ({ value: it.k, label: tt(it.l) }))}/>
      {preset==="custom" && (
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <I.Calendar size={13} style={{color:"var(--ink-400)"}}/>
          <span className="muted" style={{fontSize:12}}>{tt("اليوم")}</span>
          <input className="input" type="date" aria-label={tt("تاريخ الفواتير")} value={custom||""}
            onChange={e=>setCustom(e.target.value)}
            style={{width:180}}/>
        </div>
      )}
      {preset==="range" && (
        <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
          <I.Calendar size={13} style={{color:"var(--ink-400)"}}/>
          <span className="muted" style={{fontSize:12}}>{tt("من")}</span>
          <input className="input" type="date" aria-label={tt("من تاريخ")} value={rangeStart||""}
            onChange={e=>setRangeStart(e.target.value)}
            style={{width:170}}/>
          <span className="muted" style={{fontSize:12}}>{tt("إلى")}</span>
          <input className="input" type="date" aria-label={tt("إلى تاريخ")} value={rangeEnd||""}
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
  const filtered = payload.rows.filter(p => methodFilter==="الكل" || payMethodAr(p.method)===methodFilter);
  const stats = payload.stats;
  const totalPages = Math.max(1, Math.ceil((payload.count||0) / PAGE_SIZE));

  const exportCsv = () => {
    const rows=[tt("الفاتورة,المريض,التاريخ,المبلغ,مدفوع,الطريقة,الحالة"),
      ...filtered.map(p=>`${p.id||p.invoice_id},${p.patient||""},${p.date||""},${p.amount||0},${p.paid||0},${p.method ? payMethodLabel(p.method) : ""},${p.status ? tt(p.status) : ""}`)];
    downloadCsv(rows, "payments.csv");
    if(window.showToast)window.showToast(tt("تم تصدير الفواتير"),"success");
  };

  return (
    <Page>
      <div className="page-head">
        <div>
          <div className="crumb"><span>{tt("الرئيسية")}</span><I.Chevron size={11}/><span>{tt("المدفوعات والفواتير")}</span></div>
          <h1 className="h1">{tt("المدفوعات والفواتير")}</h1>
          <div className="muted" style={{fontSize:13.5,marginTop:4}}>{tt("نقدي، بطاقة، إنستاباي، فودافون كاش، تحويل بنكي")}</div>
        </div>
        <div className="page-actions">
          <button className="btn btn-secondary" onClick={exportCsv}><I.Download size={14}/> {tt("تصدير")}</button>
          <button className="btn btn-blue" onClick={()=>setSelected({mode:"new"})}><I.Plus size={14}/> {tt("فاتورة جديدة")}</button>
        </div>
      </div>

      <div className="grid-stats" style={{marginBottom:18}}>
        <StatCard label={tt("إجمالي الإيرادات")} value={fmtMoneyShort(Number(stats.revenue||0))} accent="#3FA984" icon={<I.Dollar size={15}/>}/>
        <StatCard label={tt("المعلّق")}          value={fmtMoneyShort(Number(stats.outstanding||0))} accent="#D49044" icon={<I.Clock size={15}/>}/>
        <StatCard label={tt("المتأخر")}          value={fmtMoneyShort(Number(stats.overdue_amount||0))} accent="#D8665A" icon={<I.X size={15}/>}/>
        <StatCard label={tt("متوسط الفاتورة")}   value={fmtMoneyShort(Number(stats.avg_amount||0))} accent="#7BBDE8" icon={<I.FileText size={15}/>}/>
      </div>
      <div className="grid-stats" style={{marginBottom:18}}>
        <StatCard label={tt("إجمالي الفواتير")}    value={fmtMoneyShort(Number(stats.total_invoices||0))} accent="#7E6BD3" icon={<I.FileText size={15}/>}/>
        <StatCard label={tt("المدفوع")}            value={fmtMoneyShort(Number(stats.paid_amount||0))} accent="#3FA984" icon={<I.Check size={15}/>}/>
        <StatCard label={tt("عدد الفواتير")}       value={`${Number(stats.count||0)}`} accent="#3A7FB5" icon={<I.Layers size={15}/>}/>
        <StatCard label={tt("إجمالي المستحقات")}   value={fmtMoneyShort(Number(stats.due_total||0))} accent="#D49044" icon={<I.Clock size={15}/>}/>
      </div>

      <Segmented label={tt("أقسام المدفوعات")} value={tab} onChange={setTab} style={{marginBottom:14}} options={[
        { value: "payments", label: tt("الفواتير") },
        { value: "methods", label: tt("طرق الدفع") },
        { value: "receipts", label: tt("الإيصالات") },
      ]}/>

      {tab==="payments" && (
        <>
          <div className="card" style={{padding:14,marginBottom:14,display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
            <div style={{position:"relative",flex:"1 1 280px",maxWidth:340}}>
              <I.Search size={14} style={{position:"absolute",insetInlineEnd:11,top:"50%",transform:"translateY(-50%)",color:"var(--ink-400)"}}/>
              <input className="input" placeholder={tt("ابحث في الفواتير…")} aria-label={tt("ابحث في الفواتير…")} style={{paddingInlineEnd:32}}
                value={search} onChange={e=>setSearch(e.target.value)}/>
            </div>
            <Segmented label={tt("حالة الفاتورة")} value={statusFilter} onChange={setStatusFilter}
              options={["الكل","مدفوع","جزئي","معلّق","متأخر"].map(s => ({ value: s, label: tt(s) }))}/>
            <select className="input" aria-label={tt("طريقة الدفع")} style={{width:160}} value={methodFilter} onChange={e=>setMethodFilter(e.target.value)}>
              {["الكل", ...PAY_METHOD_VALUES].map(m => <option key={m} value={m}>{tt(m)}</option>)}
            </select>
            <InvoiceDateFilterBar
              preset={preset} setPreset={setPreset}
              custom={customDate} setCustom={setCustomDate}
              rangeStart={rangeStart} setRangeStart={setRangeStart}
              rangeEnd={rangeEnd} setRangeEnd={setRangeEnd}/>
          </div>

          <div className="card" style={{overflow:"hidden"}}>
            <div className="tbl-scroll">
            <CardTable>
              <thead><tr>
                <th>{tt("فاتورة")}</th><th>{tt("المريض")}</th><th>{tt("التاريخ")}</th><th>{tt("المبلغ")}</th><th>{tt("مدفوع")}</th><th>{tt("الطريقة")}</th><th>{tt("الحالة")}</th><th><span className="sr-only">{tt("إجراءات")}</span></th>
              </tr></thead>
              <tbody>
                {filtered.length===0 && (
                  <tr><td colSpan={8}><EmptyState icon={<I.FileText size={22}/>} title={tt("لا فواتير للفترة المحددة")} body={loading ? tt("جارٍ التحميل…") : tt("لا توجد فواتير مطابقة لعوامل التصفية الحالية.")}/></td></tr>
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
                      <td className="mono" style={{fontWeight:600}}>{fmtMoney(p.amount)}</td>
                      <td>
                        <div>
                          <div className="mono" style={{fontSize:13}}>{fmtMoney(p.paid)}</div>
                          <div style={{height:3,background:"var(--ink-100)",borderRadius:999,overflow:"hidden",marginTop:3}}>
                            <div style={{height:"100%",width:`${pct*100}%`,background:pct===1?"var(--green)":"var(--amber)"}}/>
                          </div>
                          {remaining>0 && <div className="muted" style={{fontSize:10.5,marginTop:2}}>{tt("متبقٍ")} <span className="mono">{fmtMoney(remaining)}</span></div>}
                        </div>
                      </td>
                      <td>
                        <span className="pill" style={{fontSize:11}}>
                          {payMethodAr(p.method)==="نقدي" && <I.Dollar size={11}/>}
                          {(payMethodAr(p.method)==="فيزا" || payMethodAr(p.method)==="بطاقة") && <I.CreditCard size={11}/>}
                          {(payMethodAr(p.method)==="إنستاباي" || payMethodAr(p.method)==="فودافون كاش") && <I.Phone size={11}/>}
                          {payMethodAr(p.method)==="تحويل بنكي" && <I.Layers size={11}/>}
                          {payMethodLabel(p.method)}
                        </span>
                      </td>
                      <td><PayBadge s={p.status}/></td>
                      <td onClick={e=>e.stopPropagation()}>
                        <button className="btn btn-ghost btn-icon" title={tt("عرض")} aria-label={tt("عرض")} onClick={()=>setSelected(p)}><I.Eye size={13}/></button>
                        <button className="btn btn-ghost btn-icon" title={tt("تحميل")} aria-label={tt("تحميل")} onClick={()=>{
                          const rows=[tt("الفاتورة,المريض,التاريخ,المبلغ,مدفوع,الطريقة,الحالة"),`${p.id},${p.patient},${p.date},${p.amount},${p.paid},${payMethodLabel(p.method)},${tt(p.status)}`];
                          downloadCsv(rows, `invoice-${p.id}.csv`);
                        }}><I.Download size={13}/></button>
                        <RowMenu size={13} items={[
                          { label:tt("عرض التفاصيل"), icon:<I.Eye size={13}/>, onClick:()=>setSelected(p) },
                          { label:tt("طباعة"), icon:<I.Print size={13}/>, onClick:()=>window.print() },
                          { label:tt("تصدير CSV"), icon:<I.Download size={13}/>, onClick:()=>{
                            const rows=[tt("الفاتورة,المريض,التاريخ,المبلغ,مدفوع,الطريقة,الحالة"),`${p.id},${p.patient},${p.date},${p.amount},${p.paid},${payMethodLabel(p.method)},${tt(p.status)}`];
                            downloadCsv(rows, `invoice-${p.id}.csv`);
                            if(window.showToast)window.showToast(tt("تم تصدير الفاتورة"),"success");
                          }},
                          { label:tt("حذف"), icon:<I.X size={13}/>, danger:true, onClick:async ()=>{
                            if (!window.confirm(tt("حذف الفاتورة {id}؟", { id: p.id }))) return;
                            try {
                              if (window.KineticData) await window.KineticData.remove("payments", p.invoice_id || p.id);
                              if (window.showToast) window.showToast(tt("تم حذف الفاتورة"),"success");
                            } catch (e) { console.warn("delete invoice failed", e); if (window.showToast) window.showToast(tt("تعذّر الحذف"),"error"); }
                          }},
                        ]}/>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </CardTable>
            </div>
            {payload.count > PAGE_SIZE && (
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 14px",borderTop:"1px solid var(--ink-100)",gap:8}}>
                <div className="muted" style={{fontSize:12}}>
                  {tt("{from}–{to} من {count}", { from: (page*PAGE_SIZE)+1, to: Math.min((page+1)*PAGE_SIZE, payload.count), count: payload.count })}
                </div>
                <div style={{display:"flex",gap:6}}>
                  <button className="btn btn-secondary" disabled={page===0} onClick={()=>setPage(p=>Math.max(0,p-1))} style={{padding:"5px 10px",fontSize:12}}>{tt("السابق")}</button>
                  <div className="muted mono" style={{fontSize:12,padding:"5px 10px"}}>{page+1} / {totalPages}</div>
                  <button className="btn btn-secondary" disabled={page>=totalPages-1} onClick={()=>setPage(p=>Math.min(totalPages-1,p+1))} style={{padding:"5px 10px",fontSize:12}}>{tt("التالي")}</button>
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
    const m = payMethodAr(p.method || p.payment_method || "—");
    byMethod[m] = (byMethod[m] || 0) + (p.paid || 0);
  });
  const totalPaid = Object.values(byMethod).reduce((s,v)=>s+v, 0);
  const data = Object.entries(byMethod).sort((a,b)=>b[1]-a[1]).map(([m, rev], i) => ({
    key: m,
    label: tt(m),
    v: totalPaid ? Math.round(rev/totalPaid*100) : 0,
    color: colors[i % colors.length],
    revenue: rev,
  }));
  if (data.length === 0) {
    return <EmptyState icon={<I.CreditCard size={22}/>} title={tt("لا مدفوعات بعد")} body={tt("سيظهر توزيع طرق الدفع هنا بعد تسجيل الفواتير.")}/>;
  }
  return (
    <div className="rgrid c-lg" style={{"--gtc":"1fr 1fr"}}>
      <div className="card card-pad">
        <div className="h2" style={{marginBottom:18}}>{tt("الطريقة mix · this month")}</div>
        <DonutChart data={data} size={200} centerLabel={tt("ج.م محصلة")} centerValue={totalPaid>=1000?`${(totalPaid/1000).toFixed(0)}K`:String(totalPaid)}/>
      </div>
      <div className="card card-pad">
        <div className="h2" style={{marginBottom:14}}>{tt("Revenue بواسطة method")}</div>
        {data.map(d=>(
          <div key={d.key} style={{padding:"11px 0",borderBottom:"1px dashed var(--ink-100)",display:"flex",alignItems:"center",gap:10}}>
            <span style={{width:8,height:8,borderRadius:3,background:d.color}}></span>
            <span style={{flex:1,fontSize:13}}>{d.label}</span>
            <span className="mono" style={{fontSize:13,fontWeight:600}}>{fmtMoney(d.revenue)}</span>
            <span className="muted mono" style={{fontSize:11,minWidth:36,textAlign:"start"}}>{d.v}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReceiptsView() {
  return (
    <EmptyState icon={<I.FileText size={22}/>} title={tt("لا توجد إيصالات بعد")} body={tt("Receipts will appear here when مريض pay invoices. You can also upload paper receipts manually.")} action={<button className="btn btn-blue"><I.Upload size={13}/> {tt("رفع إيصال")}</button>}/>
  );
}

function InvoiceModal({ invoice, onClose }) {
  const clinic = window.CLINIC || {};
  const clinicName = clinic.name || tt("العيادة");
  const lineDesc = invoice.desc || tt("خدمات علاجية");
  const waPhone = String(clinic.phone || "").replace(/\D/g, "");
  return (
    <Modal open onClose={onClose} title={tt("فاتورة {id}", { id: invoice.id })} width={680}
      footer={<>
        <button className="btn btn-secondary" onClick={()=>window.print()}><I.Print size={13}/> {tt("طباعة")}</button>
        <button className="btn btn-secondary" onClick={()=>{
          const rows=[tt("البند,الكمية,السعر"),`${lineDesc},1,${invoice.amount}`];
          downloadCsv(rows, `invoice-${invoice.id}.csv`);
          if(window.showToast)window.showToast(tt("تم تحميل الفاتورة"),"success");
        }}><I.Download size={13}/> {tt("تحميل PDF")}</button>
        <button className="btn btn-blue" disabled={!waPhone} onClick={()=>{
          const text = tt("فاتورة {id} بمبلغ {amount} جنيه مصري", { id: invoice.id, amount: invoice.amount }).replace(/ /g, "+");
          window.open(`https://wa.me/${waPhone}?text=${text}`,"_blank");
        }}><I.Send size={13}/> {tt("Send via واتساب")}</button>
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
              {clinic.tax_id && <>{tt("الرقم الضريبي {id}", { id: clinic.tax_id })}<br/></>}
              {clinic.email || ""}
            </div>
          </div>
          <div style={{textAlign:"start"}}>
            <div className="serif" style={{fontSize:30,lineHeight:1}}>{tt("فاتورة")}</div>
            <div className="mono" style={{marginTop:4,fontSize:13}}>{invoice.id}</div>
            <div className="muted" style={{fontSize:12,marginTop:6}}>{tt("صدرت في {date}", { date: invoice.date })}</div>
            <PayBadge s={invoice.status}/>
          </div>
        </div>

        {/* bill to */}
        <div className="rgrid c-sm" style={{"--gtc":"1fr 1fr",marginBottom:24}}>
          <div>
            <div className="muted" style={{fontSize:11,textTransform:"uppercase",letterSpacing:".05em",marginBottom:4}}>{tt("فاتورة لـ")}</div>
            <div style={{fontWeight:600}}>{invoice.patient}</div>
            {(() => {
              const row = DATA.patients.find(p => p.name === invoice.patient || (p.patient_id||p.id) === invoice.patient_id) || {};
              return <div className="muted" style={{fontSize:12,lineHeight:1.5,marginTop:2}}>{tt("ملف {id}", { id: row.patient_id || row.id || "—" })}<br/>{row.address || ""}{row.address ? <br/> : null}{row.phone || ""}</div>;
            })()}
          </div>
          <div>
            <div className="muted" style={{fontSize:11,textTransform:"uppercase",letterSpacing:".05em",marginBottom:4}}>{tt("فريق الرعاية")}</div>
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
            <thead><tr><th>{tt("البند")}</th><th style={{textAlign:"start"}}>{tt("الكمية")}</th><th style={{textAlign:"start"}}>{tt("السعر")}</th><th style={{textAlign:"start"}}>{tt("الإجمالي")}</th></tr></thead>
            <tbody>
              <tr><td>{lineDesc}</td><td style={{textAlign:"start"}}>1</td><td style={{textAlign:"start"}} className="mono">{fmtNumber(invoice.amount||0)}</td><td style={{textAlign:"start"}} className="mono">{fmtNumber(invoice.amount||0)}</td></tr>
            </tbody>
          </table>
        </div>

        <div style={{display:"flex",justifyContent:"flex-end"}}>
          <div style={{minWidth:240}}>
            <div style={{display:"flex",justifyContent:"space-between",padding:"4px 0",fontSize:12.5}}><span className="muted">{tt("المجموع الفرعي")}</span><span className="mono">{fmtMoney(invoice.amount||0)}</span></div>
            <div style={{display:"flex",justifyContent:"space-between",padding:"4px 0",fontSize:12.5}}><span className="muted">{tt("ض.ق.م (14%)")}</span><span className="mono">{fmtMoney(0, { minimumFractionDigits: 2 })}</span></div>
            <div style={{display:"flex",justifyContent:"space-between",padding:"10px 0",borderTop:"1px solid var(--ink-200)",marginTop:6}}><span style={{fontWeight:600}}>{tt("الإجمالي")}</span><span className="mono" style={{fontWeight:600,fontSize:16}}>{fmtMoney(invoice.amount)}</span></div>
            <div style={{display:"flex",justifyContent:"space-between",padding:"4px 0",fontSize:12.5}}><span className="muted">{tt("مدفوعة عبر {method}", { method: payMethodLabel(invoice.method) })}</span><span className="mono">{fmtMoney(invoice.paid)}</span></div>
            <div style={{display:"flex",justifyContent:"space-between",padding:"4px 0",fontSize:12.5,color: invoice.amount-invoice.paid>0?"var(--amber)":"var(--green)"}}><span>{tt("الرصيد المستحق")}</span><span className="mono" style={{fontWeight:600}}>{fmtMoney(invoice.amount-invoice.paid)}</span></div>
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
    if (!patientId) { if (window.showToast) window.showToast(tt("اختر مريضًا"), "error"); return; }
    if (subtotal <= 0) { if (window.showToast) window.showToast(tt("أضف بندًا واحدًا على الأقل"), "error"); return; }
    try {
      const invoiceId = newRecordId("INV-");
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
      if (window.showToast) window.showToast(tt("تم إنشاء الفاتورة"), "success");
      onClose();
    } catch (e) {
      console.warn("create invoice failed", e);
      if (window.showToast) window.showToast(tt("تعذّر إنشاء الفاتورة"), "error");
    }
  }

  return (
    <Modal open onClose={onClose} title={tt("فاتورة جديدة")} width={720}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose}>{tt("إلغاء")}</button>
        <button className="btn btn-secondary" onClick={()=>{ if (window.showToast) window.showToast(tt("تم حفظ المسودة"),"success"); onClose(); }}>{tt("حفظ المسودة")}</button>
        <button className="btn btn-blue" onClick={create}><I.Check size={13}/> {tt("إنشاء الفاتورة")}</button>
      </>}>
      <div className="rgrid c-sm" style={{"--gtc":"1fr 1fr",gap:14,marginBottom:14}}>
        <Field label={tt("مريض")} required>
          <PatientCombobox
            value={patientId}
            onChange={setPatientId}
            patients={patients}
            placeholder={patients.length === 0 ? tt("لا يوجد مرضى") : tt("ابحث عن مريض بالاسم أو الرقم…")}
            disabled={patients.length === 0}
          />
        </Field>
        <Field label={tt("التاريخ")}><input className="input" type="date" value={date} onChange={e=>setDate(e.target.value)}/></Field>
        <Field label={tt("تاريخ الاستحقاق")}><input className="input" type="date" value={due} onChange={e=>setDue(e.target.value)}/></Field>
        <Field label={tt("الدفع method")}>
          <select className="input" value={method} onChange={e=>setMethod(e.target.value)}>
            {PAY_METHOD_VALUES.map(m => <option key={m} value={m}>{tt(m)}</option>)}
          </select>
        </Field>
      </div>

      <div className="label">{tt("بنود الفاتورة")}</div>
      <div className="card" style={{padding:0,boxShadow:"none",marginBottom:10}}>
        {items.map((it,i)=>(
          <div key={i} className="rgrid inv-item-row" style={{padding:10,"--gtc":"1fr 80px 100px 100px 28px",gap:10,alignItems:"center",borderBottom:i<items.length-1?"1px solid var(--ink-100)":"none"}}>
            <input className="input" value={it.name} onChange={e=>setItems(items.map((x,j)=>j===i?{...x,name:e.target.value}:x))}/>
            <input className="input" type="number" value={it.qty} onChange={e=>setItems(items.map((x,j)=>j===i?{...x,qty:+e.target.value}:x))}/>
            <input className="input mono" type="number" value={it.price} onChange={e=>setItems(items.map((x,j)=>j===i?{...x,price:+e.target.value}:x))}/>
            <span className="mono" style={{textAlign:"start",fontWeight:600}}>{fmtMoney(it.qty*it.price)}</span>
            <button className="btn btn-ghost btn-icon" onClick={()=>setItems(items.filter((_,j)=>j!==i))}><I.X size={13}/></button>
          </div>
        ))}
      </div>
      <button className="btn btn-secondary" onClick={()=>setItems([...items,{name:"",qty:1,price:0}])} style={{fontSize:12}}><I.Plus size={12}/> {tt("إضافة بند")}</button>

      <div style={{display:"flex",justifyContent:"flex-end",marginTop:18}}>
        <div style={{minWidth:240,padding:14,background:"var(--ink-50)",borderRadius:10}}>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:13,marginBottom:4}}><span className="muted">{tt("المجموع الفرعي")}</span><span className="mono">{fmtMoney(subtotal)}</span></div>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:13,marginBottom:4}}><span className="muted">{tt("ض.ق.م (14%)")}</span><span className="mono">{fmtMoney(0)}</span></div>
          <hr className="sep" style={{margin:"8px 0"}}/>
          <div style={{display:"flex",justifyContent:"space-between"}}><span style={{fontWeight:600}}>{tt("الإجمالي")}</span><span className="mono" style={{fontWeight:600,fontSize:18}}>{fmtMoney(subtotal)}</span></div>
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
    if (window.showToast) window.showToast(next.active ? tt("تم تفعيل {name}", { name: p.name }) : tt("تم إيقاف {name}", { name: p.name }), "success");
  };
  return (
    <Page>
      <div className="page-head">
        <div>
          <div className="crumb"><span>{tt("الرئيسية")}</span><I.Chevron size={11}/><span>{tt("الباقات")}</span></div>
          <h1 className="h1">{tt("باقات العلاج")}</h1>
          <div className="muted" style={{fontSize:13.5,marginTop:4}}>{tt("{n} نشط باقة", { n: DATA.packages.filter(p=>p.active).length })}</div>
        </div>
        <button className="btn btn-blue" onClick={()=>setEditing({mode:"new"})}><I.Plus size={14}/> {tt("باقة جديدة")}</button>
      </div>

      <div className="grid-3">
        {DATA.packages.map(p=>(
          <div key={p.id} className="card" style={{padding:0,overflow:"hidden",opacity:p.active?1:.6,position:"relative"}}>
            <div style={{height:90,background:`linear-gradient(135deg, ${p.color}, ${p.color}99)`,position:"relative",padding:18}}>
              {p.popular && <span style={{position:"absolute",top:14,insetInlineStart:14,background:"#fff",color:p.color,padding:"3px 10px",borderRadius:999,fontSize:11,fontWeight:600,boxShadow:"var(--shadow-sm)"}}>{tt("الأكثر طلبًا")}</span>}
              <div className="mono" style={{color:"#fff",opacity:.8,fontSize:10.5,letterSpacing:".06em",textTransform:"uppercase"}}>{p.id}</div>
              <div style={{color:"#fff",fontWeight:600,fontSize:18,marginTop:4,letterSpacing:"-.005em"}}>{p.name}</div>
            </div>
            <div style={{padding:18}}>
              <div style={{display:"flex",alignItems:"baseline",gap:6,marginBottom:12}}>
                <span className="mono" style={{fontSize:30,fontWeight:600,letterSpacing:"-.01em"}}>{fmtMoney(p.price)}</span>
                <span className="muted" style={{fontSize:12}}>{tt("/ للباقة")}</span>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:14}}>
                <div style={{display:"flex",alignItems:"center",gap:8,fontSize:12.5}}><I.Check size={13} style={{color:p.color}}/> {tt("{n} جلسة{s} متضمنة", { n: p.sessions, s: p.sessions>1?"s":"" })}</div>
                <div style={{display:"flex",alignItems:"center",gap:8,fontSize:12.5}}><I.Check size={13} style={{color:p.color}}/> {tt("تقييم أولي مجاني")}</div>
                <div style={{display:"flex",alignItems:"center",gap:8,fontSize:12.5}}><I.Check size={13} style={{color:p.color}}/> {tt("صالحة لمدة 90 يوم")}</div>
                {p.sessions>=10 && <div style={{display:"flex",alignItems:"center",gap:8,fontSize:12.5}}><I.Check size={13} style={{color:p.color}}/> {tt("التقدّم reports متضمنة")}</div>}
              </div>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",fontSize:12,marginBottom:14}}>
                <span className="muted">{tt("مبيعة هذا الشهر")}</span>
                <span className="mono" style={{fontWeight:600}}>{p.sold}</span>
              </div>
              <div style={{display:"flex",gap:6}}>
                <button className="btn btn-secondary" style={{flex:1,justifyContent:"center"}} onClick={()=>setEditing(p)}><I.Edit size={12}/> {tt("تعديل")}</button>
                <RowMenu size={14} items={[
                  { label:tt("تعديل الباقة"), icon:<I.Edit size={13}/>, onClick:()=>setEditing(p) },
                  { label:p.active?tt("إيقاف الباقة"):tt("تفعيل الباقة"), icon:<I.Check size={13}/>, onClick:()=>toggleActive(p) },
                  { label:tt("مضاعفة"), icon:<I.Plus size={13}/>, onClick:async()=>{
                    const clone = { ...p, id: newRecordId((p.id||"PK-")+"-Copy-"), name:tt("{name} — نسخة", { name: p.name }), sold:0 };
                    try { await window.KineticData.upsert("packages", clone); }
                    catch (e) { console.warn("clone package failed", e); }
                    if (window.showToast) window.showToast(tt("تم نسخ {name}", { name: p.name }),"success");
                  }},
                  { label:tt("حذف الباقة"), icon:<I.X size={13}/>, danger:true, onClick:async()=>{
                    if (!window.confirm(tt("حذف {name}؟", { name: p.name }))) return;
                    try { await window.KineticData.remove("packages", p.id); }
                    catch (e) { console.warn("delete package failed", e); }
                    if (window.showToast) window.showToast(tt("تم حذف {name}", { name: p.name }),"success");
                  }},
                ]}/>
                <button onClick={()=>toggleActive(p)} className={`switch ${p.active?"on":""}`} style={{marginInlineStart:"auto",border:"none",padding:0,background:"transparent",cursor:"pointer"}} title={p.active?tt("إيقاف الباقة"):tt("تفعيل الباقة")} aria-label={p.active?tt("إيقاف الباقة"):tt("تفعيل الباقة")}>
                  <div className="knob"></div>
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <Modal open onClose={()=>setEditing(null)} title={editing.mode==="new"?tt("باقة جديدة"):tt("تعديل {name}", { name: editing.name })}
          footer={<>
            <button className="btn btn-secondary" onClick={()=>setEditing(null)}>{tt("إلغاء")}</button>
            <button className="btn btn-blue" onClick={()=>setEditing(null)}><I.Check size={13}/> {tt("حفظ الباقة")}</button>
          </>}>
          <div className="rgrid c-sm" style={{"--gtc":"repeat(2,1fr)",gap:14}}>
            <Field label={tt("الاسم")} required span={2}><input className="input" defaultValue={editing.name||""} placeholder={tt("مثال: الباقة الأساسية 10")}/></Field>
            <Field label={tt("الجلسات")}><input className="input" type="number" defaultValue={editing.sessions||""}/></Field>
            <Field label={tt("السعر (ج.م)")}><input className="input" type="number" defaultValue={editing.price||""}/></Field>
            <Field label={tt("اللون")}><input className="input" type="color" defaultValue={editing.color||"#7BBDE8"}/></Field>
            <Field label={tt("الصلاحية (أيام)")}><input className="input" type="number" defaultValue="90"/></Field>
            <Field label={tt("الوصف")} span={2}><textarea className="input" style={{height:70,padding:10}} placeholder={tt("ملاحظات داخلية")}/></Field>
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
  { id: "cash",           label: tt("نقدي"),         icon: "Dollar" },
  { id: "visa",           label: tt("فيزا"),         icon: "CreditCard" },
  { id: "instapay",       label: tt("إنستاباي"),     icon: "Phone" },
  { id: "vodafone_cash",  label: tt("فودافون كاش"),  icon: "Phone" },
  { id: "bank_transfer",  label: tt("تحويل بنكي"),   icon: "Layers" },
];

// PRD Section 6 — reference numbers appear on card/wallet/transfer payments.
const QP_REF_METHODS = new Set(["visa", "instapay", "vodafone_cash", "bank_transfer"]);

function qpMethodLabel(id) {
  const m = QP_METHODS.find(x => x.id === id);
  return m ? m.label : payMethodLabel(id);
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
      setError(tt("تعذّر تحميل البيانات المالية"));
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
      if (!window.confirm(tt("لم يُدخل رقم مرجعي — هل تريد المتابعة؟"))) return;
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
      if (!res.ok) { setError(res.error || tt("تعذّر تسجيل الدفع")); setSaving(false); return; }
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
      if (window.showToast) window.showToast(tt("تم تسجيل الدفع ({no})", { no: res.receipt_no }), "success");
    } catch (e) {
      console.warn("quick payment failed", e);
      setError(e.message || tt("تعذّر تسجيل الدفع"));
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
      <Modal open onClose={() => setConfirming(false)} title={tt("تأكيد الدفع")} width={520}
        footer={<>
          <button className="btn btn-ghost" onClick={() => setConfirming(false)} disabled={saving}>{tt("رجوع")}</button>
          <button className="btn btn-blue" disabled={saving || !readyToConfirm} onClick={confirmPayment}>
            {saving ? <span className="spin" style={{width:14,height:14,border:"2px solid #fff",borderTopColor:"transparent",borderRadius:"50%"}}/>
                    : <><I.Check size={13}/> {tt("تأكيد الدفع")}</>}
          </button>
        </>}>
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          <QpSummaryRow label={tt("المريض")} value={patient.name} sub={patient.patient_id || patient.id}/>
          <div className="card" style={{padding:12,background:"var(--ink-50)"}}>
            <div className="muted" style={{fontSize:11,marginBottom:6,letterSpacing:".05em",textTransform:"uppercase"}}>{tt("العناصر المحددة")}</div>
            {selected.map(a => (
              <div key={qpSelKey(a.type, a.id)} style={{display:"flex",justifyContent:"space-between",fontSize:12.5,padding:"4px 0"}}>
                <span>{a.label}</span>
                <span className="mono">{fmtMoney(a.amount)}</span>
              </div>
            ))}
          </div>
          <QpSummaryRow label={tt("طريقة الدفع")} value={qpMethodLabel(method)}/>
          {(reference || txId) && (
            <QpSummaryRow label={tt("رقم مرجعي")} value={reference || txId}/>
          )}
          <div style={{display:"flex",justifyContent:"space-between",padding:"10px 12px",background:"var(--blue-50)",border:"1px solid var(--blue-100)",borderRadius:10}}>
            <span style={{fontWeight:600}}>{tt("الإجمالي")}</span>
            <span className="mono" style={{fontWeight:700,fontSize:16,color:"var(--blue-900)"}}>{fmtMoney(total)}</span>
          </div>
          {error && <div style={{fontSize:12,color:"#A8443A"}}>{error}</div>}
        </div>
      </Modal>
    );
  }

  // ── Main modal ────────────────────────────────────────────
  return (
    <Modal open onClose={onClose} title={tt("دفع سريع")} width={760}
      footer={<>
        <button className="btn btn-ghost" onClick={onClose}>{tt("إلغاء")}</button>
        {patient && (
          <button className="btn btn-secondary" onClick={clearPatient}>{tt("مريض آخر")}</button>
        )}
        <button className="btn btn-blue" disabled={!readyToConfirm} onClick={() => setConfirming(true)}>
          {IS_RTL ? <I.ArrowLeft size={13}/> : <I.ArrowRight size={13}/>} {tt("مراجعة الدفع ({total})", { total: fmtMoney(total) })}
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
              {tt("جارٍ تحميل الرصيد المالي…")}
            </div>
          )}
          {!loading && !anyFinancialItems && (
            <EmptyState icon={<I.Check size={22}/>} title={tt("لا مستحقات على المريض")}
              body={tt("لا مواعيد أو فواتير أو اشتراكات بها رصيد متبقٍ.")}/>
          )}
          {!loading && anyFinancialItems && (
            <>
              <QpItemsSection
                title={tt("مواعيد غير مدفوعة")} icon={<I.Calendar size={14}/>}
                items={fin.appointments.map(a => ({
                  key: a.booking_id || a.id,
                  primary: `${a.type || tt("جلسة")} — ${a.date || "—"} ${a.time || ""}`.trim(),
                  secondary: `${a.dr || a.doctor_name || ""} ${a.th ? "· " + a.th : ""}`.trim() || tt("موعد"),
                  remaining: a.remaining, badge: "b-amber",
                }))}
                type="appointment" picks={picks} toggle={toggle} setAmount={setAmount}
              />
              <QpItemsSection
                title={tt("فواتير غير مدفوعة")} icon={<I.FileText size={14}/>}
                items={fin.invoices.map(v => ({
                  key: v.invoice_id || v.id,
                  primary: tt("فاتورة {id}", { id: v.invoice_id || v.id }),
                  secondary: tt("إجمالي {total} · مدفوع {paid}", { total: fmtMoney(v.amount), paid: fmtMoney(v.paid) }),
                  remaining: v.remaining, badge: "b-blue",
                }))}
                type="invoice" picks={picks} toggle={toggle} setAmount={setAmount}
              />
              <QpItemsSection
                title={tt("اشتراكات وباقات")} icon={<I.Package size={14}/>}
                items={fin.subscriptions.map(s => {
                  const remainingSessions = Math.max(0, (s.total_sessions||0) - (s.used_sessions||0));
                  return {
                    key: s.subscription_id || s.id,
                    primary: s.package_name || tt("باقة"),
                    secondary: tt("{used}/{total} جلسات · متبقٍ {left}", { used: s.used_sessions||0, total: s.total_sessions||0, left: remainingSessions }) +
                               (s.expires_at ? " · " + tt("تنتهي {date}", { date: s.expires_at }) : ""),
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
                  <div className="muted" style={{fontSize:11.5,letterSpacing:".05em",textTransform:"uppercase"}}>{tt("الإجمالي المستحق")}</div>
                  <div className="mono" style={{fontSize:22,fontWeight:700,color:"var(--blue-900)"}}>{fmtMoney(total)}</div>
                </div>
                <div style={{textAlign:"start",fontSize:12,color:"var(--ink-500)"}}>
                  {tt("{n} عنصر محدد", { n: selected.length })}
                  {hasOverpay && <div style={{color:"#A8443A",marginTop:4}}>{tt("مبلغ يتجاوز المتبقي")}</div>}
                  {!hasOverpay && hasZero && <div style={{color:"#A8443A",marginTop:4}}>{tt("أدخل مبلغًا أكبر من صفر")}</div>}
                </div>
              </div>

              {error && <div style={{fontSize:12,color:"#A8443A"}}>{error}</div>}
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
        {tt("ابحث عن المريض بالاسم، رقم الهاتف، أو رقم الملف — ثم اختره لعرض المستحقات.")}
      </div>
      <div style={{position:"relative",marginBottom:12}}>
        <I.Search size={15} style={{position:"absolute",insetInlineStart:12,top:"50%",transform:"translateY(-50%)",color:"var(--ink-400)"}}/>
        <input className="input"
          style={{paddingInlineStart:34, height:44, fontSize:14}}
          placeholder={tt("مثال: هناء، +20100…، P-10241")} aria-label={tt("ابحث عن المريض")}
          value={query} onChange={e => setQuery(e.target.value)} autoFocus/>
        {searching && (
          <span className="spin" style={{position:"absolute",insetInlineEnd:12,top:"50%",transform:"translateY(-50%)",width:14,height:14,border:"2px solid var(--ink-200)",borderTopColor:"var(--blue-500)",borderRadius:"50%"}}/>
        )}
      </div>
      {query.trim() && !searching && results.length === 0 && (
        <div className="muted" style={{textAlign:"center",padding:"32px 12px",fontSize:13}}>
          {tt("لا نتائج مطابقة.")}
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
              {IS_RTL ? <I.ArrowLeft size={14} style={{color:"var(--ink-400)"}}/> : <I.ArrowRight size={14} style={{color:"var(--ink-400)"}}/>}
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
      <button className="btn btn-ghost" style={{fontSize:12}} onClick={onClear}>{tt("تغيير")}</button>
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
              <input type="checkbox" checked={on} disabled={it.disabled} aria-label={it.primary}
                onChange={() => toggle(type, it.key, it.remaining, it.primary)}
                style={{width:16,height:16,cursor: it.disabled ? "not-allowed":"pointer"}}/>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:13,fontWeight:500}}>{it.primary}</div>
                <div className="muted" style={{fontSize:11.5}}>{it.secondary}</div>
              </div>
              {on ? (
                <div style={{display:"flex",alignItems:"center",gap:6}}>
                  <span className="muted" style={{fontSize:11}}>{tt("مبلغ الدفع")}</span>
                  <input className="input mono" aria-label={tt("مبلغ الدفع")}
                    style={{width:120,textAlign:"end"}}
                    type="number" min="0" step="1" max={it.remaining}
                    value={picks[key].amount === "" ? "" : picks[key].amount}
                    onChange={e => setAmount(key, e.target.value)}/>
                  <span className={"badge " + (it.badge || "b-grey")}>
                    {tt("من {n}", { n: fmtNumber(it.remaining||0) })}
                  </span>
                </div>
              ) : (
                <div className="mono" style={{fontSize:13,fontWeight:600,minWidth:110,textAlign:"end"}}>
                  {fmtMoney(it.remaining)}
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
      <div className="h3" style={{marginBottom:10}}>{tt("طريقة الدفع")}</div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:8,marginBottom:12}}>
        {QP_METHODS.map(m => {
          const Ic = (window.I && window.I[m.icon]) || window.I.Dollar;
          const on = method === m.id;
          return (
            <button key={m.id} type="button" onClick={() => setMethod(m.id)} aria-pressed={on ? "true" : "false"}
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
          <Field label={tt("رقم مرجعي (اختياري)")}>
            <input className="input" value={reference} onChange={e => setReference(e.target.value)}
              placeholder={tt("آخر 4 أرقام / رقم العملية")}/>
          </Field>
          <Field label={tt("رقم المعاملة (اختياري)")}>
            <input className="input" value={txId} onChange={e => setTxId(e.target.value)}
              placeholder="Transaction ID"/>
          </Field>
        </div>
      )}
      <Field label={tt("ملاحظات (اختياري)")}>
        <textarea className="input" rows={2}
          style={{padding:10, resize:"vertical"}}
          value={notes} onChange={e => setNotes(e.target.value)}
          placeholder={tt("أي تفاصيل تخص عملية الدفع…")}/>
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
  const clinicName = clinic.name || tt("العيادة");
  const dateStr = fmtDate(r.date, { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });

  function printReceipt() {
    const esc = window.escHtml || (x => String(x||""));
    const rows = r.allocations.map(a => `
      <tr>
        <td>${esc(a.label || a.type + " " + a.id)}</td>
        <td style="text-align:end" class="mono">${esc(fmtMoney(a.amount))}</td>
      </tr>`).join("");
    // printHTML writes a right-to-left page; in English the receipt itself
    // is wrapped left-to-right with its table cells aligned to the start.
    const body = `${IS_RTL ? "" : '<style>.receipt-ltr th,.receipt-ltr td{text-align:left}</style><div class="receipt-ltr" dir="ltr" lang="en">'}
      <div style="border:1px solid #EEF2F6;border-radius:10px;padding:18px 20px;margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
          <div>
            <div style="font-size:18px;font-weight:600">${esc(clinicName)}</div>
            <div style="color:#647686;font-size:11.5px;margin-top:4px">${esc(clinic.address || "")}</div>
          </div>
          <div style="text-align:end">
            <div style="font-size:22px" class="serif">${esc(tt("إيصال دفع"))}</div>
            <div class="mono" style="margin-top:4px;font-size:12.5px">${esc(r.receipt_no || "")}</div>
            <div style="color:#647686;font-size:11.5px;margin-top:4px">${esc(dateStr)}</div>
          </div>
        </div>
      </div>
      <table>
        <tbody>
          <tr><th>${esc(tt("المريض"))}</th><td>${esc(r.patient.name)} <span class="mono" style="color:#647686">${esc(r.patient.id)}</span></td></tr>
          <tr><th>${esc(tt("الهاتف"))}</th><td>${esc(r.patient.phone || "—")}</td></tr>
          <tr><th>${esc(tt("طريقة الدفع"))}</th><td>${esc(qpMethodLabel(r.method))}</td></tr>
          ${r.reference ? `<tr><th>${esc(tt("رقم مرجعي"))}</th><td class="mono">${esc(r.reference)}</td></tr>`:""}
          ${r.transaction_id ? `<tr><th>${esc(tt("رقم المعاملة"))}</th><td class="mono">${esc(r.transaction_id)}</td></tr>`:""}
          <tr><th>${esc(tt("الكاشير"))}</th><td>${esc(r.cashier)}</td></tr>
        </tbody>
      </table>
      <div style="height:14px"></div>
      <table>
        <thead><tr><th>${esc(tt("البند"))}</th><th style="text-align:end">${esc(tt("المبلغ"))}</th></tr></thead>
        <tbody>${rows}
          <tr><th style="border-top:2px solid #0F1E2B">${esc(tt("الإجمالي المدفوع"))}</th>
              <td style="border-top:2px solid #0F1E2B;text-align:end;font-weight:600" class="mono">${esc(fmtMoney(r.amount))}</td></tr>
        </tbody>
      </table>
      ${r.notes ? `<div style="margin-top:16px;font-size:12.5px;color:#647686"><strong>${esc(tt("ملاحظات:"))}</strong> ${esc(r.notes)}</div>` : ""}
    ${IS_RTL ? "" : "</div>"}`;
    (window.printHTML || (()=>{}))(tt("إيصال {no}", { no: r.receipt_no }), body);
  }

  function downloadCsv() {
    const rows = [
      tt("البند,المبلغ"),
      ...r.allocations.map(a => `"${(a.label||a.type+" "+a.id).replace(/"/g,'""')}",${Number(a.amount||0)}`),
      `"${tt("الإجمالي المدفوع")}",${Number(r.amount||0)}`,
    ];
    const blob = new Blob([rows.join("\n")], { type:"text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${r.receipt_no || "receipt"}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Modal open onClose={onClose} title={tt("إيصال {no}", { no: r.receipt_no || "" })} width={600}
      footer={<>
        <button className="btn btn-ghost" onClick={onClose}>{tt("إغلاق")}</button>
        <button className="btn btn-secondary" onClick={downloadCsv}><I.Download size={13}/> {tt("تحميل CSV")}</button>
        <button className="btn btn-blue" onClick={printReceipt}><I.Print size={13}/> {tt("طباعة / PDF")}</button>
      </>}>
      <div style={{display:"flex",flexDirection:"column",gap:14}}>
        <div style={{
          display:"flex",alignItems:"center",gap:10,padding:"12px 14px",
          background:"var(--green-bg)",border:"1px solid rgba(63,169,132,.35)",
          borderRadius:12,color:"#2C8067"
        }}>
          <I.Check size={16}/>
          <div>
            <div style={{fontWeight:600,fontSize:13.5}}>{tt("تمت العملية بنجاح")}</div>
            <div style={{fontSize:11.5}}>{tt("تم تحديث الرصيد والإيرادات وسجل المدفوعات.")}</div>
          </div>
        </div>
        <QpSummaryRow label={tt("المريض")} value={r.patient.name} sub={r.patient.id}/>
        <QpSummaryRow label={tt("طريقة الدفع")} value={qpMethodLabel(r.method)}/>
        {r.reference && <QpSummaryRow label={tt("رقم مرجعي")} value={r.reference}/>}
        {r.transaction_id && <QpSummaryRow label={tt("رقم المعاملة")} value={r.transaction_id}/>}
        <QpSummaryRow label={tt("الكاشير")} value={r.cashier}/>
        <div className="card" style={{padding:12,background:"var(--ink-50)"}}>
          <div className="muted" style={{fontSize:11,marginBottom:6,letterSpacing:".05em",textTransform:"uppercase"}}>{tt("العناصر المدفوعة")}</div>
          {r.allocations.map((a, i) => (
            <div key={i} style={{display:"flex",justifyContent:"space-between",fontSize:12.5,padding:"4px 0"}}>
              <span>{a.label || `${a.type} ${a.id}`}</span>
              <span className="mono">{fmtMoney(a.amount)}</span>
            </div>
          ))}
        </div>
        <div style={{display:"flex",justifyContent:"space-between",padding:"10px 12px",background:"var(--blue-50)",border:"1px solid var(--blue-100)",borderRadius:10}}>
          <span style={{fontWeight:600}}>{tt("المبلغ المدفوع")}</span>
          <span className="mono" style={{fontWeight:700,fontSize:16,color:"var(--blue-900)"}}>{fmtMoney(r.amount)}</span>
        </div>
      </div>
    </Modal>
  );
}

Object.assign(window, { QuickPaymentModal, QuickPaymentReceipt });

Object.assign(window, { Payments, Packages, NewInvoiceModal });


// ===== src/campaigns.jsx =====
// واتساب الحملة System

// Campaign statuses: the seed and the API store codes ("draft"…), these
// screens write the Arabic label («جارٍ»…); both are shown by their label.
const CAMPAIGN_STATUS_AR = { draft: "مسودة", running: "جارٍ", active: "جارٍ", scheduled: "مجدول", completed: "مكتمل" };
function campaignStatusAr(s) { return CAMPAIGN_STATUS_AR[s] || s; }
function campaignBadge(s) {
  const ar = campaignStatusAr(s);
  return ar==="جارٍ"?"b-green":ar==="مجدول"?"b-blue":ar==="مكتمل"?"b-grey":"b-amber";
}
// Ready-made message templates (names are also the builder's lookup keys).
const CAMPAIGN_TEMPLATE_NAMES = ["تذكير موعد","متابعة ما بعد الجلسة","عرض خاص على الباقات","رسالة رمضان","استطلاع رضا المريض"];

function Campaigns({ go }) {
  const [view, setView] = React.useState("list"); // list | builder | analytics
  const [selected, setSelected] = React.useState(null);
  const [templatesOpen, setTemplatesOpen] = React.useState(false);
  const [initialTemplate, setInitialTemplate] = React.useState(null);
  const [statusFilter, setStatusFilter] = React.useState("الكل");
  const shownCampaigns = DATA.campaigns.filter(c => statusFilter === "الكل" || campaignStatusAr(c.status) === statusFilter);

  if (view === "builder") return <CampaignBuilder initialTemplate={initialTemplate} onCancel={()=>{setInitialTemplate(null);setView("list");}} onSave={()=>{
    if (window.showToast) window.showToast(tt("تم إطلاق الحملة"), "success");
    setInitialTemplate(null);
    setView("list");
  }}/>;
  if (view === "analytics" && selected) return <CampaignAnalytics c={selected} onBack={()=>setView("list")}/>;

  return (
    <Page>
      <div className="page-head">
        <div>
          <div className="crumb"><span>{tt("الرئيسية")}</span><I.Chevron size={11}/><span>{tt("حملات واتساب")}</span></div>
          <h1 className="h1">{tt("حملات واتساب")}</h1>
          <div className="muted" style={{fontSize:13.5,marginTop:4}}>{tt("تواصل مع مرضاك عبر التذكيرات والمتابعات والإعلانات.")}</div>
        </div>
        <div className="page-actions">
          <button className="btn btn-secondary" onClick={()=>setTemplatesOpen(true)}><I.FileText size={14}/> {tt("القوالب")}</button>
          <button className="btn btn-blue" onClick={()=>setView("builder")}><I.Plus size={14}/> {tt("حملة جديدة")}</button>
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
        <StatCard label={tt("رسائل مُرسلة")}   value={fmtNumber(sent)} accent="#25D366" icon={<I.WhatsApp size={15}/>}/>
        <StatCard label={tt("معدل القراءة")}             value={pct(read, sent)} accent="#7BBDE8" icon={<I.Eye size={15}/>}/>
        <StatCard label={tt("معدل الرد")}         value={pct(replied, sent)} accent="#7E6BD3" icon={<I.Send size={15}/>}/>
        <StatCard label={tt("الحملات النشطة")}       value={String(DATA.campaigns.filter(c=>campaignStatusAr(c.status)==="جارٍ"||campaignStatusAr(c.status)==="مجدول").length)} accent="#D8665A" icon={<I.Megaphone size={15}/>}/>
      </div>
        );
      })()}

      <div className="card" style={{overflow:"hidden"}}>
        <div style={{padding:"12px 18px",borderBottom:"1px solid var(--ink-200)",display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
          <div className="h3">{tt("الحملات")}</div>
          <div style={{flex:1}}/>
          <Segmented label={tt("حالة الحملة")} value={statusFilter} onChange={setStatusFilter}
            options={["الكل","جارٍ","مجدول","مكتمل"].map(s => ({ value: s, label: tt(s) }))}/>
        </div>
        <div className="tbl-scroll">
        <CardTable>
          <thead><tr><th>{tt("الحملة")}</th><th>{tt("الجمهور")}</th><th>{tt("مُرسلة")}</th><th>{tt("مقروءة")}</th><th>{tt("ردّ")}</th><th>{tt("القالب")}</th><th>{tt("الجدولة")}</th><th>{tt("الحالة")}</th><th><span className="sr-only">{tt("إجراءات")}</span></th></tr></thead>
          <tbody>
            {DATA.campaigns.length===0 && (
              <tr><td colSpan={9}><EmptyState icon={<I.Megaphone size={22}/>} title={tt("لا حملات بعد")} body={tt("أطلق أول حملة واتساب من زر «حملة جديدة».")}/></td></tr>
            )}
            {DATA.campaigns.length>0 && shownCampaigns.length===0 && (
              <tr><td colSpan={9}><div className="tbl-empty"><I.Search size={20}/><div>{tt("لا حملات بهذه الحالة.")}</div></div></td></tr>
            )}
            {shownCampaigns.map(c=>(
              <tr key={c.id} data-clickable="true" tabIndex={0} onClick={()=>{setSelected(c);setView("analytics")}} onKeyDown={e=>{ if(e.key==="Enter"||e.key===" "){e.preventDefault();setSelected(c);setView("analytics");} }}>
                <td>
                  <div style={{display:"flex",alignItems:"center",gap:10}}>
                    <div style={{width:32,height:32,borderRadius:8,background:c.best?"linear-gradient(135deg,#25D366,#1FA351)":"var(--blue-100)",color:"#fff",display:"flex",alignItems:"center",justifyContent:"center"}}>
                      <I.WhatsApp size={15} style={{color: c.best?"#fff":"var(--blue-700)"}}/>
                    </div>
                    <div>
                      <div style={{fontWeight:600,display:"flex",alignItems:"center",gap:6}}>
                        {c.name}
                        {c.best && <span className="badge b-green" style={{fontSize:10}}><I.Sparkle size={10}/>{tt("الأفضل أداءً")}</span>}
                      </div>
                      <div className="mono" style={{fontSize:11,color:"var(--ink-500)"}}>{c.id}</div>
                    </div>
                  </div>
                </td>
                <td className="mono">{fmtNumber(c.audience)}</td>
                <td className="mono">{fmtNumber(c.sent)}</td>
                <td>
                  <div>
                    <span className="mono">{fmtNumber(c.read)}</span>
                    {c.sent>0 && <div style={{height:3,background:"var(--ink-100)",borderRadius:999,overflow:"hidden",marginTop:3,width:80}}>
                      <div style={{height:"100%",width:`${c.read/c.sent*100}%`,background:"var(--blue-500)"}}/>
                    </div>}
                  </div>
                </td>
                <td className="mono">{c.replied} <span className="muted" style={{fontSize:11}}>{c.sent?`(${(c.replied/c.sent*100).toFixed(1)}%)`:""}</span></td>
                <td><span className="pill">{c.template}</span></td>
                <td><span style={{fontSize:12}}>{c.schedule}</span></td>
                <td>
                  <span className={"badge " + campaignBadge(c.status)}>
                    <span className="dot"></span>{tt(campaignStatusAr(c.status))}
                  </span>
                </td>
                <td>
                  <button className="btn btn-ghost btn-icon" title={tt("عرض التحليلات")} aria-label={tt("عرض التحليلات")} onClick={(e)=>{e.stopPropagation();setSelected(c);setView("analytics")}}><I.Chart size={13}/></button>
                  <RowMenu size={13} items={[
                    { label:tt("عرض التحليلات"), icon:<I.Chart size={13}/>, onClick:()=>{setSelected(c);setView("analytics");} },
                    { label:tt("مضاعفة الحملة"), icon:<I.Plus size={13}/>, onClick:async()=>{
                      const clone = { ...c, id: newRecordId((c.id||"CM-")+"-C-"), name: tt("{name} — نسخة", { name: c.name }), status:"مسودة", sent:0, read:0, replied:0 };
                      try { await window.KineticData.upsert("campaigns", clone); }
                      catch (e) { console.warn("clone campaign failed", e); }
                      if (window.showToast) window.showToast(tt("تم نسخ الحملة"),"success");
                    }},
                    { label:campaignStatusAr(c.status)==="جارٍ"?tt("إيقاف مؤقت"):tt("استئناف"), icon:<I.X size={13}/>, onClick:async()=>{
                      const nextStatus = campaignStatusAr(c.status)==="جارٍ" ? "مجدول" : "جارٍ";
                      try { await window.KineticData.upsert("campaigns", { ...c, status: nextStatus }); }
                      catch (e) { console.warn("toggle campaign failed", e); }
                      if (window.showToast) window.showToast(nextStatus==="جارٍ"?tt("تم الاستئناف"):tt("تم الإيقاف المؤقت"),"success");
                    }},
                    { label:tt("حذف الحملة"), icon:<I.X size={13}/>, danger:true, onClick:async()=>{
                      if (!window.confirm(tt("حذف حملة {name}؟", { name: c.name }))) return;
                      try { await window.KineticData.remove("campaigns", c.id); }
                      catch (e) { console.warn("delete campaign failed", e); }
                      if (window.showToast) window.showToast(tt("تم حذف الحملة"),"success");
                    }},
                  ]}/>
                </td>
              </tr>
            ))}
          </tbody>
        </CardTable>
        </div>
      </div>
      {templatesOpen && (
        <Modal title={tt("قوالب الحملات")} onClose={()=>setTemplatesOpen(false)}>
          {CAMPAIGN_TEMPLATE_NAMES.map((t,i)=>(
            <div key={i} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 0",borderBottom:"1px solid var(--ink-100)"}}>
              <span style={{fontSize:13}}>{tt(t)}</span>
              <button className="btn btn-secondary" style={{fontSize:12}} onClick={()=>{setInitialTemplate(t);setTemplatesOpen(false);setView("builder");if(window.showToast)window.showToast(tt("تم تحميل القالب: {name}", { name: tt(t) }),"success");}}>{tt("استخدام")}</button>
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
  const [name, setName] = React.useState(initialTemplate ? tt(initialTemplate) : tt("متابعة ربع سنوية لمرضى أسفل الظهر"));
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
    // The bodies' {{…}} tags are message variables, not tt() placeholders.
    { name:tt("متابعة ربع سنوية"), body:tt("أهلاً {{first_name}} 👋 it's been a while! How is your {{condition}} feeling? Reply 1 to book a جلسة, 2 to chat مع a therapist.") },
    { name:tt("تذكير بموعد"), body:tt("أهلاً {{first_name}}, reminder for your جلسة tomorrow at {{time}} مع {{therapist}}. Reply CONFIRM to confirm or RESCHEDULE.") },
    { name:tt("متابعة بعد العمليات"), body:tt("أهلاً {{first_name}}, how's your recovery? Your therapist {{therapist}} wants to check in. Are you experiencing any discomfort?") },
    { name:tt("تهاني عيد الميلاد"), body:tt("Happy birthday {{first_name}}! 🎉 Wishing you a year من pain-free movement. Enjoy 15% off your next package this month.") },
  ];

  return (
    <Page>
      <div className="crumb" style={{cursor:"pointer"}} onClick={onCancel}><span>{tt("حملات واتساب")}</span><I.Chevron size={11}/><span style={{color:"var(--ink-700)"}}>{tt("حملة جديدة")}</span></div>
      <h1 className="h1" style={{marginBottom:6}}>{tt("إنشاء حملة")}</h1>
      <div className="muted" style={{fontSize:13.5,marginBottom:22}}>{tt("ابنِ، استهدف وجدول في 4 خطوات.")}</div>

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
                <span className="step-label" style={{fontSize:12.5,fontWeight:i+1===step?600:500,color:i+1===step?"var(--ink-900)":"var(--ink-500)"}}>{tt(s)}</span>
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
              <div className="h2" style={{marginBottom:18}}>{tt("الحملة basics")}</div>
              <Field label={tt("الاسم")} required><input className="input" value={name} onChange={e=>setName(e.target.value)}/></Field>
              <div style={{height:14}}/>
              <Field label={tt("الهدف")}>
                <div className="rgrid half-sm" style={{"--gtc":"repeat(4,1fr)",gap:8}}>
                  {["حجوزات","إعادة تفاعل","تذكيرات","إعلانات"].map((g,i)=>(
                    <button key={g} className="btn btn-secondary" style={{justifyContent:"flex-start",padding:12,background:i===1?"var(--blue-50)":"#fff",borderColor:i===1?"var(--blue-500)":"var(--ink-200)"}}>
                      {tt(g)}
                    </button>
                  ))}
                </div>
              </Field>
              <div style={{height:14}}/>
              <Field label={tt("وصف داخلي")}><textarea className="input" style={{height:70,padding:10}} placeholder={tt("ما هدف هذه الحملة؟")}/></Field>
            </div>
          )}

          {step===2 && (
            <div>
              <div className="h2" style={{marginBottom:18}}>{tt("الجمهور المستهدف")}</div>
              <div className="rgrid c-sm" style={{"--gtc":"repeat(2,1fr)",gap:14}}>
                <Field label={tt("التشخيص")}><input className="input" value={filters.diag} onChange={e=>setFilters({...filters,diag:e.target.value})}/></Field>
                <Field label={tt("الحالة/نوع الإصابة")}><select className="input"><option>{tt("أي")}</option><option>{tt("بعد العمليات")}</option><option>{tt("أمراض مزمنة pain")}</option></select></Field>
                <Field label={tt("الفئة العمرية")}><input className="input" defaultValue="35 – 75"/></Field>
                <Field label={tt("الجنس")}><select className="input" value={filters.gender} onChange={e=>setFilters({...filters,gender:e.target.value})}>{["أي","أنثى","ذكر"].map(g => <option key={g} value={g}>{tt(g)}</option>)}</select></Field>
                <Field label={tt("طبيب")}><select className="input"><option>{tt("أي")}</option>{[...new Set(DATA.patients.map(p=>p.dr).filter(d=>d&&d!=="—"))].map(d=><option key={d}>{d}</option>)}</select></Field>
                <Field label={tt("الأخصائي")}><select className="input"><option>{tt("أي")}</option>{DATA.therapists.map(t=><option key={t.id||t.name}>{t.name}</option>)}</select></Field>
                <Field label={tt("الجلسات المتبقية")}><select className="input" value={filters.remaining} onChange={e=>setFilters({...filters,remaining:e.target.value})}>{["أي","0","1–2","≥ 3"].map(v => <option key={v} value={v}>{tt(v)}</option>)}</select></Field>
                <Field label={tt("آخر زيارة")}><select className="input" value={filters.lastVisit} onChange={e=>setFilters({...filters,lastVisit:e.target.value})}>{["آخر 7 أيام","14+ days","30+ days","60+ days"].map(v => <option key={v} value={v}>{tt(v)}</option>)}</select></Field>
                <Field label={tt("أمراض مزمنة disease")}><select className="input"><option>{tt("أي")}</option><option>{tt("سكري")}</option><option>{tt("ضغط دم")}</option></select></Field>
                <Field label={tt("الدفع status")}><select className="input"><option>{tt("أي")}</option><option>{tt("مدفوع")}</option><option>{tt("معلّق")}</option><option>{tt("متأخر")}</option></select></Field>
              </div>

              <div style={{padding:14,background:"var(--blue-50)",border:"1px solid var(--blue-100)",borderRadius:12,marginTop:18,display:"flex",alignItems:"center",gap:14,flexWrap:"wrap"}}>
                <div style={{width:42,height:42,borderRadius:11,background:"var(--blue-500)",color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                  <I.Users size={18}/>
                </div>
                <div style={{flex:1,minWidth:200}}>
                  <div style={{fontWeight:600,fontSize:13.5,color:"var(--blue-900)"}}>{ttx("هذا الجمهور يشمل {count}", { count: <span className="mono">{tt("{n} مريض", { n: audiencePatients.length })}</span> })}</div>
                  <div className="muted" style={{fontSize:12,marginTop:2}}>{filters.diag ? tt("تشخيص: {diag}", { diag: filters.diag }) + " · " : ""}{tt("تكلفة تقديرية {cost}", { cost: fmtMoney(Math.round(audiencePatients.length * 0.5)) })}</div>
                </div>
                <button className="btn btn-secondary" onClick={()=>setPreviewOpen(true)}>{tt("معاينة القائمة")}</button>
              </div>
            </div>
          )}

          {step===3 && (
            <div>
              <div className="h2" style={{marginBottom:18}}>{tt("الرسالة")}</div>
              <div className="label">{tt("القالب")}</div>
              <div className="rgrid c-sm" style={{"--gtc":"repeat(2,1fr)",gap:10,marginBottom:18}}>
                {templates.map((t,i)=>(
                  <button key={i} onClick={()=>setTemplate(i)} style={{
                    // Physical left in both languages: the sample bodies are mostly Latin text.
                    padding:14,textAlign:"left",cursor:"pointer",
                    border:`1px solid ${template===i?"var(--blue-500)":"var(--ink-200)"}`,
                    borderRadius:11,background: template===i?"var(--blue-50)":"#fff",
                  }}>
                    <div style={{fontWeight:600,fontSize:13}}>{t.name}</div>
                    <div className="muted" style={{fontSize:11.5,marginTop:4,lineHeight:1.5,display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical",overflow:"hidden"}}>{t.body}</div>
                  </button>
                ))}
              </div>

              <Field label={tt("الرسالة body")}><textarea className="input" style={{height:160,padding:14,resize:"vertical",fontSize:13.5,lineHeight:1.55}} defaultValue={templates[template].body}/></Field>
              <div className="muted" style={{fontSize:11.5,marginTop:6}}>{ttx("استخدم {a}, {b}, {c} للتخصيص.", { a: <span className="mono">{"{{first_name}}"}</span>, b: <span className="mono">{"{{therapist}}"}</span>, c: <span className="mono">{"{{condition}}"}</span> })}</div>

              <div style={{display:"flex",gap:8,marginTop:14,flexWrap:"wrap"}}>
                <button className="btn btn-secondary" style={{fontSize:12}}><I.Image size={13}/> {tt("إرفاق صورة")}</button>
                <button className="btn btn-secondary" style={{fontSize:12}}><I.FileText size={13}/> {tt("إرفاق PDF")}</button>
                <button className="btn btn-secondary" style={{fontSize:12}}><I.Plus size={13}/> {tt("زر رد سريع")}</button>
              </div>
            </div>
          )}

          {step===4 && (
            <div>
              <div className="h2" style={{marginBottom:18}}>{tt("الجدولة")}</div>
              <Field label={tt("متى ترسل")}>
                <div className="rgrid c-sm" style={{"--gtc":"repeat(3,1fr)",gap:10}}>
                  {[
                    {l:tt("إرسال الآن"),sub:tt("خلال 5 دقائق")},
                    {l:tt("الجدولة one-shot"),sub:tt("اختر تاريخًا ووقتًا")},
                    {l:tt("متكررة"),sub:tt("يومي، أسبوعي، شهري")},
                  ].map((s,i)=>(
                    <button key={i} className="btn btn-secondary" style={{flexDirection:"column",alignItems:"flex-start",padding:14,background:i===1?"var(--blue-50)":"#fff",borderColor:i===1?"var(--blue-500)":"var(--ink-200)"}}>
                      <div style={{fontWeight:600,fontSize:13.5}}>{s.l}</div>
                      <div className="muted" style={{fontSize:11.5,marginTop:3}}>{s.sub}</div>
                    </button>
                  ))}
                </div>
              </Field>
              <div className="rgrid c-sm" style={{"--gtc":"repeat(2,1fr)",gap:14,marginTop:14}}>
                <Field label={tt("التاريخ")}><input className="input" type="date" defaultValue="2026-06-02"/></Field>
                <Field label={tt("الوقت")}><input className="input" type="time" defaultValue="09:00"/></Field>
                <Field label={tt("المنطقة الزمنية")} span={2}><select className="input"><option>Cairo (GMT+2)</option></select></Field>
              </div>

              <div style={{padding:14,background:"var(--green-bg)",border:"1px solid #BCE0D1",borderRadius:12,marginTop:18,display:"flex",alignItems:"center",gap:14}}>
                <I.Check size={20} style={{color:"var(--green)"}}/>
                <div>
                  <div style={{fontWeight:600,fontSize:13.5,color:"#2C8067"}}>{tt("جاهزة للإطلاق")}</div>
                  <div className="muted" style={{fontSize:12}}>312 messages will be queued for Jun 2, 09:00 (Cairo) at ~EGP 156 total.</div>
                </div>
              </div>
            </div>
          )}

          <div style={{display:"flex",justifyContent:"space-between",marginTop:24,flexWrap:"wrap",gap:10}}>
            <button className="btn btn-secondary" disabled={step===1} onClick={()=>setStep(step-1)} style={{opacity:step===1?.5:1}}>
              <I.ArrowLeft size={13}/> {tt("رجوع")}
            </button>
            <div style={{display:"flex",gap:10}}>
              <button className="btn btn-ghost" onClick={onCancel}>{tt("إلغاء")}</button>
              {step<4 ? (
                <button className="btn btn-blue" onClick={()=>setStep(step+1)}>{tt("متابعة")} <I.ArrowRight size={13}/></button>
              ) : (
                <button className="btn btn-blue" onClick={onSave}><I.Send size={13}/> {tt("إطلاق الحملة")}</button>
              )}
            </div>
          </div>
        </div>

        {/* Live preview */}
        <div>
          <div className="label">{tt("Live preview · واتساب")}</div>
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
                <div style={{fontSize:13,fontWeight:600,color:"#075E54"}}>{tt("عيادة كينيتك")}</div>
                <div style={{fontSize:11,color:"#888"}}>{tt("متصل")}</div>
              </div>
            </div>
            {/* Chat bubbles: the incoming one sits at the start with its tail
                corner at the bottom end, mirrored for left-to-right. */}
            <div style={{display:"flex",justifyContent:"flex-start",marginBottom:8}}>
              <div style={{
                background:"#fff",borderRadius:IS_RTL ? "12px 12px 12px 4px" : "12px 12px 4px 12px",
                padding:"10px 12px",fontSize:13,maxWidth:"86%",
                boxShadow:"0 1px 1px rgba(0,0,0,.1)",lineHeight:1.45
              }}>
                {ttx("أهلاً {name} 👋", { name: <strong>{"{{first_name}}"}</strong> })}<br/>
                {ttx("مرّ وقت طويل! كيف حال {condition} مؤخرًا؟", { condition: <strong>{"{{condition}}"}</strong> })}<br/><br/>
                {ttx("اضغط {key} لحجز جلسة", { key: <strong>1</strong> })}<br/>
                {ttx("اضغط {key} للتحدث مع أخصائي", { key: <strong>2</strong> })}
                <div style={{fontSize:10,color:"#888",textAlign:"start",marginTop:6}}>09:00 · ✓✓</div>
              </div>
            </div>
            <div style={{display:"flex",justifyContent:"flex-end",marginBottom:8}}>
              <div style={{background:"#DCF8C6",borderRadius:IS_RTL ? "12px 12px 4px 12px" : "12px 12px 12px 4px",padding:"10px 12px",fontSize:13}}>
                {tt("1 — book a جلسة")}
                <div style={{fontSize:10,color:"#888",textAlign:"start",marginTop:6}}>09:04 · ✓✓</div>
              </div>
            </div>
            <div style={{display:"flex",justifyContent:"flex-start",marginBottom:8}}>
              <div style={{background:"#fff",borderRadius:IS_RTL ? "12px 12px 12px 4px" : "12px 12px 4px 12px",padding:"10px 12px",fontSize:13,maxWidth:"86%",boxShadow:"0 1px 1px rgba(0,0,0,.1)"}}>
                {tt("تمام! {time} مع {therapist}؟", { time: "{{time}}", therapist: "{{therapist}}" })}<br/>
                {ttx("اضغط {yes} للتأكيد.", { yes: <strong>{tt("نعم")}</strong> })}
                <div style={{fontSize:10,color:"#888",textAlign:"start",marginTop:6}}>09:04 · ✓</div>
              </div>
            </div>

            <div style={{textAlign:"center",fontSize:11,color:"#888",marginTop:20}}>{tt("هذه معاينة توضيحية تلقائية")}</div>
          </div>
        </div>
      </div>
      {previewOpen && (
        <Modal title={tt("معاينة جمهور الحملة")} onClose={()=>setPreviewOpen(false)}>
          <div className="muted" style={{fontSize:12,marginBottom:10}}>{tt("عرض عيّنة من المرضى المطابقين للفلاتر الحالية:")}</div>
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
            {(!DATA.patients || DATA.patients.length===0) && <div className="muted" style={{fontSize:12,padding:14,textAlign:"center"}}>{tt("لا يوجد مرضى في قاعدة البيانات بعد.")}</div>}
          </div>
        </Modal>
      )}
    </Page>
  );
}

function CampaignAnalytics({ c, onBack }) {
  const [status, setStatus] = React.useState(campaignStatusAr(c.status));
  const flipStatus = (next, msg) => {
    c.status = next;
    setStatus(next);
    try { window.dispatchEvent(new CustomEvent("kinetic:data-updated", { detail: { table: "campaigns" } })); } catch(_) {}
    if (window.showToast) window.showToast(msg, "success");
  };
  const funnelData = [
    { label:tt("مستهدف"), v:c.audience, color:"#BDD8E9" },
    { label:tt("مُرسلة"),     v:c.sent,     color:"#7BBDE8" },
    { label:tt("مقروءة"),     v:c.read,     color:"#3A7FB5" },
    { label:tt("ردّ"),  v:c.replied,  color:"#1E4A6E" },
  ];
  const timeSeries = [240, 320, 280, 340, 390, 280, 120].map((v, i) => ({ label: tt("يوم {n}", { n: i + 1 }), v }));

  return (
    <Page>
      <div className="crumb" style={{cursor:"pointer"}} onClick={onBack}><span>{tt("الحملات")}</span><I.Chevron size={11}/><span style={{color:"var(--ink-700)"}}>{c.name}</span></div>
      <div className="page-head">
        <div>
          <div className="h1" style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
            {c.name}
            {c.best && <span className="badge b-green"><I.Sparkle size={12}/>{tt("الأفضل أداءً")}</span>}
            <span className={"badge " + campaignBadge(status)}><span className="dot"></span>{tt(status)}</span>
          </div>
          <div className="muted" style={{fontSize:13.5,marginTop:4}}>{c.id} · {c.schedule} · template "{c.template}"</div>
        </div>
        <div className="page-actions">
          {status==="جارٍ"
            ? <button className="btn btn-secondary" onClick={()=>flipStatus("مجدول",tt("تم إيقاف الحملة مؤقتًا"))}><I.X size={13}/> {tt("إيقاف مؤقت")}</button>
            : <button className="btn btn-secondary" onClick={()=>flipStatus("جارٍ",tt("تم استئناف الحملة"))}><I.Send size={13}/> {tt("استئناف")}</button>}
          <button className="btn btn-secondary" onClick={()=>onBack&&onBack()}><I.Edit size={13}/> {tt("تعديل")}</button>
          <button className="btn btn-blue" onClick={()=>flipStatus("جارٍ",tt("تم تشغيل الحملة الآن"))}><I.Send size={13}/> {tt("تشغيل الآن")}</button>
        </div>
      </div>

      <div className="grid-4" style={{marginBottom:18}}>
        <StatCard label={tt("مُرسلة")}        value={fmtNumber(c.sent)}    accent="#7BBDE8" icon={<I.Send size={15}/>}/>
        <StatCard label={tt("مقروءة")}        value={c.sent ? `${(c.read/c.sent*100).toFixed(0)}%` : "—"} accent="#3A7FB5" icon={<I.Eye size={15}/>}/>
        <StatCard label={tt("ردّ")}     value={c.sent ? `${(c.replied/c.sent*100).toFixed(1)}%` : "—"} accent="#7E6BD3" icon={<I.WhatsApp size={15}/>}/>
        <StatCard label={tt("تحويلات")} value="42" delta="+12" deltaKind="up" accent="#3FA984" icon={<I.Check size={15}/>}/>
      </div>

      <div className="rgrid c-lg" style={{"--gtc":"1.5fr 1fr",marginBottom:18}}>
        <div className="card card-pad">
          <div className="h2" style={{marginBottom:18}}>{tt("الرسائل بمرور الوقت")}</div>
          <AreaChart data={timeSeries} height={220} formatY={v=>v}/>
        </div>
        <div className="card card-pad">
          <div className="h2" style={{marginBottom:18}}>{tt("القمع")}</div>
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            {funnelData.map((f,i)=>{
              const w = f.v/funnelData[0].v*100;
              return (
                <div key={f.label}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                    <span style={{fontSize:12.5,fontWeight:500}}>{f.label}</span>
                    <span className="mono" style={{fontSize:12.5}}>{fmtNumber(f.v)} <span className="muted">({Math.round(w)}%)</span></span>
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
          <div className="h2" style={{marginBottom:14}}>{tt("أفضل الردود")}</div>
          <div className="muted" style={{fontSize:13,padding:"14px 0"}}>{tt("ستظهر ردود المرضى هنا بعد ربط واتساب للأعمال.")}</div>
        </div>
        <div className="card card-pad">
          <div className="h2" style={{marginBottom:14}}>{tt("رسائل فاشلة")}</div>
          <div className="muted" style={{fontSize:13,padding:"14px 0"}}>{tt("لا رسائل فاشلة — تُعرض التسليمات المرتدة هنا بعد ربط واتساب للأعمال.")}</div>
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
function reportActiveFilters(f, show, opts, scopeLabel) {
  const list = [{ label: tt("الفترة"), value: `${f.from || "—"} ${IS_RTL ? "←" : "→"} ${f.to || "—"}` }];
  if (scopeLabel) list.push({ label: tt("الفرع"), value: scopeLabel });
  if (show.therapist && f.therapist !== "all") list.push({ label: tt("الأخصائي"), value: f.therapist });
  if (show.doctor && f.doctor !== "all") list.push({ label: tt("الطبيب"), value: f.doctor });
  if (show.patient && f.patient !== "all") {
    const p = (opts.patients || []).find(x => x.id === f.patient);
    list.push({ label: tt("المريض"), value: p ? p.name : f.patient });
  }
  if (f.q) list.push({ label: tt("بحث"), value: f.q });
  return list;
}

// Date-range + entity filter bar with search + Excel export button.
function ReportFilterBar({ f, set, opts, show, onExport, searchPlaceholder = tt("بحث…") }) {
  const uid = React.useId();
  return (
    <div className="card card-pad" style={{ marginBottom: 18 }}>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div style={{ minWidth: 140 }}>
          <label className="label" htmlFor={uid + "from"} style={{ display: "block" }}>{tt("من تاريخ")}</label>
          <input id={uid + "from"} type="date" className="input" value={f.from} max={f.to || undefined} onChange={e => set("from", e.target.value)} />
        </div>
        <div style={{ minWidth: 140 }}>
          <label className="label" htmlFor={uid + "to"} style={{ display: "block" }}>{tt("إلى تاريخ")}</label>
          <input id={uid + "to"} type="date" className="input" value={f.to} min={f.from || undefined} onChange={e => set("to", e.target.value)} />
        </div>
        {show.therapist && (
          <div style={{ minWidth: 150 }}>
            <label className="label" htmlFor={uid + "therapist"} style={{ display: "block" }}>{tt("الأخصائي")}</label>
            <select id={uid + "therapist"} className="input" value={f.therapist} onChange={e => set("therapist", e.target.value)}>
              <option value="all">{tt("كل الأخصائيين")}</option>
              {opts.therapists.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
        )}
        {show.doctor && (
          <div style={{ minWidth: 150 }}>
            <label className="label" htmlFor={uid + "doctor"} style={{ display: "block" }}>{tt("الطبيب")}</label>
            <select id={uid + "doctor"} className="input" value={f.doctor} onChange={e => set("doctor", e.target.value)}>
              <option value="all">{tt("كل الأطباء")}</option>
              {opts.doctors.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
        )}
        {show.patient && (
          <div style={{ minWidth: 170 }}>
            <label className="label" htmlFor={uid + "patient"} style={{ display: "block" }}>{tt("المريض")}</label>
            <select id={uid + "patient"} className="input" value={f.patient} onChange={e => set("patient", e.target.value)}>
              <option value="all">{tt("كل المرضى")}</option>
              {opts.patients.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        )}
        <div style={{ flex: 1, minWidth: 170 }}>
          <label className="label" htmlFor={uid + "q"} style={{ display: "block" }}>{tt("بحث")}</label>
          <input id={uid + "q"} className="input" placeholder={searchPlaceholder} value={f.q} onChange={e => set("q", e.target.value)} />
        </div>
        <button type="button" className="btn btn-blue" onClick={onExport} style={{ whiteSpace: "nowrap" }}>
          <I.Download size={14} /> {tt("تصدير Excel")}
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
      {/* Focusable so a keyboard can scroll the wide table on phones. */}
      <div className="tbl-scroll" role="region" aria-label={tt("جدول النتائج")} tabIndex={0}>
        <CardTable className="report-rows">
          <thead><tr>{columns.map(c => <th key={c.key} style={c.type === "number" || c.type === "currency" ? { textAlign: "start" } : undefined}>{c.label}</th>)}</tr></thead>
          <tbody>
            {view.length === 0 && (
              <tr><td colSpan={columns.length}><div className="tbl-empty"><I.Search size={20} /><div>{empty || tt("لا نتائج ضمن عوامل التصفية الحالية.")}</div></div></td></tr>
            )}
            {view.map((r, i) => (
              <tr key={r.id || i} data-branch={r.branch_id || undefined}>
                {columns.map(c => (
                  <td key={c.key} className={(c.type === "number" || c.type === "currency" || /date$/.test(c.key)) ? "mono tnum" : undefined}
                    style={/date$/.test(c.key) || c.type === "currency" ? { whiteSpace: "nowrap" } : undefined}>
                    {c.render ? c.render(r) : (c.type === "currency" ? fmtMoney(r[c.key]) : (r[c.key] == null || r[c.key] === "" ? "—" : r[c.key]))}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </CardTable>
      </div>
      {total > 0 && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 12, gap: 8, flexWrap: "wrap" }}>
          <div className="muted" style={{ fontSize: 12 }}>{ttx("صفحة {page} من {pages} · النتائج: {total}", { page: <span className="mono">{safe}</span>, pages: <span className="mono">{pages}</span>, total: <span className="mono">{fmtNumber(total)}</span> })}</div>
          <div style={{ display: "flex", gap: 4 }}>
            <button type="button" className="btn btn-secondary" style={{ fontSize: 12, padding: "4px 10px" }} disabled={safe <= 1} onClick={() => setPage(safe - 1)}>{tt("السابق")}</button>
            <button type="button" className="btn btn-secondary" style={{ fontSize: 12, padding: "4px 10px" }} disabled={safe >= pages} onClick={() => setPage(safe + 1)}>{tt("التالي")}</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Branch scope (docs/03 C05, task 3.19) ─────────────────────
// The clinic admin of a clinic with more than one branch chooses «الفرع
// الحالي» (the rows already loaded for the branch picked in the sidebar)
// or «كل الفروع» (every branch, with a «الفرع» column, a per-branch
// breakdown, and the search matching the branch name too). Every branch's
// rows are read for this view only (KineticData.listAllBranches):
// X-Branch-Id and window.DATA do not change. Other roles keep the current
// branch, as before.
const REPORT_SCOPE_TABLES = ["appts", "sessions", "payments"];
function reportCanPickBranch() {
  if (!window.SB || !window.KineticData || typeof window.KineticData.listAllBranches !== "function") return false;
  const role = window.TENANT_ROLE || (window.ME && window.ME.role === "مدير" ? "admin" : "");
  return role === "admin" && (window.BRANCHES || []).length > 1;
}
function reportBranchName(id) {
  const b = (window.BRANCHES || []).find(x => x.id === id);
  return b ? b.name : (id || "—");
}
function reportBranchActive(b) {
  return window.branchIsActive ? window.branchIsActive(b) : String((b && b.status) || "active") !== "inactive";
}
// scope: "current" | "all" → { scope, all, label, rowsOf(name), loading,
// waiting (nothing loaded yet), error, retry } for the report tabs.
function useReportScope(scope, version) {
  const wide = scope === "all";
  const [state, setState] = React.useState({ tables: null, loading: false, error: "" });
  const reqRef = React.useRef(0);
  const fetchAll = React.useCallback(() => {
    const n = ++reqRef.current;
    setState(s => ({ ...s, loading: true, error: "" }));
    window.KineticData.listAllBranches(REPORT_SCOPE_TABLES).then(
      tables => { if (n === reqRef.current) setState({ tables, loading: false, error: "" }); },
      e => { if (n === reqRef.current) setState(s => ({ ...s, loading: false, error: (e && e.message) || tt("تعذّر تحميل بيانات الفروع") })); });
  }, []);
  // Read again whenever the clinic's data changes (a save, a branch switch).
  React.useEffect(() => { if (wide) fetchAll(); }, [wide, version, fetchAll]);
  return {
    scope, all: wide,
    label: wide ? tt("كل الفروع ({n})", { n: (window.BRANCHES || []).length }) : tt("الفرع: {name}", { name: activeBranchName() }),
    rowsOf: (name) => wide ? ((state.tables && state.tables[name]) || []) : ((window.DATA && window.DATA[name]) || []),
    loading: wide && state.loading, waiting: wide && !state.tables, error: wide ? state.error : "", retry: fetchAll,
  };
}

// Per-branch totals for «كل الفروع»: a row for every branch of the clinic
// (one without rows too), then the clinic total. `metrics`: [{ key, label,
// calc(rows) → number, fmt(number) → text }].
function ReportBranchBreakdown({ rows, metrics }) {
  const branches = window.BRANCHES || [];
  const ids = branches.map(b => b.id);
  rows.forEach(r => { if (r.branch_id && !ids.includes(r.branch_id)) ids.push(r.branch_id); });
  const groups = {};
  rows.forEach(r => { (groups[r.branch_id] = groups[r.branch_id] || []).push(r); });
  const cells = (list) => metrics.map(m => {
    const v = m.calc(list);
    return <td key={m.key} className="mono tnum" data-metric={m.key} data-value={v}>{m.fmt(v)}</td>;
  });
  return (
    <div className="card card-pad report-branch-breakdown" style={{ marginBottom: 18 }}>
      <div className="h2" style={{ marginBottom: 12 }}>{tt("حسب الفرع")}</div>
      <div className="tbl-scroll" role="region" aria-label={tt("حسب الفرع")} tabIndex={0}>
        <CardTable>
          <thead><tr><th>{tt("الفرع")}</th>{metrics.map(m => <th key={m.key} style={{ textAlign: "start" }}>{m.label}</th>)}</tr></thead>
          <tbody>
            {ids.map(id => {
              const b = branches.find(x => x.id === id);
              return (
                <tr key={id} data-branch-row={id}>
                  <td>{reportBranchName(id)}{b && !reportBranchActive(b) && <span className="badge b-grey" style={{ marginInlineStart: 6 }}>{tt("معطّل")}</span>}</td>
                  {cells(groups[id] || [])}
                </tr>
              );
            })}
            <tr data-branch-row="total" style={{ fontWeight: 600, background: "var(--ink-50)" }}>
              <td>{tt("الإجمالي")}</td>
              {cells(rows)}
            </tr>
          </tbody>
        </CardTable>
      </div>
    </div>
  );
}
const reportFmtCount = (v) => fmtNumber(v || 0);
const reportFmtMoney = (v) => fmtMoney(Math.round(Number(v) || 0));
const reportBranchColumn = { key: "branch", label: tt("الفرع"), type: "text", width: 16 };
// Booking types are saved as text: «جلسة علاج طبيعي» or «جلسة + استشارة
// <department>» (the booking wizard); shown translated where they match.
function reportApptType(t) {
  if (!t) return "—";
  if (t === "جلسة علاج طبيعي") return tt(t);
  const m = /^جلسة \+ استشارة (.+)$/.exec(t);
  return m ? tt("جلسة + استشارة {dept}", { dept: m[1] }) : t;
}

function Reports({ go }) {
  const version = window.useDataVersion ? window.useDataVersion() : 0;
  const [section, setSection] = React.useState("financial");
  const canPick = reportCanPickBranch();
  const [scopeChoice, setScopeChoice] = React.useState("current");
  const view = useReportScope(canPick ? scopeChoice : "current", version);

  const cats = [
    { id: "financial",   l: tt("المالية"),     icon: <I.Dollar size={15} /> },
    { id: "medical",     l: tt("الطبي"),       icon: <I.Heart size={15} /> },
    { id: "operational", l: tt("التشغيلية"),   icon: <I.Activity size={15} /> },
  ];

  return (
    <Page>
      <div className="page-head">
        <div>
          <div className="crumb"><span>{tt("الرئيسية")}</span><I.Chevron size={11}/><span>{tt("التقارير")}</span></div>
          <h1 className="h1">{tt("التقارير")}</h1>
          <div className="muted" style={{fontSize:13.5,marginTop:4}}>{tt("تحليلات مالية وطبية وتشغيلية — بيانات مباشرة من قاعدة البيانات.")}</div>
          {window.SB && (
            <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap",marginTop:8}}>
              <div className="report-branch" data-scope={view.scope}>
                <span className="pill"><I.MapPin size={12}/> {view.label}</span>
                {!canPick && <span className="muted" style={{fontSize:12,marginInlineStart:8}}>{tt("بدّل الفرع من القائمة الجانبية لعرض تقاريره.")}</span>}
              </div>
              {canPick && (
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <Segmented className="report-scope" label={tt("نطاق التقرير")} value={view.scope} onChange={setScopeChoice} options={[
                    { value: "current", label: tt("الفرع الحالي") },
                    { value: "all", label: tt("كل الفروع") },
                  ]}/>
                  {view.loading && <span className="spin" role="status" aria-label={tt("جارٍ تحميل بيانات الفروع")} style={{width:14,height:14,border:"2px solid var(--blue-500)",borderTopColor:"transparent",borderRadius:"50%"}}/>}
                </div>
              )}
            </div>
          )}
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
          {view.error && (
            <CaAlert tone="error">{view.error} <button type="button" className="btn btn-ghost" style={{fontSize:12,padding:"2px 8px",marginInlineStart:6}} onClick={view.retry}>{tt("إعادة المحاولة")}</button></CaAlert>
          )}
          {view.waiting && !view.error && (
            <div className="card card-pad" aria-busy="true"><div className="muted" style={{fontSize:13,marginBottom:10}}>{tt("جارٍ تحميل بيانات الفروع…")}</div><SkeletonRow count={4}/></div>
          )}
          {/* Hidden, not unmounted, until the branches' rows arrive: the
              tab keeps its filters. */}
          <div style={view.waiting ? {display:"none"} : undefined}>
            {section==="financial" && <FinancialReport view={view}/>}
            {section==="medical" && <MedicalReport view={view}/>}
            {section==="operational" && <OperationalReport view={view}/>}
          </div>
        </div>
      </div>
    </Page>
  );
}

// ── Financial report (payments / invoices) ────────────────────
function FinancialReport({ view }) {
  window.useDataVersion && window.useDataVersion();
  const { f, set, page, setPage } = useReportState();
  const opts = useReportOpts();
  const show = { therapist: false, doctor: false, patient: true };

  // Row-level financial data — one row per invoice, straight from the
  // hydrated payments table (or every branch's, view.all). No mock values.
  const base = view.rowsOf("payments");
  const rows = React.useMemo(() => base.map(v => {
    const amount = Number(v.amount) || 0, paid = Number(v.paid) || 0;
    return {
      id: v.id || v.invoice_id,
      branch_id: v.branch_id || null,
      branch: reportBranchName(v.branch_id),
      date: String(v.date || v.created_at || "").slice(0, 10),
      patient: v.patient || "—",
      patient_id: v.patient_id || null,
      // Shown, searched and exported as text in the interface language.
      method: payMethodLabel(v.method) || "—",
      amount, paid, outstanding: Math.max(0, amount - paid),
      status: v.status ? tt(v.status) : "—",
    };
  }), [base]);

  const q = f.q.trim().toLowerCase();
  const filtered = React.useMemo(() => rows.filter(r =>
    reportInRange(r.date, f.from, f.to) &&
    (f.patient === "all" || r.patient_id === f.patient) &&
    (!q || [r.patient, r.method, r.id, r.status, view.all ? r.branch : ""].some(x => String(x || "").toLowerCase().includes(q)))
  ).sort((a, b) => String(b.date).localeCompare(String(a.date))), [rows, f.from, f.to, f.patient, q]);

  const collected = filtered.reduce((s, r) => s + r.paid, 0);
  const invoiced = filtered.reduce((s, r) => s + r.amount, 0);
  const outstanding = filtered.reduce((s, r) => s + r.outstanding, 0);
  const avg = filtered.length ? invoiced / filtered.length : 0;

  // Monthly collected trend + payment-method split from the filtered set.
  const byMonth = {};
  filtered.forEach(r => { if (r.date) byMonth[r.date.slice(0, 7)] = (byMonth[r.date.slice(0, 7)] || 0) + r.paid; });
  const monthly = Object.keys(byMonth).sort().slice(-6).map(m => ({ label: m.slice(2), v: Math.round(byMonth[m]) }));
  const byMethod = {};
  filtered.forEach(r => { byMethod[r.method] = (byMethod[r.method] || 0) + r.paid; });
  const methodColors = ["#7BBDE8", "#7E6BD3", "#3FA984", "#D49044", "#3A7FB5", "#BDD8E9"];
  const methodData = Object.keys(byMethod).map((m, i) => ({ label: m, v: Math.round(byMethod[m]), color: methodColors[i % methodColors.length] })).filter(d => d.v > 0);

  const columns = [
    { key: "date", label: tt("التاريخ"), type: "date", width: 12 },
    ...(view.all ? [reportBranchColumn] : []),
    { key: "patient", label: tt("المريض"), type: "text", width: 20 },
    { key: "method", label: tt("طريقة الدفع"), type: "text", width: 14 },
    { key: "amount", label: tt("المبلغ"), type: "currency", total: true, width: 14 },
    { key: "paid", label: tt("المدفوع"), type: "currency", total: true, width: 14 },
    { key: "outstanding", label: tt("المتبقي"), type: "currency", total: true, width: 14 },
    { key: "status", label: tt("الحالة"), type: "text", width: 12 },
  ];
  async function doExport() {
    const ok = await exportReportExcel({
      filename: tt("تقرير-مالي-{date}.xlsx", { date: reportToday() }), sheetName: tt("التقرير المالي"),
      title: tt("التقرير المالي"), filters: reportActiveFilters(f, show, opts, view.label), columns, rows: filtered,
    });
    if (ok && window.showToast) window.showToast(tt("تم تصدير {n} صفًا إلى Excel", { n: filtered.length }), "success");
  }

  return (
    <div>
      <ReportFilterBar f={f} set={set} opts={opts} show={show} onExport={doExport} searchPlaceholder={tt("بحث بالمريض أو طريقة الدفع…")} />

      <div className="grid-4" style={{ marginBottom: 18 }}>
        <StatCard label={tt("محصّل")} value={fmtMoneyShort(collected)} accent="#3FA984" icon={<I.Check size={15} />} />
        <StatCard label={tt("إجمالي مفوتر")} value={fmtMoneyShort(invoiced)} accent="#3A7FB5" icon={<I.Dollar size={15} />} />
        <StatCard label={tt("متبقٍ")} value={fmtMoneyShort(outstanding)} accent="#D49044" icon={<I.Clock size={15} />} />
        <StatCard label={tt("عدد الفواتير")} value={fmtNumber(filtered.length)} accent="#7BBDE8" icon={<I.Chart size={15} />} />
      </div>

      {view.all && <ReportBranchBreakdown rows={filtered} metrics={[
        { key: "count", label: tt("عدد الفواتير"), calc: l => l.length, fmt: reportFmtCount },
        { key: "invoiced", label: tt("إجمالي مفوتر"), calc: l => l.reduce((s, r) => s + r.amount, 0), fmt: reportFmtMoney },
        { key: "collected", label: tt("محصّل"), calc: l => l.reduce((s, r) => s + r.paid, 0), fmt: reportFmtMoney },
        { key: "outstanding", label: tt("متبقٍ"), calc: l => l.reduce((s, r) => s + r.outstanding, 0), fmt: reportFmtMoney },
      ]}/>}

      <div className="rgrid c-lg" style={{ "--gtc": "1.5fr 1fr", marginBottom: 18 }}>
        <div className="card card-pad">
          <div className="h2" style={{ marginBottom: 14 }}>{tt("اتجاه المبالغ المحصّلة (شهريًا)")}</div>
          {monthly.length ? <AreaChart data={monthly} height={240} formatY={v => v >= 1000 ? `${Number((v / 1000).toFixed(1))}K` : v} /> : <div className="muted" style={{ fontSize: 13, padding: "40px 0", textAlign: "center" }}>{tt("لا بيانات ضمن الفترة المحددة.")}</div>}
        </div>
        <div className="card card-pad">
          <div className="h2" style={{ marginBottom: 14 }}>{tt("توزيع طرق الدفع")}</div>
          {methodData.length ? <DonutChart data={methodData} size={180} centerLabel={tt("محصّل")} centerValue={fmtMoneyShort(collected)} /> : <div className="muted" style={{ fontSize: 13, padding: "40px 0", textAlign: "center" }}>{tt("لا بيانات.")}</div>}
        </div>
      </div>

      <ReportTable columns={columns} rows={filtered} page={page} setPage={setPage} empty={tt("لا فواتير ضمن عوامل التصفية الحالية.")} />
    </div>
  );
}

// ── Medical report (treatment sessions / patients) ────────────
function MedicalReport({ view }) {
  window.useDataVersion && window.useDataVersion();
  const { f, set, page, setPage } = useReportState();
  const opts = useReportOpts();
  const show = { therapist: true, doctor: true, patient: true };

  // Patient lookup so each session can surface its diagnosis + doctor.
  const patientById = React.useMemo(() => {
    const m = {}; (DATA.patients || []).forEach(p => { m[p.id || p.patient_id] = p; }); return m;
  }, [DATA.patients]);

  // One row per treatment session, from the hydrated sessions table (or
  // every branch's, view.all).
  const base = view.rowsOf("sessions");
  const rows = React.useMemo(() => base.map(s => {
    const p = patientById[s.patient_id] || {};
    return {
      id: s.id || s.session_id,
      branch_id: s.branch_id || null,
      branch: reportBranchName(s.branch_id),
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
  }), [base, patientById]);

  const q = f.q.trim().toLowerCase();
  const filtered = React.useMemo(() => rows.filter(r =>
    reportInRange(r.date, f.from, f.to) &&
    (f.therapist === "all" || r.therapist === f.therapist) &&
    (f.doctor === "all" || r.doctor === f.doctor) &&
    (f.patient === "all" || r.patient_id === f.patient) &&
    (!q || [r.patient, r.therapist, r.doctor, r.diagnosis, r.notes, view.all ? r.branch : ""].some(x => String(x || "").toLowerCase().includes(q)))
  ).sort((a, b) => String(b.date).localeCompare(String(a.date))), [rows, f.from, f.to, f.therapist, f.doctor, f.patient, q]);

  const distinctPatients = new Set(filtered.map(r => r.patient_id).filter(Boolean)).size;
  const totalSessions = filtered.length;
  const avgPain = filtered.length ? (filtered.reduce((s, r) => s + (Number(r.pain) || 0), 0) / filtered.length).toFixed(1) : "0";
  const avgPer = distinctPatients ? (totalSessions / distinctPatients).toFixed(1) : "0";

  // Diagnosis mix (from the patients touched in the filtered sessions).
  const buckets = [
    { label: tt("أسفل الظهر / القطنية"), re: /ظهر|قطن|غضروف|نسا/, color: "#7BBDE8" },
    { label: tt("الركبة"), re: /ركبة|رباط|رضف/, color: "#3A7FB5" },
    { label: tt("الكتف"), re: /كتف/, color: "#7E6BD3" },
    { label: tt("الرقبة / العنقية"), re: /رقبة|عنق/, color: "#3FA984" },
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
  if (other > 0) diagData.push({ label: tt("أخرى"), v: other, color: "#BDD8E9" });

  // Cohort pain trend: average pain per session number across filtered rows.
  const byNum = {};
  filtered.forEach(s => { const n = s.session; if (!n) return; (byNum[n] = byNum[n] || []).push(Number(s.pain) || 0); });
  const cohort = Object.keys(byNum).map(Number).sort((a, b) => a - b).slice(0, 12)
    .map(n => ({ label: tt("ج{n}", { n }), v: byNum[n].reduce((s, v) => s + v, 0) / byNum[n].length }));

  const columns = [
    { key: "date", label: tt("التاريخ"), type: "date", width: 12 },
    ...(view.all ? [reportBranchColumn] : []),
    { key: "patient", label: tt("المريض"), type: "text", width: 20 },
    { key: "therapist", label: tt("الأخصائي"), type: "text", width: 18 },
    { key: "doctor", label: tt("الطبيب"), type: "text", width: 16 },
    { key: "session", label: tt("رقم الجلسة"), type: "number", width: 10 },
    { key: "pain", label: tt("مستوى الألم"), type: "number", width: 10 },
    { key: "notes", label: tt("ملاحظات"), type: "text", width: 30 },
  ];
  async function doExport() {
    const ok = await exportReportExcel({
      filename: tt("تقرير-طبي-{date}.xlsx", { date: reportToday() }), sheetName: tt("التقرير الطبي"),
      title: tt("التقرير الطبي"), filters: reportActiveFilters(f, show, opts, view.label), columns, rows: filtered,
    });
    if (ok && window.showToast) window.showToast(tt("تم تصدير {n} صفًا إلى Excel", { n: filtered.length }), "success");
  }

  return (
    <div>
      <ReportFilterBar f={f} set={set} opts={opts} show={show} onExport={doExport} searchPlaceholder={tt("بحث بالمريض أو التشخيص…")} />

      <div className="grid-4" style={{ marginBottom: 18 }}>
        <StatCard label={tt("مرضى تحت العلاج")} value={String(distinctPatients)} accent="#7BBDE8" icon={<I.Users size={15} />} />
        <StatCard label={tt("عدد الجلسات")} value={fmtNumber(totalSessions)} accent="#3A7FB5" icon={<I.Activity size={15} />} />
        <StatCard label={tt("متوسط الجلسات لكل مريض")} value={avgPer} accent="#7E6BD3" icon={<I.Chart size={15} />} />
        <StatCard label={tt("متوسط مستوى الألم")} value={avgPain} accent="#D49044" icon={<I.Heart size={15} />} />
      </div>

      {view.all && <ReportBranchBreakdown rows={filtered} metrics={[
        { key: "sessions", label: tt("عدد الجلسات"), calc: l => l.length, fmt: reportFmtCount },
        { key: "patients", label: tt("مرضى تحت العلاج"), calc: l => new Set(l.map(r => r.patient_id).filter(Boolean)).size, fmt: reportFmtCount },
      ]}/>}

      <div className="rgrid c-lg" style={{ "--gtc": "1fr 1fr", marginBottom: 18 }}>
        <div className="card card-pad">
          <div className="h2" style={{ marginBottom: 18 }}>{tt("توزيع التشخيصات")}</div>
          {diagData.length ? <DonutChart data={diagData} size={180} centerLabel={tt("مريض")} centerValue={String(distinctPatients)} /> : <div className="muted" style={{ fontSize: 13, padding: "40px 0", textAlign: "center" }}>{tt("لا بيانات ضمن الفترة المحددة.")}</div>}
        </div>
        <div className="card card-pad">
          <div className="h2" style={{ marginBottom: 6 }}>{tt("تقدّم العلاج · متوسط الألم")}</div>
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 14 }}>{tt("متوسط مستوى الألم حسب رقم الجلسة")}</div>
          {cohort.length ? <AreaChart data={cohort} height={200} color="#3FA984" fill="rgba(63,169,132,.16)" formatY={v => Number(v).toFixed(1)} /> : <div className="muted" style={{ fontSize: 13, padding: "40px 0", textAlign: "center" }}>{tt("لا جلسات ضمن الفترة المحددة.")}</div>}
        </div>
      </div>

      <ReportTable columns={columns} rows={filtered} page={page} setPage={setPage} empty={tt("لا جلسات ضمن عوامل التصفية الحالية.")} />
    </div>
  );
}

// ── Operational report (appointments / attendance / rooms) ────
function OperationalReport({ view }) {
  window.useDataVersion && window.useDataVersion();
  const { f, set, page, setPage } = useReportState();
  const opts = useReportOpts();
  const show = { therapist: true, doctor: true, patient: true };

  // One row per booked appointment, from the hydrated appts table (or
  // every branch's, view.all).
  const base = view.rowsOf("appts");
  const rows = React.useMemo(() => base
    .filter(a => a.status !== "متاح")
    .map(a => ({
      id: a.id || a.booking_id,
      branch_id: a.branch_id || null,
      branch: reportBranchName(a.branch_id),
      date: String(a.date || "").slice(0, 10),
      time: a.time || "—",
      patient: a.patient || "—",
      patient_id: a.pid || a.patient_id || null,
      therapist: a.th || "—",
      doctor: a.dr || "—",
      room: a.room || "—",
      type: reportApptType(a.type),
      status: a.status || "—",                     // stored value, compared below
      status_text: a.status ? tt(a.status) : "—",   // shown, searched and exported
    })), [base]);

  const q = f.q.trim().toLowerCase();
  const filtered = React.useMemo(() => rows.filter(r =>
    reportInRange(r.date, f.from, f.to) &&
    (f.therapist === "all" || r.therapist === f.therapist) &&
    (f.doctor === "all" || r.doctor === f.doctor) &&
    (f.patient === "all" || r.patient_id === f.patient) &&
    (!q || [r.patient, r.therapist, r.doctor, r.room, r.type, r.status, r.status_text, view.all ? r.branch : ""].some(x => String(x || "").toLowerCase().includes(q)))
  ).sort((a, b) => (String(b.date) + b.time).localeCompare(String(a.date) + a.time)), [rows, f.from, f.to, f.therapist, f.doctor, f.patient, q]);

  const booked = filtered.length;
  const completed = filtered.filter(a => a.status === "مكتمل").length;
  const noShow = filtered.filter(a => a.status === "لم يحضر").length;
  const attended = filtered.filter(a => a.status === "مكتمل" || a.status === "قيد التنفيذ").length;
  const attendRate = booked ? Math.round(attended / booked * 100) : 0;
  const noShowRate = booked ? (noShow / booked * 100).toFixed(1) : "0";
  const completedRate = booked ? Math.round(completed / booked * 100) : 0;

  const wd = weekdayNames(IS_RTL ? "long" : "short");
  const byDay = wd.map(l => ({ label: l, v: 0, color: "#7BBDE8" }));
  filtered.forEach(a => { if (a.date) { const d = new Date(a.date); if (!isNaN(d)) byDay[d.getDay()].v += 1; } });
  const byHourMap = {};
  filtered.forEach(a => { const h = parseInt(String(a.time || "").split(":")[0], 10); if (Number.isFinite(h)) byHourMap[h] = (byHourMap[h] || 0) + 1; });
  const byHour = Object.keys(byHourMap).map(Number).sort((a, b) => a - b).map(h => ({ label: `${h}:00`, v: byHourMap[h] }));

  const columns = [
    { key: "date", label: tt("التاريخ"), type: "date", width: 12 },
    { key: "time", label: tt("الوقت"), type: "text", width: 8 },
    ...(view.all ? [reportBranchColumn] : []),
    { key: "patient", label: tt("المريض"), type: "text", width: 20 },
    { key: "therapist", label: tt("الأخصائي"), type: "text", width: 18 },
    { key: "doctor", label: tt("الطبيب"), type: "text", width: 16 },
    { key: "room", label: tt("الغرفة"), type: "text", width: 10 },
    { key: "type", label: tt("النوع"), type: "text", width: 14 },
    { key: "status_text", label: tt("الحالة"), type: "text", width: 12 },
  ];
  async function doExport() {
    const ok = await exportReportExcel({
      filename: tt("تقرير-تشغيلي-{date}.xlsx", { date: reportToday() }), sheetName: tt("التقرير التشغيلي"),
      title: tt("التقرير التشغيلي"), filters: reportActiveFilters(f, show, opts, view.label), columns, rows: filtered,
    });
    if (ok && window.showToast) window.showToast(tt("تم تصدير {n} صفًا إلى Excel", { n: filtered.length }), "success");
  }

  return (
    <div>
      <ReportFilterBar f={f} set={set} opts={opts} show={show} onExport={doExport} searchPlaceholder={tt("بحث بالمريض أو الغرفة…")} />

      <div className="grid-4" style={{ marginBottom: 18 }}>
        <StatCard label={tt("مواعيد مسجلة")} value={fmtNumber(booked)} accent="#7BBDE8" icon={<I.Calendar size={15} />} />
        <StatCard label={tt("معدّل الحضور")} value={`${attendRate}%`} accent="#3FA984" icon={<I.Check size={15} />} />
        <StatCard label={tt("معدل عدم الحضور")} value={`${noShowRate}%`} accent="#D49044" icon={<I.X size={15} />} />
        <StatCard label={tt("نسبة الإكمال")} value={`${completedRate}%`} accent="#7E6BD3" icon={<I.Activity size={15} />} />
      </div>

      {view.all && <ReportBranchBreakdown rows={filtered} metrics={[
        { key: "booked", label: tt("مواعيد مسجلة"), calc: l => l.length, fmt: reportFmtCount },
        { key: "completed", label: tt("مكتملة"), calc: l => l.filter(a => a.status === "مكتمل").length, fmt: reportFmtCount },
        { key: "noshow", label: tt("لم يحضر"), calc: l => l.filter(a => a.status === "لم يحضر").length, fmt: reportFmtCount },
        { key: "attend", label: tt("معدّل الحضور"), calc: l => l.length ? Math.round(l.filter(a => a.status === "مكتمل" || a.status === "قيد التنفيذ").length / l.length * 100) : 0, fmt: v => `${v}%` },
      ]}/>}

      <div className="rgrid c-lg" style={{ "--gtc": "1fr 1fr", marginBottom: 18 }}>
        <div className="card card-pad">
          <div className="h2" style={{ marginBottom: 14 }}>{tt("المواعيد حسب يوم الأسبوع")}</div>
          {byDay.some(d => d.v > 0) ? <BarChart data={byDay} height={220} /> : <div className="muted" style={{ fontSize: 13, padding: "40px 0", textAlign: "center" }}>{tt("لا مواعيد ضمن الفترة المحددة.")}</div>}
        </div>
        <div className="card card-pad">
          <div className="h2" style={{ marginBottom: 14 }}>{tt("المواعيد حسب الساعة")}</div>
          {byHour.length ? <AreaChart data={byHour} height={220} /> : <div className="muted" style={{ fontSize: 13, padding: "40px 0", textAlign: "center" }}>{tt("لا مواعيد ضمن الفترة المحددة.")}</div>}
        </div>
      </div>

      <ReportTable columns={columns} rows={filtered} page={page} setPage={setPage} empty={tt("لا مواعيد ضمن عوامل التصفية الحالية.")} />
    </div>
  );
}
