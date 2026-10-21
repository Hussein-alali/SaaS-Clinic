

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

  const active = branches.find(b => b.id === activeId) || branches[0] || { name:"—", therapists:0, rooms:0 };
  const isAdmin = role === "مدير";
  const toArDigits = (n) => String(n).replace(/\d/g, d => "٠١٢٣٤٥٦٧٨٩"[+d]);

  return (
    <div ref={ref} style={{position:"relative",margin:"4px 14px 10px"}}>
      <button
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
          <div style={{fontSize:10.5,color:"var(--ink-500)"}}>{toArDigits(active.therapists||0)} أخصائيين · {toArDigits(active.rooms||0)} غرف</div>
        </div>
        <I.ChevronDown size={13} style={{color:"var(--ink-400)",transform:open?"rotate(180deg)":"none",transition:"transform .15s"}}/>
      </button>

      {open && (
        <div style={{
          position:"absolute", top:"calc(100% + 6px)", insetInlineStart:0, insetInlineEnd:0,
          background:"#fff", border:"1px solid var(--ink-200)", borderRadius:11,
          boxShadow:"var(--shadow-md)", zIndex:30, padding:6, maxHeight:280, overflowY:"auto"
        }}>
          {branches.map(b => (
            <div key={b.id}
              onClick={()=>{ if (window.setActiveBranch) window.setActiveBranch(b.id); setOpen(false); if (window.showToast) window.showToast(`تم التبديل إلى ${b.name}`, "success"); }}
              style={{
                display:"flex",alignItems:"center",gap:8,padding:"8px 10px",
                borderRadius:8, cursor:"pointer",
                background: b.id === activeId ? "var(--blue-50)" : "transparent"
              }}
              onMouseEnter={(e)=>{ if (b.id !== activeId) e.currentTarget.style.background = "var(--ink-50)"; }}
              onMouseLeave={(e)=>{ if (b.id !== activeId) e.currentTarget.style.background = "transparent"; }}
            >
              <I.MapPin size={12} style={{color:"var(--blue-700)"}}/>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:12.5,fontWeight:600,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{b.name}</div>
                <div style={{fontSize:10.5,color:"var(--ink-500)"}}>{toArDigits(b.therapists||0)} · {toArDigits(b.rooms||0)} غرف</div>
              </div>
              {b.id === activeId && <I.Check size={12} style={{color:"var(--blue-700)"}}/>}
              {isAdmin && (
                <button
                  title="تعديل الفرع"
                  onClick={(e)=>{ e.stopPropagation(); setOpen(false); setEditing(b); }}
                  style={{border:"none",background:"transparent",padding:4,borderRadius:6,cursor:"pointer",color:"var(--ink-500)"}}
                  onMouseEnter={(e)=>e.currentTarget.style.background="var(--ink-100)"}
                  onMouseLeave={(e)=>e.currentTarget.style.background="transparent"}
                >
                  <I.Edit size={12}/>
                </button>
              )}
              {isAdmin && branches.length > 1 && b.id !== activeId && (
                <button
                  title="حذف الفرع"
                  onClick={async (e)=>{
                    e.stopPropagation();
                    if (!window.confirm(`حذف ${b.name}؟`)) return;
                    if (window.removeBranch) await window.removeBranch(b.id);
                    if (window.showToast) window.showToast(`تم حذف ${b.name}`, "success");
                  }}
                  style={{border:"none",background:"transparent",padding:4,borderRadius:6,cursor:"pointer",color:"var(--red)"}}
                  onMouseEnter={(e)=>e.currentTarget.style.background="var(--red-50, #fee2e2)"}
                  onMouseLeave={(e)=>e.currentTarget.style.background="transparent"}
                >
                  <I.X size={12}/>
                </button>
              )}
            </div>
          ))}
          {isAdmin && (
            <>
              <div style={{height:1,background:"var(--ink-100)",margin:"6px 4px"}}/>
              <button
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
            </>
          )}
        </div>
      )}

      {adding && <AddBranchModal onClose={()=>setAdding(false)}/>}
      {editing && <AddBranchModal editing={editing} onClose={()=>setEditing(null)}/>}
    </div>
  );
}

