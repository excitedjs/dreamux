#!/usr/bin/env bash
# Install the gitleaks binary this repository's pre-commit gate requires.
#
# dreamux is a PUBLIC repository. The anti-leak gate is not optional and the
# hook refuses to pass without it, so this script exists to make installing it
# a single command on any developer machine and on CI runners that commit.
#
# The version is pinned rather than resolved from "latest": a guardrail whose
# behaviour changes under you is not a guardrail. The download is checksum-
# verified against the same release's published checksums file.
#
# Usage:
#   common/scripts/install-gitleaks.sh              # installs to ~/.local/bin
#   GITLEAKS_INSTALL_DIR=/usr/local/bin common/scripts/install-gitleaks.sh
set -euo pipefail

GITLEAKS_VERSION="8.30.1"
INSTALL_DIR="${GITLEAKS_INSTALL_DIR:-$HOME/.local/bin}"
BASE_URL="https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}"

case "$(uname -s)" in
  Linux) os="linux" ;;
  Darwin) os="darwin" ;;
  *) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) arch="x64" ;;
  arm64 | aarch64) arch="arm64" ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

asset="gitleaks_${GITLEAKS_VERSION}_${os}_${arch}.tar.gz"
workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

echo "downloading ${asset}"
curl -fsSL --retry 3 -o "$workdir/$asset" "$BASE_URL/$asset"
curl -fsSL --retry 3 -o "$workdir/checksums.txt" \
  "$BASE_URL/gitleaks_${GITLEAKS_VERSION}_checksums.txt"

echo "verifying checksum"
expected="$(awk -v want="$asset" '$2 == want || $2 == "*"want { print $1 }' \
  "$workdir/checksums.txt")"
if [ -z "$expected" ]; then
  echo "no checksum published for $asset; refusing to install" >&2
  exit 1
fi
if command -v sha256sum > /dev/null 2>&1; then
  actual="$(sha256sum "$workdir/$asset" | awk '{ print $1 }')"
else
  actual="$(shasum -a 256 "$workdir/$asset" | awk '{ print $1 }')"
fi
if [ "$expected" != "$actual" ]; then
  echo "checksum mismatch for $asset" >&2
  echo "  expected $expected" >&2
  echo "  actual   $actual" >&2
  exit 1
fi

tar -xzf "$workdir/$asset" -C "$workdir" gitleaks
mkdir -p "$INSTALL_DIR"
install -m 0755 "$workdir/gitleaks" "$INSTALL_DIR/gitleaks"

installed="$("$INSTALL_DIR/gitleaks" version 2> /dev/null || true)"
case "$installed" in
  *"$GITLEAKS_VERSION"*) ;;
  *)
    echo "installed binary reports '$installed', expected $GITLEAKS_VERSION" >&2
    exit 1
    ;;
esac

echo "gitleaks $GITLEAKS_VERSION installed at $INSTALL_DIR/gitleaks"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo
    echo "$INSTALL_DIR is not on your PATH; the pre-commit gate will not find it."
    echo "Add this to your shell profile:"
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac
