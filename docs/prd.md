# Sorted PRD (MVP)

Decisions only. No rationale.

Sorted is a social-media approval tool. The Approver writes a brief; the Creator drafts a post; the post moves through review to approved, rejected, or parked. No publishing, no scheduling, no insights in the MVP. Plans are in: a shared object in chat holding concepts and posts with Creator and Approver approval; a plan is not scheduling.

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
20. Legacy migration
21. Observability
22. Security
23. Chat and Comments
24. Compliance
25. Build phases and tests

## 1. Project identifiers and DANGER

Supabase project ID: movnexawfhsyuluspxoc. Pass it explicitly to every Supabase MCP call.

## 2. Goals and scope

| Item | Decision |
| --- | --- |
| Product | Social-media post approval tool. Brief in, post drafted, reviewed, approved. |
| Launch | 2026 (web) |
| Native mobile | Deferred. Reassess month 3 post-launch. |
| Public signup | Live at launch. Paid. |
| Legacy tenant migration | Separate track. Decoupled from public signup. |
| New tenants prelaunch | Free. |
| Repo | Greenfield. Org srtdio. Project movnexawfhsyuluspxoc (Pro, Mumbai). See section 1. Public repository. |
| Domain | srtd.io. Cockpit at platform.srtd.io. |

## 3. Operating principles

- One workspace = one approver side (end customer) = one platform. Locked invariant.
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
- No AI features. No publishing, scheduling, or insights in MVP. Plans are in scope (chat plans with Creator and Approver approval), not scheduling.
- All sensitive writes go through SECURITY DEFINER procs. INSERT/UPDATE/DELETE revoked from authenticated role on sensitive tables.
- post_versions and post_annotations are immutable edit history. Never soft-deletable.
- Users not hard-deleted from auth.users except for GDPR. public.users.deleted_at signals account removal; workspace_members.active=false signals workspace removal. Either surfaces as '(ex-member)' badge.
- Workspace owner cannot delete their own account until ownership is transferred or the workspace is deleted.

## 4. Users, roles, visibility

### Roles

Creator = role key agency, Approver = role key client. Visible text says Creator / Approver; role keys in code, DB and RLS are unchanged.

| Role | Definition |
| --- | --- |
| Owner | Workspace creator. Billing, deletion, transfer. Cannot self-delete until ownership transferred. |
| Admin | Full workspace power except billing and deletion. |
| Creator | All sections except admin settings. |
| Approver | Pipeline (except Draft), Briefs (own only), Assets. |

### Visibility

| Surface | Approver sees |
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
| display_name | Required. 1-25 chars (users_display_name_max25, 9 Nov 2026). Every name input caps at 25 with a live "n/25" counter from 20; the server refusal reads "Names can be up to 25 characters." Names truncate with "…" wherever they render. Editable from profile settings. |
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
| Creator | 999 | 8 |
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
| Signup form | Single scroll. Required: name (-> display_name), email, password, workspace name, workspace timezone (auto-detected), and consent to the Privacy Policy and Terms & Conditions. Each policy opens on a separate public page. |
| Workspaces at signup | Exactly one |
| Additional workspaces | From workspace switcher |
| First-run state | Empty Pipeline, empty Activity, empty Assets |
| Profile completion | Designation and avatar optional, added later. |
| Current design | Onboarding and the tour always run on the current app design; every UI change that touches a tour control updates the tour in the same PR. |

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

### Flat look (7 Nov 2026)

- Lighting: in-content surfaces flat, a `--border` hairline separates them; only floating layers (sheets, menus, dialogs, toasts, the unread pill) keep a soft shadow. All values in the FLAT LOOK block of `src/index.css`.
- List row (ui/ListCard, every list): flat, 60 tall, rows touching, no divider, no border; bleeds edge to edge so the selected / pressed fill spans the screen on phone; 40 picture (people round, else a 10 squircle); title bold when unread, regular when read.
- Chips and single-choice picks: outline pill, 32 visible / 44 tap; rest hairline + fg-2; picked = ink line + fg, no fill.
- Phone nav: centred, as wide as its tabs; only the open tab shows its name; Chat is its own circle; always 52; scrolling never changes it, only a tab change does.

