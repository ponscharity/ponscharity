import { keccak256, encodeAbiParameters, parseAbi, type Address, type Hex } from 'viem'
import { publicClient } from './chain.ts'
import { NATIVE, USDG } from './pairs.ts'

/**
 * What one unit of a pair asset is worth in USD, read from Uniswap V4 on Robinhood Chain.
 *
 * ## ⛔⛔ WHY THE MARKET CAP IS IN DOLLARS AND NOT IN ETHER
 *
 * A cap shown as "1.68 ETH" is not a market cap, it is a reserve balance wearing one. Nobody reads
 * a token's size in ether, two tokens paired against different assets cannot be compared at a
 * glance, and the number moves when ETH moves even though nothing about the token changed. Pons's
 * own feed reports `marketCapUsd`, and this has been got wrong here before.
 *
 * ➤ So every cap on this site is converted to USD, and a cap that cannot be converted shows a dash
 * rather than a figure in whatever unit happened to be available.
 *
 * ## ⭐⭐ THE RATE COMES FROM THE CHAIN, NOT FROM AN API
 *
 * USDG is the dollar here. Reading the asset's USDG pool out of the V4 singleton's storage keeps
 * this site what it is: a static page that reads the chain in the visitor's browser, with no key,
 * no backend and no third party that can rate limit it or go down. It is the same derivation
 * `V4Seller.poolState` uses on chain, reproduced exactly.
 *
 * ## ⛔⛔ AN INITIALISED POOL IS NOT A LIQUID POOL
 *
 * Measured on live RHC: MSTR/USDG is initialised at `fee=100` holding ZERO liquidity, and GME/USDG
 * is initialised at `fee=3000` with nothing in it while trading at `fee=10000`. `sqrtPriceX96` is
 * non zero in all of those, so a reader that stops at "the pool exists" gets a confident price off
 * an empty book. Every tier is read and the DEEPEST one wins; if none holds liquidity the answer is
 * null.
 */

const POOL_MANAGER = '0x8366a39CC670B4001A1121B8F6A443A643e40951' as Address
/** `Pool.State[] _pools` is slot 6 on the singleton. Matches `V4Seller.POOLS_SLOT`. */
const POOLS_SLOT = 6n
const Q96 = 2n ** 96n
const ZERO_HOOK = '0x0000000000000000000000000000000000000000' as Address

const EXTSLOAD_ABI = parseAbi(['function extsload(bytes32 slot) view returns (bytes32)'])

/** The standard tiers, and their tick spacings. All four are initialised for ETH/USDG on this chain. */
const TIERS: readonly (readonly [number, number])[] = [[100, 1], [500, 10], [3000, 60], [10000, 200]]

/** ⚠ Reproduces `PoolKey.toId()`. Currencies are sorted, and native ETH is address(0) so it is
 *  always currency0. The hook is the zero address: these are plain pools with no hook. */
export function poolIdFor(a: Address, b: Address, fee: number, tickSpacing: number): Hex {
  const [c0, c1] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a]
  return keccak256(encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
    [c0, c1, fee, tickSpacing, ZERO_HOOK],
  ))
}

export const poolStateSlot = (id: Hex): Hex =>
  keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [id, POOLS_SLOT]))

/**
 * USD per ONE WHOLE unit of `asset`, scaled by 1e6 so it stays an exact integer.
 *
 * ⛔⛔ `sqrtPriceX96` SQUARED overflows uint256 on chain and loses precision as a float here, which
 * is why this is bigint throughout and why the scaling is applied before the division rather than
 * after. `(sq/2^96)^2` is `amount1/amount0` in the two currencies' BASE units, so the asset's own
 * decimals have to be put back in and USDG's six taken out. Getting that backwards is a price out
 * by a factor of a trillion that still looks like a number.
 */
export function usdPerUnitScaled(
  sqrtPriceX96: bigint, assetIsCurrency0: boolean, assetDecimals: number,
): bigint | null {
  if (sqrtPriceX96 <= 0n) return null
  const sq = sqrtPriceX96 * sqrtPriceX96
  const one = 10n ** BigInt(assetDecimals)
  /* asset is currency0: price = usdgBase per assetBase, so a whole asset is price * 10^assetDec.
     asset is currency1: the ratio is the other way up, so invert. */
  const scaled = assetIsCurrency0 ? (sq * one) / (Q96 * Q96) : (Q96 * Q96 * one) / sq
  return scaled > 0n ? scaled : null
}

/** ⛔ USD per whole USDG is exactly one. USDG is the unit this whole file measures in. */
const USDG_SCALED = 1_000_000n

const cache = new Map<string, bigint | null>()
const inflight = new Map<string, Promise<bigint | null>>()

async function readTier(asset: Address, decimals: number, fee: number, ts: number) {
  const base = poolStateSlot(poolIdFor(asset, USDG, fee, ts))
  const liquiditySlot = `0x${(BigInt(base) + 3n).toString(16).padStart(64, '0')}` as Hex
  const [slot0, liq] = await Promise.all([
    publicClient.readContract({ address: POOL_MANAGER, abi: EXTSLOAD_ABI, functionName: 'extsload', args: [base] }),
    publicClient.readContract({ address: POOL_MANAGER, abi: EXTSLOAD_ABI, functionName: 'extsload', args: [liquiditySlot] }),
  ])
  const sqrtPriceX96 = BigInt(slot0) & ((1n << 160n) - 1n)
  const liquidity = BigInt(liq) & ((1n << 128n) - 1n)
  return { sqrtPriceX96, liquidity }
}

/**
 * USD per one whole unit of the asset, scaled by 1e6, or null when nothing can price it.
 *
 * ⚠ Cached per asset for the life of the page. Two dashboards and a dozen rows share at most a
 * handful of distinct pair assets, and each one is four `eth_call`s.
 */
export async function usdPerAsset(asset: Address, decimals: number): Promise<bigint | null> {
  const key = asset.toLowerCase()
  if (key === USDG.toLowerCase()) return USDG_SCALED
  if (cache.has(key)) return cache.get(key)!
  const running = inflight.get(key)
  if (running) return running

  const job = (async () => {
    try {
      const states = await Promise.all(TIERS.map(([fee, ts]) => readTier(asset, decimals, fee, ts).catch(() => null)))
      /* ⛔ The DEEPEST tier, not the first that answers. A thin book prices off almost nothing and
         the reading is indistinguishable from a real one. */
      let best: { sqrtPriceX96: bigint; liquidity: bigint } | null = null
      for (const s of states) {
        if (!s || s.sqrtPriceX96 === 0n || s.liquidity === 0n) continue
        if (!best || s.liquidity > best.liquidity) best = s
      }
      if (!best) return null
      const assetIsCurrency0 = asset.toLowerCase() < USDG.toLowerCase()
      return usdPerUnitScaled(best.sqrtPriceX96, assetIsCurrency0, decimals)
    } catch {
      return null
    }
  })().then((v) => { cache.set(key, v); return v }).finally(() => { inflight.delete(key) })

  inflight.set(key, job)
  return job
}

export const isNativeAsset = (a: string) => a.toLowerCase() === NATIVE.toLowerCase()
