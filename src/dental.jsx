// ══════════════════════════════════════════════════════════════
// The dental patient file (owner's reference picture, 26 Oct 2026;
// 0018_clinical_records dental_findings): header with the medical alerts,
// «ملاحظة زيارة جديدة» · «وصفة جديدة» · «حجز موعد», and the tabs
// Overview · Tooth chart · Treatment · Billing · Visit notes · Prescriptions
// · Appointments.
//
// The tooth chart is FDI (adult 11–48, child 51–85), seen as facing the
// patient: the patient's right on the left of the screen, never mirrored in
// RTL. A tooth's state comes from its findings (one row per event): the
// latest row of each condition counts; history = all rows of the tooth.
// ══════════════════════════════════════════════════════════════

// group: attention (needs attention) · restoration · removal · missing
const DENTAL_CONDITIONS = [
  { code: "caries",     short: "C",   group: "attention" },
  { code: "fracture",   short: "Fx",  group: "attention" },
  { code: "watch",      short: "W",   group: "attention" },
  { code: "filling",    short: "F",   group: "restoration" },
  { code: "crown",      short: "Cr",  group: "restoration" },
  { code: "root_canal", short: "RCT", group: "restoration" },
  { code: "implant",    short: "Imp", group: "restoration" },
  { code: "veneer",     short: "V",   group: "restoration" },
  { code: "bridge",     short: "Br",  group: "restoration" },
  { code: "sealant",    short: "S",   group: "restoration" },
  { code: "extraction", short: "Ext", group: "removal" },
  { code: "missing",    short: "M",   group: "missing" },
];
const DENTAL_CONDITION_LABELS = {
  caries: "تسوس", fracture: "كسر", watch: "مراقبة", filling: "حشوة", crown: "تاج", root_canal: "علاج عصب",
  implant: "زرعة", veneer: "قشرة", bridge: "جسر", sealant: "سد الشقوق", extraction: "خلع", missing: "مفقود",
};
const DENTAL_STATUS_LABELS = { existing: "موجود", planned: "مخطط", done: "تم" };
const DENTAL_SURFACE_LABELS = { M: "إنسي", O: "إطباقي", D: "وحشي", B: "شدقي", L: "لساني" };
const DENTAL_CATEGORY_LABELS = { attention: "يحتاج انتباهًا", planned: "علاج مخطط", restored: "مُرمَّم", missing: "مفقود" };
const conditionOf = (code) => DENTAL_CONDITIONS.find(c => c.code === code) || { code, short: code, group: "restoration" };

// FDI rows as seen facing the patient (the patient's right first).
const DENTAL_LAYOUT = {
  adult: { upper: [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28],
           lower: [48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38] },
  child: { upper: [55, 54, 53, 52, 51, 61, 62, 63, 64, 65],
           lower: [85, 84, 83, 82, 81, 71, 72, 73, 74, 75] },
};

const findingTime = (f) => `${f.recorded_on || ""} ${f.created_at || ""}`;

// The latest finding of each condition of one tooth, then the tooth's
// category: missing → needs attention → planned → restored → none.
// A finding that needs attention (caries, fracture, watch) is resolved when
// marked done or when a treatment is recorded after it (not just planned).
function toothState(findings) {
  const sorted = findings.slice().sort((a, b) => findingTime(b).localeCompare(findingTime(a)));
  const latest = new Map();
  for (const f of sorted) if (!latest.has(f.condition)) latest.set(f.condition, f);
  const treatedAfter = (f) => sorted.some(g => findingTime(g) > findingTime(f)
    && g.status !== "planned" && conditionOf(g.condition).group !== "attention");
  const resolved = (f) => conditionOf(f.condition).group === "attention" && (f.status === "done" || treatedAfter(f));
  const current = [...latest.values()].filter(f => !resolved(f));
  const has = (pred) => current.some(pred);
  let category = null;
  if (has(f => f.condition === "missing" && f.status !== "planned") || has(f => f.condition === "extraction" && f.status === "done")) category = "missing";
  else if (has(f => conditionOf(f.condition).group === "attention" && f.status === "existing")) category = "attention";
  else if (has(f => f.status === "planned")) category = "planned";
  else if (has(f => f.status !== "planned" && conditionOf(f.condition).group === "restoration")) category = "restored";
  // Shown on the tooth: what is there or done first, then what is planned.
  const order = DENTAL_CONDITIONS.map(c => c.code);
  const shown = current.slice()
    .sort((a, b) => (a.status === "planned") - (b.status === "planned") || order.indexOf(a.condition) - order.indexOf(b.condition));
  return { category, current: shown, label: shown.map(f => conditionOf(f.condition).short).join(" ") };
}

