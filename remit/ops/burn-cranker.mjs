/**
 * Forwards the burn share of $CHARITY's ops income into {@link CharityBurner}, then cranks it.
 *
 * ## ⛔⛔ WHY THIS EXISTS AT ALL, RATHER THAN BEING A CONTRACT
 *
 * `CharityDistributor` holds `charityVault` and `opsVault` as immutables with no setter, and the
 * Pons factory only accepts `transferCreatorFeeRecipient` from the current recipient — which IS the
 * distributor, whose bytecode contains no such call. So the 50/50 cannot be re-cut on chain, and
 * `opsVault` is an EOA, which executes nothing when money lands in it.
 *
 * ➤ Therefore the burn share is a POLICY THIS SCRIPT ENFORCES, not a property of the chain. That
 * distinction is the whole risk profile and must never be described as "automatic on chain":
 * everything downstream of the burner's `receive()` is trustless, everything upstream is us.
 *
 * ## ⛔⛔ ATTRIBUTION IS A COUNTER, NEVER A BALANCE
 *
 * The naive version watches the ops wallet's balance and forwards a cut of any rise. That is wrong
 * in both directions: gas paid from the same wallet makes the balance fall for reasons unrelated to
 * income, and any unrelated deposit — a refund, a transfer, somebody's mistake — would be taxed as
 * though it were fees. The charity keeper has already been burned once by treating an arrival as
 * anything other than an attributed delta.
 *
 * ⭐ So the delta is read from `CharityDistributor.totalToOps(asset)`, a monotonic on-chain total
 * that only a `Released` event can move. Money that did not come from a release is invisible here,
 * which is exactly right.
 *
 * ## ⛔ NO STATE FILE MEANS STOP
 *
 * The high-water mark lives on disk. If it is missing, this REFUSES to run rather than choosing a
 * default, because both defaults are wrong: starting from zero would try to forward a cut of every
 * release since launch, and starting from "now" would silently skip whatever accrued while the file
 * was gone. `--init` is the operator saying which they meant.
 *
 *   node ops/burn-cranker.mjs                 # dry run, the default
 *   node ops/burn-cranker.mjs --send          # armed
 *   node ops/burn-cranker.mjs --init          # set the high-water mark to now, forward nothing
 *
 * ## THE THREE WALLETS
 *
 * | key | wallet | does |
 * |---|---|---|
 * | `OPS_KEY` | `0xc42c1009…2A22` | forwards the burn share out of ops. Keeps the 10%. |
 * | `BURN_WALLET_KEY` | `0xB97F2573…9291f` | receives the 40%, pushes it in, signs every burn. |
 * | `KEEPER_KEY` | the keeper | `router-cranker.mjs`, the LAUNCH buy-backs. Not used here. |
 *
 * ⭐ To change the split: `BURN_SHARE_BPS` (8000 = 40% of total). To stop it: `BURN_ENABLED=0`.
 *
 * ⛔⛔ Three separate wallets is a requirement, not tidiness: two senders on one nonce produce a
 * replacement transaction rather than two transactions, so one unit silently does nothing. The
 * launch buy-backs and this must never be able to collide.
 */
