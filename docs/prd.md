# Sorted v2 PRD (MVP)

Decisions only. No rationale.

Sorted v2 is a social-media approval tool. Client writes a brief; agency drafts a post; the post moves through review to approved, rejected, or parked. No publishing, no scheduling, no plan, no insights in the MVP.

## Index

1. Project identifiers and DANGER
2. Goals and scope
3. Operating principles
4. Users, roles, visibility
5. Pricing and trial
6. Onboarding
7. Layout and shell
8. Activity
9. Pipeline
10. Briefs
11. PCS (Post Control System)
12. Create sheet
13. Assets
14. Notifications (ephemeral)
15. Workspace settings
16. Cockpit
17. Search
18. Devices
19. Data model
20. Migration and cutover
21. Observability
22. Security
23. Chat and Comments
24. Compliance
25. Build phases and tests

## 1. Project identifiers and DANGER

| Env | Project ID | Region | Status | Touch from v2 build? |
| --- | --- | --- | --- | --- |
| v2 | movnexawfhsyuluspxoc | Mumbai (ap-south-1) | Build target | YES |
| v1 | ozptjplxbyswclolbxyn | Mumbai (ap-south-1) | LIVE PRODUCTION | NO. Only via ETL cutover script, on cutover day. |

Both projects are in Mumbai. Region is NOT a disambiguator. The project ID is the only safe identifier.

Every Supabase MCP call from a v2 prompt MUST pass project_id="movnexawfhsyuluspxoc" explicitly. "Mumbai" alone, or "the Supabase project" alone, is never sufficient. Reject any prompt that uses them without the project ID.

Any operation targeting ozptjplxbyswclolbxyn must say "v1" explicitly in the same prompt and state the reason. No v2 build prompt may target v1.

## 2. Goals and scope

| Item | Decision |
| --- | --- |
| Product | Social-media post approval tool. Brief in, post drafted, reviewed, approved. |
| Launch | 2026 (web) |
| Native mobile | Deferred. Reassess month 3 post-launch. |
| Public signup | Live at launch. Paid. |
| v1 tenant cutover | Separate track. Decoupled from public signup. |
| New tenants prelaunch | Free. |
| Repo | Greenfield. Org srtdio. v2 project movnexawfhsyuluspxoc (Pro, Mumbai). See section 1. Public repository. |
| Domain | srtd.io. Cockpit at platform.srtd.io. |

## 3. Operating principles

- One workspace = one end-client = one platform. Locked invariant.
- TypeScript strict. No .js, .jsx, .mjs, .cjs. Ever.
- Multi-tenant from day 1. Postgres RLS is the security boundary.
- post.stage is the single workflow state: draft, review, approved, parked, rejected.
- JWT 15 min + session_devices fingerprint RLS on every auth request.
- Trace ID is an explicit RPC parameter. Not SET LOCAL.
- Discussion has two primitives: Comments (Postgres) and Chat (Agora).
- Activity is the only permanent in-app event surface.
- No section toggles. Every section ships for every workspace.
- Assets are versioned. Attachments bind to asset_version_id.
- Brief is a read-only information document. No edits after creation.
- Approval is per-post, deliberate. Inside Sorted only. No bulk approve.
- Touch targets 44x44 minimum everywhere.
- Email is out-of-app catch-up. Bundled, 9am-9pm workspace TZ.
- No AI features. No publishing, scheduling, plan, or insights in MVP.
- All sensitive writes go through SECURITY DEFINER procs. INSERT/UPDATE/DELETE revoked from authenticated role on sensitive tables.
- post_versions and post_annotations are immutable edit history. Never soft-deletable.
- Users not hard-deleted from auth.users except for GDPR. public.users.deleted_at signals account removal; workspace_members.active=false signals workspace removal. Either surfaces as '(ex-member)' badge.
- Workspace owner cannot delete their own account until ownership is transferred or the workspace is deleted.

## 4. Users, roles, visibility

### Roles

| Role | Definition |
| --- | --- |
| Owner | Workspace creator. Billing, deletion, transfer. Cannot self-delete until ownership transferred. |
| Admin | Full workspace power except billing and deletion. |
| Agency | All sections except admin settings. |
| Client | Pipeline (except Draft), Briefs (own only), Assets. |

