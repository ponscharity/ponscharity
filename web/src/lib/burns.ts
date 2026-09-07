import { parseAbi } from 'viem'
import { EXPLORER, txUrl, publicClient } from './chain.ts'

/**
 * Every buy-back-and-burn $CHARITY's fees have paid for.
 *
 * ## ⛔⛔ WHY BLOCKSCOUT AND NOT `eth_getLogs`
 *
 * Robinhood Chain's public RPC caps a log query at 2,000 blocks and makes a block roughly every
 * 100ms — about three minutes of history per call — and it **ignores the topics filter entirely**,
 * answering with every log in range. Decoding that positionally yields well-formed fiction. So the
 * history comes from the explorer's indexed view, and every row is still matched on `topics[0]`
 * here rather than trusted to have been filtered. @see lib/pairs.ts, which learned this first.
 *
 * ⚠ The v1 `?module=logs&action=getLogs` endpoint answers **HTTP 500** for `fromBlock=0` on this
 * chain. v2 is the one that works, and it pages.
 *
 * ## ⭐ WHAT A ROW PROVES
 *
 * Each one is an event from the burner contract carrying the amount destroyed and the token's
 * `totalSupply` immediately afterwards, and it links to the transaction. A visitor does not have to
 * believe the figure — and because `burn` genuinely reduces supply rather than moving tokens to a
 * dead address, the supply in the row is checkable against the token itself.
 */

/** The ownerless contract that buys $CHARITY and destroys it. Nothing can withdraw from it. */
export const BURNER = '0x54C28eaE367466F925a0Ef56B6C1aD091b048694' as `0x${string}`

/** `keccak256("BoughtAndBurned(uint256,uint256,uint256)")` — bought on the pool, then burned. */
const BOUGHT_AND_BURNED = '0x0bf775574a8ef30285202d6405288f585f4a0ad2a7062980e61ef43fc069431d'
/** `keccak256("BurnedDirect(uint256,uint256)")` — fee-side tokens burned with no swap. */
const BURNED_DIRECT = '0xe1ac0cefb086b72e2dc8e190bf9a3b1f2abdf8d3c01e98fc95c6f6e29367177a'

/**
 * ⛔⛔ MIRRORS THE KEEPER, AND NOTHING ENFORCES THAT IT STILL DOES.
 *
 * The split is a policy `burn-cranker.mjs` applies, not a number the chain can be asked for:
 * `opsVault` is an EOA and `CharityDistributor`'s halves are immutable, so no contract knows these
 * figures. They are `BURN_SHARE_BPS` (8000 = 80% of the ops half = 40% of the whole) expressed the
 * way a reader of the page thinks about it.
 *
 * ➤ If `BURN_SHARE_BPS` changes on the box, CHANGE THESE TOO. The site would otherwise keep stating
 * an old split with total confidence, which is the worst kind of wrong a page like this can be.
 */
export const BURN_SHARE_PCT = 40
export const CREATOR_SHARE_PCT = 10

export type Burn = {
  kind: 'bought' | 'direct'
  /** $CHARITY destroyed, in base units (18dp). */
  burned: bigint
  /** ETH spent buying it. Zero for a direct burn, which spent nothing. */
  spent: bigint
  /** The token's `totalSupply` immediately after this burn. */
  supplyAfter: bigint
  txHash: string
  logIndex: number
  /** Unix seconds, or 0 when the explorer gave no timestamp. */
  timestamp: number
}

/**
 * A log, flattened out of whichever explorer API answered.
 *
 * ⚠ The two APIs name and shape the same fields differently — v2 gives an ISO timestamp and decimal
 * `index`, v1 gives hex seconds and hex `logIndex` — so they are normalised at the door and decoded
 * once. Two decoders drifting apart is how one source starts quietly reporting different numbers.
 */
type RawLog = {
  topics?: (string | null)[]
  data?: string
  txHash: string
  logIndex: number
  /** Unix seconds, or 0 when the source gave none. */
  timestamp: number
}

type V2Log = {
  data?: string
  topics?: (string | null)[]
  transaction_hash?: string
  block_timestamp?: string
  index?: number
}

type V1Log = {
  data?: string
  topics?: (string | null)[]
  transactionHash?: string
  /** Hex seconds, e.g. `0x6a9e8ff5`. */
  timeStamp?: string
  /** Hex, e.g. `0xf`. */
  logIndex?: string
}

/** ⚠ 32-byte words out of the data blob. Non-indexed args live here in declaration order. */
const word = (data: string, i: number): bigint => {
  const hex = data.startsWith('0x') ? data.slice(2) : data
  const slice = hex.slice(i * 64, (i + 1) * 64)
  return slice.length === 64 ? BigInt(`0x${slice}`) : 0n
}

