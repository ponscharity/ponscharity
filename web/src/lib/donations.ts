import { createPublicClient, fallback, http, parseAbiItem, type Address, type Hex } from 'viem'
import { base } from 'viem/chains'
import { CHARITY_PAYER_BASE, BASE_EXPLORER } from './launchpad.ts'

/**
 * Every payment this launchpad has made to a charity, read from Base.
 *
 * ## ⭐⭐ THE EVENT IS THE RECORD, NOT OUR LEDGER
 *
 * The keeper keeps a receipts file on the box, and it would have been far easier to serve that as
 * JSON. It is also exactly the thing a visitor cannot check. `CharityPayer.Paid` is emitted in the
 * same transaction that hands the money to donate.gg's relay, so a row on this page and a donation
 * are the same event, and the `View tx` link next to it opens the proof on a block explorer we do
 * not run. If our box lies, the chain contradicts it.
 *
 * ⚠⚠ `Paid` carries no launch token. The bridge credits `address(this)`, so on the far side the
 * money has no memory of which coin earned it; the attribution lives only in the keeper's ledger.
 * ➤ So a row names the CHARITY and the amount, both of which the event proves, and does not name
 * the token, which it does not. Showing a coin name here would mean sourcing it off chain and
 * printing it beside a `View tx` button that cannot support it.
 *
 * ## ⛔⛔ AMOUNTS ARE NEVER SUMMED ACROSS TOKENS
 *
 * `pay` donates an ERC-20 and `payNative` donates ETH, and both emit `Paid`. Adding 95 USDC to
 * 0.4 ETH is the same `0.4 + 120 = 120.4` mistake `charityStats.ts` exists to prevent, made worse
 * here because the two differ by twelve decimal places. Totals are kept per token in a map.
 */

/**
 * ⚠ Base caps `eth_getLogs` at 10,000 blocks per call, so history is read in chunks. Measured
 * against `mainnet.base.org` on 29 Aug 2026: 10,000 passes, 100,000 is refused outright.
 */
export const LOG_SPAN = 10_000n

/**
 * The block `CharityPayer` was deployed in, found by bisecting `getCode`. It is the floor of the
 * scan: without it, an empty history walks backwards to the genesis block one chunk at a time.
 */
export const PAYER_FIRST_BLOCK = 50_588_537n

/** ⚠ Chunks per `Load more`. Base makes a block every 2s, so this is about a day of history. */
export const CHUNKS_PER_PAGE = 44
/** How many chunks are in flight at once. Enough to be quick, few enough not to be rate limited. */
export const CHUNK_BATCH = 8

export const BASE_RPC =
  ((import.meta as { env?: Record<string, string | undefined> }).env?.VITE_BASE_RPC) ||
  'https://mainnet.base.org'

/*
  ⚠ More than one endpoint, because a public Base RPC rate limits under load and this page is the
  first thing a visitor sees. `mainnet.base.org` leads because it is the one verified to serve a
  BROWSER — a public RPC that answers Node happily can still refuse a browser origin, which would
  ship a permanently empty list with nothing on the page to explain it.

  ⛔ Every endpoint here caps `eth_getLogs`, which is why history is chunked regardless of which one
  answers. `base.publicnode.com` is last: it is fast for `eth_call` and refuses wide log ranges.
*/
export const baseClient = createPublicClient({
  chain: base,
  transport: fallback(
    /* ⚠ `batch: true` collapses the JSON-RPC calls made in one tick into a single HTTP request.
       Stamping times is one `getBlock` per donation, and unbatched that is a request per row on a
       cold load — measured at about fifteen seconds before this, against two milliseconds warm. */
    [BASE_RPC, 'https://base.drpc.org', 'https://base.publicnode.com'].map((u) =>
      http(u, { batch: { wait: 16 } })),
    { rank: false },
  ),
})

export const PAID_EVENT = parseAbiItem(
  'event Paid(bytes32 indexed configId, address indexed token, uint256 amount)',
)

/**
 * ⛔⛔ THE LOG WALK DOES NOT GO THROUGH `fallback`, AND THAT IS THE WHOLE POINT.
 *
 * `fallback` moves to the next endpoint when a request FAILS. A public RPC refusing a 10,000-block
 * `eth_getLogs` does not fail in that sense — it answers, with a JSON-RPC error — so the chunk is
 * treated as answered and the walk moves on. Measured against all three endpoints on 7 Sep 2026,
 * over the 39 chunks of this payer's history:
 *
 *     mainnet.base.org      38 of 39 chunks answered   →  75,936.47 USDC
 *     base.drpc.org          7 of 39                   →  34,033.14 USDC
 *     base.publicnode.com    0 of 39                   →           0
 *
 * The true figure is **76,241.876795 USDC over 381 donations**. Every one of those three numbers
 * rendered as a confident headline, which is exactly how two people on two devices came to read
 * two different totals off the same page.
 *
 * ➤ So each chunk is retried across EVERY endpoint in turn, and a chunk nobody would answer comes
 * back as `null` — *unknown*, never an empty list. See {@link readChunk}.
 */
