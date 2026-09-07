/**
 * Makes a {@link CreatorRouter} actually do the thing the launch promised.
 *
 * ## ⛔⛔ WITHOUT THIS, NONE OF IT MOVES — AND EVERYTHING STILL LOOKS FINE
 *
 * `distribute` and `buyAndBurn` are permissionless by design: no key of ours can steer them, and
 * anybody at all may call them. That is the security property, and it is also the trap — a function
 * anybody CAN call is a function nobody DOES call. Left uncranked:
 *
 *   - the creator's fees pile up in the router, split by nobody;
 *   - the burn never happens, so a launch that advertised "buy back & burn" never burns;
 *   - and the account share never reaches `CharityFeeClaims`, so `claimable` reads zero and the
 *     person it was promised to signs in, sees nothing, and concludes they were not paid.
 *
 * Every one of those failures is silent. Nothing reverts, no alarm fires, and the money is visibly
 * sitting in a contract whose page says it does something else.
 *
 * ## ⚠ Deliberately NOT part of the donation keeper
 *
 * That keeper is the live path that moves real money to charities every fifteen minutes, and it has
 * been broken twice this month by changes made in good faith. This is a separate unit with its own
 * timer: a crash here delays a burn and cannot delay a donation.
 *
 * ⛔ It signs with the SAME key as the keeper, so the two must never run at once — two senders on
 * one nonce is a replacement transaction, not two transactions. The timer is offset for that reason;
 * see `charity-routercrank.timer`.
 *
 * ## ⛔⛔ THE BURN IS SIMULATED FIRST, ALWAYS
 *
 * `minTokensOut` of zero is not "no limit", it is "any fill is acceptable" — and this is a standing,
 * permissionless, scheduled buy, which is the single most sandwichable shape there is. Every burn
 * here quotes itself by simulation and then floors that quote.
 */
import {
  createPublicClient, createWalletClient, http, parseAbi, formatUnits,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const RPC = process.env.RHC_RPC ?? 'https://rpc.mainnet.chain.robinhood.com'
const LAUNCHPAD = process.env.LAUNCHPAD_V2 ?? process.env.LAUNCHPAD
const NATIVE = '0x0000000000000000000000000000000000000000'

/** How far below the simulated fill a burn will still accept. ⚠ Tight, because it is quoted a
    block earlier — this is the gap between the quote and the block, not a risk appetite. */
const SLIPPAGE_BPS = 50n

/* ⚠ Cloudflare fronts this RPC and blocks a default node agent. @see rhc-cloudflare-blocks-foundry */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36'
const transport = http(RPC, { fetchOptions: { headers: { 'user-agent': UA } }, retryCount: 4 })
const rhc = {
  id: 4663, name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
}
const pub = createPublicClient({ chain: rhc, transport })

const PAD = parseAbi([
  'struct Entry { address token; address curve; address distributor; address charity; address creator; address pairToken; uint16 charityBps; uint64 launchedAt; bytes32 charityId; }',
  'function count() view returns (uint256)',
  'function page(uint256 offset, uint256 limit) view returns (Entry[])',
])
const DIST = parseAbi(['function opsVault() view returns (address)'])
const ROUTER = parseAbi([
  'struct Split { uint8 mode; uint16 bps; address wallet; bytes32 beneficiary; uint8 provider; uint256 accountId; }',
  'function splits() view returns (Split[])',
  'function pairToken() view returns (address)',
  'function burnReserve(address asset) view returns (uint256)',
  'function initialized() view returns (bool)',
  'function distribute(address asset) returns (uint256)',
  'function buyAndBurn(uint256 minTokensOut) returns (uint256 bought, uint256 burned)',
  'function buyAndBurnOnPool(uint256 minTokensOut) returns (uint256 bought, uint256 burned)',
])
const CURVE = parseAbi(['function graduated() view returns (bool)'])
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)'])

const MODE_BURN = 2

const balanceOf = (asset, who) =>
  asset === NATIVE
    ? pub.getBalance({ address: who })
    : pub.readContract({ address: asset, abi: ERC20, functionName: 'balanceOf', args: [who] })

