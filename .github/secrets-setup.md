# GitHub Actions Secrets

Shubham adds these manually in repo Settings > Secrets and variables > Actions.

| Secret                          | Scope       | Notes                                                            |
| ------------------------------- | ----------- | ---------------------------------------------------------------- |
| `VITE_SUPABASE_URL`             | public      | Stored as secret for env consistency. Used by PR 2 CI.           |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | public      | Stored as secret for env consistency. Used by PR 2 CI.           |
| `SUPABASE_SECRET_KEY`           | server-only | NEVER in frontend. Placeholder for later PRs.                    |
| `SUPABASE_DB_URL`               | server-only | Transaction pooler connection string. Placeholder for later PRs. |
| `CLOUDFLARE_API_TOKEN`          | server-only | Required by `deploy.yml`. Also used by the one-off scripts.      |
| `CLOUDFLARE_ACCOUNT_ID`         | server-only | Required by `deploy.yml`.                                        |
| `CLOUDFLARE_ZONE_ID`            | server-only | Required by `scripts/cloudflare-dns-setup.sh`.                   |
| `SENTRY_AUTH_TOKEN`             | server-only | In use by PR 4. Source map upload in `deploy.yml`.               |
| `SENTRY_DSN_FRONTEND`           | public      | In use by PR 4. Sentry frontend project DSN.                     |
| `SENTRY_DSN_BACKEND`            | public      | In use by PR 4. Sentry backend project DSN, wired up in PR 6.    |

The Supabase public pair is consumed by PR 2 CI and the deploy build. The
three `CLOUDFLARE_*` secrets are required by PR 3's `deploy.yml` and the
one-off Cloudflare setup scripts. The two server-only Supabase entries are
placeholders used in later PRs. The three `SENTRY_*` secrets are used by PR 4's
`deploy.yml` build step for source map upload and frontend error reporting.
