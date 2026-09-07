import type { Address } from 'viem'
import { parseAbi } from 'viem'
import { publicClient, EXPLORER } from './chain.ts'

/**
 * The assets a Pons V2 launch can be priced in, and — for this launchpad — whether the fees earned
 * in one can actually reach a charity.
 *
 * ## ⛔⛔ THE COLUMN THAT MATTERS IS `remit`, NOT `approved`
 *
 * Creator fees are denominated in whichever asset a launch picks, and the pair asset is **fixed at
 * launch for ever**. Relay — the bridge that moves value off Robinhood Chain — carries native ETH
 * and USDG and refuses every one of the tokenized equities, commodities and ETFs with "Unsupported
 * currency". Re-confirmed 6 Sep 2026 at `api.relay.link/chains`: chain 4663 lists exactly ONE
 * `erc20Currencies` entry.
 *
 * ➤ So everything else is **sold to USDG on the Uniswap V4 singleton first**, then bridged. The
 * keeper does that itself as of 6 Sep 2026 — `sellStock` in `remit/src/keeper.ts`, rehearsed
 * against the live deployed distributors in `contracts/test/StrandedFork.t.sol`. Until then this
 * file said `sell-first` and nothing sold, which made it a promise rather than a description.
 *
 * ## ⛔⛔ THE LIST IS READ FROM THE CHAIN, BECAUSE IT MOVES FASTER THAN THIS FILE
 *
 * Pons approved **32 new pair assets between 28 Aug and 4 Sep 2026** — going from 23 to 55 — and
 * this file knew about none of them. A creator on the launch form was offered 25 of 55 while the
 * launchpad contract itself gates on `factory.approvedPairTokens` and would have accepted any of
 * them. A hardcoded catalogue of somebody else's contract is a catalogue that is wrong by default.
 *
 * ➤ {@link loadPairAssets} replays the factory's approval log and verifies every survivor against
 * the live mapping. {@link PAIR_ASSETS} below is the SEED and the FALLBACK — what the form shows
 * before the chain answers, and what it keeps showing if the explorer is unreachable. A stale seed
 * costs the newest listings; it never costs the feature.
 */

export type RemitRoute = 'direct' | 'sell-first'

export type PairAsset = {
  address: Address
  symbol: string
  decimals: number
  /** How the charity's share gets off this chain. */
  remit: RemitRoute
  note?: string
}

export const NATIVE = '0x0000000000000000000000000000000000000000' as Address
export const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address

/**
 * ⭐ A pure function of the asset, and the SAME rule the keeper applies in `remitAssetFor`. If these
 * two ever disagree, the form promises a route the keeper does not take.
 */
/**
 * What a launch's charity share is finally PAID OUT as, which is not always what it earned in.
 *
 * ⛔⛔ THE DISTRIBUTOR CREDITS `totalToCharity` UNDER THE ASSET IT RELEASED, NOT THE PAIR ASSET.
 * A stock-paired launch is sold to USDG before a penny can reach a charity, so its ledger entry
 * lands under USDG and `totalToCharity(AAPL)` stays at zero for ever. Reading the pair asset
 * therefore reports a launch that has raised real money as having raised nothing — silently, with
 * a confident zero on the page whose entire job is showing that money reached a charity.
 *
 * ⚠ True of BOTH launchpad versions: V1 sells then releases, V2 reserves then sells. Same key.
 * ⭐ The same rule the keeper applies in `remitAssetFor`; the two must not drift.
 */
export const remitAssetFor = (pairToken: Address): Address =>
  remitRouteFor(pairToken) === 'direct' ? pairToken : USDG

export const remitRouteFor = (address: Address): RemitRoute =>
  address.toLowerCase() === NATIVE.toLowerCase() || address.toLowerCase() === USDG.toLowerCase()
    ? 'direct'
    : 'sell-first'

/**
 * Every asset approved as of 6 Sep 2026, each read off the chain rather than off a document.
 *
 * ⚠ A SEED AND A FALLBACK, NOT THE SOURCE OF TRUTH. {@link loadPairAssets} verifies each of these
 * against `approvedPairTokens` before offering it, so a revoked listing disappears from the form on
 * the next load without this file being touched.
 *
 * ⛔ `decimals` is not decoration and is not all 18: USDG is 6 and **cbBTC is 8**. It sizes the
 * developer buy, so a wrong value here is a launch that reverts or one that spends a million times
 * what the creator typed.
 */
