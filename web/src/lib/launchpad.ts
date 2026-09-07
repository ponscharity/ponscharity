import { parseAbi, formatUnits, type Address } from 'viem'
import { ENV, publicClient } from './chain.ts'
import { NATIVE, pairBy, remitAssetFor } from './pairs.ts'
import { marketCapInPair, capUsdScaled } from './marketCap.ts'
import { poolPrice } from './token.ts'
import { usdPerAsset } from './usdPrice.ts'
import type { StatRow } from './charityStats.ts'

/**
 * `CharityLaunchpad`, and everything the site reads off it.
 *
 * ⛔⛔ NOT DEPLOYED UNTIL THIS IS SET. Left unset the site renders honestly — the launch form says
 * so and the feed says so — rather than showing a zero that looks like "nobody has launched yet".
 * A launchpad that reports an empty registry when it is really pointing at nothing is the same
 * class of lie as reading one fee ledger and reporting zero.
 */
export const LAUNCHPAD = (ENV?.VITE_LAUNCHPAD || '') as Address | ''
export const PONS_FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e' as Address

/**
 * `CharityPayer`, the far side of the bridge. ⛔ On BASE, not Robinhood Chain, so it is a constant
 * rather than an env var: nothing on this site reads it, and its explorer is a different one.
 *
 * ⛔⛔ The same address on Robinhood Chain means something else entirely. `0xBc259FA0…4BaA` is an
 * orphaned duplicate payer on Base AND the superseded launchpad on RHC, same deployer and nonce on
 * two chains. The one in use is deliberately the second deploy for exactly that reason.
 */
export const CHARITY_PAYER_BASE = '0xb3190e0AeCD4F9F502133A354BBFbA64f2eF79f2' as Address
export const BASE_EXPLORER = 'https://basescan.org'
export const LAUNCH_CONFIG_ID = 0n

export const isLive = () => /^0x[0-9a-fA-F]{40}$/.test(LAUNCHPAD)

/**
 * Where a listed charity's share lands on Robinhood Chain before it is bridged and donated.
 *
 * ⛔⛔ THIS IS THE OPERATED STEP, AND IT IS THE ONLY ONE. A charity chosen from the list is paid
 * through donate.gg's relay on Base, which cannot be called from this chain, so the share pools here
 * first. What is NOT operated is who it is for: the config id is written into the launch and no key
 * can change it. A charity that publishes its own wallet skips this entirely.
 */
export const REMIT_VAULT = (ENV?.VITE_REMIT_VAULT || '0x0000000000000000000000000000000000000000') as Address

/** ⚠ A launch that names an address directly carries no config id. */
export const ZERO_ID = '0x0000000000000000000000000000000000000000000000000000000000000000'

/**
 * ⛔ Whether a listed charity can be paid at all.
 *
 * With no vault configured, choosing a charity would build a launch whose `charity` is the zero
 * address, the contract would revert `ZeroAddress`, and the interface would report a generic
 * failure for something that is a deployment setting rather than anything the launcher did.
 */
export const vaultConfigured = () =>
  /^0x[0-9a-fA-F]{40}$/.test(REMIT_VAULT) && !/^0x0+$/.test(REMIT_VAULT)

/**
 * ⛔⛔ THE V2 LAUNCHPAD IS A SEPARATE ADDRESS AND A SEPARATE ABI, AND MIXING THEM BREAKS LAUNCHING.
 *
 * V2's `CharityTerms` carries a `splits` array and V1's does not. One shared ABI declaring the V2
 * shape, sent to the V1 address, encodes a struct the live contract cannot decode — so every launch
 * with a developer buy or a snipe exemption (the `launchWithBuy` path) fails, for everybody,
 * including people who wanted none of the new options.
 *
 * ⚠ Blank until V2 is deployed, and that is a supported state: {usingV2} is false, the launch form
 * offers only what V1 can honour, and the site keeps working exactly as it does today. Nothing here
 * may assume V2 exists.
 */
export const LAUNCHPAD_V2 = (ENV?.VITE_LAUNCHPAD_V2 || '') as Address | ''
export const usingV2 = () => /^0x[0-9a-fA-F]{40}$/.test(LAUNCHPAD_V2)

