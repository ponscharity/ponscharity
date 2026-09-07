import type { Address, Hex } from 'viem'

/**
 * The charities a launch can pay, and the mechanism that pays them.
 *
 * ## ⭐⭐ A CHARITY IS A CONFIG ID, NOT AN ADDRESS
 *
 * donate.gg runs a public `DonationRelayUpgradeableV1` at
 * `0x02A0d2a39732082b824a5A3D3b026C54d581DCC8` on **Ethereum and Base**, with `donateNative` and
 * `donateToken` open to anyone. A donation routes by a 32 byte `configId`.
 *
 * ➤ That is what lifts the ceiling from four charities to thousands. Before it, a charity was
 * payable only if it published a static self-custodied wallet, which almost none do, because nearly
 * all of them receive through a processor whose addresses become smart contracts. It is the same
 * rail pump.fun's charity coins run on.
 *
 * ## ⛔⛔ THE RELAY DOES NOT VALIDATE THE CONFIG ID
 *
 * Verified by simulation on Base: `donateNative` succeeds with `0xabab…ab`, an id belonging to
 * nobody. A wrong id is accepted on chain, silently, with a successful transaction to show for it.
 * So every id here was read from donate.gg's own API for that charity, in one pass, and none was
 * typed, inferred, or copied from a third party.
 *
 * ⛔⛔ `raisedUsd` AND `donations` ARE NOT DISPLAYED ANYWHERE. They are donate.gg's own lifetime
 * figures at import time, and the site used to print them on the cards and in a headline that summed
 * the whole file — somebody else's totals reading, under our masthead, as what launching here
 * achieves. What the cards show now is read from our own register: see `charityStats.ts`.
 *
 * ➤ `raisedUsd` survives for ONE job, ordering. Ranking 2,705 charities by what this launchpad has
 * paid them leaves nearly all of them tied, and a tie of two thousand rows is not an order, so it
 * breaks ties and decides who appears on the first screen. Deciding who is shown first is not the
 * same act as printing the number. ⚠ It must never reach the DOM.
 *
 * ⛔ Being listed is not an endorsement, a partnership, or a claim that the organisation has agreed
 * to receive anything from a token launched here.
 */

/** `DonationRelayUpgradeableV1`, the same proxy address on Ethereum and Base. */
export const DONATION_RELAY = '0x02A0d2a39732082b824a5A3D3b026C54d581DCC8' as Address

/**
 * ⚠ Base, not Ethereum. Both carry the relay, and bridging Robinhood Chain to Base costs about
 * 0.08% against Ethereum's 0.49%, with gas on the far side a fraction of the price. The charity
 * receives the same amount either way, so the difference is money that would otherwise be burned
 * getting there.
 */
export const RELAY_CHAIN_ID = 8453

export const RELAY_ABI = [
  'function donateNative(bytes32 configId, uint256 tipBps, address creditedTo, bytes message) payable',
  'function donateToken(bytes32 configId, address token, uint256 amountIn, uint256 tipBps, address creditedTo, bytes message)',
] as const

export type Charity = {
  name: string
  slug: string
  /** The 32 byte id the relay routes by. */
  configId: Hex
  ein: string
  logo: string
  place: string
  mission: string
  raisedUsd: number
  donations: number
}

/*
  ⛔⛔ FETCHED, NOT BUNDLED. 2,705 charities are a megabyte of JSON. Imported as a module it lands in
  the main bundle and every visitor downloads the entire directory before the home page can paint,
  to look at a hero. As a static file it is requested once, when somebody actually opens the picker,
  and Caddy serves it gzipped at about a third of the size.

  ⚠ One in-flight request is shared. Without the cached promise, three components mounting together
  fetch a megabyte three times.
*/
type Row = { n: string; s: string; c: Hex; e: string; l: string; p: string; m: string; r: number; d: number }

let cache: Charity[] | null = null
let inflight: Promise<Charity[]> | null = null

export function loadedCharities(): Charity[] | null {
  return cache
}

export async function loadCharities(): Promise<Charity[]> {
  if (cache) return cache
  if (inflight) return inflight
  inflight = fetch('/charities.json')
    .then((r) => {
      if (!r.ok) throw new Error(`charities.json ${r.status}`)
      return r.json() as Promise<Row[]>
    })
    .then((rows) => {
      cache = rows.map((x) => ({
        name: x.n, slug: x.s, configId: x.c, ein: x.e,
        logo: x.l, place: x.p, mission: x.m,
        raisedUsd: x.r, donations: x.d,
      }))
      return cache
    })
    .finally(() => { inflight = null })
  return inflight
}

export const charityPage = (c: Charity) => `https://www.donate.gg/charities/${c.slug}`

/**
 * ⚠ Ranked, not just filtered. Over two and a half thousand rows, a plain `includes` puts whatever
 * happens to be alphabetically convenient at the top, and somebody typing "st jude" scrolls past
 * forty organisations with "st" in the middle of a word. A name that STARTS with the query outranks
 * one that merely contains it, and both outrank a match found only in the mission text.
 */
export function searchCharities(all: Charity[], q: string, limit = 40): Charity[] {
  const n = q.trim().toLowerCase()
  if (!n) return all.slice(0, limit)

  const scored: { c: Charity; s: number }[] = []
  for (const c of all) {
    const name = c.name.toLowerCase()
    let s = -1
    if (name === n) s = 0
    else if (name.startsWith(n)) s = 1
    else if (name.includes(n)) s = 2
    else if (c.place.toLowerCase().includes(n)) s = 3
    else if (c.mission.toLowerCase().includes(n)) s = 4
    if (s >= 0) scored.push({ c, s })
    if (scored.length > 600) break
  }
  /* ⚠ Ties break on donate.gg's figure, which is the only signal in the file that says anything
     about whether an organisation actually receives donations. Ordering only — it is never rendered.
     See the note at the top of this file. */
  scored.sort((a, b) => a.s - b.s || b.c.raisedUsd - a.c.raisedUsd)
  return scored.slice(0, limit).map((x) => x.c)
}

export const charityByConfig = (all: Charity[], id: string) =>
  all.find((c) => c.configId.toLowerCase() === id.trim().toLowerCase())
