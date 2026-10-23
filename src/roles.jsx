

// ===== src/roles.jsx =====
// Role identity, navigation visibility, data scoping, and per-role home dashboards.
// Each "job" (مدير / موظف استقبال / طبيب / الأخصائي) gets its OWN landing,
// OWN sidebar, and sees ONLY its OWN data.

// ── Identity per role ──────────────────────────────────────────
// `match` is the name as it appears in DATA (dr / th fields) so we can scope.
const ROLE_PROFILES = {
  "مدير":          { name:"أمير",            email:"amir@kinetic.eg",   match:null,             color:"#7BBDE8", title:"مدير الفرع" },
  "موظف استقبال":  { name:"دينا فؤاد",       email:"dina@kinetic.eg",   match:null,             color:"#3FA984", title:"مكتب الاستقبال" },
  "طبيب":          { name:"د. ياسمين عادل",  email:"yasmin@kinetic.eg", match:"د. ياسمين عادل", color:"#7E6BD3", title:"أخصائي تأهيل" },
  "الأخصائي":       { name:"كريم صالح",       email:"karim@kinetic.eg",  match:"كريم صالح",       color:"#7BBDE8", title:"أخصائي علاج طبيعي" },
};

// ── Navigation routes ──────────────────────────────────────────
// Which routes each role may reach (also drives sidebar visibility).
const ROLE_ROUTES = {
  "مدير":          ["dashboard","patients","appointments","treatments","sessions","payments","packages","campaigns","reports","branches","settings"],
  "موظف استقبال":  ["dashboard","appointments","patients","payments","reports"],
  "طبيب":          ["dashboard","patients","appointments","treatments","sessions","reports","settings"],
  "الأخصائي":       ["dashboard","appointments","sessions","patients"],
};

// Tailored label for each role's home tab.
const ROLE_DASH_LABEL = {
  "مدير":"لوحة التحكم", "موظف استقبال":"لوحة الاستقبال", "طبيب":"يومي الإكلينيكي", "الأخصائي":"جدول يومي",
};

const ROLE_DEFAULT = {
  "مدير":"dashboard", "موظف استقبال":"dashboard", "طبيب":"dashboard", "الأخصائي":"dashboard",
};

function roleScope(role){
  return ({"مدير":"all","موظف استقبال":"reception","طبيب":"doctor","الأخصائي":"therapist"})[role] || "none";
}
function roleDefaultRoute(role){ return ROLE_DEFAULT[role] || "dashboard"; }
function roleAllows(role, route){
  // Admin-defined custom sections (prefix "custom:") are always allowed for admin.
  if (typeof route === "string" && route.startsWith("custom:")) return role === "مدير";
  const a = ROLE_ROUTES[role];
  // Default-deny: unknown role or missing route list = no access. This is
  // client-side UX only — server RLS is the real enforcement — but it stops
  // a mistyped role from silently unlocking everything.
  if (!Array.isArray(a)) return false;
  return a.includes(route);
}

// ── Data scoping (reads window.ME, set by App) ─────────────────
// These are DEFENCE-IN-DEPTH UX filters. They hide rows from a role's UI
// but do NOT enforce access — real enforcement lives in Supabase RLS.
//
// `me.match` is the logged-in clinician's own name (set from the staff
// record at sign-in, not a fixed profile). We match on name OR the
// resolved therapist_id so the filter works for real production accounts,
// not just the demo personas.
function myName(){ const me = window.ME; return me ? (me.match || me.name || "") : ""; }
// The DATA.therapists row id for the logged-in therapist (by name), so we
// can also match patients/appointments linked via therapist_id.
function myTherapistId(){
  const nm = myName(); if (!nm) return null;
  const t = (DATA.therapists || []).find(x => x.name === nm);
  return t ? t.id : null;
}
function scopePatients(list){
  const me = window.ME;
  if (!me || me.scope==="all" || me.scope==="reception") return list;
  const nm = myName();
  if (me.scope==="doctor")    return list.filter(p=>p.dr===nm);
  if (me.scope==="therapist") { const tid = myTherapistId();
    return list.filter(p=>p.th===nm || (tid && p.therapist_id===tid)); }
  return list;
}
function scopeAppts(list){
  const me = window.ME;
  if (!me || me.scope==="all" || me.scope==="reception") return list;
  const nm = myName();
  if (me.scope==="doctor")    return list.filter(a=>a.dr===nm);
  if (me.scope==="therapist") { const tid = myTherapistId();
    return list.filter(a=>a.th===nm || (tid && a.therapist_id===tid)); }
  return list;
}
function scopeTherapists(list){
  const me = window.ME;
  if (me && me.scope==="therapist") return list.filter(t=>t.name===myName());
  return list;
}
// Payments: gate by the caller's visible patient set. Doctor/therapist only
// see invoices for patients on their caseload.
function scopePayments(list){
  const me = window.ME;
  if (!me || me.scope==="all" || me.scope==="reception") return list;
  const patients = scopePatients(DATA.patients || []);
  const allowedNames = new Set(patients.map(p=>p.name));
  const allowedIds   = new Set(patients.map(p=>p.id || p.patient_id));
  return list.filter(v => {
    if (v.patient_id && allowedIds.has(v.patient_id)) return true;
    if (v.pid && allowedIds.has(v.pid)) return true;
    if (v.patient && allowedNames.has(v.patient)) return true;
    return false;
  });
}

