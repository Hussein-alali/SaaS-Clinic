-- =====================================================================
-- 0009_inactive_branch_guard.sql — no new row on an inactive branch
-- (plan task 3.18; docs/05-Backend-Schema.md convention 8 and
-- "branches"; docs/03 C07).
--
-- Branches are deactivated, never deleted (0005). The API still accepts
-- an X-Branch-Id that names an inactive branch the member may use
-- (api/src/tenant.js chooseBranch): the history of a closed branch stays
-- readable, and its rows can still be updated (an old invoice paid, a
-- booking cancelled). What must not happen is new work landing there, so
-- the database refuses it, whatever the route:
--
--   * BEFORE INSERT on the seven branch-scoped tables (bookings, sessions,
--     invoices, payments, payment_receipts, patient_schedules, treatments)
--     when branch_id (usually DEFAULT app_branch_id() = X-Branch-Id) names
--     an inactive branch;
--   * BEFORE UPDATE OF branch_id when a row is moved to an inactive branch.
--
-- The error is SQLSTATE BR409, message 'branch_inactive'; the API answers
-- 409 {code:'branch_inactive', message:'Branch is inactive'}
-- (api/src/errors.js mapPgError), on /api/data and /api/rpc alike (e.g.
-- record_quick_payment, whose payments row would be new).
--
-- Not refused:
--   * Updates that leave branch_id alone, and deletes.
--   * INSERT ... ON CONFLICT DO UPDATE of a row that already exists: the
--     screens save existing rows that way (src/supabase.jsx upsertRow),
--     and BEFORE INSERT fires before the conflict is found. When the
--     primary key (the trigger argument) is already there, the statement
--     updates that row, which keeps its branch (or fails with 23505).
--   * A branch the caller cannot see (another clinic's, hidden by RLS):
--     the composite foreign key and branch_scope already refuse those.
--   * The system context (app.system = 'on': seeds, the Supabase data
--     import of task 4.7, platform maintenance; never derived from a
--     request), which may need to write the history of a closed branch.
--
-- PostgreSQL >= 13, no extensions. migrate.js wraps this file in one
-- transaction.
-- =====================================================================

create or replace function public.refuse_inactive_branch()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_status text;
  v_exists boolean;
begin
  if public.app_is_system() then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.branch_id is not distinct from old.branch_id then
    return new;
  end if;

  -- Runs with the caller's RLS: every role that writes these tables may
  -- read branches ("staff read branches").
  select b.status into v_status from public.branches b where b.id = new.branch_id;
  if not found or v_status = 'active' then
    return new;
  end if;

  -- An upsert of an existing row is an update (see the header).
  if tg_op = 'INSERT' then
    execute format('select exists (select 1 from public.%I t where t.%I = $1)', tg_table_name, tg_argv[0])
       into v_exists
      using to_jsonb(new) ->> tg_argv[0];
    if v_exists then
      return new;
    end if;
  end if;

  raise exception using
    errcode = 'BR409',
    message = 'branch_inactive',
    detail  = format('branch %s is inactive: no new %s row can be added to it', new.branch_id, tg_table_name),
    hint    = 'Work in an active branch; the rows of an inactive branch can still be read and updated.';
end
$$;

-- One trigger per branch-scoped table; the argument is its primary key.
do $$
declare
  t record;
begin
  for t in
    select * from (values
      ('bookings', 'booking_id'),
      ('sessions', 'session_id'),
      ('invoices', 'invoice_id'),
      ('payments', 'payment_id'),
      ('payment_receipts', 'receipt_id'),
      ('patient_schedules', 'schedule_id'),
      ('treatments', 'treatment_id')
    ) v (tbl, pk)
  loop
    execute format('drop trigger if exists %I on public.%I', t.tbl || '_branch_active', t.tbl);
    execute format(
      'create trigger %I before insert or update of branch_id on public.%I
         for each row execute function public.refuse_inactive_branch(%L)',
      t.tbl || '_branch_active', t.tbl, t.pk);
  end loop;
end
$$;

-- Self-check: every branch-scoped table (branch_id + branch_scope, 0003)
-- has the trigger, enabled, and its argument is the table's primary key.
do $$
declare
  v_bad text[];
begin
  select array_agg(c.relname::text order by c.relname) into v_bad
    from pg_class c
   where c.relnamespace = 'public'::regnamespace
     and c.relkind = 'r'
     and exists (select 1 from pg_policy p where p.polrelid = c.oid and p.polname = 'branch_scope')
     and not exists (
       select 1
         from pg_trigger g
         join pg_index i on i.indrelid = c.oid and i.indisprimary and i.indnatts = 1
         join pg_attribute a on a.attrelid = c.oid and a.attnum = i.indkey[0]
        where g.tgrelid = c.oid
          and g.tgfoid = 'public.refuse_inactive_branch()'::regprocedure
          and g.tgenabled <> 'D'
          and g.tgnargs = 1
          and g.tgargs = convert_to(a.attname::text, 'UTF8') || '\x00'::bytea);
  if v_bad is not null then
    raise exception '0009_inactive_branch_guard self-check: branch tables without a working refuse_inactive_branch trigger: %', v_bad;
  end if;
end
$$;
