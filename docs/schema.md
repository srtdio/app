# Sorted v2 Schema (MVP)

Generated from live database movnexawfhsyuluspxoc (srtdio-v2) after the MVP stripdown.
This file is the human-readable design reference. The migrations folder is implementation truth.

Sorted v2 MVP is a social-media approval tool: client writes a brief, agency drafts a post, post moves through review to approved, rejected, or parked. No publishing, no scheduling. Plans exist from 9 Oct 2026 (plans tables, step 3a). Chat history is the Postgres record (chat_messages); Agora is live delivery only. Email is out-of-app catch-up.

All tables are in schema `public`, all have RLS enabled. `id` uses `uuidv7()` unless noted. Timestamps are `timestamptz`. `*_by` FK columns are SET NULL on delete except `workspaces.owner_user_id` (RESTRICT) and `asset_attachments` (NO ACTION).

## Index

1. Identity and access: users, workspaces, workspace_members, workspace_role_permissions, workspace_settings, workspace_onboarding, session_devices, platform_operators
2. Content: workspace_buckets, posts, post_versions, post_annotations
3. Discussion: comments, comment_reactions
4. Briefs: briefs
5. Assets: assets, asset_versions, asset_attachments, folders
6. People grouping: groups, group_members
7. Chat (Postgres record): chat_channels, chat_messages, chat_message_marks, chat_message_stars, chat_reactions, chat_read_cursors, chat_sync_events
8. Inbox and delivery: inbox_entries, email_threads, delivery_attempts, webhook_events, webhook_processing_attempts
9. Platform ops (Cockpit): audit_log, feature_flags, cockpit_access_log, cockpit_procedure_allowlist, intent_ledger, pending_flows
10. Enumerations reference
11. Partitioning reference
12. Known leftover traces

## 1. Identity and access

### users

App-level profile. id mirrors auth.users.id (FK).

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | PK, FK auth.users.id |
| display_name | text | 1 to 80 chars |
| designation | text | nullable, 1 to 80 |
| avatar_url | text | nullable, ^https?:// |
| deleted_at | timestamptz | nullable, account-level soft-delete |
| timezone | text | nullable, IANA tz; null falls back to workspaces.timezone for catch-up scheduling |
| profile_completed_at | timestamptz | nullable, onboarding gate; stamped once an avatar exists |
| email_opt_in | boolean | not null, default true; catch-up email opt-out |
| created_at / updated_at | timestamptz | default now() |

user_profile_update(p_display_name, p_designation, p_avatar_url, p_email_opt_in, p_trace_id) SECURITY DEFINER (search_path='', EXECUTE to authenticated only): the only write path to a user's own profile. Acts on auth.uid(); a null or blank display_name raises invalid_payload. designation / avatar_url / email_opt_in are coalesced (null leaves the existing value). profile_completed_at is stamped now() the first time an avatar exists and never overwritten. Writes a success audit row.

### workspaces

One workspace = one end-client = one platform.

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | PK |
| name | text | 1 to 80 |
| owner_user_id | uuid | FK users.id, RESTRICT |
| plan_tier | text | solo / studio / agency / enterprise, default solo |
| timezone | text | |
| week_start_day | smallint | 0 to 6, default 1 |
| stripe_customer_id / stripe_subscription_id | text | nullable |
| subscription_state | text | trial / active / read_only / grace / soft_pause / full_pause / soft_delete, default trial |
| subscription_state_expires_at / trial_ends_at / activated_at | timestamptz | nullable |
| digest_default_time | time | default 09:00 |
| target_distributions | jsonb | nullable |
| asset_bucket | text | permanent R2 bucket name, set on insert by trigger, immutable thereafter. Unique among active (deleted_at null) workspaces. |
| row_version | bigint | default 1 |
| created_at / updated_at / deleted_at | timestamptz | deleted_at nullable |

### workspace_members

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | PK |
| workspace_id | uuid | FK workspaces.id |
| user_id | uuid | FK auth.users.id |
| role | text | owner / admin / agency / client |
| active | boolean | default true |
| invited_by | uuid | nullable, FK users.id |
| invited_at | timestamptz | default now() |
| accepted_at / removed_at / rejoined_at | timestamptz | nullable |

Unique: one active membership per (workspace_id, user_id).

### workspace_role_permissions

PK (workspace_id, role, capability). Fields: allowed default true, updated_at. role in owner/admin/agency/client.

### workspace_settings

PK workspace_id. Fields: payload jsonb default {}, updated_at, updated_by nullable FK users.id.

### workspace_onboarding

Milestone timestamps, all nullable: first_post_at, first_invite_at, first_brief_at, dismissed_at, auto_hidden_at. PK workspace_id.

### session_devices

JWT 15 min plus device fingerprint RLS. PK id. Fields: user_id FK auth.users.id, fingerprint_hash ^[a-f0-9]{64}$, user_agent nullable, ip_subnet inet nullable, last_seen_at, created_at, revoked_at nullable.

### platform_operators

Cockpit staff. PK user_id (FK auth.users.id). Fields: granted_at, granted_by nullable FK, revoked_at nullable, passkey_credential_id nullable.

## 2. Content

### workspace_buckets

PK id. Fields: workspace_id FK, name, color_hex ^#[0-9A-Fa-f]{6}$, position default 0, archived default false, target_month int 0 to 100 default 0, created_at. Unique (workspace_id, lower(name)) where not archived.

### posts

The approval unit. stage is the only workflow state. No publish_status.

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | PK |
| workspace_id | uuid | FK workspaces.id |
| title | text | 1 to 200 |
| caption | text | nullable |
| bucket_id | uuid | FK workspace_buckets.id |
| owner_user_id | uuid | FK users.id, SET NULL |
| platform | text | linkedin / x / instagram / facebook / threads |
| format | text | text / single_image / carousel / video / link |
| stage | text | draft / review / approved / parked / rejected, default draft |
| stage_entered_at | timestamptz | not null with a default, reset by stage_transition on every stage change |
| approved_by | uuid | nullable, FK auth.users.id, SET NULL. Set to the actor on entering approved, cleared on leaving it |
| approved_at | timestamptz | nullable. Set on entering approved, cleared on leaving it |
| target_date | timestamptz | nullable, indicative only, no engine in MVP |
| origin | text | manual / brief, default manual |
| brief_id | uuid | nullable, FK briefs.id, SET NULL |
| row_version | bigint | default 1 |
| created_by | uuid | FK users.id, SET NULL |
| legacy_author_name | text | nullable, frozen original v1 author/creator name shown when the live created_by is null, used by the detail pages with an "(ex-member)" fallback |
| created_at / updated_at / deleted_at | timestamptz | deleted_at nullable |

Stage CHECK: draft, review, approved, parked, rejected. No publish/schedule/platform columns. Indexes: (workspace_id, stage, created_at desc), (workspace_id, target_date) where target_date not null, brief_id partial, owner partial. All where deleted_at null.

posts_select_member: active member, not deleted; drafts only for owner/admin/agency. comments and asset_attachments on posts inherit this via EXISTS on posts.

### post_versions

Immutable edit history. No deleted_at. PK id. Fields: post_id FK, workspace_id FK, version_number, snapshot jsonb, created_by FK users.id SET NULL, legacy_author_name (text, nullable: frozen original v1 author/creator name shown when the live created_by is null, used by the detail pages with an "(ex-member)" fallback), created_at. Unique (post_id, version_number).

### post_annotations

Immutable. No deleted_at. PK id.

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | PK |
| post_id | uuid | FK posts.id |
| workspace_id | uuid | FK workspaces.id |
| post_version_id | uuid | FK post_versions.id |
| kind | text | caption_span / image_pin |
| caption_start / caption_end | int | nullable |
| asset_attachment_id | uuid | nullable, FK asset_attachments.id |
| image_x / image_y | real | nullable, 0 to 1 |
| comment_id | uuid | FK comments.id |
| created_at | timestamptz | default now() |

