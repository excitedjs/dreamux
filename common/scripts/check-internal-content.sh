#!/bin/sh
# Reject company-internal content before it reaches a commit.
#
# dreamux is a PUBLIC repository. `.gitleaks.toml` catches secrets and Feishu
# identifier *formats*, but it deliberately stays identical to the sibling
# internal repository's copy, and that repository legitimately contains the
# internal mount and developer home paths this scan rejects. So the internal
# path patterns live here instead of being added there.
#
# The release workflow already applies these patterns to packed tarball
# contents (.github/workflows/release.yml, "Pack and verify manifest"). That
# gate only sees what reaches `dist`, so an internal path in a test or a
# fixture reaches the default branch undetected — which happened on
# 2026-09-02. This script applies the same patterns to the source tree, in the
# pre-commit hook and in CI.
#
# Usage:
#   common/scripts/check-internal-content.sh            # staged changes
#   common/scripts/check-internal-content.sh --staged   # the same, explicit
#   common/scripts/check-internal-content.sh --tree     # every tracked file
set -eu

# Keep in sync with the tarball audit in .github/workflows/release.yml.
FORBIDDEN_RE='(ou_[A-Za-z0-9]{20}|oc_[A-Za-z0-9]{20}|cli_[A-Za-z0-9]{16}|/data00/|/home/[a-z][a-z0-9_-]+/)'

# Reviewed public placeholder home directories. `volta` and `linuxbrew` are real
# public install locations; the rest are example users written into tests and
# docs on purpose. Extend only with a name that is provably not a real
# developer or host account — never by directory, because the leak this gate
# exists for was in `tests/`.
ALLOWED_RE='/home/(volta|linuxbrew|linuxbrew2|example|me|me-old|meredith|op|someoneelse)/'

# Files that define or document the patterns above, and therefore have to
# contain them. Listed one by one; a directory is never excluded.
is_pattern_definition() {
  case "$1" in
    .gitleaks.toml) return 0 ;;
    .github/workflows/release.yml) return 0 ;;
    .agents/domains/repository-operations-and-release.md) return 0 ;;
    common/scripts/check-internal-content.sh) return 0 ;;
    *) return 1 ;;
  esac
}

mode="${1:---staged}"
repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"

# `core.quotePath=false` is not cosmetic. With git's default, a path holding any
# non-ASCII byte is reported C-quoted (`"\346\226\207.md"`), the lookup below
# then finds nothing, and the file is skipped in silence — a scanner that
# quietly ignores a file is the exact failure this gate exists to remove.
#
# Both modes read the indexed blob rather than the working tree. That is what
# gets committed, it is what a CI checkout produces, and it gives one code path
# that cannot trip over a tracked symlink pointing at a directory — of which
# this repository has several.
case "$mode" in
  --staged)
    files=$(git -c core.quotePath=false diff --cached --name-only --diff-filter=ACMR)
    ;;
  --tree)
    files=$(git -c core.quotePath=false ls-files)
    ;;
  *)
    echo "usage: $0 [--staged|--tree]" >&2
    exit 2
    ;;
esac

fail=0
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
  echo "[internal-content] FORBIDDEN internal content in $f:" >&2
  printf '%s\n' "$hits" | sed 's/^/  /' >&2
  fail=1
done
set +f
IFS=$oldifs

if [ "$fail" -ne 0 ]; then
  echo "[internal-content] dreamux is a public repository." >&2
  echo "[internal-content] Remove the internal identifier or path, or use a" >&2
  echo "[internal-content] reviewed public placeholder, before committing." >&2
  exit 1
fi