// Every tooth's findings → { [tooth]: toothState }.
function chartOf(findings) {
  const byTooth = new Map();
  for (const f of findings) {
    if (!byTooth.has(f.tooth)) byTooth.set(f.tooth, []);
    byTooth.get(f.tooth).push(f);
  }
  const out = {};
  for (const [tooth, list] of byTooth) out[tooth] = toothState(list);
  return out;
}

const TOOTH_STYLE = {
  attention: { border: "#E9A99F", background: "#FDF1EE" },
  planned:   { border: "#D49044", background: "#FDF3E3" },
  restored:  { border: "#3A7FB5", background: "#EEF5FB" },
  missing:   { border: "var(--ink-200)", background: "var(--ink-100)" },
  none:      { border: "var(--ink-200)", background: "#fff" },
};

function toothAria(tooth, st) {
  const parts = (st ? st.current : []).map(f => `${tt(DENTAL_CONDITION_LABELS[f.condition] || f.condition)} (${tt(DENTAL_STATUS_LABELS[f.status])})`);
  return parts.length ? tt("السن {n}: {list}", { n: tooth, list: parts.join(IS_RTL ? "، " : ", ") }) : tt("السن {n}", { n: tooth });
}

function ToothButton({ tooth, st, selected, onSelect }) {
  const cat = (st && st.category) || "none";
  const look = TOOTH_STYLE[cat];
  return (
    <button type="button" data-tooth={tooth} data-category={cat} aria-pressed={selected ? "true" : "false"}
      aria-label={toothAria(tooth, st)} onClick={() => onSelect(tooth)}
      style={{
        minWidth: 44, height: 58, padding: "6px 2px", borderRadius: 10, cursor: "pointer",
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-start", gap: 4,
        border: selected ? "2.5px solid var(--ink-900)" : `1.5px solid ${look.border}`,
        background: look.background, color: "var(--ink-900)", flex: "1 1 0",
      }}>
      <span className="mono" style={{fontSize:13,fontWeight:600,textDecoration: cat === "missing" ? "line-through" : "none",color: cat === "missing" ? "var(--ink-500)" : undefined}}>{tooth}</span>
      <span style={{fontSize:10.5,color:"var(--ink-700)",whiteSpace:"nowrap",overflow:"hidden",maxWidth:"100%"}}>{st ? st.label : ""}</span>
    </button>
  );
}

function ToothChart({ chart, dentition, selected, onSelect }) {
  const rows = DENTAL_LAYOUT[dentition];
  const half = rows.upper.length / 2;
  const row = (teeth) => (
    <div style={{display:"flex",gap:5}}>
      {teeth.map((t, i) => (
        <React.Fragment key={t}>
          {i === half && <span aria-hidden="true" style={{width:6,flexShrink:0}}/>}
          <ToothButton tooth={t} st={chart[t]} selected={selected === t} onSelect={onSelect}/>
        </React.Fragment>
      ))}
    </div>
  );
  return (
    // Anatomical orientation: the same in Arabic and English.
    <div dir="ltr" data-tooth-chart={dentition} style={{border:"1px solid var(--ink-200)",borderRadius:14,padding:"10px 12px",background:"var(--ink-50)",overflowX:"auto"}}>
      <div style={{minWidth: dentition === "adult" ? 760 : 500}}>
        <div style={{display:"flex",justifyContent:"space-between",fontSize:11.5,color:"var(--ink-500)",marginBottom:6}}>
          <span>{tt("يمين المريض")}</span><span>{tt("الفك العلوي")}</span><span>{tt("يسار المريض")}</span>
        </div>
        {row(rows.upper)}
        <div style={{height:10}}/>
        {row(rows.lower)}
        <div style={{textAlign:"center",fontSize:11.5,color:"var(--ink-500)",marginTop:6}}>{tt("الفك السفلي")}</div>
      </div>
    </div>
  );
}

