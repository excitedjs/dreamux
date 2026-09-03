#!/bin/sh
# Reject company-internal content before it reaches a commit or a release.
#
# dreamux is a PUBLIC repository. `.gitleaks.toml` catches secrets and Feishu
# identifier *formats*, but it deliberately stays identical to the sibling
# internal repository's copy, and that repository legitimately contains the
# internal mount and developer home paths this scan rejects. So the internal
# path patterns live here instead of being added there.
#
# This script is the one owner of those patterns. The release workflow
# (.github/workflows/release.yml, "Pack and verify manifest") runs it over
# every packed tarball with `--tarball`. That gate only sees what reaches
# `dist`, so an internal path in a test or a fixture reached the default
# branch undetected on 2026-09-02; the tree modes below exist for that, in the
# pre-commit hook and in CI.
#
# Usage:
#   common/scripts/check-internal-content.sh                  # staged changes
#   common/scripts/check-internal-content.sh --staged         # the same, explicit
#   common/scripts/check-internal-content.sh --tree           # every tracked file
#   common/scripts/check-internal-content.sh --tarball <tgz>  # every packed file
set -eu

FORBIDDEN_RE='(ou_[A-Za-z0-9]{20}|oc_[A-Za-z0-9]{20}|cli_[A-Za-z0-9]{16}|/data00/|/home/[a-z][a-z0-9_-]+/)'

# Reviewed public placeholder home directories. `volta` and `linuxbrew` are real
# public install locations; the rest are example users written into tests and
# docs on purpose. Extend only with a name that is provably not a real
# developer or host account — never by directory, because the leak this gate
# exists for was in `tests/`.
ALLOWED_RE='/home/(volta|linuxbrew|linuxbrew2|example|me|me-old|meredith|op|someoneelse)/'

# What a packed tarball may carry: only the two real public install locations
# compiled into `dist`. The example users above are source-tree placeholders
# for tests and docs, and none of them belongs in a published artifact.
ALLOWED_DIST_RE='/home/(volta|linuxbrew)/'

# Files that define or document the patterns above, and therefore have to
# contain them. Listed one by one; a directory is never excluded.
is_pattern_definition() {
  case "$1" in
    .gitleaks.toml) return 0 ;;
    .agents/domains/repository-operations-and-release.md) return 0 ;;
    common/scripts/check-internal-content.sh) return 0 ;;
    *) return 1 ;;
  esac
}

# $1 names what was scanned; the hits arrive on stdin, one per line.
report() {
  echo "[internal-content] FORBIDDEN internal content in $1:" >&2
  sed 's/^/  /' >&2
}

mode="${1:---staged}"
fail=0

if [ "$mode" = "--tarball" ]; then
  # A tarball is scanned where it is: no repository is needed, and the path is
  # used before any `cd` so a relative one keeps meaning what the caller wrote.
  tgz="${2:-}"
  if [ -z "$tgz" ] || [ ! -f "$tgz" ]; then
    echo "usage: $0 --tarball <file.tgz>" >&2
    exit 2
  fi
  contents=$(mktemp)
  trap 'rm -f "$contents"' EXIT
  # Extracted to a file first: a tar failure then stops the script under
  # `set -e` instead of hiding behind the last exit status of a pipeline.
  tar xzO -f "$tgz" > "$contents"
  hits=$(grep -aoE "$FORBIDDEN_RE" "$contents" \
    | grep -vxE "$ALLOWED_DIST_RE" \
    | sort -u || true)
  if [ -n "$hits" ]; then
    printf '%s\n' "$hits" | report "$tgz"
    fail=1
  fi
else
  repo_root=$(git rev-parse --show-toplevel)
  cd "$repo_root"

  # `core.quotePath=false` is not cosmetic. With git's default, a path holding
  # any non-ASCII byte is reported C-quoted (`"\346\226\207.md"`), the lookup
  # below then finds nothing, and the file is skipped in silence — a scanner
  # that quietly ignores a file is the exact failure this gate exists to remove.
  #
  # Both modes read the indexed blob rather than the working tree. That is what
  # gets committed, it is what a CI checkout produces, and it gives one code
  # path that cannot trip over a tracked symlink pointing at a directory — of
  # which this repository has several.
  case "$mode" in
    --staged)
      files=$(git -c core.quotePath=false diff --cached --name-only --diff-filter=ACMR)
      ;;
    --tree)
      files=$(git -c core.quotePath=false ls-files)
      ;;
    *)
      echo "usage: $0 [--staged|--tree|--tarball <file.tgz>]" >&2
      exit 2
      ;;
  esac

  oldifs=$IFS
  IFS='
'
  set -f # paths are literal; do not glob-expand them
  for f in $files; do
    [ -n "$f" ] || continue
    is_pattern_definition "$f" && continue
    hits=$(git show ":$f" \
      | grep -aoE "$FORBIDDEN_RE" \
      | grep -vxE "$ALLOWED_RE" \
      | sort -u || true)
    [ -n "$hits" ] || continue
    printf '%s\n' "$hits" | report "$f"
    fail=1
  done
  set +f
  IFS=$oldifs
fi

if [ "$fail" -ne 0 ]; then
  echo "[internal-content] dreamux is a public repository." >&2
  echo "[internal-content] Remove the internal identifier or path, or use a" >&2
  echo "[internal-content] reviewed public placeholder, before committing." >&2
  exit 1
fi
