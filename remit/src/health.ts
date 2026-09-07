/**
 * Is the launchpad actually delivering money, and if not, what stopped it?
 *
 * ## ⭐⭐ WHY THIS EXISTS
 *
 * On 29 Aug 2026 donations were halted for about forty minutes and nothing said so. The keeper's
 * refusal is a log line on a box nobody watches; the site kept serving, the timer kept firing, and
 * every pass ended by declining to send. It was found by a person going to look.
 *
 * ➤ The system is now complex enough that SILENT FAILURE is the main risk, not bugs. This module is
 * the smallest thing that turns the three states which have actually stopped money into something a
 * free uptime monitor can see.
 *
 * ## ⛔⛔ AN ALERT THAT CRIES WOLF IS WORSE THAN NO ALERT
 *
 * Every check here is written to be quiet during NORMAL operation, including the normal transients:
 *
 * - Money sits at the payer legitimately, for seconds, between a bridge landing and its donation.
 *   Sampling once would fire on that. So a stuck payer must PERSIST across checks before it counts.
 * - `receipts.json` is rewritten by the keeper in a way that is not atomic, so a read can land
 *   mid-write. That is an unreadable file, not a broken system, and it reports `unknown` — never a
 *   fault, because a false alarm teaches somebody to ignore the next real one.
 *
 * ⛔ This module decides only. It never writes the ledger, never signs, never touches the keeper.
 */

export type Level = 'ok' | 'warn' | 'critical' | 'unknown'

export type Sample = {
  /** USDC at the shared payer, 6dp. `null` when Base could not be read. */
  payerUsdc: bigint | null
  /** True when the ledger names a delivery that is in flight or landed and undonated. */
  hasPending: boolean
  /** False when `receipts.json` could not be read or parsed. */
  ledgerReadable: boolean
  /** ms since the keeper last finished a pass successfully. `null` when unknown. */
  sinceLastRunMs: number | null
  /** Keeper's gas on Robinhood Chain, wei. `null` when the chain could not be read. */
  keeperGasWei: bigint | null
  /** Burn wallet's gas, wei. It signs every buyAndBurn. `null` when the chain could not be read. */
  burnWalletGasWei: bigint | null
  /** `totalToOps` minus the burn cranker's high-water mark, wei — fee income not yet taxed for the
      burn. `null` when either side could not be read. */
  burnBacklogWei: bigint | null
  /** When this same fault was first seen, from the previous status file. */
  stuckSinceMs: number | null
}

export type Check = { id: string; level: Level; detail: string }

/* ── thresholds, all in one place so they can be argued with ─────────────────────────────────── */

/** ⚠ The timer is every 15 min. Three missed passes, not one: a single long pass is normal. */
export const STALE_WARN_MS = 45 * 60 * 1000
export const STALE_CRIT_MS = 90 * 60 * 1000

/**
 * ⚠ Measured 29 Aug: about 0.036 ETH/day under heavy delivery. The warn level is roughly a day of
 * warning and the critical level about ten hours, which is the point at which somebody has to act
 * rather than notice.
 */
export const GAS_WARN_WEI = 40_000_000_000_000_000n   // 0.04 ETH
export const GAS_CRIT_WEI = 15_000_000_000_000_000n   // 0.015 ETH

/**
 * ⛔⛔ How long an unattributed payer balance must persist before it is a fault.
 *
 * A bridge lands and is donated seconds later, and in that window the payer legitimately holds money
 * with the pending record already cleared. Ten minutes is far longer than that gap and far shorter
 * than the forty minutes the real incident went unnoticed.
 */
export const STUCK_GRACE_MS = 10 * 60 * 1000

export function checkPayer(s: Sample, now = Date.now()): Check {
  if (!s.ledgerReadable) {
    return { id: 'payer', level: 'unknown', detail: 'the ledger could not be read, so nothing can be said about the payer' }
  }
  if (s.payerUsdc === null) {
    return { id: 'payer', level: 'unknown', detail: 'Base could not be read' }
  }
  if (s.payerUsdc === 0n) {
    return { id: 'payer', level: 'ok', detail: 'the payer is empty' }
  }
  const usdc = `${(Number(s.payerUsdc) / 1e6).toFixed(6)} USDC`
  if (s.hasPending) {
    /* Normal: a delivery is in flight or has landed and is about to be donated. */
    return { id: 'payer', level: 'ok', detail: `${usdc} at the payer, claimed by the pending record` }
  }
  const heldMs = s.stuckSinceMs === null ? 0 : now - s.stuckSinceMs
  if (heldMs < STUCK_GRACE_MS) {
    return { id: 'payer', level: 'ok', detail: `${usdc} at the payer, unclaimed for ${Math.round(heldMs / 1000)}s — within the settle window` }
  }
  /* ⛔ This is the state that halts EVERY donation: the gate refuses to guess whose money it is. */
  return {
    id: 'payer',
    level: 'critical',
    detail: `${usdc} at the payer with no pending record for ${Math.round(heldMs / 60000)} minutes. Every donation is blocked until it is attributed.`,
  }
}

