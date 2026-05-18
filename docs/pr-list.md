# Sorted v2 PR List

Living document. Updated as PRs land.

**Target:** July 2026 web launch
**Repo:** srtdio/app
**Author:** Shubham Gune
**Last revised:** 17 May 2026

-----

# 0. Project identifiers and DANGER

| Env | Project ID | Status | Touch from v2 PRs? |
| --- | --- | --- | --- |
| v2 | movnexawfhsyuluspxoc | Build target | YES |
| v1 | ozptjplxbyswclolbxyn | LIVE PRODUCTION | NO. Only the cutover PR ("Cutover: interceptor on v1, ETL cutover mode run, checksum validator, rollback rehearsal"), only on cutover day. |

Both projects are Mumbai. Region is NOT a disambiguator. Project ID is the only safe identifier. Every Claude Code prompt that touches Supabase MUST pass project_id="movnexawfhsyuluspxoc" explicitly.

-----

## How to read this document

- Every PR has a full descriptive title. No numbers, no abbreviations.
- Dependencies reference other PRs by their **full title**. Always use the exact wording.
- “Status” values: `planned`, `in-progress`, `merged`, `blocked`.
- When a PR merges, Claude Code updates this file in the same PR: status changes to `merged` and the GitHub PR URL is added.
- The Status board at the top is the quick-scan view. Full details are below.
- Plan section PRs are blocked until the Plan model is locked in PRD §9.

-----

## Status board

|Status |Title                                                                                                               |GitHub PR|
|-------|--------------------------------------------------------------------------------------------------------------------|---------|
|planned|Repo bootstrap: TS strict, Vite, Tailwind, ESLint boundaries (no .js/.jsx anywhere), CI                             |—        |
|planned|Cloudflare Workers config, Pages, R2 buckets, DNS srtd.io, user-avatars bucket                                      |—        |
|planned|Sentry frontend + backend projects, source maps                                                                     |—        |
|planned|Trace ID system: uuid_v7 propagation FE/API/DB/queue (ESLint enforces on .rpc())                                    |—        |
|planned|Structured JSON logging to Cloudflare Logpush, R2 sink                                                              |—        |
|planned|Zod shared package, Supabase type-gen, CI drift gate                                                                |—        |
|planned|Commit applied schema as migration files                                                                            |—        |
|planned|RLS CI test suite: cross-tenant isolation tests for every tenant-scoped table                                       |—        |
|planned|Auth: magic-link signup, login, password, JWT 15min + refresh                                                       |—        |
|planned|session_devices fingerprint capture + RLS gate on every auth request                                                |—        |
|planned|SECURITY DEFINER procs consolidated                                                                                 |—        |
|planned|Workspace creation flow + member invite + role assignment + onboarding checklist card                               |—        |
|planned|Idempotency-Key middleware on all mutating endpoints                                                                |—        |
|planned|Audit log write helper, indexed on trace_id                                                                         |—        |
|planned|ETL v1->v2 single-shot: dev-seed mode + cutover mode                                                                |—        |
|planned|Discussion component shell: shared Composer, MessageRow, mention picker                                             |—        |
|planned|Comments primitive: Supabase Realtime, reactions, edit 5min, soft-delete + E2E tests                                |—        |
|planned|Decision Records: flag + filterable view                                                                            |—        |
|planned|Post creation API + Create sheet                                                                                    |—        |
|planned|PCS skeleton: header, caption editor, asset gallery, metadata sidebar                                               |—        |
|planned|Annotations: caption span + image pin, immutable, version-locked                                                    |—        |
|planned|Auto-versioning on every edit + Version history panel                                                               |—        |
|planned|Stage state machine + E2E tests on every transition                                                                 |—        |
|planned|Pipeline: vertical kanban desktop, accordion mobile, urgency colors                                                 |—        |
|planned|Filters + saved views + bulk actions (agency only, cap 10)                                                          |—        |
|planned|Briefs entity: client-only creation, Open/Closed states, comment/withdraw, no edits                                 |—        |
|planned|Email-forwarding intake: workspace inbound address, MIME parse, asset link                                          |—        |
|blocked|Plan: calendar grid, cell detail panel, drag reschedule                                                             |—        |
|blocked|Plan states + period approval modes                                                                                 |—        |
|blocked|Plan Approved spawns Draft post with Origin=Plan                                                                    |—        |
|blocked|Plan alignment view: actual vs target distribution                                                                  |—        |
|planned|Inbox: topbar icon, badge, state chips, scope dropdown, snooze options                                              |—        |
|planned|Inbox flat scopes: Everything, Posts, Briefs                                                                        |—        |
|planned|Inbox drill scopes: Plans, People, Groups, Clients                                                                  |—        |
|planned|Groups: create modal, naming rules, #group-name addressability                                                      |—        |
|planned|Anchored messages (comments): caption span + image pin, version-locked                                              |—        |
|planned|Agora workspace setup, channel ID convention, token mint endpoint                                                   |—        |
|planned|Chat primitive: SDK wrap, DM, Group, Plan-period channels                                                           |—        |
|planned|Chat mirror cron: Cloudflare Cron every 6h pulls Agora REST history                                                 |—        |
|planned|Chat reconciliation cron: 04:00 UTC daily Agora vs mirror diff                                                      |—        |
|planned|Assets: upload pipeline, MIME allowlist, EXIF strip, SVG sanitize, virus scan, R2 per-workspace bucket              |—        |
|planned|Assets surface: folders, tags, asset_version chain UI, pre-publish banner, delete-protection toast                  |—        |
|planned|Trash: soft-delete UI, 30-day recovery for assets, 7-day for workspaces, cleanup cron                               |—        |
|planned|Search prep: tsvector indexes on comments, posts, briefs, assets                                                    |—        |
|planned|LinkedIn OAuth: connect flow, envelope-encrypted token storage, refresh worker                                      |—        |
|planned|schedule_jobs: idempotent enqueue, Cloudflare Cron every minute                                                     |—        |
|planned|Publish Queue Worker: dequeue, LinkedIn API, retry 3x backoff, circuit breaker + E2E tests                          |—        |
|planned|publish_status state machine in worker + PCS publish-failed banner + Published frozen                               |—        |
|planned|Canonical share token: auto-create on post creation, public read-only view, revoke endpoint                         |—        |
|planned|Resend integration: notifications table, bounce/complaint webhooks, email_threads table                             |—        |
|planned|Email bundler: 9am-9pm workspace TZ, threaded per work unit                                                         |—        |
|planned|Push (urgent only, Sorted-fired): FCM + APNs + Web Push, gated 9am-9pm                                              |—        |
|planned|LinkedIn Insights ingestion: hourly 24h, daily 7d, weekly 30d, daily through day 90                                 |—        |
|planned|Insights surface: per-post, workspace dashboard, per-client view                                                    |—        |
|planned|cmd+K Search: Postgres FTS for entities/comments, Agora SDK for chat                                                |—        |
|planned|Stripe billing: per-platform additive tiers, 14-day trial, nudges, lifecycle states                                 |—        |
|planned|Stripe reconciliation cron: 03:00 UTC daily desync correction + E2E tests                                           |—        |
|planned|Cockpit subdomain platform.srtd.io: shell, passkey auth, env badge                                                  |—        |
|planned|Cockpit Dashboard: hero tiles, attention list, recent actions, alerts                                               |—        |
|planned|Cockpit Workspace mgmt + Actions retry, replay, restart, oauth, re-auth                                             |—        |
|planned|Cockpit Impersonation: capability-scoped, 30-min cap, emergency-exit.html                                           |—        |
|planned|Cockpit Tickets, Notifications, Feature Flags                                                                       |—        |
|planned|Cockpit Deploys + Actions revoke sessions, billing override, extend trial, kill switch, revoke canonical share token|—        |
|planned|Webhook signature alerts, queue health, RLS CI, capability audit CI, Agora mirror health                            |—        |
|planned|v1 URL redirect worker: old magic-link clicks land on v2 login                                                      |—        |
|planned|Workspace settings UI: name, timezone, billing, members, LinkedIn connection, 7-day soft-delete, ownership transfer |—        |
|planned|Cutover: interceptor on v1, ETL cutover mode run, checksum validator, rollback rehearsal                            |—        |

