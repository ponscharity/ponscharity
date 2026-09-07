import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chunkRanges, byNewest, totalsByToken, fmtAmount, ago,
  LOG_SPAN, PAYER_FIRST_BLOCK, BASE_USDC, tokenMeta,
  readChunk, fetchAllDonations,
} from '../src/lib/donations.ts'

const d = (block, logIndex, token, amount, timestamp = 0) => ({
  txHash: '0x' + String(block).padStart(64, '0'), block: BigInt(block), logIndex,
  configId: '0x' + 'ab'.repeat(32), token, amount: BigInt(amount), timestamp,
})

test('chunk ranges never exceed the RPC log span', () => {
  for (const r of chunkRanges(1_000_000n, 0n, 10)) {
    assert.ok(r.to - r.from + 1n <= LOG_SPAN, `${r.from}..${r.to} is wider than the cap`)
  }
})

test('chunks are contiguous, so no block is scanned twice or stepped over', () => {
  /* ⛔ An off-by-one here either duplicates a donation on every page or drops one silently. */
  const rs = chunkRanges(1_000_000n, 0n, 6)
  for (let i = 1; i < rs.length; i++) {
    assert.equal(rs[i].to, rs[i - 1].from - 1n, 'gap or overlap between chunks')
  }
})

test('the walk stops at the payer deploy block, never below it', () => {
  const rs = chunkRanges(PAYER_FIRST_BLOCK + 5n, PAYER_FIRST_BLOCK, 40)
  assert.equal(rs.length, 1)
  assert.equal(rs[0].from, PAYER_FIRST_BLOCK)
  assert.equal(rs[0].to, PAYER_FIRST_BLOCK + 5n)
})

test('a floor landing mid chunk is clamped, not overshot', () => {
  const rs = chunkRanges(100_000n, 95_000n, 40)
  assert.equal(rs.at(-1).from, 95_000n)
})

test('newest first, and two donations in one block stay ordered', () => {
  const rows = [d(10, 0, BASE_USDC, 1), d(12, 3, BASE_USDC, 1), d(12, 7, BASE_USDC, 1)]
  const sorted = [...rows].sort(byNewest)
  assert.deepEqual(sorted.map((r) => [Number(r.block), r.logIndex]), [[12, 7], [12, 3], [10, 0]])
})

test('⛔ totals are kept per token and never flattened into one figure', () => {
  /* 95 USDC + 0.4 ETH = 95.4 of nothing, and the two differ by twelve decimal places. */
  const eth = '0x0000000000000000000000000000000000000000'
  const t = totalsByToken([d(1, 0, BASE_USDC, 95_110284), d(2, 0, eth, 4n * 10n ** 17n), d(3, 0, BASE_USDC, 24_016713)])
  assert.equal(Object.keys(t).length, 2)
  assert.equal(t[BASE_USDC.toLowerCase()], 119_126997n)
  assert.equal(t[eth], 400000000000000000n)
})

test('USDC is read as 6 decimals, not 18', () => {
  /* ⚠ Treating USDC as 18dp prints $0.000000000095 and reads as a rounding error. */
  assert.equal(tokenMeta(BASE_USDC).decimals, 6)
  assert.equal(fmtAmount(95_110284n, 6), '95.110284')
})

test('amounts match the three donations actually on chain', () => {
  assert.equal(fmtAmount(24_016713n, 6), '24.016713')
  assert.equal(fmtAmount(118_741272n, 6), '118.741272')
  assert.equal(fmtAmount(237_868269n, 6), '237.868269')
})

test('whole amounts carry no trailing dot and thousands are grouped', () => {
  assert.equal(fmtAmount(1_000_000n, 6), '1')
  assert.equal(fmtAmount(1_234_000_000n, 6), '1,234')
  assert.equal(fmtAmount(0n, 6), '0')
})

test('a dust amount does not round away to zero', () => {
  assert.equal(fmtAmount(1n, 6), '0.000001')
})

test('age reads in the largest unit that fits', () => {
  const now = 2_000_000 * 1000
  assert.equal(ago(2_000_000 - 30, now), '30s')
  assert.equal(ago(2_000_000 - 720, now), '12m')
  assert.equal(ago(2_000_000 - 25_200, now), '7h')
  assert.equal(ago(2_000_000 - 86_400 * 3, now), '3d')
})

test('a missing block timestamp shows no age rather than 1970', () => {
  assert.equal(ago(0), '')
})

test('a clock skewed behind the chain never prints a negative age', () => {
  assert.equal(ago(2_000_000 + 60, 2_000_000 * 1000), '0s')
})

import { mergeDonations, readCache, writeCache, CACHE_KEY, REORG_SLACK } from '../src/lib/donations.ts'

test('merging keeps one row per log, not per transaction', () => {
  /* Two donations can share a transaction; the log index is what separates them. */
  const a = { ...d(5, 0, BASE_USDC, 1), txHash: '0xsame' }
  const b = { ...d(5, 1, BASE_USDC, 2), txHash: '0xsame' }
  assert.equal(mergeDonations([a], [b]).length, 2)
})

