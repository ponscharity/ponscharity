import type { Address } from 'viem'
import { pairBy } from './pairs.ts'
import { fmtAmount } from './launchpad.ts'

/**
 * What THIS launchpad has paid each charity, read from its own register.
 *
 * ## ⭐⭐ WHY THESE NUMBERS AND NOT donate.gg's
 *
 * The directory ships with donate.gg's lifetime totals for every organisation, and the site used to
 * show them: a `$1.2m raised` pill on each card and an `Over $2.9m raised` headline that summed the
 * whole file. None of that money came through here. On our own pages, under our own masthead, it
 * read as a track record — a claim made without a single sentence being literally false.
 *
 * ➤ So the figures on the cards are now ours: launches opened here, and what their distributors have
 * actually paid toward that charity. They start empty and they only ever grow from real launches.
 *
 * ## ⛔⛔ NEVER SUMMED ACROSS PAIR ASSETS
 *
 * A launch pays in whatever it is paired against, so one charity can hold ETH from one launch and
 * USDG from another. `0.4 + 120 = 120.4` of nothing. Worse, the two have different decimals, so a
 * naive sort puts whichever has more decimals on top and calls it a leaderboard. Totals are kept
 * **per asset** in a map and rendered as a list; the only cross-asset ranking offered is by launch
 * count, which is a real integer in every case. It is the same rule `mixedAssets` enforces in the
 * ledger, applied where the temptation to add is stronger.
 *
 * ⚠ "Paid" is the site's word for it everywhere, and it is the honest one: `totalToCharity` is what
 * a distributor has PUSHED, not what is sitting swept and unclaimed. A listed charity's share lands
 * in the remit vault on its way to donate.gg's relay, so paid means paid toward them, and the note
 * under the grid says so rather than the number pretending otherwise.
 */

export type CharityStat = {
  /** Launches opened here that name this charity. */
  launches: number
  /** REMIT asset (lowercased) -> paid, in that asset's own units. ⛔ Never added together.
   *  ⚠ The remit asset, not the pair asset: a stock-paired launch is credited under USDG. */
  byAsset: Record<string, bigint>
}

export type StatIndex = Record<string, CharityStat>

/** ⚠ A launch that names an address directly carries no config id and joins to no card. */
export const ZERO_CONFIG = '0x0000000000000000000000000000000000000000000000000000000000000000'

export type StatRow = { charityId: string; asset: Address; paid: bigint }

/**
 * Fold the register into a per-charity index.
 *
 * Pure, and separated from the chain read so the folding rule can be tested without a node — the
 * same reason `decide.ts` is pure in the keeper. This is where the per-asset discipline lives.
 */
export function indexByCharity(rows: StatRow[]): StatIndex {
  const out: StatIndex = {}
  for (const r of rows) {
    const id = r.charityId?.toLowerCase()
    if (!id || id === ZERO_CONFIG) continue
    const stat = (out[id] ??= { launches: 0, byAsset: {} })
    stat.launches += 1
    const asset = r.asset.toLowerCase()
    /* ⚠ Counted even when zero, so a charity with a launch that has not earned yet still shows the
       launch. Hiding it would make the register and the card disagree. */
    stat.byAsset[asset] = (stat.byAsset[asset] ?? 0n) + r.paid
  }
  return out
}

export const statFor = (index: StatIndex, configId: string): CharityStat | null =>
  index[configId?.toLowerCase()] ?? null

/**
 * The paid totals as display strings, one per asset, largest first within each asset's own units.
 *
 * ⛔ Returns a LIST, never a total. An asset that has paid nothing is dropped, so a charity whose
 * only launch has not earned yet renders its launch count and no money line, rather than "0 ETH".
 */
export function paidParts(stat: CharityStat): string[] {
  return Object.entries(stat.byAsset)
    .filter(([, v]) => v > 0n)
    .map(([asset, v]) => {
      const p = pairBy(asset)
      return { text: `${fmtAmount(v, p?.decimals ?? 18, 3)} ${p?.symbol ?? 'TOKEN'}`, v }
    })
    .sort((a, b) => (b.v > a.v ? 1 : b.v < a.v ? -1 : 0))
    .map((x) => x.text)
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * Whether ranking by amount is meaningful across a set of charities.
 *
 * ⚠⚠ The moment two pair assets appear anywhere in the list, comparing amounts compares ether to
 * dollars and sorts by decimal count. There is no price feed here on purpose, so the honest move is
 * to rank by launches instead and say so — the same fallback the ledger makes.
 */
export function amountsComparable(index: StatIndex): boolean {
  const assets = new Set<string>()
  for (const s of Object.values(index)) {
    for (const [a, v] of Object.entries(s.byAsset)) if (v > 0n) assets.add(a)
  }
  return assets.size <= 1
}

/** The single asset every paid total is in, when there is exactly one. */
export function soleAsset(index: StatIndex): string | null {
  const assets = new Set<string>()
  for (const s of Object.values(index)) {
    for (const [a, v] of Object.entries(s.byAsset)) if (v > 0n) assets.add(a)
  }
  return assets.size === 1 ? [...assets][0] : null
}

/** Ranking value for "most paid", valid only when `amountsComparable` is true. */
export function paidIn(stat: CharityStat | null, asset: string | null): bigint {
  if (!stat || !asset) return 0n
  return stat.byAsset[asset] ?? 0n
}

/** What the launchpad has done in total, for the line above the grid. */
export function totals(index: StatIndex) {
  let launches = 0
  const charities = Object.keys(index).length
  const byAsset: Record<string, bigint> = {}
  for (const s of Object.values(index)) {
    launches += s.launches
    for (const [a, v] of Object.entries(s.byAsset)) byAsset[a] = (byAsset[a] ?? 0n) + v
  }
  return { launches, charities, paid: paidParts({ launches, byAsset }) }
}

/*
  ⚠ One in-flight request, shared, exactly like `loadCharities`. The directory page and the launch
  form's picker can both mount inside the same second, and without the cached promise each one reads
  the whole register off chain independently.

  ⛔ A failed read resolves to an EMPTY index, never a rejection. These numbers decorate a directory
  whose real job is choosing a charity; an RPC hiccup must cost a launcher some figures on a card,
  not the ability to pick anybody at all.
*/
let statCache: StatIndex | null = null
let statInflight: Promise<StatIndex> | null = null

export function loadedCharityStats(): StatIndex | null {
  return statCache
}

export async function loadCharityStats(): Promise<StatIndex> {
  if (statCache) return statCache
  if (statInflight) return statInflight
  const { readCharityStatRows } = await import('./launchpad.ts')
  statInflight = readCharityStatRows()
    .then((rows) => (statCache = indexByCharity(rows)))
    .catch(() => (statCache = {}))
    .finally(() => { statInflight = null })
  return statInflight
}
