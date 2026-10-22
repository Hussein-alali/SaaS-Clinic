-- API test fixtures on top of the REAL schema (plan task 2.6 / 2.4).
--
-- test/helpers.js resets the test database, applies db/migrations/*.sql
-- with db/migrate.js and db/seed/dev.sql, then this file. It only adds the
-- cases the dev seed does not have (accounts and clinics in unusual
-- states). NOT a migration and never applied outside the API tests.
--
-- Runs in the system context (app.system = 'on'): branches and the other
-- clinic tables have FORCE ROW LEVEL SECURITY. Every account's password is
-- Dev@12345 (the bcrypt hash of admin@demo-physio.test from the dev seed;
-- legacy@ uses the same hash with the $2a$ prefix Supabase Auth wrote).

select set_config('app.system', 'on', false);

begin;

insert into auth.users (id, email, encrypted_password, raw_user_meta_data, status) values
  ('a7000000-0000-4000-8000-000000000001', 'staff@demo-physio.test',    '$2b$10$Swo6CVGGBWzARWcmiPZj3.OmiJo4xmZVNPMCcvLbPhuPbvNmORFNS', '{"name":"Physio Staff"}',   'active'),
  ('a7000000-0000-4000-8000-000000000002', 'former@demo-physio.test',   '$2b$10$Swo6CVGGBWzARWcmiPZj3.OmiJo4xmZVNPMCcvLbPhuPbvNmORFNS', '{"name":"Former Member"}',  'active'),
  ('a7000000-0000-4000-8000-000000000003', 'outsider@clinicsys.test',   '$2b$10$Swo6CVGGBWzARWcmiPZj3.OmiJo4xmZVNPMCcvLbPhuPbvNmORFNS', '{}',                        'active'),
  ('a7000000-0000-4000-8000-000000000004', 'multi@clinicsys.test',      '$2b$10$Swo6CVGGBWzARWcmiPZj3.OmiJo4xmZVNPMCcvLbPhuPbvNmORFNS', '{"name":"Two Clinics"}',    'active'),
  ('a7000000-0000-4000-8000-000000000005', 'disabled@clinicsys.test',   '$2b$10$Swo6CVGGBWzARWcmiPZj3.OmiJo4xmZVNPMCcvLbPhuPbvNmORFNS', '{}',                        'disabled'),
  ('a7000000-0000-4000-8000-000000000006', 'changer@demo-physio.test',  '$2b$10$Swo6CVGGBWzARWcmiPZj3.OmiJo4xmZVNPMCcvLbPhuPbvNmORFNS', '{}',                        'active'),
  ('a7000000-0000-4000-8000-000000000007', 'reset@demo-physio.test',    '$2b$10$Swo6CVGGBWzARWcmiPZj3.OmiJo4xmZVNPMCcvLbPhuPbvNmORFNS', '{}',                        'active'),
  ('a7000000-0000-4000-8000-000000000008', 'admin@demo-suspended.test', '$2b$10$Swo6CVGGBWzARWcmiPZj3.OmiJo4xmZVNPMCcvLbPhuPbvNmORFNS', '{}',                        'active'),
  ('a7000000-0000-4000-8000-000000000009', 'legacy@demo-physio.test',   '$2a$10$Swo6CVGGBWzARWcmiPZj3.OmiJo4xmZVNPMCcvLbPhuPbvNmORFNS', '{"name":"Supabase hash"}', 'active');

-- Clinics in the other lifecycle states.
insert into public.organizations (id, name, slug, primary_specialty_id, status, status_reason, suspended_at, plan_id, created_by)
select v.id, v.name, v.slug, s.id, v.status, v.reason, v.suspended_at, p.id, 'de000000-0000-4000-8000-000000000001'::uuid
  from (values
    ('a7000000-0000-4000-8000-0000000a0003'::uuid, 'Demo Suspended', 'demo-suspended', 'physio',  'suspended',          'unpaid',          now()),
    ('a7000000-0000-4000-8000-0000000a0004'::uuid, 'Demo Closed',    'demo-closed',    'physio',  'closed',             'closed by owner', null),
    ('a7000000-0000-4000-8000-0000000a0005'::uuid, 'Demo Pending',   'demo-pending',   'general', 'pending_activation', null,              null),
    ('a7000000-0000-4000-8000-0000000a0006'::uuid, 'Demo Draft',     'demo-draft',     'general', 'draft',              null,              null)
  ) as v(id, name, slug, specialty, status, reason, suspended_at)
  join public.specialties s on s.code = v.specialty
  cross join public.subscription_plans p
 where p.code = 'default';

insert into public.branches (id, organization_id, name, status) values
  ('br-demo-suspended-1', 'a7000000-0000-4000-8000-0000000a0003', 'الفرع الرئيسي', 'active');
insert into public.clinic_settings (organization_id, id, name, subtitle) values
  ('a7000000-0000-4000-8000-0000000a0003', 1, 'عيادة موقوفة', null),
  ('a7000000-0000-4000-8000-0000000a0005', 1, 'عيادة قيد التفعيل', 'بانتظار المدير');

-- A plan with a 1 MB storage limit (files.test.js moves a clinic onto it).
insert into public.subscription_plans (code, name, max_users, max_branches, max_storage_mb, included_modules, status)
values ('tiny', 'Tiny (tests)', null, null, 1, null, 'active');

-- Memberships. staff@ has the 'staff' role (no file access, no branch);
-- former@ is disabled; multi@ is in both demo clinics.
insert into public.organization_members (id, organization_id, user_id, role, status, joined_at) values
  ('a7000000-0000-4000-8000-0000000b0001', 'de000000-0000-4000-8000-0000000a0001', 'a7000000-0000-4000-8000-000000000001', 'staff',        'active',   now()),
  ('a7000000-0000-4000-8000-0000000b0002', 'de000000-0000-4000-8000-0000000a0001', 'a7000000-0000-4000-8000-000000000002', 'receptionist', 'disabled', now()),
  ('a7000000-0000-4000-8000-0000000b0004', 'de000000-0000-4000-8000-0000000a0001', 'a7000000-0000-4000-8000-000000000004', 'therapist',    'active',   now()),
  ('a7000000-0000-4000-8000-0000000b0014', 'de000000-0000-4000-8000-0000000a0002', 'a7000000-0000-4000-8000-000000000004', 'receptionist', 'active',   now()),
  ('a7000000-0000-4000-8000-0000000b0006', 'de000000-0000-4000-8000-0000000a0001', 'a7000000-0000-4000-8000-000000000006', 'admin',        'active',   now()),
  ('a7000000-0000-4000-8000-0000000b0007', 'de000000-0000-4000-8000-0000000a0001', 'a7000000-0000-4000-8000-000000000007', 'receptionist', 'active',   now()),
  ('a7000000-0000-4000-8000-0000000b0008', 'a7000000-0000-4000-8000-0000000a0003', 'a7000000-0000-4000-8000-000000000008', 'admin',        'active',   now()),
  ('a7000000-0000-4000-8000-0000000b0009', 'de000000-0000-4000-8000-0000000a0001', 'a7000000-0000-4000-8000-000000000009', 'receptionist', 'active',   now());

insert into public.member_branches (member_id, branch_id, organization_id) values
  ('a7000000-0000-4000-8000-0000000b0002', 'br-demo-physio-1', 'de000000-0000-4000-8000-0000000a0001'),
  ('a7000000-0000-4000-8000-0000000b0004', 'br-demo-physio-1', 'de000000-0000-4000-8000-0000000a0001'),
  ('a7000000-0000-4000-8000-0000000b0004', 'br-demo-physio-2', 'de000000-0000-4000-8000-0000000a0001'),
  ('a7000000-0000-4000-8000-0000000b0014', 'br-demo-dental-2', 'de000000-0000-4000-8000-0000000a0002'),
  ('a7000000-0000-4000-8000-0000000b0007', 'br-demo-physio-1', 'de000000-0000-4000-8000-0000000a0001'),
  ('a7000000-0000-4000-8000-0000000b0009', 'br-demo-physio-1', 'de000000-0000-4000-8000-0000000a0001');

commit;

select set_config('app.system', 'off', false);