function AddBranchModal({ onClose, editing }) {
  const isEdit = !!editing;
  const [form, setForm] = React.useState({
    name: editing?.name || "",
    therapists: editing?.therapists ?? "",
    rooms: editing?.rooms ?? "",
    address: editing?.address || "",
    phone: editing?.phone || "",
  });
  const [saving, setSaving] = React.useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  async function onSave() {
    const name = form.name.trim();
    if (!name) { if (window.showToast) window.showToast("اسم الفرع مطلوب", "error"); return; }
    setSaving(true);
    try {
      if (isEdit) {
        if (window.updateBranch) await window.updateBranch(editing.id, form);
        if (window.showToast) window.showToast(`تم تحديث ${name}`, "success");
      } else {
        const branch = window.addBranch ? await window.addBranch(form) : null;
        if (branch && window.setActiveBranch) window.setActiveBranch(branch.id);
        if (window.showToast) window.showToast(`تم إضافة ${name}`, "success");
      }
      onClose();
    } catch (e) {
      console.warn("branch save failed", e);
      if (window.showToast) window.showToast("تعذّر حفظ الفرع", "error");
    } finally { setSaving(false); }
  }

  return (
    <Modal title={isEdit ? `تعديل ${editing.name}` : "إضافة فرع جديد"} onClose={onClose} footer={<>
      <button className="btn btn-ghost" onClick={onClose}>إلغاء</button>
      <button className="btn btn-blue" disabled={saving} onClick={onSave}>
        {isEdit ? <I.Check size={13}/> : <I.Plus size={13}/>}
        {saving ? "جارٍ الحفظ…" : (isEdit ? "حفظ التغييرات" : "إضافة الفرع")}
      </button>
    </>}>
      <Field label="اسم الفرع" required>
        <input className="input" placeholder="فرع المعادي" value={form.name} onChange={e=>set("name", e.target.value)}/>
      </Field>
      <div style={{height:12}}/>
      <div className="rgrid half-sm" style={{"--gtc":"1fr 1fr",gap:12}}>
        <Field label="عدد الأخصائيين">
          <input className="input" type="number" min="0" placeholder="4" value={form.therapists} onChange={e=>set("therapists", e.target.value)}/>
        </Field>
        <Field label="عدد الغرف">
          <input className="input" type="number" min="0" placeholder="5" value={form.rooms} onChange={e=>set("rooms", e.target.value)}/>
        </Field>
      </div>
      <div style={{height:12}}/>
      <Field label="العنوان">
        <input className="input" placeholder="14 ش صلاح سالم، القاهرة" value={form.address} onChange={e=>set("address", e.target.value)}/>
      </Field>
      <div style={{height:12}}/>
      <Field label="الهاتف">
        <input className="input" placeholder="+20 2 xxxx xxxx" value={form.phone} onChange={e=>set("phone", e.target.value)}/>
      </Field>
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
      { id:"settings", label:"الإعدادات", icon: <I.Settings size={17}/> },
    ]},
  ];

  // ── Hide routes this role can't reach; drop empty sections ────
  // Custom sections (prefixed "custom:") are visible only to admin.
  const allowed = (window.ROLE_ROUTES && window.ROLE_ROUTES[role]) || null;
  const groups = allGroups
    .map(g => ({ ...g, items: g.items.filter(it => {
      if (it.custom) return role === "مدير";
      return !allowed || allowed.includes(it.id);
    }) }))
    .filter(g => g.items.length > 0);

  const u = user || { name:"أمير", email:"amir@kinetic.eg" };
  const uInit = window.initialsOf ? window.initialsOf(u.name) : "ش ع";

  return (
    <aside className={"sidebar" + (isOpen ? " open" : "")}>
      {/* Brand */}
      <div style={{padding:"18px 20px 14px",display:"flex",alignItems:"center",gap:10}}>
        {clinic.logo
          ? <img src={clinic.logo} alt="clinic logo" style={{width:30,height:30,borderRadius:9,objectFit:"cover",background:"var(--blue-50)"}}/>
          : <I.Logo size={30}/>}
        <div style={{display:"flex",flexDirection:"column",lineHeight:1.1}}>
          <span style={{fontWeight:600,fontSize:15,letterSpacing:"-.01em"}}>{clinic.name || "—"}</span>
          <span style={{fontSize:10.5,color:"var(--ink-500)",letterSpacing:".06em",textTransform:"uppercase"}}>{clinic.subtitle || ""}</span>
        </div>
      </div>

      {/* Clinic switcher */}
      <BranchSwitcher role={role}/>

      <nav style={{flex:1, overflowY:"auto", paddingBottom:14}}>
        {groups.map((g,gi)=>(
          <div key={gi}>
            {g.title && <div className="nav-section">{g.title}</div>}
            {g.items.map(it => (
              <div key={it.id}
                className={"nav-item" + (active===it.id?" active":"")}
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
        <div className="av md" style={{background:u.color||"var(--blue-500)",color:"#fff"}}>{uInit}</div>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:12.5,fontWeight:600,lineHeight:1.2,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{u.name}</div>
          <div style={{fontSize:10.5,color:"var(--ink-500)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{role || "مدير"} · {u.email}</div>
        </div>
        <button className="btn btn-ghost btn-icon" title="تسجيل الخروج" onClick={()=>onNav("logout")}>
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
function Modal({ open, onClose, children, title, footer, width=560 }) {
  if (open === false) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{width,maxWidth:`calc(100% - 40px)`}} onClick={e=>e.stopPropagation()}>
        {title && (
          <div style={{padding:"18px 22px",borderBottom:"1px solid var(--ink-100)",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
            <div className="h3">{title}</div>
            <button className="btn btn-ghost btn-icon" onClick={onClose}><I.X size={16}/></button>
          </div>
        )}
        <div style={{padding:"20px 22px"}}>{children}</div>
        {footer && <div style={{padding:"14px 22px",borderTop:"1px solid var(--ink-100)",display:"flex",justifyContent:"flex-end",gap:10,background:"var(--ink-50)",borderBottomLeftRadius:18,borderBottomRightRadius:18}}>{footer}</div>}
      </div>
    </div>
  );
}

// ── Toast ──────────────────────────────────────────────────────
function Toast({ msg, kind="success" }) {
  if (!msg) return null;
  const color = kind==="success" ? "var(--green)" : kind==="error" ? "var(--red)" : "var(--blue-500)";
  return (
    <div style={{
      position:"fixed",bottom:24,right:24,zIndex:200,
      background:"#fff",border:"1px solid var(--ink-200)",borderRadius:12,
      boxShadow:"var(--shadow-lg)",padding:"12px 16px",
      display:"flex",alignItems:"center",gap:10, animation:"popin .2s"
    }}>
      <span style={{width:8,height:8,borderRadius:999,background:color}}></span>
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
function RowMenu({ items = [], size = 13, stopRowClick = true }) {
  const [open, setOpen] = React.useState(false);
  // Fixed positioning (computed from the trigger) lets the popover escape
  // horizontally-scrolling table wrappers on small screens.
  const [pos, setPos] = React.useState({ top: 0, left: 0 });
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    const onAway = () => setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onAway, true);
    window.addEventListener("resize", onAway);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onAway, true);
      window.removeEventListener("resize", onAway);
    };
  }, [open]);
  const MENU_W = 180;
  return (
    <div ref={ref} style={{position:"relative",display:"inline-block"}}>
      <button className="btn btn-ghost btn-icon" title="المزيد" onClick={(e)=>{
        if (stopRowClick) e.stopPropagation();
        if (!open) {
          const r = e.currentTarget.getBoundingClientRect();
          const left = Math.max(8, Math.min(r.right - MENU_W, window.innerWidth - MENU_W - 8));
          const top = Math.min(r.bottom + 4, window.innerHeight - 60);
          setPos({ top, left });
        }
        setOpen(o=>!o);
      }}>
        <I.More size={size}/>
      </button>
      {open && (
        <div className="row-menu-pop" style={{position:"fixed",top:pos.top,left:pos.left,minWidth:MENU_W,background:"#fff",border:"1px solid var(--ink-200)",borderRadius:10,boxShadow:"var(--shadow-md)",zIndex:120,padding:6}}>
          {items.map((it, i) => (
            <button key={i} onClick={(e)=>{ e.stopPropagation(); setOpen(false); if (it.onClick) it.onClick(); }}
              style={{display:"flex",alignItems:"center",gap:8,width:"100%",padding:"7px 10px",fontSize:13,textAlign:"start",background:"transparent",border:"none",borderRadius:6,cursor:"pointer",color:it.danger?"var(--red)":"var(--ink-700)",fontFamily:"inherit"}}
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
                {query && emptyHint && <div style={{fontSize:11.5, color:"var(--ink-400)"}}>{emptyHint}</div>}
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

function AuthScreen({ onLogin, onBookAsGuest }) {
  // ── State ──────────────────────────────────────────────────
  const [mode, setMode] = React.useState("login"); // login | forgot | reset
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

  // ── Handlers ───────────────────────────────────────────────
  const ROLE_TO_AR = {
    admin:"مدير", receptionist:"موظف استقبال", doctor:"طبيب", therapist:"الأخصائي", patient:"مريض",
  };

  async function submit(e) {
    e && e.preventDefault();
    if (!pw) {
      setShake(true); setTimeout(()=>setShake(false), 400);
      if (window.showToast) window.showToast("أدخل كلمة المرور", "error");
      return;
    }
    setBusy(true);
    // Prefer Supabase Auth whenever it's configured. Mock login is gated
    // to explicit demo mode so a real deployment can't accidentally hand
    // out the requested role without a credential check.
    if (window.SB && window.signInEmail && !isDemoMode()) {
      try {
        const res = await window.signInEmail(email, pw);
        setBusy(false);
        if (!res.ok) {
          setShake(true); setTimeout(()=>setShake(false), 400);
          if (window.showToast) window.showToast(res.error || "بيانات الدخول غير صحيحة", "error");
          return;
        }
        const dbRole = res.role || res.staff?.role;
        const arRole = ROLE_TO_AR[dbRole] || role;
        const prof = (window.ROLE_PROFILES||{})[arRole] || { name:res.staff?.name || res.user?.email || email, email };
        // Clinicians scope their caseload by their OWN name (from the staff
        // record), not a fixed profile — so real accounts see real patients.
        const isClinician = arRole === "طبيب" || arRole === "الأخصائي";
        onLogin && onLogin({
          name: res.staff?.name || prof.name,
          role: arRole,
          email: res.user?.email || email,
          match: isClinician ? (res.staff?.name || prof.match || null) : (prof.match || null),
          title: prof.title,
          color: prof.color,
          scope: window.roleScope ? window.roleScope(arRole) : "all",
        });
        return;
      } catch (err) {
        setBusy(false);
        setShake(true); setTimeout(()=>setShake(false), 400);
        if (window.showToast) window.showToast(err.message || "تعذّر تسجيل الدخول", "error");
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
      {/* Left — brand panel */}
      <div style={{
        background:"linear-gradient(155deg, #7BBDE8 0%, #BDD8E9 60%, #E8F1F7 100%)",
        position:"relative",padding:"clamp(24px, 4vw, 40px) clamp(20px, 5vw, 48px)",overflow:"hidden",
        display:"flex",flexDirection:"column",justifyContent:"space-between",gap:28,
        color:"#fff"
      }}>
        {/* decorative blobs */}
        <svg style={{position:"absolute",inset:0,width:"100%",height:"100%",opacity:.45}} viewBox="0 0 600 800" preserveAspectRatio="none">
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
            ? <img src={clinic.logo} alt="clinic logo" style={{width:36,height:36,borderRadius:10,objectFit:"cover",background:"rgba(255,255,255,.6)"}}/>
            : <I.Logo size={36}/>}
          <div>
            <div style={{fontWeight:600,fontSize:20,color:"#0F1E2B"}}>{clinic.name || ""}</div>
            <div style={{fontSize:11,letterSpacing:".08em",color:"#1E4A6E",textTransform:"uppercase"}}>{clinic.subtitle || ""}</div>
          </div>
        </div>

        <div style={{position:"relative",maxWidth:440}}>
          <div className="serif" style={{fontSize:"clamp(30px, 5vw, 46px)",lineHeight:1.05,color:"#0F1E2B",letterSpacing:"-.01em",marginBottom:18}}>
            العيادة التي <em>تتحرك</em> مع مرضاك.
          </div>
          <p style={{fontSize:14.5,color:"#1E4A6E",lineHeight:1.55,opacity:.9}}>
            جدول الجلسات، اكتب ملاحظات التقدّم، أدر الباقات وحملات الواتساب —
            كل هذا من مساحة عمل واحدة هادئة مصممة للعلاج الطبيعي.
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
                <div style={{fontSize:11,color:"#1E4A6E",letterSpacing:".04em",textTransform:"uppercase"}}>{s.k}</div>
                <div className="mono" style={{fontSize:22,fontWeight:600,color:"#0F1E2B",marginTop:2}}>{s.v}</div>
              </div>
            ))}
          </div>
        </div>

        <div style={{position:"relative",fontSize:12,color:"#1E4A6E",opacity:.8}}>
          © {new Date().getFullYear()} {clinic.name || ""} {clinic.subtitle || ""}
        </div>
      </div>

      {/* Right — form */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"center",padding:"clamp(20px, 5vw, 40px)"}}>
        <div style={{width:"100%",maxWidth:420, animation: shake?"shake .35s":""}}>
          {mode==="login" && (
            <>
              <div className="h1" style={{fontSize:30,marginBottom:6}}>أهلاً بعودتك</div>
              <div className="muted" style={{fontSize:14,marginBottom:28}}>
                سجّل الدخول للمتابعة إلى مساحة عيادتك.
              </div>

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

              <form onSubmit={submit}>
                <div className="label">البريد الإلكتروني</div>
                <input className="input" type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@clinic.com" style={{marginBottom:14,height:42}}/>

                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div className="label">كلمة المرور</div>
                  <button type="button" onClick={()=>setMode("forgot")} style={{background:"none",border:"none",color:"var(--blue-700)",fontSize:12,cursor:"pointer",padding:0}}>نسيت؟</button>
                </div>
                <div style={{position:"relative"}}>
                  <input className="input" type={showPw?"text":"password"} value={pw} onChange={e=>setPw(e.target.value)} style={{height:42,paddingRight:38}}/>
                  <button type="button" onClick={()=>setShowPw(!showPw)} style={{position:"absolute",right:6,top:5,padding:6,border:"none",background:"transparent",cursor:"pointer",color:"var(--ink-500)"}}>
                    <I.Eye size={15}/>
                  </button>
                </div>

                <label style={{display:"flex",alignItems:"center",gap:8,fontSize:12.5,color:"var(--ink-700)",marginTop:14}}>
                  <input type="checkbox" defaultChecked/> أبقني مسجلاً لمدة 30 يوم
                </label>

                <button type="submit" disabled={busy} className="btn btn-blue" style={{width:"100%",height:44,justifyContent:"center",marginTop:18,fontSize:14}}>
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

              {/* المريض — no account needed */}
              <button type="button" onClick={onBookAsGuest} style={{
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
              </button>

              <div className="muted" style={{textAlign:"center",fontSize:11.5,marginTop:18}}>
                تحتاج حساب عيادة؟ <a href="#" style={{color:"var(--blue-700)",fontWeight:500}}>تواصل مع المبيعات</a>
              </div>
            </>
          )}

          {mode==="forgot" && (
            <>
              <div className="h1" style={{fontSize:30,marginBottom:6}}>إعادة تعيين كلمة المرور</div>
              <div className="muted" style={{fontSize:14,marginBottom:28}}>
                سنرسل رابطًا لمرة واحدة إلى بريدك المسجّل.
              </div>
              <div className="label">البريد الإلكتروني</div>
              <input className="input" type="email" defaultValue={isDemoMode() ? "amir@kinetic.eg" : ""} placeholder="you@clinic.com" style={{height:42,marginBottom:18}}/>
              <button className="btn btn-blue" style={{width:"100%",height:44,justifyContent:"center"}} onClick={()=>setMode("login")}>
                إرسال رابط الإعادة <I.ArrowRight size={15}/>
              </button>
              <button onClick={()=>setMode("login")} style={{background:"none",border:"none",color:"var(--ink-500)",fontSize:12.5,marginTop:14,cursor:"pointer",display:"flex",alignItems:"center",gap:6}}>
                <I.ArrowLeft size={13}/> العودة لتسجيل الدخول
              </button>
            </>
          )}
        </div>
      </div>
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
  const inputRef = React.useRef(null);

  React.useEffect(() => {
    if (open) {
      setQ(""); setI(0);
      setTimeout(() => inputRef.current && inputRef.current.focus(), 30);
    }
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
  const canSeePayments = !allowedRoutes || allowedRoutes.includes("payments");

  const items = [];
  patients.forEach(p => items.push({
    kind: "patient", route: "patients", id: p.id,
    title: p.name, sub: `${p.id} · ${p.diag || ""} · ${p.phone || ""}`,
    hay: `${p.name} ${p.id} ${p.phone || ""} ${p.diag || ""}`,
    icon: I.Users,
  }));
  appts.forEach(a => items.push({
    kind: "appointment", route: "appointments", id: a.id,
    title: `${a.patient} — ${a.time}`, sub: `${a.id} · ${a.dr} · ${a.status}`,
    hay: `${a.id} ${a.patient} ${a.time} ${a.dr} ${a.th} ${a.status}`,
    icon: I.Calendar,
  }));
  if (canSeePayments) payments.forEach(v => items.push({
    kind: "invoice", route: "payments", id: v.id,
    title: `${v.id} — ${v.patient}`, sub: `${v.amount} ج.م · ${v.method} · ${v.status}`,
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
    { title: "الإعدادات",      route: "settings",     icon: I.Settings },
  ];
  NAV.forEach(n => items.push({
    kind: "page", route: n.route, id: n.route,
    title: n.title, sub: "الانتقال إلى الصفحة",
    hay: `${n.title} ${n.route}`, icon: n.icon,
  }));

  const results = query
    ? items.filter(it => norm(it.hay).includes(query)).slice(0, 30)
    : NAV.map(n => ({ kind: "page", route: n.route, id: n.route, title: n.title, sub: "الانتقال", icon: n.icon }));

  const sel = results[Math.min(i, results.length - 1)];

  function pick(r) {
    if (!r) return;
    onClose && onClose();
    onNav && onNav(r.route, r);
  }

  function onKey(e) {
    if (e.key === "ArrowDown") { e.preventDefault(); setI(x => Math.min(x + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setI(x => Math.max(x - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); pick(sel); }
    else if (e.key === "Escape") { e.preventDefault(); onClose && onClose(); }
  }

  return (
    <div className="modal-backdrop" style={{ alignItems: "flex-start", paddingTop: "min(90px, 10vh)" }} onClick={onClose}>
      <div className="modal" style={{ maxWidth: 640, width: "calc(100% - 40px)", padding: 0, overflow: "hidden" }} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 18px", borderBottom: "1px solid var(--ink-100)" }}>
          <I.Search size={16} style={{ color: "var(--ink-400)" }} />
          <input ref={inputRef} value={q} onChange={e => { setQ(e.target.value); setI(0); }} onKeyDown={onKey}
            placeholder="ابحث عن مريض · موعد · فاتورة · صفحة…"
            style={{ flex: 1, border: "none", outline: "none", fontSize: 15, background: "transparent", fontFamily: "inherit" }} />
          <span className="mono" style={{ fontSize: 10, color: "var(--ink-400)", border: "1px solid var(--ink-200)", padding: "2px 6px", borderRadius: 5 }}>Esc</span>
        </div>
        <div style={{ maxHeight: 420, overflowY: "auto", padding: "6px 0" }}>
          {results.length === 0 && (
            <div style={{ padding: "24px 20px", color: "var(--ink-500)", fontSize: 13, textAlign: "center" }}>
              لا توجد نتائج مطابقة
            </div>
          )}
          {results.map((r, k) => {
            const Ico = r.icon || I.Search;
            const active = k === Math.min(i, results.length - 1);
            return (
              <div key={r.kind + ":" + r.id + ":" + k}
                onMouseEnter={() => setI(k)}
                onClick={() => pick(r)}
                style={{
                  display: "flex", alignItems: "center", gap: 12,
                  padding: "10px 18px", cursor: "pointer",
                  background: active ? "var(--blue-50)" : "transparent",
                  borderLeft: active ? "3px solid var(--blue-500)" : "3px solid transparent",
                }}>
                <div style={{ width: 30, height: 30, borderRadius: 8, background: "var(--ink-100)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink-700)", flexShrink: 0 }}>
                  <Ico size={15} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 500, color: "var(--ink-900)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}</div>
                  <div style={{ fontSize: 11.5, color: "var(--ink-500)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.sub}</div>
                </div>
                <span className="mono" style={{ fontSize: 10, color: "var(--ink-400)", textTransform: "uppercase", letterSpacing: ".04em" }}>{r.kind}</span>
              </div>
            );
          })}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 18px", borderTop: "1px solid var(--ink-100)", fontSize: 11, color: "var(--ink-500)" }}>
          <span><span className="mono">↑ ↓</span> للتنقل · <span className="mono">Enter</span> للفتح</span>
          <span>{results.length} نتيجة</span>
        </div>
      </div>
    </div>
  );
}

window.CommandPalette = CommandPalette;
