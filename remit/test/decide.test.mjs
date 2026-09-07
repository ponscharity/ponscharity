import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideRemit, canLeaveRhc, targetFor, BRIDGEABLE_FROM_RHC } from '../src/decide.ts'

const HOUR = 3_600_000
const now = 1_800_000_000_000
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'
const ETH = '0x0000000000000000000000000000000000000000'
const batch = (o) => ({ asset: USDG, symbol: 'USDG', heldSinceMs: now - HOUR, quote: { inUsd: 100, outUsd: 99.9 }, ...o })

test('a healthy USDG batch goes', () => {
  const d = decideRemit(batch(), now)
  assert.equal(d.remit, true)
})

test('dust is held, never burned in fees — even when it is old', () => {
  /* ⚠ Re-pegged when the floor moved 20 -> 5. The PROPERTY is the point and is unchanged: age says
     "stop holding this", never "hold it and also destroy it". Only the amount that counts as dust
     moved, to one the measurements actually call dust — $2.51 bridges at 1.32%. */
  const d = decideRemit(batch({ heldSinceMs: now - 200 * HOUR, quote: { inUsd: 2.51, outUsd: 2.477 } }), now)
  assert.equal(d.remit, false, 'the age override must NOT lift the hard floor')
  assert.match(d.reason, /consolidate it by hand/)
})

test('⛔ the floor is a floor, not a wall — the $19.79 case that sat 27h', () => {
  /* The regression this re-measure was about: 21 cents under the old floor meant NEVER, because the
     floor is checked before the age override. */
  const stuck = batch({ symbol: 'USDG', heldSinceMs: now - 27 * HOUR, quote: { inUsd: 19.79, outUsd: 19.77 } })
  assert.equal(decideRemit(stuck, now).remit, true, '$19.79 must move')
  const small = batch({ asset: ETH, symbol: 'ETH', quote: { inUsd: 6.02, outUsd: 5.975 } })
  assert.equal(decideRemit(small, now).remit, true, 'a $6 batch at 0.75% must move')
})

test('an expensive small batch waits for a bigger one', () => {
  const d = decideRemit(batch({ quote: { inUsd: 25, outUsd: 24.84 } }), now) // 0.64% loss
  assert.equal(d.remit, false)
  assert.match(d.reason, /waiting for a bigger batch/)
})

test('custody beats efficiency once the hold limit passes', () => {
  const stale = batch({ heldSinceMs: now - 25 * HOUR, quote: { inUsd: 25, outUsd: 24.84 } })
  assert.equal(decideRemit(stale, now).remit, true)
})

test('an unpriced quote is an alarm, not a silent hold at zero', () => {
  const d = decideRemit(batch({ quote: { inUsd: 0, outUsd: 0 } }), now)
  assert.equal(d.remit, false)
  assert.match(d.reason, /alarm/)
})

test('a full-size native batch clears its OWN target — the gate is not dead code for ETH', () => {
  // measured: 1 ETH -> mainnet USDC, 0.49% lost
  const eth = batch({ asset: ETH, symbol: 'ETH', quote: { inUsd: 2428.77, outUsd: 2416.78 } })
  assert.equal(decideRemit(eth, now).remit, true)
})

/* ⚠ These two pin the ACTUAL crossover, and they are written from single rows of the measured table
   rather than mixing them. The earlier version of the first one paired the amount of the $121 row
   with the loss of the $5 row — 1.19% on $121.44 — which is a quote that cannot happen: at $121 the
   route measures 0.52%, which is UNDER the target and would remit. It passed, and pinned nothing. */

test('the cost gate now catches a DEGRADED route, not merely a small batch', () => {
  /*
    ⚠⚠ THE GATE'S JOB CHANGED, DELIBERATELY. It used to mean "wait for a bigger batch": at 0.55%
    only ~$30+ could pass. Re-measuring showed that waiting buys almost nothing — $6 held to $20
    saves 1.4 cents — while the floor above it excluded those launches permanently.
    ➤ SIZE is the floor's job now. The target's job is to refuse a route that has gone bad.
  */
  const degraded = batch({ asset: ETH, symbol: 'ETH', quote: { inUsd: 25, outUsd: 24.5 } }) // 2.0%
  const d = decideRemit(degraded, now)
  assert.equal(d.remit, false)
  assert.match(d.reason, /target for ETH/, 'held by the cost target, not the hard floor')

  const healthy = batch({ asset: ETH, symbol: 'ETH', quote: { inUsd: 25, outUsd: 24.8575 } }) // 0.57%
  assert.equal(decideRemit(healthy, now).remit, true)
})

test('0.05 ETH is where the native route becomes worth taking — $121 at 0.52%', () => {
  // measured: 0.52% at $121.44 (0.05 ETH at $2429). Just under the 0.55% target.
  const eth = batch({ asset: ETH, symbol: 'ETH', quote: { inUsd: 121.44, outUsd: 120.81 } })
  assert.equal(decideRemit(eth, now).remit, true,
    'the native target is set just above what the route achieves at size — this is the point it clears')
})

test('each asset is judged against its own achievable floor', () => {
  assert.ok(targetFor(USDG) < targetFor(ETH),
    'USDG is stable-to-stable and must be held to a tighter target than a route that crosses a swap')
})

test('tokenized stocks cannot leave RHC', () => {
  assert.equal(canLeaveRhc('0x0000000000000000000000000000000000000000'), true)
  assert.equal(canLeaveRhc('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'), true)
  assert.equal(canLeaveRhc('0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9'), false) // AAPL
})

test('⛔⛔ a tokenized stock is refused, because the vault could never send it on', () => {
  /* RemitVault has remitToken, remitNative and setKeeper. No swap, no withdraw, no rescue — a
     settable payout address is a withdraw function wearing a different name. So an asset that
     cannot be bridged and is sitting in the vault is not delayed, it is gone. The keeper must
     refuse BEFORE harvesting, because harvest is what pushes the charity's share in there. */
  const STOCKS = [
    '0x1f1bb4b2ef4a2a1d1e0d1d0c1a0e5b0e0d0a0b0c', // any non-approved asset
  ]
  for (const s of STOCKS) assert.equal(canLeaveRhc(s), false, `${s} must not be bridgeable`)
})

test('native ETH and the approved bridgeables are still allowed', () => {
  assert.equal(canLeaveRhc('0x0000000000000000000000000000000000000000'), true)
  for (const addr of Object.keys(BRIDGEABLE_FROM_RHC)) {
    assert.equal(canLeaveRhc(addr), true, `${addr} is listed as bridgeable but was refused`)
  }
})

test('the bridgeable list is a closed allowlist, not a denylist of known stocks', () => {
  /* ⚠ A denylist would pass every stock Robinhood lists tomorrow. Anything not named is refused. */
  assert.equal(canLeaveRhc('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'), false)
})
