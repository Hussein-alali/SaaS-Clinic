-- ═══════════════════════════════════════════════════════════════
-- Migration: fix created_by_name lookup in upsert RPCs (2026-07-14)
--
-- ROOT CAUSE: upsert_template_category() and upsert_treatment_method()
-- resolved the creator's display name with
--     (select name from staff where user_id = v_uid limit 1)
-- but the staff table's account link column is `auth_uid`, not `user_id`.
-- On the INSERT (create) branch PostgreSQL raised
--     ERROR 42703: column "user_id" does not exist
-- which aborted the whole function — so CREATING a new template category
-- (or a new treatment method) failed and nothing was stored. The UPDATE
-- (rename/edit) branch never references that column, which is why editing
-- an existing category worked while creating a new one silently failed.
--
-- FIX: look up the creator name by auth_uid. Both functions are recreated
-- verbatim below with only that one-word correction. Idempotent.
-- ═══════════════════════════════════════════════════════════════

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

-- ── NEW: delete a template category (blocked when still in use) ──
-- Completes category CRUD: a category with no templates referencing its
-- name can be hard-deleted; otherwise the caller is told to reassign or
-- archive. Admin/doctor only; audited. No template is ever orphaned.
create or replace function public.delete_template_category(
  p_category_id text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.app_role();
  v_uid  uuid := auth.uid();
  v_cat  template_categories%rowtype;
  v_used int;
begin
  if v_role not in ('admin','doctor') then
    raise exception 'غير مصرح — لا تملك صلاحية حذف الفئات';
  end if;
  select * into v_cat from template_categories where category_id = p_category_id;
  if not found then raise exception 'الفئة غير موجودة'; end if;
  select count(*) into v_used from treatment_templates where category = v_cat.name;
  if v_used > 0 then
    raise exception 'لا يمكن حذف الفئة — يستخدمها % قالب. أعد تصنيف القوالب أو أرشِف الفئة بدلًا من حذفها.', v_used;
  end if;
  delete from template_categories where category_id = p_category_id;
  insert into audit_events (actor_uid, actor_role, action, table_name, row_pk, payload)
  values (v_uid, v_role, 'tpl_cat_delete', 'template_categories', p_category_id, to_jsonb(v_cat));
  return jsonb_build_object('category_id', p_category_id, 'deleted', true);
end;
$$;
grant execute on function public.delete_template_category(text) to authenticated;

notify pgrst, 'reload schema';