export const LOG_CLIENTS = [BASE_RPC, 'https://base.drpc.org', 'https://base.publicnode.com'].map(
  (u) => createPublicClient({ chain: base, transport: http(u, { retryCount: 1, retryDelay: 800, timeout: 25_000 }) }),
)

/** How many times the whole endpoint list is walked before a chunk is given up on. */
export const CHUNK_ATTEMPTS = 3

export type Range = { from: bigint; to: bigint }

/**
 * One chunk of `Paid` logs, or `null` if no endpoint would serve it.
 *
 * ⛔⛔ NEVER RETURN `[]` ON FAILURE. An empty array is indistinguishable from "no donations in this
 * range", and every caller adds it to a total — so one swallowed error silently subtracts real
 * money from a headline and leaves the page looking healthy. `null` forces the caller to decide.
 */
export async function readChunk(
  r: Range,
  clients: { getLogs: (a: never) => Promise<unknown[]> }[] = LOG_CLIENTS as never,
): Promise<Donation[] | null> {
  for (let attempt = 0; attempt < clients.length * CHUNK_ATTEMPTS; attempt++) {
    const c = clients[attempt % clients.length]
    try {
      const logs = (await (c as unknown as typeof baseClient).getLogs({
        address: CHARITY_PAYER_BASE, event: PAID_EVENT, fromBlock: r.from, toBlock: r.to,
      })) as { transactionHash: Hex; blockNumber: bigint; logIndex: number; args: Record<string, unknown> }[]
      return logs.map((l) => ({
        txHash: l.transactionHash, block: l.blockNumber, logIndex: l.logIndex,
        configId: l.args.configId as Hex, token: l.args.token as Address,
        amount: l.args.amount as bigint, timestamp: 0,
      }))
    } catch {
      /* Next endpoint. A range this one refuses is routinely served by another.
         ⚠ Pause between full passes over the list. Without it, 39 chunks each retrying three times
         is a burst that rate limits the one endpoint that WOULD have answered — measured: a run
         that put the two fussy endpoints first came back short until this was added. */
      const nextPass = (attempt + 1) % clients.length === 0
      if (nextPass) await new Promise((r) => setTimeout(r, 400 * (1 + attempt / clients.length)))
    }
  }
  return null
}

/** USDC on Base. Every donation the keeper makes is denominated in it. */
export const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address

const TOKENS: Record<string, { symbol: string; decimals: number }> = {
  [BASE_USDC.toLowerCase()]: { symbol: 'USDC', decimals: 6 },
  '0x0000000000000000000000000000000000000000': { symbol: 'ETH', decimals: 18 },
}

export const tokenMeta = (t: Address) =>
  TOKENS[t.toLowerCase()] ?? { symbol: 'tokens', decimals: 18 }

export type Donation = {
  txHash: Hex
  block: bigint
  /** Distinguishes two donations in one block; also the React key. */
  logIndex: number
  configId: Hex
  token: Address
  amount: bigint
  /** Seconds. 0 until the block header is read. */
  timestamp: number
}

export type Page = {
  rows: Donation[]
  /** The next block to scan down from, or null when the payer's first block has been reached. */
  cursor: bigint | null
}

export const baseTxUrl = (h: string) => `${BASE_EXPLORER}/tx/${h}`

/**
 * The chunk boundaries for one page, newest first.
 *
 * Pure and exported so the walk can be tested without a node: an off-by-one here either rereads a
 * block on every page, duplicating rows, or steps over one and drops a donation silently.
 */
export function chunkRanges(from: bigint, floor: bigint, chunks = CHUNKS_PER_PAGE) {
  const out: { from: bigint; to: bigint }[] = []
  let to = from
  while (to >= floor && out.length < chunks) {
    const lo = to - LOG_SPAN + 1n
    out.push({ from: lo > floor ? lo : floor, to })
    if (lo <= floor) break
    to = lo - 1n
  }
  return out
}

