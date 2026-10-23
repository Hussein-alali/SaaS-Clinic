-- ═══════════════════════════════════════════════════════════════
-- Catch-up migration: consolidated 2026-07-11 → 2026-07-12 changes
--
-- These changes shipped in the consolidated schema files but were never
-- added to this CLI migrations folder, so databases managed with
-- `supabase db push` were missing them. Contents:
--
--   Base objects appended to the schema after the baseline snapshot:
--   • bookings: price / paid / payment_status (Quick Payment)
--   • packages stub, patient_subscriptions, payments ledger (+RLS)
--   • record_quick_payment() atomic RPC
--   • treatment_methods library: table, RLS, default seeds, RPCs
--
--   Then the consolidated migrations, in order:
--   • 2026-07-11 — payments/receipts, treatment templates & methods
--   • extended patient fields + unique indexes
--   • patient_files metadata, FKs, indexes
--   • clinic settings columns + staff provenance
--   • staff-table roles + staff-wide patient INSERT (RLS)
--   • treatments (records created from templates)
--
-- Regenerated 2026-07-13 after the modalities column was dropped from
-- the product, so nothing here (re-)creates it.
-- Every statement is idempotent — safe on fresh and existing databases.
-- ═══════════════════════════════════════════════════════════════

-- ── Per-appointment pricing (Quick Payment) ─────────────────
-- Bookings gained a session price + running paid + payment_status so a
-- receptionist can settle individual appointments without an invoice row.
-- Safe to re-run.
alter table bookings add column if not exists price          numeric default 0;
alter table bookings add column if not exists paid           numeric default 0;
alter table bookings add column if not exists payment_status text default 'pending'
  check (payment_status in ('pending','partial','paid'));

-- ── Packages (declared early so patient_subscriptions FK resolves) ──
-- Full column set is (re-)declared further down; this stub only exists
-- so the `patient_subscriptions.package_id -> packages(id)` foreign key
-- can be created in a single-pass migration. `create table if not
-- exists` is a no-op if the full definition below already ran.
create table if not exists packages (
  id    text primary key,
  name  text
);

-- ── Patient subscriptions / active packages ────────────────
-- A patient may buy one or more packages (12 sessions, post-op 24 …).
-- Session counters and remaining balance live here so Quick Payment can
-- update package status atomically without touching the packages catalog.
create table if not exists patient_subscriptions (
  subscription_id  text primary key,
  patient_id       text references patients(patient_id) on delete cascade,
  package_id       text references packages(id) on delete set null,
  package_name     text not null,
  total_sessions   int  default 0,
  used_sessions    int  default 0,
  price            numeric default 0,
  paid             numeric default 0,
  status           text default 'active'
    check (status in ('active','paid','expired','cancelled')),
  expires_at       date,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);
create index if not exists patient_subscriptions_patient_id_idx
  on patient_subscriptions(patient_id);

-- ── Payment history (immutable ledger) ─────────────────────
-- Every Quick Payment writes exactly one row here. `allocations` is a
-- jsonb array of { type: 'appointment'|'invoice'|'subscription',
-- id: '...', amount: n } — this is the authoritative ledger for the
-- Payment History page and receipts.
create table if not exists payments (
  payment_id      text primary key,
  patient_id      text references patients(patient_id) on delete cascade,
  cashier_id      text,
  cashier_name    text,
  amount          numeric not null check (amount > 0),
  method          text not null,
  reference       text,
  transaction_id  text,
  notes           text,
  receipt_no      text unique,
  allocations     jsonb default '[]'::jsonb,
  ip_address      text,
  status          text default 'completed',
  created_at      timestamptz default now()
);
create index if not exists payments_patient_id_idx on payments(patient_id);
create index if not exists payments_created_at_idx on payments(created_at desc);

-- ── patient_subscriptions ────────────────────────────────────
alter table patient_subscriptions enable row level security;
drop policy if exists "staff read patient_subscriptions" on patient_subscriptions;
create policy "staff read patient_subscriptions" on patient_subscriptions for select using (
  public.app_role() in ('admin','receptionist','doctor','therapist')
);
drop policy if exists "admin/reception write patient_subscriptions" on patient_subscriptions;
create policy "admin/reception write patient_subscriptions" on patient_subscriptions for all using (
  public.app_role() in ('admin','receptionist')
) with check (
  public.app_role() in ('admin','receptionist')
);

-- ── payments (ledger) ────────────────────────────────────────
alter table payments enable row level security;
drop policy if exists "staff read payments" on payments;
create policy "staff read payments" on payments for select using (
  public.app_role() in ('admin','receptionist','doctor')
);
-- Direct client insert is allowed for admin/receptionist so the demo path
-- (RPC unavailable) still works. The RPC below runs SECURITY DEFINER and
-- bypasses this check when called normally.
drop policy if exists "admin/reception write payments" on payments;
create policy "admin/reception write payments" on payments for all using (
  public.app_role() in ('admin','receptionist')
) with check (
  public.app_role() in ('admin','receptionist')
);

