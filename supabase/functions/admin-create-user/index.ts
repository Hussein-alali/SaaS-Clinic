// ═══════════════════════════════════════════════════════════════════════
// Edge Function: admin-create-user
//
// Purpose: create clinic staff accounts without going through the anon
// signUp flow (which is rate-limited by the GoTrue SMTP quota — that's
// the "email rate limit exceeded" the client kept hitting) and without
// requiring the new user to confirm their email.
//
// Auth model:
//   • The caller MUST send their session JWT in `Authorization: Bearer
//     <token>`.
//   • This function decodes the JWT with the anon client, verifies the
//     caller's app_role() is 'admin', and only then uses the service
//     role key (from env, never shipped to the browser) to call
//     `auth.admin.createUser`.
//
// Deploy (see also deploy-edge-function.sh in the repo root):
//   supabase functions deploy admin-create-user --no-verify-jwt
//
// Env: SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are
// injected into Edge Functions automatically by the platform — nothing
// to configure manually.
// ═══════════════════════════════════════════════════════════════════════

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ROLE_SLUGS = new Set(["admin", "receptionist", "doctor", "therapist"]);

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
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return json({ ok: false, error: "missing_token" }, 401);

  const anon = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: userData, error: userErr } = await anon.auth.getUser(token);
  if (userErr || !userData?.user)
    return json({ ok: false, error: "invalid_token" }, 401);

  // Role source of truth is the staff table (same as public.app_role()
  // in RLS); JWT metadata is only a fallback for legacy accounts.
  const svc = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: staffRow } = await svc
    .from("staff").select("role").eq("auth_uid", userData.user.id).maybeSingle();
  const callerRole =
    staffRow?.role ??
    (userData.user.app_metadata as any)?.role ??
    (userData.user.user_metadata as any)?.role ??
    null;
  if (callerRole !== "admin")
    return json({ ok: false, error: "forbidden" }, 403);

  // 2) Validate the request payload.
  let body: any = {};
  try { body = await req.json(); } catch { /* empty body */ }
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const name = String(body.name || "").trim();
  const role = String(body.role || "receptionist");
  const phone = body.phone != null ? String(body.phone).trim() : null;

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return json({ ok: false, error: "invalid_email" }, 400);
  if (password.length < 6)
    return json({ ok: false, error: "weak_password" }, 400);
  if (!ROLE_SLUGS.has(role))
    return json({ ok: false, error: "invalid_role" }, 400);
  if (!name)
    return json({ ok: false, error: "missing_name" }, 400);

  // 3) Create the auth user with the service role. `email_confirm: true`
  // skips the confirmation email entirely — this is the internal-staff
  // workflow the PRD asks for.
  const admin = svc;

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name, role },
    app_metadata:  { role },      // JWT reads app_role() from here
  });
  if (createErr) {
    const msg = (createErr.message || "").toLowerCase();
    let code = "create_failed";
    if (msg.includes("already registered") || msg.includes("duplicate")) code = "email_exists";
    else if (msg.includes("password")) code = "weak_password";
    else if (msg.includes("rate")) code = "rate_limited";
    return json({ ok: false, error: code, detail: createErr.message }, 400);
  }
  const uid = created?.user?.id ?? null;
  if (!uid) return json({ ok: false, error: "create_failed" }, 500);

  // 4) Mirror into the staff table (RLS is bypassed by service role).
  const staffId = "U-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const { error: staffErr } = await admin.from("staff").insert({
    staff_id:   staffId,
    name,
    email,
    role,
    phone,
    status:     "active",
    auth_uid:   uid,
    created_by: userData.user.id,
  });
  if (staffErr) {
    // Roll back the auth user so the two tables never drift.
    await admin.auth.admin.deleteUser(uid).catch(() => {});
    return json({ ok: false, error: "staff_insert_failed", detail: staffErr.message }, 500);
  }

  return json({ ok: true, uid, staff_id: staffId });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}