/** Newest first, and stable for two donations sharing a block. */
export const byNewest = (a: Donation, b: Donation) =>
  a.block === b.block ? b.logIndex - a.logIndex : b.block > a.block ? 1 : -1

/** Per token, in that token's own units. ⛔ Never flattened to one figure. */
export function totalsByToken(rows: Donation[]): Record<string, bigint> {
  const out: Record<string, bigint> = {}
  for (const r of rows) {
    const k = r.token.toLowerCase()
    out[k] = (out[k] ?? 0n) + r.amount
  }
  return out
}

export function fmtAmount(amount: bigint, decimals: number, maxFrac = 6) {
  const base10 = 10n ** BigInt(decimals)
  const whole = amount / base10
  const frac = (amount % base10).toString().padStart(decimals, '0').slice(0, maxFrac).replace(/0+$/, '')
  const w = whole.toLocaleString('en-US')
  return frac ? `${w}.${frac}` : w
}

export function ago(seconds: number, now = Date.now()) {
  if (!seconds) return ''
  const s = Math.max(0, Math.floor(now / 1000) - seconds)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

/**
 * Read one page of donations, walking backwards from `from`.
 *
 * ⚠ Stops early once `want` rows are in hand, so the common case — somebody opening the home page
 * to see the last few donations — costs one or two requests rather than a scan of all history.
 */
export async function fetchDonations({
  from, want = 5, floor = PAYER_FIRST_BLOCK, client = baseClient,
}: { from?: bigint; want?: number; floor?: bigint; client?: typeof baseClient } = {}): Promise<Page> {
  const head = from ?? (await client.getBlockNumber())
  if (head < floor) return { rows: [], cursor: null }

  const ranges = chunkRanges(head, floor)
  const rows: Donation[] = []
  let scanned = 0

  for (let i = 0; i < ranges.length; i += CHUNK_BATCH) {
    const batch = ranges.slice(i, i + CHUNK_BATCH)
    /* ⚠ Same resilient read as the full walk. A dropped chunk here only loses a row from a list
       rather than money from a headline, but it is the same silent hole and the same fix. */
    const found = await Promise.all(batch.map((r) => readChunk(r)))
    scanned += batch.length
    for (const logs of found) for (const l of logs ?? []) rows.push(l)
    if (rows.length >= want) break
  }

  const last = ranges[Math.min(scanned, ranges.length) - 1]
  const cursor = !last || last.from <= floor ? null : last.from - 1n

  rows.sort(byNewest)
  await stampTimes(rows, client)
  return { rows, cursor }
}

/**
 * Every donation ever, for the figures that must be totals rather than samples.
 *
 * ## ⛔⛔ A PAGE OF DONATIONS IS NOT A TOTAL
 *
 * `fetchDonations` stops as soon as it has enough rows to show, which is right for a list and
 * WRONG for a headline. Summing a partial page and calling it "delivered to charities" understates
 * it the moment history outgrows one page, and it does so silently — the figure stays plausible,
 * just short, and nothing on the page says so. The home page prints this number, so it reads the
 * whole history or it does not print.
 *
 * ## ⭐ THE SCAN IS CACHED, BECAUSE IT ONLY EVER GROWS
 *
 * Every endpoint caps `eth_getLogs` at 10,000 blocks and Base makes a block every two seconds, so
 * the full history costs about four requests per day of it. Left uncached that is fine this week
 * and unreasonable in a year. Donations are append-only and finalized, so a scan can be resumed:
 * what a visitor already has stays valid for ever and only the new tail is fetched.
 *
 * ⚠ A cache miss costs requests, never correctness. Anything unreadable is discarded and the range
 * is rescanned, which is why every access is wrapped — `localStorage` throws outright in some
 * contexts (a thumbnail capture, a browser set to block site data) rather than returning null.
 */
/**
 * ⚠⚠ VERSIONED, AND THE VERSION WAS BUMPED TO `v2` ON 7 Sep 2026 TO THROW AWAY EVERY EXISTING CACHE.
 *
 * The v1 walk swallowed a failed chunk as an empty one and then wrote `scannedTo = head` anyway, so
 * a visitor who lost one request had a short total FROZEN into their browser: every later visit
 * resumed past the hole and re-rendered the same wrong figure for ever. Fixing the walk does not
 * repair those stores — only a new key does. One extra scan per visitor, once.
 */
export const CACHE_KEY = `pons-charity:donations:v2:${CHARITY_PAYER_BASE.toLowerCase()}`

/** ⚠ The tail is always rescanned. A cached row from a block that later reorged out would otherwise
 *  be permanent, and re-reading a few hundred blocks costs one request. */
export const REORG_SLACK = 300n

type Cached = { scannedTo: string; rows: (Omit<Donation, 'block' | 'amount'> & { block: string; amount: string })[] }

export function readCache(): { scannedTo: bigint; rows: Donation[] } | null {
  try {
    const raw = globalThis.localStorage?.getItem(CACHE_KEY)
    if (!raw) return null
    const c = JSON.parse(raw) as Cached
    if (!c?.scannedTo || !Array.isArray(c.rows)) return null
    return {
      scannedTo: BigInt(c.scannedTo),
      rows: c.rows.map((r) => ({ ...r, block: BigInt(r.block), amount: BigInt(r.amount) })),
    }
  } catch {
    return null
  }
}

export function writeCache(scannedTo: bigint, rows: Donation[]) {
  try {
    const payload: Cached = {
      scannedTo: scannedTo.toString(),
      rows: rows.map((r) => ({ ...r, block: r.block.toString(), amount: r.amount.toString() })),
    }
    globalThis.localStorage?.setItem(CACHE_KEY, JSON.stringify(payload))
  } catch {
    /* A full or disabled store costs the next visit some requests and nothing else. */
  }
}

/** Merge two sets of donations, keeping one row per log. */
export function mergeDonations(a: Donation[], b: Donation[]): Donation[] {
  const seen = new Map<string, Donation>()
  for (const r of [...a, ...b]) seen.set(`${r.txHash}:${r.logIndex}`, r)
  return [...seen.values()].sort(byNewest)
}

/**
 * The result of a full walk.
 *
 * ⛔⛔ `complete` IS NOT DECORATION. `rows` is a lower bound whenever it is false, and the headline
 * total must not be printed from a lower bound — see the note on {@link readChunk} for the three
 * different "totals" that shipped because it used to be impossible to tell the two apart.
 */
export type DonationScan = {
  rows: Donation[]
  /** True only when every chunk of the requested range was actually answered. */
  complete: boolean
  /** The ranges nobody would serve. Empty when `complete`. */
  missing: Range[]
}

export async function fetchAllDonations({
  floor = PAYER_FIRST_BLOCK, client = baseClient, useCache = true, onPartial, readRange = readChunk,
}: {
  floor?: bigint; client?: typeof baseClient; useCache?: boolean
  /**
   * ⭐ Called with the rows as soon as the LOGS are in, before block times are read.
   *
   * ⚠ Nothing on a row needs its timestamp to render — the age is the one thing that waits, and it
   * simply appears a moment later. Blocking the whole list on it cost about eight seconds of blank
   * page on a cold load, to show a relative time nobody is waiting for.
   */
  onPartial?: (scan: DonationScan) => void
  /** Seam for the tests: the real one retries across every endpoint. */
  readRange?: (r: Range) => Promise<Donation[] | null>
} = {}): Promise<DonationScan> {
  const head = await client.getBlockNumber()
  const cache = useCache ? readCache() : null
  /* ⚠ `floor` still wins when the cache claims to start above it, so a bad cache cannot shrink the
     range that gets read. */
  const from = cache && cache.scannedTo > floor ? bigMax(floor, cache.scannedTo - REORG_SLACK) : floor
  const ranges = chunkRanges(head, from, Number.MAX_SAFE_INTEGER)

  const found: Donation[] = []
  const missing: Range[] = []
  for (let i = 0; i < ranges.length; i += CHUNK_BATCH) {
    const batch = ranges.slice(i, i + CHUNK_BATCH)
    /* ⚠⚠ `batch.map(readRange)` — point-free — hands the callback (element, INDEX, array), so the
       index lands in `readChunk`'s second parameter and replaces the endpoint list with a number.
       Every chunk then reads as unanswered and the whole page goes to the em dash. Wrap it. */
    const logs = await Promise.all(batch.map((r) => readRange(r)))
    logs.forEach((set, k) => {
      if (set === null) missing.push(batch[k])
      else found.push(...set)
    })
  }

  const rows = mergeDonations(cache?.rows ?? [], found)
  const complete = missing.length === 0
  onPartial?.({ rows, complete, missing })
  await stampTimes(rows.filter((r) => !r.timestamp), client)

  /*
    ⛔⛔ THE WATERMARK ONLY MOVES ON A CLEAN SWEEP.

    Rows are always kept — they are real donations and re-reading them costs requests for nothing —
    but `scannedTo` stays where it was if any chunk went unanswered, so the next visit rescans the
    hole instead of inheriting it. Advancing it past a gap is what made a one-off network blip
    permanent for that browser.
  */
  if (useCache) writeCache(complete ? head : (cache?.scannedTo ?? floor), rows)
  return { rows, complete, missing }
}

const bigMax = (a: bigint, b: bigint) => (a > b ? a : b)

/** Fill in block times. One read per distinct block, not one per row. */
export async function stampTimes(rows: Donation[], client = baseClient) {
  const blocks = [...new Set(rows.map((r) => r.block))]
  const times = new Map<bigint, number>()
  await Promise.all(
    blocks.map(async (b) => {
      try {
        const blk = await client.getBlock({ blockNumber: b })
        times.set(b, Number(blk.timestamp))
      } catch {
        /* A missing timestamp hides the age on that row; it must not lose the donation. */
      }
    }),
  )
  for (const r of rows) r.timestamp = times.get(r.block) ?? 0
  return rows
}

/**
 * Which launch each donation came from.
 *
 * ## ⛔⛔ THE ONE FIGURE ON THIS SITE THAT IS NOT READ FROM A CHAIN
 *
 * `Paid` has a config id and an amount and no launch token. The bridge credits the payer itself, so
 * by the time the money is on Base it has genuinely forgotten which coin earned it, and the near
 * side — `RemitVault.Remitted(token, amount, requestId)` — is on a chain that keeps about three
 * minutes of logs. Nothing a browser can reach holds the join, so the keeper publishes it.
 *
 * ➤ It publishes ONLY the join: a token and a transaction hash. Everything a row actually says —
 * the amount, the charity, the time — still comes from the `Paid` event that browser already read.
 * The index can therefore misattribute a donation, and it cannot invent or inflate one; a payTx
 * with no matching event on chain never renders.
 *
 * ⚠ A failure is an empty map, never an exception. The donations are real whether or not our box is
 * answering, and a launch page must fall back to showing none of them rather than to an error.
 */
export async function fetchAttribution(): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  try {
    const r = await fetch('/api/donations')
    if (!r.ok) return out
    const body = (await r.json()) as { donations?: { token?: string; payTx?: string }[] }
    for (const d of body.donations ?? []) {
      if (d?.payTx && d?.token) out.set(d.payTx.toLowerCase(), d.token.toLowerCase())
    }
  } catch {
    /* Offline, blocked, or the service is down: nothing is attributable, which is not an error. */
  }
  return out
}

