# Cloudflare Conventions

## Pages

- Project name: `srtdio-app`
- Production branch: `main`

## R2 bucket naming

R2 buckets are created at runtime, one per workspace (PRD section 13). They are
NOT created in PR 3.

- Bucket name pattern: `assets-{workspace_id}`
- Region: APAC (auto, follows the account default)
- Custom domain attachment: deferred to PR 49 (Assets upload pipeline)
