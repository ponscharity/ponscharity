/**
 * Whether to bridge the charity vault's balance out to the charity now, or wait for more.
 *
 * Kept pure so the whole policy can be tested without a chain or a network — the same shape as
 * `~/ponsi/cranker/src/decide.ts`, and for the same reason: this is the only judgement the remit
 * service makes, and it is judging where somebody else's donation goes.
 *
 * ## ⭐⭐ WHY THIS DECISION IS EASIER THAN THE CRANKER'S, AND WHY THAT MATTERS
 *
 * The cranker cannot weigh a USDG bounty against ETH gas without a price feed, so it falls back to
 * operator-stated floors and skips loudly when it cannot price something. That whole apparatus is
 * unnecessary here: a Relay quote reports `amountUsd` on BOTH sides of the route, so the cost of
 * bridging is already denominated in the same unit as the thing being bridged. The decision is a
 * ratio of two numbers the quote handed us together.
 *
 * ➤ So the gate is RELATIVE — "what fraction of this donation does the bridge eat" — not an
 * absolute floor. An absolute floor in ETH would be the mixed-unit bug all over again the first
 * time a launch paired in USDG.
 *
 * ## ⛔⛔ THE REAL TENSION IS NOT COST, IT IS CUSTODY
 *
 * Waiting for a bigger batch always makes the bridge cheaper. It also means more of the charity's
 * money sits in a hot wallet controlled by one key, which is the single trusted hop in this whole
 * design (see CharityDistributor's trust note). Optimising cost alone converges on "hold everything
 * forever", which is exactly the posture that made donate.gg's $1.7M of undistributed balances a
 * story.
 *
 * ➤ `maxHoldMs` overrides the cost gate. Past it, a batch is remitted at whatever the route costs.
 * Paying 1.2% to move money out of a hot wallet is a good trade against holding it another week.
 */

/**
 * Measured on Relay, RHC (chain 4663) → Ethereum mainnet USDC, 28 Aug 2026.
 * Percentages are total value lost end to end, including the relayer fee, gas and swap spread.
 *
 * | in           | native ETH | USDG   |
 * | ---          | ---        | ---    |
 * | ~$5          | 1.19%      | 1.27%  |
 * | ~$25         | 0.63%      | 0.27%  |
 * | ~$100        | 0.52%      | 0.08%  |
 * | ~$1000       | 0.49%      | 0.04%  |
 *
 * ⭐⭐ USDG IS AN ORDER OF MAGNITUDE CHEAPER TO REMIT THAN ETH, and it is not a fee difference — it
 * is the swap. ETH→USDC crosses a spread that never goes away no matter how big the batch, so the
 * native route floors out around 0.49%. USDG→USDC is stable-to-stable and keeps improving.
 *
 * ➤ This is a LAUNCH-TIME decision, not a remit-time one: a charity token paired against USDG
 * delivers roughly 0.45% more of its fees to the charity than the identical token paired against
 * ETH, forever, and the pair asset cannot be changed afterwards.
 */
/**
 * The floor a single remit must clear, in USD.
 *
 * ⚠ Exported so the keeper can avoid ASKING for a quote on money that is nowhere near it. That is an
 * optimisation only — every real decision still runs through `decideRemit` on a real quote. One
 * number, one place: a second copy of 20 somewhere else is how the two drift apart.
 */
export const HARD_FLOOR_USD = 5