export function checkFreshness(s: Sample): Check {
  if (s.sinceLastRunMs === null) {
    return { id: 'keeper', level: 'unknown', detail: 'the last run time could not be read' }
  }
  const mins = Math.round(s.sinceLastRunMs / 60000)
  if (s.sinceLastRunMs >= STALE_CRIT_MS) {
    return { id: 'keeper', level: 'critical', detail: `no successful pass for ${mins} minutes` }
  }
  if (s.sinceLastRunMs >= STALE_WARN_MS) {
    return { id: 'keeper', level: 'warn', detail: `no successful pass for ${mins} minutes` }
  }
  return { id: 'keeper', level: 'ok', detail: `last pass ${mins} minutes ago` }
}

export function checkGas(s: Sample): Check {
  if (s.keeperGasWei === null) {
    return { id: 'gas', level: 'unknown', detail: 'Robinhood Chain could not be read' }
  }
  const eth = (Number(s.keeperGasWei) / 1e18).toFixed(6)
  if (s.keeperGasWei < GAS_CRIT_WEI) {
    return { id: 'gas', level: 'critical', detail: `${eth} ETH — the keeper stops when this empties, with no error anywhere` }
  }
  if (s.keeperGasWei < GAS_WARN_WEI) {
    return { id: 'gas', level: 'warn', detail: `${eth} ETH — top it up` }
  }
  return { id: 'gas', level: 'ok', detail: `${eth} ETH` }
}

/**
 * ⛔ Below this the burn wallet cannot pay for the `buyAndBurn` it exists to sign. It is not the
 * cranker's 0.003 push reserve — that one self-heals the moment ops forwards again — it is the
 * point at which the wallet is genuinely stuck.
 */
export const BURN_GAS_CRIT_WEI = 500_000_000_000_000n // 0.0005 ETH
/** The cranker's own `CRANK_GAS_RESERVE`: under this it pushes nothing and says so, once, in a log. */
export const BURN_GAS_WARN_WEI = 3_000_000_000_000_000n // 0.003 ETH

/* ⚠ Generous on purpose. A backlog between passes is NORMAL — it is what the high-water mark is
   for — so these are set well above a half-hour of income (~0.04 ETH a pass on 7 Sep). They fire on
   a PILE-UP: a stalled timer, a forward leg that never armed, or an ops wallet being spent down
   faster than the burn can take its cut. */
export const BURN_BACKLOG_CRIT_WEI = 2_000_000_000_000_000_000n // 2 ETH
export const BURN_BACKLOG_WARN_WEI = 500_000_000_000_000_000n // 0.5 ETH

/**
 * The buy-back-and-burn, which fails SILENTLY in both of its own documented ways.
 *
 * ⛔⛔ WHY THIS EARNS A CHECK. `burn-cranker.mjs` warns that with the ops key armed and the burn key
 * missing, "the mark keeps advancing, so it reads as a healthy pass while the pile grows and the
 * site's burn figure stays at zero", and that a wallet under its gas reserve stops burning with
 * nothing but a log line to say so. Neither is visible from the donations pipeline this file was
 * built to watch, and neither moves `/api/status` — so on 7 Sep the burn wallet sat under its
 * reserve and the page stayed green.
 */
export function checkBurn(s: Sample): Check {
  if (s.burnWalletGasWei === null || s.burnBacklogWei === null) {
    return { id: 'burn', level: 'unknown', detail: 'the burn wallet or the high-water mark could not be read' }
  }
  const gas = (Number(s.burnWalletGasWei) / 1e18).toFixed(6)
  const backlog = (Number(s.burnBacklogWei) / 1e18).toFixed(6)

  /* ⛔ Gas first: a wallet that cannot sign makes the backlog a SYMPTOM, and reporting the symptom
     would send whoever reads this to the wrong wallet. */
  if (s.burnWalletGasWei < BURN_GAS_CRIT_WEI) {
    return { id: 'burn', level: 'critical', detail: `burn wallet holds ${gas} ETH — it cannot sign a buyAndBurn, so nothing burns` }
  }
  if (s.burnBacklogWei > BURN_BACKLOG_CRIT_WEI) {
    return { id: 'burn', level: 'critical', detail: `${backlog} ETH of ops income untaxed for the burn — the forward leg is not running` }
  }
  if (s.burnWalletGasWei < BURN_GAS_WARN_WEI) {
    return { id: 'burn', level: 'warn', detail: `burn wallet holds ${gas} ETH, under the 0.003 push reserve — top it up` }
  }
  if (s.burnBacklogWei > BURN_BACKLOG_WARN_WEI) {
    return { id: 'burn', level: 'warn', detail: `${backlog} ETH of ops income still untaxed for the burn` }
  }
  return { id: 'burn', level: 'ok', detail: `burn wallet ${gas} ETH · ${backlog} ETH awaiting its cut` }
}