Total: 67 PRs. 23 parallel-safe. 44 sequenced. 4 blocked on Plan design.

-----

## Goals and scope

|Item                  |Decision                                                           |
|----------------------|-------------------------------------------------------------------|
|Launch date           |July 2026 (web)                                                    |
|Native mobile         |Deferred. Reassess month 3 post-launch.                            |
|Public signup         |Live at launch. Paid.                                              |
|v1 tenant cutover     |Separate track. Decoupled from public signup date.                 |
|New tenants pre-launch|Free.                                                              |
|Launch platform       |LinkedIn only. Other platforms: OAuth + schema only.               |
|Repo                  |Greenfield. srtdio/app. Supabase Pro Mumbai (movnexawfhsyuluspxoc).|
|Domain                |srtd.io. Cockpit at platform.srtd.io.                              |

-----

## Batch summary

|Batch                        |Scope                                                                                  |Gate to next batch                                                                                                     |
|-----------------------------|---------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------|
|B1 Foundation                |Repo, infra, observability, auth, RLS tests, SECURITY DEFINER procs, workspaces, ETL   |Auth works. RLS CI green. Trace IDs end-to-end. Zod drift gate. SECURITY DEFINER procs reviewed. ETL seeds dev from v1.|
|B2 Core                      |Core entities, Comments, PCS, Pipeline, stage state machine                            |Create post, comment, version, annotate, move stages per locked matrix. Pipeline reflects stage.                       |
|B3 Briefs/Inbox/Chat/Assets  |Briefs, Inbox, Chat (Agora), Assets. Plan blocked.                                     |Briefs operational. Chat live via Agora. Inbox is home surface. Assets versioned.                                      |
|B4 Publishing/Cockpit/Cutover|Publishing, Canonical share, Notifications, Insights, Search, Billing, Cockpit, Cutover|LinkedIn publish E2E. Trial converts to paid. Cockpit operates a tenant. v1 cutover rehearsed.                         |

