import { createPublicClient, createWalletClient, fallback, formatUnits, http, parseAbi, type Address, type Hex } from 'viem'
/* ⚠ `viem/accounts`, not `viem`. The root export does not carry it, and the failure is a module
   resolution error at import time rather than anything the type checker flags. */
import { privateKeyToAccount } from 'viem/accounts'
import { quoteRemit, quoteIsStale, fitsVault, MAINNET_ASSETS } from './relay.ts'
import { parseLedger, remittedFor, decideDelivery, hasArrived, noteHeld, orderForDelivery, type Ledger, type Pending } from './settle.ts'
import { decideRemit, canLeaveRhc, BRIDGEABLE_FROM_RHC, HARD_FLOOR_USD } from './decide.ts'
import { readPoolSweep } from './poolSweep.ts'
import { probeTiers, pickTier, minOutFor, worthSelling } from './sell.ts'

/**
 * The keeper: the one process that signs, and the smallest thing that could be.
 *
 * ## What it does, in order
 *
 * 1. `sweepCurve` and `harvest` on each launch. **Permissionless**, so these need no key at all;
 *    the keeper runs them only because somebody has to and it is already awake.
 * 2. Quote a bridge from the vault on Robinhood Chain to `CharityPayer` on Base.
 * 3. `vault.remitToken` / `remitNative`. **This is the only signed step that moves money**, and the
 *    only one a compromised keeper could abuse. The vault caps it per asset, refuses any calldata
 *    that is not a Relay deposit naming the vault, and logs the request id.
 * 4. `payer.pay(configId, USDC)` on Base. Permissionless again: if the keeper dies here, anyone
 *    can finish it, and the money cannot go anywhere but a charity regardless.
 *
 * ## ⛔⛔ THE RULES THIS FILE EXISTS TO ENFORCE
 *
 * - **`--send` is never the default.** A remit runner's failure mode is not that it sits idle, it is
 *   that it acts once, wrongly, on somebody else's donation.
 * - **One launch at a time.** The vault pools every launch's share, but each launch names a
 *   different charity. Remitting the whole balance and then guessing how to split the donation is
 *   how the wrong charity gets paid. Each pass moves exactly one launch's owed amount and donates it
 *   to exactly that launch's config id.
 * - **The config id comes from the CHAIN, never from configuration.** It is the promise the token
 *   made. A keeper that read ids from its own config could pay a different charity than the token
 *   advertises without anything on chain changing.
 */

const RHC_RPC = process.env.RHC_RPC ?? 'https://rpc.mainnet.chain.robinhood.com'
/**
 * ⛔⛔ NOT `base-rpc.publicnode.com`. It answers reads and accepts transactions, and then REFUSES
 * `eth_getTransactionReceipt` with "Archive requests require a personal token" — so the keeper sent
 * a real 95 USDC donation, succeeded, and crashed one line later while confirming its own receipt.
 * The money was fine and the ledger was already written; the process just fell over reporting it.
 *
 * ⚠ A receipt is not an archive query. Anything that treats it as one cannot supervise a
 * transaction it just sent, which is most of what this process does after it signs.
 */
const BASE_RPC = process.env.BASE_RPC ?? 'https://mainnet.base.org'

const LAUNCHPAD = (process.env.LAUNCHPAD ?? '') as Address
/**
 * ⛔⛔ BOTH REGISTERS, OR HALF THE LAUNCHES ARE INVISIBLE AND NOTHING SAYS SO.
 *
 * V2 is a SEPARATE launchpad with its own `count()`/`page()`. V1 is not superseded — 182 launches
 * point at it immutably — so the keeper has to read the two and merge them. Reading only V1, which
 * is what shipped, means a V2 launch's charity share accrues in its distributor and is never
 * remitted: the launch works, the fees arrive, the charity gets nothing, and no unit ever goes red.
 *
 * ⚠ Optional on purpose. A box with no `LAUNCHPAD_V2` set reads V1 alone, exactly as before, rather
 * than crashing the one service that moves real money every fifteen minutes.
 */
const LAUNCHPAD_V2 = (process.env.LAUNCHPAD_V2 ?? '') as Address
const VAULT = (process.env.REMIT_VAULT ?? '') as Address
const PAYER = (process.env.CHARITY_PAYER ?? '') as Address

const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address
const NATIVE = '0x0000000000000000000000000000000000000000' as Address
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address

/**
 * ⛔⛔ THERE ARE NO FLOORS IN THIS FILE. THE POLICY LIVES IN `decide.ts`.
 *
 * This used to hold two flat minimums, 0.02 ETH and 50 USDG, while `decide.ts` — a tested module
 * with a hard floor, per-asset loss targets and a custody time limit — was imported by nothing. Its
 * own header said "this is the only judgement the remit service makes" and it made none.
 *
 * ➤ Two things the flat floors could not do, and the reason the swap is worth it:
 *
 * - **A floor in an asset's own units is not a judgement about cost.** 0.02 ETH is a different
 *   amount of money every day, and it says nothing about what the crossing will actually take. The
 *   policy asks the only question that matters — *what fraction of this donation does the bridge
 *   eat* — against a quote that prices BOTH sides in USD.
 * - **A floor alone has no upper bound on holding.** Waiting always makes the bridge cheaper, so
 *   cost alone converges on holding a charity's money in a hot wallet for ever. `maxHoldMs` is the
 *   custody side of that trade and nothing here expressed it.
 */

const rhc = {
  id: 4663, name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RHC_RPC] } },
  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' as Address } },
} as const

const base = {
  id: 8453, name: 'Base',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [BASE_RPC] } },
} as const

/**
 * ⛔⛔ ROBINHOOD CHAIN'S RPC IS BEHIND CLOUDFLARE, AND IT CHALLENGES A DEFAULT AGENT.
 *
 * Node's fetch sends its own User-Agent, and from a datacenter address Cloudflare answers the
 * managed challenge instead of JSON: a "Just a moment..." HTML page that viem then fails to parse.
 * The failure names no cause. It says the RPC returned something unparseable, and it only appears
 * once the keeper is somewhere other than a laptop — this ran clean locally for weeks and died on
 * its first pass on the server.
 *
 * ➤ A browser agent is answered normally. It is the agent string and nothing else; there is no
 * token and no allowlist. Same fix as `cast --rpc-headers` and as `scripts/rpc-proxy.mjs`, applied
 * to every transport rather than to the one that happened to fail first.
 */
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
/*
  ⚠⚠ RETRIES ARE RAISED ABOVE viem's DEFAULT THREE, AND THE REASON IS THE SHAPE OF THIS RUN.

  A pass walks every launch and makes several reads each, so the public endpoints see a burst rather
  than a trickle and start rate limiting partway through. Three attempts inside one second are three
  attempts into the same closed window, so the run died on `usdcAtPayer` AFTER bridging and donating,
  which is the worst place to stop: the money had moved and the ledger had not caught up.

  ➤ Six attempts with a backing off delay carry the call past a rate limit window instead.
*/
const one = (url: string) =>
  http(url, {
    fetchOptions: { headers: { 'User-Agent': BROWSER_UA } },
    retryCount: 6,
    retryDelay: 800,
    timeout: 30_000,
  })

const rpc = (url: string) => one(url)

/*
  ⛔⛔ BASE NEEDS MORE THAN ONE ENDPOINT, AND THE ORDER IS NOT ARBITRARY.

  A pass makes hundreds of Base reads — every launch is checked, and the wait for a crossing polls
  the payer's balance every few seconds — and `mainnet.base.org` starts answering `over rate limit`
  partway through. Measured from this box on 29 Aug 2026 it served 5 of 12 identical `eth_call`s.
  Retries alone do not fix that: they are more requests into the same closed window. The run died
  AFTER bridging $8,600 and before donating it, which is the worst place to stop.

  ⛔ `base.publicnode.com` is the fastest of the three and CANNOT BE FIRST. It refuses
  `eth_getTransactionReceipt` with "Archive requests require a personal token", and the keeper waits
  on a receipt after every donation. That is the same endpoint, and the same refusal, that crashed
  this keeper once before. It is kept only as a last resort for the plain `eth_call`s it does serve.

  ⭐ `base.drpc.org` answered 12 of 12 and is the only one of the three that serves receipts AND
  unbounded `eth_getLogs`, so it leads.

  ⚠ `rank: false` on purpose. Ranking reorders by observed latency, which would promote publicnode
  for being fast at the calls it answers and put the receipt refusal back at the front.
*/
const BASE_RPCS = [
  process.env.BASE_RPC,
  'https://base.drpc.org',
  'https://mainnet.base.org',
  'https://base.publicnode.com',
].filter((u): u is string => !!u)

const baseTransport = fallback(BASE_RPCS.map(one), { rank: false, retryCount: 2 })

export const rhcClient = createPublicClient({ chain: rhc, transport: rpc(RHC_RPC), batch: { multicall: true } })
export const baseClient = createPublicClient({ chain: base, transport: baseTransport })

const PAD_ABI = parseAbi([
  'struct Entry { address token; address curve; address distributor; address charity; address creator; address pairToken; uint16 charityBps; uint64 launchedAt; bytes32 charityId; }',
  'function count() view returns (uint256)',
  'function page(uint256 offset, uint256 limit) view returns (Entry[])',
])
/**
 * What a curve is holding, read BEFORE deciding to sweep it.
 *
 * ⛔⛔ THREE BALANCES, NOT ONE. The plain fee is split with Pons, the creator tax is NOT split, and
 * a pending buyback is carved out of the creator's side. A gate built on `quoteFeeBalance` alone
 * would skip a taxed launch that genuinely has money waiting. @see unswept.ts
 */
