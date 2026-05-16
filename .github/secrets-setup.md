# GitHub Actions Secrets

Shubham adds these manually in repo Settings > Secrets and variables > Actions.

| Secret                          | Scope       | Notes                                                            |
| ------------------------------- | ----------- | ---------------------------------------------------------------- |
| `VITE_SUPABASE_URL`             | public      | Stored as secret for env consistency. Used by PR 2 CI.           |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | public      | Stored as secret for env consistency. Used by PR 2 CI.           |
| `SUPABASE_SECRET_KEY`           | server-only | NEVER in frontend. Placeholder for later PRs.                    |
| `SUPABASE_DB_URL`               | server-only | Transaction pooler connection string. Placeholder for later PRs. |

Only the first two are consumed by PR 2 CI (the build job). The other two are
added now so we do not forget them; they are used in later PRs.