export const MEASURED = {
  /**
   * Below this the route is never worth taking, in any asset.
   *
   * ⛔⛔ THIS WAS $20 AND IT WAS A WALL, NOT A THROTTLE. The floor is checked BEFORE the age
   * override, so a launch earning less than it was not donated late — it was never donated. A USDG
   * batch sat at **$19.79 for 27 hours**, twenty one cents short, with no path out. When the big
   * earners drained on 30 Aug the feed simply stopped, because everything behind them was under $20.
   *
   * ⭐ RE-MEASURED 30 Aug 2026 against the live native route, RHC → Base USDC:
   *
   *   $2.51 → 1.320%   $5.01 → 0.896%   $7.52 → 0.753%   $10.02 → 0.682%
   *   $15.04 → 0.614%  $20.05 → 0.578%  $50.12 → 0.515%  $125.30 → 0.489%
   *
   * Holding $6 back until it reaches $20 saves **1.4 cents**. The old comment claimed "at $5 the
   * bridge eats over 1%" — it is 0.90%.
   *
   * ➤ $5 is where the curve turns: below it the loss runs past 1% toward 1.3% and the balance is
   * genuinely dust. Above it, sending beats waiting. Lowered with the operator's agreement.
   */
  hardFloorUsd: HARD_FLOOR_USD,
  /**
   * The loss fraction a batch must clear before it goes, PER ASSET, as a fraction not bps.
   *
   * ⛔⛔ ONE GLOBAL TARGET IS DEAD CODE FOR AT LEAST ONE ASSET, AND A TEST CAUGHT IT. At a single
   * 0.30% target the native route — which floors at 0.49% no matter how large the batch, because
   * the ETH→USDC spread does not shrink — can never pass on cost. Every native remit would then
   * happen on the age override alone, so the cost gate would silently do nothing for the asset it
   * matters most for, while the logs read normally.
   *
   * ➤ Each target sits just above what that route can actually ACHIEVE at size, so the gate says
   * "this batch is too small for its own route" rather than "this asset is too expensive to exist".
   */
  targetLoss: {
    /**
     * ⚠⚠ RAISED FROM 0.0055 ON 30 AUG 2026, AND THE FLOOR ALONE WOULD HAVE CHANGED NOTHING.
     * At a 0.55% target only batches over roughly $30 could pass on cost, so dropping the floor to
     * $5 would have handed every small launch to the 24h age override — once a day instead of
     * never. 1% is what the measurements support: it clears $5 (0.896%) and refuses $2.51 (1.32%).
     */
    '0x0000000000000000000000000000000000000000': 0.010,
    /** measured: 0.27% at $25, 0.08% at $100 — so this bites below roughly $60. */
    '0x5fc5360d0400a0fd4f2af552add042d716f1d168': 0.0015,
  } as Record<string, number>,
  /** For an asset with no measured target of its own. ⚠ Deliberately generous: an unknown route is
   *  not a reason to hold a charity's money, it is a reason to measure the route. */
  targetLossFallback: 0.010,
  /** Nothing waits longer than this regardless of cost. Custody beats efficiency. */
  maxHoldMs: 24 * 60 * 60 * 1000,
} as const

export type Quote = {
  /** What leaves the vault, in USD, per the quote. */
  inUsd: number
  /** What lands at the charity, in USD, per the same quote. */
  outUsd: number
}

export type Batch = {
  /** The asset sitting in the charity vault. `native` or an ERC-20 address. */
  asset: string
  symbol: string
  /** When the OLDEST unremitted value landed in the vault. */
  heldSinceMs: number
  quote: Quote
}

export type Decision =
  | { remit: true; reason: string; lossPct: number }
  | { remit: false; reason: string; lossPct?: number }

export type Policy = {
  hardFloorUsd: number
  targetLoss: Record<string, number>
  targetLossFallback: number
  maxHoldMs: number
}

export const DEFAULT_POLICY: Policy = {
  hardFloorUsd: MEASURED.hardFloorUsd,
  targetLoss: MEASURED.targetLoss,
  targetLossFallback: MEASURED.targetLossFallback,
  maxHoldMs: MEASURED.maxHoldMs,
}

export const targetFor = (asset: string, p: Policy = DEFAULT_POLICY): number =>
  p.targetLoss[asset.toLowerCase()] ?? p.targetLossFallback