-----

## B1 Foundation

### Repo bootstrap: TS strict, Vite, Tailwind, ESLint boundaries (no .js/.jsx anywhere), CI

Status: `planned`
GitHub PR: —
Depends on: nothing
Parallel: no

Greenfield repo at srtdio/app. TypeScript strict mode everywhere. Vite. Tailwind. ESLint flat config with explicit rule rejecting .js, .jsx, .mjs, .cjs files (not just convention). pnpm workspaces with packages/ layout. CI pipeline: typecheck, lint, format-check, test, build.

### Cloudflare Workers config, Pages, R2 buckets, DNS srtd.io, user-avatars bucket

Status: `planned`
GitHub PR: —
Depends on: nothing
Parallel: yes

Cloudflare account setup. Workers config (wrangler.toml). Pages config. R2 bucket per workspace pattern (created at runtime, not pre-provisioned). Shared user-avatars R2 bucket (public read, authenticated write via Worker). DNS srtd.io. Subdomains: app.srtd.io, platform.srtd.io.

### Sentry frontend + backend projects, source maps

Status: `planned`
GitHub PR: —
Depends on: nothing
Parallel: yes

Sentry projects for frontend and backend. Source map upload in CI. Error grouping by trace_id when the system lands.

### Trace ID system: uuid_v7 propagation FE/API/DB/queue (ESLint enforces on .rpc())

Status: `planned`
GitHub PR: —
Depends on: Repo bootstrap
Parallel: no

uuid_v7 trace ID generated at the entry boundary. Propagated through fetch wrapper, supabase.rpc() wrapper, queue jobs, worker invocations. ESLint rule rejects raw .rpc() calls; forces use of the wrapper that injects _trace_id. DB-side uuidv7() helper function.

### Structured JSON logging to Cloudflare Logpush, R2 sink

Status: `planned`
GitHub PR: —
Depends on: Cloudflare Workers config, Pages, R2 buckets, DNS srtd.io, user-avatars bucket; Trace ID system
Parallel: no

Structured JSON loggers for frontend and backend. Single-line JSON output. Field redaction for known secrets patterns. 8KB cap per log line. Logpush job pushes to R2 srtdio-logs bucket. Provisioned in CI, not manual.

### Zod shared package, Supabase type-gen, CI drift gate

Status: `planned`
GitHub PR: —
Depends on: Repo bootstrap
Parallel: no

packages/schemas Zod package. supabase gen types script generates packages/schemas/src/supabase.generated.ts from live DB. CI schema-drift gate fails on git diff –exit-code. Generated file is committed; drift detection is part of every PR.

### Commit applied schema as migration files

Status: `planned`
GitHub PR: —
Depends on: nothing
Parallel: yes

All 40 tables, RLS policies, triggers, indexes, functions live in DB but missing from migration files. This PR commits them as one big timestamped migration in supabase/migrations/. Includes public.users profile table, auto-create trigger on auth.users insert, all *_by FK repoints to public.users with ON DELETE SET NULL except workspaces.owner_user_id (RESTRICT). PR prompt notes: “Schema already applied to live DB. Do NOT execute migration. This is repo housekeeping only.”

### RLS CI test suite: cross-tenant isolation tests for every tenant-scoped table

Status: `planned`
GitHub PR: —
Depends on: Commit applied schema as migration files
Parallel: no

Test suite that creates two workspaces with members, attempts cross-tenant reads, asserts isolation. One test per tenant-scoped table. Runs in CI. Fails build on any isolation violation.

### Auth: magic-link signup, login, password, JWT 15min + refresh

Status: `planned`
GitHub PR: —
Depends on: Commit applied schema as migration files; RLS CI test suite
Parallel: no

Magic-link signup. Email + password login. JWT 15-minute expiry. Refresh token flow. Signup form: name (-> public.users.display_name), email, password, workspace name, workspace timezone (auto-detected).

### session_devices fingerprint capture + RLS gate on every auth request

Status: `planned`
GitHub PR: —
Depends on: Auth
Parallel: no

Device fingerprint hash (SHA-256 of user-agent + IP subnet + browser features). Captured on every auth request. RLS gate joins session_devices on user_id and fingerprint_hash. Stale or unknown fingerprints get a forced re-auth.

### SECURITY DEFINER procs consolidated

Status: `planned`
GitHub PR: —
Depends on: Commit applied schema as migration files; RLS CI test suite
Parallel: no

