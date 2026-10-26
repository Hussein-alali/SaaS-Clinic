-- =====================================================================
-- 0010_concurrency.sql — race conditions (docs/06 S4; docs/05
-- "Concurrency"; docs/02 «الجاهزية للتوسع»).
--
-- 1. One active booking per therapist slot and per doctor slot. The
--    screens check a slot against the data they loaded, which can be
--    minutes old, and Quick Booking does not check at all: two
--    receptionists confirming the same therapist, date and time both
--    succeeded. Trigger bookings_slot_guard (BEFORE INSERT OR UPDATE OF
--    therapist_id, doctor_id, date, time, status) takes a transaction
--    advisory lock on (clinic, therapist|doctor, date, time) and raises
--    SQLSTATE BK409 'slot_taken' (API: 409 {code:'slot_taken'}) when
--    another active booking of the clinic holds that slot.
--      * Active = status not in ('ملغي','ملغى','cancelled','متاح'),
--        like src/screens1.jsx therapistBusyAt(); time compared trimmed.
--      * The check sees every branch of the clinic (a therapist can work
--        in two), through booking_slot_taken(), a security-definer
--        function that turns app.system on for its own query only,
--        limited to the caller's clinic.
--      * Not checked: the system context (seeds, the Supabase data import
--        of task 4.7: history is written as it was), rows of another
--        clinic (RLS refuses them; the guard must not answer for that
--        clinic's slots), and saving a booking that already holds its
--        slot (marking it paid or completed). INSERT ... ON CONFLICT DO
--        UPDATE of an existing booking (src/supabase.jsx upsertRow) is
--        judged as the update it becomes. Existing duplicates are left
--        as they are (no unique index), and stay editable.
-- 2. Receipt numbers: 'RCT-' || day || '-' || 5 random digits collided
--    (about 5 % a day at 100 receipts in one clinic) and the payment
--    failed on unique (organization_id, receipt_no). They now come from
--    org_counters, a counter per clinic and day (next_org_counter(),
--    one row lock until the payment commits): RCT-<YYYYMMDD>-00001, ...
--    Today's counters start after the receipts already issued.
-- 3. new_record_id(prefix): the SQL twin of newRecordId() in
--    src/apiclient.jsx (prefix + base-36 milliseconds + 6 random base-36
--    characters from gen_random_uuid()); record_quick_payment uses it for
--    PMT- ids (task 2.10; the template RPCs keep their generators: admin
--    actions at second precision + 16 random bits).
-- 4. idempotency_keys: the API's Idempotency-Key store (api/src/
--    idempotency.js). The key is claimed in the transaction that does the
--    work, so a repeat gets the stored answer, never a second payment.
--
-- org_counters and idempotency_keys are platform/ops tables (convention 4):
-- no RLS, never reachable through /api/data, written only by the
-- functions and the API code above.
--
-- PostgreSQL >= 13 (gen_random_uuid() is built in), no extensions.
-- migrate.js wraps this file in one transaction.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 3. new_record_id()
-- ---------------------------------------------------------------------
create or replace function public.new_record_id(p_prefix text)
returns text
language plpgsql
volatile
set search_path = public
as $$
declare
  c_alpha constant text := '0123456789abcdefghijklmnopqrstuvwxyz';
  v_ms    bigint := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_time  text := '';
  v_rand  text := '';
  v_bytes bytea;
  v_byte  int;
begin
  loop
    v_time := substr(c_alpha, (v_ms % 36)::int + 1, 1) || v_time;
    v_ms := v_ms / 36;
    exit when v_ms = 0;
  end loop;
  -- Random bytes of a v4 UUID (bytes 6 and 8 carry its version and variant
  -- bits); 252 = 7 * 36, so dropping 252..255 keeps every character equally likely.
  while length(v_rand) < 6 loop
    v_bytes := uuid_send(gen_random_uuid());
    for i in 0..15 loop
      continue when i in (6, 8);
      v_byte := get_byte(v_bytes, i);
      if v_byte < 252 then
        v_rand := v_rand || substr(c_alpha, v_byte % 36 + 1, 1);
        exit when length(v_rand) = 6;
      end if;
    end loop;
  end loop;
  return coalesce(p_prefix, '') || v_time || v_rand;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. Per-clinic counters
