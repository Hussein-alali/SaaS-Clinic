

// ===== src/shell.jsx =====
// App shell — sidebar, topbar, container

// Whitelist of icon names allowed in user-defined custom sections. Prevents
// a custom `icon` string from reaching into non-icon properties on the icons
// object (e.g. "constructor").
const CUSTOM_ICON_WHITELIST = new Set([
  "Layers","Users","Calendar","Clipboard","Activity","Package","CreditCard",
  "FileText","Chart","Send","Settings","Phone","Mail","MapPin","Heart",
  "Stethoscope","Megaphone","Sparkle","Pin","Sun","Moon","Dashboard",
]);

// Sidebar branch picker (docs/03 «تبديل الفرع», docs/04 «Branch picker»).
// Lists the branches this member may use (window.BRANCHES is already
// limited to them); inactive branches are not offered — the one in use
// stays visible, marked «معطّل», only when the member has no active one.
// The clinic admin also gets edit, «إضافة فرع جديد» and «إدارة الفروع»
// (C07). Branches are never deleted here.
function BranchSwitcher({ role }) {
  const [branches, setBranches] = React.useState(window.BRANCHES || []);
  const [activeId, setActiveId] = React.useState(window.ACTIVE_BRANCH_ID || null);
  const [open, setOpen] = React.useState(false);
  const [adding, setAdding] = React.useState(false);
  const [editing, setEditing] = React.useState(null);
  const ref = React.useRef(null);

  React.useEffect(()=>{
    const onUpd = ()=>{
      setBranches(window.BRANCHES || []);
      setActiveId(window.ACTIVE_BRANCH_ID || null);
    };
    window.addEventListener("kinetic:branches-updated", onUpd);
    return ()=> window.removeEventListener("kinetic:branches-updated", onUpd);
  },[]);

  React.useEffect(()=>{
    if (!open) return;
    const onDoc = (e)=>{ if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e)=>{ if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return ()=>{
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  },[open]);

  const isActiveBranch = (b) => window.branchIsActive ? window.branchIsActive(b) : String((b && b.status) || "active") !== "inactive";
  const active = branches.find(b => b.id === activeId) || branches[0] || { name:"—", rooms:0 };
  const activeOff = !!active.id && !isActiveBranch(active);
  const options = branches.filter(b => isActiveBranch(b) || b.id === activeId);
  const isAdmin = role === "مدير";
  const subLine = (b) => [b.address, `الغرف: ${b.rooms||0}`].filter(Boolean).join(" · ");

  return (
    <div ref={ref} style={{position:"relative",margin:"4px 14px 10px"}}>
      <button
        type="button"
        className="branch-switcher"
        aria-haspopup="listbox"
        aria-expanded={open ? "true" : "false"}
        aria-label={`الفرع الحالي: ${active.name} — تبديل الفرع`}
        onClick={()=>setOpen(o=>!o)}
        style={{
          width:"100%", padding:"9px 11px", background:"var(--ink-50)",
          border:"1px solid var(--ink-200)", borderRadius:11, display:"flex",
          alignItems:"center", gap:10, cursor:"pointer", textAlign:"right"
        }}>
        <div style={{width:26,height:26,borderRadius:7,background:"var(--blue-100)",display:"flex",alignItems:"center",justifyContent:"center"}}>
          <I.MapPin size={13} style={{color:"var(--blue-700)"}}/>
        </div>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:12.5,fontWeight:600,color:"var(--ink-900)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{active.name}</div>
          <div style={{fontSize:10.5,color:activeOff?"#A8443A":"var(--ink-500)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
            {activeOff ? "فرع معطّل — للعرض فقط" : `الغرف: ${active.rooms||0}`}
          </div>
        </div>
        <I.ChevronDown size={13} style={{color:"var(--ink-400)",transform:open?"rotate(180deg)":"none",transition:"transform .15s"}}/>
      </button>

      {open && (
        <div style={{
          position:"absolute", top:"calc(100% + 6px)", insetInlineStart:0, insetInlineEnd:0,
          background:"#fff", border:"1px solid var(--ink-200)", borderRadius:11,
          boxShadow:"var(--shadow-md)", zIndex:30, padding:6, maxHeight:320, overflowY:"auto"
        }}>
          <div role="listbox" aria-label="الفروع">
          {options.map(b => {
            const off = !isActiveBranch(b);
            return (
            <div key={b.id} role="option" aria-selected={b.id === activeId ? "true" : "false"} aria-disabled={off ? "true" : undefined}
              data-branch={b.id} tabIndex={0}
              onKeyDown={(e)=>{ if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.currentTarget.click(); } }}
              onClick={()=>{
                if (off) return;
                if (window.setActiveBranch) window.setActiveBranch(b.id);
                setOpen(false);
                if (window.showToast && b.id !== activeId) window.showToast(`تم التبديل إلى ${b.name}`, "success");
              }}
              style={{
                display:"flex",alignItems:"center",gap:8,padding:"8px 10px",
                borderRadius:8, cursor:off?"default":"pointer",
                background: b.id === activeId ? "var(--blue-50)" : "transparent"
              }}
              onMouseEnter={(e)=>{ if (b.id !== activeId) e.currentTarget.style.background = "var(--ink-50)"; }}
              onMouseLeave={(e)=>{ if (b.id !== activeId) e.currentTarget.style.background = "transparent"; }}
            >
              <I.MapPin size={12} style={{color:off?"var(--ink-400)":"var(--blue-700)"}}/>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:12.5,fontWeight:600,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{b.name}</div>
                <div style={{fontSize:10.5,color:"var(--ink-500)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{off ? "معطّل" : subLine(b)}</div>
              </div>
              {b.id === activeId && <I.Check size={12} style={{color:"var(--blue-700)"}}/>}
              {isAdmin && (
                <button
                  type="button"
                  title="تعديل الفرع"
                  aria-label={`تعديل ${b.name}`}
                  onClick={(e)=>{ e.stopPropagation(); setOpen(false); setEditing(b); }}
                  style={{border:"none",background:"transparent",padding:4,borderRadius:6,cursor:"pointer",color:"var(--ink-500)"}}
                  onMouseEnter={(e)=>e.currentTarget.style.background="var(--ink-100)"}
                  onMouseLeave={(e)=>e.currentTarget.style.background="transparent"}
                >
                  <I.Edit size={12}/>
                </button>
              )}
            </div>
          );})}
          </div>
          {isAdmin && (
            <>
              <div style={{height:1,background:"var(--ink-100)",margin:"6px 4px"}}/>
              <button
                type="button"
                onClick={()=>{ setOpen(false); setAdding(true); }}
                style={{
                  width:"100%", display:"flex", alignItems:"center", gap:8, padding:"8px 10px",
                  border:"none", background:"transparent", borderRadius:8, cursor:"pointer",
                  color:"var(--blue-700)", fontSize:12.5, fontWeight:600
                }}
                onMouseEnter={(e)=>e.currentTarget.style.background="var(--blue-50)"}
                onMouseLeave={(e)=>e.currentTarget.style.background="transparent"}
              >
                <I.Plus size={13}/> إضافة فرع جديد
              </button>
              {window.navigate && (
                <button
                  type="button"
                  onClick={()=>{ setOpen(false); window.navigate("branches"); }}
                  style={{
                    width:"100%", display:"flex", alignItems:"center", gap:8, padding:"8px 10px",
                    border:"none", background:"transparent", borderRadius:8, cursor:"pointer",
                    color:"var(--ink-700)", fontSize:12.5, fontWeight:500
                  }}
                  onMouseEnter={(e)=>e.currentTarget.style.background="var(--ink-50)"}
                  onMouseLeave={(e)=>e.currentTarget.style.background="transparent"}
                >
                  <I.Settings size={13}/> إدارة الفروع
                </button>
              )}
            </>
          )}
        </div>
      )}

      {adding && <BranchFormModal selectAfterAdd onClose={()=>setAdding(false)}/>}
      {editing && <BranchFormModal editing={editing} onClose={()=>setEditing(null)}/>}
    </div>
  );
}

// ── Branch form (docs/03 C07 «إضافة فرع» / تعديل) ─────────────────
// Name (required, unique in the clinic), address, phone, rooms and the
// weekly working hours ({ "sat": ["09:00","21:00"], … } — an unticked day
// is closed). Field errors show under the field; a refusal of the server
// (taken name, the plan's branch limit, no permission) shows as an alert
// at the top of the form, in Arabic. Used by C07 and the sidebar picker.
function branchHoursState(wh, withDefaults) {
  const cfg = window.calendarConfig ? window.calendarConfig() : { start:"09:00", end:"17:00" };
  const out = {};
  for (const d of (window.BRANCH_DAYS || [])) {
    const v = wh && Array.isArray(wh[d.key]) ? wh[d.key] : null;
    out[d.key] = v
      ? { open:true, from:v[0], to:v[1] }
      : { open: !!withDefaults && d.key !== "fri", from: cfg.start, to: cfg.end };
  }
  return out;
}

function BranchFormModal({ onClose, editing, onSaved, selectAfterAdd }) {
  const isEdit = !!editing;
  const days = window.BRANCH_DAYS || [];
  const [form, setForm] = React.useState(() => ({
    name: (editing && editing.name) || "",
    address: (editing && editing.address) || "",
    phone: (editing && editing.phone) || "",
    rooms: editing && editing.rooms != null ? String(editing.rooms) : "",
    // A new branch starts from the clinic's calendar hours, Saturday–Thursday.
    hours: branchHoursState(editing ? editing.working_hours : null, !isEdit),
  }));
  const [errors, setErrors] = React.useState({});
  const [serverError, setServerError] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const set = (k, v) => { setForm(f => ({ ...f, [k]: v })); setErrors(e => ({ ...e, [k]: undefined })); setServerError(""); };
  const setDay = (key, patch) => {
    setForm(f => ({ ...f, hours: { ...f.hours, [key]: { ...f.hours[key], ...patch } } }));
    setErrors(e => ({ ...e, hours: undefined }));
    setServerError("");
  };

  function validate() {
    const e = {};
    const name = form.name.trim();
    const taken = name && (window.BRANCHES || []).some(b =>
      b.id !== (editing && editing.id) && String(b.name || "").trim().toLowerCase() === name.toLowerCase());
    if (!name) e.name = "اسم الفرع مطلوب";
    else if (name.length > 80) e.name = "اسم الفرع طويل جدًا (80 حرفًا كحد أقصى)";
    else if (taken) e.name = "يوجد فرع بهذا الاسم في عيادتك بالفعل — اختر اسمًا آخر";
    const rooms = String(form.rooms).trim();
    if (rooms && (!/^\d{1,3}$/.test(rooms))) e.rooms = "أدخل عددًا صحيحًا من 0 إلى 999";
    const phone = form.phone.trim();
    if (phone && !/^[0-9+()\-\s]{6,20}$/.test(phone)) e.phone = "رقم هاتف غير صالح (أرقام فقط، 6 إلى 20 خانة)";
    for (const d of days) {
      const h = form.hours[d.key];
      if (h && h.open && !(h.from && h.to && h.from < h.to)) {
        e.hours = `${d.ar}: وقت الإغلاق يجب أن يكون بعد وقت الفتح`;
        break;
      }
    }
    return e;
  }

  async function onSave() {
    const e = validate();
    setErrors(e);
    if (Object.keys(e).some(k => e[k])) return;
    const working_hours = {};
    for (const d of days) {
      const h = form.hours[d.key];
      if (h && h.open) working_hours[d.key] = [h.from, h.to];
    }
    const payload = {
      name: form.name.trim(),
      address: form.address.trim(),
      phone: form.phone.trim(),
      rooms: String(form.rooms).trim() === "" ? 0 : parseInt(form.rooms, 10),
      working_hours,
    };
    setSaving(true);
    setServerError("");
    try {
      let saved;
      if (isEdit) {
        saved = await window.updateBranch(editing.id, payload);
        if (window.showToast) window.showToast(`تم حفظ ${payload.name}`, "success");
      } else {
        saved = await window.addBranch(payload);
        if (selectAfterAdd && saved && window.setActiveBranch) window.setActiveBranch(saved.id);
        if (window.showToast) window.showToast(`تمت إضافة ${payload.name}`, "success");
      }
      if (onSaved) onSaved(saved);
      onClose();
    } catch (err) {
      console.warn("branch save failed", err);
      // addBranch() / updateBranch() throw an Arabic reason (e.g. the plan's branch limit).
      const msg = err && /[؀-ۿ]/.test(String(err.message || "")) ? err.message : "تعذّر حفظ الفرع — أعد المحاولة";
      setServerError(msg);
    } finally { setSaving(false); }
  }

  const errStyle = { fontSize:11.5, color:"#A8443A", marginTop:4 };
  const invalid = (k) => errors[k] ? { borderColor:"var(--red)" } : undefined;
  return (
    <Modal title={isEdit ? `تعديل ${editing.name}` : "إضافة فرع جديد"} onClose={saving ? undefined : onClose} width={600} footer={<>
      <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>إلغاء</button>
      <button type="button" className="btn btn-blue" disabled={saving} onClick={onSave} aria-busy={saving ? "true" : undefined}>
        {saving
          ? <span className="spin" aria-hidden="true" style={{width:13,height:13,border:"2px solid #fff",borderTopColor:"transparent",borderRadius:"50%"}}/>
          : (isEdit ? <I.Check size={13}/> : <I.Plus size={13}/>)}
        {isEdit ? "حفظ التغييرات" : "إضافة الفرع"}
      </button>
    </>}>
      <form className="branch-form" onSubmit={(e)=>{ e.preventDefault(); onSave(); }} noValidate>
        {serverError && (
          <div role="alert" className="branch-form-error" style={{display:"flex",gap:8,alignItems:"flex-start",padding:"10px 12px",marginBottom:14,borderRadius:10,background:"var(--red-bg)",color:"#A8443A",fontSize:13,lineHeight:1.6}}>
            <I.X size={14} style={{marginTop:3,flexShrink:0}}/><span>{serverError}</span>
          </div>
        )}
        <label className="label" htmlFor="branch-name">اسم الفرع <span style={{color:"#A8443A"}}>*</span></label>
        <input id="branch-name" className="input" placeholder="فرع المعادي" value={form.name} maxLength={120} autoFocus
          aria-invalid={errors.name ? "true" : undefined} aria-describedby={errors.name ? "branch-name-err" : undefined}
          style={invalid("name")} onChange={e=>set("name", e.target.value)}/>
        {errors.name && <div id="branch-name-err" style={errStyle}>{errors.name}</div>}
        <div style={{height:12}}/>
        <div className="rgrid c-sm" style={{"--gtc":"2fr 1fr",gap:12}}>
          <div>
            <label className="label" htmlFor="branch-address">العنوان</label>
            <input id="branch-address" className="input" placeholder="14 ش صلاح سالم، القاهرة" value={form.address} maxLength={200} onChange={e=>set("address", e.target.value)}/>
          </div>
          <div>
            <label className="label" htmlFor="branch-rooms">عدد الغرف</label>
            <input id="branch-rooms" className="input" type="number" min="0" max="999" inputMode="numeric" placeholder="4" value={form.rooms}
              aria-invalid={errors.rooms ? "true" : undefined} aria-describedby={errors.rooms ? "branch-rooms-err" : undefined}
              style={invalid("rooms")} onChange={e=>set("rooms", e.target.value)}/>
            {errors.rooms && <div id="branch-rooms-err" style={errStyle}>{errors.rooms}</div>}
          </div>
        </div>
        <div style={{height:12}}/>
        <label className="label" htmlFor="branch-phone">الهاتف</label>
        <input id="branch-phone" className="input" dir="ltr" placeholder="+20 2 xxxx xxxx" value={form.phone} maxLength={40}
          aria-invalid={errors.phone ? "true" : undefined} aria-describedby={errors.phone ? "branch-phone-err" : undefined}
          style={{textAlign:"right", ...(invalid("phone") || {})}} onChange={e=>set("phone", e.target.value)}/>
        {errors.phone && <div id="branch-phone-err" style={errStyle}>{errors.phone}</div>}
        <div style={{height:16}}/>
        <fieldset style={{border:"none",margin:0,padding:0}} aria-describedby={errors.hours ? "branch-hours-err" : undefined}>
          <legend className="label" style={{padding:0}}>ساعات العمل</legend>
          <div className="muted" style={{fontSize:11.5,marginBottom:8}}>علّم أيام العمل وحدد وقت الفتح والإغلاق؛ الأيام غير المعلّمة مغلقة.</div>
          <div style={{border:"1px solid var(--ink-200)",borderRadius:10,overflow:"hidden"}}>
            {days.map((d, i) => {
              const h = form.hours[d.key] || { open:false, from:"09:00", to:"17:00" };
              return (
                <div key={d.key} className="branch-hours-row" data-day={d.key}
                  style={{display:"flex",alignItems:"center",gap:10,padding:"7px 10px",flexWrap:"wrap",
                    borderTop: i ? "1px solid var(--ink-100)" : "none", background: h.open ? "#fff" : "var(--ink-50)"}}>
                  <label style={{display:"flex",alignItems:"center",gap:8,minWidth:110,fontSize:13,cursor:"pointer"}}>
                    <input type="checkbox" checked={!!h.open} onChange={e=>setDay(d.key, { open: e.target.checked })}/>
                    {d.ar}
                  </label>
                  {h.open ? (
                    <div style={{display:"flex",alignItems:"center",gap:6,flex:1,minWidth:200}}>
                      <input type="time" className="input" dir="ltr" aria-label={`${d.ar}: من`} value={h.from} style={{height:32,maxWidth:120}}
                        onChange={e=>setDay(d.key, { from: e.target.value })}/>
                      <span className="muted" style={{fontSize:12}}>إلى</span>
                      <input type="time" className="input" dir="ltr" aria-label={`${d.ar}: إلى`} value={h.to} style={{height:32,maxWidth:120}}
                        onChange={e=>setDay(d.key, { to: e.target.value })}/>
                    </div>
                  ) : <span className="muted" style={{fontSize:12}}>مغلق</span>}
                </div>
              );
            })}
          </div>
          {errors.hours && <div id="branch-hours-err" style={errStyle}>{errors.hours}</div>}
        </fieldset>
        <button type="submit" hidden aria-hidden="true" tabIndex={-1}/>
      </form>
    </Modal>
  );
}

function Sidebar({ active, onNav, role, user, isOpen }) {
  // ── Live clinic + custom sections (re-render on updates) ──────
  const [clinic, setClinic] = React.useState(window.CLINIC || {});
  const [customs, setCustoms] = React.useState(window.CUSTOM_SECTIONS || []);
  // Bump on any data change so patient/appt counts stay live.
  const [, setTick] = React.useState(0);
  React.useEffect(()=>{
    const c = ()=> setClinic(window.CLINIC || {});
    const s = ()=> setCustoms(window.CUSTOM_SECTIONS || []);
    const d = ()=> setTick(t=>t+1);
    window.addEventListener("kinetic:clinic-updated", c);
    window.addEventListener("kinetic:sections-updated", s);
    window.addEventListener("kinetic:data-updated", d);
    return ()=>{
      window.removeEventListener("kinetic:clinic-updated", c);
      window.removeEventListener("kinetic:sections-updated", s);
      window.removeEventListener("kinetic:data-updated", d);
    };
  },[]);

  // ── Role-aware counts — every job sees only its own caseload ──
  const pCount = window.scopePatients ? window.scopePatients(DATA.patients).length : DATA.patients.length;
  // Bookings that aren't just an empty slot. Handles both seed labels ("متاح")
  // and canonical Supabase values ("available").
  const aCount = (window.scopeAppts ? window.scopeAppts(DATA.appts) : DATA.appts)
    .filter(a => a.status !== "متاح" && a.status !== "available").length;
  const dashLabel = (window.ROLE_DASH_LABEL && window.ROLE_DASH_LABEL[role]) || "لوحة التحكم";

  // ── Custom section groups (admin-defined) ─────────────────────
  const customGroups = {};
  customs.filter(s=>s.visible!==false).forEach(s=>{
    const g = s.group || "مخصص";
    if(!customGroups[g]) customGroups[g] = [];
    const iconName = CUSTOM_ICON_WHITELIST.has(s.icon) ? s.icon : "Layers";
    const Ico = I[iconName] || I.Layers;
    customGroups[g].push({ id:"custom:"+s.id, label:s.label, icon:<Ico size={17}/>, custom:true });
  });
  const customGroupList = Object.keys(customGroups).map(title=>({ title, items:customGroups[title] }));

  const allGroups = [
    { title: null, items: [
      { id:"dashboard", label:dashLabel, icon: <I.Dashboard size={17}/> },
    ]},
    { title: "الرعاية", items: [
      { id:"patients",    label:"المرضى",        icon: <I.Users size={17}/>, badge: pCount },
      { id:"appointments",label:"المواعيد",    icon: <I.Calendar size={17}/>, badge: aCount, badgeKind:"blue" },
      { id:"treatments",  label:"خطط العلاج", icon: <I.Clipboard size={17}/> },
      { id:"sessions",    label:"جلسات العلاج",icon: <I.Activity size={17}/> },
    ]},
    { title: "المالية", items: [
      { id:"payments", label:"المدفوعات والفواتير", icon: <I.CreditCard size={17}/> },
      { id:"packages", label:"الباقات",            icon: <I.Package size={17}/> },
    ]},
    { title: "النمو", items: [
      { id:"campaigns", label:"حملات واتساب", icon: <I.Megaphone size={17}/> },
      { id:"reports",   label:"التقارير",            icon: <I.Chart size={17}/> },
    ]},
    ...customGroupList,
    { title: "النظام", items: [
      { id:"branches", label:"الفروع", icon: <I.MapPin size={17}/> },
      { id:"settings", label:"الإعدادات", icon: <I.Settings size={17}/> },
    ]},
  ];

  // ── Hide routes this role can't reach or whose module is disabled
  // for the clinic (src/roles.jsx ROUTE_MODULES); drop empty sections ──
  // Custom sections (prefixed "custom:") are visible only to admin.
  const allowed = (window.ROLE_ROUTES && window.ROLE_ROUTES[role]) || null;
  const moduleOn = (id) => !window.routeModuleEnabled || window.routeModuleEnabled(id);
  const groups = allGroups
    .map(g => ({ ...g, items: g.items.filter(it => {
      if (it.custom) return role === "مدير";
      return (!allowed || allowed.includes(it.id)) && moduleOn(it.id);
    }) }))
    .filter(g => g.items.length > 0);

  const u = user || { name:"أمير", email:"amir@kinetic.eg" };
  const uInit = window.initialsOf ? window.initialsOf(u.name) : "ش ع";
  // «تبديل العيادة» (docs/03 Alternate journeys) for members of several clinics.
  const memberships = (window.TENANT_SESSION && window.TENANT_SESSION.memberships) || [];
  const canSwitchClinic = memberships.length > 1 && !!window.tenantGoRoot;

  return (
    <aside className={"sidebar" + (isOpen ? " open" : "")}>
      {/* Brand */}
      <div style={{padding:"18px 20px 14px",display:"flex",alignItems:"center",gap:10}}>
        {clinic.logo
          ? <img src={clinic.logo} alt="" style={{width:30,height:30,borderRadius:9,objectFit:"cover",background:"var(--blue-50)"}}/>
          : <I.Logo size={30}/>}
        <div style={{display:"flex",flexDirection:"column",lineHeight:1.1}}>
          <span style={{fontWeight:600,fontSize:15,letterSpacing:"-.01em"}}>{clinic.name || "—"}</span>
          <span style={{fontSize:11,color:"var(--ink-500)"}}>{clinic.subtitle || ""}</span>
        </div>
      </div>

      {/* Clinic switcher */}
      <BranchSwitcher role={role}/>

      <nav aria-label="القائمة الرئيسية" style={{flex:1, overflowY:"auto", paddingBottom:14}}>
        {groups.map((g,gi)=>(
          <div key={gi}>
            {g.title && <div className="nav-section">{g.title}</div>}
            {g.items.map(it => (
              <div key={it.id} data-route={it.id} role="link" tabIndex={0}
                aria-current={active===it.id ? "page" : undefined}
                className={"nav-item" + (active===it.id?" active":"")}
                onKeyDown={(e)=>{ if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onNav(it.id); } }}
                onClick={()=>onNav(it.id)}>
                {it.icon}
                <span style={{flex:1}}>{it.label}</span>
                {it.badge!=null && (
                  <span className="mono" style={{
                    fontSize:10.5, color: it.badgeKind==="blue"?"var(--blue-900)":"var(--ink-500)",
                    background: it.badgeKind==="blue"?"var(--blue-100)":"var(--ink-100)",
                    padding:"1.5px 7px", borderRadius:999
                  }}>{it.badge}</span>
                )}
              </div>
            ))}
            {gi<groups.length-1 && <div style={{height:10}}/>}
          </div>
        ))}
      </nav>

      {/* user card */}
      <div style={{padding:"12px 14px",borderTop:"1px solid var(--ink-200)",display:"flex",alignItems:"center",gap:10}}>
        <div className="av md" aria-hidden="true" style={{background:"var(--blue-700)",color:"#fff"}}>{uInit}</div>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:12.5,fontWeight:600,lineHeight:1.2,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{u.name}</div>
          <div style={{fontSize:10.5,color:"var(--ink-500)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{role || "مدير"} · <bdi dir="ltr">{u.email}</bdi></div>
        </div>
        {canSwitchClinic && (
          <button className="btn btn-ghost btn-icon" title="تبديل العيادة" aria-label="تبديل العيادة" onClick={()=>window.tenantGoRoot()}>
            <I.Layers size={15}/>
          </button>
        )}
        <button className="btn btn-ghost btn-icon" title="تسجيل الخروج" aria-label="تسجيل الخروج" onClick={()=>onNav("logout")}>
          <I.Logout size={15}/>
        </button>
      </div>
    </aside>
  );
}

function TopBar({ title, crumb, right, onSearch, theme, setTheme }) {
  return (
    <div className="topbar">
      <div style={{flex:1,display:"flex",alignItems:"center",gap:14}}>
        <div>
          {crumb && <div className="crumb">{crumb.map((c,i)=>(
            <React.Fragment key={i}>
              <span>{c}</span>
              {i<crumb.length-1 && <I.Chevron size={11}/>}
            </React.Fragment>
          ))}</div>}
          <div className="h2">{title}</div>
        </div>
      </div>

      <div className="search-wrap" style={{position:"relative",width:"min(320px, 34vw)"}}>
        <I.Search size={15} style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",color:"var(--ink-400)"}}/>
        <input className="input" placeholder="ابحث عن مرضى، مواعيد، فواتير…"
          style={{paddingLeft:34,height:36,background:"var(--ink-50)",border:"1px solid transparent"}}
          onChange={(e)=>onSearch && onSearch(e.target.value)}/>
        <span className="mono" style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",fontSize:10,color:"var(--ink-400)",background:"#fff",border:"1px solid var(--ink-200)",borderRadius:5,padding:"1px 5px"}}>⌘K</span>
      </div>

      <button className="btn btn-ghost btn-icon" title="الإشعارات">
        <I.Bell size={17}/>
        <span style={{position:"absolute",width:6,height:6,background:"var(--red)",borderRadius:"50%",marginLeft:-7,marginTop:-7}}></span>
      </button>
      <button className="btn btn-ghost btn-icon" title="المظهر" onClick={()=>setTheme && setTheme(theme==="light"?"dark":"light")}>
        {theme==="dark" ? <I.Sun size={17}/> : <I.Moon size={17}/>}
      </button>
      {right}
    </div>
  );
}

// ── Generic empty state ────────────────────────────────────────
function EmptyState({ icon, title, body, action }) {
  return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",padding:"60px 24px",textAlign:"center"}}>
      <div style={{width:56,height:56,borderRadius:14,background:"var(--blue-100)",color:"var(--blue-700)",display:"flex",alignItems:"center",justifyContent:"center",marginBottom:14}}>
        {icon || <I.Sparkle size={22}/>}
      </div>
      <div className="h3" style={{marginBottom:4}}>{title}</div>
      <div className="muted" style={{maxWidth:360,fontSize:13}}>{body}</div>
      {action && <div style={{marginTop:16}}>{action}</div>}
    </div>
  );
}

// ── Skeleton row ───────────────────────────────────────────────
function SkeletonRow({ count=5 }) {
  return Array.from({length:count}).map((_,i)=>(
    <div key={i} style={{display:"flex",alignItems:"center",gap:12,padding:"12px 14px",borderBottom:"1px solid var(--ink-100)"}}>
      <div className="skel" style={{width:32,height:32,borderRadius:999}}/>
      <div className="skel" style={{height:11,width:`${30+Math.random()*30}%`}}/>
      <div className="skel" style={{height:11,width:`${15+Math.random()*15}%`,marginLeft:"auto"}}/>
      <div className="skel" style={{height:11,width:60}}/>
    </div>
  ));
}

// ── Modal ──────────────────────────────────────────────────────
// Open modals, innermost last: only the top one handles Esc and Tab.
const __openModals = [];
// Elements Tab can reach inside `box`, in document order (hidden, disabled
// and tabindex="-1" ones left out, as the browser skips them).
const __TABBABLE = 'a[href],area[href],button,input:not([type="hidden"]),select,textarea,iframe,summary,audio[controls],video[controls],[contenteditable]:not([contenteditable="false"]),[tabindex]';
function __tabbablesIn(box) {
  return Array.from(box.querySelectorAll(__TABBABLE)).filter(el => {
    if (el.hasAttribute("data-focus-guard") || el.disabled) return false;
    const ti = el.getAttribute("tabindex");
    if (ti != null && ti !== "" && Number(ti) < 0) return false;
    if (el.closest("fieldset:disabled, [inert]")) return false;
    if (!el.getClientRects().length) return false;
    return window.getComputedStyle(el).visibility !== "hidden";
  });
}
// Focus `el` without scrolling the page behind; false when it cannot.
function __focusEl(el) {
  if (!el || typeof el.focus !== "function") return false;
  try { el.focus({ preventScroll: true }); } catch (_) { return false; }
  return document.activeElement === el;
}
// Tab / Shift+Tab inside the top dialog: from the last element back to the
// first and the other way round, and back inside when focus is elsewhere
// (e.g. on <body> after a click on the backdrop while saving).
function __trapTab(e, box) {
  const list = __tabbablesIn(box);
  const active = document.activeElement;
  if (!list.length) { e.preventDefault(); __focusEl(box); return; }
  const first = list[0], last = list[list.length - 1];
  if (active === box || !box.contains(active)) {
    e.preventDefault();
    __focusEl(e.shiftKey ? last : first);
  } else if (e.shiftKey && active === first) {
    e.preventDefault(); __focusEl(last);
  } else if (!e.shiftKey && active === last) {
    e.preventDefault(); __focusEl(first);
  }
}
// Invisible stops just before and after the dialog: if the browser's own
// Tab order ever steps past its edge, focus wraps instead of reaching the
// page behind.
const __FOCUS_GUARD = { position:"fixed", top:0, left:0, width:1, height:1, opacity:0, overflow:"hidden", pointerEvents:"none" };

// The keyboard side of a dialog (docs/04 Accessibility), for Modal and for
// the dialogs that draw their own box (reschedule, the patient booking
// flow, the command palette): while `isOpen`, focus moves into `boxRef`
// ([data-autofocus] or an autoFocus field inside, else the box itself),
// Tab and Shift+Tab stay inside it, Esc closes it when it may be closed
// (onClose set), and focus returns to the element that opened it. With
// stacked dialogs only the top one does this. Returns an id for the
// dialog's title (aria-labelledby). The box needs tabIndex={-1}, and the
// focus guards (DialogFocusGuard) just before and after it.
function useDialogFocus(boxRef, isOpen, onClose) {
  const idRef = React.useRef(null);
  if (!idRef.current) idRef.current = "modal-" + Math.random().toString(36).slice(2, 10);
  const closeRef = React.useRef(onClose);
  closeRef.current = onClose;
  // The element that opened the dialog, read while rendering: an autoFocus
  // field inside takes focus before the effect below runs.
  const openerRef = React.useRef(null);
  if (!isOpen) openerRef.current = null;
  else if (!openerRef.current && typeof document !== "undefined") openerRef.current = document.activeElement;
  React.useEffect(() => {
    if (!isOpen) return;
    const me = idRef.current;
    __openModals.push(me);
    const box = boxRef.current;
    // A dialog opened from another one that closed in the same render (e.g.
    // «نقل / تعديل» in the booking details) has lost its opener; that
    // dialog has just given focus back to its own opener, so take that.
    let opener = openerRef.current;
    if ((!opener || !document.contains(opener)) && !(box && box.contains(document.activeElement))) opener = document.activeElement;
    if (box && !box.contains(document.activeElement)) {
      if (!__focusEl(box.querySelector("[data-autofocus]"))) __focusEl(box);
    }
    const onKey = (e) => {
      if (__openModals[__openModals.length - 1] !== me) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        if (closeRef.current) closeRef.current();
      } else if (e.key === "Tab" && box && !e.altKey && !e.ctrlKey && !e.metaKey) {
        __trapTab(e, box);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const i = __openModals.lastIndexOf(me);
      if (i >= 0) __openModals.splice(i, 1);
      // Back to the opener, unless something outside the dialog took focus
      // on purpose meanwhile.
      const active = document.activeElement;
      const lost = !active || active === document.body || !document.contains(active) || (box && box.contains(active));
      if (lost && opener && opener !== document.body && document.contains(opener)) __focusEl(opener);
    };
  }, [isOpen]);
  return idRef.current + "-title";
}

// Invisible stop just before (start) or after (end) a dialog's box: focus
// that reaches it wraps to the box's last or first element.
function DialogFocusGuard({ boxRef, at }) {
  const wrap = () => {
    const box = boxRef.current;
    if (!box) return;
    const list = __tabbablesIn(box);
    if (!__focusEl(at === "start" ? list[list.length - 1] : list[0])) __focusEl(box);
  };
  return <span tabIndex={0} data-focus-guard={at} style={__FOCUS_GUARD} onFocus={wrap}/>;
}

// A dialog (docs/04 Accessibility): role="dialog" named by its title, with
// the keyboard behaviour of useDialogFocus.
function Modal({ open, onClose, children, title, footer, width=560 }) {
  const isOpen = open !== false;
  const boxRef = React.useRef(null);
  const titleId = useDialogFocus(boxRef, isOpen, onClose);
  if (!isOpen) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <DialogFocusGuard boxRef={boxRef} at="start"/>
      <div ref={boxRef} className="modal" role="dialog" aria-modal="true" tabIndex={-1}
        aria-labelledby={title ? titleId : undefined}
        style={{width,maxWidth:`calc(100% - 40px)`,outline:"none"}} onClick={e=>e.stopPropagation()}>
        {title && (
          <div style={{padding:"18px 22px",borderBottom:"1px solid var(--ink-100)",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
            <div className="h3" id={titleId}>{title}</div>
            <button type="button" className="btn btn-ghost btn-icon" aria-label="إغلاق" onClick={onClose}><I.X size={16}/></button>
          </div>
        )}
        <div style={{padding:"20px 22px"}}>{children}</div>
        {footer && <div style={{padding:"14px 22px",borderTop:"1px solid var(--ink-100)",display:"flex",justifyContent:"flex-end",gap:10,background:"var(--ink-50)",borderBottomLeftRadius:18,borderBottomRightRadius:18}}>{footer}</div>}
      </div>
      <DialogFocusGuard boxRef={boxRef} at="end"/>
    </div>
  );
}

// ── Toast ──────────────────────────────────────────────────────
// Top left under the top bar (docs/04 Components, like the platform's
// toasts), announced to screen readers, and never in the way of a click.
function Toast({ msg, kind="success" }) {
  if (!msg) return null;
  const color = kind==="success" ? "var(--green)" : kind==="error" ? "var(--red)" : "var(--blue-700)";
  return (
    <div role={kind==="error" ? "alert" : "status"} aria-live={kind==="error" ? "assertive" : "polite"} style={{
      position:"fixed",top:72,left:16,zIndex:200,maxWidth:"min(380px, calc(100vw - 32px))",
      background:"#fff",border:"1px solid var(--ink-200)",borderRadius:12,
      boxShadow:"var(--shadow-lg)",padding:"12px 16px",pointerEvents:"none",
      display:"flex",alignItems:"center",gap:10, animation:"popin .2s"
    }}>
      <span aria-hidden="true" style={{width:8,height:8,borderRadius:999,background:color,flexShrink:0}}></span>
      <span style={{fontSize:13.5}}>{msg}</span>
    </div>
  );
}

// ── Page container ─────────────────────────────────────────────
function Page({ children }) {
  return <div className="page">{children}</div>;
}

// ── Row action menu ────────────────────────────────────────────
// Small popover triggered by a more-dots icon. Pass an `items` array of
// { label, icon?, onClick, danger? }. Closes on outside click and Escape.
// Keyboard: opening moves focus to the first item, ↑/↓ move between the
// items, Esc and Tab close it with focus back on the trigger (the menu is
// rendered at the end of <body>, out of the page's Tab order).
function RowMenu({ items = [], size = 13, stopRowClick = true }) {
  const [open, setOpen] = React.useState(false);
  // Fixed positioning (computed from the trigger) lets the popover escape
  // horizontally-scrolling table wrappers on small screens. It is rendered
  // into document.body (a portal), so a row's own stacking context (e.g.
  // opacity) or a later sticky table header cannot cover it.
  const [pos, setPos] = React.useState({ top: 0, left: 0 });
  const ref = React.useRef(null);
  const popRef = React.useRef(null);
  const btnRef = React.useRef(null);
  const anchor = React.useRef(null); // trigger position when opened
  React.useEffect(() => {
    if (!open) return;
    const inside = (t) => (ref.current && ref.current.contains(t)) || (popRef.current && popRef.current.contains(t));
    const onDoc = (e) => { if (!inside(e.target)) setOpen(false); };
    const itemsOf = () => popRef.current ? Array.from(popRef.current.querySelectorAll("button")) : [];
    const onKey = (e) => {
      if (e.key === "Escape" || e.key === "Tab") {
        if (e.key === "Tab") e.preventDefault();
        setOpen(false);
        if (btnRef.current) btnRef.current.focus();
      } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && popRef.current && popRef.current.contains(document.activeElement)) {
        e.preventDefault();
        const list = itemsOf();
        const i = list.indexOf(document.activeElement);
        const next = list[(i + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length];
        if (next) next.focus();
      }
    };
    const t = setTimeout(() => { const first = itemsOf()[0]; if (first) first.focus({ preventScroll: true }); }, 0);
    // Close when the trigger moves (page or table scrolled, window
    // resized). A scroll event that arrives after opening for a scroll made
    // before it (they fire on the next frame) leaves the trigger in place
    // and keeps the menu open.
    const onAway = () => {
      const a = anchor.current;
      const r = btnRef.current && btnRef.current.getBoundingClientRect();
      if (!a || !r || Math.abs(r.top - a.top) > 1 || Math.abs(r.left - a.left) > 1) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onAway, true);
    window.addEventListener("resize", onAway);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onAway, true);
      window.removeEventListener("resize", onAway);
    };
  }, [open]);
  const MENU_W = 180;
  return (
    <div ref={ref} style={{position:"relative",display:"inline-block"}}>
      <button ref={btnRef} type="button" className="btn btn-ghost btn-icon" title="المزيد" aria-label="المزيد" aria-expanded={open ? "true" : "false"} onClick={(e)=>{
        if (stopRowClick) e.stopPropagation();
        if (!open) {
          const r = e.currentTarget.getBoundingClientRect();
          anchor.current = { top: r.top, left: r.left };
          const left = Math.max(8, Math.min(r.right - MENU_W, window.innerWidth - MENU_W - 8));
          // Below the trigger, or above it when the menu would leave the screen.
          const h = items.length * 34 + 14;
          const top = (r.bottom + 4 + h <= window.innerHeight - 8) ? r.bottom + 4 : Math.max(8, r.top - 4 - h);
          setPos({ top, left });
        }
        setOpen(o=>!o);
      }}>
        <I.More size={size}/>
      </button>
      {open && __rowMenuPortal(
        <div ref={popRef} className="row-menu-pop" style={{position:"fixed",top:pos.top,left:pos.left,minWidth:MENU_W,background:"#fff",border:"1px solid var(--ink-200)",borderRadius:10,boxShadow:"var(--shadow-md)",zIndex:120,padding:6}}>
          {items.map((it, i) => (
            <button key={i} type="button" className="row-menu-item" onClick={(e)=>{
                e.stopPropagation(); setOpen(false);
                // Back on the trigger first: a dialog the item opens returns focus there.
                if (btnRef.current) btnRef.current.focus({ preventScroll: true });
                if (it.onClick) it.onClick();
              }}
              style={{display:"flex",alignItems:"center",gap:8,width:"100%",minHeight:34,padding:"7px 10px",fontSize:13,textAlign:"start",background:"transparent",border:"none",borderRadius:6,cursor:"pointer",color:it.danger?"#A8443A":"var(--ink-700)",fontFamily:"inherit"}}
              onMouseEnter={(e)=>{ e.currentTarget.style.background = "var(--ink-50)"; }}
              onMouseLeave={(e)=>{ e.currentTarget.style.background = "transparent"; }}
            >
              {it.icon}
              <span>{it.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
// document.body portal when ReactDOM offers one (React 16+), else in place.
function __rowMenuPortal(node) {
  return (window.ReactDOM && typeof window.ReactDOM.createPortal === "function" && document.body)
    ? window.ReactDOM.createPortal(node, document.body)
    : node;
}
window.RowMenu = RowMenu;

// ── WhatsApp appointment reminder ──────────────────────────────
// Builds the reminder from live DB-backed data only: patient name/phone
// from DATA.patients, date/time/therapist from DATA.appts, clinic name
// from the clinic_settings singleton (window.CLINIC). The message opens
// pre-filled in a new WhatsApp tab — the receptionist reviews it and
// presses Send manually; nothing is sent automatically.

// Country code used to convert local numbers ("010…" → "2010…").
// Matches the clinic locale used across the app (ar-EG).
const WA_COUNTRY_CODE = "20";

// Sanitize + convert to international format. Removes spaces, dashes and
// punctuation, handles "00"/"+" prefixes, and prefixes the country code
// for local numbers ("0…" or a bare 10-digit mobile). Returns the wa.me
// digit string, or null when the number can't be a valid phone.
function waNormalizePhone(raw) {
  let s = String(raw == null ? "" : raw).trim().replace(/[\s\-().]/g, "");
  if (!s) return null;
  if (s.startsWith("00")) s = "+" + s.slice(2);
  const intl = s.startsWith("+");
  s = s.replace(/\D/g, "");
  if (!s) return null;
  if (!intl) {
    if (s.startsWith("0")) s = WA_COUNTRY_CODE + s.replace(/^0+/, "");
    else if (/^1\d{9}$/.test(s)) s = WA_COUNTRY_CODE + s; // mobile typed without the leading 0
  }
  return /^[1-9]\d{9,14}$/.test(s) ? s : null; // E.164: 10–15 digits, no leading zero
}

// Default reminder template. The therapist line is omitted entirely when
// no therapist/doctor is attached — never rendered empty.
function waReminderMessage({ patientName, clinicName, date, time, therapistName }) {
  const lines = [
    `السلام عليكم ${patientName}`,
    `نذكركم بموعدكم في ${clinicName}.`,
    `📅 التاريخ: ${date}`,
    `🕒 الوقت: ${time}`,
  ];
  if (therapistName && String(therapistName).trim() && therapistName !== "—") {
    lines.push(`👨‍⚕️ المعالج: ${therapistName}`);
  }
  lines.push("في حال الرغبة بتعديل الموعد، يرجى التواصل معنا.");
  lines.push("شكراً لكم ونتمنى لكم دوام الصحة.");
  return lines.join("\n");
}

// Valid ISO date of a booking row, "" when missing/unparseable.
function waApptDateIso(a) {
  const s = String((a && (a.date || a.appointment_date || a.start_date)) || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
}

// Re-resolve the live patient row from the DB mirror so the reminder
// always reads the current phone/name, not a stale render snapshot.
function waLivePatient(patient) {
  if (!patient) return null;
  const pid = patient.patient_id || patient.id;
  return ((window.DATA && window.DATA.patients) || [])
    .find(x => (x.patient_id || x.id) === pid) || patient;
}

// Patient row a booking belongs to (by id, falling back to name for
// legacy rows) — same matching rule as AppointmentActionsModal.
function waPatientOfAppt(appt) {
  if (!appt) return null;
  return ((window.DATA && window.DATA.patients) || []).find(p =>
    (p.patient_id || p.id) === (appt.patient_id || appt.pid)
    || (appt.patient && p.name === appt.patient)) || null;
}

// The patient's next reminder-worthy appointment: the earliest active
// (not completed/cancelled/free-slot) booking from today onward. Falls
// back to an undated active booking so the button can explain exactly
// why it is disabled instead of silently hiding.
function waNextAppt(patient) {
  const p = waLivePatient(patient);
  if (!p) return null;
  const pid = p.patient_id || p.id;
  const done = new Set(["مكتمل", "ملغي", "ملغى", "cancelled", "متاح"]);
  const mine = ((window.DATA && window.DATA.appts) || []).filter(a =>
    ((a.patient_id || a.pid) === pid || (p.name && a.patient === p.name)) && !done.has(a.status));
  const t = new Date();
  const todayIso = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  const upcoming = mine
    .filter(a => waApptDateIso(a) >= todayIso)
    .sort((a, b) => (waApptDateIso(a) + (a.time || "")).localeCompare(waApptDateIso(b) + (b.time || "")));
  return upcoming[0] || mine.find(a => !waApptDateIso(a)) || null;
}

// Why the reminder can't be built from this booking (null when it can).
// Doubles as the disabled-state tooltip.
function waReminderDisabledReason(appt) {
  if (!appt) return "لا يمكن إرسال التذكير — لا يوجد موعد قادم لهذا المريض";
  if (!waApptDateIso(appt)) return "لا يمكن إرسال التذكير — تاريخ الموعد غير محدد";
  if (!appt.time) return "لا يمكن إرسال التذكير — وقت الموعد غير محدد";
  return null;
}

// Validate, build and open the wa.me link in a new tab.
function sendWaApptReminder(patient, appt) {
  const toast = window.showToast || (() => {});
  const p = waLivePatient(patient) || waPatientOfAppt(appt);
  if (!p) return toast("تعذّر العثور على بيانات المريض لهذا الموعد", "error");
  const reason = waReminderDisabledReason(appt);
  if (reason) return toast(reason, "error");
  const raw = p.phone || p.whatsapp;
  if (!raw || !String(raw).trim()) return toast("رقم هاتف المريض غير مسجل — أضِف رقم الهاتف من ملف المريض أولًا", "error");
  const phone = waNormalizePhone(raw);
  if (!phone) return toast(`رقم هاتف المريض غير صالح (${raw}) — صحّح الرقم من ملف المريض أولًا`, "error");
  const msg = waReminderMessage({
    patientName: p.name || "",
    clinicName: (window.CLINIC && window.CLINIC.name) || "العيادة",
    date: waApptDateIso(appt),
    time: appt.time,
    therapistName: appt.th || appt.dr || "",
  });
  window.open(`https://wa.me/${phone}?text=${encodeURIComponent(msg)}`, "_blank", "noopener");
}

// «إرسال تذكير واتساب» button. Pass `appt` on appointment surfaces; omit
// it on patient surfaces and the next upcoming appointment is resolved
// live. Disabled (with an explanatory tooltip) when the date or time is
// missing. `iconOnly` renders the compact table-row variant.
function WaReminderButton({ patient, appt, iconOnly = false, className = "btn btn-secondary", style }) {
  window.useDataVersion && window.useDataVersion();
  const target = appt !== undefined ? appt : waNextAppt(patient);
  const reason = waReminderDisabledReason(target);
  const label = "إرسال تذكير واتساب";
  return (
    // The title lives on a wrapper so the tooltip still shows over a
    // disabled button (disabled elements swallow hover in some browsers).
    <span title={reason || label}
      style={{ display: "inline-flex", width: style && style.width ? style.width : undefined }}
      onClick={e => e.stopPropagation()}>
      <button
        className={iconOnly ? "btn btn-ghost btn-icon" : className}
        disabled={!!reason}
        aria-label={label}
        style={{ ...(reason ? { opacity: .5, cursor: "not-allowed" } : null), ...style }}
        onClick={() => sendWaApptReminder(patient || waPatientOfAppt(target), target)}
      >
        <I.WhatsApp size={14} style={!reason ? { color: "#25D366" } : null}/>
        {!iconOnly && <span>{label}</span>}
      </button>
    </span>
  );
}

Object.assign(window, {
  waNormalizePhone, waReminderMessage, waNextAppt, waPatientOfAppt,
  waReminderDisabledReason, sendWaApptReminder, WaReminderButton,
});

// ── Segmented buttons ──────────────────────────────────────────
// The shared .seg control (docs/04, task 3.24): a labelled group whose
// buttons announce the chosen one with aria-pressed.
//   <Segmented label={tt("العرض")} value={view} onChange={setView}
//     options={[{ value: "list", label: tt("قائمة") }, { value: "cards", label: tt("بطاقات"), icon: "Grid" }]}/>
function Segmented({ options, value, onChange, label, className, style, size }) {
  return (
    <div className={"seg" + (className ? " " + className : "")} role="group" aria-label={label} style={style}>
      {(options || []).map((o) => {
        const on = o.value === value;
        const Icon = o.icon && I[o.icon];
        return (
          <button key={String(o.value)} type="button" className={on ? "on" : ""} aria-pressed={on ? "true" : "false"}
            disabled={o.disabled} title={o.title} data-value={o.value} onClick={() => !on && onChange && onChange(o.value)}>
            {Icon ? <Icon size={size || 13} aria-hidden="true"/> : null}{o.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Tables that become cards on phones ─────────────────────────
// docs/04 «Layout rules»: under 640px a list table turns into one card per
// row (task 3.20). <CardTable> is a <table className="tbl tbl-cards">
// that, after every render, gives each body cell its column title as
// data-label; the phone CSS in index.html shows it before the value. A
// header cell with .sr-only text (e.g. «إجراءات») gives no label.
function CardTable({ children, className, ...rest }) {
  const ref = React.useRef(null);
  React.useLayoutEffect(() => {
    const table = ref.current;
    if (!table) return;
    const heads = Array.from(table.querySelectorAll("thead th")).map((th) => (th.querySelector(".sr-only") || th.classList.contains("sr-only") ? "" : th.textContent.trim()));
    table.querySelectorAll("tbody tr").forEach((tr) => {
      Array.from(tr.children).forEach((td, i) => {
        const label = td.colSpan > 1 ? "" : heads[i] || "";
        if (label) { if (td.getAttribute("data-label") !== label) td.setAttribute("data-label", label); }
        else if (td.hasAttribute("data-label")) td.removeAttribute("data-label");
      });
    });
  });
  return <table ref={ref} className={"tbl tbl-cards" + (className ? " " + className : "")} {...rest}>{children}</table>;
}

Object.assign(window, { Segmented, CardTable });

// ── Searchable combobox ────────────────────────────────────────
// Modern healthcare-SaaS style entity picker. Drop-in replacement for a
// native <select> that renders two-line cards, filters with Arabic
// normalisation, and supports full keyboard nav.
//
// EntityCombobox is the generic engine — parents pass accessors (getId,
// getPrimary, renderSecondary, …) so the same component can power patient,
// therapist, or any other picker. PatientCombobox and TherapistCombobox
// are thin wrappers that preset the accessors for their domain.
//
// Features: instant filtering with Arabic normalisation, highlighted
// matches, full keyboard nav (↑ ↓ Enter Esc Home End), fixed-positioned
// panel so it escapes modal overflow clipping, virtualised list for
// large datasets (>60 rows), soft shadow + slide/fade animation.
function normalizeAr(s) {
  if (s == null) return "";
  return String(s)
    .toLowerCase()
    .replace(/[\u064B-\u0652\u0670]/g, "")   // strip Arabic diacritics
    .replace(/[إأآٱا]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/\s+/g, " ")
    .trim();
}
function initialsOf2(name) {
  return (name || "?").trim().split(/\s+/).slice(0, 2).map(w => w[0] || "").join("").toUpperCase();
}
function highlightMatch(text, query) {
  const raw = String(text == null ? "" : text);
  const q = String(query || "").trim();
  if (!q) return raw;
  const lo = raw.toLowerCase();
  const i = lo.indexOf(q.toLowerCase());
  if (i < 0) return raw; // normalised-only match: safer to leave unhighlighted
  return (
    <>
      {raw.slice(0, i)}
      <mark className="pcombo-hl">{raw.slice(i, i + q.length)}</mark>
      {raw.slice(i + q.length)}
    </>
  );
}

function EntityCombobox({
  value,
  onChange,
  items = [],
  // Accessors — every one has a sensible default so simple cases stay terse.
  getId = it => it && (it.id || it.patient_id || it.staff_id || it.name),
  getPrimary = it => (it && it.name) || "",
  getSearchText,                                 // (item) => haystack; defaults to primary + id
  getInitials,                                   // (item) => 2-char string; defaults to first 2 words
  getAccent,                                     // (item) => color; overrides avatar background
  renderSecondary,                               // (item, hl) => ReactNode; hl(text) highlights query
  // Presentation
  placeholder = "اختر…",
  emptyMessage = "لا نتائج",
  emptyHint,
  ariaLabel = "قائمة",
  disabled = false,
  loading = false,
  countLabel,                                    // (visible, total) => string
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [rect, setRect] = React.useState(null);
  const [scrollTop, setScrollTop] = React.useState(0);
  const rootRef = React.useRef(null);
  const inputRef = React.useRef(null);
  const listRef = React.useRef(null);

  const haystackOf = React.useCallback(it => {
    if (getSearchText) return getSearchText(it);
    return `${getPrimary(it) || ""} ${getId(it) || ""}`;
  }, [getSearchText, getPrimary, getId]);

  const filtered = React.useMemo(() => {
    const q = normalizeAr(query);
    if (!q) return items;
    return items.filter(it => normalizeAr(haystackOf(it)).includes(q));
  }, [items, query, haystackOf]);

  const selected = React.useMemo(
    () => items.find(it => getId(it) === value) || null,
    [items, value, getId]
  );

  const updateRect = React.useCallback(() => {
    if (rootRef.current) setRect(rootRef.current.getBoundingClientRect());
  }, []);

  // Open lifecycle: focus input, seed active index to the selection,
  // wire outside-click dismissal, and REPOSITION (not dismiss) on
  // viewport reflow. iOS Safari fires window "resize" and page "scroll"
  // when the on-screen keyboard opens; dismissing on those events used
  // to instantly close the panel and kill the keyboard on iPad/iPhone.
  React.useEffect(() => {
    if (!open) { setQuery(""); setActiveIndex(0); setScrollTop(0); return; }
    updateRect();
    const t = setTimeout(() => inputRef.current && inputRef.current.focus(), 20);
    const selIdx = filtered.findIndex(it => getId(it) === value);
    if (selIdx >= 0) setActiveIndex(selIdx);

    const onDoc = e => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    const onKey = e => { if (e.key === "Escape") setOpen(false); };
    const onReflow = e => {
      // Ignore scrolls that originate inside our own subtree (the user
      // scrolling the result list, not the outer page moving under us).
      if (e && e.type === "scroll" && rootRef.current && rootRef.current.contains(e.target)) return;
      updateRect();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  React.useEffect(() => {
    if (activeIndex >= filtered.length) setActiveIndex(Math.max(0, filtered.length - 1));
  }, [filtered.length, activeIndex]);

  React.useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-idx="${activeIndex}"]`);
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex, open]);

  function pick(it) {
    if (!it) return;
    onChange && onChange(getId(it), it);
    setOpen(false);
  }

  function onKeyDown(e) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex(i => Math.min(i + 1, Math.max(0, filtered.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex(i => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(filtered[activeIndex]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === "Home") {
      e.preventDefault(); setActiveIndex(0);
    } else if (e.key === "End") {
      e.preventDefault(); setActiveIndex(Math.max(0, filtered.length - 1));
    }
  }

  // Virtualisation — kicks in for large lists to keep DOM light
  const ITEM_H = 60;
  const VIEW_H = 360;
  const virt = filtered.length > 60;
  const startIdx = virt ? Math.max(0, Math.floor(scrollTop / ITEM_H) - 4) : 0;
  const endIdx = virt ? Math.min(filtered.length, Math.ceil((scrollTop + VIEW_H) / ITEM_H) + 4) : filtered.length;
  const padTop = virt ? startIdx * ITEM_H : 0;
  const padBot = virt ? (filtered.length - endIdx) * ITEM_H : 0;
  const visible = filtered.slice(startIdx, endIdx);

  const panelStyle = rect ? {
    position: "fixed",
    top: Math.min(rect.bottom + 6, window.innerHeight - 60),
    insetInlineStart: rect.left,
    width: rect.width,
    zIndex: 200,
  } : { display: "none" };

  // Curried highlight for row renderers
  const hlNoop = t => t;
  const hlWith = q => t => highlightMatch(t, q);

  // Renders the avatar. Accent color (if any) is applied inline.
  function renderAvatar(it) {
    const initials = getInitials ? getInitials(it) : initialsOf2(getPrimary(it));
    const accent = getAccent ? getAccent(it) : null;
    const style = accent ? { background: accent, color: "#fff" } : undefined;
    return <div className="av sm pcombo-av" style={style}>{initials}</div>;
  }

  // Renders one row's secondary line. Uses renderSecondary if given, else
  // falls back to the item id in muted mono.
  function renderRowSecondary(it, hl) {
    if (renderSecondary) return renderSecondary(it, hl);
    return <span className="mono">{hl(getId(it) || "")}</span>;
  }

  return (
    <div ref={rootRef} className="pcombo" style={{position:"relative", direction:"inherit"}}>
      <button
        type="button"
        className={`pcombo-trigger${open ? " is-open" : ""}${disabled ? " is-disabled" : ""}`}
        aria-haspopup="listbox" aria-expanded={open}
        disabled={disabled}
        onClick={() => { if (!disabled) { updateRect(); setOpen(o => !o); } }}
      >
        {selected ? (
          <div className="pcombo-sel">
            {renderAvatar(selected)}
            <div style={{flex:1, minWidth:0, textAlign:"start"}}>
              <div className="pcombo-name" title={getPrimary(selected)}>{getPrimary(selected)}</div>
              <div className="pcombo-sub">{renderRowSecondary(selected, hlNoop)}</div>
            </div>
          </div>
        ) : (
          <span className="pcombo-placeholder">{placeholder}</span>
        )}
        <I.ChevronDown size={14}
          style={{color:"var(--ink-500)", flexShrink:0, marginInlineStart:8,
                  transition:"transform .18s ease", transform: open ? "rotate(180deg)" : "none"}}/>
      </button>

      {open && (
        <div className="pcombo-panel" role="listbox" aria-label={ariaLabel} style={panelStyle}>
          <div className="pcombo-search">
            <I.Search size={14} style={{color:"var(--ink-400)", flexShrink:0}}/>
            <input
              ref={inputRef}
              className="pcombo-input"
              value={query}
              onChange={e => { setQuery(e.target.value); setActiveIndex(0); }}
              onKeyDown={onKeyDown}
              placeholder={placeholder}
              aria-label={ariaLabel}
              aria-autocomplete="list"
              aria-controls="pcombo-list"
            />
            {query && (
              <button type="button" className="pcombo-clear" onClick={() => { setQuery(""); inputRef.current && inputRef.current.focus(); }} aria-label="مسح البحث">
                <I.X size={12}/>
              </button>
            )}
          </div>

          <div
            ref={listRef}
            id="pcombo-list"
            className="pcombo-list"
            style={{maxHeight: VIEW_H}}
            onScroll={virt ? e => setScrollTop(e.currentTarget.scrollTop) : undefined}
          >
            {loading && (
              <div className="pcombo-empty">
                <span className="spin" style={{width:16, height:16, border:"2px solid var(--ink-200)", borderTopColor:"var(--blue-500)", borderRadius:"50%"}}/>
                <div>جارٍ التحميل…</div>
              </div>
            )}

            {!loading && filtered.length === 0 && (
              <div className="pcombo-empty">
                <I.Search size={18}/>
                <div>{emptyMessage}</div>
                {query && emptyHint && <div style={{fontSize:11.5, color:"var(--ink-500)"}}>{emptyHint}</div>}
              </div>
            )}

            {!loading && filtered.length > 0 && (
              <>
                {padTop > 0 && <div style={{height:padTop}}/>}
                {visible.map((it, i) => {
                  const idx = startIdx + i;
                  const id = getId(it);
                  const isSel = id === value;
                  const isAct = idx === activeIndex;
                  const hl = hlWith(query);
                  return (
                    <div
                      key={id}
                      data-idx={idx}
                      role="option"
                      aria-selected={isSel}
                      className={`pcombo-item${isSel ? " is-selected" : ""}${isAct ? " is-active" : ""}`}
                      onMouseEnter={() => setActiveIndex(idx)}
                      onClick={() => pick(it)}
                    >
                      {renderAvatar(it)}
                      <div style={{flex:1, minWidth:0}}>
                        <div className="pcombo-name" title={getPrimary(it)}>{hl(getPrimary(it))}</div>
                        <div className="pcombo-sub">{renderRowSecondary(it, hl)}</div>
                      </div>
                      {isSel && <I.Check size={14} style={{color:"var(--blue-700)", flexShrink:0}}/>}
                    </div>
                  );
                })}
                {padBot > 0 && <div style={{height:padBot}}/>}
              </>
            )}
          </div>

          {!loading && filtered.length > 0 && (
            <div className="pcombo-foot">
              <span>{countLabel ? countLabel(filtered.length, items.length) : `${filtered.length} من ${items.length}`}</span>
              <span className="pcombo-kbd">↑↓ للتنقل · Enter للاختيار · Esc للإغلاق</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
window.EntityCombobox = EntityCombobox;

// ── Domain wrappers ────────────────────────────────────────────
// Each wrapper is deliberately tiny — it just presets accessors for its
// domain. Callers keep the exact same API they had with the native <select>:
// pass value + onChange + the array they already have.
function PatientCombobox({ value, onChange, patients = [], placeholder, disabled, loading }) {
  return (
    <EntityCombobox
      value={value}
      onChange={onChange}
      items={patients}
      getId={p => p.patient_id || p.id}
      getPrimary={p => p.name}
      getInitials={p => initialsOf2(p.name)}
      getSearchText={p => `${p.name || ""} ${p.patient_id || p.id || ""} ${p.phone || ""} ${p.diag || p.diagnosis || ""}`}
      renderSecondary={(p, hl) => (
        <>
          <span className="mono">{hl(p.patient_id || p.id || "")}</span>
          {p.phone && <> · <span className="mono">{hl(p.phone)}</span></>}
          {p.age && <> · {p.age} سنة</>}
        </>
      )}
      placeholder={placeholder || "ابحث عن مريض بالاسم أو الرقم…"}
      emptyMessage="لا يوجد مرضى مطابقون"
      emptyHint="جرّب اسمًا آخر أو رقم ملف"
      ariaLabel="ابحث عن مريض"
      disabled={disabled}
      loading={loading}
    />
  );
}
window.PatientCombobox = PatientCombobox;

function TherapistCombobox({ value, onChange, therapists = [], placeholder, disabled, loading }) {
  return (
    <EntityCombobox
      value={value}
      onChange={onChange}
      items={therapists}
      getId={t => t.staff_id || t.id || t.name}
      getPrimary={t => t.name}
      getInitials={t => initialsOf2(t.name)}
      getAccent={t => t.color}
      getSearchText={t => `${t.name || ""} ${t.spec || ""}`}
      renderSecondary={(t, hl) => {
        const hasLoad = typeof t.load === "number" && typeof t.max === "number";
        return (
          <>
            {t.spec ? hl(t.spec) : null}
            {hasLoad && <> · {t.load}/{t.max} حالة</>}
          </>
        );
      }}
      placeholder={placeholder || "اختر الأخصائي…"}
      emptyMessage="لا يوجد أخصائيين مطابقون"
      ariaLabel="ابحث عن الأخصائي"
      disabled={disabled}
      loading={loading}
    />
  );
}
window.TherapistCombobox = TherapistCombobox;

// ── CategoryCombobox — treatment-plan template category picker ──
// DB-authoritative, searchable dropdown backed by the template_categories
// table (via window.TplCategories). It loads active categories on mount,
// refreshes live on `kinetic:tpl-categories-updated`, and stores the
// selected category NAME (templates keep category as free text so a
// rename/archive never orphans historical templates). A current value
// that isn't an active category (legacy / archived) is preserved as a
// pinned option so editing an old template never silently drops it. The
// first option clears the field ("بدون فئة").
function CategoryCombobox({ value, onChange, placeholder, disabled }) {
  const [cats, setCats] = React.useState([]);
  const reload = React.useCallback(async () => {
    if (!window.TplCategories) return;
    const res = await window.TplCategories.list(false);   // active only
    if (res && res.ok) setCats(res.rows || []);
  }, []);
  React.useEffect(() => {
    reload();
    const on = () => reload();
    window.addEventListener("kinetic:tpl-categories-updated", on);
    return () => window.removeEventListener("kinetic:tpl-categories-updated", on);
  }, [reload]);

  const items = React.useMemo(() => {
    const list = [{ id: "", name: "بدون فئة", __none: true }];
    (cats || []).forEach(c => list.push({
      id: c.name, name: c.name, category_id: c.category_id, description: c.description || null,
    }));
    if (value && !list.some(it => it.id === value)) {
      list.push({ id: value, name: value, __custom: true });
    }
    return list;
  }, [cats, value]);

  return (
    <EntityCombobox
      value={value || ""}
      onChange={(id) => onChange && onChange(id || "")}
      items={items}
      getId={it => it.id}
      getPrimary={it => it.name}
      getSearchText={it => it.name || ""}
      getInitials={it => it.__none ? "—" : initialsOf2(it.name)}
      renderSecondary={(it) => it.__custom ? "فئة مخصّصة" : (it.description || null)}
      placeholder={placeholder || "اختر فئة…"}
      emptyMessage="لا توجد فئات"
      emptyHint="أضِف فئات من «إدارة الفئات»"
      ariaLabel="قائمة الفئات"
      disabled={disabled}
    />
  );
}
window.CategoryCombobox = CategoryCombobox;

// ── Diagnosis dictionary + inline autocomplete ─────────────────
// Editable per-category dictionary. Add new terms by editing the arrays.
window.DIAGNOSIS_DICT = {
  shoulder: [
    "Postoperative",
    "Rotator Cuff",
    "Tendinitis",
    "Tear",
    "Dislocation",
    "Supraspinatus",
    "Infraspinatus",
    "Adhesive capsulitis",
    "Full thickness",
    "Partial thickness",
    "Biceptal tendnitis",
    "Hypertrophy",
    "AC arthritis",
    "Bursitis",
  ],
  spine: [
    "Lumber spondylosis",
    "Cervical spondylosis",
    "Disc bulge",
    "Disc protrusion",
    "Disc prolapse",
    "Sciatica",
    "Numbness",
    "Femoralgia",
    "Spondylolythesis",
    "Retrolythesis",
    "Broadbase",
    "Postrolat",
    "Paracentral",
    "Central",
    "LBP",
    "Muscle spasm",
    "Mechanical pain",
    "Sacroiliatis",
    "Hip impingement",
    "Post cervical fixation",
    "Post lumber fixation",
    "C-scoliosis",
    "S-scoliosis",
    "Kyphosis",
    "Sacral neutation",
    "Flat curve",
    "Piriform's syndrome",
    "ITB syndrome",
    "Peronial pain & numbness",
    "Facet's arthropathy",
    "Muscle strain",
    "Ankylosing spondylitis",
    "Sacral displacement",
    "Pars fracture",
    "Radiculopathy",
  ],
};
window.DIAGNOSIS_TERMS = Object.values(window.DIAGNOSIS_DICT).flat();

function DiagnosisAutocomplete({ value, onChange, multiline, placeholder, style, dict, ...rest }) {
  const terms = React.useMemo(() => dict || window.DIAGNOSIS_TERMS || [], [dict]);
  const ref = React.useRef(null);
  const mirrorRef = React.useRef(null);
  const [dismissedToken, setDismissedToken] = React.useState(null);
  const [caretAtEnd, setCaretAtEnd] = React.useState(true);

  const v = value || "";

  // Current token = text after the last separator (space / comma / newline / tab).
  // This resets the matcher for every new term the user types.
  let lastSep = -1;
  for (let i = v.length - 1; i >= 0; i--) {
    const ch = v.charCodeAt(i);
    // space=32, tab=9, LF=10, CR=13, comma=44
    if (ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === 44) { lastSep = i; break; }
  }
  const token = lastSep === -1 ? v : v.slice(lastSep + 1);

  let ghost = "";
  if (caretAtEnd && token.length > 0) {
    const q = token.toLowerCase();
    const m = terms.find(t => t.toLowerCase().startsWith(q) && t.length > token.length);
    if (m) ghost = m.slice(token.length);
  }
  if (dismissedToken !== null && dismissedToken === token) ghost = "";

  const checkCaret = () => {
    const el = ref.current;
    if (!el) return;
    const atEnd = el.selectionStart === el.selectionEnd && el.selectionEnd === (el.value || "").length;
    if (atEnd !== caretAtEnd) setCaretAtEnd(atEnd);
  };

  const accept = () => {
    if (!ghost) return false;
    const newVal = v + ghost;
    onChange({ target: { value: newVal } });
    // Keep caret at end after React commits; don't call focus() unless lost —
    // calling focus() on an already-focused element is a no-op but can scroll.
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      if (document.activeElement !== el) {
        try { el.focus({ preventScroll: true }); } catch (_) { el.focus(); }
      }
      try { el.setSelectionRange(newVal.length, newVal.length); } catch (_) {}
    });
    return true;
  };

  const handleKey = (e) => {
    // Ghost active → Tab/Enter accept and stay in field.
    if (ghost && (e.key === "Tab" || e.key === "Enter")) {
      e.preventDefault();
      e.stopPropagation();
      accept();
      return;
    }
    if (ghost && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setDismissedToken(token);
      return;
    }
    // No ghost + single-line Enter → swallow to prevent accidental form submit.
    // (Multiline textarea Enter falls through to insert a newline naturally.)
    if (!ghost && e.key === "Enter" && !multiline) {
      e.preventDefault();
    }
    if (dismissedToken !== null) setDismissedToken(null);
    if (rest.onKeyDown) rest.onKeyDown(e);
  };

  const handleChange = (e) => {
    if (dismissedToken !== null) setDismissedToken(null);
    onChange(e);
    // After the input event, caret is at the end of the user's typing.
    setTimeout(checkCaret, 0);
  };

  const handleScroll = () => {
    const el = ref.current, m = mirrorRef.current;
    if (el && m) {
      m.scrollTop = el.scrollTop;
      m.scrollLeft = el.scrollLeft;
    }
  };

  const base = {
    boxSizing: "border-box",
    width: "100%",
    padding: 10,
    border: "1px solid var(--ink-200)",
    borderRadius: 10,
    background: "#fff",
    fontFamily: "inherit",
    fontSize: 13,
    lineHeight: 1.5,
    direction: "ltr",
    textAlign: "left",
    whiteSpace: multiline ? "pre-wrap" : "pre",
    wordBreak: "break-word",
    overflowWrap: "break-word",
    margin: 0,
  };

  const inputStyle = {
    ...base,
    position: "relative",
    color: "var(--ink-900, #111)",
    background: "transparent",
    outline: "none",
    resize: multiline ? "vertical" : "none",
    minHeight: multiline ? ((style && style.minHeight) || 70) : undefined,
    overflow: multiline ? "auto" : "hidden",
    ...(style || {}),
  };

  const mirrorStyle = {
    ...base,
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    pointerEvents: "none",
    color: "transparent",
    userSelect: "none",
    background: "#fff",
    borderColor: "transparent",
    overflow: "hidden",
    minHeight: multiline ? ((style && style.minHeight) || 70) : undefined,
    ...(style || {}),
    borderColor: "transparent",
  };

  const InputTag = multiline ? "textarea" : "input";
  const { onKeyDown: _ignored, ...passRest } = rest;

  return (
    <div style={{ position: "relative", width: "100%" }}>
      <div ref={mirrorRef} aria-hidden="true" style={mirrorStyle}>
        <span>{v}</span>
        {ghost ? <span style={{ color: "#9CA3AF" }}>{ghost}</span> : null}
        {multiline ? "\u200B" : null}
      </div>
      <InputTag
        ref={ref}
        value={v}
        onChange={handleChange}
        onKeyDown={handleKey}
        onKeyUp={checkCaret}
        onSelect={checkCaret}
        onClick={checkCaret}
        onFocus={checkCaret}
        onScroll={handleScroll}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        style={inputStyle}
        {...passRest}
      />
    </div>
  );
}
window.DiagnosisAutocomplete = DiagnosisAutocomplete;

// ── Stat card ──────────────────────────────────────────────────
function StatCard({ label, value, delta, deltaKind, icon, accent="#7BBDE8", spark }) {
  const up = deltaKind === "up";
  return (
    <div className="card" style={{padding:18,display:"flex",flexDirection:"column",gap:12}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <span style={{fontSize:12,color:"var(--ink-500)",fontWeight:500}}>{label}</span>
        <div style={{width:28,height:28,borderRadius:8,background:`${accent}22`,color:accent,display:"flex",alignItems:"center",justifyContent:"center"}}>
          {icon}
        </div>
      </div>
      <div style={{display:"flex",alignItems:"baseline",gap:10}}>
        <span style={{fontSize:26,fontWeight:600,letterSpacing:"-.01em"}} className="mono tnum">{value}</span>
        {delta && (
          <span style={{
            fontSize:11.5,color: up?"var(--green)":"var(--red)",display:"inline-flex",alignItems:"center",gap:3,
            background:up?"var(--green-bg)":"var(--red-bg)",padding:"2px 7px",borderRadius:999
          }}>
            {up? <I.ArrowUp size={11}/> : <I.ArrowDown size={11}/>}
            {delta}
          </span>
        )}
      </div>
      {spark && <Sparkline data={spark} color={accent} width={200} height={28}/>}
    </div>
  );
}

window.Sidebar = Sidebar;
window.TopBar = TopBar;
window.EmptyState = EmptyState;
window.SkeletonRow = SkeletonRow;
window.Modal = Modal;
window.Toast = Toast;
window.Page = Page;
window.StatCard = StatCard;


// ===== src/auth.jsx =====
// Login screen — original aesthetic مع brand blues

// Demo mode: only when the URL says so (?demo=1) OR Supabase isn't wired.
// In production with SB, mock login must NEVER grant an admin JWT-equivalent.
function isDemoMode() {
  try {
    const p = new URLSearchParams(window.location.search);
    if (p.get("demo") === "1") return true;
  } catch {}
  return !window.SB;
}

function AuthScreen({ onLogin, onBookAsGuest, notice: noticeProp }) {
  // ── State ──────────────────────────────────────────────────
  const [mode, setMode] = React.useState("login"); // login | forgot
  // Live clinic branding so the login page picks up name/subtitle/logo
  // changes without a code deploy. Re-renders on kinetic:clinic-updated.
  const [clinic, setClinic] = React.useState(window.CLINIC || {});
  React.useEffect(() => {
    const on = () => setClinic(window.CLINIC || {});
    window.addEventListener("kinetic:clinic-updated", on);
    return () => window.removeEventListener("kinetic:clinic-updated", on);
  }, []);
  // Prefill a sample account only in demo; production starts blank so no
  // specific account is hardcoded in the UI.
  const [email, setEmail] = React.useState(isDemoMode() ? "amir@kinetic.eg" : "");
  // Empty by default. The placeholder bullets used to seed this field
  // caused a real password containing "•" to bypass Supabase Auth.
  const [pw, setPw] = React.useState("");
  const [role, setRole] = React.useState("مدير");
  const [busy, setBusy] = React.useState(false);
  const [showPw, setShowPw] = React.useState(false);
  const [shake, setShake] = React.useState(false);
  const [remember, setRemember] = React.useState(true);
  // The field a local check refused: red border + aria-invalid, described
  // by the message above the form (docs/04 Forms).
  const [badField, setBadField] = React.useState("");
  // Inline message above the form: a refused login, a message from the
  // app (e.g. signed out because the membership was disabled), or the
  // one-shot flash after a password reset.
  const [notice, setNotice] = React.useState(() =>
    noticeProp || (window.tenantTakeFlash ? window.tenantTakeFlash() : null));
  React.useEffect(() => { if (noticeProp) setNotice(noticeProp); }, [noticeProp]);

  // ── Handlers ───────────────────────────────────────────────
  function refuse(text) {
    setShake(true); setTimeout(()=>setShake(false), 400);
    setNotice({ kind: "error", text });
  }

  async function submit(e) {
    e && e.preventDefault();
    if (!isDemoMode() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setBadField("email");
      refuse("أدخل بريدًا إلكترونيًا صحيحًا");
      return;
    }
    if (!pw) {
      setBadField("pw");
      refuse("أدخل كلمة المرور");
      return;
    }
    setBadField("");
    setBusy(true);
    setNotice(null);
    // Real sign-in whenever the API client is there. Mock login is gated
    // to explicit demo mode so a real deployment can't accidentally hand
    // out the requested role without a credential check.
    if (window.SB && window.signInEmail && !isDemoMode()) {
      try {
        const res = await window.signInEmail(email.trim(), pw, { remember });
        if (!res.ok) {
          setBusy(false);
          refuse(res.error || "البريد الإلكتروني أو كلمة المرور غير صحيحة");
          return;
        }
        // The account is valid; may it enter THIS clinic? (src/tenant.jsx)
        // A non-member or a deactivated member is signed out again.
        const verdict = window.tenantLoginVerdict
          ? window.tenantLoginVerdict(res)
          : { ok: false, error: "تعذّر التحقق من العضوية" };
        if (!verdict.ok) {
          try { await window.signOut(); } catch {}
          setBusy(false);
          setPw("");
          refuse(verdict.error);
          return;
        }
        setBusy(false);
        onLogin && onLogin(verdict.user, res);
        return;
      } catch (err) {
        setBusy(false);
        refuse(window.friendlyAuthError ? window.friendlyAuthError("network_error") : "تعذّر تسجيل الدخول");
        return;
      }
    }
    // Mock path (demo mode) — role selector picks the identity.
    setTimeout(()=>{
      setBusy(false);
      const prof = (window.ROLE_PROFILES||{})[role] || { name:"أمير", email:"amir@kinetic.eg", match:null };
      onLogin && onLogin({
        name: prof.name,
        role,
        email: prof.email,
        match: prof.match || null,
        title: prof.title,
        color: prof.color,
        scope: window.roleScope ? window.roleScope(role) : "all",
      });
    }, 700);
  }

  function handleRolePick(r) {
    setRole(r);
    const pr = (window.ROLE_PROFILES||{})[r];
    if (pr) setEmail(pr.email);
  }

  const roles = ["مدير","موظف استقبال","طبيب","الأخصائي"];

  return (
    <div className="auth-grid">
      {/* Left — brand panel (on phones only the clinic's name: index.html) */}
      <div className="auth-brand" style={{
        background:"linear-gradient(155deg, #7BBDE8 0%, #BDD8E9 60%, #E8F1F7 100%)",
        position:"relative",padding:"clamp(24px, 4vw, 40px) clamp(20px, 5vw, 48px)",overflow:"hidden",
        display:"flex",flexDirection:"column",justifyContent:"space-between",gap:28,
        color:"#fff"
      }}>
        {/* decorative blobs */}
        <svg aria-hidden="true" style={{position:"absolute",inset:0,width:"100%",height:"100%",opacity:.45}} viewBox="0 0 600 800" preserveAspectRatio="none">
          <defs>
            <radialGradient id="g1" cx=".25" cy=".2">
              <stop offset="0%" stopColor="#fff" stopOpacity=".7"/>
              <stop offset="100%" stopColor="#fff" stopOpacity="0"/>
            </radialGradient>
          </defs>
          <circle cx="120" cy="160" r="280" fill="url(#g1)"/>
          <path d="M0 600 Q 200 540 400 620 T 800 580 L 800 800 L 0 800 Z" fill="rgba(255,255,255,.35)"/>
        </svg>

        <div style={{position:"relative",display:"flex",alignItems:"center",gap:12}}>
          {clinic.logo
            ? <img src={clinic.logo} alt="" style={{width:36,height:36,borderRadius:10,objectFit:"cover",background:"rgba(255,255,255,.6)"}}/>
            : <I.Logo size={36}/>}
          <div>
            <div style={{fontWeight:600,fontSize:20,color:"#0F1E2B"}}>{clinic.name || ""}</div>
            <div style={{fontSize:11,letterSpacing:".08em",color:"#1E4A6E",textTransform:"uppercase"}}>{clinic.subtitle || ""}</div>
          </div>
        </div>

        <div className="auth-brand-extra" style={{position:"relative",maxWidth:440}}>
          <div className="serif" style={{fontSize:"clamp(30px, 5vw, 46px)",lineHeight:1.05,color:"#0F1E2B",letterSpacing:"-.01em",marginBottom:18}}>
            العيادة التي <em>تتحرك</em> مع مرضاك.
          </div>
          <p style={{fontSize:14.5,color:"#1E4A6E",lineHeight:1.55,opacity:.9}}>
            {isDemoMode()
              ? "جدول الجلسات، اكتب ملاحظات التقدّم، أدر الباقات وحملات الواتساب — كل هذا من مساحة عمل واحدة هادئة مصممة للعلاج الطبيعي."
              : "المواعيد، والمرضى، والفواتير، والفروع — كل هذا من مساحة عمل واحدة هادئة لعيادتك."}
          </p>

          {/* stat tiles — demo shows sample figures; production shows the
              clinic's real counts (blank-safe on a fresh database). */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(3, 1fr)",gap:10,marginTop:28}}>
            {(isDemoMode() ? [
              {k:"المرضى",v:"248"},
              {k:"جلسات/شهر",v:"1,420"},
              {k:"معدّل الالتزام",v:"97%"},
            ] : [
              {k:"جدولة الجلسات",v:"✓"},
              {k:"الفواتير والباقات",v:"✓"},
              {k:"حملات واتساب",v:"✓"},
            ]).map((s,i)=>(
              <div key={i} style={{background:"rgba(255,255,255,.55)",backdropFilter:"blur(8px)",border:"1px solid rgba(255,255,255,.6)",padding:"12px 14px",borderRadius:14}}>
                <div style={{fontSize:11,color:"#1E4A6E"}}>{s.k}</div>
                <div className="mono" style={{fontSize:22,fontWeight:600,color:"#0F1E2B",marginTop:2}}>{s.v}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="auth-brand-extra" style={{position:"relative",fontSize:12,color:"#1E4A6E"}}>
          © {new Date().getFullYear()} {clinic.name || ""} {clinic.subtitle || ""}
        </div>
      </div>

      {/* Right — form */}
      <main style={{display:"flex",alignItems:"center",justifyContent:"center",padding:"clamp(20px, 5vw, 40px)"}}>
        <div style={{width:"100%",maxWidth:420, animation: shake?"shake .35s":""}}>
          {mode==="login" && (
            <>
              <h1 className="h1" style={{fontSize:30,marginBottom:6}}>أهلاً بعودتك</h1>
              <div className="muted" style={{fontSize:14,marginBottom:28}}>
                سجّل الدخول للمتابعة إلى مساحة {clinic.name ? <strong style={{color:"var(--ink-700)"}}>{clinic.name}</strong> : "عيادتك"}.
              </div>
              <div id="login-notice">{window.TenantNotice && <window.TenantNotice notice={notice}/>}</div>

              {/* الدور picker — demo only; production resolves the role from
                  the Supabase account, so picking one here would mislead. */}
              {isDemoMode() && <>
              <div className="label">سجّل الدخول بصفة</div>
              <div className="rgrid half-sm" style={{"--gtc":"repeat(4,1fr)",gap:6,marginBottom:18}}>
                {roles.map(r=>(
                  <button key={r} type="button"
                    onClick={()=>handleRolePick(r)}
                    style={{
                      padding:"8px 4px",border:`1px solid ${role===r?"var(--blue-500)":"var(--ink-200)"}`,
                      background: role===r?"var(--blue-100)":"#fff",
                      color: role===r?"var(--blue-900)":"var(--ink-700)",
                      borderRadius:10,fontSize:11.5,fontWeight:500,cursor:"pointer",
                      transition:"all .12s"
                    }}>{r}</button>
                ))}
              </div>
              </>}

              <form onSubmit={submit} noValidate>
                <label className="label" htmlFor="login-email" style={{display:"block"}}>البريد الإلكتروني</label>
                <input id="login-email" className="input" type="email" dir="ltr" autoComplete="username" value={email} onChange={e=>{ setEmail(e.target.value); if (badField === "email") setBadField(""); }} placeholder="you@clinic.com"
                  aria-invalid={badField === "email" ? "true" : undefined} aria-describedby={badField === "email" ? "login-notice" : undefined}
                  style={{marginBottom:14,height:42,borderColor:badField === "email" ? "var(--red)" : undefined}}/>

                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <label className="label" htmlFor="login-password">كلمة المرور</label>
                  <button type="button" className="auth-link" onClick={()=>{ setNotice(null); setMode("forgot"); }} style={{background:"none",border:"none",color:"var(--blue-700)",fontSize:12,cursor:"pointer",padding:0}}>نسيت؟</button>
                </div>
                <div style={{position:"relative"}}>
                  <input id="login-password" className="input" type={showPw?"text":"password"} autoComplete="current-password" value={pw} onChange={e=>{ setPw(e.target.value); if (badField === "pw") setBadField(""); }}
                    aria-invalid={badField === "pw" ? "true" : undefined} aria-describedby={badField === "pw" ? "login-notice" : undefined}
                    style={{height:42,paddingRight:42,borderColor:badField === "pw" ? "var(--red)" : undefined}}/>
                  <button type="button" aria-label={showPw ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"} aria-pressed={showPw ? "true" : "false"} onClick={()=>setShowPw(!showPw)} style={{position:"absolute",right:1,top:1,width:40,height:40,display:"flex",alignItems:"center",justifyContent:"center",padding:0,border:"none",borderRadius:9,background:"transparent",cursor:"pointer",color:"var(--ink-500)"}}>
                    <I.Eye size={15}/>
                  </button>
                </div>

                <label style={{display:"flex",alignItems:"center",gap:8,fontSize:12.5,color:"var(--ink-700)",marginTop:14}}>
                  <input type="checkbox" checked={remember} onChange={e=>setRemember(e.target.checked)}/> أبقني مسجلاً لمدة 30 يومًا
                </label>

                <button type="submit" disabled={busy} aria-busy={busy ? "true" : undefined} className="btn btn-blue" style={{width:"100%",height:44,justifyContent:"center",marginTop:18,fontSize:14}}>
                  {busy ? <span className="spin" style={{width:14,height:14,border:"2px solid #fff",borderTopColor:"transparent",borderRadius:"50%"}}/> : "تسجيل الدخول"}
                  {!busy && <I.ArrowRight size={15}/>}
                </button>
              </form>

              {/* <div style={{display:"flex",alignItems:"center",gap:12,margin:"20px 0",color:"var(--ink-400)",fontSize:12}}>
                <hr className="sep" style={{flex:1}}/> أو <hr className="sep" style={{flex:1}}/>
              </div> */}

              {/* <button className="btn btn-secondary" style={{width:"100%",height:42,justifyContent:"center"}}>
                <svg width="15" height="15" viewBox="0 0 24 24"><path fill="#4285F4" d="M22 12c0-.7-.1-1.4-.2-2H12v3.8h5.6c-.2 1.3-.9 2.4-2 3.1v2.5h3.2c1.9-1.7 3-4.3 3-7.4z"/><path fill="#34A853" d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6C4.8 19.9 8.1 22 12 22z"/><path fill="#FBBC05" d="M6.4 14c-.2-.6-.3-1.3-.3-2s.1-1.4.3-2V7.4H3.1C2.4 8.8 2 10.4 2 12s.4 3.2 1.1 4.6L6.4 14z"/><path fill="#EA4335" d="M12 5.9c1.5 0 2.8.5 3.8 1.5l2.9-2.9C16.9 2.9 14.7 2 12 2 8.1 2 4.8 4.1 3.1 7.4L6.4 10c.8-2.3 3-4.1 5.6-4.1z"/></svg>
                المتابعة عبر Google
              </button> */}

              {/* المريض — no account needed. Demo only: with the API a
                  booking needs a signed-in member, so a guest booking could
                  only pretend to succeed. */}
              {isDemoMode() && <button type="button" onClick={onBookAsGuest} style={{
                marginTop:22, width:"100%", padding:"14px 16px",
                background:"linear-gradient(135deg, var(--blue-50), #fff)",
                border:"1px solid var(--blue-100)", borderRadius:12, cursor:"pointer",
                display:"flex", alignItems:"center", gap:12, fontFamily:"inherit",
                textAlign:"left", transition:"all .15s"
              }}
                onMouseEnter={e=>{e.currentTarget.style.borderColor="var(--blue-500)";e.currentTarget.style.boxShadow="0 6px 20px rgba(123,189,232,.18)";}}
                onMouseLeave={e=>{e.currentTarget.style.borderColor="var(--blue-100)";e.currentTarget.style.boxShadow="";}}
              >
                <div style={{width:38,height:38,borderRadius:11,background:"var(--blue-500)",color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                  <I.Calendar size={17}/>
                </div>
                <div style={{flex:1}}>
                  <div style={{fontWeight:600,fontSize:13.5,color:"var(--ink-900)"}}>هل أنت مريض؟ احجز زيارة ←</div>
                  <div className="muted" style={{fontSize:11.5,marginTop:2}}>لا حاجة لحساب · 30 ثانية</div>
                </div>
              </button>}

              <div className="muted" style={{textAlign:"center",fontSize:11.5,marginTop:18}}>
                {isDemoMode()
                  ? <>تحتاج حساب عيادة؟ <a href="#" style={{color:"var(--blue-700)",fontWeight:500}}>تواصل مع المبيعات</a></>
                  : "ليس لديك حساب؟ يُنشأ الحساب بدعوة من مدير العيادة."}
              </div>
            </>
          )}

          {mode==="forgot" && window.TenantForgotForm && (
            <window.TenantForgotForm initialEmail={email} onBack={()=>setMode("login")}/>
          )}
        </div>
      </main>
    </div>
  );
}

window.AuthScreen = AuthScreen;


// ═══════════════════════════════════════════════════════════════
// Global CommandPalette (⌘K) — PRD 5.10 Search
// Indexes patients, appointments (bookings), invoices from window.DATA
// Renders a modal overlay with keyboard navigation.
// ═══════════════════════════════════════════════════════════════
function CommandPalette({ open, onClose, onNav }) {
  const [q, setQ] = React.useState("");
  const [i, setI] = React.useState(0);
  const boxRef = React.useRef(null);
  const listRef = React.useRef(null);
  // A dialog like Modal (focus in, Tab kept inside, Esc closes, focus back
  // to the search button); the field is its [data-autofocus] element.
  const titleId = useDialogFocus(boxRef, !!open, onClose);

  React.useEffect(() => {
    if (open) { setQ(""); setI(0); }
  }, [open]);

  if (!open) return null;

  // Build index from live DATA every open. Apply role scope so a therapist
  // can't fuzzy-search other therapists' patients, receptionist can't see
  // finance-only invoices, etc. Falls back to unscoped when helpers aren't
  // loaded (early boot).
  const data = window.DATA || {};
  const norm = (s) => (s || "").toString().toLowerCase();
  const query = norm(q).trim();

  const patients = window.scopePatients ? window.scopePatients(data.patients || []) : (data.patients || []);
  const appts    = window.scopeAppts    ? window.scopeAppts(data.appts || [])       : (data.appts || []);
  const scopedPatientIds = new Set(patients.map(p => p.id || p.patient_id));
  const payments = (data.payments || []).filter(v => {
    // If we can identify the patient, gate; otherwise show (admin/reception).
    if (!v.pid && !v.patient_id) return true;
    return scopedPatientIds.has(v.pid || v.patient_id);
  });
  const allowedRoutes = (window.ROLE_ROUTES && window.ME && window.ROLE_ROUTES[window.ME.role]) || null;
  const canSeePayments = (!allowedRoutes || allowedRoutes.includes("payments")) &&
    (!window.routeModuleEnabled || window.routeModuleEnabled("payments"));

  const items = [];
  patients.forEach(p => items.push({
    kind: "patient", route: "patients", id: p.id,
    title: p.name, sub: [p.id, p.diag, p.phone].filter(Boolean).join(" · "),
    hay: `${p.name} ${p.id} ${p.phone || ""} ${p.diag || ""}`,
    icon: I.Users,
  }));
  appts.forEach(a => items.push({
    kind: "appointment", route: "appointments", id: a.id,
    title: `${a.patient} — ${a.time}`, sub: [a.id, a.dr || a.th, a.status].filter(Boolean).join(" · "),
    hay: `${a.id} ${a.patient} ${a.time} ${a.dr} ${a.th} ${a.status}`,
    icon: I.Calendar,
  }));
  if (canSeePayments) payments.forEach(v => items.push({
    kind: "invoice", route: "payments", id: v.id,
    title: `${v.id} — ${v.patient}`, sub: [`EGP ${Number(v.amount || 0).toLocaleString("en-US")}`, v.method, v.status].filter(Boolean).join(" · "),
    hay: `${v.id} ${v.patient} ${v.method} ${v.status}`,
    icon: I.CreditCard,
  }));
  // Quick-nav actions
  const NAV = [
    { title: "لوحة التحكم",   route: "dashboard",    icon: I.Dashboard },
    { title: "المرضى",         route: "patients",     icon: I.Users },
    { title: "المواعيد",       route: "appointments", icon: I.Calendar },
    { title: "جلسات العلاج",   route: "sessions",     icon: I.Activity },
    { title: "المدفوعات",      route: "payments",     icon: I.CreditCard },
    { title: "الباقات",        route: "packages",     icon: I.Package },
    { title: "التقارير",       route: "reports",      icon: I.Chart },
    { title: "الفروع",         route: "branches",     icon: I.MapPin },
    { title: "الإعدادات",      route: "settings",     icon: I.Settings },
  ];
  // Same rules as the sidebar: role routes and the clinic's enabled modules.
  const navAllowed = (route) =>
    (!allowedRoutes || allowedRoutes.includes(route)) &&
    (!window.routeModuleEnabled || window.routeModuleEnabled(route));
  const NAV_OK = NAV.filter(n => navAllowed(n.route));
  NAV_OK.forEach(n => items.push({
    kind: "page", route: n.route, id: n.route,
    title: n.title, sub: "الانتقال إلى الصفحة",
    hay: `${n.title} ${n.route}`, icon: n.icon,
  }));

  const results = query
    ? items.filter(it => norm(it.hay).includes(query)).slice(0, 30)
    : NAV_OK.map(n => ({ kind: "page", route: n.route, id: n.route, title: n.title, sub: "الانتقال", icon: n.icon }));

  const sel = results[Math.min(i, results.length - 1)];

  function pick(r) {
    if (!r) return;
    onClose && onClose();
    onNav && onNav(r.route, r);
  }

  // Arrows move the active option (aria-activedescendant), Enter opens it;
  // Esc is the dialog's (useDialogFocus).
  function onKey(e) {
    if (e.key === "ArrowDown") { e.preventDefault(); setI(x => Math.min(x + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setI(x => Math.max(x - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); pick(sel); }
  }
  const activeIdx = Math.min(i, results.length - 1);
  const optionId = (k) => titleId + "-opt-" + k;
  const KIND_AR = { patient: "مريض", appointment: "موعد", invoice: "فاتورة", page: "صفحة" };

  return (
    <div className="modal-backdrop" style={{ alignItems: "flex-start", paddingTop: "min(90px, 10vh)" }} onClick={onClose}>
      <DialogFocusGuard boxRef={boxRef} at="start"/>
      <div ref={boxRef} className="modal cmdk" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        style={{ maxWidth: 640, width: "calc(100% - 40px)", padding: 0, overflow: "hidden", outline: "none" }} onClick={e => e.stopPropagation()}>
        <h2 id={titleId} className="sr-only">البحث الشامل</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 18px", borderBottom: "1px solid var(--ink-100)" }}>
          <I.Search size={16} aria-hidden="true" style={{ color: "var(--ink-500)" }} />
          <input data-autofocus="" value={q} onChange={e => { setQ(e.target.value); setI(0); }} onKeyDown={onKey}
            role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls={titleId + "-list"}
            aria-activedescendant={results.length ? optionId(activeIdx) : undefined}
            aria-label="ابحث عن مريض أو موعد أو فاتورة أو صفحة"
            placeholder="ابحث عن مريض · موعد · فاتورة · صفحة…"
            style={{ flex: 1, minHeight: 32, border: "none", outline: "none", fontSize: 15, background: "transparent", fontFamily: "inherit" }} />
          <kbd className="mono" aria-hidden="true" style={{ fontSize: 10, color: "var(--ink-500)", border: "1px solid var(--ink-200)", padding: "2px 6px", borderRadius: 5 }}>Esc</kbd>
        </div>
        <div ref={listRef} id={titleId + "-list"} role="listbox" aria-label="النتائج" tabIndex={-1}
          style={{ maxHeight: 420, overflowY: "auto", padding: "6px 0", outline: "none" }}>
          {results.length === 0 && (
            <div role="presentation" style={{ padding: "24px 20px", color: "var(--ink-500)", fontSize: 13, textAlign: "center" }}>
              لا توجد نتائج مطابقة
            </div>
          )}
          {results.map((r, k) => {
            const Ico = r.icon || I.Search;
            const active = k === activeIdx;
            return (
              <div key={r.kind + ":" + r.id + ":" + k} id={optionId(k)} role="option" aria-selected={active ? "true" : "false"}
                ref={active ? (el) => { if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" }); } : undefined}
                onMouseEnter={() => setI(k)}
                onClick={() => pick(r)}
                style={{
                  display: "flex", alignItems: "center", gap: 12,
                  padding: "10px 18px", cursor: "pointer", minHeight: 44,
                  background: active ? "var(--blue-50)" : "transparent",
                  borderInlineStart: active ? "3px solid var(--blue-700)" : "3px solid transparent",
                }}>
                <div style={{ width: 30, height: 30, borderRadius: 8, background: "var(--ink-100)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink-700)", flexShrink: 0 }}>
                  <Ico size={15} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 500, color: "var(--ink-900)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}</div>
                  <div style={{ fontSize: 11.5, color: "var(--ink-500)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.sub}</div>
                </div>
                <span style={{ fontSize: 11, color: "var(--ink-500)" }}>{KIND_AR[r.kind] || ""}</span>
              </div>
            );
          })}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 18px", borderTop: "1px solid var(--ink-100)", fontSize: 11, color: "var(--ink-500)" }}>
          <span><span className="mono">↑ ↓</span> للتنقل · <span className="mono">Enter</span> للفتح</span>
          <span role="status">النتائج: <span className="mono">{results.length}</span></span>
        </div>
      </div>
      <DialogFocusGuard boxRef={boxRef} at="end"/>
    </div>
  );
}

window.CommandPalette = CommandPalette;