All sensitive write paths through SECURITY DEFINER functions. Procs included: stage_transition, approval_act, member_invite, member_accept, post_version_create, annotation_create, share_token_create, share_token_revoke, publish_enqueue, schedule_cancel. INSERT/UPDATE/DELETE revoked from authenticated role on all sensitive tables. Each proc validates capability via has_capability(), validates workspace tenancy, writes audit_log row.

### Workspace creation flow + member invite + role assignment + onboarding checklist card

Status: `planned`
GitHub PR: —
Depends on: Auth; SECURITY DEFINER procs consolidated
Parallel: no

Workspace creation form. Member invite by email. Role assignment (Owner / Admin / Agency / Client). public.users profile editing UI: display_name (1-80 chars), designation (optional), avatar upload to user-avatars R2 bucket. Onboarding checklist card on Dashboard: 5 items, auto-checks on workspace events, hides on >= 4 of 5 checked or manual dismiss.

### Idempotency-Key middleware on all mutating endpoints

Status: `planned`
GitHub PR: —
Depends on: Trace ID system; Zod shared package
Parallel: yes

Idempotency-Key HTTP header on every POST / PUT / PATCH / DELETE. Server stores key + response for 24 hours. Replay returns cached response. Key collision with different body returns 409 Conflict.

### Audit log write helper, indexed on trace_id

Status: `planned`
GitHub PR: —
Depends on: Trace ID system; Commit applied schema as migration files
Parallel: yes

Type-safe wrapper around audit_log_write() SECURITY DEFINER function. Called from every SECURITY DEFINER proc and every webhook handler. Indexed on trace_id. 90-day retention. Partitioned monthly.

### ETL v1->v2 single-shot: dev-seed mode + cutover mode

Status: `planned`
GitHub PR: —
Depends on: Commit applied schema as migration files
Parallel: yes

Single TypeScript ETL script. Two modes. Dev-seed: PII scrubbed (emails hashed, names replaced), runs throughout B1-B3 to seed dev from v1. Cutover: real data, runs on cutover day against latest v1 state. Brings over workspaces, posts, briefs, assets, comments, schedule. Does NOT bring over users. Legacy *_by columns set NULL, displayed as ‘(ex-member)’ in UI. Owner set to agency operator at ETL time; transferred post-cutover via PR Workspace settings UI.

-----

## B2 Core

### Discussion component shell: shared Composer, MessageRow, mention picker

Status: `planned`
GitHub PR: —
Depends on: Workspace creation flow + member invite + role assignment + onboarding checklist card
Parallel: no

Shared React components for Comments and Chat: Composer, MessageRow, mention picker. 44x44 touch targets throughout. Used by both Postgres Comments and Agora Chat primitives.

### Comments primitive: Supabase Realtime, reactions, edit 5min, soft-delete + E2E tests

Status: `planned`
GitHub PR: —
Depends on: Discussion component shell
Parallel: no

Comments entity write/read via Supabase Realtime. Entity-anchored (post, brief, plan_cell). Emoji reactions. Edit window 5 minutes. Soft-delete. E2E tests cover create, edit, react, delete, realtime propagation. Critical-surface PR.

### Decision Records: flag + filterable view

Status: `planned`
GitHub PR: —
Depends on: Comments primitive
Parallel: yes

Boolean is_decision flag on comments. Filterable view on PCS / Brief / Plan cell surfaces. Indexed in comments_decision_idx.

### Post creation API + Create sheet

Status: `planned`
GitHub PR: —
Depends on: SECURITY DEFINER procs consolidated; Discussion component shell
Parallel: no

Post creation via SECURITY DEFINER proc. Create sheet UI: single mode (no quick mode), all fields visible (no accordion). Required: title, caption, channel. Optional: asset gallery, content_pillar, content_type, target_date, owner, Origin (Brief link). Commit action: Save as Draft.

### PCS skeleton: header, caption editor, asset gallery, metadata sidebar

Status: `planned`
GitHub PR: —
Depends on: Post creation API + Create sheet
Parallel: no

Post Control System surface. Header with title and stage badge. Caption editor with rich text. Asset gallery showing current version. Metadata sidebar (target_date, owner, brief link, etc.). Three-tab comments panel. Approve button (PCS only, never on Pipeline cards).

### Annotations: caption span + image pin, immutable, version-locked

Status: `planned`
GitHub PR: —
Depends on: PCS skeleton
Parallel: no

post_annotations: caption_span (start/end positions, image fields NULL) or image_pin (image_x/y + asset_attachment_id, caption fields NULL). Immutable (no deleted_at). Bound to specific post_version_id. Annotations on outdated versions stay in DB forever, displayed greyed out with ‘copy changed’ indicator.

### Auto-versioning on every edit + Version history panel

Status: `planned`
GitHub PR: —
Depends on: PCS skeleton
Parallel: no

post_versions: snapshot per pre-publish edit. Immutable, no deleted_at. Version history panel in PCS. Pre-existing annotations stay on their version forever. Rollback supported pre-publish only.