const CURVE_FEE_ABI = parseAbi([
  'function quoteFeeBalance() view returns (uint256)',
  'function creatorTaxBalance() view returns (uint256)',
  'function buybackQuoteBalance() view returns (uint256)',
])

/**
 * Whether a curve is worth spending a transaction on.
 *
 * ⛔⛔ `sweepCurve` SUCCEEDS on an empty curve — it moves zero and returns — so simulating it is not
 * a filter. Measured 7 Sep against the live V1 registry: 40 of 40 sampled curves held zero fees and
 * 40 of 40 still simulated OK, so the keeper sent ~600 pointless transactions every fifteen minutes.
 *
 * ⚠ `null` means the balances could not be READ, and that must still sweep: a gas optimisation may
 * never turn into a silent skip of a launch that has money. Only a confirmed zero declines.
 */
export const worthSweeping = (curveHolds: bigint | null): boolean =>
  curveHolds === null || curveHolds > 0n

const DIST_ABI = parseAbi([
  'function sweepCurve(address curve, uint256 minBuybackTokensOut)',
  /* ⛔⛔ THE SWEEP FOR A GRADUATED LAUNCH, AND ITS ABSENCE WAS A BUG WITH MONEY IN IT. Graduating
     kills the curve: fees stop accruing there and start accruing in the meme hook, and `sweepCurve`
     reverts from then on. With only the curve sweep, this keeper stopped moving a launch's fees the
     moment it graduated — quietly, because `pending` reads the escrow that the sweep is what fills,
     so every pass found nothing to do and said so. @see poolSweep.ts */
  'function sweepPool(address hook, bytes32 poolId, uint256 minConversionQuoteOut, uint256 minBuybackTokensOut)',
  'function harvest() returns (uint256)',
  'function harvestToken(address asset) returns (uint256)',
  'function pending(address asset) view returns (uint256)',
  'function totalToCharity(address asset) view returns (uint256)',
  /* ⭐ The sell path. Present on every deployed distributor — checked on chain 6 Sep 2026, all
     twelve stock-paired ones carry identical 8089-byte code answering `maxSellSlippageBps` 200. */
  'function sellAllForUsdg(address stock, uint24 fee, int24 tickSpacing, uint256 minOut) returns (uint256)',
  'function quoteSpot(address stock, uint24 fee, int24 tickSpacing, uint256 amountIn) view returns (uint256)',
  'function maxSellSlippageBps() view returns (uint16)',
])
const VAULT_ABI = parseAbi([
  'function remitToken(address token, uint256 amount, bytes depositData)',
  'function remitNative(uint256 amount, bytes depositData)',
  'function maxNativePerRemit() view returns (uint256)',
  'function maxTokenPerRemit(address token) view returns (uint256)',
  'function keeper() view returns (address)',
  'function relayDepositor() view returns (address)',
])
const PAYER_ABI = parseAbi(['function pay(bytes32 configId, address token) returns (uint256)'])
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)'])
const ERC20_DECIMALS = parseAbi(['function decimals() view returns (uint8)'])
const ERC20_SYMBOL = parseAbi(['function symbol() view returns (string)'])

/**
 * What `settlePending` did about the money at the payer.
 *
 * - `donated`  — `pay` succeeded, the ledger has the record, `pending` is cleared.
 * - `empty`    — there was nothing at the payer. Normal; the caller carries on.
 * - `reverted` — `pay` failed. The money is STILL THERE and still this launch's, `pending` is still
 *                set, and nothing was recorded. ⛔ The caller must STOP the pass: the payer is
 *                all-or-nothing, so bridging anything else on top would donate two launches' money
 *                to whichever id fires next.
 */
export type Settled = 'donated' | 'empty' | 'reverted'

export type Launch = {
  token: Address
  curve: Address
  distributor: Address
  /** What the launch is PRICED in. What the curve, the escrow and a harvest all deal in. */
  pairToken: Address
  /**
   * What the VAULT ends up holding for this launch, and therefore what gets bridged.
   *
   * ⛔⛔ NOT THE SAME AS `pairToken`, AND CONFLATING THEM STRANDS MONEY. A stock-paired launch is
   * harvested as the stock and then SOLD, and `_release` credits `totalToCharity[USDG]` — the asset
   * it released — while `totalToCharity[AAPL]` stays at zero for ever. A keeper that reads the
   * ledger under `pairToken` therefore sees a launch it has just sold as owing NOTHING, and the
   * proceeds sit in the vault as USDG that no launch claims. That is the unattributed-money state
   * that froze every donation for two days on 4 Sep 2026, reached from the other direction.
   *
   * ➤ So every remit-side read — the ledger, the cap, the vault balance, the bridge quote, the
   * decimals — uses THIS, and only sweep, harvest and sell use `pairToken`.
   */
  remitAsset: Address
  charityId: Hex
  /** Lifetime, pushed by this launch's distributor to the vault, denominated in `remitAsset`. */
  paidToVault: bigint
  /** Sitting in the Pons escrow, claimable by a harvest. In `pairToken`. */
  pending: bigint
}

/**
 * What a launch's fees turn into on the way out.
 *
 * ⚠ A pure function of the pair asset, because a launch's pair asset is fixed at launch for ever.
 * Relay carries native ETH and USDG off this chain and nothing else, so everything else is sold to
 * USDG first and reaches the vault as USDG. @see sell.ts
 */
/**
 * ⚠⚠ CANONICALISED, NEVER ECHOED. Returning the caller's own string kept its CASE, so a lowercased
 * USDG and a checksummed one produced two different remit assets for the same launch — and one of
 * the places this value lands is `l.remitAsset === NATIVE`, a case-sensitive comparison. Every
 * other ledger read in this service is already case-insensitive for exactly this reason; a key that
 * depends on how it was spelled is how a balance reads as a confident zero.
 *
 * ⚠ The `?? pairToken` fallback is unreachable while Relay carries only these two, and is kept so
 * that adding a third to `BRIDGEABLE_FROM_RHC` cannot silently start routing it through USDG.
 */
const CANONICAL_REMIT_ASSETS: Record<string, Address> = {
  [NATIVE.toLowerCase()]: NATIVE,
  [USDG.toLowerCase()]: USDG,
}

export const remitAssetFor = (pairToken: Address): Address =>
  canLeaveRhc(pairToken) ? (CANONICAL_REMIT_ASSETS[pairToken.toLowerCase()] ?? pairToken) : USDG

/** One register's rows. @see readLaunches for why there is more than one. */
async function readRegister(pad: Address) {
  if (!pad) return []
  const n = await rhcClient.readContract({ address: pad, abi: PAD_ABI, functionName: 'count' })
  if (n === 0n) return []
  return rhcClient.readContract({ address: pad, abi: PAD_ABI, functionName: 'page', args: [0n, n] })
}

export async function readLaunches(): Promise<Launch[]> {
  /*
    ⛔ SEQUENTIAL, NOT Promise.all. A failing V2 read must not take V1's 182 launches down with it —
    the donations that have been running unattended for weeks are on V1, and a new register going
    wrong is not a reason to stop paying them.
    ⚠ `page()` is identical on both, so one ABI covers them; the V2 struct only ADDED fields after
    the ones V1 has, which is what makes that safe rather than lucky.
  */
  const rows = [...(await readRegister(LAUNCHPAD))]
  if (LAUNCHPAD_V2) {
    try {
      rows.push(...(await readRegister(LAUNCHPAD_V2)))
    } catch (e) {
      /* ⚠ Loud. A quiet skip here is the exact failure this whole comment exists about. */
      console.log(`⛔ could not read the V2 register at ${LAUNCHPAD_V2}: ${String((e as Error).message).slice(0, 120)}`)
    }
  }
  if (rows.length === 0) return []
  return Promise.all(rows.map(async (e) => ({
    token: e.token, curve: e.curve, distributor: e.distributor,
    pairToken: e.pairToken, remitAsset: remitAssetFor(e.pairToken), charityId: e.charityId,
    /* ⛔ Keyed by the REMIT asset. See the note on `Launch.remitAsset`: for a stock-paired launch
       this reads the USDG the sell produced, which is the only place its money is recorded. */
    paidToVault: await rhcClient.readContract({
      address: e.distributor, abi: DIST_ABI, functionName: 'totalToCharity',
      args: [remitAssetFor(e.pairToken)],
    }).catch(() => 0n),
    /* ⚠ Keyed by the PAIR asset, because the escrow holds what the launch was priced in — the
       stock itself — and that is what a harvest claims. */
    pending: await rhcClient.readContract({
      address: e.distributor, abi: DIST_ABI, functionName: 'pending', args: [e.pairToken],
    }).catch(() => 0n),
  })))
}

/**
 * How much of the vault belongs to a launch that has not been sent yet.
 *
 * ⚠⚠ `paidToVault` is a LIFETIME figure from the distributor's own ledger, so the amount owed is it
 * minus whatever has already been remitted for that launch. That subtrahend is the one piece of
 * state this system keeps off chain, in `receipts.json`, and losing it would make the keeper try to
 * send everything again.
 *
 * ⚠ The remitted totals are running sums and carry no provenance of their own; what makes a remit
 * checkable is on chain, in the vault's `Remitted(token, amount, requestId)` and the payer's
 * `Paid(configId, token, amount)`. The ledger's `pending` half carries the request id of the one
 * delivery in flight, which is the piece those events cannot supply in time — the vault logs the
 * request but not which LAUNCH it was for, and with two launches paired in the same asset that
 * attribution exists nowhere else. See `settle.ts`.
 */
