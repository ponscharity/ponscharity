import type { Address } from 'viem'
import type { Launch } from './launchpad.ts'
import { NOTHING_UNSWEPT, type Unswept } from './unswept.ts'

/**
 * What a launcher can actually collect, and from which of their launches.
 *
 * ## ⛔⛔ A 100% CHARITY SPLIT PAYS THE LAUNCHER NOTHING, AND MOST LAUNCHES ARE 100%
 *
 * `CharityDistributor` splits every fee at `charityBps` and pushes both halves. The launcher's side
 * is the remainder, `10000 - charityBps`, and it is paid to `opsVault`, the creator payout address
 * fixed at launch. The form defaults to a 100% charity share, so for a typical launch here the
 * launcher's side is exactly zero no matter how much the token trades.
 *
 * ➤ So this page cannot list "your launches with fees". It has to list the launches with fees THAT
 * ARE YOURS, which is a different set, and it must say plainly that a 100% launch has a charity
 * balance rather than showing a launcher a figure they cannot have.
 *
 * ## ⚠⚠ NOTHING HERE IS CLAIMED, IT IS PUSHED
 *
 * `harvest()` pulls from Pons's escrow and immediately calls `_release`, which sends the charity
 * side to the vault and the launcher's side to `opsVault`. There is no balance sitting somewhere
 * waiting to be withdrawn to whoever calls, and the call is permissionless: pressing the button
 * pays out the same way whether the launcher, the charity or a stranger presses it. The button is a
 * crank, not a withdrawal, and the copy has to say so or it reads as a claim on a balance.
 *
 * ⛔ It follows that the money lands at `opsVault`, which is NOT necessarily the connected wallet.
 * It was chosen at launch and cannot be changed. Showing "claim to your wallet" would be false for
 * any launcher who set it to a different address.
 */

export type Claimable = {
  launch: Launch
  /** Sitting in Pons's escrow, in the pair asset's base units. A harvest moves this. */
  pending: bigint
  /** The launcher's share of `pending`, at this launch's split. Zero at a 100% charity split. */
  yours: bigint
  /**
   * Where the launcher's share is pushed. Fixed at launch.
   *
   * ⛔⛔ READ FROM THE DISTRIBUTOR, NEVER TAKEN FROM `Entry.creator`. They are two different
   * addresses set from two different arguments: the launchpad records `creator: msg.sender` while
   * the distributor is constructed with `opsVault: terms.creatorPayout`, which the launch form lets
   * the launcher type. A launch on chain right now already has them differ, so substituting the
   * creator names an address the money does not go to — the precise falsehood the header of this
   * file forbids.
   *
   * ⚠ Null when it could not be read. NOT defaulted to the creator: a wrong address rendered as
   * fact is worse than no address, and the fallback would silently reinstate the bug.
   */
  payout: Address | null
  /** True when this launch can never pay its launcher, because the charity takes everything. */
  allToCharity: boolean
  /**
   * Fees that exist but have not reached the escrow, so `pending` cannot see them.
   *
   * ⛔⛔ THE REASON THIS PAGE USED TO LIE. `pending` reads the escrow, which is the SECOND hop; a
   * launch's fees accrue first on its curve or, once it graduates, in the meme hook. Between a
   * trade and a sweep the escrow is genuinely empty, and this page rendered that as
   * "Nothing to collect" on launches that had earned real money. @see unswept.ts
   */
  unswept: Unswept
  /** `pending` plus the unswept share, in the pair asset's units — everything a crank could move. */
  collectable: bigint
}

/**
 * The launcher's side of an amount, at a given split.
 *
 * ⛔ Rounds the OPS side DOWN, exactly as the contract does, so this never promises a wei the
 * contract will not send. `CharityDistributor._release` computes `toOps = amount * (10000 -
 * charityBps) / 10000` and gives the remainder to the charity, deliberately, so that division dust
 * lands on the side without the keys. A UI that rounded the other way would show a figure one wei
 * above what arrives, every time, on every launch.
 */
export function launcherShare(amount: bigint, charityBps: number): bigint {
  if (amount <= 0n) return 0n
  const bps = BigInt(Math.max(0, Math.min(10_000, charityBps)))
  return (amount * (10_000n - bps)) / 10_000n
}

/** Launches created by this wallet, newest first. */
export function launchesBy(all: Launch[], who: string | null): Launch[] {
  if (!who) return []
  const w = who.toLowerCase()
  return all
    .filter((l) => l.creator.toLowerCase() === w)
    .sort((a, b) => (b.launchedAt > a.launchedAt ? 1 : b.launchedAt < a.launchedAt ? -1 : 0))
}

/**
 * Rows for the claim page.
 *
 * ⚠ Includes launches with nothing pending, so a launcher can see that the launch is theirs and
 * that it has earned nothing yet. Hiding them would make an empty page ambiguous between "you have
 * no launches" and "your launches have no fees", which are different problems with different fixes.
 */
export function claimableFor(
  all: Launch[],
  who: string | null,
  pendingBy: Map<string, bigint>,
  /** token (lowercased) to the distributor's `opsVault`. Absent entries render as unknown. */
  payoutBy: Map<string, Address> = new Map(),
  /** token (lowercased) to what is still sitting on its curve or in its pool. */
  unsweptBy: Map<string, Unswept> = new Map(),
): Claimable[] {
  return launchesBy(all, who).map((l) => {
    const pending = pendingBy.get(l.token.toLowerCase()) ?? 0n
    const unswept = unsweptBy.get(l.token.toLowerCase()) ?? NOTHING_UNSWEPT
    /* ⚠ Only the QUOTE-denominated share is added. `unswept.memePending` is denominated in the
       memecoin and adding it here would be the ether-plus-dollars mistake this file forbids
       everywhere else. */
    const collectable = pending + unswept.creatorShare
    return {
      launch: l,
      pending,
      /* ⚠ The launcher's cut of everything a crank could move, not of the escrow alone. The two
         differed on every graduated launch, and the escrow-only figure was the smaller one. */
      yours: launcherShare(collectable, l.charityBps),
      payout: payoutBy.get(l.token.toLowerCase()) ?? null,
      allToCharity: l.charityBps >= 10_000,
      unswept,
      collectable,
    }
  })
}

/**
 * Only the rows where pressing the button actually moves something.
 *
 * ⛔ Judged on `collectable`, not on `pending`. A graduated launch with fees in the hook has an
 * empty escrow until somebody sweeps, and pressing its button is precisely what does that.
 */
export const worthCranking = (rows: Claimable[]): Claimable[] => rows.filter((r) => r.collectable > 0n)

/** Totals per pair asset. ⛔ Never summed across assets; ether and dollars do not add. */
export function totalsByAsset(rows: Claimable[]) {
  const out = new Map<string, {
    symbol: string; decimals: number; yours: bigint; pending: bigint; collectable: bigint
  }>()
  for (const r of rows) {
    const k = r.launch.pairToken.toLowerCase()
    const cur = out.get(k) ?? {
      symbol: r.launch.pairSymbol, decimals: r.launch.pairDecimals,
      yours: 0n, pending: 0n, collectable: 0n,
    }
    cur.yours += r.yours
    cur.pending += r.pending
    cur.collectable += r.collectable
    out.set(k, cur)
  }
  return [...out.values()].filter((v) => v.yours > 0n || v.collectable > 0n)
}
