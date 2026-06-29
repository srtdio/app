#!/usr/bin/env bash
# Convert a PDF to Markdown using Microsoft's markitdown.
#
# Usage:
#   scripts/pdf-to-markdown.sh <input.pdf> [output.md]
#
# If [output.md] is omitted, the output is written next to the input with a
# .md extension (e.g. brief.pdf -> brief.md).
#
# Requires markitdown with PDF support:
#   pip install 'markitdown[pdf]'
#
# Manual / dev tooling only. NOT run by CI.
set -euo pipefail

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "usage: scripts/pdf-to-markdown.sh <input.pdf> [output.md]" >&2
  exit 1
fi

input="$1"

if [ ! -f "$input" ]; then
  echo "error: input file not found: $input" >&2
  exit 1
fi

case "$input" in
  *.pdf | *.PDF) ;;
  *)
    echo "error: input does not look like a PDF: $input" >&2
    exit 1
    ;;
esac

# Default output: same path with the extension replaced by .md.
output="${2:-${input%.*}.md}"

if ! command -v markitdown >/dev/null 2>&1; then
  echo "error: markitdown is not installed." >&2
  echo "       install it with: pip install 'markitdown[pdf]'" >&2
  exit 1
fi

markitdown "$input" -o "$output"

echo "Converted $input -> $output"
