# Sorted v2 PR List (MVP)

Social-media post approval tool. Greenfield. Org `srtdio`, repo `app`. Author: Shubham Gune.
Regenerated 23 May 2026 after the MVP stripdown. Replaces the old 67-PR list (publishing, scheduling, plan, insights, approvals-table, share-tokens all dead).

## 0. Project identifiers and DANGER

| Env | Project ID | Status | Touch from v2 PRs? |
| --- | --- | --- | --- |
| v2 | movnexawfhsyuluspxoc | Build target | YES |
| v1 | ozptjplxbyswclolbxyn | LIVE PRODUCTION | NO. Only the cutover PR, only on cutover day. |

Both projects are Mumbai. Region is NOT a disambiguator. Project ID is the only safe identifier.
Every Claude Code prompt that touches Supabase MUST pass `project_id="movnexawfhsyuluspxoc"` explicitly.
The v1 project ID appears only in the ETL script and the cutover PR.

## 1. How to read

- PRs are numbered. Numbers are labels, not a fixed order. Order will change.
- "Depends on" lists the PR numbers that must merge first. "none" means standalone, can run anytime in parallel.
- No status column, no batch gates. Statuses drift; this list does not track them.
- Grouped only by the three locked build phases (PRD section 24): Backend, ETL, Frontend.
  No interleaving across phases. No PR depends on a later phase.
- Approval is a post stage transition, not a feature. No publishing, scheduling, plan, or insights anywhere.

## 2. Phase 1: Backend

| # | Title | Depends on |
| --- | --- | --- |
| 1 | Regenerate baseline migration from the stripped live DB: all 30 base tables + 3 partitioned parents + 9 partitions, RLS, triggers, indexes, public.users + auto-create trigger, all *_by FK rules. Replaces the old baseline + rename_stages migrations. Schema already applied. Do NOT execute. | none |
| 2 | Regenerate supabase.generated.ts and Zod schemas from the stripped live DB. Drop all dead-table types. Drift gate green. | 1 |
| 3 | Leftover-trace cleanup migration: drop dead CHECK values (comments/inbox plan_cell + plan_period; chat_channels plan; intent_ledger share_token), drop workspace_onboarding.linkedin_connected_at + first_schedule_at, add webhook_events.source value agora. SQL stated in chat and approved first. | 1 |
| 4 | RLS CI test suite: cross-tenant isolation tests for every tenant-scoped table | 1 |
| 5 | SECURITY DEFINER procs consolidated: stage_transition, post_version_create, annotation_create, member_invite, member_accept, brief_create, brief_close. INSERT/UPDATE/DELETE revoked from authenticated on sensitive tables. | 1, 4 |
| 6 | Auth: magic-link signup, login, password, JWT 15 min + refresh | 1, 4 |
| 7 | session_devices fingerprint capture + RLS gate on every auth request | 6 |
| 8 | Workspace creation + member invite + role assignment (owner/admin/agency/client) + workspace_role_permissions defaults + public.users profile editing (display_name, designation, avatar upload to user-avatars bucket) | 6, 5 |
| 9 | Idempotency-Key middleware on all mutating endpoints | none |
| 10 | Audit log write helper, indexed on trace_id (table already exists) | none |
| 11 | Posts domain: stage state machine (draft to review/parked, review to approved/rejected/parked, approved to parked/rejected, parked and rejected revive to review, approved not terminal; matrix CHECK already in DB) + post create, version, annotate APIs via SECURITY DEFINER. post_versions and post_annotations immutable, no deleted_at. + E2E on every transition. | 5 |
| 12 | idempotency_keys table: service-role-only infra table (RLS enabled, no policies; service_role bypasses RLS and is the sole writer), unique scope index (key, workspace_id, user_id) NULLS NOT DISTINCT, expires_at index + regenerate supabase.generated.ts and Zod schemas, drift gate green. Schema already applied. Do NOT execute. | 1 |
| 13 | Comments primitive backend: entity-anchored, reactions, edit window, soft-delete, decision flag, Supabase Realtime channel + E2E | 5 |
| 14 | Briefs backend: client-only create, open/closed, comment + close, no edits after creation, derived linked-post count + E2E | 5 |
| 15 | Assets backend: upload pipeline (MIME allowlist, EXIF strip, SVG sanitize, virus scan), R2 per-workspace bucket, asset_versions chain, asset_attachments bind to asset_version_id (NO ACTION) | none |
| 16 | Inbox backend: inbox_entries writes for all MVP event types, scope routing, snooze, partition-ahead cron | 5 |
| 17 | Agora setup: channel ID convention (dm/group only), 15-min token mint endpoint JWT-aligned, per-channel ACL at creation | 1 |
| 18 | Chat mirror cron (Agora REST to chat_messages, per-channel cursor) + reconciliation cron 04:00 UTC (>5% P3, >20% P2) | 17, 3 |
| 19 | Groups backend: create, naming rules, group_members, Agora ACL mirror via REST | 8 |
| 20 | Email backend: Resend integration, email_threads, delivery_attempts, bounce/complaint webhooks, 9am-9pm workspace-TZ bundler, Message-ID chains (brief if linked, else post) | 10 |
| 21 | Push backend: FCM + APNs + Web Push, urgent-only, gated 9am-9pm workspace TZ, per-user opt-in | 20 |
| 22 | Search prep: tsvector indexes on comments, posts, briefs, assets | 1 |
| 23 | Cockpit backend: passkey auth, platform_operators, audit_log wiring, intent_ledger, pending_flows, allowlisted procs, impersonation (capability-scoped, 30-min cap) | 5, 10 |
| 24 | Feature flags backend: killswitch / rollout / experiment / tier-gated, global + per-workspace | 1 |
| 25 | Stripe billing backend: per-workspace tiers, 14-day trial, nudge cadence (day 7/10/12/13/14), lifecycle states (trial/active/grace/soft_pause/full_pause/soft_delete), reconciliation cron | 8 |
| 26 | Trash backend: soft-delete + restore for assets (30 days) and workspaces (7 days), cleanup cron | 15 |
| 27 | Alerts and monitoring: webhook signature failures, RLS CI, capability audit CI, mirror cron failures, Agora reconciliation drift | 4, 10 |

