import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickTier, minOutFor, worthSelling, CANDIDATE_TIERS } from '../src/sell.ts'

const t = (fee, out, error) => ({ fee, tickSpacing: 1, out, error })

test('the deepest FILL wins, not the deepest pool', () => {
  const c = pickTier([t(100, 90n), t(500, 100n), t(3000, 99n), t(10000, null, 'NoLiquidity')])
  assert.equal(c.ok, true)
  assert.equal(c.fee, 500)
  assert.match(c.reason, /better than fee=3000/)
})

test('MSTR — initialised everywhere, liquid nowhere — is a loud failure with the reasons', () => {
  const c = pickTier(CANDIDATE_TIERS.map((x) => t(x.fee, null, 'NoLiquidity')))
  assert.equal(c.ok, false)
  assert.match(c.reason, /no tier could sell this/)
  assert.match(c.reason, /NoLiquidity/)
})

test('a tier that fills zero is not a tier', () => {
  assert.equal(pickTier([t(3000, 0n)]).ok, false)
})

test('minOut is learned from the simulation, never sent as zero', () => {
  assert.equal(minOutFor(1_000_000n, 50), 995_000n)
  assert.equal(minOutFor(0n), 0n, 'nothing to protect')
})

test('a sale worth less than its gas is refused', () => {
  assert.equal(worthSelling(0.5, 1).sell, false)
  assert.equal(worthSelling(50, 1).sell, true)
})

/* ------------------------------------------------- thin pools need tranching -- */
import { findMaxTranche, sizeTranches } from '../src/sell.ts'

/** Mirrors the measured GME pool: fills up to 5 shares, refuses 20. */
const gmeFits = (cap) => async (size) => size <= cap

test('the whole balance goes in one trade when the pool can take it', async () => {
  assert.equal(await findMaxTranche(5n * 10n ** 18n, gmeFits(10n ** 19n)), 5n * 10n ** 18n)
})

test('a thin pool gets a searched-for size, not a give-up', async () => {
  const cap = 5n * 10n ** 18n
  const found = await findMaxTranche(50n * 10n ** 18n, gmeFits(cap))
  assert.ok(found > 0n, 'must not report the stock unsellable just because the balance is big')
  assert.ok(found <= cap, 'never returns a size known to fail')
  assert.ok(found > cap / 2n, 'and gets reasonably close to the real ceiling')
})

test('a pool that can take nothing right now is a real answer, not a retry', async () => {
  assert.equal(await findMaxTranche(10n ** 18n, async () => false), 0n)
})

test('a balance is split across as many trades as it needs', () => {
  const t = sizeTranches(52n * 10n ** 18n, 5n * 10n ** 18n)
  assert.equal(t.count, 10)
  assert.equal(t.remainder, 2n * 10n ** 18n)
})

test('an unsellable stock reports its whole balance as remainder, not as sold', () => {
  const t = sizeTranches(10n ** 18n, 0n)
  assert.equal(t.count, 0)
  assert.equal(t.remainder, 10n ** 18n)
})
