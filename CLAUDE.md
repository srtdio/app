# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Sorted: a social media operations platform for agencies. A social-media approval tool: the Approver writes a brief, the Creator drafts a post, the post moves through review to approved, rejected, or parked. Also shipped: Plan, chat scheduled send, voice note transcription, and Inbox. No post publishing or insights in the MVP.

## Commands

Node 22 (`.nvmrc`), pnpm. Run `pnpm install` first.

- `pnpm dev` - Vite dev server (needs `.env.local` with `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`, see `.env.example`)
- `pnpm build` - typecheck + production build to `dist/`
- `pnpm typecheck` - `tsc --noEmit` on app + node configs
- `pnpm lint` - ESLint 9 flat config
- `pnpm test` - unit tests only (root vitest config; never touches a database)
- `pnpm format` / `pnpm format:check` - Prettier
- `pnpm types:supabase` - regenerate `packages/schemas/src/supabase.generated.ts` (needs `SUPABASE_PROJECT_ID`); never edit that file by hand

These commands are for GitHub CI. Claude Code does not run them (see Speed rule).

Single unit test: `pnpm exec vitest run src/lib/foo.test.ts`.

Design ratchet (CI: design-ratchet-ci.yml): `node --experimental-strip-types scripts/design-ratchet.ts [--verbose|--update]`.

iPhone/WebKit visual checks: `pnpm test:e2e` (e2e/harness)

Domain/DB suites live in `tests/<domain>/` and are NOT run by `pnpm test`. Each has its own config and CI workflow:

- `pnpm exec vitest run --config tests/<domain>/vitest.config.ts` (domains: rls, auth, posts, briefs, comments, inbox, rpc, workspace, flags, catch-up)
- Type-check a suite: `pnpm exec tsc -p tests/<domain>/tsconfig.json --noEmit`
- DB-backed specs are gated with `describe.runIf(process.env.<DOMAIN>_SUITE === '1')`; the suite config sets that env var. Under the root config they auto-skip, so the default run stays DB-free.
- The RLS suite's globalSetup boots a local ephemeral Supabase container (Supabase CLI) and applies `supabase/migrations/`; it never touches the live database.

## Architecture

pnpm workspace monorepo. Frontend is a Vite 5 + React 18 + Tailwind 3 SPA; backend is Supabase (Postgres + RLS + edge functions) plus Cloudflare Workers.

- `src/` - the SPA. `src/components/pages/` route pages (Pipeline, PCS, Briefs, Chat, Assets, Activity, Settings, Cockpit), `src/components/ui|shell|...` shared UI, `src/lib/` client logic (contexts, chat store, inbox, hooks). Deployed to Cloudflare Pages (`srtdio-app`) via `.github/workflows/deploy.yml` on push to main.
- `src/server/` - server-side code shared by Workers: `workers/` one module per Worker (chat-token, chat-agora-sync, chat-scheduled-send, chat-transcribe, asset-upload/read, avatar-upload, link-preview, og-preview), plus `assets/` upload pipeline (MIME allowlist, EXIF strip, SVG sanitize, virus scan), `cron/` scheduled handlers (catchup-send, storage-purge Workers), `middleware/` (idempotency), `logger.ts`, `trace.ts`.
- `workers/<name>/` - one `wrangler.toml` per Worker whose `main` points at `src/server/workers/<name>.ts`; secrets are Worker secrets, only binding names appear in the toml. Each Worker has its own `*-deploy.yml` workflow.
- `packages/` - domain packages imported as `@srtdio/*`, all exporting raw TS from `src/index.ts` (no build step). `schemas` is the base: Zod schemas + generated Supabase types. `rpc` wraps Supabase RPC (`callRpc`). `posts`, `briefs`, `comments`, `inbox`, `workspace`, `storage` are domain logic shared by frontend and Workers. `test-utils` holds RLS test helpers.
- `supabase/functions/ops-cockpit` - the platform operator's Cockpit API (GET mode=status|full; 404 for anyone without an active platform_operators row); the UI is `src/components/cockpit/`, lazy-loaded only when the operator flag is true.
- `supabase/` - `migrations/` (implementation truth for schema), `functions/` Deno edge functions (invite-send/accept, brand-request-send, book-call-send, demo-request-send, catchup-unsubscribe, resend-webhook), `config.toml`.

### Supabase project

Supabase project ID: movnexawfhsyuluspxoc. Pass it explicitly to every Supabase MCP call.

### Trace propagation

