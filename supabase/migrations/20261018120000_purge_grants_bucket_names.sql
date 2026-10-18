-- Already applied live on 18 Oct 2026 via Supabase MCP (project movnexawfhsyuluspxoc); this file is the record.
--
-- 1. The asset-upload Worker's /purge and /purge-chat routes (service_role) re-check
--    asset_in_use in code before removing files from R2. That check reads
--    asset_attachments and comments, which service_role could not SELECT.
grant select on table public.asset_attachments to service_role;
grant select on table public.comments to service_role;

-- 2. Workspace bucket names: a deleted workspace keeps its bucket name until the
--    nightly storage-purge job wipes it, so a new workspace must never reuse that
--    name (the old check only looked at deleted_at IS NULL rows). Also trims a
--    trailing "-" left by the 56-character cut.
create or replace function public.set_workspace_asset_bucket() returns trigger language plpgsql as $$
declare base text; cand text;
begin
  if new.asset_bucket is not null then return new; end if;
  base := trim(both '-' from left('assets-' || coalesce(nullif(public.slugify_workspace(new.name), ''), 'ws'), 56));
  cand := base;
  if exists (select 1 from public.workspaces where asset_bucket = cand) then
    cand := base || '-' || right(replace(new.id::text, '-', ''), 4);
    if exists (select 1 from public.workspaces where asset_bucket = cand) then
      cand := base || '-' || right(replace(new.id::text, '-', ''), 6);
    end if;
  end if;
  new.asset_bucket := cand;
  return new;
end $$;