### Visibility

| Surface | Client sees |
| --- | --- |
| Pipeline | All stages except Draft |
| Briefs | Own briefs only |
| Assets | Yes |
| Activity | Events involving them |

### Capability storage

Capabilities live in workspace_role_permissions keyed by (workspace_id, role, capability). No granular UI in MVP; defaults per role. Granular UI is post-launch without schema rewrite.

### User profile (public.users)

Auto-created via trigger on auth.users insert.

| Field | Decision |
| --- | --- |
| display_name | Required. 1-80 chars. Editable from profile settings. |
| designation | Optional. 1-80 chars. |
| avatar_url | Optional. R2 bucket user-avatars (public read, auth write via worker). |
| deleted_at | Account-level soft-delete. Triggers '(ex-member)' display. |

All *_by columns reference public.users(id) ON DELETE SET NULL, except workspaces.owner_user_id (RESTRICT) and asset_attachments (NO ACTION).

## 5. Pricing and trial

### Tiers (per workspace, per month, INR)

| Tier | Price | Members |
| --- | --- | --- |
| Solo | 499 | 1 |
| Studio | 749 | 4 |
| Agency | 999 | 8 |
| Enterprise | Custom | Unlimited |

Subscription is per workspace. No caps on workspaces per account.

### Trial

| Item | Decision |
| --- | --- |
| Duration | 14 days, account-wide |
| Card upfront | No |
| Nudge cadence | Day 7, 10, 12, 13, 14 (email + in-app) |
| Workspaces during trial | Multiple allowed, from workspace switcher |
| Conversion | Per-workspace activation. Owner picks which workspace each paid subscription activates. |
| Non-activated at trial end | Read-only indefinitely. Data retained until owner deletes or upgrades. |

### Billing failure ladder (active paid workspaces)

| State | Behaviour |
| --- | --- |
| active | Normal |
| grace (3 days) | Banner. |
| soft_pause (10 days) | Read-only. |
| full_pause (30 days) | Billing settings only. |
| soft_delete (60 days) | Recoverable via support. |
| hard_delete | Gone. |

## 6. Onboarding

| Item | Decision |
| --- | --- |
| Signup form | Single scroll. Required: name (-> display_name), email, password, workspace name, workspace timezone (auto-detected). |
| Workspaces at signup | Exactly one |
| Additional workspaces | From workspace switcher |
| First-run state | Empty Pipeline, empty Activity, empty Assets |
| Profile completion | Designation and avatar optional, added later. |

### Empty-state checklist

The first-run checklist renders on the Pipeline page.

| # | Item | Action |
| --- | --- | --- |
| 1 | Create your first post | Opens Create sheet |
| 2 | Invite a teammate | Navigates to Settings, members panel |
| 3 | Create your first brief | Opens Brief create sheet |

Manual Skip per item and manual Dismiss for the whole card.

## 7. Layout and shell

### Shell

| Element | Decision |
| --- | --- |
| Topbar | Search trigger, Create (+) menu (New post, New brief), profile avatar button. |
| Drawer (left) | Sections: Pipeline, Briefs, Chat, Activity. Workspace switcher at top of drawer. |
| Assets entry | Reached from the Pipeline and Briefs page heads. |
| Profile / avatar menu | Switch workspace, Recently deleted, Settings, profile. |
| Mobile | Web-only at MVP. Bottom tab bar on small screens. Native deferred. |

### Iconography

| Item | Decision |
| --- | --- |
| Icon style | Minimal SVG strokes, 1.6px, round caps and joins, currentColor, fill none |
| Icon button | 44x44 frame with 20x20 SVG |
| Touch targets | 44x44 minimum everywhere. No exceptions. |
| Hover | No hover-only interactions |
| Long-press | Right-click equivalent |

## 8. Activity

Permanent in-app event feed. Source of truth for what happened. The only permanent surface; toasts, push, and email are ephemeral. Backed by the inbox_entries table.

### Structure

| Element | Decision |
| --- | --- |
| State chips | All, Unread, Snoozed |
| Scopes | Everything, Posts, Briefs, People, Groups, Clients |
| Snooze | 1h, 4h, tomorrow 9am, next week |
| Inline approve | No. Click navigates to PCS. |
| Inline reply (comments) | Lands on entity. |