// ── Clinic modules (docs/03 "القائمة الجانبية تعرض فقط الوحدات المفعلة") ──
// Route → the module (organization_modules / modules.code) it belongs to.
// A route without an entry (dashboard, campaigns, custom:*) has no module
// and follows the role rules only. Hiding is UX; the API/RLS enforce.
const ROUTE_MODULES = {
  patients:     "core.patients",
  appointments: "core.appointments",
  treatments:   "physio.treatment_plans",
  sessions:     "physio.sessions",
  payments:     "core.billing",
  packages:     "core.billing",
  reports:      "core.reports",
  branches:     "core.branches",
  settings:     "core.settings",
};
// window.ORG_MODULES = enabled codes of the current clinic (from
// /api/orgs/resolve, then /api/orgs/current; src/tenant.jsx). Not set
// (demo mode, the data layer alone) = every module is available.
function routeModuleEnabled(route){
  const mods = window.ORG_MODULES;
  if (!Array.isArray(mods)) return true;
  const code = ROUTE_MODULES[route];
  return !code || mods.includes(code);
}
// One module by code (e.g. "core.staff" for the staff tab of the settings).
function orgModuleOn(code){
  const mods = window.ORG_MODULES;
  return !Array.isArray(mods) || !code || mods.includes(code);
}

// Empty-name safe: filter falsy pieces before taking initial characters so
// double-spaces don't produce "undefined" strings.
const initialsOf = (n)=> (n||"")
  .replace("د. ","")
  .split(" ")
  .filter(Boolean)
  .map(x => x[0] || "")
  .join("")
  .slice(0,2);

Object.assign(window, {
  ROLE_PROFILES, ROLE_ROUTES, ROLE_DASH_LABEL, ROLE_DEFAULT,
  roleScope, roleDefaultRoute, roleAllows, ROUTE_MODULES, routeModuleEnabled, orgModuleOn,
  scopePatients, scopeAppts, scopeTherapists, scopePayments, initialsOf,
});


// ── Shared bits for role homes ─────────────────────────────────
function HomeHeader({ kicker, title, sub, right }){
  return (
    <div style={{display:"flex",alignItems:"flex-end",justifyContent:"space-between",marginBottom:22,gap:16,flexWrap:"wrap"}}>
      <div>
        <div className="crumb"><span>{tt("الرئيسية")}</span><I.Chevron size={11}/><span>{kicker}</span></div>
        <h1 className="h1">{title}</h1>
        <div className="muted" style={{fontSize:13.5,marginTop:4}}>{sub}</div>
      </div>
      {right && <div style={{display:"flex",gap:10,alignItems:"center"}}>{right}</div>}
    </div>
  );
}

function ApptRow({ a, right }){
  return (
    <div style={{display:"flex",alignItems:"center",gap:12,padding:"10px 12px",border:"1px solid var(--ink-200)",borderRadius:12,background:a.status==="قيد التنفيذ"?"var(--blue-50)":"#fff"}}>
      <div style={{textAlign:"center",minWidth:48}}>
        <div className="mono" style={{fontSize:13,fontWeight:600}}>{a.time}</div>
        <div style={{fontSize:10.5,color:"var(--ink-500)"}}><span className="mono">{a.dur}</span> {tt("د")}</div>
      </div>
      <div style={{width:1,height:30,background:"var(--ink-200)"}}/>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontSize:13,fontWeight:500,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{a.patient}</div>
        <div style={{fontSize:11.5,color:"var(--ink-500)"}}>{a.room} · {a.type || "—"}</div>
      </div>
      {right ? right : <ApptBadge s={a.status}/>}
    </div>
  );
}


