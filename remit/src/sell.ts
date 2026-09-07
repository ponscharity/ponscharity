import { parseAbi, type Address, type PublicClient } from 'viem'

/**
 * Turning a tokenized-stock fee into something that can actually leave Robinhood Chain.
 *
 * Relay refuses all 21 tokenized equities off RHC, so a fee earned in AAPL is sold into USDG on the
 * Uniswap V4 singleton first and bridged as USDG. `CharityDistributor.sellAllForUsdg` does the swap;
 * this module decides WHICH POOL and WHAT FLOOR, which are the two things the contract cannot work
 * out for itself.
 */

/**
 * ⛔⛔ THE TIER IS NEVER ASSUMED. Verified on chain 28 Aug 2026: AAPL, SPY and NVDA are deepest at
 * `fee=3000, ts=60`; GME and COIN at `fee=10000, ts=200`; NVDA alone is initialised at all four.
 * There is no tier that is right for every stock, and a hardcoded 3000 would quietly route GME
 * through a shallower pool for the life of the service.
 *
 * ⚠⚠ "A POOL EXISTS" IS NOT THE TEST, and neither is "the deepest tier". Measured on a fork of
 * live RHC: MSTR/USDG is initialised only at `fee=100` and holds zero liquidity; GME/USDG is
 * initialised at `fee=3000` with zero liquidity and really trades only at `fee=10000`. The only
 * test that means anything is what a simulated sell actually returns.
 */
export const CANDIDATE_TIERS: ReadonlyArray<{ fee: number; tickSpacing: number }> = [
  { fee: 100, tickSpacing: 1 },
  { fee: 500, tickSpacing: 10 },
  { fee: 3000, tickSpacing: 60 },
  { fee: 10000, tickSpacing: 200 },
]

export type TierResult = {
  fee: number
  tickSpacing: number
  /** USDG out for the whole balance, from a simulation. `null` when the tier reverted. */
  out: bigint | null
  error?: string
}

export type TierChoice =
  | { ok: true; fee: number; tickSpacing: number; out: bigint; reason: string }
  | { ok: false; reason: string }

/**
 * Pick the tier that actually fills best.
 *
 * ⭐ Chosen by SIMULATED OUTPUT, not by the `liquidity` reading. Liquidity in a concentrated-range
 * pool says nothing about depth at the current price — a pool can report a large L with all of it
 * parked in ranges the trade never touches. The number that matters is what a real sell returns,
 * and a simulation gives exactly that including the LP fee and the price impact.
 */
export function pickTier(results: readonly TierResult[]): TierChoice {
  const live = results.filter((r): r is TierResult & { out: bigint } => r.out !== null && r.out > 0n)
  if (live.length === 0) {
    const why = results.map((r) => `${r.fee}: ${r.error ?? 'returned zero'}`).join('; ')
    return { ok: false, reason: `no tier could sell this — ${why}` }
  }
  const best = live.reduce((a, b) => (b.out > a.out ? b : a))
  const runnerUp = live.filter((r) => r !== best).sort((a, b) => (b.out > a.out ? 1 : -1))[0]
  return {
    ok: true,
    fee: best.fee,
    tickSpacing: best.tickSpacing,
    out: best.out,
    reason: runnerUp
      ? `fee=${best.fee} returns ${best.out}, ${(((Number(best.out) - Number(runnerUp.out)) / Number(runnerUp.out)) * 100).toFixed(2)}% better than fee=${runnerUp.fee}`
      : `fee=${best.fee} is the only tier with depth`,
  }
}

/**
 * The floor to send with the sell, learned by simulating first.
 *
 * ## 🔴🔴 THE SAME RULE THE CRANKER LEARNED, AND IT MATTERS MORE HERE
 *
 * `floorFor` in the cranker exists because a bot sending `minTokensOut = 0` on a timer is a standing
 * invitation to be front-run. `sellForUsdg` is *permissionless*, so an attacker does not even have
 * to wait for our timer — the contract's own spot floor is what stops them, and it is deliberately
 * loose (2%) because it is a backstop against a hostile caller, not an execution target.
 *
 * ➤ So the service must pass something far tighter than the contract's floor. A simulation in the
 * pending block returns the exact fill; the tolerance covers only what can move between the call and
 * the block landing.
 */
export function minOutFor(simulated: bigint, toleranceBps = 50): bigint {
  if (simulated <= 0n) return 0n
  return (simulated * (10_000n - BigInt(toleranceBps))) / 10_000n
}

/**
 * Whether selling is worth the gas at all.
 *
 * ⚠ In USD on both sides, because the quote and the gas can both be priced — the mixed-unit problem
 * the cranker has to skip around does not arise. ⛔ A sale worth less than the gas is not a small
 * loss, it is the charity paying to destroy its own donation.
 */
export function worthSelling(
  usdgOutUsd: number,
  gasUsd: number,
  marginBps = 15_000,
): { sell: boolean; reason: string } {
  const needed = (gasUsd * marginBps) / 10_000
  if (usdgOutUsd < needed) {
    return { sell: false, reason: `$${usdgOutUsd.toFixed(2)} of USDG is under the $${needed.toFixed(2)} it needs to be worth $${gasUsd.toFixed(2)} of gas` }
  }
  return { sell: true, reason: `$${usdgOutUsd.toFixed(2)} of USDG against $${gasUsd.toFixed(2)} of gas` }
}

