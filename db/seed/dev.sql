-- =====================================================================
-- db/seed/dev.sql — DEVELOPMENT / TEST DATA ONLY. NEVER RUN IN PRODUCTION.
-- (plan task 2.4; docs/05-Backend-Schema.md "Migration and seed data")
--
--   node db/migrate.js && psql "$DATABASE_URL" -f db/seed/dev.sql
--   (the db tests apply it themselves when it is missing; see db/README.md)
--
-- Every account's password is Dev@12345 (bcrypt, cost 10, generated with
-- bcryptjs; documented only here and in docs/05).
--
--   super@clinicsys.test                  Super Admin (platform_admins), no clinic
--   demo-physio (physio) / demo-dental (dental): active, plan 'default',
--   two branches each (br-<slug>-1 'الفرع الرئيسي', br-<slug>-2), and
--     admin@<slug>.test          admin         every branch
--     receptionist@<slug>.test   receptionist  branch 1
--     doctor@<slug>.test         doctor        branch 1
--     therapist@<slug>.test      therapist     branch 1
--     receptionist2@<slug>.test  receptionist  branches 1 and 2
--
-- Each clinic gets at least one row in every clinic table (the isolation
-- tests need rows on both sides), with globally unique text ids
-- (<prefix>-PHY-... / <prefix>-DEN-...). Some values repeat on purpose in
-- both clinics (national_id, receipt_no, custom_sections.slug,
-- patient_files.storage_path): uniques are per organization (convention 9).
--
-- Runs as one transaction in the system context (app.system = 'on'), and
-- refuses a database that already has these or any other organizations.
-- =====================================================================
select set_config('app.system', 'on', false);

begin;

do $$
begin
  if not exists (select 1 from public.schema_migrations where version = '0003_tenancy') then
    raise exception 'db/seed/dev.sql: run node db/migrate.js first (0003_tenancy is not applied)';
  end if;
  if exists (select 1 from public.organizations where slug in ('demo-physio', 'demo-dental')) then
    raise exception 'db/seed/dev.sql: already applied (demo-physio / demo-dental exist)';
  end if;
  if exists (select 1 from public.organizations) then
    raise exception 'db/seed/dev.sql: this database already has organizations; the dev seed only goes into an empty development/test database';
  end if;
end
$$;

-- ---------------------------------------------------------------------
-- Accounts (auth.users) and the Super Admin
-- ---------------------------------------------------------------------
insert into auth.users (id, email, encrypted_password, raw_user_meta_data, status, email_confirmed_at) values
  ('de000000-0000-4000-8000-000000000001', 'super@clinicsys.test', '$2b$10$vwgtmms0HEJPySF8FjzmCumwE8DXEs2nhjeMe4tiiOUGhHEDnMXF.', '{"name":"Super Admin"}', 'active', now()),
  ('de000000-0000-4000-8000-000000000111', 'admin@demo-physio.test', '$2b$10$Swo6CVGGBWzARWcmiPZj3.OmiJo4xmZVNPMCcvLbPhuPbvNmORFNS', '{"name":"مدير العيادة — PHY"}', 'active', now()),
  ('de000000-0000-4000-8000-000000000112', 'receptionist@demo-physio.test', '$2b$10$Zstu79DPRPzVziitiz2gje0Ym5KOMkPKZcZJPUzL8YEq41LAwDKje', '{"name":"موظف الاستقبال — PHY"}', 'active', now()),
  ('de000000-0000-4000-8000-000000000113', 'doctor@demo-physio.test', '$2b$10$b7joMN1a5BCq4u0mIIXSouaGiVOUfeYTG.PY9L4gfdYZqXWbDvb9q', '{"name":"الطبيب — PHY"}', 'active', now()),
  ('de000000-0000-4000-8000-000000000114', 'therapist@demo-physio.test', '$2b$10$rIHw/bo3csdhkDQiUY7txOoTsPMN8yYO7NdL1JGaHYJMbuh3yT4N2', '{"name":"الأخصائي — PHY"}', 'active', now()),
  ('de000000-0000-4000-8000-000000000115', 'receptionist2@demo-physio.test', '$2b$10$m5lkwdjrfoUMF8Vlr2w10OuOQ8ybz2aEX3f7l/IjcJbqXYjucxYlS', '{"name":"استقبال الفرعين — PHY"}', 'active', now()),
  ('de000000-0000-4000-8000-000000000121', 'admin@demo-dental.test', '$2b$10$DzN7AsKj7CrzwSiW4vvFfuhOoIJGWOuIASczVdvCMWoOLeDso6ZC.', '{"name":"مدير العيادة — DEN"}', 'active', now()),
  ('de000000-0000-4000-8000-000000000122', 'receptionist@demo-dental.test', '$2b$10$cOFF3NTNfhNefhNSKXfJbOyxRElEh2xm1LukQMehkT1GnFd0N/0T6', '{"name":"موظف الاستقبال — DEN"}', 'active', now()),
  ('de000000-0000-4000-8000-000000000123', 'doctor@demo-dental.test', '$2b$10$joxUkxTIqSvdKQo64BvheuQot0zncNw1mScljXVGp2K.mo553jQgu', '{"name":"الطبيب — DEN"}', 'active', now()),
  ('de000000-0000-4000-8000-000000000124', 'therapist@demo-dental.test', '$2b$10$Ar6lBEATCUNybL8XtwHo6.C34aWceNVHr4Q/JJ1jCfd9urNkQpxdm', '{"name":"الأخصائي — DEN"}', 'active', now()),
  ('de000000-0000-4000-8000-000000000125', 'receptionist2@demo-dental.test', '$2b$10$0h3edg3DlM6Jq7eVg9WTJ.S5GjTpX79MBzIqEPNLMipuJwe9p7mJy', '{"name":"استقبال الفرعين — DEN"}', 'active', now());

insert into public.platform_admins (user_id, created_by) values ('de000000-0000-4000-8000-000000000001', null);

