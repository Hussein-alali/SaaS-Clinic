// ===== src/screens3.jsx =====
// Settings, staff and invitations (C06), branches (C07), the clinic shell
// (App / ClinicApp) and the demo patient portal. Split from screens2.jsx
// (task 3.28) so two people can work on them at once; a classic script
// like the others, loaded right after screens2.jsx (index.html order).

// ───────────────── Settings ─────────────────
function SettingsPage({ go }) {
  const role = (window.ME && window.ME.role) || "";
  const isAdmin = !role || role === "مدير";
  // A link may ask for a tab (the first-use checklist: «الأقسام والفريق»,
  // «المستخدمون والأدوار»); it is used once.
  const [tab, setTab] = React.useState(() => {
    const asked = window.__settingsTabRequest;
    window.__settingsTabRequest = null;
    return ["clinic", "branding", "depts", "users"].includes(asked) ? asked : "clinic";
  });

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

  // «المستخدمون والأدوار» is C06 (module core.staff, docs/03).
  const staffOn = !window.orgModuleOn || window.orgModuleOn("core.staff");
  const items = [
    { id:"clinic",    l:"بيانات العيادة",       ic:<I.MapPin size={14}/> },
    { id:"branding",  l:"الهوية البصرية",       ic:<I.Image size={14}/> },
    { id:"depts",     l:"الأقسام والفريق",       ic:<I.Stethoscope size={14}/> },
    ...(staffOn ? [{ id:"users", l:"المستخدمون والأدوار", ic:<I.Users size={14}/> }] : []),
  ];

  return (
    <Page>
      <div className="crumb"><span>الرئيسية</span><I.Chevron size={11}/><span>الإعدادات</span></div>
      <h1 className="h1" style={{marginBottom:18}}>الإعدادات</h1>

      <div className="rgrid c-lg" style={{"--gtc":"220px 1fr"}}>
        <div className="card side-tabs" role="tablist" aria-label="أقسام الإعدادات" style={{padding:8,height:"fit-content"}}>
          {items.map(s=>(
            <div key={s.id} data-settings-tab={s.id} role="tab" tabIndex={0} aria-selected={tab===s.id ? "true" : "false"}
              className={"nav-item" + (tab===s.id?" active":"")} style={{margin:0}} onClick={()=>setTab(s.id)}
              onKeyDown={(e)=>{ if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setTab(s.id); } }}>
              {s.ic}{s.l}
            </div>
          ))}
        </div>

        <div className="card card-pad">
          {tab==="clinic" && <ClinicDetailsPanel/>}
          {tab==="depts" && <DeptDoctorsPanel/>}
          {tab==="users" && staffOn && <UsersPanel/>}
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
const newId = (p) => newRecordId(p);

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
          <thead><tr><th>القسم</th><th>بالإنجليزية</th><th>الأطباء</th><th>الأخصائيون</th><th>الحالة</th><th><span className="sr-only">إجراءات</span></th></tr></thead>
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
          <thead><tr><th>الطبيب</th><th>القسم</th><th>التخصص</th><th>الهاتف</th><th>البريد</th><th>التوفر</th><th>الحالة</th><th><span className="sr-only">إجراءات</span></th></tr></thead>
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
          <thead><tr><th>الأخصائي</th><th>القسم</th><th>التخصص</th><th>الهاتف</th><th>البريد</th><th>رقم الترخيص</th><th>الحالة</th><th><span className="sr-only">إجراءات</span></th></tr></thead>
          <tbody>
            {specRoster.total===0 && <tr><td colSpan={8}><EmptyState icon={<I.Activity size={22}/>} title="لا أخصائيين" body={depts.length? "أضف أول أخصائي من زر «إضافة أخصائي».":"أضف قسمًا أولاً ثم أضف الأخصائيين."}/></td></tr>}
            {specRoster.view.map(s=>(
              <tr key={s.id}>
                <td><div style={{display:"flex",alignItems:"center",gap:8}}>
                  <span className="av sm" aria-hidden="true" style={{background:(s.color||"#7BBDE8")+"33",color:"var(--ink-900)"}}>{(s.name||"").split(" ").map(x=>x[0]||"").join("").slice(0,2)}</span>
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
          <thead><tr><th>الاسم</th><th>الهاتف</th><th>البريد</th><th>ملاحظات</th><th>الحالة</th><th><span className="sr-only">إجراءات</span></th></tr></thead>
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
        <button className={"btn " + (danger?"btn-secondary":"btn-blue")} style={danger?{color:"#A8443A",borderColor:"var(--red-bg)"}:undefined} disabled={busy} onClick={onConfirm}>
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

// ═══════════════════════════════════════════════════════════════
// Clinic admin: shared bits for C06 (staff) and C07 (branches)
// ═══════════════════════════════════════════════════════════════

// Plan usage from GET /api/org/usage (window.OrgAdmin, src/supabase.jsx):
// { plan, users:{active, pending_invitations, used, max}, branches:{active,
// inactive, total, max}, branch_staff:{<branch id>: n} } — null while
// loading or without a backend (demo mode).
function useOrgUsage() {
  const [usage, setUsage] = React.useState(null);
  const [failed, setFailed] = React.useState(false);
  const reload = React.useCallback(async () => {
    if (!window.OrgAdmin || !window.OrgAdmin.available()) return null;
    const r = await window.OrgAdmin.usage();
    if (r.ok) { setUsage(r.data); setFailed(false); return r.data; }
    setFailed(true);
    return null;
  }, []);
  React.useEffect(() => { reload(); }, [reload]);
  return { usage, failed, reload };
}

// ── First-use checklist «ابدأ الإعداد» (docs/03 «First-use journey», J2) ──
// On the clinic admin's dashboard (C01) of a new clinic. Each step is done
// when the clinic's own data says so — nothing is ticked by hand:
//   branch    an active branch has an address or a phone (C07)
//   settings  the clinic's phone, e-mail or address is filled in (C08)
//   team      a doctor or a specialist is on the roster (الأقسام والفريق)
//   invite    another member or a pending invitation (C06, core.staff)
//   booking   a patient and an appointment exist (C02/C03)
// «لاحقًا» folds it into one line for this browser tab; «إخفاء» removes it
// for this admin in this clinic. It disappears once every step is done.
// Not shown in demo mode, to other roles, or before the first data load.
const ONBOARDING_KEYS = { hidden: "clinicsys.onboarding_hidden", later: "clinicsys.onboarding_later" };
function onboardingScope() {
  const slug = window.TENANT_SLUG || "";
  const uid = (window.ME && window.ME.id) || "";
  return slug && uid ? `${slug}|${uid}` : "";
}
function onboardingFlag(kind, key) {
  try {
    const store = kind === "hidden" ? window.localStorage : window.sessionStorage;
    const map = JSON.parse(store.getItem(ONBOARDING_KEYS[kind]) || "{}") || {};
    return !!(key && map[key]);
  } catch (_) { return false; }
}
function setOnboardingFlag(kind, key, on) {
  if (!key) return;
  try {
    const store = kind === "hidden" ? window.localStorage : window.sessionStorage;
    const map = JSON.parse(store.getItem(ONBOARDING_KEYS[kind]) || "{}") || {};
    if (on) map[key] = true; else delete map[key];
    store.setItem(ONBOARDING_KEYS[kind], JSON.stringify(map));
  } catch (_) {}
}
function onboardingSteps(usage) {
  const D = window.DATA || {};
  const c = window.CLINIC || {};
  const branches = window.BRANCHES || [];
  const active = (b) => String((b && b.status) || "active") !== "inactive";
  const staffOn = !window.orgModuleOn || window.orgModuleOn("core.staff");
  const steps = [
    { id: "branch", title: "أكمل بيانات الفرع الأول", hint: "العنوان، والهاتف، وساعات العمل.",
      done: branches.some(b => active(b) && (String(b.address || "").trim() || String(b.phone || "").trim())),
      action: "فتح الفروع", route: "branches" },
    { id: "settings", title: "راجع إعدادات العيادة", hint: "اسم العرض، وبيانات التواصل، وساعات التقويم.",
      done: !!(String(c.phone || "").trim() || String(c.email || "").trim() || String(c.address || "").trim()),
      action: "فتح الإعدادات", route: "settings", tab: "clinic" },
    { id: "team", title: "أضف الأقسام والأطباء والأخصائيين", hint: "يظهرون في الحجز والتقويم.",
      done: ((D.doctors || []).length + (D.therapists || []).length) > 0,
      action: "فتح الأقسام والفريق", route: "settings", tab: "depts" },
  ];
  if (staffOn) {
    steps.push({ id: "invite", title: "ادعُ فريقك وحدد فروعهم", hint: "استقبال، وأطباء، وأخصائيون — كلٌّ بدوره.",
      done: !!(usage && usage.users && Number(usage.users.used) > 1),
      action: "دعوة الموظفين", route: "settings", tab: "users", needsUsage: true });
  }
  steps.push({ id: "booking", title: "أضف أول مريض واحجز أول موعد", hint: "من صفحة المواعيد: «حجز جديد».",
    done: (D.patients || []).length > 0 && (D.appts || []).length > 0,
    action: "فتح المواعيد", route: "appointments" });
  return steps;
}

function OnboardingChecklist({ go }) {
  window.useDataVersion && window.useDataVersion();
  const key = onboardingScope();
  const [hiddenNow, setHiddenNow] = React.useState(false);
  const hidden = hiddenNow || onboardingFlag("hidden", key);
  const isAdmin = window.ME && window.ME.role === "مدير";
  // Nothing to show (and no /api/org/usage request): demo mode, other
  // roles, hidden or finished before, or the clinic's settings and tables
  // not read yet (the steps would look undone for a moment).
  if (!window.SB || !isAdmin || !key || hidden || !window.DATA_LOADED || !window.CLINIC_LOADED) return null;
  return <OnboardingChecklistBody go={go} scopeKey={key} onHide={() => { setOnboardingFlag("hidden", key, true); setHiddenNow(true); }}/>;
}

function OnboardingChecklistBody({ go, scopeKey, onHide }) {
  const [, bump] = React.useState(0);
  React.useEffect(() => {
    const on = () => bump(n => n + 1);
    window.addEventListener("kinetic:branches-updated", on);
    return () => window.removeEventListener("kinetic:branches-updated", on);
  }, []);
  const { usage, failed } = useOrgUsage();
  const [later, setLater] = React.useState(() => onboardingFlag("later", scopeKey));
  const staffOn = !window.orgModuleOn || window.orgModuleOn("core.staff");
  const waiting = staffOn && !usage && !failed; // the invitation step is still loading
  const steps = waiting ? [] : onboardingSteps(usage).filter(st => !(st.needsUsage && !usage));
  const doneCount = steps.filter(st => st.done).length;
  const complete = !waiting && steps.length > 0 && doneCount === steps.length;
  // Every step done: the checklist goes away for good (docs/03).
  React.useEffect(() => { if (complete) onHide(); }, [complete]);
  if (waiting || complete) return null;

  const open = (st) => {
    if (st.tab) window.__settingsTabRequest = st.tab;
    go && go(st.route);
  };
  const fold = (on) => { setOnboardingFlag("later", scopeKey, on); setLater(on); };
  const pct = Math.round((doneCount / steps.length) * 100);
  const progressText = `أنجزت ${doneCount} من ${steps.length}`;

  if (later) {
    return (
      <section className="card onboarding onboarding-folded" aria-label="ابدأ الإعداد" data-onboarding="folded"
        style={{display:"flex",alignItems:"center",gap:12,padding:"12px 16px",marginBottom:18,flexWrap:"wrap",borderColor:"var(--blue-100)",background:"var(--blue-50)"}}>
        <I.Sparkle size={16} style={{color:"var(--blue-700)",flexShrink:0}}/>
        <div style={{flex:1,minWidth:180,fontSize:13.5}}>
          <strong>ابدأ الإعداد</strong> <span className="muted" data-onboarding-progress="">— {progressText}</span>
        </div>
        <button type="button" className="btn btn-secondary" style={{fontSize:12.5}} onClick={() => fold(false)}>متابعة الإعداد</button>
      </section>
    );
  }

  return (
    <section className="card card-pad onboarding" aria-labelledby="onboarding-title" data-onboarding="open"
      style={{marginBottom:18,borderColor:"var(--blue-100)"}}>
      <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12,flexWrap:"wrap",marginBottom:12}}>
        <div style={{minWidth:0}}>
          <h2 id="onboarding-title" className="h2" style={{display:"flex",alignItems:"center",gap:8,margin:0}}>
            <I.Sparkle size={17} style={{color:"var(--blue-700)"}}/> ابدأ الإعداد
          </h2>
          <div className="muted" style={{fontSize:12.5,marginTop:4}}>خطوات قليلة لتجهيز عيادتك لأول حجز.</div>
        </div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          <button type="button" className="btn btn-ghost" style={{fontSize:12.5}} onClick={() => fold(true)}>لاحقًا</button>
          <button type="button" className="btn btn-ghost" style={{fontSize:12.5}} onClick={onHide}>إخفاء</button>
        </div>
      </div>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
        <div role="progressbar" aria-label="تقدم الإعداد" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={doneCount}
          style={{flex:1,height:6,background:"var(--ink-100)",borderRadius:999,overflow:"hidden"}}>
          <div style={{width:`${pct}%`,height:"100%",background:"var(--green)",borderRadius:999,transition:"width .2s"}}/>
        </div>
        <span className="muted" data-onboarding-progress="" style={{fontSize:12,whiteSpace:"nowrap"}}>{progressText}</span>
      </div>
      <ol style={{listStyle:"none",padding:0,margin:0,display:"flex",flexDirection:"column",gap:8}}>
        {steps.map((st, i) => (
          <li key={st.id} data-step={st.id} data-done={st.done ? "true" : "false"}
            style={{display:"flex",alignItems:"center",gap:12,padding:"10px 12px",border:"1px solid var(--ink-200)",borderRadius:10,
              background: st.done ? "var(--ink-50)" : "#fff",flexWrap:"wrap"}}>
            <span aria-hidden="true" style={{width:24,height:24,borderRadius:999,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",
              fontSize:11.5,fontWeight:600,background: st.done ? "var(--green)" : "var(--ink-100)",color: st.done ? "#fff" : "var(--ink-500)"}}>
              {st.done ? <I.Check size={13}/> : i + 1}
            </span>
            <div style={{flex:1,minWidth:180}}>
              <div style={{fontSize:13.5,fontWeight:500,color: st.done ? "var(--ink-500)" : "var(--ink-900)",textDecoration: st.done ? "line-through" : "none"}}>
                {st.title}<span className="sr-only" style={{position:"absolute",width:1,height:1,overflow:"hidden",clip:"rect(0 0 0 0)"}}>{st.done ? " — تم" : " — لم يتم بعد"}</span>
              </div>
              <div className="muted" style={{fontSize:12,marginTop:2}}>{st.hint}</div>
            </div>
            {st.done
              ? <span className="badge b-green"><I.Check size={11}/> تم</span>
              : <button type="button" className="btn btn-secondary" style={{fontSize:12.5}} onClick={() => open(st)}>{st.action}</button>}
          </li>
        ))}
      </ol>
    </section>
  );
}
window.OnboardingChecklist = OnboardingChecklist;

// Inline page alert (docs/04 «Alert ثابت داخل الصفحة»): tone warn | error | info.
function CaAlert({ tone = "warn", children, onClose, id }) {
  const tones = {
    warn:  { bg: "var(--amber-bg)", fg: "#9B6321" },
    error: { bg: "var(--red-bg)",   fg: "#A8443A" },
    info:  { bg: "var(--blue-50)",  fg: "var(--blue-900)" },
  };
  const t = tones[tone] || tones.warn;
  return (
    <div id={id} role={tone === "error" ? "alert" : "status"} className={"ca-alert ca-alert-" + tone}
      style={{display:"flex",gap:10,alignItems:"flex-start",padding:"10px 14px",borderRadius:12,background:t.bg,color:t.fg,fontSize:13,lineHeight:1.65,marginBottom:14}}>
      <span style={{flex:1}}>{children}</span>
      {onClose && <button type="button" className="btn btn-ghost btn-icon" aria-label="إغلاق التنبيه" onClick={onClose} style={{padding:2,color:"inherit"}}><I.X size={13}/></button>}
    </div>
  );
}

// An e-mail, left-to-right, that may wrap only before its "@" (narrow
// table columns) instead of splitting a word.
function caEmail(email) {
  const v = String(email || "");
  const at = v.indexOf("@");
  if (at <= 0) return <bdi dir="ltr">{v || "—"}</bdi>;
  return <bdi dir="ltr">{v.slice(0, at)}<wbr/>{v.slice(at)}</bdi>;
}

// YYYY-MM-DD (ISO) kept left-to-right inside Arabic text.
function caFmtDate(v) {
  const s = String(v || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? <bdi dir="ltr" className="mono">{s}</bdi> : "—";
}

// Branch id → name (the clinic's branches, inactive ones marked).
function caBranchNames(ids) {
  const list = window.BRANCHES || [];
  return (ids || []).map(id => {
    const b = list.find(x => x.id === id);
    if (!b) return id;
    return b.name + ((window.branchIsActive && !window.branchIsActive(b)) ? " (معطّل)" : "");
  });
}

// Checkbox list of the clinic's ACTIVE branches (invitations, members and
// accounts can only be given active branches).
function CaBranchChecks({ value, onChange, idPrefix, invalid, describedBy }) {
  const list = (window.BRANCHES || []).filter(b => !window.branchIsActive || window.branchIsActive(b));
  const toggle = (id, on) => onChange(on ? Array.from(new Set([...(value || []), id])) : (value || []).filter(x => x !== id));
  if (!list.length) return <div className="muted" style={{fontSize:12.5}}>لا توجد فروع نشطة — أضف فرعًا من صفحة «الفروع» أولًا.</div>;
  return (
    <div role="group" aria-describedby={describedBy} aria-invalid={invalid ? "true" : undefined}
      style={{display:"flex",flexWrap:"wrap",gap:8}}>
      {list.map(b => {
        const on = (value || []).includes(b.id);
        return (
          <label key={b.id} htmlFor={`${idPrefix}-${b.id}`}
            style={{display:"inline-flex",alignItems:"center",gap:8,padding:"7px 12px",borderRadius:10,cursor:"pointer",fontSize:13,
              border:"1px solid " + (on ? "var(--blue-500)" : invalid ? "var(--red)" : "var(--ink-200)"),
              background: on ? "var(--blue-50)" : "#fff"}}>
            <input id={`${idPrefix}-${b.id}`} type="checkbox" checked={on} onChange={e=>toggle(b.id, e.target.checked)}/>
            {b.name}
          </label>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// C07 — الفروع (docs/03 C07, docs/04 «C07 الفروع»; clinic admin only)
// ═══════════════════════════════════════════════════════════════
// Cards: name, status, address, phone, rooms, staff count, working hours;
// add / edit (BranchFormModal, src/ui.jsx), deactivate / re-activate —
// never delete (0005_branches_no_delete). Counter «الفروع النشطة: X من Y»
// when the plan limits branches; the plan's refusal (422
// plan_limit:branches) is shown in Arabic where it happens.

// Working hours as short lines: "السبت، الأحد: 09:00–21:00".
function caHoursSummary(wh) {
  const days = window.BRANCH_DAYS || [];
  if (!wh || typeof wh !== "object") return null;
  const groups = [];
  let closed = 0;
  for (const d of days) {
    const v = wh[d.key];
    if (!Array.isArray(v) || v.length !== 2) { closed++; continue; }
    const key = v[0] + "–" + v[1];
    const g = groups.find(x => x.key === key);
    if (g) g.days.push(d.ar); else groups.push({ key, from: v[0], to: v[1], days: [d.ar] });
  }
  if (!groups.length) return null;
  return { groups, closed };
}

function BranchCard({ b, current, staffCount, canDeactivate, onEdit, onToggle }) {
  const on = !window.branchIsActive || window.branchIsActive(b);
  const hours = caHoursSummary(b.working_hours);
  const row = { display:"flex", alignItems:"flex-start", gap:8, fontSize:13, color:"var(--ink-700)" };
  return (
    <div className="card card-pad branch-card" data-branch-card={b.id} data-status={on ? "active" : "inactive"}
      style={{display:"flex",flexDirection:"column",gap:10,opacity:on?1:.85}}>
      <div style={{display:"flex",alignItems:"flex-start",gap:8}}>
        <div style={{width:34,height:34,borderRadius:10,background:on?"var(--blue-100)":"var(--ink-100)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
          <I.MapPin size={16} style={{color:on?"var(--blue-700)":"var(--ink-500)"}}/>
        </div>
        <div style={{flex:1,minWidth:0}}>
          <div className="h3 branch-card-name" style={{whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{b.name}</div>
          <div style={{display:"flex",gap:6,flexWrap:"wrap",marginTop:4}}>
            <span className={"badge " + (on ? "b-green" : "b-grey")}><span className="dot"></span>{on ? "نشط" : "معطّل"}</span>
            {current && <span className="badge b-blue">الفرع الحالي</span>}
          </div>
        </div>
      </div>
      <div style={row}><I.MapPin size={13} style={{marginTop:3,color:"var(--ink-400)",flexShrink:0}}/><span>{b.address || <span className="muted">لا يوجد عنوان</span>}</span></div>
      <div style={row}><I.Phone size={13} style={{marginTop:3,color:"var(--ink-400)",flexShrink:0}}/><span>{b.phone ? <bdi dir="ltr" className="mono">{b.phone}</bdi> : <span className="muted">لا يوجد هاتف</span>}</span></div>
      <div style={{...row,gap:16,flexWrap:"wrap"}}>
        <span className="branch-card-rooms"><I.Layers size={13} style={{verticalAlign:"-2px",marginInlineEnd:6,color:"var(--ink-400)"}}/>الغرف: <span className="mono">{Number(b.rooms) || 0}</span></span>
        <span className="branch-card-staff"><I.Users size={13} style={{verticalAlign:"-2px",marginInlineEnd:6,color:"var(--ink-400)"}}/>الموظفون: <span className="mono">{staffCount == null ? "—" : staffCount}</span></span>
      </div>
      <div style={row}>
        <I.Clock size={13} style={{marginTop:3,color:"var(--ink-400)",flexShrink:0}}/>
        {hours ? (
          <div className="branch-card-hours" style={{display:"flex",flexDirection:"column",gap:2}}>
            {hours.groups.map(g => (
              <span key={g.key}>{g.days.join("، ")}: <bdi dir="ltr" className="mono">{g.from}–{g.to}</bdi></span>
            ))}
            {hours.closed > 0 && <span className="muted">باقي الأيام: مغلق</span>}
          </div>
        ) : <span className="muted">لم تُحدد ساعات العمل</span>}
      </div>
      <div style={{display:"flex",gap:8,marginTop:"auto",paddingTop:6,borderTop:"1px solid var(--ink-100)",flexWrap:"wrap"}}>
        <button type="button" className="btn btn-secondary" style={{fontSize:12.5}} onClick={onEdit} aria-label={`تعديل ${b.name}`}><I.Edit size={13}/> تعديل</button>
        {on ? (
          <button type="button" className="btn btn-secondary" style={{fontSize:12.5,color:canDeactivate?"var(--red)":undefined}}
            disabled={!canDeactivate} aria-disabled={!canDeactivate ? "true" : undefined}
            title={canDeactivate ? undefined : "لا يمكن تعطيل آخر فرع نشط"}
            onClick={onToggle} aria-label={`تعطيل ${b.name}`}>
            <I.Lock size={13}/> تعطيل
          </button>
        ) : (
          <button type="button" className="btn btn-secondary" style={{fontSize:12.5}} onClick={onToggle} aria-label={`إعادة تفعيل ${b.name}`}>
            <I.Check size={13}/> إعادة تفعيل
          </button>
        )}
      </div>
      {on && !canDeactivate && <div className="muted" style={{fontSize:11.5}}>آخر فرع نشط لا يمكن تعطيله.</div>}
    </div>
  );
}

function BranchesPage({ go }) {
  const role = (window.ME && window.ME.role) || "";
  const [branches, setBranches] = React.useState(window.BRANCHES || []);
  const [activeId, setActiveId] = React.useState(window.ACTIVE_BRANCH_ID || null);
  const { usage, reload } = useOrgUsage();
  const [form, setForm] = React.useState(null);      // null | "new" | branch row
  const [confirm, setConfirm] = React.useState(null); // { branch, target: "active" | "inactive" }
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState(null);   // { tone, text }

  React.useEffect(() => {
    const onUpd = () => { setBranches(window.BRANCHES || []); setActiveId(window.ACTIVE_BRANCH_ID || null); };
    window.addEventListener("kinetic:branches-updated", onUpd);
    return () => window.removeEventListener("kinetic:branches-updated", onUpd);
  }, []);

  if (role && role !== "مدير") {
    return (
      <Page>
        <div className="card card-pad" style={{textAlign:"center",padding:"60px 20px",maxWidth:520,margin:"40px auto"}}>
          <I.Lock size={36} style={{color:"var(--ink-400)",marginBottom:12}}/>
          <div className="h2" style={{marginBottom:8}}>ليست لديك صلاحية لهذه الصفحة</div>
          <div className="muted" style={{fontSize:13.5,marginBottom:20}}>إدارة الفروع متاحة لمدير العيادة فقط.</div>
          <button className="btn btn-blue" style={{margin:"0 auto"}} onClick={()=>go && go("dashboard")}><I.ArrowLeft size={13}/> العودة إلى لوحة التحكم</button>
        </div>
      </Page>
    );
  }

  const isOn = (b) => !window.branchIsActive || window.branchIsActive(b);
  const activeList = branches.filter(isOn);
  const inactiveList = branches.filter(b => !isOn(b));
  const max = usage && usage.branches ? usage.branches.max : null;
  const atLimit = max != null && activeList.length >= max;
  const staffOf = (id) => (usage && usage.branch_staff ? (usage.branch_staff[id] || 0) : null);

  async function applyStatus() {
    if (!confirm) return;
    const { branch, target } = confirm;
    setBusy(true);
    try {
      await window.setBranchStatus(branch.id, target);
      setNotice(null);
      if (window.showToast) window.showToast(target === "inactive" ? `تم تعطيل ${branch.name}` : `تمت إعادة تفعيل ${branch.name}`, "success");
      reload();
    } catch (e) {
      const msg = e && /[؀-ۿ]/.test(String(e.message || "")) ? e.message : "تعذّر تغيير حالة الفرع — أعد المحاولة";
      setNotice({ tone: "error", text: msg });
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  const counter = max != null
    ? <>الفروع النشطة: <span className="mono">{activeList.length}</span> من <span className="mono">{max}</span></>
    : <>الفروع النشطة: <span className="mono">{activeList.length}</span>{usage ? " · خطتك بلا حد للفروع" : ""}</>;

  return (
    <Page>
      <div className="page-head">
        <div>
          <div className="crumb"><span>الرئيسية</span><I.Chevron size={11}/><span>الفروع</span></div>
          <h1 className="h1">الفروع</h1>
          <div className="muted" style={{fontSize:13.5,marginTop:4}}>فروع عيادتك وساعات عملها وغرفها. الفرع المعطّل تبقى سجلاته محفوظة ولا يقبل حجوزات جديدة.</div>
        </div>
        <div className="page-actions">
          <span className={"pill branch-counter" + (atLimit ? " tag-amber" : "")} data-testid="branch-counter"
            style={atLimit ? {background:"var(--amber-bg)",color:"#9B6321"} : undefined}>{counter}</span>
          <button type="button" className="btn btn-blue" onClick={()=>setForm("new")} aria-describedby={atLimit ? "branch-limit-note" : undefined}>
            <I.Plus size={14}/> إضافة فرع
          </button>
        </div>
      </div>

      {atLimit && (
        <CaAlert tone="warn" id="branch-limit-note">
          وصلت إلى حد الفروع في خطتك (<span className="mono">{activeList.length}</span> من <span className="mono">{max}</span>). لإضافة فرع آخر عطّل فرعًا قائمًا أو تواصل مع إدارة المنصة لترقية الخطة.
        </CaAlert>
      )}
      {notice && <CaAlert tone={notice.tone} onClose={()=>setNotice(null)}>{notice.text}</CaAlert>}

      {branches.length === 0 ? (
        <div className="card">
          <EmptyState icon={<I.MapPin size={22}/>} title="لا فروع بعد" body="أضف أول فرع لبدء الحجز — الحجز معطّل حتى يوجد فرع نشط."
            action={<button type="button" className="btn btn-blue" onClick={()=>setForm("new")}><I.Plus size={14}/> أضف أول فرع</button>}/>
        </div>
      ) : (
        <div className="rgrid branch-grid" style={{"--gtc":"repeat(auto-fill, minmax(min(100%, 290px), 1fr))"}}>
          {activeList.map(b => (
            <BranchCard key={b.id} b={b} current={b.id === activeId} staffCount={staffOf(b.id)}
              canDeactivate={activeList.length > 1}
              onEdit={()=>setForm(b)} onToggle={()=>setConfirm({ branch: b, target: "inactive" })}/>
          ))}
        </div>
      )}

      {inactiveList.length > 0 && (
        <>
          <div className="h2" style={{margin:"26px 0 12px"}}>الفروع المعطّلة</div>
          <div className="rgrid branch-grid" style={{"--gtc":"repeat(auto-fill, minmax(min(100%, 290px), 1fr))"}}>
            {inactiveList.map(b => (
              <BranchCard key={b.id} b={b} current={b.id === activeId} staffCount={staffOf(b.id)} canDeactivate={false}
                onEdit={()=>setForm(b)} onToggle={()=>setConfirm({ branch: b, target: "active" })}/>
            ))}
          </div>
        </>
      )}

      {form && <BranchFormModal editing={form === "new" ? null : form} onSaved={()=>{ setNotice(null); reload(); }} onClose={()=>setForm(null)}/>}
      {confirm && (
        <ConfirmModal
          title={confirm.target === "inactive" ? `تعطيل ${confirm.branch.name}` : `إعادة تفعيل ${confirm.branch.name}`}
          danger={confirm.target === "inactive"}
          busy={busy}
          cancelLabel="رجوع"
          confirmLabel={confirm.target === "inactive" ? "تعطيل الفرع" : "إعادة التفعيل"}
          onConfirm={applyStatus}
          onClose={()=>setConfirm(null)}
          message={confirm.target === "inactive"
            ? <>سيختفي <b>{confirm.branch.name}</b> من قائمة الفروع ولن يقبل حجوزات جديدة. تبقى مواعيده وفواتيره وجلساته محفوظة، ويمكنك إعادة تفعيله لاحقًا. لا يُحذف أي فرع.</>
            : <>سيعود <b>{confirm.branch.name}</b> إلى قائمة الفروع ويقبل الحجوزات من جديد. يُحسب ضمن حد الفروع في خطتك.</>}
        />
      )}
    </Page>
  );
}

// Shown above every page while the branch in use is inactive (a member
// whose only branches were deactivated): its data stays readable, new
// bookings are refused (src/supabase.jsx upsertRow).
function InactiveBranchBanner() {
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    const on = () => setTick(t => t + 1);
    window.addEventListener("kinetic:branches-updated", on);
    return () => window.removeEventListener("kinetic:branches-updated", on);
  }, []);
  if (!window.SB || !window.branchIsActive) return null;
  const b = (window.BRANCHES || []).find(x => x.id === window.ACTIVE_BRANCH_ID);
  if (!b || window.branchIsActive(b)) return null;
  return (
    <div style={{padding:"10px 36px 0"}}>
      <CaAlert tone="warn">الفرع «{b.name}» معطّل — بياناته للعرض فقط ولا يمكن إضافة حجوزات جديدة فيه. تواصل مع مدير العيادة.</CaAlert>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// C06 — الموظفون والدعوات (docs/03 C06, docs/04 «C06 الموظفون»)
// ═══════════════════════════════════════════════════════════════
// With the API: members (GET /api/org/members — role, branches, status),
// invitations (GET/POST /api/org/invitations, resend, revoke), the users
// counter «المستخدمون: X من Y» (GET /api/org/usage), role + branches of a
// member (PATCH /api/org/members/:id), deactivate / re-activate through
// the admin set-status flow, and the existing «إنشاء مستخدم». Without a
// backend (demo mode) the local staff roster below is shown instead.
const CA_ROLE_AR = { admin:"مدير", receptionist:"موظف استقبال", doctor:"طبيب", therapist:"الأخصائي", staff:"موظف" };
const CA_INVITE_ROLES = ["receptionist", "doctor", "therapist", "admin"];
const CA_INVITE_STATUS = {
  pending:  { label:"معلّقة",  cls:"b-amber" },
  expired:  { label:"منتهية", cls:"b-grey" },
  accepted: { label:"مقبولة", cls:"b-green" },
  revoked:  { label:"ملغاة",  cls:"b-red" },
};
const CA_MEMBER_STATUS = {
  active:   { label:"نشط",   cls:"b-green" },
  disabled: { label:"معطّل", cls:"b-grey" },
  invited:  { label:"مدعو",  cls:"b-amber" },
};
const CA_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The invitation e-mail as the server last recorded it (docs/06 task 3.15):
// email_status 'failed' → «لم يُرسل البريد» (red, with a resend), 'pending'
// → «البريد قيد الإرسال» (neutral), 'sent' or none (older rows or an older
// API without the field) → nothing.
function caEmailStatus(inv) {
  const v = inv && inv.email_status;
  return v === "failed" || v === "pending" || v === "sent" ? v : null;
}
function CaEmailBadge({ inv }) {
  const st = caEmailStatus(inv);
  if (st === "failed") return <span className="badge b-red invite-unsent" data-email-status="failed" style={{whiteSpace:"nowrap"}}><I.Mail size={11}/>لم يُرسل البريد</span>;
  if (st === "pending") return <span className="badge b-grey invite-sending" data-email-status="pending" style={{whiteSpace:"nowrap"}}><I.Mail size={11}/>البريد قيد الإرسال</span>;
  return null;
}
// Replaces (or adds) one invitation in a list, as the server returned it.
function caMergeInvite(list, inv) {
  if (!Array.isArray(list) || !inv || !inv.id) return list;
  return list.some(x => x.id === inv.id) ? list.map(x => x.id === inv.id ? { ...x, ...inv } : x) : [inv, ...list];
}

function UsersPanel() {
  const api = !!(window.OrgAdmin && window.OrgAdmin.available());
  return api ? <StaffInvitesPanel/> : <StaffRosterPanel/>;
}

function StaffInvitesPanel() {
  const me = window.ME || {};
  const [members, setMembers] = React.useState(null);
  const [invites, setInvites] = React.useState(null);
  const [loadError, setLoadError] = React.useState("");
  const { usage, reload: reloadUsage } = useOrgUsage();
  const [filter, setFilter] = React.useState("open");
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editMember, setEditMember] = React.useState(null);
  const [nameRow, setNameRow] = React.useState(null);
  const [resetRow, setResetRow] = React.useState(null);
  const [statusRow, setStatusRow] = React.useState(null);
  const [statusBusy, setStatusBusy] = React.useState(false);
  const [revokeRow, setRevokeRow] = React.useState(null);
  const [revokeBusy, setRevokeBusy] = React.useState(false);
  const [resendId, setResendId] = React.useState(null);
  const [pwOpen, setPwOpen] = React.useState(false);
  const [profileOpen, setProfileOpen] = React.useState(false);

  const load = React.useCallback(async () => {
    const [m, i] = await Promise.all([window.OrgAdmin.members(), window.OrgAdmin.invitations()]);
    if (m.ok) setMembers(Array.isArray(m.data) ? m.data : []);
    if (i.ok) setInvites(Array.isArray(i.data) ? i.data : []);
    setLoadError(!m.ok ? m.error : (!i.ok ? i.error : ""));
    reloadUsage();
  }, [reloadUsage]);
  React.useEffect(() => { load(); }, [load]);

  // An e-mail still being sent when the server answered (email_status
  // 'pending'): read the list again a few times until it settles.
  const sendingCount = (invites || []).filter(i => caEmailStatus(i) === "pending").length;
  const pollRef = React.useRef(0);
  React.useEffect(() => {
    if (!sendingCount) { pollRef.current = 0; return; }
    if (pollRef.current >= 8) return;
    const t = setTimeout(() => { pollRef.current += 1; load(); }, 15000);
    return () => clearTimeout(t);
  }, [sendingCount, invites, load]);

  const toast = (msg, kind) => window.showToast && window.showToast(msg, kind || "success");

  // Create / resend answer {invitation, email_sent}: the row shows the
  // server's email_status at once, then the list is read again.
  function afterInvite(data) {
    const inv = data && data.invitation;
    if (!inv) return;
    setInvites(prev => caMergeInvite(prev, inv));
    if (data.email_sent === true) toast(`تم إرسال الدعوة إلى ${inv.email}`);
    else if (data.email_sent === false) toast(`أُنشئت الدعوة لكن لم يُرسل البريد إلى ${inv.email} بعد — أعد الإرسال من القائمة`, "error");
    else toast(`أُنشئت الدعوة — البريد قيد الإرسال إلى ${inv.email}`, "info");
    setFilter("open");
    load();
  }

  async function resend(inv) {
    setResendId(inv.id);
    const r = await window.OrgAdmin.resendInvitation(inv.id);
    setResendId(null);
    if (!r.ok) { toast(r.error, "error"); return; }
    const sent = r.data ? r.data.email_sent : false;
    if (r.data && r.data.invitation) setInvites(prev => caMergeInvite(prev, r.data.invitation));
    if (sent === true) toast(`أُعيد إرسال الدعوة إلى ${inv.email}`);
    else if (sent === null) toast(`جُددت الدعوة — البريد قيد الإرسال إلى ${inv.email}`, "info");
    else toast(`تعذّر إرسال البريد إلى ${inv.email} — أعد المحاولة لاحقًا`, "error");
    load();
  }

  async function revoke() {
    if (!revokeRow) return;
    setRevokeBusy(true);
    const r = await window.OrgAdmin.revokeInvitation(revokeRow.id);
    setRevokeBusy(false);
    if (r.ok) { toast(`تم إلغاء دعوة ${revokeRow.email}`); load(); }
    else toast(r.error, "error");
    setRevokeRow(null);
  }

  async function applyStatus() {
    if (!statusRow) return;
    const { row, active } = statusRow;
    setStatusBusy(true);
    const res = await window.adminSetStaffStatus({ staff_id: row.staff_id, active });
    setStatusBusy(false);
    if (res.ok) toast(active ? `تم تفعيل حساب ${row.name}` : `تم تعطيل حساب ${row.name}`);
    else toast(res.error || "تعذّر تنفيذ العملية", "error");
    setStatusRow(null);
    load();
  }

  const usersMax = usage && usage.users ? usage.users.max : null;
  const atLimit = usersMax != null && usage.users.used >= usersMax;
  const allInvites = invites || [];
  const openInvites = allInvites.filter(i => i.status === "pending" || i.status === "expired");
  const shownInvites = filter === "open" ? openInvites : allInvites;
  const initials = (n) => (n || "?").split(" ").map(x => x[0] || "").join("").slice(0, 2);

  return (
    <div className="staff-panel">
      {/* Phones (< 640px): each row becomes a card (docs/04 Layout rules). */}
      <style>{`
        @media (max-width: 639px) {
          .staff-panel .tbl-scroll { max-height: none; overflow: visible; }
          .staff-panel .tbl-scroll > .tbl.ca-cards { min-width: 0; }
          .staff-panel .ca-cards thead { display: none; }
          .staff-panel .ca-cards, .staff-panel .ca-cards tbody { display: block; }
          .staff-panel .ca-cards tbody tr { display: block; border: 1px solid var(--ink-200); border-radius: 12px; padding: 8px 12px; margin-bottom: 10px; background: #fff; }
          .staff-panel .ca-cards tbody td { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 6px 0 !important; border: none !important; background: transparent !important; }
          .staff-panel .ca-cards tbody td[data-label]::before { content: attr(data-label); font-size: 11.5px; color: var(--ink-500); flex-shrink: 0; }
          .staff-panel .ca-cards tbody td.ca-cell-menu { justify-content: flex-end; width: auto !important; }
        }
      `}</style>
      <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:14,gap:12,flexWrap:"wrap"}}>
        <div>
          <div className="h2">المستخدمون والأدوار</div>
          <div className="muted" style={{fontSize:12.5,marginTop:2}}>ادعُ فريقك بالبريد وحدد الدور والفروع، وفعّل أو عطّل الحسابات. لا يُحذف أي حساب.</div>
          {usage && usage.users && (
            <div className="users-counter" data-testid="users-counter" style={{marginTop:8,fontSize:12.5,color:atLimit?"#9B6321":"var(--ink-700)"}}>
              {/* The pending invitations belong to the count, before the plan's note. */}
              المستخدمون: <span className="mono">{usage.users.used}</span>
              {usersMax != null && <> من <span className="mono">{usersMax}</span></>}
              {usage.users.pending_invitations > 0 && <span className="muted"> (منها دعوات معلّقة: <span className="mono">{usage.users.pending_invitations}</span>)</span>}
              {usersMax == null && <> · خطتك بلا حد للمستخدمين</>}
            </div>
          )}
        </div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          <button type="button" className="btn btn-secondary" onClick={()=>setCreateOpen(true)}><I.User size={14}/> إنشاء مستخدم</button>
          <button type="button" className="btn btn-blue" onClick={()=>setInviteOpen(true)}><I.Mail size={14}/> دعوة موظف</button>
        </div>
      </div>

      {atLimit && (
        <CaAlert tone="warn">
          وصلت إلى حد المستخدمين في خطتك (<span className="mono">{usage.users.used}</span> من <span className="mono">{usersMax}</span>) — الدعوات المعلّقة تُحسب أيضًا. ألغِ دعوة أو عطّل حسابًا، أو تواصل مع إدارة المنصة لترقية الخطة.
        </CaAlert>
      )}
      {loadError && (
        <CaAlert tone="error">{loadError} <button type="button" className="btn btn-ghost" style={{fontSize:12,padding:"2px 8px",marginInlineStart:6}} onClick={load}>إعادة المحاولة</button></CaAlert>
      )}

      {/* My account */}
      <div className="card" style={{padding:14,marginBottom:18,display:"flex",alignItems:"center",gap:14,flexWrap:"wrap",background:"var(--blue-50)",border:"1px solid var(--blue-100)"}}>
        <div className="av md" style={{background:"var(--blue-700)",color:"#fff"}}>{initials(me.name)}</div>
        <div style={{flex:1,minWidth:160}}>
          <div style={{fontWeight:600,fontSize:13.5}}>{me.name || "حسابي"} <span className="badge b-violet" style={{marginInlineStart:6}}><span className="dot"></span>{me.role || "مدير"}</span></div>
          <div className="mono muted" style={{fontSize:12}}><bdi dir="ltr">{me.email || "—"}</bdi></div>
        </div>
        <button type="button" className="btn btn-secondary" style={{fontSize:12.5}} onClick={()=>setProfileOpen(true)}><I.Edit size={13}/> تعديل اسمي</button>
        <button type="button" className="btn btn-secondary" style={{fontSize:12.5}} onClick={()=>setPwOpen(true)}><I.Lock size={13}/> تغيير كلمة المرور</button>
      </div>

      {/* Members — name with the e-mail under it, so the table fits the
          card without sideways scrolling on a desktop screen. */}
      <div className="h3" style={{marginBottom:8}}>أعضاء العيادة</div>
      <div className="tbl-scroll" style={{marginBottom:22}}>
        <table className="tbl members-table ca-cards">
          <thead><tr><th>الموظف</th><th>الدور</th><th>الفروع</th><th>الحالة</th><th><span style={{position:"absolute",width:1,height:1,overflow:"hidden",clip:"rect(0 0 0 0)"}}>إجراءات</span></th></tr></thead>
          <tbody>
            {members === null && !loadError && (
              <tr><td colSpan={5} style={{padding:0}}><SkeletonRow count={3}/></td></tr>
            )}
            {members && members.length === 0 && (
              <tr><td colSpan={5}><EmptyState icon={<I.Users size={22}/>} title="لا أعضاء بعد" body="ادعُ أول موظف بالبريد من زر «دعوة موظف»."/></td></tr>
            )}
            {(members || []).map(m => {
              const st = CA_MEMBER_STATUS[m.status] || CA_MEMBER_STATUS.active;
              const branches = m.role === "admin" ? ["كل الفروع"] : caBranchNames(m.branch_ids);
              const active = m.status === "active";
              const items = [];
              if (m.is_self) {
                items.push({ label:"تعديل اسمي", icon:<I.Edit size={13}/>, onClick:()=>setProfileOpen(true) });
                items.push({ label:"تغيير كلمة المرور", icon:<I.Lock size={13}/>, onClick:()=>setPwOpen(true) });
              } else {
                items.push({ label:"تعديل الدور والفروع", icon:<I.Settings size={13}/>, onClick:()=>setEditMember(m) });
                if (m.staff_id) items.push({ label:"تعديل الاسم", icon:<I.Edit size={13}/>, onClick:()=>setNameRow({ staff_id:m.staff_id, name:m.name, email:m.email, role:m.role }) });
                if (m.staff_id) items.push({ label:"إعادة تعيين كلمة المرور", icon:<I.Lock size={13}/>, onClick:()=>setResetRow({ staff_id:m.staff_id, auth_uid:m.user_id, name:m.name, email:m.email }) });
                if (m.staff_id) items.push(active
                  ? { label:"تعطيل الحساب", icon:<I.Lock size={13}/>, danger:true, onClick:()=>setStatusRow({ row:m, active:false }) }
                  : { label:"إعادة تفعيل الحساب", icon:<I.Check size={13}/>, onClick:()=>setStatusRow({ row:m, active:true }) });
              }
              items.push({ label:"نسخ البريد", icon:<I.Mail size={13}/>, onClick:()=>{ try { navigator.clipboard.writeText(m.email || ""); toast("تم نسخ البريد"); } catch (_) {} } });
              // A disabled member is greyed by colour, not opacity: opacity
              // would trap the row menu (position:fixed) under the next table.
              return (
                <tr key={m.id} data-member={m.email} data-status={m.status} style={active ? undefined : {color:"var(--ink-500)"}}>
                  <td><div style={{display:"flex",alignItems:"center",gap:10,minWidth:0}}>
                    <div className="av sm" style={{flexShrink:0}}>{initials(m.name)}</div>
                    <div style={{minWidth:0}}>
                      <div style={{fontWeight:500}}>{m.name}{m.is_self && <span className="muted" style={{fontSize:11,fontWeight:400,marginInlineStart:6}}>(أنا)</span>}</div>
                      <div className="mono muted" style={{fontSize:11.5,overflowWrap:"break-word"}}>{caEmail(m.email)}</div>
                    </div>
                  </div></td>
                  <td data-label="الدور"><span className={"badge " + roleBadgeClass(m.role)} style={{whiteSpace:"nowrap"}}><span className="dot"></span>{CA_ROLE_AR[m.role] || m.role}</span></td>
                  <td data-label="الفروع" style={{fontSize:12.5}}>{branches.length ? branches.join("، ") : <span className="muted">—</span>}</td>
                  <td data-label="الحالة"><span className={"badge " + st.cls} style={{whiteSpace:"nowrap"}}><span className="dot"></span>{st.label}</span></td>
                  <td className="ca-cell-menu" style={{width:44}}><RowMenu size={13} items={items}/></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Invitations — e-mail with the role and branches under it. */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,flexWrap:"wrap",marginBottom:8}}>
        <div className="h3">الدعوات</div>
        <div className="seg" role="group" aria-label="تصفية الدعوات">
          <button type="button" className={filter === "open" ? "on" : ""} aria-pressed={filter === "open"} onClick={()=>setFilter("open")}>بانتظار القبول (<span className="mono">{openInvites.length}</span>)</button>
          <button type="button" className={filter === "all" ? "on" : ""} aria-pressed={filter === "all"} onClick={()=>setFilter("all")}>كل الدعوات (<span className="mono">{allInvites.length}</span>)</button>
        </div>
      </div>
      <div className="tbl-scroll">
        <table className="tbl invitations-table ca-cards">
          <thead><tr><th>المدعو</th><th>الحالة</th><th>تنتهي في</th><th>إجراءات</th></tr></thead>
          <tbody>
            {invites === null && !loadError && (
              <tr><td colSpan={4} style={{padding:0}}><SkeletonRow count={2}/></td></tr>
            )}
            {invites && shownInvites.length === 0 && (
              <tr><td colSpan={4}><div className="tbl-empty"><I.Mail size={20}/><div>{filter === "open" ? "لا توجد دعوات بانتظار القبول." : "لم تُرسل أي دعوة بعد."}</div></div></td></tr>
            )}
            {shownInvites.map(inv => {
              const st = CA_INVITE_STATUS[inv.status] || { label: inv.status, cls: "b-grey" };
              const actionable = inv.status === "pending" || inv.status === "expired";
              const notSent = actionable && caEmailStatus(inv) === "failed";
              const where = inv.role === "admin" ? "كل الفروع" : (caBranchNames(inv.branch_ids).join("، ") || "—");
              return (
                <tr key={inv.id} data-invite={inv.email} data-status={inv.status}>
                  <td>
                    <div className="mono" style={{fontSize:12,overflowWrap:"break-word"}}>{caEmail(inv.email)}</div>
                    <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap",marginTop:4,fontSize:12}}>
                      <span className={"badge " + roleBadgeClass(inv.role)} style={{whiteSpace:"nowrap"}}><span className="dot"></span>{CA_ROLE_AR[inv.role] || inv.role}</span>
                      <span className="muted invite-branches">{where}</span>
                    </div>
                  </td>
                  <td data-label="الحالة">
                    <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                      <span className={"badge " + st.cls} style={{whiteSpace:"nowrap"}}><span className="dot"></span>{st.label}</span>
                      {actionable && <CaEmailBadge inv={inv}/>}
                    </div>
                  </td>
                  <td data-label="تنتهي في" style={{fontSize:12.5,whiteSpace:"nowrap"}}>{actionable ? caFmtDate(inv.expires_at) : "—"}</td>
                  <td data-label="إجراءات">
                    {actionable ? (
                      <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                        <button type="button" className={"btn " + (notSent || inv.status === "expired" ? "btn-blue" : "btn-secondary")} style={{fontSize:12,padding:"5px 10px",whiteSpace:"nowrap"}}
                          disabled={resendId === inv.id} aria-label={`إعادة إرسال دعوة ${inv.email}`} onClick={()=>resend(inv)}>
                          {resendId === inv.id
                            ? <span className="spin" aria-hidden="true" style={{width:12,height:12,border:"2px solid currentColor",borderTopColor:"transparent",borderRadius:"50%"}}/>
                            : <I.Send size={12}/>} إعادة الإرسال
                        </button>
                        <button type="button" className="btn btn-ghost" style={{fontSize:12,padding:"5px 10px",color:"#A8443A",whiteSpace:"nowrap"}}
                          aria-label={`إلغاء دعوة ${inv.email}`} onClick={()=>setRevokeRow(inv)}>
                          <I.X size={12}/> إلغاء
                        </button>
                      </div>
                    ) : <span className="muted" style={{fontSize:12}}>—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {inviteOpen && <InviteStaffModal onClose={()=>setInviteOpen(false)} onDone={afterInvite}/>}
      {createOpen && <CreateUserModal onClose={()=>setCreateOpen(false)} onDone={()=>load()}/>}
      {editMember && <EditMemberModal member={editMember} onClose={()=>setEditMember(null)} onDone={()=>{ toast("تم حفظ التغييرات"); load(); }}/>}
      {nameRow && <EditUserModal row={nameRow} nameOnly onClose={()=>{ setNameRow(null); load(); }}/>}
      {pwOpen && <ChangePasswordModal onClose={()=>setPwOpen(false)}/>}
      {profileOpen && <EditProfileModal onClose={()=>{ setProfileOpen(false); load(); }}/>}
      {resetRow && <AdminResetPasswordModal row={resetRow} onClose={()=>setResetRow(null)}/>}
      {revokeRow && (
        <ConfirmModal
          title="إلغاء الدعوة"
          danger
          busy={revokeBusy}
          cancelLabel="رجوع"
          confirmLabel="إلغاء الدعوة"
          onConfirm={revoke}
          onClose={()=>setRevokeRow(null)}
          message={<>لن يعمل رابط الدعوة المرسل إلى <b><bdi dir="ltr">{revokeRow.email}</bdi></b> بعد الآن، ويتحرر مقعده في الخطة. يمكنك إرسال دعوة جديدة لاحقًا.</>}
        />
      )}
      {statusRow && (
        <ConfirmModal
          title={statusRow.active ? "إعادة تفعيل الحساب" : "تعطيل الحساب"}
          danger={!statusRow.active}
          busy={statusBusy}
          cancelLabel="رجوع"
          confirmLabel={statusRow.active ? "تفعيل" : "تعطيل"}
          onConfirm={applyStatus}
          onClose={()=>setStatusRow(null)}
          message={statusRow.active
            ? <>سيتمكّن <b>{statusRow.row.name}</b> (<bdi dir="ltr">{statusRow.row.email || "—"}</bdi>) من تسجيل الدخول إلى العيادة مجددًا بنفس البريد وكلمة المرور. يُحسب ضمن حد المستخدمين في خطتك.</>
            : <>سيُمنع <b>{statusRow.row.name}</b> (<bdi dir="ltr">{statusRow.row.email || "—"}</bdi>) من دخول العيادة وتُنهى جلساته الحالية فورًا. تبقى جميع بياناته ومواعيده وسجل التدقيق كما هي، ويمكن إعادة التفعيل لاحقًا.</>}
        />
      )}
    </div>
  );
}

// «دعوة موظف»: e-mail + role + branches (docs/03 «دعوة موظف»). Non-admin
// roles need at least one active branch; the clinic admin works in every
// branch. The server's refusals (already a member, a pending invitation,
// the plan's user limit) show in the form, in Arabic.
function InviteStaffModal({ onClose, onDone }) {
  const activeIds = (window.BRANCHES || []).filter(b => !window.branchIsActive || window.branchIsActive(b)).map(b => b.id);
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState("receptionist");
  const [branchIds, setBranchIds] = React.useState(() =>
    activeIds.includes(window.ACTIVE_BRANCH_ID) ? [window.ACTIVE_BRANCH_ID] : activeIds.slice(0, 1));
  const [errors, setErrors] = React.useState({});
  const [serverError, setServerError] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function submit() {
    const e = {};
    const addr = email.trim().toLowerCase();
    if (!addr) e.email = "أدخل البريد الإلكتروني";
    else if (!CA_EMAIL_RE.test(addr) || addr.length > 254) e.email = "بريد إلكتروني غير صحيح";
    if (!CA_INVITE_ROLES.includes(role)) e.role = "اختر الدور";
    if (role !== "admin" && !branchIds.length) e.branches = "اختر فرعًا واحدًا على الأقل";
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    setServerError("");
    const r = await window.OrgAdmin.invite({ email: addr, role, branch_ids: role === "admin" ? [] : branchIds });
    setBusy(false);
    if (!r.ok) { setServerError(r.error); return; }
    onClose();
    if (onDone) onDone(r.data);
  }

  const errStyle = { fontSize:11.5, color:"#A8443A", marginTop:4 };
  return (
    <Modal title="دعوة موظف" onClose={busy ? undefined : onClose} width={560} footer={<>
      <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>إلغاء</button>
      <button type="button" className="btn btn-blue" disabled={busy} onClick={submit} aria-busy={busy ? "true" : undefined}>
        {busy ? <span className="spin" aria-hidden="true" style={{width:13,height:13,border:"2px solid #fff",borderTopColor:"transparent",borderRadius:"50%"}}/> : <I.Send size={13}/>}
        إرسال الدعوة
      </button>
    </>}>
      <form onSubmit={(e)=>{ e.preventDefault(); submit(); }} noValidate>
        {serverError && <CaAlert tone="error">{serverError}</CaAlert>}
        <label className="label" htmlFor="staff-invite-email">البريد الإلكتروني <span style={{color:"#A8443A"}}>*</span></label>
        <input id="staff-invite-email" className="input" type="email" dir="ltr" autoFocus placeholder="name@clinic.eg" value={email}
          style={{textAlign:"right", ...(errors.email ? {borderColor:"var(--red)"} : {})}}
          aria-invalid={errors.email ? "true" : undefined} aria-describedby={errors.email ? "staff-invite-email-err" : undefined}
          onChange={e=>{ setEmail(e.target.value); setErrors(x=>({...x,email:undefined})); setServerError(""); }}/>
        {errors.email && <div id="staff-invite-email-err" style={errStyle}>{errors.email}</div>}
        <div style={{height:12}}/>
        <label className="label" htmlFor="staff-invite-role">الدور <span style={{color:"#A8443A"}}>*</span></label>
        <select id="staff-invite-role" className="input" value={role} onChange={e=>{ setRole(e.target.value); setServerError(""); }}>
          {CA_INVITE_ROLES.map(r => <option key={r} value={r}>{CA_ROLE_AR[r]}</option>)}
        </select>
        <div style={{height:14}}/>
        <div className="label" id="staff-invite-branches-label">الفروع {role !== "admin" && <span style={{color:"#A8443A"}}>*</span>}</div>
        {role === "admin"
          ? <div className="muted" style={{fontSize:12.5}}>مدير العيادة يعمل في كل الفروع.</div>
          : <CaBranchChecks value={branchIds} onChange={(v)=>{ setBranchIds(v); setErrors(x=>({...x,branches:undefined})); }} idPrefix="staff-invite-branch"
              invalid={!!errors.branches} describedBy={errors.branches ? "staff-invite-branches-err" : "staff-invite-branches-label"}/>}
        {errors.branches && <div id="staff-invite-branches-err" style={errStyle}>{errors.branches}</div>}
        <div className="muted" style={{fontSize:11.5,marginTop:14,lineHeight:1.6,padding:"10px 12px",background:"var(--ink-50)",borderRadius:8}}>
          <I.Mail size={11} style={{marginInlineEnd:4}}/> يصل للموظف رابط صالح لمدة 7 أيام ليعيّن كلمة مروره بنفسه. الدعوة المعلّقة تحجز مقعدًا في خطتك حتى تُقبل أو تُلغى.
        </div>
      </form>
    </Modal>
  );
}

// Role and branches of a member (PATCH /api/org/members/:id). A role
// change ends the member's open sessions so the new navigation applies.
function EditMemberModal({ member, onClose, onDone }) {
  const roles = member.role === "staff" ? [...CA_INVITE_ROLES, "staff"] : CA_INVITE_ROLES;
  const [role, setRole] = React.useState(member.role);
  const [branchIds, setBranchIds] = React.useState(() => (member.branch_ids || []).filter(id =>
    (window.BRANCHES || []).some(b => b.id === id && (!window.branchIsActive || window.branchIsActive(b)))));
  const [error, setError] = React.useState("");
  const [serverError, setServerError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  async function submit() {
    if (role !== "admin" && !branchIds.length) { setError("اختر فرعًا واحدًا على الأقل"); return; }
    setBusy(true);
    setServerError("");
    const r = await window.OrgAdmin.updateMember(member.id, { role, branch_ids: role === "admin" ? [] : branchIds });
    setBusy(false);
    if (!r.ok) { setServerError(r.error); return; }
    onClose();
    if (onDone) onDone(r.data);
  }
  return (
    <Modal title={`تعديل ${member.name}`} onClose={busy ? undefined : onClose} footer={<>
      <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>إلغاء</button>
      <button type="button" className="btn btn-blue" disabled={busy} onClick={submit}><I.Check size={13}/> حفظ</button>
    </>}>
      {serverError && <CaAlert tone="error">{serverError}</CaAlert>}
      <div className="muted mono" style={{fontSize:12,marginBottom:12}}><bdi dir="ltr">{member.email}</bdi></div>
      <label className="label" htmlFor="member-role">الدور</label>
      <select id="member-role" className="input" value={role} onChange={e=>{ setRole(e.target.value); setError(""); }}>
        {roles.map(r => <option key={r} value={r}>{CA_ROLE_AR[r]}</option>)}
      </select>
      <div style={{height:14}}/>
      <div className="label">الفروع</div>
      {role === "admin"
        ? <div className="muted" style={{fontSize:12.5}}>مدير العيادة يعمل في كل الفروع.</div>
        : <CaBranchChecks value={branchIds} onChange={(v)=>{ setBranchIds(v); setError(""); }} idPrefix="member-branch" invalid={!!error}/>}
      {error && <div style={{fontSize:11.5,color:"#A8443A",marginTop:4}}>{error}</div>}
      {role !== member.role && (
        <div className="muted" style={{fontSize:11.5,marginTop:12,lineHeight:1.6,padding:"10px 12px",background:"var(--ink-50)",borderRadius:8}}>
          تغيير الدور يُنهي جلسات الموظف المفتوحة، فيسجّل الدخول من جديد بصلاحيات الدور الجديد.
        </div>
      )}
    </Modal>
  );
}

// Without a backend (demo mode): the local staff roster, as before.
function StaffRosterPanel() {
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
    if (!window.confirm(`إزالة ${s.name} من القائمة؟`)) return;
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
        <div className="av md" style={{background:"var(--blue-700)",color:"#fff"}}>{(me.name||"?").split(" ").map(x=>x[0]||"").join("").slice(0,2)}</div>
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
        <thead><tr><th>الاسم</th><th>البريد الإلكتروني</th><th>الدور</th><th>حالة الحساب</th><th><span className="sr-only">إجراءات</span></th></tr></thead>
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
        <I.Lock size={11} style={{marginInlineEnd:4}}/> بصفتك مديرًا، يمكنك تعيين كلمة مرور جديدة لهذا الموظف دون معرفة كلمته الحالية. تُنهى جلساته المفتوحة، ويستخدم الكلمة الجديدة في دخوله القادم.
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

// «إنشاء مستخدم» (POST /api/admin/create-user): an account with a password
// set by the admin, for staff who cannot receive e-mail. Invitations are
// the preferred path (the member sets their own password).
function CreateUserModal({ onClose, onDone }) {
  const api = !!(window.OrgAdmin && window.OrgAdmin.available());
  const activeIds = (window.BRANCHES || []).filter(b => !window.branchIsActive || window.branchIsActive(b)).map(b => b.id);
  const [form, setForm] = React.useState({ name:"", email:"", password:"", role:"receptionist" });
  const [branchIds, setBranchIds] = React.useState(() =>
    activeIds.includes(window.ACTIVE_BRANCH_ID) ? [window.ACTIVE_BRANCH_ID] : activeIds.slice(0, 1));
  const [busy, setBusy] = React.useState(false);
  const [showPw, setShowPw] = React.useState(false);
  const [serverError, setServerError] = React.useState("");
  const set = (k,v)=>{ setForm(f=>({...f,[k]:v})); setServerError(""); };
  async function submit() {
    if (!form.name.trim()) { setServerError("أدخل الاسم الكامل"); return; }
    if (api && form.role !== "admin" && !branchIds.length) { setServerError("اختر فرعًا واحدًا على الأقل"); return; }
    setBusy(true);
    const res = await window.adminCreateUser(api ? { ...form, branch_ids: form.role === "admin" ? [] : branchIds } : form);
    setBusy(false);
    if (!res.ok) { setServerError(res.error || "تعذّر إنشاء المستخدم"); return; }
    if (res.needsConfirm) window.showToast && window.showToast("تم الإنشاء — على المستخدم تأكيد بريده قبل الدخول", "success");
    else window.showToast && window.showToast(res.demo ? "تم الإنشاء (وضع تجريبي)" : "تم إنشاء المستخدم", "success");
    onClose();
    if (onDone) onDone(res);
  }
  return (
    <Modal title="إنشاء مستخدم جديد" onClose={busy ? undefined : onClose}
      footer={<>
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>إلغاء</button>
        <button type="button" className="btn btn-blue" disabled={busy} onClick={submit}>
          {busy ? <span className="spin" style={{width:14,height:14,border:"2px solid #fff",borderTopColor:"transparent",borderRadius:"50%"}}/> : <><I.Check size={13}/> إنشاء الحساب</>}
        </button>
      </>}>
      {serverError && <CaAlert tone="error">{serverError}</CaAlert>}
      <Field label="الاسم الكامل" required>
        <input className="input" aria-label="الاسم الكامل" value={form.name} onChange={e=>set("name",e.target.value)} placeholder="مثال: دينا فؤاد"/>
      </Field>
      <div style={{height:12}}/>
      <Field label="البريد الإلكتروني" required>
        <input className="input" aria-label="البريد الإلكتروني" type="email" dir="ltr" style={{textAlign:"right"}} value={form.email} onChange={e=>set("email",e.target.value)} placeholder="user@clinic.eg"/>
      </Field>
      <div style={{height:12}}/>
      <Field label="كلمة المرور" required hint="6 أحرف على الأقل">
        <div style={{position:"relative"}}>
          <input className="input" aria-label="كلمة المرور" type={showPw?"text":"password"} value={form.password} onChange={e=>set("password",e.target.value)} style={{paddingRight:38}}/>
          <button type="button" aria-label={showPw ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"} onClick={()=>setShowPw(s=>!s)} style={{position:"absolute",right:6,top:5,padding:6,border:"none",background:"transparent",cursor:"pointer",color:"var(--ink-500)"}}><I.Eye size={15}/></button>
        </div>
      </Field>
      <div style={{height:12}}/>
      <Field label="الدور" required>
        <select className="input" aria-label="الدور" value={form.role} onChange={e=>set("role",e.target.value)}>
          {ROLE_OPTIONS.map(r=><option key={r.slug} value={r.slug}>{r.label}</option>)}
        </select>
      </Field>
      {api && (
        <>
          <div style={{height:12}}/>
          <div className="label">الفروع {form.role !== "admin" && <span style={{color:"#A8443A"}}>*</span>}</div>
          {form.role === "admin"
            ? <div className="muted" style={{fontSize:12.5}}>مدير العيادة يعمل في كل الفروع.</div>
            : <CaBranchChecks value={branchIds} onChange={(v)=>{ setBranchIds(v); setServerError(""); }} idPrefix="create-user-branch"/>}
        </>
      )}
      <div className="muted" style={{fontSize:11.5,marginTop:14,lineHeight:1.6,padding:"10px 12px",background:"var(--ink-50)",borderRadius:8}}>
        <I.Lock size={11} style={{marginInlineEnd:4}}/> يستطيع الموظف الدخول فورًا بهذا البريد وكلمة المرور. الأفضل إرسال «دعوة موظف» ليعيّن كلمة مروره بنفسه؛ والحساب الموجود في عيادة أخرى ينضم بدعوة فقط.
      </div>
    </Modal>
  );
}

// Name (and, in demo mode, the roster role) of a staff row. With the API
// the role and branches are the membership's (EditMemberModal), so
// `nameOnly` hides the role.
function EditUserModal({ row, onClose, nameOnly }) {
  const [name, setName] = React.useState(row.name || "");
  const [role, setRole] = React.useState(row.role || "receptionist");
  const [busy, setBusy] = React.useState(false);
  async function submit() {
    if (!name.trim()) { window.showToast && window.showToast("أدخل الاسم", "error"); return; }
    setBusy(true);
    const res = await window.updateStaffMember(row.staff_id || row.id, nameOnly ? { name: name.trim() } : { name: name.trim(), role });
    setBusy(false);
    if (res.ok) window.showToast && window.showToast("تم حفظ التغييرات", "success");
    else window.showToast && window.showToast(res.error || "تعذّر الحفظ", "error");
    onClose();
  }
  const roleChanged = !nameOnly && role !== (row.role || "receptionist");
  return (
    <Modal title={`تعديل ${row.name || "المستخدم"}`} onClose={onClose}
      footer={<>
        <button type="button" className="btn btn-ghost" onClick={onClose}>إلغاء</button>
        <button type="button" className="btn btn-blue" disabled={busy} onClick={submit}><I.Check size={13}/> حفظ</button>
      </>}>
      <Field label="الاسم"><input className="input" aria-label="الاسم" value={name} onChange={e=>setName(e.target.value)}/></Field>
      <div style={{height:12}}/>
      <Field label="البريد الإلكتروني" hint="لا يمكن تغييره من هنا">
        <input className="input" dir="ltr" style={{opacity:.7,textAlign:"right"}} value={row.email || "—"} disabled/>
      </Field>
      {!nameOnly && (
        <>
          <div style={{height:12}}/>
          <Field label="الدور">
            <select className="input" value={role} onChange={e=>setRole(e.target.value)}>
              {ROLE_OPTIONS.map(r=><option key={r.slug} value={r.slug}>{r.label}</option>)}
            </select>
          </Field>
        </>
      )}
      {roleChanged && (
        <div className="muted" style={{fontSize:11.5,marginTop:12,lineHeight:1.6,padding:"10px 12px",background:"var(--ink-50)",borderRadius:8}}>
          يتغير الدور في قائمة الموظفين المحلية فقط (وضع العرض).
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
          <thead><tr><th>القسم</th><th>المجموعة</th><th>الحالة</th><th><span className="sr-only">إجراءات</span></th></tr></thead>
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
          <h1 className="h1" style={{marginBottom:2}}>{s.label}</h1>
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
        <h1 className="h1" style={{marginTop:18}}>هذه الصفحة في يوم تعافي.</h1>
        <div className="muted" style={{marginTop:8,maxWidth:480,textAlign:"center"}}>الصفحة التي تبحث عنها غير موجودة أو تم نقلها. عُد إلى لوحة التحكم.</div>
        <button className="btn btn-blue" style={{marginTop:20}} onClick={()=>go("dashboard")}><I.ArrowLeft size={13}/> العودة إلى لوحة التحكم</button>
      </div>
    </Page>
  );
}

Object.assign(window, { Reports, SettingsPage, NotFound });


// ─────────── App entrypoint ───────────
// Boot routing (docs/03-App-Flow.md "Entry points", src/tenant.jsx):
//   ?demo=1 / ?import=1          → ClinicApp, as before (demo has no backend)
//   ?invite=<token>              → S03 accept the invitation
//   ?reset=<token>               → new password, then back to the login
//   admin.<base> / ?platform=1   → window.PlatformApp (src/platform.jsx)
//   <slug>.<base> / ?org=<slug>  → ClinicApp: resolve → S06 or login → shell
//   the bare base domain         → S01/S02/S04: login, then the clinic
function App() {
  const [ctx] = React.useState(() =>
    window.tenantContext ? window.tenantContext() : { kind: "clinic", slug: null });
  if (ctx.kind === "platform") return <TenantPlatformGate/>;
  if (ctx.kind === "invite") return <TenantInviteScreen token={ctx.token}/>;
  if (ctx.kind === "reset") return <TenantResetScreen token={ctx.token}/>;
  if (ctx.kind === "root") return <TenantRootPortal/>;
  return <ClinicApp ctx={ctx}/>;
}

// The clinic workspace (also demo mode and the ?import=1 page). With a
// backend, the clinic gate runs first: GET /api/orgs/resolve → status
// page (S06) or the clinic's login → membership check → GET
// /api/orgs/current + data → the shell. Identity comes from the server
// session, never from localStorage.
function ClinicApp({ ctx }) {
  // Re-render the entire app when any DB table changes (upsert / remove /
  // hydrate). Cheap: it just bumps a state counter.
  window.useDataVersion();
  const demo = ctx.kind === "demo" || !window.SB;
  const gated = ctx.kind === "clinic" && !!window.SB;

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

  // The page: a link to it (#/<route>, src/tenant.jsx) first, else the last
  // page of this browser.
  const [rawRoute, setRoute] = React.useState(() => {
    const linked = window.tenantRouteFromHash ? window.tenantRouteFromHash() : null;
    return linked || localStorage.getItem("kinetic.route") || "dashboard";
  });
  // How the next route change reaches the address bar: "push" for the
  // user's own navigation (Back returns), "replace" otherwise.
  const navMode = React.useRef("replace");
  // Demo mode keeps its mock identity across reloads; with a backend the
  // session cookie is the only source (restored by the clinic gate).
  const [user, setUser] = React.useState(() => {
    if (!demo) return null;
    try {
      return JSON.parse(localStorage.getItem("kinetic.user")) || null;
    } catch { return null; }
  });
  // resolving | status | open (login screen or shell)
  const [gate, setGate] = React.useState(() => (gated ? { phase: "resolving" } : { phase: "open" }));
  const [publicBooking, setPublicBooking] = React.useState(false);
  const [toast, setToast] = React.useState(null);
  const [notifsOpen, setNotifsOpen] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);
  // Esc closes the phone menu drawer and the notifications list (a dialog
  // on top handles its own Esc first).
  React.useEffect(() => {
    if (!mobileNavOpen && !notifsOpen) return;
    const onKey = (e) => {
      if (e.key !== "Escape" || __openModals.length) return;
      setMobileNavOpen(false); setNotifsOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mobileNavOpen, notifsOpen]);
  // TEMPORARY isolated route for the historical patient import page (?import=1).
  // Bypasses auth/nav entirely. Remove this line, the early return below, and
  // src/import.jsx after the paper-record migration is complete.
  const importMode = ctx.kind === "import";
  // In the production build the import page is a separate chunk
  // (scripts/build.mjs) fetched only on this route; in dev, index.html has
  // already loaded src/import.jsx.
  const [importGateReady, setImportGateReady] = React.useState(() => !!window.ImportAuthGate);
  React.useEffect(() => {
    const chunk = window.KINETIC_CHUNKS && window.KINETIC_CHUNKS.importPage;
    if (!importMode || importGateReady || !chunk) return;
    loadScriptOnce(chunk).then(() => setImportGateReady(true)).catch(() =>
      window.showToast && window.showToast("تعذّر تحميل صفحة الاستيراد — تحقق من الاتصال", "error"));
  }, [importMode, importGateReady]);

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

  // The page in the address bar (#/<route>) while someone is signed in; a
  // route this role may not open is replaced by the role's home page.
  React.useEffect(() => {
    if (!user || importMode || user.role === "مريض" || !window.tenantWriteRouteHash) return;
    if (window.roleAllows && !window.roleAllows(user.role, rawRoute)) {
      navMode.current = "replace";
      setRoute(window.roleDefaultRoute ? window.roleDefaultRoute(user.role) : "dashboard");
      return;
    }
    window.tenantWriteRouteHash(rawRoute, navMode.current === "push");
    navMode.current = "replace";
  }, [rawRoute, user]);
  // Back / Forward (or an edited #/<route>) moves between pages.
  React.useEffect(() => {
    if (importMode || !window.tenantRouteFromHash) return;
    const onPop = () => {
      const r = window.tenantRouteFromHash();
      if (r) { navMode.current = "replace"; setRoute(r); }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  React.useEffect(()=>{
    window.showToast = (msg, kind="success") => {
      setToast({msg, kind});
      setTimeout(()=>setToast(null), 4000);
    };
  },[]);

  React.useEffect(()=>{
    if (!demo) return;
    if (user) localStorage.setItem("kinetic.user", JSON.stringify(user));
    else localStorage.removeItem("kinetic.user");
  },[user]);
  // An identity cached by an older version must not outlive a real login.
  React.useEffect(() => { if (!demo) { try { localStorage.removeItem("kinetic.user"); } catch {} } }, []);

  // ── Sign out (button, expired session, refused membership) ──
  // A forced sign-out keeps the page in the address, so signing in again
  // returns to it (docs/03 «انتهاء الجلسة»); the button starts afresh.
  async function doLogout(notice, { keepPage = !!notice } = {}) {
    try { if (window.signOut) await window.signOut(); } catch {}
    window.ME = null;
    if (!keepPage && window.tenantClearRouteHash) window.tenantClearRouteHash();
    setUser(null);
    setRoute("dashboard");
    if (gated) setGate({ phase: "open", notice: notice || null });
  }

  // ── Enter the clinic: the shell renders at once, the clinic context
  // (modules, branches, X-Branch-Id) and then the data load behind it ──
  function enterClinic(u, { restored } = {}) {
    window.ME = u;
    setUser(u);
    setGate({ phase: "open" });
    if (!restored) {
      const linked = window.tenantRouteFromHash ? window.tenantRouteFromHash() : null;
      setRoute(linked || (window.roleDefaultRoute ? window.roleDefaultRoute(u.role) : "dashboard"));
    }
    if (!window.tenantLoadClinicData) return;
    window.tenantLoadClinicData().then((res) => {
      if (res.ok) return;
      if (res.status === 401 || res.status === 403) {
        doLogout({ kind: "error", text: res.error || "انتهت الجلسة — سجّل الدخول من جديد" });
      } else if (window.showToast) {
        window.showToast(res.error || "تعذّر تحميل بيانات العيادة", "error");
      }
    }).catch((e) => console.warn("loading the clinic failed", e));
  }

  // ── The clinic gate: resolve the clinic, then restore the session ──
  React.useEffect(() => {
    if (!gated || gate.phase !== "resolving") return;
    let cancelled = false;
    (async () => {
      const r = await window.tenantResolveOrg(ctx.slug, ctx.invalidSlug);
      if (cancelled) return;
      if (r.state !== "active") { setGate({ phase: "status", status: r.state }); return; }
      window.tenantApplyOrg(r.org);
      const s = await window.tenantRestoreSession(ctx.slug);
      if (cancelled) return;
      if (s.state === "member") enterClinic(s.user, { restored: true });
      else if (s.state === "not-member") setGate({ phase: "status", status: "no-membership", session: s.session });
      else if (s.state === "error") setGate({ phase: "status", status: "error" });
      else setGate({ phase: "open", notice: s.notice || null });
    })().catch((e) => {
      console.warn("clinic gate failed", e);
      if (!cancelled) setGate({ phase: "status", status: "error" });
    });
    return () => { cancelled = true; };
  }, [gate.phase]);

  // ?import=1: the page has its own auth gate (src/import.jsx); the clinic
  // data its suggestions use loads once there is a session.
  React.useEffect(() => {
    if (!importMode || !window.SB || !ctx.slug || !window.tenantLoadClinicData) return;
    let loaded = false;
    const load = (session) => {
      if (loaded || !session || !window.tenantMembershipFor(session, ctx.slug)) return;
      loaded = true;
      window.tenantSetSession(session);
      window.tenantLoadClinicData().catch(() => {});
    };
    window.SB.auth.getSession().then(({ data }) => load(data && data.session)).catch(() => {});
    const off = window.onAuthChange ? window.onAuthChange((session) => load(session)) : () => {};
    return off;
  }, []);

  // Re-validate the session whenever the tab regains focus (and once on
  // mount for an identity the gate did not just verify). A deactivated
  // member, a disabled membership or a revoked session is signed out —
  // its data access is already refused by the API. Offline / server
  // errors keep the user signed in. Skips demo/mock logins.
  React.useEffect(() => {
    if (!user || user.role === "مريض") return;
    if (!window.getAuthStaff || demo || isDemoMode()) return;
    let cancelled = false;
    async function check() {
      try {
        const res = await window.getAuthStaff();
        if (cancelled) return;
        const stillMember = !ctx.slug || !window.tenantMembershipFor || window.tenantMembershipFor(res.session, ctx.slug);
        if (res.ok && stillMember) return;
        if (res.ok || ["account-inactive", "invalid-session", "no-session", "staff-lookup-failed"].includes(res.reason)) {
          const text = res.ok || res.reason === "staff-lookup-failed"
            ? "لم تعد لديك عضوية نشطة في هذه العيادة — تم تسجيل خروجك"
            : (res.error || "انتهت الجلسة — سجّل الدخول من جديد");
          if (window.showToast) window.showToast(text, "error");
          doLogout({ kind: "error", text });
        }
      } catch {}
    }
    if (!user.verifiedAt || Date.now() - user.verifiedAt > 5000) check();
    const onFocus = () => check();
    window.addEventListener("focus", onFocus);
    return () => { cancelled = true; window.removeEventListener("focus", onFocus); };
  }, [user]);

  function go(r) {
    if (r === "logout") {
      if (demo) {
        if (window.tenantClearRouteHash) window.tenantClearRouteHash();
        setUser(null); setRoute("dashboard"); return;
      }
      doLogout();
      return;
    }
    navMode.current = "push";
    setRoute(r);
    window.scrollTo({top:0, behavior:"smooth"});
  }
  // Expose the router to descendants that can't easily receive `go` via
  // props (e.g. modals opened deep inside pages).
  React.useEffect(() => { window.navigate = go; }, []);

  function handleLogin(u) {
    if (gated) enterClinic(u);
    else {
      window.ME = u;
      setUser(u);
      const linked = window.tenantRouteFromHash ? window.tenantRouteFromHash() : null;
      setRoute(linked || (window.roleDefaultRoute ? window.roleDefaultRoute(u.role) : "dashboard"));
    }
    setToast({ msg: `أهلاً بعودتك، ${u.name.split(" ")[0]}`, kind:"success" });
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

  if (gated && gate.phase === "resolving") return <TenantLoading text="جارٍ تحميل العيادة…"/>;
  if (gated && gate.phase === "status") {
    const session = gate.session || null;
    return <TenantStatusScreen status={gate.status}
      email={gate.status === "no-membership" && session && session.user ? session.user.email : ""}
      isSuperAdmin={gate.status === "no-membership" && !!(session && session.is_super_admin)}
      onLogout={gate.status === "no-membership" ? () => doLogout() : null}
      onRetry={gate.status === "error" ? () => setGate({ phase: "resolving" }) : null}/>;
  }

  if (!user) return <><AuthScreen onLogin={handleLogin} onBookAsGuest={()=>setPublicBooking(true)} notice={gate.notice}/>{toast && <Toast msg={toast.msg} kind={toast.kind}/>}</>;

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
  // A route of a module the clinic has not enabled (stored route, a link
  // inside a page, the command palette) shows why instead of the page.
  const moduleOff = !!(window.routeModuleEnabled && !window.routeModuleEnabled(route));

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
    branches:     { title:"الفروع",                crumb:["الرئيسية","الفروع"] },
    settings:     { title:"الإعدادات",             crumb:["الرئيسية","Settings"] },
  };

  // Notifications derived from real data — latest bookings, payments and
  // logged sessions (no canned entries).
  const notifs = [
    ...DATA.appts.filter(a=>a.status!=="متاح").slice(-2).map(a=>({ title:`موعد — ${a.patient}${a.time?` ${a.time}`:""}`, time:a.date||"", dot:"var(--blue-500)" })),
    ...DATA.payments.slice(-2).map(p=>({ title:`فاتورة ${p.id} — EGP ${(p.paid||0).toLocaleString("en-US")}`, time:p.date||"", dot:"var(--green)" })),
    ...DATA.sessions.slice(0,1).map(s=>({ title:`جلسة مسجلة — ${s.patient||""} #${s.session||""}`, time:s.date||"", dot:"var(--amber)" })),
  ].slice(0,5);

  return (
    <div style={{display:"flex",minHeight:"100vh",background:"var(--ink-50)"}}>
      {/* First Tab stop: past the menu and the top bar to the page (like the platform's). */}
      <a className="skip-link" href="#clinic-main" onClick={(e)=>{ e.preventDefault(); const m = document.getElementById("clinic-main"); if (m) m.focus(); }}>تخطَّ إلى المحتوى</a>
      <div className={"sidebar-backdrop" + (mobileNavOpen ? " open" : "")} onClick={()=>setMobileNavOpen(false)}/>
      <Sidebar active={route} onNav={(id)=>{ setMobileNavOpen(false); go(id); }} role={acct.role} user={acct} isOpen={mobileNavOpen}/>
      <div style={{flex:1,minWidth:0,display:"flex",flexDirection:"column"}}>
        {/* Inline topbar replaced — pages own their own headers for richer context */}
        <div className="topbar">
          <button type="button" className="mobile-menu-btn" aria-label="فتح القائمة" onClick={()=>setMobileNavOpen(o=>!o)}>
            <I.Menu size={18}/>
          </button>
          <div style={{flex:1,display:"flex",alignItems:"center",gap:12,minWidth:0}}>
            <span style={{fontSize:12,color:"var(--ink-500)",whiteSpace:"nowrap"}}>{acct.role}</span>
            <span aria-hidden="true" style={{color:"var(--ink-300)"}}>·</span>
            <span style={{fontSize:13,color:"var(--ink-700)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{activeBranchName()}</span>
            <span className="badge b-green topbar-online"><span className="dot" aria-hidden="true"></span>متصل</span>
          </div>
          {/* Its name is its visible text (WCAG 2.5.3); ⌘K is a hint only. */}
          <button type="button" className="search-wrap" onClick={()=>setPaletteOpen(true)} aria-haspopup="dialog"
            style={{position:"relative",width:"min(340px, 32vw)",height:36,padding:"0 34px",borderRadius:10,
              border:"1px solid var(--ink-200)",background:"var(--ink-50)",cursor:"pointer",
              alignItems:"center",gap:8,color:"var(--ink-500)",fontSize:13,fontFamily:"inherit"}}>
            <I.Search size={15} style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",color:"var(--ink-500)"}}/>
            <span style={{flex:1,textAlign:"start"}}>ابحث عن مرضى، مواعيد، فواتير…</span>
            <kbd className="mono" aria-hidden="true" style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",fontSize:10,color:"var(--ink-500)",background:"#fff",border:"1px solid var(--ink-200)",borderRadius:5,padding:"1px 5px"}}>⌘K</kbd>
          </button>
          {/* Phone: the full search bar collapses to this icon (opens the same palette) */}
          <button type="button" className="btn btn-ghost btn-icon mobile-search-btn" title="بحث" aria-label="فتح البحث الشامل" aria-haspopup="dialog" onClick={()=>setPaletteOpen(true)}>
            <I.Search size={17}/>
          </button>
          <div style={{position:"relative"}}>
            <button type="button" className="btn btn-ghost btn-icon" title="الإشعارات" aria-label={notifs.length ? `الإشعارات (${notifs.length})` : "الإشعارات"} aria-expanded={notifsOpen ? "true" : "false"} style={{position:"relative"}} onClick={()=>setNotifsOpen(o=>!o)}>
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
                      <div className="mono" style={{fontSize:11,color:"var(--ink-500)"}}>{n.time}</div>
                    </div>
                  </div>
                ))}
                <div style={{padding:"8px 16px 2px",textAlign:"center"}}>
                  <button className="btn btn-ghost" style={{fontSize:12,width:"100%"}} onClick={()=>setNotifsOpen(false)}>عرض كل الإشعارات</button>
                </div>
              </div>
            )}
          </div>
          <button type="button" className="btn btn-ghost btn-icon" title="مساعدة" aria-label="مساعدة" onClick={()=>window.showToast&&window.showToast("المساعدة قريبًا","info")}>
            <I.Sparkle size={17}/>
          </button>
        </div>

        <main id="clinic-main" tabIndex={-1} style={{flex:1,outline:"none"}}>
          {!demo && <InactiveBranchBanner/>}
          {moduleOff && <TenantModuleDisabled go={go}/>}
          {!moduleOff && <>
          {route==="dashboard" && <RoleHome role={acct.role} go={go} user={acct}/>}
          {route==="patients" && <Patients go={go}/>}
          {route==="appointments" && <Appointments go={go}/>}
          {route==="treatments" && <Treatments go={go}/>}
          {route==="sessions" && <Sessions go={go}/>}
          {route==="payments" && <Payments go={go}/>}
          {route==="packages" && <Packages go={go}/>}
          {route==="campaigns" && <Campaigns go={go}/>}
          {route==="reports" && <Reports go={go}/>}
          {route==="branches" && <BranchesPage go={go}/>}
          {route==="settings" && <SettingsPage go={go}/>}
          {typeof route === "string" && route.startsWith("custom:") && <CustomSectionPage id={route.slice(7)}/>}
          {!titles[route] && !(typeof route === "string" && route.startsWith("custom:")) && <NotFound go={go}/>}
          </>}
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
    setToast({ msg: `تم حجز موعدك يوم ${slot.date} الساعة ${slot.time}`, kind:"success" });
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
          <div className="av md" style={{background:"var(--blue-700)",color:"#fff"}}>{PATIENT_ME.initials}</div>
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
              <div className="av lg" aria-hidden="true" style={{background:c.color+"33",color:"var(--ink-900)"}}>{(c.name||"—").split(" ").slice(-2).map(x=>x[0]||"").join("")}</div>
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
              <div className="mono" style={{fontSize:11,opacity:.8,fontWeight:500}}>{/^\d{4}-\d{2}-\d{2}/.test(a.date) ? new Date(a.date).toLocaleDateString("ar-EG-u-nu-latn",{month:"short"}) : a.date.split("،")[0].slice(0,4)}</div>
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
              <div className="mono" style={{fontSize:11.5,color:"var(--ink-500)"}}>{a.time} · {a.dur} د</div>
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
          <div className="mono" style={{fontSize:26,fontWeight:600,marginTop:4}}>EGP {paidThisYear.toLocaleString("en-US")}</div>
        </div>
        <div className="card card-pad">
          <div className="muted" style={{fontSize:11,textTransform:"uppercase",letterSpacing:".05em"}}>معلّق</div>
          <div className="mono" style={{fontSize:26,fontWeight:600,marginTop:4,color:pending>0?"var(--red)":"var(--green)"}}>EGP {pending.toLocaleString("en-US")}</div>
        </div>
        <div className="card card-pad">
          <div className="muted" style={{fontSize:11,textTransform:"uppercase",letterSpacing:".05em"}}>جلسات متبقية</div>
          <div className="mono" style={{fontSize:26,fontWeight:600,marginTop:4}}>{PATIENT_ME.remaining} <span style={{fontSize:14,color:"var(--ink-500)"}}>/ {PATIENT_ME.total}</span></div>
        </div>
      </div>

      <div className="card" style={{overflow:"hidden"}}>
        <div className="tbl-scroll">
        <table className="tbl">
          <thead><tr><th>فاتورة</th><th>التاريخ</th><th>البند</th><th>المبلغ</th><th>الطريقة</th><th>الحالة</th><th><span className="sr-only">إجراءات</span></th></tr></thead>
          <tbody>
            {bills.length===0 && (
              <tr><td colSpan={7}><EmptyState icon={<I.FileText size={22}/>} title="لا فواتير بعد" body="ستظهر فواتيرك هنا بعد أول عملية دفع."/></td></tr>
            )}
            {bills.map(b=>(
              <tr key={b.id}>
                <td className="mono">{b.id}</td>
                <td>{b.date}</td>
                <td>{b.desc}</td>
                <td className="mono" style={{fontWeight:600}}>EGP {b.amount.toLocaleString("en-US")}</td>
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
  // A dialog like Modal (docs/04): role=dialog named by its title, focus
  // kept inside, Esc closes it, focus back to «احجز زيارة».
  const boxRef = React.useRef(null);
  const titleId = useDialogFocus(boxRef, true, confirming ? null : onClose);
  // A step's buttons leave with it: keep the focus in the dialog.
  React.useEffect(() => {
    const box = boxRef.current;
    if (box && !box.contains(document.activeElement)) __focusEl(box);
  }, [step, confirming]);

  // `patch`: a choice made by the same click that moves on (a reason or a
  // specialist card); React applies setPicks() on the next render, so the
  // step is checked against picks + patch.
  function next(patch) {
    const cur = patch ? { ...picks, ...patch } : picks;
    if (patch) setPicks(cur);
    // Validate the current step before advancing so incomplete state can't
    // silently slip through to booking. Each step guards its own field.
    if (step === 1 && !cur.reason) { if (window.showToast) window.showToast("اختر سبب الزيارة", "error"); return; }
    if (step === 2 && !cur.therapist) { if (window.showToast) window.showToast("اختر المعالج", "error"); return; }
    if (step === 3 && (!cur.date || !cur.time)) { if (window.showToast) window.showToast("اختر التاريخ والوقت", "error"); return; }
    // Reject past dates/times before persisting so the DB never sees them.
    if (step === 3) {
      const now = new Date(nowTick);
      const todayIso = __bkIso(now);
      const nowHM = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
      if (cur.date < todayIso || (cur.date === todayIso && cur.time <= nowHM)) {
        if (window.showToast) window.showToast("لا يمكن الحجز في وقت سابق", "error");
        return;
      }
    }
    if (step < 4) { setStep(step+1); return; }
    setConfirming(true);
    const me = getPatientMe();
    // Persist the booking so it appears in Appointments after the modal closes.
    if (window.KineticData) {
      const therapistRow = (DATA.therapists || []).find(t => t.name === cur.therapist);
      const bookingId = newRecordId("B-");
      window.KineticData.upsert("appts", {
        booking_id: bookingId,
        id: bookingId,
        patient_id: me.file,
        therapist_id: (therapistRow && (therapistRow.staff_id || therapistRow.id)) || null,
        th: cur.therapist || null,
        date: cur.date,
        time: cur.time,
        status: "مؤكد",
        notes: cur.reason || "",
      }).catch(e => console.warn("booking persist failed", e));
    }
    setTimeout(()=>{
      onDone(cur);
    }, 1100);
  }

  return (
    <div className="modal-backdrop" onClick={confirming ? undefined : onClose}>
      <DialogFocusGuard boxRef={boxRef} at="start"/>
      <div ref={boxRef} className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        style={{width:760,maxWidth:"calc(100% - 40px)",maxHeight:"calc(100vh - 60px)",padding:0,overflow:"hidden",outline:"none"}} onClick={e=>e.stopPropagation()}>
        {/* Header */}
        <div style={{padding:"18px 24px",borderBottom:"1px solid var(--ink-100)",display:"flex",alignItems:"center",gap:12}}>
          <div aria-hidden="true" style={{width:34,height:34,borderRadius:10,background:"var(--blue-100)",color:"var(--blue-700)",display:"flex",alignItems:"center",justifyContent:"center"}}>
            <I.Calendar size={17}/>
          </div>
          <div style={{flex:1}}>
            <h2 className="h3" id={titleId}>احجز زيارة</h2>
            <div className="muted" style={{fontSize:12}}>خطوة {step} من 4 — تستغرق عادةً 30 ثانية</div>
          </div>
          <button type="button" className="btn btn-ghost btn-icon" aria-label="إغلاق" onClick={onClose} disabled={confirming}><I.X size={16}/></button>
        </div>

        {/* Stepper */}
        <div aria-hidden="true" style={{padding:"14px 24px",background:"var(--ink-50)",borderBottom:"1px solid var(--ink-100)",display:"flex",gap:6}}>
          {[1,2,3,4].map(n=>(
            <div key={n} style={{
              flex:1,height:5,borderRadius:999,
              background: n<step?"var(--green)":n===step?"var(--blue-700)":"var(--ink-200)",
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
              <div className="muted" role="status">سيصلك التأكيد عبر واتساب على <bdi dir="ltr" className="mono">{PATIENT_ME.phone}</bdi>.</div>
            </div>
          ) : step===1 ? (
            <div>
              <div className="serif" style={{fontSize:26,marginBottom:6}}>ما الذي يحضرك إلينا؟</div>
              <div className="muted" style={{fontSize:13.5,marginBottom:22}}>يساعدنا ذلك على اختيار الأخصائي المناسب لك.</div>

              <div className="rgrid c-sm" style={{"--gtc":"1fr 1fr",gap:10}}>
                {[
                  { id:"continue", l:"متابعة خطتي",     sub:`${PATIENT_ME.remaining} جلسات متبقية${PATIENT_ME.diag&&PATIENT_ME.diag!=="—"?` · ${PATIENT_ME.diag}`:""}`, ic:<I.Heart size={18}/>, primary:true },
                  { id:"new",      l:"مشكلة جديدة",            sub:"شيء جديد يضايقك",                                  ic:<I.Plus size={18}/> },
                  { id:"followup", l:"متابعة مع الطبيب", sub:PATIENT_ME.doctor&&PATIENT_ME.doctor!=="—"?`متابعة مع ${PATIENT_ME.doctor}`:"متابعة مع طبيبك",                                   ic:<I.Stethoscope size={18}/> },
                  { id:"assess",   l:"تقييم أولي",   sub:"أول زيارة",                                                  ic:<I.Sparkle size={18}/> },
                ].map(o=>(
                  <button type="button" key={o.id} aria-pressed={picks.reason===o.id ? "true" : "false"} onClick={()=>next({ reason:o.id })} style={{
                    padding:18,textAlign:"start",cursor:"pointer",fontFamily:"inherit",
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
                    <I.ArrowLeft size={14} style={{color:"var(--ink-500)"}}/>
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
                  <button type="button" key={i} aria-pressed={picks.therapist===t.name ? "true" : "false"} onClick={()=>next({ therapist:t.name })} style={{
                    padding:16,textAlign:"start",cursor:"pointer",fontFamily:"inherit",
                    border:`1px solid ${picks.therapist===t.name?"var(--blue-500)":"var(--ink-200)"}`,
                    background: picks.therapist===t.name?"var(--blue-50)":"#fff",
                    borderRadius:14,display:"flex",alignItems:"center",gap:12,transition:"all .15s"
                  }}>
                    {t.any ? (
                      <div style={{width:44,height:44,borderRadius:12,background:"var(--ink-100)",display:"flex",alignItems:"center",justifyContent:"center",color:"var(--ink-700)",flexShrink:0}}>
                        <I.Users size={18}/>
                      </div>
                    ) : (
                      <div className="av lg" aria-hidden="true" style={{background:t.color+"33",color:"var(--ink-900)"}}>{t.name.split(" ").map(x=>x[0]).join("")}</div>
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
              <div className="muted" style={{fontSize:13.5,marginBottom:22}}>المواعيد المتاحة الآن مع {picks.therapist}.</div>

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
                          <button type="button" key={d.iso} disabled={full} aria-pressed={sel ? "true" : "false"} onClick={()=> !full && setPicks({...picks,date:d.iso})} style={{
                            padding:"10px 6px",cursor:full?"not-allowed":"pointer",fontFamily:"inherit",
                            border:`1px solid ${sel?"var(--blue-700)":"var(--ink-200)"}`,
                            background:sel?"var(--blue-700)":full?"var(--ink-50)":"#fff",
                            color:sel?"#fff":full?"var(--ink-500)":"var(--ink-900)",borderRadius:10,
                            opacity: full ? .6 : 1,
                          }}>
                            <div style={{fontWeight:600,fontSize:13}}>{d.weekday}</div>
                            <div className="mono" style={{fontSize:10.5,opacity:.7}}>{d.day} {d.month}</div>
                            <div style={{fontSize:10,marginTop:3,color:sel?"#fff":full?"var(--ink-500)":"#2C8067"}}>
                              {full ? "ممتلئ" : `متاح: ${d.slots}`}
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
                          <button type="button" key={t} disabled={unavail} aria-pressed={sel ? "true" : "false"} onClick={()=> !unavail && setPicks({...picks,time:t})}
                            title={isPast?"وقت سابق":isTaken?"محجوز":""}
                            style={{
                              padding:"8px 14px",minHeight:40,fontFamily:"inherit",cursor:unavail?"not-allowed":"pointer",
                              border:`1px solid ${sel?"var(--blue-700)":"var(--ink-200)"}`,
                              background:sel?"var(--blue-700)":unavail?"var(--ink-100)":"#fff",
                              color:sel?"#fff":unavail?"var(--ink-500)":"var(--ink-900)",
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
              <div className="muted" style={{fontSize:13.5,marginBottom:22}}>راجع التفاصيل ثم أكّد. يمكنك إعادة الجدولة أو الإلغاء حتى 4 ساعات قبل الموعد.</div>

              <div style={{
                padding:20,
                background:"linear-gradient(135deg, var(--blue-50), #fff)",
                border:"1px solid var(--blue-100)",borderRadius:14,marginBottom:14
              }}>
                <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:14}}>
                  <div>
                    <div style={{fontSize:11,color:"var(--ink-500)",marginBottom:4}}>موعدك</div>
                    <div className="mono" style={{fontSize:26,lineHeight:1.1}}>{picks.date}</div>
                    <div style={{fontSize:18,marginTop:4,color:"var(--blue-900)",fontWeight:600}}><span className="mono">{picks.time}</span> · {(window.calendarConfig ? window.calendarConfig().slotMinutes : 45)} دقيقة</div>
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
                    <div style={{fontWeight:500}}>{picks.reason==="new"?"تقييم مشكلة جديدة":picks.reason==="followup"?"متابعة مع الطبيب":picks.reason==="assess"?"تقييم أولي":"متابعة خطة العلاج"}</div>
                  </div>
                  <div>
                    <div className="muted" style={{fontSize:11}}>المكان</div>
                    <div style={{fontWeight:500}}>{(typeof activeBranchName === "function" && activeBranchName()) || (window.CLINIC && window.CLINIC.name) || "—"}</div>
                  </div>
                  <div>
                    <div className="muted" style={{fontSize:11}}>التكلفة</div>
                    <div style={{fontWeight:500}}>{picks.reason==="continue" ? "من الباقة" : "EGP 850"}</div>
                  </div>
                </div>
              </div>

              <label style={{display:"flex",alignItems:"flex-start",gap:10,padding:14,background:"var(--ink-50)",borderRadius:10,fontSize:12.5,cursor:"pointer"}}>
                <input type="checkbox" defaultChecked style={{marginTop:2}}/>
                <span>أرسل لي تذكيرًا عبر واتساب قبل الزيارة بـ 24 ساعة على <bdi dir="ltr" className="mono">{PATIENT_ME.phone}</bdi>.</span>
              </label>
            </div>
          )}
        </div>

        {/* Footer */}
        {!confirming && (
          <div style={{padding:"14px 24px",borderTop:"1px solid var(--ink-100)",display:"flex",alignItems:"center",justifyContent:"space-between",background:"#fff",flexWrap:"wrap",gap:8}}>
            <button type="button" className="btn btn-ghost" onClick={step===1?onClose:()=>setStep(step-1)}>
              {step===1 ? "إلغاء" : <><I.ArrowLeft size={13}/> رجوع</>}
            </button>
            <div style={{display:"flex",alignItems:"center",gap:14}}>
              {step>=3 && (
                <span className="muted mono" style={{fontSize:12}}>
                  {picks.date} · {picks.time}
                </span>
              )}
              <button type="button" className="btn btn-blue" onClick={()=>next()} disabled={step===1 && !picks.reason}>
                {step<4 ? "متابعة" : "تأكيد الحجز"} <I.ArrowRight size={13}/>
              </button>
            </div>
          </div>
        )}
      </div>
      <DialogFocusGuard boxRef={boxRef} at="end"/>
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
      const bookingId = newRecordId("B-");
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
                          <div className="av lg" aria-hidden="true" style={{background:t.color+"33",color:"var(--ink-900)"}}>{t.name.split(" ").map(x=>x[0]).join("")}</div>
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

