#!/usr/bin/env bash
#
# Render the social card. ⛔ REGENERATE THIS WHENEVER THE BRAND MOVES: an og image is the one asset
# nobody looks at after shipping, and it is the first thing anybody outside sees. The card shipped
# for weeks showing a tagline the site had dropped, a 50/50 split that was never the default, and a
# background texture that had been removed.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
OUT="$HERE/../../public/og.png"

"$CHROME" --headless --disable-gpu --hide-scrollbars \
  --window-size=1200,630 --screenshot="$OUT" \
  --default-background-color=00000000 \
  --virtual-time-budget=6000 \
  "file://$HERE/card.html" >/dev/null 2>&1

[ -f "$OUT" ] || { echo "FATAL: no image was written" >&2; exit 1; }
SIZE=$(sips -g pixelWidth -g pixelHeight "$OUT" 2>/dev/null | awk '/pixel/{print $2}' | paste -sd'x' -)
echo "wrote $OUT  ($SIZE, $(wc -c < "$OUT") bytes)"
[ "$SIZE" = "1200x630" ] || echo "⚠ expected 1200x630 — scrapers crop anything else"

# ⛔⛔ BUMP THE ?v= IN index.html AFTER REGENERATING. X caches a card and replacing the bytes at the
# same URL does not reliably refresh it, so a new card at an old URL is a card nobody sees.
echo
echo "  next: bump the ?v= on og:image and twitter:image in web/index.html, then ./deploy.sh"
grep -o 'og\.png?v=[0-9]*' ../../index.html | head -1 | sed 's/^/  currently: /'