-- ---------------------------------------------------------------------
-- Organizations, subscriptions, modules (the specialty defaults)
-- ---------------------------------------------------------------------
insert into public.organizations (id, name, slug, primary_specialty_id, status, plan_id, created_by)
select 'de000000-0000-4000-8000-0000000a0001'::uuid, 'عيادة العلاج الطبيعي التجريبية', 'demo-physio', s.id, 'active', p.id, 'de000000-0000-4000-8000-000000000001'::uuid
  from public.specialties s, public.subscription_plans p where s.code = 'physio' and p.code = 'default'
union all
select 'de000000-0000-4000-8000-0000000a0002'::uuid, 'عيادة الأسنان التجريبية', 'demo-dental', s.id, 'active', p.id, 'de000000-0000-4000-8000-000000000001'::uuid
  from public.specialties s, public.subscription_plans p where s.code = 'dental' and p.code = 'default';

insert into public.subscriptions (organization_id, plan_id, status, period_start, notes, set_by)
select o.id, o.plan_id, 'active', current_date, 'dev seed', 'de000000-0000-4000-8000-000000000001'::uuid
  from public.organizations o where o.slug in ('demo-physio', 'demo-dental');

-- Planned modules (dental.*) are listed but disabled until they are active.
insert into public.organization_modules (organization_id, module_id, enabled, configured_by)
select o.id, sm.module_id, m.status = 'active', 'de000000-0000-4000-8000-000000000001'::uuid
  from public.organizations o
  join public.specialty_modules sm on sm.specialty_id = o.primary_specialty_id
  join public.modules m on m.id = sm.module_id
 where o.slug in ('demo-physio', 'demo-dental');

-- =====================================================================
-- demo-physio (physio)
-- =====================================================================
insert into public.branches (id, organization_id, name, address, phone, rooms, status, working_hours, created_at) values
  ('br-demo-physio-1', 'de000000-0000-4000-8000-0000000a0001', 'الفرع الرئيسي', 'القاهرة', '02200000001', 4, 'active', '{"sat":["09:00","21:00"],"sun":["09:00","21:00"]}', now() - interval '2 days'),
  ('br-demo-physio-2', 'de000000-0000-4000-8000-0000000a0001', 'فرع المعادي', 'القاهرة', '02200000011', 2, 'active', '{"sat":["12:00","20:00"]}', now() - interval '1 day');

insert into public.clinic_settings (organization_id, id, name, subtitle, primary_color, phone, email) values
  ('de000000-0000-4000-8000-0000000a0001', 1, 'عيادة العلاج الطبيعي التجريبية', 'بيانات تجريبية', '#7BBDE8', '02200000001', 'info@demo-physio.test');

-- Members, their branches, and the matching staff rows (auth_uid linked).
insert into public.organization_members (id, organization_id, user_id, role, status, invited_by, joined_at) values
  ('de000000-0000-4000-8000-0000000b0011', 'de000000-0000-4000-8000-0000000a0001', 'de000000-0000-4000-8000-000000000111', 'admin', 'active', 'de000000-0000-4000-8000-000000000001', now()),
  ('de000000-0000-4000-8000-0000000b0012', 'de000000-0000-4000-8000-0000000a0001', 'de000000-0000-4000-8000-000000000112', 'receptionist', 'active', 'de000000-0000-4000-8000-000000000001', now()),
  ('de000000-0000-4000-8000-0000000b0013', 'de000000-0000-4000-8000-0000000a0001', 'de000000-0000-4000-8000-000000000113', 'doctor', 'active', 'de000000-0000-4000-8000-000000000001', now()),
  ('de000000-0000-4000-8000-0000000b0014', 'de000000-0000-4000-8000-0000000a0001', 'de000000-0000-4000-8000-000000000114', 'therapist', 'active', 'de000000-0000-4000-8000-000000000001', now()),
  ('de000000-0000-4000-8000-0000000b0015', 'de000000-0000-4000-8000-0000000a0001', 'de000000-0000-4000-8000-000000000115', 'receptionist', 'active', 'de000000-0000-4000-8000-000000000001', now());
insert into public.member_branches (member_id, branch_id, organization_id) values
  ('de000000-0000-4000-8000-0000000b0012', 'br-demo-physio-1', 'de000000-0000-4000-8000-0000000a0001'),
  ('de000000-0000-4000-8000-0000000b0013', 'br-demo-physio-1', 'de000000-0000-4000-8000-0000000a0001'),
  ('de000000-0000-4000-8000-0000000b0014', 'br-demo-physio-1', 'de000000-0000-4000-8000-0000000a0001'),
  ('de000000-0000-4000-8000-0000000b0015', 'br-demo-physio-1', 'de000000-0000-4000-8000-0000000a0001'),
  ('de000000-0000-4000-8000-0000000b0015', 'br-demo-physio-2', 'de000000-0000-4000-8000-0000000a0001');
insert into public.staff (staff_id, organization_id, name, role, phone, email, auth_uid, status) values
  ('ST-PHY-ADMIN', 'de000000-0000-4000-8000-0000000a0001', 'مدير العيادة — PHY', 'admin', '01000001000', 'admin@demo-physio.test', 'de000000-0000-4000-8000-000000000111', 'active'),
  ('ST-PHY-RECEPTIONIST', 'de000000-0000-4000-8000-0000000a0001', 'موظف الاستقبال — PHY', 'receptionist', '01000001100', 'receptionist@demo-physio.test', 'de000000-0000-4000-8000-000000000112', 'active'),
  ('ST-PHY-DOCTOR', 'de000000-0000-4000-8000-0000000a0001', 'الطبيب — PHY', 'doctor', '01000001200', 'doctor@demo-physio.test', 'de000000-0000-4000-8000-000000000113', 'active'),
  ('ST-PHY-THERAPIST', 'de000000-0000-4000-8000-0000000a0001', 'الأخصائي — PHY', 'therapist', '01000001300', 'therapist@demo-physio.test', 'de000000-0000-4000-8000-000000000114', 'active'),
  ('ST-PHY-RECEPTIONIST2', 'de000000-0000-4000-8000-0000000a0001', 'استقبال الفرعين — PHY', 'receptionist', '01000001400', 'receptionist2@demo-physio.test', 'de000000-0000-4000-8000-000000000115', 'active');

insert into public.departments (id, organization_id, name_ar, name_en) values
  ('DEP-PHY-1', 'de000000-0000-4000-8000-0000000a0001', 'العلاج الطبيعي', 'Physiotherapy');
