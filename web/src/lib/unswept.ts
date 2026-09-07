import { encodeAbiParameters, keccak256, parseAbi, type Address, type Hex } from 'viem'
import { publicClient } from './chain.ts'
import { PONS_FACTORY } from './launchpad.ts'

/**
 * Fees that a launch has earned but that are NOT in the escrow yet.
 *
 * ## ⛔⛔ THE ESCROW IS THE SECOND HOP, AND THE CLAIM PAGE ONLY EVER READ THE SECOND HOP
 *
 * Pons pays creator fees in **two** steps, and this site knew about one of them:
 *
 * 1. Fees accrue **on the curve**, or after graduation **in the meme hook**, as a pending balance.
 * 2. A **sweep** splits them and credits the shared fee escrow.
 * 3. `harvest` claims the escrow and releases both sides.
 *
 * `CharityDistributor.pending()` reads the escrow, so it answers step 3's question. On a launch
 * whose fees are still sitting at step 1 it returns a truthful, useless **zero** — and the claim
 * page rendered that zero as "In the escrow 0 ETH", greyed its button to "Nothing to collect", and
 * gave a launcher with real earnings a control that does nothing when pressed and says nothing
 * about why.
 *
 * ⛔⛔ $CHARITY hit exactly this. It **graduated**, so its curve is dead and the site's only sweep
 * path — `sweepCurve` — reverts. Nothing on the site or in the keeper has ever called `sweepPool`,
 * so every fee it earned after graduating has sat in the hook, invisible, while the page reported
 * nothing to collect.
 *
 * ➤ So this module reads where the money actually is, in both places, and says whether we can move
 * it. A figure the site cannot act on is still worth showing: "0.16 ETH waiting on Pons's sweep
 * operator" is a true answer to the question the launcher is asking. "Nothing to collect" is not.
 */

const FACTORY_ABI = parseAbi([
  'function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))',
  /** ⚠ The hook a graduated pool is keyed by. Without it the pool id cannot be derived at all. */
  'function memeHook() view returns (address)',
])

const CURVE_ABI = parseAbi([
  'function protocolFeeShareBps() view returns (uint16)',
  /* ⛔⛔ THREE BALANCES, NOT ONE. The plain fee is split with Pons, the creator tax is NOT, and a
     pending buyback is carved out of the creator's side. Reading only `quoteFeeBalance` — which is
     what `bountyNow()`-style helpers do elsewhere — under-reports a taxed launch by more than half.
     @see splitCreatorShare */
  'function quoteFeeBalance() view returns (uint256)',
  'function creatorTaxBalance() view returns (uint256)',
  'function buybackQuoteBalance() view returns (uint256)',
])

const HOOK_ABI = parseAbi([
  'function launches(bytes32 poolId) view returns (bool registered, bool memecoinIsCurrency0, address memecoin, address quoteToken, address creator, address buybackCreatorRecipient, address protocolFeeRecipient, uint16 creatorTaxBps, uint16 protocolFeeShareBps, uint16 buybackBurnBps, uint16 hookFeeBps, uint16 maxInternalPriceImpactBps, bool buybackEnabled)',
  'function pendingFees(bytes32 poolId, address currency) view returns (uint256)',
  'function pendingCreatorTax(bytes32 poolId, address currency) view returns (uint256)',
  'function pendingBuyback(bytes32 poolId, address currency) view returns (uint256)',
])

/** 0 trading on the curve · 1 swept but the pool is NOT seeded yet · 2 trading in the V4 pool. */
export const PHASE = { onCurve: 0, swept: 1, poolCreated: 2 } as const

/**
 * ⛔ Raised by the hook when a sweep would have to run an internal swap. Only Pons's rotatable
 * `feeSweepOperator` may do that, so the fee recipient — this site's distributor — cannot.
 *
 * Confirmed by simulating `sweepPoolFees` on $CHARITY's live pool as three different callers:
 * a stranger got `NotFeeSweepOperator()` (`0x8d42130c`), the distributor got this, so the
 * distributor is past the authorisation gate and stopped by the swap rule specifically.
 */
export const INTERNAL_SWAP_REQUIRES_OPERATOR = '0x31cdb504'
const NOT_FEE_SWEEP_OPERATOR = '0x8d42130c'

