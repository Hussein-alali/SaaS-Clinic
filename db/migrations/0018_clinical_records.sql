-- =====================================================================
-- 0018_clinical_records.sql — the patient file and the diagnosis follow
-- the clinic's department (owner request, 26 Oct 2026; docs/05, docs/06
-- «السجلات السريرية حسب التخصص»).
--
-- 1. specialties.diagnosis_form: which diagnosis (and patient file) a
--    specialty uses — physio (the body diagram), dental (the tooth chart)
--    or general (a short form). The Super Admin chooses it per specialty;
--    a new specialty is general until changed.
-- 2. dental.chart, general.visits and general.prescriptions are active
--    (prescriptions depend on the patients only and are also a default of
--    dental); clinics of those specialties get them switched on.
-- 3. assessments — every diagnosis record (kind physio | dental | general):
--    complaint, diagnosis, notes, the form's other fields in `data`, and
--    the pain points as coordinates only: markers = [[x, y], ...], each in
--    percent (0–100) of assets/body-diagram.jpeg. No image is stored.
-- 4. dental_findings — one row per tooth event: FDI tooth (adult 11–48,
--    child 51–85), surfaces (M O D B L), condition, status existing |
--    planned | done. The chart and each tooth's history come from them.
-- 5. prescriptions — items = [{name, dose, frequency, duration, notes}].
--
-- The three tables: FORCE RLS + tenant_isolation like every clinic table,
-- not branch-scoped (a patient's clinical record is one across branches,
-- like patients); read and written by admin, doctor and therapist (owner
-- decision), prescriptions written by admin and doctor; deleted by admin,
-- doctor or the row's author. author_uid / author_name come from the
-- session (trigger), whatever the client sends, and never change.
--
-- Expand only. PostgreSQL >= 13, no extensions. migrate.js wraps this file
-- in one transaction.
-- =====================================================================

-- ── 1. diagnosis form per specialty ──────────────────────────────────
alter table public.specialties
  add column diagnosis_form text not null default 'general'
  constraint specialties_diagnosis_form_chk check (diagnosis_form in ('physio', 'dental', 'general'));
update public.specialties set diagnosis_form = code where code in ('physio', 'dental');

-- ── 2. clinical modules ──────────────────────────────────────────────
update public.modules set status = 'active'
 where code in ('dental.chart', 'general.visits', 'general.prescriptions');
update public.modules set depends_on = '{core.patients}' where code = 'general.prescriptions';
insert into public.specialty_modules (specialty_id, module_id)
select s.id, m.id from public.specialties s, public.modules m
 where s.code = 'dental' and m.code = 'general.prescriptions'
on conflict do nothing;
-- Clinics whose specialty has them by default. They were 'planned' until
-- now, so no clinic could have chosen to switch them off.
insert into public.organization_modules (organization_id, module_id, enabled)
select o.id, sm.module_id, true
  from public.organizations o
  join public.specialty_modules sm on sm.specialty_id = o.primary_specialty_id
  join public.modules m on m.id = sm.module_id
 where m.code in ('dental.chart', 'general.visits', 'general.prescriptions')
on conflict (organization_id, module_id) do update set enabled = true, updated_at = now()
 where not public.organization_modules.enabled;

-- ── validators (used by CHECK constraints) ───────────────────────────
-- [[x, y], ...]: at most 200 points, two numbers each, 0 <= x, y <= 100.
create function public.valid_body_markers(p jsonb) returns boolean
  language plpgsql immutable set search_path = public
as $$
declare
  m jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'array' or jsonb_array_length(p) > 200 then return false; end if;
  for m in select value from jsonb_array_elements(p) loop
    if jsonb_typeof(m) <> 'array' or jsonb_array_length(m) <> 2
       or coalesce(jsonb_typeof(m -> 0), '') <> 'number' or coalesce(jsonb_typeof(m -> 1), '') <> 'number' then
      return false;
    end if;
    if (m ->> 0)::numeric not between 0 and 100 or (m ->> 1)::numeric not between 0 and 100 then return false; end if;
  end loop;
  return true;
