/**
 * Reconstruct donation attribution the keeper did not record itself.
 *
 * ## What is authoritative here, and what is not
 *
 * Every AMOUNT, CHARITY and TIME comes from the `Paid` event on Base. This script only decides
 * WHICH LAUNCH each donation came from, because that is the one fact no chain holds: the bridge
 * credits the payer itself, so the money arrives having forgotten what earned it.
 *
 * Attribution comes from the keeper's own journal (`<token>  donated <n> USDC to <cfg>…  <payTx>`),
 * and where the journal has nothing — a run that died between paying and printing — from the
 * register, but only where the answer is unambiguous. @see the launch-time rule below.
 *
 * ⛔⛔ MERGES, never overwrites. receipts.json is the one piece of state that cannot be rebuilt from
 * a chain; a backfill that truncated it would destroy the remitted totals the keeper depends on.
 *
 * ⛔ RUN WITH THE TIMER STOPPED. The keeper holds the ledger in memory for a whole pass and writes
 * it back at the end, so an edit under a running pass is silently lost.
 *
 *   systemctl stop charity-keeper.timer charity-keeper.service
 *   node ops/backfill-donations.mjs
 *   systemctl start charity-keeper.timer
 */
import { readFile, writeFile, copyFile } from 'node:fs/promises'
import { execSync } from 'node:child_process'
import { createPublicClient, fallback, http, parseAbiItem } from 'viem'
import { base } from 'viem/chains'

/*
  ⛔⛔ THE SCRIPT OWNS THIS, NOT THE SHELL.

  The keeper holds the ledger in memory for a whole pass and writes it back at the end, so an edit
  made under a running pass is silently discarded. The obvious guard is to chain the stop with
  `&&` — and that is WORSE than nothing: stopping a oneshot mid-pass makes the unit report
  `Failed with result 'signal'`, so `systemctl stop` exits non-zero and the `&&` skips the very
  command it was meant to protect. Three runs did nothing and looked like they had found nothing.

  ➤ So the wait lives here, where it cannot be got wrong by a paste.
*/
function waitForKeeperIdle(seconds = 180) {
  const state = () => {
    try { return execSync('systemctl is-active charity-keeper.service', { encoding: 'utf8' }).trim() }
    catch (e) { return String(e.stdout ?? '').trim() || 'inactive' }
  }
  const started = Date.now()
  let s = state()
  if (s === 'active' || s === 'activating') {
    console.log(`⏳ a keeper pass is running (${s}) — waiting for it to finish before touching the ledger`)
  }
  while ((s === 'active' || s === 'activating') && Date.now() - started < seconds * 1000) {
    execSync('sleep 3')
    s = state()
  }
  if (s === 'active' || s === 'activating') {
    console.error(`⛔ the keeper is still ${s} after ${seconds}s. Refusing to write: the pass would overwrite this.`)
    process.exit(1)
  }
  return s
}

const LEDGER = process.env.RECEIPTS ?? '/root/charity-remit/receipts.json'
/** ⚠ `--dry` does every read and decision and writes NOTHING, so a failure can be reproduced and
 *  read without touching the one file that cannot be rebuilt from a chain. */
const DRY = process.argv.includes('--dry')
const PAYER = '0xb3190e0AeCD4F9F502133A354BBFbA64f2eF79f2'
const LAUNCHPAD = process.env.LAUNCHPAD ?? '0xF1755477b2931E6e8fc2B0f6b7d66B4AA7EeEfE3'
const FIRST_BLOCK = 50_588_537n
const PAID = parseAbiItem('event Paid(bytes32 indexed configId, address indexed token, uint256 amount)')
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'

/*
  ⚠ A fallback with retries. This reads all history in 10,000 block chunks, and an unguarded throw
  anywhere aborts the run BEFORE it writes — so one free-tier "Request timeout" silently costs the
  whole backfill. That happened twice: both runs looked like they had simply found nothing.
*/
const base_ = createPublicClient({
  chain: base,
  transport: fallback(
    ['https://base.drpc.org', 'https://mainnet.base.org', 'https://base.publicnode.com']
      .map((u) => http(u, { retryCount: 5, retryDelay: 900, timeout: 30_000 })),
    { rank: false },
  ),
})

const LP_ABI = [
  { name: 'count', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'page', type: 'function', stateMutability: 'view',
    inputs: [{ type: 'uint256' }, { type: 'uint256' }],
    outputs: [{ type: 'tuple[]', components: [
      { name: 'token', type: 'address' }, { name: 'curve', type: 'address' },
      { name: 'distributor', type: 'address' }, { name: 'charity', type: 'address' },
      { name: 'creator', type: 'address' }, { name: 'pairToken', type: 'address' },
      { name: 'charityBps', type: 'uint16' }, { name: 'launchedAt', type: 'uint64' },
      { name: 'charityId', type: 'bytes32' }] }] },
]
const rhc = createPublicClient({
  transport: http('https://rpc.mainnet.chain.robinhood.com', {
    fetchOptions: { headers: { 'User-Agent': UA } }, retryCount: 5, retryDelay: 900,
  }),
})