// ════════════════════════════════════════════════════════════════
// RECEPTIONIST — front desk: today's flow, check-ins, daily cash
// ════════════════════════════════════════════════════════════════
function ReceptionDashboard({ go, user }){
  window.useDataVersion && window.useDataVersion();
  const [quickPayOpen, setQuickPayOpen] = React.useState(false);
  const appts   = DATA.appts;
  const booked  = appts.filter(a=>a.status!=="متاح");
  const free    = appts.filter(a=>a.status==="متاح");
  const waiting = appts.filter(a=>a.status==="مؤكد"||a.status==="معلّق");
  // "Today's cash" — only invoices dated today. Seed rows use ISO date
  // strings; live rows may use `created_at`. Fallback to all-time is fine
  // for demo mode.
  const today = new Date().toISOString().slice(0,10);
  const todaysInvoices = DATA.payments.filter(p => {
    const d = (p.date || p.created_at || "").slice(0,10);
    return !d || d === today;
  });
  const collected   = todaysInvoices.reduce((s,p)=>s+p.paid,0);
  const outstanding = todaysInvoices.reduce((s,p)=>s+(p.amount-p.paid),0);
  const unpaid      = DATA.payments.filter(p=>p.status!=="مدفوع");

  return (
    <Page>
      <HomeHeader
        kicker={tt("لوحة الاستقبال")}
        title={<>{tt("صباح الخير، {name}", { name: user.name.split(" ")[0] })} <span style={{display:"inline-block",transform:"translateY(-2px)"}}>👋🏼</span></>}
        sub={tt("{date} — حركة مكتب الاستقبال اليوم في {branch}.", { date: todayLabelAr(), branch: activeBranchName() })}
        right={<>
          <button className="btn btn-secondary" onClick={()=>go("patients")}><I.Plus size={14}/> {tt("مريض جديد")}</button>
          <button className="btn btn-secondary" onClick={()=>setQuickPayOpen(true)}><I.CreditCard size={14}/> {tt("دفع سريع")}</button>
          <button className="btn btn-blue" onClick={()=>go("appointments")}><I.Plus size={14}/> {tt("حجز موعد")}</button>
        </>}
      />

      <div className="grid-stats" style={{marginBottom:18}}>
        <StatCard label={tt("مواعيد اليوم")}  value={`${booked.length}/${appts.length}`} accent="#3A7FB5" icon={<I.Calendar size={15}/>}/>
        <StatCard label={tt("بانتظار الوصول")} value={String(waiting.length)} accent="#D49044" icon={<I.Clock size={15}/>}/>
        <StatCard label={tt("فترات متاحة")}   value={String(free.length)} accent="#3FA984" icon={<I.Plus size={15}/>}/>
        <StatCard label={tt("تحصيل اليوم")}   value={fmtMoneyShort(collected)} accent="#7BBDE8" icon={<I.Dollar size={15}/>}/>
        <StatCard label={tt("مستحقات معلّقة")} value={fmtMoneyShort(outstanding)} accent="#D8665A" icon={<I.CreditCard size={15}/>}/>
      </div>

      <div className="rgrid c-lg" style={{"--gtc":"1.4fr 1fr"}}>
        {/* Check-in queue */}
        <div className="card card-pad">
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
            <div><div className="h2">{tt("طابور الوصول")}</div><div className="muted" style={{fontSize:12.5,marginTop:2}}>{tt("سجّل وصول المرضى عند حضورهم")}</div></div>
            <button className="btn btn-ghost" style={{fontSize:12}} onClick={()=>go("appointments")}>{tt("كل المواعيد")} <I.ArrowRight size={12}/></button>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {booked.slice(0,7).map(a=>(
              <ApptRow key={a.id} a={a} right={
                a.status==="مكتمل" ? <span className="badge b-green"><I.Check size={11}/>{tt("تم")}</span>
                : a.status==="قيد التنفيذ" ? <ApptBadge s={a.status}/>
                : <button className="btn btn-secondary" style={{fontSize:12,padding:"6px 10px"}}><I.Check size={12}/> {tt("تسجيل وصول")}</button>
              }/>
            ))}
          </div>
        </div>

        {/* Daily cash */}
        <div style={{display:"flex",flexDirection:"column",gap:18}}>
          <div className="card card-pad">
            <div className="h2" style={{marginBottom:4}}>{tt("صندوق اليوم")}</div>
            <div className="muted" style={{fontSize:12.5,marginBottom:14}}>{tt("ملخص التحصيل النقدي والبطاقات")}</div>
            <div style={{display:"flex",alignItems:"baseline",gap:8}}>
              <span className="mono" style={{fontSize:30,fontWeight:600}}>{fmtMoney(collected)}</span>
            </div>
            <div style={{height:8,background:"var(--ink-100)",borderRadius:999,overflow:"hidden",margin:"12px 0"}}>
              <div style={{height:"100%",width:`${collected/(collected+outstanding)*100}%`,background:"var(--green)",borderRadius:999}}/>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:12.5}}>
              <span className="muted">{tt("محصّل {pct}%", { pct: Math.round(collected/(collected+outstanding)*100) })}</span>
              <span style={{color:"#A8443A"}}>{tt("متبقٍ {amount}", { amount: fmtMoney(outstanding) })}</span>
            </div>
          </div>
          <div className="card card-pad">
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
              <div className="h2">{tt("فواتير تحتاج تحصيل")}</div>
              <span className="badge b-amber">{unpaid.length}</span>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              {unpaid.slice(0,4).map(p=>(
                <div key={p.id} style={{display:"flex",alignItems:"center",gap:10}}>
                  <div className="av sm" style={{background:"var(--ink-100)",color:"var(--ink-700)"}}>{initialsOf(p.patient)}</div>
                  <div style={{flex:1,minWidth:0}}><div style={{fontSize:12.5,fontWeight:500}}>{p.patient}</div><div className="mono" style={{fontSize:11,color:"var(--ink-500)"}}>{p.id}</div></div>
                  <div style={{textAlign:"end"}}><div className="mono" style={{fontSize:12.5,fontWeight:600}}>{fmtMoney(p.amount-p.paid)}</div><PayBadge s={p.status}/></div>
                </div>
              ))}
            </div>
            <button className="btn btn-blue" style={{width:"100%",justifyContent:"center",marginTop:14}} onClick={()=>go("payments")}>{tt("فتح المدفوعات")} <I.ArrowRight size={13}/></button>
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


