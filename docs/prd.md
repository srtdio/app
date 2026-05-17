# Sorted v2 PRD

Decisions only. No rationale.

**Last revised:** 17 May 2026

-----

## 1. Goals and scope

|Item                  |Decision                                                               |
|----------------------|-----------------------------------------------------------------------|
|Launch date           |July 2026 (web)                                                        |
|Native mobile         |Deferred. No fixed date. Reassess month 3 post-launch.                 |
|Public signup         |Live at launch. Paid.                                                  |
|v1 tenant cutover     |Separate track. Decoupled from public signup date.                     |
|New tenants pre-launch|Free.                                                                  |
|Launch platform       |LinkedIn only. Other platforms: OAuth + schema only.                   |
|Repo                  |Greenfield. New org srtdio. Supabase Pro Mumbai (movnexawfhsyuluspxoc).|
|Domain                |srtd.io. Cockpit at platform.srtd.io.                                  |
|Total PRs             |67 across 4 batches.                                                   |

## 2. Operating principles

- One workspace = one end-client = one platform. Locked invariant.
- TypeScript strict. No .js or .jsx or .mjs or .cjs. Ever.
- Multi-tenant from day 1. Postgres RLS is the security boundary.
- post.stage = workflow state. publish_status = auxiliary. Never conflated. CHECK constraint enforces legal pairs.
- JWT 15 min + session_devices fingerprint RLS on every auth request.
- Trace ID is an explicit RPC parameter. Not SET LOCAL.
- Discussion has two primitives: Comments (Postgres) and Chat (Agora).
- Inbox is the only permanent in-app event surface.
- Published posts are frozen in Sorted. Edit on LinkedIn. No rollback from Published.
- No section toggles. Every section ships for every workspace.
- Assets are versioned. Attachments bind to asset_version_id.
- Brief is a read-only information document. No spawning.
- Approval is per-post, deliberate. Inside Sorted only. No bulk approve. No magic-link approval.
- Touch targets 44x44 minimum everywhere.
- Email is out-of-app catch-up. Bundled, 9am-9pm workspace TZ.
- No AI features in v2.0. No tables, no workers, no UI.
- All sensitive writes go through SECURITY DEFINER procs. INSERT/UPDATE/DELETE revoked from authenticated role on sensitive tables.
- post_versions and post_annotations are immutable edit history. Never soft-deletable.
- Users are not hard-deleted from auth.users except for GDPR. public.users.deleted_at signals account-level removal. workspace_members.active=false signals workspace-level removal. Either condition surfaces as ‘(ex-member)’ badge in UI.
- Workspace owner cannot delete their own account until ownership is transferred or the workspace is deleted.

## 3. Users, roles, visibility

### Roles

|Role  |Definition                                                                                     |
|------|-----------------------------------------------------------------------------------------------|
|Owner |Workspace creator. Billing, deletion, transfer. Cannot self-delete until ownership transferred.|
|Admin |Full workspace power except billing and deletion.                                              |
|Agency|All sections except admin settings.                                                            |
|Client|Pipeline (everything except Draft), Briefs (own only), Assets, Insights (curated).             |

### Visibility

|Surface |Client sees                                      |
|--------|-------------------------------------------------|
|Pipeline|All stages except Draft                          |
|Briefs  |Own briefs only                                  |
|Assets  |Yes                                              |
|Insights|Curated subset (no click-through, no comparisons)|
|Plan    |TBD (section parked)                             |
|Inbox   |Events involving them                            |

### Capability storage

Capabilities live in workspace_role_permissions keyed by (workspace_id, role, capability). v2.0 has no granular UI; defaults per role. Granular UI is post-launch without schema rewrite.

### User profile (public.users)

Every authenticated user has a public.users row, auto-created via trigger on auth.users insert.

|Field       |Decision                                                                                              |
|------------|------------------------------------------------------------------------------------------------------|
|display_name|Required. 1-80 chars. Editable from profile settings.                                                 |
|designation |Optional. 0-80 chars. e.g. ‘Senior Strategist’, ‘Founder’.                                            |
|avatar_url  |Optional. Stored in R2 bucket user-avatars (shared, public read, auth write via worker).              |
|deleted_at  |Account-level soft-delete. Set when admin removes user OR self-delete. Triggers ‘(ex-member)’ display.|