/* ── 1. every Paid event, once ─────────────────────────────────────────────────────────────────
   ⭐ Fetched in one sweep and held in a map. The previous version made two RPC calls PER journal
   row to re-verify each donation — 278 calls, any one of which could abort the run. */
const head = await base_.getBlockNumber()
const paid = new Map()
let unreadable = 0
for (let f = FIRST_BLOCK; f <= head; f += 10_000n) {
  const to = f + 9_999n > head ? head : f + 9_999n
  try {
    for (const l of await base_.getLogs({ address: PAYER, event: PAID, fromBlock: f, toBlock: to })) {
      paid.set(l.transactionHash.toLowerCase(), l)
    }
  } catch {
    /* ⛔ Counted, never swallowed. Reporting zero recoveries because a range would not load is a
       different fact from reporting zero because there was nothing to recover. */
    unreadable++
  }
}
console.log(`Paid events on chain: ${paid.size}`)
if (unreadable) console.log(`⚠ ${unreadable} block ranges could not be read — rerun before trusting a zero below`)

/* ── 2. what the journal says each one belonged to ─────────────────────────────────────────── */
const log = execSync(
  'journalctl -u charity-keeper.service --no-pager -o short-iso --since "7 days ago" | grep " donated " || true',
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
)
const RE = /^(\S+)\s.*?(0x[0-9a-fA-F]{40})\s+donated\s+[\d.]+\s+USDC\s+to\s+\S+\s+(0x[0-9a-fA-F]{64})/
const fromJournal = new Map()
for (const line of log.split('\n')) {
  const m = RE.exec(line.trim())
  if (m) fromJournal.set(m[3].toLowerCase(), m[2])
}
console.log(`attributions in the journal: ${fromJournal.size}`)

/* ── 3. the register, for donations the journal never logged ───────────────────────────────── */
const total = await rhc.readContract({ address: LAUNCHPAD, abi: LP_ABI, functionName: 'count' })
const register = []
for (let o = 0n; o < total; o += 50n) {
  register.push(...await rhc.readContract({ address: LAUNCHPAD, abi: LP_ABI, functionName: 'page', args: [o, 50n] }))
}
console.log(`launches in the register: ${register.length}`)

/* ── 4. build the rows ─────────────────────────────────────────────────────────────────────── */
const blockTime = new Map()
const rows = []
let inferred = 0
let skipped = 0
for (const [payTx, l] of paid) {
  let token = fromJournal.get(payTx)
  if (!blockTime.has(l.blockNumber)) {
    blockTime.set(l.blockNumber, Number((await base_.getBlock({ blockNumber: l.blockNumber })).timestamp))
  }
  const at = blockTime.get(l.blockNumber)

  if (!token) {
    /*
      ⛔⛔ ONLY LAUNCHES THAT ALREADY EXISTED CAN BE THE SOURCE.

      Matching on config id alone gets LESS certain over time, because every new launch naming that
      charity adds a candidate retroactively. The first donation here had exactly one candidate when
      checked and five an hour later — four of which launched hours after the money was delivered.

      ➤ Filtering on launch time makes the answer stable: candidates can only be removed by this
      rule, never added, so an attribution that is unambiguous today stays unambiguous.
    */
    const named = register.filter(
      (e) => e.charityId.toLowerCase() === l.args.configId.toLowerCase() && Number(e.launchedAt) <= at,
    )
    if (named.length !== 1) {
      console.log(`  ⚠ ${payTx.slice(0, 12)}… no journal line, ${named.length} launches naming its charity existed by then — left unattributed`)
      skipped++
      continue
    }
    token = named[0].token
    inferred++
    console.log(`  ⭐ recovered ${payTx.slice(0, 12)}… -> ${token}`)
  }

  rows.push({
    token, charityId: l.args.configId, amount: l.args.amount.toString(),
    payTx: l.transactionHash, requestId: '', at: at * 1000,
  })
}
rows.sort((a, b) => a.at - b.at)

/* ── 5. merge ──────────────────────────────────────────────────────────────────────────────── */
/* ⚠ Checked HERE, immediately before the read, not at startup. The scan above takes a while and a
   timer can fire during it, so an all-clear from a minute ago is not an all-clear now. */
if (!DRY) waitForKeeperIdle()

const ledger = JSON.parse(await readFile(LEDGER, 'utf8'))
const existing = new Set((ledger.donations ?? []).map((d) => d.payTx.toLowerCase()))
const added = rows.filter((r) => !existing.has(r.payTx.toLowerCase()))
if (DRY) {
  console.log('\n--dry: nothing written')
} else {
  await copyFile(LEDGER, `${LEDGER}.bak-backfill-${Date.now()}`)
  ledger.donations = [...(ledger.donations ?? []), ...added].sort((a, b) => a.at - b.at)
  await writeFile(LEDGER, JSON.stringify(ledger, null, 1))
}

console.log()
console.log(`from the journal : ${rows.length - inferred}`)
console.log(`inferred         : ${inferred}`)
console.log(`left unattributed: ${skipped}`)
console.log(`already recorded : ${rows.length - added.length}`)
console.log(`ADDED            : ${added.length}`)
console.log(`ledger total     : ${ledger.donations.length}`)
