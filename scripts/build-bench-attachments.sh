#!/usr/bin/env bash
# build-bench-attachments.sh
#
# Converts every .md attachment under vault-demo/benchmark/attachments/
# into a sibling .pdf via weasyprint, and generates one ASCII-chart
# image via ImageMagick to round out the multimodal test surface.
#
# The .md files are the canonical source — the bench runner reads them
# directly and inlines their text into the prompt for every CLI. The
# .pdfs and .pngs this script produces are companion artifacts the user
# can inspect visually, OR commit alongside the .md and add to a future
# question's attachments list once per-CLI PDF/image-passing is wired
# (currently the runner only inlines text).
#
# Requirements:
#   - weasyprint (brew install weasyprint, or pip install weasyprint)
#   - magick (brew install imagemagick)
#
# Run from the repo root:
#   bash scripts/build-bench-attachments.sh

set -euo pipefail

ATTACH_DIR="vault-demo/benchmark/attachments"

if ! command -v weasyprint >/dev/null 2>&1; then
  echo "✗ weasyprint not found. install via 'brew install weasyprint' or 'pip install weasyprint'."
  exit 1
fi

if ! command -v magick >/dev/null 2>&1; then
  echo "! magick not found — skipping the chart-image step."
  SKIP_MAGICK=1
fi

if [ ! -d "$ATTACH_DIR" ]; then
  echo "✗ $ATTACH_DIR does not exist. run this from the repo root."
  exit 1
fi

# Minimal CSS to make the PDF look like a real document, not raw markdown.
CSS=$(cat <<'CSS_EOF'
@page { size: letter; margin: 0.75in; }
body { font-family: -apple-system, "Helvetica Neue", Helvetica, sans-serif; font-size: 10.5pt; line-height: 1.45; color: #222; }
h1 { font-size: 18pt; border-bottom: 1px solid #888; padding-bottom: 4px; margin-bottom: 16px; }
h2 { font-size: 13pt; color: #444; margin-top: 18px; }
h3 { font-size: 11pt; color: #555; }
table { border-collapse: collapse; width: 100%; margin: 8px 0 16px 0; font-size: 9.5pt; }
table, th, td { border: 1px solid #bbb; }
th, td { padding: 4px 8px; text-align: left; }
th { background: #eee; }
code { background: #f3f3f3; padding: 1px 4px; border-radius: 2px; font-family: SFMono-Regular, Menlo, monospace; font-size: 9.5pt; }
strong { color: #000; }
CSS_EOF
)

CSS_FILE=$(mktemp /tmp/bench-attach-css.XXXXXX.css)
echo "$CSS" > "$CSS_FILE"
trap 'rm -f "$CSS_FILE"' EXIT

count=0
for md in "$ATTACH_DIR"/*.md; do
  [ -e "$md" ] || continue
  base="${md%.md}"
  pdf="${base}.pdf"

  # Generate HTML from MD via python-markdown (or fall back to passing
  # raw markdown to weasyprint, which has limited MD parsing).
  html=$(mktemp -t bench-attach).html
  if command -v python3 >/dev/null 2>&1 && python3 -c "import markdown" 2>/dev/null; then
    python3 -c "
import sys, markdown
md_text = open(sys.argv[1]).read()
html = markdown.markdown(md_text, extensions=['tables', 'fenced_code'])
print(f'<html><head><meta charset=\"utf-8\"></head><body>{html}</body></html>')
" "$md" > "$html"
  else
    # Crude fallback — wrap as <pre> so weasyprint at least produces something.
    {
      echo '<html><head><meta charset="utf-8"></head><body><pre>'
      cat "$md"
      echo '</pre></body></html>'
    } > "$html"
  fi

  if weasyprint "$html" "$pdf" --stylesheet "$CSS_FILE" 2>/tmp/weasy-err.$$; then
    echo "✓ $pdf"
    count=$((count + 1))
  else
    echo "! skipped $pdf (weasyprint failed — see /tmp/weasy-err.$$ for details)"
  fi
  rm -f "$html"
done

# Generate a single "chart screenshot" PNG so the attachments folder has
# at least one image artifact for future multimodal question authoring.
if [ -z "${SKIP_MAGICK:-}" ]; then
  CHART_PNG="$ATTACH_DIR/wealth-q4-revenue-chart.png"
  magick -size 720x320 xc:white \
    -font Helvetica -pointsize 16 -fill black \
    -draw "text 30,30 'Acme Industries — Q4 2026 Revenue'" \
    -font Helvetica -pointsize 12 \
    -draw "text 30,60 'Oct  Nov  Dec'" \
    -draw "text 30,90 '\$420k  \$445k  \$385k'" \
    -draw "rectangle 30,120 100,260" \
    -draw "rectangle 130,110 200,260" \
    -draw "rectangle 230,140 300,260" \
    -fill "#888" \
    -draw "rectangle 31,121 99,259" \
    -draw "rectangle 131,111 199,259" \
    -draw "rectangle 231,141 299,259" \
    -fill black \
    -draw "line 30,260 700,260" \
    -draw "text 30,290 'Source: Q4 internal statements (synthetic)'" \
    "$CHART_PNG"
  echo "✓ $CHART_PNG"
fi

echo ""
echo "built $count PDF$([ "$count" != "1" ] && echo 's' || echo '') under $ATTACH_DIR/"
echo "the .md files remain the canonical source the bench runner reads."
