/**
 * The burn cranker's high-water mark.
 *
 * ⛔⛔ WHY THIS FILE EXISTS. This arithmetic decides whether an arrival is taxed once, twice or
 * never, and until 7 Sep 2026 it lived inline at the bottom of the pass with no test and no name.
 * A stale mark forwards a SECOND cut of the same money out of ops; an over-advanced one silently
 * forgives real burn share. Both are invisible from a balance.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { markAfter } from '../ops/burn-cranker.mjs'

const BPS = 8000n // 40% of total = 80% of the ops half
const E = 1_000_000_000_000_000_000n

test('a full forward advances the mark by the whole arrival', () => {
  const arrived = E / 10n // 0.1 ETH
  const want = (arrived * BPS) / 10_000n
  assert.equal(markAfter(0n, arrived, want, BPS), arrived)
})

test('a short forward advances only by the slice it paid, so the rest stays owed', () => {
  const arrived = 83_261_341_039_144_823n // the real 7 Sep figure
  const want = (arrived * BPS) / 10_000n
  const paid = 40_554_602_742_381_527n // what ops could actually afford
  const mark = markAfter(0n, arrived, paid, BPS)

  assert.ok(mark < arrived, 'a short pass must NOT advance to the full arrival')
  assert.equal(mark, 50_693_253_427_976_908n)

  /* ⭐ The remainder the next pass re-charges is the cut that could not be taken this time.
     ⚠ Asserted as an invariant, not a magic constant: two integer floors sit between `arrived` and
     this number, so it lands within a wei or two of `want - paid`. What must never happen is it
     coming out MATERIALLY SHORT, which would forgive burn share every time a pass ran short. */
  const stillOwed = ((arrived - mark) * BPS) / 10_000n
  const drift = stillOwed - (want - paid)
  assert.ok(drift >= -2n && drift <= 2n, `re-charged ${stillOwed}, expected ~${want - paid}`)
  assert.equal(stillOwed, 26_054_470_088_934_332n) // the 0.02605447 ETH reported on 7 Sep
})

test('forwarding nothing leaves the mark exactly where it was', () => {
  const last = 15_332_382_168_420_814_570n
  assert.equal(markAfter(last, E, 0n, BPS), last, 'a short-with-empty-wallet pass must not advance')
})

test('no arrival cannot move the mark even if something was forwarded by hand', () => {
  const last = 99n
  assert.equal(markAfter(last, 0n, E, BPS), last)
})

test('the mark can never overshoot the arrival', () => {
  // A manual top-up of the burn wallet, or a bps change between passes, must not forgive future income.
  const arrived = E
  assert.equal(markAfter(0n, arrived, E * 10n, BPS), arrived)
})

test('two passes over one arrival land where a single full pass would', () => {
  const arrived = E
  const want = (arrived * BPS) / 10_000n
  const first = markAfter(0n, arrived, want / 2n, BPS)
  const remaining = arrived - first
  const second = markAfter(first, remaining, (remaining * BPS) / 10_000n, BPS)
  assert.equal(second, arrived, 'splitting a payment must not lose or duplicate any of it')
})