/* ---------------------------------------------------------------- tranching -- */

/**
 * ⛔⛔ A THIN POOL HAS A CEILING AND SELLING THE WHOLE BALANCE JUST FAILS.
 *
 * Measured on a fork of live RHC: GME/USDG at `fee=10000` fills 0.1, 0.5, 1 and 5 shares fine at
 * about $17.90 a share, and REFUSES 20 — not because the pool is empty, but because the price
 * impact exceeds the tolerance the contract will accept. AAPL, SPY and NVDA took their whole test
 * balances without complaint, so this is per-pool and cannot be a constant.
 *
 * ➤ A service that tries the full balance, catches the revert and moves on **sells nothing, for
 * ever, while every log line reads normally** — the silent-skip failure this repo keeps rediscovering.
 * So the size is searched for, and what will not fit in one trade is sold across several.
 */
export type Tranches = { size: bigint; count: number; remainder: bigint }

/**
 * The largest size that still fills, by binary search over a predicate the caller supplies (a
 * simulation).
 *
 * ⚠ Bounded at `maxProbes`, and returns the largest size KNOWN to work rather than the true
 * boundary. Each probe is an `eth_call` against a forked or live node; hunting the exact wei is
 * paying real latency for a number that changes with the next trade anyway.
 *
 * ⛔ Returns `0n` when even the smallest probe fails. That is a real answer — the pool cannot take
 * anything right now — and the caller must report it, never retry it in a tight loop.
 */
export async function findMaxTranche(
  balance: bigint,
  fits: (size: bigint) => Promise<boolean>,
  maxProbes = 8,
): Promise<bigint> {
  if (balance <= 0n) return 0n
  if (await fits(balance)) return balance

  let lo = 0n
  let hi = balance
  for (let i = 0; i < maxProbes && hi - lo > 1n; i++) {
    const mid = lo + (hi - lo) / 2n
    if (mid === lo) break
    if (await fits(mid)) lo = mid
    else hi = mid
  }
  return lo
}

/**
 * How a balance gets sold, given the largest single trade the pool will take.
 *
 * ⚠ The remainder is reported separately rather than folded into a final partial tranche, because a
 * dust remainder is usually not worth its own transaction and that is the caller's decision to make.
 */
export function sizeTranches(balance: bigint, maxTranche: bigint): Tranches {
  if (maxTranche <= 0n) return { size: 0n, count: 0, remainder: balance }
  const count = Number(balance / maxTranche)
  return { size: maxTranche, count, remainder: balance % maxTranche }
}

/* ----------------------------------------------------------------- on chain -- */

export const DISTRIBUTOR_ABI = parseAbi([
  'function sellAllForUsdg(address stock, uint24 fee, int24 tickSpacing, uint256 minOut) returns (uint256)',
  'function quoteSpot(address stock, uint24 fee, int24 tickSpacing, uint256 amountIn) view returns (uint256)',
  'function poolState(address stock, uint24 fee, int24 tickSpacing) view returns (uint160 sqrtPriceX96, uint128 liquidity)',
  'function maxSellSlippageBps() view returns (uint16)',
  'function harvestMany(address[] assets)',
  'function pending(address asset) view returns (uint256)',
])

/**
 * Simulate the sell at every candidate tier and report what each would return.
 *
 * ⚠⚠ Simulated with `minOut` set to the CONTRACT'S OWN floor, not to zero and not to a guess. Zero
 * is rejected by `SlippageTooLoose` before the swap ever runs, so a simulation at zero would report
 * every tier as dead and the service would conclude the stock is unsellable — a total, silent
 * failure that looks exactly like an illiquid market.
 */
export async function probeTiers(
  client: PublicClient,
  distributor: Address,
  stock: Address,
  balance: bigint,
  caller: Address,
): Promise<TierResult[]> {
  const maxSlip = await client.readContract({
    address: distributor, abi: DISTRIBUTOR_ABI, functionName: 'maxSellSlippageBps',
  })

  return Promise.all(
    CANDIDATE_TIERS.map(async ({ fee, tickSpacing }): Promise<TierResult> => {
      try {
        const spot = await client.readContract({
          address: distributor, abi: DISTRIBUTOR_ABI, functionName: 'quoteSpot',
          args: [stock, fee, tickSpacing, balance],
        })
        const floor = (spot * (10_000n - BigInt(maxSlip))) / 10_000n
        const { result } = await client.simulateContract({
          address: distributor, abi: DISTRIBUTOR_ABI, functionName: 'sellAllForUsdg',
          args: [stock, fee, tickSpacing, floor], account: caller,
        })
        return { fee, tickSpacing, out: result as bigint }
      } catch (e) {
        /* ⭐ `PoolNotInitialised` and `NoLiquidity` are the expected answers for most tiers of most
           stocks, not errors worth waking anyone for. They are recorded so `pickTier` can say WHY
           nothing worked when nothing works — a silent skip is how a stock quietly never sells. */
        return { fee, tickSpacing, out: null, error: (e as Error).message.split('\n')[0].slice(0, 80) }
      }
    }),
  )
}