## 3. Phase 2: ETL

| # | Title | Depends on |
| --- | --- | --- |
| 28 | ETL v1 to v2 single-shot: dev-seed mode (PII scrubbed) + cutover mode. Brings over workspaces, posts, briefs, assets, comments. Does NOT bring over users (fresh signup post-cutover). Legacy *_by columns set NULL, displayed as ex-member. Owner set to agency operator at ETL time. The v1 project ID appears here. | 1, 5 |
| 29 | Cutover run: interceptor on v1, ETL cutover mode, checksum validator, rollback rehearsal. Post-cutover the agency invites each client fresh via the invite flow. The v1 project ID appears here. | 28, and a working backend (Phase 1 complete) |
| 30 | ETL Run (manual): workflow_dispatch-only GitHub Actions workflow (.github/workflows/etl-run.yml) to run the @srtdio/etl migration. Inputs: mode (dev-seed/cutover), dry_run, operator_email, operator_display_name, workspace_name, confirm_cutover. Guard step fails fast on cutover without confirm_cutover. Never fires on push/PR. Touches no package source. | 28 |

## 4. Phase 3: Frontend

Every frontend PR ships with an explicit light AND dark mode parity check. 44x44 minimum touch targets, no hover-only interactions.

| # | Title | Depends on |
| --- | --- | --- |
| 30 | App shell: topbar (workspace switcher, search trigger, inbox icon + badge, profile menu), left drawer (Pipeline / Briefs / Assets, switcher, Recently deleted, Settings) | 2, 6 |
| 31 | Onboarding: single-scroll signup (name, email magic-link, password, workspace name, timezone), exactly one workspace at signup, empty-state checklist card (owners only, first 30 days, auto-check on events, dismissable) | 30, 8 |
| 32 | Discussion component shell: shared Composer, MessageRow, mention picker | 30 |
| 33 | Comments UI: Realtime thread, reactions, 5-min edit, soft-delete, Decision Records filterable view | 32, 13 |
| 34 | Create sheet: single mode, all fields visible, required title/caption/channel, optional asset gallery/format/target_date/owner/Origin (None or Brief), Save as Draft | 30, 11 |
| 35 | PCS: header, caption editor, asset gallery, metadata sidebar, three-tab comments, auto-version on edit, annotations (caption span + image pin, version-locked, prior-version greyed as copy changed), Approve button (PCS only, client must be logged in) | 34, 33, 11 |
| 36 | Pipeline: vertical kanban desktop, accordion mobile, owner + urgency colors, client visibility = all stages except Draft, filters, saved views, bulk actions (agency only, cap 10) | 35 |
| 37 | Briefs UI: client-only create, open/closed, comment + withdraw, read-only after creation, derived linked-post count, email-forward intake address | 32, 14 |
| 38 | Inbox UI: icon + badge, state chips (All / Unread / Snoozed), scope chips (Everything / Posts / Briefs / People / Groups / Clients), snooze (1h / 4h / tomorrow 9am / next week), inline reply, click navigates to PCS | 30, 16 |
| 39 | Chat UI: Agora SDK wrap, DM + Group channels, reads live from SDK, mirror never on read path. Chat unavailable does not affect the rest of the app. | 32, 17, 19 |
| 40 | Assets UI: folders, tags, version chain, newer-version banner (Use new / Keep current), delete-protection toast and in-use modal, current-version display, kebab version history | 34, 15 |
| 41 | Trash UI: Recently deleted drawer entry, restore button + countdown | 40, 26 |
| 42 | Search UI: cmd+K palette, scope chips (All / Posts / Briefs / Comments / Chat / Assets / People), Postgres FTS for entities + Agora SDK for chat, recency + relevance ranking | 38, 22, 39 |
| 43 | Workspace settings UI: name, timezone, default digest time, member roles, billing, 7-day soft-delete, ownership transfer (immediate, password confirm, owner cannot self-delete until transferred) | 30, 25 |
| 44 | Notifications (ephemeral): toast slide-in desktop + mobile, fires on Inbox triggers while user active, not stored | 38 |
| 45 | Cockpit UI at platform.srtd.io: passkey auth, dashboard, workspace management, actions (replay webhook, restart job, revoke sessions, billing override, extend trial, open ticket, global kill switch), impersonation banner + emergency-exit.html | 23, 30 |

## 5. Handoff rules

- One PR per Claude Code prompt.
- Every prompt ends with: "Return your entire response in ONE code block, most token-efficient form, no prose outside it." and "After pushing, reply with the exact GitHub PR URL in this format: https://github.com/srtdio/app/pull/[PR-number]".
- Audit prompts before any fix prompt. Report-only: no branches, PRs, version bumps, or CLAUDE.md edits.
- Schema changes: state SQL in chat, get approval, execute via Supabase MCP with project_id="movnexawfhsyuluspxoc" passed explicitly, verify via information_schema, then the PR prompt notes "Schema already applied. Do NOT execute." Never target v1 from a v2 schema change.
- Auto-merge disabled. Shubham merges manually. Never defer or pause a PR.
- TypeScript strict everywhere. No .js, .jsx, .mjs, .cjs anywhere (scripts, configs, tests, workers, edge functions all .ts/.tsx).
- Phase order holds: backend, then ETL, then frontend. No interleaving.
- Critical-surface PRs (auth, RLS, ETL, comments, stage transitions, PCS, post lifecycle, billing, cutover) require E2E tests in scope.
- Internal team (Hinglish Agency) is the beta cohort throughout build.