async function main() {
  if (!LAUNCHPAD) throw new Error('LAUNCHPAD_V2 is not set')

  const key = process.env.KEEPER_KEY
  /* ⚠ A dry run is the DEFAULT and exits 0. A timer firing against an unarmed box would otherwise
     mark the unit failed every time, and a unit that is permanently red is one nobody looks at on
     the day it goes red for a real reason. */
  const send = Boolean(key) && process.argv.includes('--send')
  const account = key ? privateKeyToAccount(key) : null
  const wallet = account ? createWalletClient({ account, chain: rhc, transport }) : null

  const n = await pub.readContract({ address: LAUNCHPAD, abi: PAD, functionName: 'count' })
  if (n === 0n) { console.log('no launches'); return }
  const rows = await pub.readContract({ address: LAUNCHPAD, abi: PAD, functionName: 'page', args: [0n, n] })

  console.log(`${rows.length} launches · ${send ? 'ARMED' : 'dry run'}`)

  for (const e of rows) {
    try {
      const router = await pub.readContract({
        address: e.distributor, abi: DIST, functionName: 'opsVault',
      })
      if (!router || router === NATIVE) continue

      /* ⚠ A router is a CONTRACT; a wallet-only launch's payout is an EOA. Reading `splits()` off an
         EOA returns empty data, which viem raises as a decode error rather than "no shares" — so the
         shape decides, and a wallet-only launch is skipped in silence rather than logged as a fault.
         ⭐ This is the ordinary case: most launches have no router at all. */
      const code = await pub.getBytecode({ address: router })
      if (!code || code === '0x') continue

      const ready = await pub.readContract({ address: router, abi: ROUTER, functionName: 'initialized' })
      if (!ready) { console.log(`${e.token}  router not bound yet`); continue }

      const [splits, pairToken] = await Promise.all([
        pub.readContract({ address: router, abi: ROUTER, functionName: 'splits' }),
        pub.readContract({ address: router, abi: ROUTER, functionName: 'pairToken' }),
      ])

      /* ── 1. split whatever has arrived ─────────────────────────────────────────────────────
         ⛔ The burn reserve is EXCLUDED by the contract, so what is distributable is the balance
         minus what a previous pass already set aside. Read the same way here, or every pass would
         report work to do and every call would revert `NothingToDistribute`. */
      const [held, reserved] = await Promise.all([
        balanceOf(pairToken, router),
        pub.readContract({ address: router, abi: ROUTER, functionName: 'burnReserve', args: [pairToken] }),
      ])
      const distributable = held > reserved ? held - reserved : 0n

      if (distributable > 0n) {
        if (send) {
          const { request } = await pub.simulateContract({
            address: router, abi: ROUTER, functionName: 'distribute', args: [pairToken], account,
          })
          const hash = await wallet.writeContract(request)
          const receipt = await pub.waitForTransactionReceipt({ hash })
          /* ⛔ `status` CHECKED. A receipt resolving is not a transaction succeeding — that exact
             assumption froze every donation for two days on 4 Sep. */
          console.log(
            receipt.status === 'success'
              ? `${e.token}  distributed ${formatUnits(distributable, 18)}`
              : `${e.token}  ⚠ distribute REVERTED, nothing recorded`,
          )
        } else {
          console.log(`${e.token}  would distribute ${formatUnits(distributable, 18)}`)
        }
      }

      /* ── 2. burn, if this launch has a burn leg with something in it ───────────────────── */
      if (!splits.some((s) => Number(s.mode) === MODE_BURN)) continue

      const toBurn = await pub.readContract({
        address: router, abi: ROUTER, functionName: 'burnReserve', args: [pairToken],
      })
      if (toBurn === 0n) continue

      /* ⛔⛔ WHICH CALL DEPENDS ON THE PHASE, AND A LAUNCH IS IN EXACTLY ONE. `curve.buy` stops
         working the moment a launch graduates and the pool call reverts before it. Asked rather
         than guessed — the contract has two entry points for exactly this reason. */
      const graduated = await pub.readContract({ address: e.curve, abi: CURVE, functionName: 'graduated' })
      const fn = graduated ? 'buyAndBurnOnPool' : 'buyAndBurn'

      /*
        ⛔⛔ SIMULATED AT ZERO ONLY TO LEARN THE FILL, THEN FLOORED — the simulation is never what
        gets sent. A scheduled, permissionless buy with `minTokensOut: 0` is a standing invitation
        to sandwich, and the fact that it is our own cranker calling it changes nothing.
      */
      let quoted
      try {
        const sim = await pub.simulateContract({
          address: router, abi: ROUTER, functionName: fn, args: [0n], account: account ?? e.creator,
        })
        quoted = sim.result?.[0] ?? 0n
      } catch (err) {
        /* ⚠ Reported, not swallowed. A pool with no depth for this size is a true answer about the
           market that somebody should be able to see — a burn leg that quietly never fires is the
           silent-skip shape this repo keeps rediscovering. */
        console.log(`${e.token}  ⛔ burn cannot be quoted: ${String(err?.shortMessage ?? err?.message).slice(0, 90)}`)
        continue
      }
      if (quoted === 0n) { console.log(`${e.token}  ⛔ burn would return nothing`); continue }

      const floor = (quoted * (10_000n - SLIPPAGE_BPS)) / 10_000n

      if (!send) {
        console.log(`${e.token}  would ${fn} ${formatUnits(toBurn, 18)} -> >=${formatUnits(floor, 18)} tokens`)
        continue
      }

      const { request } = await pub.simulateContract({
        address: router, abi: ROUTER, functionName: fn, args: [floor], account,
      })
      const hash = await wallet.writeContract(request)
      const receipt = await pub.waitForTransactionReceipt({ hash })
      console.log(
        receipt.status === 'success'
          ? `${e.token}  burned, spending ${formatUnits(toBurn, 18)}`
          : `${e.token}  ⚠ ${fn} REVERTED — the reserve is untouched, next pass retries`,
      )
    } catch (err) {
      /* ⚠ Per launch, so one launch's bad luck does not abandon the rest of the pass — the same
         lesson the donation keeper learned the hard way on 29 Aug. */
      console.log(`${e.token}  ⚠ skipped: ${String(err?.shortMessage ?? err?.message ?? err).slice(0, 120)}`)
    }
  }
}

await main()