/** A hex quantity as a plain number, and 0 for anything that isn't one. */
const hexNum = (h?: string): number => {
  if (!h) return 0
  try {
    const n = Number(BigInt(h))
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

const decode = (log: RawLog): Burn | null => {
  const topic = log.topics?.[0]?.toLowerCase()
  const data = log.data ?? '0x'
  if (!log.txHash) return null

  const base = { txHash: log.txHash, logIndex: log.logIndex, timestamp: log.timestamp }

  /* ⛔ Matched on topic0 HERE, on the results, never assumed from the query. */
  if (topic === BOUGHT_AND_BURNED) {
    // BoughtAndBurned(pairSpent, burned, newTotalSupply)
    return { ...base, kind: 'bought', spent: word(data, 0), burned: word(data, 1), supplyAfter: word(data, 2) }
  }
  if (topic === BURNED_DIRECT) {
    // BurnedDirect(burned, newTotalSupply)
    return { ...base, kind: 'direct', spent: 0n, burned: word(data, 0), supplyAfter: word(data, 1) }
  }
  return null
}

const fromV2 = (log: V2Log): Burn | null => {
  const ts = log.block_timestamp ? Math.floor(Date.parse(log.block_timestamp) / 1000) : 0
  return decode({
    topics: log.topics,
    data: log.data,
    txHash: log.transaction_hash ?? '',
    logIndex: log.index ?? 0,
    timestamp: Number.isFinite(ts) ? ts : 0,
  })
}

const fromV1 = (log: V1Log): Burn | null =>
  decode({
    topics: log.topics,
    data: log.data,
    txHash: log.transactionHash ?? '',
    logIndex: hexNum(log.logIndex),
    timestamp: hexNum(log.timeStamp),
  })

/**
 * What a walk of one explorer API came back with.
 *
 * ⛔⛔ `ok` IS THE WHOLE POINT. An empty register and an unreadable one are different statements,
 * and this page used to make them with the same words: when the explorer failed, `rows` was `[]`
 * and the panel said "Nothing burned yet" — about a contract that had burned seven times, on a page
 * whose own headline stat, read straight off the burner, was busy printing what it had spent. A
 * failed read must be able to say so.
 */
export type BurnScan = {
  rows: Burn[]
  /** Every page was read. A TOTAL is only honest when this is true. */
  complete: boolean
  /** The explorer answered. ⛔ `false` means "we could not ask", NEVER "there are none". */
  ok: boolean
}

const FAILED: BurnScan = { rows: [], complete: false, ok: false }

/** ⚠ A 429 on this explorer is a multi-minute penalty box. Seeing one stops every further request. */
class RateLimited extends Error {}

/** Unique rows, newest first. ⚠ Both sources page, and neither promises an order the UI can use. */
const tidy = (rows: Burn[]): Burn[] => {
  const seen = new Set<string>()
  const out = rows.filter((r) => {
    const k = `${r.txHash}:${r.logIndex}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  out.sort((a, b) => (b.timestamp - a.timestamp) || (b.logIndex - a.logIndex))
  return out
}

/** v1 pages this many logs at a time. Well above what this contract can have burned. */
const PER_PAGE = 1000

/**
 * The v1 `getLogs` endpoint: the whole history in one request, no cursor.
 *
 * ⭐⭐ TRIED FIRST BECAUSE IT IS THE ONE THAT ANSWERS. Measured on 7 Sep 2026, back to back on this
 * very contract: `/api/v2/addresses/{a}/logs` returned **HTTP 500 to 11 of 12 requests** while this
 * one answered 8 of 8. That is the bug a visitor saw — a register that was blank three times in
 * four, not because nothing had burned but because v2 was throwing.
 *
 * ⚠ The old note here claimed v1 500s for `fromBlock=0`. It does not, and `lib/pairs.ts` has been
 * reading the factory's whole approval history that way all along.
 *
 * ⚠ NO topic0 in the query. There are two burn events and the endpoint filters one topic0 value at
 * a time, so the filtering happens on the results — which is the rule on this chain anyway.
 */
async function fetchViaV1(): Promise<BurnScan> {
  const rows: Burn[] = []
  const base = `${EXPLORER}/api?module=logs&action=getLogs&fromBlock=0&toBlock=latest&address=${BURNER}`

  /* ⚠ Bounded, and it stops as soon as a page adds nothing new. v1's paging is `page`/`offset`; an
     endpoint that ignored them would hand back page 1 for ever, and the dedupe is what turns that
     into a stop rather than a spin. */
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(`${base}&page=${page}&offset=${PER_PAGE}`)
    if (res.status === 429) throw new RateLimited()
    if (!res.ok) return FAILED
    const body = (await res.json()) as { message?: string; result?: unknown }

    if (!Array.isArray(body.result)) {
      /* ⭐ "No logs found" is an ANSWER, not a failure: v1 says it with `status: "0"` and no array,
         and reading that as an error would hide a genuinely empty register behind a retry button.
         Every other non-array result — rate limits, upstream errors — is a failure. */
      const msg = (body.message ?? '').toLowerCase()
      if (msg.includes('no logs found') || msg.includes('no records found')) break
      return FAILED
    }

    const items = body.result as V1Log[]
    const before = tidy(rows).length
    for (const log of items) {
      const b = fromV1(log)
      if (b) rows.push(b)
    }
    if (items.length === 0 || tidy(rows).length === before) break
    if (items.length < PER_PAGE) break
  }

  return { rows: tidy(rows), complete: true, ok: true }
}

/**
 * The v2 address-logs endpoint, kept as the fallback.
 *
 * ⚠ Returns `complete: false` if a page could not be read. The rows are still real — each is its
 * own transaction — but the TOTAL would be a lower bound, and a total that quietly understates
 * itself is worse than no total. Same rule the donations register follows.
 */
async function fetchViaV2(): Promise<BurnScan> {
  const rows: Burn[] = []
  let complete = true
  let url = `${EXPLORER}/api/v2/addresses/${BURNER}/logs`

  /* ⚠ Bounded. An explorer that keeps handing back a next-page cursor must not spin this forever on
     somebody's token page. Ten pages is far more history than this contract can plausibly have. */
  for (let page = 0; page < 10 && url; page++) {
    const res = await fetch(url)
    if (res.status === 429) throw new RateLimited()
    /* ⛔ The FIRST page failing means we learned nothing at all — that is an unreadable register,
       not an empty one. A later page failing leaves real rows and an untrustworthy total. */
    if (!res.ok) {
      if (page === 0) return FAILED
      complete = false
      break
    }
    const body = (await res.json()) as { items?: V2Log[]; next_page_params?: Record<string, unknown> | null }
    for (const log of body.items ?? []) {
      const b = fromV2(log)
      if (b) rows.push(b)
    }
    const next = body.next_page_params
    if (!next) break
    const qs = new URLSearchParams(
      Object.entries(next).map(([k, v]) => [k, String(v)]),
    ).toString()
    url = `${EXPLORER}/api/v2/addresses/${BURNER}/logs?${qs}`
  }

  return { rows: tidy(rows), complete, ok: true }
}

/**
 * Every burn, newest first.
 *
 * ⭐ TWO SOURCES, because one of them is unreliable and neither is ours. Whichever answers wins;
 * only if BOTH refuse does the register report itself unreadable, and the panel then says so
 * instead of inventing an empty history. @see BurnScan
 *
 * ⛔ No retry loop. A 429 here is a multi-minute penalty box, so the recovery is a button the
 * visitor presses, not this page hammering an explorer that has just asked it to stop.
 */
export async function fetchBurns(): Promise<BurnScan> {
  for (const source of [fetchViaV1, fetchViaV2]) {
    try {
      const scan = await source()
      if (scan.ok) return scan
    } catch (e) {
      if (e instanceof RateLimited) return FAILED
      /* A network error on one source is not a verdict on the other. */
    }
  }
  return FAILED
}

/**
 * The lifetime totals, read STRAIGHT OFF THE CONTRACT.
 *
 * ⭐⭐ NOT SUMMED FROM LOGS. The contract keeps its own running counters, so this is one call that
 * cannot be short: a log walk that loses a page understates the total silently, and an understated
 * "burned so far" is the kind of wrong nobody notices. The rows in the register are for showing
 * each burn and proving it; THIS is the figure to put on a headline stat.
 *
 * ⚠ Returns null rather than zero when the read fails. Zero is a real value — it means nothing has
 * been burned — and rendering it for "we could not ask" would state a falsehood confidently.
 */
export async function readBurnTotals(): Promise<{ spent: bigint; burned: bigint } | null> {
  try {
    const [spent, burned] = await Promise.all([
      publicClient.readContract({ address: BURNER, abi: BURNER_ABI, functionName: 'totalPairSpent' }),
      publicClient.readContract({ address: BURNER, abi: BURNER_ABI, functionName: 'totalBurned' }),
    ])
    return { spent, burned }
  } catch {
    return null
  }
}

const BURNER_ABI = parseAbi([
  /** ETH spent buying $CHARITY back, lifetime. */
  'function totalPairSpent() view returns (uint256)',
  /** $CHARITY destroyed, lifetime. */
  'function totalBurned() view returns (uint256)',
])

/** Total $CHARITY destroyed across the rows given. */
export const totalBurned = (rows: Burn[]): bigint => rows.reduce((n, r) => n + r.burned, 0n)

/** Total ETH spent buying it back. ⚠ Never added to the burned figure — different assets. */
export const totalSpent = (rows: Burn[]): bigint => rows.reduce((n, r) => n + r.spent, 0n)

export const burnTxUrl = (h: string) => txUrl(h)