function ChartLegend() {
  return (
    <div style={{display:"flex",gap:16,flexWrap:"wrap",fontSize:12,color:"var(--ink-500)",margin:"12px 2px"}}>
      {["attention", "planned", "restored", "missing"].map(k => (
        <span key={k} style={{display:"inline-flex",alignItems:"center",gap:6}}>
          <span aria-hidden="true" style={{width:12,height:12,borderRadius:3,border:`1.5px solid ${TOOTH_STYLE[k].border}`,background:TOOTH_STYLE[k].background}}/>
          {tt(DENTAL_CATEGORY_LABELS[k])}
        </span>
      ))}
    </div>
  );
}

// The surfaces of a tooth: B on top, M · O · D in the middle, L below.
function SurfacePicker({ value, onChange }) {
  const cell = (s) => (
    <button key={s} type="button" aria-pressed={value.includes(s) ? "true" : "false"} data-surface={s}
      aria-label={tt("السطح {s} — {name}", { s, name: tt(DENTAL_SURFACE_LABELS[s]) })}
      onClick={() => onChange(value.includes(s) ? value.filter(x => x !== s) : [...value, s])}
      style={{width:44,height:44,border:"1px solid var(--ink-300)",cursor:"pointer",fontWeight:600,fontSize:13,
        background: value.includes(s) ? "var(--blue-500)" : "#fff", color: value.includes(s) ? "#fff" : "var(--ink-700)"}}>{s}</button>
  );
  return (
    <div dir="ltr" role="group" aria-label={tt("الأسطح")} style={{display:"grid",gridTemplateColumns:"44px 44px 44px",gridTemplateRows:"44px 44px 44px",gap:2}}>
      <span/>{cell("B")}<span/>
      {cell("M")}{cell("O")}{cell("D")}
      <span/>{cell("L")}<span/>
    </div>
  );
}