export const LAUNCHPAD_ABI = parseAbi([
  'struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }',
  'struct LaunchParams { string name; string symbol; string logo; string description; Socials socials; address creatorFeeRecipient; uint16 creatorTaxBps; bool buybackEnabled; bytes32 expectedEconomics; bytes32 salt; }',
  'struct Entry { address token; address curve; address distributor; address charity; address creator; address pairToken; uint16 charityBps; uint64 launchedAt; bytes32 charityId; }',
  'function launch(LaunchParams params, uint256 launchConfigId, address pairToken, address charity, bytes32 charityId, address creatorPayout, uint16 charityBps) payable returns (address token, address curve, address distributor)',
  'struct CharityTerms { address charity; bytes32 charityId; address creatorPayout; uint16 charityBps; }',
  'struct DevBuy { uint256 quoteIn; uint256 minTokensOut; }',
  /**
   * ⛔⛔ The value is EXACT: `launchFee + quoteIn` for a native pair, `launchFee` alone otherwise,
   * and anything else reverts `NativeValueMismatch`. There is no slack and no tip.
   *
   * ⭐ The bought tokens go to `msg.sender`, which the launchpad passes to Pons's periphery. Pons V1
   * chose the buyer for you and sent it to the fee recipient; here the fee recipient is a
   * distributor that cannot move a token balance out, so that would be permanent.
   */
  'function launchWithBuy(LaunchParams params, uint256 launchConfigId, address pairToken, CharityTerms terms, DevBuy devBuy, address[] snipeTaxExemptions) payable returns (address token, address curve, address distributor)',
  'error DevBuyUnavailable()',
  'error NativeValueMismatch(uint256 supplied, uint256 expected)',
  'function count() view returns (uint256)',
  'function page(uint256 offset, uint256 limit) view returns (Entry[])',
  'function minCharityBps() view returns (uint16)',
  'error LaunchesClosed()',
  'error CharityShareTooSmall(uint16 asked, uint16 floorRequired)',
  'error ZeroAddress()',
  'error PairTokenNotApproved(address pairToken)',
  'error EconomicsMoved(bytes32 pinned, bytes32 live)',
])

export const FACTORY_ABI = parseAbi([
  'function launchEnabled() view returns (bool)',
  'function launchFee() view returns (uint256)',
  'function maxCreatorTaxBps() view returns (uint256)',
  'function previewLaunchEconomics(uint256 launchConfigId, address pairToken) view returns (bytes32)',
])

export const DISTRIBUTOR_ABI = parseAbi([
  'function totalToCharity(address asset) view returns (uint256)',
  'function totalToOps(address asset) view returns (uint256)',
  'function pending(address asset) view returns (uint256)',
  /*
    ⛔⛔ THE TWO THAT MOVE MONEY, AND A LAUNCH ONLY EVER USES ONE.

    Pons keeps TWO escrow ledgers and a launch lands in exactly one: a native launch credits the
    native side and a launch paired against USDG credits only the token side, whose native balance
    reads a truthful, useless zero forever. `harvest` claims the native ledger, `harvestToken` the
    other, and calling the wrong one succeeds while moving nothing.

    ⚠ Both RELEASE as well as claim: the charity's share and the launcher's are pushed inside the
    same call. There is no separate withdraw, which is why the interface calls this collecting
    rather than claiming.
  */
  'function harvest() returns (uint256)',
  'function harvestToken(address asset) returns (uint256)',
  /** ⚠ Permissionless passthrough. Pons refuses a sweep from anyone but its operator or the fee
   *  recipient, which is the distributor, so without this a launch's fees wait on Pons's schedule. */
  'function sweepCurve(address curve, uint256 minBuybackTokensOut)',
  /* ⛔⛔ THE SWEEP FOR A GRADUATED LAUNCH, AND ITS ABSENCE HERE WAS A BUG WITH MONEY IN IT.
     Graduating kills the curve: fees stop accruing there and start accruing in the meme hook, and
     `sweepCurve` reverts from then on. With only the curve sweep in this ABI, the site could not
     move a graduated launch's fees at all, and — because `pending()` reads the escrow, which the
     sweep is what fills — could not even SEE them. $CHARITY, this launchpad's largest earner,
     graduated and its claim page reported "Nothing to collect" while real fees piled up in the
     hook. @see unswept.ts */
  'function sweepPool(address hook, bytes32 poolId, uint256 minConversionQuoteOut, uint256 minBuybackTokensOut)',
  'function charityBps() view returns (uint16)',
  'function opsVault() view returns (address)',
])

