import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  BLANK_REMAINDER, maxSharePct, withShare, remainderTotalBps, remainderErrors, toSplits,
} from '../src/lib/remainder.ts'

/**
 * ⛔⛔ `CreatorRouter` REVERTS ON A TOTAL THAT IS NOT EXACTLY 10,000.
 *
 * The form used to let the boxes disagree and reported it in red underneath — burn at 100 beside a
 * wallet at 50, reading "150% of 14% — needs to be 100%". The shares are now kept summing to 100 as
 * they are typed, which is only a safe thing to claim if it is actually true for every path in, so
 * it is asserted here rather than read off the JSX.
 */

const wallet = (id, bps) => ({ id, kind: 'wallet', value: `0x${id.repeat(40).slice(0, 40)}`, resolved: null, bps })

const state = (burnOn, ...bpsList) => ({
  burn: { on: burnOn, bps: burnOn ? bpsList[0] : 0 },
  recipients: (burnOn ? bpsList.slice(1) : bpsList).map((b, i) => wallet(String(i + 1), b)),
})

test('⛔⛔ any typed value leaves the legs summing to exactly 100%', () => {
  const shapes = [
    state(true, 3400, 3300, 3300),
    state(false, 5000, 5000),
    state(true, 2500, 2500, 2500, 2500),
    state(false, 2000, 2000, 2000, 2000, 2000),
  ]
  for (const s of shapes) {
    const keys = [...(s.burn.on ? ['burn'] : []), ...s.recipients.map((x) => x.id)]
    for (const k of keys) {
      /* ⚠ Including the values a person actually types by accident: 0, 100 on a four-way split,
         a negative from a paste, and something far past the end. */
      for (const typed of [-40, 0, 1, 7, 50, 99, 100, 500]) {
        const next = withShare(s, k, typed)
        assert.equal(remainderTotalBps(next), 10000,
          `${keys.length} legs, ${k} := ${typed} produced ${remainderTotalBps(next)}`)
      }
    }
  }
})

test('⛔ no leg can be driven to zero — the contract refuses a zero-bps share', () => {
  const s = state(true, 3400, 3300, 3300)
  for (const typed of [100, 500, 98]) {
    const next = withShare(s, 'burn', typed)
    assert.ok(next.burn.bps > 0)
    for (const r of next.recipients) assert.ok(r.bps > 0, `a recipient reached ${r.bps}`)
  }
})

test('⛔ the cap is 100 minus one point for every other leg', () => {
  assert.equal(maxSharePct(state(false, 10000)), 100)
  assert.equal(maxSharePct(state(true, 5000, 5000)), 99)
  assert.equal(maxSharePct(state(true, 2500, 2500, 2500, 2500)), 97)
  /* ⚠ Typing the impossible gives you the cap, not the number you typed. */
  assert.equal(withShare(state(true, 2500, 2500, 2500, 2500), 'burn', 100).burn.bps, 9700)
})

test('⭐ raising one leg takes from the others IN PROPORTION, not off whichever is first', () => {
  /* 20 / 60 / 20 — pushing the first to 40 should leave the middle leg the big one. */
  const s = state(false, 2000, 6000, 2000)
  const next = withShare(s, '1', 40)
  assert.equal(next.recipients[0].bps, 4000)
  assert.ok(next.recipients[1].bps > next.recipients[2].bps)
  assert.equal(remainderTotalBps(next), 10000)
})

test('⚠ a single leg is left alone — it is necessarily the whole remainder', () => {
  const s = state(false, 10000)
  assert.deepEqual(withShare(s, '1', 30), s)
})

test('⛔ the total error is unreachable through the UI, but still guards the contract', () => {
  /* ⚠ Constructed directly, which is the only way to get here now. `remainderErrors` stays the
     mirror of what `CreatorRouter` enforces — it is the last thing between a bad state and a
     wasted launch fee, not a duplicate of the input clamp. */
  const bad = state(true, 10000, 5000)
  assert.match(remainderErrors(bad), /exactly 100%/)
  assert.equal(remainderErrors(withShare(bad, 'burn', 50)), null)
})

test('⛔ mode numbering matches CreatorRouter.Mode — burn 2, wallet 0', () => {
  const s = state(true, 5000, 5000)
  const splits = toSplits(s)
  assert.equal(splits[0].mode, 2)
  assert.equal(splits[1].mode, 0)
  assert.equal(splits.reduce((n, x) => n + x.bps, 0), 10000)
})

test('BLANK_REMAINDER is a valid one-leg state at 100%', () => {
  assert.equal(remainderTotalBps(BLANK_REMAINDER), 10000)
  assert.equal(maxSharePct(BLANK_REMAINDER), 100)
})

test('⛔⛔ soleWallet is a WALLET row, never just the first row', async () => {
  const { soleWallet } = await import('../src/lib/remainder.ts')
  const { isAddress } = await import('viem')
  const ADDR = '0xc42c1009665d9a5e465f93977b87241dee432a22'
  const x = { id: 'a', kind: 'x', value: 'MEADGod', resolved: { provider: 'x', id: '17', handle: 'MEADGod', name: 'O' }, bps: 10000 }
  const w = { id: 'b', kind: 'wallet', value: ADDR, resolved: null, bps: 10000 }

  /* ⛔ The launch that failed: the whole remainder to one X account. This returned "MEADGod", which
     became `creatorPayout`, which viem refused to encode — no revert, no signature, no reason. */
  assert.equal(soleWallet({ burn: { on: false, bps: 0 }, recipients: [x] }), '')
  /* ⚠ And an account row FIRST must not hide the wallet behind it. */
  assert.equal(soleWallet({ burn: { on: false, bps: 0 }, recipients: [{ ...x, bps: 5000 }, { ...w, bps: 5000 }] }), ADDR)
  assert.equal(soleWallet({ burn: { on: false, bps: 0 }, recipients: [w] }), ADDR)

  /* ⭐ The property the launch form actually depends on: whatever comes back is either empty or
     something that can be encoded as an address. */
  for (const r of [[x], [x, w], [w], []]) {
    const got = soleWallet({ burn: { on: false, bps: 0 }, recipients: r })
    assert.ok(got === '' || isAddress(got), `soleWallet returned ${JSON.stringify(got)}`)
  }
})
