-- MVP baseline. Schema already applied to movnexawfhsyuluspxoc. Do NOT execute. Snapshot of live DB as of regeneration.

-- ============================================================================
-- Extensions
-- ============================================================================
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;

-- ============================================================================
-- Functions (definitions verbatim from live)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.uuidv7()
 RETURNS uuid
 LANGUAGE sql
AS $function$
  select encode(
    set_bit(
      set_bit(
        overlay(
          uuid_send(gen_random_uuid())
          placing substring(
            int8send(floor(extract(epoch from clock_timestamp()) * 1000)::bigint)
            from 3)
          from 1 for 6),
        52, 1),
      53, 1),
    'hex')::uuid;
$function$;

CREATE OR REPLACE FUNCTION public.workspace_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select nullif(
    current_setting('request.jwt.claims', true)::jsonb ->> 'workspace_id',
    ''
  )::uuid;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_row_version_increment()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if new.row_version is distinct from old.row_version + 1 then
    raise exception
      'row_version must increment by exactly 1 (expected %, got %)',
      old.row_version + 1, new.row_version
      using errcode = 'serialization_failure';
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.briefs_enforce_row_version()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if new.row_version <> old.row_version + 1 then
    raise exception 'row_version must increment by exactly 1 (was %, attempted %)',
      old.row_version, new.row_version
      using errcode = '40001';
  end if;
  new.updated_at := now();
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.posts_enforce_row_version()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if new.row_version <> old.row_version + 1 then
    raise exception 'row_version must increment by exactly 1 (was %, attempted %)',
      old.row_version, new.row_version
      using errcode = '40001';
  end if;
  new.updated_at := now();
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.workspaces_enforce_row_version()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if new.row_version <> old.row_version + 1 then
    raise exception 'row_version must increment by exactly 1 (was %, attempted %)',
      old.row_version, new.row_version
      using errcode = '40001';
  end if;
  new.updated_at := now();
  return new;
end;
$function$;

-- Retained in live; trigger function kept faithful to the live catalog.
CREATE OR REPLACE FUNCTION public.plan_cells_enforce_row_version()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if new.row_version <> old.row_version + 1 then
    raise exception 'row_version must increment by exactly 1 (was %, attempted %)',
      old.row_version, new.row_version
      using errcode = '40001';
  end if;
  new.updated_at := now();
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.users_set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.users_create_profile_on_signup()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  insert into public.users (id, display_name)
  values (
    new.id,
    coalesce(
      nullif(trim(new.raw_user_meta_data->>'full_name'), ''),
      nullif(trim(new.raw_user_meta_data->>'name'), ''),
      split_part(new.email, '@', 1)
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.seed_workspace_onboarding()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  insert into public.workspace_onboarding (workspace_id) values (new.id);
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.seed_workspace_role_defaults()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  insert into public.workspace_role_permissions (workspace_id, role, capability, allowed) values
    (new.id, 'owner', 'workspace.manage_billing', true),
    (new.id, 'owner', 'workspace.delete', true),
    (new.id, 'owner', 'workspace.transfer_ownership', true),
    (new.id, 'owner', 'workspace.manage_members', true),
    (new.id, 'owner', 'workspace.manage_settings', true),
    (new.id, 'owner', 'pipeline.view_all_stages', true),
    (new.id, 'owner', 'pipeline.bulk_actions', true),
    (new.id, 'owner', 'post.create', true),
    (new.id, 'owner', 'post.edit', true),
    (new.id, 'owner', 'post.approve', true),
    (new.id, 'owner', 'post.publish', true),
    (new.id, 'owner', 'brief.view_all', true),
    (new.id, 'owner', 'brief.close', true),
    (new.id, 'owner', 'asset.upload', true),
    (new.id, 'owner', 'asset.delete', true),
    (new.id, 'owner', 'insights.view_full', true),
    (new.id, 'owner', 'inbox.view', true);

  insert into public.workspace_role_permissions (workspace_id, role, capability, allowed) values
    (new.id, 'admin', 'workspace.manage_members', true),
    (new.id, 'admin', 'workspace.manage_settings', true),
    (new.id, 'admin', 'pipeline.view_all_stages', true),
    (new.id, 'admin', 'pipeline.bulk_actions', true),
    (new.id, 'admin', 'post.create', true),
    (new.id, 'admin', 'post.edit', true),
    (new.id, 'admin', 'post.approve', true),
    (new.id, 'admin', 'post.publish', true),
    (new.id, 'admin', 'brief.view_all', true),
    (new.id, 'admin', 'brief.close', true),
    (new.id, 'admin', 'asset.upload', true),
    (new.id, 'admin', 'asset.delete', true),
    (new.id, 'admin', 'insights.view_full', true),
    (new.id, 'admin', 'inbox.view', true);

  insert into public.workspace_role_permissions (workspace_id, role, capability, allowed) values
    (new.id, 'agency', 'pipeline.view_all_stages', true),
    (new.id, 'agency', 'pipeline.bulk_actions', true),
    (new.id, 'agency', 'post.create', true),
    (new.id, 'agency', 'post.edit', true),
    (new.id, 'agency', 'post.approve', true),
    (new.id, 'agency', 'post.publish', true),
    (new.id, 'agency', 'brief.view_all', true),
    (new.id, 'agency', 'brief.close', true),
    (new.id, 'agency', 'asset.upload', true),
    (new.id, 'agency', 'asset.delete', true),
    (new.id, 'agency', 'insights.view_full', true),
    (new.id, 'agency', 'inbox.view', true);

  insert into public.workspace_role_permissions (workspace_id, role, capability, allowed) values
    (new.id, 'client', 'pipeline.view_non_draft', true),
    (new.id, 'client', 'post.approve', true),
    (new.id, 'client', 'brief.view_own', true),
    (new.id, 'client', 'brief.create', true),
    (new.id, 'client', 'brief.close_own', true),
    (new.id, 'client', 'asset.upload', true),
    (new.id, 'client', 'insights.view_curated', true),
    (new.id, 'client', 'inbox.view', true);

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.rls_auto_enable()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$;

-- ============================================================================
-- Tables
-- ============================================================================

CREATE TABLE public.users (
  id uuid NOT NULL,
  display_name text NOT NULL,
  designation text,
  avatar_url text,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_pkey PRIMARY KEY (id),
  CONSTRAINT users_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT users_avatar_url_check CHECK (((avatar_url IS NULL) OR (avatar_url ~ '^https?://'::text))),
  CONSTRAINT users_designation_check CHECK (((designation IS NULL) OR ((char_length(designation) >= 1) AND (char_length(designation) <= 80)))),
  CONSTRAINT users_display_name_check CHECK (((char_length(display_name) >= 1) AND (char_length(display_name) <= 80)))
);

CREATE TABLE public.workspaces (
  id uuid NOT NULL DEFAULT uuidv7(),
  name text NOT NULL,
  owner_user_id uuid NOT NULL,
  plan_tier text NOT NULL DEFAULT 'solo'::text,
  timezone text NOT NULL,
  week_start_day smallint NOT NULL DEFAULT 1,
  stripe_customer_id text,
  stripe_subscription_id text,
  subscription_state text NOT NULL DEFAULT 'trial'::text,
  subscription_state_expires_at timestamptz,
  trial_ends_at timestamptz,
  activated_at timestamptz,
  digest_default_time time without time zone NOT NULL DEFAULT '09:00:00'::time without time zone,
  target_distributions jsonb,
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT workspaces_pkey PRIMARY KEY (id),
  CONSTRAINT workspaces_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE RESTRICT,
  CONSTRAINT workspaces_name_check CHECK (((char_length(name) >= 1) AND (char_length(name) <= 80))),
  CONSTRAINT workspaces_plan_tier_check CHECK ((plan_tier = ANY (ARRAY['solo'::text, 'studio'::text, 'agency'::text, 'enterprise'::text]))),
  CONSTRAINT workspaces_subscription_state_check CHECK ((subscription_state = ANY (ARRAY['trial'::text, 'active'::text, 'read_only'::text, 'grace'::text, 'soft_pause'::text, 'full_pause'::text, 'soft_delete'::text]))),
  CONSTRAINT workspaces_week_start_day_check CHECK (((week_start_day >= 0) AND (week_start_day <= 6)))
);

CREATE TABLE public.workspace_members (
  id uuid NOT NULL DEFAULT uuidv7(),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  invited_by uuid,
  invited_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  removed_at timestamptz,
  rejoined_at timestamptz,
  CONSTRAINT workspace_members_pkey PRIMARY KEY (id),
  CONSTRAINT workspace_members_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE,
  CONSTRAINT workspace_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT workspace_members_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT workspace_members_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'agency'::text, 'client'::text])))
);