## 3. Discussion

Two primitives: Comments (here) and Chat (section 7). Both are recorded in Postgres.

### comments

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | PK |
| workspace_id | uuid | FK workspaces.id |
| entity_type | text | post / brief / plan_cell (see section 12: plan_cell is a dead value) |
| entity_id | uuid | |
| parent_comment_id | uuid | nullable, FK comments.id |
| author_user_id | uuid | FK auth.users.id |
| body | text | up to 10000 chars, NOT NULL; may be an empty string only when the comment carries at least one attachment (comments_body_or_attachment_check: char_length(body) >= 1 OR the comment has at least one attachment). comment_create applies the same rule, rejecting an empty or whitespace-only body when there are no attachments |
| mentions | jsonb | nullable |
| attachment_asset_ids | uuid[] | nullable |
| resolved_at | timestamptz | nullable, set on the root comment when its thread is resolved (null = open) |
| resolved_by | uuid | nullable, FK users.id ON DELETE SET NULL, the member who resolved the thread |
| ledger_seq | integer | nullable; non-null marks the comment as a feedback-ledger checkpoint. Must be > 0, top-level (parent_comment_id null) and entity_type='post' (comments_ledger_shape_check); trimmed body must split to 1 to 50 whitespace-separated words (comments_ledger_word_cap_check); unique per post via the partial unique index comments_entity_ledger_seq_key on (entity_id, ledger_seq) where ledger_seq is not null |
| ledger_batch_id | uuid | nullable, groups the checkpoints written by one comment_batch_create call |
| resolution_note | text | nullable, 1 to 500 chars (comments_resolution_note_len_check); trimmed note stored by comment_resolve on a real open-to-resolved transition, cleared on reopen |
| legacy_author_name | text | nullable, 1 to 120, frozen original author name for migrated v1 comments |
| legacy_author_email | text | nullable, 3 to 320, original author email, used to reclaim authorship when that person later joins with the same email |
| edited_at / deleted_at | timestamptz | nullable |
| created_at | timestamptz | default now() |

Indexes: FTS on body, entity, parent, author. All where deleted_at null. Plus the ledger indexes: comments_entity_ledger_seq_key (unique (entity_id, ledger_seq) where ledger_seq is not null) and comments_open_checkpoints_idx ((entity_id) where ledger_seq is not null and resolved_at is null and deleted_at is null).

comment_create(p_workspace_id, p_entity_type, p_entity_id, p_parent_comment_id, p_body, p_mentions, p_attachment_asset_ids, p_trace_id) SECURITY DEFINER (search_path='public', EXECUTE to authenticated only): the only write path to the comments table. One-level threading (a reply to an already-threaded comment is invalid_payload), lands attachment_asset_ids as entity_type='comment' asset_attachments rows, and emits the Activity inbox_entries ('comment' for the audience, urgent 'mention' for mentioned members).

comment_resolve(p_comment_id, p_resolved, p_trace_id, p_resolution_note default null) SECURITY DEFINER (search_path='public', EXECUTE to authenticated only): toggles the thread-level resolved state on a root comment (a reply is invalid_payload; a missing or soft-deleted comment is not_found). p_resolved=true stamps resolved_at=now()/resolved_by=auth.uid() only when currently open and emits one 'comment_resolved' active inbox entry per other thread author (role-gated like comment_create); p_resolved=false clears the state (including resolution_note) and is silent (no inbox write). p_resolution_note is trimmed, a blank note becomes null, over 500 chars raises invalid_payload; the note is stored only on a real open-to-resolved transition. Any active workspace member may resolve or reopen.

#### Feedback ledger

Doctrine for client feedback on posts, layered on the comments table (applied via MCP 2026-07-16; recorded in migration 20260716120000_feedback_ledger.sql, history only):

- A checkpoint is a top-level ('post') comment with ledger_seq set. Replies are never checkpoints, and only members with role 'client' can create them (comment_batch_create is client-only), so agency comments are never checkpoints.
- 50-word cap: a checkpoint body is 1 to 50 words (whitespace split on the trimmed body), enforced by the check constraint, by comment_batch_create, and by comment_edit on checkpoints.
- Per-post permanent numbering: seq is assigned under a posts-row FOR UPDATE lock, continuing from the post's max ledger_seq, and is unique per post (partial unique index). Numbers are never reused or renumbered.
- Batch = one notification: comment_batch_create(p_workspace_id, p_post_id, p_points jsonb, p_trace_id) returns jsonb [{id,seq}]. Caller must be an active 'client' member (else forbidden_role); the post must exist in the workspace (else not_found) and not be in 'draft' (else invalid_stage); 1 to 20 points (else invalid_payload). Each point is {body, attachment_version_ids?}; attachment version ids are validated against the workspace and non-deleted assets, then written as entity_type='comment' asset_attachments rows. One 'checkpoints_added' inbox entry (tier 'active', payload batch_id/count/seqs) per active member except the author, plus one audit_log_write.
- Edit clears the tick: comment_edit on a checkpoint enforces the word cap and clears resolved_at, resolved_by and resolution_note in the same statement. Normal comments are unchanged.
- Ready ping is gated on a clean ledger: post_ready_notify(p_post_id, p_trace_id) requires an active owner/admin/agency caller (else forbidden_role) and stage 'review' (else invalid_stage); any unresolved checkpoint raises checkpoints_open. On success it writes one 'post_ready' inbox entry (tier 'urgent', payload checkpoints=total) per active client member except the caller. A zero-checkpoint ping is allowed.
- Constraint fix (migration 20260717120000_widen_inbox_event_type_check.sql): inbox_entries_event_type_check is re-created to also admit 'checkpoints_added' and 'post_ready' (the full section 8 list plus these two). Before this, the constraint listed only the original section 8 values, so both procs failed at the inbox insert whenever there was a recipient and the whole transaction rolled back (no checkpoint ever committed on live). The value set is now the single source of truth INBOX_EVENT_TYPES (@srtdio/schemas), asserted equal to the live constraint by tests/comments/event-type-constraint.test.ts. The ephemeral test stacks pick the widening up from the migration (the former local-only patch in tests/comments/setup.ts has been removed). Apply to live via MCP to close the incident.

### comment_reactions

PK (comment_id, user_id, emoji). Fields: workspace_id FK, emoji 1 to 32, created_at.

## 4. Briefs

Client writes the brief; it lands in the Briefs section and can be linked to a post (origin=brief). Read-only after creation. Open or Closed.

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | PK |
| workspace_id | uuid | FK workspaces.id |
| title | text | 1 to 200 |
| objective | text | 1 to 5000 |
| format_requested | text | nullable: text / single_image / carousel / video / link |
| brand_requirements | text | nullable |
| target_date | date | nullable, indicative only |
| reference_links | jsonb | nullable |
| status | text | open / closed, default open |
| closed_at / closed_by | | nullable, closed_by FK users.id |
| created_by | uuid | FK users.id |
| legacy_author_name | text | nullable, frozen original v1 author/creator name shown when the live created_by is null, used by the detail pages with an "(ex-member)" fallback |
| created_via | text | app / email_forward, default app |
| row_version | bigint | default 1 |
| created_at / updated_at / deleted_at | timestamptz | deleted_at nullable |

Indexes: (workspace_id, status, created_at desc), target_date partial, created_by, FTS on title+objective.

brief_create(p_workspace_id, p_payload, p_trace_id) SECURITY DEFINER: client-only create gated on an active member with the brief.create capability. The payload also accepts an optional field attachment_asset_version_ids (an ordered array of asset_version ids, any kind: image / video / pdf / Office-doc / link). Because briefs are read-only after creation, creation is the only attach point: each id is written as an asset_attachments row with entity_type='brief', entity_id = the new brief id, and position = array order. A non-array value, a non-uuid element, or an id whose asset_version is missing or in another workspace raises invalid_payload and writes no brief and no attachments.