// ════════════════════════════════════════════════════════════════
// DOCTOR — clinical: my caseload, my clinic today, plans to review
// ════════════════════════════════════════════════════════════════
function DoctorDashboard({ go, user }){
  const myPatients = scopePatients(DATA.patients);
  const myAppts    = scopeAppts(DATA.appts).filter(a=>a.status!=="متاح");
  const active     = myPatients.filter(p=>p.status==="نشط");
  // Running low but not exhausted — patients at 0 have finished their package
  // and belong on a different pile ("renew / discharge"), not the review list.
  const reviewPlans = myPatients.filter(p=>p.remain > 0 && p.remain <= 4);
  const caseMix = [
    // Real counts only: with no patients the chart shows its empty state.
    { label:tt("عمود فقري"), v: myPatients.filter(p=>/ظهر|فقر|عنق|عرق|غضروف/.test(p.diag)).length, color:"#7BBDE8" },
    { label:tt("مفاصل"),     v: myPatients.filter(p=>/كتف|ركبة|رضف/.test(p.diag)).length, color:"#7E6BD3" },
    { label:tt("أخرى"),      v: myPatients.length - myPatients.filter(p=>/ظهر|فقر|عنق|عرق|غضروف|كتف|ركبة|رضف/.test(p.diag)).length, color:"#BDD8E9" },
  ];

  return (
    <Page>
      <HomeHeader
        kicker={tt("يومي الإكلينيكي")}
        title={<>{tt("أهلاً، {name}", { name: user.name })} <span style={{display:"inline-block",transform:"translateY(-2px)"}}>🩺</span></>}
        sub={tt("{date} — مواعيد اليوم: {appts} · المرضى النشطون: {active}", { date: todayLabelAr(), appts: myAppts.length, active: active.length })}
        right={<>
          <button className="btn btn-secondary" onClick={()=>go("treatments")}><I.Clipboard size={14}/> {tt("خطط العلاج")}</button>
          <button className="btn btn-blue" onClick={()=>go("patients")}><I.Users size={14}/> {tt("مرضاي")}</button>
        </>}
      />

      <div className="grid-stats" style={{marginBottom:18}}>
        <StatCard label={tt("مرضاي")}          value={String(myPatients.length)} accent="#7E6BD3" icon={<I.Users size={15}/>}/>
        <StatCard label={tt("مواعيد اليوم")}   value={String(myAppts.length)} accent="#3A7FB5" icon={<I.Calendar size={15}/>}/>
        <StatCard label={tt("خطط للمراجعة")}   value={String(reviewPlans.length)} accent="#D49044" icon={<I.Clipboard size={15}/>}/>
        <StatCard label={tt("نشطون")}          value={String(active.length)} accent="#3FA984" icon={<I.Activity size={15}/>}/>
      </div>

      <div className="rgrid c-lg" style={{"--gtc":"1fr 1.3fr"}}>
        {/* My clinic today */}
        <div className="card card-pad">
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
            <div><div className="h2">{tt("عيادتي اليوم")}</div><div className="muted" style={{fontSize:12.5,marginTop:2}}>{tt("المجدولة: {n}", { n: myAppts.length })}</div></div>
            <button className="btn btn-ghost" style={{fontSize:12}} onClick={()=>go("appointments")}>{tt("التقويم")} <I.ArrowRight size={12}/></button>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {myAppts.map(a=> <ApptRow key={a.id} a={a}/>)}
            {myAppts.length===0 && <div className="muted" style={{fontSize:13,padding:"20px 0",textAlign:"center"}}>{tt("لا مواعيد اليوم.")}</div>}
          </div>
        </div>

        {/* My caseload */}
        <div style={{display:"flex",flexDirection:"column",gap:18}}>
          <div className="card card-pad">
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
              <div className="h2">{tt("قائمة مرضاي")}</div>
              <button className="btn btn-ghost" style={{fontSize:12}} onClick={()=>go("patients")}>{tt("عرض الكل")} <I.ArrowRight size={12}/></button>
            </div>
            <div className="tbl-scroll">
            <CardTable style={{margin:"-4px 0"}}>
              <thead><tr><th>{tt("المريض")}</th><th>{tt("التشخيص")}</th><th>{tt("متبقٍ")}</th><th>{tt("الدفع")}</th></tr></thead>
              <tbody>
                {myPatients.length===0 && <tr><td colSpan={4} className="tbl-empty">{tt("لا مرضى تحت رعايتك بعد.")}</td></tr>}
                {myPatients.map(p=>(
                  <tr key={p.id} data-clickable="true" tabIndex={0} onClick={()=>go("patients")} onKeyDown={e=>{ if(e.key==="Enter"||e.key===" "){e.preventDefault();go("patients");} }}>
                    <td><div style={{display:"flex",alignItems:"center",gap:8}}><div className="av sm">{initialsOf(p.name)}</div><span style={{fontWeight:500}}>{p.name}</span></div></td>
                    <td style={{fontSize:12.5}}>{p.diag}</td>
                    <td className="mono" style={{fontWeight:600}}>{p.remain}</td>
                    <td><PayBadge s={p.payment}/></td>
                  </tr>
                ))}
              </tbody>
            </CardTable>
            </div>
          </div>
          <div className="card card-pad">
            <div className="h2" style={{marginBottom:4}}>{tt("توزيع الحالات")}</div>
            <div className="muted" style={{fontSize:12.5,marginBottom:14}}>{tt("مرضاي حسب نوع الإصابة")}</div>
            <DonutChart data={caseMix} size={140} centerLabel={tt("مريض")} centerValue={String(myPatients.length)}/>
          </div>
        </div>
      </div>
    </Page>
  );
}