### Events that land in Activity

- Comments on posts and briefs
- Post stage changes
- Brief created, brief closed
- Asset uploaded, asset version added
- @-mentions
- Decision Records flagged
- System events (asset removed)

Chat messages do NOT land in Activity. Chat notification is Agora native push only (MENTION_ONLY). See sections 14 and 23.

## 9. Pipeline

| Item | Decision |
| --- | --- |
| Desktop layout | Horizontal column board by stage, with a stage selector. |
| Mobile layout | Accordion by stage |
| Visual cues | Owner colors, urgency colors |
| Filters | Owner, channel, content_type, target_date range, has_blocking_comment, has_brief |
| Saved views | Per workspace, per user |
| Bulk actions (agency) | Move stage, assign owner, add tag, archive. Cap 10 per action. |
| Bulk actions (client) | None |
| Client visibility | All stages except Draft |

### Stages

| Stage | Definition |
| --- | --- |
| Draft | Agency private. Client cannot see. |
| Review | Client review required. Client approves, rejects, or comments. |
| Approved | Client approved. |
| Parked | Held by agency. |
| Rejected | Client rejected. |

### Stage transition map

| From | Can move to |
| --- | --- |
| draft | review, parked |
| review | approved, rejected, parked |
| approved | parked, rejected |
| parked | review |
| rejected | review |

Approved is not terminal. Approved can move to parked or rejected. When a client wants changes instead of approving, they comment and the post stays in review. Parked and rejected revive to review. There is no publishing step.

target_date is a nullable indicative field on posts. It carries no scheduling behaviour in MVP.

## 10. Briefs

Client writes the brief; it lands in the Briefs section and can be linked to a post.

| Item | Decision |
| --- | --- |
| States | Open (default), Closed (soft) |
| Closed behaviour | Hidden from default view, still readable, still accepts comments |
| Created by | Client only |
| Required fields | Title, objective |
| Optional fields | Format requested, brand requirements, target date, references, initial comment |
| Client can | Comment, close (withdraw) |
| Agency can | Comment, close |
| Edit after creation | No one |
| Post linkage | Optional. Agency picks Origin: Brief in Create sheet. |
| Linked posts display | Read-only derived count on brief detail panel |
| Email thread root | Brief if any post links to it; else post |

## 11. PCS (Post Control System)

| Element | Decision |
| --- | --- |
| Layout | Header, caption editor, asset gallery, metadata sidebar, comments |
| Caption editing | Agency edits the caption inside PCS. |
| Versioning | Auto-version on every edit. post_versions immutable; never deleted. |
| Annotations | Caption span + image pin. Immutable, version-locked. |
| Annotations on outdated versions | Display greyed out / 'copy changed' indicator. Never hidden from DB. |
| Decision Records | Boolean flag on comment. Filterable view. |
| Rollback | Pre-approval edit history via versions; versions are immutable. |
| Approve button | PCS only. Not on Pipeline cards. Client must be logged in. |

## 12. Create sheet

| Item | Decision |
| --- | --- |
| Modes | Single mode. No quick mode. |
| Required fields | Title, caption, platform |
| Optional fields | Asset gallery, format, target_date, owner, Origin (Brief link) |
| Field visibility | All visible. No accordion. |
| Commit action | Save as Draft |
| Origin options | None, Brief |

## 13. Assets

| Item | Decision |
| --- | --- |
| Storage | R2 bucket per workspace: assets-{workspace_id}. Separate user-avatars bucket. |
| Versions | asset_versions table. Editing creates new version row + bumps assets.current_version_id. |
| Attachments | asset_attachments.asset_version_id binds to a specific version. Immutable. FK NO ACTION: live attachments block asset hard-delete. |
| Delete attempt UX | Toast: 'Asset in use. Remove from posts/briefs first.' Modal where the usage list exists: 'Used in N posts and M briefs. Delete anyway?' |
| Version banner | Newer version available. [Use new] / [Keep current]. |
| Assets surface | Shows current version. Kebab > Version history. |
| Soft-delete | 30 days. Then hard-delete. |
| Post-hard-delete display | Asset removed placeholder. |
| GDPR takedown | Targets asset chain. Cascades to all versions. |
| Upload pipeline | Worker > MIME allowlist > EXIF strip > SVG sanitize > virus scan > R2 |

