// ═══════════════════════════════════════════════════════════════════════
// Edge Function: admin-reset-password
//
// Purpose: let a clinic administrator set a NEW password for any staff
// account WITHOUT knowing the current one, using the Supabase Auth Admin
// API (auth.admin.updateUserById) — never by touching password hashes or
// the database directly. Password hashes are never returned to the client.
//
// Auth model (identical to admin-create-user):
//   • Caller MUST send their session JWT in `Authorization: Bearer <token>`.
//   • We decode it, verify the caller's staff.role is 'admin', and only
//     then use the service-role key (env, never shipped to the browser).
//
// Request body: { staff_id?: string, auth_uid?: string, password: string }
//   Identify the target by staff_id (preferred) or auth_uid.
//
// Side effect: writes an audit_events row { action:'staff.password_reset',
//   actor_uid, actor_role, table_name:'staff', row_pk:<staff_id>,
//   payload:{ staff_id, staff_email, ip } }.
//
// Deploy:
//   supabase functions deploy admin-reset-password --no-verify-jwt
// ═══════════════════════════════════════════════════════════════════════

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST")
    return json({ ok: false, error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey)
    return json({ ok: false, error: "server_misconfigured" }, 500);

  // 1) Verify the caller is an authenticated admin using their own JWT.
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

  // 2) Validate payload.
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  const staffId = body.staff_id != null ? String(body.staff_id).trim() : "";
  const authUid = body.auth_uid != null ? String(body.auth_uid).trim() : "";
  const password = String(body.password || "");
  if (!staffId && !authUid) return json({ ok: false, error: "missing_target" }, 400);
  if (password.length < 6) return json({ ok: false, error: "weak_password" }, 400);

  // 3) Resolve the target staff row (source of the auth_uid to update).
  const q = svc.from("staff").select("staff_id,email,auth_uid,name");
  const { data: target, error: targetErr } = staffId
    ? await q.eq("staff_id", staffId).maybeSingle()
    : await q.eq("auth_uid", authUid).maybeSingle();
  if (targetErr) return json({ ok: false, error: "lookup_failed", detail: targetErr.message }, 500);
  if (!target) return json({ ok: false, error: "staff_not_found" }, 404);
  if (!target.auth_uid) return json({ ok: false, error: "no_auth_account" }, 400);

  // 4) Set the new password via the Auth Admin API (never touches hashes
  //    in SQL). This transparently invalidates nothing else; the user can
  //    sign in immediately with the new password.
  const { error: updErr } = await svc.auth.admin.updateUserById(target.auth_uid, { password });
  if (updErr) {
    const msg = (updErr.message || "").toLowerCase();
    const code = msg.includes("password") ? "weak_password" : "update_failed";
    return json({ ok: false, error: code, detail: updErr.message }, 400);
  }

  // 5) Audit (best-effort — never block the reset on a log write).
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") || null;
  await svc.from("audit_events").insert({
    actor_uid: userData.user.id,
    actor_role: "admin",
    action: "staff.password_reset",
    table_name: "staff",
    row_pk: target.staff_id,
    payload: { staff_id: target.staff_id, staff_email: target.email, ip },
  }).then(() => {}, () => {});

  return json({ ok: true, staff_id: target.staff_id });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}
