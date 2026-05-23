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
5. Assets: assets, asset_versions, asset_attachments
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
| created_at / updated_at | timestamptz | default now() |

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

Milestone timestamps, all nullable: first_post_at, first_invite_at, linkedin_connected_at, first_brief_at, first_schedule_at, dismissed_at, auto_hidden_at. PK workspace_id. (See leftover note in section 12 re: linkedin/schedule columns.)

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
| created_at / updated_at / deleted_at | timestamptz | deleted_at nullable |

Stage CHECK: draft, review, approved, parked, rejected. No publish/schedule/platform columns. Indexes: (workspace_id, stage, created_at desc), (workspace_id, target_date) where target_date not null, brief_id partial, owner partial. All where deleted_at null.

### post_versions

Immutable edit history. No deleted_at. PK id. Fields: post_id FK, workspace_id FK, version_number, snapshot jsonb, created_by FK users.id SET NULL, created_at. Unique (post_id, version_number).

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
| body | text | 1 to 10000 |
| mentions | jsonb | nullable |
| attachment_asset_ids | uuid[] | nullable |
| is_decision | boolean | default false |
| edited_at / deleted_at | timestamptz | nullable |
| created_at | timestamptz | default now() |

Indexes: FTS on body, entity, parent, author, decision partial. All where deleted_at null.

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
| created_via | text | app / email_forward, default app |
| row_version | bigint | default 1 |
| created_at / updated_at / deleted_at | timestamptz | deleted_at nullable |

Indexes: (workspace_id, status, created_at desc), target_date partial, created_by, FTS on title+objective.

## 5. Assets

Versioned. Attachments bind to a specific asset_version_id.

### assets

PK id. Fields: workspace_id FK, filename 1 to 500, current_version_id nullable FK asset_versions.id, folder_path default '/', tags text[] default {}, uploaded_by FK users.id, uploaded_at, deleted_at nullable. Indexes: FTS filename, gin tags, (workspace_id, folder_path), (workspace_id, uploaded_at desc). All where deleted_at null.

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

## 6. People grouping

### groups

PK id. Fields: workspace_id FK, name ^[A-Za-z0-9 -]{1,40}$, created_by FK, created_at, deleted_at nullable. Unique (workspace_id, lower(name)) where not deleted.

### group_members

PK (group_id, user_id). Fields: workspace_id FK, joined_at. user_id FK auth.users.id.

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
| user_id | uuid | FK auth.users.id |
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

PK (id, created_at). Partitions: 2026_05, 2026_06, 2026_07.

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
- inbox_entries.event_type: comment, mention, stage_change, decision_marked, brief_created, brief_closed, asset_uploaded, asset_version_added, invite, trial_warning, billing_failure, system
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
- workspace_onboarding still has linkedin_connected_at and first_schedule_at columns from the publishing era.

Counts: 33 base tables + 3 partitioned parents + 9 partition children = 45 relations in public. All RLS enabled.
