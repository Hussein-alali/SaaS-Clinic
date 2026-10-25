-- =====================================================================
-- 0016_invoices_rpc_org.sql — the invoices screen's RPC names the clinic
-- (code review of S1–S10, 25 Oct 2026; docs/06 S9).
--
-- list_invoices_filtered reads invoices six times a call (the page and five
-- totals). RLS keeps it inside the clinic, but tenant_isolation reaches the
-- planner as `app_is_system() OR organization_id = app_org_id()`, which is
-- no index condition: every call scanned every clinic's invoices. Each read
-- now also says `i.organization_id = v_org` (the caller's clinic; the role
-- check above it already requires one), so the (organization_id, branch_id,
-- created_at) index of 0015 serves it. Same signature and result: create or
-- replace only (expand).
--
-- PostgreSQL >= 13, no extensions. migrate.js wraps this file in one
-- transaction.
-- =====================================================================

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
  -- [0016] the clinic, named in every read of invoices (index use, docs/06 S9).
  v_org   uuid := public.app_org_id();
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
     where i.organization_id = v_org and (v_from is null or i.created_at >= v_from)
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
                      where i.organization_id = v_org and (v_from is null or i.created_at >= v_from)
                        and (v_to   is null or i.created_at <= v_to)
                        and (v_st   is null or i.status = v_st)
                        and (v_srch is null
                             or i.invoice_id ilike '%'||v_srch||'%'
                             or coalesce(p.name,'') ilike '%'||v_srch||'%')),
    'paid_amount',   (select coalesce(sum(paid),0) from invoices i
                       left join patients p on p.patient_id = i.patient_id
                      where i.organization_id = v_org and (v_from is null or i.created_at >= v_from)
                        and (v_to   is null or i.created_at <= v_to)
                        and (v_st   is null or i.status = v_st)
                        and (v_srch is null
                             or i.invoice_id ilike '%'||v_srch||'%'
                             or coalesce(p.name,'') ilike '%'||v_srch||'%')),
    'outstanding',   (select coalesce(sum(greatest(coalesce(amount,0)-coalesce(paid,0),0)),0)
                        from invoices i
                        left join patients p on p.patient_id = i.patient_id
                       where i.organization_id = v_org and (v_from is null or i.created_at >= v_from)
                         and (v_to   is null or i.created_at <= v_to)
                         and (v_st   is null or i.status = v_st)
                         and (v_srch is null
                              or i.invoice_id ilike '%'||v_srch||'%'
                              or coalesce(p.name,'') ilike '%'||v_srch||'%')),
    'overdue_amount',(select coalesce(sum(greatest(coalesce(amount,0)-coalesce(paid,0),0)),0)
                        from invoices i
                        left join patients p on p.patient_id = i.patient_id
                       where i.organization_id = v_org and (v_from is null or i.created_at >= v_from)
                         and (v_to   is null or i.created_at <= v_to)
                         and i.status = 'متأخر'
                         and (v_st   is null or i.status = v_st)
                         and (v_srch is null
                              or i.invoice_id ilike '%'||v_srch||'%'
                              or coalesce(p.name,'') ilike '%'||v_srch||'%')),
    'avg_amount',    (select coalesce(avg(amount),0) from invoices i
                       left join patients p on p.patient_id = i.patient_id
                      where i.organization_id = v_org and (v_from is null or i.created_at >= v_from)
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
