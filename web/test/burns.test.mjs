/**
 * The burns register, and the one thing it must never do: report an unreadable explorer as an
 * empty history.
 *
 * ⛔⛔ THE BUG THIS PINS. `/api/v2/addresses/{a}/logs` on Robinhood Chain's Blockscout answered
 * HTTP 500 to eleven of twelve requests measured back to back on 7 Sep 2026, while the v1 `getLogs`
 * endpoint answered eight of eight. The panel caught the failure, kept its rows empty and printed
 * "Nothing burned yet" about a contract that had burned seven times — beside a headline stat, read
 * off the burner's own counter, showing what those burns had spent.
 *
 * ⚠ The fixtures are REAL responses from that contract, hex quirks and all: v1 gives `timeStamp`
 * and `logIndex` as hex and pads `topics` with nulls.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { fetchBurns } from '../src/lib/burns.ts'

const BOUGHT = '0x0bf775574a8ef30285202d6405288f585f4a0ad2a7062980e61ef43fc069431d'
const DIRECT = '0xe1ac0cefb086b72e2dc8e190bf9a3b1f2abdf8d3c01e98fc95c6f6e29367177a'
/** `Transfer(address,address,uint256)` — a log this register must not decode as a burn. */
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

const w = (n) => n.toString(16).padStart(64, '0')

const v1Log = (topic, words, { tx = '0xaa', logIndex = '0xf', ts = '0x6a9e8ff5' } = {}) => ({
  address: '0x54c28eae367466f925a0ef56b6c1ad091b048694',
  data: `0x${words.map(w).join('')}`,
  logIndex,
  timeStamp: ts,
  topics: [topic, null, null, null],
  transactionHash: tx,
})

const v2Log = (topic, words, { tx = '0xbb', index = 3, at = '2026-09-07T18:47:27.000000Z' } = {}) => ({
  data: `0x${words.map(w).join('')}`,
  topics: [topic],
  transaction_hash: tx,
  block_timestamp: at,
  index,
})

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

/** Serves a scripted answer per request, and records what was asked for. */
function stubFetch(answers) {
  const seen = []
  globalThis.fetch = async (url) => {
    seen.push(String(url))
    const answer = answers[Math.min(seen.length - 1, answers.length - 1)]
    if (answer instanceof Error) throw answer
    return answer
  }
  return seen
}

const v1Ok = (result) => json({ status: '1', message: 'OK', result })
const v1Empty = json({ status: '0', message: 'No logs found', result: [] })
const v1NoArray = json({ status: '0', message: 'No logs found', result: '' })
const fail500 = json('Internal server error', 500)
const fail429 = json({ status: '0', message: 'Too many requests.' }, 429)

test.afterEach(() => { delete globalThis.fetch })

test('v1 answers: hex fields decode, non-burn logs are dropped, newest first', async () => {
  stubFetch([v1Ok([
    v1Log(BOUGHT, [0x679c3c67099daan, 100n, 900n], { tx: '0x01', logIndex: '0xf', ts: '0x6a9e8ff5' }),
    v1Log(TRANSFER, [1n], { tx: '0x02' }),
    v1Log(DIRECT, [50n, 850n], { tx: '0x03', logIndex: '0x4c', ts: '0x6a9e96fc' }),
  ])])

  const scan = await fetchBurns()
  assert.equal(scan.ok, true)
  assert.equal(scan.complete, true)
  /* ⛔ Two rows, not three: the Transfer is matched on topic0 and refused. */
  assert.equal(scan.rows.length, 2)
  assert.deepEqual(scan.rows.map((r) => r.txHash), ['0x03', '0x01'])
  assert.equal(scan.rows[0].kind, 'direct')
  assert.equal(scan.rows[0].burned, 50n)
  assert.equal(scan.rows[0].spent, 0n)
  assert.equal(scan.rows[0].logIndex, 0x4c)
  assert.equal(scan.rows[0].timestamp, 0x6a9e96fc)
  assert.equal(scan.rows[1].kind, 'bought')
  assert.equal(scan.rows[1].spent, 0x679c3c67099daan)
  assert.equal(scan.rows[1].burned, 100n)
  assert.equal(scan.rows[1].supplyAfter, 900n)
})

test('⛔⛔ both sources failing reports UNREADABLE, never an empty register', async () => {
  const seen = stubFetch([fail500])
  const scan = await fetchBurns()
  assert.equal(scan.ok, false)
  assert.equal(scan.rows.length, 0)
  assert.equal(scan.complete, false)
  /* Both endpoints were tried before giving up. */
  assert.ok(seen.some((u) => u.includes('module=logs')), 'v1 tried')
  assert.ok(seen.some((u) => u.includes('/api/v2/addresses/')), 'v2 tried')
})

test('v2 carries the register when v1 is down', async () => {
  stubFetch([fail500, json({ items: [v2Log(BOUGHT, [7n, 8n, 9n], { tx: '0xcc' })], next_page_params: null })])
  const scan = await fetchBurns()
  assert.equal(scan.ok, true)
  assert.equal(scan.complete, true)
  assert.deepEqual(scan.rows.map((r) => r.txHash), ['0xcc'])
  assert.equal(scan.rows[0].burned, 8n)
  assert.equal(scan.rows[0].timestamp, Math.floor(Date.parse('2026-09-07T18:47:27.000000Z') / 1000))
})

test('a genuinely empty history still reads as empty, not as a failure', async () => {
  for (const answer of [v1Empty, v1NoArray, v1Ok([])]) {
    stubFetch([answer])
    const scan = await fetchBurns()
    assert.equal(scan.ok, true, 'answered')
    assert.equal(scan.rows.length, 0)
  }
})

test('⚠ a 429 stops everything — no hammering the penalty box', async () => {
  const seen = stubFetch([fail429])
  const scan = await fetchBurns()
  assert.equal(scan.ok, false)
  assert.equal(seen.length, 1, 'gave up on the first 429')
})

test('a thrown network error on v1 is not a verdict on v2', async () => {
  const seen = stubFetch([new TypeError('Failed to fetch'), json({ items: [], next_page_params: null })])
  const scan = await fetchBurns()
  assert.equal(scan.ok, true)
  assert.equal(seen.length, 2)
})

test('⚠ v2 losing a LATER page keeps the rows but refuses to call the walk complete', async () => {
  stubFetch([
    fail500,
    json({ items: [v2Log(BOUGHT, [1n, 2n, 3n], { tx: '0xd1' })], next_page_params: { block_number: 5, index: 1 } }),
    fail500,
  ])
  const scan = await fetchBurns()
  assert.equal(scan.ok, true)
  assert.equal(scan.complete, false, 'a total off a short walk would understate itself')
  assert.equal(scan.rows.length, 1)
})

test('⚠ an endpoint that ignores `page` is stopped by the dedupe, not left spinning', async () => {
  /* v1 pages with `page`/`offset`. An endpoint that ignored them would hand back a full page of the
     same logs for ever, and the ten-page bound would make ten pointless requests against a rate
     limiter that answers a 429 with a multi-minute lockout. */
  const full = Array.from({ length: 1000 }, (_, i) =>
    v1Log(BOUGHT, [1n, 2n, 3n], { tx: `0x${i.toString(16)}`, logIndex: '0x1' }))
  const seen = stubFetch([v1Ok(full)])

  const scan = await fetchBurns()
  assert.equal(scan.ok, true)
  assert.equal(scan.rows.length, 1000, 'each log once')
  assert.equal(seen.length, 2, 'stopped as soon as a page added nothing new')
})
