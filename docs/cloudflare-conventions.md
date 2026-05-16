# Cloudflare Conventions

## Pages

- Project name: `srtdio-app`
- Production branch: `main`
- v2 staging URL: https://v2.srtd.io
- The apex `srtd.io` still serves v1 and is untouched until cutover (PR 73, PR 75).

## R2 bucket naming

R2 buckets are created at runtime, one per workspace (PRD section 13). They are
NOT created in PR 3.

- Bucket name pattern: `assets-{workspace_id}`
- Region: APAC (auto, follows the account default)
- Custom domain attachment: deferred to PR 49 (Assets upload pipeline)

## Custom domain attachment for v2.srtd.io

One-time manual step, run after `scripts/cloudflare-dns-setup.sh` creates the
`v2.srtd.io` CNAME. The Cloudflare API surface cannot script this reliably.

1. Cloudflare dashboard > Pages > `srtdio-app` > Custom domains
2. Set up a custom domain
3. Enter `v2.srtd.io`
4. Confirm; Cloudflare validates against the existing CNAME record.
