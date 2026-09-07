/**
 * Restore the attribution for ONE delivery whose ledger write was lost.
 *
 * ⛔⛔ RUN WITH THE TIMER STOPPED. The keeper holds the ledger in memory for a whole pass and
 * writes it back at the end, so editing the file under a running pass loses the edit — that race is
 * how the donations backfill was destroyed twice on 29 Aug 2026.
 *
 *   systemctl stop charity-keeper.timer charity-keeper.service
 *   node ops/recover-lost-attribution.mjs
 *   systemctl start charity-keeper.timer
 *
 * ## Why this is needed at all
 *
 * The keeper was killed mid-pass inside `waitForTransactionReceipt`: the money had left the vault
 * and nothing on disk said whose it was. `RemitVault.Remitted` carries the PAIR ASSET, not the
 * launch, so the chain cannot answer it either. The launch was recovered from the two transactions
 * immediately before the remit — the keeper sweeps and harvests a launch in the same loop iteration
 * that bridges it, so the distributor in those calls is the launch that bridged.
 *
 * ⚠ The keeper now writes this record the instant the remit is submitted, so this cannot recur.
 * This script exists for the one delivery that predates that fix.
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'

const P = process.env.RECEIPTS ?? '/root/charity-remit/receipts.json'

/* Evidence, all of it checkable:
   - remitNative      0x0d82012ba791fbd910aece72693d094f43a403d5f0d171ffa12480df51b59a95  14:43:55
   - sweep + harvest  -> distributor 0x7066491CD4E53c39d0EF1E72c39f4b83F8760cB7  14:43:47 / 14:43:51
   - that distributor belongs to launch 0x36BF54D2A70d77dbF54F81F72045141e11EBcD2C
   - 38.128556 USDC arrived at the payer from Relay at 14:44:01, and is still there */
const TOKEN = '0x36BF54D2A70d77dbF54F81F72045141e11EBcD2C'
const CHARITY_ID = '0xb02173170bada3eb8162396b27744f9c5ac99bed3a632b1c4d2bc9b1b366b0e8'
const REQUEST_ID = '0xc75684f90846733f4a895b9a8e9efd5ac49443f04cf7bb5c8f93d87ecc9037f6'
const AMOUNT = 15671511627058675n
const BRIDGED_AT_MS = 1788014635000

const d = JSON.parse(readFileSync(P, 'utf8'))
const key = TOKEN.toLowerCase()

/* ⛔ Never overwrite a live delivery. If something else is in flight, this script is not the fix. */
if (d.pending) {
  console.error('⛔ a pending record already exists — refusing to overwrite:')
  console.error(JSON.stringify(d.pending, null, 1))
  process.exit(1)
}

const before = BigInt(d.remitted[key] ?? '0')
copyFileSync(P, `${P}.bak-recover-${Date.now()}`)

d.pending = {
  token: TOKEN, charityId: CHARITY_ID, amount: AMOUNT.toString(),
  requestId: REQUEST_ID, bridgedAtMs: BRIDGED_AT_MS,
}
/* ⛔⛔ The remitted total MUST go up too. The bridge happened and was never recorded, so without
   this the keeper still thinks the money is owed and bridges it a SECOND time. */
d.remitted[key] = (before + AMOUNT).toString()

writeFileSync(P, JSON.stringify(d, null, 1))

console.log('restored')
console.log('  pending.token     ', TOKEN)
console.log('  pending.charityId ', CHARITY_ID)
console.log('  pending.amount    ', AMOUNT.toString(), '(0.015671511627058675 ETH -> 38.128556 USDC)')
console.log('  remitted           ', before.toString(), '->', d.remitted[key], '(so it is never bridged twice)')
console.log('  donations kept    ', (d.donations ?? []).length)
