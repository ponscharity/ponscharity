import { test } from 'node:test'
import assert from 'node:assert/strict'
import { poolIdFor, readPoolSweep, PHASE, NO_POOL_SWEEP } from '../src/poolSweep.ts'

/**
 * ⛔⛔ The gap these cover: this keeper only ever called `sweepCurve`. Graduating kills the curve
 * and moves every further fee into the meme hook, so a launch stopped being swept the day it
 * graduated — silently, because the pass judges "is there anything to do" off `pending`, which
 * reads the escrow that a sweep is what fills.
 */

const CHARITY = '0x030FA758daD53f0D6e23cfD3a8Fe7bC7B54E5Ac9'
const NATIVE = '0x0000000000000000000000000000000000000000'
const HOOK = '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044'

test('⭐ derives $CHARITY’s real pool id, checked against the live hook', () => {
  /* A GOLDEN VALUE read off Robinhood Chain: `memeHook.launches()` answers `registered: true` for
     this id, naming $CHARITY. `pendingFees` on a WRONG id returns zero rather than reverting, so a
     drifting derivation reports "nothing to sweep" and looks exactly like the truth. */
  assert.equal(
    poolIdFor({ token: CHARITY, pairToken: NATIVE, poolFee: 0, tickSpacing: 200, hook: HOOK }),
    '0x6956ad626704d890e90601e4a7497e6b6a34220ef4016795f3f8031449fb5303',
  )
})

test('the pair order the caller passes cannot change the id', () => {
  const usdg = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'
  assert.equal(
    poolIdFor({ token: CHARITY, pairToken: usdg, poolFee: 0, tickSpacing: 200, hook: HOOK }),
    poolIdFor({ token: usdg, pairToken: CHARITY, poolFee: 0, tickSpacing: 200, hook: HOOK }),
  )
})

/* ── the decision, against a stubbed chain ───────────────────────────────────────────────── */

/** A client that answers the six reads `readPoolSweep` makes, and nothing else. */
const client = (o) => ({
  readContract: async ({ functionName, args }) => {
    if (functionName === 'getLaunchedToken') {
      if (o.record === null) throw new Error('unreachable')
      return { curve: '0x' + 'cc'.repeat(20), poolFee: 0, tickSpacing: 200, phase: o.phase ?? 2, exists: true, ...o.record }
    }
    if (functionName === 'memeHook') return HOOK
    if (functionName === 'launches') {
      return o.registered === false
        ? [false, false, NATIVE, NATIVE, NATIVE, NATIVE, NATIVE, 0, 3000, 0, 0, 0, false]
        : [true, false, o.memecoin ?? CHARITY, NATIVE, NATIVE, NATIVE, NATIVE, 100, 3000, 5000, 100, 300, false]
    }
    const meme = args[1].toLowerCase() === CHARITY.toLowerCase()
    return (meme ? o.meme : o.quote)?.[functionName] ?? 0n
  },
})
const L = { token: CHARITY, pairToken: NATIVE }

test('⛔⛔ a graduated launch with pool fees is swept — the case that was invisible', async () => {
  const r = await readPoolSweep(client({ quote: { pendingFees: 100n, pendingCreatorTax: 100n } }), L)
  assert.equal(r.pool.poolId, '0x6956ad626704d890e90601e4a7497e6b6a34220ef4016795f3f8031449fb5303')
  assert.equal(r.quotePending, 200n, 'the creator tax counts — it is not split with Pons')
  assert.equal(r.weMaySweep, true)
})

test('⛔⛔ memecoin fees make the WHOLE sweep operator-only, including the ETH leg', async () => {
  /* Mirrors the hook's `_requiresTrustedOperator`: memecoin fees have to be converted first, and
     only Pons's operator may run an internal swap. This is $CHARITY's live state. */
  const r = await readPoolSweep(client({
    quote: { pendingFees: 100n }, meme: { pendingFees: 391_263n * 10n ** 18n },
  }), L)
  assert.equal(r.weMaySweep, false)
  assert.match(r.note, /converted first/)
  assert.ok(r.quotePending > 0n, 'the figure is still reported, so the pass can log it')
})

test('a pending buyback is operator-only too', async () => {
  const r = await readPoolSweep(client({ quote: { pendingFees: 100n, pendingBuyback: 5n } }), L)
  assert.equal(r.weMaySweep, false)
  assert.match(r.note, /buyback/)
})

test('⛔ memecoin fees are never added to the quote figure — different asset, different units', async () => {
  const r = await readPoolSweep(client({ quote: { pendingFees: 7n }, meme: { pendingFees: 10n ** 24n } }), L)
  assert.equal(r.quotePending, 7n)
})

test('a graduated pool with nothing pending is not swept, and says nothing', async () => {
  const r = await readPoolSweep(client({}), L)
  assert.equal(r.weMaySweep, false)
  assert.equal(r.note, '', 'a quiet launch must not print a line every fifteen minutes')
})

test('⛔ a launch still on the curve reports NO pool, so the curve sweep still runs', async () => {
  const r = await readPoolSweep(client({ phase: PHASE.onCurve, quote: { pendingFees: 100n } }), L)
  assert.equal(r.pool, null)
  assert.equal(r.phase, PHASE.onCurve)
})

test('⛔ a launch swept off its curve but with no pool yet has nowhere to sweep', async () => {
  const r = await readPoolSweep(client({ phase: PHASE.swept }), L)
  assert.equal(r.pool, null, 'the derivation would produce a well-formed id for a pool that does not exist')
})

test('⛔⛔ an unregistered pool id is NOT believed, however well formed', async () => {
  const r = await readPoolSweep(client({ registered: false, quote: { pendingFees: 100n } }), L)
  assert.equal(r.pool, null)
})

test('⛔⛔ a pool naming a DIFFERENT memecoin is not this launch’s pool', async () => {
  const r = await readPoolSweep(client({ memecoin: '0x' + '99'.repeat(20), quote: { pendingFees: 100n } }), L)
  assert.equal(r.pool, null, 'a collision must never sweep somebody else’s fees into our distributor')
})

test('⚠ an unreadable chain is no pool sweep, never a thrown pass', async () => {
  assert.deepEqual(await readPoolSweep(client({ record: null }), L), NO_POOL_SWEEP)
})