test('a row already cached is not duplicated when the tail is rescanned', () => {
  /* ⚠ The rescan overlaps by REORG_SLACK on purpose, so every pass re-reads rows it already has. */
  const row = d(100, 2, BASE_USDC, 42)
  assert.equal(mergeDonations([row], [row]).length, 1)
})

test('the merged result is newest first', () => {
  const older = d(10, 0, BASE_USDC, 1)
  const newer = d(99, 0, BASE_USDC, 1)
  assert.deepEqual(mergeDonations([older], [newer]).map((r) => Number(r.block)), [99, 10])
})

test('⚠ the reorg overlap is real, so a reorged row cannot be cached for ever', () => {
  assert.ok(REORG_SLACK > 0n)
})

test('a cache round trip preserves bigints, which JSON alone cannot carry', () => {
  /* ⛔ block and amount are bigint. JSON.stringify THROWS on one, so both are stored as strings and
     must come back as bigint or every amount silently becomes a string and formats as NaN. */
  const store = new Map()
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
  }
  const rows = [d(50611058, 3, BASE_USDC, 2_070_272_959)]
  writeCache(50611100n, rows)
  const back = readCache()
  assert.equal(typeof back.rows[0].amount, 'bigint')
  assert.equal(back.rows[0].amount, 2_070_272_959n)
  assert.equal(back.scannedTo, 50611100n)
  assert.equal(fmtAmount(back.rows[0].amount, 6), '2,070.272959')
  delete globalThis.localStorage
})

test('a corrupt cache is discarded rather than thrown on', () => {
  globalThis.localStorage = { getItem: () => '{not json', setItem: () => {} }
  assert.equal(readCache(), null)
  delete globalThis.localStorage
})

test('a localStorage that throws outright does not break the page', () => {
  /* Some contexts throw on ACCESS, not on read: a thumbnail capture, a browser blocking site data. */
  globalThis.localStorage = {
    getItem: () => { throw new Error('denied') },
    setItem: () => { throw new Error('denied') },
  }
  assert.equal(readCache(), null)
  assert.doesNotThrow(() => writeCache(1n, []))
  delete globalThis.localStorage
})

test('no localStorage at all is a cache miss, not a crash', () => {
  assert.equal(readCache(), null)
  assert.doesNotThrow(() => writeCache(1n, []))
})

test('the cache key is scoped to the payer, so a redeploy cannot serve stale donations', () => {
  assert.ok(CACHE_KEY.includes('0xb3190e0aecd4f9f502133a354bbfba64f2ef79f2'))
})

import { donationsFor } from '../src/lib/donations.ts'

test('⛔ a launch shows only ITS donations, keyed by transaction', () => {
  const mine = { ...d(1, 0, BASE_USDC, 100), txHash: '0xaa' }
  const theirs = { ...d(2, 0, BASE_USDC, 200), txHash: '0xbb' }
  const attribution = new Map([['0xaa', '0xtoken1'], ['0xbb', '0xtoken2']])
  assert.deepEqual(donationsFor([mine, theirs], attribution, '0xTOKEN1').map((r) => r.txHash), ['0xaa'])
})

test('⛔⛔ two launches paying the SAME charity do not show each other’s money', () => {
  /* Three of the first thirteen donations went to one config id from three different tokens.
     Filtering on charity instead of transaction would have shown each of them all three. */
  const a = { ...d(1, 0, BASE_USDC, 100), txHash: '0xaa', configId: '0xsamecharity' }
  const b = { ...d(2, 0, BASE_USDC, 900), txHash: '0xbb', configId: '0xsamecharity' }
  const attribution = new Map([['0xaa', '0xtoken1'], ['0xbb', '0xtoken2']])
  const got = donationsFor([a, b], attribution, '0xtoken1')
  assert.equal(got.length, 1)
  assert.equal(got[0].amount, 100n)
})

test('a donation the index does not know about is not shown against any token', () => {
  const orphan = { ...d(1, 0, BASE_USDC, 5), txHash: '0xzz' }
  assert.deepEqual(donationsFor([orphan], new Map(), '0xtoken1'), [])
})

test('⚠ the index claiming a transaction with no Paid event renders nothing', () => {
  /* The index supplies attribution only. A payTx with no event behind it is never in `rows`, so it
     cannot reach the page however confidently it is listed. */
  const attribution = new Map([['0xghost', '0xtoken1']])
  assert.deepEqual(donationsFor([], attribution, '0xtoken1'), [])
})

test('attribution matching is case insensitive on both sides', () => {
  const r = { ...d(1, 0, BASE_USDC, 1), txHash: '0xAABB' }
  assert.equal(donationsFor([r], new Map([['0xaabb', '0xabc']]), '0xABC').length, 1)
})

