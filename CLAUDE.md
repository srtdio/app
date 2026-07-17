# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Sorted v2: a social media operations platform for agencies. A social-media approval tool: client writes a brief, agency drafts a post, the post moves through review to approved, rejected, or parked. No publishing, scheduling, plan, or insights in the MVP.

## Commands

Node 22 (`.nvmrc`), pnpm. Run `pnpm install` first.

- `pnpm dev` - Vite dev server (needs `.env.local` with `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`, see `.env.example`)
- `pnpm build` - typecheck + production build to `dist/`
- `pnpm typecheck` - `tsc --noEmit` on app + node configs
- `pnpm lint` - ESLint 9 flat config
- `pnpm test` - unit tests only (root vitest config; never touches a database)
- `pnpm format` / `pnpm format:check` - Prettier
- `pnpm types:supabase` - regenerate `packages/schemas/src/supabase.generated.ts` (needs `SUPABASE_PROJECT_ID`); never edit that file by hand

Single unit test: `pnpm exec vitest run src/lib/foo.test.ts`.

Domain/DB suites live in `tests/<domain>/` and are NOT run by `pnpm test`. Each has its own config and CI workflow:

- `pnpm exec vitest run --config tests/<domain>/vitest.config.ts` (domains: rls, auth, posts, briefs, comments, inbox, rpc, workspace, flags, etl)
- Type-check a suite: `pnpm exec tsc -p tests/<domain>/tsconfig.json --noEmit`
- DB-backed specs are gated with `describe.runIf(process.env.<DOMAIN>_SUITE === '1')`; the suite config sets that env var. Under the root config they auto-skip, so the default run stays DB-free.
- The RLS suite's globalSetup boots a local ephemeral Supabase container (Supabase CLI) and applies `supabase/migrations/`; it never touches the live database.

## Architecture

pnpm workspace monorepo. Frontend is a Vite 5 + React 18 + Tailwind 3 SPA; backend is Supabase (Postgres + RLS + edge functions) plus Cloudflare Workers.

- `src/` - the SPA. `src/components/pages/` route pages (Pipeline, PCS, Briefs, Chat, Assets, Activity, Settings, Cockpit), `src/components/ui|shell|...` shared UI, `src/lib/` client logic (contexts, chat store, inbox, hooks). Deployed to Cloudflare Pages (`srtdio-app`, staging https://v2.srtd.io) via `.github/workflows/deploy.yml` on push to main.
- `src/server/` - server-side code shared by Workers: `workers/` one module per Worker (chat-token, chat-agora-sync, asset-upload/read, avatar-upload, og-preview, inbox-writer, chat-webhook-mirror, chat-transcribe), plus `assets/` upload pipeline (MIME allowlist, EXIF strip, SVG sanitize, virus scan), `cron/` scheduled handlers, `middleware/` (idempotency), `logger.ts`, `trace.ts`.
- `workers/<name>/` - one `wrangler.toml` per Worker whose `main` points at `src/server/workers/<name>.ts`; secrets are Worker secrets, only binding names appear in the toml. Each Worker has its own `*-deploy.yml` workflow. (`workers/inbox-writer/` is self-contained with its own `src/`.)
- `packages/` - domain packages imported as `@srtdio/*`, all exporting raw TS from `src/index.ts` (no build step). `schemas` is the base: Zod schemas + generated Supabase types. `rpc` wraps Supabase RPC (`callRpc`). `auth`, `posts`, `briefs`, `comments`, `inbox`, `workspace`, `storage` are domain logic shared by frontend and Workers. `etl` is the standalone v1-to-v2 migration tool. `test-utils` holds RLS test helpers.
- `supabase/` - `migrations/` (implementation truth for schema), `functions/` Deno edge functions (invite-send/accept, session-register, brief-create/close, comment-create), `config.toml`.

### Supabase projects

| Env | Project ID           | Status                                                                     |
| --- | -------------------- | -------------------------------------------------------------------------- |
| v2  | movnexawfhsyuluspxoc | Build target. YES.                                                         |
| v1  | ozptjplxbyswclolbxyn | LIVE PRODUCTION. Never touch except the ETL cutover script on cutover day. |

Both are in Mumbai; region is not a disambiguator. Always pass the v2 project ID explicitly to Supabase tools.

### Trace propagation

Every user action generates a uuid_v7 `trace_id` (`src/lib/trace.ts`) that flows FE -> Supabase -> DB RPC -> Worker -> Sentry tag. ESLint enforces the plumbing: raw `fetch` is banned (use `fetchWithTrace()` from `src/lib/fetch.ts`, which adds `X-Trace-Id`), `.rpc()` without `_trace_id` is banned (use `callRpc()` from `src/lib/rpc.ts`), and `console.*` is banned in `src/**` outside the logger files (use `logger` from `src/lib/logger.ts` or `src/server/logger.ts`; single-line JSON output).

## Invariants

- One workspace = one client = one platform.
- TypeScript strict mode everywhere; no loosening of compiler flags.
- Multi-tenant isolation is enforced by Postgres RLS.
- `post.stage` is the single workflow state: draft, review, approved, parked, rejected. There is no `publish_status` field in MVP.
- Auth: JWT expires in 15 minutes; long-lived sessions tracked in `session_devices`.
- `trace_id` is always passed as an explicit RPC parameter, never inferred.
- Every Supabase `.rpc()` call MUST pass `_trace_id` via the `callRpc()` helper. ESLint enforces. Never `SET LOCAL`.
- Comments are stored in Postgres; Chat runs on Agora (Postgres holds a mirror in `chat_messages`).
- Inbox is a permanent surface; it is never cleared or archived away.
- Assets are versioned; old versions are retained. R2 buckets are per-workspace (`assets-{workspace_id}`), created at runtime.
- Briefs are read-only once created.
- Approval is per-post; there is no bulk approve.
- Touch targets are at least 44x44 px.
- No AI features in v2.0.

## Rules for Claude Code

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

## Canonical living docs

- Canonical docs live in `docs/`: `pr-list.md` (PR list, referenced by full title only, no numbers, no slugs), `prd.md` (PRD, decisions only), `schema.md` (live DB snapshot from Supabase project movnexawfhsyuluspxoc). Read these before planning any work; they outrank memory and prior chat context.
- Schema changes: after executing SQL via Supabase MCP and verifying via `information_schema`, regenerate `docs/schema.md` in the same migration PR so the snapshot stays current. The PR prompt will say `Schema already applied. Do NOT execute.`

## How to handoff

After pushing, reply with the exact PR URL: `https://github.com/srtdio/app/pull/[N]`.

## Decision test before adding to this file

"Does this prevent a real mistake that has happened or is likely?" If no, do not add it.
