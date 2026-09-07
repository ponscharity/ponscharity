#!/usr/bin/env bash
#
# Back up receipts.json, the ONE piece of state that cannot be rebuilt from the chain.
#
# ⛔⛔ WHY THIS MATTERS MORE THAN IT LOOKS. `totalToCharity` on a distributor is a LIFETIME figure, so
# the amount still owed is that minus what has already been remitted, and that subtrahend lives only
# here. Lose it and every launch reads as never remitted: the next pass bridges the whole lifetime
# figure again, to a charity that has already had it, out of a vault that pools every launch's money.
#
# ⚠ The vault's `Remitted` events record the amount and the request id but NOT which launch it was
# for, so with two launches paired in the same asset the attribution exists nowhere else at all.
#
# ⭐ Copy on CHANGE, not on a schedule. A keeper that has not remitted anything has not changed the
# file, and a hundred identical copies bury the one that matters.
set -euo pipefail

SRC=${SRC:-/root/charity-remit/receipts.json}
DEST=${DEST:-/root/charity-ops/receipts-backups}
KEEP=${KEEP:-60}

[ -f "$SRC" ] || exit 0        # nothing has been remitted yet. Not an error.
mkdir -p "$DEST"

# ⚠ Content addressed, so an unchanged file writes nothing and the newest backup is always the
# newest CHANGE. `shasum` rather than a timestamp comparison: the keeper rewrites the file on every
# pass that bridges, and mtime alone would make identical content look like new state.
SUM=$(shasum -a 256 "$SRC" | cut -c1-12)
LATEST=$(ls -1t "$DEST"/receipts-*.json 2>/dev/null | head -1 || true)
if [ -n "$LATEST" ] && [ "$(shasum -a 256 "$LATEST" | cut -c1-12)" = "$SUM" ]; then
  exit 0
fi

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
cp "$SRC" "$DEST/receipts-$STAMP-$SUM.json"
chmod 600 "$DEST/receipts-$STAMP-$SUM.json"

# ⚠ Pruned by COUNT, never by age. This file changes only when money moves, so a quiet month must
# not expire the only copy of what was remitted before it.
ls -1t "$DEST"/receipts-*.json | tail -n +$((KEEP + 1)) | xargs -r rm -f

echo "backed up receipts.json -> receipts-$STAMP-$SUM.json ($(ls -1 "$DEST"/receipts-*.json | wc -l | tr -d ' ') kept)"
