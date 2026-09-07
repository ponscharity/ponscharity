/**
 * Sample the system and write a status file. Read-only.
 *
 * ⛔⛔ THIS MUST NEVER BE ABLE TO HURT THE KEEPER. It signs nothing, holds no key, writes only
 * `status.json`, and never touches `receipts.json`, which it opens read-only. It runs as its own
 * systemd unit so that if it crashes, hangs or is rate limited, the keeper does not notice.
 *
 * ⚠ It also never stops or starts anything. A watchdog that restarts the keeper mid-pass would
 * destroy a delivery's attribution — that is exactly how $38.13 got stranded on 29 Aug.
 */
import { readFile, writeFile, rename } from 'node:fs/promises'
import { execSync } from 'node:child_process'
import { createPublicClient, fallback, http, parseAbi } from 'viem'
import { base } from 'viem/chains'
import { report, nextStuckSince, decideNotify, alertBody } from '../src/health.ts'

const LEDGER = process.env.RECEIPTS ?? '/root/charity-remit/receipts.json'
const STATUS = process.env.STATUS ?? '/root/charity-remit/status.json'
const PAYER = '0xb3190e0AeCD4F9F502133A354BBFbA64f2eF79f2'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const KEEPER = '0xF57c2f22464fAf38C15dcAE9ac5d685fB4450edE'
/* The buy-back leg. @see ../src/health.ts checkBurn — both of these fail silently. */
const BURN_WALLET = '0xB97F2573E06886C0210676a536fe11b0BAB9291f'
const DISTRIBUTOR = '0xB4308041D846761F7cdB6579522C8B5A1dEd133a'
const BURN_STATE = process.env.BURN_STATE ?? '/var/lib/charity/burn-state.json'
const TOTAL_TO_OPS = [{
  type: 'function', name: 'totalToOps', stateMutability: 'view',
  inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }],
}]

/**
 * How much fee income has reached ops but not yet been taxed for the burn.
 *
 * ⛔ `null` on ANY doubt — an unreadable mark or an unreadable chain is `unknown`, not zero. A zero
 * here would read as "nothing outstanding" and is the one answer that must never be guessed.
 * ⚠ The mark is a high-water counter the cranker owns; this only reads it.
 */
async function burnBacklogWei() {
  try {
    const mark = BigInt(JSON.parse(await readFile(BURN_STATE, 'utf8')).lastTotalToOps)
    const total = await rhc.readContract({
      address: DISTRIBUTOR, abi: TOTAL_TO_OPS, functionName: 'totalToOps',
      args: ['0x0000000000000000000000000000000000000000'],
    })
    /* ⚠ Clamped at zero. The counter only rises, so a negative means the state file belongs to a
       different deployment — report nothing outstanding rather than a nonsense negative. */
    return total > mark ? total - mark : 0n
  } catch {
    return null
  }
}
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)'])

const baseClient = createPublicClient({
  chain: base,
  transport: fallback(
    ['https://base.drpc.org', 'https://mainnet.base.org', 'https://base.publicnode.com']
      .map((u) => http(u, { retryCount: 3, retryDelay: 700, timeout: 15_000 })),
    { rank: false },
  ),
})
const rhc = createPublicClient({
  transport: http('https://rpc.mainnet.chain.robinhood.com', {
    fetchOptions: { headers: { 'User-Agent': UA } }, retryCount: 3, retryDelay: 700, timeout: 15_000,
  }),
})

/**
 * ⚠ Read TWICE on a parse failure. The keeper rewrites this file without an atomic rename, so a read
 * can land mid-write. One bad read is a bad read; two in a row is worth reporting as unknown.
 */
async function readLedger() {
  for (let i = 0; i < 2; i++) {
    try {
      return JSON.parse(await readFile(LEDGER, 'utf8'))
    } catch {
      if (i === 0) await new Promise((r) => setTimeout(r, 600))
    }
  }
  return null
}

