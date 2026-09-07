import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseLedger, remittedFor, decideDelivery, hasArrived, noteHeld, EMPTY_LEDGER } from '../src/settle.ts'

const TOKEN_A = '0xAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaa'
const TOKEN_B = '0xBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbb'
const pendingFor = (o = {}) => ({
  token: TOKEN_B, charityId: '0x' + 'cc'.repeat(32), amount: '100000000',
  requestId: '0x' + 'dd'.repeat(32), bridgedAtMs: 1_800_000_000_000, ...o,
})

/* ── the bug this module exists for ──────────────────────────────────────────────────────── */

test("a launch's delivery is never donated to the NEXT launch's charity", () => {
  // B bridged, the wait expired, B's money is sitting at the payer undonated.
  const d = decideDelivery(100_000_000n, pendingFor({ token: TOKEN_B }))
  assert.equal(d.action, 'settle', 'the balance belongs to B and must be paid to B first')
  assert.equal(d.pending.token, TOKEN_B)
})

test('money at the payer with no record of whose it is STOPS the keeper — it never picks a charity', () => {
  const d = decideDelivery(100_000_000n, null)
  assert.equal(d.action, 'blocked')
  assert.match(d.reason, /Refusing to guess/)
  assert.match(d.reason, /NOT lost/, 'the operator must be told it is recoverable, not that it is gone')
})

test('nothing may bridge while another launch\'s delivery is still in flight', () => {
  const d = decideDelivery(0n, pendingFor())
  assert.equal(d.action, 'awaiting', 'bridging now would put two launches in one all-or-nothing balance')
})

test('an empty payer with nothing in flight is the only state that may bridge', () => {
  assert.equal(decideDelivery(0n, null).action, 'clear')
})

/* ── arrival is a delta, not a balance ───────────────────────────────────────────────────── */

test('arrival is measured as an increase, so a stale balance is never read as our delivery', () => {
  assert.equal(hasArrived(100_000_000n, 100_000_000n), false, 'unchanged means nothing landed')
  assert.equal(hasArrived(100_000_000n, 150_000_000n), true)
  assert.equal(hasArrived(0n, 0n), false)
  assert.equal(hasArrived(0n, 1n), true)
})

/* ── the ledger, the one piece of state that cannot be rebuilt from chain ────────────────── */

test('the original flat receipts shape is migrated, not lost', () => {
  const l = parseLedger({ [TOKEN_A.toLowerCase()]: '250', [TOKEN_B.toLowerCase()]: '900' })
  assert.equal(l.version, 2)
  assert.equal(remittedFor(l, TOKEN_A), 250n)
  assert.equal(remittedFor(l, TOKEN_B), 900n)
  assert.equal(l.pending, null)
})

test('the ledger is read case-insensitively — a checksummed key must not read as zero', () => {
  const l = parseLedger({ version: 2, remitted: { [TOKEN_A.toLowerCase()]: '250' }, pending: null })
  assert.equal(remittedFor(l, TOKEN_A), 250n, 'querying with the checksummed address must find it')
})

test('an unreadable ledger is absent, never a throw — and absent plus money is blocked, not sent', () => {
  for (const junk of [null, undefined, 'nonsense', 42, []]) {
    const l = parseLedger(junk)
    assert.equal(remittedFor(l, TOKEN_A), 0n)
  }
  // and the consequence of losing it is a stop, not a double send
  assert.equal(decideDelivery(100_000_000n, parseLedger(null).pending).action, 'blocked')
})

test('a v2 ledger round-trips through JSON with its pending delivery intact', () => {
  const before = { ...EMPTY_LEDGER, remitted: { [TOKEN_A.toLowerCase()]: '5' }, pending: pendingFor() }
  const after = parseLedger(JSON.parse(JSON.stringify(before)))
  assert.deepEqual(after.pending, before.pending)
  assert.equal(remittedFor(after, TOKEN_A), 5n)
  assert.equal(after.pending.requestId, pendingFor().requestId,
    'the request id is what makes a stuck delivery resolvable without this file')
})

/* ── how long a batch has been held, which is what the custody override judges ───────────── */

test('the held clock starts when a balance first appears', () => {
  const l = { ...EMPTY_LEDGER, remitted: {}, heldSince: {} }
  assert.equal(noteHeld(l, TOKEN_A, 100n, 1000), 1000)
  assert.equal(noteHeld(l, TOKEN_A, 100n, 9999), 1000, 'a later pass must not restart the clock')
})