### Stage state machine + E2E tests on every transition

Status: `planned`
GitHub PR: —
Depends on: PCS skeleton
Parallel: no

Stage transitions via SECURITY DEFINER proc stage_transition. Transition map: draft -> review/parked; review -> scheduled (on approval)/parked/rejected/draft (revise); scheduled unschedulable to review/draft/parked/rejected; parked/rejected revive to review only; published TERMINAL. publish_status auto-resets to draft on unschedule. schedule_job auto-cancels on unschedule. CHECK constraint already in DB. E2E test for every legal transition AND every illegal transition (must error); expect parked/rejected revive to review. Critical-surface PR.

### Pipeline: vertical kanban desktop, accordion mobile, urgency colors

Status: `planned`
GitHub PR: —
Depends on: Stage state machine
Parallel: no

Pipeline surface: vertical kanban on desktop, accordion on mobile. Stage columns: Draft (agency-only), Review, Scheduled, Published, Parked, Rejected (6 stages). Owner colors, urgency colors based on target_date proximity. Client visibility: all stages except Draft.

### Filters + saved views + bulk actions (agency only, cap 10)

Status: `planned`
GitHub PR: —
Depends on: Pipeline
Parallel: yes

Pipeline filters: owner, channel, content_type, target_date range, has_blocking_comment, has_brief, has_brand_input. Saved views per workspace per user. Bulk actions (agency only): move stage, assign owner, add tag, archive. Cap 10 posts per action. Client gets zero bulk actions.

-----

## B3 Briefs/Inbox/Chat/Assets

### Briefs entity: client-only creation, Open/Closed states, comment/withdraw, no edits

Status: `planned`
GitHub PR: —
Depends on: Comments primitive
Parallel: no

Briefs table. Client-only creation. Open (default) or Closed (soft). Required: title, objective. Optional: format_requested, brand_requirements, target_date, references, initial comment. No edits after creation. Client can comment and close (withdraw). Agency can comment and close. Derived linked-posts count on brief detail panel.

### Email-forwarding intake: workspace inbound address, MIME parse, asset link

Status: `planned`
GitHub PR: —
Depends on: Briefs entity
Parallel: no

Per-workspace inbound email address. MIME parser extracts subject -> brief.title, body -> brief.objective, attachments -> assets linked to the brief.

### Plan: calendar grid, cell detail panel, drag reschedule

Status: `blocked`
GitHub PR: —
Depends on: Comments primitive
Parallel: no
Blocked on: Plan section design lock (PRD §9 TBD).

### Plan states + period approval modes

Status: `blocked`
GitHub PR: —
Depends on: Plan calendar grid
Parallel: no
Blocked on: Plan section design lock (PRD §9 TBD).

### Plan Approved spawns Draft post with Origin=Plan

Status: `blocked`
GitHub PR: —
Depends on: Plan states + period approval modes
Parallel: no
Blocked on: Plan section design lock (PRD §9 TBD).

### Plan alignment view: actual vs target distribution

Status: `blocked`
GitHub PR: —
Depends on: Plan calendar grid
Parallel: yes
Blocked on: Plan section design lock (PRD §9 TBD).

### Inbox: topbar icon, badge, state chips, scope dropdown, snooze options

Status: `planned`
GitHub PR: —
Depends on: Comments primitive
Parallel: no

Permanent in-app event feed. Topbar icon with unread badge. State chips: All, Unread, Snoozed. Scope dropdown (filled out by next PRs). Snooze options: 1h, 4h, tomorrow 9am, next week.

### Inbox flat scopes: Everything, Posts, Briefs

Status: `planned`
GitHub PR: —
Depends on: Inbox
Parallel: no

Flat scopes for the dropdown: Everything (default), Posts, Briefs. Each shows inbox_entries filtered by scope column.

### Inbox drill scopes: Plans, People, Groups, Clients

Status: `planned`
GitHub PR: —
Depends on: Inbox
Parallel: yes

Drill scopes: Plans, People, Groups, Clients. Drill scopes show second-level picker (which plan, which person, which group, which client).

### Groups: create modal, naming rules, #group-name addressability

Status: `planned`
GitHub PR: —
Depends on: Inbox
Parallel: yes

Groups table. Create modal. Name regex: ^[A-Za-z0-9 -]{1,40}$. Unique per workspace (case-insensitive). #group-name addressability for mentions. Sorted is source of truth; Agora ACL mirrors via REST.

### Anchored messages (comments): caption span + image pin, version-locked

Status: `planned`
GitHub PR: —
Depends on: Annotations; Comments primitive
Parallel: no

Comments with anchor type: caption_span or image_pin. Hooks into post_annotations via comment_id FK. Version-locked: annotation stays on the post_version it was created against.

### Agora workspace setup, channel ID convention, token mint endpoint

