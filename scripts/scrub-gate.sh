#!/usr/bin/env bash
# Deploy gate — fail if real/personal data leaked into the SHIPPED demo vault.
# The bundled vault-demo must be 100% synthetic (the "Alex Rivera" persona); the
# founder's real identity (email, name, home path) must never reach users.
# Mirrors prevail-desktop/scripts/scrub-gate.sh. Run: bash scripts/scrub-gate.sh
set -euo pipefail

TARGET="${1:-vault-demo}"
if [ ! -d "$TARGET" ]; then
  echo "scrub-gate: target '$TARGET' not found — skipping."
  exit 0
fi

PATTERNS=(
  'fru\.dev3'       # real email local-part
  'Fru'         # real legal name
  'Fru'       # legacy real-name variant
  '/Users/[a-z]'    # any real home-dir path — runtime leak
)
ALLOW='your_email|example\.com|alex\.rivera|jordan|maria@austincpa|you@|user@|name@'

fail=0
for p in "${PATTERNS[@]}"; do
  hits=$(grep -rinE "$p" "$TARGET" 2>/dev/null || true)
  if [ -n "$hits" ]; then
    echo "❌ scrub-gate: matched forbidden pattern /$p/ in $TARGET:"
    echo "$hits" | head -8 | sed 's/^/   /'
    fail=1
  fi
done
leaked=$(grep -rhoiE '[a-z0-9._%+-]+@(gmail|icloud|yahoo|outlook|hotmail|me|proton)\.(com|me)' "$TARGET" 2>/dev/null | grep -viE "$ALLOW" | sort -u || true)
if [ -n "$leaked" ]; then
  echo "❌ scrub-gate: non-synthetic email address(es) in $TARGET:"
  echo "$leaked" | sed 's/^/   /'
  fail=1
fi
if [ "$fail" -ne 0 ]; then
  echo ""
  echo "Deploy blocked: scrub real/personal data from the demo vault before releasing."
  exit 1
fi
echo "✓ scrub-gate: $TARGET is clean of personal data ($(find "$TARGET" -type f | wc -l | tr -d ' ') files scanned)."