export function owed(l: Launch, alreadyRemitted: bigint): bigint {
  return l.paidToVault > alreadyRemitted ? l.paidToVault - alreadyRemitted : 0n
}

/**
 * A pair asset's ticker, read off the token and cached.
 *
 * ⛔ READ, NOT LISTED. A hardcoded symbol table is the exact thing that went stale everywhere else
 * in this repo: Pons approved 32 new pair assets between 28 Aug and 4 Sep 2026 and nothing here was
 * told. The chain always knows. Falls back to the address, which is ugly and never wrong.
 */
const pairSymbolCache = new Map<string, string>()
async function pairSymbol(asset: Address): Promise<string> {
  if (asset.toLowerCase() === NATIVE.toLowerCase()) return 'ETH'
  const key = asset.toLowerCase()
  const hit = pairSymbolCache.get(key)
  if (hit !== undefined) return hit
  const read = await rhcClient
    .readContract({ address: asset, abi: ERC20_SYMBOL, functionName: 'symbol' })
    .catch(() => null)
  const s = read ? String(read) : asset
  pairSymbolCache.set(key, s)
  return s
}

/**
 * What one sell costs, in dollars.
 *
 * ⚠⚠ **THE ETH PRICE IS THE ONE NUMBER IN THIS FILE NOT READ FROM THE CHAIN**, so it is worth being
 * exact about what it can and cannot do. It feeds {@link worthSelling}, whose only job is to refuse
 * a sale whose proceeds are smaller than the gas of making it. Measured on RHC 6 Sep 2026: a sell
 * is ~350k gas at 0.378 gwei, about **$0.33**, against real balances quoting $1.43 to $28.45.
 * Nothing is remotely close to the line.
 *
 * ➤ So being wrong by 2x cannot lose money. Too high and a marginal sale waits for the next pass,
 * by which point the balance is larger; too low and we spend a third of a dollar to move a dollar.
 * Both are recoverable, which is why a constant beats a price oracle for a gate on dust.
 *
 * ⚠ 2500 is where ETH actually was on 6 Sep 2026 — cross-checked against Relay pricing 0.04 ETH at
 * $99.74 in the same pass, i.e. $2493. ⛔ It is a PRICE and prices rot; the number is here rather
 * than buried so that it is findable, and `ETH_USD` overrides it without a deploy.
 *
 * ⛔⛔ THE EXACT FIX, the day this matters: read the ETH/USDG V4 pool the way
 * `web/src/lib/usdPrice.ts` already does. All four tiers are initialised for that pair on this
 * chain, so it is a storage read on the singleton and no new dependency. It was not done here
 * because a gate that only ever refuses sub-dollar dust does not justify porting a price feed into
 * the signing process — but the moment this number decides anything larger, it does.
 */
const ETH_USD = Number(process.env.ETH_USD ?? 2500)

async function sellGasUsd(distributor: Address, stock: Address, fee: number, tickSpacing: number, minOut: bigint, caller: Address): Promise<number> {
  const [gas, price] = await Promise.all([
    rhcClient.estimateContractGas({
      address: distributor, abi: DIST_ABI, functionName: 'sellAllForUsdg',
      args: [stock, fee, tickSpacing, minOut], account: caller,
    }),
    rhcClient.getGasPrice(),
  ])
  return Number(formatUnits(gas * price, 18)) * ETH_USD
}

/**
 * Turn a stock-paired launch's fees into USDG in the vault, so the ordinary remit path can deliver
 * them. The other half of the fix that {@link Launch.remitAsset} is the accounting half of.
 *
 * ## Why this is safe to run before the payer gate
 *
 * ⭐ **Nothing here touches the payer, the ledger, or the bridge.** The money moves from the Pons
 * escrow into the distributor, and from the distributor into the vault as USDG — the same place a
 * USDG-paired launch's fees already land, credited under the same key. No attribution is created or
 * destroyed, so a crash anywhere in here leaves a state the next pass reads correctly. That is why
 * it can sit at the top of the loop with the sweeps rather than behind the one-launch-at-a-time gate.
 *
 * ## ⛔⛔ The three failures this is written around
 *
 * 1. **A tier is never assumed.** Verified on a fork of live RHC 6 Sep 2026: SPCX fills best at
 *    `fee=3000`, GME and DJT at `fee=10000`. A hardcoded 3000 would route DJT through a tier that
 *    refuses it and report the stock as unsellable for ever.
 * 2. **`minOut` is never zero and never the contract's own floor.** Zero is refused outright by
 *    `SlippageTooLoose`, so a probe at zero reports every tier dead and the stock looks illiquid.
 *    The contract's 2% floor is a backstop against a hostile caller, not an execution target — the
 *    service simulates and then floors the simulation, which is what {@link minOutFor} is.
 * 3. **A sale worth less than its gas is a loss, not a small win.** {@link worthSelling} is the
 *    gate, priced in USD on both sides.
 *
 * @returns a line describing what happened, for the caller to log against the launch.
 */
export async function sellStock(l: Launch, wallet: any, caller: Address): Promise<string> {
  const dPair = await pairDecimals(l.pairToken)
  const symbol = await pairSymbol(l.pairToken)

  /* ── 1. claim it out of the escrow. Held by the distributor, never pushed at the vault. ── */
  if (l.pending > 0n) {
    const hash = await wallet.writeContract({
      address: l.distributor, abi: DIST_ABI, functionName: 'harvestToken', args: [l.pairToken],
    })
    const receipt = await rhcClient.waitForTransactionReceipt({ hash })
    /* ⛔ `status` CHECKED. The 4 Sep freeze was a reverted transaction whose receipt resolved and
       whose caller wrote a success line anyway. Nothing after this point may assume the claim
       landed. @see settlePending */
    if (receipt.status !== 'success') return `⚠ the harvest of ${formatUnits(l.pending, dPair)} ${symbol} REVERTED — nothing sold`
  }

  const held = await rhcClient.readContract({
    address: l.pairToken, abi: ERC20, functionName: 'balanceOf', args: [l.distributor],
  }).catch(() => 0n)
  if (held === 0n) return `holds no ${symbol} to sell`

  /* ── 2. which pool, and what it would return. Simulated, at the real size. ────────────── */
  const tiers = await probeTiers(rhcClient as never, l.distributor, l.pairToken, held, caller)
  const choice = pickTier(tiers)
  if (!choice.ok) {
    /* ⚠ Reported every pass rather than once. A stock nothing will buy is a charity's money sitting
       still, and the quiet version of this is how $CHARITY's pool went unswept for five days. */
    return `⛔ ${formatUnits(held, dPair)} ${symbol} cannot be sold: ${choice.reason}`
  }

  /* ── 3. is it worth the gas? ───────────────────────────────────────────────────────────── */
  const usdgOutUsd = Number(formatUnits(choice.out, 6))
  const minOut = minOutFor(choice.out)
  /* ⚠ A gas estimate that cannot be taken is not a reason to refuse a sale worth twenty dollars, so
     it falls back to a figure well above what a sell has ever cost here. Erring high only delays. */
  /* ⚠ A gas estimate that cannot be taken must not veto a sale worth twenty dollars, so the
     fallback is a figure several times what a sell has ever cost here — high enough to still refuse
     dust, low enough to let anything real through. */
  const gasUsd = await sellGasUsd(l.distributor, l.pairToken, choice.fee, choice.tickSpacing, minOut, caller)
    .catch(() => 1)
  const worth = worthSelling(usdgOutUsd, gasUsd)
  if (!worth.sell) return `⏸ holding ${formatUnits(held, dPair)} ${symbol}: ${worth.reason}`

  /* ── 4. the sale. `sellAllForUsdg` releases the proceeds in the same transaction. ──────── */
  const hash = await wallet.writeContract({
    address: l.distributor, abi: DIST_ABI, functionName: 'sellAllForUsdg',
    args: [l.pairToken, choice.fee, choice.tickSpacing, minOut],
  })
  const receipt = await rhcClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') {
    return `⚠ the sell of ${formatUnits(held, dPair)} ${symbol} REVERTED — the stock is still held, next pass retries`
  }
  return `sold ${formatUnits(held, dPair)} ${symbol} -> ~${usdgOutUsd.toFixed(2)} USDG to the vault (${choice.reason})`
}

/**
 * Decimals for a REMIT asset — native ETH or USDG, and never anything else.
 *
 * ⛔⛔ SOUND ONLY BECAUSE OF THAT RESTRICTION. Pons approves 55 pair assets as of 6 Sep 2026 and
 * they are not all 18dp: **cbBTC is 8**. So this binary is wrong for a PAIR asset and right for a
 * remit asset, because `remitAssetFor` can only ever return native or USDG. Use
 * {@link pairDecimals} for anything denominated in what a launch is priced in.
 */
export const decimalsOf = (asset: Address) => (asset.toLowerCase() === USDG.toLowerCase() ? 6 : 18)