CREATE TABLE public.workspace_settings (
  workspace_id uuid NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT workspace_settings_pkey PRIMARY KEY (workspace_id),
  CONSTRAINT workspace_settings_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE,
  CONSTRAINT workspace_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL
);

CREATE TABLE public.workspace_onboarding (
  workspace_id uuid NOT NULL,
  first_post_at timestamptz,
  first_invite_at timestamptz,
  linkedin_connected_at timestamptz,
  first_brief_at timestamptz,
  first_schedule_at timestamptz,
  dismissed_at timestamptz,
  auto_hidden_at timestamptz,
  CONSTRAINT workspace_onboarding_pkey PRIMARY KEY (workspace_id),
  CONSTRAINT workspace_onboarding_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE
);

CREATE TABLE public.workspace_role_permissions (
  workspace_id uuid NOT NULL,
  role text NOT NULL,
  capability text NOT NULL,
  allowed boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_role_permissions_pkey PRIMARY KEY (workspace_id, role, capability),
  CONSTRAINT workspace_role_permissions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE,
  CONSTRAINT workspace_role_permissions_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'agency'::text, 'client'::text])))
);

CREATE TABLE public.workspace_buckets (
  id uuid NOT NULL DEFAULT uuidv7(),
  workspace_id uuid NOT NULL,
  name text NOT NULL,
  color_hex text NOT NULL,
  "position" integer NOT NULL DEFAULT 0,
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  target_month integer NOT NULL DEFAULT 0,
  CONSTRAINT workspace_buckets_pkey PRIMARY KEY (id),
  CONSTRAINT workspace_buckets_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE,
  CONSTRAINT workspace_buckets_color_hex_check CHECK ((color_hex ~ '^#[0-9A-Fa-f]{6}$'::text)),
  CONSTRAINT workspace_buckets_target_month_check CHECK (((target_month >= 0) AND (target_month <= 100)))
);

CREATE TABLE public.groups (
  id uuid NOT NULL DEFAULT uuidv7(),
  workspace_id uuid NOT NULL,
  name text NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT groups_pkey PRIMARY KEY (id),
  CONSTRAINT groups_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE,
  CONSTRAINT groups_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT groups_name_check CHECK ((name ~ '^[A-Za-z0-9 -]{1,40}$'::text))
);

CREATE TABLE public.group_members (
  group_id uuid NOT NULL,
  user_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT group_members_pkey PRIMARY KEY (group_id, user_id),
  CONSTRAINT group_members_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON DELETE CASCADE,
  CONSTRAINT group_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT group_members_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE
);

CREATE TABLE public.briefs (
  id uuid NOT NULL DEFAULT uuidv7(),
  workspace_id uuid NOT NULL,
  title text NOT NULL,
  objective text NOT NULL,
  format_requested text,
  brand_requirements text,
  target_date date,
  reference_links jsonb,
  status text NOT NULL DEFAULT 'open'::text,
  closed_at timestamptz,
  closed_by uuid,
  created_by uuid NOT NULL,
  created_via text NOT NULL DEFAULT 'app'::text,
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT briefs_pkey PRIMARY KEY (id),
  CONSTRAINT briefs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE,
  CONSTRAINT briefs_closed_by_fkey FOREIGN KEY (closed_by) REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT briefs_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT briefs_closed_consistency CHECK ((((status = 'open'::text) AND (closed_at IS NULL) AND (closed_by IS NULL)) OR ((status = 'closed'::text) AND (closed_at IS NOT NULL) AND (closed_by IS NOT NULL)))),
  CONSTRAINT briefs_created_via_check CHECK ((created_via = ANY (ARRAY['app'::text, 'email_forward'::text]))),
  CONSTRAINT briefs_format_requested_check CHECK (((format_requested IS NULL) OR (format_requested = ANY (ARRAY['text'::text, 'single_image'::text, 'carousel'::text, 'video'::text, 'link'::text])))),
  CONSTRAINT briefs_objective_check CHECK (((char_length(objective) >= 1) AND (char_length(objective) <= 5000))),
  CONSTRAINT briefs_status_check CHECK ((status = ANY (ARRAY['open'::text, 'closed'::text]))),
  CONSTRAINT briefs_title_check CHECK (((char_length(title) >= 1) AND (char_length(title) <= 200)))
);

CREATE TABLE public.posts (
  id uuid NOT NULL DEFAULT uuidv7(),
  workspace_id uuid NOT NULL,
  title text NOT NULL,
  caption text,
  bucket_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  platform text NOT NULL,
  format text NOT NULL,
  stage text NOT NULL DEFAULT 'draft'::text,
  target_date timestamptz,
  origin text NOT NULL DEFAULT 'manual'::text,
  brief_id uuid,
  row_version bigint NOT NULL DEFAULT 1,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT posts_pkey PRIMARY KEY (id),
  CONSTRAINT posts_brief_id_fkey FOREIGN KEY (brief_id) REFERENCES public.briefs(id) ON DELETE SET NULL,
  CONSTRAINT posts_bucket_id_fkey FOREIGN KEY (bucket_id) REFERENCES public.workspace_buckets(id),
  CONSTRAINT posts_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT posts_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT posts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE,
  CONSTRAINT posts_format_check CHECK ((format = ANY (ARRAY['text'::text, 'single_image'::text, 'carousel'::text, 'video'::text, 'link'::text]))),
  CONSTRAINT posts_origin_check CHECK ((origin = ANY (ARRAY['manual'::text, 'brief'::text]))),
  CONSTRAINT posts_platform_check CHECK ((platform = ANY (ARRAY['linkedin'::text, 'x'::text, 'instagram'::text, 'facebook'::text, 'threads'::text]))),
  CONSTRAINT posts_stage_check CHECK ((stage = ANY (ARRAY['draft'::text, 'review'::text, 'approved'::text, 'parked'::text, 'rejected'::text]))),
  CONSTRAINT posts_title_check CHECK (((char_length(title) >= 1) AND (char_length(title) <= 200)))
);

CREATE TABLE public.post_versions (
  id uuid NOT NULL DEFAULT uuidv7(),
  post_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  version_number integer NOT NULL,
  snapshot jsonb NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT post_versions_pkey PRIMARY KEY (id),
  CONSTRAINT post_versions_post_id_version_number_key UNIQUE (post_id, version_number),
  CONSTRAINT post_versions_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.posts(id) ON DELETE CASCADE,
  CONSTRAINT post_versions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE,
  CONSTRAINT post_versions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL
);

CREATE TABLE public.assets (
  id uuid NOT NULL DEFAULT uuidv7(),
  workspace_id uuid NOT NULL,
  filename text NOT NULL,
  current_version_id uuid,
  folder_path text NOT NULL DEFAULT '/'::text,
  tags text[] NOT NULL DEFAULT '{}'::text[],
  uploaded_by uuid NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT assets_pkey PRIMARY KEY (id),
  CONSTRAINT assets_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT assets_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE,
  CONSTRAINT assets_filename_check CHECK (((char_length(filename) >= 1) AND (char_length(filename) <= 500)))
);

CREATE TABLE public.asset_versions (
  id uuid NOT NULL DEFAULT uuidv7(),
  asset_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  version_number integer NOT NULL,
  r2_key text NOT NULL,
  mime_type text NOT NULL,
  sha256 text NOT NULL,
  size_bytes bigint NOT NULL,
  width integer,
  height integer,
  duration_ms integer,
  uploaded_by uuid NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT asset_versions_pkey PRIMARY KEY (id),
  CONSTRAINT asset_versions_asset_id_version_number_key UNIQUE (asset_id, version_number),
  CONSTRAINT asset_versions_r2_key_key UNIQUE (r2_key),
  CONSTRAINT asset_versions_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.assets(id) ON DELETE CASCADE,
  CONSTRAINT asset_versions_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT asset_versions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE,
  CONSTRAINT asset_versions_duration_ms_check CHECK (((duration_ms IS NULL) OR (duration_ms > 0))),
  CONSTRAINT asset_versions_height_check CHECK (((height IS NULL) OR (height > 0))),
  CONSTRAINT asset_versions_sha256_check CHECK ((sha256 ~ '^[a-f0-9]{64}$'::text)),
  CONSTRAINT asset_versions_size_bytes_check CHECK ((size_bytes > 0)),
  CONSTRAINT asset_versions_width_check CHECK (((width IS NULL) OR (width > 0)))
);