function ToothPanel({ tooth, patientId, findings, onSaved }) {
  const [surfaces, setSurfaces] = React.useState([]);
  const [status, setStatus] = React.useState("existing");
  const [notes, setNotes] = React.useState("");
  const [busy, setBusy] = React.useState("");
  React.useEffect(() => { setSurfaces([]); setNotes(""); }, [tooth]);
  async function add(condition) {
    if (busy) return;
    setBusy(condition);
    try {
      await ClinicalAPI.save("dental_findings", {
        patient_id: patientId, tooth, surfaces, condition, status, notes: notes.trim() || null,
      });
      window.showToast && window.showToast(tt("تم الحفظ: السن {n} — {c} ({s})", {
        n: tooth, c: tt(DENTAL_CONDITION_LABELS[condition]), s: tt(DENTAL_STATUS_LABELS[status]) }), "success");
      setSurfaces([]); setNotes("");
      onSaved && onSaved();
    } catch (e) {
      window.showToast && window.showToast(e.message || tt("تعذّر الحفظ"), "error");
    } finally { setBusy(""); }
  }
  function dictate() {
    if (!window.startDictation) return;
    window.startDictation({ onText: (text) => setNotes(n => (n ? n + " " : "") + text) });
  }
  return (
    <div className="card" style={{padding:18}} data-tooth-panel={tooth}>
      <h3 className="h3" style={{margin:"0 0 12px"}}>{tt("السن {n}", { n: tooth })}</h3>
      <div style={{display:"flex",gap:18,flexWrap:"wrap",alignItems:"flex-start"}}>
        <SurfacePicker value={surfaces} onChange={setSurfaces}/>
        <div style={{flex:1,minWidth:220}}>
          <div className="label" style={{marginBottom:6}}>{tt("الحالة")}</div>
          <Segmented label={tt("الحالة")} value={status} onChange={setStatus}
            options={["existing", "planned", "done"].map(v => ({ value: v, label: tt(DENTAL_STATUS_LABELS[v]) }))}/>
          <div className="muted" style={{fontSize:12,marginTop:8}}>{tt("حدد الأسطح إن لزم، ثم اضغط حالة لحفظها.")}</div>
        </div>
      </div>
      <div style={{display:"flex",flexWrap:"wrap",gap:6,marginTop:14}} role="group" aria-label={tt("الحالات")}>
        {DENTAL_CONDITIONS.map(c => (
          <button key={c.code} type="button" className="btn btn-secondary" data-condition={c.code} disabled={!!busy}
            aria-busy={busy === c.code ? "true" : undefined} onClick={() => add(c.code)} style={{fontSize:12.5}}>
            <b className="mono" style={{fontSize:11}}>{c.short}</b> {tt(DENTAL_CONDITION_LABELS[c.code])}
          </button>
        ))}
      </div>
      <div style={{display:"flex",gap:8,marginTop:12,alignItems:"flex-end"}}>
        <label style={{display:"flex",flexDirection:"column",gap:4,flex:1}}>
          <span className="label">{tt("ملاحظة على السن (اختياري)")}</span>
          <input className="input" value={notes} maxLength={1000} onChange={e => setNotes(e.target.value)}/>
        </label>
        {window.startDictation && <button type="button" className="btn btn-ghost btn-icon" aria-label={tt("إملاء الملاحظة")} onClick={dictate}><I.Mic size={15}/></button>}
      </div>
    </div>
  );
}

function ToothHistory({ tooth, findings, patientId }) {
  const list = findings.filter(f => f.tooth === tooth).sort((a, b) => findingTime(b).localeCompare(findingTime(a)));
  async function markDone(f) {
    try {
      await ClinicalAPI.save("dental_findings", { patient_id: patientId, tooth: f.tooth, surfaces: f.surfaces || [], condition: f.condition, status: "done", notes: f.notes || null });
      window.showToast && window.showToast(tt("تم تسجيل الإنجاز"), "success");
    } catch (e) { window.showToast && window.showToast(e.message || tt("تعذّر الحفظ"), "error"); }
  }
  async function remove(f) {
    if (!window.confirm(tt("حذف هذا السطر من تاريخ السن؟"))) return;
    try { await ClinicalAPI.remove("dental_findings", f.finding_id, patientId); }
    catch (e) { window.showToast && window.showToast(e.message, "error"); }
  }
  return (
    <div className="card" style={{padding:18}} data-tooth-history={tooth}>
      <h3 className="h3" style={{margin:"0 0 10px"}}>{tt("التاريخ")}</h3>
      {!list.length && <div className="muted" style={{fontSize:13}}>{tt("لا شيء مسجل لهذا السن بعد.")}</div>}
      {list.map((f, i) => {
        const planned = f.status === "planned";
        const doneLater = planned && list.slice(0, i).some(g => g.condition === f.condition && g.status === "done");
        return (
          <div key={f.finding_id} data-finding={f.finding_id} style={{padding:"10px 0",borderBottom: i < list.length - 1 ? "1px solid var(--ink-100)" : "none"}}>
            <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
              <b style={{fontSize:13.5}}>{tt(DENTAL_CONDITION_LABELS[f.condition] || f.condition)}</b>
              <span className={"badge " + (f.status === "planned" ? "b-amber" : f.status === "done" ? "b-green" : "b-blue")}>{tt(DENTAL_STATUS_LABELS[f.status])}</span>
              {(f.surfaces || []).length > 0 && <span className="mono muted" style={{fontSize:11.5}}>{f.surfaces.join("")}</span>}
              <span style={{flex:1}}/>
              {planned && !doneLater && <button type="button" className="btn btn-ghost" style={{fontSize:12}} onClick={() => markDone(f)}><I.Check size={12}/> {tt("تم")}</button>}
              <button type="button" className="btn btn-ghost btn-icon" aria-label={tt("حذف")} onClick={() => remove(f)}><I.Trash size={12}/></button>
            </div>
            <div className="muted" style={{fontSize:12,marginTop:2}}>{clinicalByline(f.recorded_on, f.author_name)}</div>
            {f.notes && <div style={{fontSize:12.5,marginTop:4}}>{f.notes}</div>}
          </div>
        );
      })}
    </div>
  );
}