All *_by columns across schema reference public.users(id) with ON DELETE SET NULL, except workspaces.owner_user_id (RESTRICT). When a user is removed (via deleted_at OR workspace_members.active=false), UI shows their name with ‘(ex-member)’ badge.

## 4. Pricing and trial

### Tiers (per workspace, per month, INR)

|Tier      |Price |Platforms                |Members  |
|----------|------|-------------------------|---------|
|Solo      |499   |1 (add more at same rate)|1        |
|Studio    |749   |1 (add more at same rate)|4        |
|Agency    |999   |1 (add more at same rate)|8        |
|Enterprise|Custom|Unlimited                |Unlimited|

### Pricing rules

- Each tier ships with 1 platform.
- Each additional platform = same tier price added. Agency + Instagram = 999 + 999 = 1998.
- Subscription is per workspace. No caps on workspaces per account.
- v2.0 launches with LinkedIn live. Other platforms purchasable; publishing ships post-launch.

### Trial

|Item                      |Decision                                                                               |
|--------------------------|---------------------------------------------------------------------------------------|
|Duration                  |14 days, account-wide                                                                  |
|Card upfront              |No                                                                                     |
|Nudge cadence             |Day 7, 10, 12, 13, 14 (email + in-app)                                                 |
|Workspaces during trial   |Multiple allowed, created from workspace switcher                                      |
|Conversion                |Per-workspace activation. Owner picks which workspace each paid subscription activates.|
|Non-activated at trial end|Read-only indefinitely. Data retained until owner deletes or upgrades.                 |

### Billing failure ladder (active paid workspaces)

|State                |Behaviour                 |
|---------------------|--------------------------|
|active               |Normal                    |
|grace (3 days)       |Publishing paused. Banner.|
|soft_pause (10 days) |Publishing off. Read-only.|
|full_pause (30 days) |Billing settings only.    |
|soft_delete (60 days)|Recoverable via support.  |
|hard_delete          |Gone.                     |

## 5. Onboarding

|Item                 |Decision                                                                                                                                       |
|---------------------|-----------------------------------------------------------------------------------------------------------------------------------------------|
|Signup form          |Single scroll. Required: name (-> public.users.display_name), email (magic-link), password, workspace name, workspace timezone (auto-detected).|
|Workspaces at signup |Exactly one                                                                                                                                    |
|Additional workspaces|Created from workspace switcher in drawer                                                                                                       |
|First-run state      |Empty Pipeline, empty Plan, empty Inbox, empty Assets                                                                                           |
|Profile completion   |Designation and avatar are optional and added later via profile settings.                                                                      |

### Empty-state checklist (Dashboard card)

|#|Item                   |Action                      |
|-|-----------------------|----------------------------|
|1|Create your first post |Opens Create sheet          |
|2|Invite a teammate      |Opens Invite modal          |
|3|Connect LinkedIn       |OAuth flow                  |
|4|Create your first brief|Opens Brief create sheet    |
|5|Schedule a publish     |Opens Scheduled stage in PCS|

- Owners only. First 30 days.
- Items auto-check on workspace events. No manual.
- Hides on >= 4 of 5 checked OR manual dismiss. Never re-appears after dismiss.
- Per-item Skip link for non-applicable steps.

## 6. Layout and shell

### Shell

|Element         |Decision                                                                                                       |
|----------------|---------------------------------------------------------------------------------------------------------------|
|Topbar          |Workspace switcher, search trigger, Inbox icon (badge), profile menu (avatar + designation)                    |
|Drawer (left)   |Sections: Pipeline, Plan, Briefs, Assets, Insights. Bottom: workspace switcher, Recently deleted (N), Settings.|
|Recently deleted|Bottom of drawer. Tap to expand. Restore button + countdown per workspace.                                     |
|Mobile          |Web-only at v2.0. Native deferred.                                                                             |

### Iconography

|Item         |Decision                                                                 |
|-------------|-------------------------------------------------------------------------|
|Icon style   |Minimal SVG strokes, 1.6px, round caps and joins, currentColor, fill none|
|Icon button  |44x44 frame with 20x20 SVG                                               |
|Touch targets|44x44 minimum everywhere. No exceptions.                                 |
|Hover        |No hover-only interactions                                               |
|Long-press   |Right-click equivalent                                                   |

## 7. Inbox

