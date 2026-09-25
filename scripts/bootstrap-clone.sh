#!/usr/bin/env bash
#
# bootstrap-clone.sh — materialize a fresh, clean clone workspace from this template.
#
# The website-cloner skill is installed globally but is NOT self-contained: it builds
# inside a Next.js + shadcn + Tailwind v4 scaffold. This script stamps a fresh copy of
# that scaffold into a dedicated subfolder under the Websites base dir, so the skill can
# run from anywhere and drop each clone into its own isolated workspace —
# mirroring how ~/code/study/Decode/ holds one subfolder per decoded repo.
#
# Usage:
#   bootstrap-clone.sh <slug-or-url> [websites-home]
#
# Examples:
#   bootstrap-clone.sh https://stripe.com          -> ~/code/study/Websites/stripe-com
#   bootstrap-clone.sh linear.app                  -> ~/code/study/Websites/linear-app
#   WEBSITES_HOME=/tmp/x bootstrap-clone.sh foo    -> /tmp/x/foo
#
# The scaffold is exported via `git archive HEAD`, so it is always clean (no node_modules,
# no .git, no artifacts from prior clones). NOTE: only COMMITTED template state is copied —
# commit refinements to the template before cloning from them.
#
# stdout: the absolute path of the created workspace (last line, machine-readable).
# stderr: all progress/npm logs.
set -euo pipefail

RAW="${1:?usage: bootstrap-clone.sh <slug-or-url> [websites-home]}"
WEBSITES_HOME="${2:-${WEBSITES_HOME:-$HOME/code/study/Websites}}"

# TEMPLATE_HOME = the repo this script lives in (resolved from the script's own path,
# so it keeps working even when the skill is invoked via a symlink from ~/.claude/skills).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_HOME="$(cd "$SCRIPT_DIR/.." && pwd)"

# Derive a filesystem-safe slug from a URL or a raw name.
slug="$RAW"
slug="${slug#http://}"
slug="${slug#https://}"
slug="${slug%%/*}"      # keep hostname only
slug="${slug#www.}"     # drop leading www.
slug="$(printf '%s' "$slug" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g; s/--*/-/g; s/^-//; s/-$//')"
[ -n "$slug" ] || { echo "bootstrap-clone: could not derive a slug from '$RAW'" >&2; exit 1; }

DEST="$WEBSITES_HOME/$slug"

if [ -e "$DEST" ]; then
  # Reusing an existing workspace. If it was stamped from an OLDER template commit, this
  # re-clone will silently run on STALE scripts — which defeats the most common reason to
  # re-clone (validating a refined template). Compare stamps and warn LOUDLY when they differ.
  existing_head=$(sed -n 's/^template_head=//p' "$DEST/docs/research/.template-snapshot" 2>/dev/null)
  current_head=$(cd "$TEMPLATE_HOME" 2>/dev/null && git rev-parse --short HEAD 2>/dev/null)
  if [ -n "$existing_head" ] && [ -n "$current_head" ] && [ "$existing_head" != "$current_head" ]; then
    echo "bootstrap-clone: ============================================================" >&2
    echo "bootstrap-clone: ⚠  REUSING A STALE WORKSPACE — it will NOT have recent template changes." >&2
    echo "bootstrap-clone:    existing scaffold = template $existing_head" >&2
    echo "bootstrap-clone:    current template  = $current_head" >&2
    echo "bootstrap-clone:    To clone with the LATEST template (e.g. to validate it):" >&2
    echo "bootstrap-clone:      rm -rf \"$DEST\"   # or: WEBSITES_HOME=<other-dir>" >&2
    echo "bootstrap-clone:    then re-run. Proceeding with the stale workspace for now." >&2
    echo "bootstrap-clone: ============================================================" >&2
  else
    echo "bootstrap-clone: workspace already exists, reusing: $DEST" >&2
  fi
  echo "$DEST"
  exit 0
fi

echo "bootstrap-clone: template = $TEMPLATE_HOME" >&2
echo "bootstrap-clone: creating  = $DEST" >&2