const CURVE_ABI = parseAbi([
  'function graduated() view returns (bool)',
  /* ⚠ `quoteReserve` INCLUDES the curve's phantom quote, which is virtual and not real money. It
     belongs in the PRICE, because the curve genuinely prices against it, and must be excluded from
     anything describing liquidity or graduation progress. @see marketCap.ts */
  'function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)',
])

const FACTORY_MIN_ABI = parseAbi([
  'function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))',
  /** ⚠ The hook the graduated pool is keyed by. Without it the pool id cannot be derived. */
  'function memeHook() view returns (address)',
])

export const TOKEN_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function decimals() view returns (uint8)',
  /**
   * ⛔⛔ THE REAL BURN, AND THE ONLY ONE. Sending to `0x…dEaD` is not burning: the tokens still
   * exist, `totalSupply` does not move, and every market cap on this site is computed from
   * `totalSupply`, so nothing changes. Proven on a fork, and it has cost this stack once already.
   * `ERC20Burnable.burn` destroys them and the supply falls.
   */
  'function burn(uint256 amount)',
])

const ERC20_ABI = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
  /* ⭐ Read from the token itself rather than guessed from an explorer icon path. The explorer only
     has an icon once it has indexed one, so a brand new launch showed a broken image for its first
     minutes, which is exactly when somebody is looking at it. */
  'function logo() view returns (string)',
])

export type Entry = {
  token: Address
  curve: Address
  distributor: Address
  charity: Address
  creator: Address
  pairToken: Address
  charityBps: number
  launchedAt: bigint
  /** ⚠ The struct has carried this all along and the type did not, so nothing could join a launch
   *  to the charity it names without reaching past the type. It is the whole promise of a launch. */
  charityId: `0x${string}`
}

export type Launch = Entry & {
  name: string
  symbol: string
  /** Already paid out to the charity, in the pair asset's own units. */
  raised: bigint
  /** Swept but not yet claimed. ⚠ A separate number on purpose — see below. */
  pending: bigint
  pairSymbol: string
  pairDecimals: number
  /** The URI stored on the token. Resolve it with `resolveImage` before putting it in a src. */
  logo: string
  /**
   * ⛔ Decides which dashboard a launch appears in, and it appears in exactly ONE. A graduated token
   * trades on a Uniswap V4 pool and a curve one does not; showing a launch in both would also
   * double every count on the page.
   */
  graduated: boolean
  /**
   * Market cap in USD, scaled by 1e6. **Null when it cannot be known**, never zero.
   *
   * ⛔⛔ Null for a graduated launch: graduating sweeps the curve and drains its reserves, so the
   * curve would price the token at nothing. A dash is the honest rendering; a zero beside a live
   * token is a claim that it is worthless.
   */
  marketCapUsd: bigint | null
}

/* ══ reads ══════════════════════════════════════════════════════════════════ */

export async function readFactoryState() {
  const f = { address: PONS_FACTORY, abi: FACTORY_ABI } as const
  const [enabled, fee, maxTax] = await Promise.all([
    publicClient.readContract({ ...f, functionName: 'launchEnabled' }),
    publicClient.readContract({ ...f, functionName: 'launchFee' }),
    publicClient.readContract({ ...f, functionName: 'maxCreatorTaxBps' }),
  ])
  return { enabled, fee, maxTax: Number(maxTax) }
}

export async function previewEconomics(pairToken: Address): Promise<`0x${string}`> {
  return publicClient.readContract({
    address: PONS_FACTORY,
    abi: FACTORY_ABI,
    functionName: 'previewLaunchEconomics',
    args: [LAUNCH_CONFIG_ID, pairToken],
  })
}

export async function readMinCharityBps(): Promise<number> {
  if (!isLive()) return 5000
  /* ⚠ Read from the launchpad the LAUNCH will go to, not the one the site reads history from. The
     two are both 5000 today, so a mix-up would be invisible until one of them changed — and then
     the form would validate against a minimum the contract does not enforce. */
  return Number(
    await publicClient.readContract({
      address: (usingV2() ? LAUNCHPAD_V2 : LAUNCHPAD) as Address,
      abi: LAUNCHPAD_ABI,
      functionName: 'minCharityBps',
    }),
  )
}

