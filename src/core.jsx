

// ===== src/icons.jsx =====
// Minimal inline icon set (Lucide-style strokes, 1.6 weight)
const Icon = ({ d, size = 16, stroke = 1.6, fill = "none", style, ...rest }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke="currentColor"
    strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round"
    style={{ flexShrink: 0, ...style }} {...rest}>
    {typeof d === "string" ? <path d={d} /> : d}
  </svg>
);

const I = {
  Logo: (p) => (
    <svg width={p.size || 28} height={p.size || 28} viewBox="0 0 32 32" fill="none" {...p}>
      <rect x="2" y="2" width="28" height="28" rx="9" fill="#7BBDE8"/>
      <path d="M10 22 L13 14 L16 19 L19 11 L22 22" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
      <circle cx="22" cy="22" r="1.6" fill="#fff"/>
    </svg>
  ),
  Search: (p)=> <Icon {...p} d={<><circle cx="11" cy="11" r="7"/><path d="m20 20-3-3"/></>}/>,
  Bell:   (p)=> <Icon {...p} d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21a2 2 0 0 0 4 0"/>,
  Plus:   (p)=> <Icon {...p} d="M12 5v14M5 12h14"/>,
  Chevron:(p)=> <Icon {...p} d="m9 18 6-6-6-6"/>,
  ChevronDown:(p)=> <Icon {...p} d="m6 9 6 6 6-6"/>,
  ChevronUp:(p)=> <Icon {...p} d="m18 15-6-6-6 6"/>,
  Dashboard: (p)=> <Icon {...p} d={<><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></>}/>,
  Users:  (p)=> <Icon {...p} d={<><path d="M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"/><circle cx="10" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></>}/>,
  Calendar:(p)=> <Icon {...p} d={<><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></>}/>,
  Clipboard:(p)=> <Icon {...p} d={<><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M9 12h6M9 16h4"/></>}/>,
  Activity:(p)=> <Icon {...p} d="M22 12h-4l-3 9L9 3l-3 9H2"/>,
  Package:(p)=> <Icon {...p} d={<><path d="m7.5 4.27 9 5.15"/><path d="M21 8.5 12 14 3 8.5"/><path d="M3 8.5v7L12 21l9-5.5v-7L12 3 3 8.5Z"/><path d="M12 14v7"/></>}/>,
  CreditCard:(p)=> <Icon {...p} d={<><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h2"/></>}/>,
  FileText:(p)=> <Icon {...p} d={<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/></>}/>,
  Chart:  (p)=> <Icon {...p} d={<><path d="M3 3v18h18"/><path d="M7 14l4-4 4 3 6-7"/></>}/>,
  Send:   (p)=> <Icon {...p} d="m22 2-7 20-4-9-9-4 20-7Z"/>,
  Settings:(p)=> <Icon {...p} d={<><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></>}/>,
  Phone:  (p)=> <Icon {...p} d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.37 1.9.72 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.35 1.85.59 2.81.72A2 2 0 0 1 22 16.92Z"/>,
  Mail:   (p)=> <Icon {...p} d={<><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 6-10 7L2 6"/></>}/>,
  MapPin: (p)=> <Icon {...p} d={<><path d="M20 10c0 7-8 12-8 12s-8-5-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></>}/>,
  User:   (p)=> <Icon {...p} d={<><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></>}/>,
  Edit:   (p)=> <Icon {...p} d={<><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z"/></>}/>,
  Trash:  (p)=> <Icon {...p} d={<><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6 18 20a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></>}/>,
  Filter: (p)=> <Icon {...p} d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/>,
  Menu:   (p)=> <Icon {...p} d="M3 6h18M3 12h18M3 18h18"/>,
  More:   (p)=> <Icon {...p} d={<><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></>}/>,
  Download:(p)=> <Icon {...p} d={<><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/></>}/>,
  Print:  (p)=> <Icon {...p} d={<><path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></>}/>,
  Check:  (p)=> <Icon {...p} d="M20 6 9 17l-5-5"/>,
  X:      (p)=> <Icon {...p} d="M18 6 6 18M6 6l12 12"/>,
  Eye:    (p)=> <Icon {...p} d={<><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"/><circle cx="12" cy="12" r="3"/></>}/>,
  Upload: (p)=> <Icon {...p} d={<><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5M12 3v12"/></>}/>,
  Image:  (p)=> <Icon {...p} d={<><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></>}/>,
  Clock:  (p)=> <Icon {...p} d={<><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></>}/>,
  Heart:  (p)=> <Icon {...p} d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78Z"/>,
  Dollar: (p)=> <Icon {...p} d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>,
  Stethoscope:(p)=> <Icon {...p} d={<><path d="M4.8 2.3A.3.3 0 1 0 5 2H4a2 2 0 0 0-2 2v5a6 6 0 0 0 6 6v0a6 6 0 0 0 6-6V4a2 2 0 0 0-2-2h-1a.2.2 0 1 0 .3.3"/><path d="M8 15v1a6 6 0 0 0 6 6v0a6 6 0 0 0 6-6v-4"/><circle cx="20" cy="10" r="2"/></>}/>,
  ArrowUp:(p)=> <Icon {...p} d="M12 19V5M5 12l7-7 7 7"/>,
  ArrowDown:(p)=> <Icon {...p} d="M12 5v14M5 12l7 7 7-7"/>,
  ArrowRight:(p)=> <Icon {...p} d="M5 12h14M12 5l7 7-7 7"/>,
  ArrowLeft:(p)=> <Icon {...p} d="M19 12H5M12 19l-7-7 7-7"/>,
  Wave:   (p)=> <Icon {...p} d="M2 12c2-3 4-3 6 0s4 3 6 0 4-3 6 0 4 3 6 0"/>,
  Sun:    (p)=> <Icon {...p} d={<><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></>}/>,
  Moon:   (p)=> <Icon {...p} d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z"/>,
  WhatsApp:(p)=> <Icon {...p} d={<><path d="M3 21l1.6-5.8A8.5 8.5 0 1 1 8.6 19.4L3 21Z"/><path d="M8.3 9.1c.4 1 1 2 2 3s2 1.5 3 1.9c.4.2.8.1 1.1-.1l.7-.7c.2-.2.5-.3.8-.2.6.2 1.2.3 1.9.4.4.1.7.4.7.8v.8c0 .4-.2.8-.5 1-1.3.7-2.7.9-4 .5-2.6-.8-4.5-2.7-5.3-5.3-.4-1.3-.2-2.7.5-4 .2-.3.6-.5 1-.5h.8c.4 0 .7.3.8.7.1.7.2 1.3.4 1.9.1.3 0 .6-.2.8l-.7.7c-.2.3-.3.7-.1 1.1z" fill="currentColor" stroke="none"/></>}/>,
  Logout: (p)=> <Icon {...p} d={<><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/></>}/>,
  Lock:   (p)=> <Icon {...p} d={<><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></>}/>,
  Mic:    (p)=> <Icon {...p} d={<><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4M8 22h8"/></>}/>,
  Megaphone:(p)=> <Icon {...p} d={<><path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/></>}/>,
  Layers: (p)=> <Icon {...p} d="m12 2 10 6-10 6L2 8l10-6zM2 16l10 6 10-6M2 12l10 6 10-6"/>,
  Pin:    (p)=> <Icon {...p} d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16h14v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>,
  Sparkle:(p)=> <Icon {...p} d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>,
  Drag:   (p)=> <Icon {...p} d={<><circle cx="9" cy="6" r="1.2"/><circle cx="15" cy="6" r="1.2"/><circle cx="9" cy="12" r="1.2"/><circle cx="15" cy="12" r="1.2"/><circle cx="9" cy="18" r="1.2"/><circle cx="15" cy="18" r="1.2"/></>}/>,
};

window.I = I;
window.Icon = Icon;


// ===== src/data.jsx =====
// Domain data lives in PostgreSQL (Supabase). window.DATA is the
// in-memory mirror hydrated on boot by hydrateDomainTables(); every
// CRUD path goes through KineticData.upsert / remove, which writes
// through to Supabase and republishes the mirror. No seed/mock data.

/* Removed: seed arrays for patients, appointments, therapists, departments,
   doctors, packages, payments, campaigns, sessions. Production hydrates
   from PostgreSQL (Supabase) via hydrateDomainTables(). No demo path. */

window.DATA = {
  patients: [], appts: [], therapists: [], departments: [], doctors: [],
  receptionists: [], schedules: [],
  packages: [], payments: [], campaigns: [], sessions: [],
  paymentHistory: [], subscriptions: [], treatmentMethods: [],
};

// ── Reactive data hook ─────────────────────────────────────────
// Components that read from window.DATA.* should call useDataVersion()
// so they re-render when any table is upserted/removed/hydrated.
// Emits the same event (kinetic:data-updated) already dispatched by
// KineticData.upsert/remove and hydrateDomainTables. Also reacts to
// kinetic:clinic-updated so calendar working hours / slot duration
// changes propagate to every open calendar without a reload.
function useDataVersion() {
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    const on = () => setTick(t => t + 1);
    window.addEventListener("kinetic:data-updated", on);
    window.addEventListener("kinetic:clinic-updated", on);
    return () => {
      window.removeEventListener("kinetic:data-updated", on);
      window.removeEventListener("kinetic:clinic-updated", on);
    };
  }, []);
  return tick;
}
window.useDataVersion = useDataVersion;


// ===== src/charts.jsx =====
// Lightweight SVG charts — no external lib. Tabular numerics, brand blues.

// ── Shared hook: observe container width ──────────────────────
function useContainerWidth(initialWidth) {
  const ref = React.useRef(null);
  const [w, setW] = React.useState(initialWidth);
  React.useEffect(() => {
    if (!ref.current) return;
    const measure = () => { if (ref.current) setW(ref.current.clientWidth); };
    // Measure synchronously on mount — the observer's initial notification
    // can be missed, leaving the chart at its fallback width.
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

// ── Shared chart constants ─────────────────────────────────────
const CHART_PAD = { L: 38, R: 12, T: 10, B: 22 };
const Y_TICKS = 4;

// Placeholder rendered by every chart when there are no points yet —
// production starts with an empty DB, so charts must not crash on [].
function ChartEmpty({ height }) {
  return (
    <div style={{height, display:"flex", alignItems:"center", justifyContent:"center",
      background:"var(--ink-50)", borderRadius:10, color:"var(--ink-400)", fontSize:12.5}}>
      لا توجد بيانات بعد
    </div>
  );
}

// Smooth area / line chart
function AreaChart({ data, height = 160, color = "#7BBDE8", fill = "rgba(123,189,232,.22)", showGrid = true, showAxis = true, formatY = (v)=>v }) {
  const [ref, w] = useContainerWidth(600);
  if (!data || data.length === 0) return <ChartEmpty height={height}/>;
  const { L: padL, R: padR, T: padT, B: padB } = CHART_PAD;
  const innerW = Math.max(w - padL - padR, 50);
  const innerH = height - padT - padB;
  const max = Math.max(...data.map(d => d.v)) * 1.15 || 1;
  const min = 0;
  const stepX = innerW / Math.max(data.length - 1, 1);
  const pts = data.map((d,i) => ({
    x: padL + i * stepX,
    y: padT + innerH - ((d.v - min) / (max - min)) * innerH,
    v: d.v, label: d.label,
  }));
  // Catmull-Rom-ish smooth
  const path = pts.map((p,i) => i===0 ? `M ${p.x} ${p.y}` :
    `C ${pts[i-1].x + stepX/2} ${pts[i-1].y}, ${p.x - stepX/2} ${p.y}, ${p.x} ${p.y}`
  ).join(" ");
  const areaPath = `${path} L ${pts[pts.length-1].x} ${padT+innerH} L ${pts[0].x} ${padT+innerH} Z`;
  const ticks = Array.from({length:Y_TICKS+1},(_,i)=> min + (max-min)*(i/Y_TICKS));
  return (
    <div ref={ref} style={{width:"100%"}}>
      <svg width={w} height={height} style={{maxWidth:"100%",display:"block"}}>
        {showGrid && ticks.map((t,i) => {
          const y = padT + innerH - ((t-min)/(max-min))*innerH;
          return (
            <g key={i}>
              <line x1={padL} x2={w-padR} y1={y} y2={y} stroke="#EEF2F6" />
              {showAxis && <text x={padL-6} y={y+3} fontSize="10" textAnchor="end" fill="#8898A8" fontFamily="Geist Mono">{formatY(Math.round(t))}</text>}
            </g>
          );
        })}
        <path d={areaPath} fill={fill} />
        <path d={path} fill="none" stroke={color} strokeWidth="2" />
        {pts.map((p,i)=> (
          <g key={i}>
            <circle cx={p.x} cy={p.y} r="2.5" fill="#fff" stroke={color} strokeWidth="1.6" />
            {showAxis && <text x={p.x} y={height-6} fontSize="10" textAnchor="middle" fill="#8898A8" fontFamily="Geist Mono">{p.label}</text>}
          </g>
        ))}
      </svg>
    </div>
  );
}

function BarChart({ data, height = 160, color = "#7BBDE8", showAxis = true, formatY = (v)=>v }) {
  const [ref, w] = useContainerWidth(600);
  if (!data || data.length === 0) return <ChartEmpty height={height}/>;
  const { L: padL, R: padR, T: padT, B: padB } = CHART_PAD;
  const innerW = Math.max(w - padL - padR, 50);
  const innerH = height - padT - padB;
  const max = Math.max(...data.map(d => d.v)) * 1.15 || 1;
  const bandW = innerW / data.length;
  const barW = Math.min(bandW * 0.62, 26);
  const ticks = Array.from({length:Y_TICKS+1},(_,i)=> (max)*(i/Y_TICKS));
  return (
    <div ref={ref} style={{width:"100%"}}>
      <svg width={w} height={height} style={{maxWidth:"100%",display:"block"}}>
        {ticks.map((t,i) => {
          const y = padT + innerH - (t/max)*innerH;
          return (
            <g key={i}>
              <line x1={padL} x2={w-padR} y1={y} y2={y} stroke="#EEF2F6" />
              {showAxis && <text x={padL-6} y={y+3} fontSize="10" textAnchor="end" fill="#8898A8" fontFamily="Geist Mono">{formatY(Math.round(t))}</text>}
            </g>
          );
        })}
        {data.map((d,i)=> {
          const x = padL + i*bandW + (bandW-barW)/2;
          const h = (d.v/max)*innerH;
          const y = padT + innerH - h;
          return (
            <g key={i}>
              <rect x={x} y={y} width={barW} height={h} rx="4" fill={d.color || color} />
              {showAxis && <text x={x+barW/2} y={height-6} fontSize="10" textAnchor="middle" fill="#8898A8" fontFamily="Geist Mono">{d.label}</text>}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function DonutChart({ data, size=160, thickness=22, centerLabel, centerValue }) {
  if (!data || data.length === 0 || data.every(d => !d.v)) return <ChartEmpty height={size}/>;
  const total = data.reduce((s,d)=>s+d.v,0) || 1;
  const r = (size - thickness) / 2;
  const cx = size/2, cy = size/2;
  let acc = 0;
  const arcs = data.map((d,i) => {
    const start = acc/total * Math.PI*2 - Math.PI/2;
    acc += d.v;
    const end = acc/total * Math.PI*2 - Math.PI/2;
    const large = end - start > Math.PI ? 1 : 0;
    const x1 = cx + r*Math.cos(start), y1 = cy + r*Math.sin(start);
    const x2 = cx + r*Math.cos(end),   y2 = cy + r*Math.sin(end);
    return { d:`M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`, color: d.color, label:d.label, v:d.v };
  });
  return (
    <div style={{display:"flex",gap:18,alignItems:"center",flexWrap:"wrap"}}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{flexShrink:1,maxWidth:"100%"}}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="#EEF2F6" strokeWidth={thickness} />
        {arcs.map((a,i)=>(
          <path key={i} d={a.d} fill="none" stroke={a.color} strokeWidth={thickness} strokeLinecap="butt" />
        ))}
        {centerLabel && (
          <g>
            <text x={cx} y={cy-4} textAnchor="middle" fontSize="22" fontWeight="600" fill="#0F1E2B" fontFamily="Geist Mono">{centerValue}</text>
            <text x={cx} y={cy+14} textAnchor="middle" fontSize="10" fill="#8898A8" letterSpacing=".05em">{centerLabel}</text>
          </g>
        )}
      </svg>
      <div style={{display:"flex",flexDirection:"column",gap:8}}>
        {arcs.map((a,i)=>(
          <div key={i} style={{display:"flex",alignItems:"center",gap:8,fontSize:12.5}}>
            <span style={{width:10,height:10,borderRadius:3,background:a.color}}></span>
            <span style={{color:"#2E4458"}}>{a.label}</span>
            <span className="mono" style={{color:"#8898A8",marginLeft:"auto",paddingLeft:14}}>{Math.round(a.v/total*100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Sparkline({ data, width=120, height=36, color="#7BBDE8" }) {
  if (!data || data.length === 0) return null;
  const max = Math.max(...data), min = Math.min(...data);
  const stepX = width / (data.length-1 || 1);
  const pts = data.map((v,i)=>`${i*stepX},${height - ((v-min)/((max-min)||1))*height}`);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{display:"block",maxWidth:"100%"}}>
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

Object.assign(window, { AreaChart, BarChart, DonutChart, Sparkline });
