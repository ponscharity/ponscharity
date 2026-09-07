import { test } from 'node:test'
import assert from 'node:assert/strict'
import { launcherShare, launchesBy, claimableFor, worthCranking, totalsByAsset } from '../src/lib/claimable.ts'

const ME = '0xAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaa'
const OTHER = '0xBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbb'
const ETH = '0x0000000000000000000000000000000000000000'
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'
const L = (o = {}) => ({
  token: '0x' + '11'.repeat(20), creator: ME, charityBps: 10000, launchedAt: 100n,
  pairToken: ETH, pairSymbol: 'ETH', pairDecimals: 18, ...o,
})

/* ── the split, exactly as the contract computes it ──────────────────────────────────────── */

test('⛔ a 100% charity split pays the launcher nothing, however much it trades', () => {
  assert.equal(launcherShare(10n ** 18n, 10000), 0n)
})

test('the launcher gets the remainder at a partial split', () => {
  assert.equal(launcherShare(1000n, 9000), 100n, '10% of the fee')
  assert.equal(launcherShare(1000n, 5000), 500n)
})

test('⛔ dust rounds to the CHARITY, matching _release, so the page never over promises', () => {
  // contract: toOps = amount * (10000 - bps) / 10000, remainder to charity
  assert.equal(launcherShare(9999n, 9999n === 0n ? 0 : 9999), 0n, 'rounds down, never up')
  assert.equal(launcherShare(3n, 5000), 1n, '1.5 becomes 1 for ops, charity keeps 2')
})

test('a nonsense split cannot produce a share above the amount', () => {
  assert.equal(launcherShare(500n, -5), 500n)
  assert.equal(launcherShare(500n, 99999), 0n)
  assert.equal(launcherShare(0n, 5000), 0n)
})

/* ── whose launches ──────────────────────────────────────────────────────────────────────── */

test('only this wallet\'s launches, matched case-insensitively', () => {
  const all = [L({ creator: OTHER }), L({ creator: ME.toLowerCase() })]
  assert.equal(launchesBy(all, ME).length, 1)
  assert.equal(launchesBy(all, ME.toUpperCase().replace('0X', '0x')).length, 1)
})

test('no wallet connected means no rows, never everyone\'s', () => {
  assert.deepEqual(launchesBy([L(), L({ creator: OTHER })], null), [])
})

test('newest first', () => {
  const rows = launchesBy([L({ launchedAt: 10n }), L({ launchedAt: 99n })], ME)
  assert.equal(rows[0].launchedAt, 99n)
})

/* ── the rows ────────────────────────────────────────────────────────────────────────────── */

test('a launch with fees but a 100% split shows the fee and a zero share', () => {
  const rows = claimableFor([L({ charityBps: 10000 })], ME, new Map([['0x' + '11'.repeat(20), 500n]]))
  assert.equal(rows[0].pending, 500n)
  assert.equal(rows[0].yours, 0n)
  assert.equal(rows[0].allToCharity, true, 'the page must say the charity gets it, not show a claimable 0')
})

test('launches with nothing pending are still listed', () => {
  const rows = claimableFor([L()], ME, new Map())
  assert.equal(rows.length, 1, 'an empty page must not be ambiguous between no launches and no fees')
  assert.equal(rows[0].pending, 0n)
})

test('only rows with something pending are worth cranking', () => {
  const rows = claimableFor(
    [L({ token: '0x' + '11'.repeat(20) }), L({ token: '0x' + '22'.repeat(20) })],
    ME, new Map([['0x' + '22'.repeat(20), 7n]]),
  )
  assert.equal(worthCranking(rows).length, 1)
})

test('⛔ totals are per asset and never added across them', () => {
  const rows = claimableFor(
    [L({ token: '0x' + '11'.repeat(20), charityBps: 5000 }),
     L({ token: '0x' + '22'.repeat(20), charityBps: 5000, pairToken: USDG, pairSymbol: 'USDG', pairDecimals: 6 })],
    ME, new Map([['0x' + '11'.repeat(20), 1000n], ['0x' + '22'.repeat(20), 2000n]]),
  )
  const t = totalsByAsset(rows)
  assert.equal(t.length, 2, 'ETH and USDG are two figures, never one')
  assert.equal(t.find((x) => x.symbol === 'ETH').yours, 500n)
  assert.equal(t.find((x) => x.symbol === 'USDG').yours, 1000n)
})

/* ── where the money actually goes ────────────────────────────────────────────────────────── */

/* ⛔⛔ REGRESSION. `payout` was `l.creator`, which is `msg.sender` recorded by the launchpad, while
   the money is pushed to the distributor's `opsVault`, built from the separate `creatorPayout`
   argument the launch form lets the launcher type. Live launch 0x36BF54D2…cD2C has creator
   0xA32456d1…0000 and opsVault 0xb104D58d…F02A, so the old code named an address the money does not
   go to — on a 50% split, i.e. a launch with a real launcher side. */
test('⛔⛔ payout is the distributor opsVault, NOT the creator', () => {
  const TOK = '0x' + '11'.repeat(20)
  const OPS = '0xb104D58dBd2f0fd81AD55965594B80d0F15eF02A'
  const rows = claimableFor([L({ token: TOK, creator: ME, charityBps: 5000 })], ME, new Map(),
    new Map([[TOK.toLowerCase(), OPS]]))
  assert.equal(rows[0].payout, OPS)
  assert.notEqual(rows[0].payout, rows[0].launch.creator, 'the creator is not where the money lands')
})