Permanent in-app event feed. Source of truth for what happened. Only permanent surface; toasts/push/email are ephemeral.

### Structure

|Element                       |Decision                                                 |
|------------------------------|---------------------------------------------------------|
|State chips                   |All, Unread, Snoozed                                     |
|Scopes                        |Everything, Posts, Briefs, Plans, People, Groups, Clients|
|Snooze                        |Yes. Options: 1h, 4h, tomorrow 9am, next week            |
|Inline approve                |No. Click navigates to PCS.                              |
|Inline reply (comments + chat)|Yes. Lands on entity.                                    |

### Events that land in Inbox

- Comments on posts, briefs, plan cells
- Chat messages in DM, group, plan-period channels
- Post stage changes
- Brief created (agency), brief closed
- Asset uploaded, asset version added
- Approvals requested, approvals given/rejected
- @-mentions
- Decision Records flagged
- System events (asset removed, publish failed)

## 8. Pipeline

|Item                 |Decision                                                                                         |
|---------------------|-------------------------------------------------------------------------------------------------|
|Desktop layout       |Vertical kanban by stage                                                                         |
|Mobile layout        |Accordion by stage                                                                               |
|Visual cues          |Owner colors, urgency colors                                                                     |
|Filters              |Owner, channel, content_type, target_date range, has_blocking_comment, has_brief, has_brand_input|
|Saved views          |Per workspace, per user                                                                          |
|Bulk actions (agency)|Move stage, assign owner, add tag, archive. Cap 10 per action.                                   |
|Bulk actions (client)|None                                                                                             |
|Client visibility    |All stages except Draft                                                                          |

### Stages

|Stage            |Definition                                   |
|-----------------|---------------------------------------------|
|Draft            |Agency private. Client cannot see.           |
|Awaiting Approval|Client review required                       |
|Needs Input      |Client feedback returned to agency           |
|Scheduled        |Approved, queued for publish at target_date  |
|Published        |Live on platform. Frozen in Sorted. Terminal.|
|Parked           |Held by agency. Not published.               |
|Rejected         |Client rejected. Closed.                     |

### Stage transition map (locked)

|From             |Can move to                                                                                                                             |
|-----------------|----------------------------------------------------------------------------------------------------------------------------------------|
|draft            |awaiting_approval, parked                                                                                                               |
|awaiting_approval|needs_input, scheduled (approval), parked, rejected                                                                                     |
|needs_input      |awaiting_approval, parked                                                                                                               |
|scheduled        |awaiting_approval, draft, parked, rejected (manual unschedule). published / publishing / publish_failed / publish_failed_final (worker).|
|published        |Terminal. No transitions in Sorted. To take down: agency deletes on LinkedIn manually, then creates a new Sorted post.                  |
|parked           |awaiting_approval (revive only)                                                                                                         |
|rejected         |awaiting_approval (revive only)                                                                                                         |

Notes: Unscheduling resets publish_status to draft and cancels the schedule_job. Parked/rejected revive directly to awaiting_approval, must re-enter approval chain. No direct stage jumps to scheduled, only via approval transition.

### Stage x publish_status matrix (CHECK constraint enforced)

|Stage            |Allowed publish_status values                              |
|-----------------|-----------------------------------------------------------|
|draft            |draft                                                      |
|awaiting_approval|draft                                                      |
|needs_input      |draft                                                      |
|scheduled        |scheduled, publishing, publish_failed, publish_failed_final|
|published        |published                                                  |
|parked           |draft                                                      |
|rejected         |draft                                                      |

## 9. Plan

TO BE FINALIZED. Design session required before Plan PRs build. Plan PRs blocked until decided.

### Open questions

- Does Plan auto-spawn posts, or follow Brief model (information + manual creation)?
- Approval states or acknowledgement only?
- Period approval modes meaning?
- Client visibility?

## 10. Briefs

|Item                |Decision                                                                      |
|--------------------|------------------------------------------------------------------------------|
|States              |Open (default), Closed (soft)                                                 |
|Closed behaviour    |Hidden from default view, still readable, still accepts comments              |
|Created by          |Client only                                                                   |
|Required fields     |Title, objective                                                              |
|Optional fields     |Format requested, brand requirements, target date, references, initial comment|
|Client can          |Comment, close (withdraw)                                                     |
|Agency can          |Comment, close                                                                |
|Edit after creation |No one                                                                        |
|Post linkage        |Optional. Agency picks Origin: Brief in Create sheet.                         |
|Linked posts display|Read-only derived count on brief detail panel                                 |
|Email thread root   |Brief if any post links to it; else post                                      |