/**
 * The launch feed, newest first.
 *
 * ⚠⚠ `raised` is what the distributor has ALREADY PUSHED to the charity, and `pending` is what is
 * swept but unclaimed. They are shown as two numbers and never added together in one figure headed
 * "raised", because a fee is only the charity's once it has moved. Pons pays nothing until somebody
 * calls `claim`, so a combined figure would be a promise dressed as a receipt.
 */
/**
 * ⛔⛔ HOW MANY LAUNCHES ARE READ PER CALL. It is a REQUEST SIZE, NOT A LIMIT ON THE REGISTER.
 *
 * This read used to be a single `page(0, 24)`, and the register outgrew it. Launch 25 onward simply
 * stopped existing as far as the site was concerned: $CHARITY sat at index 26, graduated, at the
 * launchpad's highest market cap, and appeared on no dashboard at all — while its own token page,
 * which reads the token directly, showed it fine. Two of the three graduated tokens were invisible.
 *
 * ⚠ A cap that silently drops the newest rows is worse than a slow page. `count()` decides how many
 * there are and every page is fetched, so the register can grow without the site quietly truncating.
 */
export const PAGE_SIZE = 50

/**
 * The whole register.
 *
 * ⭐ The pages are fetched together and every per-token read is multicall batched, so this is a
 * handful of round trips for the entire launchpad rather than one per launch.
 */
/**
 * Every entry in ONE registry, newest first.
 *
 * ⚠ Returns empty rather than throwing when a registry is unreachable. With two of them, one being
 * down must cost that half of the list and not the whole page — the alternative is that a hiccup on
 * an empty V2 registry blanks 182 real launches.
 */
async function entriesIn(pad: Address): Promise<readonly Entry[]> {
  try {
    const total = (await publicClient.readContract({
      address: pad, abi: LAUNCHPAD_ABI, functionName: 'count',
    })) as bigint
    if (total === 0n) return []

    const offsets: bigint[] = []
    for (let o = 0n; o < total; o += BigInt(PAGE_SIZE)) offsets.push(o)

    const pages = await Promise.all(offsets.map((o) =>
      publicClient.readContract({
        address: pad, abi: LAUNCHPAD_ABI, functionName: 'page', args: [o, BigInt(PAGE_SIZE)],
      }) as Promise<readonly Entry[]>,
    ))
    return pages.flat()
  } catch {
    return []
  }
}