// ════════════════════════════════════════════════════════════════
// THERAPIST — my day: schedule to run, sessions to log, my caseload
// ════════════════════════════════════════════════════════════════
function TherapistDashboard({ go, user }){
  const myAppts   = scopeAppts(DATA.appts).filter(a=>a.status!=="متاح");
  const done      = myAppts.filter(a=>a.status==="مكتمل");
  const remaining = myAppts.filter(a=>a.status!=="مكتمل");
  const myPatients= scopePatients(DATA.patients);
  const meT = DATA.therapists.find(t=>t.name===user.match) || { load: myAppts.length, max: 8 };

  return (
    <Page>
      <HomeHeader
        kicker={tt("جدول يومي")}
        title={<>{tt("أهلاً، {name}", { name: user.name.split(" ")[0] })} <span style={{display:"inline-block",transform:"translateY(-2px)"}}>💪🏼</span></>}
        sub={tt("{date} — {n} جلسات على جدولك اليوم، {done} مكتملة.", { date: todayLabelAr(), n: myAppts.length, done: done.length })}
        right={<button className="btn btn-blue" onClick={()=>go("sessions")}><I.Activity size={14}/> {tt("سجل جلسة")}</button>}
      />

      <div className="grid-stats" style={{marginBottom:18}}>
        <StatCard label={tt("جلسات اليوم")} value={String(myAppts.length)} accent="#7BBDE8" icon={<I.Calendar size={15}/>}/>
        <StatCard label={tt("مكتملة")}      value={String(done.length)} delta={tt("مكتمل")} deltaKind="up" accent="#3FA984" icon={<I.Check size={15}/>}/>
        <StatCard label={tt("متبقية")}      value={String(remaining.length)} accent="#D49044" icon={<I.Clock size={15}/>}/>
        <StatCard label={tt("مرضاي")}       value={String(myPatients.length)} accent="#7E6BD3" icon={<I.Users size={15}/>}/>
        <StatCard label={tt("حِملي اليوم")}  value={`${meT.load}/${meT.max}`} accent="#3A7FB5" icon={<I.Activity size={15}/>}/>
      </div>

      <div className="rgrid c-lg" style={{"--gtc":"1.3fr 1fr"}}>
        {/* Schedule timeline */}
        <div className="card card-pad">
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
            <div><div className="h2">{tt("جدولي اليوم")}</div><div className="muted" style={{fontSize:12.5,marginTop:2}}>{tt("اضغط لبدء الجلسة وتسجيل الملاحظات")}</div></div>
            <button className="btn btn-ghost" style={{fontSize:12}} onClick={()=>go("appointments")}>{tt("التقويم")} <I.ArrowRight size={12}/></button>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {myAppts.map(a=>(
              <ApptRow key={a.id} a={a} right={
                a.status==="مكتمل" ? <span className="badge b-green"><I.Check size={11}/>{tt("تمت")}</span>
                : <button className="btn btn-blue" style={{fontSize:12,padding:"6px 10px"}} onClick={()=>go("sessions")}>{tt("بدء الجلسة")} <I.ArrowRight size={11}/></button>
              }/>
            ))}
            {myAppts.length===0 && <div className="muted" style={{fontSize:13,padding:"20px 0",textAlign:"center"}}>{tt("لا جلسات اليوم.")}</div>}
          </div>
        </div>

        {/* My assigned patients */}
        <div className="card card-pad">
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
            <div className="h2">{tt("مرضاي المسندون")}</div>
            <button className="btn btn-ghost" style={{fontSize:12}} onClick={()=>go("patients")}>{tt("عرض الكل")} <I.ArrowRight size={12}/></button>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            {myPatients.map(p=>{
              // Pull the package size out of the pkg label ("12 Sessions", "24 جلسة", …).
              // Fall back to Math.max so a stale/missing pkg doesn't produce >100% bars.
              const pkgMatch = (p.pkg || "").match(/(\d+)/);
              const total = pkgMatch ? parseInt(pkgMatch[1], 10) : Math.max(12, (p.remain || 0));
              const done = Math.max(0, total - (p.remain || 0));
              const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
              return (
                <div key={p.id} style={{cursor:"pointer"}} onClick={()=>go("patients")}>
                  <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:6}}>
                    <div className="av md">{initialsOf(p.name)}</div>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:13,fontWeight:500}}>{p.name}</div>
                      <div className="muted" style={{fontSize:11.5,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{p.diag}</div>
                    </div>
                    <span className="mono" style={{fontSize:11.5,color:"var(--ink-700)"}}>{done}/{total}</span>
                  </div>
                  <div style={{height:5,background:"var(--ink-100)",borderRadius:999,overflow:"hidden"}}>
                    <div style={{height:"100%",width:`${pct}%`,background:"var(--blue-500)",borderRadius:999}}/>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </Page>
  );
}


// ── Home dispatcher: picks the right dashboard for the role ────
function RoleHome({ role, go, user }){
  if (role==="موظف استقبال") return <ReceptionDashboard go={go} user={user}/>;
  if (role==="طبيب")         return <DoctorDashboard go={go} user={user}/>;
  if (role==="الأخصائي")      return <TherapistDashboard go={go} user={user}/>;
  return <Dashboard go={go}/>; // مدير → full admin KPI dashboard
}

Object.assign(window, { ReceptionDashboard, DoctorDashboard, TherapistDashboard, RoleHome });