Every user action generates a uuid_v7 `trace_id` (`src/lib/trace.ts`) that flows FE -> Supabase -> DB RPC -> Worker -> Sentry tag. ESLint enforces the plumbing: raw `fetch` is banned (use `fetchWithTrace()` from `src/lib/fetch.ts`, which adds `X-Trace-Id`), `.rpc()` without `_trace_id` is banned (use `callRpc()` from `src/lib/rpc.ts`), and `console.*` is banned in `src/**` outside the logger files (use `logger` from `src/lib/logger.ts` or `src/server/logger.ts`; single-line JSON output).

## Invariants

- One workspace = one approver side (role key client) = one platform.
- TypeScript strict mode everywhere; no loosening of compiler flags.
- Multi-tenant isolation is enforced by Postgres RLS.
- `post.stage` is the single workflow state: draft, review, approved, parked, rejected. There is no `publish_status` field in MVP.
- Auth: JWT 60 minutes with silent refresh; no device fingerprinting.
- `trace_id` is always passed as an explicit RPC parameter, never inferred.
- Every Supabase `.rpc()` call MUST pass `_trace_id` via the `callRpc()` helper. ESLint enforces. Never `SET LOCAL`.
- Comments are stored in Postgres; Chat runs on Agora (Postgres holds a mirror in `chat_messages`).
- Inbox is a permanent surface; it is never cleared or archived away.
- Assets are versioned; old versions are retained. R2 buckets are per-workspace (`assets-{workspace_id}`), created at runtime.
- Briefs are read-only once created.
- Approval is per-post; there is no bulk approve.
- No connection-state UI anywhere (no Reconnecting/Connecting/Offline). Failures show per message only: clock while pending, 'Not sent' + retry on failure.
- AI: voice note transcription only.
- Idea bank: a concept with plan_id null, team-only unless show_to_client. Bank ideas go through the bank procs only (bank_idea_create, bank_idea_edit, bank_idea_set, plan_item_to_bank, plan_item_from_bank, plan_item_buckets_set), never plan_concept_edit or plan_item_move. Every open Bank re-reads on the bank:<workspace_id> broadcast; an own write patches the kept page through PLAN_CHANGED_EVENT, never a count read.
- Bank row tile: a picture, else the first link's picture (previewClient, asked when the row is in view), else the file glyph, else none (bankThumbOf).

## Rules for Claude Code

- Speed rule: never run pnpm test, pnpm build, pnpm typecheck, pnpm lint, e2e or any test suite locally. GitHub CI runs all checks. Write tests, do not run them. Do not wait for CI or the test site after pushing: push, open the PR, return the URL. No self-audit loops.
- One PR per prompt.
- Never auto-merge a PR.
- Schema changes execute via the Supabase MCP only after Shubham approves them.
- posts_list returns posts columns by name: any new posts column must be added to posts_list in the same migration, plus types regen.
- Never use `.js` or `.jsx` for application code; `.ts` and `.tsx` only.
- Never commit secrets.
- Never push to `main` directly.
- A PR that turns an e2e test red fixes it in the same PR; never merge with E2E WebKit red.
- Light and dark mode parity is required on every UI PR.
- No em-dashes in user-facing strings.
- Never put SUPABASE_SECRET_KEY or DB connection strings in frontend code or committed .env files. Server secrets live in GitHub Actions Secrets and Cloudflare Pages env only.
- All deploys go through CI to Cloudflare Pages on push to main. Never deploy locally except for emergency rollback via `wrangler pages deploy`.
- Errors flow to Sentry srtdio org: frontend project for React errors, backend project for Cloudflare Workers. Source maps uploaded in CI only.
- New API endpoints, RPC functions, and Workers must accept and propagate trace_id. Read it from the `X-Trace-Id` header on inbound, attach it to all outbound calls.
- Use logger from `src/lib/logger.ts`. No `console.*` in `src/**` outside logger files.
- Blast radius: before changing a shared function, gate, constant or wait, list every caller and screen that uses it in the PR body with what changes for each. A new wait, hold, cap or gate on a paint path states its ceiling and reason and may not stack on an existing one without stating the total.
- Speed ratchet: no PR may make a paint or tap path slower. Do not add an await, hold, gate or network read on a paint or tap path without Shubham's approval. The PR body lists the paths touched, their before/after ?paintlog marks, and what this PR made faster.
- Activity and chat arrive live by push; polling is only a safety net. No PR may make either wait for a poll.

## Design and layout (locked 6 Nov 2026; guards in `src/__tests__`, eslint designRules, `scripts/design-ratchet.ts`)

