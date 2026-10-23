-- =====================================================================
-- 0005_branches_no_delete.sql — branches are deactivated, never deleted
-- (plan task 2.15; docs/05-Backend-Schema.md "branches": status
-- 'active' | 'inactive'; docs/03 C07).
--
-- 0001's policy "admin write branches" is FOR ALL, so a clinic admin could
-- still DELETE a branch that no row references (the old sidebar picker did
-- exactly that). The screens now deactivate a branch instead (C07,
-- src/supabase.jsx setBranchStatus / removeBranch), so the policy is split
-- into INSERT and UPDATE only. Without a permissive DELETE policy, a
-- member's DELETE on branches matches no row (RLS) and deletes nothing.
--
-- Unchanged: "staff read branches" (SELECT), the RESTRICTIVE
-- tenant_isolation policy, the plan-limit trigger (re-activating a branch
-- is checked against max_branches) and system_access (the API's own
-- system context may still remove a branch, e.g. while cleaning up a
-- clinic that never went live).
--
-- PostgreSQL >= 13, no extensions. migrate.js wraps this file in one
-- transaction.
-- =====================================================================

drop policy if exists "admin write branches" on public.branches;

create policy "admin insert branches" on public.branches
  for insert
  with check (public.app_role() = 'admin');

create policy "admin update branches" on public.branches
  for update
  using (public.app_role() = 'admin')
  with check (public.app_role() = 'admin');

-- Self-check: no permissive policy lets a member delete a branch (the
-- system_access policy is the only one that covers DELETE).
do $$
declare
  v_bad text[];
begin
  select array_agg(p.polname order by p.polname) into v_bad
    from pg_policy p
   where p.polrelid = 'public.branches'::regclass
     and p.polpermissive
     and p.polcmd in ('d', '*')
     and p.polname <> 'system_access';
  if v_bad is not null then
    raise exception '0005_branches_no_delete self-check: policies still allow DELETE on branches: %', v_bad;
  end if;
end
$$;
