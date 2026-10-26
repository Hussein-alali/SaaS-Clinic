

// ===== src/dashboard.jsx =====
// Admin Dashboard

// ── File-local utilities ───────────────────────────────────────
function downloadCsv(rows, filename) {
  const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// The message is pre-filled in the interface language (like the reminder in
// src/ui.jsx); the receptionist reviews it in WhatsApp before sending.
function buildWhatsAppUrl(phone, msg) {
  return `https://wa.me/${(phone || "").replace(/\D/g, "")}?text=${encodeURIComponent(msg || "")}`;
}

function buildTelUrl(phone) {
  return `tel:${phone}`;
}

// «23/10/2026» — the browser's default numeric date, in the interface language.
const NUMERIC_DATE = { year: "numeric", month: "numeric", day: "numeric" };

// ── Dashboard ─────────────────────────────────────────────────
// Shared palette for computed category charts.
const CHART_COLORS = ["#7BBDE8","#3A7FB5","#BDD8E9","#7E6BD3","#3FA984","#1E4A6E","#D49044"];
// Long date for page subtitles («الأحد، 24 مايو» / «Sunday 24 May»).
function todayLabelAr() {
  return fmtDate(new Date(), "weekdayDate");
}
// Active branch name (settings-driven; falls back to a neutral label).
function activeBranchName() {
  const b = (window.BRANCHES || []).find(x => x.id === window.ACTIVE_BRANCH_ID) || (window.BRANCHES || [])[0];
  return (b && b.name) || tt("عيادتك");
}
const invoiceDateOf = (p) => String(p.date || p.created_at || "").slice(0, 10);

// ── Dashboard time filter ─────────────────────────────────────
// Given a range preset (اليوم / هذا الأسبوع / الشهر / الربع — stored
// values, saved in localStorage), returns the [from, to] window
// (YYYY-MM-DD, inclusive), the translated `label`, and a `bucket` telling
// widgets whether to group by hour, day, or month. The clinic week
// starts on Saturday to match the Calendar module.
function __dashPad(n){ return String(n).padStart(2,"0"); }
function __dashIso(d){ return `${d.getFullYear()}-${__dashPad(d.getMonth()+1)}-${__dashPad(d.getDate())}`; }
function __dashStartOfWeek(d){
  const day = d.getDay();
  const diff = (day + 1) % 7; // days since Saturday
  const out = new Date(d); out.setDate(d.getDate() - diff); out.setHours(0,0,0,0);
  return out;
}
function dashboardPeriod(range) {
  const now = new Date(); now.setHours(0,0,0,0);
  const y = now.getFullYear(), m = now.getMonth();
  switch (range) {
    case "اليوم":
      return { from: __dashIso(now), to: __dashIso(now), bucket: "hour", label: tt("اليوم") };
    case "هذا الأسبوع": {
      const s = __dashStartOfWeek(now);
      const e = new Date(s); e.setDate(s.getDate()+6);
      return { from: __dashIso(s), to: __dashIso(e), bucket: "day", label: tt("هذا الأسبوع") };
    }
    case "الشهر": {
      const s = new Date(y, m, 1), e = new Date(y, m+1, 0);
      return { from: __dashIso(s), to: __dashIso(e), bucket: "day", label: tt("الشهر") };
    }
    case "الربع": {
      const q = Math.floor(m/3);            // 0-3
      const s = new Date(y, q*3, 1), e = new Date(y, q*3+3, 0);
      return { from: __dashIso(s), to: __dashIso(e), bucket: "month", label: tt("الربع") };
    }
    default:
      return { from: __dashIso(now), to: __dashIso(now), bucket: "hour", label: tt(range) };
  }
}
function inPeriod(dateStr, from, to) {
  if (!dateStr) return false;
  const d = String(dateStr).slice(0, 10);
  return d >= from && d <= to;
}
// Read the appointment's canonical date, treating a missing date as today
// (bookings without a scheduled date usually get filed as "today").
function apptDayOf(a){
  const d = a && (a.date || a.created_at);
  return d ? String(d).slice(0,10) : new Date().toISOString().slice(0,10);
}
function apptHourOf(a){
  const t = String(a && a.time || "").match(/^(\d{1,2}):/);
  return t ? Math.max(0, Math.min(23, parseInt(t[1], 10))) : null;
}
// Enumerate day/month labels covering [from, to] so charts stay stable
// even for periods with no data.
function enumerateDays(from, to){
  const out = [];
  const s = new Date(from), e = new Date(to);
  s.setHours(0,0,0,0); e.setHours(0,0,0,0);
  const cur = new Date(s);
  while (cur <= e) { out.push(__dashIso(cur)); cur.setDate(cur.getDate()+1); }
  return out;
}
function enumerateMonths(from, to){
  const out = [];
  const s = new Date(from), e = new Date(to);
  s.setDate(1); e.setDate(1);
  const cur = new Date(s);
  while (cur <= e) { out.push(`${cur.getFullYear()}-${__dashPad(cur.getMonth()+1)}`); cur.setMonth(cur.getMonth()+1); }
  return out;
}

function Dashboard({ go }) {
  window.useDataVersion && window.useDataVersion();
  const LS_RANGE = "kinetic.dashRange";
  // Preserve the selected range across navigations. Falls back to a sane
  // default the first time the dashboard is opened.
  const [range, setRangeState] = React.useState(() => {
    try { return localStorage.getItem(LS_RANGE) || "هذا الأسبوع"; }
    catch { return "هذا الأسبوع"; }
  });
  const setRange = React.useCallback((r) => {
    setRangeState(r);
    try { localStorage.setItem(LS_RANGE, r); } catch {}
  }, []);
  const [quickPayOpen, setQuickPayOpen] = React.useState(false);

  const patients = DATA.patients, appts = DATA.appts, payments = DATA.payments;
  const today = new Date().toISOString().slice(0,10);

  const period = React.useMemo(() => dashboardPeriod(range), [range]);
  const periodAppts    = React.useMemo(
    () => appts.filter(a => inPeriod(apptDayOf(a), period.from, period.to)),
    [appts, period.from, period.to]
  );
  const periodPayments = React.useMemo(
    () => payments.filter(p => inPeriod(invoiceDateOf(p), period.from, period.to)),
    [payments, period.from, period.to]
  );
  const periodPatients = React.useMemo(
    () => patients.filter(p => inPeriod(String(p.registered||"").slice(0,10), period.from, period.to)),
    [patients, period.from, period.to]
  );

  // Revenue chart — labels/values match the period bucket.
  // hour: 24 buckets 0-23; day: one bucket per calendar day; month: one per month.
  const revenueData = React.useMemo(() => {
    if (period.bucket === "hour") {
      const buckets = Array(24).fill(0);
      periodPayments.forEach(p => {
        const t = String(p.created_at || "");
        const h = t ? (new Date(t)).getHours() : 0;
        if (Number.isFinite(h)) buckets[h] += (p.paid || 0);
      });
      return buckets.map((v,i) => ({ label: `${i}:00`, v }));
    }
    if (period.bucket === "day") {
      const days = enumerateDays(period.from, period.to);
      const map = {};
      periodPayments.forEach(p => { const d = invoiceDateOf(p); if (d) map[d] = (map[d]||0)+(p.paid||0); });
      return days.map(d => ({ label: d.slice(5), v: map[d] || 0 }));
    }
    const months = enumerateMonths(period.from, period.to);
    const map = {};
    periodPayments.forEach(p => { const d = invoiceDateOf(p).slice(0,7); if (d) map[d] = (map[d]||0)+(p.paid||0); });
    return months.map(m => ({ label: m.slice(5), v: map[m] || 0 }));
  }, [periodPayments, period.bucket, period.from, period.to]);

  // Appointment volume — same bucketing as revenue.
  const apptData = React.useMemo(() => {
    if (period.bucket === "hour") {
      const buckets = Array(24).fill(0);
      periodAppts.forEach(a => {
        const h = apptHourOf(a);
        if (h != null) buckets[h] += 1;
      });
      return buckets.map((v,i) => ({ label: `${i}:00`, v }));
    }
    if (period.bucket === "day") {
      const days = enumerateDays(period.from, period.to);
      const map = {};
      periodAppts.forEach(a => { const d = apptDayOf(a); map[d] = (map[d]||0)+1; });
      return days.map(d => ({ label: d.slice(5), v: map[d] || 0 }));
    }
    const months = enumerateMonths(period.from, period.to);
    const map = {};
    periodAppts.forEach(a => { const m = apptDayOf(a).slice(0,7); map[m] = (map[m]||0)+1; });
    return months.map(m => ({ label: m.slice(5), v: map[m] || 0 }));
  }, [periodAppts, period.bucket, period.from, period.to]);

  // Session-type mix — recomputed from period appointments only.
  const methodsData = React.useMemo(() => {
    const typeCounts = {};
    periodAppts.forEach(a => { if (a.type) typeCounts[a.type] = (typeCounts[a.type]||0)+1; });
    return Object.entries(typeCounts).sort((a,b)=>b[1]-a[1]).slice(0,4)
      .map(([label, v], i) => ({ label: apptTypeLabel(label), v, color: CHART_COLORS[i] }));
  }, [periodAppts]);
  const methodsTotal = methodsData.reduce((s,d)=>s+d.v, 0);

  // Package uptake from the packages table (stays global — not date-scoped).
  const packageData = DATA.packages.filter(p => p.active !== false).slice(0,5)
    .map((p, i) => ({ label:p.name, v:p.sold||0, color: CHART_COLORS[i % CHART_COLORS.length] }));

  // Period-scoped stats — every card refreshes when `range` changes.
  const booked          = periodAppts.filter(a => a.status !== "متاح");
  const confirmed       = booked.filter(a => a.status !== "معلّق" && a.status !== "ملغي");
  const uniquePatients  = new Set(booked.map(a => a.patient).filter(Boolean)).size;
  const periodRevenue   = periodPayments.reduce((s,p)=>s+(p.paid||0),0);
  const monthRevenue    = payments.filter(p => invoiceDateOf(p).startsWith(today.slice(0,7)))
                                  .reduce((s,p)=>s+(p.paid||0),0);
  const outstanding     = periodPayments.reduce((s,p)=>s+Math.max(0,(p.amount||0)-(p.paid||0)),0);
  const remainTotal     = patients.reduce((s,p)=>s+(p.remain||0),0);
  const newPatients     = periodPatients.length;
  const pendingPayments = periodPayments.filter(p => p.status !== "مدفوع");

  // Card labels adapt to the selected period so nothing reads "اليوم" when
  // the user picked "الشهر". We keep the visual layout untouched.
  const labels = React.useMemo(() => {
    switch (range) {
      case "اليوم":       return { patients:tt("مرضى اليوم"),   appts:tt("مواعيد اليوم"),   rev:tt("إيرادات اليوم"),   patRange:tt("اليوم") };
      case "هذا الأسبوع": return { patients:tt("مرضى الأسبوع"), appts:tt("مواعيد الأسبوع"), rev:tt("إيرادات الأسبوع"), patRange:tt("هذا الأسبوع") };
      case "الشهر":       return { patients:tt("مرضى الشهر"),   appts:tt("مواعيد الشهر"),   rev:tt("إيرادات الشهر"),   patRange:tt("هذا الشهر") };
      case "الربع":       return { patients:tt("مرضى الربع"),   appts:tt("مواعيد الربع"),   rev:tt("إيرادات الربع"),   patRange:tt("هذا الربع") };
      default:            return { patients:tt("المرضى"),       appts:tt("المواعيد"),       rev:tt("الإيرادات"),       patRange:tt(range) };
    }
  }, [range]);

  // Therapist workload — count of period appts assigned to each therapist.
  const workloadByTh = React.useMemo(() => {
    const map = {};
    periodAppts.forEach(a => {
      const key = a.therapist_id || a.th || "";
      if (!key) return;
      map[key] = (map[key] || 0) + 1;
    });
    return map;
  }, [periodAppts]);

  // Schedule list — sorted chronologically inside the period.
  const scheduleList = React.useMemo(() => {
    return periodAppts.slice().sort((a,b) => {
      const da = `${apptDayOf(a)} ${a.time || ""}`;
      const db = `${apptDayOf(b)} ${b.time || ""}`;
      return da.localeCompare(db);
    }).slice(0, 6);
  }, [periodAppts]);

  // ── Handlers ──
  function handleExportCsv() {
    const rows = [
      `${tt("البيان")},${tt("القيمة (الفترة: {period})", { period: period.label })}`,
      `${labels.patients},${uniquePatients}`,
      `${labels.appts},${booked.length}/${periodAppts.length}`,
      `${labels.rev},${periodRevenue}`,
      `${tt("الإيرادات الشهرية")},${monthRevenue}`,
      `${tt("مستحقات معلقة")},${outstanding}`,
      `${tt("مرضى جدد")},${newPatients}`,
    ];
    downloadCsv(rows, "dashboard.csv");
    if (window.showToast) window.showToast(tt("تم تصدير البيانات"), "success");
  }

  return (
    <Page>
      <div className="page-head" style={{marginBottom:22}}>
        <div>
          <div className="crumb"><span>{tt("الرئيسية")}</span><I.Chevron size={11}/><span>{tt("لوحة التحكم")}</span></div>
          <h1 className="h1">{window.ME && window.ME.name ? tt("صباح الخير، {name}", { name: window.ME.name.split(" ")[0] }) : tt("صباح الخير")} <span style={{display:"inline-block",transform:"translateY(-2px)"}}>👋🏼</span></h1>
          <div className="muted" style={{fontSize:13.5,marginTop:4}}>{tt("{date} — أداء {branch} اليوم.", { date: todayLabelAr(), branch: activeBranchName() })}</div>
        </div>
        <div className="page-actions">
          <Segmented label={tt("الفترة")} value={range} onChange={setRange}
            options={["اليوم","هذا الأسبوع","الشهر","الربع"].map(r => ({ value: r, label: tt(r) }))}/>
          <button className="btn btn-secondary" onClick={handleExportCsv}><I.Download size={14}/> {tt("تصدير")}</button>
          <button className="btn btn-secondary" onClick={()=>setQuickPayOpen(true)}><I.CreditCard size={14}/> {tt("دفع سريع")}</button>
          <button className="btn btn-blue" onClick={()=>go("appointments")}><I.Plus size={14}/> {tt("موعد جديد")}</button>
        </div>
      </div>

      {/* «ابدأ الإعداد» for the admin of a new clinic (src/screens2.jsx) */}
      {window.OnboardingChecklist && <window.OnboardingChecklist go={go}/>}

      {/* stat row */}
      <div className="grid-stats" style={{marginBottom:18}}>
        <StatCard label={labels.patients}    value={String(uniquePatients)} accent="#7BBDE8" icon={<I.Users size={15}/>}/>
        <StatCard label={labels.appts} value={`${booked.length}/${periodAppts.length}`} accent="#3A7FB5" icon={<I.Calendar size={15}/>}/>
        <StatCard label={labels.rev}   value={fmtMoneyShort(periodRevenue)} accent="#3FA984" icon={<I.Dollar size={15}/>}/>
        <StatCard label={tt("الإيرادات الشهرية")}   value={fmtMoneyShort(monthRevenue)} accent="#7E6BD3" icon={<I.Chart size={15}/>}/>
        <StatCard label={tt("الأخصائيون النشطون")} value={`${(DATA.therapists||[]).filter(t=>t.active!==false).length}/${(DATA.therapists||[]).length}`} accent="#D49044" icon={<I.Stethoscope size={15}/>}/>
        <StatCard label={tt("الجلسات المتبقية")} value={fmtNumber(remainTotal)} accent="#D8665A" icon={<I.Activity size={15}/>}/>
      </div>

      {/* main two cols */}
      <div className="rgrid c-lg" style={{"--gtc":"1.5fr 1fr",marginBottom:18}}>
        {/* Revenue */}
        <div className="card card-pad">
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:18}}>
            <div>
              <div className="h2">{tt("اتجاه الإيرادات")}</div>
              <div className="muted" style={{fontSize:12.5,marginTop:2}}>
                {period.bucket==="hour" ? tt("الساعات · ج.م") : period.bucket==="month" ? tt("الأشهر · ج.م") : tt("الأيام · ج.م")} — {period.label}
              </div>
            </div>
            <div style={{display:"flex",gap:14,fontSize:12}}>
              <span style={{display:"flex",alignItems:"center",gap:6}}><span style={{width:9,height:9,borderRadius:3,background:"#7BBDE8"}}></span>{tt("مقبوض")}</span>
              <span style={{display:"flex",alignItems:"center",gap:6,color:"var(--ink-500)"}} className="mono">{fmtMoneyShort(periodRevenue)}</span>
            </div>
          </div>
          <AreaChart data={revenueData} height={220} formatY={(v)=>v>=1000?`${Number((v/1000).toFixed(1))}K`:v}/>
        </div>

        {/* مواعيد اليوم */}
        <div className="card card-pad">
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
            <div>
              <div className="h2">{tt("جدول اليوم")}</div>
              <div className="muted" style={{fontSize:12.5,marginTop:2}}>{tt("{n} من {total} مؤكد", { n: confirmed.length, total: booked.length })}</div>
            </div>
            <button className="btn btn-ghost" style={{fontSize:12}} onClick={()=>go("appointments")}>{tt("عرض التقويم")} <I.ArrowRight size={12}/></button>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:8,maxHeight:268,overflowY:"auto"}}>
            {scheduleList.length===0 && <div className="muted" style={{fontSize:13,padding:"24px 0",textAlign:"center"}}>{tt("لا مواعيد ضمن الفترة المحددة.")}</div>}
            {scheduleList.map(a=>(
              <div key={a.id} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 12px",border:"1px solid var(--ink-200)",borderRadius:12,background:a.status==="قيد التنفيذ"?"var(--blue-50)":"#fff"}}>
                <div style={{textAlign:"center",minWidth:48}}>
                  <div className="mono" style={{fontSize:13,fontWeight:600}}>{a.time}</div>
                  <div style={{fontSize:10.5,color:"var(--ink-500)"}}><span className="mono">{a.dur}</span> {tt("د")}</div>
                </div>
                <div style={{width:1,height:30,background:"var(--ink-200)"}}/>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:13,fontWeight:500,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{a.patient}</div>
                  <div style={{fontSize:11.5,color:"var(--ink-500)"}}>{a.th} · {apptTypeLabel(a.type) || "—"} · {apptDayOf(a).slice(5)}</div>
                </div>
                <ApptBadge s={a.status}/>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Bottom grid */}
      <div className="rgrid half-lg c-sm" style={{"--gtc":"repeat(3,1fr)"}}>
        {/* Appointment trend */}
        <div className="card card-pad">
          <div className="h2" style={{marginBottom:4}}>{tt("حجم المواعيد")}</div>
          <div className="muted" style={{fontSize:12.5,marginBottom:14}}>
            {period.bucket==="hour" ? tt("جلسات/ساعة") : period.bucket==="month" ? tt("جلسات/شهر") : tt("جلسات/يوم")} · {period.label}
          </div>
          <BarChart data={apptData} height={170}/>
        </div>

        {/* طرق العلاج */}
        <div className="card card-pad">
          <div className="h2" style={{marginBottom:4}}>{tt("طرق العلاج")}</div>
          <div className="muted" style={{fontSize:12.5,marginBottom:14}}>{tt("نسبة الجلسات · {period}", { period: period.label })}</div>
          <DonutChart data={methodsData} size={150} centerLabel={tt("الجلسات")} centerValue={String(methodsTotal)}/>
        </div>

        {/* حمل الأخصائيين */}
        <div className="card card-pad">
          <div className="h2" style={{marginBottom:4}}>{tt("حمل الأخصائيين")}</div>
          <div className="muted" style={{fontSize:12.5,marginBottom:14}}>{tt("حجوزات {period}", { period: period.label })}</div>
          <div style={{display:"flex",flexDirection:"column",gap:14}}>
            {DATA.therapists.length===0 && <div className="muted" style={{fontSize:13,padding:"18px 0",textAlign:"center"}}>{tt("لا أخصائيين مسجّلين بعد.")}</div>}
            {DATA.therapists.map(t=>{
              const load = (workloadByTh[t.id] || 0) + (workloadByTh[t.name] || 0);
              const cap = Math.max(t.max || 8, 1);
              const pct = Math.min(100, (load / cap) * 100);
              return (
              <div key={t.name}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <span className="av sm" aria-hidden="true" style={{background:t.color+"33",color:"var(--ink-900)"}}>{t.name.split(" ").map(x=>x[0]).join("").slice(0,2)}</span>
                    <div>
                      <div style={{fontSize:12.5,fontWeight:500}}>{t.name}</div>
                      <div style={{fontSize:11,color:"var(--ink-500)"}}>{t.spec}</div>
                    </div>
                  </div>
                  <span className="mono" style={{fontSize:11.5,color:"var(--ink-700)"}}>{load}/{cap}</span>
                </div>
                <div style={{height:5,background:"var(--ink-100)",borderRadius:999,overflow:"hidden"}}>
                  <div style={{height:"100%",width:`${pct}%`,background:t.color,borderRadius:999,transition:"width .3s"}}/>
                </div>
              </div>
              );
            })}
          </div>
        </div>

        {/* مرضى جدد */}
        <div className="card card-pad">
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
            <div>
              <div className="h2">{tt("مرضى جدد")}</div>
              <div className="muted" style={{fontSize:12.5,marginTop:2}}>{tt("مسجّلون · {range}", { range: labels.patRange })}</div>
            </div>
            <span className="badge b-blue">{tt("{n} جديد", { n: newPatients })}</span>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {periodPatients.length===0 && <div className="muted" style={{fontSize:13,padding:"18px 0",textAlign:"center"}}>{tt("لا مرضى مسجّلين ضمن الفترة.")}</div>}
            {periodPatients.slice(0,4).map(p=>(
              <div key={p.id} style={{display:"flex",alignItems:"center",gap:10,padding:"6px 0"}}>
                <div className="av md">{p.name.split(" ").map(x=>x[0]).join("").slice(0,2)}</div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:13,fontWeight:500}}>{p.name}</div>
                  <div style={{fontSize:11.5,color:"var(--ink-500)"}}>{p.diag}</div>
                </div>
                <button type="button" className="btn btn-ghost" aria-label={tt("فتح ملف {name}", { name: p.name })} style={{fontSize:11.5,padding:"4px 8px",minWidth:40,justifyContent:"center"}} onClick={()=>go("patients")}>{tt("فتح")}</button>
              </div>
            ))}
          </div>
        </div>

        {/* استخدام الباقات */}
        <div className="card card-pad">
          <div className="h2" style={{marginBottom:4}}>{tt("استخدام الباقات")}</div>
          <div className="muted" style={{fontSize:12.5,marginBottom:14}}>{tt("اشتراكات نشطة")}</div>
          <BarChart data={packageData} height={170}/>
        </div>

        {/* مدفوعات معلقة */}
        <div className="card card-pad">
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
            <div>
              <div className="h2">{tt("مدفوعات معلقة")}</div>
              <div className="muted" style={{fontSize:12.5,marginTop:2}}>{tt("يحتاج متابعة · {period}", { period: period.label })}</div>
            </div>
            <span className="badge b-amber"><span className="dot"></span>{fmtMoneyShort(outstanding)}</span>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {pendingPayments.length===0 && <div className="muted" style={{fontSize:13,padding:"18px 0",textAlign:"center"}}>{tt("لا مدفوعات معلقة.")}</div>}
            {pendingPayments.slice(0,4).map(p=>(
              <div key={p.id} style={{display:"flex",alignItems:"center",gap:10,padding:"4px 0"}}>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:12.5,fontWeight:500}}>{p.patient}</div>
                  <div style={{fontSize:11,color:"var(--ink-500)"}} className="mono">{p.id} · {p.date}</div>
                </div>
                <div style={{textAlign:"start"}}>
                  <div className="mono" style={{fontSize:12.5,fontWeight:600}}>{fmtMoney(p.amount-p.paid)}</div>
                  <PayBadge s={p.status}/>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {quickPayOpen && window.QuickPaymentModal && (
        <window.QuickPaymentModal
          onClose={()=>setQuickPayOpen(false)}
          onDone={()=>setQuickPayOpen(false)}
        />
      )}
    </Page>
  );
}

// ── Reused badges ──────────────────────────────────────────────
// `s` is the stored (Arabic) status; only the label is translated.
function ApptBadge({ s }) {
  const map = {
    "معلّق":     { c:"b-amber",  d:tt("معلّق") },
    "مؤكد":   { c:"b-blue",   d:tt("مؤكد") },
    "مكتمل":   { c:"b-green",  d:tt("مكتمل") },
    "قيد التنفيذ": { c:"b-violet", d:tt("في الجلسة") },
    "ملغي":   { c:"b-red",    d:tt("ملغي") },
    "لم يحضر":     { c:"b-red",    d:tt("لم يحضر") },
    "متاح":   { c:"b-grey",   d:tt("موعد متاح") },
  };
  const m = map[s] || { c:"b-grey", d:tt(s) };
  return <span className={"badge " + m.c}><span className="dot"></span>{m.d}</span>;
}
function PayBadge({ s }) {
  const map = {
    "مدفوع":    { c:"b-green",  d:tt("مدفوع") },
    "جزئي": { c:"b-amber",  d:tt("جزئي") },
    "معلّق": { c:"b-grey",   d:tt("معلّق") },
    "متأخر": { c:"b-red",    d:tt("متأخر") },
  };
  // Rows written by the API carry the English status codes.
  const codes = { paid:"مدفوع", partial:"جزئي", pending:"معلّق", unpaid:"معلّق", overdue:"متأخر" };
  const key = codes[String(s || "").toLowerCase()] || s;
  const m = map[key] || { c:"b-grey", d:s === "cancelled" ? tt("ملغاة") : tt(s) };
  return <span className={"badge " + m.c}><span className="dot"></span>{m.d}</span>;
}

Object.assign(window, { Dashboard, ApptBadge, PayBadge, todayLabelAr, activeBranchName });


// ===== src/مريض.jsx =====
// المريض management — list, details, add/edit

// «أنثى» / «ذكر» (Female / Male) for the stored codes (F/M; older rows:
// Female/Male or the Arabic word). The stored value never changes.
function genderLabel(g) {
  const v = String(g || "").trim().toLowerCase();
  if (v === "f" || v === "female" || v === "أنثى") return tt("أنثى");
  if (v === "m" || v === "male" || v === "ذكر") return tt("ذكر");
  return "";
}

