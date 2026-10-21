-- ============================================================
-- Kinetic — Main admin account: "amir"
--
-- Run this ONCE in the Supabase SQL editor, AFTER running
-- supabase-schema.sql.
--
--   Email:    amr@clinic.eg
--   Password: Amr@2026!     ←  CHANGE THIS after first login
--                                (Supabase Dashboard → Authentication →
--                                 Users → amr@clinic.eg → Reset password)
--
-- What it does:
--   1. Creates the Supabase Auth user (role "admin" is kept in
--      user_metadata for display, but permissions come from staff).
--   2. Creates the matching row in the `staff` table, linked via
--      auth_uid. This row is what public.app_role() and the app read
--      to authorize the user — it MUST exist for the account to work.
--
-- Safe to re-run: it skips the auth user if the email already exists
-- and upserts the staff row.
-- ============================================================

create extension if not exists pgcrypto;

do $$
declare
  uid uuid;
begin
  select id into uid from auth.users where email = 'amr@clinic.eg';

  if uid is null then
    uid := gen_random_uuid();

    -- NOTE: the *_token / *_change columns must be '' (not NULL) — GoTrue
    -- returns 500 "Database error" on login when they are NULL, which is
    -- the classic pitfall of SQL-created auth users.
    insert into auth.users (
      instance_id, id, aud, role, email,
      encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data,
      created_at, updated_at,
      confirmation_token, recovery_token,
      email_change, email_change_token_new, email_change_token_current,
      phone_change, phone_change_token, reauthentication_token,
      is_sso_user
    ) values (
      '00000000-0000-0000-0000-000000000000',
      uid,
      'authenticated',
      'authenticated',
      'amr@clinic.eg',
      crypt('Amr@2026!', gen_salt('bf')),
      now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      '{"role":"admin","name":"أمير"}'::jsonb,
      now(), now(),
      '', '',
      '', '', '',
      '', '',
      '',
      false
    );

    insert into auth.identities (
      id, user_id, provider_id, identity_data, provider,
      last_sign_in_at, created_at, updated_at
    ) values (
      gen_random_uuid(),
      uid,
      uid::text,
      jsonb_build_object('sub', uid::text, 'email', 'amr@clinic.eg', 'email_verified', true),
      'email',
      now(), now(), now()
    );
  end if;

  -- Repair pass: if the user was created by an earlier version of this
  -- script (or any SQL insert) with NULL token columns, GoTrue answers
  -- every login with 500. Normalize them to '' so sign-in works.
  update auth.users set
    confirmation_token         = coalesce(confirmation_token, ''),
    recovery_token             = coalesce(recovery_token, ''),
    email_change               = coalesce(email_change, ''),
    email_change_token_new     = coalesce(email_change_token_new, ''),
    email_change_token_current = coalesce(email_change_token_current, ''),
    phone_change               = coalesce(phone_change, ''),
    phone_change_token         = coalesce(phone_change_token, ''),
    reauthentication_token     = coalesce(reauthentication_token, ''),
    email_confirmed_at         = coalesce(email_confirmed_at, now()),
    raw_user_meta_data         = coalesce(raw_user_meta_data, '{}'::jsonb)
                                   || '{"role":"admin","name":"أمير"}'::jsonb
  where email = 'amr@clinic.eg';

  insert into staff (staff_id, name, role, email, auth_uid)
  values ('ST-AMR', 'عمرو', 'admin', 'amr@clinic.eg', uid)
  on conflict (staff_id) do update
    set auth_uid = excluded.auth_uid,
        role     = 'admin',
        email    = excluded.email,
        name     = excluded.name;
end $$;