export type Unswept = {
  /** Where the money is. `none` covers a launch that has genuinely earned nothing anywhere. */
  where: 'curve' | 'pool' | 'none'
  /** 0 / 1 / 2, or null when the factory record could not be read. @see PHASE */
  phase: number | null
  /** The curve, for `sweepCurve`. Zero-address when there is none to sweep. */
  curve: Address | null
  /** The hook and pool id, for `sweepPool`. Null unless the pool exists AND is registered. */
  pool: { hook: Address; poolId: Hex } | null
  /**
   * What a sweep right now would credit the distributor, in the pair asset's own units.
   *
   * ⚠ The CREATOR's share, not the gross fee: Pons keeps `protocolFeeShareBps` of the plain fee.
   * Showing the gross would promise a number that never arrives.
   */
  creatorShare: bigint
  /**
   * Fees denominated in the memecoin, waiting in the pool. **Not** in the pair asset's units and
   * never added to `creatorShare` — it is the reason a sweep may be operator-only.
   */
  memePending: bigint
  /** False when only Pons's operator can run this sweep. @see INTERNAL_SWAP_REQUIRES_OPERATOR */
  weMaySweep: boolean
}

/* ⛔ THERE IS NO `note` HERE ANY MORE. It carried a paragraph of mechanism into the claim row, and
   the row reads better with the button alone — `Paid automatically` answers the launcher's actual
   question. The strings were still being computed and shipped in the bundle after the markup that
   rendered them was deleted, which is how dead copy survives a removal. The mechanism is documented
   at the top of this file, for a reader, rather than assembled at runtime for nobody. */

export const NOTHING_UNSWEPT: Unswept = {
  where: 'none', phase: null, curve: null, pool: null,
  creatorShare: 0n, memePending: 0n, weMaySweep: false,
}

/**
 * The Uniswap V4 pool id a graduated launch trades in.
 *
 * ⚠⚠ V4 has no registry to ask, so this reproduces `PoolKey.toId()` —
 * `keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks))`. A derivation that is
 * quietly wrong reads `pendingFees` on a pool that does not exist and gets a confident **zero**,
 * which is indistinguishable from "no fees" and is the worst possible failure for this number.
 *
 * ⭐ So it is never trusted on its own: {@link readUnswept} checks the id back against
 * `hook.launches(poolId)` and uses it only when that comes back registered AND naming this exact
 * memecoin.
 */
export function poolIdFor(args: {
  token: Address; pairToken: Address; poolFee: number; tickSpacing: number; hook: Address
}): Hex {
  // Currencies are sorted, and native ETH is address(0), so it is always currency0 on a native pair.
  const [c0, c1] = args.pairToken.toLowerCase() < args.token.toLowerCase()
    ? [args.pairToken, args.token]
    : [args.token, args.pairToken]
  return keccak256(encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
    [c0, c1, args.poolFee, args.tickSpacing, args.hook],
  ))
}

/**
 * What a sweep would actually credit the fee recipient, from the three pending balances.
 *
 * ```
 * protocol = fee * protocolFeeShareBps / 10000     // Pons's cut of the plain fee
 * creator  = fee - protocol - buyback + tax        // ⭐ the creator TAX is not split
 * ```
 *
 * ⭐ Exported and pure so the arithmetic is tested rather than inferred from a screenshot. It is
 * the same shape in the curve and in the pool, which is why one function serves both.
 */
export function splitCreatorShare(
  fee: bigint, tax: bigint, buyback: bigint, protocolFeeShareBps: number,
): bigint {
  if (fee < 0n) return 0n
  const bps = BigInt(Math.max(0, Math.min(10_000, protocolFeeShareBps)))
  const bucket = fee - (fee * bps) / 10_000n
  /* ⚠ Clamped rather than subtracted blind. The buyback is carved out of the creator's bucket, so
     a buyback larger than the bucket would make this negative and render as a nonsense figure. */
  const afterBuyback = buyback > bucket ? 0n : bucket - buyback
  return afterBuyback + tax
}

/** ⚠ Both viem and raw RPC bury the revert data at different depths. Look everywhere for it. */
function revertData(e: unknown): string {
  const seen = new Set<unknown>()
  let cur: unknown = e
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur)
    const d = (cur as { data?: unknown }).data
    if (typeof d === 'string' && d.startsWith('0x')) return d.toLowerCase()
    if (typeof d === 'object' && d && typeof (d as { data?: unknown }).data === 'string') {
      return ((d as { data: string }).data).toLowerCase()
    }
    cur = (cur as { cause?: unknown }).cause
  }
  return ''
}

/**
 * Whether the revert says "only Pons may run this", rather than any other failure.
 *
 * ⛔ Matched on the selector, never on the message text. viem renders an unknown custom error as
 * raw hex with no name, so a string match would silently classify every operator-only sweep as an
 * unknown error and put the misleading generic message back.
 */
export function isOperatorOnly(e: unknown): boolean {
  const d = revertData(e)
  return d.startsWith(INTERNAL_SWAP_REQUIRES_OPERATOR) || d.startsWith(NOT_FEE_SWEEP_OPERATOR)
}

/**
 * Read where one launch's unswept fees are.
 *
 * ⚠ Never throws. Every read is caught, because this hangs off a page whose primary job — showing
 * the escrow balance — must still render when the factory or the hook cannot be reached.
 */