test('⚠ an unread payout is null, never quietly the creator', () => {
  const rows = claimableFor([L({ creator: ME })], ME, new Map(), new Map())
  assert.equal(rows[0].payout, null, 'a wrong address rendered as fact is worse than none')
})

test('the payout map is matched case-insensitively on the token', () => {
  const TOK = '0x' + 'AB'.repeat(20)
  const OPS = '0xb104D58dBd2f0fd81AD55965594B80d0F15eF02A'
  const rows = claimableFor([L({ token: TOK, creator: ME })], ME, new Map(),
    new Map([[TOK.toLowerCase(), OPS]]))
  assert.equal(rows[0].payout, OPS)
})

/* ── fees that never reached the escrow ───────────────────────────────────────────────────── */

/* ⛔⛔ THE REPORTED BUG. `pending` reads Pons's ESCROW, the second of two hops. Fees accrue first on
   the launch's curve and, once it graduates, in the meme hook; only a SWEEP moves them into the
   escrow. $CHARITY graduated, nothing here or in the keeper ever called `sweepPool`, and so the
   claim page truthfully reported an empty escrow — rendered as "Nothing to collect", on this
   launchpad's largest earner, with a disabled button that explained nothing when pressed. */

const UN = (o = {}) => ({
  where: 'pool', phase: 2, curve: null, pool: { hook: '0x' + 'ee'.repeat(20), poolId: '0x' + '00'.repeat(32) },
  creatorShare: 0n, memePending: 0n, weMaySweep: true, note: '', ...o,
})

test('⛔⛔ a graduated launch with an EMPTY escrow still reports what the pool is holding', () => {
  const TOK = '0x' + '11'.repeat(20)
  const rows = claimableFor([L({ token: TOK, creator: ME })], ME, new Map(), new Map(),
    new Map([[TOK.toLowerCase(), UN({ creatorShare: 161_000n })]]))
  assert.equal(rows[0].pending, 0n, 'the escrow really is empty, and that reading was never wrong')
  assert.equal(rows[0].collectable, 161_000n, 'but the launch has earned, and the page must say so')
})

test('the escrow and the pool are ADDED, because one crank moves both', () => {
  const TOK = '0x' + '11'.repeat(20)
  const rows = claimableFor([L({ token: TOK })], ME, new Map([[TOK.toLowerCase(), 40n]]), new Map(),
    new Map([[TOK.toLowerCase(), UN({ creatorShare: 60n })]]))
  assert.equal(rows[0].collectable, 100n)
})

test('⛔ the launcher\'s share is taken on the FULL collectable, not the escrow alone', () => {
  const TOK = '0x' + '11'.repeat(20)
  const rows = claimableFor([L({ token: TOK, charityBps: 5000 })], ME, new Map(), new Map(),
    new Map([[TOK.toLowerCase(), UN({ creatorShare: 1000n })]]))
  assert.equal(rows[0].yours, 500n, 'an escrow-only share reported zero on every graduated launch')
})

test('⛔⛔ memecoin-denominated fees are NEVER added in — different asset, different units', () => {
  const TOK = '0x' + '11'.repeat(20)
  const rows = claimableFor([L({ token: TOK })], ME, new Map(), new Map(),
    new Map([[TOK.toLowerCase(), UN({ creatorShare: 5n, memePending: 391_263n * 10n ** 18n })]]))
  assert.equal(rows[0].collectable, 5n, 'ether and memecoins do not add, any more than ether and dollars')
})

test('a launch with fees only in the pool IS worth cranking — pressing the button sweeps it', () => {
  const TOK = '0x' + '11'.repeat(20)
  const rows = claimableFor([L({ token: TOK })], ME, new Map(), new Map(),
    new Map([[TOK.toLowerCase(), UN({ creatorShare: 1n })]]))
  assert.equal(worthCranking(rows).length, 1, 'judged on collectable; on pending it was filtered away')
})

test('a launch that has genuinely earned nothing anywhere is still not worth cranking', () => {
  const rows = claimableFor([L()], ME, new Map(), new Map(), new Map())
  assert.equal(worthCranking(rows).length, 0)
  assert.equal(rows[0].collectable, 0n, '"nothing to collect" stays available for the true case')
})

test('⚠ a launch with no unswept entry read still renders, as escrow-only', () => {
  const TOK = '0x' + '11'.repeat(20)
  const rows = claimableFor([L({ token: TOK })], ME, new Map([[TOK.toLowerCase(), 9n]]))
  assert.equal(rows[0].collectable, 9n, 'a failed read must not zero the number the page had')
  assert.equal(rows[0].unswept.where, 'none')
})

test('totals count the pool side too, per asset', () => {
  const A = '0x' + '11'.repeat(20)
  const B = '0x' + '22'.repeat(20)
  const rows = claimableFor(
    [L({ token: A, charityBps: 5000 }),
     L({ token: B, charityBps: 5000, pairToken: USDG, pairSymbol: 'USDG', pairDecimals: 6 })],
    ME, new Map(), new Map(),
    new Map([[A.toLowerCase(), UN({ creatorShare: 1000n })], [B.toLowerCase(), UN({ creatorShare: 2000n })]]),
  )
  const t = totalsByAsset(rows)
  assert.equal(t.length, 2)
  assert.equal(t.find((x) => x.symbol === 'ETH').yours, 500n)
  assert.equal(t.find((x) => x.symbol === 'USDG').collectable, 2000n)
})