-- Deferred FK closes the assets <-> asset_versions cycle (matches live: ON DELETE NO ACTION).
ALTER TABLE public.assets
  ADD CONSTRAINT assets_current_version_id_fkey FOREIGN KEY (current_version_id) REFERENCES public.asset_versions(id);

CREATE TABLE public.asset_attachments (
  id uuid NOT NULL DEFAULT uuidv7(),
  asset_id uuid NOT NULL,
  asset_version_id uuid NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  workspace_id uuid NOT NULL,
  "position" integer NOT NULL DEFAULT 0,
  attached_by uuid NOT NULL,
  attached_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT asset_attachments_pkey PRIMARY KEY (id),
  CONSTRAINT asset_attachments_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.assets(id),
  CONSTRAINT asset_attachments_asset_version_id_fkey FOREIGN KEY (asset_version_id) REFERENCES public.asset_versions(id),
  CONSTRAINT asset_attachments_attached_by_fkey FOREIGN KEY (attached_by) REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT asset_attachments_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE,
  CONSTRAINT asset_attachments_entity_id_check CHECK (((char_length(entity_id) >= 1) AND (char_length(entity_id) <= 200))),
  CONSTRAINT asset_attachments_entity_type_check CHECK ((entity_type = ANY (ARRAY['post'::text, 'comment'::text, 'chat_message'::text, 'brief'::text])))
);

CREATE TABLE public.comments (
  id uuid NOT NULL DEFAULT uuidv7(),
  workspace_id uuid NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  parent_comment_id uuid,
  author_user_id uuid NOT NULL,
  body text NOT NULL,
  mentions jsonb,
  attachment_asset_ids uuid[],
  is_decision boolean NOT NULL DEFAULT false,
  edited_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT comments_pkey PRIMARY KEY (id),
  CONSTRAINT comments_author_user_id_fkey FOREIGN KEY (author_user_id) REFERENCES auth.users(id),
  CONSTRAINT comments_parent_comment_id_fkey FOREIGN KEY (parent_comment_id) REFERENCES public.comments(id) ON DELETE CASCADE,
  CONSTRAINT comments_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE,
  CONSTRAINT comments_body_check CHECK (((char_length(body) >= 1) AND (char_length(body) <= 10000))),
  CONSTRAINT comments_entity_type_check CHECK ((entity_type = ANY (ARRAY['post'::text, 'brief'::text, 'plan_cell'::text])))
);

CREATE TABLE public.comment_reactions (
  comment_id uuid NOT NULL,
  user_id uuid NOT NULL,
  emoji text NOT NULL,
  workspace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT comment_reactions_pkey PRIMARY KEY (comment_id, user_id, emoji),
  CONSTRAINT comment_reactions_comment_id_fkey FOREIGN KEY (comment_id) REFERENCES public.comments(id) ON DELETE CASCADE,
  CONSTRAINT comment_reactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT comment_reactions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE,
  CONSTRAINT comment_reactions_emoji_check CHECK (((char_length(emoji) >= 1) AND (char_length(emoji) <= 32)))
);

CREATE TABLE public.post_annotations (
  id uuid NOT NULL DEFAULT uuidv7(),
  post_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  post_version_id uuid NOT NULL,
  kind text NOT NULL,
  caption_start integer,
  caption_end integer,
  asset_attachment_id uuid,
  image_x real,
  image_y real,
  comment_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT post_annotations_pkey PRIMARY KEY (id),
  CONSTRAINT post_annotations_asset_attachment_id_fkey FOREIGN KEY (asset_attachment_id) REFERENCES public.asset_attachments(id) ON DELETE SET NULL,
  CONSTRAINT post_annotations_comment_id_fkey FOREIGN KEY (comment_id) REFERENCES public.comments(id) ON DELETE CASCADE,
  CONSTRAINT post_annotations_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.posts(id) ON DELETE CASCADE,
  CONSTRAINT post_annotations_post_version_id_fkey FOREIGN KEY (post_version_id) REFERENCES public.post_versions(id) ON DELETE CASCADE,
  CONSTRAINT post_annotations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE,
  CONSTRAINT post_annotations_caption_fields CHECK ((((kind = 'caption_span'::text) AND (caption_start IS NOT NULL) AND (caption_end IS NOT NULL) AND (caption_start < caption_end) AND (image_x IS NULL) AND (image_y IS NULL) AND (asset_attachment_id IS NULL)) OR ((kind = 'image_pin'::text) AND (image_x IS NOT NULL) AND (image_y IS NOT NULL) AND (asset_attachment_id IS NOT NULL) AND (caption_start IS NULL) AND (caption_end IS NULL)))),
  CONSTRAINT post_annotations_image_x_check CHECK (((image_x IS NULL) OR ((image_x >= (0)::double precision) AND (image_x <= (1)::double precision)))),
  CONSTRAINT post_annotations_image_y_check CHECK (((image_y IS NULL) OR ((image_y >= (0)::double precision) AND (image_y <= (1)::double precision)))),
  CONSTRAINT post_annotations_kind_check CHECK ((kind = ANY (ARRAY['caption_span'::text, 'image_pin'::text])))
);

CREATE TABLE public.chat_channels (
  channel_id text NOT NULL,
  workspace_id uuid NOT NULL,
  channel_type text NOT NULL,
  entity_id uuid,
  dm_user_a uuid,
  dm_user_b uuid,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_channels_pkey PRIMARY KEY (channel_id),
  CONSTRAINT chat_channels_dm_user_a_fkey FOREIGN KEY (dm_user_a) REFERENCES auth.users(id),
  CONSTRAINT chat_channels_dm_user_b_fkey FOREIGN KEY (dm_user_b) REFERENCES auth.users(id),
  CONSTRAINT chat_channels_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE,
  CONSTRAINT chat_channels_channel_id_check CHECK ((channel_id ~ '^(dm|group|plan)__[a-f0-9-]{36}__.+$'::text)),
  CONSTRAINT chat_channels_channel_type_check CHECK ((channel_type = ANY (ARRAY['dm'::text, 'group'::text, 'plan_period'::text]))),
  CONSTRAINT chat_channels_shape CHECK ((((channel_type = 'dm'::text) AND (entity_id IS NULL) AND (dm_user_a IS NOT NULL) AND (dm_user_b IS NOT NULL) AND (dm_user_a < dm_user_b)) OR ((channel_type = 'group'::text) AND (entity_id IS NOT NULL) AND (dm_user_a IS NULL) AND (dm_user_b IS NULL)) OR ((channel_type = 'plan_period'::text) AND (entity_id IS NOT NULL) AND (dm_user_a IS NULL) AND (dm_user_b IS NULL))))
);

CREATE TABLE public.chat_messages (
  id text NOT NULL,
  channel_id text NOT NULL,
  workspace_id uuid NOT NULL,
  sender_user_id uuid,
  body text,
  mentions jsonb,
  attachment_asset_ids uuid[],
  agora_event_id text NOT NULL,
  created_at timestamptz NOT NULL,
  edited_at timestamptz,
  deleted_at timestamptz,
  CONSTRAINT chat_messages_pkey PRIMARY KEY (id, created_at),
  CONSTRAINT chat_messages_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.chat_channels(channel_id) ON DELETE CASCADE,
  CONSTRAINT chat_messages_sender_user_id_fkey FOREIGN KEY (sender_user_id) REFERENCES auth.users(id),
  CONSTRAINT chat_messages_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE
) PARTITION BY RANGE (created_at);

CREATE TABLE public.chat_messages_2026_05 PARTITION OF public.chat_messages
  FOR VALUES FROM ('2026-05-01 00:00:00+00') TO ('2026-06-01 00:00:00+00');
CREATE TABLE public.chat_messages_2026_06 PARTITION OF public.chat_messages
  FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00');
CREATE TABLE public.chat_messages_2026_07 PARTITION OF public.chat_messages
  FOR VALUES FROM ('2026-07-01 00:00:00+00') TO ('2026-08-01 00:00:00+00');

