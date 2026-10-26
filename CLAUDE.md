# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Sorted: a social media operations platform for agencies. A social-media approval tool: client writes a brief, agency drafts a post, the post moves through review to approved, rejected, or parked. Also shipped: Plan, chat scheduled send, voice note transcription, and Inbox. No post publishing or insights in the MVP.

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

iPhone/WebKit visual checks: `pnpm test:e2e` (e2e/harness)

Domain/DB suites live in `tests/<domain>/` and are NOT run by `pnpm test`. Each has its own config and CI workflow:

- `pnpm exec vitest run --config tests/<domain>/vitest.config.ts` (domains: rls, auth, posts, briefs, comments, inbox, rpc, workspace, flags)
- Type-check a suite: `pnpm exec tsc -p tests/<domain>/tsconfig.json --noEmit`
- DB-backed specs are gated with `describe.runIf(process.env.<DOMAIN>_SUITE === '1')`; the suite config sets that env var. Under the root config they auto-skip, so the default run stays DB-free.
- The RLS suite's globalSetup boots a local ephemeral Supabase container (Supabase CLI) and applies `supabase/migrations/`; it never touches the live database.

## Architecture

pnpm workspace monorepo. Frontend is a Vite 5 + React 18 + Tailwind 3 SPA; backend is Supabase (Postgres + RLS + edge functions) plus Cloudflare Workers.

- `src/` - the SPA. `src/components/pages/` route pages (Pipeline, PCS, Briefs, Chat, Assets, Activity, Settings, Cockpit), `src/components/ui|shell|...` shared UI, `src/lib/` client logic (contexts, chat store, inbox, hooks). Deployed to Cloudflare Pages (`srtdio-app`) via `.github/workflows/deploy.yml` on push to main.
- `src/server/` - server-side code shared by Workers: `workers/` one module per Worker (chat-token, chat-agora-sync, chat-scheduled-send, chat-transcribe, asset-upload/read, avatar-upload, link-preview, og-preview), plus `assets/` upload pipeline (MIME allowlist, EXIF strip, SVG sanitize, virus scan), `cron/` scheduled handlers (catchup-send, storage-purge Workers), `middleware/` (idempotency), `logger.ts`, `trace.ts`.
- `workers/<name>/` - one `wrangler.toml` per Worker whose `main` points at `src/server/workers/<name>.ts`; secrets are Worker secrets, only binding names appear in the toml. Each Worker has its own `*-deploy.yml` workflow.
- `packages/` - domain packages imported as `@srtdio/*`, all exporting raw TS from `src/index.ts` (no build step). `schemas` is the base: Zod schemas + generated Supabase types. `rpc` wraps Supabase RPC (`callRpc`). `posts`, `briefs`, `comments`, `inbox`, `workspace`, `storage` are domain logic shared by frontend and Workers. `test-utils` holds RLS test helpers.
- `supabase/` - `migrations/` (implementation truth for schema), `functions/` Deno edge functions (invite-send/accept, brand-request-send, book-call-send, demo-request-send, catchup-unsubscribe, resend-webhook), `config.toml`.

### Supabase project

Supabase project ID: movnexawfhsyuluspxoc. Pass it explicitly to every Supabase MCP call.

### Trace propagation

Every user action generates a uuid_v7 `trace_id` (`src/lib/trace.ts`) that flows FE -> Supabase -> DB RPC -> Worker -> Sentry tag. ESLint enforces the plumbing: raw `fetch` is banned (use `fetchWithTrace()` from `src/lib/fetch.ts`, which adds `X-Trace-Id`), `.rpc()` without `_trace_id` is banned (use `callRpc()` from `src/lib/rpc.ts`), and `console.*` is banned in `src/**` outside the logger files (use `logger` from `src/lib/logger.ts` or `src/server/logger.ts`; single-line JSON output).

## Invariants

- One workspace = one client = one platform.
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
- Touch targets are at least 44x44 px.
- No connection-state UI anywhere (no Reconnecting/Connecting/Offline). Failures show per message only: clock while pending, 'Not sent' + retry on failure.
- AI: voice note transcription only.

## Rules for Claude Code

- Speed rule: never run pnpm test, pnpm build, pnpm typecheck, pnpm lint, e2e or any test suite locally. GitHub CI runs all checks. Write tests, do not run them. Do not wait for CI or the test site after pushing: push, open the PR, return the URL. No self-audit loops.
- One PR per prompt.
- Never auto-merge a PR.
- Schema changes execute via the Supabase MCP only after Shubham approves them.
- Never use `.js` or `.jsx` for application code; `.ts` and `.tsx` only.
- Never commit secrets.
- Never push to `main` directly.
- Light and dark mode parity is required on every UI PR.
- No em-dashes in user-facing strings.
- Never put SUPABASE_SECRET_KEY or DB connection strings in frontend code or committed .env files. Server secrets live in GitHub Actions Secrets and Cloudflare Pages env only.
- All deploys go through CI to Cloudflare Pages on push to main. Never deploy locally except for emergency rollback via `wrangler pages deploy`.
- Errors flow to Sentry srtdio org: frontend project for React errors, backend project for Cloudflare Workers. Source maps uploaded in CI only.
- New API endpoints, RPC functions, and Workers must accept and propagate trace_id. Read it from the `X-Trace-Id` header on inbound, attach it to all outbound calls.
- Use logger from `src/lib/logger.ts`. No `console.*` in `src/**` outside logger files.