## 11. PCS (Post Control System)

|Element                         |Decision                                                                                                    |
|--------------------------------|------------------------------------------------------------------------------------------------------------|
|Layout                          |Header, caption editor, asset gallery, metadata sidebar, three-tab comments                                 |
|Versioning                      |Auto-version on every edit. Pre-publish only. post_versions immutable; never deleted.                       |
|Annotations                     |Caption span + image pin. Immutable, version-locked. Pre-existing annotations stay on their version forever.|
|Annotations on outdated versions|Display greyed out / with ‘copy changed’ indicator. Never hidden from DB.                                   |
|Decision Records                |Boolean flag on comment. Filterable view.                                                                   |
|Rollback                        |Pre-publish only. Stops at Published.                                                                       |
|Edit after publish              |Disabled in Sorted. Replaced with ‘Edit on LinkedIn’ deep-link.                                             |
|Approve button                  |PCS only. Not on Pipeline cards. Client must be logged in.                                                  |
|Take down published post        |Not possible from Sorted. Agency deletes on LinkedIn manually, then creates a new Sorted post if needed.    |

### Share URL behaviour

|Token type           |Behaviour                                                                                                                                                                                                                                                      |
|---------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
|Canonical share token|Auto-created per post at post creation (in SECURITY DEFINER fn). Public read-only view at /s/{token}. Renders latest version, current stage, all live comments. No expiry. Revocable from Cockpit. Agency shares it as needed. Chat NEVER shown on public view.|
|Post-publish OG card |Pulled from LinkedIn lastModifiedAt. Nightly cron refreshes Sorted snapshot if drift detected. P3 alert on drift.                                                                                                                                              |

## 12. Create sheet

|Item            |Decision                                                                            |
|----------------|------------------------------------------------------------------------------------|
|Modes           |Single mode. No quick mode.                                                         |
|Required fields |Title, caption, channel                                                             |
|Optional fields |Asset gallery, content_pillar, content_type, target_date, owner, Origin (Brief link)|
|Field visibility|All visible. No accordion.                                                          |
|Commit action   |Save as Draft                                                                       |
|Origin options  |None, Brief, (Plan when §9 lands)                                                   |

## 13. Assets

|Item                    |Decision                                                                                                                                             |
|------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------|
|Storage                 |R2 bucket per workspace: assets-{workspace_id}. Separate user-avatars bucket for profile pics.                                                       |
|Versions                |asset_versions table. Editing creates new version row + bumps assets.current_version_id.                                                             |
|Attachments             |asset_attachments.asset_version_id binds to specific version. Immutable. FK NO ACTION: live attachments block asset hard-delete.                     |
|Delete-attempt UX       |Toast: ‘Asset in use. Remove from posts/briefs first.’ For surfaces with the list, modal: ‘Used in N posts and M briefs. Delete anyway?’ with usages.|
|Pre-publish banner      |Newer version available. [Use new] / [Keep current].                                                                                                 |
|Post-publish banner     |None. Frozen.                                                                                                                                        |
|Assets surface          |Shows current version. Kebab > Version history.                                                                                                      |
|Soft-delete             |30 days. Then hard-delete.                                                                                                                           |
|Post-hard-delete display|Asset removed placeholder.                                                                                                                           |
|OG hero resolution      |asset_attachments.asset_version_id for the post version being shared.                                                                                |
|GDPR takedown           |Targets asset chain. Cascades to all versions.                                                                                                       |
|Upload pipeline         |Worker > MIME allowlist > EXIF strip > SVG sanitize > virus scan > R2                                                                                |

## 14. AI

No AI features in v2.0. No tables. No workers. No UI surfaces. No tabs. No inline triggers. No brief parsing. No cost cap. Schema does not carry ai_usage, ai_memory, tool_invocations, or workspace_brand_guides.

## 15. Insights

