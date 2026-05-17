# Cloudflare Logpush setup

Structured JSON logs from Workers and Pages Functions are shipped to an R2
bucket via Cloudflare Logpush. This is a one-time manual setup; CI never
mutates the Cloudflare account.

## Overview

- App code logs single-line JSON via `src/lib/logger.ts` (frontend) and
  `src/server/logger.ts` (backend). Every line carries `trace_id`, `level`,
  `ts`, `msg` and `context`.
- Workers and Pages Functions write those lines to stdout.
- `[observability]` in `wrangler.toml` enables Cloudflare's log collection.
- Logpush forwards the collected events to the R2 bucket `srtdio-logs`.

## Prerequisites

- `CLOUDFLARE_API_TOKEN` with R2 and Logpush permissions, set locally.
- `wrangler` (already a devDependency).

## 1. Create the R2 bucket

Run the helper script (not run by CI):

```sh
CLOUDFLARE_API_TOKEN=... scripts/cloudflare-logpush-init.sh
```

It creates the R2 bucket `srtdio-logs` and applies a 30-day lifecycle rule.

## 2. Create the Logpush job

In the Cloudflare dashboard (Account > Logs > Logpush) or via the API:

- Job name: `pages-srtdio-app-logs`
- Destination: R2 bucket `srtdio-logs/` (path prefix optional, e.g.
  `srtdio-logs/{DATE}/`)
- Dataset:
  - `workers_trace_events` for Workers.
  - `pages_function_logs` for Pages Functions (add once Pages Functions
    exist; deferred to a later PR).
- Output format: NDJSON.
- Filter: `outcome != "ok"` OR sample 10% of successful requests
  (`sampling_rate = 0.1` on the success branch). Failures are always shipped.

## 3. Retention

The 30-day lifecycle rule on the `srtdio-logs` bucket (applied in step 1)
expires objects automatically. Adjust the rule in the R2 dashboard if a
different retention window is needed.

## Notes

- Do not run Logpush API calls from CI; this stays a manual operation.
- The R2 bucket `srtdio-logs` must exist before logs flow; until then
  Logpush jobs targeting it fail.
- Real Worker integration (Workers actually emitting these logs) lands in a
  later PR; `src/server/logger.ts` is currently an interface-stable stub.