// «مخطط الأسنان»: chart + legend, then the selected tooth's panel and history.
function ToothChartTab({ p, findings }) {
  const pid = p.patient_id || p.id;
  const childish = p.age && Number(p.age) < 12;
  const [dentition, setDentition] = React.useState(childish ? "child" : "adult");
  const [selected, setSelected] = React.useState(null);
  const chart = React.useMemo(() => chartOf(findings), [findings]);
  return (
    <div data-tab="chart">
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,marginBottom:12,flexWrap:"wrap"}}>
        <h2 className="h3" style={{margin:0}}>{tt("مخطط الأسنان")}</h2>
        <Segmented label={tt("الأسنان")} value={dentition} onChange={(v) => { setDentition(v); setSelected(null); }}
          options={[{ value: "adult", label: tt("بالغ") }, { value: "child", label: tt("طفل") }]}/>
      </div>
      <ToothChart chart={chart} dentition={dentition} selected={selected} onSelect={setSelected}/>
      <ChartLegend/>
      {selected
        ? (
          <div className="rgrid c-md" style={{"--gtc":"minmax(0,1.3fr) minmax(0,1fr)",gap:16}}>
            <ToothPanel tooth={selected} patientId={pid} findings={findings}/>
            <ToothHistory tooth={selected} findings={findings} patientId={pid}/>
          </div>
        )
        : <div className="muted" style={{fontSize:13,padding:"8px 2px"}}>{tt("اختر سنًا لتسجيل حالته أو رؤية تاريخه.")}</div>}
    </div>
  );
}

// «العلاج»: what is planned (latest row of each tooth and condition) and done.
function DentalTreatmentTab({ p, findings }) {
  const pid = p.patient_id || p.id;
  const chart = React.useMemo(() => chartOf(findings), [findings]);
  const current = Object.entries(chart).flatMap(([tooth, st]) => st.current.map(f => ({ ...f, tooth: Number(tooth) })));
  const planned = current.filter(f => f.status === "planned").sort((a, b) => a.tooth - b.tooth);
  const done = findings.filter(f => f.status === "done").sort((a, b) => findingTime(b).localeCompare(findingTime(a)));
  async function markDone(f) {
    try {
      await ClinicalAPI.save("dental_findings", { patient_id: pid, tooth: f.tooth, surfaces: f.surfaces || [], condition: f.condition, status: "done", notes: f.notes || null });
      window.showToast && window.showToast(tt("تم تسجيل الإنجاز"), "success");
    } catch (e) { window.showToast && window.showToast(e.message || tt("تعذّر الحفظ"), "error"); }
  }
  const line = (f, action) => (
    <div key={f.finding_id} data-treatment={f.finding_id} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 0",borderBottom:"1px solid var(--ink-100)"}}>
      <span className="mono" style={{fontWeight:600,minWidth:28}}>{f.tooth}</span>
      <span style={{flex:1}}>{tt(DENTAL_CONDITION_LABELS[f.condition])}{(f.surfaces || []).length ? <span className="mono muted"> · {f.surfaces.join("")}</span> : null}</span>
      <span className="muted" style={{fontSize:12}}>{clinicalByline(f.recorded_on, f.author_name)}</span>
      {action}
    </div>
  );
  return (
    <div data-tab="treatment" className="rgrid c-md" style={{"--gtc":"1fr 1fr",gap:18}}>
      <div>
        <h2 className="h3" style={{margin:"0 0 8px"}}>{tt("خطة العلاج")}</h2>
        {!planned.length && <div className="muted" style={{fontSize:13}}>{tt("لا علاج مخطط. خطط العلاج من مخطط الأسنان باختيار «مخطط».")}</div>}
        {planned.map(f => line(f, <button type="button" className="btn btn-secondary" style={{fontSize:12}} onClick={() => markDone(f)}><I.Check size={12}/> {tt("تم")}</button>))}
      </div>
      <div>
        <h2 className="h3" style={{margin:"0 0 8px"}}>{tt("ما أُنجز")}</h2>
        {!done.length && <div className="muted" style={{fontSize:13}}>{tt("لم يُسجل إنجاز بعد.")}</div>}
        {done.map(f => line(f, null))}
      </div>
    </div>
  );
}

