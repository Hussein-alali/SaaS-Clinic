-- =====================================================================
-- 0007_rpc_role_guards.sql — the role guards of the security-definer RPCs
-- refuse a caller without a role (plan task 2.9; docs/05-Backend-Schema.md
-- convention 12, "Authorization rules").
--
-- The guards inherited from the Supabase functions (0001, some re-created
-- by 0003) read
--     if v_role not in ('admin','doctor') then raise ...
--     if v_role <> 'admin' then raise ...
--     if public.app_role() not in (...) then raise ...
-- app_role() is NULL without an active membership in the current clinic
-- (anonymous, a non-member, a disabled member or account, a suspended
-- clinic), and "NULL not in (...)" is NULL, not true: the guard did not
-- fire. RLS still limited what such a caller could read or write, but the
-- function itself must refuse first. Every guard is now NULL-safe:
--     if v_role is null or v_role not in (...) then raise ...
--     if v_role is null or v_role <> 'admin' then raise ...
--     if coalesce(public.app_role(), '') not in (...) then raise ...
-- The messages are unchanged ('غير مصرح...', SQLSTATE P0001 → the API's
-- 400 {message, code:'P0001'}).
--
-- record_quick_payment and list_invoices_filtered had no role check at
-- all; they now admit admin and receptionist only: the billing roles of
-- the screens (src/roles.jsx: only they reach «المدفوعات», the one caller
-- of both) and of RLS (payments, bookings and invoices are written by
-- admin/receptionist only, so a doctor's quick payment already failed
-- with "not found"). A doctor still reads invoices through /api/data
-- (0001 policy "staff read invoices"); the RPC is a billing screen.
--
-- The legacy v1 RPCs create_treatment_method() and
-- update_treatment_method() are DROPPED: no screen calls them (src/*.jsx
-- uses upsert_treatment_method), they are not in the API whitelist
-- (api/src/rpc-whitelist.js), so nothing could reach them, and they
-- carried the same NULL-unsafe guard.
--
-- Each function below is the CURRENT definition (0001, or 0003 for the
-- ones it re-created), as pg_get_functiondef() prints it, with only the
-- guard changed (and, in the two billing RPCs, the new guard added).
-- The self-check at the end fails the migration if a security-definer
-- function in public still has a NULL-unsafe guard.
--
-- PostgreSQL >= 13, no extensions. migrate.js wraps this file in one
-- transaction.
-- =====================================================================

drop function if exists public.create_treatment_method(text, text, text, text, integer, text);
drop function if exists public.update_treatment_method(text, text, text, text, integer, text);

-- ---------------------------------------------------------------------
-- Billing (core.billing): admin and receptionist; delete_payment_receipt admin only
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
$function$;

create or replace function public.list_invoices_filtered(p_from timestamp with time zone default null::timestamp with time zone, p_to timestamp with time zone default null::timestamp with time zone, p_search text default null::text, p_status text default null::text, p_limit integer default 50, p_offset integer default 0)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
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
  v_role  text := public.app_role();
begin
  -- [0007] billing roles only (there was no role check).
  if v_role is null or v_role not in ('admin','receptionist') then
    raise exception 'غير مصرح — الفواتير مقتصرة على المدير وموظف الاستقبال';
  end if;

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
$function$;

create or replace function public.delete_payment_receipt(p_receipt_id text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_role text := public.app_role();
  v_row  payment_receipts%rowtype;
begin
  if v_role is null or v_role <> 'admin' then
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
$function$;

-- ---------------------------------------------------------------------
-- Treatment methods: admin and doctor
-- ---------------------------------------------------------------------

create or replace function public.upsert_treatment_method(p_method_id text, p_payload jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_role   text := public.app_role();
  v_uid    uuid := auth.uid();
  v_name   text := btrim(coalesce(p_payload->>'name',''));
  v_id     text := p_method_id;
  v_old    treatment_methods%rowtype;
  v_dup    int;
  v_action text;
  v_exists boolean;
begin
  if v_role is null or v_role not in ('admin','doctor') then
    raise exception 'غير مصرح — لا تملك صلاحية إدارة طرق العلاج';
  end if;
  if v_name = '' then raise exception 'اسم طريقة العلاج مطلوب'; end if;

  if v_id is null or v_id = '' then
    v_id := 'TM-' || to_char(now(),'YYYYMMDD-HH24MISS') || '-'
         || upper(substr(md5(random()::text),1,4));
  end if;

  select * into v_old from treatment_methods where method_id = v_id for update;
  v_exists := found; -- [0003]
  v_action := case when v_exists then 'tx_method_update' else 'tx_method_create' end;

  select count(*) into v_dup from treatment_methods
    where lower(trim(name)) = lower(v_name) and method_id <> v_id;
  if v_dup > 0 then raise exception 'اسم طريقة العلاج موجود مسبقًا'; end if;

  if v_exists then
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
$function$;

create or replace function public.delete_treatment_method(p_method_id text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_role text := public.app_role();
  v_uid  uuid := auth.uid();
  v_row  treatment_methods%rowtype;
  v_hits int;
begin
  if v_role is null or v_role not in ('admin','doctor') then
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
$function$;

create or replace function public.set_treatment_method_status(p_method_id text, p_status text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_role text := public.app_role();
  v_old  text;
begin
  if v_role is null or v_role not in ('admin','doctor') then
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
$function$;

-- ---------------------------------------------------------------------
-- Treatment-plan templates: read by admin, doctor, therapist; written by admin, doctor;
-- applied by admin, doctor, therapist
-- ---------------------------------------------------------------------

create or replace function public.list_treatment_templates(p_status text default null::text, p_category text default null::text, p_creator uuid default null::uuid, p_search text default null::text, p_sort text default 'recent'::text, p_limit integer default 100, p_offset integer default 0)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_lim int := least(greatest(coalesce(p_limit,100),1),500);
  v_off int := greatest(coalesce(p_offset,0),0);
  v_srch text := nullif(btrim(coalesce(p_search,'')),'');
  v_st   text := nullif(btrim(coalesce(p_status,'')),'');
  v_cat  text := nullif(btrim(coalesce(p_category,'')),'');
  v_rows jsonb;
  v_cnt  int;
begin
  if coalesce(public.app_role(), '') not in ('admin','doctor','therapist') then
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
$function$;

create or replace function public.get_treatment_template(p_template_id text)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_tpl jsonb;
  v_stats jsonb;
begin
  if coalesce(public.app_role(), '') not in ('admin','doctor','therapist') then
    raise exception 'غير مصرح';
  end if;
  select to_jsonb(t.*) into v_tpl from treatment_templates t where t.template_id = p_template_id;
  if v_tpl is null then return null; end if;

  select jsonb_build_object(
    'usage_count',    coalesce(count(*),0),
    'completion_rate',coalesce(round(avg( (completed_at is not null)::int )::numeric * 100, 1), 0),
    'avg_recovery',   coalesce(round(avg(recovery_days),1), 0),
    'last_used_at',   max(applied_at)
  ) into v_stats
    from template_usage where template_id = p_template_id;

  return jsonb_build_object('template', v_tpl, 'stats', v_stats);
end;
$function$;

create or replace function public.create_treatment_template(p_template_id text, p_payload jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_role  text := public.app_role();
  v_uid   uuid := auth.uid();
  v_name  text := coalesce((p_payload->>'created_by_name'),'');
  v_new_id text := p_template_id;
begin
  if v_role is null or v_role not in ('admin','doctor') then
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
$function$;

create or replace function public.update_treatment_template(p_template_id text, p_payload jsonb, p_change_summary text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_role text := public.app_role();
  v_uid  uuid := auth.uid();
  v_name text := coalesce((p_payload->>'updated_by_name'),'');
  v_old  jsonb;
begin
  if v_role is null or v_role not in ('admin','doctor') then
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
  -- [0003] a global template (or one hidden by RLS) is not updated.
  if not found then raise exception 'لا يمكن تعديل هذا القالب (قالب عام للقراءة فقط)'; end if;

  perform public._tpl_write_version(p_template_id, v_uid, v_name, coalesce(p_change_summary,'تعديل'));

  insert into audit_events (actor_uid, actor_role, action, table_name, row_pk, payload)
  values (v_uid, v_role, 'template_update', 'treatment_templates', p_template_id,
    jsonb_build_object('old', v_old, 'new', p_payload, 'summary', p_change_summary));

  return jsonb_build_object('template_id', p_template_id);
end;
$function$;

create or replace function public.duplicate_treatment_template(p_template_id text, p_new_name text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_role  text := public.app_role();
  v_uid   uuid := auth.uid();
  v_src   treatment_templates%rowtype;
  v_new_id text;
begin
  if v_role is null or v_role not in ('admin','doctor') then
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
$function$;

create or replace function public.set_treatment_template_status(p_template_id text, p_status text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_role text := public.app_role();
  v_uid  uuid := auth.uid();
begin
  if v_role is null or v_role not in ('admin','doctor') then
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
$function$;

create or replace function public.delete_treatment_template(p_template_id text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_role text := public.app_role();
  v_uid  uuid := auth.uid();
  v_uses int;
  v_row  treatment_templates%rowtype;
begin
  if v_role is null or v_role not in ('admin','doctor') then
    raise exception 'غير مصرح';
  end if;
  select * into v_row from treatment_templates where template_id = p_template_id;
  if not found then raise exception 'القالب غير موجود'; end if;

  select count(*)::int into v_uses from template_usage where template_id = p_template_id;
  if v_uses > 0 or coalesce(v_row.usage_count,0) > 0 then
    raise exception 'لا يمكن حذف قالب مستخدم — استخدم الأرشفة بدلاً منه';
  end if;

  delete from treatment_templates where template_id = p_template_id;
  -- [0003] a global template (or one hidden by RLS) is not deleted.
  if not found then raise exception 'لا يمكن حذف هذا القالب (قالب عام للقراءة فقط)'; end if;

  insert into audit_events (actor_uid, actor_role, action, table_name, row_pk, payload)
  values (v_uid, v_role, 'template_delete', 'treatment_templates', p_template_id,
    to_jsonb(v_row));

  return jsonb_build_object('template_id', p_template_id, 'deleted', true);
end;
$function$;

create or replace function public.apply_template_to_patient(p_template_id text, p_patient_id text, p_plan_id text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_role text := public.app_role();
  v_uid  uuid := auth.uid();
  v_name text := coalesce((select raw_user_meta_data->>'name' from auth.users where id = v_uid),'—');
  v_use_id text;
  v_status text;
begin
  if v_role is null or v_role not in ('admin','doctor','therapist') then
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
$function$;

-- ---------------------------------------------------------------------
-- Template categories: read by admin, doctor, therapist; written by admin, doctor
-- ---------------------------------------------------------------------

create or replace function public.list_template_categories(p_include_archived boolean default false)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare v_rows jsonb;
begin
  if coalesce(public.app_role(), '') not in ('admin','doctor','therapist') then
    raise exception 'غير مصرح';
  end if;
  select coalesce(jsonb_agg(to_jsonb(c.*) order by
    coalesce(c.sort_order, 999999), c.name),'[]'::jsonb)
    into v_rows
    from template_categories c
   where p_include_archived or c.status = 'active';
  return jsonb_build_object('rows', v_rows);
end;
$function$;

create or replace function public.upsert_template_category(p_category_id text, p_payload jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_role text := public.app_role();
  v_uid  uuid := auth.uid();
  v_name text := btrim(coalesce(p_payload->>'name',''));
  v_id   text := p_category_id;
  v_old  template_categories%rowtype;
  v_dup  int;
  v_action text;
  v_exists boolean;
begin
  if v_role is null or v_role not in ('admin','doctor') then
    raise exception 'غير مصرح — لا تملك صلاحية إدارة الفئات';
  end if;
  if v_name = '' then raise exception 'اسم الفئة مطلوب'; end if;

  if v_id is null or v_id = '' then
    v_id := 'TPC-' || to_char(now(),'YYYYMMDD-HH24MISS') || '-'
         || upper(substr(md5(random()::text),1,4));
  end if;

  select * into v_old from template_categories where category_id = v_id for update;
  v_exists := found; -- [0003]
  v_action := case when v_exists then 'tpl_cat_update' else 'tpl_cat_create' end;

  select count(*) into v_dup from template_categories
    where lower(trim(name)) = lower(v_name) and category_id <> v_id;
  if v_dup > 0 then raise exception 'اسم الفئة موجود مسبقًا'; end if;

  if v_exists then
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
$function$;

create or replace function public.set_template_category_status(p_category_id text, p_status text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_role text := public.app_role();
  v_uid  uuid := auth.uid();
begin
  if v_role is null or v_role not in ('admin','doctor') then
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
$function$;

create or replace function public.delete_template_category(p_category_id text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_role text := public.app_role();
  v_uid  uuid := auth.uid();
  v_cat  template_categories%rowtype;
  v_used int;
begin
  if v_role is null or v_role not in ('admin','doctor') then
    raise exception 'غير مصرح — لا تملك صلاحية حذف الفئات';
  end if;
  select * into v_cat from template_categories where category_id = p_category_id;
  if not found then raise exception 'الفئة غير موجودة'; end if;
  select count(*) into v_used from treatment_templates where category = v_cat.name;
  if v_used > 0 then
    raise exception 'لا يمكن حذف الفئة — يستخدمها % قالب. أعد تصنيف القوالب أو أرشِف الفئة بدلًا من حذفها.', v_used;
  end if;
  delete from template_categories where category_id = p_category_id;
  -- [0003] a global category (or one hidden by RLS) is not deleted.
  if not found then raise exception 'لا يمكن حذف هذه الفئة (فئة عامة للقراءة فقط)'; end if;
  insert into audit_events (actor_uid, actor_role, action, table_name, row_pk, payload)
  values (v_uid, v_role, 'tpl_cat_delete', 'template_categories', p_category_id, to_jsonb(v_cat));
  return jsonb_build_object('category_id', p_category_id, 'deleted', true);
end;
$function$;

-- ---------------------------------------------------------------------
-- Patient treatments: admin, doctor, therapist; deleted by admin, doctor
-- ---------------------------------------------------------------------

create or replace function public.create_treatment(p_treatment_id text, p_payload jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
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
  if v_role is null or v_role not in ('admin','doctor','therapist') then
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
$function$;

create or replace function public.update_treatment(p_treatment_id text, p_payload jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_role text := public.app_role();
  v_uid  uuid := auth.uid();
  v_name text := coalesce((select raw_user_meta_data->>'name' from auth.users where id = v_uid),'—');
  v_th_id text := nullif(btrim(coalesce(p_payload->>'therapist_id','')),'');
  v_th_nm text;
  v_row  treatments%rowtype;
begin
  if v_role is null or v_role not in ('admin','doctor','therapist') then
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
$function$;

create or replace function public.list_treatments(p_patient_id text default null::text, p_status text default null::text, p_search text default null::text, p_limit integer default 200, p_offset integer default 0)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_lim  int  := least(greatest(coalesce(p_limit,200),1),500);
  v_off  int  := greatest(coalesce(p_offset,0),0);
  v_srch text := nullif(btrim(coalesce(p_search,'')),'');
  v_st   text := nullif(btrim(coalesce(p_status,'')),'');
  v_pid  text := nullif(btrim(coalesce(p_patient_id,'')),'');
  v_rows jsonb;
  v_cnt  int;
begin
  if coalesce(public.app_role(), '') not in ('admin','doctor','therapist') then
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
$function$;

create or replace function public.get_treatment(p_treatment_id text)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_out jsonb;
begin
  if coalesce(public.app_role(), '') not in ('admin','doctor','therapist') then
    raise exception 'غير مصرح';
  end if;
  select to_jsonb(t.*) || jsonb_build_object('patient_name', p.name)
    into v_out
    from treatments t
    left join patients p on p.patient_id = t.patient_id
   where t.treatment_id = p_treatment_id;
  return v_out;
end;
$function$;

create or replace function public.delete_treatment(p_treatment_id text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_role     text := public.app_role();
  v_uid      uuid := auth.uid();
  v_unlinked int;
  v_row      treatments%rowtype;
begin
  if v_role is null or v_role not in ('admin','doctor') then
    raise exception 'غير مصرح';
  end if;
  select * into v_row from treatments where treatment_id = p_treatment_id;
  if not found then raise exception 'سجل العلاج غير موجود'; end if;

  -- Count the sessions that will be unlinked by the FK (on delete set null).
  select count(*)::int into v_unlinked from sessions where treatment_id = p_treatment_id;

  delete from treatments where treatment_id = p_treatment_id;

  insert into audit_events (actor_uid, actor_role, action, table_name, row_pk, payload)
  values (v_uid, v_role, 'treatment_delete', 'treatments', p_treatment_id, to_jsonb(v_row));

  return jsonb_build_object(
    'treatment_id', p_treatment_id,
    'deleted', true,
    'sessions_unlinked', v_unlinked
  );
end;
$function$;


-- =====================================================================
-- Self-check
-- =====================================================================
do $$
declare
  v_rpcs text[] := array[
    'record_quick_payment', 'list_invoices_filtered', 'delete_payment_receipt',
    'upsert_treatment_method', 'delete_treatment_method', 'set_treatment_method_status',
    'list_treatment_templates', 'get_treatment_template', 'create_treatment_template',
    'update_treatment_template', 'duplicate_treatment_template', 'set_treatment_template_status',
    'delete_treatment_template', 'apply_template_to_patient',
    'list_template_categories', 'upsert_template_category', 'set_template_category_status',
    'delete_template_category',
    'create_treatment', 'update_treatment', 'list_treatments', 'get_treatment', 'delete_treatment'];
  v_bad text[];
begin
  -- No security-definer function in public compares v_role / app_role()
  -- with "not in", "<>" or "!=" unless the same test first says
  -- "... is null or ..." (coalesce(public.app_role(), '') never matches).
  select array_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text) into v_bad
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.prosecdef
     and regexp_replace(p.prosrc,
           '(v_role|app_role\(\))\s+is\s+null\s+or\s+(public\.)?(v_role|app_role\(\))\s', ' ', 'gi')
         ~* '(v_role|app_role\(\))\s*(not\s+in\M|<>|!=)';
  if v_bad is not null then
    raise exception '0007_rpc_role_guards self-check: NULL-unsafe role guards in %', v_bad;
  end if;

  -- Every RPC the API whitelists is security definer and has a NULL-safe
  -- role guard.
  select array_agg(f order by f) into v_bad
    from unnest(v_rpcs) f
   where not exists (
     select 1 from pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.proname = f and p.prosecdef
        and p.prosrc ~* '(v_role\s+is\s+null\s+or\s+v_role\s+(not\s+in|<>)|coalesce\(public\.app_role\(\), ''''\)\s+not\s+in)');
  if v_bad is not null then
    raise exception '0007_rpc_role_guards self-check: RPCs without a NULL-safe role guard: %', v_bad;
  end if;

  -- The legacy v1 treatment-method RPCs are gone.
  select array_agg(p.oid::regprocedure::text) into v_bad
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('create_treatment_method', 'update_treatment_method');
  if v_bad is not null then
    raise exception '0007_rpc_role_guards self-check: legacy RPCs still defined: %', v_bad;
  end if;
end
$$;
