# Sorted v2 Schema (MVP)

Generated from live database movnexawfhsyuluspxoc (srtdio-v2) after the MVP stripdown.
This file is the human-readable design reference. The migrations folder is implementation truth.

Sorted v2 MVP is a social-media approval tool: client writes a brief, agency drafts a post, post moves through review to approved, rejected, or parked. No publishing, no scheduling, no plan. Chat is Agora (DB mirror only). Email is out-of-app catch-up.

All tables are in schema `public`, all have RLS enabled. `id` uses `uuidv7()` unless noted. Timestamps are `timestamptz`. `*_by` FK columns are SET NULL on delete except `workspaces.owner_user_id` (RESTRICT) and `asset_attachments` (NO ACTION).

## Index

1. Identity and access: users, workspaces, workspace_members, workspace_role_permissions, workspace_settings, workspace_onboarding, session_devices, platform_operators
2. Content: workspace_buckets, posts, post_versions, post_annotations
3. Discussion: comments, comment_reactions
4. Briefs: briefs
5. Assets: assets, asset_versions, asset_attachments, folders
6. People grouping: groups, group_members
7. Chat (Agora mirror): chat_channels, chat_messages
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
| target_date | timestamptz | nullable, indicative only, no engine in MVP |
| origin | text | manual / brief, default manual |
| brief_id | uuid | nullable, FK briefs.id, SET NULL |
| row_version | bigint | default 1 |
| created_by | uuid | FK users.id, SET NULL |
| legacy_author_name | text | nullable, frozen original v1 author/creator name shown when the live created_by is null, used by the detail pages with an "(ex-member)" fallback |
| created_at / updated_at / deleted_at | timestamptz | deleted_at nullable |

Stage CHECK: draft, review, approved, parked, rejected. No publish/schedule/platform columns. Indexes: (workspace_id, stage, created_at desc), (workspace_id, target_date) where target_date not null, brief_id partial, owner partial. All where deleted_at null.

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

Two primitives: Comments (Postgres, here) and Chat (Agora, section 7).

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

## 5. Assets

Versioned. Attachments bind to a specific asset_version_id.

### assets

PK id. Fields: workspace_id FK, filename 1 to 500, display_name text nullable (human label, backfilled from post title), current_version_id nullable FK asset_versions.id, folder_id nullable FK folders.id (SET NULL on folder delete), folder_path default '/', tags text[] default {}, uploaded_by FK users.id, uploaded_at, deleted_at nullable. Indexes: FTS filename, gin tags, (workspace_id, folder_path), (workspace_id, folder_id), (workspace_id, uploaded_at desc). All where deleted_at null.

folder_id and folder_path coexist for now: folder_id is the new structured folder reference, folder_path is the legacy string path. folder_path remains present pending a later reconciliation decision; no migration drops or backfills either column yet.

### asset_versions

PK id. Fields: asset_id FK, workspace_id FK, version_number, r2_key unique, mime_type, sha256 ^[a-f0-9]{64}$, size_bytes > 0, width/height/duration_ms nullable > 0, uploaded_by FK, uploaded_at. Unique (asset_id, version_number).

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

### group_members

PK (group_id, user_id). Fields: workspace_id FK, joined_at. user_id FK auth.users.id.

### Group + channel procs (A2a)

Six SECURITY DEFINER procs (search_path='', EXECUTE to authenticated only): group_create, group_rename, group_member_add, group_member_remove, group_leave, dm_channel_ensure. group_create also seeds the group chat_channels row; dm_channel_ensure upserts the dm channel. Gating: group_create / dm_channel_ensure require an active workspace member; group_rename / group_member_add / group_member_remove require the group creator or a workspace owner/admin; group_leave is self only.

## 7. Chat (Agora mirror)

Agora owns chat. These tables are a compliance/mirror only, fed by webhook. chat_messages is partitioned monthly.

### chat_channels

PK channel_id (text, ^(dm|group|plan)__[a-f0-9-]{36}__.+$). Fields: workspace_id FK, channel_type (dm / group / plan_period), entity_id uuid nullable, dm_user_a / dm_user_b nullable FK auth.users.id, last_synced_at nullable, created_at.

### chat_messages (partitioned by created_at, monthly)

PK (id, created_at). Fields: id text, channel_id FK, workspace_id FK, sender_user_id nullable FK auth.users.id, body nullable, mentions jsonb nullable, attachment_asset_ids uuid[] nullable, agora_event_id, created_at, edited_at / deleted_at nullable. Unique (agora_event_id, created_at). Partitions: 2026_05, 2026_06, 2026_07.

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
| entity_type | text | nullable: post / brief / plan_cell / plan_period / chat_channel / workspace (see section 12) |
| entity_id | text | nullable, 1 to 200 |
| scope | text | everything / posts / briefs / people / groups / clients |
| scope_key | text | nullable |
| tier | text | urgent / active / ambient, default active |
| payload | jsonb | default {} |
| read_at / snoozed_until / email_sent_at / deleted_at | timestamptz | nullable |
| created_at | timestamptz | PK part, default now() |

PK (id, created_at). Partitions: 2026_05, 2026_06, 2026_07. actor_user_id is set by the seven procs that fan out into inbox_entries (checkpoint_ask, checkpoint_send_back, comment_batch_create, comment_create, comment_resolve, post_ready_notify, stage_transition); it is permanently null on stage_change and post_ready rows written before this change, because the actor was never recorded at the time.

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
- inbox_entries.event_type: comment, mention, stage_change, comment_resolved, brief_created, brief_closed, asset_uploaded, asset_version_added, invite, trial_warning, billing_failure, system, checkpoints_added, post_ready (canonical list: INBOX_EVENT_TYPES in @srtdio/schemas)
- inbox_entries.scope: everything, posts, briefs, people, groups, clients
- inbox_entries.tier: urgent, active, ambient
- chat_channels.channel_type: dm, group, plan_period
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
- chat_channels.channel_type and channel_id regex still allow plan / plan_period channels. No plan periods exist to create them.
- intent_ledger.target_type still lists share_token. share_tokens table is dropped.
- webhook_events.source lists stripe / resend / linkedin but not agora. To store the Agora chat webhook entry you wanted, this enum likely needs an agora value added.

Counts: 33 base tables + 3 partitioned parents + 9 partition children = 45 relations in public (idempotency_keys, asset_renditions, and folders added since this line was first written). All RLS enabled.