// clinical = false (receptionist): the patient's details only; the counts
// and the last visit belong to the clinical record they cannot read.
function DentalOverview({ p, findings, visits, clinical }) {
  const chart = chartOf(findings);
  const counts = { attention: 0, planned: 0, restored: 0, missing: 0 };
  for (const st of Object.values(chart)) if (st.category) counts[st.category]++;
  const pid = p.patient_id || p.id;
  const next = (DATA.appts || []).filter(a => (a.pid === pid || a.patient_id === pid) && a.status !== "مكتمل" && a.status !== "ملغي")
    .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")))[0];
  const last = visits[0];
  const details = (
    <div className="card" style={{padding:16}} data-patient-details>
      <h3 className="h3" style={{margin:"0 0 8px"}}>{tt("بيانات المريض")}</h3>
      <ClinicalRow k={tt("الموعد القادم")} v={next ? `${next.date ? fmtDate(next.date) : tt("اليوم")} ${next.time || ""}` : "—"}/>
      <ClinicalRow k={tt("الهاتف")} v={p.phone ? <bdi dir="ltr">{p.phone}</bdi> : "—"}/>
      <ClinicalRow k={tt("العمر")} v={p.age ? tt("{n} سنة", { n: p.age }) : "—"}/>
      <ClinicalRow k={tt("الحساسية")} v={p.allergies || tt("لا يوجد")}/>
      <ClinicalRow k={tt("الأدوية الحالية")} v={p.medications || tt("لا يوجد")}/>
      <ClinicalRow k={tt("التاريخ المرضي")} v={p.medical_history || "—"}/>
    </div>
  );
  if (!clinical) return <div data-tab="overview" style={{maxWidth:640}}>{details}</div>;
  return (
    <div data-tab="overview">
      <div className="grid-4" style={{marginBottom:16}}>
        {["attention", "planned", "restored", "missing"].map(k => (
          <div key={k} className="card" style={{padding:14,borderInlineStart:`4px solid ${TOOTH_STYLE[k].border}`}} data-count={k}>
            <div className="muted" style={{fontSize:12}}>{tt(DENTAL_CATEGORY_LABELS[k])}</div>
            <div className="mono" style={{fontSize:22,fontWeight:600}}>{counts[k]}</div>
          </div>
        ))}
      </div>
      <div className="rgrid c-md" style={{"--gtc":"1fr 1fr",gap:16}}>
        <div className="card" style={{padding:16}}>
          <h3 className="h3" style={{margin:"0 0 8px"}}>{tt("آخر زيارة")}</h3>
          {last ? <><div className="muted" style={{fontSize:12,marginBottom:6}}>{clinicalByline(last.visit_date, last.clinician_name || last.author_name)}</div><AssessmentDetails a={last}/></>
                : <div className="muted" style={{fontSize:13}}>{tt("لا ملاحظات زيارات بعد")}</div>}
        </div>
        {details}
      </div>
    </div>
  );
}