## Design rules (locked 24 Oct 2026)

- Type: Tailwind fontSize scale only (xs 11, sm 12, md 13, base 14, lg 15, xl 17, 2xl 20, 3xl 28). No text-[Npx]. Inputs render 16px on phone (iOS zoom). Weights 400/500/600 only.
- Roles: page title 3xl/600; screen header lg/600; section label sm/600 uppercase tracking-[0.06em] fg-2; card title base/500; body base fg; meta sm fg-3, meta only, never copy or controls.
- Buttons: only Button / IconButton / Chip from src/components/ui. 44 tall. Variants primary secondary ghost link success danger; shape round for the composer.
- Icons: only src/components/ui/icons.tsx, stroke 1.7, sizes 16 beside text, 18 sidebar, 20 alone or tab bar, 22 tray/menu. One icon per concept. No inline <svg> outside ui/.
- Colour: token classes only; /opacity allowed. No hex, no dark:. text-accent is for text, bg-accent for fills. good/warn/bad for state; stage-\* only on stage chips and dots.
- Contrast: every text token passes 4.5:1 on bg and panel in both themes.
- Radius roles: controls 8, cards/popovers/menus 12, sheets/dialogs 16, pills full. Chat bubble radii live only in chat/chat-type.ts.
- Shadows: cards none; menus/popovers/sheets/dialogs shadow-2xl; dragged items shadow-lg; tokens for toast, auth card, spotlight.
- Tappable rows and tiles use PressableRow; dim layers use Backdrop; upload targets use DropZone; never override a ui primitive with "!".
- Icon sizes come from ICON_SIZE in ui/icons.tsx.
- Words: Activity (never Notifications), file (the tab is Assets), Due date, stages Draft/Review/Approved/Parked/Rejected. Format, chat and workspace names come from their src/lib functions only.
- Zero results use ui/NoResults only. Zero states are one positive line, "{Things} show up here." Never "Nothing", "No matches" or "empty" in a zero state.
- Errors: "Couldn't {action}. {reason}". Never mention connection state.
- Dates and times come from src/lib/time.ts only. No toLocale\*, Intl.DateTimeFormat or date libraries in components.
- Due dates are calendar days on the workspace zone; moments (message, comment, activity times) are on the device zone.
- Motion: duration-fast/base/slow and ease-enter/exit only. No duration-[Nms] or raw transition values.
- If no shared component or function fits, stop and ask. Never hand-build a new variant.
- Post and brief decisions render only through PostDecisionBar: phone bottom bar, laptop header right. Every surface that shows a post offers the same actions for the same role.
- ⋯ menus use ui/ActionMenu only: sheet on phone, popover on laptop. Order: Open, Copy link, others, Delete last.
- Sheets: title left, X right. Cancel only in footers, ghost, left of the primary.
- New buttons: primary with IconPlus. Empty states have no create button.
- Hide what a person can't do; never disable for permission.
- Delete = UndoStrip for UNDO_MS (src/lib/undo.ts). ConfirmDialog only when the action cannot be undone.
- Toasts come from ui/toast only. Phone vs laptop comes from useIsLaptop only.
- List toolbars: search, at most one IconButton, then the New button. No text buttons or dropdown chevrons in the toolbar.
- Avatars: ui/Avatar roles only (inline 20, header 32, row 40, profile 72). People circle, groups and notes rounded square.
- Counts and unread badges: ui/CountBadge only. Filter chip counts are plain text.
- Icon meanings: Send = send a message only; Forward/Send to chat = IconForward; Reject X, Approve check, Park pause; attach = paper clip. Decision bar buttons have no icons.
- Long-press on touch and right-click on laptop open the same ActionMenu. Esc closes every overlay and returns focus to its trigger.
- Exception: plan edit rows open their menu on right-click only; long-press there is drag.
- Every UI change updates the visual baselines in the same PR and lists the changed screens. Never update baselines to hide an unplanned change.
- Onboarding follows the app: it uses only shared pieces, the tour finds controls by data-induction. Any UI change that moves, renames or removes a data-induction control updates the tour step, its copy (src/lib/induction-copy.ts) and its visual baselines in the same PR. Never delete a data-induction attribute without updating the tour.

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