/**
 * ⚠ `unknown` is NOT a fault. A monitor that goes red because a public RPC rate limited us would be
 * trained away within a week. It is surfaced in the body so a human reading the page can see it.
 */
export const WORST: Record<Level, number> = { ok: 0, unknown: 0, warn: 1, critical: 2 }

export function overall(checks: Check[]): Level {
  let worst: Level = 'ok'
  for (const c of checks) if (WORST[c.level] > WORST[worst]) worst = c.level
  if (worst === 'ok' && checks.some((c) => c.level === 'unknown')) return 'unknown'
  return worst
}

/** 200 while money can still move, 503 once something is actually stopping it. */
export const statusCode = (level: Level) => (level === 'critical' || level === 'warn' ? 503 : 200)

export function report(s: Sample, now = Date.now()) {
  const checks = [checkPayer(s, now), checkFreshness(s), checkGas(s), checkBurn(s)]
  const level = overall(checks)
  return { level, code: statusCode(level), checks, at: now }
}

/**
 * Carry forward when a stuck payer was FIRST seen, so the grace window measures the fault rather
 * than the time since this check last ran.
 *
 * ⚠ Cleared the moment the condition clears, so a payer that empties and later fills again starts a
 * fresh window instead of inheriting an old one and alerting instantly.
 */
export function nextStuckSince(s: Sample, previous: number | null, now = Date.now()): number | null {
  const unattributed = s.ledgerReadable && s.payerUsdc !== null && s.payerUsdc > 0n && !s.hasPending
  if (!unattributed) return null
  return previous ?? now
}

/* ══ notifying a human ═══════════════════════════════════════════════════════════════════════════

   ⛔⛔ AN ALERT THAT REPEATS EVERY CHECK IS AN ALERT THAT GETS MUTED.

   The health check runs every five minutes. Posting on every unhealthy run would send twelve
   messages an hour for one fault, and the predictable result is a muted channel — which is worse
   than no alerting at all, because it looks like coverage.

   ➤ So a message is sent when the state CHANGES, and then at most once an hour while it persists.
   Recovery is announced once, because a fault that goes quiet is otherwise indistinguishable from
   one nobody fixed.
*/

/** How long before the same unresolved fault is repeated. */
export const RENOTIFY_MS = 60 * 60 * 1000

export type NotifyState = { level: Level; atMs: number } | null

export type NotifyDecision =
  | { send: false; reason: string }
  | { send: true; kind: 'raised' | 'worsened' | 'reminder' | 'recovered'; reason: string }

export function decideNotify(current: Level, previous: NotifyState, now = Date.now()): NotifyDecision {
  const bad = (l: Level) => l === 'warn' || l === 'critical'

  if (!bad(current)) {
    /* ⚠ `unknown` is not healthy enough to announce a recovery from: a rate limited RPC would send
       "recovered" while the fault was merely unobservable. Only a clean `ok` clears it. */
    if (previous && bad(previous.level) && current === 'ok') {
      return { send: true, kind: 'recovered', reason: 'the fault has cleared' }
    }
    return { send: false, reason: 'nothing wrong' }
  }

  if (!previous || !bad(previous.level)) {
    return { send: true, kind: 'raised', reason: 'a new fault' }
  }
  if (WORST[current] > WORST[previous.level]) {
    return { send: true, kind: 'worsened', reason: `escalated from ${previous.level}` }
  }
  if (now - previous.atMs >= RENOTIFY_MS) {
    return { send: true, kind: 'reminder', reason: 'still unresolved an hour later' }
  }
  return { send: false, reason: 'already reported, and not yet due a reminder' }
}

/**
 * The message body, shaped so ONE implementation covers the services people actually use.
 *
 * ⚠ Discord reads `content`, Slack and Mattermost read `text`. Sending both means a webhook URL can
 * be pasted in without anyone having to say which service it belongs to, and a generic endpoint
 * still receives readable JSON.
 */
export function alertBody(level: Level, kind: string, checks: Check[], url: string) {
  const mark = level === 'critical' ? '🔴' : level === 'warn' ? '🟠' : '🟢'
  const head = kind === 'recovered'
    ? `${mark} Pons Charity recovered — money is moving again`
    : `${mark} Pons Charity ${level.toUpperCase()}${kind === 'reminder' ? ' (still unresolved)' : ''}`
  const lines = checks
    .filter((c) => c.level === 'warn' || c.level === 'critical' || kind === 'recovered')
    .map((c) => `• ${c.id}: ${c.detail}`)
  const text = [head, ...lines, url].join('\n')
  return { content: text, text }
}