/* ------------------------------------------------------------------------------------------
   The walk, and the hole in it that showed four different totals to four different people.

   Measured against the live payer on 7 Sep 2026, over the 39 chunks of its history:
     mainnet.base.org  38/39 answered → 75,936.47 USDC · base.drpc.org 7/39 → 34,033.14
     base.publicnode.com 0/39 → 0 · truth: 76,241.876795 USDC over 381 donations
   Each of those rendered as a settled headline, because a refused chunk was caught and turned
   into an empty one. These tests are about telling "nothing here" apart from "nobody answered".
   ------------------------------------------------------------------------------------------ */

/** A client stub: the walk only needs a head, and `stampTimes` only needs block times. */
const fakeClient = (head) => ({
  getBlockNumber: async () => head,
  getBlock: async () => ({ timestamp: 1_700_000_000n }),
})

/** A localStorage stub, so the cache rules can be asserted without a browser. */
async function withStore(fn) {
  const store = new Map()
  const prev = globalThis.localStorage
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  }
  /* ⚠ AWAITED. A sync wrapper restores the real store in `finally` before the async body has run,
     so every cache assertion inside it reads `null` and passes for the wrong reason. */
  try { return await fn(store) } finally { globalThis.localStorage = prev }
}

test('⛔⛔ a chunk no endpoint will serve reads as null, never as an empty list', async () => {
  /* `[]` is indistinguishable from "no donations in this range" and every caller adds it to a
     total, so one swallowed error silently subtracts real money and the page still looks well. */
  const refusing = [{ getLogs: async () => { throw new Error('range too wide') } }]
  assert.equal(await readChunk({ from: 1n, to: 2n }, refusing), null)
})

test('⭐ a chunk one endpoint refuses is retried on the next one', async () => {
  let asked = 0
  const clients = [
    { getLogs: async () => { asked++; throw new Error('range too wide') } },
    { getLogs: async () => { asked++; return [] } },
  ]
  assert.deepEqual(await readChunk({ from: 1n, to: 2n }, clients), [])
  assert.equal(asked, 2, 'the second endpoint was never tried')
})

test('⛔⛔ an unanswered chunk makes the scan INCOMPLETE and names the range', async () => {
  await withStore(async () => {
    const floor = PAYER_FIRST_BLOCK
    const head = floor + LOG_SPAN * 3n
    let n = 0
    const scan = await fetchAllDonations({
      floor, client: fakeClient(head), useCache: false,
      /* The second chunk is the one nobody serves. */
      readRange: async (r) => (n++ === 1 ? null : []),
    })
    assert.equal(scan.complete, false)
    assert.equal(scan.missing.length, 1)
  })
})

test('⛔⛔ a scan with a hole does NOT move the cache watermark', async () => {
  /* This is the bit that made a one-off network blip permanent: v1 wrote `scannedTo = head`
     whatever happened, so the next visit resumed PAST the hole and re-rendered the short total
     for ever. Keep the rows, never the claim to have read the range. */
  await withStore(async () => {
    const floor = PAYER_FIRST_BLOCK
    const head = floor + LOG_SPAN * 3n
    let n = 0
    await fetchAllDonations({
      floor, client: fakeClient(head), useCache: true,
      readRange: async () => (n++ === 1 ? null : [d(Number(floor) + 1, 0, BASE_USDC, 7)]),
    })
    const cached = readCache()
    assert.ok(cached, 'the rows that WERE read are still kept')
    assert.ok(cached.rows.length > 0)
    assert.equal(cached.scannedTo, floor, 'the watermark must not advance past an unread range')
  })
})

test('⭐ a clean sweep does move the watermark, so the next visit only reads the tail', async () => {
  await withStore(async () => {
    const floor = PAYER_FIRST_BLOCK
    const head = floor + LOG_SPAN * 3n
    const scan = await fetchAllDonations({
      floor, client: fakeClient(head), useCache: true, readRange: async () => [],
    })
    assert.equal(scan.complete, true)
    assert.equal(readCache().scannedTo, head)
  })
})

test('⚠ the cache key is versioned, so v1’s frozen short totals are discarded', () => {
  /* Fixing the walk cannot repair a store that already holds a short total under the old key. */
  assert.match(CACHE_KEY, /:v2:/)
})

test('⚠⚠ the chunk reader is called with ONE argument, never map’s index', async () => {
  /* `batch.map(readChunk)` passes (element, index, array); the index becomes the endpoint list,
     every chunk reads as unanswered, and the headline goes blank for everybody. Caught live. */
  await withStore(async () => {
    const seen = []
    await fetchAllDonations({
      floor: PAYER_FIRST_BLOCK, client: fakeClient(PAYER_FIRST_BLOCK + LOG_SPAN * 2n), useCache: false,
      readRange: async (...args) => { seen.push(args.length); return [] },
    })
    assert.ok(seen.length > 0)
    assert.deepEqual([...new Set(seen)], [1], 'the reader was handed extra arguments')
  })
})