### Homepage and /demo type (13 Nov 2026)

- One family, Montserrat, self-hosted from the app (never Google): headlines 800, sub-headlines and labels 600, body 400, buttons 600. The app and emails stay on Inter.
- Text is black on white or white on the black band; no grey text (disabled calendar days and the email placeholder excepted). The grey second line of the headlines is gone.
- No word alone on the last line of a heading or paragraph at any width: the copy joins its last two words with a no-break space. The hero keeps its breaks: phone "Social media / teams hate / WhatsApp.", wider "Social media teams / hate WhatsApp."; "WhatsApp." alone is deliberate.

### Iconography

| Item | Decision |
| --- | --- |
| Icon style | Minimal SVG strokes, 1.6px, round caps and joins, currentColor, fill none |
| Icon button | 44x44 frame with 20x20 SVG |
| Touch targets | 44x44 minimum everywhere. No exceptions. |
| Hover | No hover-only interactions |
| Long-press | Right-click equivalent. On a list card both enter select mode (decision 7 Nov 2026). |
| List card | Every list (Pipeline, Briefs, Assets, Chat, Plan tab, Bank, Activity) uses one two-line card, 74px tall: 48px picture left; line 1 title with the time on the right; line 2 one-line preview, one grey tag, unread dot. No ⋮ on a card. Decision 7 Nov 2026. |
| Select mode | Long-press (phone) or right-click / Shift-click / Cmd-click (laptop) ticks a card; a tap then toggles. Pipeline, Chat, Bank and Assets only. The select bar shows "N selected" and every action the old card menu had (Open, Copy link, Send to chat, Plan it only for one). Exit: Cancel, Esc, Back, or unticking the last card. Decision 7 Nov 2026. |
| Card dates | Words only. Due: Today, Tomorrow, weekday (2-6 days), else "12 Nov". Late: "2d late", "3w late", "2mo late", "1y late" in red. Plan: before start Today / Tomorrow / weekday / date, "Live" while running, the end date once ended. Workspace timezone. Decision 7 Nov 2026. |

## 8. Activity

Permanent in-app event feed. Source of truth for what happened. The only permanent surface; toasts, push, and email are ephemeral. Backed by the inbox_entries table.

### Structure