-- ---------------------------------------------------------------------
create table if not exists public.org_counters (
  organization_id uuid   not null references public.organizations (id) on delete cascade,
  name            text   not null,
  value           bigint not null default 0,
  primary key (organization_id, name)
);
comment on table public.org_counters is
  'Per-clinic counters (receipt:<YYYYMMDD>, ...). Platform/ops table: no RLS, only next_org_counter() writes it (0010).';

-- The next value of a clinic's counter. The row stays locked until the
-- calling transaction ends, so concurrent callers get consecutive values.
create or replace function public.next_org_counter(p_org uuid, p_name text)
returns bigint
language sql
volatile
set search_path = public
as $$
  insert into public.org_counters as c (organization_id, name, value)
  values (p_org, p_name, 1)
  on conflict (organization_id, name) do update set value = c.value + 1
  returning c.value
$$;

-- Today's counters start after the receipts already issued with the old
-- random numbers (the last two days, whatever the session time zone).
select set_config('app.system', 'on', true);
insert into public.org_counters (organization_id, name, value)
select organization_id, 'receipt:' || substr(receipt_no, 5, 8), max(substr(receipt_no, 14)::bigint)
  from public.payments
 where receipt_no ~ '^RCT-[0-9]{8}-[0-9]{1,18}$'
   and substr(receipt_no, 5, 8) >= to_char(now() - interval '2 days', 'YYYYMMDD')
 group by 1, 2
on conflict (organization_id, name) do update set value = greatest(public.org_counters.value, excluded.value);
select set_config('app.system', 'off', true);

