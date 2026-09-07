import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkPayer, checkFreshness, checkGas, checkBurn, overall, statusCode, report, nextStuckSince,
  STUCK_GRACE_MS, STALE_WARN_MS, STALE_CRIT_MS, GAS_WARN_WEI, GAS_CRIT_WEI,
  BURN_GAS_WARN_WEI, BURN_GAS_CRIT_WEI, BURN_BACKLOG_WARN_WEI, BURN_BACKLOG_CRIT_WEI,
} from '../src/health.ts'

const NOW = 1_800_000_000_000
const base = {
  payerUsdc: 0n, hasPending: false, ledgerReadable: true,
  sinceLastRunMs: 60_000, keeperGasWei: 100_000_000_000_000_000n, stuckSinceMs: null,
  burnWalletGasWei: 50_000_000_000_000_000n, burnBacklogWei: 40_000_000_000_000_000n,
}

test('⛔ the real incident is caught: money at the payer, nothing claiming it', () => {
  /* 38.128556 USDC sat unattributed for ~40 minutes and blocked every donation. */
  const s = { ...base, payerUsdc: 38_128_556n, hasPending: false, stuckSinceMs: NOW - 40 * 60_000 }
  const c = checkPayer(s, NOW)
  assert.equal(c.level, 'critical')
  assert.match(c.detail, /Every donation is blocked/)
})

test('⛔⛔ a delivery mid-settle is NOT an alert', () => {
  /* Money is at the payer for seconds between landing and being donated. Sampling once would fire
     on that, and an alert that cries wolf is worse than no alert. */
  const s = { ...base, payerUsdc: 2_000_000_000n, hasPending: true }
  assert.equal(checkPayer(s, NOW).level, 'ok')
})

test('an unclaimed balance inside the grace window is not yet a fault', () => {
  const s = { ...base, payerUsdc: 500n, hasPending: false, stuckSinceMs: NOW - 60_000 }
  assert.equal(checkPayer(s, NOW).level, 'ok')
})

test('it becomes a fault once it outlasts the grace window', () => {
  const s = { ...base, payerUsdc: 500n, hasPending: false, stuckSinceMs: NOW - STUCK_GRACE_MS - 1 }
  assert.equal(checkPayer(s, NOW).level, 'critical')
})

test('⚠ an unreadable ledger is unknown, never a fault', () => {
  /* receipts.json is rewritten non-atomically, so a read can land mid-write. That is a bad read,
     not a broken system, and reporting it as one trains somebody to ignore the next real alert. */
  const s = { ...base, payerUsdc: 999n, ledgerReadable: false }
  assert.equal(checkPayer(s, NOW).level, 'unknown')
})

test('⚠ an unreachable chain is unknown, never a fault', () => {
  assert.equal(checkPayer({ ...base, payerUsdc: null }, NOW).level, 'unknown')
  assert.equal(checkGas({ ...base, keeperGasWei: null }).level, 'unknown')
  assert.equal(checkFreshness({ ...base, sinceLastRunMs: null }).level, 'unknown')
})

test('one long pass is normal; three missed ones are not', () => {
  assert.equal(checkFreshness({ ...base, sinceLastRunMs: 20 * 60_000 }).level, 'ok')
  assert.equal(checkFreshness({ ...base, sinceLastRunMs: STALE_WARN_MS }).level, 'warn')
  assert.equal(checkFreshness({ ...base, sinceLastRunMs: STALE_CRIT_MS }).level, 'critical')
})

test('gas warns before it is urgent, and is critical before it is empty', () => {
  assert.equal(checkGas({ ...base, keeperGasWei: GAS_WARN_WEI }).level, 'ok')
  assert.equal(checkGas({ ...base, keeperGasWei: GAS_WARN_WEI - 1n }).level, 'warn')
  assert.equal(checkGas({ ...base, keeperGasWei: GAS_CRIT_WEI - 1n }).level, 'critical')
  /* ⛔ Never waits for zero: at zero the keeper stops with no error anywhere. */
  assert.equal(checkGas({ ...base, keeperGasWei: 0n }).level, 'critical')
})

