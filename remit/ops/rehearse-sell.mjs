/**
 * Rehearse the stock-sell path against a fork, and nothing else.
 *
 * ## ⛔⛔ WHY THIS EXISTS RATHER THAN `keeper.ts --send` AGAINST A FORK
 *
 * A full pass with `--send` would also walk the ETH and USDG launches, and their path ends in a
 * **Relay quote and a `payer.pay` on Base** — a real HTTP request and a real mainnet contract, on a
 * chain the fork does not cover. Rehearsing the sell by running the whole keeper therefore reaches
 * out to live systems to exercise a branch that never touches them.
 *
 * ➤ So this drives `sellStock` directly, for the stock-paired launches only. Everything it calls is
 * on Robinhood Chain and therefore inside the fork: sweep, harvest, probe, sell.
 *
 * ## Running it
 *
 *   node scripts/rpc-proxy.mjs &                        # in contracts/, Cloudflare 403s Foundry
 *   anvil --fork-url http://127.0.0.1:8899 --port 8901 --silent &
 *   RHC_RPC=http://127.0.0.1:8901 \
 *   LAUNCHPAD=0x… REMIT_VAULT=0x… CHARITY_PAYER=0x… \
 *   node --experimental-strip-types ops/rehearse-sell.mjs
 *
 * ⛔⛔ REFUSES TO RUN AGAINST THE REAL CHAIN. `RHC_RPC` must be loopback. This signs transactions
 * with a throwaway key and calls permissionless functions that move real fees on the real chain if
 * pointed at it — `sweepCurve`, `harvestToken` and `sellAllForUsdg` are open to anyone by design.
 */
import { createWalletClient, http, formatUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { readLaunches, sellStock, rhcClient } from '../src/keeper.ts'
import { canLeaveRhc } from '../src/decide.ts'

const RHC_RPC = process.env.RHC_RPC ?? ''
if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(RHC_RPC)) {
  console.error('⛔ RHC_RPC must point at a local fork. Refusing to rehearse against a real chain.')
  process.exit(1)
}

/** anvil's first dev account. ⚠ Only ever used against a fork; it is a published key. */
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const account = privateKeyToAccount(KEY)

const chain = {
  id: 4663,
  name: 'Robinhood Chain (fork)',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RHC_RPC] } },
}
const wallet = createWalletClient({ account, chain, transport: http(RHC_RPC) })

const launches = await readLaunches()
const stocks = launches.filter((l) => !canLeaveRhc(l.pairToken))
console.log(`${launches.length} launches, ${stocks.length} stock-paired\n`)

const vaultUsdg = async () =>
  rhcClient.readContract({
    address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
    abi: [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }],
    functionName: 'balanceOf',
    args: [process.env.REMIT_VAULT],
  })

const before = await vaultUsdg()
console.log(`vault USDG before  ${formatUnits(before, 6)}\n`)

for (const l of stocks) {
  const line = await sellStock(l, wallet, account.address).catch((e) => `THREW: ${e.shortMessage ?? e.message}`)
  console.log(`${l.token}  ${line}`)
}

const after = await vaultUsdg()
console.log(`\nvault USDG after   ${formatUnits(after, 6)}`)
console.log(`delivered          ${formatUnits(after - before, 6)} USDG`)