- Use a part or add a slot to it; never hand-build its frame or fork it. If no part fits, stop and ask.
- Roles in visible text (9 Nov 2026): Creator (role key agency), Approver (role key client). Never 'agency' or 'client' in UI copy; role keys unchanged. A screen's create '+' always shows; without the capability it is blocked (aria-disabled, toast says who creates). Guard: `src/__tests__/role-words-guard.test.ts`.
- Parts (src/components/ui): Text, layout.ts, Card, Row, Tile, ChatCard, Composer, WritingBox (+ EmojiSheet, AddLinkSheet), HeaderBar, Toolbar, StatusDot, Sheet + SheetActions, ActionMenu + ActionMenuTrigger, Button / IconButton / PressableRow (44 tall), LoadMore, Chip (visible 32, hit 44), Tag, CountBadge, Avatar, PersonTrigger, NoResults, ErrorNote, SidePanel, PostPlaceholder.
- Type roles (ui/Text only): display (post title only), title (bar titles), heading, body, secondary, label, meta (mono, tabular), section. Max 3 roles per part. leading-_, tracking-_, text-[..] live only in ui/Text (lint error).
- Values: tailwind.config.ts holds only the allowed scale (type xs..3xl + input; 4px spacing grid, 0.5/1.5/5/7 only on sizes; radius roles; border 1/2 + named cut-out/rail; named z layers base..top; named panel widths). New exception = named token + one-line comment. No [Npx], no z-[N].
- Edges (L2): page 16 phone / 24 laptop (GUTTER), chat 12 (CHAT_GUTTER), sheets 16. Inside <= outside spacing.
- Trailing rule: a trailing ⋮, chevron or X is a 44 box pulled out 12 (TRAILING_PULL) so its glyph sits on the content edge; leading back/close mirrors it (LEADING_PULL). Parts apply it, never call sites.
- Lanes (ui/layout LANE\_\*): unread pill top centre, jump-to-latest bottom trailing above the composer, tip strip in flow above the composer; they never cover a title, a time or each other.
- Exit: "<" for anything opening over the app; X (IconX) only to cancel an upload, remove an attached file, clear a typed query, or close the phone format row (8 Nov). Bin to delete; "Clear" to clear or dismiss. One exit per panel. Guard: `src/__tests__/no-cross.test.ts`.
- Top bar: search | sort | filled + | avatar via useTopbarActions; no search field on any screen; pickers search through CommandPalette pick mode.
- Select: visible Select at the chip row end on every list + long-press; ui/SelectCheck is the only select circle.
- Upload: ui/UploadRing on the item (X cancels) and ui/PendingChip for attached files; no bars, no % text.
- States keep their footprint: Button busy keeps width; Sheet busy is on its button; Composer, upload, pending, Not sent and select mode keep row height and slots.
- Lighting (flat, 7 Nov 2026): in-content surfaces flat, a --border hairline separates them; only floating layers (lit-float, lit-overlay) keep a soft shadow; all values live in the FLAT LOOK block of src/index.css; outlines lit-selected/lit-focus/lit-bad/lit-drop/lit-today only, a crisp ink line. No shadow-\*, drop-shadow, backdrop-blur, dark: at call sites. In-content surfaces flat; frames only on floating layers (8 Nov 2026): no lit-card/lit-card-muted card frame, bg-panel-2 box or dashed add box in content; rows split by hairlines (guard: `src/__tests__/flat-surfaces.test.ts` KEEP list).
- Colour: token classes only; greys + amber Review, green Approved, red errors/Reject; no violet/blue, no hex, no text-white. Contrast 4.5:1 text, 3:1 edges.
- Motion: src/lib/motion only; never fade; instant under Reduce Motion.
- Icons: ui/icons.tsx only; ICON_SIZE; stroke follows size (strokeFor). One icon per concept.
- Icon meanings: Copy = two squares (IconCopy, Square2Stack); Reply privately = bubble with arrow (IconReplyPrivately); the person icon (IconUser) = a person only.
- Words: Activity, file/Assets, Due (never Target), Review, Retry, Alerts. Zero states "{Things} show up here." Errors "Couldn't {action}. {reason}". No em-dashes. Dates via src/lib/time.ts, font-mono tabular-nums.
- Spacing (8 Nov 2026): padding/margin/gap/space steps 4 / 8 / 12 / 16 / 24 only (+ 32 and up, field-y, row-inset). 4 stacked lines in one item; 8 tight group (chips, meta, buttons); 12 row padding; 16 heading to content, under top bar, sheet padding; 24 between sections. Tailwind has no p/m/gap/space 0.5, 1.5, 5, 7 (eslint OFF_STEP_CLASS, ratchet offGrid).
- Density (8 Nov 2026): Compact / Cozy (default) / Calm per account (users.density), switched only in the account menu. <html data-density> set at boot from the device cache (src/lib/density.ts); parts read it via compact: / calm: variants, never props. Row 60/72/80, picture 40/48/48, chip 32/36/40 (tap 44), plan stack 4/8/12, plan padding 8/12/16; text size identical. Only ListCard, Chip, Avatar 'card', plan spacing.
- List row (ui/ListCard, every list): flat, density tall (72 Cozy), rows touching, no divider, no border; bleeds -mx-4 so selected/pressed fill runs edge to edge; density picture left (people rounded square like groups, else rounded-picture 10); line 1 title (bold unread, regular read) + time right; line 2 preview, one grey Tag, unread dot last; no preview: tag right under the time. No line 3, no ⋮.
- Chips and single-choice picks: outline pill, density visible (36 Cozy) / 44 tap; rest border-strong + fg-2; picked = ink line + fg, no fill; counts fg-3.
- Chips: every chip-like control (tabs, quick links, day tiles, post refs) uses Chip or the CHIP\_\* exports; no grey-filled pills. Guard: `src/__tests__/chips-flat-guard.test.ts`.
- Buttons (9 Nov 2026): every button is one level, by its job, never by its look on one screen. MAIN (variant primary; success only to approve, danger only to destroy) = the single action a screen, sheet or dialog exists to complete (Save, Send for review, Done, OK, Plan it, Catch up, composer Send); one per surface, a decision pair may both be Main; solid fill, rounded-lg rectangle, right-aligned auto width in a sheet; round only for icon-only Main. BUTTON (secondary) = any other standalone action (Load more, Add files, Copy link): soft grey bg-fg/10, no border. TOOL (ghost / link) = 3+ actions in one row, an action inline beside content (Edit, Copy, Change), or dismiss/recover words (Cancel, Back, Retry, Clear, Close): no fill, no border.
- No lighting on buttons (no lit-btn-\*), no pill text buttons (shape="pill" is gone), ClearButton is a Tool (the word, no outline). Chips are filters and toggles only: never Chip for an action, never Button for a filter. A floating button over content (unread pill) keeps the solid float surface. Guard: `src/__tests__/button-system-guard.test.tsx`.
- Format keys: on = glyph ink only, never a tile or ring. Phone format row: X close and send are matching filled circles; mic hides while it is open. Guard: `src/__tests__/format-keys.test.ts`.
- Comment action bar never shares the author name's line: it rides the row's top hairline (absolute); name one line, truncates; "(edited)" ends the body. Guard: `src/__tests__/comment-header-guard.test.ts`.
- Phone nav: centred, as wide as its tabs; 52 at rest (active tab panel-3 fill + label), 44 while scrolling down (labels hide, icons stay), grows on scroll up or at the top (useDockShrunk, MOVE_CLASS.dock); Chat circle shrinks with it, active = ink fill.
- First page fills the screen: every list's first page (the server page too) is getFillCount() rows (screen height / density row + 1, x laptop columns, 6..40; tile grids getTileFillCount), read once per app load; each Load more adds the same count in one request (hasMore = last page came back full). Load more is ui/LoadMore only: "Load more", left aligned, no count. Not for chat history / Load older or infinite-scroll search. Exception: Plan tab (plan_bundle_read c_page 12, needs a proc change).
- Card dates are words only (time.ts): due "Today", "Tomorrow", "Fri", "12 Nov"; late "2d late" in the bad token; plans "Mon" ahead, "Live", then the end day. Never "Due", "Overdue", "Starts" on a card.
- No ⋮ on a list card: long-press (phone) or right-click / Shift / Cmd-click (laptop) selects; actions live on the list's SelectBar (ui/SelectBar). Guard: `src/__tests__/list-card-guard.test.tsx`.
- Text: fields are ui/Input or ui/Textarea; every multi-line writing box is ui/WritingBox (modes chat / comment / field / caption: Aa format row, emoji sheet, @, Reddit-style expand); no floating format strip. Saved free text renders through parseFormat; one-line previews use stripFormat; post captions never format.
- Composer rows: row keys are a 36 circle on a 44 tall hit, 36 apart (ui/WritingBox RowKey/RowSend, ComposerTray compact +); the only exception to 44x44. Guard: `src/__tests__/composer-row-keys.test.ts`.
- Swipe: right = Reply, left = Delete on every message, comment and task row; one core (src/lib/chat/swipe-reply.ts); own and others' rows swipe the same. In chat, Reply opens the message's thread.
- Square photos (8 Nov 2026): people, groups and workspaces are one rounded-square shape at every size (ui/Avatar avatarShapeClass, one rule). Guard: `src/__tests__/square-avatars.test.ts`.
- Work chat (8 Nov 2026, Slack way): everyone on the left, no bubbles; a group head = square photo 32 + name + clock time, same sender within 5 min groups; own rows look the same (send states kept). Every reply is a thread (reply_to = root): the main chat shows top-level messages only, each root with a replies row (3 photos, "N replies", latest line, unread dot); no quote-reply in the main chat. Thread screen: "<", card title or "Thread" + chat name, "N replies", hint "Reply". Signals: alerts to thread participants only (6 or fewer members: everyone), "<Name> in thread:" list preview, "N threads" strip item, Threads sheet, "New" line (ink rule + New pill). Open rule: unread top level -> New line, else unread threads (known before first paint) -> Threads sheet. Long-press sheet: reactions, tiles Reply / Forward / Add to Tasks, rows Mark unread / Copy link / Copy text, then More actions. Guards: `src/__tests__/chat-threads-guards.test.ts`.
- Thread view: no reply gesture or Reply action inside a thread. Swipe right does nothing, the sheet has no Reply, swipe left Delete stays; content starts at the top; the "N replies" divider carries Add to Tasks, Forward, More for the root. Guard: `src/__tests__/thread-view-no-reply.test.ts`.
- Catch up: one card per notification; card swipe = X axis + rotate only. Max 6deg, the stack below never moves. /activity?catchup=<entryId>; every Activity row tap, the Catch up bar and the in-app Activity / mention toasts open it; the queue is fixed on open. Guard: `src/__tests__/catch-up-guards.test.ts`.
- Behaviour: hide what a person can't do; Delete = UndoStrip; ⋯ menus = ActionMenu (Open, Copy link, others, Delete last); decisions only via PostDecisionBar; phone vs laptop via useIsLaptop; svh/dvh only.
- Speed: first paint from what the device holds; no new await, hold, gate or read on a paint or tap path; parts are pure render.
- Pinned exit bar: every HeaderBar with a back "<" on a screen that opens over the app stays pinned while the page scrolls (phone page mode: sticky at --shell-sticky-top, safe area kept). On the post screen the checkpoint progress row sits inside the pinned block under the bar.
- Annotations are ink, never gold: caption highlight = fg underline + numbered ink circle; quote chip = fg rail + circle; photo pin = the checkpoint circle (resolved goes good). Creator pin = ink dot, no number.
- Comment and slot composers = chat composer: leading "+" tray with Photos, File, Assets only; no paper clip. Personal notes composer hint stays "Note" (allowed exception).
- Comments (8 Nov 2026, Linear way): one bordered action bar on the card's top edge, right, always visible: Reply, Resolve, To-do, Edit, hairline, Delete last (own only); no ⋯, no long-press menu, no role label. To-do makes a chat task (comment_task_create); tag under the body.
- Plan item, concept, bank idea and Plan notes threads draw with chat's parts (MessageBubble, swipe core, MessageActionMenu, Not sent + Retry); never hand-build a plan comment row.
- Checkpoints: one flat section (top hairline, 8 Nov 2026), threads split by hairlines; resolved points fold to one line at the bottom; numbers never change; replies fold to the latest.
- Every UI change: light + dark parity, visual baselines + layout checks (e2e/visual/layout-checks.ts) updated in the same PR; data-induction targets keep the tour working.