CREATE TABLE public.email_threads (
  id uuid NOT NULL DEFAULT uuidv7(),
  workspace_id uuid NOT NULL,
  root_type text NOT NULL,
  root_id uuid NOT NULL,
  message_id text NOT NULL,
  subject text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_sent_at timestamptz,
  CONSTRAINT email_threads_pkey PRIMARY KEY (id),
  CONSTRAINT email_threads_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE,
  CONSTRAINT email_threads_message_id_check CHECK ((message_id ~ '^<(brief|post)-[a-f0-9-]{36}@srtd\.io>$'::text)),
  CONSTRAINT email_threads_root_type_check CHECK ((root_type = ANY (ARRAY['brief'::text, 'post'::text]))),
  CONSTRAINT email_threads_subject_check CHECK (((char_length(subject) >= 1) AND (char_length(subject) <= 998)))
);

CREATE TABLE public.delivery_attempts (
  id uuid NOT NULL DEFAULT uuidv7(),
  workspace_id uuid,
  user_id uuid,
  channel text NOT NULL,
  template_key text NOT NULL,
  provider text NOT NULL,
  provider_message_id text,
  status text NOT NULL DEFAULT 'queued'::text,
  error text,
  sent_at timestamptz,
  delivered_at timestamptz,
  bounced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  email_thread_id uuid,
  CONSTRAINT delivery_attempts_pkey PRIMARY KEY (id),
  CONSTRAINT delivery_attempts_email_thread_id_fkey FOREIGN KEY (email_thread_id) REFERENCES public.email_threads(id) ON DELETE SET NULL,
  CONSTRAINT delivery_attempts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT delivery_attempts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE SET NULL,
  CONSTRAINT delivery_attempts_channel_check CHECK ((channel = ANY (ARRAY['email'::text, 'push'::text]))),
  CONSTRAINT delivery_attempts_provider_check CHECK ((provider = ANY (ARRAY['resend'::text, 'fcm'::text, 'apns'::text, 'web_push'::text]))),
  CONSTRAINT delivery_attempts_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'sent'::text, 'delivered'::text, 'bounced'::text, 'complained'::text, 'failed'::text]))),
  CONSTRAINT delivery_attempts_template_key_check CHECK (((char_length(template_key) >= 1) AND (char_length(template_key) <= 100)))
);

CREATE TABLE public.webhook_events (
  id uuid NOT NULL DEFAULT uuidv7(),
  source text NOT NULL,
  source_event_id text NOT NULL,
  event_type text NOT NULL,
  workspace_id uuid,
  signature_verified boolean NOT NULL,
  raw_payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT webhook_events_pkey PRIMARY KEY (id),
  CONSTRAINT webhook_events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE SET NULL,
  CONSTRAINT webhook_events_event_type_check CHECK (((char_length(event_type) >= 1) AND (char_length(event_type) <= 100))),
  CONSTRAINT webhook_events_payload_size CHECK ((octet_length((raw_payload)::text) <= 1048576)),
  CONSTRAINT webhook_events_source_check CHECK ((source = ANY (ARRAY['stripe'::text, 'resend'::text, 'linkedin'::text]))),
  CONSTRAINT webhook_events_source_event_id_check CHECK (((char_length(source_event_id) >= 1) AND (char_length(source_event_id) <= 200)))
);

CREATE TABLE public.webhook_processing_attempts (
  id uuid NOT NULL DEFAULT uuidv7(),
  webhook_event_id uuid NOT NULL,
  attempt_number integer NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  outcome text,
  error text,
  trace_id uuid NOT NULL,
  CONSTRAINT webhook_processing_attempts_pkey PRIMARY KEY (id),
  CONSTRAINT webhook_processing_attempts_webhook_event_id_fkey FOREIGN KEY (webhook_event_id) REFERENCES public.webhook_events(id) ON DELETE CASCADE,
  CONSTRAINT webhook_processing_attempts_attempt_number_check CHECK ((attempt_number > 0)),
  CONSTRAINT webhook_processing_attempts_outcome_check CHECK (((outcome IS NULL) OR (outcome = ANY (ARRAY['success'::text, 'failure'::text, 'skipped'::text]))))
);

CREATE TABLE public.feature_flags (
  id uuid NOT NULL DEFAULT uuidv7(),
  workspace_id uuid,
  flag_name text NOT NULL,
  category text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  rollout_percentage smallint NOT NULL DEFAULT 0,
  tier_min text,
  reason text,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT feature_flags_pkey PRIMARY KEY (id),
  CONSTRAINT feature_flags_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT feature_flags_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE,
  CONSTRAINT feature_flags_category_check CHECK ((category = ANY (ARRAY['killswitch'::text, 'rollout'::text, 'experiment'::text, 'tier_gated'::text]))),
  CONSTRAINT feature_flags_flag_name_check CHECK ((flag_name ~ '^[a-z][a-z0-9_]{0,99}$'::text)),
  CONSTRAINT feature_flags_rollout_percentage_check CHECK ((rollout_percentage = ANY (ARRAY[0, 10, 25, 50, 100]))),
  CONSTRAINT feature_flags_tier_min_check CHECK (((tier_min IS NULL) OR (tier_min = ANY (ARRAY['solo'::text, 'studio'::text, 'agency'::text, 'enterprise'::text]))))
);

CREATE TABLE public.inbox_entries (
  id uuid NOT NULL DEFAULT uuidv7(),
  user_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  event_type text NOT NULL,
  entity_type text,
  entity_id text,
  scope text NOT NULL,
  scope_key text,
  tier text NOT NULL DEFAULT 'active'::text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at timestamptz,
  snoozed_until timestamptz,
  email_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT inbox_entries_pkey PRIMARY KEY (id, created_at),
  CONSTRAINT inbox_entries_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT inbox_entries_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE,
  CONSTRAINT inbox_entries_entity_id_check CHECK (((entity_id IS NULL) OR ((char_length(entity_id) >= 1) AND (char_length(entity_id) <= 200)))),
  CONSTRAINT inbox_entries_entity_type_check CHECK (((entity_type IS NULL) OR (entity_type = ANY (ARRAY['post'::text, 'brief'::text, 'plan_cell'::text, 'plan_period'::text, 'chat_channel'::text, 'workspace'::text])))),
  CONSTRAINT inbox_entries_event_type_check CHECK ((event_type = ANY (ARRAY['comment'::text, 'mention'::text, 'stage_change'::text, 'decision_marked'::text, 'brief_created'::text, 'brief_closed'::text, 'asset_uploaded'::text, 'asset_version_added'::text, 'invite'::text, 'trial_warning'::text, 'billing_failure'::text, 'system'::text]))),
  CONSTRAINT inbox_entries_scope_check CHECK ((scope = ANY (ARRAY['everything'::text, 'posts'::text, 'briefs'::text, 'people'::text, 'groups'::text, 'clients'::text]))),
  CONSTRAINT inbox_entries_tier_check CHECK ((tier = ANY (ARRAY['urgent'::text, 'active'::text, 'ambient'::text])))
) PARTITION BY RANGE (created_at);

CREATE TABLE public.inbox_entries_2026_05 PARTITION OF public.inbox_entries
  FOR VALUES FROM ('2026-05-01 00:00:00+00') TO ('2026-06-01 00:00:00+00');
CREATE TABLE public.inbox_entries_2026_06 PARTITION OF public.inbox_entries
  FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00');
CREATE TABLE public.inbox_entries_2026_07 PARTITION OF public.inbox_entries
  FOR VALUES FROM ('2026-07-01 00:00:00+00') TO ('2026-08-01 00:00:00+00');