/**
 * Decimals for a PAIR asset, read off the token and cached for the process.
 *
 * ⚠ Falls back to 18 rather than throwing, and says so at the call site by returning the fallback
 * flag — a log line with the wrong scale is survivable, a pass that dies on one unreadable token is
 * not. ⛔ It must never be used to size a trade or a floor; those come from simulations, which are
 * denominated in the token's own units either way and so cannot be got wrong by this.
 */
const pairDecimalsCache = new Map<string, number>()
export async function pairDecimals(asset: Address): Promise<number> {
  if (asset.toLowerCase() === NATIVE.toLowerCase()) return 18
  const key = asset.toLowerCase()
  const hit = pairDecimalsCache.get(key)
  if (hit !== undefined) return hit
  const read = await rhcClient
    .readContract({ address: asset, abi: ERC20_DECIMALS, functionName: 'decimals' })
    .catch(() => null)
  const d = read === null ? 18 : Number(read)
  pairDecimalsCache.set(key, d)
  return d
}

/** ⚠ The bridge delivers to the PAYER, never to a wallet. That is what makes the far side safe. */
export async function planRemit(l: Launch, amount: bigint) {
  const quote = await quoteRemit({
    sender: VAULT,
    charity: PAYER,
    originCurrency: l.remitAsset.toLowerCase() === USDG.toLowerCase() ? USDG : NATIVE,
    amount,
    destinationChainId: 8453,
    destinationCurrency: USDC_BASE,
  })
  return quote
}

/**
 * ⛔⛔ RE-QUOTE UNTIL RELAY OFFERS THE SHAPE THE VAULT PINS, THEN SIGN THAT ONE IMMEDIATELY.
 *
 * Relay moved RHC onto its v3 router on 30 Aug 2026 and the vault — immutable, no setter — refuses
 * everything but the old 68-byte `depositNative`. ⭐ The old shape still comes back in WAVES: on
 * chain, 12–13 direct deposits a minute, then four minutes of none, then back. A pass that quotes
 * once and gives up misses those windows; a pass that signs without looking reverts
 * `BadDepositData()` and burns gas, which is what it did 16 times before this existed.
 *
 * ⚠ Every attempt is a FRESH quote, never a cached one: a quote prices a route at a moment and a
 * stale deposit is refunded on the origin side. The one that fits is returned and signed at once.
 *
 * ⚠ Bounded and spaced on purpose. Relay answered `Could not process request` 195 times in two
 * hours when this keeper asked too fast, and it only ever runs for the ONE launch about to bridge.
 */
/* ⭐ Measured on chain 30 Aug 2026: direct deposits ran 4 minutes (12-13/min), then stopped for
   5-6, then came back — a cycle of about ten minutes. So the window has to span a TROUGH, not a
   few seconds, or a pass gives up during the gap and waits a full 15 minutes for the next one. */
const FIT_ATTEMPTS = 24
const FIT_SPACING_MS = 15_000

/**
 * ⛔⛔ THE SEARCH MUST FIT INSIDE THE BUDGET SYSTEMD GIVES THE PASS.
 *
 * `charity-keeper.service` is `Type=oneshot` and systemd SIGTERMs the pass at `TimeoutStartSec`.
 * The first version of this search waited six minutes PER LAUNCH, so the second eligible launch
 * pushed the pass past the then-600s mark and systemd killed it — the exact mid-pass kill that
 * costs a delivery its attribution. Twice. Both times it got away with it (the kill landed during
 * quoting, before anything was signed, `pending` stayed null) but it must not be able to happen.
 *
 * ➤ So the search has its OWN budget, shared by every launch in the pass and spent only while
 * waiting, and it stops with time left over for the delivery it might still have to make.
 *
 * ⚠ `PASS_BUDGET_MS` mirrors `TimeoutStartSec` in the unit file. Change one, change the other.
 */
const PASS_STARTED_AT = Date.now()
const PASS_BUDGET_MS = Number(process.env.PASS_BUDGET_MS ?? 840_000)

/* ⚠⚠ MEASURED, NOT GUESSED. Five passes on 30 Aug took 293-329s of sweeping, harvesting and
   quoting BEFORE any of this existed, so the search is what is added on top of ~330s — not a
   share of the budget. Sizing it as a fraction of 600s is what pushed a pass past
   `TimeoutStartSec` and got it SIGTERMed. 330 baseline + 300 search = ~630s inside 840s. */
const SEARCH_BUDGET_MS = 300_000

/* ⛔ Time spent WAITING for a window, accumulated across every launch in the pass. Wall clock since
   start would charge the search for the sweeping either side of it and stop it far too early. */
let searchSpentMs = 0

export function searchBudgetLeftMs(spentMs: number, budgetMs = SEARCH_BUDGET_MS) {
  return Math.max(0, budgetMs - spentMs)
}
/* ⚠ A wall-clock backstop as well: if a pass is somehow slow for an unrelated reason, the search
   must still not be the thing that runs it into the timeout. */
const searchTimeLeft = () => Math.min(
  searchBudgetLeftMs(searchSpentMs),
  Math.max(0, PASS_BUDGET_MS * 0.75 - (Date.now() - PASS_STARTED_AT)),
)

async function quoteThatFitsVault(
  l: Launch,
  amount: bigint,
  p: { vault: Address; depositor: Address; isNative: boolean; first: Awaited<ReturnType<typeof planRemit>>; attempts: number },
) {
  let last = fitsVault(p.first, { vault: p.vault, depositor: p.depositor, amount, isNative: p.isNative })
  if (last.ok) return { quote: p.first, fit: last }

  for (let i = 1; i < p.attempts; i++) {
    /* ⛔ Stop early rather than be killed: a pass terminated mid-delivery is the failure this
       whole service is most careful about. */
    if (searchTimeLeft() < FIT_SPACING_MS) {
      return { quote: null, fit: { ok: false, reason: `${last.reason} (out of search budget for this pass)` } }
    }
    await new Promise((r) => setTimeout(r, FIT_SPACING_MS))
    searchSpentMs += FIT_SPACING_MS
    const q = await planRemit(l, amount).catch(() => null)
    if (!q) continue
    const fit = fitsVault(q, { vault: p.vault, depositor: p.depositor, amount, isNative: p.isNative })
    last = fit
    if (fit.ok) return { quote: q, fit }
  }
  return { quote: null, fit: last }
}

