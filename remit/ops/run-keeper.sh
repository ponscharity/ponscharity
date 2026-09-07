#!/usr/bin/env bash
#
# Run one keeper pass, with `--send` only when there is a key to send with.
#
# ⛔⛔ WHY THIS EXISTS RATHER THAN ALWAYS PASSING --send. The keeper throws when `--send` is given
# without `KEEPER_KEY`, which is the right guard: acting once, wrongly, on somebody else's donation
# is the failure mode that matters, so it refuses rather than half-running. But a timer that fires
# every thirty minutes against an unarmed keeper would then mark the unit FAILED every time, and a
# unit that is permanently red is a unit nobody looks at on the day it goes red for a real reason.
#
# ➤ So arming is the presence of a file, and an unarmed keeper does a clean DRY RUN and exits 0. It
# still reads the chain, still reports what it would move, and still proves the whole path works.
set -euo pipefail
cd /root/charity-remit

if [ -n "${KEEPER_KEY:-}" ]; then
  # ⛔⛔ SHAPE CHECKED BEFORE IT IS USED. `keeper.key.env` is written by hand, and the obvious way to
  # get it wrong is to paste the instruction rather than the key: `KEEPER_KEY=0xYOURKEY` sets the
  # variable, so the wrapper armed itself and every pass then died in viem with a stack trace about
  # a hex string. That reads like the keeper is broken rather than like the key was never filled in.
  # ⚠ Refuses and exits 0, so the unit does not go permanently red over a typo either.
  if ! printf '%s' "$KEEPER_KEY" | grep -qE '^0x[0-9a-fA-F]{64}$'; then
    echo "⛔ KEEPER_KEY is set but is not 0x followed by 64 hex characters."
    echo "   /root/charity-ops/keeper.key.env probably still holds the placeholder."
    echo "   Nothing was signed. Fix the file and the next pass will act."
    exit 0
  fi
  exec /usr/bin/node --experimental-strip-types src/keeper.ts --send
fi

echo "🔒 no KEEPER_KEY: dry run. Nothing will be signed."
exec /usr/bin/node --experimental-strip-types src/keeper.ts