end
$$;

-- 1–30 medicines; each an object with a non-empty name and only the known
-- string fields, 200 characters at most.
create function public.valid_rx_items(p jsonb) returns boolean
  language plpgsql immutable set search_path = public
as $$
declare
  item jsonb;
  k text;
begin
  if p is null or jsonb_typeof(p) <> 'array' or jsonb_array_length(p) not between 1 and 30 then return false; end if;
  for item in select value from jsonb_array_elements(p) loop
    if jsonb_typeof(item) <> 'object' then return false; end if;
    for k in select jsonb_object_keys(item) loop
      if k not in ('name', 'dose', 'frequency', 'duration', 'notes') then return false; end if;
      if jsonb_typeof(item -> k) <> 'string' or char_length(item ->> k) > 200 then return false; end if;
    end loop;
    if coalesce(btrim(item ->> 'name'), '') = '' then return false; end if;
  end loop;
  return true;
end
$$;

-- author_uid / author_name / created_at from the session on insert, kept
-- on update; updated_at always now. The system context (seed, imports)
-- keeps what it writes.
create function public.clinical_author_stamp() returns trigger
  language plpgsql set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if not public.app_is_system() then
      new.author_uid := auth.uid();
      new.author_name := (select coalesce(nullif(btrim(u.raw_user_meta_data ->> 'name'), ''), u.email)
                            from auth.users u where u.id = auth.uid());
      new.created_at := now();
    end if;
  else
    new.author_uid := old.author_uid;
    new.author_name := old.author_name;
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end
$$;

-- ── 3. assessments ───────────────────────────────────────────────────
create table public.assessments (
  assessment_id   text primary key default public.new_record_id('ASM-'),
  organization_id uuid not null default public.app_org_id() references public.organizations (id) on delete cascade,
  branch_id       text default public.app_branch_id(),
  patient_id      text not null,
  kind            text not null constraint assessments_kind_check check (kind in ('physio', 'dental', 'general')),
  visit_date      date not null default current_date,
  clinician_id    text check (char_length(clinician_id) <= 128),
  clinician_name  text check (char_length(clinician_name) <= 120),
  complaint       text check (char_length(complaint) <= 4000),
  diagnosis       text check (char_length(diagnosis) <= 4000),
  notes           text check (char_length(notes) <= 8000),
  data            jsonb not null default '{}'
                  constraint assessments_data_check check (jsonb_typeof(data) = 'object' and octet_length(data::text) <= 32768),
  markers         jsonb not null default '[]' constraint assessments_markers_check check (public.valid_body_markers(markers)),
  author_uid      uuid,
  author_name     text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint assessments_org_key unique (organization_id, assessment_id),
  constraint assessments_patient_id_fkey foreign key (organization_id, patient_id)
    references public.patients (organization_id, patient_id) on delete cascade,
  constraint assessments_branch_id_fkey foreign key (organization_id, branch_id)
    references public.branches (organization_id, id)
);
-- Patient ids are unique on the platform (patients_pkey): the patient's
-- records newest first.
create index assessments_patient_idx on public.assessments (patient_id, visit_date desc, created_at desc);
create index assessments_org_created_idx on public.assessments (organization_id, created_at desc);

