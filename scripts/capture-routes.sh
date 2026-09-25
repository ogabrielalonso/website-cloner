#!/usr/bin/env bash
# capture-routes.sh — bulk-fetch raw SSR HTML for markup-port (Framer site).
# Reads route paths (one per line) from a file or stdin, encodes each to the
# slice-routes slug convention ("/" → index, "/a/b" → a__b), and curls the SSR
# HTML into docs/research/raw-html/<slug>.html in parallel.
#
#   scripts/capture-routes.sh docs/research/routes.txt
#   printf '%s\n' /changelog /definitions/a | scripts/capture-routes.sh
#
# Idempotent: pass --force to re-fetch existing files (default skips them).
set -euo pipefail

ORIGIN=""
OUT="docs/research/raw-html"
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
PAR=12
FORCE=0

ARGS=()
for a in "$@"; do
  case "$a" in
    --force) FORCE=1 ;;
    --origin=*) ORIGIN="${a#--origin=}" ;;
    -P*) PAR="${a#-P}" ;;
    *) ARGS+=("$a") ;;
  esac
done

# Resolve the origin: --origin=… wins, else read source_input from the clone's snapshot.
if [ -z "$ORIGIN" ] && [ -f docs/research/.template-snapshot ]; then
  src=$(sed -n 's/^source_input=//p' docs/research/.template-snapshot | head -1)
  if [ -n "$src" ]; then ORIGIN=$(printf '%s' "$src" | sed -E 's#(https?://[^/]+).*#\1#'); fi
fi
if [ -z "$ORIGIN" ]; then
  echo "capture-routes: no origin — pass --origin=https://site.com or run from a workspace with docs/research/.template-snapshot" >&2
  exit 2
fi
ORIGIN="${ORIGIN%/}"

mkdir -p "$OUT"
export ORIGIN OUT UA FORCE

fetch_one() {
  local path="$1"
  path="${path%$'\r'}"
  [ -z "$path" ] && return 0
  local slug
  if [ "$path" = "/" ]; then slug="index"; else
    slug="${path#/}"; slug="${slug%/}"; slug="${slug//\//__}"
  fi
  local dest="$OUT/$slug.html"
  if [ "$FORCE" = "0" ] && [ -s "$dest" ]; then return 0; fi
  local code
  code=$(curl -s -A "$UA" -w "%{http_code}" -o "$dest.tmp" "$ORIGIN$path" || echo "000")
  if [ "$code" = "200" ] && [ -s "$dest.tmp" ]; then
    mv "$dest.tmp" "$dest"
    printf 'OK   %s  (%s)\n' "$slug" "$(wc -c < "$dest" | tr -d ' ')"
  else
    rm -f "$dest.tmp"
    printf 'FAIL %s  http=%s\n' "$slug" "$code"
  fi
}
export -f fetch_one

if [ "${#ARGS[@]}" -gt 0 ] && [ -f "${ARGS[0]}" ]; then
  SRC=$(cat "${ARGS[0]}")
elif [ "${#ARGS[@]}" -gt 0 ]; then
  SRC=$(printf '%s\n' "${ARGS[@]}")
else
  SRC=$(cat)
fi

printf '%s\n' "$SRC" | xargs -P "$PAR" -I{} bash -c 'fetch_one "$@"' _ {}
