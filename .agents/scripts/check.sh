#!/usr/bin/env bash
# Validate the .agents/ knowledge base.
#
# Checks:
#   1. every repo-root-absolute link target (`/foo/bar`) inside .agents/
#      resolves to a file or directory that exists
#   2. every .md file under .agents/ is reachable from .agents/root.md
#      (link graph; flags orphans)
#
# Exits 0 on success, non-zero with a noisy list of failures otherwise.
# Run before committing KB changes, and from CI.

set -eu
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
KB_ROOT="$(cd -- "$SCRIPT_DIR/.." &> /dev/null && pwd)"
REPO_ROOT="$(cd -- "$KB_ROOT/.." &> /dev/null && pwd)"

errors=0

# ---------- 1) repo-root-absolute links resolve ----------
# Match `](/...)` style links — the convention CONTRIBUTING.md mandates.
while IFS= read -r line; do
  file="${line%%:*}"
  link="${line#*:}"
  # Strip line-number prefix and the surrounding `](...)`.
  target="$(echo "$link" | sed -E 's/.*\]\((\/[^)#]+)(#[^)]*)?\).*/\1/')"
  [ -z "$target" ] && continue
  full="$REPO_ROOT$target"
  if [ ! -e "$full" ]; then
    echo "broken link in $file -> $target (resolved to $full)" >&2
    errors=$((errors + 1))
  fi
done < <(grep -rEn --include='*.md' ']\(/[^)]+\)' "$KB_ROOT" 2>/dev/null || true)

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
  while IFS= read -r raw; do
    # Match either `](foo.md)` or `](foo/)` or absolute /.agents/foo.md.
    target="$(echo "$raw" | sed -E 's/.*\]\(([^)#]+)(#[^)]*)?\).*/\1/')"
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
  done < <(grep -E ']\([^)]+\)' "$curfile" 2>/dev/null || true)
done

for rel in "${!all[@]}"; do
  if [ -z "${seen[$rel]+x}" ]; then
    echo "orphan KB doc: .agents/$rel is not reachable from root.md" >&2
    errors=$((errors + 1))
  fi
done

if [ "$errors" -gt 0 ]; then
  echo "" >&2
  echo "$errors KB issue(s) found" >&2
  exit 1
fi
echo "KB OK ($(echo "${!all[@]}" | wc -w) files reachable from root.md)"