function DentalPatientDetail({ p: pIn, onBack, go }) {
  window.useDataVersion && window.useDataVersion();
  const pid = pIn.patient_id || pIn.id;
  const p = (DATA.patients || []).find(x => (x.patient_id || x.id) === pid) || pIn;
  if (window.useOlderRows) window.useOlderRows({ patientId: pid });
  const clinical = canReadClinical();
  const { rows } = useClinical(pid, clinical ? ["dental_findings", "assessments"] : []);
  const findings = rows.dental_findings || [];
  const visits = rows.assessments || [];
  const [tab, setTab] = React.useState(clinical ? "chart" : "overview");
  const [modal, setModal] = React.useState(null); // "visit" | "rx" | "edit"
  const mayEdit = window.canEditPatient ? window.canEditPatient((window.ME && window.ME.role) || "") : true;
  const tabs = [
    { key: "overview", label: tt("نظرة عامة") },
    ...(clinical ? [{ key: "chart", label: tt("مخطط الأسنان") }, { key: "treatment", label: tt("العلاج") }] : []),
    { key: "billing", label: tt("الفواتير") },
    ...(clinical ? [{ key: "visits", label: tt("ملاحظات الزيارات") }] : []),
    ...(clinical && orgModuleOn("general.prescriptions") ? [{ key: "rx", label: tt("الوصفات") }] : []),
    { key: "appointments", label: tt("المواعيد") },
    ...(orgModuleOn("core.files") ? [{ key: "files", label: tt("الملفات") }] : []),
  ];
  return (
    <Page>
      <ClinicalPatientHeader p={p} onBack={onBack} actions={<>
        {clinical && <button className="btn btn-blue" onClick={() => setModal("visit")}><I.Edit size={14}/> {tt("ملاحظة زيارة جديدة")}</button>}
        {canPrescribe() && orgModuleOn("general.prescriptions") && <button className="btn btn-secondary" onClick={() => setModal("rx")}><I.FileText size={14}/> {tt("وصفة جديدة")}</button>}
        <button className="btn btn-secondary" onClick={() => go && go("appointments")}><I.Calendar size={14}/> {tt("حجز موعد")}</button>
        {mayEdit && <button className="btn btn-ghost btn-icon" aria-label={tt("تعديل بيانات المريض")} onClick={() => setModal("edit")}><I.Edit size={15}/></button>}
      </>}/>
      <div className="card" style={{padding:0,overflow:"hidden"}}>
        <ClinicalTabs tabs={tabs} value={tab} onChange={setTab}/>
        <div style={{padding:20}}>
          {tab === "overview" && <DentalOverview p={p} findings={findings} visits={visits} clinical={clinical}/>}
          {tab === "chart" && <ToothChartTab p={p} findings={findings}/>}
          {tab === "treatment" && <DentalTreatmentTab p={p} findings={findings}/>}
          {tab === "billing" && <PatientInvoices p={p}/>}
          {tab === "visits" && <VisitNotesTab p={p} kind="dental" onNew={() => setModal("visit")}/>}
          {tab === "rx" && <PrescriptionsTab p={p} onNew={() => setModal("rx")}/>}
          {tab === "appointments" && <PatientAppointmentsTab p={p} go={go}/>}
          {tab === "files" && <PatientFiles p={p}/>}
        </div>
      </div>
      {modal === "visit" && <VisitNoteModal kind="dental" patient={p} onClose={() => setModal(null)} onSaved={() => { setModal(null); setTab("visits"); }}/>}
      {modal === "rx" && <PrescriptionModal patient={p} onClose={() => setModal(null)} onSaved={() => { setModal(null); setTab("rx"); }}/>}
      {modal === "edit" && window.PatientEditModal && <window.PatientEditModal patient={p} onClose={() => setModal(null)} onSaved={() => setModal(null)}/>}
    </Page>
  );
}

Object.assign(window, {
  DENTAL_CONDITIONS, DENTAL_LAYOUT, toothState, chartOf,
  DentalPatientDetail, ToothChart, ToothChartTab,
});