test('the worst check decides the whole, and unknown does not mask a fault', () => {
  assert.equal(overall([{ id: 'a', level: 'ok', detail: '' }, { id: 'b', level: 'unknown', detail: '' }]), 'unknown')
  assert.equal(overall([{ id: 'a', level: 'unknown', detail: '' }, { id: 'b', level: 'critical', detail: '' }]), 'critical')
  assert.equal(overall([{ id: 'a', level: 'warn', detail: '' }, { id: 'b', level: 'critical', detail: '' }]), 'critical')
})

test('⚠ unknown answers 200, so a rate limited RPC does not page anybody', () => {
  assert.equal(statusCode('unknown'), 200)
  assert.equal(statusCode('ok'), 200)
  assert.equal(statusCode('warn'), 503)
  assert.equal(statusCode('critical'), 503)
})

test('a healthy system reports 200 and says why for each check', () => {
  const r = report(base, NOW)
  assert.equal(r.level, 'ok')
  assert.equal(r.code, 200)
  assert.equal(r.checks.length, 4)
  for (const c of r.checks) assert.ok(c.detail.length > 0, `${c.id} gave no detail`)
})

test('the stuck clock starts when the fault starts, not when the check runs', () => {
  const s = { ...base, payerUsdc: 5n, hasPending: false }
  const first = nextStuckSince(s, null, NOW)
  assert.equal(first, NOW)
  assert.equal(nextStuckSince(s, first, NOW + 600_000), NOW, 'the original time must be carried forward')
})

test('⛔ the clock resets once the payer clears, so a later balance does not alert instantly', () => {
  const stuck = { ...base, payerUsdc: 5n, hasPending: false }
  const cleared = { ...base, payerUsdc: 0n }
  assert.equal(nextStuckSince(cleared, NOW - 3_600_000, NOW), null)
  assert.equal(nextStuckSince(stuck, null, NOW + 1000), NOW + 1000)
})

test('a pending delivery does not start the stuck clock', () => {
  assert.equal(nextStuckSince({ ...base, payerUsdc: 900n, hasPending: true }, null, NOW), null)
})

test('an unreadable ledger does not start the stuck clock either', () => {
  assert.equal(nextStuckSince({ ...base, payerUsdc: 900n, ledgerReadable: false }, null, NOW), null)
})

import { decideNotify, alertBody, RENOTIFY_MS } from '../src/health.ts'

test('⛔⛔ the same fault is not re-sent every five minutes', () => {
  /* Twelve messages an hour for one fault mutes the channel, which is worse than no alerting
     because it looks like coverage. */
  const prev = { level: 'critical', atMs: NOW }
  assert.equal(decideNotify('critical', prev, NOW + 5 * 60_000).send, false)
  assert.equal(decideNotify('critical', prev, NOW + 30 * 60_000).send, false)
})

test('an unresolved fault is repeated once an hour', () => {
  const prev = { level: 'critical', atMs: NOW }
  const d = decideNotify('critical', prev, NOW + RENOTIFY_MS)
  assert.equal(d.send, true)
  assert.equal(d.kind, 'reminder')
})

test('a new fault is sent immediately', () => {
  const d = decideNotify('critical', null, NOW)
  assert.equal(d.send, true)
  assert.equal(d.kind, 'raised')
})

test('an escalation is sent even inside the quiet window', () => {
  /* warn -> critical matters more than not repeating yourself. */
  const d = decideNotify('critical', { level: 'warn', atMs: NOW }, NOW + 60_000)
  assert.equal(d.send, true)
  assert.equal(d.kind, 'worsened')
})

