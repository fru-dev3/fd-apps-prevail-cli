#!/usr/bin/env bash
# prevail installer — fetches the prebuilt binary for your platform from
# the latest GitHub release and installs it to ~/.local/bin/prevail.
#
#   curl -fsSL https://prevail.ai/install | bash
#
# Override the install dir:
#   curl -fsSL https://prevail.ai/install | PREVAIL_BIN_DIR=/usr/local/bin bash

set -euo pipefail

REPO="${PREVAIL_REPO:-fru-dev3/prevail}"
BIN_DIR="${PREVAIL_BIN_DIR:-$HOME/.local/bin}"
DATA_DIR="${PREVAIL_DATA_DIR:-$HOME/.prevail}"
VERSION="${PREVAIL_VERSION:-latest}"

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

printf "\n  %s╲ │ ╱%s    %sPREVAIL%s\n" "$gold" "$reset" "$bold$gold" "$reset"
printf "  %s─ ◈ ─%s    a personal ai cockpit\n" "$gold" "$reset"
printf "  %s╱ │ ╲%s    %sinstalling for %s%s\n\n" "$gold" "$reset" "$dim" "$target" "$reset"

if [ "$VERSION" = "latest" ]; then
  say "fetching latest release tag..."
  VERSION=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name"' | head -1 | sed -E 's/.*"([^"]+)".*/\1/')
  if [ -z "$VERSION" ]; then echo "✗ could not resolve latest release"; exit 1; fi
fi

ASSET="prevail-${VERSION}-${target}.tar.gz"
URL="https://github.com/$REPO/releases/download/$VERSION/$ASSET"

say "downloading $ASSET..."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/$ASSET" "$URL"
tar -xzf "$tmp/$ASSET" -C "$tmp"

mkdir -p "$BIN_DIR"
mv "$tmp/prevail" "$BIN_DIR/prevail"
chmod +x "$BIN_DIR/prevail"

say "installed binary to $BIN_DIR/prevail"

if [ -d "$tmp/vault-demo" ]; then
  mkdir -p "$DATA_DIR"
  rm -rf "$DATA_DIR/vault-demo"
  mv "$tmp/vault-demo" "$DATA_DIR/vault-demo"
  say "installed synthetic vault to $DATA_DIR/vault-demo"
fi

if [ -f "$tmp/AGENTS-operating.md" ]; then
  mkdir -p "$DATA_DIR"
  mv "$tmp/AGENTS-operating.md" "$DATA_DIR/AGENTS-operating.md"
  say "installed agent operating manual to $DATA_DIR/AGENTS-operating.md"
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    note ""
    note "$BIN_DIR is not on your PATH. add this to your shell rc:"
    note "  export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

printf "\n  %sdone.%s next:\n" "$bold" "$reset"
printf "    %sprevail%s          ← first-run wizard\n" "$gold" "$reset"
printf "    %sprevail demo%s     ← jump straight into the synthetic vault\n" "$gold" "$reset"
printf "    %sprevail doctor%s   ← check installed AI clis\n\n" "$gold" "$reset"