-- ══════════════════════════════════════════════════════════════
-- Quick Payment RPC — atomic (single PG transaction)
-- ══════════════════════════════════════════════════════════════
-- Accepts a patient + a list of allocations and updates every parent row,
-- writes an immutable payment ledger row, and appends an audit event.
-- Anything that raises inside the function rolls the whole batch back.
--
-- allocations: jsonb array of objects:
--   { "type": "appointment"|"invoice"|"subscription", "id": "...", "amount": 350 }
--
-- Returns: { payment_id, receipt_no }.
create or replace function public.record_quick_payment(
  p_patient_id     text,
  p_allocations    jsonb,
  p_method         text,
  p_reference      text default null,
  p_transaction_id text default null,
  p_notes          text default null,
  p_cashier_id     text default null,
  p_cashier_name   text default null,
  p_ip_address     text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment_id  text;
  v_receipt_no  text;
  v_total       numeric := 0;
  v_alloc       jsonb;
  v_type        text;
  v_ref_id      text;
  v_amount      numeric;
  v_remaining   numeric;
  v_new_paid    numeric;
  v_row         record;
begin
  if p_patient_id is null then
    raise exception 'patient_id is required';
  end if;
  if not exists (select 1 from patients where patient_id = p_patient_id) then
    raise exception 'patient % not found', p_patient_id;
  end if;
  if jsonb_typeof(p_allocations) <> 'array' or jsonb_array_length(p_allocations) = 0 then
    raise exception 'allocations must be a non-empty array';
  end if;
  if p_method is null or length(trim(p_method)) = 0 then
    raise exception 'payment method is required';
  end if;

  -- Total = sum of allocation amounts. Reject negative / zero.
  for v_alloc in select * from jsonb_array_elements(p_allocations)
  loop
    v_amount := coalesce((v_alloc->>'amount')::numeric, 0);
    if v_amount <= 0 then
      raise exception 'allocation amount must be > 0 (got %)', v_amount;
    end if;
    v_total := v_total + v_amount;
  end loop;

  v_payment_id := 'PMT-' || to_char(now(), 'YYYYMMDDHH24MISSMS')
                        || '-' || substr(md5(random()::text), 1, 4);
  v_receipt_no := 'RCT-' || to_char(now(), 'YYYYMMDD') || '-'
                        || lpad((floor(random()*100000))::int::text, 5, '0');

  -- Apply each allocation. RAISE inside any branch aborts the whole tx.
  for v_alloc in select * from jsonb_array_elements(p_allocations)
  loop
    v_type   := v_alloc->>'type';
    v_ref_id := v_alloc->>'id';
    v_amount := (v_alloc->>'amount')::numeric;

    if v_type = 'appointment' then
      select * into v_row from bookings where booking_id = v_ref_id
        and patient_id = p_patient_id for update;
      if not found then
        raise exception 'appointment % not found for patient %', v_ref_id, p_patient_id;
      end if;
      v_remaining := coalesce(v_row.price, 0) - coalesce(v_row.paid, 0);
      if v_amount > v_remaining + 0.001 then
        raise exception 'appointment % payment (%) exceeds remaining (%)',
          v_ref_id, v_amount, v_remaining;
      end if;
      v_new_paid := coalesce(v_row.paid, 0) + v_amount;
      update bookings
         set paid = v_new_paid,
             payment_status = case
               when v_new_paid >= coalesce(v_row.price, 0) then 'paid'
               when v_new_paid > 0 then 'partial'
               else 'pending'
             end
       where booking_id = v_ref_id;

    elsif v_type = 'invoice' then
      select * into v_row from invoices where invoice_id = v_ref_id
        and patient_id = p_patient_id for update;
      if not found then
        raise exception 'invoice % not found for patient %', v_ref_id, p_patient_id;
      end if;
      v_remaining := coalesce(v_row.amount, 0) - coalesce(v_row.paid, 0);
      if v_remaining <= 0 then
        raise exception 'invoice % is already fully paid', v_ref_id;
      end if;
      if v_amount > v_remaining + 0.001 then
        raise exception 'invoice % payment (%) exceeds remaining (%)',
          v_ref_id, v_amount, v_remaining;
      end if;
      v_new_paid := coalesce(v_row.paid, 0) + v_amount;
      update invoices
         set paid = v_new_paid,
             payment_method = p_method,
             status = case
               when v_new_paid >= coalesce(v_row.amount, 0) then 'paid'
               when v_new_paid > 0 then 'partial'
               else 'pending'
             end
       where invoice_id = v_ref_id;

    elsif v_type = 'subscription' then
      select * into v_row from patient_subscriptions where subscription_id = v_ref_id
        and patient_id = p_patient_id for update;
      if not found then
        raise exception 'subscription % not found for patient %', v_ref_id, p_patient_id;
      end if;
      v_remaining := coalesce(v_row.price, 0) - coalesce(v_row.paid, 0);
      if v_remaining <= 0 then
        raise exception 'subscription % is already fully paid', v_ref_id;
      end if;
      if v_amount > v_remaining + 0.001 then
        raise exception 'subscription % payment (%) exceeds remaining (%)',
          v_ref_id, v_amount, v_remaining;
      end if;
      v_new_paid := coalesce(v_row.paid, 0) + v_amount;
      update patient_subscriptions
         set paid = v_new_paid,
             status = case
               when v_new_paid >= coalesce(v_row.price, 0) then 'paid'
               else 'active'
             end,
             updated_at = now()
       where subscription_id = v_ref_id;

    else
      raise exception 'unknown allocation type: %', v_type;
    end if;
  end loop;

  insert into payments (
    payment_id, patient_id, cashier_id, cashier_name,
    amount, method, reference, transaction_id, notes,
    receipt_no, allocations, ip_address
  ) values (
    v_payment_id, p_patient_id, p_cashier_id, p_cashier_name,
    v_total, p_method, p_reference, p_transaction_id, p_notes,
    v_receipt_no, p_allocations, p_ip_address
  );

  insert into audit_events (actor_uid, actor_role, action, table_name, row_pk, payload)
  values (
    auth.uid(),
    public.app_role(),
    'quick_payment',
    'payments',
    v_payment_id,
    jsonb_build_object(
      'patient_id',   p_patient_id,
      'amount',       v_total,
      'method',       p_method,
      'receipt_no',   v_receipt_no,
      'allocations',  p_allocations,
      'cashier_name', p_cashier_name,
      'ip_address',   p_ip_address
    )
  );

  return jsonb_build_object(
    'payment_id', v_payment_id,
    'receipt_no', v_receipt_no,
    'amount',     v_total
  );
end;
$$;

grant execute on function public.record_quick_payment(
  text, jsonb, text, text, text, text, text, text, text
) to authenticated;

-- ═══════════════════════════════════════════════════════════════
-- Treatment Methods ("طرق علاج أخرى")
-- Shared library of treatment methods that doctors can extend
-- at run-time. Feeds the method chips on TreatmentPlanCreate.
-- ═══════════════════════════════════════════════════════════════
create table if not exists treatment_methods (
  method_id        text primary key,
  name             text not null unique,
  category         text,
  description      text,
  duration_minutes int,
  notes            text,
  status           text not null default 'active'
                     check (status in ('active','archived')),
  created_by       uuid,
  created_by_name  text,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);
create index if not exists tx_methods_status_idx   on treatment_methods(status);
create index if not exists tx_methods_category_idx on treatment_methods(category);

alter table treatment_methods enable row level security;

-- Any signed-in staff can read the library.
drop policy if exists "staff read tx methods" on treatment_methods;
create policy "staff read tx methods" on treatment_methods for select using (
  public.app_role() in ('admin','receptionist','doctor','therapist')
);

-- Only admins and doctors can create / edit / archive.
drop policy if exists "doctor write tx methods" on treatment_methods;
create policy "doctor write tx methods" on treatment_methods for insert with check (
  public.app_role() in ('admin','doctor')
);
drop policy if exists "doctor update tx methods" on treatment_methods;
create policy "doctor update tx methods" on treatment_methods for update using (
  public.app_role() in ('admin','doctor')
) with check (
  public.app_role() in ('admin','doctor')
);
drop policy if exists "admin delete tx methods" on treatment_methods;
create policy "admin delete tx methods" on treatment_methods for delete using (
  public.app_role() = 'admin'
);

-- Seed the nine built-in methods that used to be hardcoded in
-- TreatmentPlanCreate. Safe to re-run.
insert into treatment_methods (method_id, name, category, status) values
  ('TM-DFLT-001', 'علاج يدوي',          'علاج يدوي',     'active'),
  ('TM-DFLT-002', 'تدريبات قوة',        'تمارين علاجية', 'active'),
  ('TM-DFLT-003', 'تمارين إطالة',       'تمارين علاجية', 'active'),
  ('TM-DFLT-004', 'علاج حراري',         'أجهزة علاجية', 'active'),
  ('TM-DFLT-005', 'تحفيز كهربي',        'أجهزة علاجية', 'active'),
  ('TM-DFLT-006', 'موجات فوق صوتية',    'أجهزة علاجية', 'active'),
  ('TM-DFLT-007', 'علاج مائي',          'علاج مائي',     'active'),
  ('TM-DFLT-008', 'حجامة',              'أخرى',          'active'),
  ('TM-DFLT-009', 'وخز جاف',            'علاج يدوي',     'active')
on conflict (name) do nothing;

-- ── RPC: transactional create with duplicate-name guard + audit
create or replace function public.create_treatment_method(
  p_method_id   text,
  p_name        text,
  p_category    text,
  p_description text,
  p_duration    int,
  p_notes       text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role         text := public.app_role();
  v_normalized   text := trim(p_name);
  v_creator_name text;
  v_dup          int;
begin
  if v_role not in ('admin','doctor') then
    raise exception 'غير مصرح: لا تملك صلاحية إضافة طرق علاج';
  end if;
  if v_normalized is null or v_normalized = '' then
    raise exception 'اسم طريقة العلاج مطلوب';
  end if;

  -- Case-insensitive duplicate guard (both active and archived rows).
  select count(*) into v_dup from treatment_methods
    where lower(trim(name)) = lower(v_normalized);
  if v_dup > 0 then
    raise exception 'اسم طريقة العلاج موجود مسبقًا';
  end if;

  select coalesce(name, '') into v_creator_name from staff
    where user_id = auth.uid() limit 1;

  insert into treatment_methods (
    method_id, name, category, description, duration_minutes, notes,
    status, created_by, created_by_name
  ) values (
    p_method_id, v_normalized, nullif(trim(coalesce(p_category,'')),''),
    nullif(trim(coalesce(p_description,'')),''), p_duration,
    nullif(trim(coalesce(p_notes,'')),''),
    'active', auth.uid(), v_creator_name
  );

  insert into audit_events (actor_uid, actor_role, action, table_name, row_pk, payload)
  values (
    auth.uid(), v_role, 'tx_method_create', 'treatment_methods', p_method_id,
    jsonb_build_object(
      'name', v_normalized, 'category', p_category,
      'description', p_description, 'duration_minutes', p_duration,
      'notes', p_notes, 'created_by_name', v_creator_name
    )
  );

  return jsonb_build_object(
    'method_id', p_method_id, 'name', v_normalized, 'status', 'active'
  );
end;
$$;
grant execute on function public.create_treatment_method(text,text,text,text,int,text)
  to authenticated;

-- ── RPC: rename / description / category / duration / notes update + audit
create or replace function public.update_treatment_method(
  p_method_id   text,
  p_name        text,
  p_category    text,
  p_description text,
  p_duration    int,
  p_notes       text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role       text := public.app_role();
  v_old        treatment_methods%rowtype;
  v_normalized text := trim(coalesce(p_name,''));
  v_dup        int;
begin
  if v_role not in ('admin','doctor') then
    raise exception 'غير مصرح';
  end if;
  select * into v_old from treatment_methods where method_id = p_method_id for update;
  if not found then
    raise exception 'طريقة العلاج غير موجودة';
  end if;
  if v_normalized = '' then
    raise exception 'الاسم مطلوب';
  end if;
  if lower(v_normalized) <> lower(v_old.name) then
    select count(*) into v_dup from treatment_methods
      where lower(trim(name)) = lower(v_normalized)
        and method_id <> p_method_id;
    if v_dup > 0 then
      raise exception 'اسم طريقة العلاج موجود مسبقًا';
    end if;
  end if;

  update treatment_methods set
    name             = v_normalized,
    category         = nullif(trim(coalesce(p_category,'')),''),
    description      = nullif(trim(coalesce(p_description,'')),''),
    duration_minutes = p_duration,
    notes            = nullif(trim(coalesce(p_notes,'')),''),
    updated_at       = now()
    where method_id  = p_method_id;

  insert into audit_events (actor_uid, actor_role, action, table_name, row_pk, payload)
  values (
    auth.uid(), v_role, 'tx_method_update', 'treatment_methods', p_method_id,
    jsonb_build_object(
      'old', to_jsonb(v_old),
      'new', jsonb_build_object(
        'name', v_normalized, 'category', p_category,
        'description', p_description, 'duration_minutes', p_duration,
        'notes', p_notes
      )
    )
  );
  return jsonb_build_object('method_id', p_method_id, 'name', v_normalized);
end;
$$;
grant execute on function public.update_treatment_method(text,text,text,text,int,text)
  to authenticated;

-- ── RPC: archive / restore toggle + audit
create or replace function public.set_treatment_method_status(
  p_method_id text,
  p_status    text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.app_role();
  v_old  text;
begin
  if v_role not in ('admin','doctor') then
    raise exception 'غير مصرح';
  end if;
  if p_status not in ('active','archived') then
    raise exception 'حالة غير صحيحة';
  end if;
  select status into v_old from treatment_methods
    where method_id = p_method_id for update;
  if not found then raise exception 'غير موجود'; end if;

  update treatment_methods
    set status = p_status, updated_at = now()
    where method_id = p_method_id;

  insert into audit_events (actor_uid, actor_role, action, table_name, row_pk, payload)
  values (
    auth.uid(), v_role,
    case when p_status='archived' then 'tx_method_archive' else 'tx_method_restore' end,
    'treatment_methods', p_method_id,
    jsonb_build_object('old_status', v_old, 'new_status', p_status)
  );
  return jsonb_build_object('method_id', p_method_id, 'status', p_status);
end;
$$;
grant execute on function public.set_treatment_method_status(text,text)
  to authenticated;

-- ┌────────────────────────────────────────────────────────────────────┐
-- │ 2. MIGRATION 2026-07-11 — payments/receipts, treatment templates & methods
-- │ (source: supabase-migration-2026-07-11.sql)
-- └────────────────────────────────────────────────────────────────────┘

-- ═════════════════════════════════════════════════════════════
-- Kinetic — combined migration (2026-07-11)
-- Apply in Supabase → SQL Editor → New query → paste → Run.
-- Idempotent: safe to re-run.
--
-- Bundles three migrations in dependency order:
--   1. Payments & Invoices  — list_invoices_filtered RPC,
--                              payment_receipts table + RLS,
--                              delete_payment_receipt RPC
--   2. Treatment Templates  — treatment_templates + versions
--                              + usage tables, 9 RPCs
--   3. Treatment Methods v2 — icon/color/display_order columns,
--                              upsert + delete RPCs (delete blocks
--                              when a template references the
--                              method by id OR by name)
-- ═════════════════════════════════════════════════════════════


-- ═════════════════════════════════════════════════════════════
-- 1. PAYMENTS & INVOICES
-- ═════════════════════════════════════════════════════════════

-- ── 1a. list_invoices_filtered RPC ───────────────────────────
-- Returns rows + stats + count in one round-trip. Used by the
-- Payments & Invoices page date-filter.
create or replace function public.list_invoices_filtered(
  p_from    timestamptz default null,
  p_to      timestamptz default null,
  p_search  text        default null,
  p_status  text        default null,
  p_limit   int         default 50,
  p_offset  int         default 0
) returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_lim   int := least(greatest(coalesce(p_limit, 50), 1), 500);
  v_off   int := greatest(coalesce(p_offset, 0), 0);
  v_from  timestamptz := p_from;
  v_to    timestamptz := case
    when p_to is null then null
    else (date_trunc('day', p_to) + interval '1 day' - interval '1 microsecond')
  end;
  v_srch  text := nullif(btrim(coalesce(p_search, '')), '');
  v_st    text := nullif(btrim(coalesce(p_status, '')), '');
  v_rows  jsonb;
  v_stats jsonb;
  v_count int;
begin
  with base as (
    select i.invoice_id, i.patient_id, i.amount, i.paid, i.payment_method,
           i.status, i.created_at,
           coalesce(p.name, '') as patient_name
      from invoices i
      left join patients p on p.patient_id = i.patient_id
     where (v_from is null or i.created_at >= v_from)
       and (v_to   is null or i.created_at <= v_to)
       and (v_st   is null or i.status = v_st)
       and (
         v_srch is null
         or i.invoice_id ilike '%'||v_srch||'%'
         or coalesce(p.name,'') ilike '%'||v_srch||'%'
       )
  ),
  page as (
    select * from base
    order by created_at desc, invoice_id desc
    limit v_lim offset v_off
  )
  select
    coalesce(jsonb_agg(to_jsonb(page.*) order by created_at desc, invoice_id desc), '[]'::jsonb),
    (select count(*)::int from base)
  into v_rows, v_count
  from page;

  select jsonb_build_object(
    'count',         v_count,
    'total_invoices',(select coalesce(sum(amount),0) from invoices i
                       left join patients p on p.patient_id = i.patient_id
                      where (v_from is null or i.created_at >= v_from)
                        and (v_to   is null or i.created_at <= v_to)
                        and (v_st   is null or i.status = v_st)
                        and (v_srch is null
                             or i.invoice_id ilike '%'||v_srch||'%'
                             or coalesce(p.name,'') ilike '%'||v_srch||'%')),
    'paid_amount',   (select coalesce(sum(paid),0) from invoices i
                       left join patients p on p.patient_id = i.patient_id
                      where (v_from is null or i.created_at >= v_from)
                        and (v_to   is null or i.created_at <= v_to)
                        and (v_st   is null or i.status = v_st)
                        and (v_srch is null
                             or i.invoice_id ilike '%'||v_srch||'%'
                             or coalesce(p.name,'') ilike '%'||v_srch||'%')),
    'outstanding',   (select coalesce(sum(greatest(coalesce(amount,0)-coalesce(paid,0),0)),0)
                        from invoices i
                        left join patients p on p.patient_id = i.patient_id
                       where (v_from is null or i.created_at >= v_from)
                         and (v_to   is null or i.created_at <= v_to)
                         and (v_st   is null or i.status = v_st)
                         and (v_srch is null
                              or i.invoice_id ilike '%'||v_srch||'%'
                              or coalesce(p.name,'') ilike '%'||v_srch||'%')),
    'overdue_amount',(select coalesce(sum(greatest(coalesce(amount,0)-coalesce(paid,0),0)),0)
                        from invoices i
                        left join patients p on p.patient_id = i.patient_id
                       where (v_from is null or i.created_at >= v_from)
                         and (v_to   is null or i.created_at <= v_to)
                         and i.status = 'متأخر'
                         and (v_st   is null or i.status = v_st)
                         and (v_srch is null
                              or i.invoice_id ilike '%'||v_srch||'%'
                              or coalesce(p.name,'') ilike '%'||v_srch||'%')),
    'avg_amount',    (select coalesce(avg(amount),0) from invoices i
                       left join patients p on p.patient_id = i.patient_id
                      where (v_from is null or i.created_at >= v_from)
                        and (v_to   is null or i.created_at <= v_to)
                        and (v_st   is null or i.status = v_st)
                        and (v_srch is null
                             or i.invoice_id ilike '%'||v_srch||'%'
                             or coalesce(p.name,'') ilike '%'||v_srch||'%'))
  ) into v_stats;

  return jsonb_build_object(
    'rows',  v_rows,
    'stats', v_stats,
    'count', v_count,
    'limit', v_lim,
    'offset',v_off
  );
end;
$$;

grant execute on function public.list_invoices_filtered(timestamptz,timestamptz,text,text,int,int)
  to authenticated;

-- ── 1b. payment_receipts table + RLS ─────────────────────────
-- Every uploaded receipt file (image/PDF) tied to a payment row.
-- Files live in Supabase Storage; this table stores metadata + path.
-- Soft-delete via deleted_at so the payment is never lost.
create table if not exists payment_receipts (
  receipt_id       text primary key,
  payment_id       text references payments(payment_id) on delete cascade,
  invoice_id       text references invoices(invoice_id) on delete set null,
  patient_id       text references patients(patient_id) on delete cascade,
  file_name        text,
  stored_name      text,
  storage_path     text,
  file_url         text,
  file_type        text,
  file_size        int,
  uploaded_by      uuid,
  uploaded_by_name text,
  uploaded_at      timestamptz default now(),
  deleted_at       timestamptz,
  deleted_by       uuid
);
create index if not exists payment_receipts_payment_idx  on payment_receipts(payment_id);
create index if not exists payment_receipts_invoice_idx  on payment_receipts(invoice_id);
create index if not exists payment_receipts_patient_idx  on payment_receipts(patient_id);

alter table payment_receipts enable row level security;

drop policy if exists "staff read receipts" on payment_receipts;
create policy "staff read receipts" on payment_receipts for select using (
  public.app_role() in ('admin','receptionist','doctor','therapist')
);
drop policy if exists "reception write receipts" on payment_receipts;
create policy "reception write receipts" on payment_receipts for insert
  with check (public.app_role() in ('admin','receptionist'));
drop policy if exists "reception update receipts" on payment_receipts;
create policy "reception update receipts" on payment_receipts for update using (
  public.app_role() in ('admin','receptionist')
);

-- ── 1c. delete_payment_receipt RPC ───────────────────────────
-- Admin-only soft-delete + audit log entry.
create or replace function public.delete_payment_receipt(
  p_receipt_id text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.app_role();
  v_row  payment_receipts%rowtype;
begin
  if v_role <> 'admin' then
    raise exception 'غير مصرح — الحذف مقتصر على المدير';
  end if;
  select * into v_row from payment_receipts where receipt_id = p_receipt_id for update;
  if not found then raise exception 'الإيصال غير موجود'; end if;
  if v_row.deleted_at is not null then
    return jsonb_build_object('receipt_id', p_receipt_id, 'already_deleted', true);
  end if;
  update payment_receipts
    set deleted_at = now(), deleted_by = auth.uid()
    where receipt_id = p_receipt_id;
  insert into audit_events (actor_uid, actor_role, action, table_name, row_pk, payload)
  values (auth.uid(), v_role, 'receipt_delete', 'payment_receipts', p_receipt_id,
    jsonb_build_object('payment_id', v_row.payment_id, 'invoice_id', v_row.invoice_id));
  return jsonb_build_object('receipt_id', p_receipt_id, 'deleted', true);
end;
$$;
grant execute on function public.delete_payment_receipt(text) to authenticated;


-- ═════════════════════════════════════════════════════════════
-- 2. TREATMENT PLAN TEMPLATES ("قوالب خطط العلاج")
-- Full library of reusable treatment plans doctors can apply to
-- patients. Exercises/methods/goals live inline as
-- JSONB arrays so a template is one atomic row + one round-trip.
-- Versions and usage are tracked in side tables for restore &
-- statistics. Receptionists have no access. Doctors + admins can
-- create/edit; therapists can view + apply.
-- ═════════════════════════════════════════════════════════════
create table if not exists treatment_templates (
  template_id            text primary key,
  name                   text not null,
  category               text,
  diagnosis              text,
  body_part              text,
  goals                  jsonb not null default '[]'::jsonb,
  exercises              jsonb not null default '[]'::jsonb,
  methods                jsonb not null default '[]'::jsonb,
  home_instructions      text,
  notes                  text,
  warnings               text,
  followup_instructions  text,
  estimated_sessions     int,
  weekly_frequency       int,
  expected_recovery_days int,
  status                 text not null default 'active'
                           check (status in ('active','archived')),
  version                int  not null default 1,
  usage_count            int  not null default 0,
  last_used_at           timestamptz,
  avg_recovery_days      numeric,
  completion_rate        numeric,
  created_by             uuid,
  created_by_name        text,
  updated_by             uuid,
  updated_by_name        text,
  created_at             timestamptz default now(),
  updated_at             timestamptz default now()
);
create index if not exists tx_templates_status_idx    on treatment_templates(status);
create index if not exists tx_templates_category_idx  on treatment_templates(category);
create index if not exists tx_templates_creator_idx   on treatment_templates(created_by);
create index if not exists tx_templates_usage_idx     on treatment_templates(usage_count desc);
create index if not exists tx_templates_created_idx   on treatment_templates(created_at desc);

alter table treatment_templates enable row level security;

-- Read: everyone except receptionist.
drop policy if exists "clinical read templates" on treatment_templates;
create policy "clinical read templates" on treatment_templates for select using (
  public.app_role() in ('admin','doctor','therapist')
);
drop policy if exists "doctor write templates" on treatment_templates;
create policy "doctor write templates" on treatment_templates for insert with check (
  public.app_role() in ('admin','doctor')
);
drop policy if exists "doctor update templates" on treatment_templates;
create policy "doctor update templates" on treatment_templates for update using (
  public.app_role() in ('admin','doctor')
) with check (
  public.app_role() in ('admin','doctor')
);
drop policy if exists "doctor delete templates" on treatment_templates;
create policy "doctor delete templates" on treatment_templates for delete using (
  public.app_role() in ('admin','doctor')
);

-- ── Version history (snapshot per edit) ──────────────────────
create table if not exists template_versions (
  version_id     text primary key,
  template_id    text not null references treatment_templates(template_id) on delete cascade,
  version_num    int  not null,
  editor_uid     uuid,
  editor_name    text,
  change_summary text,
  snapshot       jsonb not null,
  created_at     timestamptz default now()
);
create index if not exists tx_ver_template_idx on template_versions(template_id, version_num desc);

alter table template_versions enable row level security;
drop policy if exists "clinical read versions" on template_versions;
create policy "clinical read versions" on template_versions for select using (
  public.app_role() in ('admin','doctor','therapist')
);
-- Only RPCs (security definer) write to versions — no direct policy.

-- ── Usage log (which patients used which template) ───────────
create table if not exists template_usage (
  use_id          text primary key,
  template_id     text not null references treatment_templates(template_id) on delete cascade,
  patient_id      text,
  plan_id         text,
  applied_by      uuid,
  applied_by_name text,
  applied_at      timestamptz default now(),
  completed_at    timestamptz,
  recovery_days   int
);
create index if not exists tx_use_template_idx on template_usage(template_id);
create index if not exists tx_use_patient_idx  on template_usage(patient_id);

alter table template_usage enable row level security;
drop policy if exists "clinical read usage" on template_usage;
create policy "clinical read usage" on template_usage for select using (
  public.app_role() in ('admin','doctor','therapist')
);
-- Writes go through RPCs.

-- ── Helper: audit + version ──────────────────────────────────
create or replace function public._tpl_snapshot(p_template_id text) returns jsonb
language sql stable security definer set search_path = public as $$
  select to_jsonb(t.*) from treatment_templates t where t.template_id = p_template_id
$$;

create or replace function public._tpl_write_version(
  p_template_id text, p_editor_uid uuid, p_editor_name text, p_summary text
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_num int;
  v_id  text;
  v_snap jsonb;
begin
  select coalesce(max(version_num),0) + 1 into v_num
    from template_versions where template_id = p_template_id;
  v_id := 'TV-' || p_template_id || '-' || v_num;
  v_snap := public._tpl_snapshot(p_template_id);
  insert into template_versions(version_id, template_id, version_num, editor_uid, editor_name, change_summary, snapshot)
  values (v_id, p_template_id, v_num, p_editor_uid, p_editor_name, p_summary, v_snap);
  update treatment_templates set version = v_num where template_id = p_template_id;
end;
$$;

-- ── RPC: create template ─────────────────────────────────────
create or replace function public.create_treatment_template(
  p_template_id text,
  p_payload     jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role  text := public.app_role();
  v_uid   uuid := auth.uid();
  v_name  text := coalesce((p_payload->>'created_by_name'),'');
  v_new_id text := p_template_id;
begin
  if v_role not in ('admin','doctor') then
    raise exception 'غير مصرح — الإنشاء مقتصر على المدير والطبيب';
  end if;
  if coalesce(btrim(p_payload->>'name'),'') = '' then
    raise exception 'اسم القالب مطلوب';
  end if;
  if v_new_id is null or v_new_id = '' then
    v_new_id := 'TPL-' || to_char(now(),'YYYYMMDD-HH24MISS') || '-'
             || upper(substr(md5(random()::text),1,4));
  end if;

  insert into treatment_templates (
    template_id, name, category, diagnosis, body_part,
    goals, exercises, methods,
    home_instructions, notes, warnings, followup_instructions,
    estimated_sessions, weekly_frequency, expected_recovery_days,
    status, version, created_by, created_by_name, updated_by, updated_by_name
  ) values (
    v_new_id,
    btrim(p_payload->>'name'),
    nullif(p_payload->>'category',''),
    nullif(p_payload->>'diagnosis',''),
    nullif(p_payload->>'body_part',''),
    coalesce(p_payload->'goals','[]'::jsonb),
    coalesce(p_payload->'exercises','[]'::jsonb),
    coalesce(p_payload->'methods','[]'::jsonb),
    nullif(p_payload->>'home_instructions',''),
    nullif(p_payload->>'notes',''),
    nullif(p_payload->>'warnings',''),
    nullif(p_payload->>'followup_instructions',''),
    nullif(p_payload->>'estimated_sessions','')::int,
    nullif(p_payload->>'weekly_frequency','')::int,
    nullif(p_payload->>'expected_recovery_days','')::int,
    'active', 1, v_uid, v_name, v_uid, v_name
  );

  perform public._tpl_write_version(v_new_id, v_uid, v_name, 'إنشاء');

  insert into audit_events (actor_uid, actor_role, action, table_name, row_pk, payload)
  values (v_uid, v_role, 'template_create', 'treatment_templates', v_new_id, p_payload);

  return jsonb_build_object('template_id', v_new_id);
end;
$$;
grant execute on function public.create_treatment_template(text, jsonb) to authenticated;

-- ── RPC: update template ─────────────────────────────────────
create or replace function public.update_treatment_template(
  p_template_id   text,
  p_payload       jsonb,
  p_change_summary text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.app_role();
  v_uid  uuid := auth.uid();
  v_name text := coalesce((p_payload->>'updated_by_name'),'');
  v_old  jsonb;
begin
  if v_role not in ('admin','doctor') then
    raise exception 'غير مصرح — التعديل مقتصر على المدير والطبيب';
  end if;
  v_old := public._tpl_snapshot(p_template_id);
  if v_old is null then raise exception 'القالب غير موجود'; end if;

  update treatment_templates set
    name                   = coalesce(nullif(btrim(p_payload->>'name'),''), name),
    category               = coalesce(nullif(p_payload->>'category',''), category),
    diagnosis              = coalesce(nullif(p_payload->>'diagnosis',''), diagnosis),
    body_part              = coalesce(nullif(p_payload->>'body_part',''), body_part),
    goals                  = coalesce(p_payload->'goals', goals),
    exercises              = coalesce(p_payload->'exercises', exercises),
    methods                = coalesce(p_payload->'methods', methods),
    home_instructions      = coalesce(nullif(p_payload->>'home_instructions',''), home_instructions),
    notes                  = coalesce(nullif(p_payload->>'notes',''), notes),
    warnings               = coalesce(nullif(p_payload->>'warnings',''), warnings),
    followup_instructions  = coalesce(nullif(p_payload->>'followup_instructions',''), followup_instructions),
    estimated_sessions     = coalesce(nullif(p_payload->>'estimated_sessions','')::int, estimated_sessions),
    weekly_frequency       = coalesce(nullif(p_payload->>'weekly_frequency','')::int, weekly_frequency),
    expected_recovery_days = coalesce(nullif(p_payload->>'expected_recovery_days','')::int, expected_recovery_days),
    updated_by             = v_uid,
    updated_by_name        = v_name,
    updated_at             = now()
    where template_id = p_template_id;

  perform public._tpl_write_version(p_template_id, v_uid, v_name, coalesce(p_change_summary,'تعديل'));

  insert into audit_events (actor_uid, actor_role, action, table_name, row_pk, payload)
  values (v_uid, v_role, 'template_update', 'treatment_templates', p_template_id,
    jsonb_build_object('old', v_old, 'new', p_payload, 'summary', p_change_summary));

  return jsonb_build_object('template_id', p_template_id);
end;
$$;
grant execute on function public.update_treatment_template(text, jsonb, text) to authenticated;

-- ── RPC: duplicate template ──────────────────────────────────
create or replace function public.duplicate_treatment_template(
  p_template_id text,
  p_new_name    text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role  text := public.app_role();
  v_uid   uuid := auth.uid();
  v_src   treatment_templates%rowtype;
  v_new_id text;
begin
  if v_role not in ('admin','doctor') then
    raise exception 'غير مصرح — النسخ مقتصر على المدير والطبيب';
  end if;
  select * into v_src from treatment_templates where template_id = p_template_id;
  if not found then raise exception 'القالب غير موجود'; end if;

  v_new_id := 'TPL-' || to_char(now(),'YYYYMMDD-HH24MISS') || '-'
           || upper(substr(md5(random()::text),1,4));

  insert into treatment_templates (
    template_id, name, category, diagnosis, body_part,
    goals, exercises, methods,
    home_instructions, notes, warnings, followup_instructions,
    estimated_sessions, weekly_frequency, expected_recovery_days,
    status, version, created_by, created_by_name, updated_by, updated_by_name
  ) values (
    v_new_id,
    coalesce(nullif(btrim(p_new_name),''), v_src.name || ' — نسخة'),
    v_src.category, v_src.diagnosis, v_src.body_part,
    v_src.goals, v_src.exercises, v_src.methods,
    v_src.home_instructions, v_src.notes, v_src.warnings, v_src.followup_instructions,
    v_src.estimated_sessions, v_src.weekly_frequency, v_src.expected_recovery_days,
    'active', 1, v_uid,
    coalesce((select raw_user_meta_data->>'name' from auth.users where id = v_uid),'—'),
    v_uid,
    coalesce((select raw_user_meta_data->>'name' from auth.users where id = v_uid),'—')
  );

  perform public._tpl_write_version(v_new_id, v_uid, null, 'نسخة من ' || p_template_id);

  insert into audit_events (actor_uid, actor_role, action, table_name, row_pk, payload)
  values (v_uid, v_role, 'template_duplicate', 'treatment_templates', v_new_id,
    jsonb_build_object('source_id', p_template_id));

  return jsonb_build_object('template_id', v_new_id, 'source_id', p_template_id);
end;
$$;
grant execute on function public.duplicate_treatment_template(text, text) to authenticated;

-- ── RPC: archive / restore ───────────────────────────────────
create or replace function public.set_treatment_template_status(
  p_template_id text,
  p_status      text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.app_role();
  v_uid  uuid := auth.uid();
begin
  if v_role not in ('admin','doctor') then
    raise exception 'غير مصرح';
  end if;
  if p_status not in ('active','archived') then
    raise exception 'حالة غير صحيحة';
  end if;
  update treatment_templates set status = p_status, updated_at = now(), updated_by = v_uid
    where template_id = p_template_id;
  if not found then raise exception 'القالب غير موجود'; end if;

  insert into audit_events (actor_uid, actor_role, action, table_name, row_pk, payload)
  values (v_uid, v_role,
    case when p_status='archived' then 'template_archive' else 'template_restore' end,
    'treatment_templates', p_template_id, jsonb_build_object('status', p_status));

  return jsonb_build_object('template_id', p_template_id, 'status', p_status);
end;
$$;
grant execute on function public.set_treatment_template_status(text, text) to authenticated;

-- ── RPC: delete template (hard-delete only if never used) ────
create or replace function public.delete_treatment_template(
  p_template_id text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.app_role();
  v_uid  uuid := auth.uid();
  v_uses int;
  v_row  treatment_templates%rowtype;
begin
  if v_role not in ('admin','doctor') then
    raise exception 'غير مصرح';
  end if;
  select * into v_row from treatment_templates where template_id = p_template_id;
  if not found then raise exception 'القالب غير موجود'; end if;

  select count(*)::int into v_uses from template_usage where template_id = p_template_id;
  if v_uses > 0 or coalesce(v_row.usage_count,0) > 0 then
    raise exception 'لا يمكن حذف قالب مستخدم — استخدم الأرشفة بدلاً منه';
  end if;

  delete from treatment_templates where template_id = p_template_id;

  insert into audit_events (actor_uid, actor_role, action, table_name, row_pk, payload)
  values (v_uid, v_role, 'template_delete', 'treatment_templates', p_template_id,
    to_jsonb(v_row));

  return jsonb_build_object('template_id', p_template_id, 'deleted', true);
end;
$$;
grant execute on function public.delete_treatment_template(text) to authenticated;

-- ── RPC: apply template to a patient ─────────────────────────
create or replace function public.apply_template_to_patient(
  p_template_id text,
  p_patient_id  text,
  p_plan_id     text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.app_role();
  v_uid  uuid := auth.uid();
  v_name text := coalesce((select raw_user_meta_data->>'name' from auth.users where id = v_uid),'—');
  v_use_id text;
  v_status text;
begin
  if v_role not in ('admin','doctor','therapist') then
    raise exception 'غير مصرح';
  end if;
  select status into v_status from treatment_templates where template_id = p_template_id;
  if v_status is null then raise exception 'القالب غير موجود'; end if;
  if v_status = 'archived' then
    raise exception 'لا يمكن تطبيق قالب مؤرشف';
  end if;

  v_use_id := 'TU-' || to_char(now(),'YYYYMMDD-HH24MISS') || '-'
           || upper(substr(md5(random()::text),1,4));
  insert into template_usage (use_id, template_id, patient_id, plan_id, applied_by, applied_by_name)
  values (v_use_id, p_template_id, p_patient_id, p_plan_id, v_uid, v_name);

  update treatment_templates
     set usage_count  = coalesce(usage_count,0) + 1,
         last_used_at = now()
   where template_id = p_template_id;

  insert into audit_events (actor_uid, actor_role, action, table_name, row_pk, payload)
  values (v_uid, v_role, 'template_apply', 'treatment_templates', p_template_id,
    jsonb_build_object('patient_id', p_patient_id, 'plan_id', p_plan_id, 'use_id', v_use_id));

  return jsonb_build_object('use_id', v_use_id, 'template_id', p_template_id);
end;
$$;
grant execute on function public.apply_template_to_patient(text, text, text) to authenticated;

-- ── RPC: list templates with search + filters + pagination ───
create or replace function public.list_treatment_templates(
  p_status     text  default null,
  p_category   text  default null,
  p_creator    uuid  default null,
  p_search     text  default null,
  p_sort       text  default 'recent',
  p_limit      int   default 100,
  p_offset     int   default 0
) returns jsonb
language plpgsql security definer set search_path = public stable as $$
declare
  v_lim int := least(greatest(coalesce(p_limit,100),1),500);
  v_off int := greatest(coalesce(p_offset,0),0);
  v_srch text := nullif(btrim(coalesce(p_search,'')),'');
  v_st   text := nullif(btrim(coalesce(p_status,'')),'');
  v_cat  text := nullif(btrim(coalesce(p_category,'')),'');
  v_rows jsonb;
  v_cnt  int;
begin
  if public.app_role() not in ('admin','doctor','therapist') then
    raise exception 'غير مصرح';
  end if;

  with base as (
    select t.*
      from treatment_templates t
     where (v_st  is null or t.status   = v_st)
       and (v_cat is null or t.category = v_cat)
       and (p_creator is null or t.created_by = p_creator)
       and (
         v_srch is null
         or t.name      ilike '%'||v_srch||'%'
         or t.diagnosis ilike '%'||v_srch||'%'
         or t.category  ilike '%'||v_srch||'%'
         or t.body_part ilike '%'||v_srch||'%'
         or (t.exercises::text ilike '%'||v_srch||'%')
         or (t.methods  ::text ilike '%'||v_srch||'%')
       )
  ),
  ordered as (
    select * from base
    order by
      case when p_sort = 'usage'   then usage_count end desc nulls last,
      case when p_sort = 'name'    then name       end asc  nulls last,
      case when p_sort = 'oldest'  then created_at end asc  nulls last,
      created_at desc
    limit v_lim offset v_off
  )
  select coalesce(jsonb_agg(to_jsonb(ordered.*)),'[]'::jsonb),
         (select count(*)::int from base)
    into v_rows, v_cnt
    from ordered;

  return jsonb_build_object('rows', v_rows, 'count', v_cnt,
                             'limit', v_lim, 'offset', v_off);
end;
$$;
grant execute on function public.list_treatment_templates(text,text,uuid,text,text,int,int) to authenticated;

-- ── RPC: fetch a single template + versions + usage stats ────
create or replace function public.get_treatment_template(
  p_template_id text
) returns jsonb
language plpgsql security definer set search_path = public stable as $$
declare
  v_tpl jsonb;
  v_versions jsonb;
  v_stats jsonb;
begin
  if public.app_role() not in ('admin','doctor','therapist') then
    raise exception 'غير مصرح';
  end if;
  select to_jsonb(t.*) into v_tpl from treatment_templates t where t.template_id = p_template_id;
  if v_tpl is null then return null; end if;

  select coalesce(jsonb_agg(to_jsonb(v.*) order by v.version_num desc),'[]'::jsonb)
    into v_versions
    from template_versions v where v.template_id = p_template_id;

  select jsonb_build_object(
    'usage_count',    coalesce(count(*),0),
    'completion_rate',coalesce(round(avg( (completed_at is not null)::int )::numeric * 100, 1), 0),
    'avg_recovery',   coalesce(round(avg(recovery_days),1), 0),
    'last_used_at',   max(applied_at)
  ) into v_stats
    from template_usage where template_id = p_template_id;

  return jsonb_build_object('template', v_tpl, 'versions', v_versions, 'stats', v_stats);
end;
$$;
grant execute on function public.get_treatment_template(text) to authenticated;

-- ── RPC: restore a previous version ──────────────────────────
create or replace function public.restore_template_version(
  p_version_id text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.app_role();
  v_uid  uuid := auth.uid();
  v_v    template_versions%rowtype;
  v_snap jsonb;
begin
  if v_role not in ('admin','doctor') then
    raise exception 'غير مصرح';
  end if;
  select * into v_v from template_versions where version_id = p_version_id;
  if not found then raise exception 'الإصدار غير موجود'; end if;
  v_snap := v_v.snapshot;

  update treatment_templates set
    name                   = v_snap->>'name',
    category               = v_snap->>'category',
    diagnosis              = v_snap->>'diagnosis',
    body_part              = v_snap->>'body_part',
    goals                  = coalesce(v_snap->'goals','[]'::jsonb),
    exercises              = coalesce(v_snap->'exercises','[]'::jsonb),
    methods                = coalesce(v_snap->'methods','[]'::jsonb),
    home_instructions      = v_snap->>'home_instructions',
    notes                  = v_snap->>'notes',
    warnings               = v_snap->>'warnings',
    followup_instructions  = v_snap->>'followup_instructions',
    estimated_sessions     = nullif(v_snap->>'estimated_sessions','')::int,
    weekly_frequency       = nullif(v_snap->>'weekly_frequency','')::int,
    expected_recovery_days = nullif(v_snap->>'expected_recovery_days','')::int,
    updated_by             = v_uid,
    updated_at             = now()
    where template_id = v_v.template_id;

  perform public._tpl_write_version(v_v.template_id, v_uid, null,
    'استعادة الإصدار ' || v_v.version_num);

  insert into audit_events (actor_uid, actor_role, action, table_name, row_pk, payload)
  values (v_uid, v_role, 'template_restore_version', 'treatment_templates', v_v.template_id,
    jsonb_build_object('version_id', p_version_id, 'version_num', v_v.version_num));

  return jsonb_build_object('template_id', v_v.template_id);
end;
$$;
grant execute on function public.restore_template_version(text) to authenticated;


-- ═════════════════════════════════════════════════════════════
-- 3. TREATMENT METHODS v2 (icon / color / display_order + hard delete)
-- Adds visual attributes and a delete RPC that refuses to remove
-- methods used by any template. Existing v1 create/update RPCs
-- stay intact so old callers still work.
-- ═════════════════════════════════════════════════════════════
alter table treatment_methods
  add column if not exists icon           text,
  add column if not exists color          text,
  add column if not exists display_order  int;

create index if not exists tx_methods_order_idx
  on treatment_methods(display_order nulls last, name);

-- ── RPC: upsert (create or update) with full field set ───────
create or replace function public.upsert_treatment_method(
  p_method_id text,
  p_payload   jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role   text := public.app_role();
  v_uid    uuid := auth.uid();
  v_name   text := btrim(coalesce(p_payload->>'name',''));
  v_id     text := p_method_id;
  v_old    treatment_methods%rowtype;
  v_dup    int;
  v_action text;
begin
  if v_role not in ('admin','doctor') then
    raise exception 'غير مصرح — لا تملك صلاحية إدارة طرق العلاج';
  end if;
  if v_name = '' then raise exception 'اسم طريقة العلاج مطلوب'; end if;

  if v_id is null or v_id = '' then
    v_id := 'TM-' || to_char(now(),'YYYYMMDD-HH24MISS') || '-'
         || upper(substr(md5(random()::text),1,4));
  end if;

  select * into v_old from treatment_methods where method_id = v_id for update;
  v_action := case when found then 'tx_method_update' else 'tx_method_create' end;

  select count(*) into v_dup from treatment_methods
    where lower(trim(name)) = lower(v_name) and method_id <> v_id;
  if v_dup > 0 then raise exception 'اسم طريقة العلاج موجود مسبقًا'; end if;

  if found then
    update treatment_methods set
      name             = v_name,
      category         = nullif(btrim(coalesce(p_payload->>'category','')),''),
      description      = nullif(btrim(coalesce(p_payload->>'description','')),''),
      duration_minutes = nullif(p_payload->>'duration_minutes','')::int,
      notes            = nullif(btrim(coalesce(p_payload->>'notes','')),''),
      icon             = nullif(btrim(coalesce(p_payload->>'icon','')),''),
      color            = nullif(btrim(coalesce(p_payload->>'color','')),''),
      display_order    = nullif(p_payload->>'display_order','')::int,
      status           = case when coalesce(p_payload->>'is_active','true')='false'
                                then 'archived' else coalesce(status,'active') end,
      updated_at       = now()
      where method_id  = v_id;
  else
    insert into treatment_methods (
      method_id, name, category, description, duration_minutes, notes,
      icon, color, display_order, status, created_by, created_by_name
    ) values (
      v_id, v_name,
      nullif(btrim(coalesce(p_payload->>'category','')),''),
      nullif(btrim(coalesce(p_payload->>'description','')),''),
      nullif(p_payload->>'duration_minutes','')::int,
      nullif(btrim(coalesce(p_payload->>'notes','')),''),
      nullif(btrim(coalesce(p_payload->>'icon','')),''),
      nullif(btrim(coalesce(p_payload->>'color','')),''),
      nullif(p_payload->>'display_order','')::int,
      case when coalesce(p_payload->>'is_active','true')='false' then 'archived' else 'active' end,
      v_uid,
      (select name from staff where auth_uid = v_uid limit 1)
    );
  end if;

  insert into audit_events (actor_uid, actor_role, action, table_name, row_pk, payload)
  values (v_uid, v_role, v_action, 'treatment_methods', v_id,
    jsonb_build_object('old', to_jsonb(v_old), 'new', p_payload));

  return jsonb_build_object('method_id', v_id, 'name', v_name);
end;
$$;
grant execute on function public.upsert_treatment_method(text, jsonb) to authenticated;

-- ── RPC: hard delete (blocks if referenced by any template) ──
-- Templates store methods as JSONB [{method_id, name}]. Block the
-- delete if either the id OR the name appears in any template.
create or replace function public.delete_treatment_method(
  p_method_id text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.app_role();
  v_uid  uuid := auth.uid();
  v_row  treatment_methods%rowtype;
  v_hits int;
begin
  if v_role not in ('admin','doctor') then
    raise exception 'غير مصرح';
  end if;
  select * into v_row from treatment_methods where method_id = p_method_id for update;
  if not found then raise exception 'طريقة العلاج غير موجودة'; end if;

  select count(*) into v_hits
    from treatment_templates t
   where exists (
     select 1 from jsonb_array_elements(coalesce(t.methods,'[]'::jsonb)) elem
      where elem->>'method_id' = p_method_id
         or lower(coalesce(elem->>'name','')) = lower(v_row.name)
   );
  if v_hits > 0 then
    raise exception 'لا يمكن حذف طريقة مستخدمة في % قالب — استخدم الأرشفة بدلاً منها', v_hits;
  end if;

  delete from treatment_methods where method_id = p_method_id;

  insert into audit_events (actor_uid, actor_role, action, table_name, row_pk, payload)
  values (v_uid, v_role, 'tx_method_delete', 'treatment_methods', p_method_id, to_jsonb(v_row));

  return jsonb_build_object('method_id', p_method_id, 'deleted', true);
end;
$$;
grant execute on function public.delete_treatment_method(text) to authenticated;


-- ═════════════════════════════════════════════════════════════
-- 4. TEMPLATE CATEGORIES ("فئات القوالب")
-- Managed from Settings → قوالب خطط العلاج. Templates.category
-- remains free-text on the row so historical templates keep their
-- category even after a category is archived or renamed; the
-- categories table is the *authoritative source* for the picker.
-- ═════════════════════════════════════════════════════════════
create table if not exists template_categories (
  category_id     text primary key,
  name            text not null,
  description     text,
  status          text not null default 'active'
                    check (status in ('active','archived')),
  sort_order      int,
  created_by      uuid,
  created_by_name text,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);
create unique index if not exists tpl_cat_name_uniq
  on template_categories(lower(trim(name)));
create index if not exists tpl_cat_status_idx  on template_categories(status);
create index if not exists tpl_cat_sort_idx    on template_categories(sort_order nulls last, name);

alter table template_categories enable row level security;

drop policy if exists "clinical read tpl categories" on template_categories;
create policy "clinical read tpl categories" on template_categories for select using (
  public.app_role() in ('admin','doctor','therapist')
);
-- Writes go through the RPCs below (security definer).

-- ── RPC: list categories ─────────────────────────────────────
create or replace function public.list_template_categories(
  p_include_archived boolean default false
) returns jsonb
language plpgsql security definer set search_path = public stable as $$
declare
  v_rows jsonb;
begin
  if public.app_role() not in ('admin','doctor','therapist') then
    raise exception 'غير مصرح';
  end if;
  select coalesce(jsonb_agg(to_jsonb(c.*) order by
    coalesce(c.sort_order, 999999), c.name),'[]'::jsonb)
    into v_rows
    from template_categories c
   where p_include_archived or c.status = 'active';
  return jsonb_build_object('rows', v_rows);
end;
$$;
grant execute on function public.list_template_categories(boolean) to authenticated;

-- ── RPC: upsert (create or rename/reorder) category ──────────
create or replace function public.upsert_template_category(
  p_category_id text,
  p_payload     jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.app_role();
  v_uid  uuid := auth.uid();
  v_name text := btrim(coalesce(p_payload->>'name',''));
  v_id   text := p_category_id;
  v_old  template_categories%rowtype;
  v_dup  int;
  v_action text;
begin
  if v_role not in ('admin','doctor') then
    raise exception 'غير مصرح — لا تملك صلاحية إدارة الفئات';
  end if;
  if v_name = '' then raise exception 'اسم الفئة مطلوب'; end if;

  if v_id is null or v_id = '' then
    v_id := 'TPC-' || to_char(now(),'YYYYMMDD-HH24MISS') || '-'
         || upper(substr(md5(random()::text),1,4));
  end if;

  select * into v_old from template_categories where category_id = v_id for update;
  v_action := case when found then 'tpl_cat_update' else 'tpl_cat_create' end;

  select count(*) into v_dup from template_categories
    where lower(trim(name)) = lower(v_name) and category_id <> v_id;
  if v_dup > 0 then raise exception 'اسم الفئة موجود مسبقًا'; end if;

  if found then
    -- Renaming? Propagate to any templates using the old name so their
    -- category field stays consistent with the authoritative label.
    if v_old.name is distinct from v_name then
      update treatment_templates set category = v_name
        where category = v_old.name;
    end if;
    update template_categories set
      name        = v_name,
      description = nullif(btrim(coalesce(p_payload->>'description','')),''),
      sort_order  = nullif(p_payload->>'sort_order','')::int,
      updated_at  = now()
      where category_id = v_id;
  else
    insert into template_categories (
      category_id, name, description, sort_order,
      status, created_by, created_by_name
    ) values (
      v_id, v_name,
      nullif(btrim(coalesce(p_payload->>'description','')),''),
      nullif(p_payload->>'sort_order','')::int,
      'active', v_uid,
      (select name from staff where auth_uid = v_uid limit 1)
    );
  end if;

  insert into audit_events (actor_uid, actor_role, action, table_name, row_pk, payload)
  values (v_uid, v_role, v_action, 'template_categories', v_id,
    jsonb_build_object('old', to_jsonb(v_old), 'new', p_payload));

  return jsonb_build_object('category_id', v_id, 'name', v_name);
end;
$$;
grant execute on function public.upsert_template_category(text, jsonb) to authenticated;

-- ── RPC: archive / restore category ──────────────────────────
create or replace function public.set_template_category_status(
  p_category_id text,
  p_status      text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.app_role();
  v_uid  uuid := auth.uid();
begin
  if v_role not in ('admin','doctor') then
    raise exception 'غير مصرح';
  end if;
  if p_status not in ('active','archived') then
    raise exception 'حالة غير صحيحة';
  end if;
  update template_categories set status = p_status, updated_at = now()
    where category_id = p_category_id;
  if not found then raise exception 'الفئة غير موجودة'; end if;

  insert into audit_events (actor_uid, actor_role, action, table_name, row_pk, payload)
  values (v_uid, v_role,
    case when p_status='archived' then 'tpl_cat_archive' else 'tpl_cat_restore' end,
    'template_categories', p_category_id, jsonb_build_object('status', p_status));

  return jsonb_build_object('category_id', p_category_id, 'status', p_status);
end;
$$;
grant execute on function public.set_template_category_status(text, text) to authenticated;

-- ┌────────────────────────────────────────────────────────────────────┐
-- │ 3. MIGRATION — extended patient fields + unique indexes
-- │ (source: supabase-migration-patients-2026-07-12.sql)
-- └────────────────────────────────────────────────────────────────────┘

-- ══════════════════════════════════════════════════════════════════════
-- Migration 2026-07-12: extend `patients` for the full edit workflow.
--   Safe to re-run — every statement is idempotent.
--
-- Adds the demographic/medical fields required by the Patient edit PRD
-- and unique indexes on national_id + medical_file_no so duplicates are
-- caught at the DB layer (not just client validation).
-- ══════════════════════════════════════════════════════════════════════

alter table patients add column if not exists medical_file_no  text;
alter table patients add column if not exists national_id      text;
alter table patients add column if not exists whatsapp         text;
alter table patients add column if not exists email            text;
alter table patients add column if not exists date_of_birth    date;
alter table patients add column if not exists address          text;
alter table patients add column if not exists occupation       text;
alter table patients add column if not exists emergency_name   text;
alter table patients add column if not exists emergency_phone  text;
alter table patients add column if not exists doctor_id        text;
alter table patients add column if not exists medical_history  text;
alter table patients add column if not exists allergies        text;
alter table patients add column if not exists medications      text;
alter table patients add column if not exists insurance_info   text;
alter table patients add column if not exists status           text default 'نشط';
alter table patients add column if not exists updated_at       timestamptz default now();

-- Uniqueness: national ID and medical file number must not collide across
-- patients, but empty strings are allowed since the fields are optional.
create unique index if not exists patients_national_id_uniq
  on patients(national_id)
  where national_id is not null and national_id <> '';

create unique index if not exists patients_medical_file_uniq
  on patients(medical_file_no)
  where medical_file_no is not null and medical_file_no <> '';

-- Bump updated_at on every UPDATE so the client can detect staleness
-- if it wants to; harmless if the trigger already exists from an earlier
-- migration under a different name.
create or replace function patients_touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists patients_updated_at on patients;
create trigger patients_updated_at before update on patients
  for each row execute function patients_touch_updated_at();

-- ┌────────────────────────────────────────────────────────────────────┐
-- │ 4. MIGRATION — patient_files metadata, FKs, indexes
-- │ (source: supabase-migration-files-2026-07-12.sql)
-- └────────────────────────────────────────────────────────────────────┘

-- ============================================================
-- Clinksys — patient_files hardening + FKs + indexes
-- Idempotent. Run in Supabase SQL editor.
-- Goals:
--   • Expand patient_files metadata (storage_path, original_name,
--     mime_type, file_size, uploaded_by, uploaded_by_name).
--   • Add FKs on bookings/patients/sessions therapist/doctor/department.
--   • Add missing indexes for patient_id lookups.
-- ============================================================

-- ── patient_files metadata expansion ────────────────────────
alter table patient_files add column if not exists storage_path      text;
alter table patient_files add column if not exists original_name     text;
alter table patient_files add column if not exists mime_type         text;
alter table patient_files add column if not exists file_size         bigint;
alter table patient_files add column if not exists uploaded_by       uuid;
alter table patient_files add column if not exists uploaded_by_name  text;

-- Backfill mime_type from legacy file_type column where empty.
update patient_files set mime_type = file_type where mime_type is null and file_type is not null;
-- Backfill original_name from file_name where empty.
update patient_files set original_name = file_name where original_name is null;

-- One storage object per file_id — cheap dup guard.
create unique index if not exists patient_files_storage_path_uniq
  on patient_files(storage_path) where storage_path is not null;

create index if not exists patient_files_uploaded_at_idx
  on patient_files(uploaded_at desc);

-- ── Referential integrity: bookings ─────────────────────────
-- Null out orphans so FK creation succeeds; production data should
-- already reference live rows, but this makes the migration re-runnable
-- against dirty environments.
update bookings b set therapist_id = null
  where therapist_id is not null
    and not exists (select 1 from therapists t where t.id = b.therapist_id);
update bookings b set doctor_id = null
  where doctor_id is not null
    and not exists (select 1 from doctors d where d.id = b.doctor_id);
update bookings b set department_id = null
  where department_id is not null
    and not exists (select 1 from departments d where d.id = b.department_id);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'bookings_therapist_id_fkey'
  ) then
    alter table bookings
      add constraint bookings_therapist_id_fkey
      foreign key (therapist_id) references therapists(id) on delete set null;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'bookings_doctor_id_fkey'
  ) then
    alter table bookings
      add constraint bookings_doctor_id_fkey
      foreign key (doctor_id) references doctors(id) on delete set null;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'bookings_department_id_fkey'
  ) then
    alter table bookings
      add constraint bookings_department_id_fkey
      foreign key (department_id) references departments(id) on delete set null;
  end if;
end $$;

-- ── Referential integrity: patients & sessions ──────────────
update patients p set therapist_id = null
  where therapist_id is not null
    and not exists (select 1 from therapists t where t.id = p.therapist_id);
update sessions s set therapist_id = null
  where therapist_id is not null
    and not exists (select 1 from therapists t where t.id = s.therapist_id);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'patients_therapist_id_fkey'
  ) then
    alter table patients
      add constraint patients_therapist_id_fkey
      foreign key (therapist_id) references therapists(id) on delete set null;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'sessions_therapist_id_fkey'
  ) then
    alter table sessions
      add constraint sessions_therapist_id_fkey
      foreign key (therapist_id) references therapists(id) on delete set null;
  end if;
end $$;

-- ── Hot-path indexes ────────────────────────────────────────
create index if not exists bookings_patient_id_idx   on bookings(patient_id);
create index if not exists bookings_date_idx         on bookings(date);
create index if not exists sessions_patient_id_idx   on sessions(patient_id);
create index if not exists invoices_patient_id_idx   on invoices(patient_id);
create index if not exists bookings_therapist_id_idx on bookings(therapist_id);
create index if not exists bookings_doctor_id_idx    on bookings(doctor_id);

-- ┌────────────────────────────────────────────────────────────────────┐
-- │ 5. MIGRATION — clinic settings columns + staff provenance
-- │ (source: supabase-migration-settings-users-2026-07-12.sql)
-- └────────────────────────────────────────────────────────────────────┘

-- ══════════════════════════════════════════════════════════════════════
-- Migration 2026-07-12: fix clinic settings persistence + user management
--
-- ROOT CAUSE (clinic settings): the `clinic_settings` table only had the
-- columns { id, name, subtitle, logo, primary_color, updated_at }, but
-- the Settings form was upserting { branch, phone, email, address,
-- tax_id, hours, ... }. PostgREST rejected every save with 400 because
-- those columns did not exist. The client ignored the response, showed
-- "saved" from a local optimistic update, then the next page load
-- fetched the untouched singleton row and everything "reverted".
--
-- ROOT CAUSE (users): the `staff` table lacked `status`, `created_by`,
-- and `created_at`, so the admin-create flow could not record the
-- provenance the PRD requires.
--
-- Fix: add every column that the client actually writes, and refresh
-- the RLS policies so admins can INSERT + UPDATE the singleton row.
-- Safe to re-run — every statement is idempotent.
-- ══════════════════════════════════════════════════════════════════════

-- ── clinic_settings: add every field the Settings form exposes ──
alter table clinic_settings add column if not exists branch                text;
alter table clinic_settings add column if not exists phone                 text;
alter table clinic_settings add column if not exists email                 text;
alter table clinic_settings add column if not exists address               text;
alter table clinic_settings add column if not exists tax_id                text;
alter table clinic_settings add column if not exists hours                 text;
alter table clinic_settings add column if not exists website               text;
alter table clinic_settings add column if not exists currency              text default 'EGP';
alter table clinic_settings add column if not exists timezone              text default 'Africa/Cairo';
alter table clinic_settings add column if not exists appointment_duration  int  default 30;

-- Make sure the singleton row actually exists before the first save.
insert into clinic_settings (id) values (1) on conflict do nothing;

-- Refresh RLS: admins get SELECT + INSERT + UPDATE. Read stays public so
-- the login page can pull branding before an auth session exists.
drop policy if exists "public read clinic_settings" on clinic_settings;
create policy "public read clinic_settings"
  on clinic_settings for select using (true);

drop policy if exists "admin write clinic_settings" on clinic_settings;
create policy "admin write clinic_settings"
  on clinic_settings for all
  using      (public.app_role() = 'admin')
  with check (public.app_role() = 'admin');

-- ── staff: provenance columns the PRD requires ──
alter table staff add column if not exists status      text default 'active';
alter table staff add column if not exists created_by  uuid;
alter table staff add column if not exists created_at  timestamptz default now();

-- Backfill created_at for pre-existing rows so downstream sorts don't NaN.
update staff set created_at = now() where created_at is null;

-- Case-insensitive uniqueness on email — the current text-unique index is
-- case-sensitive and would let "user@x" and "User@x" coexist.
create unique index if not exists staff_email_lower_uniq
  on staff (lower(email))
  where email is not null and email <> '';

-- ══════════════════════════════════════════════════════════════════════
-- Notes for the operator:
--   • Deploy the `admin-create-user` Edge Function alongside this
--     migration so the client can create users without triggering the
--     GoTrue signup email rate limit.
--   • If you must keep the anon signUp fallback, go to Supabase
--     Dashboard → Authentication → Providers → Email and either
--     (a) disable "Confirm email", or (b) increase the SMTP quota.
-- ══════════════════════════════════════════════════════════════════════

-- ┌────────────────────────────────────────────────────────────────────┐
-- │ 6. MIGRATION — staff-table roles + staff-wide patient INSERT (RLS)
-- │ (source: supabase-migration-import-auth-2026-07-12.sql)
-- └────────────────────────────────────────────────────────────────────┘

-- ============================================================
-- Migration 2026-07-12: Import-page auth + staff-wide patient INSERT
-- Idempotent — safe to re-run in the Supabase SQL editor.
--
-- Root causes fixed:
--   1. public.app_role() trusted the JWT's user_metadata.role — a value
--      any signed-in user can rewrite for themselves via
--      auth.updateUser({ data: { role: 'admin' } }). Role checks now read
--      the `staff` table in PostgreSQL by auth.uid(); only an admin can
--      write staff rows, so roles are server-controlled.
--   2. RLS allowed INSERT on patients / patient_files / the patient-files
--      storage bucket only for admin + receptionist. Every staff role
--      (admin, receptionist, doctor, therapist) can now register patients
--      and upload their documents. Deleting patients stays restricted to
--      admin + receptionist.
--
-- RLS stays ENABLED on every table — policies are replaced, not dropped.
-- ============================================================

-- ── 1. Backfill staff rows ───────────────────────────────────
-- app_role() now resolves from staff.auth_uid, so every auth user that
-- was provisioned with a staff role in user_metadata needs a staff row.
-- (Accounts created through the app already have one; this catches any
-- created directly in the dashboard.)
insert into staff (staff_id, name, role, email, auth_uid)
select
  'ST-' || left(u.id::text, 8),
  coalesce(u.raw_user_meta_data->>'name', split_part(u.email, '@', 1)),
  u.raw_user_meta_data->>'role',
  u.email,
  u.id
from auth.users u
where u.raw_user_meta_data->>'role' in ('admin','receptionist','doctor','therapist')
  and not exists (select 1 from staff s where s.auth_uid = u.id)
on conflict (staff_id) do nothing;

-- ── 2. app_role(): read the role from PostgreSQL, not the JWT ─
-- SECURITY DEFINER so the lookup is not blocked by staff's own RLS and
-- cannot recurse into it. Anonymous requests have auth.uid() = null →
-- role = null → every staff policy evaluates to false, so anon can never
-- read or write patient data.
create or replace function public.app_role() returns text
language plpgsql stable security definer
set search_path = public
as $$
begin
  return (select s.role from staff s where s.auth_uid = auth.uid() limit 1);
end $$;

-- ── 3. patients: every staff role may INSERT + UPDATE ────────
-- Replaces the single FOR ALL admin/reception policy with per-command
-- policies. SELECT stays as-is ("staff read patients" already covers all
-- four roles). DELETE remains admin/reception only.
drop policy if exists "admin/reception write patients" on patients;

drop policy if exists "staff insert patients" on patients;
create policy "staff insert patients" on patients for insert with check (
  public.app_role() in ('admin','receptionist','doctor','therapist')
);

drop policy if exists "staff update patients" on patients;
create policy "staff update patients" on patients for update using (
  public.app_role() in ('admin','receptionist','doctor','therapist')
) with check (
  public.app_role() in ('admin','receptionist','doctor','therapist')
);

drop policy if exists "admin/reception delete patients" on patients;
create policy "admin/reception delete patients" on patients for delete using (
  public.app_role() in ('admin','receptionist')
);

-- ── 4. patient_files: every staff role may attach documents ──
-- uploaded_by may not exist yet if supabase-migration-files-2026-07-12.sql
-- hasn't run; make this migration self-contained.
alter table patient_files add column if not exists uploaded_by uuid;

drop policy if exists "admin/reception write patient_files" on patient_files;

drop policy if exists "staff insert patient_files" on patient_files;
create policy "staff insert patient_files" on patient_files for insert with check (
  public.app_role() in ('admin','receptionist','doctor','therapist')
);

drop policy if exists "admin/reception update patient_files" on patient_files;
create policy "admin/reception update patient_files" on patient_files for update using (
  public.app_role() in ('admin','receptionist')
) with check (
  public.app_role() in ('admin','receptionist')
);

-- Uploaders may delete their own rows (needed for the client's
-- compensating rollback when a storage upload succeeds but the metadata
-- insert fails); admin/reception may delete any.
drop policy if exists "staff delete patient_files" on patient_files;
create policy "staff delete patient_files" on patient_files for delete using (
  public.app_role() in ('admin','receptionist')
  or uploaded_by = auth.uid()
);

-- ── 5. Storage bucket: every staff role may upload ───────────
drop policy if exists "admin/reception write patient files bucket" on storage.objects;

drop policy if exists "staff upload patient files bucket" on storage.objects;
create policy "staff upload patient files bucket" on storage.objects for insert with check (
  bucket_id = 'patient-files'
  and public.app_role() in ('admin','receptionist','doctor','therapist')
);

drop policy if exists "admin/reception update patient files bucket" on storage.objects;
create policy "admin/reception update patient files bucket" on storage.objects for update using (
  bucket_id = 'patient-files'
  and public.app_role() in ('admin','receptionist')
) with check (
  bucket_id = 'patient-files'
  and public.app_role() in ('admin','receptionist')
);

-- Uploaders may remove their own objects (upload rollback); storage sets
-- owner/owner_id to auth.uid() on upload.
drop policy if exists "staff delete patient files bucket" on storage.objects;
create policy "staff delete patient files bucket" on storage.objects for delete using (
  bucket_id = 'patient-files'
  and (
    public.app_role() in ('admin','receptionist')
    or owner = auth.uid()
    or owner_id = auth.uid()::text
  )
);

-- ── 6. Belt-and-braces table grants ──────────────────────────
-- Supabase grants these by default; restated so a hardened project that
-- revoked defaults still lets RLS be the single gate.
grant select, insert, update, delete on patients      to authenticated;
grant select, insert, update, delete on patient_files to authenticated;
grant select on staff to authenticated;

-- ┌────────────────────────────────────────────────────────────────────┐
-- │ 7. MIGRATION — treatments (records created from templates)
-- │ (source: supabase-migration-treatments-2026-07-12.sql)
-- └────────────────────────────────────────────────────────────────────┘

-- ============================================================
-- Migration 2026-07-12 — Treatments (سجلات العلاج)
--
-- Turns the template workflow into a real record flow:
-- clicking «استخدام» on a قالب opens the treatment form with every
-- template field pre-filled; saving inserts an independent row here.
-- The row keeps a full copy of every clinical field PLUS the id,
-- version and snapshot of the template that generated it, so later
-- template edits never change existing treatments and vice-versa.
--
-- Idempotent: safe to re-run.
-- ============================================================

-- Templates can carry file attachments (copied into treatments on use).
alter table treatment_templates add column if not exists attachments jsonb not null default '[]'::jsonb;

-- ── Treatments table ──────────────────────────────────────────
create table if not exists treatments (
  treatment_id           text primary key,
  patient_id             text not null references patients(patient_id) on delete cascade,
  therapist_id           text not null,
  therapist_name         text,
  -- Template linkage (audit only — values below are independent copies).
  template_id            text references treatment_templates(template_id),
  template_version       int,
  template_name          text,
  template_snapshot      jsonb,          -- full template row at apply time
  -- Clinical fields (copied from the template, editable before save).
  name                   text,
  category               text,
  diagnosis              text,
  body_part              text,
  goals                  jsonb not null default '[]'::jsonb,
  exercises              jsonb not null default '[]'::jsonb,
  methods                jsonb not null default '[]'::jsonb,
  home_instructions      text,
  notes                  text,
  warnings               text,
  followup_instructions  text,
  estimated_sessions     int,
  weekly_frequency       int,
  expected_recovery_days int,
  attachments            jsonb not null default '[]'::jsonb,
  extra_fields           jsonb not null default '{}'::jsonb,  -- future custom fields, no schema change needed
  treatment_date         date default current_date,
  start_date             date,
  status                 text not null default 'active'
                           check (status in ('draft','active','completed','cancelled')),
  created_by             uuid,
  created_by_name        text,
  updated_by             uuid,
  updated_by_name        text,
  created_at             timestamptz default now(),
  updated_at             timestamptz default now()
);
create index if not exists treatments_patient_idx   on treatments(patient_id);
create index if not exists treatments_therapist_idx on treatments(therapist_id);
create index if not exists treatments_template_idx  on treatments(template_id);
create index if not exists treatments_created_idx   on treatments(created_at desc);

alter table treatments enable row level security;

-- Read: clinical roles. Writes go through the security-definer RPCs only.
drop policy if exists "clinical read treatments" on treatments;
create policy "clinical read treatments" on treatments for select using (
  public.app_role() in ('admin','doctor','therapist')
);

-- ── RPC: create a treatment (optionally from a template) ─────
-- When p_payload->>'template_id' is set, EVERY clinical field of the
-- template is copied first, then the payload (the doctor's edits) is
-- merged on top — so fields the client never rendered still arrive in
-- the treatment row. Validates patient, therapist and template before
-- inserting, logs template_usage and bumps usage_count in the same
-- transaction as the insert.
create or replace function public.create_treatment(
  p_treatment_id text,
  p_payload      jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role   text := public.app_role();
  v_uid    uuid := auth.uid();
  v_name   text := coalesce((select raw_user_meta_data->>'name' from auth.users where id = v_uid),'—');
  v_tpl    treatment_templates%rowtype;
  v_tpl_id text := nullif(btrim(coalesce(p_payload->>'template_id','')),'');
  v_pat_id text := nullif(btrim(coalesce(p_payload->>'patient_id','')),'');
  v_th_id  text := nullif(btrim(coalesce(p_payload->>'therapist_id','')),'');
  v_th_nm  text;
  v_base   jsonb := '{}'::jsonb;
  v_data   jsonb;
  v_use_id text;
  v_status text := coalesce(nullif(btrim(coalesce(p_payload->>'status','')),''),'active');
  v_row    treatments%rowtype;
begin
  if v_role not in ('admin','doctor','therapist') then
    raise exception 'غير مصرح';
  end if;
  if p_treatment_id is null or btrim(p_treatment_id) = '' then
    raise exception 'معرّف العلاج مفقود';
  end if;

  -- 1. المريض موجود؟
  if v_pat_id is null then raise exception 'اختر المريض'; end if;
  if not exists (select 1 from patients where patient_id = v_pat_id) then
    raise exception 'المريض غير موجود';
  end if;

  -- 2. الأخصائي موجود؟ (roster أو جدول الموظفين)
  if v_th_id is null then raise exception 'اختر الأخصائي المسؤول'; end if;
  select name into v_th_nm from therapists where id = v_th_id;
  if v_th_nm is null then
    select name into v_th_nm from staff
     where staff_id = v_th_id and role in ('therapist','doctor','admin');
  end if;
  if v_th_nm is null then raise exception 'الأخصائي غير موجود'; end if;

  -- 3. القالب موجود؟ انسخ كل حقوله كقاعدة ثم طبّق تعديلات الطبيب فوقها.
  if v_tpl_id is not null then
    select * into v_tpl from treatment_templates where template_id = v_tpl_id;
    if v_tpl.template_id is null then raise exception 'القالب غير موجود'; end if;
    if v_tpl.status = 'archived' then raise exception 'لا يمكن استخدام قالب مؤرشف'; end if;
    v_base := jsonb_build_object(
      'name',                   v_tpl.name,
      'category',               v_tpl.category,
      'diagnosis',              v_tpl.diagnosis,
      'body_part',              v_tpl.body_part,
      'goals',                  v_tpl.goals,
      'exercises',              v_tpl.exercises,
      'methods',                v_tpl.methods,
      'home_instructions',      v_tpl.home_instructions,
      'notes',                  v_tpl.notes,
      'warnings',               v_tpl.warnings,
      'followup_instructions',  v_tpl.followup_instructions,
      'estimated_sessions',     v_tpl.estimated_sessions,
      'weekly_frequency',       v_tpl.weekly_frequency,
      'expected_recovery_days', v_tpl.expected_recovery_days,
      'attachments',            v_tpl.attachments
    );
  end if;
  v_data := jsonb_strip_nulls(v_base) || jsonb_strip_nulls(coalesce(p_payload,'{}'::jsonb));

  insert into treatments (
    treatment_id, patient_id, therapist_id, therapist_name,
    template_id, template_version, template_name, template_snapshot,
    name, category, diagnosis, body_part,
    goals, exercises, methods,
    home_instructions, notes, warnings, followup_instructions,
    estimated_sessions, weekly_frequency, expected_recovery_days,
    attachments, extra_fields, treatment_date, start_date, status,
    created_by, created_by_name, updated_by, updated_by_name
  ) values (
    p_treatment_id, v_pat_id, v_th_id, v_th_nm,
    v_tpl.template_id, v_tpl.version, v_tpl.name,
    case when v_tpl.template_id is null then null else to_jsonb(v_tpl) end,
    v_data->>'name', v_data->>'category', v_data->>'diagnosis', v_data->>'body_part',
    coalesce(v_data->'goals','[]'::jsonb),
    coalesce(v_data->'exercises','[]'::jsonb),
    coalesce(v_data->'methods','[]'::jsonb),
    v_data->>'home_instructions', v_data->>'notes', v_data->>'warnings', v_data->>'followup_instructions',
    nullif(v_data->>'estimated_sessions','')::int,
    nullif(v_data->>'weekly_frequency','')::int,
    nullif(v_data->>'expected_recovery_days','')::int,
    coalesce(v_data->'attachments','[]'::jsonb),
    coalesce(v_data->'extra_fields','{}'::jsonb),
    coalesce(nullif(v_data->>'treatment_date','')::date, current_date),
    nullif(v_data->>'start_date','')::date,
    case when v_status in ('draft','active','completed','cancelled') then v_status else 'active' end,
    v_uid, v_name, v_uid, v_name
  );

  -- Usage log + counter — only now that the treatment really exists.
  if v_tpl.template_id is not null then
    v_use_id := 'TU-' || to_char(now(),'YYYYMMDD-HH24MISS') || '-'
             || upper(substr(md5(random()::text),1,4));
    insert into template_usage (use_id, template_id, patient_id, plan_id, applied_by, applied_by_name)
    values (v_use_id, v_tpl.template_id, v_pat_id, p_treatment_id, v_uid, v_name);
    update treatment_templates
       set usage_count  = coalesce(usage_count,0) + 1,
           last_used_at = now()
     where template_id = v_tpl.template_id;
  end if;

  insert into audit_events (actor_uid, actor_role, action, table_name, row_pk, payload)
  values (v_uid, v_role, 'treatment_create', 'treatments', p_treatment_id,
    jsonb_build_object('patient_id', v_pat_id, 'therapist_id', v_th_id,
                       'template_id', v_tpl.template_id, 'template_version', v_tpl.version,
                       'use_id', v_use_id));

  select * into v_row from treatments where treatment_id = p_treatment_id;
  return to_jsonb(v_row);
end;
$$;
grant execute on function public.create_treatment(text, jsonb) to authenticated;

-- ── RPC: update a treatment ───────────────────────────────────
-- Touches ONLY the treatment row. The originating template — and the
-- snapshot/version stored here — are never modified.
create or replace function public.update_treatment(
  p_treatment_id text,
  p_payload      jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.app_role();
  v_uid  uuid := auth.uid();
  v_name text := coalesce((select raw_user_meta_data->>'name' from auth.users where id = v_uid),'—');
  v_th_id text := nullif(btrim(coalesce(p_payload->>'therapist_id','')),'');
  v_th_nm text;
  v_row  treatments%rowtype;
begin
  if v_role not in ('admin','doctor','therapist') then
    raise exception 'غير مصرح';
  end if;
  select * into v_row from treatments where treatment_id = p_treatment_id;
  if v_row.treatment_id is null then raise exception 'سجل العلاج غير موجود'; end if;

  if p_payload ? 'patient_id'
     and nullif(btrim(coalesce(p_payload->>'patient_id','')),'') is distinct from v_row.patient_id then
    if not exists (select 1 from patients where patient_id = p_payload->>'patient_id') then
      raise exception 'المريض غير موجود';
    end if;
  end if;
  if v_th_id is not null and v_th_id is distinct from v_row.therapist_id then
    select name into v_th_nm from therapists where id = v_th_id;
    if v_th_nm is null then
      select name into v_th_nm from staff
       where staff_id = v_th_id and role in ('therapist','doctor','admin');
    end if;
    if v_th_nm is null then raise exception 'الأخصائي غير موجود'; end if;
  end if;

  update treatments set
    patient_id             = coalesce(nullif(btrim(coalesce(p_payload->>'patient_id','')),''), patient_id),
    therapist_id           = coalesce(v_th_id, therapist_id),
    therapist_name         = coalesce(v_th_nm, therapist_name),
    name                   = coalesce(p_payload->>'name', name),
    category               = case when p_payload ? 'category'  then p_payload->>'category'  else category  end,
    diagnosis              = case when p_payload ? 'diagnosis' then p_payload->>'diagnosis' else diagnosis end,
    body_part              = case when p_payload ? 'body_part' then p_payload->>'body_part' else body_part end,
    goals                  = coalesce(p_payload->'goals', goals),
    exercises              = coalesce(p_payload->'exercises', exercises),
    methods                = coalesce(p_payload->'methods', methods),
    home_instructions      = case when p_payload ? 'home_instructions'     then p_payload->>'home_instructions'     else home_instructions end,
    notes                  = case when p_payload ? 'notes'                 then p_payload->>'notes'                 else notes end,
    warnings               = case when p_payload ? 'warnings'              then p_payload->>'warnings'              else warnings end,
    followup_instructions  = case when p_payload ? 'followup_instructions' then p_payload->>'followup_instructions' else followup_instructions end,
    estimated_sessions     = case when p_payload ? 'estimated_sessions'     then nullif(p_payload->>'estimated_sessions','')::int     else estimated_sessions end,
    weekly_frequency       = case when p_payload ? 'weekly_frequency'       then nullif(p_payload->>'weekly_frequency','')::int       else weekly_frequency end,
    expected_recovery_days = case when p_payload ? 'expected_recovery_days' then nullif(p_payload->>'expected_recovery_days','')::int else expected_recovery_days end,
    attachments            = coalesce(p_payload->'attachments', attachments),
    extra_fields           = coalesce(p_payload->'extra_fields', extra_fields),
    treatment_date         = coalesce(nullif(p_payload->>'treatment_date','')::date, treatment_date),
    start_date             = case when p_payload ? 'start_date' then nullif(p_payload->>'start_date','')::date else start_date end,
    status                 = case when coalesce(p_payload->>'status','') in ('draft','active','completed','cancelled')
                                  then p_payload->>'status' else status end,
    updated_by             = v_uid,
    updated_by_name        = v_name,
    updated_at             = now()
  where treatment_id = p_treatment_id;

  insert into audit_events (actor_uid, actor_role, action, table_name, row_pk, payload)
  values (v_uid, v_role, 'treatment_update', 'treatments', p_treatment_id, p_payload);

  select * into v_row from treatments where treatment_id = p_treatment_id;
  return to_jsonb(v_row);
end;
$$;
grant execute on function public.update_treatment(text, jsonb) to authenticated;

-- ── RPC: list treatments (joined with patient name) ──────────
create or replace function public.list_treatments(
  p_patient_id text default null,
  p_status     text default null,
  p_search     text default null,
  p_limit      int  default 200,
  p_offset     int  default 0
) returns jsonb
language plpgsql security definer set search_path = public stable as $$
declare
  v_lim  int  := least(greatest(coalesce(p_limit,200),1),500);
  v_off  int  := greatest(coalesce(p_offset,0),0);
  v_srch text := nullif(btrim(coalesce(p_search,'')),'');
  v_st   text := nullif(btrim(coalesce(p_status,'')),'');
  v_pid  text := nullif(btrim(coalesce(p_patient_id,'')),'');
  v_rows jsonb;
  v_cnt  int;
begin
  if public.app_role() not in ('admin','doctor','therapist') then
    raise exception 'غير مصرح';
  end if;

  with base as (
    select t.*, p.name as patient_name
      from treatments t
      left join patients p on p.patient_id = t.patient_id
     where (v_pid  is null or t.patient_id = v_pid)
       and (v_st   is null or t.status = v_st)
       and (
         v_srch is null
         or t.treatment_id   ilike '%'||v_srch||'%'
         or coalesce(p.name,'')          ilike '%'||v_srch||'%'
         or coalesce(t.diagnosis,'')     ilike '%'||v_srch||'%'
         or coalesce(t.therapist_name,'') ilike '%'||v_srch||'%'
       )
  ),
  ordered as (
    select * from base order by created_at desc limit v_lim offset v_off
  )
  select coalesce(jsonb_agg(to_jsonb(ordered.*)),'[]'::jsonb),
         (select count(*)::int from base)
    into v_rows, v_cnt
    from ordered;

  return jsonb_build_object('rows', v_rows, 'count', v_cnt,
                            'limit', v_lim, 'offset', v_off);
end;
$$;
grant execute on function public.list_treatments(text,text,text,int,int) to authenticated;

-- ── RPC: fetch one treatment ──────────────────────────────────
create or replace function public.get_treatment(
  p_treatment_id text
) returns jsonb
language plpgsql security definer set search_path = public stable as $$
declare
  v_out jsonb;
begin
  if public.app_role() not in ('admin','doctor','therapist') then
    raise exception 'غير مصرح';
  end if;
  select to_jsonb(t.*) || jsonb_build_object('patient_name', p.name)
    into v_out
    from treatments t
    left join patients p on p.patient_id = t.patient_id
   where t.treatment_id = p_treatment_id;
  return v_out;
end;
$$;
grant execute on function public.get_treatment(text) to authenticated;

-- ── Guard: a template that generated treatments can't be deleted ──
-- delete_treatment_template already refuses when template_usage rows
-- exist (every treatment created from a template writes one). The FK
-- from treatments.template_id (no cascade) is the hard backstop.
