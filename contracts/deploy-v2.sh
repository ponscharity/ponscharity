#!/usr/bin/env bash
#
# Deploy the V2 stack: the claims contract, the router factory, and the launchpad that uses both.
#
# ⛔⛔ THE CONSTRUCTOR ARGUMENTS ARE IMMUTABLE. `minCharityBps` and `claims` in particular can never
# be changed once this is on chain — a wrong value means redeploying and repointing the site.
#
# ⛔⛔ THIS DOES NOT TOUCH V1. The 182 launches already made point at the V1 launchpad and their own
# V1 distributors, immutably. Nothing here migrates them and nothing here can break them.
#
# ⚠ Runs through the loopback proxy because Cloudflare 403s Foundry's User-Agent and forge has no
# way to send a header. See scripts/rpc-proxy.mjs.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

KEYDIR="$HOME/.charity-deployer"
KEYFILE="$KEYDIR/deployer.key"
[[ -f "$KEYFILE" ]] || { echo "FATAL: no deployer key at $KEYFILE" >&2; exit 1; }
DEPLOYER=$(cat "$KEYDIR/deployer.address")

# ⛔ Who may PAUSE claiming and rotate the signer. It cannot take money that is owed — `sweepStray`
# refuses anything below the outstanding line — but a stolen signer key is answered by pausing, so
# this key must NOT live on the same box as the signer.
CLAIMS_OWNER="${CLAIMS_OWNER:?set CLAIMS_OWNER to the address that may pause claiming}"
# ⭐ Signs vouchers and NOTHING else. It holds no funds, cannot move money and cannot change where a
# voucher pays. This is the one key that lives on the API box.
# ⛔⛔ NO APOSTROPHE IN THESE MESSAGES. An `'` inside `${VAR:?msg}` makes bash fail to parse the
# WHOLE FILE, and it reports the error at an unrelated line far below — this script was written with
# "the voucher signer's address" here and bash blamed a python one-liner thirty lines away.
CLAIM_SIGNER="${CLAIM_SIGNER:?set CLAIM_SIGNER to the address that signs vouchers}"

FACTORY=0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e
POOL_MANAGER=0x8366a39CC670B4001A1121B8F6A443A643e40951
USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
MAX_SELL_SLIPPAGE_BPS="${MAX_SELL_SLIPPAGE_BPS:-200}"
MIN_CHARITY_BPS="${MIN_CHARITY_BPS:-5000}"

RPC=http://127.0.0.1:8899
export PATH="$HOME/.foundry/bin:$PATH"

STARTED_PROXY=0
if ! curl -s -m 3 -o /dev/null "$RPC" -X POST -H 'content-type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'; then
  node scripts/rpc-proxy.mjs >/tmp/charity-proxy.log 2>&1 &
  STARTED_PROXY=$!
  sleep 2
fi
cleanup() { [[ "$STARTED_PROXY" != 0 ]] && kill "$STARTED_PROXY" 2>/dev/null || true; }
trap cleanup EXIT

echo "deployer      $DEPLOYER"
echo "balance       $(cast balance "$DEPLOYER" --rpc-url "$RPC" --ether) ETH"
echo "claims owner  $CLAIMS_OWNER"
echo "claim signer  $CLAIM_SIGNER"
echo

# ⛔ `--json` goes BEFORE `--constructor-args`. After it, forge consumes the flag as a constructor
# argument and the output is not JSON — a trap this repo has hit before.
# ⚠ 2>/dev/null because forge writes compilation progress to stderr and it lands in the capture.
mk() {
  forge create --rpc-url "$RPC" --private-key "$(cat "$KEYFILE")" --broadcast --json "$@" 2>/dev/null \
    | python3 -c "import sys,json;print(json.load(sys.stdin)['deployedTo'])"
}

echo "==> CharityFeeClaims"
# ⛔⛔ THE ORDER IS (owner, signer) AND IT WAS WRONG HERE ONCE. Both are addresses, so a swap
# compiles, deploys and verifies without complaint — and produces a contract whose OWNER key lives
# on the API box and whose SIGNER is a key nobody there holds. Every voucher then fails to verify
# and the one safeguard (pausing from a separate machine) is gone. Read the constructor, not this
# line, if you ever touch it: `constructor(address owner_, address signer_)`.
CLAIMS=$(mk src/CharityFeeClaims.sol:CharityFeeClaims --constructor-args "$CLAIMS_OWNER" "$CLAIM_SIGNER")
echo "    $CLAIMS"

# ⛔ READ BACK AND REFUSE TO CONTINUE IF THEY ARE THE WRONG WAY ROUND. A deploy that silently swaps
# two addresses is worth exactly one extra RPC call to catch.
GOT_OWNER=$(cast call "$CLAIMS" "owner()(address)" --rpc-url "$RPC")
GOT_SIGNER=$(cast call "$CLAIMS" "signer()(address)" --rpc-url "$RPC")
# ⚠ `tr`, not `${var,,}` — macOS ships bash 3.2, where that expansion is a syntax error and would
# take the whole script down at parse time rather than failing here.
lower() { printf '%s' "$1" | tr 'A-F' 'a-f'; }
if [[ "$(lower "$GOT_OWNER")" != "$(lower "$CLAIMS_OWNER")" || "$(lower "$GOT_SIGNER")" != "$(lower "$CLAIM_SIGNER")" ]]; then
  echo "FATAL: claims deployed with owner=$GOT_OWNER signer=$GOT_SIGNER" >&2
  echo "       expected owner=$CLAIMS_OWNER signer=$CLAIM_SIGNER" >&2
  echo "       NOT continuing to the launchpad, which would pin this contract immutably." >&2
  exit 1
fi
echo "    owner and signer verified on chain"

# ⛔⛔ A SEPARATE CONTRACT FOR A MEASURED REASON. Inlining `new CreatorRouter` put the launchpad at
# 29,206 bytes against EIP-170's 24,576 and it could not be deployed at all. Behind this factory it
# is 18,277. See CreatorRouterFactory.sol.
echo "==> CreatorRouterFactory"
ROUTERS=$(mk src/CreatorRouterFactory.sol:CreatorRouterFactory)
echo "    $ROUTERS"

echo "==> CharityLaunchpadV2"
PAD=$(mk src/CharityLaunchpadV2.sol:CharityLaunchpadV2 --constructor-args \
  "$FACTORY" "$POOL_MANAGER" "$USDG" "$MAX_SELL_SLIPPAGE_BPS" "$MIN_CHARITY_BPS" "$CLAIMS" "$ROUTERS")
echo "    $PAD"

# ⛔ Written to a file rather than printed only. Every one of these has to reach three other places
# — the keeper's env, the API's env and the front end's build — and re-reading them off a terminal
# scroll is how one of them ends up pointing at the wrong contract.
cat >> ../REMIT_ADDRESSES <<EOF

# ── V2, deployed $(date -u +%Y-%m-%dT%H:%M:%SZ) ────────────────────────────────
# ⛔ V1 above is NOT superseded: the 182 launches made before this point at it immutably.
CHARITY_FEE_CLAIMS_RHC=$CLAIMS
CREATOR_ROUTER_FACTORY_RHC=$ROUTERS
CHARITY_LAUNCHPAD_V2_RHC=$PAD
EOF

echo
echo "==> written to ../REMIT_ADDRESSES"
echo "    next: set CLAIMS_ADDRESS + LAUNCHPAD_V2 + CLAIM_SIGNER_KEY in the API env,"
echo "          LAUNCHPAD_V2 in the keeper env, and VITE_LAUNCHPAD_V2 in the web build."