Status: `planned`
GitHub PR: —
Depends on: Commit applied schema as migration files
Parallel: no

Agora workspace provisioned. Channel ID convention: dm__W__min(A,B)__max(A,B); group__W__G; plan__W__P. Token mint endpoint: 15-min JWT-aligned tokens, per-channel ACL at creation.

### Chat primitive: SDK wrap, DM, Group, Plan-period channels

Status: `planned`
GitHub PR: —
Depends on: Groups; Agora workspace setup; Discussion component shell
Parallel: no

SDK wrapper. DM, Group, Plan-period channel types. Reads live from Agora SDK; never from Postgres mirror. UI uses same shared Composer / MessageRow components as Comments.

### Chat mirror cron: Cloudflare Cron every 6h pulls Agora REST history

Status: `planned`
GitHub PR: —
Depends on: Agora workspace setup
Parallel: no

Cloudflare Cron every 6 hours. Pulls Agora REST history per channel. Per-channel cursor in chat_channels.last_synced_at. Mirror used only for 90-day retention, GDPR export, email digest aggregation, audit. Never on read path.

### Chat reconciliation cron: 04:00 UTC daily Agora vs mirror diff

Status: `planned`
GitHub PR: —
Depends on: Chat mirror cron
Parallel: yes

Daily 04:00 UTC cron. Compares Agora REST counts vs chat_messages counts per channel. > 5% drift fires P3 alert. > 20% drift fires P2 alert.

### Assets: upload pipeline, MIME allowlist, EXIF strip, SVG sanitize, virus scan, R2 per-workspace bucket

Status: `planned`
GitHub PR: —
Depends on: Cloudflare Workers config, Pages, R2 buckets, DNS srtd.io, user-avatars bucket; Commit applied schema as migration files
Parallel: no

Upload pipeline Worker. MIME allowlist. EXIF strip. SVG sanitize. Virus scan. Writes to R2 bucket per workspace (created on first upload). Returns asset_version row.

### Assets surface: folders, tags, asset_version chain UI, pre-publish banner, delete-protection toast

Status: `planned`
GitHub PR: —
Depends on: Assets upload pipeline
Parallel: no

Assets UI: folders by folder_path, tags, search. Shows current version. Kebab > Version history. Pre-publish ‘newer version available’ banner with [Use new] / [Keep current]. Delete-protection: ‘Asset in use. Remove from posts/briefs first.’ toast when attachments exist.

### Trash: soft-delete UI, 30-day recovery for assets, 7-day for workspaces, cleanup cron

Status: `planned`
GitHub PR: —
Depends on: Assets surface
Parallel: yes

Recently-deleted drawer item. 30-day recovery for assets. 7-day recovery for workspaces. Cleanup cron at 02:00 UTC hard-deletes past-window rows.

### Search prep: tsvector indexes on comments, posts, briefs, assets

Status: `planned`
GitHub PR: —
Depends on: Discussion component shell; Post creation API + Create sheet; Briefs entity; Assets upload pipeline
Parallel: yes

GIN indexes with to_tsvector(‘english’, …) on: comments.body, posts.title + caption, briefs.title + objective, assets.filename. Already partial WHERE deleted_at IS NULL. Confirms indexes match live DB.

-----

## B4 Publishing/Cockpit/Cutover

### LinkedIn OAuth: connect flow, envelope-encrypted token storage, refresh worker

Status: `planned`
GitHub PR: —
Depends on: Workspace creation flow + member invite + role assignment + onboarding checklist card
Parallel: no

LinkedIn OAuth connect flow. Tokens envelope-encrypted in platform_accounts (DEK + KEK pattern). Refresh worker before expiry. Disconnect with grace period.

### schedule_jobs: idempotent enqueue, Cloudflare Cron every minute

Status: `planned`
GitHub PR: —
Depends on: SECURITY DEFINER procs consolidated; LinkedIn OAuth
Parallel: no

schedule_jobs table populated via SECURITY DEFINER publish_enqueue proc. Idempotent enqueue (PK is post_id, idempotency_key unique). Cloudflare Cron polls every minute.

### Publish Queue Worker: dequeue, LinkedIn API, retry 3x backoff, circuit breaker + E2E tests

Status: `planned`
GitHub PR: —
Depends on: schedule_jobs
Parallel: no

Worker dequeues pending jobs. Calls LinkedIn API. Retry 3 times with exponential backoff. Circuit breaker on consecutive failures. Logs attempts to schedule_job_logs. Critical-surface PR with E2E tests.

### publish_status state machine in worker + PCS publish-failed banner + Published frozen

Status: `planned`
GitHub PR: —
Depends on: Publish Queue Worker; PCS skeleton
Parallel: no

Worker advances publish_status: scheduled -> publishing -> published or publish_failed -> publish_failed_final. PCS shows publish-failed banner when in publish_failed_final. Published is terminal: ‘Edit on LinkedIn’ deep-link replaces edit controls. No rollback from published.

