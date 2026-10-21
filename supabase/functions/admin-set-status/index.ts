// ═══════════════════════════════════════════════════════════════════════
// Edge Function: admin-set-status
//
// Purpose: let a clinic administrator ACTIVATE or DEACTIVATE any staff
// account. Deactivation:
//   • flips staff.status to 'inactive' (public.app_role() then returns
//     NULL for that user, so every RLS policy denies them — this is the
//     server-side teeth: even an old, still-valid access token can read
//     nothing);
//   • bans the Auth user (ban_duration) so token REFRESH fails and no new
//     sign-in succeeds, forcing the session to die;
//   • keeps the row + all historical data intact (no deletes).
// Reactivation flips status back to 'active' and lifts the ban.
//
// Auth model: caller MUST send their session JWT; we verify staff.role is
// 'admin' before using the service-role key.
//
// Request body: { staff_id: string, active: boolean }
//
// Side effect: audit_events { action:'staff.activate'|'staff.deactivate',
//   payload:{ staff_id, staff_email, prev_status, new_status, ip } }.
//
// Deploy: supabase functions deploy admin-set-status --no-verify-jwt
// ═══════════════════════════════════════════════════════════════════════

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ~100 years — effectively permanent until explicitly lifted with "none".
const BAN_FOREVER = "876000h";

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST")
    return json({ ok: false, error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey)
    return json({ ok: false, error: "server_misconfigured" }, 500);

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ ok: false, error: "missing_token" }, 401);

  const anon = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: userData, error: userErr } = await anon.auth.getUser(token);
  if (userErr || !userData?.user)
    return json({ ok: false, error: "invalid_token" }, 401);

  const svc = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: callerRow } = await svc
    .from("staff").select("role,status").eq("auth_uid", userData.user.id).maybeSingle();
  const callerRole =
    (callerRow?.status === "active" ? callerRow?.role : null) ??
    (userData.user.app_metadata as any)?.role ??
    null;
  if (callerRole !== "admin")
    return json({ ok: false, error: "forbidden" }, 403);

  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  const staffId = body.staff_id != null ? String(body.staff_id).trim() : "";
  const active = body.active === true;
  if (!staffId) return json({ ok: false, error: "missing_target" }, 400);

  const { data: target, error: targetErr } = await svc
    .from("staff").select("staff_id,email,auth_uid,status").eq("staff_id", staffId).maybeSingle();
  if (targetErr) return json({ ok: false, error: "lookup_failed", detail: targetErr.message }, 500);
  if (!target) return json({ ok: false, error: "staff_not_found" }, 404);

  // Guard: an admin must never lock themselves out.
  if (target.auth_uid && target.auth_uid === userData.user.id && !active)
    return json({ ok: false, error: "cannot_deactivate_self" }, 400);

  const prevStatus = target.status || "active";
  const newStatus = active ? "active" : "inactive";

  // 1) Flip the DB flag (the RLS enforcement point).
  const { error: updErr } = await svc
    .from("staff").update({ status: newStatus }).eq("staff_id", staffId);
  if (updErr) return json({ ok: false, error: "update_failed", detail: updErr.message }, 500);

  // 2) Ban / unban the Auth user so token refresh + fresh sign-in respect
  //    the change. Best-effort: the DB flag is already authoritative for
  //    data access, so a transient Auth-admin hiccup must not fail the op.
  if (target.auth_uid) {
    await svc.auth.admin
      .updateUserById(target.auth_uid, { ban_duration: active ? "none" : BAN_FOREVER })
      .then(() => {}, () => {});
    // Also revoke existing refresh tokens on deactivation, where supported,
    // so the session cannot be silently extended.
    if (!active && typeof (svc.auth.admin as any).signOut === "function") {
      await (svc.auth.admin as any).signOut(target.auth_uid, "global").then(() => {}, () => {});
    }
  }

  // 3) Audit.
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") || null;
  await svc.from("audit_events").insert({
    actor_uid: userData.user.id,
    actor_role: "admin",
    action: active ? "staff.activate" : "staff.deactivate",
    table_name: "staff",
    row_pk: target.staff_id,
    payload: {
      staff_id: target.staff_id, staff_email: target.email,
      prev_status: prevStatus, new_status: newStatus, ip,
    },
  }).then(() => {}, () => {});

  return json({ ok: true, staff_id: target.staff_id, status: newStatus });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}
