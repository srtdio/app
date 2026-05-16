#!/usr/bin/env bash
# One-off: create the Cloudflare Pages project for Sorted v2.
# Run once after PR 3 merges, with CLOUDFLARE_API_TOKEN set locally.
# Idempotent: a pre-existing project is treated as success.
set -euo pipefail

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "error: CLOUDFLARE_API_TOKEN is not set" >&2
  exit 1
fi

output=$(pnpm wrangler pages project create srtdio-app --production-branch main 2>&1) || true
echo "$output"

if echo "$output" | grep -qiE "already exists|8000007"; then
  echo "Pages project srtdio-app already exists; nothing to do."
  exit 0
fi

if echo "$output" | grep -qiE "error|✘"; then
  echo "error: failed to create Pages project" >&2
  exit 1
fi

echo "Pages project srtdio-app created."
