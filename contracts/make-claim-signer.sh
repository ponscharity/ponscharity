#!/usr/bin/env bash
#
# Create the voucher signer, which is the ONE key the API box holds.
#
# ## ⭐ WHAT THIS KEY CAN AND CANNOT DO
#
# It signs EIP-712 vouchers and nothing else. It cannot move money, cannot withdraw, cannot change
# where a voucher pays, and holds no balance — so it never needs funding. The worst a stolen signer
# can do is sign vouchers for money that is genuinely owed, up to what the claims contract holds,
# and the owner answers that by PAUSING and rotating the signer in one transaction.
#
# ⛔⛔ THE OWNER KEY MUST NOT LIVE ON THE SAME BOX. Pausing is the answer to a compromised signer; a
# box that holds both answers nothing.
#
# ⚠ The key is written 0600 and NEVER printed. `cast wallet new` writes it to stdout, which on this
# machine means it lands in ~/.zsh_history as loose hex — that is exactly how a key here became
# reachable to a sweep tool once already.
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"

DIR="$HOME/.charity-deployer"
OUT="$DIR/claim-signer.key"
mkdir -p "$DIR"
chmod 700 "$DIR"

[[ -f "$OUT" ]] && { echo "FATAL: $OUT already exists. Refusing to overwrite a signer." >&2; exit 1; }

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
cast wallet new --json > "$TMP"

python3 - "$TMP" "$OUT" <<'PY'
import json, os, sys
w = json.load(open(sys.argv[1]))[0]
# ⚠ Key to a 0600 file, address to stdout. The two must never swap places.
fd = os.open(sys.argv[2], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as f:
    f.write(w['private_key'] + '\n')
open(sys.argv[2].replace('.key', '.address'), 'w').write(w['address'] + '\n')
print(w['address'])
PY

echo
echo "  key      $OUT  (0600, never printed)"
echo "  address  $(cat "${OUT%.key}.address")"
echo
echo "  ⛔ Put ONLY this on the API box:"
echo "     printf 'CLAIM_SIGNER_KEY=%s\\n' \"\$(cat $OUT)\" | ssh <box> 'cat > /root/charity-ops/claims.key.env'"
echo "     ssh <box> 'chmod 600 /root/charity-ops/claims.key.env'"