CREATE TABLE public.audit_log (
  id uuid NOT NULL DEFAULT uuidv7(),
  workspace_id uuid,
  actor_user_id uuid,
  on_behalf_of uuid,
  impersonation_session_id uuid,
  action text NOT NULL,
  entity_type text,
  entity_id text,
  payload jsonb,
  outcome text NOT NULL,
  error_code text,
  trace_id uuid NOT NULL,
  ip_subnet inet,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_log_pkey PRIMARY KEY (id, created_at),
  CONSTRAINT audit_log_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES auth.users(id),
  CONSTRAINT audit_log_on_behalf_of_fkey FOREIGN KEY (on_behalf_of) REFERENCES auth.users(id),
  CONSTRAINT audit_log_outcome_check CHECK ((outcome = ANY (ARRAY['success'::text, 'failure'::text]))),
  CONSTRAINT audit_log_payload_no_secrets CHECK (((payload IS NULL) OR (((payload)::text !~* 'bearer\s+[a-z0-9._-]+'::text) AND ((payload)::text !~* 'AKIA[0-9A-Z]{16}'::text) AND ((payload)::text !~* 'sk_live_[a-z0-9]+'::text) AND ((payload)::text !~* 'eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+'::text)))),
  CONSTRAINT audit_log_payload_size CHECK (((payload IS NULL) OR (octet_length((payload)::text) <= 65536)))
) PARTITION BY RANGE (created_at);

CREATE TABLE public.audit_log_2026_05 PARTITION OF public.audit_log
  FOR VALUES FROM ('2026-05-01 00:00:00+00') TO ('2026-06-01 00:00:00+00');
CREATE TABLE public.audit_log_2026_06 PARTITION OF public.audit_log
  FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00');
CREATE TABLE public.audit_log_2026_07 PARTITION OF public.audit_log
  FOR VALUES FROM ('2026-07-01 00:00:00+00') TO ('2026-08-01 00:00:00+00');

CREATE TABLE public.session_devices (
  id uuid NOT NULL DEFAULT uuidv7(),
  user_id uuid NOT NULL,
  fingerprint_hash text NOT NULL,
  user_agent text,
  ip_subnet inet,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT session_devices_pkey PRIMARY KEY (id),
  CONSTRAINT session_devices_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT session_devices_fingerprint_hash_check CHECK ((fingerprint_hash ~ '^[a-f0-9]{64}$'::text))
);

CREATE TABLE public.platform_operators (
  user_id uuid NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by uuid,
  revoked_at timestamptz,
  passkey_credential_id text,
  CONSTRAINT platform_operators_pkey PRIMARY KEY (user_id),
  CONSTRAINT platform_operators_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT platform_operators_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);

CREATE TABLE public.cockpit_access_log (
  id uuid NOT NULL DEFAULT uuidv7(),
  operator_user_id uuid NOT NULL,
  route text NOT NULL,
  workspace_id uuid,
  session_id uuid NOT NULL,
  accessed_at timestamptz NOT NULL DEFAULT now(),
  trace_id uuid NOT NULL,
  CONSTRAINT cockpit_access_log_pkey PRIMARY KEY (id),
  CONSTRAINT cockpit_access_log_operator_user_id_fkey FOREIGN KEY (operator_user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT cockpit_access_log_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE SET NULL,
  CONSTRAINT cockpit_access_log_route_check CHECK (((char_length(route) >= 1) AND (char_length(route) <= 500)))
);

CREATE TABLE public.cockpit_procedure_allowlist (
  procedure_name text NOT NULL,
  description text NOT NULL,
  risk_tier text NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  added_by uuid NOT NULL,
  CONSTRAINT cockpit_procedure_allowlist_pkey PRIMARY KEY (procedure_name),
  CONSTRAINT cockpit_procedure_allowlist_added_by_fkey FOREIGN KEY (added_by) REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT cockpit_procedure_allowlist_description_check CHECK (((char_length(description) >= 1) AND (char_length(description) <= 1000))),
  CONSTRAINT cockpit_procedure_allowlist_procedure_name_check CHECK (((char_length(procedure_name) >= 1) AND (char_length(procedure_name) <= 200))),
  CONSTRAINT cockpit_procedure_allowlist_risk_tier_check CHECK ((risk_tier = ANY (ARRAY['tap'::text, 'medium'::text, 'nuclear'::text])))
);

CREATE TABLE public.intent_ledger (
  id uuid NOT NULL DEFAULT uuidv7(),
  operator_user_id uuid NOT NULL,
  action text NOT NULL,
  target_type text,
  target_id text,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending'::text,
  reason_category text,
  reason_text text,
  ticket_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + '01:00:00'::interval),
  trace_id uuid NOT NULL,
  CONSTRAINT intent_ledger_pkey PRIMARY KEY (id),
  CONSTRAINT intent_ledger_operator_user_id_fkey FOREIGN KEY (operator_user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT intent_ledger_action_check CHECK (((char_length(action) >= 1) AND (char_length(action) <= 100))),
  CONSTRAINT intent_ledger_committed_consistency CHECK ((((status = 'committed'::text) AND (committed_at IS NOT NULL)) OR ((status <> 'committed'::text) AND (committed_at IS NULL)))),
  CONSTRAINT intent_ledger_reason_text_check CHECK (((reason_text IS NULL) OR (char_length(reason_text) >= 10))),
  CONSTRAINT intent_ledger_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'committed'::text, 'failed'::text, 'expired'::text]))),
  CONSTRAINT intent_ledger_target_id_check CHECK (((target_id IS NULL) OR ((char_length(target_id) >= 1) AND (char_length(target_id) <= 200)))),
  CONSTRAINT intent_ledger_target_type_check CHECK (((target_type IS NULL) OR (target_type = ANY (ARRAY['workspace'::text, 'user'::text, 'flag'::text, 'deploy'::text, 'share_token'::text])))),
  CONSTRAINT intent_ledger_ticket_id_check CHECK (((ticket_id IS NULL) OR ((char_length(ticket_id) >= 1) AND (char_length(ticket_id) <= 100))))
);

CREATE TABLE public.pending_flows (
  id uuid NOT NULL DEFAULT uuidv7(),
  operator_user_id uuid NOT NULL,
  flow_type text NOT NULL,
  external_system text NOT NULL,
  external_ref text,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'open'::text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + '01:00:00'::interval),
  CONSTRAINT pending_flows_pkey PRIMARY KEY (id),
  CONSTRAINT pending_flows_operator_user_id_fkey FOREIGN KEY (operator_user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT pending_flows_external_ref_check CHECK (((external_ref IS NULL) OR ((char_length(external_ref) >= 1) AND (char_length(external_ref) <= 500)))),
  CONSTRAINT pending_flows_external_system_check CHECK ((external_system = ANY (ARRAY['stripe'::text, 'sentry'::text, 'cloudflare'::text, 'github'::text, 'resend'::text]))),
  CONSTRAINT pending_flows_flow_type_check CHECK ((flow_type = ANY (ARRAY['billing_override'::text, 'sentry_inspect'::text, 'cf_purge'::text, 'gh_diff'::text]))),
  CONSTRAINT pending_flows_resolved_consistency CHECK ((((status = ANY (ARRAY['resolved'::text, 'discarded'::text])) AND (resolved_at IS NOT NULL)) OR ((status = ANY (ARRAY['open'::text, 'expired'::text])) AND (resolved_at IS NULL)))),
  CONSTRAINT pending_flows_status_check CHECK ((status = ANY (ARRAY['open'::text, 'resolved'::text, 'discarded'::text, 'expired'::text])))
);

-- ============================================================================
-- Functions that depend on tables defined above
-- ============================================================================

