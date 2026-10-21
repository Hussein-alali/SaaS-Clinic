-- ============================================================
-- Kinetic — Staff seed: therapists + receptionist
--
-- Creates login accounts + staff rows for the clinic team:
--   Therapists (role "therapist"):
--     • دكتور عبد الرحمن   abdelrahman@clinic.eg
--     • دكتور اسماعيل      esmail@clinic.eg
--     • دكتور منه          menna@clinic.eg
--     • دكتور داليا        dalia@clinic.eg
--     • دكتور روضة         rawda@clinic.eg
--   Receptionist (role "receptionist"):
--     • مريم               mariam@clinic.eg
--
--   Password (ALL accounts): Clinic@2026!
--     ←  CHANGE THIS after first login
--        (Dashboard → Authentication → Users → Reset password)
--
-- What it does, per person:
--   1. Creates the Supabase Auth user (skipped if the email exists),
--      with the *_token / *_change columns set to '' — NULLs there make
--      GoTrue answer every login with a 500, the classic SQL-user pitfall.
--   2. Creates the matching auth.identities row (email provider).
--   3. Upserts the `staff` row (auth_uid + role) — this is what
--      public.app_role() reads to authorize the account.
--   4. For therapists only, upserts the `therapists` roster row so they
--      appear in the "الأخصائي المسؤول" picker on treatment plans. The
--      roster id equals the staff_id so every person has one canonical id.
--
-- Idempotent: safe to re-run. Run AFTER the schema (or just run
-- Supabase_All_In_One.sql, which already includes this).
-- ============================================================

create extension if not exists pgcrypto;

do $$
declare
  r   record;
  uid uuid;
begin
  for r in
    select * from (values
      ('abdelrahman@clinic.eg', 'دكتور عبد الرحمن', 'therapist',    'ST-ABDELRAHMAN'),
      ('esmail@clinic.eg',      'دكتور اسماعيل',    'therapist',    'ST-ESMAIL'),
      ('menna@clinic.eg',       'دكتور منه',        'therapist',    'ST-MENNA'),
      ('dalia@clinic.eg',       'دكتور داليا',      'therapist',    'ST-DALIA'),
      ('rawda@clinic.eg',       'دكتور روضة',       'therapist',    'ST-RAWDA'),
      ('mariam@clinic.eg',      'مريم',             'receptionist', 'ST-MARIAM')
    ) as t(email, name, role, staff_id)
  loop
    select id into uid from auth.users where email = r.email;

    if uid is null then
      uid := gen_random_uuid();

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
        r.email,
        crypt('Clinic@2026!', gen_salt('bf')),
        now(),
        '{"provider":"email","providers":["email"]}'::jsonb,
        jsonb_build_object('role', r.role, 'name', r.name),
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
        jsonb_build_object('sub', uid::text, 'email', r.email, 'email_verified', true),
        'email',
        now(), now(), now()
      );
    end if;

    -- Repair pass: normalize NULL token columns (login-breaking) and keep
    -- the display role/name in metadata current.
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
                                     || jsonb_build_object('role', r.role, 'name', r.name)
    where email = r.email;

    -- Authorization row. `staff.role` is the source of truth for app_role().
    insert into staff (staff_id, name, role, email, auth_uid)
    values (r.staff_id, r.name, r.role, r.email, uid)
    on conflict (staff_id) do update
      set auth_uid = excluded.auth_uid,
          role     = excluded.role,
          email    = excluded.email,
          name     = excluded.name;
  end loop;

  -- Therapist roster (only the therapists) — feeds the treatment-plan
  -- "الأخصائي المسؤول" picker. id == staff_id so it's one canonical id.
  insert into therapists (id, name, spec) values
    ('ST-ABDELRAHMAN', 'دكتور عبد الرحمن', 'أخصائي علاج طبيعي'),
    ('ST-ESMAIL',      'دكتور اسماعيل',    'أخصائي علاج طبيعي'),
    ('ST-MENNA',       'دكتور منه',        'أخصائي علاج طبيعي'),
    ('ST-DALIA',       'دكتور داليا',      'أخصائي علاج طبيعي'),
    ('ST-RAWDA',       'دكتور روضة',       'أخصائي علاج طبيعي')
  on conflict (id) do update
    set name = excluded.name,
        spec = excluded.spec;
end $$;
