-- Already applied to live DB out-of-band; committed retroactively to restore migrations-as-truth. Do NOT re-execute manually.
--
-- The `folders` table, the `assets.folder_id` column + FK, and the supporting
-- index were created directly against live v2 (Supabase project
-- movnexawfhsyuluspxoc) outside the migration history. This file mirrors that
-- live state EXACTLY so a fresh database build reproduces it, no more and no
-- less. RECORD ONLY: do not run `supabase db push` or any apply/migrate command
-- for this PR. No data backfill (folders was empty; assets.folder_id is NULL for
-- every existing row). `assets.folder_path` is retained for now; reconciliation
-- between folder_path and folder_id is deferred to a later decision.

-- ---------------------------------------------------------------------------
-- folders: per-workspace, self-referential (parent_id) asset folder tree.
-- Soft-deleted via deleted_at. id is uuidv7() like every other base table.
-- ---------------------------------------------------------------------------
CREATE TABLE public.folders (
  id uuid NOT NULL DEFAULT uuidv7(),
  workspace_id uuid NOT NULL,
  name text NOT NULL,
  parent_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT folders_pkey PRIMARY KEY (id),
  CONSTRAINT folders_name_check CHECK (((char_length(name) >= 1) AND (char_length(name) <= 80))),
  CONSTRAINT folders_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id),
  CONSTRAINT folders_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.folders(id),
  CONSTRAINT folders_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL
);

-- Active-folder uniqueness: one name per (workspace, parent), case-insensitive,
-- treating NULL parent_id as a single grouping value (NULLS NOT DISTINCT).
CREATE UNIQUE INDEX folders_unique_name
  ON public.folders USING btree (workspace_id, parent_id, lower(name))
  NULLS NOT DISTINCT
  WHERE (deleted_at IS NULL);

CREATE INDEX folders_workspace_parent
  ON public.folders USING btree (workspace_id, parent_id)
  WHERE (deleted_at IS NULL);

-- Cycle guard: a folder may not be its own parent, nor sit inside its own
-- subtree. Walks the parent chain on every parent_id insert/update.
CREATE OR REPLACE FUNCTION public.folders_prevent_cycle()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
declare cur uuid;
begin
  if new.parent_id is null then return new; end if;
  if new.parent_id = new.id then raise exception 'folder cannot be its own parent'; end if;
  cur := new.parent_id;
  while cur is not null loop
    if cur = new.id then raise exception 'folder cycle detected'; end if;
    select parent_id into cur from public.folders where id = cur;
  end loop;
  return new;
end $function$;

CREATE TRIGGER folders_cycle_guard
  BEFORE INSERT OR UPDATE OF parent_id ON public.folders
  FOR EACH ROW EXECUTE FUNCTION public.folders_prevent_cycle();

-- RLS: enabled, not forced (matches every other base table). The only policy on
-- folders is a workspace-membership SELECT; there are NO insert/update/delete
-- policies. Roles is PUBLIC, mirroring live.
ALTER TABLE public.folders ENABLE ROW LEVEL SECURITY;

CREATE POLICY folders_select_member ON public.folders AS PERMISSIVE FOR SELECT TO public
  USING (
    (deleted_at IS NULL)
    AND (EXISTS (
      SELECT 1 FROM workspace_members wm
      WHERE ((wm.workspace_id = folders.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.active = true))
    ))
  );

-- Table privileges mirror live EXACTLY. CREATE TABLE in the public schema grants
-- ALL to anon/authenticated/service_role via Supabase default privileges; live
-- folders has SELECT/INSERT/UPDATE/DELETE revoked from all three (only the
-- REFERENCES/TRIGGER/TRUNCATE defaults remain) and SELECT granted to
-- srtdio_readonly. See the PR description: this leaves the folders_select_member
-- policy unreachable for the authenticated role at the table-grant level, and
-- service_role has no CRUD grant. Recorded as-is; not changed in this PR.
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.folders FROM anon, authenticated, service_role;
GRANT SELECT ON public.folders TO srtdio_readonly;

-- ---------------------------------------------------------------------------
-- assets.folder_id: nullable FK into folders, SET NULL on folder delete, plus a
-- partial index for active rows. folder_path stays in place (see header).
-- ---------------------------------------------------------------------------
ALTER TABLE public.assets
  ADD COLUMN folder_id uuid;

ALTER TABLE public.assets
  ADD CONSTRAINT assets_folder_id_fkey FOREIGN KEY (folder_id) REFERENCES public.folders(id) ON DELETE SET NULL;

CREATE INDEX assets_workspace_folder
  ON public.assets USING btree (workspace_id, folder_id)
  WHERE (deleted_at IS NULL);