## 4a. plans / plan_items / plan_item_reviews

Applied 9 Oct 2026 (step 3a plans), restated in migration 20261009110000_plans_core.sql. A plan is a shared object in chat holding concepts and posts with team and client approval. RLS on all three; authenticated has SELECT only (no INSERT, UPDATE or DELETE); every write goes through the procs below. No proc hard-deletes a row.

### plans

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | PK, default uuidv7() |
| workspace_id | uuid | FK workspaces.id, CASCADE |
| title | text | 1 to 200 |
| starts_on / ends_on | date | ends_on >= starts_on, at most 92 days apart (plans_dates) |
| audience | text | team / client |
| shared_with_client_at | timestamptz | nullable |
| shared_with_client_by | uuid | nullable, FK users.id, SET NULL |
| created_by | uuid | nullable, FK users.id, SET NULL |
| created_at / updated_at / deleted_at | timestamptz | deleted_at nullable |

- plans_shared_consistency: audience team has both shared_with_client columns null; audience client has shared_with_client_at set.
- plans_select_member: active member, not deleted; team plans only for owner/admin/agency.
- Indexes: (workspace_id, starts_on desc) where not deleted; created_by and shared_with_client_by partial.

### plan_items

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | PK, default uuidv7() |
| workspace_id | uuid | FK workspaces.id, CASCADE |
| plan_id | uuid | FK plans.id, CASCADE |
| kind | text | concept / post |
| position | int | default 0 |
| title | text | concept only, 1 to 200 |
| description | text | concept only, nullable, up to 5000 |
| post_id | uuid | post only, FK posts.id, CASCADE |
| target_date | date | concept only, nullable (null = no date); post items take their date from posts.target_date |
| created_by | uuid | nullable, FK users.id, SET NULL |
| created_at / updated_at / deleted_at | timestamptz | deleted_at nullable |

- plan_items_shape: a concept has a title and no post_id; a post item has post_id and no title or description.
- plan_items_target_date_concept_only: kind = concept or target_date is null.
- plan_items_post_once: a post appears at most once per plan among live post items (partial unique on plan_id, post_id).
- plan_items_select_member: not deleted, its plan readable, and for a post item its post readable (so a draft post item stays hidden from a client, via posts_select_member).
- Concept files: asset_attachments rows with entity_type plan_item; asset_attachments_select_member checks the plan item is readable.

### plan_item_reviews

| Column | Type | Notes |
| --- | --- | --- |
| item_id | uuid | PK part, FK plan_items.id, CASCADE |
| workspace_id | uuid | FK workspaces.id, CASCADE |
| side | text | PK part, team / client |
| status | text | waiting / approved / changes |
| reviewed_by | uuid | nullable, FK users.id, SET NULL |
| reviewed_at | timestamptz | default now() |

- plan_item_reviews_select_member: its item readable; team reviews only for owner/admin/agency, client reviews for every member who can read the item.

### plan_item_comments

Applied 9 Oct 2026 (step 3b plan comments), restated in migration 20261009205500_plan_item_comments.sql. RLS on; authenticated has SELECT only.

- Columns: id uuid PK default uuidv7(); workspace_id FK workspaces.id CASCADE; item_id FK plan_items.id CASCADE; author_user_id nullable FK users.id SET NULL.
- Content: body text, trimmed length 1 to 5000 (plan_item_comments_body_check); visibility text 'everyone' / 'team' (plan_item_comments_visibility_check).
- Timestamps: created_at default now(); edited_at / deleted_at nullable.
- Indexes: (item_id, created_at) where not deleted; workspace_id; author_user_id where not null.
- plan_item_comments_select_member: not deleted, its item readable, and visibility 'everyone' or the caller is_agency_side_member.

### Plan procs

All SECURITY DEFINER, search_path '', EXECUTE to authenticated, each takes p_trace_id and writes one audit_log row named after the proc on success. Owner/admin/agency only unless noted (forbidden_role otherwise).

- is_agency_side_member(p_workspace_id): true when the caller is an active owner, admin or agency member.
- plan_create(p_workspace_id, p_title, p_starts_on, p_ends_on, p_audience, p_trace_id) returns uuid: create a plan; a client plan is shared at once.
- plan_update(p_plan_id, p_title, p_starts_on, p_ends_on, p_trace_id): rename or move dates.
- plan_share_with_client(p_plan_id, p_trace_id): one-way team to client; plan_has_drafts while it holds a draft post.
- plan_delete(p_plan_id, p_trace_id): soft-delete the plan.
- plan_concept_add(p_plan_id, p_title, p_description, p_attachment_version_ids, p_trace_id, p_target_date default null) returns uuid: append a concept with up to 20 library files and an optional date.
- plan_concept_edit(p_item_id, p_title, p_description, p_attachment_version_ids, p_trace_id, p_target_date default null): edit a concept (null files keeps them); always writes target_date (null clears it); any edit, a date-only one included, resets its team and client reviews to waiting.
- plan_posts_add(p_plan_id, p_post_ids, p_trace_id) returns integer: append 1 to 50 posts, skipping ones already in the plan; plan_has_drafts for a draft into a client plan.
- plan_item_remove(p_item_id, p_trace_id): soft-delete an item.
- plan_items_reorder(p_plan_id, p_item_ids, p_trace_id): set positions from the full, exact list of live item ids.
- plan_item_review(p_item_id, p_side, p_status, p_trace_id): upsert a review; team side for owner/admin/agency, client side for an active client on a client plan's concepts only (use_stage_transition on a post item). A status other than waiting writes plan_review inbox rows via _plan_item_notify (team side to owner/admin/agency only).
- plan_item_comment_create(p_item_id, p_body, p_visibility, p_trace_id) returns uuid: any active member; a client only on a client plan and only 'everyone' (forbidden_role otherwise); invalid_payload for a missing item, a bad visibility or an empty or over-5000 body; writes plan_comment inbox rows via _plan_item_notify ('team' to owner/admin/agency only).
- Internal, no EXECUTE for authenticated: _plan_check_versions (same-workspace, library, not deleted; 'attachment not available' for chat-origin or deleted files), _plan_attach_versions, and _plan_item_notify(p_item_id, p_event_type, p_team_only, p_payload) (one inbox row per other active member: owner/admin/agency always, clients too when not team-only on a client plan; payload gains plan_id).

## 5. Assets

Versioned. Attachments bind to a specific asset_version_id.

### assets

PK id. Fields: workspace_id FK, filename 1 to 500, display_name text nullable (human label, backfilled from post title), current_version_id nullable FK asset_versions.id, folder_id nullable FK folders.id (SET NULL on folder delete), folder_path default '/', tags text[] default {}, uploaded_by FK users.id, uploaded_at, deleted_at nullable, origin text NOT NULL default 'library' (CHECK assets_origin_check: origin in ('library','chat'); 'chat' marks a file uploaded in chat, backfilled in 20260930160000_assets_origin_chat_private.sql). Indexes: FTS filename, gin tags, (workspace_id, folder_path), (workspace_id, folder_id), (workspace_id, uploaded_at desc). All where deleted_at null.

folder_id and folder_path coexist for now: folder_id is the new structured folder reference, folder_path is the legacy string path. folder_path remains present pending a later reconciliation decision; no migration drops or backfills either column yet.

### asset_versions

PK id. Fields: asset_id FK, workspace_id FK, version_number, r2_key unique, mime_type, sha256 ^[a-f0-9]{64}$, size_bytes > 0, width/height/duration_ms nullable > 0, uploaded_by FK, uploaded_at. Unique (asset_id, version_number).

RLS (20260930160000_assets_origin_chat_private.sql):

- assets_select_member (SELECT to authenticated): deleted_at IS NULL AND origin = 'library' AND an active workspace_members row for (assets.workspace_id, auth.uid()).
- asset_versions_select_member (SELECT to authenticated): an active workspace_members row for (asset_versions.workspace_id, auth.uid()) AND the parent asset has origin = 'library'.