/**
 * The donations one launch paid for.
 *
 * ⛔⛔ NEVER FILTERED BY CHARITY. Several launches can name the same charity — three of the first
 * thirteen donations went to the same config id from three different tokens — so matching on
 * `configId` would show a launch other launches' money and inflate what it looks like it raised.
 * The transaction hash is the only key that identifies one donation.
 */
export function donationsFor(rows: Donation[], attribution: Map<string, string>, token: string): Donation[] {
  const want = token.toLowerCase()
  return rows.filter((r) => attribution.get(r.txHash.toLowerCase()) === want)
}

/**
 * USDC donated per launch, for the cards.
 *
 * ⚠ ONE SHARED LOAD FOR THE WHOLE GRID. Forty cards mounting together must not each scan Base, so
 * the promise is cached the way `loadCharities` caches the directory. A failure resolves to an
 * empty map rather than rejecting: a card whose donated line is missing is a card, a card that
 * threw is a blank page.
 *
 * ⛔⛔ USDC ONLY, NEVER SUMMED WITH ANOTHER ASSET. `payNative` also emits `Paid`, and adding ether
 * to dollars on a single line would be the mixed-unit bug this codebase keeps catching — made worse
 * here because the card has room for one figure, so the wrong sum would be the only one shown.
 * Every remit lands as USDC today, so this is the complete picture; if that ever changes the line
 * understates rather than lies.
 */
let totalsInflight: Promise<Map<string, bigint>> | null = null

export function loadDonatedByLaunch(): Promise<Map<string, bigint>> {
  if (!totalsInflight) {
    totalsInflight = (async () => {
      const [{ rows }, attribution] = await Promise.all([fetchAllDonations(), fetchAttribution()])
      const out = new Map<string, bigint>()
      for (const r of rows) {
        if (r.token.toLowerCase() !== BASE_USDC.toLowerCase()) continue
        const launch = attribution.get(r.txHash.toLowerCase())
        if (!launch) continue
        out.set(launch, (out.get(launch) ?? 0n) + r.amount)
      }
      return out
    })().catch(() => new Map<string, bigint>())
  }
  return totalsInflight
}
