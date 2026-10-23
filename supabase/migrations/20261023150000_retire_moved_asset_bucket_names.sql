-- Fast file delivery: GBL and College Vidya moved to Asia-Pacific buckets.
--
-- Applied live on 23 Oct 2026 by the owner in the Supabase SQL editor
-- (project movnexawfhsyuluspxoc), in one transaction:
--   * workspaces.asset_bucket switched for two workspaces (assets-gbl ->
--     assets-gbl-apac, assets-college-vidya -> assets-college-vidya-apac), with
--     the immutability trigger lifted for that statement only and row_version
--     bumped. That data change is specific to the live project and is NOT
--     repeated here.
--   * set_workspace_asset_bucket() taught to treat the two old bucket names as
--     taken forever: the old US buckets are kept as backups, so a new workspace
--     must never be given one of those names (it would share the backup bucket,
--     and deleting it would purge the backup).
-- This file records the function change so a fresh database matches live.

create or replace function public.set_workspace_asset_bucket()
 returns trigger
 language plpgsql
as $function$
declare
  base text;
  cand text;
  retired constant text[] := array['assets-gbl', 'assets-college-vidya'];
begin
  if new.asset_bucket is not null then return new; end if;
  base := trim(both '-' from left('assets-' || coalesce(nullif(public.slugify_workspace(new.name), ''), 'ws'), 56));
  cand := base;
  if cand = any(retired) or exists (select 1 from public.workspaces where asset_bucket = cand) then
    cand := base || '-' || right(replace(new.id::text, '-', ''), 4);
    if cand = any(retired) or exists (select 1 from public.workspaces where asset_bucket = cand) then
      cand := base || '-' || right(replace(new.id::text, '-', ''), 6);
    end if;
  end if;
  new.asset_bucket := cand;
  return new;
end $function$;