export async function readUnswept(launch: {
  token: Address; pairToken: Address
}): Promise<Unswept> {
  const [record, hook] = await Promise.all([
    publicClient
      .readContract({ address: PONS_FACTORY, abi: FACTORY_ABI, functionName: 'getLaunchedToken', args: [launch.token] })
      .catch(() => null),
    publicClient
      .readContract({ address: PONS_FACTORY, abi: FACTORY_ABI, functionName: 'memeHook' })
      .catch(() => null),
  ])
  if (!record || !record.exists) return NOTHING_UNSWEPT

  const phase = Number(record.phase)
  const curve = record.curve

  /* ── still on the curve ────────────────────────────────────────────────────────────────── */
  if (phase === PHASE.onCurve) {
    const [bps, fee, tax, buyback] = await Promise.all([
      publicClient.readContract({ address: curve, abi: CURVE_ABI, functionName: 'protocolFeeShareBps' }).catch(() => 3000),
      publicClient.readContract({ address: curve, abi: CURVE_ABI, functionName: 'quoteFeeBalance' }).catch(() => 0n),
      publicClient.readContract({ address: curve, abi: CURVE_ABI, functionName: 'creatorTaxBalance' }).catch(() => 0n),
      publicClient.readContract({ address: curve, abi: CURVE_ABI, functionName: 'buybackQuoteBalance' }).catch(() => 0n),
    ])
    const creatorShare = splitCreatorShare(fee as bigint, tax as bigint, buyback as bigint, Number(bps))
    if (creatorShare === 0n && (buyback as bigint) === 0n) return { ...NOTHING_UNSWEPT, phase, curve }
    /* ⚠ A pending buyback needs a swap, which is operator-only on the curve too. Launches made here
       disable the buyback, so this is defensive rather than the normal case. */
    const weMaySweep = (buyback as bigint) === 0n
    return { where: 'curve', phase, curve, pool: null, creatorShare, memePending: 0n, weMaySweep }
  }

  /* ── swept off the curve, but nobody has seeded the pool ───────────────────────────────── */
  if (phase === PHASE.swept) {
    return { ...NOTHING_UNSWEPT, phase, curve }
  }

  /* ── trading in the V4 pool ────────────────────────────────────────────────────────────── */
  if (!hook) return { ...NOTHING_UNSWEPT, phase, curve }
  const poolId = poolIdFor({
    token: launch.token,
    pairToken: launch.pairToken,
    poolFee: Number(record.poolFee),
    tickSpacing: Number(record.tickSpacing),
    hook: hook as Address,
  })

  /* ⚠⚠ The guard on the derivation. `pendingFees` on an id that does not exist returns zero rather
     than reverting, so an id that is subtly wrong reports "no fees" and looks exactly like the
     truth. Only a registered pool naming THIS memecoin is believed. */
  const info = await publicClient
    .readContract({ address: hook as Address, abi: HOOK_ABI, functionName: 'launches', args: [poolId] })
    .catch(() => null)
  if (!info || info[0] !== true || info[2].toLowerCase() !== launch.token.toLowerCase()) {
    return { ...NOTHING_UNSWEPT, phase, curve }
  }

  const [qFee, qTax, qBuy, mFee, mTax, mBuy] = await Promise.all(
    ([[launch.pairToken, 'pendingFees'], [launch.pairToken, 'pendingCreatorTax'], [launch.pairToken, 'pendingBuyback'],
      [launch.token, 'pendingFees'], [launch.token, 'pendingCreatorTax'], [launch.token, 'pendingBuyback']] as const)
      .map(([currency, fn]) => publicClient
        .readContract({ address: hook as Address, abi: HOOK_ABI, functionName: fn, args: [poolId, currency] })
        .catch(() => 0n)),
  )

  /* ⚠ The pool's own frozen share, read off `launches`, not the factory's current global. A launch
     keeps the split it registered with. */
  const creatorShare = splitCreatorShare(qFee, qTax, qBuy, Number(info[8]))
  const memePending = mFee + mTax + mBuy

  if (creatorShare === 0n && memePending === 0n && qBuy === 0n) {
    return { ...NOTHING_UNSWEPT, phase, curve, pool: { hook: hook as Address, poolId } }
  }

  /* ⛔⛔ Mirrors the hook's own `_requiresTrustedOperator` rather than restating it loosely: a
     pending buyback needs a swap, and so does ANY fee sitting in the memecoin, because it has to be
     converted to the quote asset before it can be credited. Either one makes the whole sweep
     operator-only — including the ETH leg that would otherwise have been ours to move. */
  const needsSwap = qBuy > 0n || memePending > 0n
  return {
    where: 'pool', phase, curve, pool: { hook: hook as Address, poolId },
    creatorShare, memePending, weMaySweep: !needsSwap,
  }
}
