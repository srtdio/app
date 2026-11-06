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

Design ratchet (CI: design-ratchet-ci.yml): `node --experimental-strip-types scripts/design-ratchet.ts [--verbose|--update]`.

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
- `supabase/functions/ops-cockpit` - the platform operator's Cockpit API (GET mode=status|full; 404 for anyone without an active platform_operators row); the UI is `src/components/cockpit/`, lazy-loaded only when the operator flag is true.
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

## Design and layout (locked 6 Nov 2026; guards in src/**tests**, eslint designRules, scripts/design-ratchet.ts)

- Use a part or add a slot to it; never hand-build its frame or fork it. If no part fits, stop and ask.
- Parts (src/components/ui): Text, layout.ts, Card, Row, Tile, ChatCard, Composer, HeaderBar, Toolbar, StatusDot, Sheet + SheetActions, ActionMenu + ActionMenuTrigger, Button / IconButton / Chip / PressableRow (44 tall), Tag, CountBadge, Avatar, PersonTrigger, NoResults, ErrorNote, SidePanel, PostPlaceholder.
- Type roles (ui/Text only): display (post title only), title (bar titles), heading, body, secondary, label, meta (mono, tabular), section. Max 3 roles per part. leading-_, tracking-_, text-[..] live only in ui/Text (lint error).
- Values: tailwind.config.ts holds only the allowed scale (type xs..3xl + input; 4px spacing grid plus 0.5 and 1.5; radius roles; border 1/2 + named cut-out/rail; named z layers base..top; named panel widths). New exception = named token + one-line comment. No [Npx], no z-[N].
- Edges (L2): page 16 phone / 24 laptop (GUTTER), chat 12 (CHAT_GUTTER), sheets 16. Inside <= outside spacing.
- Trailing rule: a trailing ⋮, chevron or X is a 44 box pulled out 12 (TRAILING_PULL) so its glyph sits on the content edge; leading back/close mirrors it (LEADING_PULL). Parts apply it, never call sites.
- Lanes (ui/layout LANE\_\*): unread pill top centre, jump-to-latest bottom trailing above the composer, tip strip in flow above the composer; they never cover a title, a time or each other.
- Exit: "<" for anything opening over the app; X only for remove / clear / dismiss / cancel upload. One exit per panel.
- States keep their footprint: Button busy keeps width; Sheet busy is on its button; Composer, upload, pending, Not sent and select mode keep row height and slots.
- Lighting: one lit-_ height per surface (no shadow-_, drop-shadow, backdrop-blur, dark:); outlines lit-selected/lit-focus/lit-bad/lit-drop/lit-today only.
- Colour: token classes only; greys + amber Review, green Approved, red errors/Reject; no violet/blue, no hex, no text-white. Contrast 4.5:1 text, 3:1 edges.
- Motion: src/lib/motion only; never fade; instant under Reduce Motion.
- Icons: ui/icons.tsx only; ICON_SIZE; stroke follows size (strokeFor). One icon per concept.
- Words: Activity, file/Assets, Due (never Target), Review, Retry, Alerts. Zero states "{Things} show up here." Errors "Couldn't {action}. {reason}". No em-dashes. Dates via src/lib/time.ts, font-mono tabular-nums.
- Behaviour: hide what a person can't do; Delete = UndoStrip; ⋯ menus = ActionMenu (Open, Copy link, others, Delete last); decisions only via PostDecisionBar; phone vs laptop via useIsLaptop; svh/dvh only.
- Speed: first paint from what the device holds; no new await, hold, gate or read on a paint or tap path; parts are pure render.
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
