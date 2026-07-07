#!/usr/bin/env bash
# Deploy gate — fail if real/personal data leaked into the SHIPPED demo vault.
# The bundled vault-demo must be 100% synthetic (the "Alex Rivera" persona); no
# maintainer-identifying data (email, name, home path) may reach users.
# Mirrors prevail-desktop/scripts/scrub-gate.sh. Run: bash scripts/scrub-gate.sh
set -euo pipefail

TARGET="${1:-vault-demo}"
if [ ! -d "$TARGET" ]; then
  echo "scrub-gate: target '$TARGET' not found — skipping."
  exit 0
fi

# Name patterns are base64-encoded so this script itself never contains the
# strings it exists to keep out of the tree (grep/code-search finds plaintext).
PATTERNS=(
  'fru\.dev3'       # email local-part of the project account
  "$(printf 'RnJ1IE5kZQ==' | base64 -d)"
  "$(printf 'RnJ1IExvdWlz' | base64 -d)"
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

# Auto-generated runtime LEDGERS must never ship — they accumulate the user's
# REAL activity (chat intents/questions, decisions, Omega learnings, loop runs,
# usage). The bundled demo is curated synthetic content only.
ledgers=$(find "$TARGET" \( \
  -name "omega.md" -o -name "_intents.jsonl" -o -name "_decisions.jsonl" \
  -o -name "_journal.md" -o -name "_loops_runtime.json" -o -name "_surface.json" \
  -o -name "_skillgen.json" -o -name "_taskgen.json" -o -name "usage.ndjson" \
  \) 2>/dev/null || true)
if [ -n "$ledgers" ]; then
  echo "❌ scrub-gate: runtime ledger(s) present in $TARGET — real-activity byproducts must not ship:"
  echo "$ledgers" | sed "s|$TARGET/|   |"
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "Deploy blocked: scrub real/personal data from the demo vault before releasing."
  exit 1
fi
echo "✓ scrub-gate: $TARGET is clean of personal data ($(find "$TARGET" -type f | wc -l | tr -d ' ') files scanned)."