### Canonical share token: auto-create on post creation, public read-only view, revoke endpoint

Status: `planned`
GitHub PR: —
Depends on: Post creation API + Create sheet
Parallel: yes

share_tokens row auto-created in SECURITY DEFINER post_create proc. Public view at /s/{token}: latest version, current stage, all live comments. No expiry. Chat NEVER shown on public view. Revoke endpoint (used by Cockpit action revoke canonical share token).

### Resend integration: notifications table, bounce/complaint webhooks, email_threads table

Status: `planned`
GitHub PR: —
Depends on: Sentry frontend + backend projects, source maps
Parallel: no

Resend API integration. Bounce and complaint webhooks. email_threads table for RFC-822 Message-ID anchoring per work unit (brief if post originated from brief, else post).

### Email bundler: 9am-9pm workspace TZ, threaded per work unit

Status: `planned`
GitHub PR: —
Depends on: Resend integration; Inbox
Parallel: yes

Bundler runs every 15 minutes. Pulls unread inbox_entries per user. Builds digest per work unit (brief or post). Threaded with Message-ID chains. Sends only between 9am-9pm workspace TZ. Outside hours queued, sent next 9am. Skips if user active in app within last 5 minutes.

### Push (urgent only, Sorted-fired): FCM + APNs + Web Push, gated 9am-9pm

Status: `planned`
GitHub PR: —
Depends on: Resend integration
Parallel: yes

FCM + APNs + Web Push for urgent inbox_entries (tier=‘urgent’). Gated to 9am-9pm workspace TZ. Per-user opt-in toggle. Agora native push for chat mentions (MENTION_ONLY mode) is separate and not time-gated.

### LinkedIn Insights ingestion: hourly 24h, daily 7d, weekly 30d, daily through day 90

Status: `planned`
GitHub PR: —
Depends on: Publish Queue Worker
Parallel: no

Insights polling cadence: hourly first 24h, daily through day 7, weekly through day 30, daily again through day 90, then stop. Post-90d uses on-demand ‘Refresh from LinkedIn’ button. Fetch failure shows last cached + ‘Last updated [time ago]’. Never zeros or errors.

### Insights surface: per-post, workspace dashboard, per-client view

Status: `planned`
GitHub PR: —
Depends on: LinkedIn Insights ingestion
Parallel: no

Per-post panel in PCS. Workspace dashboard (last 30 days, cached only). Per-client view in agency mode. Agency sees full metrics including click-through and comparison-to-workspace-average. Client sees curated subset: impressions, reactions, comments, shares.

### cmd+K Search: Postgres FTS for entities/comments, Agora SDK for chat

Status: `planned`
GitHub PR: —
Depends on: Search prep; Chat primitive
Parallel: no

cmd+K palette. Scope chips: All, Posts, Briefs, Plans, Comments, Chat, Assets, People. Postgres FTS for entities and comments using tsvector indexes from Search prep PR. Agora SDK for chat. Result ranking: recency + relevance.

### Stripe billing: per-platform additive tiers, 14-day trial, nudges, lifecycle states

Status: `planned`
GitHub PR: —
Depends on: Workspace creation flow + member invite + role assignment + onboarding checklist card
Parallel: no

Stripe per-platform additive billing. Tiers: Solo 499, Studio 749, Agency 999 INR per platform per month. Each additional platform adds the tier price. 14-day trial, account-wide, no card upfront. Nudges day 7, 10, 12, 13, 14. Per-workspace activation. Lifecycle states: active, grace 3d, soft_pause 10d, full_pause 30d, soft_delete 60d, hard_delete. Critical-surface PR.

### Stripe reconciliation cron: 03:00 UTC daily desync correction + E2E tests

Status: `planned`
GitHub PR: —
Depends on: Stripe billing
Parallel: yes

Daily 03:00 UTC cron. Reconciles workspaces.subscription_state with Stripe customer state. Corrects desyncs. E2E tests for desync scenarios.

### Cockpit subdomain platform.srtd.io: shell, passkey auth, env badge

Status: `planned`
GitHub PR: —
Depends on: Auth; SECURITY DEFINER procs consolidated
Parallel: no

platform.srtd.io subdomain. Shell layout. Passkey-only auth (no password fallback). Env badge (prod/staging/dev). Mobile-first, iPhone primary.

### Cockpit Dashboard: hero tiles, attention list, recent actions, alerts

Status: `planned`
GitHub PR: —
Depends on: Cockpit subdomain; Audit log write helper
Parallel: no

Cockpit Dashboard. Hero tiles: total workspaces, active subs, in-trial, paused. Attention list: failed publishes, billing failures, webhook signature failures. Recent actions: last 50 operator actions from audit_log. Alerts: P2/P3 active.

### Cockpit Workspace mgmt + Actions retry, replay, restart, oauth, re-auth

Status: `planned`
GitHub PR: —
Depends on: Cockpit Dashboard
Parallel: no

