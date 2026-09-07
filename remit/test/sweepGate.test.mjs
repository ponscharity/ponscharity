import test from 'node:test'
import assert from 'node:assert/strict'
import { worthSweeping } from '../src/keeper.ts'

/**
 * The gate that stopped the keeper burning its whole balance on nothing.
 *
 * ## ⛔⛔ WHAT THIS IS PROTECTING AGAINST, IN BOTH DIRECTIONS
 *
 * `sweepCurve` succeeds on a curve holding nothing — it moves zero and returns — so the simulate
 * that used to be the only filter passed for every launch still on its curve, and a real
 * transaction went out for each one on every pass. Measured against the live V1 registry on 7 Sep:
 * **40 of 40 sampled curves held zero, and 40 of 40 simulated OK.**
 *
 * ⚠ But the failure mode of a fix like this is worse than the bug: a gate that declines too eagerly
 * silently stops moving real money, which is the exact shape this repo keeps rediscovering. So the
 * unreadable case must sweep.
 */

test('⛔ a confirmed zero does NOT sweep — this is the ~600 tx/pass drain', () => {
  assert.equal(worthSweeping(0n), false)
})

test('a curve with fees sweeps', () => {
  assert.equal(worthSweeping(1n), true)
  assert.equal(worthSweeping(10n ** 18n), true)
})

test('⛔⛔ an UNREADABLE curve sweeps anyway — a gas fix may never become a silent skip', () => {
  assert.equal(worthSweeping(null), true)
})

/**
 * ⚠ The three balances are summed by the caller precisely so this cannot happen: a launch whose
 * plain fee is zero but whose creator tax is not is still worth sweeping. A gate built on
 * `quoteFeeBalance` alone would read zero here and skip real money.
 */
test('⚠ a launch with ONLY creator tax still sweeps, once the three balances are summed', () => {
  const quoteFee = 0n
  const creatorTax = 4_200_000_000_000_000n
  const buyback = 0n
  assert.equal(worthSweeping(quoteFee + creatorTax + buyback), true)
  // and the under-reporting version would have been wrong:
  assert.equal(worthSweeping(quoteFee), false)
})
