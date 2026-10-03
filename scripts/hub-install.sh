#!/bin/bash
# Install the Prevail hub on the hub Mac (agent-mesh plan, Step 4).
#
#   scripts/hub-install.sh [--host <tailscale-ip>] [--port 7421] [--no-load] [--uninstall]
#
# What it does, all machine-local (nothing enters the vault):
#   1. links ~/.local/bin/prevail to the app's engine, so `prevail spaces cmd`
#      works inside herdr tabs;
#   2. `prevail hub init`: the hub secret in ~/.prevail/hub.json (0600);
#   3. two LaunchAgents: sh.prevail.hub (`prevail hub serve`, kept alive) and
#      sh.prevail.spaces-tidy (`prevail spaces tidy` every 5 minutes: idle and
#      memory policy, and the open tabs' domain locks);
#   4. loads them and checks /health.
# Bind address: the Tailscale IPv4 (asked of the tailscale CLI or the app),
# else --host. Never 0.0.0.0. Re-running is safe: the secret is kept.
#
# Overrides for a dry run on another machine: PREVAIL_BIN, LAUNCH_AGENTS_DIR,
# BIN_DIR, LOG_DIR, PREVAIL_CONFIG_DIR.
set -euo pipefail

PREVAIL_BIN=${PREVAIL_BIN:-/Applications/Prevail.app/Contents/MacOS/prevail}
LAUNCH_AGENTS_DIR=${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}
BIN_DIR=${BIN_DIR:-$HOME/.local/bin}
LOG_DIR=${LOG_DIR:-$HOME/Library/Logs}
HOST=""
PORT=7421
LOAD=1
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST=$2; shift 2 ;;
    --port) PORT=$2; shift 2 ;;
    --no-load) LOAD=0; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

HUB=sh.prevail.hub
TIDY=sh.prevail.spaces-tidy

if [ "$UNINSTALL" = 1 ]; then
  for l in $HUB $TIDY; do
    launchctl bootout "gui/$(id -u)/$l" 2>/dev/null || true
    [ -f "$LAUNCH_AGENTS_DIR/$l.plist" ] && mv "$LAUNCH_AGENTS_DIR/$l.plist" "$LAUNCH_AGENTS_DIR/$l.plist.removed-$(date +%Y-%m-%d)"
  done
  echo "hub stopped; plists kept beside as .removed-<date>; ~/.prevail/hub.json kept"
  exit 0
fi

[ -x "$PREVAIL_BIN" ] || { echo "no engine at $PREVAIL_BIN (install Prevail.app, or set PREVAIL_BIN)" >&2; exit 1; }

if [ -z "$HOST" ]; then
  for ts in tailscale /Applications/Tailscale.app/Contents/MacOS/Tailscale; do
    if command -v "$ts" >/dev/null 2>&1 || [ -x "$ts" ]; then
      HOST=$("$ts" ip -4 2>/dev/null | head -1 || true)
      [ -n "$HOST" ] && break
    fi
  done
fi
[ -n "$HOST" ] || { echo "no Tailscale address found; pass --host <tailscale-ip> (or 127.0.0.1 for local only)" >&2; exit 1; }
case "$HOST" in 0.0.0.0|::) echo "refusing to bind every interface" >&2; exit 1 ;; esac

mkdir -p "$BIN_DIR" "$LAUNCH_AGENTS_DIR" "$LOG_DIR"
if [ ! -e "$BIN_DIR/prevail" ]; then
  ln -s "$PREVAIL_BIN" "$BIN_DIR/prevail"
  echo "linked $BIN_DIR/prevail"
fi

"$PREVAIL_BIN" hub init --host "$HOST" --port "$PORT"

plist() { # label, interval-or-empty, args...
  local label=$1 interval=$2; shift 2
  local args="" a
  for a in "$PREVAIL_BIN" "$@"; do args="$args    <string>$a</string>
"; done
  local when
  if [ -n "$interval" ]; then
    when="  <key>StartInterval</key><integer>$interval</integer>"
  else
    when="  <key>KeepAlive</key><true/>"
  fi
  cat > "$LAUNCH_AGENTS_DIR/$label.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
$args  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$BIN_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
$when
  <key>StandardOutPath</key><string>$LOG_DIR/$label.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/$label.log</string>
</dict>
</plist>
EOF
  echo "wrote $LAUNCH_AGENTS_DIR/$label.plist"
}

plist $HUB "" hub serve
plist $TIDY 300 spaces tidy

if [ "$LOAD" = 1 ]; then
  for l in $HUB $TIDY; do
    launchctl bootout "gui/$(id -u)/$l" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENTS_DIR/$l.plist"
  done
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS "http://$HOST:$PORT/health" >/dev/null 2>&1; then
      echo "hub up: http://$HOST:$PORT/domains/<domain>"
      exit 0
    fi
    sleep 1
  done
  echo "hub did not answer on http://$HOST:$PORT/health; see $LOG_DIR/$HUB.log" >&2
  exit 1
fi
echo "not loaded (--no-load); start with: launchctl bootstrap gui/\$(id -u) $LAUNCH_AGENTS_DIR/$HUB.plist"