CREATE OR REPLACE FUNCTION public.has_capability(p_capability text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(
    (
      select wrp.allowed
      from public.workspace_role_permissions wrp
      join public.workspace_members wm
        on wm.workspace_id = wrp.workspace_id
       and wm.role = wrp.role
      where wm.user_id = auth.uid()
        and wm.workspace_id = public.workspace_id()
        and wm.active = true
        and wrp.capability = p_capability
      limit 1
    ),
    false
  );
$function$;

CREATE OR REPLACE FUNCTION public.audit_log_write(p_action text, p_outcome text, p_trace_id uuid, p_workspace_id uuid DEFAULT NULL::uuid, p_entity_type text DEFAULT NULL::text, p_entity_id text DEFAULT NULL::text, p_payload jsonb DEFAULT NULL::jsonb, p_error_code text DEFAULT NULL::text, p_on_behalf_of uuid DEFAULT NULL::uuid, p_impersonation_session_id uuid DEFAULT NULL::uuid, p_ip_subnet inet DEFAULT NULL::inet)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_id uuid;
begin
  insert into public.audit_log (
    workspace_id, actor_user_id, on_behalf_of, impersonation_session_id,
    action, entity_type, entity_id, payload, outcome, error_code,
    trace_id, ip_subnet
  ) values (
    p_workspace_id, auth.uid(), p_on_behalf_of, p_impersonation_session_id,
    p_action, p_entity_type, p_entity_id, p_payload, p_outcome, p_error_code,
    p_trace_id, p_ip_subnet
  )
  returning id into v_id;
  return v_id;
end;
$function$;

-- ============================================================================
-- Indexes
-- ============================================================================
CREATE INDEX asset_attachments_asset_idx ON public.asset_attachments USING btree (asset_id) WHERE (deleted_at IS NULL);
CREATE INDEX asset_attachments_asset_version_idx ON public.asset_attachments USING btree (asset_version_id) WHERE (deleted_at IS NULL);
CREATE INDEX asset_attachments_entity_idx ON public.asset_attachments USING btree (entity_type, entity_id, "position") WHERE (deleted_at IS NULL);
CREATE INDEX asset_attachments_workspace_idx ON public.asset_attachments USING btree (workspace_id) WHERE (deleted_at IS NULL);

CREATE INDEX asset_versions_asset_idx ON public.asset_versions USING btree (asset_id, version_number DESC);
CREATE INDEX asset_versions_sha256_idx ON public.asset_versions USING btree (workspace_id, sha256);

CREATE INDEX assets_filename_fts_idx ON public.assets USING gin (to_tsvector('english'::regconfig, filename)) WHERE (deleted_at IS NULL);
CREATE INDEX assets_folder_idx ON public.assets USING btree (workspace_id, folder_path) WHERE (deleted_at IS NULL);
CREATE INDEX assets_tags_idx ON public.assets USING gin (tags) WHERE (deleted_at IS NULL);
CREATE INDEX assets_workspace_idx ON public.assets USING btree (workspace_id, uploaded_at DESC) WHERE (deleted_at IS NULL);

CREATE INDEX audit_log_actor_created_idx ON public.audit_log USING btree (actor_user_id, created_at DESC) WHERE (actor_user_id IS NOT NULL);
CREATE INDEX audit_log_trace_id_idx ON public.audit_log USING btree (trace_id);
CREATE INDEX audit_log_workspace_created_idx ON public.audit_log USING btree (workspace_id, created_at DESC);

CREATE INDEX briefs_created_by_idx ON public.briefs USING btree (workspace_id, created_by, created_at DESC) WHERE (deleted_at IS NULL);
CREATE INDEX briefs_target_date_idx ON public.briefs USING btree (workspace_id, target_date) WHERE ((deleted_at IS NULL) AND (target_date IS NOT NULL));
CREATE INDEX briefs_title_fts_idx ON public.briefs USING gin (to_tsvector('english'::regconfig, ((title || ' '::text) || objective))) WHERE (deleted_at IS NULL);
CREATE INDEX briefs_workspace_status_idx ON public.briefs USING btree (workspace_id, status, created_at DESC) WHERE (deleted_at IS NULL);

CREATE INDEX chat_channels_dm_idx ON public.chat_channels USING btree (workspace_id, dm_user_a, dm_user_b) WHERE (channel_type = 'dm'::text);
CREATE INDEX chat_channels_entity_idx ON public.chat_channels USING btree (entity_id) WHERE (entity_id IS NOT NULL);
CREATE INDEX chat_channels_sync_cursor_idx ON public.chat_channels USING btree (last_synced_at NULLS FIRST);
CREATE INDEX chat_channels_workspace_idx ON public.chat_channels USING btree (workspace_id, channel_type);

CREATE UNIQUE INDEX chat_messages_agora_event_unique ON public.chat_messages USING btree (agora_event_id, created_at);
CREATE INDEX chat_messages_channel_idx ON public.chat_messages USING btree (channel_id, created_at DESC);
CREATE INDEX chat_messages_sender_idx ON public.chat_messages USING btree (sender_user_id, created_at DESC) WHERE (sender_user_id IS NOT NULL);
CREATE INDEX chat_messages_workspace_idx ON public.chat_messages USING btree (workspace_id, created_at DESC);

CREATE INDEX cockpit_access_log_operator_idx ON public.cockpit_access_log USING btree (operator_user_id, accessed_at DESC);
CREATE INDEX cockpit_access_log_session_idx ON public.cockpit_access_log USING btree (session_id, accessed_at);
CREATE INDEX cockpit_access_log_trace_idx ON public.cockpit_access_log USING btree (trace_id);
CREATE INDEX cockpit_access_log_workspace_idx ON public.cockpit_access_log USING btree (workspace_id, accessed_at DESC) WHERE (workspace_id IS NOT NULL);

CREATE INDEX comment_reactions_comment_idx ON public.comment_reactions USING btree (comment_id);

CREATE INDEX comments_author_idx ON public.comments USING btree (workspace_id, author_user_id, created_at DESC) WHERE (deleted_at IS NULL);
CREATE INDEX comments_body_fts_idx ON public.comments USING gin (to_tsvector('english'::regconfig, body)) WHERE (deleted_at IS NULL);
CREATE INDEX comments_decision_idx ON public.comments USING btree (workspace_id, entity_type, entity_id) WHERE ((is_decision = true) AND (deleted_at IS NULL));
CREATE INDEX comments_entity_idx ON public.comments USING btree (workspace_id, entity_type, entity_id, created_at DESC) WHERE (deleted_at IS NULL);
CREATE INDEX comments_parent_idx ON public.comments USING btree (parent_comment_id) WHERE ((parent_comment_id IS NOT NULL) AND (deleted_at IS NULL));

CREATE INDEX delivery_attempts_provider_msg_idx ON public.delivery_attempts USING btree (provider, provider_message_id) WHERE (provider_message_id IS NOT NULL);
CREATE INDEX delivery_attempts_status_idx ON public.delivery_attempts USING btree (status, created_at DESC);
CREATE INDEX delivery_attempts_thread_idx ON public.delivery_attempts USING btree (email_thread_id, created_at DESC) WHERE (email_thread_id IS NOT NULL);
CREATE INDEX delivery_attempts_user_idx ON public.delivery_attempts USING btree (user_id, created_at DESC) WHERE (user_id IS NOT NULL);
CREATE INDEX delivery_attempts_workspace_idx ON public.delivery_attempts USING btree (workspace_id, created_at DESC) WHERE (workspace_id IS NOT NULL);

CREATE UNIQUE INDEX email_threads_message_id_unique ON public.email_threads USING btree (message_id);
CREATE UNIQUE INDEX email_threads_root_unique ON public.email_threads USING btree (workspace_id, root_type, root_id);
CREATE INDEX email_threads_workspace_idx ON public.email_threads USING btree (workspace_id, last_sent_at DESC NULLS LAST);

CREATE INDEX feature_flags_category_idx ON public.feature_flags USING btree (category, enabled);
CREATE INDEX feature_flags_global_idx ON public.feature_flags USING btree (flag_name) WHERE (workspace_id IS NULL);
CREATE UNIQUE INDEX feature_flags_unique ON public.feature_flags USING btree (COALESCE((workspace_id)::text, 'GLOBAL'::text), flag_name);
CREATE INDEX feature_flags_workspace_idx ON public.feature_flags USING btree (workspace_id, flag_name) WHERE (workspace_id IS NOT NULL);

CREATE INDEX group_members_user_idx ON public.group_members USING btree (user_id, workspace_id);
CREATE INDEX group_members_workspace_idx ON public.group_members USING btree (workspace_id);

CREATE UNIQUE INDEX groups_name_unique ON public.groups USING btree (workspace_id, lower(name)) WHERE (deleted_at IS NULL);
CREATE INDEX groups_workspace_idx ON public.groups USING btree (workspace_id, created_at DESC) WHERE (deleted_at IS NULL);

CREATE INDEX inbox_entries_email_dedupe_idx ON public.inbox_entries USING btree (user_id, email_sent_at) WHERE ((email_sent_at IS NULL) AND (deleted_at IS NULL));
CREATE INDEX inbox_entries_entity_idx ON public.inbox_entries USING btree (entity_type, entity_id, created_at DESC) WHERE ((entity_id IS NOT NULL) AND (deleted_at IS NULL));
CREATE INDEX inbox_entries_snoozed_idx ON public.inbox_entries USING btree (user_id, snoozed_until) WHERE ((snoozed_until IS NOT NULL) AND (deleted_at IS NULL));
CREATE INDEX inbox_entries_unread_idx ON public.inbox_entries USING btree (user_id, read_at, created_at DESC) WHERE (deleted_at IS NULL);
CREATE INDEX inbox_entries_user_scope_idx ON public.inbox_entries USING btree (user_id, scope, created_at DESC) WHERE (deleted_at IS NULL);
CREATE INDEX inbox_entries_workspace_idx ON public.inbox_entries USING btree (workspace_id, created_at DESC) WHERE (deleted_at IS NULL);

CREATE INDEX intent_ledger_operator_status_idx ON public.intent_ledger USING btree (operator_user_id, status, created_at DESC);
CREATE INDEX intent_ledger_pending_expiry_idx ON public.intent_ledger USING btree (expires_at) WHERE (status = 'pending'::text);
CREATE INDEX intent_ledger_target_idx ON public.intent_ledger USING btree (target_type, target_id, created_at DESC) WHERE (target_id IS NOT NULL);
CREATE INDEX intent_ledger_trace_idx ON public.intent_ledger USING btree (trace_id);

CREATE INDEX pending_flows_external_idx ON public.pending_flows USING btree (external_system, external_ref) WHERE (external_ref IS NOT NULL);
CREATE INDEX pending_flows_open_expiry_idx ON public.pending_flows USING btree (expires_at) WHERE (status = 'open'::text);
CREATE INDEX pending_flows_operator_status_idx ON public.pending_flows USING btree (operator_user_id, status, created_at DESC);

CREATE INDEX post_annotations_comment_idx ON public.post_annotations USING btree (comment_id);
CREATE INDEX post_annotations_post_version_idx ON public.post_annotations USING btree (post_version_id);

CREATE INDEX post_versions_post_idx ON public.post_versions USING btree (post_id, version_number DESC);

CREATE INDEX posts_brief_idx ON public.posts USING btree (brief_id) WHERE ((brief_id IS NOT NULL) AND (deleted_at IS NULL));
CREATE INDEX posts_owner_idx ON public.posts USING btree (workspace_id, owner_user_id) WHERE (deleted_at IS NULL);
CREATE INDEX posts_workspace_stage_idx ON public.posts USING btree (workspace_id, stage, created_at DESC) WHERE (deleted_at IS NULL);
CREATE INDEX posts_workspace_target_date_idx ON public.posts USING btree (workspace_id, target_date) WHERE ((deleted_at IS NULL) AND (target_date IS NOT NULL));

CREATE INDEX session_devices_fingerprint_idx ON public.session_devices USING btree (user_id, fingerprint_hash) WHERE (revoked_at IS NULL);
CREATE INDEX session_devices_user_id_idx ON public.session_devices USING btree (user_id) WHERE (revoked_at IS NULL);

CREATE INDEX users_deleted_at_idx ON public.users USING btree (deleted_at) WHERE (deleted_at IS NOT NULL);

CREATE INDEX webhook_events_received_idx ON public.webhook_events USING btree (source, received_at DESC);
CREATE UNIQUE INDEX webhook_events_source_unique ON public.webhook_events USING btree (source, source_event_id);
CREATE INDEX webhook_events_unverified_idx ON public.webhook_events USING btree (source, received_at DESC) WHERE (signature_verified = false);
CREATE INDEX webhook_events_workspace_idx ON public.webhook_events USING btree (workspace_id, received_at DESC) WHERE (workspace_id IS NOT NULL);

CREATE INDEX webhook_processing_attempts_event_idx ON public.webhook_processing_attempts USING btree (webhook_event_id, attempt_number DESC);
CREATE INDEX webhook_processing_attempts_pending_idx ON public.webhook_processing_attempts USING btree (started_at) WHERE (finished_at IS NULL);
CREATE INDEX webhook_processing_attempts_trace_idx ON public.webhook_processing_attempts USING btree (trace_id);

CREATE UNIQUE INDEX workspace_buckets_name_unique ON public.workspace_buckets USING btree (workspace_id, lower(name)) WHERE (archived = false);
CREATE INDEX workspace_buckets_workspace_idx ON public.workspace_buckets USING btree (workspace_id, "position") WHERE (archived = false);

CREATE UNIQUE INDEX workspace_members_active_uq ON public.workspace_members USING btree (workspace_id, user_id) WHERE (active = true);

CREATE INDEX workspace_role_permissions_lookup_idx ON public.workspace_role_permissions USING btree (workspace_id, role) WHERE (allowed = true);

-- ============================================================================
-- Triggers
-- ============================================================================
CREATE TRIGGER users_create_profile_trg AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION users_create_profile_on_signup();
CREATE TRIGGER users_updated_at_trg BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION users_set_updated_at();
CREATE TRIGGER briefs_row_version_check BEFORE UPDATE ON public.briefs FOR EACH ROW WHEN (((old.row_version IS DISTINCT FROM new.row_version) OR (old.* IS DISTINCT FROM new.*))) EXECUTE FUNCTION briefs_enforce_row_version();
CREATE TRIGGER posts_row_version_check BEFORE UPDATE ON public.posts FOR EACH ROW WHEN (((old.row_version IS DISTINCT FROM new.row_version) OR (old.* IS DISTINCT FROM new.*))) EXECUTE FUNCTION posts_enforce_row_version();
CREATE TRIGGER workspaces_row_version_check BEFORE UPDATE ON public.workspaces FOR EACH ROW WHEN (((old.row_version IS DISTINCT FROM new.row_version) OR (old.* IS DISTINCT FROM new.*))) EXECUTE FUNCTION workspaces_enforce_row_version();
CREATE TRIGGER workspaces_row_version_occ BEFORE UPDATE ON public.workspaces FOR EACH ROW EXECUTE FUNCTION enforce_row_version_increment();
CREATE TRIGGER workspaces_seed_onboarding AFTER INSERT ON public.workspaces FOR EACH ROW EXECUTE FUNCTION seed_workspace_onboarding();
CREATE TRIGGER workspaces_seed_role_defaults AFTER INSERT ON public.workspaces FOR EACH ROW EXECUTE FUNCTION seed_workspace_role_defaults();

-- ============================================================================
-- Event trigger (RLS auto-enable on new public tables)
-- ============================================================================
CREATE EVENT TRIGGER ensure_rls ON ddl_command_end
  WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  EXECUTE FUNCTION rls_auto_enable();

-- ============================================================================
-- Row Level Security: enable on every relation (42 total)
-- ============================================================================
ALTER TABLE public.asset_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.asset_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log_2026_05 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log_2026_06 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log_2026_07 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.briefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages_2026_05 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages_2026_06 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages_2026_07 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cockpit_access_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cockpit_procedure_allowlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comment_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feature_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbox_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbox_entries_2026_05 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbox_entries_2026_06 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbox_entries_2026_07 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intent_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pending_flows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_operators ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_annotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_processing_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_onboarding ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- RLS policies (SELECT-centric, plus the few write policies present in live)
-- ============================================================================
CREATE POLICY asset_attachments_select_member ON public.asset_attachments AS PERMISSIVE FOR SELECT TO authenticated
  USING (((deleted_at IS NULL) AND (EXISTS ( SELECT 1 FROM workspace_members wm WHERE ((wm.workspace_id = asset_attachments.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.active = true))))));

CREATE POLICY asset_versions_select_member ON public.asset_versions AS PERMISSIVE FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1 FROM workspace_members wm WHERE ((wm.workspace_id = asset_versions.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.active = true)))));

