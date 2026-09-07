import { encodeAbiParameters, keccak256, parseAbi, type Address, type Hex, type PublicClient } from 'viem'

/**
 * Sweeping a launch that has GRADUATED.
 *
 * ## ⛔⛔ THE KEEPER ONLY EVER SWEPT CURVES, AND THAT IS HALF THE LIFE OF A LAUNCH
 *
 * Fees accrue on a launch's bonding curve until it graduates. After that the curve is dead, its
 * `sweepFees` reverts, and every further fee accrues **in the meme hook** against the launch's
 * Uniswap V4 pool. Moving those needs `sweepPoolFees`, which the distributor exposes as
 * `sweepPool` — and nothing in this service, or on the website, ever called it.
 *
 * 🔴🔴 So a graduated launch silently stopped being harvested. Its escrow stayed empty, `pending`
 * kept answering zero, the keeper's per-launch pass found nothing to do every fifteen minutes, and
 * the claim page reported "Nothing to collect". $CHARITY — this launchpad's largest earner — sat in
 * exactly that state with real ETH accruing in the hook.
 *
 * ⚠ Nothing was lost: the fees stay in the hook, and Pons's own sweep operator can move them at any
 * time. But nothing on our side was moving them, and nothing on our side could see them.
 *
 * ## ⛔ WHO MAY SWEEP, AND WHY THE ANSWER CHANGES WITH THE POOL'S CONTENTS
 *
 * The hook allows either Pons's rotatable `feeSweepOperator` or the launch's fee recipient — which
 * is the distributor — **except** when the sweep would have to run an internal swap, which is
 * operator-only. In a pool that means a pending buyback OR any fee that accrued denominated in the
 * memecoin, because those have to be converted to the quote asset first.
 *
 * ➤ Which is read here rather than guessed at, because guessing costs a reverted transaction's gas
 * every pass, forever, on a launch that is trading well enough to have earned the fees.
 */

const FACTORY_ABI = parseAbi([
  'function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))',
  'function memeHook() view returns (address)',
])

const HOOK_ABI = parseAbi([
  'function launches(bytes32 poolId) view returns (bool registered, bool memecoinIsCurrency0, address memecoin, address quoteToken, address creator, address buybackCreatorRecipient, address protocolFeeRecipient, uint16 creatorTaxBps, uint16 protocolFeeShareBps, uint16 buybackBurnBps, uint16 hookFeeBps, uint16 maxInternalPriceImpactBps, bool buybackEnabled)',
  'function pendingFees(bytes32 poolId, address currency) view returns (uint256)',
  'function pendingCreatorTax(bytes32 poolId, address currency) view returns (uint256)',
  'function pendingBuyback(bytes32 poolId, address currency) view returns (uint256)',
])

/** ⛔ The factory every launch here is made through. @see pons-v2-new-factory-launches-open */
export const PONS_FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e' as Address

/** 0 trading on the curve · 1 swept but the pool is NOT seeded · 2 trading in the V4 pool. */
export const PHASE = { onCurve: 0, swept: 1, poolCreated: 2 } as const

/**
 * The Uniswap V4 pool id a graduated launch trades in.
 *
 * ⚠⚠ V4 has no registry to ask, so this reproduces `PoolKey.toId()` —
 * `keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks))`. An id that is quietly
 * wrong reads `pendingFees` on a pool that does not exist and gets a confident **zero**, which is
 * indistinguishable from "nothing to sweep" and would reinstate the exact silence this module
 * exists to end. {@link readPoolSweep} therefore checks it back against `hook.launches()`.
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

export type PoolSweep = {
  /** Null when this launch is not trading in a pool, so the curve sweep is still the right one. */
  pool: { hook: Address; poolId: Hex } | null
  /** 0 / 1 / 2, or null when the factory record could not be read. @see PHASE */
  phase: number | null
  /** Quote-denominated fees waiting in the pool, gross of Pons's share. */
  quotePending: bigint
  /** Fees denominated in the MEMECOIN. ⛔ A different asset — never added to `quotePending`. */
  memePending: bigint
  /** False when only Pons's `feeSweepOperator` may run this sweep. */
  weMaySweep: boolean
  /** Plain-language reason, for the pass log. Empty when there is nothing to say. */
  note: string
}

export const NO_POOL_SWEEP: PoolSweep = {
  pool: null, phase: null, quotePending: 0n, memePending: 0n, weMaySweep: false, note: '',
}

/**
 * Whether a launch has pool fees, and whether we are allowed to move them.
 *
 * ⚠ Never throws. A pass that cannot reach the factory must still sweep the curves it can, so
 * every read is caught and an unreadable launch is reported as having no pool sweep rather than
 * taking the whole run down.
 */
export async function readPoolSweep(
  client: PublicClient,
  launch: { token: Address; pairToken: Address },
): Promise<PoolSweep> {
  const [record, hook] = await Promise.all([
    client.readContract({ address: PONS_FACTORY, abi: FACTORY_ABI, functionName: 'getLaunchedToken', args: [launch.token] })
      .catch(() => null),
    client.readContract({ address: PONS_FACTORY, abi: FACTORY_ABI, functionName: 'memeHook' }).catch(() => null),
  ])
  if (!record || !record.exists) return NO_POOL_SWEEP

  const phase = Number(record.phase)
  if (phase !== PHASE.poolCreated || !hook) return { ...NO_POOL_SWEEP, phase }

  const poolId = poolIdFor({
    token: launch.token,
    pairToken: launch.pairToken,
    poolFee: Number(record.poolFee),
    tickSpacing: Number(record.tickSpacing),
    hook: hook as Address,
  })

  /* ⚠⚠ The guard on the derivation. `pendingFees` on an unregistered id returns zero rather than
     reverting, so an id that is subtly wrong reports "no fees" — the failure that looks exactly
     like success. Only a registered pool naming THIS memecoin is believed. */
  const info = await client
    .readContract({ address: hook as Address, abi: HOOK_ABI, functionName: 'launches', args: [poolId] })
    .catch(() => null)
  if (!info || info[0] !== true || info[2].toLowerCase() !== launch.token.toLowerCase()) {
    return { ...NO_POOL_SWEEP, phase }
  }

  const [qFee, qTax, qBuy, mFee, mTax, mBuy] = await Promise.all(
    ([[launch.pairToken, 'pendingFees'], [launch.pairToken, 'pendingCreatorTax'], [launch.pairToken, 'pendingBuyback'],
      [launch.token, 'pendingFees'], [launch.token, 'pendingCreatorTax'], [launch.token, 'pendingBuyback']] as const)
      .map(([currency, fn]) => client
        .readContract({ address: hook as Address, abi: HOOK_ABI, functionName: fn, args: [poolId, currency] })
        .catch(() => 0n)),
  )

  const quotePending = qFee + qTax
  const memePending = mFee + mTax + mBuy

  /* ⛔⛔ Mirrors the hook's own `_requiresTrustedOperator` rather than restating it loosely. Either
     condition makes the WHOLE sweep operator-only, including the quote leg that would otherwise
     have been ours to move — so this is not a per-leg decision. */
  const needsSwap = qBuy > 0n || memePending > 0n
  return {
    pool: { hook: hook as Address, poolId },
    phase,
    quotePending,
    memePending,
    weMaySweep: !needsSwap && quotePending > 0n,
    note: quotePending === 0n && memePending === 0n
      ? ''
      : needsSwap
        ? qBuy > 0n
          ? 'a buyback is pending, so only Pons’s sweep operator can sweep this pool'
          : 'fees accrued in the token itself and must be converted first, so only Pons’s sweep operator can sweep this pool'
        : '',
  }
}
