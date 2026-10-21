

// ===== src/multisession.jsx =====
// Concurrent sessions — a therapist runs several patients AT THE SAME TIME.
// Each active session has its own independent, simultaneously-running timer,
// pain score, notes and sign-off. Switching cards never pauses the others.
//
// Every session is generated from the patient's ACTIVE TREATMENT PLAN
// (خطة العلاج): goals, planned exercises, methods, home instructions,
// diagnosis, and the session counter (completed / total) all come from the
// plan — the therapist only records today's progress. Ending a session
// persists a linked `sessions` row; a DB trigger then bumps the plan's
// completed_sessions so remaining counts update everywhere automatically.
// Uses globals from earlier scripts: React, I, DATA, AreaChart, Modal,
// scopeAppts, scopePatients, ME, KineticData, TreatmentsAPI.

// ── Utilities ─────────────────────────────────────────────────
function fmtClock(sec){
  const h=Math.floor(sec/3600), m=Math.floor((sec%3600)/60), s=sec%60;
  const pad=n=>String(n).padStart(2,"0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
const initials2 = (n)=> (n||"").replace("د. ","").split(" ").map(x=>x[0]).join("").slice(0,2);

// Normalize plan jsonb fields that may arrive as strings or object arrays.
function planGoalsOf(plan){
  const raw = plan && Array.isArray(plan.goals) ? plan.goals : [];
  return raw.map(g => typeof g === "string" ? { g, done:false } : { g: g.g || g.text || g.name || "", done:false })
            .filter(x => x.g);
}
function planExercisesOf(plan){
  const raw = plan && Array.isArray(plan.exercises) ? plan.exercises : [];
  return raw.map(e => ({ name: typeof e === "string" ? e : (e.name || e.title || ""), done:false }))
            .filter(x => x.name);
}
function planMethodsOf(plan){
  const raw = plan && Array.isArray(plan.methods) ? plan.methods : [];
  return raw.map(m => typeof m === "string" ? m : (m.name || "")).filter(Boolean);
}

// Resolve the therapist id to stamp on a session row.
function sessionTherapistId(plan){
  return (plan && plan.therapist_id)
    || (window.ME && ((DATA.therapists || []).find(t => t.name === window.ME.match) || {}).id)
    || (window.ME && window.ME.match) || null;
}

// ── ConcurrentSessions ────────────────────────────────────────
function ConcurrentSessions(){
  const tick = window.useDataVersion ? window.useDataVersion() : 0;

  // ── State — starts EMPTY, then RESTORES from the database: a session
  // row is inserted the moment it starts (status 'in_progress'), so
  // navigating away, refreshing, or re-logging never loses a running
  // session. No fabricated/demo sessions.
  const [sessions, setSessions] = React.useState([]);
  const [selId, setSelId] = React.useState(null);
  const [now, setNow] = React.useState(Date.now());
  const [picker, setPicker] = React.useState(false);
  const [starting, setStarting] = React.useState(null); // patient_id being loaded

  // Rebuild cards for DB rows that are in progress but not on screen —
  // this is what makes running sessions survive navigation/refresh.
  React.useEffect(() => {
    const running = (DATA.sessions || []).filter(r => r.status === "in_progress");
    const have = new Set(sessions.map(x => x.id));
    const missing = running.filter(r => !have.has(r.session_id || r.id));
    if (!missing.length) return;
    let alive = true;
    (async () => {
      const restored = [];
      for (const r of missing) {
        const p = (DATA.patients || []).find(x => (x.patient_id || x.id) === r.patient_id)
          || { patient_id: r.patient_id, id: r.patient_id, name: r.patient || r.patient_id || "—" };
        let plan = null;
        try { if (r.treatment_id && window.TreatmentsAPI) plan = await window.TreatmentsAPI.get(r.treatment_id); } catch {}
        const doneEx = new Set(Array.isArray(r.completed_exercises) ? r.completed_exercises : (Array.isArray(r.done) ? r.done : []));
        const exercises = planExercisesOf(plan).map(e => ({ ...e, done: doneEx.has(e.name) }));
        const goals = (Array.isArray(r.goals) && r.goals.length)
          ? r.goals.map(g => typeof g === "string" ? { g, done:false } : { g: g.g || "", done: !!g.done }).filter(x=>x.g)
          : planGoalsOf(plan);
        restored.push({
          id: r.session_id || r.id, p, plan,
          bookingId: r.booking_id || null,
          room: "",
          type: (plan && (plan.name || plan.category)) || "جلسة علاج طبيعي",
          start: r.started_at ? Date.parse(r.started_at) : (r.created_at ? Date.parse(r.created_at) : Date.now()),
          paused: false, frozen: 0,
          pain: r.pain_score ?? r.pain ?? null, mood: (typeof r.mood === "number" ? r.mood : 2), signed: false,
          num: r.session_number || ((plan ? Number(plan.completed_sessions) || 0 : 0) + 1),
          total: plan ? Number(plan.estimated_sessions) || 0 : 0,
          notes: r.session_notes || r.notes || "",
          goals, exercises,
        });
      }
      if (alive && restored.length) setSessions(ss => {
        const haveNow = new Set(ss.map(x => x.id));
        const add = restored.filter(r => !haveNow.has(r.id));
        return add.length ? [...ss, ...add] : ss;
      });
    })();
    return () => { alive = false; };
  }, [tick]);

  // Autosave the in-progress payload (pain, mood, notes, check-offs) a few
  // seconds after the last change, so a mid-session refresh loses nothing.
  const saveTimer = React.useRef(null);
  React.useEffect(() => {
    if (!sessions.length || !window.KineticData) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      for (const s of sessions) {
        window.KineticData.upsert("sessions", {
          session_id: s.id,
          patient_id: s.p.patient_id || s.p.id,
          pain_score: s.pain, mood: s.mood,
          goals: s.goals || [],
          completed_exercises: (s.exercises || []).filter(e=>e.done).map(e=>e.name),
          session_notes: s.notes || "",
          status: "in_progress",
        }).catch(() => {});
      }
    }, 4000);
    return () => clearTimeout(saveTimer.current);
  }, [sessions]);

  // Today's active appointments (mine) — the natural way to start a session,
  // and the link that keeps the calendar in sync with the session room.
  const todayIso = new Date().toISOString().slice(0,10);
  const CANCELLED = new Set(["ملغي","ملغى","cancelled"]);
  const myAppts = (window.scopeAppts ? window.scopeAppts(DATA.appts || []) : (DATA.appts || []))
    .filter(a => (a.patient_id || a.pid)
      && String(a.date || "").slice(0,10) === todayIso
      && !CANCELLED.has(a.status) && a.status !== "متاح" && a.status !== "مكتمل");

  // One shared heartbeat drives EVERY timer — they all advance together.
  React.useEffect(()=>{
    const id = setInterval(()=>{
      if (document.hidden) return;
      setNow(Date.now());
    }, 1000);
    const onVis = () => { if (!document.hidden) setNow(Date.now()); };
    document.addEventListener("visibilitychange", onVis);
    return ()=>{ clearInterval(id); document.removeEventListener("visibilitychange", onVis); };
  },[]);
  // Keep a valid selection.
  React.useEffect(()=>{ if(sessions.length && !sessions.some(s=>s.id===selId)) setSelId(sessions[0].id); },[sessions,selId]);

  // ── Derived ──
  const elapsedOf = (s)=> s.paused ? (s.frozen||0) : Math.max(0, Math.floor((now - s.start)/1000));
  const sel = sessions.find(s=>s.id===selId) || sessions[0] || null;

  // ── Handlers ──
  const updateById = (id, patch)=> setSessions(ss=>ss.map(s=> s.id===id ? {...s,...patch} : s));
  const update = (patch)=> { if (sel) updateById(sel.id, patch); };
  const togglePause = (id)=> setSessions(ss=>ss.map(s=>{
    if(s.id!==id) return s;
    if(s.paused) return {...s, paused:false, start: Date.now() - (s.frozen||0)*1000, frozen:0};
    const frozenMs = Math.max(0, Date.now() - s.start);
    return {...s, paused:true, frozen: Math.floor(frozenMs/1000)};
  }));

  // Start a session: everything auto-populates from the patient's active
  // treatment plan — the therapist enters nothing twice.
  async function startSession(p, appt){
    const pid = p.patient_id || p.id;
    if (sessions.some(s => (s.p.patient_id || s.p.id) === pid)) { setPicker(false); return; }
    setStarting(pid);
    let plan = null;
    try {
      if (window.TreatmentsAPI) plan = await window.TreatmentsAPI.activeFor(pid);
    } catch (e) { console.warn("activeTreatmentFor failed", e); }
    const completedBefore = plan ? (Number(plan.completed_sessions) || 0)
      : (DATA.sessions || []).filter(s => s.patient_id === pid && s.status !== "in_progress").length;
    const total = plan ? (Number(plan.estimated_sessions) || 0) : 0;
    const id = "S-"+pid+"-"+Date.now();
    const startedAt = new Date().toISOString();
    const goals = planGoalsOf(plan);
    setSessions(ss=>[...ss, {
      id, p, plan,
      bookingId: appt ? (appt.booking_id || appt.id) : null,
      room: (appt && appt.room) || "",
      type: (plan && (plan.name || plan.category)) || (appt && appt.type) || "جلسة علاج طبيعي",
      start: Date.parse(startedAt), paused:false, frozen:0,
      pain: null, mood: 2, signed:false,
      num: completedBefore + 1, total,
      notes: "",
      goals,
      exercises: planExercisesOf(plan),
    }]);
    // Persist IMMEDIATELY: the session exists in the database from the
    // moment it starts, fully linked to patient/plan/appointment/therapist.
    if (window.KineticData) {
      window.KineticData.upsert("sessions", {
        session_id: id,
        patient_id: pid,
        therapist_id: sessionTherapistId(plan),
        treatment_id: plan ? plan.treatment_id : null,
        booking_id: appt ? (appt.booking_id || appt.id) : null,
        date: startedAt.slice(0, 10),
        session_number: completedBefore + 1,
        goals,
        completed_exercises: [],
        session_notes: "",
        status: "in_progress",
        started_at: startedAt,
        created_at: startedAt,
      }).catch(e => console.warn("start session persist failed", e));
      // Mirror onto the calendar: the linked appointment goes "in progress".
      if (appt) {
        window.KineticData.upsert("appts", {
          booking_id: appt.booking_id || appt.id,
          patient_id: pid,
          status: "قيد التنفيذ",
        }).catch(e => console.warn("appt in-progress update failed", e));
      }
    }
    setStarting(null);
    setSelId(id); setPicker(false);
  }

  // End session — persist the linked session row. The DB trigger updates the
  // plan's completed_sessions; we re-broadcast so every open screen refreshes.
  const endSession = (id)=> setSessions(ss=>{
    const done = ss.find(s=>s.id===id);
    if (done && done.p && window.KineticData) {
      const pid = done.p.patient_id || done.p.id;
      const secs = done.paused ? (done.frozen||0) : Math.max(0, Math.floor((Date.now() - done.start)/1000));
      // Complete the SAME row that was inserted at start — the upsert flips
      // status to 'completed' and the DB trigger bumps the plan counter.
      window.KineticData.upsert("sessions", {
        session_id: done.id,
        patient_id: pid,
        therapist_id: sessionTherapistId(done.plan),
        treatment_id: done.plan ? done.plan.treatment_id : null,
        booking_id: done.bookingId || null,
        date: new Date().toISOString().slice(0,10),
        pain_score: done.pain,
        mood: done.mood,
        duration_minutes: Math.max(1, Math.round(secs / 60)),
        goals: done.goals || [],
        completed_exercises: (done.exercises || []).filter(e=>e.done).map(e=>e.name),
        session_notes: done.notes || "",
        session_number: done.num || null,
        status: "completed",
      }).then(() => {
        // The trigger bumped treatments.completed_sessions — tell the
        // treatments screens to re-fetch.
        window.dispatchEvent(new CustomEvent("kinetic:treatments-updated"));
      }).catch(e => console.warn("endSession persist failed", e));
      // Completed session closes its appointment on the calendar.
      if (done.bookingId) {
        window.KineticData.upsert("appts", {
          booking_id: done.bookingId, patient_id: pid, status: "مكتمل",
        }).catch(e => console.warn("appt complete update failed", e));
      }
    }
    return ss.filter(s=>s.id!==id);
  });

  const activeIds = new Set(sessions.map(s=>s.p.patient_id || s.p.id));
  const patientOf = (a) => (DATA.patients || []).find(p =>
    (p.patient_id || p.id) === (a.patient_id || a.pid) || p.name === a.patient);
  // Today's appointments first (each knows its booking), then the rest of
  // the caseload for walk-ins.
  const apptChoices = myAppts
    .map(a => ({ a, p: patientOf(a) }))
    .filter(x => x.p && !activeIds.has(x.p.patient_id || x.p.id));
  const apptPids = new Set(apptChoices.map(x => x.p.patient_id || x.p.id));
  const walkIns = (window.scopePatients ? window.scopePatients(DATA.patients || []) : (DATA.patients || []))
    .filter(p => !activeIds.has(p.patient_id || p.id) && !apptPids.has(p.patient_id || p.id));

  const runningCount = sessions.filter(s=>!s.paused).length;

  return (
    <div>
      {/* Concurrency banner */}
      <div style={{display:"flex",alignItems:"center",gap:12,padding:"12px 16px",marginBottom:16,
        background:"var(--blue-50)",border:"1px solid var(--blue-100)",borderRadius:14,flexWrap:"wrap"}}>
        <span style={{position:"relative",width:10,height:10,flexShrink:0}}>
          <span className="live-pulse" style={{position:"absolute",inset:0,borderRadius:"50%",background:"var(--green)"}}/>
        </span>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:13.5,fontWeight:600}}>{sessions.length} جلسات نشطة في نفس الوقت</div>
          <div className="muted" style={{fontSize:12}}>{runningCount} مؤقّت يعمل الآن بالتوازي · كل جلسة تُحمَّل تلقائيًا من خطة علاج المريض.</div>
        </div>
        <button className="btn btn-blue" onClick={()=>setPicker(true)}><I.Plus size={14}/> بدء جلسة</button>
      </div>

      {/* Active-session rail */}
      {sessions.length > 0 && (
      <div style={{display:"flex",gap:12,overflowX:"auto",paddingBottom:6,marginBottom:18}}>
        {sessions.map(s=>{
          const on = sel && s.id===sel.id;
          const el = elapsedOf(s);
          const painColor = s.pain==null?"#8898A8":s.pain<=3?"#3FA984":s.pain<=6?"#D49044":"#D8665A";
          return (
            <div key={s.id} onClick={()=>setSelId(s.id)}
              style={{
                flex:"0 0 232px", cursor:"pointer", borderRadius:14, padding:14,
                border:`1.5px solid ${on?"var(--blue-500)":"var(--ink-200)"}`,
                background: on?"var(--blue-50)":"#fff",
                boxShadow: on?"0 6px 18px rgba(123,189,232,.22)":"var(--shadow-sm)",
                transition:"all .15s", position:"relative"
              }}>
              <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
                <div className="av md" style={{background:on?"var(--blue-500)":"var(--blue-100)",color:on?"#fff":"var(--blue-900)"}}>{initials2(s.p?.name)}</div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:13,fontWeight:600,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{s.p?.name}</div>
                  <div className="muted" style={{fontSize:11,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
                    جلسة {s.num}{s.total ? ` من ${s.total}` : ""}{s.room ? ` · ${s.room}` : ""}
                  </div>
                </div>
                <button className="btn btn-ghost btn-icon" title="إنهاء" style={{padding:4,color:"var(--ink-400)"}}
                  onClick={(e)=>{e.stopPropagation(); endSession(s.id);}}><I.X size={13}/></button>
              </div>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                <div style={{display:"flex",alignItems:"center",gap:7}}>
                  {!s.paused
                    ? <span style={{position:"relative",width:8,height:8}}><span className="live-pulse" style={{position:"absolute",inset:0,borderRadius:"50%",background:"var(--green)"}}/></span>
                    : <span style={{width:8,height:8,borderRadius:"50%",background:"var(--ink-300)"}}/>}
                  <span className="mono" style={{fontSize:20,fontWeight:600,letterSpacing:"-.01em",color:s.paused?"var(--ink-400)":"var(--blue-700)"}}>{fmtClock(el)}</span>
                </div>
                <span className="badge" style={{background:painColor+"22",color:painColor}}>{s.pain==null?"ألم —":`ألم ${s.pain}`}</span>
              </div>
            </div>
          );
        })}

        {/* Add card */}
        <button onClick={()=>setPicker(true)}
          style={{flex:"0 0 150px",cursor:"pointer",borderRadius:14,border:"1.5px dashed var(--ink-300)",
            background:"var(--ink-50)",color:"var(--ink-500)",display:"flex",flexDirection:"column",
            alignItems:"center",justifyContent:"center",gap:8,fontFamily:"inherit",fontSize:12.5,fontWeight:500}}>
          <div style={{width:34,height:34,borderRadius:10,background:"#fff",border:"1px solid var(--ink-200)",display:"flex",alignItems:"center",justifyContent:"center"}}><I.Plus size={16}/></div>
          بدء جلسة جديدة
        </button>
      </div>
      )}

      {/* Selected session detail */}
      {sel
        ? <SessionDetail s={sel} elapsed={elapsedOf(sel)} update={update} onEnd={()=>endSession(sel.id)} onTogglePause={()=>togglePause(sel.id)}/>
        : <div className="card card-pad" style={{textAlign:"center",padding:"60px 20px"}}>
            <div className="h3" style={{marginBottom:6}}>لا جلسات نشطة</div>
            <div className="muted" style={{fontSize:13,marginBottom:16}}>ابدأ جلسة من مواعيد اليوم — تُحمَّل بيانات الخطة العلاجية تلقائيًا.</div>
            <button className="btn btn-blue" style={{margin:"0 auto"}} onClick={()=>setPicker(true)}><I.Plus size={14}/> بدء جلسة</button>
          </div>}

      {/* Patient picker: today's appointments first, then the caseload */}
      <Modal open={picker} onClose={()=>setPicker(false)} title="بدء جلسة">
        <div className="muted" style={{fontSize:12.5,marginBottom:14}}>
          اختر المريض — تُحمَّل خطته العلاجية النشطة تلقائيًا (الأهداف، التمارين، طرق العلاج، رقم الجلسة).
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:8,maxHeight:380,overflowY:"auto"}}>
          {apptChoices.length > 0 && <div className="label" style={{marginBottom:0}}>مواعيد اليوم</div>}
          {apptChoices.map(({a, p})=>(
            <div key={a.id} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 12px",border:"1px solid var(--ink-200)",borderRadius:12}}>
              <div className="av md">{initials2(p.name)}</div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:13,fontWeight:500}}>{p.name}</div>
                <div className="muted" style={{fontSize:11.5,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
                  <span className="mono">{a.time || ""}</span>{a.type ? ` · ${a.type}` : ""}{p.diag && p.diag !== "—" ? ` · ${p.diag}` : ""}
                </div>
              </div>
              <button className="btn btn-blue" style={{fontSize:12,padding:"7px 12px"}} disabled={starting===(p.patient_id||p.id)} onClick={()=>startSession(p, a)}>
                {starting===(p.patient_id||p.id) ? "تحميل…" : <><I.Plus size={12}/> بدء</>}
              </button>
            </div>
          ))}
          {walkIns.length > 0 && <div className="label" style={{marginBottom:0,marginTop:apptChoices.length?8:0}}>كل المرضى</div>}
          {walkIns.map(p=>(
            <div key={p.patient_id || p.id} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 12px",border:"1px solid var(--ink-200)",borderRadius:12}}>
              <div className="av md">{initials2(p.name)}</div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:13,fontWeight:500}}>{p.name}</div>
                <div className="muted" style={{fontSize:11.5,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{p.diag && p.diag !== "—" ? p.diag : "بدون موعد اليوم"}</div>
              </div>
              <button className="btn btn-secondary" style={{fontSize:12,padding:"7px 12px"}} disabled={starting===(p.patient_id||p.id)} onClick={()=>startSession(p, null)}>
                {starting===(p.patient_id||p.id) ? "تحميل…" : <><I.Plus size={12}/> بدء</>}
              </button>
            </div>
          ))}
          {apptChoices.length===0 && walkIns.length===0 && (
            <div className="muted" style={{fontSize:13}}>كل مرضاك في جلسات نشطة بالفعل.</div>
          )}
        </div>
      </Modal>
    </div>
  );
}