/** ms since the keeper last FINISHED successfully. `ExecMainExitTimestamp` is when the pass ended. */
function sinceLastRunMs() {
  try {
    /* ⛔ The NAMED form, not `--value`. `--value` prints the properties in ALPHABETICAL order rather
       than the order asked for, so `-p ExecMainExitTimestamp -p Result --value` yields the result
       first and the timestamp second. Reading them positionally parsed "success" as a date and made
       every check report `unknown`. Parsing `KEY=value` cannot be got wrong by reordering. */
    const out = execSync(
      'systemctl show charity-keeper.service -p ExecMainExitTimestamp -p Result -p ActiveState -p InactiveEnterTimestamp',
      { encoding: 'utf8' },
    )
    const field = (k) => (out.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1] ?? '').trim()
    const result = field('Result')

    /* ⛔⛔ A RUNNING PASS IS THE FRESHEST STATE THERE IS, AND IT USED TO READ AS `unknown`.
       systemd BLANKS `ExecMainExitTimestamp` while a unit is activating. That was survivable when a
       pass took five minutes every fifteen; since the keeper began waiting for Relay's direct-route
       window and `charity-window.timer` began starting it on demand, it is activating much of the
       time — so the staleness alarm answered `unknown` almost always, and `unknown` answers 200 on
       purpose. The check that exists to notice a stopped keeper had quietly stopped noticing. */
    if (field('ActiveState') === 'activating') return 0

    /* ⚠ Falls back to when the unit last went inactive: after `systemctl reset-failed`, and on a
       unit that was killed rather than exiting, `ExecMainExitTimestamp` can be empty while the
       service is perfectly healthy. */
    const raw = field('ExecMainExitTimestamp') || field('InactiveEnterTimestamp')
    /* systemd prints e.g. `Sat 2026-08-29 19:10:37 UTC`. */
    const when = Date.parse(raw)
    if (!raw || !Number.isFinite(when)) return null
    /* ⚠ Only a SUCCESSFUL pass counts as fresh. A unit that keeps failing fast would otherwise look
       healthier than one that is merely slow. */
    if (result && result !== 'success') return Date.now() - when + 1
    return Date.now() - when
  } catch {
    return null
  }
}

const ledger = await readLedger()
const previous = await readFile(STATUS, 'utf8').then((t) => JSON.parse(t)).catch(() => null)

const [payerUsdc, keeperGasWei, burnWalletGasWei, backlog] = await Promise.all([
  baseClient.readContract({ address: USDC, abi: ERC20, functionName: 'balanceOf', args: [PAYER] }).catch(() => null),
  rhc.getBalance({ address: KEEPER }).catch(() => null),
  rhc.getBalance({ address: BURN_WALLET }).catch(() => null),
  burnBacklogWei(),
])

const sample = {
  payerUsdc,
  hasPending: !!ledger?.pending,
  ledgerReadable: ledger !== null,
  sinceLastRunMs: sinceLastRunMs(),
  keeperGasWei,
  burnWalletGasWei,
  burnBacklogWei: backlog,
  stuckSinceMs: previous?.stuckSinceMs ?? null,
}
sample.stuckSinceMs = nextStuckSince(sample, previous?.stuckSinceMs ?? null)

const r = report(sample)
const out = {
  level: r.level,
  code: r.code,
  at: new Date(r.at).toISOString(),
  checks: r.checks,
  stuckSinceMs: sample.stuckSinceMs,
  /* ⚠ Handy context, deliberately NOT alerted on: donations lag by design and a count that drifts
     for a few minutes is normal. */
  donations: Array.isArray(ledger?.donations) ? ledger.donations.length : null,
}

/* ⭐ Written via a temp file and renamed, so the API can never serve a half-written status — the
   exact hazard this script has to tolerate when reading the keeper's own ledger.
   ⚠ Written AFTER the notify decision so `notified` is persisted in the same file. */

/* ── tell a human ──────────────────────────────────────────────────────────────────────────────
   ⚠ Entirely optional and entirely non-fatal. With no webhook configured this is a no-op and the
   status file is still written, so `/api/status` keeps working for an external uptime monitor.
   A webhook that fails must never turn a health check into a failing unit. */
const previousNotify = previous?.notified ?? null
const decision = decideNotify(r.level, previousNotify)
out.notified = previousNotify

if (decision.send) {
  const hook = (process.env.ALERT_WEBHOOK ?? '').trim()
  if (hook) {
    try {
      const body = alertBody(r.level, decision.kind, out.checks, 'https://ponscharity.family/api/status')
      const res = await fetch(hook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      })
      /* ⛔ Only recorded as notified if it actually went out. Recording it regardless would mean one
         failed POST silently swallows the alert for a whole hour. */
      if (res.ok) out.notified = { level: r.level, atMs: Date.now() }
      console.log(`alert ${decision.kind}: ${res.ok ? 'sent' : 'webhook returned ' + res.status}`)
    } catch (e) {
      console.log(`alert ${decision.kind}: webhook failed (${String(e).slice(0, 60)}) — status file still written`)
    }
  } else {
    console.log(`alert ${decision.kind} (${decision.reason}) — no ALERT_WEBHOOK set, nothing sent`)
  }
}

await writeFile(`${STATUS}.tmp`, JSON.stringify(out, null, 1))
await rename(`${STATUS}.tmp`, STATUS)

console.log(`${out.level.toUpperCase()} (${out.code})`)
for (const c of out.checks) console.log(`  ${c.level.padEnd(8)} ${c.id.padEnd(7)} ${c.detail}`)
