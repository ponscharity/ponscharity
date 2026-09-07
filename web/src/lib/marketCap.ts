/**
 * A launch's market cap, computed from the bonding curve and denominated in its own pair asset.
 *
 * ## ⭐⭐ THE ARITHMETIC, AND WHY IT IS THIS SHAPE
 *
 * Pons V2's curve is constant product, so the spot price is `quoteReserve / tokenReserve` and the
 * market cap is that price times the whole supply. Written naively that is three divisions in
 * floating point over numbers well past 2^53. Written as one ratio it is exact:
 *
 * ```
 *   cap (pair base units) = quoteReserve * totalSupply / tokenReserve
 * ```
 *
 * ⭐ The token's own decimals CANCEL. `totalSupply` and `tokenReserve` are both in the token's base
 * units, so whatever that scale is, it divides out. Only the PAIR asset's decimals survive, and they
 * are already carried on the row for formatting. That is worth stating because the obvious version
 * of this function reads `decimals()` off the token and uses it, which is a read that can fail and a
 * number that cannot matter.
 *
 * ## ⛔⛔ THE PAIR ASSET'S DECIMALS DO NOT CANCEL, AND USDG IS 6
 *
 * `Number(quoteReserve) / Number(tokenReserve)` is a price only when the quote and the token share a
 * decimal scale. Against USDG that ratio is out by 1e12, and it is out SILENTLY: the figure is
 * plausible, positive, and wrong by a trillion. This is the same denomination blindness that has
 * been shipped before in this stack, where a bound written for one unit stayed in the old unit once
 * a second arrived. The result here is in the pair's base units and is formatted with the pair's
 * decimals, never the token's.
 *
 * ## ⚠⚠ THE PHANTOM RESERVE BELONGS IN THE PRICE
 *
 * `quoteReserve` includes the curve's phantom quote, which is virtual and not real money. It is
 * correct to leave it in here, because the curve genuinely prices against it: a launch with no buys
 * has a real market cap equal to its phantom reserve, which is the opening valuation. It must be
 * taken OUT of anything describing liquidity or graduation progress, and this function is not that.
 *
 * Verified against the live COMPANY curve on Robinhood Chain: reserves 1.68 ETH against the full
 * 1e27 supply, giving 1.68 ETH, which matches the phantom exactly for a launch with no buys, and
 * agrees to the wei with the float path the COMPANY server uses.
 */

export type CurveState = {
  /** Includes the phantom quote. In the PAIR asset's base units. */
  quoteReserve: bigint
  /** Tokens still held by the curve, in the token's base units. */
  tokenReserve: bigint
  /** In the token's base units. */
  totalSupply: bigint
  graduated: boolean
}

/**
 * Market cap in the pair asset's BASE units, or null when it cannot be known.
 *
 * ⛔⛔ NULL, NEVER ZERO. Graduating sweeps the curve and drains its reserves, so a graduated launch
 * asked this question would answer with a confident zero: a real number, in the right units, that
 * says the token is worthless. A dash is the honest rendering of "this moved to a Uniswap pool and
 * the curve can no longer price it".
 */
export function marketCapInPair(s: CurveState): bigint | null {
  if (s.graduated) return null
  if (s.tokenReserve <= 0n || s.quoteReserve <= 0n || s.totalSupply <= 0n) return null
  return (s.quoteReserve * s.totalSupply) / s.tokenReserve
}

/**
 * The cap in USD, scaled by 1e6, from the cap in the pair asset and that asset's USD rate.
 *
 * ⛔⛔ A CAP IN ETHER IS NOT A MARKET CAP. Two tokens paired against different assets cannot be
 * compared, the figure moves when ETH moves though nothing about the token changed, and nobody
 * reads a token's size in ether. Both inputs are exact integers and stay integers: converting to
 * float first is how a cap of a few thousand dollars turns into a number that is merely nearby.
 *
 * @param capInPair the cap in the pair asset's BASE units, from {@link marketCapInPair}
 * @param pairDecimals the PAIR asset's decimals, never the token's
 * @param usdPerUnitScaled USD per one whole pair asset, scaled by 1e6
 */
export function capUsdScaled(
  capInPair: bigint | null, pairDecimals: number, usdPerUnitScaled: bigint | null,
): bigint | null {
  if (capInPair === null || usdPerUnitScaled === null || usdPerUnitScaled <= 0n) return null
  return (capInPair * usdPerUnitScaled) / 10n ** BigInt(pairDecimals)
}

/**
 * Compact dollars.
 *
 * ⛔ Returns null, never "$0", when the cap is unknown. Every figure on this site renders a dash
 * rather than inventing a number, and a market cap of zero beside a live token is a claim.
 * ⚠ Pinned to en-US like every other figure here: `toLocaleString()` with no argument follows the
 * machine's regional settings and has rendered 2705 as "2.705" on this very stack.
 */
export function formatUsd(scaled: bigint | null): string | null {
  if (scaled === null) return null
  const usd = Number(scaled) / 1e6
  if (!Number.isFinite(usd)) return null
  if (usd > 0 && usd < 0.01) return '<$0.01'
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 1 })}m`
  if (usd >= 1000) return `$${(usd / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })}k`
  return `$${usd.toLocaleString('en-US', { maximumFractionDigits: usd >= 1 ? 0 : 2 })}`
}
