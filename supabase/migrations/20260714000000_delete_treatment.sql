-- ============================================================
-- Migration: delete_treatment RPC (2026-07-14)
-- Adds a security-definer RPC to permanently delete one treatment
-- plan (سجل العلاج). Linked sessions are unlinked automatically by the
-- sessions.treatment_id FK (on delete set null) and the completed-count
-- trigger recounts, so no sessions are lost. Admins and doctors only.
-- Idempotent — safe to re-run.
-- ============================================================

create or replace function public.delete_treatment(
  p_treatment_id text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role     text := public.app_role();
  v_uid      uuid := auth.uid();
  v_unlinked int;
  v_row      treatments%rowtype;
begin
  if v_role not in ('admin','doctor') then
    raise exception 'غير مصرح';
  end if;
  select * into v_row from treatments where treatment_id = p_treatment_id;
  if not found then raise exception 'سجل العلاج غير موجود'; end if;

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
$$;
grant execute on function public.delete_treatment(text) to authenticated;
