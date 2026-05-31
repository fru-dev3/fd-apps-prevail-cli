#!/usr/bin/env bash
# aireadyu installer — fetches the prebuilt binary for your platform from
# the latest GitHub release and installs it to ~/.local/bin/aireadyu.
#
#   curl -fsSL https://aireadyu.life/install | bash
#
# Override the install dir:
#   curl -fsSL https://aireadyu.life/install | AIREADYU_BIN_DIR=/usr/local/bin bash

set -euo pipefail

REPO="${AIREADYU_REPO:-fru-dev3/aireadyu}"
BIN_DIR="${AIREADYU_BIN_DIR:-$HOME/.local/bin}"
VERSION="${AIREADYU_VERSION:-latest}"

bold=$(printf '\033[1m')
gold=$(printf '\033[38;5;179m')
dim=$(printf '\033[2m')
reset=$(printf '\033[0m')

say() { printf "  %s%s%s\n" "$gold" "$1" "$reset"; }
note() { printf "  %s%s%s\n" "$dim" "$1" "$reset"; }

uname_s=$(uname -s)
uname_m=$(uname -m)

case "$uname_s-$uname_m" in
  Darwin-arm64)   target="darwin-arm64" ;;
  Darwin-x86_64)  target="darwin-x64" ;;
  Linux-x86_64)   target="linux-x64" ;;
  Linux-aarch64)  target="linux-arm64" ;;
  *) echo "✗ unsupported platform: $uname_s $uname_m"; exit 1 ;;
esac

printf "\n  %s╲ │ ╱%s    %sAIREADYU%s\n" "$gold" "$reset" "$bold$gold" "$reset"
printf "  %s─ ◈ ─%s    a personal ai cockpit\n" "$gold" "$reset"
printf "  %s╱ │ ╲%s    %sinstalling for %s%s\n\n" "$gold" "$reset" "$dim" "$target" "$reset"

if [ "$VERSION" = "latest" ]; then
  say "fetching latest release tag..."
  VERSION=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name"' | head -1 | sed -E 's/.*"([^"]+)".*/\1/')
  if [ -z "$VERSION" ]; then echo "✗ could not resolve latest release"; exit 1; fi
fi

ASSET="aireadyu-${VERSION}-${target}.tar.gz"
URL="https://github.com/$REPO/releases/download/$VERSION/$ASSET"

say "downloading $ASSET..."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/$ASSET" "$URL"
tar -xzf "$tmp/$ASSET" -C "$tmp"

mkdir -p "$BIN_DIR"
mv "$tmp/aireadyu" "$BIN_DIR/aireadyu"
chmod +x "$BIN_DIR/aireadyu"

say "installed to $BIN_DIR/aireadyu"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    note ""
    note "$BIN_DIR is not on your PATH. add this to your shell rc:"
    note "  export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

printf "\n  %sdone.%s next:\n" "$bold" "$reset"
printf "    %saireadyu%s          ← first-run wizard\n" "$gold" "$reset"
printf "    %saireadyu demo%s     ← jump straight into the synthetic vault\n" "$gold" "$reset"
printf "    %saireadyu doctor%s   ← check installed AI clis\n\n" "$gold" "$reset"