-- A therapist with an account has a roster row whose id is the staff_id
-- (0001's sessions policy compares sessions.therapist_id with staff_id).
insert into public.therapists (id, organization_id, name, spec, department_id, auth_uid, email) values
  ('ST-PHY-THERAPIST', 'de000000-0000-4000-8000-0000000a0001', 'الأخصائي — PHY', 'عام', 'DEP-PHY-1', 'de000000-0000-4000-8000-000000000114', 'therapist@demo-physio.test'),
  ('TH-PHY-2', 'de000000-0000-4000-8000-0000000a0001', 'أخصائي بدون حساب — PHY', 'عام', 'DEP-PHY-1', null, null);
insert into public.doctors (id, organization_id, name, department_id, specialization, auth_uid, email) values
  ('DR-PHY-1', 'de000000-0000-4000-8000-0000000a0001', 'الطبيب — PHY', 'DEP-PHY-1', 'استشاري', 'de000000-0000-4000-8000-000000000113', 'doctor@demo-physio.test');
insert into public.receptionists (id, organization_id, name, auth_uid, email) values
  ('RC-PHY-1', 'de000000-0000-4000-8000-0000000a0001', 'موظف الاستقبال — PHY', 'de000000-0000-4000-8000-000000000112', 'receptionist@demo-physio.test');

-- Patients (organization level). national_id 29001011234567 exists in both clinics on purpose.
insert into public.patients (patient_id, organization_id, name, phone, age, gender, diagnosis, national_id, medical_file_no, therapist_id, doctor_id) values
  ('P-PHY-01', 'de000000-0000-4000-8000-0000000a0001', 'مريض أول — PHY',  '01110001001', 34, 'M', 'ألم أسفل الظهر', '29001011234567', 'MF-1', 'ST-PHY-THERAPIST', 'DR-PHY-1'),
  ('P-PHY-02', 'de000000-0000-4000-8000-0000000a0001', 'مريضة ثانية — PHY', '01110001002', 41, 'F', 'التهاب الكتف',   '28505051234567', 'MF-2', 'ST-PHY-THERAPIST', null),
  ('P-PHY-03', 'de000000-0000-4000-8000-0000000a0001', 'مريض ثالث — PHY',  '01110001003', 27, 'M', 'إصابة ركبة',     null,             'MF-3', 'TH-PHY-2', null),
  ('P-PHY-04', 'de000000-0000-4000-8000-0000000a0001', 'مريضة رابعة — PHY', '01110001004', 58, 'F', null,             null,             null,   null,        null);

-- Branch-scoped rows: every table has rows in branch 1 and branch 2.
insert into public.bookings (booking_id, organization_id, branch_id, patient_id, therapist_id, doctor_id, department_id, date, time, status, price, paid, payment_status) values
  ('BK-PHY-B1-1', 'de000000-0000-4000-8000-0000000a0001', 'br-demo-physio-1', 'P-PHY-01', 'ST-PHY-THERAPIST', 'DR-PHY-1', 'DEP-PHY-1', current_date,     '10:00', 'confirmed', 400, 0,   'pending'),
  ('BK-PHY-B1-2', 'de000000-0000-4000-8000-0000000a0001', 'br-demo-physio-1', 'P-PHY-02', 'ST-PHY-THERAPIST', null,        'DEP-PHY-1', current_date + 1, '11:00', 'pending',   300, 100, 'partial'),
  ('BK-PHY-B2-1', 'de000000-0000-4000-8000-0000000a0001', 'br-demo-physio-2', 'P-PHY-03', 'TH-PHY-2', null,        'DEP-PHY-1', current_date,     '12:00', 'confirmed', 350, 0,   'pending'),
  ('BK-PHY-B2-2', 'de000000-0000-4000-8000-0000000a0001', 'br-demo-physio-2', 'P-PHY-04', 'TH-PHY-2', null,        null,         current_date + 2, '13:00', 'pending',   250, 0,   'pending');
insert into public.invoices (invoice_id, organization_id, branch_id, patient_id, amount, paid, status) values
  ('INV-PHY-B1-1', 'de000000-0000-4000-8000-0000000a0001', 'br-demo-physio-1', 'P-PHY-01', 600, 0,   'pending'),
  ('INV-PHY-B1-2', 'de000000-0000-4000-8000-0000000a0001', 'br-demo-physio-1', 'P-PHY-02', 200, 200, 'paid'),
  ('INV-PHY-B2-1', 'de000000-0000-4000-8000-0000000a0001', 'br-demo-physio-2', 'P-PHY-03', 450, 0,   'pending');
insert into public.payments (payment_id, organization_id, branch_id, patient_id, cashier_id, cashier_name, amount, method, receipt_no, allocations) values
  ('PMT-PHY-B1-1', 'de000000-0000-4000-8000-0000000a0001', 'br-demo-physio-1', 'P-PHY-02', 'ST-PHY-RECEPTIONIST', 'موظف الاستقبال', 300, 'cash', 'RCT-DEV-00001',
   '[{"type":"invoice","id":"INV-PHY-B1-2","amount":200},{"type":"appointment","id":"BK-PHY-B1-2","amount":100}]'),
  ('PMT-PHY-B2-1', 'de000000-0000-4000-8000-0000000a0001', 'br-demo-physio-2', 'P-PHY-03', 'ST-PHY-RECEPTIONIST2', 'استقبال الفرعين', 50, 'card', 'RCT-DEV-00002', '[]');
insert into public.payment_receipts (receipt_id, organization_id, branch_id, payment_id, invoice_id, patient_id, file_name, storage_path, file_type) values
  ('PRC-PHY-B1-1', 'de000000-0000-4000-8000-0000000a0001', 'br-demo-physio-1', 'PMT-PHY-B1-1', 'INV-PHY-B1-2', 'P-PHY-02', 'receipt.pdf', 'receipts/PMT-PHY-B1-1.pdf', 'application/pdf'),
  ('PRC-PHY-B2-1', 'de000000-0000-4000-8000-0000000a0001', 'br-demo-physio-2', 'PMT-PHY-B2-1', null,             'P-PHY-03', 'receipt.pdf', 'receipts/PMT-PHY-B2-1.pdf', 'application/pdf');
insert into public.patient_schedules (schedule_id, organization_id, branch_id, patient_id, therapist_id, days, time, sessions_per_week) values
  ('SCH-PHY-B1-1', 'de000000-0000-4000-8000-0000000a0001', 'br-demo-physio-1', 'P-PHY-01', 'ST-PHY-THERAPIST', '["sat","mon"]', '10:00', 2),
  ('SCH-PHY-B2-1', 'de000000-0000-4000-8000-0000000a0001', 'br-demo-physio-2', 'P-PHY-03', 'TH-PHY-2', '["sun"]',       '12:00', 1);
insert into public.treatments (treatment_id, organization_id, branch_id, patient_id, therapist_id, therapist_name, template_id, template_version, template_name, name, diagnosis, status, created_by, created_by_name) values
  ('TRT-PHY-B1-1', 'de000000-0000-4000-8000-0000000a0001', 'br-demo-physio-1', 'P-PHY-01', 'ST-PHY-THERAPIST', 'الأخصائي — PHY', 'TPL-SEED-SPN-01', 1,
   (select name from public.treatment_templates where template_id = 'TPL-SEED-SPN-01'), 'خطة علاج الظهر', 'ألم أسفل الظهر', 'active', 'de000000-0000-4000-8000-000000000113', 'الطبيب — PHY'),
  ('TRT-PHY-B2-1', 'de000000-0000-4000-8000-0000000a0001', 'br-demo-physio-2', 'P-PHY-03', 'TH-PHY-2', 'أخصائي بدون حساب — PHY', null, null, null, 'خطة علاج الركبة', 'إصابة ركبة', 'active', 'de000000-0000-4000-8000-000000000111', 'مدير العيادة — PHY');
insert into public.sessions (session_id, organization_id, branch_id, patient_id, therapist_id, treatment_id, booking_id, date, pain_score, session_number, status) values
  ('SES-PHY-B1-1', 'de000000-0000-4000-8000-0000000a0001', 'br-demo-physio-1', 'P-PHY-01', 'ST-PHY-THERAPIST', 'TRT-PHY-B1-1', 'BK-PHY-B1-1', current_date, 6, 1, 'completed'),
  ('SES-PHY-B2-1', 'de000000-0000-4000-8000-0000000a0001', 'br-demo-physio-2', 'P-PHY-03', 'TH-PHY-2', 'TRT-PHY-B2-1', 'BK-PHY-B2-1', current_date, 4, 1, 'completed');

-- Organization-level rows.
insert into public.packages (id, organization_id, name, sessions, price) values
  ('PKG-PHY-1', 'de000000-0000-4000-8000-0000000a0001', 'باقة 10 جلسات', 10, 3000);
insert into public.patient_subscriptions (subscription_id, organization_id, patient_id, package_id, package_name, total_sessions, used_sessions, price, paid, status) values
  ('PSUB-PHY-1', 'de000000-0000-4000-8000-0000000a0001', 'P-PHY-01', 'PKG-PHY-1', 'باقة 10 جلسات', 10, 1, 3000, 1000, 'active');
insert into public.patient_files (file_id, organization_id, patient_id, file_name, file_type, storage_path, original_name, mime_type, file_size, uploaded_by, uploaded_by_name) values
  ('PF-PHY-1', 'de000000-0000-4000-8000-0000000a0001', 'P-PHY-01', 'report.pdf', 'pdf', 'patients/P-01/report.pdf', 'report.pdf', 'application/pdf', 1024, 'de000000-0000-4000-8000-000000000112', 'موظف الاستقبال');
insert into public.campaigns (id, organization_id, name, audience, status, template) values
  ('CMP-PHY-1', 'de000000-0000-4000-8000-0000000a0001', 'تذكير المواعيد', 4, 'draft', 'مرحبًا {name}');
insert into public.custom_sections (id, organization_id, slug, label, content, position, visible) values
  ('CS-PHY-1', 'de000000-0000-4000-8000-0000000a0001', 'protocols', 'البروتوكولات', 'محتوى تجريبي', 1, true),
  ('CS-PHY-2', 'de000000-0000-4000-8000-0000000a0001', 'internal',  'ملاحظات داخلية', 'غير ظاهر',  2, false);

-- Clinic-owned template rows (the 0001 library rows are global).
insert into public.template_categories (category_id, organization_id, name, description, status, sort_order) values
  ('TPC-PHY-1', 'de000000-0000-4000-8000-0000000a0001', 'قوالب خاصة بالعيادة', 'فئة تجريبية', 'active', 10);
insert into public.treatment_methods (method_id, organization_id, name, category, status, display_order) values
  ('TM-PHY-1', 'de000000-0000-4000-8000-0000000a0001', 'طريقة خاصة بالعيادة', 'أخرى', 'active', 100);
insert into public.treatment_templates (template_id, organization_id, name, category, diagnosis, body_part, status, created_by, created_by_name) values
  ('TPL-PHY-1', 'de000000-0000-4000-8000-0000000a0001', 'قالب خاص بالعيادة', 'قوالب خاصة بالعيادة', 'تشخيص تجريبي', 'الظهر', 'active', 'de000000-0000-4000-8000-000000000113', 'الطبيب — PHY');
insert into public.template_usage (use_id, organization_id, template_id, patient_id, plan_id, applied_by, applied_by_name) values
  ('TU-PHY-1', 'de000000-0000-4000-8000-0000000a0001', 'TPL-PHY-1',      'P-PHY-02', null,            'de000000-0000-4000-8000-000000000113', 'الطبيب — PHY'),
  ('TU-PHY-2', 'de000000-0000-4000-8000-0000000a0001', 'TPL-SEED-SPN-01', 'P-PHY-01', 'TRT-PHY-B1-1', 'de000000-0000-4000-8000-000000000113', 'الطبيب — PHY');
insert into public.audit_events (organization_id, actor_uid, actor_role, action, table_name, row_pk, target_type, target_id, result, payload) values
  ('de000000-0000-4000-8000-0000000a0001', 'de000000-0000-4000-8000-000000000001', 'super_admin', 'organization_seeded', 'organizations', 'de000000-0000-4000-8000-0000000a0001', 'organization', 'de000000-0000-4000-8000-0000000a0001', 'success', '{"source":"db/seed/dev.sql"}');

-- =====================================================================
-- demo-dental (dental)
-- =====================================================================
insert into public.branches (id, organization_id, name, address, phone, rooms, status, working_hours, created_at) values
  ('br-demo-dental-1', 'de000000-0000-4000-8000-0000000a0002', 'الفرع الرئيسي', 'القاهرة', '02200000002', 4, 'active', '{"sat":["09:00","21:00"],"sun":["09:00","21:00"]}', now() - interval '2 days'),
  ('br-demo-dental-2', 'de000000-0000-4000-8000-0000000a0002', 'فرع مدينة نصر', 'القاهرة', '02200000012', 2, 'active', '{"sat":["12:00","20:00"]}', now() - interval '1 day');

insert into public.clinic_settings (organization_id, id, name, subtitle, primary_color, phone, email) values
  ('de000000-0000-4000-8000-0000000a0002', 1, 'عيادة الأسنان التجريبية', 'بيانات تجريبية', '#4FA3A5', '02200000002', 'info@demo-dental.test');

-- Members, their branches, and the matching staff rows (auth_uid linked).
insert into public.organization_members (id, organization_id, user_id, role, status, invited_by, joined_at) values
  ('de000000-0000-4000-8000-0000000b0021', 'de000000-0000-4000-8000-0000000a0002', 'de000000-0000-4000-8000-000000000121', 'admin', 'active', 'de000000-0000-4000-8000-000000000001', now()),
  ('de000000-0000-4000-8000-0000000b0022', 'de000000-0000-4000-8000-0000000a0002', 'de000000-0000-4000-8000-000000000122', 'receptionist', 'active', 'de000000-0000-4000-8000-000000000001', now()),
  ('de000000-0000-4000-8000-0000000b0023', 'de000000-0000-4000-8000-0000000a0002', 'de000000-0000-4000-8000-000000000123', 'doctor', 'active', 'de000000-0000-4000-8000-000000000001', now()),
  ('de000000-0000-4000-8000-0000000b0024', 'de000000-0000-4000-8000-0000000a0002', 'de000000-0000-4000-8000-000000000124', 'therapist', 'active', 'de000000-0000-4000-8000-000000000001', now()),
  ('de000000-0000-4000-8000-0000000b0025', 'de000000-0000-4000-8000-0000000a0002', 'de000000-0000-4000-8000-000000000125', 'receptionist', 'active', 'de000000-0000-4000-8000-000000000001', now());
insert into public.member_branches (member_id, branch_id, organization_id) values
  ('de000000-0000-4000-8000-0000000b0022', 'br-demo-dental-1', 'de000000-0000-4000-8000-0000000a0002'),
  ('de000000-0000-4000-8000-0000000b0023', 'br-demo-dental-1', 'de000000-0000-4000-8000-0000000a0002'),
  ('de000000-0000-4000-8000-0000000b0024', 'br-demo-dental-1', 'de000000-0000-4000-8000-0000000a0002'),
  ('de000000-0000-4000-8000-0000000b0025', 'br-demo-dental-1', 'de000000-0000-4000-8000-0000000a0002'),
  ('de000000-0000-4000-8000-0000000b0025', 'br-demo-dental-2', 'de000000-0000-4000-8000-0000000a0002');
insert into public.staff (staff_id, organization_id, name, role, phone, email, auth_uid, status) values
  ('ST-DEN-ADMIN', 'de000000-0000-4000-8000-0000000a0002', 'مدير العيادة — DEN', 'admin', '01000002000', 'admin@demo-dental.test', 'de000000-0000-4000-8000-000000000121', 'active'),
  ('ST-DEN-RECEPTIONIST', 'de000000-0000-4000-8000-0000000a0002', 'موظف الاستقبال — DEN', 'receptionist', '01000002100', 'receptionist@demo-dental.test', 'de000000-0000-4000-8000-000000000122', 'active'),
  ('ST-DEN-DOCTOR', 'de000000-0000-4000-8000-0000000a0002', 'الطبيب — DEN', 'doctor', '01000002200', 'doctor@demo-dental.test', 'de000000-0000-4000-8000-000000000123', 'active'),
  ('ST-DEN-THERAPIST', 'de000000-0000-4000-8000-0000000a0002', 'الأخصائي — DEN', 'therapist', '01000002300', 'therapist@demo-dental.test', 'de000000-0000-4000-8000-000000000124', 'active'),
  ('ST-DEN-RECEPTIONIST2', 'de000000-0000-4000-8000-0000000a0002', 'استقبال الفرعين — DEN', 'receptionist', '01000002400', 'receptionist2@demo-dental.test', 'de000000-0000-4000-8000-000000000125', 'active');

insert into public.departments (id, organization_id, name_ar, name_en) values
  ('DEP-DEN-1', 'de000000-0000-4000-8000-0000000a0002', 'طب الأسنان', 'Dentistry');
-- A therapist with an account has a roster row whose id is the staff_id
-- (0001's sessions policy compares sessions.therapist_id with staff_id).
insert into public.therapists (id, organization_id, name, spec, department_id, auth_uid, email) values
  ('ST-DEN-THERAPIST', 'de000000-0000-4000-8000-0000000a0002', 'الأخصائي — DEN', 'عام', 'DEP-DEN-1', 'de000000-0000-4000-8000-000000000124', 'therapist@demo-dental.test'),
  ('TH-DEN-2', 'de000000-0000-4000-8000-0000000a0002', 'أخصائي بدون حساب — DEN', 'عام', 'DEP-DEN-1', null, null);
insert into public.doctors (id, organization_id, name, department_id, specialization, auth_uid, email) values
  ('DR-DEN-1', 'de000000-0000-4000-8000-0000000a0002', 'الطبيب — DEN', 'DEP-DEN-1', 'استشاري', 'de000000-0000-4000-8000-000000000123', 'doctor@demo-dental.test');
insert into public.receptionists (id, organization_id, name, auth_uid, email) values
  ('RC-DEN-1', 'de000000-0000-4000-8000-0000000a0002', 'موظف الاستقبال — DEN', 'de000000-0000-4000-8000-000000000122', 'receptionist@demo-dental.test');

-- Patients (organization level). national_id 29001011234567 exists in both clinics on purpose.
insert into public.patients (patient_id, organization_id, name, phone, age, gender, diagnosis, national_id, medical_file_no, therapist_id, doctor_id) values
  ('P-DEN-01', 'de000000-0000-4000-8000-0000000a0002', 'مريض أول — DEN',  '01110002001', 34, 'M', 'ألم أسفل الظهر', '29001011234567', 'MF-1', 'ST-DEN-THERAPIST', 'DR-DEN-1'),
  ('P-DEN-02', 'de000000-0000-4000-8000-0000000a0002', 'مريضة ثانية — DEN', '01110002002', 41, 'F', 'التهاب الكتف',   '28505051234567', 'MF-2', 'ST-DEN-THERAPIST', null),
  ('P-DEN-03', 'de000000-0000-4000-8000-0000000a0002', 'مريض ثالث — DEN',  '01110002003', 27, 'M', 'إصابة ركبة',     null,             'MF-3', 'TH-DEN-2', null),
  ('P-DEN-04', 'de000000-0000-4000-8000-0000000a0002', 'مريضة رابعة — DEN', '01110002004', 58, 'F', null,             null,             null,   null,        null);

-- Branch-scoped rows: every table has rows in branch 1 and branch 2.
insert into public.bookings (booking_id, organization_id, branch_id, patient_id, therapist_id, doctor_id, department_id, date, time, status, price, paid, payment_status) values
  ('BK-DEN-B1-1', 'de000000-0000-4000-8000-0000000a0002', 'br-demo-dental-1', 'P-DEN-01', 'ST-DEN-THERAPIST', 'DR-DEN-1', 'DEP-DEN-1', current_date,     '10:00', 'confirmed', 400, 0,   'pending'),
  ('BK-DEN-B1-2', 'de000000-0000-4000-8000-0000000a0002', 'br-demo-dental-1', 'P-DEN-02', 'ST-DEN-THERAPIST', null,        'DEP-DEN-1', current_date + 1, '11:00', 'pending',   300, 100, 'partial'),
  ('BK-DEN-B2-1', 'de000000-0000-4000-8000-0000000a0002', 'br-demo-dental-2', 'P-DEN-03', 'TH-DEN-2', null,        'DEP-DEN-1', current_date,     '12:00', 'confirmed', 350, 0,   'pending'),
  ('BK-DEN-B2-2', 'de000000-0000-4000-8000-0000000a0002', 'br-demo-dental-2', 'P-DEN-04', 'TH-DEN-2', null,        null,         current_date + 2, '13:00', 'pending',   250, 0,   'pending');
insert into public.invoices (invoice_id, organization_id, branch_id, patient_id, amount, paid, status) values
  ('INV-DEN-B1-1', 'de000000-0000-4000-8000-0000000a0002', 'br-demo-dental-1', 'P-DEN-01', 600, 0,   'pending'),
  ('INV-DEN-B1-2', 'de000000-0000-4000-8000-0000000a0002', 'br-demo-dental-1', 'P-DEN-02', 200, 200, 'paid'),
  ('INV-DEN-B2-1', 'de000000-0000-4000-8000-0000000a0002', 'br-demo-dental-2', 'P-DEN-03', 450, 0,   'pending');
insert into public.payments (payment_id, organization_id, branch_id, patient_id, cashier_id, cashier_name, amount, method, receipt_no, allocations) values
  ('PMT-DEN-B1-1', 'de000000-0000-4000-8000-0000000a0002', 'br-demo-dental-1', 'P-DEN-02', 'ST-DEN-RECEPTIONIST', 'موظف الاستقبال', 300, 'cash', 'RCT-DEV-00001',
   '[{"type":"invoice","id":"INV-DEN-B1-2","amount":200},{"type":"appointment","id":"BK-DEN-B1-2","amount":100}]'),
  ('PMT-DEN-B2-1', 'de000000-0000-4000-8000-0000000a0002', 'br-demo-dental-2', 'P-DEN-03', 'ST-DEN-RECEPTIONIST2', 'استقبال الفرعين', 50, 'card', 'RCT-DEV-00002', '[]');
insert into public.payment_receipts (receipt_id, organization_id, branch_id, payment_id, invoice_id, patient_id, file_name, storage_path, file_type) values
  ('PRC-DEN-B1-1', 'de000000-0000-4000-8000-0000000a0002', 'br-demo-dental-1', 'PMT-DEN-B1-1', 'INV-DEN-B1-2', 'P-DEN-02', 'receipt.pdf', 'receipts/PMT-DEN-B1-1.pdf', 'application/pdf'),
  ('PRC-DEN-B2-1', 'de000000-0000-4000-8000-0000000a0002', 'br-demo-dental-2', 'PMT-DEN-B2-1', null,             'P-DEN-03', 'receipt.pdf', 'receipts/PMT-DEN-B2-1.pdf', 'application/pdf');
insert into public.patient_schedules (schedule_id, organization_id, branch_id, patient_id, therapist_id, days, time, sessions_per_week) values
  ('SCH-DEN-B1-1', 'de000000-0000-4000-8000-0000000a0002', 'br-demo-dental-1', 'P-DEN-01', 'ST-DEN-THERAPIST', '["sat","mon"]', '10:00', 2),
  ('SCH-DEN-B2-1', 'de000000-0000-4000-8000-0000000a0002', 'br-demo-dental-2', 'P-DEN-03', 'TH-DEN-2', '["sun"]',       '12:00', 1);
insert into public.treatments (treatment_id, organization_id, branch_id, patient_id, therapist_id, therapist_name, template_id, template_version, template_name, name, diagnosis, status, created_by, created_by_name) values
  ('TRT-DEN-B1-1', 'de000000-0000-4000-8000-0000000a0002', 'br-demo-dental-1', 'P-DEN-01', 'ST-DEN-THERAPIST', 'الأخصائي — DEN', 'TPL-SEED-SPN-01', 1,
   (select name from public.treatment_templates where template_id = 'TPL-SEED-SPN-01'), 'خطة علاج الظهر', 'ألم أسفل الظهر', 'active', 'de000000-0000-4000-8000-000000000123', 'الطبيب — DEN'),
  ('TRT-DEN-B2-1', 'de000000-0000-4000-8000-0000000a0002', 'br-demo-dental-2', 'P-DEN-03', 'TH-DEN-2', 'أخصائي بدون حساب — DEN', null, null, null, 'خطة علاج الركبة', 'إصابة ركبة', 'active', 'de000000-0000-4000-8000-000000000121', 'مدير العيادة — DEN');
insert into public.sessions (session_id, organization_id, branch_id, patient_id, therapist_id, treatment_id, booking_id, date, pain_score, session_number, status) values
  ('SES-DEN-B1-1', 'de000000-0000-4000-8000-0000000a0002', 'br-demo-dental-1', 'P-DEN-01', 'ST-DEN-THERAPIST', 'TRT-DEN-B1-1', 'BK-DEN-B1-1', current_date, 6, 1, 'completed'),
  ('SES-DEN-B2-1', 'de000000-0000-4000-8000-0000000a0002', 'br-demo-dental-2', 'P-DEN-03', 'TH-DEN-2', 'TRT-DEN-B2-1', 'BK-DEN-B2-1', current_date, 4, 1, 'completed');

-- Organization-level rows.
insert into public.packages (id, organization_id, name, sessions, price) values
  ('PKG-DEN-1', 'de000000-0000-4000-8000-0000000a0002', 'باقة 10 جلسات', 10, 3000);
insert into public.patient_subscriptions (subscription_id, organization_id, patient_id, package_id, package_name, total_sessions, used_sessions, price, paid, status) values
  ('PSUB-DEN-1', 'de000000-0000-4000-8000-0000000a0002', 'P-DEN-01', 'PKG-DEN-1', 'باقة 10 جلسات', 10, 1, 3000, 1000, 'active');
insert into public.patient_files (file_id, organization_id, patient_id, file_name, file_type, storage_path, original_name, mime_type, file_size, uploaded_by, uploaded_by_name) values
  ('PF-DEN-1', 'de000000-0000-4000-8000-0000000a0002', 'P-DEN-01', 'report.pdf', 'pdf', 'patients/P-01/report.pdf', 'report.pdf', 'application/pdf', 1024, 'de000000-0000-4000-8000-000000000122', 'موظف الاستقبال');
insert into public.campaigns (id, organization_id, name, audience, status, template) values
  ('CMP-DEN-1', 'de000000-0000-4000-8000-0000000a0002', 'تذكير المواعيد', 4, 'draft', 'مرحبًا {name}');
insert into public.custom_sections (id, organization_id, slug, label, content, position, visible) values
  ('CS-DEN-1', 'de000000-0000-4000-8000-0000000a0002', 'protocols', 'البروتوكولات', 'محتوى تجريبي', 1, true),
  ('CS-DEN-2', 'de000000-0000-4000-8000-0000000a0002', 'internal',  'ملاحظات داخلية', 'غير ظاهر',  2, false);

-- Clinic-owned template rows (the 0001 library rows are global).
insert into public.template_categories (category_id, organization_id, name, description, status, sort_order) values
  ('TPC-DEN-1', 'de000000-0000-4000-8000-0000000a0002', 'قوالب خاصة بالعيادة', 'فئة تجريبية', 'active', 10);
insert into public.treatment_methods (method_id, organization_id, name, category, status, display_order) values
  ('TM-DEN-1', 'de000000-0000-4000-8000-0000000a0002', 'طريقة خاصة بالعيادة', 'أخرى', 'active', 100);
insert into public.treatment_templates (template_id, organization_id, name, category, diagnosis, body_part, status, created_by, created_by_name) values
  ('TPL-DEN-1', 'de000000-0000-4000-8000-0000000a0002', 'قالب خاص بالعيادة', 'قوالب خاصة بالعيادة', 'تشخيص تجريبي', 'الظهر', 'active', 'de000000-0000-4000-8000-000000000123', 'الطبيب — DEN');
insert into public.template_usage (use_id, organization_id, template_id, patient_id, plan_id, applied_by, applied_by_name) values
  ('TU-DEN-1', 'de000000-0000-4000-8000-0000000a0002', 'TPL-DEN-1',      'P-DEN-02', null,            'de000000-0000-4000-8000-000000000123', 'الطبيب — DEN'),
  ('TU-DEN-2', 'de000000-0000-4000-8000-0000000a0002', 'TPL-SEED-SPN-01', 'P-DEN-01', 'TRT-DEN-B1-1', 'de000000-0000-4000-8000-000000000123', 'الطبيب — DEN');
insert into public.audit_events (organization_id, actor_uid, actor_role, action, table_name, row_pk, target_type, target_id, result, payload) values
  ('de000000-0000-4000-8000-0000000a0002', 'de000000-0000-4000-8000-000000000001', 'super_admin', 'organization_seeded', 'organizations', 'de000000-0000-4000-8000-0000000a0002', 'organization', 'de000000-0000-4000-8000-0000000a0002', 'success', '{"source":"db/seed/dev.sql"}');

-- ---------------------------------------------------------------------
-- Clinical records (0018): one diagnosis, finding and prescription per
-- clinic at least (db/test/isolation.test.js copies them); the dental
-- patient's chart is the owner's reference picture (26 Oct 2026).
-- markers: [[x, y], ...] in percent of assets/body-diagram.jpeg.
-- ---------------------------------------------------------------------
insert into public.assessments (assessment_id, organization_id, branch_id, patient_id, kind, visit_date, clinician_id, clinician_name,
                                complaint, diagnosis, notes, data, markers, author_uid, author_name) values
  ('ASM-PHY-1', 'de000000-0000-4000-8000-0000000a0001', 'br-demo-physio-1', 'P-PHY-01', 'physio', current_date - 7,
   'ST-PHY-THERAPIST', 'الأخصائي — PHY', 'ألم أسفل الظهر يمتد للساق اليسرى', 'انزلاق غضروفي L4–L5', null,
   '{"modalities":["TENS","Hot pack"],"cervical":{"on":false,"mode":null},"thll":{"on":true,"mode":"Bilat"},"thpl":{"on":false,"mode":null}}',
   '[[37.2,44.6],[38.4,47.1],[62.7,46.0]]', 'de000000-0000-4000-8000-000000000114', 'الأخصائي — PHY'),
  ('ASM-DEN-1', 'de000000-0000-4000-8000-0000000a0002', 'br-demo-dental-1', 'P-DEN-01', 'dental', current_date - 3,
   'DR-DEN-1', 'الطبيب — DEN', 'ألم في الضرس العلوي الأيسر مع الأكل البارد', 'التهاب لب الضرس 26', 'علاج عصب 26 ثم تاج',
   '{"examination":"تسوس عميق في 26، حساسية للبارد","treatment_done":"علاج عصب 26 — الجلسة الأولى","next_visit":"تركيب التاج"}',
   '[]', 'de000000-0000-4000-8000-000000000123', 'الطبيب — DEN');

insert into public.dental_findings (finding_id, organization_id, patient_id, tooth, surfaces, condition, status, recorded_on, assessment_id, author_uid, author_name) values
  ('DF-PHY-1',  'de000000-0000-4000-8000-0000000a0001', 'P-PHY-01', 36, '{O}',     'filling',    'existing', current_date - 30, null,        'de000000-0000-4000-8000-000000000113', 'الطبيب — PHY'),
  ('DF-DEN-1',  'de000000-0000-4000-8000-0000000a0002', 'P-DEN-01', 16, '{O}',     'filling',    'existing', current_date - 60, null,        'de000000-0000-4000-8000-000000000123', 'الطبيب — DEN'),
  ('DF-DEN-2',  'de000000-0000-4000-8000-0000000a0002', 'P-DEN-01', 14, '{D}',     'caries',     'existing', current_date - 3,  'ASM-DEN-1', 'de000000-0000-4000-8000-000000000123', 'الطبيب — DEN'),
  ('DF-DEN-3',  'de000000-0000-4000-8000-0000000a0002', 'P-DEN-01', 11, '{B}',     'veneer',     'planned',  current_date - 3,  'ASM-DEN-1', 'de000000-0000-4000-8000-000000000123', 'الطبيب — DEN'),
  ('DF-DEN-4',  'de000000-0000-4000-8000-0000000a0002', 'P-DEN-01', 21, '{}',      'crown',      'existing', current_date - 60, null,        'de000000-0000-4000-8000-000000000123', 'الطبيب — DEN'),
  ('DF-DEN-5',  'de000000-0000-4000-8000-0000000a0002', 'P-DEN-01', 24, '{O}',     'filling',    'existing', current_date - 60, null,        'de000000-0000-4000-8000-000000000123', 'الطبيب — DEN'),
  ('DF-DEN-6',  'de000000-0000-4000-8000-0000000a0002', 'P-DEN-01', 26, '{}',      'root_canal', 'done',     current_date - 7,  null,        'de000000-0000-4000-8000-000000000123', 'الطبيب — DEN'),
  ('DF-DEN-7',  'de000000-0000-4000-8000-0000000a0002', 'P-DEN-01', 26, '{}',      'crown',      'planned',  current_date - 3,  'ASM-DEN-1', 'de000000-0000-4000-8000-000000000123', 'الطبيب — DEN'),
  ('DF-DEN-8',  'de000000-0000-4000-8000-0000000a0002', 'P-DEN-01', 36, '{M,O}',   'caries',     'existing', current_date - 3,  'ASM-DEN-1', 'de000000-0000-4000-8000-000000000123', 'الطبيب — DEN'),
  ('DF-DEN-9',  'de000000-0000-4000-8000-0000000a0002', 'P-DEN-01', 37, '{O}',     'filling',    'existing', current_date - 60, null,        'de000000-0000-4000-8000-000000000123', 'الطبيب — DEN'),
  ('DF-DEN-10', 'de000000-0000-4000-8000-0000000a0002', 'P-DEN-01', 45, '{B}',     'watch',      'existing', current_date - 3,  'ASM-DEN-1', 'de000000-0000-4000-8000-000000000123', 'الطبيب — DEN'),
  ('DF-DEN-11', 'de000000-0000-4000-8000-0000000a0002', 'P-DEN-01', 46, '{}',      'implant',    'existing', current_date - 60, null,        'de000000-0000-4000-8000-000000000123', 'الطبيب — DEN'),
  ('DF-DEN-12', 'de000000-0000-4000-8000-0000000a0002', 'P-DEN-01', 48, '{}',      'missing',    'existing', current_date - 60, null,        'de000000-0000-4000-8000-000000000123', 'الطبيب — DEN');

insert into public.prescriptions (prescription_id, organization_id, patient_id, prescribed_on, items, notes, assessment_id, author_uid, author_name) values
  ('RX-PHY-1', 'de000000-0000-4000-8000-0000000a0001', 'P-PHY-01', current_date - 7,
   '[{"name":"Ibuprofen","dose":"400 mg","frequency":"3 مرات يوميًا","duration":"5 أيام","notes":"بعد الأكل"}]', null, null,
   'de000000-0000-4000-8000-000000000113', 'الطبيب — PHY'),
  ('RX-DEN-1', 'de000000-0000-4000-8000-0000000a0002', 'P-DEN-01', current_date - 3,
   '[{"name":"Amoxicillin","dose":"500 mg","frequency":"كل 8 ساعات","duration":"7 أيام"},{"name":"Paracetamol","dose":"500 mg","frequency":"عند الألم","duration":"3 أيام"}]',
   'الحضور لتركيب التاج بعد أسبوعين', 'ASM-DEN-1', 'de000000-0000-4000-8000-000000000123', 'الطبيب — DEN');

-- A platform event (organization_id NULL): only the system context sees it.
insert into public.audit_events (organization_id, actor_uid, actor_role, action, table_name, target_type, result, payload)
values (null, 'de000000-0000-4000-8000-000000000001', 'super_admin', 'dev_seed_applied', 'organizations', 'platform', 'success', '{"source":"db/seed/dev.sql"}');

commit;

select set_config('app.system', 'off', false);