CREATE POLICY assets_select_member ON public.assets AS PERMISSIVE FOR SELECT TO authenticated
  USING (((deleted_at IS NULL) AND (EXISTS ( SELECT 1 FROM workspace_members wm WHERE ((wm.workspace_id = assets.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.active = true))))));

CREATE POLICY audit_log_select_member ON public.audit_log AS PERMISSIVE FOR SELECT TO authenticated
  USING (((workspace_id IS NOT NULL) AND (EXISTS ( SELECT 1 FROM workspace_members wm WHERE ((wm.workspace_id = audit_log.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.active = true))))));

CREATE POLICY briefs_select_agency ON public.briefs AS PERMISSIVE FOR SELECT TO authenticated
  USING (((deleted_at IS NULL) AND (EXISTS ( SELECT 1 FROM workspace_members wm WHERE ((wm.workspace_id = briefs.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.active = true) AND (wm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'agency'::text])))))));

CREATE POLICY briefs_select_client_own ON public.briefs AS PERMISSIVE FOR SELECT TO authenticated
  USING (((deleted_at IS NULL) AND (created_by = auth.uid()) AND (EXISTS ( SELECT 1 FROM workspace_members wm WHERE ((wm.workspace_id = briefs.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.active = true) AND (wm.role = 'client'::text))))));