const STOCKS: readonly { address: string; symbol: string; decimals: number }[] = [
  { address: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9', symbol: 'AAPL', decimals: 18 },
  { address: '0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B', symbol: 'AMC', decimals: 18 },
  { address: '0x86923f96303D656E4aa86D9d42D1e57ad2023fdC', symbol: 'AMD', decimals: 18 },
  { address: '0x12f190a9F9d7D37a250758b26824B97CE941bF54', symbol: 'AMZN', decimals: 18 },
  { address: '0xad25Ac6C84D497db898fa1E8387bf6Af3532a1c4', symbol: 'BABA', decimals: 18 },
  { address: '0x48E39E56aCdbA37b09020C0b734A613C9a2f100A', symbol: 'BB', decimals: 18 },
  { address: '0x822CC93fFD030293E9842c30BBD678F530701867', symbol: 'BE', decimals: 18 },
  { address: '0xceF9027c7d6985b85f0BA431125073529A947A68', symbol: 'BULL', decimals: 18 },
  { address: '0xCEC185eB182c47d1bA1EFc84e6959e18cd620Be4', symbol: 'cbBTC', decimals: 8 },
  { address: '0x6330D8C3178a418788dF01a47479c0ce7CCF450b', symbol: 'COIN', decimals: 18 },
  { address: '0x4EA005168D7F09a7A0Ba9D1DEf21a479950E44C2', symbol: 'COST', decimals: 18 },
  { address: '0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5', symbol: 'CRCL', decimals: 18 },
  { address: '0x941AE714EC6D8130c7B75d67160Ca08f1e7d11Dd', symbol: 'DELL', decimals: 18 },
  { address: '0x1D11f0496982706C5e14A514D4E79F2e6BdE4516', symbol: 'DJT', decimals: 18 },
  { address: '0x25C288E6D899b9BC30160965aD9644c67e73bE0C', symbol: 'F', decimals: 18 },
  { address: '0x41F4267525a8AFf329540eF24fD83d9044758B33', symbol: 'FIG', decimals: 18 },
  { address: '0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e', symbol: 'GLD', decimals: 18 },
  { address: '0x1b0E319c6A659F002271B69dB8A7df2F911c153E', symbol: 'GME', decimals: 18 },
  { address: '0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3', symbol: 'GOOGL', decimals: 18 },
  { address: '0xCceE82fE024c36fA15E1005edE3E9e4787e23D09', symbol: 'HIMS', decimals: 18 },
  { address: '0x980dcf6766FA79f5Cf0c4AAdb3ab477ff15a9619', symbol: 'IBM', decimals: 18 },
  { address: '0xACEF2e09adb47aD6aBeBAD9fF06689E60615C2B6', symbol: 'INDA', decimals: 18 },
  { address: '0x03DfbBE0AC4E7bCDaFd08eD41A400326B77D8c80', symbol: 'JNJ', decimals: 18 },
  { address: '0x8005d266423c7ea827372c9c864491e5786600ea', symbol: 'LLY', decimals: 18 },
  { address: '0x4e62068525Ab11FE768e29dfD00ef909B9803016', symbol: 'LULU', decimals: 18 },
  { address: '0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35', symbol: 'META', decimals: 18 },
  { address: '0x43B07D15cE533bEc5476d70C22a78a1B2B662155', symbol: 'MRNA', decimals: 18 },
  { address: '0x62fd0668e10D8B72339BE2DCF7643001688ff13B', symbol: 'MRVL', decimals: 18 },
  { address: '0xe93237C50D904957Cf27E7B1133b510C669c2e74', symbol: 'MSFT', decimals: 18 },
  { address: '0xec262a75e413fAfD0dF80480274532C79D42da09', symbol: 'MSTR', decimals: 18 },
  { address: '0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD', symbol: 'MU', decimals: 18 },
  { address: '0xE0444EF8BF4eD74f74FD73686e2ddF4C1c5591E8', symbol: 'NFLX', decimals: 18 },
  { address: '0x408c14038a04f7bD235329E26d2bf569ee20e250', symbol: 'NU', decimals: 18 },
  { address: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC', symbol: 'NVDA', decimals: 18 },
  { address: '0x7066A64c24e4206CD62E83bf198c1E7EB361F51e', symbol: 'PFE', decimals: 18 },
  { address: '0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A', symbol: 'PLTR', decimals: 18 },
  { address: '0xD5f3879160bc7c32ebb4dC785F8a4F505888de68', symbol: 'QQQ', decimals: 18 },
  { address: '0xF0C4BF4C582cb3836e98394b1d4e7B7281101bE8', symbol: 'RBLX', decimals: 18 },
  { address: '0x05b37Fb53A299a1b874A619e1c4C404D52C36F4C', symbol: 'RDDT', decimals: 18 },
  { address: '0xB1BF26c1D20ff267A4f93550d1E0d06ac40a114B', symbol: 'RIVN', decimals: 18 },
  { address: '0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5', symbol: 'SGOV', decimals: 18 },
  { address: '0xF53F66751B1Eff985311b693531E3290F600c410', symbol: 'SHOP', decimals: 18 },
  { address: '0x84CAb63bc87912E71ad199ff14A0bA45de68FeF8', symbol: 'SKHY', decimals: 18 },
  { address: '0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f', symbol: 'SLV', decimals: 18 },
  { address: '0xF6589F11Bc40b669e584073F428B05562F568733', symbol: 'SNAP', decimals: 18 },
  { address: '0xB90A19fF0Af67f7779afF50A882A9CfF42446400', symbol: 'SNDK', decimals: 18 },
  { address: '0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa', symbol: 'SPCX', decimals: 18 },
  { address: '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C', symbol: 'SPY', decimals: 18 },
  { address: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d', symbol: 'TSLA', decimals: 18 },
  { address: '0x58FfE4a942d3885bAa22D7520691F611EF09e7AA', symbol: 'TSM', decimals: 18 },
  { address: '0x5e81213613b6B86EaB4c6c50d718d34359459786', symbol: 'TTWO', decimals: 18 },
  { address: '0xf23250dac154D05Bb671CB0d0eBEf3c635c79CE2', symbol: 'UPS', decimals: 18 },
  { address: '0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344', symbol: 'USO', decimals: 18 },
  { address: '0x9e7ABD3C9139D14E4c86DcE0e455AAB7A0C2FB3E', symbol: 'WYFI', decimals: 18 },
]

export const PAIR_ASSETS: PairAsset[] = [
  { address: NATIVE, symbol: 'ETH', decimals: 18, remit: 'direct' },
  { address: USDG, symbol: 'USDG', decimals: 6, remit: 'direct', note: 'The cheapest to remit. About 0.08% of the fee is lost reaching the charity.' },
  ...STOCKS.map((s) => ({
    address: s.address as Address,
    symbol: s.symbol,
    decimals: s.decimals,
    remit: remitRouteFor(s.address as Address),
  })),
]

export const pairBy = (a: string) =>
  PAIR_ASSETS.find((p) => p.address.toLowerCase() === a.toLowerCase())

/* ------------------------------------------------------------------ discovery -- */

/**
 * ⛔⛔ THERE IS NO WAY TO ENUMERATE THE APPROVED SET ON CHAIN. The factory exposes
 * `approvedPairTokens(address)` — a mapping getter, one address at a time — and
 * `setPairTokenApproved`. No list, no count, no iterator. So the set is recovered from
 * `PairTokenApprovalUpdated` logs, replayed in order so a later revocation beats an earlier
 * approval, and then **every survivor is verified against the live mapping anyway**. The log scan
 * decides who to ask about; the chain decides the answer.
 *
 * ⚠⚠ The scan runs against Blockscout rather than `eth_getLogs`, because Robinhood Chain's public
 * RPC caps a log query at 2,000 blocks — a few minutes of history on a chain that makes a block
 * every 100ms, against approvals that are months old.
 */
const PONS_FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e' as Address

/** `keccak256("PairTokenApprovalUpdated(address,bool)")`. */
const APPROVAL_TOPIC = '0x060d1992d069dc524985f328329aae36102a017c59733c5c91fc0691ee0703b6'

const FACTORY_PAIR_ABI = parseAbi([
  'function approvedPairTokens(address pairToken) view returns (bool)',
  'function pairTokenEconomics(address pairToken) view returns (uint256 phantomQuote, uint256 graduationThreshold, uint8 decimals)',
])

const ERC20_META_ABI = parseAbi(['function symbol() view returns (string)'])

/**
 * Every address the factory has ever been told about, newest verdict winning.
 *
 * ⚠ Returns an empty array rather than throwing. A discovery failure must degrade to the seed, not
 * to a launch form with no assets in it.
 */
async function discoverPairTokens(): Promise<Address[]> {
  try {
    const url = `${EXPLORER}/api?module=logs&action=getLogs&fromBlock=0&toBlock=latest`
      + `&address=${PONS_FACTORY}&topic0=${APPROVAL_TOPIC}`
    const res = await fetch(url)
    if (!res.ok) return []
    const body = (await res.json()) as { result?: { topics: string[]; data: string }[] }
    if (!Array.isArray(body.result)) return []

    /* ⚠ Replayed IN ORDER: the same asset can be approved, revoked and approved again, and only the
       last word counts. A Set of every address ever seen would offer revoked assets for ever. */
    const latest = new Map<string, boolean>()
    for (const log of body.result) {
      const topic = log.topics?.[1]
      if (!topic) continue
      latest.set(`0x${topic.slice(26)}`.toLowerCase(), BigInt(log.data) === 1n)
    }
    return [...latest].filter(([, on]) => on).map(([a]) => a as Address)
  } catch {
    return []
  }
}

/**
 * The list the launch form offers: the seed and the chain, merged, with everything confirmed
 * against the live mapping.
 *
 * ⭐ Merged rather than chosen between. Discovery finds assets listed after this file was written;
 * the seed survives the explorer being down. Either alone is a single point of failure for the one
 * field on this form that can never be changed after a launch.
 *
 * ⚠⚠ `decimals` comes from `pairTokenEconomics`, not from the token's own `decimals()`. The factory
 * validates the two agree at approval time, and the economics figure is the one every amount on the
 * launch path is denominated in — so if they ever diverged, the factory's number is the one
 * consistent with the contract that enforces it.
 */
export async function loadPairAssets(): Promise<PairAsset[]> {
  const discovered = await discoverPairTokens()

  const seen = new Set<string>()
  const candidates: Address[] = []
  for (const a of [...discovered, ...STOCKS.map((s) => s.address as Address)]) {
    const k = a.toLowerCase()
    if (k === NATIVE.toLowerCase() || k === USDG.toLowerCase() || seen.has(k)) continue
    seen.add(k)
    candidates.push(a)
  }

  const seedSymbols = new Map(STOCKS.map((s) => [s.address.toLowerCase(), s.symbol]))

  const checked = await Promise.all(candidates.map(async (address): Promise<PairAsset | null> => {
    try {
      const [approved, economics] = await Promise.all([
        publicClient.readContract({ address: PONS_FACTORY, abi: FACTORY_PAIR_ABI, functionName: 'approvedPairTokens', args: [address] }),
        publicClient.readContract({ address: PONS_FACTORY, abi: FACTORY_PAIR_ABI, functionName: 'pairTokenEconomics', args: [address] }),
      ])
      if (!approved) return null

      const [phantomQuote, graduationThreshold, decimals] = economics as readonly [bigint, bigint, number]
      /* ⚠ The factory refuses to approve an asset with zero economics, so a zero here means the read
         is not describing what it looks like it describes. Dropped rather than shown. */
      if (phantomQuote === 0n || graduationThreshold === 0n) return null

      const symbol = await publicClient
        .readContract({ address, abi: ERC20_META_ABI, functionName: 'symbol' })
        .catch(() => seedSymbols.get(address.toLowerCase()) ?? null)
      if (!symbol) return null

      return { address, symbol: symbol as string, decimals: Number(decimals), remit: remitRouteFor(address) }
    } catch {
      return null
    }
  }))

  const verified = checked.filter((a): a is PairAsset => a !== null)
  /* ⚠ A total verification failure degrades to the seed rather than to an empty picker. */
  if (verified.length === 0) return PAIR_ASSETS

  // Stablecoin first, then alphabetically: USDG is the one asset here whose price a creator can
  // reason about without checking a ticker.
  verified.sort((a, b) => a.symbol.localeCompare(b.symbol))

  return [PAIR_ASSETS[0]!, PAIR_ASSETS[1]!, ...verified]
}
