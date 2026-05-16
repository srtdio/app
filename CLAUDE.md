# CLAUDE.md

## Project

Sorted v2: a social media operations platform for agencies.

## Invariants

- One workspace = one client = one platform.
- TypeScript strict mode everywhere; no loosening of compiler flags.
- Multi-tenant isolation is enforced by Postgres RLS.
- `post.stage` (workflow position) and `publish_status` (platform state) are separate fields; never conflate them.
- Auth: JWT expires in 15 minutes; long-lived sessions tracked in `session_devices`.
- `trace_id` is always passed as an explicit RPC parameter, never inferred.
- Comments are stored in Postgres; Chat runs on Agora.
- Inbox is a permanent surface; it is never cleared or archived away.
- Published posts are frozen; edits create new versions, not mutations.
- Assets are versioned; old versions are retained.
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

## File structure

- `src/` application code.
- `src/lib/` shared utilities.
- `src/components/` UI components.
- `src/server/` edge functions (added in later PRs).

## How to handoff

After pushing, reply with the exact PR URL: `https://github.com/srtdio/app/pull/[N]`.

## Decision test before adding to this file

"Does this prevent a real mistake that has happened or is likely?" If no, do not add it.
