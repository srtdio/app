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
| 8 | Workspace creation + member invite + role assignment (owner/admin/agency/client) + workspace_role_permissions defaults + public.users profile editing (display_name, designation, avatar upload to user-avatars bucket) + workspace_create client-callable SECURITY DEFINER proc (EXECUTE granted to authenticated, revoked from public) + regenerate supabase.generated.ts, drift gate green. Schema already applied. Do NOT execute. | 6, 5 |
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
| - | Repo hygiene: stop tracking .env.production (public repo). git rm --cached only, file stays on disk; drop the !.env.production negation in .gitignore so the .env.* rule covers it and no production env file can be committed (a real secret could land there later). Tracking-only, no schema. | none |
| - | Scaffold @srtdio/storage package (scaffold) | none |
| - | Move R2 client, buildR2Key, assetBucketName, sha256, mime into @srtdio/storage (runtime-neutral; R2 client receives a traced-fetch via constructor) and repoint app worker imports | 15 |
| - | Chat token Worker: mints 24-hour Agora Chat user tokens for authenticated workspace members (username derived from the Supabase user id via toAgoraUsername, since Agora rejects UUID-shaped names; reversible via fromAgoraUsername), ensures the Agora Chat user exists via REST (idempotent), reuses asset-read's ES256 verify + service-role membership read. Mint only; renewal via SDK onTokenWillExpire, revocation via channel ACL. | 15, 17 |
| - | Chat webhook-mirror Worker: receives Agora Chat post-delivery webhooks, verifies the md5(callId+secret+timestamp) signature before processing (401 + no proc call on failure), and records each event to the DB via the service-role-only chat_webhook_ingest proc (bare service-role supabase-js client, no minted member JWT). Parses source_event_id/event_type and, for message events, channel_id + message id + agora_event_id + body + mentions + attachment asset ids + created_at, reverse-mapping the sender via fromAgoraUsername. Idempotency is the proc + DB unique indexes (no KV dedupe); success/skipped/failure all ack 200 (failure logged loudly, raw event captured for the reconciliation cron), only signature failure or an unreachable DB returns non-2xx. Compliance mirror only, never on any read path. Retroactive migration records the live-applied proc + grants (do NOT execute). | 15, 17 |
| - | Legitimize the out-of-band folders schema: record the live-applied folders table (workspace-scoped self-referential tree, cycle-guard trigger, folders_select_member RLS policy) and assets.folder_id FK (SET NULL) + index as a retroactive migration, regenerate supabase.generated.ts, drift gate green. folder_path retained pending a later reconciliation decision. Flag only (do not fix): folders has SELECT/INSERT/UPDATE/DELETE revoked from authenticated and service_role, so its SELECT policy is unreachable for the app role. Schema already applied. Do NOT execute. | 1, 15 |
| - | Folders RLS hardening: record the live-applied folders grants/policy fix (rebind folders_select_member to the authenticated role, GRANT SELECT to authenticated, GRANT SELECT/INSERT/UPDATE/DELETE to service_role) as a retroactive migration, and extend the RLS CI suite to cover folders with the same anon-deny + cross-tenant isolation matrix as assets. Closes the unreachable-policy / no-service-role-write-path flags from the folders legitimization PR. Schema already applied. Do NOT execute. Must merge AFTER the folders legitimization PR. | 4 |
| - | Group + channel procs (A2a): record the live-applied group_create, group_rename, group_member_add, group_member_remove, group_leave, dm_channel_ensure SECURITY DEFINER procs (search_path='', EXECUTE to authenticated only) as a retroactive migration, regenerate supabase.generated.ts, drift gate green. Gating: group_create / dm_channel_ensure require an active workspace member; group_rename / group_member_add / group_member_remove require the group creator or a workspace owner/admin; group_leave is self only. Schema already applied. Do NOT execute. | 8, 17 |
| - | Agora-sync Worker (A2b): Realtime consumer (bare service-role supabase-js, stateless, idempotent, one uuid_v7 trace per event) that mirrors group/channel state into Agora Chat via REST (app token from APP_ID + APP_CERTIFICATE). chat_channels INSERT creates the Agora group with the mapped owner + member usernames (DM channels have no Agora object) and records the returned group id via the service-role-only chat_channel_mark_synced proc; group_members INSERT/DELETE add/remove the member; groups UPDATE renames the group. Member events for a not-yet-synced group are a deferred no-op (Realtime redelivery / reconciliation cron is the backstop), and adding an existing member, removing an absent one, and re-handling an already-synced channel are safe no-ops; a failed Agora call is logged loudly and swallowed per event so the subscription never tears down. Mirror tweak: the chat-webhook-mirror resolves a group message's agora_group_id to our channel_id (null when unsynced) before chat_webhook_ingest, keeping the DM reconstruction. Retroactive migration records the live-applied chat_channels.agora_group_id column + partial unique index + service_role SELECT grants + chat_channel_mark_synced proc (do NOT execute); regenerate supabase.generated.ts, drift gate green. Schema already applied. Do NOT execute. | 17, 19 |

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
| 30 | App shell: BrowserRouter (Pipeline / Briefs / Chat / Activity / Assets / Settings / Recently deleted, "/" and unknown redirect to Pipeline), desktop Sidebar + mobile BottomTabs primary nav (Pipeline / Briefs / Chat / Activity), Topbar (workspace label, search trigger, Create menu, avatar menu), cmd/ctrl+K CommandPalette, AvatarMenu (switch workspace / Settings / Recently deleted / Profile / Appearance / Sign out via generic custom events), empty-first pages. Assets reached from Pipeline and Briefs heads, not primary nav. Built on the PR A UI primitives. | 2, 6 |
| 31 | Auth screens on the PR A primitives, rendered outside AppLayout on the radial-gradient background: /signin (email, password, Forgot link, Sign in via signInWithPassword, Create an account link) and /signup (name, email, password, workspace name, auto-detected editable timezone, Create account via signUp with display_name in options.data then workspaceCreate wrapper with p_trace_id). Session route guard: app routes redirect to /signin when signed out, /signin and /signup redirect to /pipeline when signed in, loading state while the session resolves. | 30, 8 |
| 32 | Discussion component shell: shared Composer, MessageRow, mention picker | 30 |
| 33 | Comments UI: Realtime thread, reactions, 5-min edit, soft-delete, Decision Records filterable view | 32, 13 |
| 34 | Create sheet: single mode, all fields visible, required title/caption/channel, optional asset gallery/format/target_date/owner/Origin (None or Brief), Save as Draft | 30, 11 |
| 35 | PCS: header, caption editor, asset gallery, metadata sidebar, three-tab comments, auto-version on edit, annotations (caption span + image pin, version-locked, prior-version greyed as copy changed), Approve button (PCS only, client must be logged in) | 34, 33, 11 |
| 36 | Pipeline: vertical kanban desktop, accordion mobile, owner + urgency colors, client visibility = all stages except Draft, filters, saved views, bulk actions (agency only, cap 10) | 35 |
| 37 | Briefs UI: client-only create, open/closed, comment + withdraw, read-only after creation, derived linked-post count, email-forward intake address | 32, 14 |
| 38 | Inbox UI: icon + badge, state chips (All / Unread / Snoozed), scope chips (Everything / Posts / Briefs / People / Groups / Clients), snooze (1h / 4h / tomorrow 9am / next week), inline reply, click navigates to PCS | 30, 16 |
| - | Chat UI foundation: frontend plumbing for Agora Chat with no chat screens. Add the agora-chat browser SDK, wire the optional VITE_CHAT_TOKEN_URL env (unset = chat unavailable, app unaffected) through env.ts + CI/deploy, an app-local src/lib/chat token fetch (POST { workspace_id } + Bearer session through fetchWithTrace, discriminated result, never throws), a useChatClient token+connection lifecycle hook (connecting/connected/unavailable, onTokenWillExpire renewal, signout + workspace-change teardown), and a ChatProvider context exposing { status, client } for later PRs. Availability gate: any failure resolves to unavailable and never breaks the app. Library code + tests only; not mounted (PR 39 mounts it). | 30, 17, 19 |
| - | Chat UI data layer: typed @srtdio/rpc wrappers for the chat write procs (groupCreate, groupRename, groupMemberAdd, groupMemberRemove, groupLeave, dmChannelEnsure; Result-returning, no throw on domain error, actor resolved server-side via auth.uid() so no caller user-id arg, trace carried as the generated p_trace_id) plus RLS-scoped Postgres-mirror reads (listChannels ordered by created_at then channel_id; listMessages paged like listComments) in src/lib mirroring src/lib/assets.ts. Compliance/history reads only; the live chat read path is the Agora SDK, never these mirror tables. No UI, no provider mount; library + co-located tests only. | 17, 19 |
| 39 | Chat UI: Agora SDK wrap, DM + Group channels, reads live from SDK, mirror never on read path. Chat unavailable does not affect the rest of the app. | 32, 17, 19 |
| 40 | Assets UI: fullscreen lightbox viewer (type-aware media for image / video / pdf / doc / xls / file, swipe + arrow + key navigation over the filtered list with links excluded), whole-card tap to open, long-press action sheet (Download / Copy link / Info), Info bottom sheet with delete, search + kind chips, toasts | 34, 15 |
| 41 | Trash UI: Recently deleted drawer entry, restore button + countdown | 40, 26 |
| 46 | Assets upload wired end to end: consolidated single-row toolbar (search + sort + add), add button 2-option menu (Upload files / Add link coming soon), AssetUploadSheet client pre-checks (100MB cap + shared MIME allowlist) before any bytes leave the device, sequential per-file upload to the asset-upload worker with Bearer JWT, per-file progress + retry, worker-error to plain-English toasts, reused=success, grid refresh on completion | 40, 15 |
| 42 | Search UI: cmd+K palette, scope chips (All / Posts / Briefs / Comments / Chat / Assets / People), Postgres FTS for entities + Agora SDK for chat, recency + relevance ranking | 38, 22, 39 |
| 43 | Workspace settings UI: name, timezone, default digest time, member roles, billing, 7-day soft-delete, ownership transfer (immediate, password confirm, owner cannot self-delete until transferred) | 30, 25 |
| 44 | Notifications (ephemeral): toast slide-in desktop + mobile, fires on Inbox triggers while user active, not stored | 38 |
| 45 | Cockpit UI at platform.srtd.io: passkey auth, dashboard, workspace management, actions (replay webhook, restart job, revoke sessions, billing override, extend trial, open ticket, global kill switch), impersonation banner + emergency-exit.html | 23, 30 |
| 47 | asset-upload worker CORS: handle OPTIONS preflight before auth (204 + reflected allowed-origin, methods POST/GET/OPTIONS, authorization + content-type + trace header, 24h max-age), attach CORS headers to every success and error response, mirroring asset-read exactly | 46, 15 |
| 48 | asset-upload worker link + rename routes: POST /links creates a link asset (kind=link, external_url set, byte columns null, version 1, current_version_id set) behind the same verifyCaller + isActiveMember gate, no R2; POST /rename updates assets.filename only behind a role gate (owner/admin/agency, client forbidden) reading the role in one membership query, leaving version rows and attachments untouched; both write audit rows (asset.create / asset.rename) with the verified actor and trace_id. Reuses the live auth, CORS, and error model | 47, 15 |
| 49 | Assets Add link + Rename wired in the frontend: enable the + Add menu "Add link" item opening a sheet (https:// link field + mandatory name, client-side validation, POST /links via the asset-upload client module, toast + grid refresh on success, worker-error to plain-English toasts), and a role-gated Edit affordance in the lightbox info sheet (owner/admin/agency only, role read once via workspace_members) turning the name into an inline input that POSTs /rename, updating the lightbox title and grid card without reload, 403 to the agency-only message | 46, 47 |
| 50 | Cleanup: record the live-applied service_role asset table grants (8 GRANTs for assets / asset_versions / workspaces / workspace_members / audit_log) as a documentation-only migration for fresh-database builds (already applied via MCP, GRANT idempotent, do NOT execute), and add the missing renameAssetInList unit tests flagged in the PR #105 audit | 48, 49 |

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