function Patients({ go }) {
  // Subscribe to data-updated events so the list re-renders whenever the
  // edit modal (or any other mutation) writes back to the DB.
  window.useDataVersion && window.useDataVersion();

  // ── State ──
  const [view, setView] = React.useState("list"); // list | detail | add
  const [selected, setSelected] = React.useState(null);
  const [editing, setEditing] = React.useState(null); // patient row being edited
  const [search, setSearch] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState("الكل");
  const [page, setPage] = React.useState(1);
  const [confirmDelete, setConfirmDelete] = React.useState(null);
  // Phones start with the cards (docs/04: tables become cards under 640px).
  const [layout, setLayout] = React.useState(() =>
    (window.matchMedia && window.matchMedia("(max-width: 640px)").matches) ? "grid" : "table"); // table | grid
  const csvRef = React.useRef(null);

  // Stable reference so unrelated re-renders (data-updated ticks that
  // don't touch patients) don't force filtered/child memos to recompute.
  const myPatients = React.useMemo(
    () => window.scopePatients ? window.scopePatients(DATA.patients) : DATA.patients,
    [DATA.patients]
  );
  const activeCount = React.useMemo(
    () => myPatients.filter(p => p.status === "نشط").length,
    [myPatients]
  );
  const filtered = React.useMemo(() => {
    const q = search ? search.toLowerCase() : "";
    return myPatients.filter(p => {
      if (statusFilter !== "الكل" && p.status !== statusFilter) return false;
      if (q && !((p.name || "") + (p.id || "") + (p.diag || "")).toLowerCase().includes(q)) return false;
      return true;
    });
  }, [myPatients, statusFilter, search]);

  if (view === "add") return <PatientAdd onCancel={()=>setView("list")} onSave={()=>setView("list")}/>;
  if (view === "detail" && selected) return <PatientDetail p={selected} onBack={()=>setView("list")} go={go}/>;

  return (
    <Page>
      <div className="page-head">
        <div>
          <div className="crumb"><span>{tt("الرئيسية")}</span><I.Chevron size={11}/><span>{tt("المرضى")}</span></div>
          <h1 className="h1">{tt("المرضى")}</h1>
          <div className="muted" style={{fontSize:13.5,marginTop:4}}>{tt("السجلات: {n} · النشطة: {active}", { n: myPatients.length, active: activeCount })}</div>
        </div>
        <div className="page-actions">
          <input ref={csvRef} type="file" accept=".csv" style={{display:"none"}} onChange={e=>{
            if(e.target.files[0]){if(window.showToast)window.showToast(tt("تم استيراد {name}", { name: e.target.files[0].name }),"success");}
            e.target.value="";
          }}/>
          <button className="btn btn-secondary" onClick={()=>csvRef.current&&csvRef.current.click()}><I.Upload size={14}/> {tt("استيراد CSV")}</button>
          <button className="btn btn-blue" onClick={()=>setView("add")}><I.Plus size={14}/> {tt("مريض جديد")}</button>
        </div>
      </div>

      {/* Filters */}
      <div className="card" style={{padding:14,marginBottom:14,display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
        <div style={{position:"relative",flex:"1 1 320px",maxWidth:380}}>
          <I.Search size={14} style={{position:"absolute",insetInlineEnd:11,top:"50%",transform:"translateY(-50%)",color:"var(--ink-400)"}}/>
          <input className="input" placeholder={tt("ابحث بالاسم، رقم الملف، التشخيص…")} value={search} onChange={e=>setSearch(e.target.value)} style={{paddingInlineEnd:32}}/>
        </div>
        {/* Filter values are the stored statuses; only the labels are translated. */}
        <Segmented label={tt("حالة الملف")} value={statusFilter} onChange={setStatusFilter}
          options={["الكل","نشط","غير نشط",INCOMPLETE_STATUS].map(s => ({ value: s, label: s===INCOMPLETE_STATUS ? tt("غير مكتمل") : tt(s) }))}/>
        <div style={{marginInlineEnd:"auto",display:"flex",alignItems:"center",gap:10}}>
          <span className="muted" style={{fontSize:12}} role="status">{tt("النتائج: {n}", { n: filtered.length })}</span>
          <Segmented label={tt("طريقة العرض")} value={layout} onChange={setLayout}
            options={[{ value:"table", label:tt("جدول") }, { value:"grid", label:tt("بطاقات") }]}/>
        </div>
      </div>

      {layout==="table" ? (
        <div className="card" style={{overflow:"hidden"}}>
          <div className="tbl-scroll">
          <CardTable>
            <thead>
              <tr>
                <th style={{width:36}}><input type="checkbox" aria-label={tt("تحديد كل المرضى")}/></th>
                <th>{tt("المريض")}</th>
                <th>{tt("رقم الملف")}</th>
                <th>{tt("التشخيص")}</th>
                <th>{tt("الطبيب")}</th>
                <th>{tt("الأخصائي")}</th>
                <th>{tt("متبقي")}</th>
                <th>{tt("آخر زيارة")}</th>
                <th>{tt("الدفع")}</th>
                <th style={{width:90}}><span className="sr-only">{tt("إجراءات")}</span></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(p=>(
                <tr key={p.id} data-clickable="true" tabIndex={0} onClick={()=>{setSelected(p);setView("detail")}} onKeyDown={e=>{ if(e.key==="Enter"||e.key===" "){e.preventDefault();setSelected(p);setView("detail");} }}>
                  <td onClick={e=>e.stopPropagation()}><input type="checkbox" aria-label={tt("تحديد {name}", { name: p.name })}/></td>
                  <td>
                    <div style={{display:"flex",alignItems:"center",gap:10}}>
                      <div className="av md">{p.name.split(" ").map(x=>x[0]).join("").slice(0,2)}</div>
                      <div>
                        <div style={{fontWeight:500}}>{p.name}</div>
                        <div style={{fontSize:11.5,color:"var(--ink-500)"}}>{[p.age ? tt("{n} سنة", { n: p.age }) : "", genderLabel(p.gender), p.job && p.job !== "—" ? p.job : ""].filter(Boolean).join(" · ") || "—"}</div>
                      </div>
                    </div>
                  </td>
                  <td className="mono" style={{fontSize:12.5,color:"var(--ink-700)",whiteSpace:"nowrap"}}>{p.id}</td>
                  <td><span style={{fontSize:12.5}}>{p.diag}</span></td>
                  <td><span style={{fontSize:12.5}}>{p.dr}</span></td>
                  <td><span style={{fontSize:12.5}}>{p.th}</span></td>
                  <td>
                    <div style={{display:"flex",alignItems:"center",gap:8}}>
                      <span className="mono" style={{fontSize:12.5,fontWeight:600,minWidth:18,textAlign:"start"}}>{p.remain ?? "—"}</span>
                      <div style={{flex:1,maxWidth:60,height:4,background:"var(--ink-100)",borderRadius:999,overflow:"hidden"}}>
                        <div style={{height:"100%",width:`${Math.min(100,(p.remain||0)/12*100)}%`,background:"var(--blue-500)"}}/>
                      </div>
                    </div>
                  </td>
                  <td className="muted mono" style={{fontSize:12.5,whiteSpace:"nowrap"}}>{p.visited}</td>
                  <td><PayBadge s={p.payment}/></td>
                  <td onClick={e=>e.stopPropagation()} style={{whiteSpace:"nowrap"}}>
                    <button type="button" className="btn btn-ghost btn-icon" title={tt("عرض الملف")} aria-label={tt("عرض ملف {name}", { name: p.name })} onClick={()=>{setSelected(p);setView("detail")}}><I.Eye size={14}/></button>
                    <button type="button" className="btn btn-ghost btn-icon" title={tt("تعديل بيانات المريض")} aria-label={tt("تعديل بيانات {name}", { name: p.name })} onClick={()=>setEditing(p)}><I.Edit size={14}/></button>
                    <button type="button" className="btn btn-ghost btn-icon" title={tt("حذف المريض")} aria-label={tt("حذف {name}", { name: p.name })} onClick={()=>setConfirmDelete(p)} style={{color:"#A8443A"}}><I.Trash size={14}/></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </CardTable>
          </div>
          {/* footer */}
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 18px",borderTop:"1px solid var(--ink-100)",background:"var(--ink-50)",flexWrap:"wrap",gap:10}}>
            <span className="muted" style={{fontSize:12}}>{tt("عرض 1–{n} من {total}", { n: filtered.length, total: myPatients.length })}</span>
            <div style={{display:"flex",gap:6}}>
              {Array.from({length: Math.max(1, Math.ceil(filtered.length/25))},(_,i)=>i+1).slice(0,8).map(n=>(
                <button key={n} className={"btn " + (page===n?"btn-primary":"btn-secondary")} style={{padding:"5px 11px",minWidth:32}} onClick={()=>setPage(n)}>{n}</button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="grid-4">
          {filtered.map(p => (
            <div key={p.id} className="card" style={{padding:18,cursor:"pointer"}} onClick={()=>{setSelected(p);setView("detail")}}>
              <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
                <div className="av lg">{p.name.split(" ").map(x=>x[0]).join("").slice(0,2)}</div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontWeight:600,fontSize:14}}>{p.name}</div>
                  <div className="mono" style={{fontSize:11,color:"var(--ink-500)"}}>{p.id}</div>
                </div>
                <PayBadge s={p.payment}/>
              </div>
              <div style={{padding:"10px 12px",background:"var(--ink-50)",borderRadius:10,fontSize:12,marginBottom:10}}>
                <div style={{color:"var(--ink-500)",fontSize:11,marginBottom:3}}>{tt("التشخيص")}</div>
                <div>{p.diag}</div>
              </div>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:12}}>
                <div>
                  <div className="muted" style={{fontSize:10.5}}>{tt("الأخصائي")}</div>
                  <div>{p.th}</div>
                </div>
                <div style={{textAlign:"start"}}>
                  <div className="muted" style={{fontSize:10.5}}>{tt("متبقي")}</div>
                  <div>{tt("{n} جلسات", { n: p.remain ?? "—" })}</div>
                </div>
              </div>
              <div style={{marginTop:12,display:"flex"}}>
                <WaReminderButton patient={p} style={{width:"100%",justifyContent:"center"}}/>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* delete modal */}
      <Modal open={!!confirmDelete} onClose={()=>setConfirmDelete(null)} title={tt("حذف سجل المريض؟")}
        footer={<>
          <button className="btn btn-secondary" onClick={()=>setConfirmDelete(null)}>{tt("إلغاء")}</button>
          <button className="btn" style={{background:"var(--red)",color:"#fff"}} onClick={async()=>{
            const target = confirmDelete;
            if (!target) return;
            setConfirmDelete(null);
            try {
              const pid = target.patient_id || target.id;
              if (window.KineticData) await window.KineticData.remove("patients", pid);
              if (window.showToast) window.showToast(tt("تم حذف المريض"), "success");
            } catch (e) {
              console.warn("delete patient failed", e);
              if (window.showToast) window.showToast(tt("تعذّر الحذف"), "error");
            }
          }}>{tt("حذف نهائي")}</button>
        </>}>
        <p>{ttx("أنت على وشك حذف {name} ({id}). This will remove all Sessions, invoices and uploads associated مع this patient.", { name: <strong>{confirmDelete?.name}</strong>, id: confirmDelete?.id })}</p>
        <p className="muted" style={{fontSize:12.5,marginTop:8}}>{tt("لا يمكن التراجع عن هذا الإجراء. فكّر في أرشفة المريض بدلًا من حذفه.")}</p>
      </Modal>

      {editing && (
        <PatientEditModal
          patient={editing}
          onClose={()=>setEditing(null)}
          onSaved={()=>setEditing(null)}
        />
      )}
    </Page>
  );
}

// ── PatientEditModal ───────────────────────────────────────────
// Full edit workflow: re-reads the row from the DB on open (never
// trusts the cached snapshot the caller passed in), enforces role
// permissions, validates, persists via KineticData.upsert (which
// dispatches `kinetic:data-updated` so every subscribed view — the
// patients list, PatientProfile, PatientDetail, dashboards — refreshes
// without a page reload), and writes an audit_events row capturing the
// diff (old vs new per field).
function PatientEditModal({ patient, onClose, onSaved }) {
  const role = (window.ME && window.ME.role) || "مدير";
  const isAdmin       = role === "مدير";
  const isReception   = role === "موظف استقبال";
  const isDoctor      = role === "طبيب";
  const isTherapist   = role === "الأخصائي";
  // Role-based edit permissions per PRD §8.
  const canEdit = {
    demographics: isAdmin || isReception,       // name, phone, id, contact, address
    medical:      isAdmin || isDoctor,          // diagnosis, allergies, meds, history, insurance
    therapy:      isAdmin || isDoctor || isTherapist, // therapist assignment, notes, status
  };

  const pid = patient.patient_id || patient.id;
  const [form, setForm]   = React.useState(null);
  const [original, setOrig] = React.useState(null);
  const [busy, setBusy]   = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [errors, setErrors] = React.useState({});

  // ── Load fresh from the DB (source of truth). Fall back to the row
  // passed in only if the network read fails outright, so the modal
  // still opens in offline/demo mode.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let fresh = null;
        if (window.KineticData && window.KineticData.list) {
          const rows = await window.KineticData.list("patients");
          fresh = (rows || []).find(r => (r.patient_id || r.id) === pid) || null;
        }
        if (!fresh) fresh = patient;
        if (!cancelled) {
          const norm = normalizePatientForForm(fresh);
          setForm(norm);
          setOrig(norm);
          setLoading(false);
        }
      } catch (e) {
        console.warn("patient reload failed", e);
        if (!cancelled) {
          const norm = normalizePatientForForm(patient);
          setForm(norm); setOrig(norm); setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [pid]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // Derived age from DOB (kept in sync so the "Age" input isn't a lie).
  const derivedAge = React.useMemo(() => {
    if (!form || !form.date_of_birth) return "";
    const d = new Date(form.date_of_birth);
    if (isNaN(d)) return "";
    const now = new Date();
    let a = now.getFullYear() - d.getFullYear();
    const m = now.getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < d.getDate())) a--;
    return a >= 0 && a < 130 ? String(a) : "";
  }, [form && form.date_of_birth]);

  function validate() {
    const e = {};
    if (!form.name || !form.name.trim()) e.name = tt("الاسم مطلوب");
    if (!form.phone || !form.phone.trim()) e.phone = tt("الهاتف مطلوب");
    else if (!/^[+\d][\d\s\-()]{6,}$/.test(form.phone.trim())) e.phone = tt("رقم هاتف غير صحيح");
    if (form.whatsapp && !/^[+\d][\d\s\-()]{6,}$/.test(form.whatsapp.trim())) e.whatsapp = tt("رقم واتساب غير صحيح");
    if (form.emergency_phone && !/^[+\d][\d\s\-()]{6,}$/.test(form.emergency_phone.trim())) e.emergency_phone = tt("رقم طوارئ غير صحيح");
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) e.email = tt("بريد إلكتروني غير صحيح");
    // Duplicate-check across the local cache — the DB unique index gives us
    // the authoritative rejection on save, but this catches it earlier.
    const others = ((window.DATA && window.DATA.patients) || []).filter(x => (x.patient_id || x.id) !== pid);
    if (form.national_id && form.national_id.trim() &&
        others.some(x => (x.national_id || "").trim() === form.national_id.trim())) {
      e.national_id = tt("الرقم القومي مستخدم لمريض آخر");
    }
    if (form.medical_file_no && form.medical_file_no.trim() &&
        others.some(x => (x.medical_file_no || "").trim() === form.medical_file_no.trim())) {
      e.medical_file_no = tt("رقم الملف مستخدم لمريض آخر");
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function save() {
    if (!validate()) {
      if (window.showToast) window.showToast(tt("راجع الحقول المُظللة"), "error");
      return;
    }
    setBusy(true);
    try {
      // Compute the diff so the audit payload only carries what changed.
      const changed = {};
      for (const k of Object.keys(form)) {
        const a = original[k] == null ? "" : String(original[k]);
        const b = form[k]     == null ? "" : String(form[k]);
        if (a !== b) changed[k] = { old: original[k] ?? null, new: form[k] ?? null };
      }
      if (Object.keys(changed).length === 0) {
        if (window.showToast) window.showToast(tt("لا تغييرات للحفظ"), "info");
        setBusy(false); return;
      }

      // Build the row to persist. Only fields present in the DB whitelist
      // will actually round-trip to Supabase; UI-only fields are ignored
      // by KineticData.upsert.
      const row = {
        patient_id:      pid,
        id:              pid,
        name:            form.name.trim(),
        phone:           form.phone.trim(),
        whatsapp:        strOrNull(form.whatsapp),
        email:           strOrNull(form.email),
        age:             form.age === "" || form.age == null ? null : Number(form.age),
        gender:          form.gender || null,
        date_of_birth:   strOrNull(form.date_of_birth),
        address:         strOrNull(form.address),
        occupation:      strOrNull(form.occupation),
        emergency_name:  strOrNull(form.emergency_name),
        emergency_phone: strOrNull(form.emergency_phone),
        doctor_id:       strOrNull(form.doctor_id),
        therapist_id:    strOrNull(form.therapist_id),
        diagnosis:       strOrNull(form.diagnosis),
        medical_history: strOrNull(form.medical_history),
        allergies:       strOrNull(form.allergies),
        medications:     strOrNull(form.medications),
        insurance_info:  strOrNull(form.insurance_info),
        notes:           strOrNull(form.notes),
        status:          form.status || "نشط",
        medical_file_no: strOrNull(form.medical_file_no),
        national_id:     strOrNull(form.national_id),
        // Preserve UI-mirrored display fields so cached list rows still render:
        diag:            strOrNull(form.diagnosis),
        dr:              form.dr || patient.dr || "",
        th:              form.th || patient.th || "",
        updated_at:      new Date().toISOString(),
      };

      // KineticData.upsert already handles LS + memory + Supabase and
      // dispatches `kinetic:data-updated`, which every useDataVersion()
      // consumer (Patients list, PatientProfile, dashboards) listens to.
      if (window.KineticData) {
        await window.KineticData.upsert("patients", row);
      }

      // Audit trail: best-effort. Failing to write the audit row must NOT
      // roll back the patient update — the patient edit is the primary
      // action; audit is a secondary observability record.
      try {
        if (window.sb || (typeof sb !== "undefined" && sb)) {
          const client = window.sb || sb;
          const uid  = (window.ME && window.ME.id) || null;
          const name = (window.ME && window.ME.name) || null;
          await client.from("audit_events").insert({
            actor_uid:  uid,
            actor_role: role,
            action:     "patient.edit",
            table_name: "patients",
            row_pk:     pid,
            // actor_name lives in payload — audit_events has no name column.
            payload:    { actor_name: name, patient_id: pid, changed, at: new Date().toISOString() },
          });
        }
      } catch (auditErr) {
        console.warn("audit write failed (non-fatal)", auditErr);
      }

      if (window.showToast) window.showToast(tt("تم حفظ بيانات المريض"), "success");
      onSaved && onSaved(row);
    } catch (e) {
      console.warn("patient edit failed", e);
      const msg = (e && e.message) ? tt(e.message) : tt("تعذّر الحفظ");
      // Keep the modal open with the user's changes intact so nothing is
      // lost after a failed save.
      if (window.showToast) window.showToast(msg, "error");
    } finally {
      setBusy(false);
    }
  }

  if (loading || !form) {
    return (
      <Modal open onClose={onClose} title={tt("تعديل بيانات المريض")} width={780}>
        <div className="muted" style={{padding:20,textAlign:"center"}}>{tt("جارٍ تحميل البيانات من قاعدة البيانات…")}</div>
      </Modal>
    );
  }

  const doctors    = (DATA.doctors    || []).filter(d => d.active !== false);
  // Inactive specialists stay hidden from the assignment dropdown; the
  // patient's currently-assigned specialist (form.therapist_id) is kept
  // in the option list even when inactive, so historical records don't
  // silently lose their assignment on render.
  const activeThs = (DATA.therapists || []).filter(t => t.active !== false);
  const currentT  = (DATA.therapists || []).find(t => (t.staff_id||t.id) === form.therapist_id);
  const therapists = currentT && currentT.active === false ? [...activeThs, currentT] : activeThs;

  const dis = (allowed) => allowed ? undefined : { disabled: true, style:{background:"var(--ink-50)",cursor:"not-allowed"} };
  const errStyle = (k) => errors[k] ? { border:"1px solid var(--red)" } : {};

  return (
    <Modal open onClose={onClose} title={tt("تعديل بيانات المريض · {name}", { name: form.name || pid })} width={860}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose} disabled={busy}>{tt("إلغاء")}</button>
        <button className="btn btn-blue" onClick={save} disabled={busy}>
          {busy ? tt("جارٍ الحفظ…") : (<><I.Check size={13}/> {tt("حفظ التغييرات")}</>)}
        </button>
      </>}>
      <div className="muted" style={{fontSize:12,marginBottom:14}}>
        {ttx("الدور: {role} · الحقول غير المسموح لك بتعديلها معطلة.", { role: <strong>{tt(role)}</strong> })}
      </div>

      <div className="h3" style={{marginBottom:10,fontSize:13,letterSpacing:".05em",textTransform:"uppercase",color:"var(--ink-500)"}}>{tt("معرفات")}</div>
      <div className="rgrid c-sm" style={{"--gtc":"repeat(2,1fr)",gap:12,marginBottom:18}}>
        <Field label={tt("رقم المريض")}><input className="input mono" value={pid} readOnly {...dis(false)}/></Field>
        <Field label={tt("رقم الملف الطبي")}>
          <input className="input" value={form.medical_file_no || ""} onChange={e=>set("medical_file_no", e.target.value)}
                 {...dis(canEdit.demographics)} style={errStyle("medical_file_no")}/>
          {errors.medical_file_no && <div style={{color:"#A8443A",fontSize:11,marginTop:3}}>{errors.medical_file_no}</div>}
        </Field>
        <Field label={tt("الرقم القومي / جواز السفر")}>
          <input className="input" value={form.national_id || ""} onChange={e=>set("national_id", e.target.value)}
                 {...dis(canEdit.demographics)} style={errStyle("national_id")}/>
          {errors.national_id && <div style={{color:"#A8443A",fontSize:11,marginTop:3}}>{errors.national_id}</div>}
        </Field>
        <Field label={tt("الحالة")}>
          <select className="input" value={form.status || "نشط"} onChange={e=>set("status", e.target.value)}
                  {...dis(canEdit.therapy)}>
            {["نشط","غير نشط","مؤرشف","غير مكتمل"].map(s=><option key={s} value={s}>{tt(s)}</option>)}
          </select>
        </Field>
      </div>

      <div className="h3" style={{marginBottom:10,fontSize:13,letterSpacing:".05em",textTransform:"uppercase",color:"var(--ink-500)"}}>{tt("البيانات الشخصية والاتصال")}</div>
      <div className="rgrid c-sm" style={{"--gtc":"repeat(2,1fr)",gap:12,marginBottom:18}}>
        <Field label={tt("الاسم الكامل")} required span={2}>
          <input className="input" value={form.name || ""} onChange={e=>set("name", e.target.value)}
                 {...dis(canEdit.demographics)} style={errStyle("name")}/>
          {errors.name && <div style={{color:"#A8443A",fontSize:11,marginTop:3}}>{errors.name}</div>}
        </Field>
        <Field label={tt("الهاتف")} required>
          <input className="input" value={form.phone || ""} onChange={e=>set("phone", e.target.value)}
                 {...dis(canEdit.demographics)} style={errStyle("phone")}/>
          {errors.phone && <div style={{color:"#A8443A",fontSize:11,marginTop:3}}>{errors.phone}</div>}
        </Field>
        <Field label={tt("واتساب")}>
          <input className="input" value={form.whatsapp || ""} onChange={e=>set("whatsapp", e.target.value)}
                 {...dis(canEdit.demographics)} style={errStyle("whatsapp")}/>
          {errors.whatsapp && <div style={{color:"#A8443A",fontSize:11,marginTop:3}}>{errors.whatsapp}</div>}
        </Field>
        <Field label={tt("البريد الإلكتروني")}>
          <input className="input" type="email" value={form.email || ""} onChange={e=>set("email", e.target.value)}
                 {...dis(canEdit.demographics)} style={errStyle("email")}/>
          {errors.email && <div style={{color:"#A8443A",fontSize:11,marginTop:3}}>{errors.email}</div>}
        </Field>
        <Field label={tt("الجنس")}>
          <select className="input" value={form.gender || ""} onChange={e=>set("gender", e.target.value)}
                  {...dis(canEdit.demographics)}>
            <option value="">—</option>
            <option value="F">{tt("أنثى")}</option>
            <option value="M">{tt("ذكر")}</option>
          </select>
        </Field>
        <Field label={tt("تاريخ الميلاد")}>
          <input className="input" type="date" value={form.date_of_birth || ""} onChange={e=>set("date_of_birth", e.target.value)}
                 {...dis(canEdit.demographics)}/>
        </Field>
        <Field label={tt("العمر")} hint={derivedAge ? tt("مشتق من تاريخ الميلاد: {age}", { age: derivedAge }) : ""}>
          <input className="input" type="number" value={form.age || ""} onChange={e=>set("age", e.target.value)}
                 {...dis(canEdit.demographics)}/>
        </Field>
        <Field label={tt("المهنة")}>
          <input className="input" value={form.occupation || ""} onChange={e=>set("occupation", e.target.value)}
                 {...dis(canEdit.demographics)}/>
        </Field>
        <Field label={tt("العنوان")} span={2}>
          <input className="input" value={form.address || ""} onChange={e=>set("address", e.target.value)}
                 {...dis(canEdit.demographics)}/>
        </Field>
        <Field label={tt("جهة الطوارئ")}>
          <input className="input" value={form.emergency_name || ""} onChange={e=>set("emergency_name", e.target.value)}
                 {...dis(canEdit.demographics)}/>
        </Field>
        <Field label={tt("هاتف الطوارئ")}>
          <input className="input" value={form.emergency_phone || ""} onChange={e=>set("emergency_phone", e.target.value)}
                 {...dis(canEdit.demographics)} style={errStyle("emergency_phone")}/>
          {errors.emergency_phone && <div style={{color:"#A8443A",fontSize:11,marginTop:3}}>{errors.emergency_phone}</div>}
        </Field>
      </div>

      <div className="h3" style={{marginBottom:10,fontSize:13,letterSpacing:".05em",textTransform:"uppercase",color:"var(--ink-500)"}}>{tt("الطاقم المعالج والتشخيص")}</div>
      <div className="rgrid c-sm" style={{"--gtc":"repeat(2,1fr)",gap:12,marginBottom:18}}>
        <Field label={tt("الطبيب المسؤول")}>
          <select className="input" value={form.doctor_id || ""} onChange={e=>{
            const id = e.target.value;
            const d = doctors.find(x => x.id === id);
            set("doctor_id", id); if (d) set("dr", d.name);
          }} {...dis(canEdit.therapy)}>
            <option value="">{tt("— بدون —")}</option>
            {doctors.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>
        <Field label={tt("الأخصائي المسؤول")}>
          <select className="input" value={form.therapist_id || ""} onChange={e=>{
            const id = e.target.value;
            const t = therapists.find(x => (x.staff_id || x.id) === id);
            set("therapist_id", id); if (t) set("th", t.name);
          }} {...dis(canEdit.therapy)}>
            <option value="">{tt("— بدون —")}</option>
            {therapists.map(t => <option key={t.staff_id||t.id} value={t.staff_id||t.id}>{t.name}</option>)}
          </select>
        </Field>
        <Field label={tt("التشخيص")} span={2}>
          <window.DiagnosisAutocomplete value={form.diagnosis || ""}
            onChange={e=>set("diagnosis", e.target.value)}
            {...dis(canEdit.medical)}/>
        </Field>
        <Field label={tt("التاريخ المرضي")} span={2}>
          <textarea className="input" style={{minHeight:60,padding:10,resize:"vertical"}}
                    value={form.medical_history || ""} onChange={e=>set("medical_history", e.target.value)}
                    {...dis(canEdit.medical)}/>
        </Field>
        <Field label={tt("الحساسية")}>
          <input className="input" value={form.allergies || ""} onChange={e=>set("allergies", e.target.value)}
                 {...dis(canEdit.medical)}/>
        </Field>
        <Field label={tt("الأدوية الحالية")}>
          <input className="input" value={form.medications || ""} onChange={e=>set("medications", e.target.value)}
                 {...dis(canEdit.medical)}/>
        </Field>
        <Field label={tt("التأمين")} span={2}>
          <input className="input" value={form.insurance_info || ""} onChange={e=>set("insurance_info", e.target.value)}
                 {...dis(canEdit.medical)}/>
        </Field>
        <Field label={tt("ملاحظات العلاج / متابعة الجلسات")} span={2}>
          <textarea className="input" style={{minHeight:70,padding:10,resize:"vertical"}}
                    value={form.notes || ""} onChange={e=>set("notes", e.target.value)}
                    {...dis(canEdit.therapy)}/>
        </Field>
      </div>
    </Modal>
  );
}

function strOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}
// Coerce a DB row into a friendly form shape. Guarantees every field the
// modal renders has a defined key so React never toggles between
// controlled/uncontrolled inputs.
function normalizePatientForForm(p) {
  return {
    name:            p.name || "",
    phone:           p.phone || "",
    whatsapp:        p.whatsapp || "",
    email:           p.email || "",
    age:             p.age != null ? String(p.age) : "",
    gender:          p.gender || "",
    date_of_birth:   p.date_of_birth ? String(p.date_of_birth).slice(0,10) : "",
    address:         p.address || "",
    occupation:      p.occupation || p.job || "",
    emergency_name:  p.emergency_name || "",
    emergency_phone: p.emergency_phone || "",
    doctor_id:       p.doctor_id || "",
    therapist_id:    p.therapist_id || "",
    diagnosis:       p.diagnosis || p.diag || "",
    medical_history: p.medical_history || "",
    allergies:       p.allergies || "",
    medications:     p.medications || p.meds || "",
    insurance_info:  p.insurance_info || "",
    notes:           p.notes || "",
    status:          p.status || "نشط",
    medical_file_no: p.medical_file_no || "",
    national_id:     p.national_id || "",
    dr:              p.dr || "",
    th:              p.th || "",
  };
}

// Roles allowed to open the "تعديل" (edit patient) action. Client-side UX
// gate only — Supabase RLS ("staff update patients") is the real
// enforcement. Every staff role can edit at least one section; the modal
// itself disables the individual fields a given role may not touch.
function canEditPatient(role) {
  return ["مدير", "موظف استقبال", "طبيب", "الأخصائي"].includes(role);
}

// ── PatientDetail ──────────────────────────────────────────────
function PatientDetail({ p: pIn, onBack, go }) {
  const [tab, setTab] = React.useState("نظرة عامة");
  const [schedOpen, setSchedOpen] = React.useState(false);
  // The edit modal is owned here so it renders over the profile page (the
  // Patients-list copy at line ~668 is unreachable from the detail view).
  const [editOpen, setEditOpen] = React.useState(false);
  const mayEdit = canEditPatient((window.ME && window.ME.role) || "");
  // Resolve the live record from DATA so edits (therapist, profile, …) reflect
  // across every section immediately; fall back to the passed snapshot.
  const pid = pIn.patient_id || pIn.id;
  const p = (DATA.patients || []).find(x => (x.patient_id || x.id) === pid) || pIn;
  // The patient's whole history, also from before the startup window
  // (docs/06 S9): merged into DATA, so every tab below shows it.
  window.useDataVersion && window.useDataVersion();
  const older = window.useOlderRows ? window.useOlderRows({ patientId: pid }) : { loading: false, error: "" };
  // Real per-patient figures (production rows carry no seed metadata).
  const mySessions = DATA.sessions.filter(s => s.patient_id === pid || s.patient === p.name);
  const pkgTotal = Number(((p.pkg || "").match(/(\d+)/) || [])[1]) || 12;
  const doneSessions = p.remain != null ? Math.max(0, pkgTotal - p.remain) : mySessions.length;
  const nextAppt = DATA.appts.find(a => (a.pid === pid || a.patient === p.name) && a.status !== "مكتمل" && a.status !== "ملغي");
  const avgPain = mySessions.length
    ? (mySessions.reduce((s, x) => s + (x.pain ?? x.pain_score ?? 0), 0) / mySessions.length).toFixed(1)
    : null;
  return (
    <Page>
      <div className="crumb" style={{cursor:"pointer"}} onClick={onBack}>
        <span>{tt("المرضى")}</span><I.Chevron size={11}/><span style={{color:"var(--ink-700)"}}>{p.name}</span>
      </div>

      {p.status === INCOMPLETE_STATUS && (
        <div style={{display:"flex",alignItems:"center",gap:10,padding:"12px 16px",marginTop:8,
          background:"#FBF3E6",border:"1px solid #F0D9A8",borderRadius:12,color:"#8A5A00"}}>
          <I.Bell size={16}/>
          <div style={{flex:1,fontSize:13,fontWeight:500}}>{tt("معلومات المريض غير مكتملة — أُنشئ هذا الملف عبر الحجز السريع. أكمل البيانات الناقصة.")}</div>
          {mayEdit && <button className="btn btn-secondary" style={{fontSize:12}} onClick={()=>setEditOpen(true)}>{tt("إكمال البيانات")}</button>}
        </div>
      )}
      {older.loading && <div className="muted" role="status" data-older="loading" style={{fontSize:12.5,marginTop:8}}>{tt("جارٍ تحميل السجل الأقدم…")}</div>}
      {older.error && <CaAlert tone="error">{older.error}</CaAlert>}

      <div className="rgrid c-lg" style={{"--gtc":"1fr 340px",gap:24,marginTop:8}}>
        <div>
          {/* hero */}
          <div className="card" style={{padding:24,display:"flex",alignItems:"flex-start",gap:18,marginBottom:18,position:"relative",overflow:"hidden",flexWrap:"wrap"}}>
            <div style={{position:"absolute",inset:0,background:"linear-gradient(120deg, var(--blue-100), transparent 60%)",opacity:.7,pointerEvents:"none"}}/>
            <div className="av lg" style={{width:64,height:64,fontSize:22,background:"var(--blue-700)",color:"#fff",position:"relative"}}>
              {p.name.split(" ").map(x=>x[0]).join("").slice(0,2)}
            </div>
            <div style={{flex:1,position:"relative",minWidth:220}}>
              <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                <h1 className="h1" style={{fontSize:24}}>{p.name}</h1>
                <span className={"badge " + (p.status===INCOMPLETE_STATUS?"b-amber":"b-green")}><span className="dot"></span>{tt(p.status)}</span>
                <span className="mono" style={{fontSize:11,color:"var(--ink-500)",border:"1px solid var(--ink-200)",padding:"2px 8px",borderRadius:6}}>{p.id}</span>
              </div>
              <div style={{display:"flex",gap:"8px 18px",marginTop:8,fontSize:12.5,color:"var(--ink-500)",flexWrap:"wrap"}}>
                <span style={{display:"flex",alignItems:"center",gap:6}}><I.User size={13}/> {[p.age ? tt("{n} سنة", { n: p.age }) : "", genderLabel(p.gender)].filter(Boolean).join(" · ") || "—"}</span>
                <span style={{display:"flex",alignItems:"center",gap:6}}><I.Phone size={13}/> <bdi dir="ltr">{p.phone}</bdi></span>
                <span style={{display:"flex",alignItems:"center",gap:6}}><I.MapPin size={13}/> {p.address || "—"}</span>
                <span style={{display:"flex",alignItems:"center",gap:6}}><I.Clock size={13}/> {ttx("سُجّل في {date}", { date: <bdi dir="ltr" className="mono">{p.registered}</bdi> })}</span>
              </div>
            </div>
            <div style={{display:"flex",gap:8,position:"relative",flexWrap:"wrap"}}>
              <button className="btn btn-secondary" onClick={()=>window.open(buildTelUrl(p.phone))}><I.Phone size={13}/> {tt("اتصال")}</button>
              <button className="btn btn-secondary" onClick={()=>window.open(buildWhatsAppUrl(p.phone, tt("مرحبًا+{name}", { name: p.name })),"_blank")}><I.WhatsApp size={13}/> {tt("واتساب")}</button>
              <WaReminderButton patient={p}/>
              <button className="btn btn-secondary" onClick={()=>setSchedOpen(true)}><I.Calendar size={13}/> {tt("الجدول الثابت")}</button>
              <button className="btn btn-blue" onClick={()=>go("appointments")}><I.Plus size={13}/> {tt("حجز")}</button>
              <RowMenu size={15} items={[
                ...(mayEdit ? [{ label:tt("تعديل"), icon:<I.Edit size={13}/>, onClick:()=>setEditOpen(true) }] : []),
                { label:tt("طباعة الملف"), icon:<I.Print size={13}/>, onClick:()=>window.print() },
                { label:tt("تصدير CSV"), icon:<I.Download size={13}/>, onClick:()=>{
                  const head=["ID",tt("الاسم"),tt("الهاتف"),tt("العمر"),tt("التشخيص"),tt("الحالة")].join(",");
                  const rows=[head,`${p.id},${p.name},${p.phone},${p.age},${p.diag||""},${p.status ? tt(p.status) : ""}`];
                  const blob=new Blob([rows.join("\n")],{type:"text/csv;charset=utf-8;"});
                  const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=`${p.id}.csv`;a.click();URL.revokeObjectURL(url);
                  if(window.showToast)window.showToast(tt("تم تصدير الملف"),"success");
                }},
                { label:tt("إرسال واتساب"), icon:<I.WhatsApp size={13}/>, onClick:()=>window.open(buildWhatsAppUrl(p.phone, tt("مرحبًا+{name}", { name: p.name })),"_blank") },
                { label:tt("حذف المريض"), icon:<I.X size={13}/>, danger:true, onClick:async ()=>{
                  if (!window.confirm(tt("حذف ملف {name}؟ لا يمكن التراجع.", { name: p.name }))) return;
                  try {
                    if (window.KineticData) await window.KineticData.remove("patients", p.patient_id || p.id);
                    if (window.showToast) window.showToast(tt("تم حذف المريض"),"success");
                    onBack && onBack();
                  } catch (e) { console.warn("delete patient failed", e); if (window.showToast) window.showToast(tt("تعذّر الحذف"),"error"); }
                }},
              ]}/>
            </div>
          </div>

          {/* tabs */}
          <div className="card" style={{padding:0,overflow:"hidden"}}>
            <div className="stepper" style={{borderBottom:"1px solid var(--ink-200)",padding:"0 18px",gap:4}}>
              {["نظرة عامة","السجل","خطة العلاج","الجلسات","الملفات","الفواتير"].map(t=>(
                <button key={t} onClick={()=>setTab(t)} style={{
                  border:"none",background:"transparent",padding:"14px 12px",
                  fontSize:13,fontWeight:500,whiteSpace:"nowrap",flexShrink:0,
                  color: tab===t?"var(--ink-900)":"var(--ink-500)",
                  borderBottom: tab===t?"2px solid var(--blue-500)":"2px solid transparent",
                  cursor:"pointer"
                }}>{tt(t)}</button>
              ))}
            </div>

            <div style={{padding:22}}>
              {tab==="نظرة عامة" && <PatientOverview p={p}/>}
              {tab==="السجل" && <PatientHistory p={p}/>}
              {tab==="خطة العلاج" && <PatientTreatmentPlan p={p}/>}
              {tab==="الجلسات" && <SessionTimeline mini p={p}/>}
              {tab==="الملفات" && <PatientFiles p={p}/>}
              {tab==="الفواتير" && <PatientInvoices p={p}/>}
            </div>
          </div>
        </div>

        {/* aside */}
        <div style={{display:"flex",flexDirection:"column",gap:18}}>
          <div className="card card-pad">
            <div className="h3" style={{marginBottom:12}}>{tt("تقدّم العلاج")}</div>
            <div style={{display:"flex",alignItems:"baseline",gap:8,marginBottom:8}}>
              <span className="mono" style={{fontSize:32,fontWeight:600}}>{doneSessions}</span>
              <span className="muted">{tt("من {n} Sessions", { n: pkgTotal })}</span>
            </div>
            <div style={{height:8,background:"var(--ink-100)",borderRadius:999,overflow:"hidden"}}>
              <div style={{height:"100%",width:`${Math.min(100, doneSessions/pkgTotal*100)}%`,background:"linear-gradient(90deg, var(--blue-500), var(--blue-700))",borderRadius:999}}/>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",marginTop:14,fontSize:12}}>
              <div><div className="muted">{tt("الجلسة القادمة")}</div><div style={{fontWeight:500}}>{nextAppt ? `${nextAppt.date || tt("اليوم")} ${nextAppt.time || ""}` : "—"}</div></div>
              <div style={{textAlign:"start"}}><div className="muted">{tt("الألم (متوسط)")}</div><div className="mono">{avgPain != null ? `${avgPain} / 10` : "—"}</div></div>
            </div>
          </div>

          <div className="card card-pad">
            <div className="h3" style={{marginBottom:12}}>{tt("البيانات الطبية")}</div>
            <InfoRow k={tt("الشكوى الرئيسية")} v={p.chief || "—"}/>
            <InfoRow k={tt("التشخيص")} v={p.diag || "—"}/>
            <InfoRow k={tt("أمراض مزمنة")} v={p.chronic.length ? p.chronic.join(", ") : "—"}/>
            <InfoRow k={tt("العمليات")} v={p.surgeries.length ? p.surgeries.join(", ") : tt("لا يوجد")}/>
          </div>

          <div className="card card-pad">
            <div className="h3" style={{marginBottom:12}}>{tt("فريق الرعاية")}</div>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
              <div className="av md" style={{background:"#7E6BD333",color:"#7E6BD3"}}>{initialsOf(p.dr) || "—"}</div>
              <div><div style={{fontSize:13,fontWeight:500}}>{p.dr || "—"}</div><div className="muted" style={{fontSize:11.5}}>{tt("الطبيب المسؤول")}</div></div>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <div className="av md" style={{background:"var(--blue-100)",color:"var(--blue-700)"}}>{initialsOf(p.th) || "—"}</div>
              <div><div style={{fontSize:13,fontWeight:500}}>{p.th || "—"}</div><div className="muted" style={{fontSize:11.5}}>{tt("الأخصائي الأساسي")}</div></div>
            </div>
          </div>

          <div className="card card-pad">
            <div className="h3" style={{marginBottom:12}}>{tt("إجراءات سريعة")}</div>
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              <button className="btn btn-secondary" style={{justifyContent:"flex-start"}} onClick={()=>window.print()}><I.FileText size={14}/> {tt("إنشاء تقرير تقدّم")}</button>
              <button className="btn btn-secondary" style={{justifyContent:"flex-start"}} onClick={()=>window.open(buildWhatsAppUrl(p.phone, tt("تذكير+موعدك+غدًا+الساعة+09:00")),"_blank")}><I.Send size={14}/> {tt("إرسال تذكير")}</button>
              <button className="btn btn-secondary" style={{justifyContent:"flex-start"}} onClick={()=>{
                const rows = [[tt("الاسم"),tt("رقم الملف"),tt("التشخيص"),tt("الطبيب"),tt("الأخصائي")].join(","), `${p.name},${p.id},${p.diag},${p.dr},${p.th}`];
                downloadCsv(rows, `patient-${p.id}.csv`);
                if (window.showToast) window.showToast(tt("تم تصدير السجل الطبي"), "success");
              }}><I.Download size={14}/> {tt("تصدير السجل الطبي")}</button>
            </div>
          </div>
        </div>
      </div>

      {schedOpen && <RecurringScheduleModal patient={p} onClose={()=>setSchedOpen(false)}/>}

      {editOpen && (
        <PatientEditModal
          patient={p}
          onClose={()=>setEditOpen(false)}
          onSaved={()=>setEditOpen(false)}
        />
      )}
    </Page>
  );
}

function InfoRow({ k, v }) {
  return (
    <div style={{display:"grid",gridTemplateColumns:"112px 1fr",gap:8,padding:"7px 0",borderBottom:"1px dashed var(--ink-100)",fontSize:12.5}}>
      <span className="muted">{k}</span>
      <span style={{color:"var(--ink-900)"}}>{v}</span>
    </div>
  );
}

function PatientOverview({ p }) {
  return (
    <div className="rgrid c-sm" style={{"--gtc":"1fr 1fr"}}>
      <div>
        <div className="h3" style={{marginBottom:10}}>{tt("البيانات الشخصية")}</div>
        <InfoRow k={tt("رقم الملف")} v={<span className="mono">{p.id}</span>}/>
        <InfoRow k={tt("الاسم الكامل")} v={p.name}/>
        <InfoRow k={tt("الهاتف")} v={p.phone}/>
        <InfoRow k={tt("العمر")} v={p.age ? tt("{n} سنة", { n: p.age }) : "—"}/>
        <InfoRow k={tt("الجنس")} v={genderLabel(p.gender) || "—"}/>
        <InfoRow k={tt("المهنة")} v={p.job}/>
        <InfoRow k={tt("العنوان")} v={p.address || "—"}/>
        <InfoRow k={tt("تاريخ التسجيل")} v={p.registered}/>
      </div>
      <div>
        <div className="h3" style={{marginBottom:10}}>{tt("اللمحة السريرية")}</div>
        <div style={{padding:14,background:"var(--blue-50)",border:"1px solid var(--blue-100)",borderRadius:12,marginBottom:14}}>
          <div className="serif" style={{fontSize:18,lineHeight:1.4,color:"var(--ink-900)"}}>"{p.chief || p.diag || "—"}"</div>
          <div className="muted" style={{fontSize:11.5,marginTop:6}}>{tt("الشكوى الرئيسية / التشخيص")}</div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
          {(() => {
            // Real per-patient metrics only — no fabricated clinical numbers.
            const pid = p.patient_id || p.id;
            const sess = DATA.sessions.filter(s => s.patient_id === pid || s.patient === p.name);
            const latest = sess[0];
            return [
              {l:tt("مستوى الألم (آخر جلسة)"), v: latest ? `${latest.pain ?? latest.pain_score ?? "—"}/10` : "—", sub: latest ? latest.date : tt("لا جلسات بعد")},
              {l:tt("جلسات مسجلة"), v: String(sess.length), sub: sess.length ? tt("آخرها {date}", { date: latest.date }) : "—"},
              {l:tt("آخر زيارة"), v: p.visited && p.visited !== "—" ? p.visited : (latest ? latest.date : "—"), sub: ""},
              {l:tt("الحالة"), v: p.status ? tt(p.status) : "—", sub: p.payment && p.payment !== "—" ? tt("الدفع: {status}", { status: tt(p.payment) }) : ""},
            ];
          })().map((m,i)=>(
            <div key={i} style={{padding:12,border:"1px solid var(--ink-200)",borderRadius:10}}>
              <div className="muted" style={{fontSize:11}}>{m.l}</div>
              <div className="mono" style={{fontSize:18,fontWeight:600,marginTop:2}}>{m.v}</div>
              <div style={{fontSize:11,color:"var(--green)"}}>{m.sub}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function PatientHistory({ p }) {
  // Timeline built from the patient's real records: logged sessions +
  // the registration event. No fabricated entries.
  const pid = p ? (p.patient_id || p.id) : null;
  const sess = p ? DATA.sessions.filter(s => s.patient_id === pid || s.patient === p.name) : [];
  const events = sess.map(s => ({
    date: s.date || "",
    type: "جلسة",
    title: tt("الجلسة #{n}", { n: s.session ?? s.session_number ?? "—" }),
    by: s.therapist || "—",
    body: s.notes || s.session_notes || "",
  }));
  if (p && (p.registered || p.created_at)) {
    events.push({
      date: p.registered || String(p.created_at).slice(0, 10),
      type: "booking",
      title: tt("تسجيل المريض"),
      by: tt("الاستقبال"),
      body: p.notes || "",
    });
  }
  events.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  if (events.length === 0) {
    return <EmptyState icon={<I.Clock size={22}/>} title={tt("لا سجل بعد")} body={tt("سيظهر السجل الزمني هنا بعد تسجيل الجلسات.")}/>;
  }
  return (
    <div>
      <div style={{marginBottom:14}}>
        <div className="h3">{tt("السجل الزمني")}</div>
      </div>
      <div style={{position:"relative",paddingInlineEnd:24}}>
        <div style={{position:"absolute",insetInlineEnd:9,top:8,bottom:8,width:2,background:"var(--ink-100)"}}/>
        {events.map((e,i)=>{
          const dotColor = e.type==="جلسة"?"var(--blue-500)":e.type==="intake"?"var(--green)":e.type==="booking"?"var(--violet)":"var(--amber)";
          return (
            <div key={i} style={{position:"relative",paddingBottom:18}}>
              <div style={{position:"absolute",insetInlineEnd:-19,top:5,width:14,height:14,borderRadius:999,background:dotColor,border:"3px solid #fff",boxShadow:"0 0 0 1px var(--ink-200)"}}/>
              <div style={{display:"flex",alignItems:"baseline",gap:10,marginBottom:3}}>
                <span style={{fontWeight:600,fontSize:13.5}}>{e.title}</span>
                <span className="muted mono" style={{fontSize:11}}>{e.date}</span>
              </div>
              <div className="muted" style={{fontSize:12.5,marginBottom:3}}>{tt("بواسطة {name}", { name: e.by })}</div>
              <div style={{fontSize:13,color:"var(--ink-700)"}}>{e.body}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PatientTreatmentPlan({ p, t: tIn }) {
  window.useDataVersion && window.useDataVersion();
  // The saved treatments row is the ONLY source of truth. When rendered
  // from the patient profile without a record, fetch the patient's active
  // plan from the database. Nothing here is placeholder data — a missing
  // plan renders an honest empty state.
  const pid = (p && (p.patient_id || p.id)) || (tIn && tIn.patient_id) || null;
  const [t, setT] = React.useState(tIn || null);
  const [loading, setLoading] = React.useState(true);
  const [editing, setEditing] = React.useState(null);
  const [thPick, setThPick] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  const reload = React.useCallback(async () => {
    if (!window.TreatmentsAPI) { setLoading(false); return; }
    try {
      if (tIn && tIn.treatment_id) {
        const fresh = await window.TreatmentsAPI.get(tIn.treatment_id);
        if (fresh) setT(fresh);
      } else if (pid) {
        const active = await window.TreatmentsAPI.activeFor(pid);
        setT(active || null);
      }
    } catch (e) { console.warn("load treatment failed", e); }
    setLoading(false);
  }, [tIn && tIn.treatment_id, pid]);
  React.useEffect(() => {
    reload();
    const onUpd = () => reload();
    window.addEventListener("kinetic:treatments-updated", onUpd);
    return () => window.removeEventListener("kinetic:treatments-updated", onUpd);
  }, [reload]);

  // Persist a partial payload onto THIS treatment record only — other
  // patients' plans are never touched (update_treatment RPC updates a
  // single treatments row by primary key).
  async function persist(payload, okMsg) {
    if (!t || !window.TreatmentsAPI) return false;
    const res = await window.TreatmentsAPI.update(t.treatment_id, payload);
    if (res && res.ok === false) {
      window.showToast && window.showToast(tt(res.error || "تعذّر الحفظ"), "error");
      return false;
    }
    window.dispatchEvent(new CustomEvent("kinetic:treatments-updated"));
    if (okMsg && window.showToast) window.showToast(okMsg, "success");
    return true;
  }

  const goals = (t && Array.isArray(t.goals) ? t.goals : []).map(g =>
    typeof g === "string" ? { g, done: false } : { g: g.g || g.text || "", done: !!g.done });
  const methods = (t && Array.isArray(t.methods) ? t.methods : []).map(m => (m && (m.name || m)) || "").filter(Boolean);
  const exercises = (t && Array.isArray(t.exercises) ? t.exercises : []);
  const total = t ? (Number(t.estimated_sessions) || 0) : 0;
  const completed = t ? (Number(t.completed_sessions) || 0) : 0;
  const remaining = Math.max(0, total - completed);
  const progress = total ? Math.min(100, Math.round(completed / total * 100)) : 0;
  const thName = (t && (t.therapist_name || t.therapist_id)) || (p && p.th && p.th !== "—" ? p.th : "") || "—";
  const thRow = (DATA.therapists || []).find(x => x.name === thName || (t && x.id === t.therapist_id));
  const doctorName = (p && p.dr && p.dr !== "—") ? p.dr : null;

  async function toggleGoal(i) {
    const next = goals.map((g, idx) => idx === i ? { ...g, done: !g.done } : g);
    setT(prev => prev ? { ...prev, goals: next } : prev);
    await persist({ goals: next });
  }

  // Assign the treating therapist — persists onto the treatment record AND
  // the patient record so lists and the care team reflect it everywhere.
  async function chooseTherapist(row) {
    setThPick(false);
    if (t) await persist({ therapist_id: row.id }, tt("تم تعيين الأخصائي"));
    if (pid && window.KineticData) {
      try { await window.KineticData.upsert("patients", { patient_id: pid, id: pid, therapist_id: row.id, th: row.name }); }
      catch (e) { console.warn("assign therapist failed", e); }
    }
  }

  function openEditor() {
    if (!t) return;
    setEditing({
      diagnosis: t.diagnosis || "",
      body_part: t.body_part || "",
      goals: goals.map(g => ({ ...g })),
      methods: methods.slice(),
      notes: t.notes || "",
      home_instructions: t.home_instructions || "",
      warnings: t.warnings || "",
      followup_instructions: t.followup_instructions || "",
      estimated_sessions: String(total || ""),
      weekly_frequency: t.weekly_frequency != null ? String(t.weekly_frequency) : "",
    });
  }
  async function saveEditor() {
    if (!editing || !t) return;
    setSaving(true);
    const ok = await persist({
      diagnosis: editing.diagnosis,
      body_part: editing.body_part,
      goals: editing.goals.map(g => ({ g: g.g.trim(), done: !!g.done })).filter(g => g.g),
      methods: editing.methods.map(m => m.trim()).filter(Boolean),
      notes: editing.notes,
      home_instructions: editing.home_instructions,
      warnings: editing.warnings,
      followup_instructions: editing.followup_instructions,
      estimated_sessions: editing.estimated_sessions === "" ? "" : String(parseInt(editing.estimated_sessions, 10) || 0),
      weekly_frequency: editing.weekly_frequency === "" ? "" : String(parseInt(editing.weekly_frequency, 10) || 0),
    }, tt("تم حفظ خطة العلاج"));
    setSaving(false);
    if (ok) setEditing(null);
  }

  if (loading && !t) {
    return <div className="muted" style={{fontSize:13,padding:"20px 0"}}>{tt("جارٍ تحميل خطة العلاج…")}</div>;
  }
  if (!t) {
    return (
      <EmptyState icon={<I.Clipboard size={22}/>} title={tt("لا خطة علاج نشطة")}
        body={tt("أنشئ خطة علاج للمريض من شاشة «خطط العلاج» (يدويًا أو من قالب) لتظهر تفاصيلها هنا وتُستخدم في الجلسات.")}/>
    );
  }

  return (
    <div>
      <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap",marginBottom:14}}>
        <div className="h3" style={{margin:0}}>{t.name || tt("خطة العلاج النشطة")}</div>
        <span className={"badge " + (t.status==="completed"?"b-green":t.status==="cancelled"?"b-grey":"b-blue")}>
          <span className="dot"></span>{t.status==="completed"?tt("مكتملة"):t.status==="cancelled"?tt("ملغاة"):t.status==="draft"?tt("مسودة"):tt("نشطة")}
        </span>
        {t.template_name && (
          <span className="muted" style={{fontSize:11.5}}>
            {tt("نسخة مستقلة من قالب «{name}» — تعديلها لا يغيّر القالب.", { name: t.template_name })}
          </span>
        )}
      </div>

      {/* Sessions progress — completed_sessions is maintained by the DB
          trigger from the linked sessions. */}
      <div className="card" style={{padding:14,marginBottom:16,display:"flex",alignItems:"center",gap:18,flexWrap:"wrap"}}>
        <div style={{flex:"1 1 220px"}}>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:12,marginBottom:6}}>
            <span className="muted">{tt("تقدّم الجلسات")}</span>
            <span className="mono">{progress}%</span>
          </div>
          <div style={{height:7,background:"var(--ink-100)",borderRadius:999,overflow:"hidden"}}>
            <div style={{height:"100%",width:`${progress}%`,background:progress>=100?"var(--green)":"var(--blue-500)"}}/>
          </div>
        </div>
        <div style={{display:"flex",gap:18,fontSize:12.5}}>
          <div><div className="muted" style={{fontSize:11}}>{tt("الإجمالي")}</div><div className="mono" style={{fontWeight:600}}>{total || "—"}</div></div>
          <div><div className="muted" style={{fontSize:11}}>{tt("مكتملة")}</div><div className="mono" style={{fontWeight:600,color:"var(--green)"}}>{completed}</div></div>
          <div><div className="muted" style={{fontSize:11}}>{tt("متبقية")}</div><div className="mono" style={{fontWeight:600,color:"var(--blue-700)"}}>{total ? remaining : "—"}</div></div>
          <div><div className="muted" style={{fontSize:11}}>{tt("التكرار")}</div><div className="mono" style={{fontWeight:600}}>{t.weekly_frequency ? tt("{n}/أسبوع", { n: t.weekly_frequency }) : "—"}</div></div>
        </div>
      </div>

      <div className="rgrid c-lg" style={{"--gtc":"1.4fr 1fr"}}>
        <div>
          <div className="label">{tt("أهداف الخطة")}</div>
          <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:18}}>
            {goals.length===0 && <div className="muted" style={{fontSize:12.5,padding:"6px 0"}}>{tt("لا أهداف بعد — أضفها من «تعديل الخطة».")}</div>}
            {goals.map((g,i)=>(
              <label key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 10px",border:"1px solid var(--ink-200)",borderRadius:10,fontSize:13,cursor:"pointer"}}>
                <input type="checkbox" checked={g.done} onChange={()=>toggleGoal(i)}/>
                <span style={{flex:1,textDecoration:g.done?"line-through":"none",color:g.done?"var(--ink-500)":"var(--ink-900)"}}>{g.g}</span>
              </label>
            ))}
          </div>

          <div className="label">{tt("طرق العلاج")}</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:18}}>
            {methods.length===0 && <span className="muted" style={{fontSize:12.5}}>—</span>}
            {methods.map(m=>(
              <span key={m} className="pill tag-blue">{m}</span>
            ))}
          </div>

          {exercises.length > 0 && (
            <>
              <div className="label">{tt("التمارين ({n})", { n: exercises.length })}</div>
              <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:18}}>
                {exercises.map((e,i)=>(
                  <div key={i} style={{padding:"8px 10px",border:"1px solid var(--ink-200)",borderRadius:10,fontSize:12.5}}>
                    <strong>{i+1}. {e.name || e.title || (typeof e === "string" ? e : "—")}</strong>
                    {e.description && <div className="muted" style={{fontSize:11.5,marginTop:2}}>{e.description}</div>}
                    <div className="muted" style={{fontSize:11.5,marginTop:2}}>
                      {[e.sets && tt("{n} مجموعات", { n: e.sets }), e.reps && tt("{n} عدّات", { n: e.reps }), e.duration && tt("مدّة {v}", { v: e.duration }),
                        e.hold_time && tt("ثبات {v}", { v: e.hold_time }), e.rest_time && tt("راحة {v}", { v: e.rest_time }), e.equipment].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {t.home_instructions && (
            <>
              <div className="label">{tt("البرنامج المنزلي")}</div>
              <div style={{padding:14,background:"var(--blue-50)",border:"1px solid var(--blue-100)",borderRadius:12,fontSize:13,lineHeight:1.55,whiteSpace:"pre-wrap",marginBottom:18}}>
                {t.home_instructions}
              </div>
            </>
          )}
          {t.warnings && (
            <>
              <div className="label" style={{color:"#A8443A"}}>{tt("تحذيرات")}</div>
              <div style={{padding:14,background:"#FDF1F0",border:"1px solid #F2CBC7",borderRadius:12,fontSize:13,lineHeight:1.55,whiteSpace:"pre-wrap",marginBottom:18}}>
                {t.warnings}
              </div>
            </>
          )}
          {t.followup_instructions && (
            <>
              <div className="label">{tt("تعليمات المتابعة")}</div>
              <div style={{padding:14,background:"var(--ink-50)",borderRadius:12,fontSize:13,lineHeight:1.55,whiteSpace:"pre-wrap",marginBottom:18}}>
                {t.followup_instructions}
              </div>
            </>
          )}

          <div className="label">{tt("ملاحظات إكلينيكية")}</div>
          <div style={{padding:14,background:"var(--ink-50)",borderRadius:12,fontSize:13,lineHeight:1.55,whiteSpace:"pre-wrap"}}>
            {t.notes || "—"}
          </div>
        </div>
        <div>
          <div className="label">{tt("الأخصائي المسؤول")}</div>
          <div style={{display:"flex",alignItems:"center",gap:10,padding:12,border:"1px solid var(--ink-200)",borderRadius:10,marginBottom:14}}>
            <div className="av md" style={{background:"var(--blue-100)",color:"var(--blue-700)"}}>{thName !== "—" ? initialsOf(thName) : "—"}</div>
            <div style={{flex:1}}>
              <div style={{fontSize:13,fontWeight:500}}>{thName}</div>
              <div className="muted" style={{fontSize:11.5}}>{(thRow && thRow.spec) || ""}</div>
            </div>
            <button className="btn btn-ghost btn-icon" onClick={()=>setThPick(true)} aria-label={tt("تغيير الأخصائي")} title={tt("تغيير الأخصائي")}><I.Edit size={13}/></button>
          </div>
          {doctorName && (
            <>
              <div className="label">{tt("الطبيب")}</div>
              <div style={{padding:12,border:"1px solid var(--ink-200)",borderRadius:10,fontSize:13,marginBottom:14}}>{doctorName}</div>
            </>
          )}

          <div className="label">{tt("التشخيص")}</div>
          <div style={{padding:12,border:"1px solid var(--ink-200)",borderRadius:10,fontSize:13,marginBottom:14}}>
            {t.diagnosis || "—"}
            {t.body_part && <div className="muted" style={{fontSize:11.5,marginTop:4}}>{tt("الجزء المستهدف: {v}", { v: t.body_part })}</div>}
            {t.category && <div className="muted" style={{fontSize:11.5,marginTop:2}}>{tt("الفئة: {v}", { v: t.category })}</div>}
          </div>

          {/* Session timing lives on the APPOINTMENTS — a session simply
              starts when its appointment starts. No fixed session time. */}
          <div className="label">{tt("مواعيد الجلسات")}</div>
          <div style={{padding:12,border:"1px solid var(--ink-200)",borderRadius:10,fontSize:12.5,lineHeight:1.6,marginBottom:14,color:"var(--ink-500)"}}>
            {tt("توقيت كل جلسة يأتي من موعدها في التقويم — الجلسة تبدأ ببداية الموعد.")}
            {t.start_date ? <div style={{marginTop:4}}>{ttx("بداية الخطة: {date}", { date: <span className="mono">{t.start_date}</span> })}</div> : null}
          </div>

          <div className="label">{tt("سجل الإنشاء")}</div>
          <div style={{padding:12,border:"1px solid var(--ink-200)",borderRadius:10,fontSize:12,lineHeight:1.7,marginBottom:14}}>
            <div><span className="muted">{tt("أنشأها:")} </span>{t.created_by_name || "—"}
              {t.created_at ? <span className="muted"> · {fmtDate(t.created_at, NUMERIC_DATE)}</span> : null}</div>
            <div><span className="muted">{tt("آخر تحديث:")} </span>{t.updated_by_name || "—"}
              {t.updated_at ? <span className="muted"> · {fmtDate(t.updated_at, NUMERIC_DATE)}</span> : null}</div>
          </div>

          <button className="btn btn-blue" style={{width:"100%",justifyContent:"center"}} onClick={openEditor}>
            <I.Edit size={13}/> {tt("تعديل الخطة")}
          </button>
          <div className="muted" style={{fontSize:11,marginTop:6,textAlign:"center"}}>
            {tt("التعديل يخص خطة هذا المريض فقط — لا يغيّر القالب ولا خطط المرضى الآخرين.")}
          </div>
        </div>
      </div>

      {thPick && (
        <Modal title={tt("تغيير الأخصائي المعالج")} onClose={()=>setThPick(false)}
          footer={<button className="btn btn-ghost" onClick={()=>setThPick(false)}>{tt("إغلاق")}</button>}>
          {(DATA.therapists||[]).length===0
            ? <EmptyState icon={<I.Users size={22}/>} title={tt("لا أخصائيين بعد")} body={tt("أضف الأخصائيين من الإعدادات.")}/>
            : <div style={{display:"flex",flexDirection:"column",gap:8}}>
                {(DATA.therapists||[]).map(row=>{
                  const on = thName === row.name;
                  return (
                    <button key={row.id||row.name} onClick={()=>chooseTherapist(row)}
                      style={{display:"flex",alignItems:"center",gap:12,padding:"10px 12px",borderRadius:12,cursor:"pointer",
                        border:`1px solid ${on?"var(--blue-500)":"var(--ink-200)"}`,background:on?"var(--blue-50)":"#fff",textAlign:"start"}}>
                      <div className="av md" style={{background:(row.color||"#7BBDE8")+"33",color:row.color||"var(--blue-700)"}}>{initialsOf(row.name)}</div>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:13,fontWeight:600}}>{row.name}</div>
                        <div className="muted" style={{fontSize:11.5}}>{row.spec}{row.max!=null ? " · " + tt("حمل {load}/{max}", { load: row.load, max: row.max }) : ""}</div>
                      </div>
                      {on && <I.Check size={16} style={{color:"var(--blue-700)"}}/>}
                    </button>
                  );
                })}
              </div>}
        </Modal>
      )}

      {editing && (
        <Modal title={tt("تعديل خطة العلاج (نسخة المريض فقط)")} onClose={()=>setEditing(null)} width={640}
          footer={<>
            <button className="btn btn-ghost" onClick={()=>setEditing(null)}>{tt("إلغاء")}</button>
            <button className="btn btn-blue" disabled={saving} onClick={saveEditor}><I.Check size={13}/> {saving ? tt("جارٍ الحفظ…") : tt("حفظ")}</button>
          </>}>
          <div className="rgrid c-sm" style={{"--gtc":"1fr 1fr",gap:10}}>
            <Field label={tt("التشخيص")}>
              <window.DiagnosisAutocomplete value={editing.diagnosis}
                onChange={e=>setEditing({...editing, diagnosis:e.target.value})}/>
            </Field>
            <Field label={tt("الجزء المستهدف")}>
              <input className="input" value={editing.body_part} onChange={e=>setEditing({...editing, body_part:e.target.value})}/>
            </Field>
          </div>

          <div style={{height:14}}/>
          <div className="label">{tt("أهداف الخطة")}</div>
          <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:6}}>
            {editing.goals.map((g,i)=>(
              <div key={i} style={{display:"flex",alignItems:"center",gap:8}}>
                <input type="checkbox" checked={g.done}
                  onChange={()=>setEditing({...editing, goals: editing.goals.map((x,ix)=> ix===i ? {...x, done:!x.done} : x)})}/>
                <input className="input" value={g.g} placeholder={tt("اكتب هدفًا…")}
                  onChange={e=>setEditing({...editing, goals: editing.goals.map((x,ix)=> ix===i ? {...x, g:e.target.value} : x)})}/>
                <button className="btn btn-ghost btn-icon" aria-label={tt("حذف")}
                  onClick={()=>setEditing({...editing, goals: editing.goals.filter((_,ix)=>ix!==i)})}>
                  <I.Trash size={13}/>
                </button>
              </div>
            ))}
          </div>
          <button className="btn btn-secondary" style={{marginBottom:14}}
            onClick={()=>setEditing({...editing, goals:[...editing.goals, {g:"", done:false}]})}>
            <I.Plus size={13}/> {tt("إضافة هدف")}
          </button>

          <div className="label">{tt("طرق العلاج")}</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:8}}>
            {editing.methods.map((m,i)=>(
              <span key={i} className="pill tag-blue" style={{gap:4}}>
                {m}
                <button type="button" onClick={()=>setEditing({...editing, methods: editing.methods.filter((_,ix)=>ix!==i)})}
                  style={{background:"none",border:"none",color:"inherit",cursor:"pointer",padding:0,display:"inline-flex"}} aria-label={tt("إزالة")}>
                  <I.X size={12}/>
                </button>
              </span>
            ))}
          </div>
          <ModalityAdder onAdd={m=>setEditing({...editing, methods:[...editing.methods, m]})}/>

          <div style={{height:14}}/>
          <div className="rgrid c-sm" style={{"--gtc":"1fr 1fr",gap:10}}>
            <Field label={tt("إجمالي الجلسات")}><input className="input" type="number" min="0" value={editing.estimated_sessions}
              onChange={e=>setEditing({...editing, estimated_sessions:e.target.value})}/></Field>
            <Field label={tt("التكرار الأسبوعي")}><input className="input" type="number" min="0" value={editing.weekly_frequency}
              onChange={e=>setEditing({...editing, weekly_frequency:e.target.value})}/></Field>
          </div>

          <div style={{height:14}}/>
          <Field label={tt("البرنامج المنزلي")}>
            <textarea className="input" rows={3} style={{padding:10,resize:"vertical"}}
              value={editing.home_instructions} onChange={e=>setEditing({...editing, home_instructions:e.target.value})}/>
          </Field>
          <Field label={tt("تحذيرات")}>
            <textarea className="input" rows={2} style={{padding:10,resize:"vertical"}}
              value={editing.warnings} onChange={e=>setEditing({...editing, warnings:e.target.value})}/>
          </Field>
          <Field label={tt("تعليمات المتابعة")}>
            <textarea className="input" rows={2} style={{padding:10,resize:"vertical"}}
              value={editing.followup_instructions} onChange={e=>setEditing({...editing, followup_instructions:e.target.value})}/>
          </Field>
          <Field label={tt("ملاحظات إكلينيكية")}>
            <textarea className="input" rows={4} style={{padding:10,resize:"vertical"}}
              value={editing.notes} onChange={e=>setEditing({...editing, notes:e.target.value})}/>
          </Field>
        </Modal>
      )}
    </div>
  );
}

function ModalityAdder({ onAdd }) {
  const [v, setV] = React.useState("");
  function submit(){
    const t = v.trim();
    if (!t) return;
    onAdd(t);
    setV("");
  }
  return (
    <div style={{display:"flex",gap:6}}>
      <input className="input" placeholder={tt("أضف طريقة علاج…")} value={v}
        onChange={e=>setV(e.target.value)}
        onKeyDown={e=>{ if (e.key==="Enter") { e.preventDefault(); submit(); } }}/>
      <button className="btn btn-secondary" onClick={submit} aria-label={tt("إضافة طريقة العلاج")}><I.Plus size={13}/></button>
    </div>
  );
}

// Patient documents — backed by the normalized `patient_files` table via
// window.listPatientFiles / uploadPatientFile (Supabase Storage + LS fallback).
function PatientFiles({ p }) {
  const pid = (p && (p.patient_id || p.id)) || null;
  const fileRef = React.useRef(null);
  const [files, setFiles] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);
  const [uploading, setUploading] = React.useState(false);

  const reload = React.useCallback(async () => {
    if (!pid) { setFiles([]); setLoading(false); return; }
    setLoading(true); setError(null);
    try {
      const rows = window.listPatientFiles ? await window.listPatientFiles(pid) : [];
      setFiles(Array.isArray(rows) ? rows : []);
    } catch (e) {
      console.warn("load patient files failed", e);
      setError(tt("تعذّر تحميل الملفات"));
    } finally { setLoading(false); }
  }, [pid]);

  React.useEffect(() => { reload(); }, [reload]);
  React.useEffect(() => {
    const h = () => reload();
    window.addEventListener("kinetic:patient-files-updated", h);
    return () => window.removeEventListener("kinetic:patient-files-updated", h);
  }, [reload]);

  async function handleUpload(e) {
    const list = Array.from(e.target.files || []);
    e.target.value = "";
    if (!list.length || !pid) return;
    setUploading(true);
    let ok = 0; let firstErr = null;
    try {
      for (const f of list) {
        if (!window.uploadPatientFile) break;
        const res = await window.uploadPatientFile(pid, f);
        if (res && res.ok) ok++;
        else if (!firstErr && res && res.error) firstErr = res.error;
      }
      if (window.showToast) {
        if (ok) window.showToast(tt("تم رفع {n} ملف", { n: ok }), "success");
        if (firstErr) window.showToast(tt(firstErr), "error");
      }
    } finally { setUploading(false); reload(); }
  }

  async function resolveUrl(f) {
    if (window.getPatientFileUrl) return await window.getPatientFileUrl(f);
    return window.safeUrl(f.file_url);
  }
  async function openFile(f) {
    const url = await resolveUrl(f);
    if (url) { window.open(url, "_blank"); return; }
    if (window.showToast) window.showToast(tt("لا يوجد ملف متاح للعرض"), "error");
  }
  async function downloadFile(f) {
    const url = await resolveUrl(f);
    if (!url) { if (window.showToast) window.showToast(tt("لا يوجد ملف للتنزيل"), "error"); return; }
    const a = document.createElement("a");
    a.href = url; a.download = f.original_name || f.file_name || "file"; a.target = "_blank";
    a.click();
    if (window.showToast) window.showToast(tt("تم فتح {name}", { name: f.file_name }), "success");
  }
  const mimeOf = (f) => (f.mime_type || f.file_type || "").toLowerCase();
  const isImage = (f) => mimeOf(f).startsWith("image/") || /\.(jpe?g|png|webp|gif|bmp)$/i.test(f.file_name || "");
  const kindLabel = (f) => {
    const n = (f.file_name || "").toLowerCase();
    const m = mimeOf(f);
    if (m.startsWith("image/") || /\.(jpe?g|png|webp|gif|bmp)$/i.test(n)) return tt("صورة");
    if (n.endsWith(".pdf") || m === "application/pdf") return "PDF";
    if (n.endsWith(".dcm") || m === "application/dicom") return "DICOM";
    return tt("مستند");
  };
  function fmtSize(n) {
    const b = Number(n) || 0;
    if (!b) return "";
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  }

  return (
    <div>
      <input ref={fileRef} type="file" multiple style={{ display: "none" }}
        accept="image/*,application/pdf,.pdf,.doc,.docx,.dcm,.xls,.xlsx,.txt" onChange={handleUpload} />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
        <div className="h3">{tt("ملفات المريض")} {files.length > 0 && <span className="muted mono" style={{ fontSize: 12 }}>({files.length})</span>}</div>
        <button className="btn btn-blue" disabled={uploading || !pid} onClick={() => fileRef.current && fileRef.current.click()}>
          {uploading ? <span className="spin" style={{ width: 13, height: 13, border: "2px solid #fff", borderTopColor: "transparent", borderRadius: "50%" }} /> : <I.Upload size={13} />}
          {uploading ? tt("جارٍ الرفع…") : tt("رفع ملف")}
        </button>
      </div>

      {/* Upload zone */}
      <div style={{
        border: "2px dashed var(--blue-300)", background: "var(--blue-50)", borderRadius: 14,
        padding: "22px 18px", display: "flex", alignItems: "center", gap: 14, marginBottom: 18, flexWrap: "wrap"
      }}>
        <div style={{ width: 42, height: 42, borderRadius: 11, background: "#fff", border: "1px solid var(--blue-300)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--blue-700)" }}>
          <I.Upload size={18} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 500, fontSize: 13.5 }}>{tt("أفلت الأشعة أو صور الرنين أو التقارير أو الصور هنا")}</div>
          <div className="muted" style={{ fontSize: 12 }}>{tt("JPG, PNG, PDF, DICOM · متعدد")}</div>
        </div>
        <button className="btn btn-secondary" onClick={() => fileRef.current && fileRef.current.click()}>{tt("تصفّح الملفات")}</button>
      </div>

      {loading ? (
        <div className="grid-3">
          {[0, 1, 2].map(i => (
            <div key={i} className="card" style={{ padding: 0, overflow: "hidden" }}>
              <div className="skel" style={{ height: 120, borderRadius: 0 }} />
              <div style={{ padding: 12 }}><div className="skel" style={{ height: 12, width: "70%" }} /></div>
            </div>
          ))}
        </div>
      ) : error ? (
        <EmptyState icon={<I.X size={22} />} title={tt("تعذّر تحميل الملفات")} body={error}
          action={<button className="btn btn-secondary" onClick={reload}>{tt("إعادة المحاولة")}</button>} />
      ) : files.length === 0 ? (
        <EmptyState icon={<I.FileText size={22} />} title={tt("لا توجد ملفات بعد")}
          body={tt("ارفع الأشعة أو التقارير أو الصور لتظهر هنا.")} />
      ) : (
        <div className="grid-3">
          {files.map((f) => (
            <div key={f.file_id} className="card" style={{ padding: 0, overflow: "hidden" }}>
              <div className="ph" style={{ height: 120, borderRadius: 0, borderBottom: "1px solid var(--blue-100)", cursor: f.file_url ? "pointer" : "default", padding: 0, overflow: "hidden" }}
                onClick={() => f.file_url && openFile(f)}>
                {isImage(f) && f.file_url
                  ? <img src={f.file_url} alt={f.file_name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  : `${kindLabel(f)} preview`}
              </div>
              <div style={{ padding: 12, display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 32, height: 32, borderRadius: 8, background: "var(--blue-100)", color: "var(--blue-700)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <I.FileText size={15} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.original_name || f.file_name}</div>
                  <div className="muted mono" style={{ fontSize: 11 }}>
                    {kindLabel(f)}
                    {f.file_size ? ` · ${fmtSize(f.file_size)}` : ""}
                    {f.uploaded_at ? ` · ${(f.uploaded_at || "").slice(0, 10)}` : ""}
                  </div>
                  {f.uploaded_by_name ? (
                    <div className="muted" style={{ fontSize: 10.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {tt("رفعه: {name}", { name: f.uploaded_by_name })}
                    </div>
                  ) : null}
                </div>
                <button className="btn btn-ghost btn-icon" title={tt("تحميل / فتح")} onClick={() => downloadFile(f)}><I.Download size={14} /></button>
                <RowMenu size={13} items={[
                  { label: tt("فتح"), icon: <I.Eye size={13} />, onClick: () => openFile(f) },
                  { label: tt("تحميل"), icon: <I.Download size={13} />, onClick: () => downloadFile(f) },
                  { label: tt("حذف"), icon: <I.Trash size={13} />, danger: true, onClick: async () => {
                    if (!window.confirm(tt("حذف {name}؟", { name: f.file_name }))) return;
                    const res = window.removePatientFile ? await window.removePatientFile(f.file_id) : { ok: false, error: "غير متاح" };
                    if (res && res.ok) { if (window.showToast) window.showToast(tt("تم حذف الملف"), "success"); }
                    else { if (window.showToast) window.showToast(tt((res && res.error) || "تعذّر الحذف"), "error"); }
                  } },
                ]} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PatientInvoices({ p }) {
  const [newInvoiceOpen, setNewInvoiceOpen] = React.useState(false);
  const pid = p.patient_id || p.id;
  const invoices = DATA.payments.filter(x => x.patient === p.name || x.patient_id === pid);
  return (
    <div>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
        <div className="h3">{tt("سجل الفواتير")}</div>
        <button className="btn btn-blue" onClick={()=>setNewInvoiceOpen(true)}><I.Plus size={13}/> {tt("فاتورة جديدة")}</button>
      </div>
      <div className="tbl-scroll">
      <CardTable>
        <thead><tr><th>{tt("فاتورة")}</th><th>{tt("التاريخ")}</th><th>{tt("المبلغ")}</th><th>{tt("مدفوع")}</th><th>{tt("الطريقة")}</th><th>{tt("الحالة")}</th><th><span className="sr-only">{tt("إجراءات")}</span></th></tr></thead>
        <tbody>
          {invoices.length ? invoices.map(inv=>(
            <tr key={inv.id}>
              <td className="mono">{inv.id}</td>
              <td>{inv.date}</td>
              <td className="mono">{fmtMoney(inv.amount)}</td>
              <td className="mono">{fmtMoney(inv.paid)}</td>
              <td>{tt(inv.method)}</td>
              <td><PayBadge s={inv.status}/></td>
              <td><button className="btn btn-ghost btn-icon" aria-label={tt("تحميل الفاتورة {id}", { id: inv.id })} onClick={()=>{
                const head = [tt("فاتورة"),tt("التاريخ"),tt("المبلغ"),tt("مدفوع"),tt("الطريقة"),tt("الحالة")].join(",");
                const rows = [head, `${inv.id},${inv.date},${inv.amount},${inv.paid},${tt(inv.method)},${tt(inv.status)}`];
                downloadCsv(rows, `${inv.id}.csv`);
                if (window.showToast) window.showToast(tt("تم تحميل الفاتورة"), "success");
              }}><I.Download size={13}/></button></td>
            </tr>
          )) : <tr><td colSpan={7}><EmptyState icon={<I.FileText size={22}/>} title={tt("لا توجد فواتير بعد")} body={tt("invoices appear here once you create them or a جلسة is checked out.")}/></td></tr>}
        </tbody>
      </CardTable>
      </div>
      {newInvoiceOpen && <NewInvoiceModal onClose={()=>setNewInvoiceOpen(false)}/>}
    </div>
  );
}

// ── PatientAdd — multi-step wizard ────────────────────────────
function PatientAdd({ onCancel, onSave }) {
  const [step, setStep] = React.useState(0);
  const steps = [tt("شخصي"), tt("طبي"), tt("المرفقات"), tt("مراجعة")];
  // Controlled state so the review step and the persist call actually
  // see what the user typed. Previously every input was uncontrolled and
  // "إنشاء مريض" saved a hardcoded seed row.
  const [form, setForm] = React.useState({
    patient_id: newRecordId("P-"),
    created_at: new Date().toISOString().slice(0,10),
    name: "", phone: "", email: "", age: "", gender: "F",
    occupation: "", marital: "أعزب", address: "",
    diagnosis: "", complaint: "", chronic: "", surgeries: "",
    allergies: "", meds: "", smoking: "أبدًا", activity: "متوسط",
  });
  const setField = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // Step-level validation gates. Continuing without a name/phone silently
  // let bad rows through to the persist step.
  function validate(current) {
    if (current === 0) {
      if (!form.patient_id.trim()) return tt("أدخل رقم الملف");
      if (!form.name.trim()) return tt("أدخل الاسم الكامل");
      if (!form.phone.trim()) return tt("أدخل رقم الهاتف");
    }
    if (current === 1) {
      if (!form.diagnosis.trim()) return tt("أدخل التشخيص");
    }
    return null;
  }

  async function persist() {
    const err = validate(0) || validate(1);
    if (err) { if (window.showToast) window.showToast(err, "error"); return; }
    try {
      const row = {
        patient_id: form.patient_id,
        id: form.patient_id,
        name: form.name,
        phone: form.phone,
        age: form.age ? Number(form.age) : null,
        gender: form.gender,
        diagnosis: form.diagnosis,
        notes: form.complaint || "",
        created_at: form.created_at,
        // UI-only fields ignored by the whitelist but useful for local seed:
        diag: form.diagnosis,
        status: "متاح",
        remain: 10,
      };
      if (window.KineticData) await window.KineticData.upsert("patients", row);
      if (window.showToast) window.showToast(tt("تم إنشاء المريض"), "success");
      onSave && onSave(row);
    } catch (e) {
      console.warn("create patient failed", e);
      if (window.showToast) window.showToast(tt("تعذّر الحفظ"), "error");
    }
  }

  function next() {
    const err = validate(step);
    if (err) { if (window.showToast) window.showToast(err, "error"); return; }
    setStep(step+1);
  }

  return (
    <Page>
      <div className="crumb"><span onClick={onCancel} style={{cursor:"pointer"}}>{tt("المرضى")}</span><I.Chevron size={11}/><span style={{color:"var(--ink-700)"}}>{tt("مريض جديد")}</span></div>
      <h1 className="h1" style={{marginBottom:6}}>{tt("تسجيل مريض جديد")}</h1>
      <div className="muted" style={{fontSize:13.5,marginBottom:24}}>{tt("خطوة {n} من {total} — drafts autosave every 5 seconds.", { n: step+1, total: steps.length })}</div>

      {/* stepper */}
      <div className="stepper" style={{gap:0,marginBottom:24}}>
        {steps.map((s,i)=>(
          <React.Fragment key={i}>
            <div style={{display:"flex",alignItems:"center",gap:10,flexShrink:0}}>
              <div style={{
                width:28,height:28,borderRadius:999,
                background:i<step?"var(--green)":i===step?"var(--blue-500)":"var(--ink-100)",
                color:i<=step?"#fff":"var(--ink-500)",
                display:"flex",alignItems:"center",justifyContent:"center",
                fontSize:12,fontWeight:600
              }}>{i<step ? <I.Check size={14}/> : i+1}</div>
              <span className="step-label" style={{fontSize:13,fontWeight:i===step?600:500,color:i===step?"var(--ink-900)":"var(--ink-500)"}}>{s}</span>
            </div>
            {i<steps.length-1 && <div style={{flex:1,minWidth:14,height:1,background:i<step?"var(--green)":"var(--ink-200)",margin:"0 16px"}}/>}
          </React.Fragment>
        ))}
      </div>

      <div className="card card-pad" style={{maxWidth:840,marginBottom:18}}>
        {step===0 && <FormPersonal form={form} setField={setField}/>}
        {step===1 && <FormMedical form={form} setField={setField}/>}
        {step===2 && <FormUploads/>}
        {step===3 && <FormReview form={form}/>}
      </div>

      <div style={{display:"flex",justifyContent:"space-between",maxWidth:840,flexWrap:"wrap",gap:10}}>
        <button className="btn btn-secondary" onClick={()=>step===0 ? onCancel() : setStep(step-1)}>
          <I.ArrowLeft size={13}/> {step===0?tt("إلغاء"):tt("رجوع")}
        </button>
        <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
          <button className="btn btn-ghost" onClick={()=>{if(window.showToast)window.showToast(tt("تم الحفظ كمسودة"),"success");onCancel&&onCancel();}}>{tt("حفظ كمسودة")}</button>
          {step<steps.length-1 ? (
            <button className="btn btn-blue" onClick={next}>{tt("متابعة")} <I.ArrowRight size={13}/></button>
          ) : (
            <button className="btn btn-blue" onClick={persist}><I.Check size={13}/> {tt("إنشاء مريض")}</button>
          )}
        </div>
      </div>
    </Page>
  );
}

// A labelled form field. The label names the field's control (docs/04:
// every field has a connected label): the first input, select or textarea
// inside without a name of its own gets aria-labelledby, and the hint
// aria-describedby.
function Field({ label, children, hint, span = 1, required }) {
  const boxRef = React.useRef(null);
  const id = "field" + React.useId().replace(/:/g, "");
  React.useEffect(() => {
    const el = boxRef.current && boxRef.current.querySelector(
      'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), select, textarea');
    if (!el || (el.labels && el.labels.length) || el.hasAttribute("aria-label")) return;
    if (!el.hasAttribute("aria-labelledby")) el.setAttribute("aria-labelledby", id + "-label");
    if (hint && !el.hasAttribute("aria-describedby")) el.setAttribute("aria-describedby", id + "-hint");
    if (required) el.setAttribute("aria-required", "true");
  });
  return (
    <div ref={boxRef} style={{gridColumn:`span ${span}`}}>
      <div className="label" id={id + "-label"}>{label} {required && <span aria-hidden="true" style={{color:"#A8443A"}}>*</span>}</div>
      {children}
      {hint && <div id={id + "-hint"} style={{fontSize:11.5,color:"var(--ink-500)",marginTop:4}}>{hint}</div>}
    </div>
  );
}
function FormPersonal({ form, setField }) {
  return (
    <div>
      <div className="h3" style={{marginBottom:14}}>{tt("البيانات الشخصية")}</div>
      <div className="rgrid c-sm" style={{"--gtc":"repeat(2,1fr)",gap:14}}>
        <Field label={tt("رقم الملف")} required><input className="input" value={form.patient_id} onChange={e=>setField("patient_id", e.target.value)}/></Field>
        <Field label={tt("تاريخ التسجيل")}><input className="input" type="date" value={form.created_at} onChange={e=>setField("created_at", e.target.value)}/></Field>
        <Field label={tt("الاسم الكامل")} required span={2}><input className="input" placeholder={tt("مثال: هناء مصطفى")} value={form.name} onChange={e=>setField("name", e.target.value)}/></Field>
        <Field label={tt("الهاتف")} required><input className="input" placeholder="+20 …" value={form.phone} onChange={e=>setField("phone", e.target.value)}/></Field>
        <Field label={tt("البريد الإلكتروني")}><input className="input" placeholder={tt("اختياري")} value={form.email} onChange={e=>setField("email", e.target.value)}/></Field>
        <Field label={tt("العمر")}><input className="input" type="number" placeholder="34" value={form.age} onChange={e=>setField("age", e.target.value)}/></Field>
        <Field label={tt("الجنس")}>
          <div style={{display:"flex",gap:6}}>
            {[["F",tt("أنثى")],["M",tt("ذكر")]].map(([g, l])=>(
              <button key={g} type="button" aria-pressed={form.gender===g ? "true" : "false"} className={"btn " + (form.gender===g?"btn-primary":"btn-secondary")} style={{flex:1,justifyContent:"center"}} onClick={()=>setField("gender", g)}>{l}</button>
            ))}
          </div>
        </Field>
        <Field label={tt("المهنة")}><input className="input" placeholder={tt("مثال: مهندسة معمارية")} value={form.occupation} onChange={e=>setField("occupation", e.target.value)}/></Field>
        <Field label={tt("الحالة الاجتماعية")}>
          <select className="input" value={form.marital} onChange={e=>setField("marital", e.target.value)}>{["أعزب","متزوج","أخرى"].map(v=><option key={v} value={v}>{tt(v)}</option>)}</select>
        </Field>
        <Field label={tt("العنوان")} span={2}><input className="input" placeholder={tt("الشارع، الحي، المدينة")} value={form.address} onChange={e=>setField("address", e.target.value)}/></Field>
      </div>
    </div>
  );
}
function FormMedical({ form, setField }) {
  return (
    <div>
      <div className="h3" style={{marginBottom:14}}>{tt("البيانات MedicalInformation")}</div>
      <div className="rgrid c-sm" style={{"--gtc":"repeat(2,1fr)",gap:14}}>
        <Field label={tt("الشكوى الرئيسية")} required span={2}><textarea className="input" style={{height:70,padding:10,resize:"vertical"}} placeholder={tt("e.g. ألم أسفل الظهر يمتد إلى الساق اليسرى, worse in AM")} value={form.complaint} onChange={e=>setField("complaint", e.target.value)}/></Field>
        <Field label={tt("التشخيص")} required span={2}><window.DiagnosisAutocomplete placeholder="e.g. L4–L5 disc herniation" value={form.diagnosis} onChange={e=>setField("diagnosis", e.target.value)}/></Field>
        <Field label={tt("أمراض مزمنة diseases")}><input className="input" placeholder={tt("النوع to add tags")} value={form.chronic} onChange={e=>setField("chronic", e.target.value)}/></Field>
        <Field label={tt("عمليات سابقة")}><input className="input" placeholder={tt("النوع to add tags")} value={form.surgeries} onChange={e=>setField("surgeries", e.target.value)}/></Field>
        <Field label={tt("حساسية")}><input className="input" placeholder={tt("مثال: بنسلين")} value={form.allergies} onChange={e=>setField("allergies", e.target.value)}/></Field>
        <Field label={tt("الأدوية الحالية")}><input className="input" placeholder={tt("افصل بفواصل")} value={form.meds} onChange={e=>setField("meds", e.target.value)}/></Field>
        {/* Option values stay Arabic (the stored answer); only the labels are translated. */}
        <Field label={tt("التدخين")}>
          <select className="input" value={form.smoking} onChange={e=>setField("smoking", e.target.value)}>{["أبدًا","سابقًا","حاليًا"].map(v=><option key={v} value={v}>{tt(v)}</option>)}</select>
        </Field>
        <Field label={tt("مستوى النشاط")}>
          <select className="input" value={form.activity} onChange={e=>setField("activity", e.target.value)}>{["خامل","خفيف","متوسط","نشط"].map(v=><option key={v} value={v}>{tt(v)}</option>)}</select>
        </Field>
      </div>
    </div>
  );
}
function FormUploads() {
  const uploadRefs = React.useRef([React.createRef(), React.createRef(), React.createRef(), React.createRef()]);
  const uploadDefs = [
    { l:tt("شخصي photo"), h:tt("JPG/PNG · لبطاقة الملف"), accept:"image/*"},
    { l:tt("صورة الهوية"), h:tt("أمامي وخلفي"), accept:"image/*"},
    { l:tt("صور الأشعة"), h:tt("متعدد مسموح"), accept:"image/*"},
    { l:tt("طبي reports"), h:"PDF, JPG, PNG", accept:".pdf,image/*"},
  ];
  return (
    <div>
      <div className="h3" style={{marginBottom:14}}>{tt("الملفات والمرفقات")}</div>
      <div className="grid-2" style={{gap:14}}>
        {uploadDefs.map((u,i)=>(
          <div key={i} style={{
            border:"2px dashed var(--ink-200)",borderRadius:12,padding:18,
            display:"flex",alignItems:"center",gap:14,background:"var(--ink-50)"
          }}>
            <input ref={uploadRefs.current[i]} type="file" accept={u.accept} style={{display:"none"}} onChange={e=>{
              if(e.target.files[0]&&window.showToast)window.showToast(tt("تم رفع {name}", { name: e.target.files[0].name }),"success");
              e.target.value="";
            }}/>
            <div style={{width:44,height:44,borderRadius:11,background:"#fff",border:"1px solid var(--ink-200)",display:"flex",alignItems:"center",justifyContent:"center",color:"var(--blue-700)"}}>
              <I.Image size={18}/>
            </div>
            <div style={{flex:1}}>
              <div style={{fontWeight:500,fontSize:13.5}}>{u.l}</div>
              <div className="muted" style={{fontSize:11.5}}>{u.h}</div>
            </div>
            <button className="btn btn-secondary" style={{fontSize:12}} onClick={()=>uploadRefs.current[i].current&&uploadRefs.current[i].current.click()}>{tt("رفع")}</button>
          </div>
        ))}
      </div>
    </div>
  );
}
function FormReview({ form }) {
  const f = form || {};
  return (
    <div>
      <div className="h3" style={{marginBottom:14}}>{tt("مراجعة & create")}</div>
      <div style={{padding:18,background:"var(--blue-50)",border:"1px solid var(--blue-100)",borderRadius:12,marginBottom:14}}>
        <div style={{display:"flex",alignItems:"center",gap:10,color:"var(--blue-900)",fontSize:13}}>
          <I.Check size={15}/> {ttx("Looks good. المريض will be created مع file # {id} وتعيينه إلى {branch}.", { id: <span className="mono">{f.patient_id || "—"}</span>, branch: <strong>{activeBranchName()}</strong> })}
        </div>
      </div>
      <div className="grid-2" style={{gap:18}}>
        {[
          {h:tt("شخصي"), rows:[[tt("الاسم الكامل"), f.name || "—"],[tt("رقم الملف"), f.patient_id || "—"],[tt("الهاتف"), f.phone || "—"],[tt("العمر والجنس"), tt("{age}، {gender}", { age: f.age ? tt("{n} سنة", { n: f.age }) : "—", gender: genderLabel(f.gender) || "—" })]]},
          {h:tt("طبي"), rows:[[tt("التشخيص"), f.diagnosis || "—"],[tt("أمراض مزمنة"), f.chronic || "—"],[tt("العمليات"), f.surgeries || "—"]]},
          {h:tt("المرفقات"), rows:[[tt("الملفات"),tt("تُرفع من ملف المريض بعد الإنشاء")]]},
          {h:tt("التعيينات"), rows:[[tt("طبيب"), f.doctor || "—"],[tt("الأخصائي"), f.therapist || "—"],[tt("الباقة"), f.pkg || "—"]]},
        ].map((s,i)=>(
          <div key={i} className="card card-pad" style={{padding:14,boxShadow:"none"}}>
            <div className="h3" style={{marginBottom:8}}>{s.h}</div>
            {s.rows.map((r,j)=>(
              <div key={j} style={{display:"flex",justifyContent:"space-between",fontSize:12.5,padding:"4px 0"}}>
                <span className="muted">{r[0]}</span><span>{r[1]}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// SessionTimeline is defined in screens2.jsx (no placeholder here: in the
// precompiled bundle all files are one script, so `SessionTimeline: null`
// overwrote the hoisted function and the session history tabs crashed).
Object.assign(window, { Patients, PatientDetail });


// ===== src/appointments.jsx =====
// Appointments — day calendar grid + booking flow

// ── Booking data helpers (departments / doctors are DB-backed) ──
const INCOMPLETE_STATUS = "ملف غير مكتمل";
const DOCTOR_STATUS = {
  available: { l: "متاح",     c: "#3FA984", badge: "b-green" },
  busy:      { l: "مشغول",    c: "#D49044", badge: "b-amber" },
  leave:     { l: "في إجازة", c: "#8898A8", badge: "b-grey" },
};
// Department name in the interface language (departments carry name_ar
// and name_en). Stored values (a booking's `dept` and `type`) keep name_ar.
function deptLabel(d) {
  if (!d) return "";
  return (!IS_RTL && d.name_en) || d.name_ar || "";
}
// Appointment types are stored as Arabic text («جلسة علاج طبيعي»,
// «جلسة + استشارة <القسم>»); this is their label in the interface language.
// Any other stored type is data and is shown as entered.
const APPT_TYPE_KEYS = new Set(["جلسة علاج طبيعي", "جلسة"]);
function apptTypeLabel(type) {
  if (!type) return type;
  const consult = /^جلسة \+ استشارة (.+)$/.exec(type);
  if (consult) {
    const name = consult[1];
    const dept = name === "طبيب" ? null : (DATA.departments || []).find(d => d.name_ar === name);
    return tt("جلسة + استشارة {dept}", { dept: name === "طبيب" ? tt("طبيب") : (dept ? deptLabel(dept) : name) });
  }
  return APPT_TYPE_KEYS.has(type) ? tt(type) : type;
}
// Departments sorted by their display order, active only.
function activeDepartments() {
  return (DATA.departments || [])
    .filter(d => d.active !== false)
    .slice()
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
}
// Active doctors assigned to a department.
function doctorsInDept(deptId) {
  return (DATA.doctors || []).filter(d => d.active !== false && d.department_id === deptId);
}
// Digits-only phone comparison so "+20 100…" matches "0100…" etc.
function normalizePhone(p) {
  return String(p || "").replace(/\D/g, "").replace(/^0+/, "");
}
function findPatientByPhone(phone) {
  const n = normalizePhone(phone);
  if (!n) return null;
  return (DATA.patients || []).find(p => normalizePhone(p.phone) === n) || null;
}

function Appointments({ go }) {
  const [tab, setTab] = React.useState("التقويم"); // calendar | list | book (values, not labels)
  const [dateOffset, setDateOffset] = React.useState(0);
  const [quickOpen, setQuickOpen] = React.useState(false);

  const myAppts = window.scopeAppts ? window.scopeAppts(DATA.appts) : DATA.appts;
  const booked = myAppts.filter(a=>a.status!=="متاح").length;
  const free = myAppts.filter(a=>a.status==="متاح").length;
  const pending = myAppts.filter(a=>a.status==="معلّق").length;
  const scoped = window.ME && (window.ME.scope==="doctor"||window.ME.scope==="therapist");

  return (
    <Page>
      <div className="page-head">
        <div>
          <div className="crumb"><span>{tt("الرئيسية")}</span><I.Chevron size={11}/><span>{tt("المواعيد")}</span></div>
          <h1 className="h1">{scoped ? tt("جدولي") : tt("المواعيد")}</h1>
          <div className="muted" style={{fontSize:13.5,marginTop:4}}>{tt("المحجوزة: {booked} · المتاحة: {free} · بانتظار التأكيد: {pending}", { booked, free, pending })}</div>
        </div>
        <div className="page-actions">
          <Segmented label={tt("عرض المواعيد")} value={tab} onChange={setTab}
            options={[{ value:"التقويم", label:tt("التقويم") }, { value:"قائمة", label:tt("قائمة") }, { value:"حجز", label:tt("حجز جديد") }]}/>
          <button className="btn btn-blue" onClick={()=>setQuickOpen(true)}><I.Plus size={14}/> {tt("حجز سريع")}</button>
        </div>
      </div>

      {tab==="التقويم" && <CalendarView dateOffset={dateOffset} setDateOffset={setDateOffset}/>}
      {tab==="قائمة" && <AppointmentList/>}
      {tab==="حجز" && <BookingFlow onDone={()=>setTab("التقويم")}/>}

      {quickOpen && <QuickBookingModal onClose={()=>setQuickOpen(false)} onDone={()=>{ setQuickOpen(false); setTab("التقويم"); }}/>}
    </Page>
  );
}

// ── Quick Booking (حجز سريع) ───────────────────────────────────
// For phone/WhatsApp bookings where the receptionist has minimal info.
// Only name, phone, therapist, date, time (+ optional doctor and notes).
// The therapist appointment is the default and required booking; a doctor
// is attached only when the receptionist explicitly selects one.
// Links to an existing patient by phone, or creates one flagged as
// "ملف غير مكتمل" so it can be completed later without touching bookings.
function QuickBookingModal({ onClose, onDone }) {
  const therapists = ((window.scopeTherapists ? window.scopeTherapists(DATA.therapists || []) : (DATA.therapists || [])))
    .filter(t => t.active !== false);
  const doctors = (DATA.doctors || []).filter(d => d.active !== false);
  const [form, setForm] = React.useState({
    name: "", phone: "", therapistId: "", doctorId: "",
    date: new Date().toISOString().slice(0, 10), time: "", notes: "",
    allowConsecutive: false,
  });
  const [busy, setBusy] = React.useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  async function save() {
    const name = form.name.trim();
    const phone = form.phone.trim();
    if (!name)  return window.showToast && window.showToast(tt("أدخل اسم المريض"), "error");
    if (!phone) return window.showToast && window.showToast(tt("أدخل رقم الهاتف"), "error");
    if (!form.therapistId) return window.showToast && window.showToast(tt("اختر الأخصائي"), "error");
    if (!form.date)     return window.showToast && window.showToast(tt("اختر التاريخ"), "error");
    if (!form.time)     return window.showToast && window.showToast(tt("اختر الوقت"), "error");

    // Default rule: at least one free day between the patient's sessions.
    // The receptionist can override intentionally (consecutive-day plan).
    const known = findPatientByPhone(phone);
    if (known && !form.allowConsecutive) {
      const clash = violatesFreeDayRule(known.patient_id || known.id, form.date);
      if (clash) {
        return window.showToast && window.showToast(
          tt("للمريض موعد في {date} — القاعدة تتطلب يوم راحة بين الجلسات. فعّل «السماح بأيام متتالية» للتجاوز.", { date: apptDateIso(clash) }),
          "error");
      }
    }

    setBusy(true);
    try {
      // 1. Resolve or create the patient (by phone).
      let patient = known;
      let createdNew = false;
      if (!patient) {
        const pid = newRecordId("P-");
        patient = await window.KineticData.upsert("patients", {
          patient_id: pid, name, phone,
          diagnosis: "", notes: "حجز سريع — بيانات ناقصة",
          status: INCOMPLETE_STATUS,
          registered: new Date().toISOString().slice(0, 10),
          created_at: new Date().toISOString(),
        });
        createdNew = true;
      }
      const patientId = patient.patient_id || patient.id;

      // 2. Create the appointment linked to that patient — therapist
      // required, doctor attached only when explicitly selected.
      const therapist = therapists.find(t => t.id === form.therapistId);
      const doctor = form.doctorId ? doctors.find(d => d.id === form.doctorId) : null;
      const dept = doctor ? (DATA.departments || []).find(d => d.id === doctor.department_id) : null;
      const bid = newRecordId("A-");
      await window.KineticData.upsert("appts", {
        booking_id: bid,
        patient_id: patientId,
        patient: patient.name || name,
        therapist_id: therapist ? (therapist.staff_id || therapist.id) : form.therapistId,
        th: therapist ? therapist.name : "",
        doctor_id: doctor ? doctor.id : null,
        department_id: dept ? dept.id : null,
        dr: doctor ? doctor.name : "",
        dept: dept ? dept.name_ar : "",
        date: form.date,
        time: form.time,
        status: "مؤكد",
        type: doctor ? `جلسة + استشارة ${dept ? dept.name_ar : "طبيب"}` : "جلسة علاج طبيعي",
        notes: form.notes.trim(),
        dur: (window.calendarConfig ? window.calendarConfig().slotMinutes : 30),
        created_at: new Date().toISOString(),
      });

      window.showToast && window.showToast(
        createdNew ? tt("تم الحجز وإنشاء ملف مبدئي للمريض") : tt("تم الحجز وربطه بملف المريض"),
        "success"
      );
      onDone && onDone();
    } catch (e) {
      console.warn("quick booking failed", e);
      window.showToast && window.showToast(tt("تعذّر إتمام الحجز"), "error");
    } finally {
      setBusy(false);
    }
  }

  const existing = findPatientByPhone(form.phone);
  const existingSchedule = existing ? scheduleForPatient(existing.patient_id || existing.id) : null;

  // One-click reuse of the saved recurring schedule: jump the form to the
  // next matching day at the preferred time.
  function usePreferred() {
    if (!existingSchedule) return;
    const days = scheduleDays(existingSchedule);
    const [nextIso] = nextScheduleDates(days, offsetIso(todayIso(), 1), 1);
    setForm(f => ({
      ...f,
      therapistId: existingSchedule.therapist_id || f.therapistId,
      date: nextIso || f.date,
      time: existingSchedule.time || f.time,
    }));
  }

  return (
    <Modal title={tt("حجز سريع")} onClose={onClose} width={560}
      footer={<>
        <button className="btn btn-ghost" onClick={onClose}>{tt("إلغاء")}</button>
        <button className="btn btn-blue" disabled={busy} onClick={save}>
          {busy ? <span className="spin" style={{width:14,height:14,border:"2px solid #fff",borderTopColor:"transparent",borderRadius:"50%"}}/> : <><I.Check size={13}/> {tt("تأكيد الحجز")}</>}
        </button>
      </>}>
      <div className="muted" style={{fontSize:12.5,marginBottom:14,lineHeight:1.6,padding:"10px 12px",background:"var(--blue-50)",border:"1px solid var(--blue-100)",borderRadius:8}}>
        {tt("للحجوزات الهاتفية والواتساب — أدخل الحد الأدنى من البيانات فقط. يُستكمل ملف المريض لاحقًا.")}
      </div>
      <div className="rgrid c-sm" style={{"--gtc":"1fr 1fr",gap:12}}>
        <Field label={tt("اسم المريض")} required>
          <input className="input" value={form.name} onChange={e=>set("name", e.target.value)} placeholder={tt("الاسم الكامل")} autoFocus/>
        </Field>
        <Field label={tt("رقم الهاتف")} required>
          {/* An LTR number aligned to the page's start side. */}
          <input className="input" value={form.phone} onChange={e=>set("phone", e.target.value)} placeholder="+20 1xx xxx xxxx" dir="ltr" style={{textAlign:IS_RTL ? "right" : "left"}}/>
        </Field>
      </div>
      {existing && (
        <div style={{fontSize:12,color:"var(--green)",margin:"2px 0 10px",display:"flex",alignItems:"center",gap:6}}>
          <I.Check size={12}/> {ttx("رقم معروف — سيُربط الحجز بملف {name}", { name: <strong>{existing.name}</strong> })}
        </div>
      )}
      {existingSchedule && (
        <div style={{display:"flex",alignItems:"center",gap:8,fontSize:12,margin:"2px 0 10px",padding:"8px 10px",background:"var(--blue-50)",border:"1px solid var(--blue-100)",borderRadius:8}}>
          <I.Clock size={12} style={{color:"var(--blue-700)",flexShrink:0}}/>
          <span style={{flex:1}}>{ttx("جدول ثابت: {days} · {time}", { days: scheduleDaysLabel(existingSchedule), time: <span className="mono">{existingSchedule.time}</span> })}</span>
          <button className="btn btn-ghost" style={{fontSize:11.5,padding:"3px 8px"}} onClick={usePreferred}>{tt("استخدام الجدول")}</button>
        </div>
      )}
      <div style={{height:2}}/>
      <div className="rgrid c-sm" style={{"--gtc":"1fr 1fr",gap:12}}>
        <Field label={tt("الأخصائي")} required>
          <select className="input" value={form.therapistId} onChange={e=>set("therapistId", e.target.value)}>
            <option value="">{tt("اختر الأخصائي…")}</option>
            {therapists.map(t=>(
              <option key={t.id} value={t.id}>{t.name}{t.spec?` — ${t.spec}`:""}</option>
            ))}
          </select>
        </Field>
        <Field label={tt("الطبيب (اختياري)")}>
          <select className="input" value={form.doctorId} onChange={e=>set("doctorId", e.target.value)}>
            <option value="">{tt("بدون طبيب")}</option>
            {doctors.map(d=>(
              <option key={d.id} value={d.id}>{d.name}{d.specialization?` — ${d.specialization}`:""}</option>
            ))}
          </select>
        </Field>
      </div>
      <div className="rgrid c-sm" style={{"--gtc":"1fr 1fr",gap:12}}>
        <Field label={tt("التاريخ")} required>
          <input className="input" type="date" value={form.date} onChange={e=>set("date", e.target.value)}/>
        </Field>
        <Field label={tt("الوقت")} required>
          <input className="input" type="time" value={form.time} onChange={e=>set("time", e.target.value)}/>
        </Field>
      </div>
      <Field label={tt("ملاحظات (اختياري)")}>
        <textarea className="input" rows={2} style={{padding:10,resize:"vertical"}} value={form.notes} onChange={e=>set("notes", e.target.value)} placeholder={tt("سبب الزيارة، تفضيلات الموعد…")}/>
      </Field>
      <label style={{display:"flex",alignItems:"center",gap:8,fontSize:12.5,marginTop:8,cursor:"pointer"}}>
        <input type="checkbox" checked={form.allowConsecutive} onChange={e=>set("allowConsecutive", e.target.checked)}/>
        {tt("السماح بأيام متتالية (تجاوز قاعدة يوم الراحة — بقرار الأخصائي)")}
      </label>
    </Modal>
  );
}

// ── Calendar helpers ──────────────────────────────────────────
// Absolute-date helpers so navigation, filtering, and persistence
// all agree on what "the selected day" means.
function isoDate(d) {
  const t = new Date(d);
  const y = t.getFullYear();
  const m = String(t.getMonth()+1).padStart(2,"0");
  const dd = String(t.getDate()).padStart(2,"0");
  return `${y}-${m}-${dd}`;
}
function todayIso() { return isoDate(new Date()); }
function offsetIso(iso, days) {
  const t = new Date(iso + "T00:00:00");
  t.setDate(t.getDate() + days);
  return isoDate(t);
}
// Match a booking row to a calendar day. Rows without an explicit
// date field (some legacy/demo rows) are treated as today so they
// still show up somewhere instead of vanishing.
function apptDateIso(a) {
  const raw = a && (a.date || a.appointment_date || a.start_date);
  if (!raw) return todayIso();
  const s = String(raw).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : todayIso();
}
// Cancelled bookings stay in the DB for history/reporting, but they must
// never occupy calendar space. Covers both Arabic spellings plus the raw
// DB value in case a row renders before normalization.
const CANCELLED_APPT_STATUSES = new Set(["ملغي", "ملغى", "cancelled"]);
function isCancelledAppt(a) {
  return Boolean(a && CANCELLED_APPT_STATUSES.has(a.status));
}

// ── Recurring schedule (الجدول الثابت) helpers ─────────────────
// A patient can carry one active recurring pattern (weekdays + fixed time
// + therapist) in patient_schedules. Future bookings are suggested and
// generated from it; editing it only affects appointments created later.
// Sunday first (Date#getDay). Arabic keeps its spelling «الإثنين»; English
// takes the names from Intl (weekdayNames, src/i18n.jsx).
const WEEKDAY_LABELS = IS_RTL ? ["الأحد","الإثنين","الثلاثاء","الأربعاء","الخميس","الجمعة","السبت"] : weekdayNames("long");
function scheduleForPatient(patientId) {
  if (!patientId) return null;
  return (DATA.schedules || []).find(s => s.patient_id === patientId && s.active !== false) || null;
}
// The days field is jsonb in the DB but may round-trip as a JSON string.
function scheduleDays(s) {
  if (!s) return [];
  let d = s.days;
  if (typeof d === "string") { try { d = JSON.parse(d); } catch { d = []; } }
  return Array.isArray(d)
    ? d.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6).sort((a, b) => a - b)
    : [];
}
function scheduleDaysLabel(s) {
  return scheduleDays(s).map(d => WEEKDAY_LABELS[d]).join(IS_RTL ? "، " : ", ");
}
// Default rule: at least one free day between sessions, so the chosen
// weekday set must not contain (cyclically) adjacent days — Saturday and
// Sunday count as adjacent.
function daysHaveConsecutive(days) {
  const set = new Set(days);
  return days.some(d => set.has((d + 1) % 7));
}
// The next `count` ISO dates matching the recurring weekdays, starting at
// startIso (inclusive).
function nextScheduleDates(days, startIso, count) {
  const out = [];
  if (!days.length || !count) return out;
  const d = new Date(startIso + "T00:00:00");
  for (let i = 0; out.length < count && i < 370; i++) {
    if (days.includes(d.getDay())) out.push(isoDate(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}
// Free-day rule against existing bookings: the patient must not already
// hold an active (non-cancelled) appointment on the same or an adjacent
// day. Returns the conflicting row, or null when the date is fine.
function violatesFreeDayRule(patientId, dateIso, excludeId) {
  if (!patientId || !dateIso) return null;
  const target = new Date(dateIso + "T00:00:00").getTime();
  return (DATA.appts || []).find(a => {
    if ((a.patient_id || a.pid) !== patientId) return false;
    if (excludeId && (a.booking_id || a.id) === excludeId) return false;
    if (isCancelledAppt(a) || a.status === "متاح") return false;
    const diff = Math.abs(new Date(apptDateIso(a) + "T00:00:00").getTime() - target);
    return diff <= 864e5;
  }) || null;
}
// Is the therapist already booked at date+time (any patient)?
function therapistBusyAt(therapistName, therapistId, dateIso, time) {
  return (DATA.appts || []).some(a =>
    apptDateIso(a) === dateIso && a.time === time &&
    !isCancelledAppt(a) && a.status !== "متاح" &&
    ((therapistId && a.therapist_id === therapistId) || (therapistName && a.th === therapistName)));
}
// Create future bookings from the saved recurring pattern: same therapist,
// same time, following the saved weekdays. Skips dates where the therapist
// slot is taken or the patient already has an appointment that day, so the
// generator is safe to re-run. Returns the created rows.
async function generateFromSchedule(patient, schedule, { startIso, sessions } = {}) {
  const days = scheduleDays(schedule);
  const time = schedule.time || "14:00";
  const count = sessions || Math.max(days.length, 1) * 4; // ≈ four weeks
  const start = startIso || offsetIso(todayIso(), 1);
  const therapistRow = (DATA.therapists || []).find(t =>
    t.id === schedule.therapist_id || t.staff_id === schedule.therapist_id);
  const thName = therapistRow ? therapistRow.name : "";
  const patientId = patient.patient_id || patient.id;
  const created = [];
  for (const dateIso of nextScheduleDates(days, start, count)) {
    if (therapistBusyAt(thName, schedule.therapist_id, dateIso, time)) continue;
    const clash = (DATA.appts || []).some(a =>
      (a.patient_id || a.pid) === patientId && !isCancelledAppt(a) &&
      a.status !== "متاح" && apptDateIso(a) === dateIso);
    if (clash) continue;
    const row = await window.KineticData.upsert("appts", {
      booking_id: newRecordId("A-"),
      patient_id: patientId,
      patient: patient.name || "",
      therapist_id: schedule.therapist_id || null,
      th: thName,
      doctor_id: null, dr: "",
      date: dateIso, time,
      status: "مؤكد",
      type: "جلسة علاج طبيعي",
      notes: "موعد مُنشأ من الجدول الثابت",
      dur: (window.calendarConfig ? window.calendarConfig().slotMinutes : 45),
      created_at: new Date().toISOString(),
    });
    created.push(row);
  }
  return created;
}

// ── Recurring schedule editor ──────────────────────────────────
// The therapist (or receptionist) fixes the patient's weekly pattern here:
// preferred time, treatment weekdays, and the consecutive-day override.
// Saving only touches patient_schedules — past and already-created
// appointments stay untouched; optional generation creates future rows.
function RecurringScheduleModal({ patient, onClose }) {
  window.useDataVersion && window.useDataVersion();
  const pid = patient.patient_id || patient.id;
  const existing = scheduleForPatient(pid);
  const therapists = ((window.scopeTherapists ? window.scopeTherapists(DATA.therapists || []) : (DATA.therapists || [])))
    .filter(t => t.active !== false);
  const [days, setDays] = React.useState(() => scheduleDays(existing));
  const [time, setTime] = React.useState((existing && existing.time) || "14:00");
  const [therapistId, setTherapistId] = React.useState(
    (existing && existing.therapist_id) || patient.therapist_id || "");
  const [allowConsecutive, setAllowConsecutive] = React.useState(Boolean(existing && existing.allow_consecutive));
  const [startIso, setStartIso] = React.useState(offsetIso(todayIso(), 1));
  const [sessions, setSessions] = React.useState(12);
  const [busy, setBusy] = React.useState(false);

  const toggleDay = (d) => setDays(prev =>
    prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d].sort((a, b) => a - b));
  const consecutive = daysHaveConsecutive(days);

  async function save(generate) {
    if (!therapistId)  return window.showToast && window.showToast(tt("اختر الأخصائي"), "error");
    if (!days.length)  return window.showToast && window.showToast(tt("اختر يومًا واحدًا على الأقل"), "error");
    if (!time)         return window.showToast && window.showToast(tt("اختر الوقت الثابت"), "error");
    if (consecutive && !allowConsecutive)
      return window.showToast && window.showToast(tt("الأيام المختارة متتالية — القاعدة تتطلب يوم راحة بين الجلسات. فعّل التجاوز أو غيّر الأيام."), "error");
    setBusy(true);
    try {
      const row = await window.KineticData.upsert("schedules", {
        schedule_id: existing ? (existing.schedule_id || existing.id) : newRecordId("SCH-"),
        patient_id: pid,
        therapist_id: therapistId,
        days,
        time,
        sessions_per_week: days.length,
        allow_consecutive: allowConsecutive,
        active: true,
        created_at: (existing && existing.created_at) || new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      let msg = tt("تم حفظ الجدول الثابت — يسري على المواعيد المستقبلية فقط");
      if (generate) {
        const made = await generateFromSchedule(patient, row, { startIso, sessions: Number(sessions) || 0 });
        msg = made.length
          ? tt("تم حفظ الجدول وإنشاء {n} موعدًا قادمًا", { n: made.length })
          : tt("تم حفظ الجدول — لا مواعيد جديدة (الأيام المطلوبة محجوزة بالفعل)");
      }
      window.showToast && window.showToast(msg, "success");
      onClose && onClose();
    } catch (e) {
      console.warn("save schedule failed", e);
      window.showToast && window.showToast(tt("تعذّر حفظ الجدول"), "error");
    } finally { setBusy(false); }
  }

  return (
    <Modal title={tt("الجدول الثابت — {name}", { name: patient.name || "" })} onClose={onClose} width={600}
      footer={<>
        <button className="btn btn-ghost" onClick={onClose}>{tt("إغلاق")}</button>
        <button className="btn btn-secondary" disabled={busy} onClick={()=>save(false)}>
          <I.Check size={13}/> {tt("حفظ الجدول فقط")}
        </button>
        <button className="btn btn-blue" disabled={busy} onClick={()=>save(true)}>
          {busy ? <span className="spin" style={{width:14,height:14,border:"2px solid #fff",borderTopColor:"transparent",borderRadius:"50%"}}/>
                : <><I.Calendar size={13}/> {tt("حفظ وإنشاء المواعيد")}</>}
        </button>
      </>}>
      <div className="muted" style={{fontSize:12.5,marginBottom:16,lineHeight:1.6,padding:"10px 12px",background:"var(--blue-50)",border:"1px solid var(--blue-100)",borderRadius:8}}>
        {tt("يحدد الأخصائي نمطًا أسبوعيًا ثابتًا (أيام + وقت). تُقترح المواعيد القادمة تلقائيًا من هذا النمط، وأي تعديل لاحق يسري على المواعيد المستقبلية فقط — المواعيد السابقة لا تتغير.")}
      </div>

      <Field label={tt("أيام العلاج الأسبوعية")} required>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          {WEEKDAY_LABELS.map((label, d) => {
            const on = days.includes(d);
            return (
              <button key={d} type="button" aria-pressed={on ? "true" : "false"} onClick={()=>toggleDay(d)}
                style={{
                  padding:"8px 12px",borderRadius:10,fontSize:12.5,cursor:"pointer",
                  border: on ? "1px solid var(--blue-500)" : "1px solid var(--ink-200)",
                  background: on ? "var(--blue-500)" : "#fff",
                  color: on ? "#fff" : "var(--ink-700)",
                  fontWeight: on ? 600 : 500, transition:"all .12s",
                }}>{label}</button>
            );
          })}
        </div>
      </Field>
      {consecutive && (
        <div style={{fontSize:12,color: allowConsecutive ? "var(--ink-500)" : "var(--red)",margin:"2px 0 10px"}}>
          {allowConsecutive
            ? tt("أيام متتالية مسموحة بقرار الأخصائي (تجاوز مفعّل).")
            : tt("تنبيه: توجد أيام متتالية — القاعدة الافتراضية تتطلب يوم راحة بين كل جلستين.")}
        </div>
      )}

      <div className="rgrid c-sm" style={{"--gtc":"1fr 1fr",gap:12}}>
        <Field label={tt("الوقت الثابت")} required>
          <input className="input" type="time" value={time} onChange={e=>setTime(e.target.value)}/>
        </Field>
        <Field label={tt("الأخصائي")} required>
          <select className="input" value={therapistId} onChange={e=>setTherapistId(e.target.value)}>
            <option value="">{tt("اختر الأخصائي…")}</option>
            {therapists.map(t=>(
              <option key={t.id} value={t.id}>{t.name}{t.spec?` — ${t.spec}`:""}</option>
            ))}
          </select>
        </Field>
      </div>
      <div className="muted" style={{fontSize:12,marginBottom:10}}>
        {ttx("عدد الجلسات في الأسبوع: {n}", { n: <strong>{days.length}</strong> })}
      </div>
      <label style={{display:"flex",alignItems:"center",gap:8,fontSize:12.5,marginBottom:16,cursor:"pointer"}}>
        <input type="checkbox" checked={allowConsecutive} onChange={e=>setAllowConsecutive(e.target.checked)}/>
        {tt("السماح بأيام متتالية (تجاوز قاعدة يوم الراحة — قرار مقصود من الأخصائي)")}
      </label>

      <div style={{borderTop:"1px solid var(--ink-100)",paddingTop:14}}>
        <div className="label" style={{marginBottom:8}}>{tt("إنشاء المواعيد القادمة تلقائيًا")}</div>
        <div className="rgrid c-sm" style={{"--gtc":"1fr 1fr",gap:12}}>
          <Field label={tt("تاريخ البداية")}>
            <input className="input" type="date" value={startIso} min={todayIso()} onChange={e=>setStartIso(e.target.value)}/>
          </Field>
          <Field label={tt("عدد الجلسات")}>
            <input className="input" type="number" min={1} max={60} value={sessions} onChange={e=>setSessions(e.target.value)}/>
          </Field>
        </div>
        <div className="muted" style={{fontSize:12}}>
          {tt("«حفظ وإنشاء المواعيد» يولّد الجلسات القادمة على نفس الأخصائي والوقت حسب الأيام المختارة، ويتخطى الأيام المحجوزة مسبقًا.")}
        </div>
      </div>
    </Modal>
  );
}
window.RecurringScheduleModal = RecurringScheduleModal;

function CalendarView({ dateOffset, setDateOffset }) {
  // Subscribe to data-updated events so external mutations (new
  // booking, quick payment, quick reschedule from another tab) flow
  // in without a page reload. Also re-renders on clinic-settings
  // changes, so admin edits to working hours apply immediately.
  window.useDataVersion && window.useDataVersion();

  // Working window from clinic settings (start/end/slot duration) —
  // nothing here is hardcoded anymore.
  const calCfg = window.calendarConfig ? window.calendarConfig()
    : { start:"08:00", end:"18:00", slotMinutes:30, startMinutes:480, endMinutes:1080 };
  const hours = window.calendarHours ? window.calendarHours()
    : ["08:00","09:00","10:00","11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00"];
  const gridStartMin = calCfg.startMinutes - (calCfg.startMinutes % 60);
  // Four tabs: "day" (all appts, chronological list), "therapist"
  // (therapists-only grid), "doctor" (doctors-only grid), "week"
  // (7-day summary). Role-restricted users get pinned to their tab.
  const meScope = (window.ME && window.ME.scope) || "all";
  const LS_MODE = "kinetic.calMode";
  const initialMode = React.useMemo(() => {
    if (meScope === "doctor")    return "doctor";
    if (meScope === "therapist") return "therapist";
    try {
      const v = localStorage.getItem(LS_MODE);
      if (["day","therapist","doctor","week"].includes(v)) return v;
    } catch {}
    return "therapist";
  }, [meScope]);
  const [viewMode, setViewModeState] = React.useState(initialMode);
  const setViewMode = React.useCallback((m) => {
    if (meScope === "doctor"    && m !== "doctor")    return;
    if (meScope === "therapist" && m !== "therapist") return;
    setViewModeState(m);
    try { localStorage.setItem(LS_MODE, m); } catch {}
  }, [meScope]);
  const [draggedId, setDraggedId] = React.useState(null);
  const [rescheduleModal, setRescheduleModal] = React.useState(null);
  const [actionsModal, setActionsModal]       = React.useState(null);

  // ── Selected date ──
  const parentIso   = todayIso();
  const viewIso     = offsetIso(parentIso, dateOffset || 0);
  const viewDate    = new Date(viewIso + "T00:00:00");
  const dm          = fmtDate(viewDate, { day: "numeric", month: "long" });
  const dateLabel   = dateOffset === 0 ? tt("اليوم، {date}", { date: dm })
                    : dateOffset === 1 ? tt("غدًا، {date}", { date: dm })
                    : dateOffset === -1 ? tt("أمس، {date}", { date: dm })
                    : fmtDate(viewDate, "weekdayDate");

  // Direct absolute-date picker: convert user's chosen date back into
  // an offset from today so the parent state stays valid.
  function onPickDate(iso) {
    if (!iso) return;
    const a = new Date(iso + "T00:00:00");
    const b = new Date(todayIso() + "T00:00:00");
    const diff = Math.round((a.getTime() - b.getTime()) / 864e5);
    setDateOffset(diff);
  }

  // ── Staff columns (therapists + doctors) ──
  // Inactive rosters are hidden from the calendar grid — historical
  // appointments still exist in the DB and can be looked up by id, but
  // an inactive specialist no longer takes up column space in the day/
  // week view. The columnIndexIn() lookup below falls back to name so a
  // rendered historical row can still route to a column when needed.
  const scopedTherapists = window.scopeTherapists ? window.scopeTherapists(DATA.therapists || []) : (DATA.therapists || []);
  const therapists = scopedTherapists.filter(t => t.active !== false);
  const doctors    = (DATA.doctors || []).filter(d => d.active !== false);
  const therapistCols = React.useMemo(() => therapists.map(t => ({
    key:       t.staff_id || t.id || t.name,
    name:      t.name,
    role:      tt("الأخصائي"),
    subtitle:  t.spec || "",
    hours:     t.schedule || t.hours || `${calCfg.start} - ${calCfg.end}`,
    load:      (t.load != null && t.max != null) ? `${t.load}/${t.max}` : "",
    color:     t.color || "#7BBDE8",
    _row:      t,
    _kind:     "therapist",
  })), [therapists, calCfg.start, calCfg.end]);
  const doctorCols = React.useMemo(() => doctors.map(d => ({
    key:       "dr:" + (d.id || d.name),
    name:      d.name,
    role:      tt("طبيب"),
    subtitle:  d.specialization || "",
    hours:     d.schedule || d.hours || `${calCfg.start} - ${calCfg.end}`,
    load:      "",
    color:     d.color || "#7E6BD3",
    _row:      d,
    _kind:     "doctor",
  })), [doctors, calCfg.start, calCfg.end]);
  // Combined map — used by day/week views to look up which column an
  // appointment belongs to for color + display.
  const staffCols = React.useMemo(() => [...therapistCols, ...doctorCols],
    [therapistCols, doctorCols]);
  // Visible columns for grid views — filtered to the active role.
  const visibleStaffCols = viewMode === "therapist" ? therapistCols
                        : viewMode === "doctor"     ? doctorCols
                        : staffCols;

  // Route an appointment to the correct column of `cols` (either the
  // visible grid list or the full staff list). Matches by staff id
  // first (most reliable), falls back to display name.
  function columnIndexIn(cols, a) {
    for (let i = 0; i < cols.length; i++) {
      const s = cols[i];
      const r = s._row;
      if (s._kind === "therapist") {
        const ids = [r.staff_id, r.id].filter(Boolean);
        if (a.therapist_id && ids.includes(a.therapist_id)) return i;
        if (a.th && r.name === a.th) return i;
      } else {
        if (a.doctor_id && a.doctor_id === r.id) return i;
        if (a.dr && r.name === a.dr) return i;
      }
    }
    return -1;
  }
  const columnIndexOf = (a) => columnIndexIn(visibleStaffCols, a);
  // Identify whether an appointment is assigned to a therapist vs doctor.
  const isTherapistAppt = (a) => Boolean(a.therapist_id || a.th);
  const isDoctorAppt    = (a) => Boolean(a.doctor_id || a.dr);

  // ── Filter appts to the selected day ──
  // Cancelled appointments are excluded from every calendar view (day,
  // therapist, doctor, week) — they remain in the DB and in the list tab.
  const scopedAll = window.scopeAppts ? window.scopeAppts(DATA.appts || []) : (DATA.appts || []);
  const scoped = scopedAll.filter(a => !isCancelledAppt(a));
  // For therapist/doctor grids, keep every appointment assigned to that
  // role. An appointment can carry BOTH a therapist and a doctor (session
  // + consultation) — it must appear in the therapist's calendar too, so
  // membership is inclusive, never "therapist only if no doctor".
  const dayAppts = React.useMemo(() => {
    return scoped
      .filter(a => apptDateIso(a) === viewIso)
      .filter(a => {
        if (viewMode === "therapist") return isTherapistAppt(a);
        if (viewMode === "doctor")    return isDoctorAppt(a);
        return true;
      })
      .map(a => ({ ...a, colIndex: columnIndexOf(a) }));
  }, [scoped, viewIso, visibleStaffCols, viewMode]);
  // Grid views can only render appointments routable to a visible column.
  // Anything left over (inactive/unknown specialist) must not silently
  // vanish — surface a count so the receptionist knows to fix the row.
  const unroutedCount = (viewMode === "therapist" || viewMode === "doctor")
    ? dayAppts.filter(a => a.colIndex === -1 && a.status !== "متاح").length
    : 0;

  // ── Week scaffolding (Saturday-start clinic week) ──
  const weekStart = React.useMemo(() => {
    const d = new Date(viewIso + "T00:00:00");
    const day = d.getDay();
    const diff = (day + 1) % 7; // days since Saturday
    d.setDate(d.getDate() - diff);
    return d;
  }, [viewIso]);
  const weekDays = React.useMemo(() => {
    const out = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart); d.setDate(weekStart.getDate() + i);
      out.push({
        iso:   d.toISOString().slice(0,10),
        label: fmtDate(d, { weekday: "short", day: "numeric" }),
      });
    }
    return out;
  }, [weekStart]);
  // A day or week before the startup window: its bookings are read when
  // shown (docs/06 S9).
  const firstShown = weekDays[0] && weekDays[0].iso < viewIso ? weekDays[0].iso : viewIso;
  window.useOlderRows && window.useOlderRows({ from: firstShown });
  const weekAppts = React.useMemo(() => {
    const isoSet = new Set(weekDays.map(d => d.iso));
    return scoped.filter(a => isoSet.has(apptDateIso(a)))
                 .map(a => ({ ...a, colIndex: columnIndexIn(staffCols, a) }));
  }, [scoped, weekDays, staffCols]);

  // Daily statistics reflect just the selected day.
  const dayBooked  = dayAppts.filter(a => a.status !== "متاح").length;
  const dayFree    = dayAppts.filter(a => a.status === "متاح").length;
  const dayPending = dayAppts.filter(a => a.status === "معلّق").length;

  // Minutes from the top of the grid (configured start hour, not 08:00).
  const minutesFromHour = (t) => {
    const parts = (t || "").split(":").map(Number);
    const h = Number.isFinite(parts[0]) ? parts[0] : Math.floor(gridStartMin / 60);
    const m = Number.isFinite(parts[1]) ? parts[1] : 0;
    return h * 60 + m - gridStartMin;
  };

  // ── Persist a move (drag-drop or reschedule modal) ──
  async function persistMove(orig, patch) {
    if (!window.KineticData) return;
    try {
      await window.KineticData.upsert("appts", {
        booking_id: orig.booking_id || orig.id,
        id:         orig.id,
        patient_id: orig.patient_id || orig.pid,
        patient:    orig.patient,
        therapist_id: patch.therapist_id ?? orig.therapist_id,
        doctor_id:    patch.doctor_id ?? orig.doctor_id,
        th:         patch.th ?? orig.th,
        dr:         patch.dr ?? orig.dr,
        date:       patch.date || apptDateIso(orig),
        time:       patch.time ?? orig.time,
        status:     patch.status ?? orig.status ?? "مؤكد",
        type:       orig.type,
        dur:        orig.dur || 30,
      });
    } catch (e) {
      console.warn("appointment persist failed", e);
      if (window.showToast) window.showToast(tt("تعذّر حفظ التعديل"), "error");
    }
  }

  // Overlap guard: another appointment in the same column at the
  // same time (ignoring the row we're moving).
  function hasConflict(colIndex, time, excludeId) {
    return dayAppts.some(a =>
      a.colIndex === colIndex
      && a.id !== excludeId
      && a.time === time
      && a.status !== "متاح"
      && a.status !== "ملغي"
    );
  }

  if (staffCols.length === 0) {
    return <EmptyState icon={<I.Calendar size={22}/>} title={tt("لا أخصائيين بعد")}
      body={tt("أضف الأخصائيين والأطباء من الإعدادات ليظهر تقويم الحجوزات هنا.")}/>;
  }

  // Tab visibility follows the current user's role. Reception/admin see
  // all four tabs; doctor sees only "الدكتور"; therapist sees only "الأخصائي".
  const canSeeTab = (m) => {
    if (meScope === "doctor")    return m === "doctor";
    if (meScope === "therapist") return m === "therapist";
    return true;
  };

  // ── Toolbar (shared by all views) ──
  const toolbar = (
    <div style={{padding:"14px 18px",display:"flex",alignItems:"center",gap:12,borderBottom:"1px solid var(--ink-200)",flexWrap:"wrap"}}>
      {/* LTR icon names: index.html mirrors them inside .btn in RTL. */}
      <button className="btn btn-secondary btn-icon" onClick={()=>setDateOffset(dateOffset-1)} aria-label={tt("السابق")}><I.ArrowLeft size={14}/></button>
      <div className="h3" style={{minWidth:"min(220px, 45vw)"}}>{dateLabel}</div>
      <button className="btn btn-secondary btn-icon" onClick={()=>setDateOffset(dateOffset+1)} aria-label={tt("التالي")}><I.ArrowRight size={14}/></button>
      <button className="btn btn-ghost" style={{fontSize:12}} onClick={()=>setDateOffset(0)}>{tt("اليوم")}</button>
      <input
        type="date"
        className="input"
        aria-label={tt("اذهب إلى تاريخ")}
        value={viewIso}
        onChange={e=>onPickDate(e.target.value)}
        style={{width:150,padding:"6px 10px",fontSize:12}}
      />
      <Segmented label={tt("طريقة عرض التقويم")} value={viewMode} onChange={setViewMode} style={{marginInlineEnd:12}}
        options={[["day","اليوم"],["therapist","الأخصائي"],["doctor","الدكتور"],["week","الأسبوع"]]
          .filter(([m]) => canSeeTab(m)).map(([m, l]) => ({ value: m, label: ttc("calendar-view", l) }))}/>
      <div style={{flex:1}}/>
      {unroutedCount > 0 && (
        <span style={{fontSize:12,color:"#A8443A"}} title={tt("مواعيد مسندة لأخصائي/طبيب غير موجود في الأعمدة الظاهرة (غير نشط أو محذوف) — راجعها من تبويب القائمة")}>
          ⚠ {tt("{n} موعد خارج الشبكة", { n: unroutedCount })}
        </span>
      )}
      <span className="muted" style={{fontSize:12}}>{tt("محجوز: {booked} · متاح: {free} · بانتظار: {pending}", { booked: dayBooked, free: dayFree, pending: dayPending })}</span>
    </div>
  );

  return (
    <>
    <div className="card" style={{padding:0,overflow:"hidden"}}>
      {toolbar}

      {(viewMode === "therapist" || viewMode === "doctor") ? (
        <div className="tbl-scroll">
        <div style={{display:"grid",gridTemplateColumns:`80px repeat(${visibleStaffCols.length},1fr)`,minHeight:660,minWidth:Math.max(320, 80 + visibleStaffCols.length*160)}}>
          {/* header */}
          <div style={{borderInlineStart:"1px solid var(--ink-200)",background:"var(--ink-50)"}}></div>
          {visibleStaffCols.map((s,i)=>{
            const cnt = dayAppts.filter(a => a.colIndex === i && a.status !== "متاح").length;
            return (
            <div key={s.key} style={{padding:"12px 14px",borderInlineStart:i<visibleStaffCols.length-1?"1px solid var(--ink-200)":"none",borderBottom:"1px solid var(--ink-200)",background:"var(--ink-50)"}}>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <span className="av sm" aria-hidden="true" style={{background:s.color+"33",color:"var(--ink-900)"}}>{(s.name||"").split(" ").map(x=>x[0]).join("").slice(0,2)}</span>
                <div style={{minWidth:0}}>
                  <div style={{fontWeight:600,fontSize:13,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{s.name}</div>
                  <div className="muted" style={{fontSize:11}}>{s.subtitle || s.role}</div>
                  <div className="muted mono" style={{fontSize:10.5,marginTop:2}}>{s.hours} · {tt("{n} موعد", { n: cnt })}</div>
                </div>
              </div>
            </div>
            );
          })}

          {/* hours column */}
          <div style={{borderInlineStart:"1px solid var(--ink-200)",background:"var(--ink-50)",position:"relative"}}>
            {hours.map((h,i)=>(
              <div key={h} style={{height:54,padding:"4px 10px",borderTop:i?"1px solid var(--ink-100)":"none",fontSize:11,color:"var(--ink-500)"}} className="mono">{h}</div>
            ))}
          </div>

          {/* staff columns */}
          {visibleStaffCols.map((s,col)=>(
            <div key={s.key}
              onDragOver={e=>e.preventDefault()}
              onDrop={e=>{
                e.preventDefault();
                const rect = e.currentTarget.getBoundingClientRect();
                const offsetY = e.clientY - rect.top;
                // Snap the drop to the configured slot duration, measured
                // from the grid's configured start hour (54px per hour).
                const snap = calCfg.slotMinutes;
                const rawMin = gridStartMin + (offsetY / 54) * 60;
                const totalMin = Math.max(calCfg.startMinutes,
                  Math.min(calCfg.endMinutes, Math.round(rawMin / snap) * snap));
                const hh = Math.floor(totalMin / 60);
                const mm = totalMin % 60;
                const newTime = `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
                const orig = dayAppts.find(x => x.id === draggedId);
                setDraggedId(null);
                if (!orig) return;
                // Cross-role guard: therapist view only moves within therapists;
                // doctor view only within doctors.
                if (viewMode === "therapist" && s._kind !== "therapist") return;
                if (viewMode === "doctor"    && s._kind !== "doctor")    return;
                if (hasConflict(col, newTime, orig.id)) {
                  if (window.showToast) window.showToast(tt("يوجد موعد آخر في نفس التوقيت"), "error");
                  return;
                }
                const patch = { time: newTime, date: viewIso };
                if (s._kind === "therapist") {
                  patch.th = s.name;
                  patch.therapist_id = s._row.staff_id || s._row.id;
                  patch.doctor_id = null; patch.dr = null;
                } else {
                  patch.dr = s.name;
                  patch.doctor_id = s._row.id;
                  patch.therapist_id = null; patch.th = null;
                }
                persistMove(orig, patch);
              }}
              style={{
                position:"relative",
                borderInlineStart:col<visibleStaffCols.length-1?"1px solid var(--ink-200)":"none",
                background: col%2===0?"#fff":"#FCFDFE",
                minHeight: hours.length * 54
              }}>
              {hours.map((_,i)=>(
                <div key={i} style={{position:"absolute",top:i*54,left:0,right:0,height:54,borderTop:i?"1px solid var(--ink-100)":"none"}}/>
              ))}
              {/* now indicator — only on today's column */}
              {col===0 && dateOffset===0 && (() => {
                const now = new Date();
                const nowMin = now.getHours()*60 + now.getMinutes() - gridStartMin;
                if (nowMin < 0 || nowMin > hours.length*60) return null;
                return (
                  <div style={{position:"absolute",top:(nowMin/60)*54-2,left:0,right:0,height:2,background:"var(--red)",zIndex:5}}>
                    <div style={{position:"absolute",insetInlineEnd:-4,top:-4,width:10,height:10,borderRadius:999,background:"var(--red)"}}/>
                  </div>
                );
              })()}

              {dayAppts.filter(a=>a.colIndex===col).map(a=>{
                const gridH = hours.length * 54;
                // Clamp into the visible grid so an appointment outside the
                // configured window is still reachable instead of hidden.
                const top = Math.max(0, Math.min(gridH - 30, (minutesFromHour(a.time)/60)*54));
                const dur = Number(a.dur) || calCfg.slotMinutes;
                const h = Math.min((dur/60)*54, gridH - top);
                const isAvail = a.status==="متاح";
                const c = s.color;
                const bg = isAvail ? "transparent" : `${c}1A`;
                const border = isAvail ? `2px dashed ${c}66` : `1px solid ${c}66`;
                return (
                  <div key={a.id}
                    draggable={!isAvail}
                    // A booking opens its details from the keyboard too.
                    role={isAvail ? undefined : "button"} tabIndex={isAvail ? undefined : 0}
                    onKeyDown={isAvail ? undefined : (e)=>{ if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setActionsModal(a); } }}
                    onDragStart={(e)=>{e.stopPropagation();setDraggedId(a.id);}}
                    onClick={()=>{ if(!isAvail) setActionsModal(a); }}
                    style={{
                      position:"absolute", left:6, right:6, top, height:h-3,
                      background:bg, border, borderInlineStart: isAvail?border:`3px solid ${c}`,
                      borderRadius:9, padding:"6px 8px",fontSize:11.5,
                      cursor: isAvail?"pointer":"grab", overflow:"hidden",
                      transition:"transform .12s",
                      opacity: draggedId===a.id ? 0.5 : 1
                    }}
                    onMouseEnter={e=>e.currentTarget.style.transform="scale(1.01)"}
                    onMouseLeave={e=>e.currentTarget.style.transform="scale(1)"}>
                    {isAvail ? (
                      <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100%",color:c,fontWeight:500}}>
                        <I.Plus size={12} style={{marginInlineStart:4}}/> {tt("موعد متاح")}
                      </div>
                    ) : (
                      <>
                        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:2}}>
                          <span style={{fontWeight:600,fontSize:12,color:"var(--ink-900)"}}>{a.patient}</span>
                          <span className="mono" style={{fontSize:10,color:"var(--ink-500)"}}>{a.time}</span>
                        </div>
                        <div style={{fontSize:10.5,color:"var(--ink-500)",whiteSpace:"normal",wordBreak:"break-word"}}>{apptTypeLabel(a.type)}</div>
                        <div style={{display:"flex",alignItems:"center",gap:6,marginTop:4}}>
                          <ApptBadge s={a.status}/>
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        </div>
      ) : viewMode === "week" ? (
        // ── Week view: 7-day chronological summary (Saturday-start) ──
        <div className="tbl-scroll">
        <div style={{display:"grid",gridTemplateColumns:`repeat(7,1fr)`,minHeight:520,minWidth:Math.max(560, 7*140)}}>
          {weekDays.map((d, i) => {
            const dayList = weekAppts
              .filter(a => apptDateIso(a) === d.iso)
              .sort((a,b)=>String(a.time).localeCompare(String(b.time)));
            const isToday = d.iso === todayIso();
            const isSelected = d.iso === viewIso;
            return (
              <div key={d.iso}
                onClick={()=>onPickDate(d.iso)}
                style={{
                  borderInlineStart: i<6 ? "1px solid var(--ink-200)" : "none",
                  background: isSelected ? "var(--blue-50)" : (i%2===0 ? "#fff" : "#FCFDFE"),
                  cursor:"pointer",
                }}>
                <div style={{padding:"10px 12px",borderBottom:"1px solid var(--ink-200)",background:isToday?"var(--blue-50)":"var(--ink-50)"}}>
                  <div style={{fontSize:12,fontWeight:600}}>{d.label}</div>
                  <div className="muted mono" style={{fontSize:10.5}}>{d.iso}</div>
                  <div className="muted" style={{fontSize:10.5,marginTop:2}}>{tt("{n} موعد", { n: dayList.filter(a=>a.status!=="متاح").length })}</div>
                </div>
                <div style={{padding:"8px",display:"flex",flexDirection:"column",gap:6}}>
                  {dayList.length === 0 && <div className="muted" style={{fontSize:11,textAlign:"center",padding:"12px 0"}}>—</div>}
                  {dayList.slice(0, 8).map(a => {
                    const col   = a.colIndex >= 0 ? staffCols[a.colIndex] : null;
                    const color = (col && col.color) || "#7BBDE8";
                    const staffLabel = col ? col.name : (a.th || a.dr || "—");
                    const isAvail = a.status === "متاح";
                    return (
                      <div key={a.id}
                        onClick={(e)=>{ e.stopPropagation(); if(!isAvail) setActionsModal(a); }}
                        style={{
                          borderInlineStart:`3px solid ${color}`,
                          border:"1px solid var(--ink-200)",
                          borderRadius:8, padding:"5px 7px",
                          background: isAvail ? "transparent" : "#fff",
                          fontSize:11, cursor:isAvail?"default":"pointer",
                        }}>
                        <div style={{display:"flex",justifyContent:"space-between",gap:4}}>
                          <span className="mono" style={{fontWeight:600}}>{a.time || "—"}</span>
                          <span className="muted" style={{fontSize:10}}><span className="mono">{a.dur||30}</span> {tt("د")}</span>
                        </div>
                        <div style={{fontWeight:500,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{a.patient || "—"}</div>
                        <div className="muted" style={{fontSize:10,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{staffLabel}</div>
                      </div>
                    );
                  })}
                  {dayList.length > 8 && (
                    <div className="muted" style={{fontSize:10.5,textAlign:"center"}}>{tt("+{n} إضافية", { n: dayList.length-8 })}</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        </div>
      ) : (
        // ── Day view: chronological list for the selected date ──
        <div style={{padding:"14px 18px"}}>
          {dayAppts.length === 0 && (
            <div className="muted" style={{fontSize:13,padding:"32px 0",textAlign:"center"}}>{tt("لا مواعيد في هذا اليوم.")}</div>
          )}
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {dayAppts.slice().sort((a,b)=>String(a.time).localeCompare(String(b.time))).map(a=>{
              const col   = a.colIndex >= 0 ? visibleStaffCols[a.colIndex] : null;
              const color = (col && col.color) || "#7BBDE8";
              const with_ = col ? `${col.role}: ${col.name}` : (a.th || a.dr || "—");
              const isAvail = a.status === "متاح";
              return (
                <div key={a.id}
                  onClick={()=>{ if(!isAvail) setActionsModal(a); }}
                  style={{
                    display:"flex",alignItems:"center",gap:12,
                    padding:"10px 12px",border:"1px solid var(--ink-200)",
                    borderInlineStart:`3px solid ${color}`,borderRadius:12,
                    background: a.status==="قيد التنفيذ" ? "var(--blue-50)" : "#fff",
                    cursor: isAvail ? "default" : "pointer",
                  }}>
                  <div style={{textAlign:"center",minWidth:56}}>
                    <div className="mono" style={{fontSize:13,fontWeight:600}}>{a.time || "—"}</div>
                    <div style={{fontSize:10.5,color:"var(--ink-500)"}}><span className="mono">{a.dur || 30}</span> {tt("د")}</div>
                  </div>
                  <div style={{width:1,height:34,background:"var(--ink-200)"}}/>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:13,fontWeight:500,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{a.patient || "—"}</div>
                    <div style={{fontSize:11.5,color:"var(--ink-500)"}}>{with_}{a.type ? ` · ${apptTypeLabel(a.type)}` : ""}</div>
                  </div>
                  <ApptBadge s={a.status}/>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>

    {actionsModal && (
      <AppointmentActionsModal
        appt={actionsModal}
        onClose={()=>setActionsModal(null)}
        onEdit={()=>{ setRescheduleModal(actionsModal); setActionsModal(null); }}
        onStatus={async (newStatus) => {
          await persistMove(actionsModal, { status: newStatus });
          setActionsModal(null);
          if (window.showToast) window.showToast(tt("تم تحديث الحالة"), "success");
        }}
      />
    )}

    {rescheduleModal && (
      <RescheduleModal
        appt={rescheduleModal}
        onClose={()=>setRescheduleModal(null)}
        onSave={(newTime, newTherapist, newDateIso)=>{
          const therapistRow = (DATA.therapists || []).find(x=>x.name===newTherapist);
          const patch = {
            time: newTime, th: newTherapist,
            therapist_id: therapistRow ? (therapistRow.staff_id || therapistRow.id) : rescheduleModal.therapist_id,
            date: newDateIso || apptDateIso(rescheduleModal),
          };
          persistMove(rescheduleModal, patch);
          setRescheduleModal(null);
          if(window.showToast) window.showToast(tt("تم إعادة جدولة موعد {name} إلى {date} {time}", { name: rescheduleModal.patient, date: newDateIso, time: newTime }), "success");
        }}
        therapists={therapists}
      />
    )}
    </>
  );
}

// ── Appointment actions (view details + status change + open patient) ──
// Small focused modal so click-to-details doesn't drop the user
// straight into the reschedule form.
function AppointmentActionsModal({ appt, onClose, onEdit, onStatus }) {
  const [schedOpen, setSchedOpen] = React.useState(false);
  const patient = (DATA.patients || []).find(p =>
    (p.patient_id || p.id) === (appt.patient_id || appt.pid)
    || p.name === appt.patient);
  if (schedOpen && patient) {
    return <RecurringScheduleModal patient={patient} onClose={onClose}/>;
  }
  return (
    <Modal open onClose={onClose} width={520} title={tt("تفاصيل الموعد")}>
      <div style={{display:"grid",gap:10,fontSize:13}}>
        <Row k={tt("المريض")}  v={appt.patient || "—"}/>
        {patient && patient.phone && <Row k={tt("الهاتف")} v={<bdi dir="ltr">{patient.phone}</bdi>}/>}
        <Row k={tt("المسؤول")} v={appt.th || appt.dr || "—"}/>
        <Row k={tt("التاريخ")} v={apptDateIso(appt)}/>
        <Row k={tt("الوقت")}   v={tt("{time} · {n} دقيقة", { time: appt.time || "—", n: appt.dur || 30 })}/>
        <Row k={tt("النوع")}   v={apptTypeLabel(appt.type) || "—"}/>
        <Row k={tt("الحالة")}  v={<ApptBadge s={appt.status}/>}/>
        {appt.payment && <Row k={tt("الدفع")} v={<PayBadge s={appt.payment}/>}/>}
        {appt.notes && <Row k={tt("ملاحظات")} v={appt.notes}/>}
      </div>
      <div style={{display:"flex",flexWrap:"wrap",gap:8,marginTop:16,justifyContent:"flex-end"}}>
        {patient && (
          <button className="btn btn-ghost" onClick={()=>{
            if (window.__goToPatient) window.__goToPatient(patient);
            else if (window.showToast) window.showToast(tt("افتح صفحة المرضى لعرض الملف"), "info");
            onClose();
          }}><I.User size={13}/> {tt("ملف المريض")}</button>
        )}
        {patient && (
          <button className="btn btn-ghost" onClick={()=>setSchedOpen(true)}><I.Clock size={13}/> {tt("الجدول الثابت")}</button>
        )}
        <WaReminderButton patient={patient} appt={appt} className="btn btn-ghost"/>
        <button className="btn btn-secondary" onClick={()=>onStatus("ملغي")}><I.X size={13}/> {tt("إلغاء")}</button>
        <button className="btn btn-secondary" onClick={()=>onStatus("مكتمل")}><I.Check size={13}/> {tt("إنهاء")}</button>
        <button className="btn btn-blue" onClick={onEdit}><I.Edit size={13}/> {tt("نقل / تعديل")}</button>
      </div>
    </Modal>
  );
}
function Row({ k, v }) {
  return (
    <div style={{display:"flex",gap:12,alignItems:"center"}}>
      <span className="muted" style={{fontSize:12,minWidth:64}}>{k}</span>
      <span style={{flex:1}}>{v}</span>
    </div>
  );
}

function RescheduleModal({ appt, onClose, onSave, therapists }) {
  // Live-tick every minute so past-time gating remains accurate even
  // if the modal sits open across the top of the hour or midnight.
  const [nowTick, setNowTick] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  // Re-render whenever another tab/module writes a booking so slot
  // availability stays fresh without a page reload.
  window.useDataVersion && window.useDataVersion();

  const WEEKDAYS = WEEKDAY_LABELS;
  const MONTHS   = monthNames("long");
  // Bookable slots from clinic settings (working window + slot duration).
  const timeSlots = window.calendarSlots ? window.calendarSlots() : [
    "08:00","08:30","09:00","09:30","10:00","10:30","11:00","11:30",
    "12:00","12:30","13:00","13:30","14:00","14:30","15:00","15:30",
    "16:00","16:30","17:00","17:30","18:00"
  ];

  // Real "today" derived from the runtime clock — never hardcoded.
  const now       = new Date(nowTick);
  const todayIsoR = isoDate(now);
  const nowHM     = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;

  // Build 7 rolling calendar days starting today. Each card carries
  // its own ISO so downstream logic never re-parses the labels.
  const days = React.useMemo(() => {
    const out = [];
    const base = new Date(todayIsoR + "T00:00:00");
    for (let i = 0; i < 7; i++) {
      const d = new Date(base); d.setDate(base.getDate() + i);
      const iso = isoDate(d);
      const wd  = WEEKDAYS[d.getDay()];
      const mo  = MONTHS[d.getMonth()];
      const short = i === 0 ? tt("اليوم، {date}", { date: `${d.getDate()} ${mo}` })
                  : i === 1 ? tt("غدًا، {date}", { date: `${d.getDate()} ${mo}` })
                  : tt("{weekday}، {day} {month}", { weekday: wd, day: d.getDate(), month: mo });
      out.push({ iso, weekday: wd, day: d.getDate(), month: mo, label: short });
    }
    return out;
  }, [todayIsoR]);

  // Bookings from the live source (DB-backed via KineticData → DATA).
  const allAppts = (window.scopeAppts ? window.scopeAppts(DATA.appts || []) : (DATA.appts || []));

  // Available count per day = working slots − bookings for that day
  // that aren't cancelled and aren't the appointment being rescheduled.
  function availableCount(iso) {
    const taken = allAppts.filter(a =>
      apptDateIso(a) === iso &&
      a.status !== "ملغي" && a.status !== "متاح" &&
      (a.booking_id || a.id) !== (appt.booking_id || appt.id)
    ).length;
    let total = timeSlots.length;
    if (iso === todayIsoR) {
      // Slots already in the past today can't be booked either.
      total = timeSlots.filter(t => t > nowHM).length;
    }
    return Math.max(0, total - taken);
  }

  // Default selection: keep the appt's current date if it's still in
  // the visible window and not in the past; otherwise fall back to today.
  const initialIso = React.useMemo(() => {
    const cur = apptDateIso(appt);
    if (cur >= todayIsoR && days.some(d => d.iso === cur)) return cur;
    return todayIsoR;
  }, [appt, todayIsoR, days]);

  const [newTime, setNewTime]           = React.useState(appt.time);
  const [newTherapist, setNewTherapist] = React.useState(appt.th);
  const [newDateIso, setNewDateIso]     = React.useState(initialIso);

  // Times taken by other appointments on the chosen day for the chosen therapist.
  const takenTimes = React.useMemo(() => {
    return new Set(
      allAppts
        .filter(a =>
          apptDateIso(a) === newDateIso &&
          a.status !== "ملغي" && a.status !== "متاح" &&
          (a.th === newTherapist) &&
          (a.booking_id || a.id) !== (appt.booking_id || appt.id)
        )
        .map(a => a.time)
    );
  }, [allAppts, newDateIso, newTherapist, appt]);

  const selectedDay = days.find(d => d.iso === newDateIso) || days[0];
  const selectedLabel = selectedDay
    ? tt("{weekday}، {day} {month}", { weekday: selectedDay.weekday, day: selectedDay.day, month: selectedDay.month })
    : newDateIso;

  const canSave =
    !!newDateIso && !!newTime && !!newTherapist &&
    newDateIso >= todayIsoR &&
    !(newDateIso === todayIsoR && newTime <= nowHM) &&
    !takenTimes.has(newTime);

  // Each picker is a labelled group (the label's id names it).
  const sectionLabel = (text, id) => (
    <div id={id} style={{
      fontSize:12,fontWeight:600,
      color:"var(--ink-700)",marginBottom:10,whiteSpace:"nowrap"
    }}>{text}</div>
  );

  // A dialog like Modal (docs/04): role=dialog named by its title, focus
  // kept inside, Esc closes it, focus back to the booking it came from.
  const boxRef = React.useRef(null);
  const titleId = useDialogFocus(boxRef, true, onClose);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <DialogFocusGuard boxRef={boxRef} at="start"/>
      <div
        ref={boxRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        onClick={e=>e.stopPropagation()}
        style={{
          background:"#fff",borderRadius:18,boxShadow:"0 24px 60px rgba(0,0,0,.18)",
          width:"min(600px, calc(100vw - 32px))",
          maxHeight:"calc(100vh - 48px)",maxHeight:"calc(100dvh - 48px)",overflowY:"auto",
          padding:"clamp(18px, 5vw, 28px) clamp(16px, 5vw, 28px) 24px",outline:"none",
        }}
      >
        {/* ── Header ── */}
        <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:16,marginBottom:20}}>
          <div style={{minWidth:0}}>
            <h2 id={titleId} style={{fontSize:18,fontWeight:700,color:"var(--ink-900)",lineHeight:1.2,margin:"0 0 4px"}}>
              {tt("إعادة جدولة الموعد")}
            </h2>
            <div style={{fontSize:13,color:"var(--ink-500)"}}>
              {[appt.patient, apptTypeLabel(appt.type)].filter(Boolean).join(" · ")}
            </div>
          </div>
          <button
            type="button" className="btn btn-ghost btn-icon" aria-label={tt("إغلاق")}
            onClick={onClose}
            style={{flexShrink:0,marginTop:2}}
          ><I.X size={16}/></button>
        </div>

        {/* ── Current slot banner ── */}
        <div style={{
          display:"flex",alignItems:"center",gap:10,
          padding:"12px 16px",
          background:"var(--blue-50)",border:"1px solid var(--blue-100)",
          borderRadius:12,marginBottom:24,
        }}>
          <I.Clock size={14} style={{color:"var(--blue-700)",flexShrink:0}}/>
          <span style={{fontSize:13,color:"var(--ink-500)",whiteSpace:"nowrap"}}>{tt("الموعد الحالي:")}</span>
          <span style={{fontSize:13,fontWeight:600,color:"var(--ink-900)",whiteSpace:"nowrap"}}>{appt.time}</span>
          <span style={{color:"var(--ink-300)"}}>·</span>
          <span style={{fontSize:13,color:"var(--ink-700)",whiteSpace:"nowrap"}}>{appt.th}</span>
        </div>

        {/* ── Date picker (rolling 7 days from real system time) ── */}
        <div style={{marginBottom:22}}>
          {sectionLabel(tt("اليوم الجديد"), titleId + "-day")}
          <div role="group" aria-labelledby={titleId + "-day"} style={{display:"grid",gridTemplateColumns:"repeat(auto-fill, minmax(120px, 1fr))",gap:8}}>
            {days.map(d => {
              const active = newDateIso === d.iso;
              const avail  = availableCount(d.iso);
              const full   = avail === 0;
              return (
                <button
                  key={d.iso} type="button"
                  onClick={()=> !full && setNewDateIso(d.iso)}
                  disabled={full} aria-pressed={active ? "true" : "false"}
                  title={full ? tt("لا تتوفر مواعيد") : tt("متاح: {n}", { n: avail })}
                  style={{
                    display:"flex",flexDirection:"column",alignItems:"center",gap:2,
                    padding:"10px 12px",borderRadius:12,
                    border: active ? "1px solid var(--blue-700)" : "1px solid var(--ink-200)",
                    cursor: full ? "not-allowed" : "pointer",
                    background: active ? "var(--blue-700)" : full ? "var(--ink-50)" : "#fff",
                    color: active ? "#fff" : full ? "var(--ink-500)" : "var(--ink-900)",
                    boxShadow: active ? "0 2px 8px rgba(58,127,181,.3)" : "none",
                    transition:"all .12s",
                    opacity: full ? .55 : 1,
                  }}
                >
                  <span style={{fontSize:11.5,fontWeight:500}}>{d.weekday}</span>
                  <span style={{fontSize:15,fontWeight:600}}>
                    <span className="mono">{d.day}</span> {d.month}
                  </span>
                  <span style={{fontSize:11}}>
                    {full ? tt("محجوز بالكامل") : tt("متاح: {n}", { n: avail })}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* ── Time picker ── */}
        <div style={{marginBottom:22}}>
          {sectionLabel(tt("الوقت الجديد"), titleId + "-time")}
          <div role="group" aria-labelledby={titleId + "-time"} style={{
            display:"grid",
            gridTemplateColumns:"repeat(auto-fill, minmax(72px, 1fr))",
            gap:6,
          }}>
            {timeSlots.map(t => {
              const active = newTime === t;
              const isPast = newDateIso === todayIsoR && t <= nowHM;
              const isTaken = takenTimes.has(t);
              const disabled = isPast || isTaken;
              return (
                <button
                  key={t} type="button"
                  disabled={disabled} aria-pressed={active ? "true" : "false"}
                  aria-label={isPast ? tt("{time} — وقت سابق", { time: t }) : isTaken ? tt("{time} — محجوز", { time: t }) : undefined}
                  onClick={()=> !disabled && setNewTime(t)}
                  title={isPast ? tt("وقت سابق") : isTaken ? tt("محجوز") : ""}
                  className="slot-btn"
                  style={{
                    display:"flex",alignItems:"center",justifyContent:"center",
                    padding:"8px 4px",borderRadius:9,cursor:disabled?"not-allowed":"pointer",
                    fontSize:13,fontWeight: active?600:400,fontFamily:"var(--font-mono)",
                    background: active?"var(--blue-700)":disabled?"var(--ink-100)":"var(--ink-50)",
                    color: active?"#fff":disabled?"var(--ink-500)":"var(--ink-700)",
                    boxShadow: active?"0 2px 8px rgba(58,127,181,.3)":"none",
                    border: active?"none":"1px solid var(--ink-200)",
                    textDecoration: isTaken ? "line-through" : "none",
                    transition:"all .12s",
                    whiteSpace:"nowrap",
                  }}
                >{t}</button>
              );
            })}
          </div>
        </div>

        {/* ── Therapist picker ── */}
        <div style={{marginBottom:26}}>
          {sectionLabel(tt("الأخصائي"), titleId + "-th")}
          <div role="group" aria-labelledby={titleId + "-th"} style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            {therapists.filter(t=>t.name!=="متاح").map(t => {
              const active = newTherapist === t.name;
              return (
                <button
                  key={t.name} type="button" aria-pressed={active ? "true" : "false"}
                  onClick={()=>setNewTherapist(t.name)}
                  style={{
                    display:"inline-flex",alignItems:"center",gap:8,minHeight:40,
                    padding:"8px 14px",borderRadius:10,border:"none",cursor:"pointer",
                    fontSize:13,fontWeight: active?600:500,
                    background: active?"var(--blue-700)":"var(--ink-100)",
                    color: active?"#fff":"var(--ink-700)",
                    boxShadow: active?"0 2px 8px rgba(58,127,181,.3)":"none",
                    transition:"all .12s",
                    whiteSpace:"nowrap",minWidth:0,
                  }}
                >
                  <div aria-hidden="true" style={{
                    width:22,height:22,borderRadius:"50%",flexShrink:0,
                    background: active?"rgba(255,255,255,.25)":(t.color+"33"),
                    color: active?"#fff":"var(--ink-900)",
                    display:"flex",alignItems:"center",justifyContent:"center",
                    fontSize:9,fontWeight:700,
                  }}>
                    {t.name.replace("د. ","").split(" ").map(x=>x[0]).join("").slice(0,2)}
                  </div>
                  {t.name}
                </button>
              );
            })}
          </div>
        </div>

        {/* ── Footer ── */}
        <div style={{
          display:"flex",alignItems:"center",justifyContent:"space-between",
          paddingTop:18,borderTop:"1px solid var(--ink-100)",gap:10,
        }}>
          <div style={{fontSize:12.5,color:"var(--ink-500)",whiteSpace:"nowrap"}} aria-live="polite">
            <I.Calendar size={12} style={{marginInlineEnd:4,verticalAlign:"middle"}}/>
            {selectedLabel} · <span className="mono">{newTime || "—"}</span>
          </div>
          <div style={{display:"flex",gap:8,flexShrink:0}}>
            <button type="button" className="btn btn-ghost" onClick={onClose} style={{whiteSpace:"nowrap"}}>{tt("إلغاء")}</button>
            <button
              type="button" className="btn btn-blue"
              disabled={!canSave}
              onClick={()=> canSave && onSave(newTime, newTherapist, newDateIso)}
              style={{whiteSpace:"nowrap",opacity:canSave?1:.55,cursor:canSave?"pointer":"not-allowed"}}
            >
              <I.Check size={13}/> {tt("تأكيد إعادة الجدولة")}
            </button>
          </div>
        </div>
      </div>
      <DialogFocusGuard boxRef={boxRef} at="end"/>
    </div>
  );
}

function AppointmentList() {
  const [statusFilter, setStatusFilter] = React.useState("الكل");
  const all = (window.scopeAppts ? window.scopeAppts(DATA.appts) : DATA.appts).filter(a=>a.status !== "متاح");
  const filtered = statusFilter==="الكل" ? all : all.filter(a => a.status === statusFilter);
  return (
    <div>
      <div className="card" style={{padding:14,marginBottom:14,display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
        <div style={{position:"relative",flex:"1 1 320px",maxWidth:380}}>
          <I.Search size={14} style={{position:"absolute",insetInlineEnd:11,top:"50%",transform:"translateY(-50%)",color:"var(--ink-400)"}}/>
          <input className="input" placeholder={tt("ابحث في المواعيد…")} style={{paddingInlineEnd:32}}/>
        </div>
        {/* Filter values are the stored statuses; only the labels are translated. */}
        <Segmented label={tt("حالة الموعد")} value={statusFilter} onChange={setStatusFilter}
          options={["الكل","مؤكد","معلّق","مكتمل","ملغي"].map(s => ({ value: s, label: tt(s) }))}/>
      </div>
      <div className="card" style={{overflow:"hidden"}}>
        <div className="tbl-scroll">
        <CardTable>
          <thead><tr><th>{tt("وقت")}</th><th>{tt("المريض")}</th><th>{tt("الطبيب")}</th><th>{tt("الأخصائي")}</th><th>{tt("الغرفة")}</th><th>{tt("النوع")}</th><th>{tt("الحالة")}</th><th><span className="sr-only">{tt("إجراءات")}</span></th></tr></thead>
          <tbody>
            {filtered.map(a=>(
              <tr key={a.id}>
                <td><span className="mono" style={{fontWeight:600}}>{a.time}</span> <span className="muted">· <span className="mono">{a.dur}</span> {tt("د")}</span></td>
                <td>
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <div className="av sm">{(a.patient||"—").split(" ").map(x=>x[0]).join("").slice(0,2)}</div>
                    {a.patient}
                  </div>
                </td>
                <td>{a.dr}</td>
                <td>{a.th}</td>
                <td>{a.room}</td>
                <td>{apptTypeLabel(a.type)}</td>
                <td><ApptBadge s={a.status}/></td>
                <td style={{whiteSpace:"nowrap"}}>
                  <WaReminderButton appt={a} iconOnly/>
                  <RowMenu size={14} items={[
                    { label:tt("تأكيد الموعد"), icon:<I.Check size={13}/>, onClick:async ()=>{
                      try {
                        if (window.KineticData) await window.KineticData.upsert("appts", { booking_id:a.id, patient_id:a.patient_id||null, status:"مؤكد" });
                        a.status = "مؤكد";
                        if (window.showToast) window.showToast(tt("تم تأكيد الموعد"),"success");
                      } catch (e) { console.warn("confirm appt failed", e); if (window.showToast) window.showToast(tt("تعذّر التأكيد"),"error"); }
                    }},
                    { label:tt("وضع كمكتمل"), icon:<I.Check size={13}/>, onClick:async ()=>{
                      try {
                        if (window.KineticData) await window.KineticData.upsert("appts", { booking_id:a.id, patient_id:a.patient_id||null, status:"مكتمل" });
                        a.status = "مكتمل";
                        if (window.showToast) window.showToast(tt("تم وضع الموعد كمكتمل"),"success");
                      } catch (e) { console.warn("complete appt failed", e); if (window.showToast) window.showToast(tt("تعذّر التحديث"),"error"); }
                    }},
                    { label:tt("إلغاء الموعد"), icon:<I.X size={13}/>, danger:true, onClick:async ()=>{
                      if (!window.confirm(tt("إلغاء موعد {name}؟", { name: a.patient||"" }))) return;
                      try {
                        if (window.KineticData) await window.KineticData.upsert("appts", { booking_id:a.id, patient_id:a.patient_id||null, status:"ملغي" });
                        a.status = "ملغي";
                        if (window.showToast) window.showToast(tt("تم إلغاء الموعد"),"success");
                      } catch (e) { console.warn("cancel appt failed", e); if (window.showToast) window.showToast(tt("تعذّر الإلغاء"),"error"); }
                    }},
                  ]}/>
                </td>
              </tr>
            ))}
          </tbody>
        </CardTable>
        </div>
      </div>
    </div>
  );
}

// ── BookingFlow — 5 steps ──────────────────────────────────────
// Earliest free slot for a doctor across the next 14 days, using the
// configured working window (no hardcoded hours).
function nextAvailableLabel(doctorId) {
  const slots = window.calendarSlots ? window.calendarSlots()
    : ["09:00","10:00","11:00","12:00","13:00","14:00","15:00","16:00","17:00"];
  for (let i = 0; i < 14; i++) {
    const d = new Date(Date.now() + i * 864e5);
    const iso = d.toISOString().slice(0, 10);
    const booked = new Set((DATA.appts || [])
      .filter(a => a.doctor_id === doctorId && a.date === iso && a.status !== "ملغي")
      .map(a => a.time));
    const free = slots.find(t => !booked.has(t));
    if (free) {
      const lbl = i === 0 ? tt("اليوم") : i === 1 ? tt("غدًا") : fmtDate(d, "dayMonth");
      return `${lbl} ${free}`;
    }
  }
  return tt("لا يوجد قريبًا");
}

// ── BookingFlow — 5 steps, all DB-driven, persists on confirm ──
// The therapist appointment is the default and required booking; the
// doctor step is optional and only fills in when the receptionist
// explicitly assigns one (new patients book directly with a therapist).
function BookingFlow({ onDone }) {
  const [step, setStep] = React.useState(1);
  const [picks, setPicks] = React.useState({
    // Step 1 — patient first: pick an existing record or enter initial info.
    patientMode: "existing",           // existing | new
    patientId: null,
    newName: "", newPhone: "",
    deptId:null, doctorId:null, therapist:null, date:null, slot:null, notes:"",
    allowConsecutive: false,           // therapist override of the free-day rule
    updatePreferredTime: false,        // persist the chosen slot as the new fixed time
  });
  const [busy, setBusy] = React.useState(false);
  const steps = [tt("المريض"),tt("الأخصائي"),tt("الطبيب (اختياري)"),tt("التاريخ"),tt("الوقت")];
  const LAST = steps.length;
  const update = (patch) => setPicks(p => ({ ...p, ...patch }));
  // The saved recurring schedule for the selected (existing) patient — used
  // to suggest the fixed days/time in the date and time steps.
  const selectedPatient = picks.patientMode === "existing" && picks.patientId
    ? (DATA.patients || []).find(p => (p.patient_id || p.id) === picks.patientId) || null
    : null;
  const patientSchedule = selectedPatient
    ? scheduleForPatient(selectedPatient.patient_id || selectedPatient.id)
    : null;
  // Only offer active specialists for new assignments; historical
  // appointments keep their original therapist_id untouched.
  const therapists = (window.scopeTherapists ? window.scopeTherapists(DATA.therapists) : DATA.therapists)
    .filter(t => t.active !== false);

  // Validate the patient step before advancing.
  function patientStepValid() {
    if (picks.patientMode === "existing") {
      if (!picks.patientId) { window.showToast && window.showToast(tt("اختر المريض أو أدخل بياناته الأولية"), "error"); return false; }
      return true;
    }
    if (!picks.newName.trim()) { window.showToast && window.showToast(tt("أدخل اسم المريض"), "error"); return false; }
    if (!picks.newPhone.trim()) { window.showToast && window.showToast(tt("أدخل رقم الهاتف"), "error"); return false; }
    return true;
  }

  // Resolve the patient at confirm time: existing id, phone match, or a new
  // record flagged "ملف غير مكتمل" (same policy as Quick Booking).
  async function resolvePatient() {
    if (picks.patientMode === "existing") {
      return (DATA.patients || []).find(p => (p.patient_id || p.id) === picks.patientId) || null;
    }
    const matched = findPatientByPhone(picks.newPhone);
    if (matched) return matched;
    return await window.KineticData.upsert("patients", {
      patient_id: newRecordId("P-"),
      name: picks.newName.trim(),
      phone: picks.newPhone.trim(),
      diagnosis: "", notes: "حجز جديد — بيانات أولية",
      status: INCOMPLETE_STATUS,
      registered: new Date().toISOString().slice(0, 10),
      created_at: new Date().toISOString(),
    });
  }

  async function confirm() {
    if (!picks.therapist) return window.showToast && window.showToast(tt("اختر الأخصائي"), "error");
    if (!picks.date) return window.showToast && window.showToast(tt("اختر التاريخ"), "error");
    if (!picks.slot) return window.showToast && window.showToast(tt("اختر الوقت"), "error");
    if (!patientStepValid()) return;
    // Default rule: one free day between the patient's sessions unless the
    // therapist explicitly overrides (checkbox in the time step).
    if (selectedPatient && !picks.allowConsecutive) {
      const clash = violatesFreeDayRule(selectedPatient.patient_id || selectedPatient.id, picks.date);
      if (clash) {
        return window.showToast && window.showToast(
          tt("للمريض موعد في {date} — القاعدة تتطلب يوم راحة بين الجلسات. فعّل «السماح بأيام متتالية» للتجاوز.", { date: apptDateIso(clash) }),
          "error");
      }
    }
    setBusy(true);
    try {
      const patient = await resolvePatient();
      if (!patient) throw new Error("patient-missing");
      const patientId = patient.patient_id || patient.id;
      // The doctor (and their department) is attached only when the
      // receptionist explicitly picked one in the optional step.
      const doctor = picks.doctorId ? (DATA.doctors || []).find(d => d.id === picks.doctorId) : null;
      const dept = doctor
        ? (DATA.departments || []).find(d => d.id === (picks.deptId || doctor.department_id))
        : null;
      const therapistRow = (DATA.therapists || []).find(t => t.name === picks.therapist);
      await window.KineticData.upsert("appts", {
        booking_id: newRecordId("A-"),
        patient_id: patientId,
        patient: patient.name || "",
        doctor_id: doctor ? doctor.id : null,
        department_id: dept ? dept.id : null,
        therapist_id: therapistRow ? therapistRow.id : null,
        dr: doctor ? doctor.name : "",
        th: picks.therapist || "",
        dept: dept ? dept.name_ar : "",
        date: picks.date,
        time: picks.slot,
        status: "مؤكد",
        type: doctor ? `جلسة + استشارة ${dept ? dept.name_ar : "طبيب"}` : "جلسة علاج طبيعي",
        notes: picks.notes || "",
        dur: (window.calendarConfig ? window.calendarConfig().slotMinutes : 45),
        created_at: new Date().toISOString(),
      });
      // "Update Preferred Time": only rewrite the saved fixed time when the
      // receptionist explicitly asked — one-time changes leave it alone.
      if (picks.updatePreferredTime && patientSchedule && picks.slot !== patientSchedule.time) {
        await window.KineticData.upsert("schedules", {
          ...patientSchedule,
          schedule_id: patientSchedule.schedule_id || patientSchedule.id,
          time: picks.slot,
          updated_at: new Date().toISOString(),
        });
      }
      window.showToast && window.showToast(tt("تم تأكيد الحجز"), "success");
      onDone && onDone();
    } catch (e) {
      console.warn("booking failed", e);
      window.showToast && window.showToast(tt("تعذّر الحجز"), "error");
    } finally { setBusy(false); }
  }

  // `patch`: a choice made by the same click that moves on (a specialist
  // card, a date). It is not in `picks` yet — React applies update() on
  // the next render — so the step is checked against picks + patch.
  function next(patch) {
    const p = patch ? { ...picks, ...patch } : picks;
    if (patch) update(patch);
    if (step === 1 && !patientStepValid()) return;
    if (step === 2 && !p.therapist) {
      window.showToast && window.showToast(tt("اختر الأخصائي — الموعد مع الأخصائي إلزامي"), "error");
      return;
    }
    if (step < LAST) setStep(step + 1); else confirm();
  }

  // A step's buttons leave with it (a specialist card, a date): the focus
  // moves to the new step instead of falling back to the page.
  const stepBoxRef = React.useRef(null);
  const firstStep = React.useRef(true);
  React.useEffect(() => {
    if (firstStep.current) { firstStep.current = false; return; }
    const box = stepBoxRef.current;
    const a = document.activeElement;
    if (box && (!a || a === document.body || !document.contains(a))) __focusEl(box);
  }, [step]);
  // On phones the stepper scrolls sideways: keep the current step in view.
  const stepperRef = React.useRef(null);
  React.useEffect(() => {
    const box = stepperRef.current;
    const cur = box && box.querySelector('[aria-current="step"]');
    if (!box || !cur || box.scrollWidth <= box.clientWidth) return;
    const b = box.getBoundingClientRect(), c = cur.getBoundingClientRect();
    if (c.left < b.left || c.right > b.right) box.scrollLeft += (c.left + c.width / 2) - (b.left + b.width / 2);
  }, [step]);

  return (
    <div>
      <div className="card" style={{padding:18,marginBottom:18,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        {/* Focusable so a keyboard can scroll it on phones. */}
        <div ref={stepperRef} className="stepper" role="group" tabIndex={0} aria-label={tt("خطوات الحجز — الخطوة {n} من {total}: {name}", { n: step, total: LAST, name: steps[step-1] })} style={{gap:0,flex:1}}>
          {steps.map((s,i)=>(
            <React.Fragment key={i}>
              <div aria-current={i+1===step ? "step" : undefined} style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
                <div aria-hidden="true" style={{
                  width:24,height:24,borderRadius:999,
                  background:i+1<step?"var(--green)":i+1===step?"var(--blue-700)":"var(--ink-100)",
                  color:i+1<=step?"#fff":"var(--ink-500)",
                  display:"flex",alignItems:"center",justifyContent:"center",
                  fontSize:11,fontWeight:600
                }}>{i+1<step ? <I.Check size={12}/> : i+1}</div>
                <span className="step-label" style={{fontSize:12.5,fontWeight:i+1===step?600:500,color:i+1===step?"var(--ink-900)":"var(--ink-500)"}}>{s}</span>
              </div>
              {i<steps.length-1 && <div style={{flex:1,minWidth:12,height:1,background:i+1<step?"var(--green)":"var(--ink-200)",margin:"0 14px"}}/>}
            </React.Fragment>
          ))}
        </div>
      </div>

      <div ref={stepBoxRef} tabIndex={-1} aria-label={tt("الخطوة {n}: {name}", { n: step, name: steps[step-1] })} role="group" className="card card-pad" style={{minHeight:420,marginBottom:18,outline:"none"}}>
        {step===1 && <PatientStep picks={picks} update={update}/>}
        {step===2 && (therapists.length ? <PickGrid title={tt("اختر أخصائيًا — الموعد مع الأخصائي إلزامي")}
          items={therapists.map(t=>({ id:t.name, l:t.name, sub:`${t.spec} · ${tt("حمل {load}/{max}", { load: t.load, max: t.max })}`, ic:t.name.split(" ").map(x=>x[0]).join(""), color:t.color, count:tt("{n} فترة متاحة", { n: t.max-t.load }) }))}
          avatar
          onPick={v=>next({ therapist: v })}
          selected={picks.therapist}
        /> : <EmptyState icon={<I.Users size={22}/>} title={tt("لا أخصائيين بعد")} body={tt("أضف الأخصائيين من الإعدادات.")}/>)}
        {step===3 && <OptionalDoctorStep picks={picks} update={update} onSkip={()=>{ update({doctorId:null, deptId:null}); setStep(4); }} onPicked={()=>setStep(4)}/>}
        {step===4 && <DatePick value={picks.date} onPick={v=>next({ date: v })} schedule={patientSchedule} patient={selectedPatient} onGenerated={onDone}/>}
        {step===5 && <SlotPick picks={picks} update={update} schedule={patientSchedule}/>}
      </div>

      <div style={{display:"flex",justifyContent:"space-between",flexWrap:"wrap",gap:10}}>
        <button className="btn btn-secondary" disabled={step===1} onClick={()=>setStep(step-1)} style={{opacity:step===1?.5:1}}>
          <I.ArrowLeft size={13}/> {tt("رجوع")}
        </button>
        <div style={{display:"flex",gap:10}}>
          <button className="btn btn-ghost" onClick={onDone}>{tt("إلغاء")}</button>
          <button className="btn btn-blue" disabled={busy} onClick={()=>next()}>
            {busy ? <span className="spin" style={{width:14,height:14,border:"2px solid #fff",borderTopColor:"transparent",borderRadius:"50%"}}/> : <>{step<LAST ? tt("متابعة") : tt("تأكيد الحجز")} <I.ArrowRight size={13}/></>}
          </button>
        </div>
      </div>
    </div>
  );
}

// Step 1 — the patient comes first: search the database for an existing
// record, or capture the initial info (name + phone) for a new one. New
// patients are created on confirm with status "ملف غير مكتمل" so the
// receptionist completes the file later (same policy as Quick Booking).
function PatientStep({ picks, update }) {
  const patients = React.useMemo(
    () => (window.scopePatients ? window.scopePatients(DATA.patients) : DATA.patients) || [],
    [DATA.patients]
  );
  const isNew = picks.patientMode === "new";
  const matched = isNew ? findPatientByPhone(picks.newPhone) : null;
  const selected = patients.find(p => (p.patient_id || p.id) === picks.patientId);
  return (
    <div>
      <div className="h2" style={{marginBottom:6}}>{tt("بيانات المريض")}</div>
      <div className="muted" style={{fontSize:13,marginBottom:18}}>{tt("ابدأ بتحديد المريض — ابحث عن ملف موجود أو أدخل البيانات الأولية لمريض جديد.")}</div>

      <Segmented label={tt("المريض")} value={isNew ? "new" : "existing"} onChange={m=>update({patientMode:m})} style={{marginBottom:18}}
        options={[{ value:"existing", label:tt("مريض مسجّل") }, { value:"new", label:tt("مريض جديد") }]}/>

      {!isNew ? (
        <div style={{maxWidth:460}}>
          <div className="label">{tt("ابحث عن المريض")}</div>
          <PatientCombobox value={picks.patientId || ""} onChange={id=>update({ patientId: id })} patients={patients}/>
          {selected && (
            <div style={{marginTop:14,padding:14,border:"1px solid var(--ink-200)",borderRadius:12,display:"flex",alignItems:"center",gap:12}}>
              <div className="av md">{initialsOf(selected.name)}</div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontWeight:600,fontSize:13.5}}>{selected.name}</div>
                <div className="muted mono" style={{fontSize:11.5}}>{selected.patient_id || selected.id}{selected.phone ? ` · ${selected.phone}` : ""}</div>
              </div>
              <I.Check size={16} style={{color:"var(--green)"}}/>
            </div>
          )}
          {patients.length===0 && <div className="muted" style={{fontSize:12.5,marginTop:12}}>{tt("لا مرضى مسجّلين بعد — اختر «مريض جديد» لإدخال البيانات الأولية.")}</div>}
        </div>
      ) : (
        <div style={{maxWidth:520}}>
          <div className="rgrid c-sm" style={{"--gtc":"1fr 1fr",gap:12}}>
            <Field label={tt("اسم المريض")} required>
              <input className="input" value={picks.newName} onChange={e=>update({newName:e.target.value})} placeholder={tt("الاسم الكامل")} autoFocus/>
            </Field>
            <Field label={tt("رقم الهاتف")} required>
              <input className="input" value={picks.newPhone} onChange={e=>update({newPhone:e.target.value})} placeholder="+20 1xx xxx xxxx" dir="ltr" style={{textAlign:IS_RTL ? "right" : "left"}}/>
            </Field>
          </div>
          {matched && (
            <div style={{fontSize:12,color:"var(--green)",marginTop:4,display:"flex",alignItems:"center",gap:6}}>
              <I.Check size={12}/> {ttx("رقم معروف — سيُربط الحجز بملف {name}", { name: <strong>{matched.name}</strong> })}
            </div>
          )}
          <div className="muted" style={{fontSize:12,marginTop:12,lineHeight:1.6,padding:"10px 12px",background:"var(--blue-50)",border:"1px solid var(--blue-100)",borderRadius:8}}>
            {tt("سيُنشأ ملف مبدئي بحالة «ملف غير مكتمل» عند تأكيد الحجز، وتُستكمل بقية البيانات لاحقًا من صفحة المرضى.")}
          </div>
        </div>
      )}
    </div>
  );
}

// Step 3 — OPTIONAL doctor consultation. The default path is therapist-only
// treatment; a doctor appointment is created only when the receptionist
// deliberately assigns one here. Skipping is the primary action.
function OptionalDoctorStep({ picks, update, onSkip, onPicked }) {
  const depts = activeDepartments().filter(d => doctorsInDept(d.id).length > 0);
  const deptId = picks.deptId || "";
  const doctors = deptId ? doctorsInDept(deptId) : (DATA.doctors || []).filter(d => d.active !== false);
  return (
    <div>
      <div className="h2" style={{marginBottom:6}}>{tt("استشارة طبيب (اختياري)")}</div>
      <div className="muted" style={{fontSize:13,marginBottom:14,lineHeight:1.6}}>
        {tt("العلاج يبدأ مع الأخصائي مباشرةً — لا يُشترط موعد طبيب. أضف طبيبًا فقط إذا قررتَ أن المريض يحتاج استشارة.")}
      </div>
      <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap",marginBottom:18}}>
        <button className="btn btn-blue" onClick={onSkip}>
          <I.ArrowRight size={13}/> {tt("متابعة بدون طبيب")}
        </button>
        {depts.length > 0 && (
          <select className="input" style={{maxWidth:240}} value={deptId} aria-label={tt("القسم")}
            onChange={e=>update({ deptId: e.target.value || null, doctorId: null })}>
            <option value="">{tt("كل الأقسام")}</option>
            {depts.map(d=>(<option key={d.id} value={d.id}>{deptLabel(d)}</option>))}
          </select>
        )}
        {picks.doctorId && (
          <button className="btn btn-ghost" style={{fontSize:12}} onClick={()=>update({doctorId:null})}>
            <I.X size={12}/> {tt("إزالة الطبيب المحدد")}
          </button>
        )}
      </div>
      {doctors.length === 0 ? (
        <EmptyState icon={<I.Stethoscope size={22}/>} title={tt("لا أطباء متاحون")}
          body={tt("تابع بدون طبيب — يمكن إنشاء موعد طبيب لاحقًا عند الحاجة.")}/>
      ) : (
      <div className="grid-3" style={{gap:14}}>
        {doctors.map(d=>{
          const st = DOCTOR_STATUS[d.status] || DOCTOR_STATUS.available;
          const isSel = picks.doctorId === d.id;
          return (
            <button key={d.id} onClick={()=>{ update({ doctorId: d.id, deptId: d.department_id || deptId || null }); onPicked && onPicked(); }}
              style={{
                padding:16,textAlign:"end",cursor:"pointer",
                border:`1px solid ${isSel?"var(--blue-500)":"var(--ink-200)"}`,
                borderRadius:14,background: isSel?"var(--blue-50)":"#fff",
                display:"flex",flexDirection:"column",gap:8, transition:"all .15s"
              }}>
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                {d.photo
                  ? <img src={d.photo} alt="" style={{width:44,height:44,borderRadius:12,objectFit:"cover"}}/>
                  : <div className="av lg" style={{background:(d.color||"#7BBDE8")+"33",color:d.color||"var(--blue-700)"}}>{(d.name||"").replace("د. ","").split(" ").map(x=>x[0]||"").join("").slice(0,2)}</div>}
                <div style={{minWidth:0}}>
                  <div style={{fontWeight:600,fontSize:14}}>{d.name}</div>
                  <div className="muted" style={{fontSize:11.5}}>{d.specialization || "—"}</div>
                </div>
              </div>
              <div className="muted" style={{fontSize:11.5,display:"flex",alignItems:"center",gap:5}}><I.Activity size={12}/> {tt("خبرة {n} سنة", { n: d.experience_years||0 })}</div>
              {d.schedule && <div className="muted" style={{fontSize:11.5,display:"flex",alignItems:"center",gap:5}}><I.Clock size={12}/> {d.schedule}</div>}
              <div style={{marginTop:"auto",display:"flex",alignItems:"center",justifyContent:"space-between",gap:6,paddingTop:6}}>
                <span className={"badge " + st.badge}><span className="dot"></span>{tt(st.l)}</span>
                <span className="mono" style={{fontSize:11,color:"var(--blue-700)"}}>{tt("أقرب: {v}", { v: nextAvailableLabel(d.id) })}</span>
              </div>
            </button>
          );
        })}
      </div>
      )}
    </div>
  );
}

function PickGrid({ title, items, onPick, selected, avatar }) {
  return (
    <div>
      <div className="h2" style={{marginBottom:18}}>{title}</div>
      <div className="grid-3" style={{gap:14}}>
        {items.map(it=>(
          <button key={it.id} onClick={()=>onPick(it.id)}
            style={{
              padding:18,textAlign:"end",cursor:"pointer",
              border:`1px solid ${selected===it.id?"var(--blue-500)":"var(--ink-200)"}`,
              borderRadius:14,background: selected===it.id?"var(--blue-50)":"#fff",
              display:"flex",flexDirection:"column",gap:10, transition:"all .15s"
            }}
            onMouseEnter={e=>{e.currentTarget.style.borderColor="var(--blue-500)";e.currentTarget.style.background="var(--blue-50)";}}
            onMouseLeave={e=>{if(selected!==it.id){e.currentTarget.style.borderColor="var(--ink-200)";e.currentTarget.style.background="#fff";}}}
          >
            {avatar ? (
              <div className="av lg" style={{background: (it.color||"#7BBDE8")+"33",color:it.color||"var(--blue-700)"}}>{it.ic}</div>
            ) : (
              <div style={{width:38,height:38,borderRadius:11,background:"var(--blue-100)",color:"var(--blue-700)",display:"flex",alignItems:"center",justifyContent:"center"}}>{it.ic}</div>
            )}
            <div>
              <div style={{fontWeight:600,fontSize:14.5}}>{it.l}</div>
              <div className="muted" style={{fontSize:12,marginTop:3}}>{it.sub}</div>
            </div>
            <div style={{marginTop:"auto",fontSize:11.5,color:"var(--blue-700)",display:"flex",alignItems:"center",gap:4}}>
              <span className="dot" style={{background:"var(--blue-700)"}}></span>{it.count}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function DatePick({ value, onPick, schedule, patient, onGenerated }) {
  const [viewMonth, setViewMonth] = React.useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [genBusy, setGenBusy] = React.useState(false);
  // Weekday initials as Arabic calendars print them (short names in
  // English); the full name is the header's accessible name.
  const fullDays = weekdayNames("long");
  const days = (IS_RTL ? ["ح","ن","ث","ر","خ","ج","س"] : weekdayNames("short")).map((d, i) => [d, fullDays[i]]);
  const y = viewMonth.getFullYear(), m = viewMonth.getMonth();
  const startDow = new Date(y, m, 1).getDay();
  const total = new Date(y, m + 1, 0).getDate();
  const todayIso = new Date().toISOString().slice(0, 10);
  const iso = (n) => `${y}-${String(m+1).padStart(2,"0")}-${String(n).padStart(2,"0")}`;
  const monthLabel = fmtDate(viewMonth, "month");
  const quick = [
    { l:tt("اليوم"), d: todayIso },
    { l:tt("غدًا"), d: new Date(Date.now()+864e5).toISOString().slice(0,10) },
    { l:tt("بعد غد"), d: new Date(Date.now()+2*864e5).toISOString().slice(0,10) },
  ];
  // Saved recurring pattern: highlight its weekdays on the calendar and
  // offer one-click generation of the upcoming sessions.
  const schedDays = schedule ? scheduleDays(schedule) : [];
  async function generateUpcoming() {
    if (!schedule || !patient) return;
    setGenBusy(true);
    try {
      const made = await generateFromSchedule(patient, schedule);
      window.showToast && window.showToast(
        made.length ? tt("أُنشئ {n} موعدًا حسب الجدول الثابت", { n: made.length }) : tt("لا مواعيد جديدة — الأيام القادمة محجوزة بالفعل"),
        made.length ? "success" : "info");
      if (made.length && onGenerated) onGenerated();
    } catch (e) {
      console.warn("generate from schedule failed", e);
      window.showToast && window.showToast(tt("تعذّر إنشاء المواعيد"), "error");
    } finally { setGenBusy(false); }
  }
  return (
    <div>
      <div className="h2" style={{marginBottom:18}}>{tt("اختر تاريخًا")}</div>
      {schedule && (
        <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap",padding:"12px 16px",marginBottom:16,
          background:"var(--blue-50)",border:"1px solid var(--blue-100)",borderRadius:12}}>
          <I.Calendar size={15} style={{color:"var(--blue-700)",flexShrink:0}}/>
          <div style={{flex:1,minWidth:220,fontSize:13}}>
            <strong>{tt("الجدول الثابت للمريض:")}</strong> {scheduleDaysLabel(schedule)} · <span className="mono">{schedule.time}</span>
            <div className="muted" style={{fontSize:11.5,marginTop:2}}>{tt("الأيام المطابقة مميزة في التقويم — أو أنشئ كل المواعيد القادمة بضغطة واحدة.")}</div>
          </div>
          <button className="btn btn-blue" disabled={genBusy} onClick={generateUpcoming} style={{whiteSpace:"nowrap"}}>
            {genBusy ? tt("جارٍ الإنشاء…") : tt("إنشاء المواعيد القادمة")}
          </button>
        </div>
      )}
      <div className="rgrid c-lg" style={{"--gtc":"1.4fr 1fr",gap:24}}>
        <div className="card" style={{padding:18,boxShadow:"none"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
            {/* LTR icon names: index.html mirrors them inside .btn, so «السابق» points right in RTL. */}
            <button type="button" className="btn btn-ghost btn-icon" aria-label={tt("الشهر السابق")} onClick={()=>setViewMonth(new Date(y,m-1,1))}><I.ArrowLeft size={14}/></button>
            <div className="h3" aria-live="polite">{monthLabel}</div>
            <button type="button" className="btn btn-ghost btn-icon" aria-label={tt("الشهر التالي")} onClick={()=>setViewMonth(new Date(y,m+1,1))}><I.ArrowRight size={14}/></button>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:6}}>
            {days.map(([d, full],i)=>(<div key={i} className="muted" title={full} aria-label={full} style={{textAlign:"center",fontSize:12,padding:"6px 0"}}>{d}</div>))}
            {Array.from({length:startDow}).map((_,i)=>(<div key={"e"+i}></div>))}
            {Array.from({length:total},(_,i)=>i+1).map(n=>{
              const dIso = iso(n);
              const isPast = dIso < todayIso;
              const isSel = value === dIso;
              const isSched = !isPast && schedDays.includes(new Date(dIso + "T00:00:00").getDay());
              return (
                <button key={n} type="button" disabled={isPast} onClick={()=>onPick(dIso)} aria-pressed={isSel ? "true" : "false"}
                  aria-label={dIso + (isSched ? " — " + tt("يوم من الجدول الثابت") : "")}
                  title={isSched ? tt("يوم من الجدول الثابت") : undefined}
                  style={{
                    height:40,minWidth:0,padding:0,borderRadius:9,cursor:isPast?"default":"pointer",
                    border:isSel?"1px solid var(--blue-700)":isSched?"1px dashed var(--blue-700)":"1px solid transparent",
                    background: isSel?"var(--blue-700)":isSched?"var(--blue-50)":"transparent",
                    color: isSel?"#fff":isPast?"var(--ink-500)":"var(--ink-900)",opacity:isPast ? .55 : 1,
                    fontWeight:isSel?600:500,fontSize:13
                  }} className="mono">{n}</button>
              );
            })}
          </div>
        </div>
        <div>
          <div className="label">{tt("اختيار سريع")}</div>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {quick.map(q=>(
              <button key={q.l} className="btn btn-secondary" style={{justifyContent:"flex-start",padding:"11px 14px"}} onClick={()=>onPick(q.d)}>
                <I.Calendar size={14}/> {q.l}
              </button>
            ))}
          </div>
          <div style={{padding:14,background:"var(--blue-50)",border:"1px solid var(--blue-100)",borderRadius:12,marginTop:18,fontSize:12.5}}>
            {tt("اختيار التاريخ يعرض الأوقات المتاحة فعليًا للأخصائي المحدد فقط.")}
          </div>
        </div>
      </div>
    </div>
  );
}

function SlotPick({ picks, update, schedule }) {
  // Slots come from clinic settings (working window + slot duration).
  const ALL = window.calendarSlots ? window.calendarSlots()
    : ["08:30","09:00","09:30","10:00","10:30","11:00","11:30","12:00","13:00","13:30","14:00","14:30","15:00","15:30","16:00","16:30","17:00"];
  const morning = ALL.filter(t => t < "12:00");
  const afternoon = ALL.filter(t => t >= "12:00");
  const doctor = picks.doctorId ? (DATA.doctors || []).find(d => d.id === picks.doctorId) : null;
  const dept = doctor ? (DATA.departments || []).find(d => d.id === (picks.deptId || doctor.department_id)) : null;
  // Slots already taken for this THERAPIST on the chosen date — the
  // therapist session is the required booking, so conflicts follow them.
  const therapistRow = (DATA.therapists || []).find(t => t.name === picks.therapist);
  const booked = new Set((DATA.appts || [])
    .filter(a =>
      apptDateIso(a) === picks.date && !isCancelledAppt(a) && a.status !== "متاح" &&
      ((picks.therapist && a.th === picks.therapist) ||
       (therapistRow && a.therapist_id && (a.therapist_id === therapistRow.id || a.therapist_id === therapistRow.staff_id))))
    .map(a => a.time));
  // Patient was resolved in step 1 (existing record or new initial info).
  const existing = (DATA.patients || []).find(p => (p.patient_id || p.id) === picks.patientId);
  const patientName = picks.patientMode === "new"
    ? (findPatientByPhone(picks.newPhone) || { name: picks.newName }).name
    : (existing && existing.name);

  // Preferred fixed time: pre-select it automatically when free so the
  // receptionist only confirms.
  const preferredTime = schedule ? schedule.time : null;
  React.useEffect(() => {
    if (preferredTime && !picks.slot && ALL.includes(preferredTime) && !booked.has(preferredTime)) {
      update({ slot: preferredTime });
    }
  }, []);

  const SlotBtn = ({ t }) => {
    const u = booked.has(t);
    const sel = picks.slot === t;
    const pref = t === preferredTime;
    return (
      <button type="button" disabled={u} onClick={()=>update({ slot: t })} className="mono slot-btn" aria-pressed={sel ? "true" : "false"}
        aria-label={u ? tt("{time} — محجوز", { time: t }) : pref ? tt("{time} — الوقت المفضل للمريض", { time: t }) : undefined}
        title={pref ? tt("الوقت المفضل للمريض") : undefined}
        style={{
          padding:"10px 16px",borderRadius:10,
          border: pref && !sel ? "1px dashed var(--blue-700)" : "1px solid var(--ink-200)",
          background: sel?"var(--blue-700)":u?"var(--ink-100)":pref?"var(--blue-50)":"#fff",
          color: sel?"#fff":u?"var(--ink-500)":"var(--ink-900)",
          textDecoration:u?"line-through":"none",
          cursor:u?"not-allowed":"pointer", fontSize:13, fontWeight: pref&&!sel?600:500
        }}>{t}{pref ? " ★" : ""}</button>
    );
  };

  return (
    <div>
      <div className="h2" style={{marginBottom:6}}>{tt("اختر الوقت")}</div>
      <div className="muted" style={{marginBottom:18,fontSize:13}}>
        {picks.therapist ? tt("المتاح لـ{name}", { name: picks.therapist }) : tt("المتاح")} · {picks.date || "—"} · {tt("جلسات {n} دقيقة", { n: window.calendarConfig ? window.calendarConfig().slotMinutes : 45 })}
      </div>
      {preferredTime && (
        <div style={{display:"flex",alignItems:"center",gap:8,fontSize:12.5,marginBottom:14,padding:"8px 12px",background:"var(--blue-50)",border:"1px solid var(--blue-100)",borderRadius:8}}>
          <I.Clock size={13} style={{color:"var(--blue-700)"}}/>
          {ttx("الوقت المفضل المحفوظ لهذا المريض: {time} — محدد تلقائيًا إن كان متاحًا.", { time: <strong className="mono">{preferredTime}</strong> })}
        </div>
      )}

      <div className="label">{tt("الصباح")}</div>
      <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:18}}>{morning.map(t=><SlotBtn key={t} t={t}/>)}</div>

      <div className="label">{tt("بعد الظهر")}</div>
      <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:18}}>{afternoon.map(t=><SlotBtn key={t} t={t}/>)}</div>

      <div className="label" id="slotpick-notes">{tt("ملاحظات (اختياري)")}</div>
      <textarea className="input" rows={2} aria-labelledby="slotpick-notes" style={{padding:10,resize:"vertical",marginBottom:8}} value={picks.notes || ""} onChange={e=>update({ notes: e.target.value })} placeholder={tt("سبب الزيارة…")}/>

      {schedule && picks.slot && picks.slot !== preferredTime && (
        <label style={{display:"flex",alignItems:"center",gap:8,fontSize:12.5,marginBottom:6,cursor:"pointer"}}>
          <input type="checkbox" checked={Boolean(picks.updatePreferredTime)} onChange={e=>update({ updatePreferredTime: e.target.checked })}/>
          {ttx("تحديث الوقت المفضل الدائم إلى {time} (وإلا فهذا تغيير لمرة واحدة فقط)", { time: <span className="mono">{picks.slot}</span> })}
        </label>
      )}
      <label style={{display:"flex",alignItems:"center",gap:8,fontSize:12.5,marginBottom:8,cursor:"pointer"}}>
        <input type="checkbox" checked={Boolean(picks.allowConsecutive)} onChange={e=>update({ allowConsecutive: e.target.checked })}/>
        {tt("السماح بأيام متتالية (تجاوز قاعدة يوم الراحة — بقرار الأخصائي)")}
      </label>

      <div style={{padding:18,background:"var(--ink-50)",borderRadius:12,marginTop:8}}>
        <div className="h3" style={{marginBottom:10}}>{tt("ملخّص الحجز")}</div>
        <div className="grid-4" style={{fontSize:12.5}}>
          <div><div className="muted">{tt("الأخصائي")}</div><div>{picks.therapist||"—"}</div></div>
          <div><div className="muted">{tt("الطبيب")}</div><div>{doctor?doctor.name:tt("بدون طبيب")}</div></div>
          <div><div className="muted">{tt("القسم")}</div><div>{dept?deptLabel(dept):"—"}</div></div>
          <div><div className="muted">{tt("التاريخ والوقت")}</div><div className="mono">{picks.date||"—"} {picks.slot||""}</div></div>
        </div>
        <div style={{marginTop:8,fontSize:12.5}}><span className="muted">{tt("المريض:")} </span>{patientName || "—"}</div>
      </div>
    </div>
  );
}

Object.assign(window, { Appointments });