-- ── 4. dental_findings ───────────────────────────────────────────────
create table public.dental_findings (
  finding_id      text primary key default public.new_record_id('DF-'),
  organization_id uuid not null default public.app_org_id() references public.organizations (id) on delete cascade,
  branch_id       text default public.app_branch_id(),
  patient_id      text not null,
  tooth           smallint not null constraint dental_findings_tooth_check check (
                    ((tooth / 10) between 1 and 4 and (tooth % 10) between 1 and 8)
                    or ((tooth / 10) between 5 and 8 and (tooth % 10) between 1 and 5)),
  surfaces        text[] not null default '{}' constraint dental_findings_surfaces_check check (
                    surfaces <@ array['M', 'O', 'D', 'B', 'L']::text[] and cardinality(surfaces) <= 5),
  condition       text not null constraint dental_findings_condition_check check (condition in (
                    'caries', 'fracture', 'watch', 'filling', 'crown', 'root_canal', 'implant',
                    'veneer', 'bridge', 'sealant', 'extraction', 'missing')),
  status          text not null constraint dental_findings_status_check check (status in ('existing', 'planned', 'done')),
  notes           text check (char_length(notes) <= 1000),
  assessment_id   text references public.assessments (assessment_id) on delete set null,
  recorded_on     date not null default current_date,
  author_uid      uuid,
  author_name     text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint dental_findings_org_key unique (organization_id, finding_id),
  constraint dental_findings_patient_id_fkey foreign key (organization_id, patient_id)
    references public.patients (organization_id, patient_id) on delete cascade,
  constraint dental_findings_branch_id_fkey foreign key (organization_id, branch_id)
    references public.branches (organization_id, id)
);
create index dental_findings_patient_idx on public.dental_findings (patient_id, tooth, recorded_on desc, created_at desc);

-- ── 5. prescriptions ─────────────────────────────────────────────────
create table public.prescriptions (
  prescription_id text primary key default public.new_record_id('RX-'),
  organization_id uuid not null default public.app_org_id() references public.organizations (id) on delete cascade,
  branch_id       text default public.app_branch_id(),
  patient_id      text not null,
  prescribed_on   date not null default current_date,
  items           jsonb not null constraint prescriptions_items_check check (public.valid_rx_items(items)),
  notes           text check (char_length(notes) <= 2000),
  assessment_id   text references public.assessments (assessment_id) on delete set null,
  author_uid      uuid,
  author_name     text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint prescriptions_org_key unique (organization_id, prescription_id),
  constraint prescriptions_patient_id_fkey foreign key (organization_id, patient_id)
    references public.patients (organization_id, patient_id) on delete cascade,
  constraint prescriptions_branch_id_fkey foreign key (organization_id, branch_id)
    references public.branches (organization_id, id)
);
create index prescriptions_patient_idx on public.prescriptions (patient_id, prescribed_on desc, created_at desc);

-- ── triggers and row-level security ──────────────────────────────────
do $$
declare
  t text;
  writers text;
begin
  foreach t in array array['assessments', 'dental_findings', 'prescriptions'] loop
    execute format('create trigger %I before insert or update on public.%I
      for each row execute function public.clinical_author_stamp()', t || '_author_stamp', t);

    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('create policy tenant_isolation on public.%I as restrictive for all to public
      using ((select public.app_is_system()) or organization_id = (select public.app_org_id()))
      with check ((select public.app_is_system()) or organization_id = (select public.app_org_id()))', t);
    execute format('create policy system_access on public.%I as permissive for all to public
      using ((select public.app_is_system())) with check ((select public.app_is_system()))', t);

    writers := case when t = 'prescriptions' then $w$array['admin', 'doctor']$w$
                    else $w$array['admin', 'doctor', 'therapist']$w$ end;
    execute format('create policy %I on public.%I for select to public
      using (public.app_role() = any (array[''admin'', ''doctor'', ''therapist'']))', 'clinical read ' || t, t);
    execute format('create policy %I on public.%I for insert to public
      with check (public.app_role() = any (%s))', 'clinical insert ' || t, t, writers);
    execute format('create policy %I on public.%I for update to public
      using (public.app_role() = any (%s)) with check (public.app_role() = any (%s))', 'clinical update ' || t, t, writers, writers);
    execute format('create policy %I on public.%I for delete to public
      using (public.app_role() = any (array[''admin'', ''doctor''])
             or (public.app_role() is not null and author_uid = auth.uid()))', 'clinical delete ' || t, t);
  end loop;
end
$$;