| Element | Decision |
| --- | --- |
| Chips | All, Unread, Mentions, Briefs, Plans (single-select, in that order; no separate scope row; each filters server-side). Snoozed chip removed 7 Nov 2026. |
| Order | Newest first; no sort control (removed 7 Nov 2026). |
| Row menu | None (removed 7 Nov 2026). |
| Row tap | Opens the real place (post, brief, plan item, idea, chat) at the exact comment or message and marks the row read (9 Nov 2026). A grouped row's head marks the group read and opens its newest comment. |
| Grouped rows | Every notification gets its own line, grouped by item (9 Nov 2026, locked): a non-chat card is a head (item title, kind, "N new") and one line per notification (photo, actor, the line without the name, time, unread dot), newest first; 5 show, the rest fold behind "+N more" / "Show less"; a line opens its own spot and marks only that entry read. Chat rows keep their one card. Catch up shows every unread notification of the item as a line (no cap). |
| Catch up | Slack-style cards over Activity, opened only from the Catch up button (/activity?catchup=newest; a seeded link /activity?catchup=<entryId> puts that entry's item first). Cards exist only inside Catch up. ONE card per ITEM: post, brief, plan item, bank idea, chat main, chat thread. Queue = items with unread card-making entries in the workspace, newest activity first, fixed on open. Card-making: mention, comment, plan_comment, checkpoints_added, plan_review, stage_change to review/approved/rejected/parked, thread_started, brief_created for you, chat mention; every other entry of the item (bank, plan, post_deleted, assets_deleted, welcome, comment_resolved, task_changed, reminder, scheduled_sent) stays Activity-only and is marked read with its item's card. Own actions never make a card. Gone item, lost access (approver on a draft, team-only idea) or read on another device: skipped silently and marked read; never an empty card. Mark as read (ink Main, never green) = every entry of the item in one inbox_mark_read_ids call (plus the chat's thread or read cursor); Keep unread writes nothing; Undo (4 s) restores all (inbox_mark_unread_ids). Long-press Mark as read = mark all. Top bar: round 48 "<", "{n} left", round 48 Undo. Card: name row (title + ⌄ menu: Open <kind>, Copy link; no Mute, no Star), context strip on non-chat cards (closed; a read-only reading window with the picture, video, full text), rows in the chat work layout with the "New" line, day lines, feedback points (open expanded, resolved folded, Reply opens the point's thread; no Resolve), event rows for stage changes, plan reviews and briefs. Long text >6 lines: "more" opens a bordered window that scrolls itself; links shortened (host/…/last part). Tapping a message or "N replies" opens the thread full screen; "<" returns to the exact card state. Reply box = the standard writing box (chat or comment behaviour, + tray, @, Aa, emoji; mic and voice notes on chat cards); sending never advances; failure "Not sent" + Retry. Read only: no edit, no resolve. Error state: "Couldn't load this card." + Retry. Laptop: centred 640 window, max 85vh; ← / → decide; Escape closes menu, then thread, then catch up. End screen "Everything's sorted." Bar under the chips: "<N> unread" + Catch up, hidden at 0. Decision 9 Nov 2026 (replaces one card per notification, 8 Nov). |
| Briefs chip | Brief created, brief closed, comments and mentions on briefs, posts created from a brief |
| Own actions | The person who acted sees their own row ("You approved ..."), already read; never toasts or sounds |
| New members | See only activity after they joined (from their welcome row) |
| Sound | New activity from someone else plays the chat tone (shared 2s throttle with chat), never while Activity is open |
| Tab alert (desktop) | While Sorted is a background tab, new activity or chat makes the tab title alternate every 1.4s between "(N) Sorted" and each event's words (Activity word for word; chat "Chat · <name> sent a message", never the text), and the tab icon gets a dot (amber Activity, blue chat). Stops when the tab is opened. Never for your own actions. Decision 18 Oct 2026. |
| Snooze | Retired from the UI 7 Nov 2026 (no row menu, no chip). Rows whose snoozed_until is in the future stay hidden; the data and procs are unchanged. |
| Inline approve | No. Click navigates to PCS. |
| Inline reply (comments) | Lands on entity. |

### Events that land in Activity

- Comments on posts and briefs
- Post stage changes
- Brief created, brief closed, post created from a brief
- Asset uploaded, asset version added
- @-mentions (a chat mention in a thread reads "mentioned you in a thread in <chat>")
- A thread's first reply on a post, brief, plan or idea card: "<Actor> started a thread on <card title>" to every chat member except the sender and the mentioned (system / thread_started; All and Unread, not Mentions). Decision 8 Nov 2026.
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
| Bulk actions (creator) | Move stage, assign owner, add tag, archive. Cap 10 per action. |
| Bulk actions (approver) | None |
| Approver visibility | All stages except Draft |

### Stages

| Stage | Definition |
| --- | --- |
| Draft | Creator private. Approver cannot see. |
| Review | Approver approves or rejects; creator may act on behalf of approver. |
| Approved | Approved by approver or creator on behalf of approver. |
| Parked | Held by creator. |
| Rejected | Rejected by approver or creator on behalf of approver. |

### Stage transition map

| From | Can move to |
| --- | --- |
| draft | review, parked |
| review | approved, rejected, parked |
| approved | parked, rejected |
| parked | review |
| rejected | review |

Approved is not terminal. Approved can move to parked or rejected. When an approver wants changes instead of approving, they comment and the post stays in review. Parked and rejected revive to review. There is no publishing step.

target_date is a nullable indicative field on posts. It carries no scheduling behaviour in MVP.

## 10. Briefs

The Approver writes the brief; it lands in the Briefs section and can be linked to a post.

| Item | Decision |
| --- | --- |
| States | Open (default), Closed (soft) |
| Closed behaviour | Hidden from default view, still readable, still accepts comments |
| Created by | Approver only |
| Create sheet fields (9 Nov 2026) | Title, Objective, Due date, Attachments, in that order. Title and Objective required. No Format, no Brand requirements, no opening note: one write per create. Old briefs that carry Format or Brand requirements still show them on the brief page. |
| Approver can | Comment, close (withdraw) |
| Creator can | Comment, close |
| Close / Reopen (9 Nov 2026) | A header button (Button level) before the ⋮: "Close brief" while open and the viewer may close, "Reopen brief" while closed. The ⋮ menu holds Copy link and Copy brief only. |
| List order (9 Nov 2026) | Creator side: fixed, no Sort. Open briefs by due date soonest first, undated last by newest updated; closed briefs by closed_at newest first; on All the open block comes first. Approver side keeps the time sections. Chips All, Open, Closed. |
| Edit after creation | No one |
| Post linkage | Optional. The Creator picks Origin: Brief in Create sheet. |
| Linked posts display | Read-only derived count on brief detail panel |
| Email thread root | Brief if any post links to it; else post |

## 11. PCS (Post Control System)

| Element | Decision |
| --- | --- |
| Layout | Header, caption editor, asset gallery, metadata sidebar, comments |
| Caption editing | Creator edits the caption inside PCS. |
| Versioning | Auto-version on every edit. post_versions immutable; never deleted. |
| Annotations | Caption span only (11 Nov 2026): selecting caption text drops the quote into the comment box; fg underline in the caption, fg rail quote chip on the comment, no numbers. Stored image pins stay in the database and are not drawn. Immutable, version-locked. |
| Annotations on outdated versions | Display greyed out / 'copy changed' indicator. Never hidden from DB. |
| Decision Records | Boolean flag on comment. Filterable view. |
| Rollback | Pre-approval edit history via versions; versions are immutable. |
| Approve button | PCS only. Not on Pipeline cards. Approver must be logged in. |
| Post screen (decided 7 Nov 2026; 11 Nov 2026) | Pinned "<" bar alone (no progress row). Cut: Compare versions, caption on/off toggle, duplicate Delete image, reorder buttons (hold and drag only, saved on drop), Open in pipeline, resolution note, checkpoint Send back. Image removal is a 4 s undo. |
| Comments as chat (decided 11 Nov 2026; replaces checkpoints and pins of 7 Nov) | Post and brief comments are a chat: plain messages, each top-level comment the root of a thread, drawn by chat's own parts (rows, swipe, long-press / right-click menu, hover keys, RepliesRow, thread view, composer). Tap, swipe right or "N replies" opens the thread (phone over the post, laptop side panel); replies never show inline. Menu: reactions, To-do (comment_task_create), Edit, Copy text, Copy link, Reply privately, Delete last (own only). Removed: checkpoints, numbers, ticks (Resolve, Reopen, Confirm), the progress row, Open / All, the open count chip, the "Send anyway?" warning, photo pins. Approvers comment through comment_create like everyone (a draft post refuses them). Every comment and reply notifies every active member. Unread per thread from comment_thread_reads. |
| Plan and Bank comment tasks (decided 13 Nov 2026) | Plan item, concept and Bank idea comments get Add to Tasks exactly as post comments: creators only, on the long-press menu and the thread's replies bar; the task lands in the chosen chat and the comment carries the Task tag, done when the task is (plan_item_comment_task_create, plan_item_comment_tasks). |
| Threads open at the top (decided 13 Nov 2026) | Every thread (chat, post, brief, Plan, Bank, Catch up) opens at its first message, spare room below; the first photo sits 12 under the top bar (chat's gap); one top bar for all: "<", the title by place (Chat reply, Post comment reply, Brief comment reply, Plan comment reply, Bank idea comment reply) over the item name. |
| Comment files (decided 7 Nov 2026) | Every comment photo and file opens in-app (lightbox or file viewer), never a new tab. |
| Platform preview (decided 7 Nov 2026) | Placement from the post format; chips only for plain video on Instagram and Facebook. Each platform drawn in its own colours, no logos. One cut row with Show cut. No size picker, no Crop section. |

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
| Member roles | Add, remove, change role. Owners and Admins can invite members individually or as a group and select invitee roles. Approvers can invite members individually or as a group, with invitee role restricted to Approver (reviewer). |
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
| Chat | Postgres over chat_messages, the chat record and only read path. Agora is never read for history or search. |
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

Schema is fully executed on project movnexawfhsyuluspxoc (Postgres 17). See section 1. See supabase/migrations/*.sql for implementation truth and schema.md for the full reference.

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
| chat_channels | Channel registry (dm / group) keyed by channel_id; membership is resolved by chat_channel_member. last_synced_at tracks the Agora live-delivery channel. |
| chat_messages | The chat record and the only read path. Written by chat_message_send, read directly under channel-membership RLS; chat_unread_counts derives per-channel unread from chat_read_cursors. Partitioned monthly. Agora is live delivery only; there is no Agora mirror. Companion tables: chat_reactions, chat_read_cursors, chat_sync_events (service-role outbox to Agora). |
| groups, group_members | Sorted source of truth. Membership and rename changes enqueue chat_sync_events for Agora live delivery. |
| email_threads | root_id, root_type, message_id, subject, workspace_id. |
| delivery_attempts | Per-event email/push delivery row. email_sent_at for dedupe. |
| webhook_events, webhook_processing_attempts | Inbound webhook capture (incl. Agora chat entry) and retry log. |
| feature_flags | Killswitch / rollout / experiment / tier-gated flags. |
| platform_operators, cockpit_access_log, cockpit_procedure_allowlist, intent_ledger, pending_flows | Cockpit operations. |

### Not in schema

- No dedicated publishing, scheduling, or insights tables (schedule_jobs, plan_periods, plan_cells, approvals, share_tokens, post_insights, platform_accounts removed). Plans use their own tables (plans, plan_items, plan_item_reviews) from 9 Oct 2026.
- No AI tables (ai_usage, ai_memory, tool_invocations, workspace_brand_guides).
- post_versions and post_annotations carry no deleted_at (immutable).

## 20. Legacy migration

v1 retired 20 Oct 2026. GBL data was migrated in June 2026; migrated rows keep legacy_author_* columns.

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
| Backend | Postgres | Postgres (chat_messages is the record). Agora for live delivery only. |
| Real-time | Supabase Realtime | Agora SDK, live delivery only. Never read for history. |
| Mirror | None | None. chat_messages is the record, not a mirror. |
| Shape | A chat with threads (11 Nov 2026), chat's parts | Chat with threads |
| Anchors to post version | Yes | No |
| Decision Records | Yes | No |
| @-mentions | inbox_entries + email | Agora native push (MENTION_ONLY) |
| Attachments | Sorted asset pipeline | Sorted asset pipeline (asset_id ref) |
| Search | Postgres FTS | Postgres over chat_messages |
| Downtime UX | May lag, refresh | History still reads from Postgres. Live delivery pauses until Agora returns. |

Chat messages never land in the Activity feed. Chat notification is Agora native push only.

### Chat specifics

| Item | Decision |
| --- | --- |
| Chat record | public.chat_messages is the single source of truth for chat history and the only read path. Every send calls chat_message_send (client-generated uuid_v7 id, server-stamped created_at, idempotent) BEFORE publishing to Agora; the Agora message carries the Sorted id in ext for dedupe. |
| Agora | Live delivery only: never read for history, never the record. Agora Free plan, no server callbacks. |
| Channel IDs | dm__W__min(A,B)__max(A,B); group__W__G |
| Auth | Sorted mints Agora Chat user tokens for authenticated workspace members via the chat-token Worker (24-hour, renewed via SDK onTokenWillExpire). Channel access is enforced in Postgres by chat_channel_member. |
| Access | chat_channel_member(channel_id, uid) gates every chat table. DMs are visible only to the two participants, group channels only to group_members. |
| Reactions, read position | chat_reactions and chat_read_cursors, written through chat_reaction_add, chat_reaction_remove, chat_read_cursor_set. |
| Group membership | Sorted is source of truth. Membership and rename changes to Agora flow through the chat_sync_events outbox, drained by the chat-agora-sync worker. |
| Retired | chat_message_save and chat_webhook_ingest (drop pending). No webhook mirror, no reconciliation cron. |

Plans: a shared object in chat holding concepts and posts with Creator and Approver approval. Schema step 3a applied 9 Oct 2026.

### Work chat: threads and signals (decided 8 Nov 2026)

| Item | Decision |
| --- | --- |
| Layout | Everyone on the left, no bubbles (main chat, thread, DMs, groups, Personal notes). A group head is a square photo (36 on phone and tablet, 32 on laptop; 12 / 8 to the text), the name and the clock time (phone: name 17 bold, text 17 on a 20 line; laptop unchanged); the same sender within 5 minutes groups under one head. Own messages look the same; clock while pending, ticks after the time, "Not sent" + Retry, Seen / Read by left-aligned. Attachments keep their own frames. |
| Photos | People are rounded squares like groups and workspaces at every size (one rule in ui/Avatar). |
| Message family (decided 11 Nov 2026) | Message rows take Slack's measured phone sizes and every surface that shows messages is one family (chat, threads, post and brief comments, plan and bank threads, Catch up). The centred date pill is replaced on every width by a date line: bold words on the photo's edge over a full-width hairline (16 above, 8 to the hairline, 12 under). Loading placeholders use the rows' photo box and gap, and the composer types in the message text's size and line, so nothing shifts when content lands or a message is sent. |
| Thread opens on the reply box (decided 12 Nov 2026) | In the thread view (chat threads, post and brief comment threads; phone, tablet, laptop) the content sits on the reply box: a thread that fits shows whole with its spare room at the top, a longer one ends at its last reply. On touch a thread opens with the keyboard down; only an explicit Reply (the sheet's Reply tile, swipe right) focuses the box. Laptop keeps the cursor in the box. A thread opened at a reply still lands on it. Comment thread rows say their day like chat threads. Supersedes the 10 Nov 2026 rule "tapping a message opens its thread with the keyboard up". |
| Threads | Every reply is a thread: reply_to_message_id = the root (the trigger keeps thread_root_message_id). Replies never show in the main chat; the root carries a replies row (up to 3 photos, "N replies", the latest reply's first line, an ink dot while unread). No quote-reply in the main chat; existing quoted replies show as thread replies. Reply privately unchanged. Post-card threads use the same model (no rail, chips or inline "N replies"). No nested threads. A deleted root keeps its thread. |
| Thread screen | Opens over the app with "<". Root, "N replies", replies; composer hint "Reply". A card thread takes the card's title; every other thread is "Thread" over the chat's name. Opening or reading to the bottom calls chat_thread_read_set. |
| Signals | In-app alert and catch-up email only to thread participants (root sender, repliers, anyone @mentioned; everyone in chats of 6 or fewer): "<Name> replied in thread: <first line>". Replies count in the chat's unread; the list preview reads "<Name> in thread: <first line>". Status strip "N threads" + dot opens the Threads sheet. The "New" line (ink rule + New pill) marks the first unread in the main chat and in threads. |
| Threads sheet | From chat_threads_for_me: unread first (dot), read in fg-3; ListCard rows (root sender photo, name, time, root's first line, "N replies"). Laptop: the conversation pane. |
| Open rule | Unread top-level messages open at the New line; else unread threads (known before the first paint) open onto the Threads sheet; else the chat opens as today. One chat_threads_for_me call in parallel with the first page; never holds the paint. |
| Long-press | Grab handle sheet: round reactions (👍 ✅ ❤️ 😂 🙏) + "+", tiles Reply / Forward / Add to Tasks, rows Mark unread / Copy link / Copy text, then More actions (Reply privately, Select text, Transcribe, Save to notes, Edit, Remove file, Delete). Laptop right-click: the same order as a popover. ✅ never means approval. |
| Mark unread | Main chat: chat_mark_unread (cursor and counter). Thread reply: chat_thread_mark_unread. Private, synced from the database. |
| Add to Tasks | One task in the chat's Tasks list from the message text (a file-only message: the file name), default priority, through chat_task_save_batch. |
| Copy link | The open-chat-at-message link; a reply opens its thread with the reply highlighted. |
| Schema | chat_thread_reads plus chat_thread_read_set, chat_thread_mark_unread, chat_mark_unread, chat_threads_for_me (20261108090000_chat_threads_unread.sql). |

### Idea bank (decided 6 Nov 2026)

| Item | Decision |
| --- | --- |
| What | A concept with no plan (plan_items.plan_id null). Lives in the Plan tab behind the Bank chip (phone: first chip; laptop: side panel, expandable to a table). Not a Pipeline chip. |
| Who sees | Team only by default. Per idea "Show to approvers" (Planable internal-post style) makes it visible to approvers; Hide takes it back. Approvers never see team-only ideas, their comments or their buckets. |
| Buckets | One workspace list. An idea holds several buckets; a post keeps one. Made, renamed and deleted from the Bank's Filter and sort sheet (delete archives the bucket and unlinks it, with Undo). Buckets show on Plan rows. Briefs have no bucket. |
| Moves | Plan concept to bank: Move to bank (blocked while its linked post is approved; reviews drop; the plan it came from is remembered). Bank to plan: Plan it (one plan, Make plan, or pick; past dates refused; the review starts again). Moving creates no copy. |
| Edit | Creator edits title, description and files of a bank idea (Edit idea). No date until planned. |
| Tile | A picture wins; else the first link's picture (link-preview Worker, asked when the row is in view); else a file glyph; else none. |
| Stars, archive | Stars are shared by the team. Archive is manual; "Untouched for 90 days" is a filter with Archive all, never a count read. |
| Chat | An idea goes to a chat as a live idea card (chat_plan_item_share). A team-only idea into an approver chat asks "Show and send" or "Send in Team instead". A draft plan into an approver chat asks "Open for approvers". |
| Alerts | Creators get every bank event (added, moved, planned, shown, hidden). Approvers get shown as a full alert, moved when the plan was shared (no link), planned through the plan's own alert. All ride Activity and the catch-up email's Plans section. |
| Live | bank:<workspace_id> broadcast; every open Bank re-reads once per burst and merges in place. Own writes patch the kept page with no read. |
| Speed | 12 ideas a page, keyset cursor, Recently active default sort. No counts, no reads before first paint, no waits on tap paths. |
| Not in v2.0 | Pipeline filter by bucket. One-query starred-first cursor. |

### Density, spacing steps, flat Plan (decided 8 Nov 2026)

| Decision | Detail |
| --- | --- |
| Density | Superseded 10 Nov 2026 (below). Compact / Cozy / Calm per account (users.density, default Cozy). Switched only in the account menu (under Appearance), never in Settings. Text size is the same in all three. List row 60 / 72 / 80; row picture 40 / 48 / 48; chip 32 / 36 / 40 visible (tap 44); plan stack 4 / 8 / 12, plan padding 8 / 12 / 16. First paint from the device cache; the server value reconciles after paint. |
| Spacing steps | Padding, margin, gap and space are 4 / 8 / 12 / 16 / 24 only (plus 32 and up). 4 lines in one item, 8 tight group, 12 row padding, 16 heading to content, 24 between sections. |
| Flat Plan | Plan days are flat sections split by hairlines (no card frame, today marked by its date tile and Today pill). New plan rows are hairline rows, no boxes. |
| Densities removed | 10 Nov 2026: densities removed; one size (former Cozy). |
| Activity solid rows | 11 Nov 2026: Catch up and Threads are solid list rows on top of the Activity list (Catch up first), replacing the two lead-row buttons. Ink fill, 72 tall, count at the right edge; a row shows only while its count is above 0, and with both at 0 the list starts right under the chips. Tap opens Catch up or the Threads list; long-press or right-click Catch up is Mark all as read. No pulse, no motion. |
| Add from bank | New plan (creator only) adds bank ideas as items with a day ("No date" = first plan day from today). Create moves them out of the Bank in the same transaction. |

### One search, one top bar, fewer chips, one upload look (decided 7 Nov 2026)

| Item | Decision |
| --- | --- |
| A. Top bar | Phone and laptop: workspace switcher, Search (CommandPalette), Sort, filled "+" (always last), avatar. Laptop keeps the ⌘K button and the Activity bell. A page publishes its sort and "+" through useTopbarActions (pure render). "+" is icon only with the old label. Blocked "+" (9 Nov 2026): a screen's create "+" always shows; without the capability it is blocked (aria-disabled, the disabled look, taps still fire) and a tap shows a toast saying who creates ("Briefs come from approvers.", "Posts come from creators."). While the capability is still unknown the slot stays empty at its width, never a blocked "+" that turns live. Activity's slot is Mark all read (hidden at 0 unread). Sort opens what each screen opened before; Activity gains Newest first / Oldest first; Chat list gains Recent / Unread first / A to Z. |
| B. One search | No search field on any screen: Pipeline, Briefs, Assets, Plan, Bank, Activity, Chat list, in-chat search and emoji search are gone, with their per-screen server search reads. CommandPalette is the one search; its group order is fixed. HelpPage and the operator Cockpit keep theirs. |
| C. Pickers | Pickers search through CommandPalette pick mode (only the picker's kinds, a "<Kind> only" pill, tap ticks, footer "Send N" / "Add N"). Without search a picker shows its recent list and chips. |
| D. Chips | Pipeline and Briefs unchanged. Assets: All, Media, Docs, Links (Docs = PDF + Docs + Sheets). Plan: Bank, Upcoming, Past (default Upcoming). Activity: All, Unread, Mentions. Chat list chips unchanged. |
| E. Select | A visible Select at the end of every list's chip row, plus long-press / right-click. ui/SelectCheck is the only select circle. |
| F. Upload | ui/UploadRing on the thing uploading (X cancels; Retry in the same spot on failure). ui/PendingChip is the one attached-file chip (uploading, ready, failed). No bars, no % text. Profile photo keeps busy on its button. |

## 24. Compliance

Not covered in MVP PRD. Defer to lawyer review pre-launch.

## 25. Build phases and tests

### Phasing

- Phase 1: All backend. Schema, RLS, SECURITY DEFINER procs, triggers, edge functions, workers.
- Phase 2: v1 retired 20 Oct 2026. GBL data was migrated in June 2026; migrated rows keep legacy_author_* columns.
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
- Schema changes: SQL in chat, approval, execute via Supabase MCP with project_id="movnexawfhsyuluspxoc" passed explicitly, verify via information_schema, PR notes 'Schema already applied. Do NOT execute.'
- Auto-merge disabled. Shubham merges manually.
- Every prompt ends with: 'Return your entire response in ONE code block, most token-efficient form, no prose outside it.' and 'After pushing, reply with the exact GitHub PR URL.'

## Formatting and the writing box (decided 8 Nov 2026)

- Every multi-line writing surface uses one Slack-style writing box (ui/WritingBox): chat, post comments, plan item / bank idea / brief comments, reject reason, stage-move note, person card message, brief fields, idea and plan item notes, post caption. Single-line fields, search, email, invites and sign-in stay plain inputs.
- Chat on a phone rests as one pill (+, "Message", mic); focused or holding a draft it is a card: text on top, + Aa emoji @ on the left, send on the right (no mic). Laptop and iPad: the card always, mic while empty.
- Aa replaces the row with the format row: Close, Bold, Italic, Underline, Strike, Link, Numbered list, Bullet list, Quote. Shortcuts Cmd/Ctrl+B/I/U, +Shift+X strike, +Shift+C mono, +Shift+7 numbered, +Shift+8 bullet, +Shift+9 quote, Cmd/Ctrl+K link.
- Stored as plain text: "N. " numbered, "- " bullet, "> " quote, [text](url) link (http(s) only; a bare domain gets https://). Return continues a list or quote; Return on an empty item ends it. Rendered as lists, a quote bar and tappable link text; plain-text readers show display text.
- Emoji opens the emoji sheet (search, Frequently used, every group, category bar). Add link is a small sheet (Text, Link, Cancel / Save). The floating select-text format strip is gone.
- Expand (Reddit style) on every box: phone opens a full-screen editor, laptop grows the box in place; collapse keeps the text, caret, reply bars and attachments.
- Post captions stay plain: no Aa row and no formatting; emoji, a plain "@" (no mention token) and expand only.