-- ---------------------------------------------------------------------
-- 2 + 3. record_quick_payment: receipt number from the counter, PMT- id
-- from new_record_id(). The 0007 definition, otherwise unchanged.
-- ---------------------------------------------------------------------
create or replace function public.record_quick_payment(p_patient_id text, p_allocations jsonb, p_method text, p_reference text default null::text, p_transaction_id text default null::text, p_notes text default null::text, p_cashier_id text default null::text, p_cashier_name text default null::text, p_ip_address text default null::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_payment_id  text;
  v_receipt_no  text;
  v_day         text;
  v_seq         bigint;
  v_total       numeric := 0;
  v_alloc       jsonb;
  v_type        text;
  v_ref_id      text;
  v_amount      numeric;
  v_remaining   numeric;
  v_new_paid    numeric;
  v_row         record;
  v_role        text := public.app_role();
begin
  -- [0007] billing roles only (there was no role check).
  if v_role is null or v_role not in ('admin','receptionist') then
    raise exception 'غير مصرح — تسجيل المدفوعات مقتصر على المدير وموظف الاستقبال';
  end if;
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

  -- [0010] collision-free ids (were PMT-<time>-<4 hex>, RCT-<day>-<random>).
  v_payment_id := public.new_record_id('PMT-');

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

  -- [0010] the clinic's receipt counter for the day, taken last: its row
  -- lock serializes the clinic's payments only from here to the commit.
  v_day := to_char(now(), 'YYYYMMDD');
  v_seq := public.next_org_counter(public.app_org_id(), 'receipt:' || v_day);
  v_receipt_no := 'RCT-' || v_day || '-' || lpad(v_seq::text, greatest(5, length(v_seq::text)), '0');

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
$function$;

-- ---------------------------------------------------------------------
-- 1. The slot guard
-- ---------------------------------------------------------------------
-- Whether another active booking of the caller's clinic holds the slot of
-- p_who (a therapist or a doctor id), in any branch. app.system = 'on'
-- lifts branch_scope for its one query and is put back right after (a
-- failing query aborts the (sub)transaction, which restores it too; a
-- function-level SET of a custom setting needs a superuser). p_org must
-- be the caller's clinic.
create or replace function public.booking_slot_taken(p_org uuid, p_kind text, p_who text,
  p_date date, p_time text, p_booking_id text)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_system text := coalesce(current_setting('app.system', true), '');
  v_taken  boolean;
begin
  if p_org is distinct from public.app_org_id() then
    return false;
  end if;
  perform set_config('app.system', 'on', true);
  select exists (
    select 1
      from public.bookings b
     where b.organization_id = p_org
       and b.date = p_date
       and btrim(b.time) = btrim(p_time)
       and b.booking_id is distinct from p_booking_id
       and not (coalesce(b.status, '') = any (array['ملغي', 'ملغى', 'cancelled', 'متاح']))
       and case p_kind when 'therapist' then b.therapist_id = p_who else b.doctor_id = p_who end)
    into v_taken;
  perform set_config('app.system', v_system, true);
  return v_taken;
end;
$$;

create or replace function public.bookings_slot_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  c_free   constant text[] := array['ملغي', 'ملغى', 'cancelled', 'متاح'];
  v_old    public.bookings%rowtype;
  v_held   boolean := false;  -- the row already actively holds this date and time
  v_kind   text;
  v_who    text;
  v_before text;
begin
  if public.app_is_system()
     or new.date is null or new.time is null
     or coalesce(new.status, '') = any (c_free)
     or (new.therapist_id is null and new.doctor_id is null)
     -- another clinic's row: RLS refuses it; never answer for its slots
     or new.organization_id is distinct from public.app_org_id() then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    v_old := old;
  else
    -- INSERT ... ON CONFLICT DO UPDATE of an existing booking: judged as
    -- the update it becomes (BEFORE INSERT fires before the conflict).
    select * into v_old from public.bookings where booking_id = new.booking_id;
  end if;
  v_held := v_old.booking_id is not null
        and not (coalesce(v_old.status, '') = any (c_free))
        and v_old.date = new.date
        and btrim(v_old.time) = btrim(new.time);

  -- Therapist first, then doctor: one lock order for every booking.
  foreach v_kind in array array['therapist', 'doctor'] loop
    v_who    := case v_kind when 'therapist' then new.therapist_id else new.doctor_id end;
    v_before := case v_kind when 'therapist' then v_old.therapist_id else v_old.doctor_id end;
    continue when v_who is null or (v_held and v_before = v_who);
    perform pg_advisory_xact_lock(hashtext('clinicsys.slot'),
      hashtext(concat_ws('|', new.organization_id, v_kind, v_who, new.date, btrim(new.time))));
    if public.booking_slot_taken(new.organization_id, v_kind, v_who, new.date, new.time, new.booking_id) then
      raise exception using errcode = 'BK409', message = 'slot_taken',
        detail = format('%s %s, %s %s', v_kind, v_who, new.date, btrim(new.time));
    end if;
  end loop;
  return new;
end;
$$;

drop trigger if exists bookings_slot_guard on public.bookings;
create trigger bookings_slot_guard
  before insert or update of therapist_id, doctor_id, date, time, status on public.bookings
  for each row execute function public.bookings_slot_guard();

-- ---------------------------------------------------------------------
-- 4. Idempotency keys (api/src/idempotency.js)
-- ---------------------------------------------------------------------
create table if not exists public.idempotency_keys (
  scope           text        not null,   -- e.g. rpc:record_quick_payment
  key             text        not null,   -- the client's Idempotency-Key
  organization_id uuid,
  user_id         uuid,
  status          int,
  response        jsonb,
  created_at      timestamptz not null default now(),
  primary key (scope, key)
);
create index if not exists idempotency_keys_created_at on public.idempotency_keys (created_at);
comment on table public.idempotency_keys is
  'Answers of requests sent with an Idempotency-Key, stored in the transaction that did the work. Platform/ops table: no RLS (0010).';