Chat-origin assets and their versions are therefore invisible to authenticated reads; chat file reads go through the service role and chat_attachment_readable (section 7).

Chat files stay in chat (20261005040000_chat_files_stay_in_chat.sql):

- gallery_set: raises 'attachment not available' for a version (in the post's workspace) whose asset is origin 'chat' or soft-deleted, unless that version is already live-attached to the same post, so an unchanged gallery still saves.
- brief_create: raises 'attachment not available' for an attachment version whose asset is origin 'chat' or soft-deleted.
- comment_create: raises 'attachment not available' for an attachment version whose asset is origin 'chat' or soft-deleted.
- comment_batch_create: raises 'attachment not available' for an attachment version whose asset is origin 'chat' or soft-deleted.
- asset_delete: raises 'chat files are deleted with their message' for an origin 'chat' asset.
- asset_delete_many: raises 'chat files are deleted with their message' when the set holds a live origin 'chat' asset.
- Agency actions (20261007100000_agency_actions_activity.sql, applied 7 Oct):
  - post_deleted inbox event: post_soft_delete writes one row per other active member (entity_type post, entity_id post id, scope posts, tier active), payload {number, title (<=120), actor_role}, actor_user_id = actor.
  - assets_deleted inbox event: asset_delete / asset_delete_many write ONE row per other active member per call (entity_type workspace, entity_id = scope_key = workspace id, scope everything, tier active), payload {count, filenames (up to 3), actor_role}. Bulk = one row; nothing deleted = no row. Any active member may delete assets.
  - post_deleted for a draft goes only to roles with pipeline.view_all_stages.
  - stage_change payload is {from, to, actor_role} (also in the audit row); approved / rejected need post.approve, parked / review need post.edit. Rows written before 7 Oct have no actor_role.
  - workspace_role_permissions: agency has post.delete (post_soft_delete is owner, admin, agency).
  - workspace_role_permissions: client has asset.delete (all workspaces and seed_workspace_role_defaults).

### asset_attachments

NO ACTION on delete: live attachments block asset hard-delete.

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | PK |
| asset_id | uuid | FK assets.id |
| asset_version_id | uuid | FK asset_versions.id |
| entity_type | text | post / comment / chat_message / brief |
| entity_id | text | 1 to 200 |
| workspace_id | uuid | FK workspaces.id |
| position | int | default 0 |
| attached_by | uuid | FK users.id |
| attached_at | timestamptz | default now() |
| deleted_at | timestamptz | nullable |

### folders

Per-workspace, self-referential asset folder tree. Created out-of-band on live and committed retroactively. Soft-deleted via deleted_at.

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | PK |
| workspace_id | uuid | FK workspaces.id (NO ACTION) |
| name | text | 1 to 80 |
| parent_id | uuid | nullable, FK folders.id (NO ACTION), self-reference |
| created_by | uuid | nullable, FK users.id, SET NULL |
| created_at / updated_at | timestamptz | default now() (no updated_at trigger) |
| deleted_at | timestamptz | nullable |

Indexes: unique (workspace_id, parent_id, lower(name)) NULLS NOT DISTINCT where deleted_at null; (workspace_id, parent_id) where deleted_at null. Trigger folders_cycle_guard (BEFORE INSERT OR UPDATE OF parent_id) calls folders_prevent_cycle() to reject self-parenting and parent-chain cycles.

RLS enabled (not forced). One policy only: folders_select_member (SELECT, role PUBLIC) where deleted_at null AND caller is an active workspace_members row. No INSERT/UPDATE/DELETE policies. Grants: SELECT/INSERT/UPDATE/DELETE are revoked from anon, authenticated, and service_role (only REFERENCES/TRIGGER/TRUNCATE defaults remain); srtdio_readonly has SELECT. Net effect: the SELECT policy is currently unreachable for authenticated at the table-grant level, and service_role has no CRUD grant. Recorded as-is, not reconciled in this migration.

## 6. People grouping

### groups

PK id. Fields: workspace_id FK, name ^[A-Za-z0-9 -]{1,40}$, created_by FK, created_at, deleted_at nullable. Unique (workspace_id, lower(name)) where not deleted.

avatar_url text nullable, check avatar_url IS NULL OR ~ '^https?://' (groups_avatar_url_check); set via group_avatar_set (permission = creator or workspace owner/admin, same as group_rename); NULL clears.

### group_members

PK (group_id, user_id). Fields: workspace_id FK, joined_at. user_id FK auth.users.id.

Group auto-archives (deleted_at set) when its last member leaves or is removed. No manual group delete.

### Group + channel procs (A2a)

Seven SECURITY DEFINER procs (search_path='', EXECUTE to authenticated only): group_create, group_rename, group_avatar_set, group_member_add, group_member_remove, group_leave, dm_channel_ensure. group_create also seeds the group chat_channels row; dm_channel_ensure upserts the dm channel. Gating: group_create / dm_channel_ensure require an active workspace member; group_rename / group_avatar_set / group_member_add / group_member_remove require the group creator or a workspace owner/admin; group_leave is self only.

## 7. Chat (Postgres record)

Chat record: public.chat_messages is the single source of truth for chat history and the only read path. Every send calls chat_message_send (client-generated uuid_v7 id, server-stamped created_at, idempotent) BEFORE publishing to Agora; the Agora message carries the Sorted id in ext for dedupe. Agora is live delivery only: never read for history, never the record. Agora Free plan, no server callbacks. Access: chat_channel_member(channel_id, uid) gates every chat table; DMs are visible only to the two participants, group channels only to group_members. chat_channels, groups, group_members SELECT = participants/group members only (plan_period channels: all active members). Reactions in chat_reactions, read position in chat_read_cursors. Membership and rename changes to Agora flow through the chat_sync_events outbox, drained by the chat-agora-sync worker. chat_message_save and chat_webhook_ingest are retired (drop pending).

chat_messages carries shared_post_ids, reply_to_message_id and attachment_meta (mime, name, size, duration_ms, and for recorded voice notes peaks: up to 48 integers 0..100, the waveform normalised to the note's own peak, per asset id; client-written jsonb, no schema change); workspace_members.active flips enqueue member_add/member_remove for every group channel the user is in.

Marks: chat_message_marks, one per message, types commitment/decision (commitment/decision/pending are all resolvable by any member (Delivered / Closed / Completed) via chat_mark_resolve; chat_mark_reopen (any member) returns a resolved mark to open; resolved rows stay as history; marks hidden by the caller's clear, same as messages.) and pending (resolvable by any member, optional priority 1 or 2). Delete: chat_message_delete soft-deletes the caller's own messages only, never marked ones. shared_brief_ids alongside shared_post_ids.

chat_message_edit(p_message_id text, p_channel_id text, p_body text, p_trace_id uuid, p_mentions jsonb default null): own message only, body and mentions only, 15 min window from created_at, blocked when marked or deleted; sets edited_at.
chat_message_delete: own messages only, 30 min window from created_at (none in a notes channel), blocked when marked. The tombstone also clears shared_plan_ids (20261009163000_chat_plan_share.sql).
Notes channels (20261003170000_notes_channel_and_search_kind.sql): chat_message_delete has no time window for messages in a notes channel; DM and group messages keep the 30 minute window. Own-only and the marked block still apply.
chat_message_search(p_workspace_id uuid, p_query text, p_trace_id uuid, p_channel_id text default null, p_before_created_at timestamptz default null, p_before_id text default null, p_limit integer default 30, p_kind text default null) RETURNS SETOF chat_messages, SQL STABLE SECURITY INVOKER (search_path public, pg_temp; EXECUTE to authenticated only), 8 args (the old 7-arg version is dropped). New p_kind filter: photo = an attachment_meta entry with mime image/*, voice = audio/*, file = any other attachment, link = body matches http(s)://. An empty query is allowed only together with p_kind; no query and no kind returns no rows. An unknown p_kind returns no rows. Rows stay limited by chat_messages RLS, so notes rows reach only their owner.
Tombstone: delete sets deleted_at, wipes every content column (body, mentions, attachment_asset_ids, attachment_meta, shared_post_ids, shared_brief_ids set to null) and keeps the row, so members still read it and render "Message deleted". Existing deleted rows were wiped the same way. Recorded in 20260929120000_chat_delete_tombstone.sql.

Forward: forwarded_from_message_id, same workspace only, source must be readable by the sender. Clear for me: chat_channel_clears(channel_id, user_id, cleared_at); the chat_messages read policy hides rows at or before the caller's cleared_at; other members unaffected.

Chat files are private to their chat: assets.origin='chat', never listed in Assets, readable only by uploader or members of a chat holding the message.

Applied to live 2026-09-22 and recorded in 20260922200000_chat_postgres_record.sql (idempotent). chat_messages is partitioned monthly.

### chat_channels

PK channel_id (text, ^(dm|group|notes)__[a-f0-9-]{36}__.+$). Fields: workspace_id FK, channel_type (dm / group / notes), entity_id uuid nullable (the group id for group channels), dm_user_a / dm_user_b nullable FK auth.users.id (dm_user_a < dm_user_b), owner_user_id nullable FK auth.users.id (notes only), agora_group_id nullable (unique where not null), last_synced_at nullable, created_at. Channel ids: dm__W__min(A,B)__max(A,B); group__W__G; notes__W__U.

Notes (20261003170000_notes_channel_and_search_kind.sql): channel_type adds 'notes' (channel_id regex now ^(dm|group|notes)__...). New column owner_user_id uuid nullable FK auth.users.id, set only for notes rows (chat_channels_shape requires it null for dm / group / plan_period and non-null for notes). Notes channel_id = notes__<workspace_id>__<owner_user_id>, enforced by chat_channels_shape: one personal notes channel per person per workspace. Notes channels have no Agora group (no agora_group_id, no chat_sync_events).

Notes channel: client calls notes_channel_ensure on Chat home load; no Agora; sync by catch-up on open/focus.

notes_channel_ensure(p_workspace_id uuid, p_trace_id uuid) RETURNS text (the channel_id), SECURITY DEFINER (search_path='', EXECUTE to authenticated only; revoked from PUBLIC and anon): requires auth.uid(), p_trace_id and an active workspace member ('workspace_member_only'). Idempotent (ON CONFLICT DO NOTHING); writes one audit_log row (action notes_channel_ensure, entity chat_channel) only when the row is created.

chat_channel_member(p_channel_id text, p_user_id uuid) RETURNS boolean, SQL STABLE SECURITY DEFINER (search_path='', EXECUTE to authenticated only): true when p_user_id is an active workspace_members row of the channel's workspace AND, for a dm channel, is dm_user_a or dm_user_b, or, for a group channel, has a group_members row for entity_id, or, for a notes channel, is owner_user_id (owner only). Every chat SELECT policy and every chat proc below gates on it.

### chat_messages (partitioned by created_at, monthly)

PK (id, created_at). Fields: id text (the client-generated uuid_v7, stored as text), channel_id FK chat_channels ON DELETE CASCADE, workspace_id FK, sender_user_id nullable FK auth.users.id, body nullable (1 to 5000 chars when present), mentions jsonb nullable (JSON array of user uuids, channel members only, max 50, null when none; CHECK chat_messages_mentions_is_array), attachment_asset_ids uuid[] nullable, shared_plan_ids uuid[] nullable (plans shared into the chat by chat_plan_share; added on the partitioned parent, present on every partition; 20261009163000_chat_plan_share.sql), thread_root_message_id text nullable (top-level message id of the reply's thread; null for non-replies; set only by trigger), agora_event_id text NULLABLE (null for every row written by chat_message_send; only legacy mirror rows carry a value), created_at (server-stamped now()), edited_at / deleted_at nullable. Unique (agora_event_id, created_at). Indexes: chat_messages_channel_created_idx (channel_id, created_at desc, id) for history pagination, chat_messages_id_idx (id) for the idempotent lookup, chat_messages_attachment_asset_ids_gin GIN (attachment_asset_ids) for the chat_attachment_readable containment lookup (created on the partitioned parent, present on every partition), chat_messages_thread_root_idx (channel_id, thread_root_message_id, created_at) WHERE thread_root_message_id IS NOT NULL for per-thread reads (parent + every partition), plus the baseline channel / sender / workspace indexes. Partitions: monthly through 2028_12 plus a DEFAULT (section 11).

RLS: chat_messages_select_channel_member (SELECT to authenticated) USING chat_channel_member(channel_id, auth.uid()) AND created_at > chat_cleared_at(channel_id, auth.uid()). It no longer filters deleted_at: deleted rows stay readable to members as wiped tombstones (20260929120000_chat_delete_tombstone.sql); outsiders still read nothing. The former workspace-wide chat_messages_select_member policy is dropped. No direct INSERT/UPDATE/DELETE policies.

chat_message_send(p_id uuid, p_channel_id text, p_trace_id uuid, p_body text default null, p_mentions jsonb default null, p_attachment_asset_ids uuid[] default null, p_shared_post_ids uuid[] default null, p_reply_to_message_id text default null, p_attachment_meta jsonb default null, p_shared_brief_ids uuid[] default null, p_forwarded_from_message_id text default null) RETURNS chat_messages, SECURITY DEFINER (search_path='', EXECUTE to authenticated only): the only write path, 11 args. Requires auth.uid(), p_id and p_trace_id; raises 'message has no body, attachments, shared posts or shared briefs' when the trimmed body is empty and all three arrays are empty, 'body exceeds 5000 characters' past the cap, and 'not a member of this chat' unless chat_channel_member. p_reply_to_message_id must be a message in the same channel ('reply target not in this chat'); p_forwarded_from_message_id must be a non-deleted message in the same workspace in a channel the sender is a member of ('forward source not accessible'). p_mentions is resolved to channel members by chat_mentions_resolve, and each mentioned user gets an urgent 'mention' inbox_entries row. p_attachment_asset_ids, p_attachment_meta, p_shared_post_ids and p_shared_brief_ids are stored as given (no existence or workspace check). Takes pg_advisory_xact_lock(hashtext(p_id)) and, when a row with that id already exists, returns it unchanged (idempotent retry); otherwise inserts with sender_user_id = auth.uid(), created_at = now(), agora_event_id null, and returns the new row.

chat_plan_share(p_id uuid, p_channel_id text, p_plan_id uuid, p_trace_id uuid, p_body text default null) RETURNS chat_messages, SECURITY DEFINER (search_path='', EXECUTE to authenticated only): any active workspace member who is in the chat posts one message carrying shared_plan_ids = [p_plan_id] (and an optional body); a client plan may be shared into any chat the caller is in, a team plan only by the agency side ('plan not available' for a client caller or a plan from another workspace) and never into a chat with an active client member ('plan_not_shared_with_client'); 'not a member of this chat' for a non-member; idempotent on p_id; one audit_log row 'chat_plan_share' with by_client in the payload. Recorded in 20261009163000_chat_plan_share.sql.

chat_attachment_readable(p_asset_version_id uuid, p_user_id uuid) RETURNS boolean, SQL STABLE SECURITY DEFINER (search_path=''; EXECUTE revoked from PUBLIC, anon, authenticated; granted to service_role only): true when the version has asset_versions.uploaded_by = p_user_id (20261005040000_chat_files_stay_in_chat.sql; was assets.uploaded_by), or a chat_messages row has attachment_asset_ids @> array[p_asset_version_id], deleted_at null, chat_channel_member(channel_id, p_user_id), and created_at > coalesce(chat_cleared_at(channel_id, p_user_id), '-infinity'). Recorded in 20260930160000_assets_origin_chat_private.sql.

Trigger: chat_messages_thread_root (BEFORE INSERT OR UPDATE OF reply_to_message_id on chat_messages, FOR EACH ROW, chat_messages_set_thread_root(), plpgsql, search_path=''): reply_to_message_id null sets thread_root_message_id null; otherwise thread_root_message_id = coalesce(parent.thread_root_message_id, parent.id) where the parent is the reply target in the same channel_id. A reply to a reply (or to a deleted tombstone) inherits the top-level root. chat_message_send has no thread root parameter. Existing replies were backfilled. Recorded in 20261003120000_chat_thread_root.sql.

chat_thread_reply_counts(p_trace_id uuid, p_channel_id text, p_root_ids text[]) RETURNS TABLE (root_id text, reply_count bigint, last_reply_at timestamptz), SQL STABLE SECURITY INVOKER (search_path=''; EXECUTE revoked from PUBLIC, granted to authenticated): per thread root in p_channel_id, the count of non-deleted replies and the latest reply created_at; only the first 200 entries of p_root_ids are considered. chat_messages RLS applies, so a non-member reads zero rows. Recorded in 20261003120000_chat_thread_root.sql.

### chat_reactions

PK (message_id, user_id, emoji). Fields: message_id text, channel_id FK chat_channels ON DELETE CASCADE, workspace_id FK workspaces ON DELETE CASCADE, user_id FK auth.users.id ON DELETE CASCADE, emoji 1 to 16 chars, created_at. Index chat_reactions_message_idx (message_id).

RLS: chat_reactions_select_channel_member (SELECT to authenticated) USING chat_channel_member(channel_id, auth.uid()). No direct write policies. Writes go through chat_reaction_add(p_message_id, p_channel_id, p_emoji, p_trace_id) (member-gated; the message must exist in that channel else 'message not found'; ON CONFLICT DO NOTHING) and chat_reaction_remove(p_message_id, p_channel_id, p_emoji, p_trace_id) (deletes only the caller's own reaction). Both RETURNS void, SECURITY DEFINER (search_path='', EXECUTE to authenticated only).

### chat_read_cursors

PK (channel_id, user_id). Fields: channel_id FK chat_channels ON DELETE CASCADE, user_id FK auth.users.id ON DELETE CASCADE, workspace_id FK workspaces ON DELETE CASCADE, last_read_message_id text, last_read_at timestamptz, updated_at default now().

RLS: chat_read_cursors_select_channel_member (SELECT to authenticated) USING chat_channel_member(channel_id, auth.uid()). No direct write policies. chat_read_cursor_set(p_channel_id, p_message_id, p_trace_id) RETURNS void, SECURITY DEFINER (search_path='', EXECUTE to authenticated only): member-gated, the message must exist in that channel else 'message not found'; upserts the caller's cursor to (p_message_id, that message's created_at) and only moves forward (the ON CONFLICT update applies when the new last_read_at is later than the stored one).

### chat_sync_events

Outbox for membership and rename changes that must reach Agora; drained by the chat-agora-sync worker as service_role. PK id uuidv7. Fields: workspace_id FK workspaces ON DELETE CASCADE, event_type (member_add / member_remove / group_rename), channel_id text (group__{workspace_id}__{group_id}), user_id uuid nullable (the member for member_* events), payload jsonb default {} ({name} for group_rename), created_at, processed_at nullable, attempts int default 0, last_error nullable. Partial index chat_sync_events_pending_idx (created_at) where processed_at is null.

RLS enabled with NO policies: anon and authenticated read zero rows; only service_role (BYPASSRLS) reads and writes it.

Triggers: chat_sync_group_members (AFTER INSERT OR DELETE on group_members, chat_sync_enqueue_member()) enqueues member_add on insert and member_remove on delete; chat_sync_groups_rename (AFTER UPDATE OF name on groups, chat_sync_enqueue_rename()) enqueues group_rename only when the name actually changed. Both trigger functions are SECURITY DEFINER, search_path='', EXECUTE revoked from PUBLIC.

Known: the member trigger inserts a row that references the workspace, so a hard DELETE of a workspace that still has group_members rows fails the chat_sync_events workspace FK during the cascade. The app soft-deletes workspaces; the RLS test cleanup deletes group_members first.

Retired: chat_message_save and chat_webhook_ingest are removed (dropped in 20260923094800_chat_drop_retired_procs.sql).

### chat_scheduled_messages

PK id uuid (client-generated). Fields: channel_id text FK chat_channels ON DELETE CASCADE, workspace_id FK workspaces ON DELETE CASCADE, sender_user_id FK auth.users.id ON DELETE CASCADE, body nullable (CHECK chat_scheduled_messages_body_check: null or at most 5000 chars), mentions jsonb nullable, attachment_asset_ids / shared_post_ids / shared_brief_ids uuid[] nullable, reply_to_message_id text nullable, attachment_meta jsonb nullable, send_at timestamptz, status text default 'scheduled' (CHECK chat_scheduled_messages_status_check: scheduled / sent / cancelled / failed), failure_reason nullable, sent_at nullable, created_at / updated_at default now(). Indexes: chat_scheduled_due_idx (send_at) WHERE status = 'scheduled', chat_scheduled_sender_idx (sender_user_id, channel_id, send_at), chat_scheduled_channel_idx (channel_id), chat_scheduled_workspace_idx (workspace_id).

RLS: chat_scheduled_select_own (SELECT to authenticated) USING sender_user_id = auth.uid(). No write policies. Table grants: authenticated SELECT only; anon none; service_role only REFERENCES / TRIGGER / TRUNCATE / MAINTAIN (no CRUD); srtdio_readonly SELECT. All writes go through the SECURITY DEFINER procs below (all search_path='').

- chat_message_schedule(p_id uuid, p_channel_id text, p_send_at timestamptz, p_trace_id uuid, p_body text default null, p_mentions jsonb default null, p_attachment_asset_ids uuid[] default null, p_shared_post_ids uuid[] default null, p_shared_brief_ids uuid[] default null, p_reply_to_message_id text default null, p_attachment_meta jsonb default null) RETURNS chat_scheduled_messages (EXECUTE to authenticated only). Requires auth.uid(), p_id and p_trace_id. An existing row with p_id is returned unchanged for its sender ('not found' for anyone else). Raises on empty content, body over 5000, send_at outside [now() + 1 minute, now() + 365 days] ('send time must be between 1 minute and 1 year from now'), non-member ('not a member of this chat'), 100 or more of the caller's rows in status scheduled ('too many scheduled messages'), an attachment version not in the channel's workspace and neither library-origin nor chat_attachment_readable ('attachment not available'), and a reply target outside the channel. Resolves mentions via chat_mentions_resolve. Audits chat_message_schedule.
- chat_scheduled_update(p_id uuid, p_send_at timestamptz, p_body text, p_mentions jsonb, p_trace_id uuid) RETURNS chat_scheduled_messages (EXECUTE to authenticated only). Caller's own row in status scheduled or failed only ('scheduled message not found'); same send_at window, body cap and content checks; the 100 cap applies when reviving a failed row. Sets send_at, body, mentions, status scheduled, failure_reason null; clears the failed inbox entry. Audits chat_scheduled_update.
- chat_scheduled_cancel(p_id uuid, p_trace_id uuid) RETURNS void (EXECUTE to authenticated only). Caller's own scheduled or failed row to cancelled ('scheduled message not found' otherwise); clears the failed inbox entry. Audits chat_scheduled_cancel.
- chat_scheduled_send_now(p_id uuid, p_trace_id uuid) RETURNS chat_messages (EXECUTE to authenticated only). Caller's own scheduled or failed row; sends via chat_message_send with id = the scheduled id, marks sent, clears the failed inbox entry. Audits chat_scheduled_send_now.
- chat_scheduled_due(p_limit integer) RETURNS SETOF uuid, SQL STABLE (EXECUTE to service_role only): ids with status scheduled and send_at <= now(), ordered by send_at, limit clamped to 1..500 (default 100).
- chat_scheduled_dispatch(p_id uuid, p_trace_id uuid) RETURNS SETOF chat_messages (EXECUTE to service_role only): locks a due scheduled row (FOR UPDATE SKIP LOCKED), sets the JWT claims to the sender, calls chat_message_send. On success marks sent and writes a scheduled_sent inbox entry (payload scheduled_id, message_id); on failure marks failed with failure_reason (first 200 chars) and writes a scheduled_failed entry (payload scheduled_id). Audits chat_scheduled_dispatch success / failure.
- chat_scheduled_outcome_entry(s chat_scheduled_messages, p_event text, p_payload jsonb) RETURNS void (no grants; internal): inserts the sender's inbox_entries row, entity chat_channel, scope groups for a group channel else people, scope_key channel_id, tier urgent for scheduled_failed else active, actor_user_id null.
- chat_scheduled_clear_failed(p_user_id uuid, p_scheduled_id uuid) RETURNS void, SQL (no grants; internal): marks the user's unread scheduled_failed entries for that scheduled_id read.

Recorded in 20261003130000_chat_scheduled_send.sql.

### chat_message_reminders

PK id uuid (client-generated). Fields: user_id FK auth.users.id ON DELETE CASCADE (the person reminded), message_id text (no FK; chat_messages is partitioned), channel_id text FK chat_channels ON DELETE CASCADE, workspace_id FK workspaces ON DELETE CASCADE, remind_at timestamptz, fired_at nullable, cancelled_at nullable, created_at default now(). A reminder is pending while fired_at and cancelled_at are both null. Indexes: chat_reminders_one_active UNIQUE (user_id, message_id) WHERE pending (one pending reminder per person per message), chat_reminders_due_idx (remind_at) WHERE pending, chat_reminders_user_idx (user_id, workspace_id, remind_at), chat_reminders_channel_idx (channel_id), chat_reminders_workspace_idx (workspace_id), chat_reminders_message_idx (message_id).

RLS: chat_reminders_select_own (SELECT to authenticated) USING user_id = auth.uid(): own rows only. No write policies. Table grants: authenticated SELECT only; anon none. All writes go through the SECURITY DEFINER procs below (all search_path='').

- chat_reminder_set(p_id uuid, p_message_id text, p_channel_id text, p_remind_at timestamptz, p_trace_id uuid) RETURNS void (EXECUTE to authenticated only). Requires auth.uid(), p_id and p_trace_id. An existing row with p_id is a no-op. Raises on remind_at outside [now() + 1 minute, now() + 365 days] ('reminder must be between 1 minute and 1 year from now'), non-member ('not a member of this chat'), and a message that is deleted or not in p_channel_id ('message not found'). Also replaces the caller's pending reminder on that message (the earlier one is cancelled, then the new one inserted), which is how "Change time" works. Audits chat_reminder_set.
- chat_reminder_cancel(p_id uuid, p_trace_id uuid) RETURNS void (EXECUTE to authenticated only). Requires auth.uid() and p_trace_id. Cancels the caller's own pending reminder; any other id (someone else's, already fired or cancelled, unknown) is a silent no-op. Audits chat_reminder_cancel when a row changed.
- chat_reminders_fire(p_limit integer default 500) RETURNS integer (no grants; cron only). Run by pg_cron job chat-reminders-fire every minute (`select public.chat_reminders_fire(500)`). Locks up to p_limit (clamped 1..2000) due pending reminders (FOR UPDATE SKIP LOCKED), sets fired_at, and writes one 'reminder' inbox_entries row per reminder: tier urgent, entity chat_channel, entity_id and scope_key channel_id, scope groups for a group channel else people, payload {message_id, reminder_id}, actor_user_id null. Skips people no longer in the chat (chat_channel_member false) and deleted messages: those are marked fired with no entry. Returns the number of entries written.
- Trigger chat_messages_reminders_on_delete (AFTER UPDATE OF deleted_at ON chat_messages, when deleted_at goes from null to not null) runs chat_messages_reminders_on_delete() (no grants): cancels every pending reminder on that message.

Recorded in 20261003140000_chat_message_reminders.sql.

### chat_message_stars

PK (user_id, message_id). Fields: user_id FK auth.users.id ON DELETE CASCADE (the person who starred), message_id text (no FK; chat_messages is partitioned with PK (id, created_at), same as chat_message_marks), message_created_at timestamptz (the starred message's created_at, used to join back to chat_messages and to order), channel_id text FK chat_channels ON DELETE CASCADE, workspace_id FK workspaces ON DELETE CASCADE, starred_at timestamptz default now(). Stars are private: each person sees only their own. Indexes: chat_message_stars_user_ws_idx (user_id, workspace_id, message_created_at DESC), chat_message_stars_user_channel_idx (user_id, channel_id, message_created_at DESC), chat_message_stars_message_idx (message_id), chat_message_stars_channel_idx (channel_id), chat_message_stars_workspace_idx (workspace_id).

RLS: chat_message_stars_select_own (SELECT to authenticated) USING user_id = auth.uid() AND chat_channel_member(channel_id, auth.uid()): own rows in chats the caller is still in. No write policies. Table grants: authenticated SELECT only (INSERT, UPDATE, DELETE revoked); anon none. All writes go through chat_message_star_set.

- chat_message_star_set(p_message_ids text[], p_channel_id text, p_starred boolean, p_trace_id uuid) RETURNS void, SECURITY DEFINER (search_path=''; EXECUTE to authenticated only). Requires auth.uid(), p_trace_id ('trace id required') and p_starred ('starred flag required'); 1 to 100 ids ('select between 1 and 100 messages'); member only ('not a member of this chat'). p_starred true: every id must be a live message in p_channel_id after the caller's clear, else 'message not found' (deleted and cleared-away messages are refused); already-starred ids are a no-op. p_starred false: removes the caller's stars on those ids in that channel; unknown ids are a no-op. Idempotent. Writes one audit_log row per call that changed rows: chat_message_star or chat_message_unstar, entity chat_channel / p_channel_id, payload {count}. A call that changes nothing writes no audit row.
- chat_message_starred_list(p_workspace_id uuid, p_trace_id uuid, p_channel_id text default null, p_query text default null, p_before_created_at timestamptz default null, p_before_id text default null, p_limit integer default 30) RETURNS SETOF chat_messages, SQL STABLE SECURITY INVOKER (search_path public, pg_temp; EXECUTE to authenticated only). The caller's own stars in the workspace only, joined to chat_messages (RLS on both tables applies), skipping deleted messages; newest message first (created_at desc, id desc); keyset paging via p_before_created_at + p_before_id; optional p_channel_id filter; optional p_query prefix text search with the same rules as chat_message_search (simple tsvector over body, each term a prefix, query trimmed length 2 to 100, else no rows); p_limit clamped 1 to 50. Writes nothing (allowlisted in tests/rls/trace-id-usage.test.ts).
- Trigger chat_messages_stars_on_delete (AFTER UPDATE OF deleted_at ON chat_messages, when deleted_at goes from null to not null) runs chat_messages_stars_on_delete() (no grants): deletes every star on that message (mirrors chat_messages_reminders_on_delete).
- Clear for me: a cleared chat hides its stars. chat_message_starred_list returns nothing at or before the caller's cleared_at (chat_messages RLS), and starring a pre-clear message raises 'message not found'.

Recorded in 20261004050000_chat_message_stars.sql.

## 8. Inbox and delivery

Inbox is the only permanent in-app event surface. Email is out-of-app catch-up, bundled 9am to 9pm workspace TZ.

### inbox_entries (partitioned by created_at, monthly)

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | PK part |
| user_id | uuid | FK auth.users.id (the recipient) |
| actor_user_id | uuid | nullable, FK public.users.id ON DELETE SET NULL: the user who performed the event, distinct from user_id which is the recipient |
| workspace_id | uuid | FK workspaces.id |
| event_type | text | see enums (publish/approval/plan values removed) |
| entity_type | text | nullable: post / brief / plan_cell / plan_period / chat_channel / workspace / plan_item (see section 12) |
| entity_id | text | nullable, 1 to 200 |
| scope | text | everything / posts / briefs / people / groups / clients |
| scope_key | text | nullable |
| tier | text | urgent / active / ambient, default active |
| payload | jsonb | default {} |
| read_at / snoozed_until / email_sent_at / deleted_at | timestamptz | nullable |
| created_at | timestamptz | PK part, default now() |

PK (id, created_at). Partitions: 2026_05, 2026_06, 2026_07. actor_user_id is set by the seven procs that fan out into inbox_entries (checkpoint_ask, checkpoint_send_back, comment_batch_create, comment_create, comment_resolve, post_ready_notify, stage_transition); it is permanently null on stage_change and post_ready rows written before this change, because the actor was never recorded at the time.

inbox_mark_read_events(p_workspace_id uuid, p_event_types text[], p_trace_id uuid) RETURNS void, SECURITY DEFINER (search_path=''; EXECUTE to authenticated only): requires is_active_workspace_member ('workspace_member_only') and p_trace_id; marks the caller's unread, non-deleted entries in the workspace whose event_type is in p_event_types read; no-op for an empty list; audits inbox_mark_read_events with the count when any row changed. Recorded in 20261003130000_chat_scheduled_send.sql.

Where inbox entries are shown:

- Chat bell only, never Activity: mention with entity_type chat_channel, scheduled_sent, scheduled_failed, reminder.
- Activity: everything else, including mentions on posts and briefs.
- inbox_mark_all_read (Activity Mark all read) skips bell types.
- plan_comment and plan_review (entity_type plan_item, entity_id = item id, tier active; 20261009205500_plan_item_comments.sql): plan events use scope 'posts', scope_key = plan id.

Decision 3 Oct 2026 (Shubham): Activity is posts only; chat notifications live in the chat bell.

### email_threads

PK id. Fields: workspace_id FK, root_type (brief / post), root_id, message_id ^<(brief|post)-...@srtd.io>$, subject 1 to 998, created_at, last_sent_at nullable. Unique message_id; (workspace_id, root_type, root_id).

### delivery_attempts

PK id. Fields: workspace_id nullable FK, user_id nullable FK, channel (email / push), template_key 1 to 100, provider (resend / fcm / apns / web_push), provider_message_id nullable, status (queued / sent / delivered / bounced / complained / failed, default queued), error/sent_at/delivered_at/bounced_at nullable, created_at, email_thread_id nullable FK.

### webhook_events

Feeds the Agora chat mirror and other sources. PK id. Fields: source (stripe / resend / linkedin), source_event_id 1 to 200, event_type 1 to 100, workspace_id nullable FK, signature_verified boolean, raw_payload jsonb up to 1MB, received_at. Unique (source, source_event_id). (See section 12: source enum has no agora value yet.)

### webhook_processing_attempts

PK id. Fields: webhook_event_id FK, attempt_number > 0, started_at, finished_at nullable, outcome (success / failure / skipped) nullable, error nullable, trace_id.

## 9. Platform ops (Cockpit)

### audit_log (partitioned by created_at, monthly)

PK (id, created_at). Fields: workspace_id nullable, actor_user_id nullable FK auth.users.id, on_behalf_of nullable FK, impersonation_session_id nullable, action, entity_type / entity_id nullable, payload jsonb up to 64KB (partitions also reject bearer tokens, AWS keys, sk_live, JWTs), outcome (success / failure), error_code nullable, trace_id, ip_subnet nullable, created_at. Partitions: 2026_05, 2026_06, 2026_07.

### feature_flags

PK id. Fields: workspace_id nullable FK, flag_name ^[a-z][a-z0-9_]{0,99}$, category (killswitch / rollout / experiment / tier_gated), enabled default false, rollout_percentage in {0,10,25,50,100}, tier_min nullable, reason nullable, updated_by nullable FK, updated_at. Unique on (COALESCE(workspace_id,'GLOBAL'), flag_name).

### cockpit_access_log

PK id. Fields: operator_user_id FK auth.users.id, route 1 to 500, workspace_id nullable FK, session_id, accessed_at, trace_id.

### cockpit_procedure_allowlist

PK procedure_name. Fields: description 1 to 1000, risk_tier (tap / medium / nuclear), added_at, added_by FK users.id.

### intent_ledger

PK id. Fields: operator_user_id FK, action 1 to 100, target_type nullable (workspace / user / flag / deploy / share_token), target_id nullable, payload jsonb, status (pending / committed / failed / expired, default pending), reason_category nullable, reason_text nullable (>= 10), ticket_id nullable, created_at, committed_at nullable, expires_at default now()+1h, trace_id. (See section 12: target_type still lists share_token, now dead.)

### pending_flows

PK id. Fields: operator_user_id FK, flow_type (billing_override / sentry_inspect / cf_purge / gh_diff), external_system (stripe / sentry / cloudflare / github / resend), external_ref nullable, payload jsonb, status (open / resolved / discarded / expired, default open), created_at, resolved_at nullable, expires_at default now()+1h.

## 10. Enumerations reference

- post.stage: draft, review, approved, parked, rejected
- post.origin: manual, brief
- post.platform / asset platform values: linkedin, x, instagram, facebook, threads
- post.format: text, single_image, carousel, video, link
- workspace_members.role: owner, admin, agency, client
- workspace.plan_tier: solo, studio, agency, enterprise
- workspace.subscription_state: trial, active, read_only, grace, soft_pause, full_pause, soft_delete
- brief.status: open, closed
- approval (table removed): n/a, approval is now a post.stage value
- inbox_entries.event_type: comment, mention, stage_change, comment_resolved, brief_created, brief_closed, asset_uploaded, asset_version_added, invite, trial_warning, billing_failure, system, checkpoints_added, post_ready, scheduled_sent (tier active), scheduled_failed (tier urgent), reminder (tier urgent), post_deleted (tier active), assets_deleted (tier active), plan_comment (tier active), plan_review (tier active) (canonical list: INBOX_EVENT_TYPES in @srtdio/schemas; 23 values)
- inbox_entries.scope: everything, posts, briefs, people, groups, clients
- inbox_entries.tier: urgent, active, ambient
- chat_channels.channel_type: dm, group, notes
- chat_sync_events.event_type: member_add, member_remove, group_rename
- audit_log.outcome: success, failure

## 11. Partitioning reference

Three tables are range-partitioned by created_at, monthly:

- audit_log -> audit_log_2026_05, _2026_06, _2026_07
- chat_messages -> chat_messages_2026_05, _2026_06, _2026_07
- inbox_entries -> inbox_entries_2026_05, _2026_06, _2026_07

Each carries (id, created_at) composite PK. New monthly partitions must be created ahead of time.

## 12. Known leftover traces

These are dead references from the pre-MVP schema. Harmless (they only widen a CHECK or name a now-missing concept), but listed so they can be cleaned in a later migration if desired:

- comments.entity_type and inbox_entries.entity_type still allow plan_cell / plan_period. Plan is removed, so these values will never be written.
- chat_channels_shape and chat_channel_member still carry a plan_period branch. channel_type (dm, group, notes) and the channel_id regex (^(dm|group|notes)__) no longer allow plan or plan_period, so the branch can never match.
- intent_ledger.target_type still lists share_token. share_tokens table is dropped.
- webhook_events.source lists stripe / resend / linkedin but not agora. To store the Agora chat webhook entry you wanted, this enum likely needs an agora value added.

Counts: 33 base tables + 3 partitioned parents + 9 partition children = 45 relations in public (idempotency_keys, asset_renditions, and folders added since this line was first written). All RLS enabled.