export async function readLaunches(): Promise<Launch[]> {
  if (!isLive()) return []

  /*
    ⛔⛔ BOTH REGISTRIES, ALWAYS. A launchpad's registry is not just where launches are SENT, it is
    what every read on this site walks — Explore, the ledger, token pages, the charity totals, and
    the list the claim page checks an account's shares against.

    The 182 launches made before V2 live in V1's registry, immutably, and V2 starts empty. So
    reading only the new one empties the site, and reading only the old one makes every new launch
    invisible AND its X or GitHub share unclaimable, because the claim page never sees the launch.

    ⚠ Merged newest-first ACROSS both rather than concatenated. Each registry is internally
    newest-first, so appending one to the other would put every old launch above a new one.
  */
  const [a, b] = await Promise.all([
    entriesIn(LAUNCHPAD as Address),
    usingV2() ? entriesIn(LAUNCHPAD_V2 as Address) : Promise.resolve([] as readonly Entry[]),
  ])
  const entries = [...a, ...b].sort((x, y) => Number(y.launchedAt) - Number(x.launchedAt))

  return Promise.all(
    entries.map(async (e) => {
      const pair = pairBy(e.pairToken)
      /* ⚠ Two waves on purpose: the curve address is only known after the factory answers, and
         `graduated()` lives on the curve. Both waves are multicall batched, so this is two round
         trips for the whole register rather than two per token. */
      const [name, symbol, logo, raised, pend, launched, totalSupply] = await Promise.all([
        publicClient.readContract({ address: e.token, abi: ERC20_ABI, functionName: 'name' }).catch(() => 'Unknown'),
        publicClient.readContract({ address: e.token, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => '???'),
        publicClient.readContract({ address: e.token, abi: ERC20_ABI, functionName: 'logo' }).catch(() => ''),
        publicClient
          /* ⛔ The REMIT asset, not the pair asset. A stock-paired launch's charity share is
             credited under USDG once it is sold, so reading the pair asset reports a launch that
             has raised real money as having raised nothing. @see remitAssetFor */
          .readContract({ address: e.distributor, abi: DISTRIBUTOR_ABI, functionName: 'totalToCharity', args: [remitAssetFor(e.pairToken)] })
          .catch(() => 0n),
        publicClient
          .readContract({ address: e.distributor, abi: DISTRIBUTOR_ABI, functionName: 'pending', args: [e.pairToken] })
          .catch(() => 0n),
        publicClient
          .readContract({ address: PONS_FACTORY, abi: FACTORY_MIN_ABI, functionName: 'getLaunchedToken', args: [e.token] })
          .catch(() => null),
        publicClient.readContract({ address: e.token, abi: ERC20_ABI, functionName: 'totalSupply' }).catch(() => 0n),
      ])

      const curve = launched?.curve
      const hasCurve = curve && curve !== '0x0000000000000000000000000000000000000000'
      const [graduated, reserves] = hasCurve
        ? await Promise.all([
            publicClient.readContract({ address: curve, abi: CURVE_ABI, functionName: 'graduated' }).catch(() => false),
            publicClient.readContract({ address: curve, abi: CURVE_ABI, functionName: 'getReserves' })
              .catch(() => null),
          ])
        : [false, null]

      /* ⚠ The USD rate is per pair ASSET, so it is fetched once per asset and cached, not once per
         launch. A dozen rows priced in ETH make one set of pool reads between them. */
      const usdPerUnit = await usdPerAsset(e.pairToken, pair?.decimals ?? 18)
      const pairDec = pair?.decimals ?? 18

      /*
        ⛔⛔ A GRADUATED TOKEN IS PRICED BY ITS POOL, NOT BY THE CURVE IT LEFT.

        Graduating drains the curve, so `marketCapInPair` correctly refuses to price from it — but
        refusing is only right if something else can. The token page already read the Uniswap V4 pool
        for exactly this case, and the dashboards did not, so the same launch showed a figure on its
        own page and a dash in every list. Every card in the explore page's Graduated section would
        have carried that dash.

        ⚠ Still null while a launch sits in phase 1: graduate() sweeps the curve and hands the
        reserves to the factory, and nobody can trade until somebody pays the gas to create the pool.
        A dash is right THERE, because nothing can price it yet.
      */
      let capInPair: bigint | null = null
      if (graduated) {
        const hook = await publicClient
          .readContract({ address: PONS_FACTORY, abi: FACTORY_MIN_ABI, functionName: 'memeHook' })
          .catch(() => null)
        if (launched && hook) {
          const price = await poolPrice(
            e.token, e.pairToken, Number(launched.poolFee), Number(launched.tickSpacing),
            hook as Address, 18, pairDec,
          )
          if (price !== null && totalSupply > 0n) {
            /* ⚠ Back into the pair's BASE units, the unit `capUsdScaled` takes, rather than being
               multiplied by a rate as a float. */
            const whole = price * (Number(totalSupply) / 1e18)
            if (Number.isFinite(whole) && whole > 0) capInPair = BigInt(Math.round(whole * 10 ** pairDec))
          }
        }
      } else if (reserves) {
        capInPair = marketCapInPair({
          quoteReserve: reserves[0], tokenReserve: reserves[1], totalSupply, graduated: false,
        })
      }

      return {
        ...e,
        charityBps: Number(e.charityBps),
        name,
        symbol,
        raised,
        pending: pend,
        pairSymbol: pair?.symbol ?? 'TOKEN',
        pairDecimals: pair?.decimals ?? 18,
        logo: logo as string,
        graduated: Boolean(graduated),
        marketCapUsd: capUsdScaled(capInPair, pairDec, usdPerUnit),
      }
    }),
  )
}

/**
 * Every launch's charity id and what it has paid, for the per-charity figures on the directory.
 *
 * ⭐ Deliberately much lighter than `readLaunches`. That one fetches a name, symbol, logo, pending
 * balance, the factory record and a graduation flag for each token — six reads a launch, to render
 * a register. This needs three fields, so it reads the register and one `totalToCharity` per launch
 * and nothing else. The directory page is already fetching a megabyte of charities; it must not also
 * pull the whole launch feed to put a number on a card.
 *
 * ⚠ Pages through `count()` rather than assuming one page. `page(0, 500)` silently truncates the
 * moment there are 501 launches, and the failure looks like charities quietly losing their totals.
 */
export async function readCharityStatRows(): Promise<StatRow[]> {
  if (!isLive()) return []

  /* ⛔⛔ BOTH REGISTRIES. This is where "$X to N charities" comes from — the number the whole site
     exists to show. Counting one registry would under-report it for ever, quietly and plausibly. */
  const [a, b] = await Promise.all([
    entriesIn(LAUNCHPAD as Address),
    usingV2() ? entriesIn(LAUNCHPAD_V2 as Address) : Promise.resolve([] as readonly Entry[]),
  ])
  const entries = [...a, ...b]
  if (entries.length === 0) return []

  return Promise.all(
    entries.map(async (e) => ({
      charityId: e.charityId,
      /* ⛔⛔ THE REMIT ASSET, BECAUSE THAT IS WHAT `paid` IS DENOMINATED IN. Reporting the PAIR
         asset beside a figure credited under USDG labels 12.4 USDG as "0.65 GME" — wrong unit and
         wrong decimals at once, which is the exact shape of the mistake this file warns about
         elsewhere. The amount and its label must travel together. */
      asset: remitAssetFor(e.pairToken),
      /* ⚠ `totalToCharity`, never `pending`. Paid means pushed. A swept but unclaimed balance is not
         the charity's yet, and the site does not add the two together anywhere else either. */
      paid: await publicClient
        .readContract({ address: e.distributor, abi: DISTRIBUTOR_ABI, functionName: 'totalToCharity', args: [remitAssetFor(e.pairToken)] })
        .catch(() => 0n),
    })),
  )
}

export const fmtAmount = (v: bigint, decimals: number, max = 4) => {
  const s = formatUnits(v, decimals)
  const n = Number(s)
  if (n === 0) return '0'
  if (n < 0.0001) return '<0.0001'
  return n.toLocaleString('en-US', { maximumFractionDigits: max })
}

export const NATIVE_ADDRESS = NATIVE

/**
 * V2's launch ABI. ⭐ `splits` is what decides where the creator's half goes — a wallet, an X or
 * GitHub account, a buy-and-burn, or any combination — and `mode` is 0 wallet / 1 account / 2 burn,
 * with `bps` of the REMAINDER after the charity's share, summing to exactly 10,000.
 *
 * ⚠ AN EMPTY ARRAY IS THE V1 BEHAVIOUR: the launchpad deploys no router at all, so a wallet-only
 * launch pays no gas for a splitter that splits one way.
 */
export const LAUNCHPAD_V2_ABI = parseAbi([
  'struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }',
  'struct LaunchParams { string name; string symbol; string logo; string description; Socials socials; address creatorFeeRecipient; uint16 creatorTaxBps; bool buybackEnabled; bytes32 expectedEconomics; bytes32 salt; }',
  'struct Split { uint8 mode; uint16 bps; address wallet; bytes32 beneficiary; uint8 provider; uint256 accountId; }',
  'struct CharityTerms { address charity; bytes32 charityId; address creatorPayout; uint16 charityBps; Split[] splits; }',
  'struct DevBuy { uint256 quoteIn; uint256 minTokensOut; }',
  'function launch(LaunchParams params, uint256 launchConfigId, address pairToken, address charity, bytes32 charityId, address creatorPayout, uint16 charityBps) payable returns (address token, address curve, address distributor, address router)',
  'function launchWithBuy(LaunchParams params, uint256 launchConfigId, address pairToken, CharityTerms terms, DevBuy devBuy, address[] snipeTaxExemptions) payable returns (address token, address curve, address distributor, address router)',
  'error DevBuyUnavailable()',
  'error NativeValueMismatch(uint256 supplied, uint256 expected)',
])
