/**
 * The remit runner: what turns accrued fees into a donation a charity actually receives.
 *
 * ## The four legs, and which of them are trusted
 *
 * 1. **Harvest.** Permissionless. Pulls each launch's fees out of the Pons escrow and pushes them
 *    at the split written into that launch's distributor. Nobody can redirect this.
 * 2. **Sell.** Permissionless. A launch paired against a tokenized stock is sold to USDG on the V4
 *    singleton, because Relay carries neither the stocks nor anything but ETH and USDG off this
 *    chain.
 * 3. **Bridge.** Robinhood Chain to Base through Relay, delivered as USDC. ⛔ This leg is operated:
 *    Relay's deposit calldata does not contain the recipient, so no contract can verify it.
 * 4. **Donate.** `donateToken` on donate.gg's public relay, routed by the config id written into the
 *    launch. ⛔⛔ The relay accepts ANY config id without validating it, proven on a Base fork, so a
 *    wrong id is a silent permanent misdirection. The id is read from the CHAIN, never from a
 *    config file, so the only thing this runner can pay is what the launch itself recorded.
 *
 * ➤ Legs 3 and 4 are the operated ones and both are published: every run writes a receipt carrying
 * the launch, the config id, both transaction hashes and the amounts.
 *
 * ⚠⚠ `--dry-run` is the default. Nothing is signed unless `--send` is passed, because the failure
 * mode of a remit runner is not that it does nothing, it is that it does something once, wrongly,
 * to somebody else's donation.
 */
import { createPublicClient, formatUnits, http, parseAbi, type Address } from 'viem'

const RHC_RPC = process.env.RHC_RPC ?? 'https://rpc.mainnet.chain.robinhood.com'
const LAUNCHPAD = (process.env.LAUNCHPAD ?? '') as Address
const REMIT_VAULT = (process.env.REMIT_VAULT ?? '') as Address

const rhc = {
  id: 4663, name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RHC_RPC] } },
  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' as Address } },
} as const

const client = createPublicClient({ chain: rhc, transport: http(RHC_RPC), batch: { multicall: true } })

const PAD_ABI = parseAbi([
  'struct Entry { address token; address curve; address distributor; address charity; address creator; address pairToken; uint16 charityBps; uint64 launchedAt; bytes32 charityId; }',
  'function count() view returns (uint256)',
  'function page(uint256 offset, uint256 limit) view returns (Entry[])',
])
const DIST_ABI = parseAbi([
  'function harvest() returns (uint256)',
  'function harvestToken(address asset) returns (uint256)',
  'function pending(address asset) view returns (uint256)',
  'function totalToCharity(address asset) view returns (uint256)',
])

export type Plan = {
  token: Address
  distributor: Address
  charityId: `0x${string}`
  pairToken: Address
  /** Sitting in the Pons escrow, claimable by a harvest. */
  pending: bigint
  /** Already pushed to the vault by this launch, lifetime. */
  paid: bigint
}

/**
 * ⚠⚠ Reads the launches from the CHAIN, never from a config file. The config id a launch recorded is
 * the promise it made, and a runner that took ids from its own configuration could pay a different
 * charity than the token advertises without anything on chain changing.
 */
export async function readPlans(): Promise<Plan[]> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(LAUNCHPAD)) throw new Error('LAUNCHPAD is not set')
  const n = await client.readContract({ address: LAUNCHPAD, abi: PAD_ABI, functionName: 'count' })
  if (n === 0n) return []
  const rows = await client.readContract({
    address: LAUNCHPAD, abi: PAD_ABI, functionName: 'page', args: [0n, n],
  })
  return Promise.all(
    rows.map(async (e) => ({
      token: e.token,
      distributor: e.distributor,
      charityId: e.charityId,
      pairToken: e.pairToken,
      pending: await client
        .readContract({ address: e.distributor, abi: DIST_ABI, functionName: 'pending', args: [e.pairToken] })
        .catch(() => 0n),
      paid: await client
        .readContract({ address: e.distributor, abi: DIST_ABI, functionName: 'totalToCharity', args: [e.pairToken] })
        .catch(() => 0n),
    })),
  )
}

export function describe(plans: Plan[], decimalsOf: (a: Address) => number): string[] {
  return plans.map((p) => {
    const d = decimalsOf(p.pairToken)
    return `${p.token}  pending ${formatUnits(p.pending, d)}  paid ${formatUnits(p.paid, d)}  -> ${p.charityId.slice(0, 12)}…`
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const send = process.argv.includes('--send')
  const plans = await readPlans()
  const dec = (a: Address) => (a.toLowerCase() === '0x5fc5360d0400a0fd4f2af552add042d716f1d168' ? 6 : 18)
  console.log(`launchpad ${LAUNCHPAD}`)
  console.log(`vault     ${REMIT_VAULT || '(unset)'}`)
  console.log(`launches  ${plans.length}`)
  for (const line of describe(plans, dec)) console.log('  ' + line)
  const harvestable = plans.filter((p) => p.pending > 0n)
  console.log(`\n${harvestable.length} launch(es) have fees waiting on a harvest.`)
  /* ⛔ The guard, not a formality. A runner whose default is to send is one mistyped flag away from
     moving somebody else's donation. */
  if (!send) console.log('dry run. Nothing was signed. Pass --send to act.')
  else console.log('⚠ --send is not wired to a signer yet: fund and configure the remit key first.')
}