## 14. Notifications (ephemeral)

'Notifications' refers only to ephemeral surfaces. The permanent surface is Activity (section 8).

| Surface | Decision |
| --- | --- |
| Toast (in-app) | Slide-in banner, desktop and mobile. Disappears in seconds. Not stored. Fires on same triggers as Activity while user active. |
| Push (Sorted-fired) | FCM + APNs + Web Push. Urgent-only events. Gated 9am-9pm workspace TZ. Per-user opt-in. |
| Push (Agora-fired, chat) | Native Agora MENTION_ONLY. Respects user DND. Not time-gated. |
| Email | Out-of-app catch-up. Bundled every 15 min. Sent 9am-9pm workspace TZ. Outside hours queued to next 9am. Sent only if user inactive > 5 min at fire time. |
| Empty digest window | No email sent. |

### Email threading

| Item | Decision |
| --- | --- |
| Thread root | Brief if post originated from brief; else post |
| Message-ID format | brief-{id}@srtd.io or post-{id}@srtd.io |
| Subject (brief-rooted) | [Workspace] {brief.title} |
| Subject (post-rooted) | [Workspace] {post.title} |
| All emails for a work unit | Share one Message-ID chain. |

## 15. Workspace settings

| Section | Decision |
| --- | --- |
| Workspace name | Editable by Admin/Owner |
| Timezone | Editable by Admin/Owner |
| Default email digest time | Workspace default, user can override |
| Member roles | Add, remove, change role |
| Billing | Tier, payment method, invoices |
| Workspace deletion | 7-day soft-delete. Recoverable via Recently deleted. After 7 days: hard delete. |
| Transfer ownership | Immediate. Existing member only. Password confirm. Old owner downgrades to Admin. New owner gets persistent 'Update billing info' banner. Old owner's card continues billing until replaced. 30-day grace before billing-failure ladder. |
| Owner self-delete | Blocked at DB level (workspaces.owner_user_id FK ON DELETE RESTRICT). Owner must transfer ownership or delete the workspace first. |
| User profile settings | Edit display_name, designation, avatar (upload to user-avatars R2 bucket). |

## 16. Cockpit

| Item | Decision |
| --- | --- |
| Surface | platform.srtd.io |
| Auth | Passkey only |
| Operator | Sorted founder. Single non-technical operator. |
| Primary device | iPhone |

### Cockpit actions

| # | Action | Confirmation |
| --- | --- | --- |
| 1 | Replay webhook | Tap, no confirm |
| 2 | Restart background job | Tap, no confirm |
| 3 | Revoke all sessions for user | Modal confirm |
| 4 | Billing override | Modal confirm + reason |
| 5 | Extend trial | Modal: days + reason |
| 6 | Open ticket | Modal |
| 7 | Global kill switch | Type 'KILL' + reason |

### Impersonation

| Item | Decision |
| --- | --- |
| Scope | Capability-scoped (read-only or read-write per session) |
| Duration | 30-min hard cap |
| Audit | Every action written to audit_log with impersonator + impersonated |
| Emergency exit | Static HTML page if Sorted is down |
| Banner | Persistent during impersonation, in target user's session view |

## 17. Search

| Item | Decision |
| --- | --- |
| Trigger | cmd+K palette. Scoped router. |
| Comments and entities | Postgres FTS. tsvector indexes. |
| Chat | Agora SDK. searchMsgFromDB (local) + asyncFetchHistoryMessages (server). Not on Postgres mirror. |
| Scope chips | All, Posts, Briefs, Comments, Chat, Assets, People |
| Result ranking | Recency + relevance |

## 18. Devices

| Item | Decision |
| --- | --- |
| MVP platform | Web only |
| Native mobile | Deferred |
| Touch targets | 44x44 minimum everywhere |
| Hover | No hover-only interactions |
| Long-press | Right-click equivalent |
| Reassessment | Month 3 post-launch |

## 19. Data model