test('recovery is announced once, and only once', () => {
  const rec = decideNotify('ok', { level: 'critical', atMs: NOW }, NOW + 60_000)
  assert.equal(rec.send, true)
  assert.equal(rec.kind, 'recovered')
  assert.equal(decideNotify('ok', { level: 'ok', atMs: NOW }, NOW + 60_000).send, false)
})

test('⚠ `unknown` never announces a recovery', () => {
  /* A rate limited RPC would otherwise send "recovered" while the fault was merely unobservable. */
  const d = decideNotify('unknown', { level: 'critical', atMs: NOW }, NOW + 60_000)
  assert.equal(d.send, false)
})

test('⚠ `unknown` never raises an alert either', () => {
  assert.equal(decideNotify('unknown', null, NOW).send, false)
})

test('a healthy system with no history sends nothing', () => {
  assert.equal(decideNotify('ok', null, NOW).send, false)
})

test('the body carries both Discord and Slack keys, so one URL works either way', () => {
  const b = alertBody('critical', 'raised', [{ id: 'payer', level: 'critical', detail: 'blocked' }], 'https://x')
  assert.equal(b.content, b.text)
  assert.match(b.content, /payer: blocked/)
  assert.match(b.content, /CRITICAL/)
})

test('a recovery message lists the checks rather than only the failing ones', () => {
  const b = alertBody('ok', 'recovered', [{ id: 'payer', level: 'ok', detail: 'the payer is empty' }], 'https://x')
  assert.match(b.content, /recovered/)
  assert.match(b.content, /the payer is empty/)
})


/* ───────────────────────────────── the buy-back-and-burn ───────────────────────────────── */

test('⛔ the 7 Sep state is caught: burn wallet under its push reserve', () => {
  /* It held 0.002948 ETH — under the cranker's 0.003 reserve, so every pass logged "top it up" and
     pushed nothing, while /api/status stayed green because nothing looked at this wallet. */
  const c = checkBurn({ ...base, burnWalletGasWei: 2_948_034_904_064n * 1_000n })
  assert.equal(c.level, 'warn')
  assert.match(c.detail, /under the 0.003 push reserve/)
})

test('⛔⛔ a wallet that cannot sign a burn is critical, and is reported ahead of the backlog', () => {
  /* Gas is the CAUSE and the backlog is the symptom; naming the backlog sends the reader to the
     wrong wallet. */
  const c = checkBurn({
    ...base,
    burnWalletGasWei: 100_000_000_000_000n, // 0.0001 ETH
    burnBacklogWei: BURN_BACKLOG_CRIT_WEI + 1n,
  })
  assert.equal(c.level, 'critical')
  assert.match(c.detail, /cannot sign a buyAndBurn/)
})

test('a pile-up of untaxed income is critical even with gas in the wallet', () => {
  /* The shape the cranker warns about: forward leg unarmed or timer dead, so the mark never moves
     and the site's burn figure stops while fees keep landing. */
  const c = checkBurn({ ...base, burnBacklogWei: BURN_BACKLOG_CRIT_WEI + 1n })
  assert.equal(c.level, 'critical')
  assert.match(c.detail, /the forward leg is not running/)
})

test('⚠ a normal between-passes backlog is NOT a fault', () => {
  /* 0.083 ETH accrued between two passes on 7 Sep. A check that fired on that would be muted in a
     day, and then it would be there for nothing on the day it mattered. */
  const c = checkBurn({ ...base, burnBacklogWei: 83_261_341_039_144_823n })
  assert.equal(c.level, 'ok')
})

test('an unreadable chain is unknown, never a fault', () => {
  assert.equal(checkBurn({ ...base, burnWalletGasWei: null }).level, 'unknown')
  assert.equal(checkBurn({ ...base, burnBacklogWei: null }).level, 'unknown')
})

test('the burn check can turn the whole report red', () => {
  const r = report({ ...base, burnWalletGasWei: 0n }, NOW)
  assert.equal(r.level, 'critical')
  assert.equal(r.code, 503)
})