test('the held clock SURVIVES a capped remit — the remainder really has been waiting', () => {
  const l = { ...EMPTY_LEDGER, remitted: {}, heldSince: {} }
  noteHeld(l, TOKEN_A, 500n, 1000)          // owed 500, cap sends 200
  assert.equal(noteHeld(l, TOKEN_A, 300n, 5000), 1000,
    'a launch earning faster than the cap would otherwise never look old and never be forced out')
})

test('the held clock resets only once the launch owes nothing', () => {
  const l = { ...EMPTY_LEDGER, remitted: {}, heldSince: {} }
  noteHeld(l, TOKEN_A, 500n, 1000)
  noteHeld(l, TOKEN_A, 0n, 5000)
  assert.equal(l.heldSince[TOKEN_A.toLowerCase()], undefined)
  assert.equal(noteHeld(l, TOKEN_A, 10n, 8000), 8000, 'the next batch is its own batch')
})

test('the held clock is keyed case-insensitively, like every other ledger read', () => {
  const l = { ...EMPTY_LEDGER, remitted: {}, heldSince: {} }
  noteHeld(l, TOKEN_A.toLowerCase(), 1n, 1000)
  assert.equal(noteHeld(l, TOKEN_A, 1n, 4000), 1000)
})

test('heldSince survives a JSON round trip and is absent from the migrated flat shape', () => {
  const l = parseLedger({ [TOKEN_A.toLowerCase()]: '250' })
  assert.deepEqual(l.heldSince, {}, 'an old ledger has no clock, so every batch starts fresh')
  const l2 = { ...EMPTY_LEDGER, heldSince: { [TOKEN_A.toLowerCase()]: 1234 } }
  assert.equal(parseLedger(JSON.parse(JSON.stringify(l2))).heldSince[TOKEN_A.toLowerCase()], 1234)
})

/* ── a completed delivery must not wedge the keeper for ever ─────────────────────────────── */

test('⛔ a pending record older than the stale window RELEASES rather than waiting for ever', () => {
  const p = pendingFor({ bridgedAtMs: 1_000_000 })
  // the payer is empty: either it has not landed, or it landed and was already donated
  const fresh = decideDelivery(0n, p, 1_000_000 + 60_000)
  assert.equal(fresh.action, 'awaiting', 'a minute old is still genuinely in flight')

  const old = decideDelivery(0n, p, 1_000_000 + 31 * 60_000)
  assert.equal(old.action, 'stale', 'half an hour on, it cannot still be in flight')
  assert.match(old.reason, /donated already or refunded/)
  assert.match(old.reason, /0xdddd/i, 'the request id stays in the message so a human can resolve it')
})

test('⚠ a stale window that is too short would abandon a real delivery', () => {
  const p = pendingFor({ bridgedAtMs: 1_000_000 })
  assert.equal(decideDelivery(0n, p, 1_000_000 + 29 * 60_000).action, 'awaiting',
    'just under the window must still wait; releasing early donates one launch money to another')
})

test('money AT the payer always settles, however old the record', () => {
  const p = pendingFor({ bridgedAtMs: 1 })
  assert.equal(decideDelivery(500n, p, 1 + 99 * 60 * 60_000).action, 'settle',
    'a balance present is never ambiguous, so age never overrides it')
})

test('⛔⛔ a field this version does not know about survives a read and write', () => {
  /* The keeper on the box was older than the file and rebuilt a fixed shape, so `donations` was
     erased on every save: 23 backfilled records gone, no error, nothing in the log. receipts.json
     cannot be rebuilt from any chain, so the reader must lose nothing it does not understand. */
  const fromDisk = {
    version: 2, remitted: { '0xa': '1' }, pending: null, heldSince: {},
    donations: [{ token: '0xa', payTx: '0xtx', amount: '5', charityId: '0xc', requestId: '', at: 1 }],
    somethingAddedLater: { keep: 'me' },
  }
  const out = parseLedger(fromDisk)
  assert.equal(out.donations.length, 1, 'donations were dropped')
  assert.deepEqual(out.somethingAddedLater, { keep: 'me' }, 'an unknown field was dropped')
  assert.equal(out.remitted['0xa'], '1')
})

test('a ledger with no donations array reads as empty, not undefined', () => {
  const out = parseLedger({ version: 2, remitted: {}, pending: null, heldSince: {} })
  assert.deepEqual(out.donations, [])
})