CREATE POLICY chat_channels_select_member ON public.chat_channels AS PERMISSIVE FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1 FROM workspace_members wm WHERE ((wm.workspace_id = chat_channels.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.active = true)))));

CREATE POLICY chat_messages_select_member ON public.chat_messages AS PERMISSIVE FOR SELECT TO authenticated
  USING (((deleted_at IS NULL) AND (EXISTS ( SELECT 1 FROM workspace_members wm WHERE ((wm.workspace_id = chat_messages.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.active = true))))));

CREATE POLICY cockpit_access_log_select_operator ON public.cockpit_access_log AS PERMISSIVE FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1 FROM platform_operators po WHERE ((po.user_id = auth.uid()) AND (po.revoked_at IS NULL)))));

CREATE POLICY cockpit_procedure_allowlist_select_operator ON public.cockpit_procedure_allowlist AS PERMISSIVE FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1 FROM platform_operators po WHERE ((po.user_id = auth.uid()) AND (po.revoked_at IS NULL)))));

CREATE POLICY comment_reactions_delete_self ON public.comment_reactions AS PERMISSIVE FOR DELETE TO authenticated
  USING ((user_id = auth.uid()));

CREATE POLICY comment_reactions_insert_self ON public.comment_reactions AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((user_id = auth.uid()) AND (EXISTS ( SELECT 1 FROM workspace_members wm WHERE ((wm.workspace_id = comment_reactions.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.active = true))))));

CREATE POLICY comment_reactions_select_member ON public.comment_reactions AS PERMISSIVE FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1 FROM workspace_members wm WHERE ((wm.workspace_id = comment_reactions.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.active = true)))));

CREATE POLICY comments_select_member ON public.comments AS PERMISSIVE FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1 FROM workspace_members wm WHERE ((wm.workspace_id = comments.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.active = true)))));

CREATE POLICY delivery_attempts_select_member ON public.delivery_attempts AS PERMISSIVE FOR SELECT TO authenticated
  USING (((workspace_id IS NOT NULL) AND (EXISTS ( SELECT 1 FROM workspace_members wm WHERE ((wm.workspace_id = delivery_attempts.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.active = true))))));

CREATE POLICY delivery_attempts_select_operator ON public.delivery_attempts AS PERMISSIVE FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1 FROM platform_operators po WHERE ((po.user_id = auth.uid()) AND (po.revoked_at IS NULL)))));

CREATE POLICY email_threads_select_member ON public.email_threads AS PERMISSIVE FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1 FROM workspace_members wm WHERE ((wm.workspace_id = email_threads.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.active = true)))));

CREATE POLICY feature_flags_select_member ON public.feature_flags AS PERMISSIVE FOR SELECT TO authenticated
  USING (((workspace_id IS NULL) OR (EXISTS ( SELECT 1 FROM workspace_members wm WHERE ((wm.workspace_id = feature_flags.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.active = true))))));

CREATE POLICY feature_flags_select_operator ON public.feature_flags AS PERMISSIVE FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1 FROM platform_operators po WHERE ((po.user_id = auth.uid()) AND (po.revoked_at IS NULL)))));

CREATE POLICY group_members_select_member ON public.group_members AS PERMISSIVE FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1 FROM workspace_members wm WHERE ((wm.workspace_id = group_members.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.active = true)))));

CREATE POLICY groups_select_member ON public.groups AS PERMISSIVE FOR SELECT TO authenticated
  USING (((deleted_at IS NULL) AND (EXISTS ( SELECT 1 FROM workspace_members wm WHERE ((wm.workspace_id = groups.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.active = true))))));

CREATE POLICY inbox_entries_select_own ON public.inbox_entries AS PERMISSIVE FOR SELECT TO authenticated
  USING (((deleted_at IS NULL) AND (user_id = auth.uid()) AND (EXISTS ( SELECT 1 FROM workspace_members wm WHERE ((wm.workspace_id = inbox_entries.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.active = true))))));

CREATE POLICY intent_ledger_select_operator ON public.intent_ledger AS PERMISSIVE FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1 FROM platform_operators po WHERE ((po.user_id = auth.uid()) AND (po.revoked_at IS NULL)))));

CREATE POLICY pending_flows_select_operator ON public.pending_flows AS PERMISSIVE FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1 FROM platform_operators po WHERE ((po.user_id = auth.uid()) AND (po.revoked_at IS NULL)))));

CREATE POLICY platform_operators_select_self ON public.platform_operators AS PERMISSIVE FOR SELECT TO authenticated
  USING ((user_id = auth.uid()));

CREATE POLICY post_annotations_select_member ON public.post_annotations AS PERMISSIVE FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1 FROM workspace_members wm WHERE ((wm.workspace_id = post_annotations.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.active = true)))));

CREATE POLICY post_versions_select_member ON public.post_versions AS PERMISSIVE FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1 FROM workspace_members wm WHERE ((wm.workspace_id = post_versions.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.active = true)))));

CREATE POLICY posts_select_member ON public.posts AS PERMISSIVE FOR SELECT TO authenticated
  USING (((deleted_at IS NULL) AND (EXISTS ( SELECT 1 FROM workspace_members wm WHERE ((wm.workspace_id = posts.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.active = true))))));

CREATE POLICY session_devices_select_own ON public.session_devices AS PERMISSIVE FOR SELECT TO authenticated
  USING ((user_id = auth.uid()));

CREATE POLICY session_devices_update_own ON public.session_devices AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));

CREATE POLICY users_select_shared_workspace ON public.users AS PERMISSIVE FOR SELECT TO authenticated
  USING (((id = auth.uid()) OR (EXISTS ( SELECT 1 FROM (workspace_members wm1 JOIN workspace_members wm2 ON ((wm1.workspace_id = wm2.workspace_id))) WHERE ((wm1.user_id = auth.uid()) AND (wm2.user_id = users.id) AND (wm1.active = true))))));

CREATE POLICY users_update_self ON public.users AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((id = auth.uid())) WITH CHECK ((id = auth.uid()));

CREATE POLICY webhook_events_select_operator ON public.webhook_events AS PERMISSIVE FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1 FROM platform_operators po WHERE ((po.user_id = auth.uid()) AND (po.revoked_at IS NULL)))));

CREATE POLICY webhook_processing_attempts_select_operator ON public.webhook_processing_attempts AS PERMISSIVE FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1 FROM platform_operators po WHERE ((po.user_id = auth.uid()) AND (po.revoked_at IS NULL)))));

CREATE POLICY workspace_buckets_select_member ON public.workspace_buckets AS PERMISSIVE FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1 FROM workspace_members wm WHERE ((wm.workspace_id = workspace_buckets.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.active = true)))));

CREATE POLICY workspace_members_select_member ON public.workspace_members AS PERMISSIVE FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1 FROM workspace_members wm2 WHERE ((wm2.workspace_id = workspace_members.workspace_id) AND (wm2.user_id = auth.uid()) AND (wm2.active = true)))));

CREATE POLICY workspace_onboarding_select_owner ON public.workspace_onboarding AS PERMISSIVE FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1 FROM workspace_members wm WHERE ((wm.workspace_id = workspace_onboarding.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.active = true) AND (wm.role = 'owner'::text)))));

CREATE POLICY workspace_role_permissions_select_member ON public.workspace_role_permissions AS PERMISSIVE FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1 FROM workspace_members wm WHERE ((wm.workspace_id = workspace_role_permissions.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.active = true)))));

CREATE POLICY workspace_settings_select_member ON public.workspace_settings AS PERMISSIVE FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1 FROM workspace_members wm WHERE ((wm.workspace_id = workspace_settings.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.active = true)))));

CREATE POLICY workspaces_select_member ON public.workspaces AS PERMISSIVE FOR SELECT TO authenticated
  USING (((deleted_at IS NULL) AND (EXISTS ( SELECT 1 FROM workspace_members wm WHERE ((wm.workspace_id = workspaces.id) AND (wm.user_id = auth.uid()) AND (wm.active = true))))));