# `git archive HEAD` captures only COMMITTED state. Warn if the template has
# uncommitted TRACKED changes (SKILL.md, globals.css, a script) so the user
# doesn't bootstrap a stale workspace. Tracked-only on purpose — `git status
# --porcelain` would false-positive on untracked files (e.g. a stray scratch file).
TEMPLATE_HEAD="$(git -C "$TEMPLATE_HOME" rev-parse --short HEAD 2>/dev/null || echo unknown)"
DIRTY="$( { git -C "$TEMPLATE_HOME" diff --name-only HEAD; git -C "$TEMPLATE_HOME" diff --cached --name-only HEAD; } 2>/dev/null | sort -u )"
if [ -n "$DIRTY" ]; then
  echo "bootstrap-clone: WARNING — template has uncommitted tracked changes (HEAD $TEMPLATE_HEAD)." >&2
  echo "bootstrap-clone:           they will NOT be in this workspace until committed:" >&2
  echo "$DIRTY" | sed 's/^/  /' >&2
fi

mkdir -p "$DEST"
# Export the committed template snapshot (clean by construction).
git -C "$TEMPLATE_HOME" archive HEAD | tar -x -C "$DEST"

# Auditable receipt: template commit + the source URL/arg this clone came from.
# (The slug is lossy — you cannot recover the original URL from it — so record it.)
mkdir -p "$DEST/docs/research"
printf 'template_head=%s\ntemplate_home=%s\nsource_input=%s\nstamped_at=%s\n' \
  "$TEMPLATE_HEAD" "$TEMPLATE_HOME" "$RAW" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  > "$DEST/docs/research/.template-snapshot"
printf '%s\n' "$RAW" > "$DEST/docs/research/SOURCE_URL"

cd "$DEST"

# node_modules cache: extracting a pre-baked tar is ~5s vs ~30-60s for npm install.
# Keyed by the committed package-lock.json hash + platform triple (native binaries
# differ per arch). Any dependency change busts the key automatically. Always safe
# to fall back to a real npm install.
CACHE_DIR="${WEBSITE_CLONER_CACHE:-$HOME/.cache/website-cloner}"
LOCK_SHA="$( { shasum -a 256 package-lock.json 2>/dev/null || sha256sum package-lock.json 2>/dev/null; } | awk '{print $1}' )"
PLATFORM="$(node -p 'process.platform+"-"+process.arch' 2>/dev/null || echo unknown)"
CACHE_TAR="$CACHE_DIR/node_modules-${LOCK_SHA}-${PLATFORM}.tar.gz"

if [ -n "$LOCK_SHA" ] && [ -f "$CACHE_TAR" ]; then
  echo "bootstrap-clone: node_modules cache HIT — extracting" >&2
  if ! tar -xzf "$CACHE_TAR" -C "$DEST" 2>/dev/null; then
    echo "bootstrap-clone: cache extract failed — npm install" >&2
    npm install 1>&2
  fi
else
  echo "bootstrap-clone: node_modules cache MISS — npm install ..." >&2
  npm install 1>&2
  if [ -n "$LOCK_SHA" ] && [ -d node_modules ]; then
    mkdir -p "$CACHE_DIR"
    tar -czf "$CACHE_TAR.tmp" -C "$DEST" node_modules 2>/dev/null \
      && mv "$CACHE_TAR.tmp" "$CACHE_TAR" \
      && echo "bootstrap-clone: node_modules cached → $CACHE_TAR" >&2 \
      || rm -f "$CACHE_TAR.tmp"
  fi
fi

# Initialize a git repo so the skill can use `git worktree` for parallel builders.
# The SKILL prescribes worktree isolation, but `git archive | tar` leaves no .git —
# without this, worktree creation fails. The scaffold's .gitignore keeps
# node_modules / .next out of the commit.
git -C "$DEST" init -q
git -C "$DEST" add -A
git -C "$DEST" -c user.email=clone@website-cloner.local -c user.name="website-cloner" \
  commit -q -m "chore: clone scaffold (template ${TEMPLATE_HEAD})" || true

echo "bootstrap-clone: ready." >&2
# Machine-readable result: the workspace path, on stdout, as the final line.
echo "$DEST"
