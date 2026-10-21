-- ═══════════════════════════════════════════════════════════════
-- Migration: persistent in-progress sessions + drop template version
-- history (2026-07-13)
--
-- 1. Treatment sessions become durable the moment they START:
--    • sessions.status ('in_progress' | 'completed') + started_at
--    • the row is inserted at session start and updated at sign-off,
--      so navigation/refresh/re-login never loses a running session
--    • the plan counter only counts COMPLETED sessions
-- 2. Template version history (سجل الإصدارات) is removed end to end:
--    the snapshot writer becomes a no-op (existing RPC bodies keep
--    working), the restore RPC and the template_versions table are
--    dropped, and get_treatment_template stops returning versions.
-- Idempotent — safe to re-run.
-- ═══════════════════════════════════════════════════════════════

-- ── sessions: lifecycle status ─────────────────────────────────
alter table sessions add column if not exists status text default 'completed'
  check (status in ('in_progress','completed'));
alter table sessions add column if not exists started_at timestamptz;
create index if not exists sessions_status_idx on sessions(status);

-- Plan counters count only completed sessions.
create or replace function public.sync_treatment_session_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids text[];
begin
  v_ids := array_remove(array[
    case when tg_op in ('INSERT','UPDATE') then new.treatment_id end,
    case when tg_op in ('DELETE','UPDATE') then old.treatment_id end
  ], null);
  update treatments t
     set completed_sessions = (
           select count(*) from sessions s
            where s.treatment_id = t.treatment_id
              and coalesce(s.status, 'completed') = 'completed'
         ),
         updated_at = now()
   where t.treatment_id = any(v_ids);
  return null;
end;
$$;

drop trigger if exists sessions_sync_treatment_count on sessions;
create trigger sessions_sync_treatment_count
  after insert or update of treatment_id, status or delete on sessions
  for each row execute function public.sync_treatment_session_count();

-- Recount with the status filter applied.
update treatments t
   set completed_sessions = coalesce(
         (select count(*) from sessions s
           where s.treatment_id = t.treatment_id
             and coalesce(s.status, 'completed') = 'completed'), 0);

-- ── Template version history: removed ──────────────────────────
-- Neutralize the snapshot writer first — the template create/update/
-- duplicate RPCs still call it, and a no-op keeps them intact.
create or replace function public._tpl_write_version(
  p_template_id text, p_editor_uid uuid, p_editor_name text, p_summary text
) returns void language plpgsql security definer set search_path = public as $$
begin
  -- Version history was removed from the product; intentionally a no-op.
  return;
end;
$$;

-- get_treatment_template no longer returns a versions payload.
create or replace function public.get_treatment_template(
  p_template_id text
) returns jsonb
language plpgsql security definer set search_path = public stable as $$
declare
  v_tpl jsonb;
  v_stats jsonb;
begin
  if public.app_role() not in ('admin','doctor','therapist') then
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
$$;
grant execute on function public.get_treatment_template(text) to authenticated;

-- Drop the restore RPC (references the table) then the table and the
-- now-unused snapshot helper.
drop function if exists public.restore_template_version(text);
drop table if exists template_versions;
drop function if exists public._tpl_snapshot(text);

notify pgrst, 'reload schema';
