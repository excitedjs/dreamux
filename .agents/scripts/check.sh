#!/usr/bin/env bash
# Validate the .agents/ knowledge base.
#
# Checks:
#   1. every internal Markdown link inside .agents/ resolves to a file or
#      directory that exists
#   2. every .md file under .agents/ is reachable from .agents/root.md
#      (link graph; flags orphans)
#   3. every decision record is listed in .agents/decisions/README.md
#   4. every /packages/... file path cited by service-topology.md exists
#
# Exits 0 on success, non-zero with a noisy list of failures otherwise.
# Run before committing KB changes, and from CI.

set -eu
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
KB_ROOT="$(cd -- "$SCRIPT_DIR/.." &> /dev/null && pwd)"
REPO_ROOT="$(cd -- "$KB_ROOT/.." &> /dev/null && pwd)"

errors=0

# ---------- 1) internal Markdown links resolve ----------
# Match each Markdown inline link target. External URLs and same-page anchors are
# skipped; repo-root-absolute and relative links must resolve.
# shellcheck disable=SC2016  # the perl one-liner below feeds this loop; its single
# quotes are intentional ($ARGV/$1 are perl variables, not shell expansions).
while IFS= read -r entry; do
  file="${entry%%:*}"
  target="${entry#*:}"
  target="${target%%#*}"
  [ -z "$target" ] && continue
  case "$target" in
    http://*|https://*|mailto:*|\#*) continue ;;
    /*) full="$REPO_ROOT$target" ;;
    *) full="$(cd -- "$(dirname -- "$file")" 2>/dev/null && realpath -m -- "$target")" ;;
  esac
  if [ ! -e "$full" ]; then
    rel_file="${file#"$REPO_ROOT"/}"
    echo "broken markdown link in $rel_file -> $target (resolved to $full)" >&2
    errors=$((errors + 1))
  fi
done < <(find "$KB_ROOT" -type f -name '*.md' -print0 | xargs -0 perl -ne 'while (/\]\(([^)]+)\)/g) { print "$ARGV:$1\n" }' 2>/dev/null || true)

# ---------- 2) orphan detection ----------
# Build the set of every .md file under .agents/, minus root.md itself.
# Then walk reachable files from root.md following any .md link
# (relative or absolute-into-.agents/). Anything not in the reachable set
# is an orphan.

declare -A all
while IFS= read -r f; do
  rel="${f#"$KB_ROOT"/}"
  [ "$rel" = "root.md" ] && continue
  all["$rel"]=1
done < <(find "$KB_ROOT" -type f -name '*.md')

declare -A seen
queue=("root.md")
seen["root.md"]=1
while [ ${#queue[@]} -gt 0 ]; do
  cur="${queue[0]}"
  queue=("${queue[@]:1}")
  curfile="$KB_ROOT/$cur"
  [ -f "$curfile" ] || continue
  while IFS= read -r target; do
    # Match either `](foo.md)` or absolute `](/.agents/foo.md)`.
    target="${target%%#*}"
    [ -z "$target" ] && continue
    case "$target" in
      http*|mailto:*) continue ;;
      /*)
        # absolute repo path
        next="${target#/}"
        case "$next" in
          .agents/*) next="${next#.agents/}" ;;
          *) continue ;;
        esac
        ;;
      *)
        # relative to current file
        next="$(dirname "$cur")/$target"
        # normalize
        next="$(cd "$KB_ROOT" 2>/dev/null && realpath --no-symlinks --relative-to=. "$next" 2>/dev/null || echo "$next")"
        ;;
    esac
    # only follow .md links
    case "$next" in
      *.md) ;;
      *) continue ;;
    esac
    if [ -z "${seen[$next]+x}" ]; then
      seen["$next"]=1
      queue+=("$next")
    fi
  done < <(perl -ne 'while (/\]\(([^)]+)\)/g) { print "$1\n" }' "$curfile" 2>/dev/null || true)
done

for rel in "${!all[@]}"; do
  if [ -z "${seen[$rel]+x}" ]; then
    echo "orphan KB doc: .agents/$rel is not reachable from root.md" >&2
    errors=$((errors + 1))
  fi
done

# ---------- 3) decision index completeness ----------
decision_index="$KB_ROOT/decisions/README.md"
decision_index_entries="$(
  awk '
    /^## Alphabetical Index$/ { in_index = 1; next }
    /^## / && in_index { exit }
    in_index { print }
  ' "$decision_index"
)"
while IFS= read -r f; do
  slug="$(basename "$f" .md)"
  [ "$slug" = "README" ] && continue
  expected="- [$slug]($slug.md)"
  if ! printf '%s\n' "$decision_index_entries" | grep -Fxq -- "$expected"; then
    echo "decision missing from alphabetical index: .agents/decisions/$slug.md" >&2
    errors=$((errors + 1))
  fi
done < <(find "$KB_ROOT/decisions" -maxdepth 1 -type f -name '*.md' | sort)

# ---------- 4) service topology source path liveness ----------
service_topology="$KB_ROOT/reference/service-topology.md"
if [ -f "$service_topology" ]; then
  while IFS= read -r cited; do
    path="${cited%%#*}"
    case "$path" in
      *:[0-9]*) path="${path%:*}" ;;
    esac
    full="$REPO_ROOT$path"
    if [ ! -e "$full" ]; then
      echo "missing service topology source path: reference/service-topology.md -> $path" >&2
      errors=$((errors + 1))
    fi
  done < <(
    perl -ne 'while (m{(/packages/[^`)\s#]+)}g) { print "$1\n" }' "$service_topology" \
      | sort -u
  )
fi

if [ "$errors" -gt 0 ]; then
  echo "" >&2
  echo "$errors KB issue(s) found" >&2
  exit 1
fi
echo "KB OK ($(echo "${!all[@]}" | wc -w) files reachable from root.md)"