Schema is fully executed on v2 project movnexawfhsyuluspxoc (Postgres 17). v1 (ozptjplxbyswclolbxyn) is untouched. See section 1. See supabase/migrations/*.sql for implementation truth and schema.md for the full reference.

### Core tables

| Table | Purpose |
| --- | --- |
| workspaces | Tenant root. owner_user_id FK to public.users, ON DELETE RESTRICT. |
| workspace_members | User + role per workspace. active flag for workspace-scoped soft-delete. |
| workspace_role_permissions | Capability matrix (workspace_id, role, capability) |
| workspace_settings | Name, timezone, defaults |
| workspace_onboarding | Per-workspace onboarding milestone timestamps. Seeded by trigger on workspace insert. |
| public.users | Profile. id FK to auth.users. display_name, designation, avatar_url, deleted_at. |
| session_devices | Fingerprint per session |
| idempotency_keys | Idempotency-Key store for mutating endpoints. |
| audit_log | Indexed on trace_id. Partitioned monthly. |

### Content tables

| Table | Purpose |
| --- | --- |
| posts | stage, target_date, platform, format, bucket_id, owner_user_id, origin, brief_id, caption, title, row_version. Stage CHECK: draft/review/approved/parked/rejected. |
| workspace_buckets | Named buckets per workspace. posts.bucket_id references it. Used for grouping posts. |
| post_versions | Snapshot per edit. Immutable; no deleted_at. |
| post_annotations | Caption span / image pin. Bound to post_version_id. Immutable; no deleted_at. |
| comments | Entity-anchored. workspace_id RLS. Soft-delete. |
| comment_reactions | Emoji per (comment, user). |
| briefs | Open/Closed. No edits after creation. |
| assets | Pointer row. current_version_id FK. |
| asset_versions | id, asset_id, version_number, r2_key, sha256, uploaded_at, uploaded_by. |
| asset_attachments | Binds entity to a specific asset_version_id. Immutable. FK NO ACTION. |
| inbox_entries | Permanent Activity feed. Partitioned monthly. |
| chat_channels | Local Agora channel registry + last_synced_at. |
| chat_messages | Agora mirror only. Partitioned monthly. Never on read path. |
| groups, group_members | Sorted source of truth. Agora ACL mirrors. |
| email_threads | root_id, root_type, message_id, subject, workspace_id. |
| delivery_attempts | Per-event email/push delivery row. email_sent_at for dedupe. |
| webhook_events, webhook_processing_attempts | Inbound webhook capture (incl. Agora chat entry) and retry log. |
| feature_flags | Killswitch / rollout / experiment / tier-gated flags. |
| platform_operators, cockpit_access_log, cockpit_procedure_allowlist, intent_ledger, pending_flows | Cockpit operations. |

### Not in schema

- No dedicated publishing, scheduling, plan, or insights tables (schedule_jobs, plan_periods, plan_cells, approvals, share_tokens, post_insights, platform_accounts removed).
- No AI tables (ai_usage, ai_memory, tool_invocations, workspace_brand_guides).
- post_versions and post_annotations carry no deleted_at (immutable).

## 20. Migration and cutover

| Item | Decision |
| --- | --- |
| Approach | Single ETL script. Two modes. |
| Dev-seed mode | PII scrubbed (emails hashed, names replaced). Seeds dev from v1. |
| Cutover mode | Real data. Run on cutover day against latest v1 state. |
| Users | Not migrated. Clients sign up fresh post-cutover via invite flow. Legacy *_by columns set NULL, shown as ex-member. |
| Content carried over | Workspaces, posts, briefs, assets, comments. Owner set to agency operator at ETL time; transferred post-cutover. |
| Dev data treatment | Disposable fixtures. Wipe and re-seed freely. |
| v1 freeze | v1 frozen for writes during cutover run only. |
| Chat history | v1 has no Agora. v2 chat starts empty. Accepted gap. |
| Schema drift handling | Re-run ETL after schema changes; no incremental migration burden. |
| Post-cutover | Agency invites each client manually. Client signs up fresh, lands in pre-populated workspace. |

## 21. Observability

| Item | Decision |
| --- | --- |
| Tracing | uuid_v7 trace_id propagated FE > API > DB > queue > worker > external API |
| DB propagation | Explicit RPC parameter. Not SET LOCAL (pgBouncer unsafe). |
| Enforcement | ESLint rule on .rpc() calls |
| Cardinality | Same trace_id flows downstream through all spawned jobs |
| Errors | Sentry frontend + backend. Source maps. |
| Logs | Structured JSON to Cloudflare Logpush. R2 sink. |
| Audit | audit_log indexed on trace_id. |
| Alerts | Webhook signature failures, RLS CI, capability audit CI, mirror cron failures (3 consecutive), Agora reconciliation drift (>5% P3, >20% P2) |

## 22. Security

| Item | Decision |
| --- | --- |
| JWT | 15-min, refresh token |
| Device fingerprint | session_devices table. RLS gate on every auth request. |
| RLS | Security boundary. Every tenant-scoped table. CI tests cross-tenant isolation. |
| Capability checks | SECURITY DEFINER helpers + workspace_role_permissions |
| Sensitive writes | Routed through SECURITY DEFINER procs. INSERT/UPDATE/DELETE revoked from authenticated role on sensitive tables. |
| Asset uploads | MIME allowlist, EXIF strip, SVG sanitize, virus scan |
| Idempotency | Idempotency-Key middleware on all mutating endpoints |

## 23. Chat and Comments

Two primitives, separate backends. Users don't know which is which.

### Split

| Aspect | Comments | Chat |
| --- | --- | --- |
| Surfaces | PCS, Brief | DM, Group |
| Backend | Postgres | Agora |
| Real-time | Supabase Realtime | Agora SDK |
| Mirror | None | chat_messages (batch, compliance only) |
| Anchors to post version | Yes | No |
| Decision Records | Yes | No |
| @-mentions | inbox_entries + email | Agora native push (MENTION_ONLY) |
| Attachments | Sorted asset pipeline | Sorted asset pipeline (asset_id ref) |
| Search | Postgres FTS | Agora SDK |
| Downtime UX | May lag, refresh | Chat unavailable. Rest unaffected. |

Chat messages never land in the Activity feed. Chat notification is Agora native push only.

### Chat specifics

| Item | Decision |
| --- | --- |
| Source of truth | Agora. Sorted does not own messages, live feed, search, push. |
| Channel IDs | dm__W__min(A,B)__max(A,B); group__W__G |
| Auth | Sorted mints 15-min Agora tokens, JWT-aligned. Per-channel ACL at creation. |
| Group membership | Sorted is source of truth. Agora ACL mirrors via REST. |
| Mirror | Webhook writes a DB entry per message into chat_messages. 90-day retention, GDPR export, email digest aggregation, audit only. Never on read path. |
| Reconciliation cron | Daily 04:00 UTC. >5% drift P3. >20% drift P2. |

## 24. Compliance

Not covered in MVP PRD. Defer to lawyer review pre-launch.

## 25. Build phases and tests

### Phasing

- Phase 1: All backend. Schema, RLS, SECURITY DEFINER procs, triggers, edge functions, workers.
- Phase 2: ETL single-shot, dev-seed + cutover modes, against complete schema.
- Phase 3: All frontend, against working backend.

### Test strategy

- Internal team (Hinglish Agency) is the beta cohort throughout build.
- E2E tests required on critical surfaces: comments, stage transitions (every transition in the map), PCS, post creation, post lifecycle.
- Heavy automated coverage on: auth, RLS, billing, ETL, stage transitions.
- No formal TDD per PR. Test density scaled to risk.
- Observability per section 21 as production safety net.
- Audit prompts before merge verify tests exist for critical-surface PRs.

### Workflow rules

- One PR per Claude Code prompt.
- Audit prompts: report-only, no branches/PRs.
- Always audit before any fix prompt (connectors, not memory).
- Schema changes: SQL in chat, approval, execute via Supabase MCP with project_id="movnexawfhsyuluspxoc" passed explicitly, verify via information_schema, PR notes 'Schema already applied. Do NOT execute.' Never target v1 (ozptjplxbyswclolbxyn) from a v2 schema change.
- Auto-merge disabled. Shubham merges manually.
- Every prompt ends with: 'Return your entire response in ONE code block, most token-efficient form, no prose outside it.' and 'After pushing, reply with the exact GitHub PR URL.'