// ── SessionDetail ──────────────────────────────────────────────
// Controlled session detail — bound to one concurrent session's state.
// Everything except today's inputs (pain, mood, notes, exercise ticks,
// goal ticks) is read from the treatment plan loaded at start.
function SessionDetail({ s, elapsed, update, onEnd, onTogglePause }){
  const p = s.p || {};
  const plan = s.plan || null;
  const moods = [
    {l:"أسوأ بكثير",c:"#D8665A"},
    {l:"أسوأ",c:"#D49044"},
    {l:"كما هو",c:"#8898A8"},
    {l:"أفضل",c:"#7BBDE8"},
    {l:"أفضل بكثير",c:"#3FA984"},
  ];
  const goals = Array.isArray(s.goals) ? s.goals : [];
  const exercises = Array.isArray(s.exercises) ? s.exercises : [];
  const methods = planMethodsOf(plan);
  const pid = p.patient_id || p.id;
  // Trend from THIS patient's completed sessions only.
  const patientSessions = (DATA.sessions || []).filter(x =>
    (x.status || "completed") !== "in_progress"
    && (x.patient_id === pid || (!x.patient_id && x.patient === p.name)));
  const trend = patientSessions.slice().reverse().map((x,i)=>({label:`S${i+1}`, v:11-(x.pain ?? x.pain_score ?? 0)}));
  const firstPain = patientSessions.length
    ? (patientSessions[patientSessions.length-1].pain ?? patientSessions[patientSessions.length-1].pain_score)
    : null;
  const remaining = s.total ? Math.max(0, s.total - s.num) : null;

  // ── Handlers ──
  const dictationStopRef = React.useRef(null);
  React.useEffect(()=>()=>{ try { dictationStopRef.current && dictationStopRef.current(); } catch {} }, []);
  function handleDictation() {
    if (!window.startDictation) return;
    try { dictationStopRef.current && dictationStopRef.current(); } catch {}
    dictationStopRef.current = window.startDictation({
      onText: (t) => update({ notes: (s.notes || "") + "\n" + t }),
    });
  }
  function toggleGoal(i){
    update({ goals: goals.map((g,idx)=> idx===i ? {...g, done:!g.done} : g) });
  }
  function toggleExercise(i){
    update({ exercises: exercises.map((e,idx)=> idx===i ? {...e, done:!e.done} : e) });
  }

  return (
    <div className="rgrid c-lg" style={{"--gtc":"1.4fr 1fr"}}>
      <div style={{display:"flex",flexDirection:"column",gap:18}}>
        {/* header */}
        <div className="card card-pad" style={{display:"flex",alignItems:"center",gap:18,position:"relative",overflow:"hidden",flexWrap:"wrap"}}>
          <div style={{position:"absolute",top:0,left:0,right:0,height:3,background:"linear-gradient(90deg, var(--blue-500), var(--blue-300))"}}/>
          <div className="av lg" style={{background:"var(--blue-500)",color:"#fff",width:54,height:54,fontSize:18}}>{initials2(p.name)}</div>
          <div style={{flex:1,minWidth:0}}>
            <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
              <div className="h2">{p.name}</div>
              <span className="badge b-violet"><span className="dot"></span>الجلسة #{s.num}{s.total ? ` من ${s.total}` : ""} {s.paused?"متوقفة مؤقتًا":"قيد التنفيذ"}</span>
            </div>
            <div style={{display:"flex",gap:14,marginTop:6,fontSize:12.5,color:"var(--ink-500)",flexWrap:"wrap"}}>
              <span>{(plan && plan.diagnosis) || p.diag || "—"}</span>
              {plan && plan.body_part && <><span>·</span><span>{plan.body_part}</span></>}
              {s.room && <><span>·</span><span>{s.room}</span></>}
              <span>·</span><span>{s.type}</span>
            </div>
          </div>
          <div style={{textAlign:"right"}}>
            <div className="mono" style={{fontSize:26,fontWeight:600,color:s.paused?"var(--ink-400)":"var(--blue-700)",letterSpacing:"-.01em"}}>{fmtClock(elapsed)}</div>
            <button className="btn btn-ghost" style={{fontSize:11,marginTop:4,padding:"3px 8px"}} onClick={onTogglePause}>
              {s.paused ? "استئناف" : "إيقاف مؤقت"}
            </button>
          </div>
        </div>

        {/* Treatment plan summary — read-only, straight from the plan */}
        {plan ? (
          <div className="card card-pad">
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12,gap:8,flexWrap:"wrap"}}>
              <div className="h3">خطة العلاج: {plan.name || plan.template_name || plan.treatment_id}</div>
              <span className="badge b-blue"><span className="dot"></span>{remaining != null ? `متبقٍ ${remaining} جلسة` : "بدون عدد محدد"}</span>
            </div>
            <div className="rgrid c-sm" style={{"--gtc":"1fr 1fr",gap:"6px 18px",fontSize:12.5}}>
              <div><span className="muted">الأخصائي: </span>{plan.therapist_name || plan.therapist_id || "—"}</div>
              <div><span className="muted">التكرار: </span>{plan.weekly_frequency ? `${plan.weekly_frequency}/أسبوع` : "—"}</div>
              {methods.length > 0 && (
                <div style={{gridColumn:"1 / -1",display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
                  <span className="muted">طرق العلاج:</span>
                  {methods.map(m=><span key={m} className="pill tag-blue">{m}</span>)}
                </div>
              )}
              {plan.home_instructions && (
                <div style={{gridColumn:"1 / -1"}}><span className="muted">البرنامج المنزلي: </span>{plan.home_instructions}</div>
              )}
              {plan.warnings && (
                <div style={{gridColumn:"1 / -1",color:"var(--red)"}}><span className="muted">تحذيرات: </span>{plan.warnings}</div>
              )}
            </div>
          </div>
        ) : (
          <div className="card card-pad" style={{background:"var(--ink-50)"}}>
            <div style={{fontSize:12.5,color:"var(--ink-500)",lineHeight:1.6}}>
              لا توجد خطة علاج نشطة لهذا المريض — أنشئ خطة من شاشة «خطط العلاج» لتُحمَّل الأهداف والتمارين تلقائيًا في الجلسات القادمة.
            </div>
          </div>
        )}

        {/* pain & mood */}
        <div className="card card-pad">
          <div className="h3" style={{marginBottom:14}}>تسجيل الألم والمزاج</div>
          <div className="label">مستوى الألم (٠ – ١٠)</div>
          <div style={{display:"flex",gap:5,marginBottom:6,flexWrap:"wrap"}}>
            {Array.from({length:11},(_,i)=>i).map(n=>{
              const color = n<=3?"#3FA984":n<=6?"#D49044":"#D8665A";
              const selN = s.pain===n;
              return (
                <button key={n} onClick={()=>update({pain:n})}
                  className="mono"
                  style={{flex:"1 0 36px",height:44,borderRadius:8,border:`1px solid ${selN?color:"var(--ink-200)"}`,
                    background:selN?color:"#fff",color:selN?"#fff":"var(--ink-700)",
                    fontWeight:600,fontSize:14,cursor:"pointer",transition:"all .12s"}}>{n}</button>
              );
            })}
          </div>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"var(--ink-500)",marginBottom:18}}>
            <span>لا ألم</span><span>متوسط</span><span>لا يُحتمل</span>
          </div>

          <div className="label">المزاج اليوم</div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            {moods.map((m,i)=>{
              const on = s.mood===i;
              return (
                <button key={i} className="btn btn-secondary" onClick={()=>update({mood:i})}
                  style={{flex:"1 0 30%",justifyContent:"center",fontSize:12,borderColor:on?m.c:"var(--ink-200)",
                    background:on?`${m.c}22`:"#fff",color:on?m.c:"var(--ink-700)",fontWeight:on?600:500}}>{m.l}</button>
              );
            })}
          </div>
        </div>

        {/* notes */}
        <div className="card card-pad">
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
            <div className="h3">ملاحظات الجلسة</div>
            <button className="btn btn-ghost" style={{fontSize:12}} onClick={handleDictation}><I.Mic size={13}/> إملاء</button>
          </div>
          <textarea className="input" style={{height:180,padding:14,resize:"vertical",fontSize:13.5,lineHeight:1.55}}
            value={s.notes} onChange={e=>update({notes:e.target.value})} placeholder="اكتب ملاحظات الجلسة لهذا المريض…"/>
          <div className="muted" style={{fontSize:11.5,marginTop:10}}>تُحفظ الملاحظات مع الجلسة عند الإنهاء وتظهر في سجل الجلسات وخطة العلاج.</div>
        </div>
      </div>

      {/* aside */}
      <div style={{display:"flex",flexDirection:"column",gap:18}}>
        <div className="card card-pad">
          <div className="h3" style={{marginBottom:14}}>متابعة التقدّم</div>
          <div style={{position:"relative",height:140}}>
            {trend.length > 0
              ? <AreaChart data={trend} height={140} color="#3FA984" fill="rgba(63,169,132,.18)"/>
              : <div className="muted" style={{fontSize:12.5,paddingTop:50,textAlign:"center"}}>أول جلسة مسجلة — سيظهر الاتجاه بدءًا من الجلسة القادمة.</div>}
          </div>
          <div style={{display:"flex",justifyContent:"space-between",marginTop:10}}>
            <div><div className="muted" style={{fontSize:11}}>ألم أول جلسة</div><div className="mono" style={{fontWeight:600}}>{firstPain != null ? `${firstPain}/10` : "—"}</div></div>
            <div><div className="muted" style={{fontSize:11}}>الآن</div><div className="mono" style={{fontWeight:600,color:"var(--green)"}}>{s.pain != null ? `${s.pain}/10` : "—"}</div></div>
            <div><div className="muted" style={{fontSize:11}}>الجلسة</div><div className="mono" style={{fontWeight:600}}>{s.num}{s.total ? `/${s.total}` : ""}</div></div>
          </div>
        </div>

        {exercises.length > 0 && (
          <div className="card card-pad">
            <div className="h3" style={{marginBottom:12}}>تمارين الخطة اليوم</div>
            {exercises.map((e,i)=>(
              <label key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"9px 10px",borderRadius:8,background:i%2===0?"var(--ink-50)":"transparent",fontSize:13,marginBottom:4,cursor:"pointer"}}>
                <input type="checkbox" checked={!!e.done} onChange={()=>toggleExercise(i)}/>
                <span style={{flex:1,textDecoration:e.done?"line-through":"none",color:e.done?"var(--ink-500)":"var(--ink-900)"}}>{e.name}</span>
              </label>
            ))}
          </div>
        )}

        <div className="card card-pad">
          <div className="h3" style={{marginBottom:12}}>أهداف الخطة</div>
          {goals.length === 0 && <div className="muted" style={{fontSize:12.5}}>لا أهداف محددة — تُضاف الأهداف من خطة العلاج.</div>}
          {goals.map((g,i)=>(
            <label key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"9px 10px",borderRadius:8,background:i%2===0?"var(--ink-50)":"transparent",fontSize:13,marginBottom:4,cursor:"pointer"}}>
              <input type="checkbox" checked={!!g.done} onChange={()=>toggleGoal(i)}/>
              <span style={{flex:1,textDecoration:g.done?"line-through":"none",color:g.done?"var(--ink-500)":"var(--ink-900)"}}>{g.g}</span>
            </label>
          ))}
        </div>

        <div className="card card-pad">
          <button className="btn btn-blue" style={{width:"100%",justifyContent:"center"}} onClick={onEnd}>
            <I.Check size={14}/> إنهاء الجلسة وتسجيلها
          </button>
          <div className="muted" style={{fontSize:11.5,marginTop:8,textAlign:"center"}}>
            الإنهاء يسجّل الجلسة على الخطة ويُحدّث عدد الجلسات المكتملة والمتبقية تلقائيًا.
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { ConcurrentSessions, SessionDetail });