|Item         |Decision                                                                                               |
|-------------|-------------------------------------------------------------------------------------------------------|
|Source       |LinkedIn API. Stored in post_insights.                                                                 |
|Cadence      |Hourly 24h > Daily 7d > Weekly 30d > Daily through day 90 > stop                                       |
|After 90 days|On-demand ‘Refresh from LinkedIn’ button only. Workspace dashboard aggregates cached, never fetches.   |
|Fetch failure|Show last cached values + ‘Last updated [time ago]’. Never zeros or errors.                            |
|Never-fetched|Show ‘Insights pending. Check back in an hour.’                                                        |
|Agency view  |Full metrics. Impressions, reactions, comments, shares, click-through, comparison-to-workspace-average.|
|Client view  |Curated subset. Impressions, reactions, comments, shares. No click-through. No comparisons.            |
|Surfaces     |Per-post panel in PCS. Workspace dashboard (last 30 days). Per-client view (agency mode).              |

## 16. Publishing

|Item                 |Decision                                                                   |
|---------------------|---------------------------------------------------------------------------|
|Live platform at v2.0|LinkedIn only                                                              |
|Other platforms      |OAuth + schema + post.platform field. Publishing workers ship post-launch. |
|Queue                |schedule_jobs. Idempotent enqueue. Cloudflare Cron every minute.           |
|Worker               |Publish Queue Worker. LinkedIn API. Retry 3x with backoff. Circuit breaker.|
|Token storage        |Envelope-encrypted in DB. Refresh worker.                                  |
|Publish failure UX   |PCS banner. Inbox entry. Retry from Cockpit (action #1).                   |
|Post-publish edits   |Happen on LinkedIn natively. Sorted does NOT call PARTIAL_UPDATE at v2.0.  |
|Post-publish rollback|Not supported. Published is terminal in Sorted.                            |

## 17. Notifications (ephemeral)

‘Notifications’ refers only to ephemeral surfaces. Permanent surface is Inbox (see §7).

|Surface                 |Decision                                                                                                                                                                        |
|------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
|Toast (in-app)          |Slide-in banner. Both desktop and mobile. Disappears in seconds. Not stored. Fires on same triggers as Inbox while user is active.                                              |
|Push (Sorted-fired)     |FCM + APNs + Web Push. Urgent-only events. Gated 9am-9pm workspace timezone. Per-user opt-in toggle.                                                                            |
|Push (Agora-fired, chat)|Native Agora MENTION_ONLY mode. Respects user DND. Not time-gated.                                                                                                              |
|Email                   |Out-of-app catch-up. Bundled every 15 min. Sent only between 9am-9pm workspace TZ. Outside hours: queued, sent next 9am. Sent only if user inactive in app > 5 min at fire time.|
|Empty digest window     |No email sent.                                                                                                                                                                  |

### Email threading

|Item                      |Decision                                                                 |
|--------------------------|-------------------------------------------------------------------------|
|Thread root               |Brief if post originated from brief; else post                           |
|Message-ID format         |`<brief-{id}@srtd.io>` or `<post-{id}@srtd.io>`                          |
|Subject (brief-rooted)    |[Workspace] {brief.title}                                                |
|Subject (post-rooted)     |[Workspace] {post.title}                                                 |
|All emails for a work unit|Share one Message-ID chain. Gmail/Outlook collapse into one conversation.|

## 18. Workspace settings

|Section                           |Decision                                                                                                                                                                                                                                |
|----------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
|Workspace name                    |Editable by Admin/Owner                                                                                                                                                                                                                 |
|Timezone                          |Editable by Admin/Owner                                                                                                                                                                                                                 |
|Default email digest time         |Workspace default, user can override                                                                                                                                                                                                    |
|Brand fields (logo, primary color)|REMOVED                                                                                                                                                                                                                                 |
|Section toggles                   |REMOVED. No Plan toggle, no others.                                                                                                                                                                                                     |
|LinkedIn connection               |Connect, disconnect, re-auth                                                                                                                                                                                                            |
|Member roles                      |Add, remove, change role                                                                                                                                                                                                                |
|Billing                           |Tier, payment method, invoices, additional platforms                                                                                                                                                                                    |
|Workspace deletion                |7-day soft-delete. Recoverable via ‘Recently deleted’ in drawer. After 7 days: hard delete.                                                                                                                                             |
|Transfer ownership                |Immediate. Existing member only. Password confirm. Old owner downgrades to Admin. New owner gets persistent ‘Update billing info’ banner. Old owner’s card continues billing until replaced. 30-day grace before billing-failure ladder.|
|Owner self-delete                 |Blocked at DB level (workspaces.owner_user_id FK is ON DELETE RESTRICT). Owner must transfer ownership or delete the workspace before deleting their own account.                                                                       |
|User profile settings             |Edit display_name (1-80 chars), designation (optional), avatar (upload to user-avatars R2 bucket).                                                                                                                                      |

## 19. Cockpit

|Item          |Decision                                      |
|--------------|----------------------------------------------|
|Surface       |platform.srtd.io                              |
|Auth          |Passkey only                                  |
|Operator      |Sorted founder. Single non-technical operator.|
|Primary device|iPhone                                        |
|Build scope   |Full. 6 PRs. Ships at launch.                 |

### Cockpit actions

|# |Action                      |Confirmation          |
|--|----------------------------|----------------------|
|1 |Retry failed publish        |Tap, no confirm       |
|2 |Replay webhook              |Tap, no confirm       |
|3 |Restart background job      |Tap, no confirm       |
|4 |Force OAuth disconnect      |Tap, no confirm       |
|5 |Trigger re-auth email       |Tap, no confirm       |
|6 |Revoke all sessions for user|Modal confirm         |
|7 |Billing override            |Modal confirm + reason|
|8 |Extend trial                |Modal: days + reason  |
|9 |Open ticket                 |Modal                 |
|10|Global kill switch          |Type ‘KILL’ + reason  |
|11|Revoke canonical share token|Tap, no confirm       |

### Impersonation

|Item          |Decision                                                          |
|--------------|------------------------------------------------------------------|
|Scope         |Capability-scoped (read-only or read-write per session)           |
|Duration      |30-min hard cap                                                   |
|Audit         |Every action written to audit_log with impersonator + impersonated|
|Emergency exit|Static HTML page if Sorted is down                                |
|Banner        |Persistent during impersonation, in target user’s session view    |

## 20. Search

|Item                 |Decision                                                                                        |
|---------------------|------------------------------------------------------------------------------------------------|
|Trigger              |cmd+K palette. Scoped router.                                                                   |
|Comments and entities|Postgres FTS. tsvector indexes.                                                                 |
|Chat                 |Agora SDK. searchMsgFromDB (local) + asyncFetchHistoryMessages (server). Not on Postgres mirror.|
|Scope chips          |All, Posts, Briefs, Plans, Comments, Chat, Assets, People                                       |
|Result ranking       |Recency + relevance                                                                             |

## 21. Devices

|Item         |Decision                                                         |
|-------------|-----------------------------------------------------------------|
|v2.0 platform|Web only                                                         |
|Native mobile|Deferred indefinitely                                            |
|Touch targets|44x44 minimum everywhere                                         |
|Hover        |No hover-only interactions                                       |
|Long-press   |Right-click equivalent                                           |
|Reassessment |Month 3 post-launch based on mobile-web traffic and demand signal|

## 22. Data model

Schema is fully executed on Supabase project movnexawfhsyuluspxoc (Mumbai, Postgres 17). 40 tables live. See `docs/schema.md` for the live schema dump, and `supabase/migrations/*.sql` for implementation truth.

### Core tables

|Table                     |Purpose                                                                                                              |
|--------------------------|---------------------------------------------------------------------------------------------------------------------|
|workspaces                |Tenant root. owner_user_id FK to public.users, ON DELETE RESTRICT.                                                   |
|workspace_members         |User + role per workspace. active flag for workspace-scoped soft-delete.                                             |
|workspace_role_permissions|Capability matrix (workspace_id, role, capability)                                                                   |
|workspace_settings        |Name, timezone, defaults                                                                                             |
|public.users              |User profile. id FK to auth.users. display_name (req), designation (opt), avatar_url (opt), deleted_at (soft-delete).|
|session_devices           |Fingerprint per session                                                                                              |
|audit_log                 |Indexed on trace_id. 90-day retention.                                                                               |

### Content tables

|Table                |Purpose                                                                                                                         |
|---------------------|--------------------------------------------------------------------------------------------------------------------------------|
|posts                |stage, publish_status, content_pillar, target_date, channel, owner, brief_id. CHECK enforces legal stage x publish_status pairs.|
|post_versions        |Snapshot per edit. Pre-publish only. IMMUTABLE; no deleted_at.                                                                  |
|post_annotations     |Caption span / image pin. Bound to post_version_id. IMMUTABLE; no deleted_at.                                                   |
|comments             |Entity-anchored. workspace_id RLS. Soft-delete.                                                                                 |
|briefs               |Open/Closed states. No edits after creation.                                                                                    |
|assets               |Pointer row. current_version_id FK.                                                                                             |
|asset_versions       |id, asset_id, version_number, r2_key, file_hash, uploaded_at, uploaded_by                                                       |
|asset_attachments    |Binds entity to a specific asset_version_id. Immutable. FK NO ACTION.                                                           |
|schedule_jobs        |Idempotent publish queue                                                                                                        |
|approvals            |Per-post + version_id + capability. No magic-link cruft. Approvals happen inside Sorted only.                                   |
|share_tokens         |Canonical only (one per post). capability=‘view_card’. No expiry. Revocable.                                                    |
|post_insights        |LinkedIn metrics, cursor per post                                                                                               |
|inbox_entries        |Permanent Inbox feed (partitioned by month)                                                                                     |
|chat_channels        |Local Agora channel registry + last_synced_at                                                                                   |
|chat_messages        |Mirror only. Batch every 6h. Never on read path.                                                                                |
|groups, group_members|Sorted source of truth. Agora ACL mirrors.                                                                                      |
|email_threads        |Root_id, root_type, message_id, subject, workspace_id                                                                           |
|notifications        |Per-event delivery row. email_sent_at for dedupe.                                                                               |

### Tables not in schema

- ai_usage, ai_memory, tool_invocations, workspace_brand_guides (AI fully out)
- magic-link approval columns removed from share_tokens and approvals
- deleted_at removed from post_versions and post_annotations (immutable)

## 23. Migration and cutover

|Item                 |Decision                                                                                                                         |
|---------------------|---------------------------------------------------------------------------------------------------------------------------------|
|Approach             |Single ETL script. Two modes.                                                                                                    |
|Dev-seed mode        |PII scrubbed (emails hashed, names replaced). Used throughout B1-B3 to seed dev from v1.                                         |
|Cutover mode         |Real data. Run on cutover day against latest v1 state.                                                                           |
|Users                |Not migrated. Clients sign up fresh post-cutover via invite flow. Legacy *_by columns set NULL, displayed as ex-member.          |
|Content carried over |Workspaces, posts, briefs, assets, comments, schedule. Owner is set to the agency operator at ETL time; transferred post-cutover.|
|Dev data treatment   |Disposable fixtures. Wipe and re-seed freely.                                                                                    |
|v1 freeze            |v1 frozen for writes during cutover run only                                                                                     |
|Chat history         |v1 has no Agora. v2 chat starts empty. Documented gap, accepted.                                                                 |
|Schema drift handling|Re-run ETL after schema changes; no incremental migration burden.                                                                |
|Post-cutover         |Agency invites each client manually via invite flow. Client signs up fresh, lands in pre-populated workspace.                    |

## 24. Observability

|Item          |Decision                                                                                                                                                 |
|--------------|---------------------------------------------------------------------------------------------------------------------------------------------------------|
|Tracing       |uuid_v7 trace_id propagated FE > API > DB > queue > worker > external API                                                                                |
|DB propagation|Explicit RPC parameter. Not SET LOCAL (pgBouncer unsafe).                                                                                                |
|Enforcement   |ESLint rule on .rpc() calls                                                                                                                              |
|Cardinality   |Same trace_id flows downstream through all spawned jobs                                                                                                  |
|Errors        |Sentry frontend + backend. Source maps.                                                                                                                  |
|Logs          |Structured JSON to Cloudflare Logpush. R2 sink.                                                                                                          |
|Audit         |audit_log indexed on trace_id. 90-day retention.                                                                                                         |
|Alerts        |Webhook signature failures, queue health, RLS CI, capability audit CI, mirror cron failures (3 consecutive), Agora reconciliation drift (>5% P3, >20% P2)|

## 25. Security

|Item              |Decision                                                                                                            |
|------------------|--------------------------------------------------------------------------------------------------------------------|
|JWT               |15-min, refresh token                                                                                               |
|Device fingerprint|session_devices table. RLS gate on every auth request.                                                              |
|RLS               |Security boundary. Every tenant-scoped table. CI tests cross-tenant isolation.                                      |
|Capability checks |SECURITY DEFINER helpers + workspace_role_permissions                                                               |
|Sensitive writes  |All routed through SECURITY DEFINER procs. INSERT/UPDATE/DELETE revoked from authenticated role on sensitive tables.|
|LinkedIn tokens   |Envelope-encrypted in DB                                                                                            |
|Asset uploads     |MIME allowlist, EXIF strip, SVG sanitize, virus scan                                                                |
|Idempotency       |Idempotency-Key middleware on all mutating endpoints                                                                |

## 26. Chat and Comments

Two primitives, separate backends. Users don’t know which is which.

### Split

|Aspect                 |Comments                           |Chat                                  |
|-----------------------|-----------------------------------|--------------------------------------|
|Surfaces               |PCS, Brief, Plan cell              |DM, Group, Plan period                |
|Backend                |Postgres                           |Agora                                 |
|Real-time              |Supabase Realtime                  |Agora SDK                             |
|Mirror                 |None                               |chat_messages (batch, compliance only)|
|Anchors to post version|Yes                                |No                                    |
|Decision Records       |Yes                                |No                                    |
|@-mentions             |inbox_entries + email              |Agora native push (MENTION_ONLY)      |
|Attachments            |Sorted asset pipeline              |Sorted asset pipeline (asset_id ref)  |
|Search                 |Postgres FTS                       |Agora SDK                             |
|Public share visibility|Yes (shown on canonical share link)|Never. Chat is workspace-internal.    |
|Downtime UX            |May lag, refresh                   |Chat unavailable. Rest unaffected.    |

### Chat specifics

|Item               |Decision                                                                                |
|-------------------|----------------------------------------------------------------------------------------|
|Source of truth    |Agora. Sorted does not own messages, live feed, search, push.                           |
|Channel IDs        |dm__W__min(A,B)__max(A,B); group__W__G; plan__W__P                                      |
|Auth               |Sorted mints 15-min Agora tokens, JWT-aligned. Per-channel ACL at creation.             |
|Group membership   |Sorted is source of truth. Agora ACL mirrors via REST.                                  |
|Mirror cron        |Cloudflare Cron every 6h. Pulls Agora REST history. Per-channel cursor.                 |
|Mirror use         |90-day retention, GDPR export, email digest aggregation, audit only. Never on read path.|
|Reconciliation cron|Daily 04:00 UTC. >5% drift P3. >20% drift P2.                                           |

## 27. Compliance

Not covered in v2.0 PRD. Defer to lawyer review pre-launch.

## 28. Build phases and tests

### Phasing

- Phase 1 (current): All backend. Schema (done live), RLS, SECURITY DEFINER procs, triggers, edge functions, workers. No UI.
- Phase 2: ETL single-shot, dev-seed + cutover modes, against complete schema.
- Phase 3: All frontend, against working backend.

### Batches

|Batch|Scope                                                                                           |
|-----|------------------------------------------------------------------------------------------------|
|B1   |Foundation: repo, infra, observability, auth, RLS tests, SECURITY DEFINER procs, workspaces, ETL|
|B2   |Core entities, Comments, PCS, Pipeline, stage state machine                                     |
|B3   |Briefs, Inbox, Chat (Agora), Assets. Plan blocked.                                              |
|B4   |Publishing, Canonical share, Notifications, Insights, Search, Billing, Cockpit, Cutover         |

### Test strategy

- Internal team (Hinglish Agency) is the beta cohort throughout build.
- E2E tests required on critical surfaces: comments, state changes (every transition in the locked matrix), PCS, post creation, post lifecycle, canonical share token.
- Heavy automated coverage on: auth, RLS, billing, ETL, publish queue, share token RLS, stage transitions.
- No formal TDD per PR. Test density scaled to risk.
- Observability per §24 as production safety net.
- Audit prompts before merge verify tests exist for critical-surface PRs.

### Workflow rules

- One PR per Claude Code prompt.
- Audit prompts: report-only, no branches/PRs.
- Always audit before any fix prompt (connectors, not memory).
- Schema changes: SQL in chat, approval, execute via Supabase MCP, verify via information_schema, PR notes ‘Schema already applied. Do NOT execute.’
- Auto-merge disabled. Shubham merges manually.
- Every prompt ends with: ‘Return your entire response in ONE code block, most token-efficient form, no prose outside it.’ and ‘After pushing, reply with the exact GitHub PR URL.’
