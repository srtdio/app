#!/usr/bin/env bash
# One-off: create the R2 bucket that backs Cloudflare Logpush for Sorted v2,
# and apply a 30-day retention lifecycle rule.
#
# Manual step only. NOT run by CI. See docs/cloudflare-logpush-setup.md.
# Run with CLOUDFLARE_API_TOKEN set locally.
# Idempotent: a pre-existing bucket is treated as success.
set -euo pipefail

BUCKET="srtdio-logs"

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "error: CLOUDFLARE_API_TOKEN is not set" >&2
  exit 1
fi

output=$(pnpm wrangler r2 bucket create "$BUCKET" 2>&1) || true
echo "$output"

if echo "$output" | grep -qiE "already (exists|owned)"; then
  echo "R2 bucket $BUCKET already exists; continuing."
elif echo "$output" | grep -qiE "error|✘"; then
  echo "error: failed to create R2 bucket $BUCKET" >&2
  exit 1
else
  echo "R2 bucket $BUCKET created."
fi

# 30-day retention: expire log objects 30 days after creation.
lifecycle=$(pnpm wrangler r2 bucket lifecycle add "$BUCKET" \
  --name expire-logs-30d \
  --expire-days 30 2>&1) || true
echo "$lifecycle"

if echo "$lifecycle" | grep -qiE "error|✘"; then
  echo "error: failed to apply 30-day lifecycle rule to $BUCKET" >&2
  exit 1
fi

echo "Done. Lifecycle rule expire-logs-30d applied to $BUCKET."
echo "Next: create the Logpush job (see docs/cloudflare-logpush-setup.md)."
