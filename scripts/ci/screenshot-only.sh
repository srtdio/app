#!/usr/bin/env bash
# Screenshot-only push check, shared by ci.yml, e2e-webkit.yml and visual-ci.yml.
#
# Prints "true" when this pull_request push can reuse the previous push's
# result for the calling workflow, else "false" (never fails the job):
#   1. the event is a pull_request synchronize with a previous head (BEFORE),
#   2. every file changed from BEFORE to the new head (HEAD_SHA) is a visual
#      baseline under e2e/visual/__screenshots__/ or the screen-to-files map
#      e2e/visual/screen-files.json (the nightly bot PR carries both; no
#      deletes of other files, no code, no merge of main),
#   3. the newest pull_request run of WORKFLOW on BEFORE concluded success,
#   4. with --refresh: BEFORE's commit message carries [update-visual-baselines]
#      (the baselines in this push are the ones that run rendered and checked).
# The typical case is the baseline commit Visual CI's commit-baselines pushes
# right after a green [update-visual-baselines] run.
#
# Usage: screenshot-only.sh <workflow file name> [--refresh]
# Env: GH_TOKEN (actions: read), REPO, EVENT_NAME, ACTION, BEFORE, HEAD_SHA.
set -uo pipefail

workflow="${1:?workflow file name}"
refresh="${2:-}"

no() {
  echo "screenshot-only: no ($1)" >&2
  echo false
  exit 0
}

[ "${EVENT_NAME:-}" = pull_request ] || no "event ${EVENT_NAME:-none}"
[ "${ACTION:-}" = synchronize ] || no "action ${ACTION:-none}"
[ -n "${BEFORE:-}" ] && [ -n "${HEAD_SHA:-}" ] || no "no previous head"
case "$BEFORE" in 0000000000000000000000000000000000000000) no "no previous head" ;; esac
git cat-file -e "$BEFORE^{commit}" 2>/dev/null || no "previous head $BEFORE not fetched"
git cat-file -e "$HEAD_SHA^{commit}" 2>/dev/null || no "head $HEAD_SHA not fetched"

files=$(git diff --name-only "$BEFORE" "$HEAD_SHA") || no "diff failed"
[ -n "$files" ] || no "no files changed"
while IFS= read -r f; do
  case "$f" in
    e2e/visual/__screenshots__/* | e2e/visual/screen-files.json) ;;
    *) no "$f changed" ;;
  esac
done <<< "$files"

if [ "$refresh" = --refresh ]; then
  message=$(git log -1 --format=%B "$BEFORE") || no "no message for $BEFORE"
  printf '%s' "$message" | grep -qF '[update-visual-baselines]' ||
    no "previous head was not a baseline refresh"
fi

conclusion=$(gh api "repos/$REPO/actions/workflows/$workflow/runs?head_sha=$BEFORE&event=pull_request&per_page=20" \
  --jq '.workflow_runs | sort_by(.created_at) | last | .conclusion // ""' 2>/dev/null) ||
  no "could not read $workflow runs on $BEFORE"
[ "$conclusion" = success ] || no "$workflow on $BEFORE: ${conclusion:-no run}"

echo "screenshot-only: yes, $workflow passed on $BEFORE and only baselines changed" >&2
echo true