export function decideRemit(b: Batch, now: number, policy: Policy = DEFAULT_POLICY): Decision {
  const { inUsd, outUsd } = b.quote

  /* ⛔ A quote that prices the input at zero is a quote that failed to price, not a batch worth
     nothing. Treating it as zero would hold the balance forever with a cheerful log line. */
  if (!(inUsd > 0)) {
    return { remit: false, reason: `the quote could not price ${b.symbol} — holding, and this is an alarm not a skip` }
  }

  const lossPct = (inUsd - outUsd) / inUsd
  const target = targetFor(b.asset, policy)
  const heldMs = now - b.heldSinceMs
  const heldHours = heldMs / 3_600_000

  /*
    ⛔⛔ THE FLOOR IS CHECKED FIRST AND THE AGE OVERRIDE DOES NOT LIFT IT.

    Below the floor the bridge's fixed costs dominate and a "just get it out" remit can hand the
    relayer a double-digit percentage of a small donation. Age says "stop holding this"; it does not
    say "hold it and also destroy it". A dust balance below the floor is held and REPORTED, and the
    answer to it is an operator consolidating manually, not a bot burning it in fees.
  */
  if (inUsd < policy.hardFloorUsd) {
    return {
      remit: false,
      lossPct,
      reason: `$${inUsd.toFixed(2)} of ${b.symbol} is under the $${policy.hardFloorUsd} floor` +
        (heldHours > 24 ? ` — held ${heldHours.toFixed(0)}h, consolidate it by hand` : ''),
    }
  }

  if (heldMs >= policy.maxHoldMs) {
    return {
      remit: true,
      lossPct,
      reason: `held ${heldHours.toFixed(1)}h, past the ${(policy.maxHoldMs / 3_600_000).toFixed(0)}h limit — going at ${(lossPct * 100).toFixed(2)}%`,
    }
  }

  if (lossPct > target) {
    return {
      remit: false,
      lossPct,
      reason: `the bridge would take ${(lossPct * 100).toFixed(2)}% of $${inUsd.toFixed(2)}, over the ${(target * 100).toFixed(2)}% target for ${b.symbol} — waiting for a bigger batch (${heldHours.toFixed(1)}h held)`,
    }
  }

  return {
    remit: true,
    lossPct,
    reason: `$${inUsd.toFixed(2)} of ${b.symbol} at ${(lossPct * 100).toFixed(2)}% — $${outUsd.toFixed(2)} lands`,
  }
}

/**
 * ⛔⛔ ASSETS THAT CANNOT LEAVE ROBINHOOD CHAIN.
 *
 * Relay routes native ETH and USDG off RHC. All 21 tokenized stocks return HTTP 400 "Unsupported
 * currency" — AAPL, TSLA, SPY and GME checked directly on 28 Aug 2026, and the list is per-currency
 * rather than a route problem, so the rest are assumed unsupported until one is shown otherwise.
 *
 * ⭐⭐ SO THEY ARE SOLD FIRST, NOT BANNED. STOCK/USDG pools exist on the V4 singleton at the
 * standard fee tiers with no hook, so `CharityDistributor.sellAllForUsdg` converts a stock fee into
 * USDG on chain and the USDG is what bridges. See `sell.ts` for tier selection.
 *
 * ⛔ This function still gates the BRIDGE, and must: a stock reaching the bridge unsold is the
 * stranding bug. The contract enforces the same rule harder — `_release` reverts `NotPayable` for
 * anything but native and USDG, so a stock physically cannot leave to a vault.
 *
 * ⚠ One residue remains and cannot be fixed off chain: a stock with no liquid pool at all — MSTR,
 * whose only initialised tier (`fee=100`) holds zero liquidity — waits in the contract until some
 * pool for it has depth. Waiting is recoverable; stranding is not.
 */
export const BRIDGEABLE_FROM_RHC: Record<string, string> = {
  '0x0000000000000000000000000000000000000000': 'ETH',
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168': 'USDG',
}

export function canLeaveRhc(asset: string): boolean {
  return asset.toLowerCase() in BRIDGEABLE_FROM_RHC
}
