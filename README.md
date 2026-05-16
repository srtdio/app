# Sorted v2

Social media operations platform for agencies.

## Stack

- Vite 5 + React 18 + TypeScript 5 (strict)
- Tailwind CSS 3 (PostCSS, autoprefixer)
- ESLint 9 (flat config) + Prettier 3
- Node 22 LTS, pnpm

## Prerequisites

- Node 22 (`.nvmrc`)
- pnpm

## Setup

```sh
pnpm install
```

### Local setup

- Copy `.env.example` to `.env.local`.
- Fill in `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` from the Supabase project.
- Run `pnpm install`.
- Run `pnpm dev`.

## Commands

| Command             | Description                     |
| ------------------- | ------------------------------- |
| `pnpm dev`          | Start the dev server            |
| `pnpm build`        | Type-check and build to `dist/` |
| `pnpm preview`      | Preview the production build    |
| `pnpm typecheck`    | Run `tsc --noEmit`              |
| `pnpm lint`         | Run ESLint                      |
| `pnpm format`       | Format with Prettier            |
| `pnpm format:check` | Check formatting with Prettier  |

## Monitoring

- Errors: Sentry at srtdio.sentry.io.
- Frontend: project=frontend, init from `src/lib/sentry.ts`.
- Backend: project=backend, integration in PR 6.

## Deploy

- On first push to main, CI auto-creates the Cloudflare Pages project.
- One-time: run `scripts/cloudflare-dns-setup.sh` (creates the `v2.srtd.io` CNAME).
- One-time: manually attach `v2.srtd.io` as a custom domain in the Pages dashboard (see `docs/cloudflare-conventions.md`).
- Ongoing: pushes to `main` auto-deploy via `.github/workflows/deploy.yml`.
- v2 staging URL: https://v2.srtd.io
- Scripts need `CLOUDFLARE_API_TOKEN` (and `CLOUDFLARE_ZONE_ID` for DNS) set locally.
- The `srtd.io` apex still serves v1 and is untouched until cutover.