Workspace management surface. Actions 1-5: retry failed publish, replay webhook, restart background job, force OAuth disconnect, trigger re-auth email. All tap-to-execute, no confirm modal.

### Cockpit Impersonation: capability-scoped, 30-min cap, emergency-exit.html

Status: `planned`
GitHub PR: —
Depends on: Cockpit Workspace mgmt; SECURITY DEFINER procs consolidated
Parallel: no

Impersonation: capability-scoped (read-only or read-write per session). 30-min hard cap. Every action logged to audit_log with impersonator + impersonated. Emergency exit at static emergency-exit.html if Sorted is down. Persistent banner during impersonation.

### Cockpit Tickets, Notifications, Feature Flags

Status: `planned`
GitHub PR: —
Depends on: Cockpit Dashboard
Parallel: yes

Tickets surface. Notifications surface. Feature flags CRUD: global vs per-workspace, killswitch / rollout / experiment / tier_gated categories.

### Cockpit Deploys + Actions revoke sessions, billing override, extend trial, kill switch, revoke canonical share token

Status: `planned`
GitHub PR: —
Depends on: Cockpit Impersonation
Parallel: no

Deploys surface (CI/CD status). Action revoke all sessions for user (modal confirm). Action billing override (modal + reason). Action extend trial (modal: days + reason). Action global kill switch (type ‘KILL’ + reason). Action revoke canonical share token (tap, no confirm).

### Webhook signature alerts, queue health, RLS CI, capability audit CI, Agora mirror health

Status: `planned`
GitHub PR: —
Depends on: RLS CI test suite; Audit log write helper
Parallel: yes

Alerts: webhook signature failures, queue health (depth, age, dead-letter), RLS CI failures, capability audit CI failures, Agora mirror health (cron failures, drift).

### v1 URL redirect worker: old magic-link clicks land on v2 login

Status: `planned`
GitHub PR: —
Depends on: Canonical share token
Parallel: yes

Worker on v1 domain. Any old v1 URL (magic-link approval, PCS deep links, brief URLs) redirects to v2 login at app.srtd.io with friendly ‘Sorted has been upgraded’ page.

### Workspace settings UI: name, timezone, billing, members, LinkedIn connection, 7-day soft-delete, ownership transfer

Status: `planned`
GitHub PR: —
Depends on: Workspace creation flow + member invite + role assignment + onboarding checklist card; Stripe billing
Parallel: yes

Workspace settings UI. Sections: workspace name, timezone, billing, members (add/remove/change role), LinkedIn connection, 7-day soft-delete, transfer ownership. Owner self-delete blocked at DB (FK is ON DELETE RESTRICT); UI explains ‘transfer ownership first or delete the workspace’.

### Cutover: interceptor on v1, ETL cutover mode run, checksum validator, rollback rehearsal

Status: `planned`
GitHub PR: —
Depends on: every prior PR in this list (final gate)
Parallel: no

v1 write interceptor (read-only). ETL cutover mode run. Checksum validator (row counts, key sums). Rollback rehearsal. Post-cutover: agency invites clients fresh via Workspace creation flow invite path. Critical-surface PR.

-----

## Parallelism rules

- Within a batch, PRs marked Parallel `yes` whose dependencies have all merged can run in separate Claude Code sessions.
- PRs marked Parallel `no` are critical-path within their batch.
- Plan section PRs are blocked. Do not start until Plan model is locked in PRD §9.

## Claude Code handoff rules

- One PR per Claude Code prompt.
- Every prompt ends verbatim: `Return your entire response in ONE code block, most token-efficient form, no prose outside it.` and `After pushing, reply with the exact GitHub PR URL in this format: https://github.com/srtdio/app/pull/[PR-number]`.
- Audit prompts are read-only. No branches, PRs, version bumps, or CLAUDE.md edits.
- Audit before any fix prompt.
- Schema changes: state SQL in chat, get approval, execute via Supabase MCP with project_id="movnexawfhsyuluspxoc" passed explicitly, verify via information_schema, then PR prompt notes ‘Schema already applied. Do NOT execute.’ Any prompt that says "Supabase" or "Mumbai" without the v2 project ID must be rejected. v1 project ID ozptjplxbyswclolbxyn appears only in the cutover prompt and the ETL script.
- Auto-merge disabled. Shubham merges manually.
- Critical-surface PRs (auth, RLS, billing, ETL, publish queue, canonical share token, comments, stage state machine, PCS, post lifecycle, cutover) require E2E tests in scope.
- Internal team (Hinglish Agency) is the beta cohort throughout build. No external beta program at v2.0.
- Phase 1 backend, Phase 2 ETL, Phase 3 frontend. No interleaving.
- TypeScript strict everywhere. No .js, .jsx, .mjs, .cjs anywhere.
- When a PR merges, Claude Code updates this file in the same PR: status changes to `merged` and the GitHub PR URL is added.