async function main() {
  const send = process.argv.includes('--send')
  /* ⚠ LAUNCHPAD_V2 is deliberately NOT required here: a box without it reads V1 alone. */
  for (const [k, v] of Object.entries({ LAUNCHPAD, REMIT_VAULT: VAULT, CHARITY_PAYER: PAYER })) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`${k} is not set`)
  }

  const launches = await readLaunches()
  console.log(`launchpad ${LAUNCHPAD}`)
  console.log(LAUNCHPAD_V2 ? `launchpad v2 ${LAUNCHPAD_V2}` : '⚠ no LAUNCHPAD_V2 — V2 launches are INVISIBLE to this keeper')
  console.log(`vault     ${VAULT}`)
  console.log(`payer     ${PAYER} (Base)`)
  console.log(`keeper    ${await rhcClient.readContract({ address: VAULT, abi: VAULT_ABI, functionName: 'keeper' })}`)
  console.log(`launches  ${launches.length}\n`)

  const fs = await import('node:fs/promises')
  const ledgerPath = process.env.RECEIPTS ?? new URL('../receipts.json', import.meta.url).pathname
  const ledger: Ledger = parseLedger(
    await fs.readFile(ledgerPath, 'utf8').then((t) => JSON.parse(t)).catch(() => null),
  )
  const saveLedger = () => fs.writeFile(ledgerPath, JSON.stringify(ledger, null, 1))

  /* ⚠ Reported before any launch is, because it governs whether ANY of them may bridge this pass.
     A blocked payer is the loudest thing this run has to say. */
  const payerHolds = await baseClient.readContract({
    address: USDC_BASE, abi: ERC20, functionName: 'balanceOf', args: [PAYER],
  })
  const standing = decideDelivery(payerHolds, ledger.pending)
  if (standing.action !== 'clear') console.log(`payer     ⚠ ${standing.reason}\n`)

  /* ⚠⚠ THE SAME ORDER `--send` USES. The preview exists so a run can be read before it is armed,
     and a preview that walks a different order than the sender reports the wrong launch as next —
     which is the one thing somebody reads this output to find out. */
  for (const l of orderForDelivery(launches, (x) => owed(x, remittedFor(ledger, x.token)), ledger.heldSince)) {
    const d = decimalsOf(l.remitAsset)
    const already = remittedFor(ledger, l.token)
    const due = owed(l, already)
    console.log(`${l.token}`)
    console.log(`  charity id   ${l.charityId}`)
    /* ⛔ TWO DIFFERENT ASSETS ON TWO ADJACENT LINES, AND THEY NEED TWO DIFFERENT SCALES. `pending`
       is the escrow, denominated in what the launch is PRICED in; `owed` is the vault ledger,
       denominated in what it will be PAID in. For a stock-paired launch those are AAPL at 18dp and
       USDG at 6dp, so formatting both with one number puts a real balance out by 1e12. */
    console.log(`  in escrow    ${formatUnits(l.pending, await pairDecimals(l.pairToken))} ${await pairSymbol(l.pairToken)}   (harvested, then sold if it cannot bridge)`)
    console.log(`  owed         ${formatUnits(due, d)} ${BRIDGEABLE_FROM_RHC[l.remitAsset.toLowerCase()] ?? ''}`)

    if (due === 0n && l.pending === 0n) { console.log('  nothing to do\n'); continue }

    if (due > 0n) {
      const cap = l.remitAsset === NATIVE
        ? await rhcClient.readContract({ address: VAULT, abi: VAULT_ABI, functionName: 'maxNativePerRemit' })
        : await rhcClient.readContract({ address: VAULT, abi: VAULT_ABI, functionName: 'maxTokenPerRemit', args: [l.remitAsset] })
      /* ⚠ Clamped to the cap rather than refused by it. A launch that earns more than one remit's
         worth should be sent across several passes, not stall until somebody raises a cap that was
         set immutably on purpose. */
      const amount = due > cap ? cap : due
      if (cap === 0n) { console.log('  ⛔ no cap set for this asset in the vault, refusing\n'); continue }
      /* ⚠ `remitAsset`, not `pairToken`. A stock-paired launch reaching this line is owed the
         USDG its fees were SOLD into, which bridges perfectly well — the old check refused it by
         looking at what the launch was priced in and stopped the delivery of money already
         converted. What must still never bridge is an asset Relay will not carry, and that is
         exactly what `remitAsset` cannot be. */
      if (!canLeaveRhc(l.remitAsset)) {
        console.log(`  ⛔ ${l.remitAsset} cannot leave RHC\n`); continue
      }
      /*
        ⛔⛔ NOT QUOTED WHEN ARMED. The send loop below re-quotes every launch immediately before
        signing — it has to, because a Relay quote prices a route at a moment and a stale deposit is
        refunded on the origin side. So quoting here during a real pass asks Relay about a hundred
        launches to print a line, and then asks again for real: **twice the load, for a preview
        nobody reads on an armed run**.

        ⚠ That load is not hypothetical. It is why Relay began answering `Could not process request`
        195 times in two hours, which held 1.48 ETH in the vault: the keeper will not bridge without
        a price, so every failed quote parked that launch until the next pass, where it failed again.
      */
      const q = send
        ? null
        : await planRemit(l, amount).catch((e) => { console.log(`  quote failed: ${e.message}`); return null })
      if (send) console.log(`  bridge       ${formatUnits(amount, d)} — priced at signing time`)
      /* ⚠ The SAME policy call `--send` makes, on the same inputs, so a dry run cannot report a
         remit that the real pass would then decline. The one difference is that this must not write
         the held clock: reporting is not observing, and a dry run that armed the custody timer would
         make `--send` behave differently for having been previewed.

         ⛔⛔ ONLY WHEN THERE IS A QUOTE — AND ON AN ARMED PASS THERE DELIBERATELY IS NOT.

         `q` is null whenever `send` is set, for the reason given above: the send loop re-quotes
         every launch immediately before signing, so quoting here too would ask Relay about a
         hundred launches twice a pass. Running the policy on that null fed it `inUsd: 0`, and
         `decideRemit` reports a zero input, correctly, as
         *"the quote could not price ETH — holding, and this is an alarm not a skip"*.

         🔴🔴 So that alarm printed for EVERY launch on EVERY armed pass — 108 times in the
         1 Sep 15:46 pass alone — while being FALSE BY CONSTRUCTION and saying nothing whatever
         about what the send loop then did. It is not harmless noise: it names a real failure mode
         this service has actually had (Relay dropping RHC pricing, 30 Aug), so it sends whoever
         reads the log to the bridge — and the true fault that day, a keeper wallet with
         0.000006 ETH of gas, sat forty lines further down the same output saying
         `gas required exceeds allowance`. A preview must never be able to raise an alarm the
         thing it is previewing did not raise. */
      if (q) {
        console.log(`  bridge       ${formatUnits(amount, d)} -> $${q.outUsd.toFixed(2)} USDC on Base (${q.timeEstimateSec}s)`)
        const heldSinceMs = ledger.heldSince[l.token.toLowerCase()] ?? Date.now()
        const call = decideRemit({
          asset: l.remitAsset, symbol: BRIDGEABLE_FROM_RHC[l.remitAsset.toLowerCase()] ?? '?',
          heldSinceMs, quote: { inUsd: q.inUsd, outUsd: q.outUsd },
        }, Date.now())
        console.log(`  ${call.remit ? 'WOULD REMIT' : 'holding'}   ${call.reason}`)
        if (call.remit) console.log(`  then         payer.pay(${l.charityId.slice(0, 10)}…, USDC)`)
      }
    }
    console.log()
  }

  if (!send) {
    console.log('DRY RUN. Nothing was signed.')
    console.log('Pass --send with KEEPER_KEY set to act.')
    return
  }

  /* ⛔⛔ The key is read from the environment and never written anywhere, never logged, and never
     put in a file this repo tracks. */
  const key = process.env.KEEPER_KEY
  if (!key) throw new Error('--send needs KEEPER_KEY')
  const account = privateKeyToAccount(key as Hex)
  const onChainKeeper = await rhcClient.readContract({ address: VAULT, abi: VAULT_ABI, functionName: 'keeper' })
  /* ⚠ Checked before anything is signed. Signing with the wrong key wastes gas and, worse, tells
     somebody watching that a key which is not the keeper is being used for this. */
  if (account.address.toLowerCase() !== onChainKeeper.toLowerCase()) {
    throw new Error(`KEEPER_KEY is ${account.address} but the vault's keeper is ${onChainKeeper}`)
  }
  /* ⚠ The WALLET clients need it too. Reads going through and writes being challenged would be the
     worst version of this: the keeper would report balances correctly and fail only when it tried to
     move money. */
  /* ⚠ Read from the vault, never hardcoded: it is what the vault will actually call, and a quote
     that names any other contract must be refused rather than signed. */
  const depositor = await rhcClient.readContract({
    address: VAULT, abi: VAULT_ABI, functionName: 'relayDepositor',
  })
  console.log(`depositor ${depositor} (the only contract the vault can call)\n`)

  const rhcWallet = createWalletClient({ account, chain: rhc, transport: rpc(RHC_RPC) })
  const baseWallet = createWalletClient({ account, chain: base, transport: baseTransport })

  /* ⚠ Pass-scoped: reset every run, so a shut route never leaks its verdict into the next pass. */
  let routeShut = false

  const usdcAtPayer = () => baseClient.readContract({
    address: USDC_BASE, abi: ERC20, functionName: 'balanceOf', args: [PAYER],
  })

  /**
   * Donate whatever is at the payer to the launch it actually belongs to, then forget it.
   *
   * ⛔⛔ `pay` donates the WHOLE balance, so this may only ever be called with the pending record
   * that the balance corresponds to. That is the entire reason `decideDelivery` exists and the
   * reason nothing else is allowed to bridge while a pending record is set.
   */
  /* ⛔ Three outcomes, not a boolean. `empty` (nothing was there) and `reverted` (the pay failed and
     the money is still there) both used to be `false`, and a caller cannot tell "carry on, there was
     nothing to do" from "stop, this launch's donation did not happen" from one flag. */
  const settlePending = async (pn: Pending): Promise<Settled> => {
    const bal = await usdcAtPayer()
    if (bal === 0n) return 'empty'

    /* ⛔⛔ GAS ESTIMATED WITH HEADROOM, NOT LEFT TO THE DEFAULT.

       viem sends the raw `eth_estimateGas` answer as the limit, with no margin. That estimate is
       taken against the state at estimate time, and `donateToken` writes storage inside the relay
       whose cost depends on it: a slot that is non-zero when we estimate and zero when we execute
       turns a 2,900 gas write into a 20,000 gas one, and the transaction runs out of gas having
       done nothing. It is not a revert — there is no reason string and no logs, just `status 0`.

       ⚠ It happened. 2 Sep 2026: estimate 122,039, limit 122,039, used 120,489, status 0. The same
       call estimates 139,323 today, +17,284 — one cold storage write. The 145.26 USDC stayed at the
       payer and, because the code below recorded the donation anyway, blocked every donation for
       two days. See the receipt check under it, which is the other half of this fix. */
    const est = await baseClient.estimateContractGas({
      address: PAYER, abi: PAYER_ABI, functionName: 'pay', args: [pn.charityId as Hex, USDC_BASE], account,
    })
    const payHash = await baseWallet.writeContract({
      address: PAYER, abi: PAYER_ABI, functionName: 'pay', args: [pn.charityId as Hex, USDC_BASE],
      gas: est + est / 2n,
    })

    /*
      ⛔⛔ THE RECEIPT'S STATUS IS CHECKED. `waitForTransactionReceipt` RESOLVES FOR A FAILED
      TRANSACTION — IT WAITS FOR MINING, NOT FOR SUCCESS.

      Without this the failure above was invisible and, far worse, actively destructive: the lines
      below logged `donated 145.26 USDC`, pushed a Donation the site then published, and cleared
      `ledger.pending`. That last one is what froze the service. The money was still at the payer,
      but the record saying whose it was had just been deleted, so `decideDelivery` saw a balance it
      could not attribute and correctly refused to guess — for two days, 179 passes.

      ➤ On a failure NOTHING is written. `pending` stays set, so the next pass's gate reads `settle`
      and retries the same charity with the same money. The all-or-nothing payer means a retry is
      safe: `pay` moves the whole balance or none of it, and the balance is still this launch's.
    */
    const rc = await baseClient.waitForTransactionReceipt({ hash: payHash })
    if (rc.status !== 'success') {
      console.log(`${pn.token}  ⛔ pay REVERTED — ${payHash}`)
      console.log(`     ${formatUnits(bal, 6)} USDC is still at the payer and still belongs to`)
      console.log(`     ${pn.charityId}. The pending record is kept, so`)
      console.log('     the next pass donates it to this launch and no other. Nothing was recorded.')
      console.log(`     gas limit ${est + est / 2n}, used ${rc.gasUsed} — out of gas if those are equal.`)
      return 'reverted'
    }
    console.log(`${pn.token}  donated ${formatUnits(bal, 6)} USDC to ${pn.charityId.slice(0, 10)}…  ${payHash}`)

    /* ⭐ Recorded so a launch can show its own donations. This is the ONLY place the launch token
       and the Base transaction are both known: `Paid` carries neither the token nor the request id,
       and the vault's `Remitted` is on a chain that keeps three minutes of logs. See `Donation`. */
    ledger.donations.push({
      token: pn.token, charityId: pn.charityId, amount: bal.toString(),
      payTx: payHash, requestId: pn.requestId, at: Date.now(),
    })
    /* ⚠ Cleared only after the donation is mined. A crash before this point leaves the record set,
       which makes the next pass settle it again — and `pay` reverts NothingToPay on an empty payer,
       so the duplicate is a no-op rather than a second donation. Erring the other way would strand
       the balance with no record of whose it is, which is the unrecoverable direction. */
    ledger.pending = null
    await saveLedger()

    /* ⛔⛔ WAIT FOR THE ENDPOINTS TO AGREE THE PAYER IS EMPTY BEFORE RETURNING.

       `pay` donates the whole balance, so after this receipt the payer holds nothing. But Base is
       read through a FALLBACK across several endpoints, and they are not at the same block height:
       the very next balance read can be served by a node that has not seen this transaction yet and
       answers with the amount just donated. That is unattributed money as far as the gate is
       concerned, so the pass stops and refuses to guess — correct behaviour, triggered by a number
       that was never true.

       ⚠ Observed on 29 Aug 2026: a $56.75 donation settled, and the next launch was blocked by a
       phantom $56.75 at the payer while the chain read zero.

       ➤ Bounded, and a timeout is NOT an error. Falling through with the balance still reading
       non-zero lands on the same refuse-to-guess gate, which is where an unclearable balance should
       end up anyway. */
    for (let i = 0; i < 12; i++) {
      if ((await usdcAtPayer().catch(() => 1n)) === 0n) break
      await new Promise((r) => setTimeout(r, 2500))
    }
    return 'donated'
  }

  /* A delivery left over from an earlier pass is resolved before any new money is bridged. ⚠ Only
     when something is actually there; a record older than the stale window is released by the gate
     inside the loop rather than waited on here. */
  /* ⚠ The result is not acted on here. A revert leaves `pending` set and the balance in place, and
     the gate at the top of the loop reads exactly that and breaks with the reason attached to the
     launch it blocks — which is the more useful place for it to be reported. */
  if (ledger.pending) await settlePending(ledger.pending)

  /* ⛔⛔ ORDERED, NOT IN REGISTER ORDER. A bridge waits up to two minutes on the crossing, so every
     launch ahead of another is a delay it pays before being looked at, and a pass that dies partway
     always dies at the same index — leaving everything past it permanently unreached. See
     `orderForDelivery`: this is the bug that left the launchpad's largest balance untouched while
     dust ahead of it bridged repeatedly.

     ⚠ Read with `totalToCharity` BEFORE this pass harvests, so it is an approximation of what will
     be owed rather than the figure the loop finally acts on. That is fine: it decides ORDER only,
     and the amount every decision below uses is re-read after the harvest. */
  const owedNow = new Map<string, bigint>()
  await Promise.all(launches.map(async (l) => {
    const paid = await rhcClient.readContract({
      address: l.distributor, abi: DIST_ABI, functionName: 'totalToCharity', args: [l.remitAsset],
    }).catch(() => 0n)
    const already = remittedFor(ledger, l.token)
    owedNow.set(l.token.toLowerCase(), paid > already ? paid - already : 0n)
  }))
  const queue = orderForDelivery(launches, (l) => owedNow.get(l.token.toLowerCase()) ?? 0n, ledger.heldSince)

  /*
    ⛔⛔ DO NOT ASK RELAY ABOUT MONEY THAT CANNOT POSSIBLY QUALIFY.

    The pass quoted EVERY launch with a balance — around a hundred of them — to discover that most
    hold a few dollars and are under the $20 floor. That is a hundred requests a pass to learn
    something arithmetic could have said, and it is why Relay started answering
    `Could not process request. Please try again later.`: we were the load. The launches that
    actually had thousands of dollars waiting were failing alongside the dust.

    ➤ So the USD rate for each asset is LEARNED from the first quote that succeeds this pass, and
    used only to skip launches that are nowhere near the floor. It is an optimisation, never a
    policy: `decideRemit` still makes every real decision, from a real quote, and the margin below
    is deliberately generous so a moving price cannot skip something that would have qualified.
  */
  const usdPerUnit = new Map<string, number>()
  const SKIP_MARGIN = 0.5

  for (const l of queue) {
    /*
      ⛔⛔ ONE LAUNCH'S BAD LUCK MUST NOT ABANDON THE REST OF THE PASS.

      Measured over 12 hours on 29 Aug 2026: **12 of 53 passes aborted** on a transient
      `RPC Request failed`, five from Robinhood Chain and three from Base. Robinhood Chain has
      exactly ONE usable endpoint — `rpc.robinhood.com` does not resolve and Blockscout's eth-rpc
      answers 429 — so there is no fallback to add. Retries are already six deep.

      ➤ An unhandled throw anywhere in this loop killed the whole run, so a hiccup on the third
      launch silently cost the forty after it a turn, every time. Catching per launch turns an
      aborted pass into a skipped launch, and the next pass picks it up.

      ⚠ SAFE AFTER A BRIDGE, and that is the case worth checking. The pending record is now written
      the instant a remit is submitted, so if this throws after the money left, the record exists and
      the NEXT iteration's payer gate either settles it or stops the pass. Continuing cannot send a
      second launch's money on top of an unsettled one.

      ⚠ `break` still breaks: the gate's deliberate stops are control flow, not exceptions, and they
      are unaffected by this.
    */
    try {
    const d = decimalsOf(l.remitAsset)
    const isNative = l.remitAsset.toLowerCase() === NATIVE.toLowerCase()

    /*
      ── 0. CAN THIS ASSET EVER LEAVE? ────────────────────────────────────────────────────────

      ⛔⛔ CHECKED BEFORE THE HARVEST, NOT AFTER IT. This was the last check in the iteration, which
      meant the keeper HARVESTED a stock paired launch first — and `harvest` does not merely claim,
      it PUSHES the charity's share into `RemitVault`.

      That vault has exactly three functions: `remitToken`, `remitNative`, `setKeeper`. No swap, no
      withdraw, no rescue, deliberately, because a settable payout address is a withdraw function
      wearing a different name. So an asset that cannot be bridged and is sitting in the vault is
      not delayed, it is GONE — and a tokenized stock cannot leave Robinhood Chain at all.

      ⚠ Nothing has been lost to this yet only because none of the seven stock paired launches has
      earned a fee. The first trade on any of them would have destroyed that charity's share.

      ➤ Skipping the whole iteration leaves the money in the distributor's escrow, where it is still
      recoverable the day there is a path — selling to USDG, or a new vault. Leaving it alone is the
      only reversible option available, so it is the one taken.
    */
    /* ⭐⭐ SUPERSEDED 6 Sep 2026 — the skip below used to be the whole treatment of a stock-paired
       launch, and it is what the `sellStock` step now replaces. Kept as a comment because the
       reasoning it records is still the reason the sell has to happen BEFORE anything is pushed:

         "harvest does not merely claim, it PUSHES the charity's share into RemitVault… an asset
          that cannot be bridged and is sitting in the vault is not delayed, it is GONE."

       That was true of an earlier distributor. The DEPLOYED one holds a harvested stock instead —
       `harvestToken` only calls `_release` when the asset is USDG — so the money can be claimed and
       converted without ever passing through the vault as something no bridge will take.

       ⛔ Verified against the deployed bytecode, not the source: `test/StrandedFork.t.sol` runs
       harvest → sell against all five live positions on a fork of RHC and asserts the vault's stock
       balance does not move. `release(GME)` on a live distributor still reverts `NotPayable`. */

    /* ── 1. sweep and harvest ────────────────────────────────────────────────────────────────

       🔴🔴 SIMULATED FIRST, ALWAYS. Both calls revert when there is nothing to do, which is the
       NORMAL state for a launch nobody is trading. A `try { write } catch {}` sends those reverting
       transactions anyway, and **a reverted transaction still costs gas**. A keeper polling a
       handful of quiet launches every hour would burn real money doing nothing, for ever, draining
       the wallet it exists to keep funded. `simulateContract` is an `eth_call`: it costs nothing and
       answers the same question.
    */

    /* ⛔⛔ WHICH SWEEP DEPENDS ON THE PHASE, AND A LAUNCH IS IN EXACTLY ONE. Graduating kills the
       curve — `sweepFees` reverts from then on and every further fee accrues in the meme hook
       instead. This pass only ever knew about the curve, so a launch stopped being harvested the
       day it graduated, silently: `pending` reads the escrow that a sweep is what fills, so the
       run reported nothing to do rather than reporting that it could not look. $CHARITY, the
       largest earner here, sat in that state. @see poolSweep.ts */
    const poolSweep = await readPoolSweep(rhcClient, l).catch(() => null)

    if (poolSweep?.weMaySweep && poolSweep.pool) {
      const { hook, poolId } = poolSweep.pool
      const ok = await rhcClient.simulateContract({
        address: l.distributor, abi: DIST_ABI, functionName: 'sweepPool', args: [hook, poolId, 0n, 0n], account,
      }).then(() => true).catch(() => false)
      if (ok) {
        const h = await rhcWallet.writeContract({
          address: l.distributor, abi: DIST_ABI, functionName: 'sweepPool', args: [hook, poolId, 0n, 0n],
        })
        await rhcClient.waitForTransactionReceipt({ hash: h })
        console.log(`${l.token}  pool swept`)
      }
    } else if (poolSweep?.note) {
      /* ⚠ Logged rather than passed over in silence. Fees we are not allowed to move are still
         fees, and a pass that prints nothing for a launch that is earning is how this went
         unnoticed. Pons's own operator can sweep these at any time; nothing is lost. */
      /* ⚠ `d` here would be the REMIT asset's decimals, and this figure is in the pair asset —
         6dp against an 18dp number reads a million times small. */
      console.log(`${l.token}  ${formatUnits(poolSweep.quotePending, await pairDecimals(l.pairToken))} pending in the pool — ${poolSweep.note}`)
    }

    /* ⚠ The curve sweep is still attempted whenever there was no pool sweep to run: a launch on the
       curve is the normal case, and a launch whose factory record could not be read must not lose
       the sweep it would otherwise have had.

       ## ⛔⛔ THE GAS DRAIN — AND WHY THE SIMULATE BELOW DOES NOT CATCH IT

       `sweepCurve` SUCCEEDS on a curve holding nothing. It moves zero and returns, so the simulate
       passes for EVERY launch still on its curve, and this loop then sent a real transaction for
       each one on every pass. Measured 7 Sep against the live V1 registry: **40 of 40 sampled
       curves held zero fees, and 40 of 40 still simulated OK.** Across both registries that is
       ~600 transactions every fifteen minutes to move nothing — which is what has been emptying
       this wallet in about a day, not any single expensive call.

       ➤ So ASK THE CURVE WHAT IT HOLDS FIRST. Three `eth_call`s are free and are not transactions.

       ⚠ THREE BALANCES, NOT ONE. The plain fee is split with Pons, the creator tax is NOT split,
       and a pending buyback is carved out of the creator's side. Reading only `quoteFeeBalance` —
       which is what `bountyNow()`-style helpers do elsewhere — under-reports a taxed launch by
       more than half, and would skip a curve that genuinely has money on it. @see unswept.ts

       ⛔ A FAILED READ SWEEPS ANYWAY. This is a gas optimisation, not a new gate: a curve that
       cannot be read must keep the sweep it would otherwise have had. The silent skip is the
       failure mode this repo keeps rediscovering, so the fallback is always the old behaviour. */
    const curveHolds = await Promise.all([
      rhcClient.readContract({ address: l.curve, abi: CURVE_FEE_ABI, functionName: 'quoteFeeBalance' }),
      rhcClient.readContract({ address: l.curve, abi: CURVE_FEE_ABI, functionName: 'creatorTaxBalance' }),
      rhcClient.readContract({ address: l.curve, abi: CURVE_FEE_ABI, functionName: 'buybackQuoteBalance' }),
    ]).then((b) => b.reduce((a, x) => a + x, 0n)).catch(() => null)

    /* ⛔⛔ SKIPS THE SWEEP ONLY, NEVER THE LAUNCH. Everything below this — the stock sale, the
       harvest, the remit — must still run for a launch whose curve happens to be empty, because
       money already in the escrow or the vault is exactly what those legs exist to move. An early
       `continue` here would have stopped donations while looking like a gas fix.
       ⚠ `null` means the read failed, and that sweeps: only a CONFIRMED zero skips. */
    const canSweep = worthSweeping(curveHolds) && !poolSweep?.pool && await rhcClient.simulateContract({
      address: l.distributor, abi: DIST_ABI, functionName: 'sweepCurve', args: [l.curve, 0n], account,
    }).then(() => true).catch(() => false)
    if (canSweep) {
      const h = await rhcWallet.writeContract({
        address: l.distributor, abi: DIST_ABI, functionName: 'sweepCurve', args: [l.curve, 0n],
      })
      await rhcClient.waitForTransactionReceipt({ hash: h })
      console.log(`${l.token}  swept`)
    }

    /*
      ── 1b. A STOCK-PAIRED LAUNCH LEAVES HERE, SOLD ─────────────────────────────────────────

      ⛔⛔ PLACED AFTER THE SWEEP AND BEFORE THE HARVEST, AND BOTH HALVES OF THAT MATTER.

      After the sweep, because a sweep is what puts fees INTO the escrow and it is permissionless
      and asset-blind — gating it on the pair asset means the stock branch harvests an escrow that
      nothing ever fills, and reports "holds no AAPL to sell" for ever while the fees pile up on the
      curve. That is the silent-skip shape this repo keeps rediscovering, and it is exactly what the
      first draft of this change did.

      Before the harvest, because from here the paths genuinely differ: `sellStock` does its own
      `harvestToken` and then converts, whereas the branch below harvests straight into the vault.
    */
    if (!canLeaveRhc(l.pairToken)) {
      const sold = await sellStock(l, rhcWallet, account.address)
      console.log(`${l.token}  ${sold}`)
      /* ⛔ `continue` WHATEVER HAPPENED. Any proceeds are now USDG in the vault credited under
         `totalToCharity[USDG]`, and this launch's `paidToVault` was read at the top of the pass,
         BEFORE that existed. Remitting on it here would size a delivery off a stale ledger. The
         next pass reads the new figure and delivers it through the ordinary USDG path. */
      continue
    }

    /* ⚠ Checked by reading the escrow rather than by simulating, because `pending` is the number a
       person would look at and it costs one call either way. */
    const claimable = await rhcClient.readContract({
      address: l.distributor, abi: DIST_ABI, functionName: 'pending', args: [l.pairToken],
    }).catch(() => 0n)
    if (claimable > 0n) {
      const hash = isNative
        ? await rhcWallet.writeContract({ address: l.distributor, abi: DIST_ABI, functionName: 'harvest' })
        : await rhcWallet.writeContract({ address: l.distributor, abi: DIST_ABI, functionName: 'harvestToken', args: [l.pairToken] })
      await rhcClient.waitForTransactionReceipt({ hash })
      console.log(`${l.token}  harvested ${formatUnits(claimable, d)}`)
    }

    /* ── 2. how much is owed, after the harvest ──────────────────────────────────────────── */
    const paid = await rhcClient.readContract({
      address: l.distributor, abi: DIST_ABI, functionName: 'totalToCharity', args: [l.remitAsset],
    })
    const already = remittedFor(ledger, l.token)
    let amount = paid > already ? paid - already : 0n
    if (amount === 0n) continue

    const cap = isNative
      ? await rhcClient.readContract({ address: VAULT, abi: VAULT_ABI, functionName: 'maxNativePerRemit' })
      : await rhcClient.readContract({ address: VAULT, abi: VAULT_ABI, functionName: 'maxTokenPerRemit', args: [l.remitAsset] })
    if (cap === 0n) { console.log(`${l.token}  no cap for ${l.remitAsset}, skipped`); continue }
    if (amount > cap) amount = cap

    /* ⚠⚠ The vault can only send what it HOLDS. It pools every launch, so a launch can be owed more
       than is present if another pass already moved it. Clamping to the balance keeps a revert from
       stopping the whole run over an accounting edge. */
    const held = isNative
      ? await rhcClient.getBalance({ address: VAULT })
      : await rhcClient.readContract({ address: l.remitAsset, abi: ERC20, functionName: 'balanceOf', args: [VAULT] })
    if (held < amount) amount = held
    if (amount === 0n) continue

    /* ⚠ Already refused at step 0, before anything was harvested into a vault that could not send
       it on. The vault's `_release` reverting `NotPayable` remains the harder guarantee underneath. */

    /* ⚠ The held clock is noted from the FULL amount owed, before the cap clamps it, because that is
       the balance actually sitting in the vault. Written now so a crash cannot lose the start time. */
    const heldSinceMs = noteHeld(ledger, l.token, paid > already ? paid - already : 0n, Date.now())
    await saveLedger()

    /* ── 3. THE PAYER MUST BE EMPTY, AND UNCLAIMED, BEFORE ANYTHING BRIDGES ──────────────────

       ⛔⛔ `CharityPayer.pay` donates the contract's ENTIRE USDC balance to ONE config id. So two
       launches' money must never sit in it at the same time: whichever `pay` fires first sends both
       to its own charity, and the second charity is short for ever because the ledger already
       counts its share as remitted. See `settle.ts` for the full walkthrough — this is the check
       that enforces the "one launch at a time" rule the header at the top of this file states.
    */
    const gate = decideDelivery(await usdcAtPayer(), ledger.pending)
    if (gate.action === 'settle') {
      /* ⛔ `break`, for the same reason the `blocked` branch below breaks: a payer holding money that
         did not get donated is a condition about the SHARED payer, not about this launch. */
      if (await settlePending(gate.pending) === 'reverted') break
    }
    else if (gate.action === 'stale') {
      /* ⚠ Cleared and reported, not silently dropped. The request id stays in the log so a human can
         resolve it through Relay if a charity turns out to be short. */
      console.log(`⚠ ${gate.reason}`)
      ledger.pending = null
      await saveLedger()
    } else if (gate.action !== 'clear') {
      /* ⛔ `break`, not `continue`. The condition is about the shared payer, not about this launch,
         so it blocks every remaining launch in this pass exactly as much as this one. Sweep and
         harvest above already ran for everybody, which is the part that is safe to keep doing. */
      console.log(`${l.token}  ⛔ ${gate.reason}`)
      break
    }

    /* ⚠ Re-read after settling. Anything still here is unattributed money, and the rule is the same
       as it is for a lost ledger: stop, never guess a charity. */
    const balanceBefore = await usdcAtPayer()
    if (balanceBefore > 0n) {
      console.log(`${l.token}  ⛔ ${decideDelivery(balanceBefore, null).reason}`)
      break
    }

    /* ── 4. quote, immediately before signing ────────────────────────────────────────────────
       ⛔⛔ Never carried from the dry run above. A Relay quote prices a route at a moment; a stale
       deposit is rejected or refunded on the origin side, which is money out and nothing delivered. */
    /* ⚠ A failed quote is not an exception here. It is one of the states the policy below is
       written to judge, and it must produce a held balance and an alarm rather than a crash that
       skips every launch after this one. */
    /* ⚠ Only skips what is FAR below the floor, and only once a rate is actually known. With no
       rate learned yet the launch is quoted as before, so the first launch of a pass — the largest,
       because the queue is ordered — is never skipped on a guess. */
    const rate = usdPerUnit.get(l.remitAsset.toLowerCase())
    if (rate !== undefined) {
      const approxUsd = (Number(amount) / 10 ** d) * rate
      if (approxUsd < HARD_FLOOR_USD * SKIP_MARGIN) {
        console.log(`${l.token}  ~$${approxUsd.toFixed(2)} is far under the $${HARD_FLOOR_USD} floor — not quoted`)
        continue
      }
    }

    const q = await planRemit(l, amount).catch((e) => {
      console.log(`${l.token}  the route could not be quoted: ${e.message}`)
      return null
    })
    /* ⭐ Learned from a real quote, which reports USD on both sides of the route. */
    if (q && q.inUsd > 0 && amount > 0n) {
      usdPerUnit.set(l.remitAsset.toLowerCase(), q.inUsd / (Number(amount) / 10 ** d))
    }

    /* ── 5. the policy: is this batch worth what the crossing costs, and has it waited too long?
       ⭐ The quote is the input, which is why this cannot be decided before one is fetched. A quote
       that failed to price arrives as inUsd 0, and `decideRemit` treats that as an ALARM rather than
       a zero-value batch — the difference between holding money and cheerfully discarding it. */
    const call = decideRemit({
      asset: l.remitAsset, symbol: BRIDGEABLE_FROM_RHC[l.remitAsset.toLowerCase()] ?? '?',
      heldSinceMs, quote: { inUsd: q?.inUsd ?? 0, outUsd: q?.outUsd ?? 0 },
    }, Date.now())
    console.log(`${l.token}  ${call.reason}`)
    if (!call.remit || !q) continue

    /* ── 5b. the shape gate ───────────────────────────────────────────────────────────────────
       ⛔⛔ The vault pins Relay's OLD 68-byte deposit and refuses anything else with
       `BadDepositData()`. Since Relay's v3 cutover that shape only comes back in waves, so this
       re-quotes into a window rather than signing a call the chain will reject. Skipping here is
       the SAFE direction: the money stays in the vault, attributed, and the next pass tries again. */
    /* ⛔ Searched HARD once per pass, then only glanced at. Whether Relay is offering the direct
       shape is a property of the ROUTE, not of the launch — every launch here quotes the same
       RHC→Base pair and differs only in amount. So once one six-minute search has come up empty,
       the rest take a single look each and hold. Otherwise five eligible launches would spend
       thirty minutes and 120 quotes re-asking a question already answered, which is exactly the
       load that had Relay refusing this keeper 195 times in two hours. */
    const fitted = await quoteThatFitsVault(l, amount, {
      vault: VAULT, depositor, isNative, first: q,
      attempts: routeShut ? 1 : FIT_ATTEMPTS,
    })
    const ready = fitted.quote
    if (!ready) {
      routeShut = true
      console.log(`${l.token}  ⏸ held this pass: ${fitted.fit.reason}`)
      continue
    }
    /* ⭐ A window is open after all — later launches may search hard again. */
    routeShut = false

    if (quoteIsStale(ready)) throw new Error('the quote went stale between fetching and signing')

    /*
      ⛔⛔ STOP STARTING DELIVERIES BEFORE SYSTEMD STOPS THE PASS.

      `TimeoutStartSec` SIGTERMs the pass, and a kill between the bridge and the donation is the one
      that costs a delivery its attribution. Passes used to fit easily; once the floor came down to
      $5 a single pass began making dozens of deliveries — 42 in one stretch, ~19s each — and it
      overran and was killed at 20:13:32 on 30 Aug.

      ➤ A delivery already begun always finishes; this only refuses to START another once the pass
      has used most of its budget. The rest of the queue is not lost, it is simply next pass's, and
      the ordering already puts the largest owed first so nothing starves.
    */
    if (Date.now() - PASS_STARTED_AT > PASS_BUDGET_MS * 0.7) {
      console.log(`⏹ stopping here: ${Math.round((Date.now() - PASS_STARTED_AT) / 1000)}s used of this pass's budget, the rest go next pass`)
      break
    }

    /* ── 6. the one signed step that moves money ─────────────────────────────────────────── */
    const remitHash = isNative
      ? await rhcWallet.writeContract({ address: VAULT, abi: VAULT_ABI, functionName: 'remitNative', args: [amount, ready.deposit.data] })
      : await rhcWallet.writeContract({ address: VAULT, abi: VAULT_ABI, functionName: 'remitToken', args: [l.remitAsset, amount, ready.deposit.data] })

    /*
      ⛔⛔ WRITTEN THE INSTANT THE TRANSACTION IS SUBMITTED, NOT AFTER IT CONFIRMS.

      This used to be recorded after `waitForTransactionReceipt`, which left a window of seconds in
      which the money had left the vault and NOTHING on disk said whose it was. A restart in that
      window is unrecoverable from chain: `Remitted` carries the PAIR ASSET, not the launch, so an
      orphaned delivery can only be traced by reading the keeper's own sweep and harvest calls
      either side of it on a block explorer.

      ⚠ It happened. A `systemctl stop` mid-pass on 29 Aug 2026 lost 0.0157 ETH of attribution, the
      $38.13 that arrived from it blocked every donation behind it, and recovering it took the
      distributor address out of the two transactions before the remit.

      ➤ A record written before a revert is the harmless direction: `settlePending` does nothing
      when the payer is empty, and the stale window releases the row. A record written too late is
      the one that strands money.
    */
    ledger.remitted[l.token.toLowerCase()] = (already + amount).toString()
    ledger.pending = {
      token: l.token, charityId: l.charityId, amount: amount.toString(),
      requestId: ready.requestId, bridgedAtMs: Date.now(),
    }
    await saveLedger()
    await rhcClient.waitForTransactionReceipt({ hash: remitHash })
    console.log(`${l.token}  bridged ${formatUnits(amount, d)} -> request ${ready.requestId}`)

    /* ⚠ The remitted total and the pending record were written together above, before this wait,
       because they are one fact: "this much left the vault for this charity and has not been
       donated yet". Recording the amount without recording whose it is produces exactly the
       misdirection the payer gate exists to refuse. */

    /* ── 7. wait for it to land, then donate ────────────────────────────────────────────── */
    let landed = false
    for (let i = 0; i < 40; i++) {
      /* ⛔ A DELTA against the balance measured before the bridge, never `> 0`. On a shared,
         all-or-nothing payer "there is money here" is not the same question as "my money landed". */
      if (hasArrived(balanceBefore, await usdcAtPayer())) { landed = true; break }
      await new Promise((r) => setTimeout(r, 3000))
    }
    if (!landed) {
      console.log(`${l.token}  ⚠ nothing arrived at the payer within two minutes. It is not lost:`)
      console.log(`     anyone can call payer.pay once it lands, and request ${ready.requestId}`)
      console.log('     resolves through Relay to the address it actually paid. The pending record')
      console.log('     is saved, so the next pass donates it to this launch and no other.')
      /* ⛔⛔ `break`, not `continue`. Continuing was the bug: the next launch would bridge on top of
         this one's in-flight delivery, and its `pay` would donate BOTH to its own charity. */
      break
    }

    /* ⛔ `break` on a failed pay. This launch's money is at the payer and undonated; the next launch
       bridging on top of it would put both into one `pay`. */
    if (await settlePending(ledger.pending!) === 'reverted') break
    } catch (err) {
      /* ⚠ Logged with the launch, so a recurring failure on ONE token is visible as that rather than
         as generic flakiness. Not rethrown: the pass continues with the launches after it. */
      console.log(`${l.token}  ⚠ skipped this pass: ${String(err?.shortMessage ?? err?.message ?? err).slice(0, 140)}`)
      continue
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}
