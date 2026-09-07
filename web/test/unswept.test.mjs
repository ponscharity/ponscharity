import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  poolIdFor, splitCreatorShare, isOperatorOnly, INTERNAL_SWAP_REQUIRES_OPERATOR,
} from '../src/lib/unswept.ts'

/**
 * The reads that decide whether this site can see a launch's fees at all.
 *
 * ⛔⛔ The bug these cover: `pending()` reads Pons's ESCROW, which is the second hop. Fees accrue
 * first on the curve and, after graduation, in the meme hook. $CHARITY graduated, so its escrow was
 * genuinely empty while real fees piled up in the hook, and the claim page rendered that as
 * "Nothing to collect" with a dead button.
 */

/* ── the pool id ─────────────────────────────────────────────────────────────────────────── */

const CHARITY = '0x030FA758daD53f0D6e23cfD3a8Fe7bC7B54E5Ac9'
const NATIVE = '0x0000000000000000000000000000000000000000'
const HOOK = '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044'

test('⭐ derives $CHARITY’s real pool id, checked against the live hook', () => {
  /* ⛔⛔ A GOLDEN VALUE, NOT A ROUND TRIP OF THE SAME MATHS. Read off Robinhood Chain: this id is
     the one `memeHook.launches()` answers `registered: true` for, naming $CHARITY as the memecoin.
     `pendingFees` on a WRONG id returns zero rather than reverting, so a derivation that drifts
     would report "no fees" — indistinguishable from the truth, and the exact failure this page was
     reported for. Anything that changes the encoding has to break this test. */
  assert.equal(
    poolIdFor({ token: CHARITY, pairToken: NATIVE, poolFee: 0, tickSpacing: 200, hook: HOOK }),
    '0x6956ad626704d890e90601e4a7497e6b6a34220ef4016795f3f8031449fb5303',
  )
})

test('⚠ currencies are SORTED, so the pair order the caller passes cannot change the id', () => {
  const usdg = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'
  const a = poolIdFor({ token: CHARITY, pairToken: usdg, poolFee: 0, tickSpacing: 200, hook: HOOK })
  const b = poolIdFor({ token: usdg, pairToken: CHARITY, poolFee: 0, tickSpacing: 200, hook: HOOK })
  assert.equal(a, b)
})

test('⛔ the hook is part of the key, so the wrong hook is a different pool', () => {
  const other = '0x1111111111111111111111111111111111111111'
  assert.notEqual(
    poolIdFor({ token: CHARITY, pairToken: NATIVE, poolFee: 0, tickSpacing: 200, hook: HOOK }),
    poolIdFor({ token: CHARITY, pairToken: NATIVE, poolFee: 0, tickSpacing: 200, hook: other }),
  )
})

/* ── the split ───────────────────────────────────────────────────────────────────────────── */

test('Pons keeps its share of the plain fee, so the gross is never the creator’s', () => {
  assert.equal(splitCreatorShare(1000n, 0n, 0n, 3000), 700n)
})

test('⭐ the creator TAX is not split — the trap that halves a taxed launch’s figure', () => {
  /* $CHARITY: hookFeeBps 100 and creatorTaxBps 100, so on the same volume the two legs are equal.
     Reading only `quoteFeeBalance` would report 700 where 1700 is owed. */
  assert.equal(splitCreatorShare(1000n, 1000n, 0n, 3000), 1700n)
})

test('a pending buyback comes out of the creator’s bucket, not Pons’s', () => {
  assert.equal(splitCreatorShare(1000n, 0n, 200n, 3000), 500n)
})

test('⛔ a buyback larger than the bucket floors at zero rather than going negative', () => {
  assert.equal(splitCreatorShare(1000n, 0n, 5000n, 3000), 0n)
  assert.equal(splitCreatorShare(1000n, 50n, 5000n, 3000), 50n, 'the tax survives it')
})

test('a nonsense protocol share cannot invent or destroy money', () => {
  assert.equal(splitCreatorShare(1000n, 0n, 0n, -1), 1000n)
  assert.equal(splitCreatorShare(1000n, 0n, 0n, 99999), 0n)
  assert.equal(splitCreatorShare(0n, 0n, 0n, 3000), 0n)
})

/* ── classifying the revert ──────────────────────────────────────────────────────────────── */

test('⛔⛔ an operator-only sweep is recognised by SELECTOR, not by message text', () => {
  /* viem renders an unknown custom error as bare hex with no name. A message match would classify
     every operator-only sweep as an unknown failure and show a launcher raw calldata. */
  assert.equal(INTERNAL_SWAP_REQUIRES_OPERATOR, '0x31cdb504')
  assert.ok(isOperatorOnly({ cause: { data: INTERNAL_SWAP_REQUIRES_OPERATOR } }))
  assert.ok(isOperatorOnly({ data: '0x8d42130c' }), 'NotFeeSweepOperator too')
})

test('the selector is found however deep viem buried it', () => {
  assert.ok(isOperatorOnly({ cause: { cause: { data: { data: '0x31cdb504' } } } }))
})

test('⚠ a cyclic error object terminates instead of hanging the page', () => {
  const e = { cause: null }
  e.cause = e
  assert.equal(isOperatorOnly(e), false)
})

test('any other revert is NOT reported as waiting on Pons', () => {
  assert.equal(isOperatorOnly({ cause: { data: '0xdeadbeef' } }), false)
  assert.equal(isOperatorOnly(new Error('execution reverted')), false)
  assert.equal(isOperatorOnly(null), false)
})
