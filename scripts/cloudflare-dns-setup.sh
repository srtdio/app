#!/usr/bin/env bash
# One-off: create the v2.srtd.io CNAME record pointing at Cloudflare Pages.
# Run once after the first Pages deployment.
# Idempotent: checks for an existing matching record before creating one.
# Does NOT touch the srtd.io apex, MX, or any other v1 DNS records.
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is not set}"
: "${CLOUDFLARE_ZONE_ID:?CLOUDFLARE_ZONE_ID is not set}"

API="https://api.cloudflare.com/client/v4"
RECORD_NAME="v2.srtd.io"
RECORD_CONTENT="srtdio-app.pages.dev"

auth=(-H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" -H "Content-Type: application/json")

existing=$(curl -fsS "${auth[@]}" \
  "${API}/zones/${CLOUDFLARE_ZONE_ID}/dns_records?type=CNAME&name=${RECORD_NAME}")

count=$(echo "$existing" | grep -o '"content":"[^"]*"' | grep -c "${RECORD_CONTENT}" || true)
if [ "$count" -gt 0 ]; then
  echo "CNAME ${RECORD_NAME} -> ${RECORD_CONTENT} already exists; nothing to do."
  exit 0
fi

echo "Creating CNAME ${RECORD_NAME} -> ${RECORD_CONTENT} ..."
curl -fsS -X POST "${auth[@]}" \
  "${API}/zones/${CLOUDFLARE_ZONE_ID}/dns_records" \
  --data "{\"type\":\"CNAME\",\"name\":\"${RECORD_NAME}\",\"content\":\"${RECORD_CONTENT}\",\"proxied\":true,\"ttl\":1}"
echo
echo "Done."