## Canonical living docs

- Canonical docs live in `docs/`: `pr-list.md` (PR list, referenced by full title only, no numbers, no slugs), `prd.md` (PRD, decisions only), `schema.md` (live DB snapshot from Supabase project movnexawfhsyuluspxoc). Read these before planning any work; they outrank memory and prior chat context.
- Schema changes: after executing SQL via Supabase MCP and verifying via `information_schema`, regenerate `docs/schema.md` in the same migration PR so the snapshot stays current. The PR prompt will say `Schema already applied. Do NOT execute.`

## Test site (dev server)

- https://test.srtdio-app.pages.dev is the permanent test site. Cloudflare hosts it (Pages alias `test`, plus Worker preview versions `test-<worker>` for avatar-upload, asset-upload, asset-read, chat-token, chat-transcribe). It uses the Supabase project above; the production deploy is untouched.
- Every push to an open PR updates it automatically via `.github/workflows/preview-deploy.yml` (about 3 minutes). The latest push to any PR wins.
- After pushing, give the PR URL. The test site updates on its own in about 3 minutes; do not wait for it or confirm it.
- Never ask Shubham to merge a PR he has not checked on the test site and approved.

## How to handoff

After pushing, reply with the exact PR URL: `https://github.com/srtdio/app/pull/[N]`.

## Decision test before adding to this file

"Does this prevent a real mistake that has happened or is likely?" If no, do not add it.