import { createPublicClient, createWalletClient, http, parseAbi, formatEther, formatUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

const RPC = process.env.RHC_RPC ?? 'https://rpc.mainnet.chain.robinhood.com'
const NATIVE = '0x0000000000000000000000000000000000000000'

const TOKEN = '0x030FA758daD53f0D6e23cfD3a8Fe7bC7B54E5Ac9'
const DISTRIBUTOR = '0xB4308041D846761F7cdB6579522C8B5A1dEd133a'
const BURNER = process.env.CHARITY_BURNER
const STATE = process.env.BURN_STATE ?? '/var/lib/charity/burn-state.json'

/**
 * ⭐⭐ THE SPLIT — 50 / 40 / 10, AND THE ONE NUMBER YOU CHANGE TO MOVE IT
 *
 * ```
 *   50%  charity        ⛔ immutable, set on chain at launch, untouchable by anything here
 *   40%  buy back+burn  → BURN_WALLET, then the burner contract
 *   10%  yours          stays in opsVault
 * ```
 *
 * ⛔⛔ `BURN_SHARE_BPS` IS A CUT OF WHAT REACHES OPS, NOT OF THE TOTAL. Charity already took its
 * half, so the ops wallet only ever sees 50% of fees — and burning 40% of the TOTAL therefore means
 * taking **80% of each arrival**. Setting this to 4000 would burn 20% of total, not 40%. The
 * mapping is: `BURN_SHARE_BPS = share_of_total × 2`.
 *
 * | you want burned | BURN_SHARE_BPS | you keep |
 * |---|---|---|
 * | 20% of total | 4000 | 30% |
 * | 30% of total | 6000 | 20% |
 * | **40% of total** | **8000** | **10%** |
 * | 50% of total | 10000 | 0% |
 *
 * ⛔ Above 10000 is refused: it would try to forward money that belongs to charity's side and the
 * wallet simply does not have it.
 */
const BURN_SHARE_BPS = BigInt(process.env.BURN_SHARE_BPS ?? 8000)

/**
 * ⭐⭐ THE OFF SWITCH. `BURN_ENABLED=0` stops the forward and the buy dead, with no redeploy and no
 * contract change — the timer keeps running and keeps reporting, it just moves nothing.
 *
 * ⚠ Turning it off does NOT strand anything: the high-water mark stops advancing, so whatever
 * accrued while it was off is simply picked up on the first pass after it comes back. Set it in
 * `/root/charity-ops/burn.key.env` and the next pass honours it.
 *
 * ⛔ It does NOT stop `burnHeld` on money ALREADY inside the burner contract. Once ETH is in there
 * it can only ever be spent on a burn — that is the contract's whole guarantee and no env var can
 * reach it. Off means "stop sending more", not "give it back".
 */
const BURN_ENABLED = (process.env.BURN_ENABLED ?? '1') !== '0'

/** How far below the simulated fill a burn will still accept — the quote-to-block gap, not an
    appetite for slippage. */
const SLIPPAGE_BPS = 50n

/**
 * ⛔⛔ NEVER FORWARD THE OPS WALLET TO ZERO. `~/sweep` has drained an operator wallet twice on this
 * stack, and a keeper that leaves its own signer unable to pay gas has broken the thing it exists
 * to run. Held back from every forward, unconditionally.
 */
const GAS_FLOOR = BigInt(process.env.OPS_GAS_FLOOR ?? 3_000_000_000_000_000n) // 0.003 ETH

/**
 * ⛔⛔ HELD BACK IN THE BURN WALLET ON EVERY PUSH. A wallet swept to zero cannot pay for the very
 * burn it is trying to run, and `~/sweep` has stranded two operator wallets on this stack exactly
 * that way. A burn cycle costs ~0.0003 ETH here, so this is roughly ten passes of headroom.
 */
const CRANK_GAS_RESERVE = BigInt(process.env.CRANK_GAS_RESERVE ?? 3_000_000_000_000_000n) // 0.003 ETH

/* ⚠ Cloudflare fronts this RPC and blocks a default node agent. @see rhc-cloudflare-blocks-foundry */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36'
const transport = http(RPC, { fetchOptions: { headers: { 'user-agent': UA } }, retryCount: 4 })
const rhc = {
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
}
const pub = createPublicClient({ chain: rhc, transport })

const DIST = parseAbi([
  'function totalToOps(address asset) view returns (uint256)',
  'function opsVault() view returns (address)',
  'function pending(address asset) view returns (uint256)',
])
const BURN = parseAbi([
  'function pending() view returns (uint256 pairHeld, uint256 tokensHeld)',
  'function totalBurned() view returns (uint256)',
  'function totalPairSpent() view returns (uint256)',
  'function buyAndBurn(uint256 minTokensOut) returns (uint256 bought, uint256 burned)',
  'function burnHeld() returns (uint256 burned)',
  'function token() view returns (address)',
])

/**
 * How far the high-water mark may advance after forwarding `forwarded` of the cut owed on
 * `arrived`.
 *
 * ⛔⛔ PURE, EXPORTED AND TESTED ON PURPOSE. This is the one calculation that decides whether an
 * arrival gets taxed once, twice or never, and it used to be four lines buried at the bottom of a
 * 400-line pass where nothing could reach it. @see test/burnMark.test.mjs
 *
 * ⭐ A short pass advances only by the slice it actually paid, so the remainder stays owed and is
 * charged to the next income rather than written off.
 */
export function markAfter(last, arrived, forwarded, bps) {
  if (arrived <= 0n || forwarded <= 0n) return last
  const covered = (forwarded * 10_000n) / bps
  return last + (covered > arrived ? arrived : covered)
}

const readState = () => JSON.parse(readFileSync(STATE, 'utf8'))
const writeState = (s) => {
  mkdirSync(dirname(STATE), { recursive: true })
  writeFileSync(STATE, `${JSON.stringify(s, null, 2)}\n`)
}

async function main() {
  if (!BURNER) throw new Error('CHARITY_BURNER is not set')

  /* ⛔ The burner is single-purpose and immutable, but a mis-set env var pointing at some other
     contract would send real money to it. Cheap to check, and the failure it prevents is total. */
  const wired = await pub.readContract({ address: BURNER, abi: BURN, functionName: 'token' })
  if (wired.toLowerCase() !== TOKEN.toLowerCase()) {
    throw new Error(`CHARITY_BURNER ${BURNER} burns ${wired}, not $CHARITY`)
  }

  const ops = await pub.readContract({ address: DISTRIBUTOR, abi: DIST, functionName: 'opsVault' })
  const totalToOps = await pub.readContract({
    address: DISTRIBUTOR, abi: DIST, functionName: 'totalToOps', args: [NATIVE],
  })

  if (process.argv.includes('--init')) {
    writeState({ lastTotalToOps: totalToOps.toString(), initialisedAt: new Date().toISOString() })
    console.log(`high-water mark set to ${formatEther(totalToOps)} ETH · nothing forwarded`)
    return
  }

  if (!existsSync(STATE)) {
    /* ⛔ See the header. Neither default is safe, so this is a hard stop with the fix printed. */
    console.error(`⛔ no state at ${STATE} — refusing to guess the high-water mark.`)
    console.error('   run once with --init to start from now, or write the file by hand.')
    process.exit(1)
  }

  const state = readState()
  const last = BigInt(state.lastTotalToOps)

  /* ⚠ A monotonic counter that went DOWN means this is not the contract we think it is, or the
     state file belongs to a different deployment. Either way, stop. */
  if (totalToOps < last) {
    console.error(`⛔ totalToOps went backwards (${last} → ${totalToOps}). Wrong state file?`)
    process.exit(1)
  }

  const arrived = totalToOps - last

  /* ── TWO SIGNERS, AND THE WALLET IS THE MIDDLE STOP ────────────────────────────────────────
     ⭐⭐ The forward can only come from `opsVault`, because that is where the fees land. From there
     the burn share goes to BURN_WALLET — your wallet — and the burn is then run FROM that wallet.
     So the 40% is visibly yours, in your wallet, on its way to being destroyed.

     ⛔⛔ AND IT KEEPS THE LAUNCH BUY-BACKS OUT OF THE WAY. `router-cranker.mjs` signs with
     KEEPER_KEY; the forward here signs as ops; the burn signs as BURN_WALLET. Three wallets, so no
     two units can ever collide on a nonce — two senders on one nonce is a REPLACEMENT transaction,
     not two transactions, and one of them silently does nothing.

     ## ⚠⚠ WHAT THE MIDDLE STOP COSTS, STATED PLAINLY

     While the share sits in BURN_WALLET it is ordinary money in an ordinary wallet: whoever holds
     that key can spend it on anything. "40% is bought back and burned" is a PROMISE for that window,
     not a property of the chain. It only becomes unbreakable once the money is inside the burner
     contract, which has no owner and no withdraw. ➤ So this pass moves it straight through — in and
     out in the same run — and the window is one pass wide, not one payout wide. */
  const BURN_WALLET = process.env.BURN_WALLET ?? '0xB97F2573E06886C0210676a536fe11b0BAB9291f'

  const opsKey = process.env.OPS_KEY
  const burnKey = process.env.BURN_WALLET_KEY

  const opsAccount = opsKey ? privateKeyToAccount(opsKey) : null
  const burnAccount = burnKey ? privateKeyToAccount(burnKey) : null

  if (opsAccount && opsAccount.address.toLowerCase() !== ops.toLowerCase()) {
    throw new Error(`OPS_KEY is ${opsAccount.address}, but the distributor pays ${ops}`)
  }
  /* ⛔ A key that is not the wallet we published as the burn wallet means the env is wired to
     something else. Cheap to check; the alternative is the burn share going somewhere unannounced. */
  if (burnAccount && burnAccount.address.toLowerCase() !== BURN_WALLET.toLowerCase()) {
    throw new Error(`BURN_WALLET_KEY is ${burnAccount.address}, expected ${BURN_WALLET}`)
  }

  const opsWallet = opsAccount ? createWalletClient({ account: opsAccount, chain: rhc, transport }) : null
  const burnWallet = burnAccount ? createWalletClient({ account: burnAccount, chain: rhc, transport }) : null

  /* ⚠ A dry run is the DEFAULT and exits 0 — a timer firing against an unarmed box must not paint
     the unit permanently red, or nobody looks at it on the day it goes red for a real reason.
     ⚠ Each leg arms independently: a box with only the burn key still burns what is already in the
     wallet, and a box with only the ops key still forwards. */
  const armed = process.argv.includes('--send')

  /* ⛔⛔ THREE FLAGS, AND THE LINE BETWEEN THEM IS REVERSIBILITY.
     `sendForward` and `sendPush` move money that is still ours — ops → wallet → contract — and BOTH
     must obey the off switch, because both are still undoable while the money sits in a wallet.
     `sendBurn` acts on money ALREADY INSIDE the contract, which has no owner and no withdraw: that
     money can only ever become a burn, so refusing to finish would strand it, not protect it.
     ⚠ The first draft gated only the forward. With BURN_ENABLED=0 the pass would still have pushed
     the wallet's balance into the burner — committing it for good while reporting "forwarding OFF". */
  const sendForward = armed && Boolean(opsAccount) && BURN_ENABLED
  const sendPush = armed && Boolean(burnAccount) && BURN_ENABLED
  const sendBurn = armed && Boolean(burnAccount)

  const pct = (bps) => `${Number(bps) / 200}% of total`
  console.log(`$CHARITY burn · ${armed ? 'ARMED' : 'dry run'}${BURN_ENABLED ? '' : ' · ⛔ BURN_ENABLED=0, forwarding OFF'}`)
  console.log(`split    : 50% charity · ${pct(BURN_SHARE_BPS)} burned · ${pct(10000n - BURN_SHARE_BPS)} kept`)
  console.log(`ops      : ${ops}${opsAccount ? ' (armed)' : ' — no OPS_KEY, read only'}`)
  console.log(`burn wlt : ${BURN_WALLET}${burnAccount ? ' (armed)' : ' — no key, read only'}`)
  console.log(`burner   : ${BURNER}`)
  console.log(`released to ops, lifetime : ${formatEther(totalToOps)} ETH`)
  console.log(`new since last pass       : ${formatEther(arrived)} ETH`)

  /* ⛔⛔ THE ONE CONFIGURATION THAT LOSES THE THREAD SILENTLY.
     With OPS_KEY but no BURN_WALLET_KEY, leg 1 arms and legs 2-4 do not: every pass moves the burn
     share into the wallet and NOTHING EVER BURNS IT. The mark keeps advancing, so it reads as a
     healthy pass while the pile grows and the site's burn figure stays at zero. That is the exact
     shape this repo keeps rediscovering, so it is called out rather than left to be noticed.
     ⚠ Not fatal: money in the wallet is still yours and a later pass with the key put through will
     sweep the whole balance in. But nobody should discover this from a balance. */
  if (opsAccount && !burnAccount && armed) {
    console.log('⛔⛔ OPS_KEY is set but BURN_WALLET_KEY is NOT — the share will be moved to the')
    console.log('    burn wallet and then sit there unburned. Add the key, or unset OPS_KEY.')
  }

  if (BURN_SHARE_BPS > 10_000n) {
    throw new Error(`BURN_SHARE_BPS ${BURN_SHARE_BPS} exceeds the ops half — charity's 50% is not ours to forward`)
  }

  /* ── 1. ops → YOUR WALLET, the burn share ──────────────────────────────────────────────────── */
  let forwarded = 0n
  if (!BURN_ENABLED) {
    console.log('⛔ BURN_ENABLED=0 — not forwarding. The mark stays put, so nothing is lost.')
  } else if (arrived > 0n) {
    const want = (arrived * BURN_SHARE_BPS) / 10_000n
    const balance = await pub.getBalance({ address: ops })
    const spendable = balance > GAS_FLOOR ? balance - GAS_FLOOR : 0n

    /* ⚠ Forwards the SHORTFALL-ADJUSTED amount and advances the mark only by what was actually
       covered, so a pass that could not afford the full cut retries the remainder next time
       instead of losing it. ⛔ It can only ever take a cut of what is STILL IN THE WALLET — money
       already spent elsewhere is gone and no later pass can reclaim it. */
    forwarded = want < spendable ? want : spendable
    if (forwarded < want) {
      console.log(`⚠ short: want ${formatEther(want)}, gas floor leaves ${formatEther(spendable)}`)
    }

    if (forwarded > 0n && sendForward) {
      const hash = await opsWallet.sendTransaction({ to: BURN_WALLET, value: forwarded })
      const receipt = await pub.waitForTransactionReceipt({ hash })
      /* ⛔ `status` CHECKED. A receipt resolving is not a transaction succeeding — that assumption
         froze every donation for two days on 4 Sep. */
      if (receipt.status !== 'success') {
        console.error('⚠ forward REVERTED — mark not advanced, will retry next pass')
        process.exit(1)
      }
      console.log(`forwarded ${formatEther(forwarded)} ETH to ${BURN_WALLET}`)

      /* ⛔⛔ THE MARK ADVANCES HERE, NOT AT THE END OF THE PASS, AND THE REASON IS A DOUBLE CHARGE.
         Once this transfer is mined the ops side is settled: the share is out of the ops wallet and
         in the burn wallet, and every step below acts on money that is already committed — the next
         pass pushes the burn wallet's WHOLE spendable balance in regardless of what the mark says.
         ⚠ So a throw below (this RPC is Cloudflare-fronted and answers 429 under load — seen 7 Sep)
         used to leave the mark stale, and the next pass would forward a SECOND 80% of the same
         arrival out of ops. Nothing was lost to the burn, but ops was taxed twice and the 10% share
         quietly went to zero. Writing it here closes that window; the earlier ordering was defending
         against the opposite failure, which the burn wallet's push already covers. */
      writeState({ ...state, lastTotalToOps: markAfter(last, arrived, forwarded, BURN_SHARE_BPS).toString(), lastPass: new Date().toISOString() })
      console.log(`mark advanced to ${formatEther(markAfter(last, arrived, forwarded, BURN_SHARE_BPS))} ETH`)
    } else {
      console.log(`would forward ${formatEther(forwarded)} ETH (${pct(BURN_SHARE_BPS)})`)
    }
  }

  /* ── 2. YOUR WALLET → the burner contract ──────────────────────────────────────────────────
     ⭐⭐ THE STEP THAT MAKES THE PROMISE BINDING. Until this lands the share is spendable money in
     a wallet; after it, it is inside a contract with no owner and no withdraw, and the only thing
     that can ever happen to it is a buy-and-burn.

     ⚠ Keeps a gas reserve behind. A wallet swept to zero cannot pay for the very burn it is trying
     to run, and `~/sweep` has already stranded two operator wallets on this stack exactly that way.

     ⛔ Pushes the WHOLE spendable balance, not just what this pass forwarded. Anything you send to
     this wallet by hand is treated as burn money too, which is what makes a manual top-up work with
     no extra tooling. ➤ Do not use this wallet for anything else. */
  const walletBalance = await pub.getBalance({ address: BURN_WALLET })
  const toBurner = walletBalance > CRANK_GAS_RESERVE ? walletBalance - CRANK_GAS_RESERVE : 0n

  if (walletBalance <= CRANK_GAS_RESERVE && walletBalance > 0n) {
    console.log(`⚠ burn wallet holds ${formatEther(walletBalance)} ETH, under the ${formatEther(CRANK_GAS_RESERVE)} gas reserve — top it up`)
  }
  if (toBurner > 0n && !BURN_ENABLED) {
    console.log(`⛔ BURN_ENABLED=0 — holding ${formatEther(toBurner)} ETH in the wallet, not pushing it in`)
  } else if (toBurner > 0n) {
    if (sendPush) {
      const hash = await burnWallet.sendTransaction({ to: BURNER, value: toBurner })
      const receipt = await pub.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') {
        console.error('⚠ push to the burner REVERTED — the share is still in the wallet')
        process.exit(1)
      }
      console.log(`pushed ${formatEther(toBurner)} ETH into the burner`)
    } else {
      console.log(`would push ${formatEther(toBurner)} ETH into the burner`)
    }
  }

  /* ── 3. burn any $CHARITY sitting in the burner, no swap needed ─────────────────────────────
     ⭐ Pons pays fees in BOTH sides of the pair. The token side is already what we want to destroy;
     routing it through a buy would pay slippage to end up holding what we held.
     ⚠ Runs even when BURN_ENABLED=0: money already inside the contract can only ever be burned, so
     refusing to finish the job would strand it, not protect it. */
  const [, tokensHeld] = await pub.readContract({ address: BURNER, abi: BURN, functionName: 'pending' })
  if (tokensHeld > 0n) {
    if (sendBurn) {
      const { request } = await pub.simulateContract({
        address: BURNER, abi: BURN, functionName: 'burnHeld', account: burnAccount,
      })
      const receipt = await pub.waitForTransactionReceipt({ hash: await burnWallet.writeContract(request) })
      console.log(receipt.status === 'success'
        ? `burned ${formatUnits(tokensHeld, 18)} CHARITY directly`
        : '⚠ burnHeld REVERTED')
    } else {
      console.log(`would burn ${formatUnits(tokensHeld, 18)} CHARITY directly (no swap)`)
    }
  }

  /* ── 4. buy and burn whatever ETH the burner now holds ──────────────────────────────────────
     ⛔⛔ SIMULATED FIRST, ALWAYS. A standing, permissionless, scheduled buy is the single most
     sandwichable shape there is, and the contract rejects a zero floor outright. */
  const [pairHeld] = await pub.readContract({ address: BURNER, abi: BURN, functionName: 'pending' })
  if (pairHeld === 0n) {
    console.log('burner holds no ETH — nothing to buy')
  } else {
    /* ⚠ Simulated as the BURN WALLET even on a dry run, so the quote reflects the sender that will
       actually run it. `account` is a hint to the node, not a signature — no key is needed to
       simulate, which is why a read-only box still reports a real quote. */
    const { result } = await pub.simulateContract({
      address: BURNER, abi: BURN, functionName: 'buyAndBurn', args: [1n], account: BURN_WALLET,
    })
    const quoted = result[0]
    const floor = (quoted * (10_000n - SLIPPAGE_BPS)) / 10_000n
    console.log(`quote: ${formatEther(pairHeld)} ETH → ${formatUnits(quoted, 18)} CHARITY`)

    if (sendBurn) {
      const { request } = await pub.simulateContract({
        address: BURNER, abi: BURN, functionName: 'buyAndBurn', args: [floor], account: burnAccount,
      })
      const receipt = await pub.waitForTransactionReceipt({ hash: await burnWallet.writeContract(request) })
      console.log(receipt.status === 'success'
        ? `bought and burned ~${formatUnits(quoted, 18)} CHARITY`
        : '⚠ buyAndBurn REVERTED')
    } else {
      console.log(`would buy and burn, floor ${formatUnits(floor, 18)} CHARITY`)
    }
  }

  /* ── 5. record that a pass ran ──────────────────────────────────────────────────────────────
     ⛔ THIS MUST NEVER MOVE THE MARK — that happens the instant the forward is mined, above. A pass
     that forwarded nothing (short wallet, burning disabled, nothing new) still stamps `lastPass`, so
     a stalled timer is visible as a stale timestamp rather than being mistaken for a quiet chain. */
  if (armed && forwarded === 0n) {
    writeState({ ...state, lastTotalToOps: last.toString(), lastPass: new Date().toISOString() })
  }

  const burned = await pub.readContract({ address: BURNER, abi: BURN, functionName: 'totalBurned' })
  console.log(`lifetime burned: ${formatUnits(burned, 18)} CHARITY`)
}

/**
 * ⛔⛔ RUN ONLY WHEN EXECUTED, NEVER ON IMPORT. Without this guard, `import`ing this file to reach
 * one pure helper SIGNS A LIVE PASS as a side effect — which is exactly what happened the first
 * time a test tried to load `markAfter`. A module that moves money on import cannot be tested, and
 * anything that reaches for one of its functions is one autocomplete away from a real transfer.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
