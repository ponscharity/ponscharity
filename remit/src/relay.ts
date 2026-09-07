import type { Address, Hex } from 'viem'

/**
 * The last mile: Robinhood Chain → the charity's own address on Ethereum, in one transaction.
 *
 * ⭐ This is the mirror image of `~/ponsterm/src/lib/relay.ts`, which uses RHC as a DESTINATION for
 * funding wallets. Here RHC is the ORIGIN. Relay lists it as chain 4663 with `depositEnabled: true`,
 * and a solver pays the recipient on the far side out of its own inventory in about four seconds.
 *
 * ## ⭐⭐ THE RECIPIENT IS THE CHARITY'S OWN ADDRESS, DIRECTLY
 *
 * `recipient` does not have to be the sender, so nothing has to land in a wallet we control on the
 * destination chain. The charity's published mainnet USDC address is the recipient of the deposit
 * itself. There is no far-side hot wallet, no far-side custody, and no far-side key to lose.
 *
 * ## ⛔⛔ AND THE THING THAT CANNOT BE CHECKED ON CHAIN
 *
 * The deposit is 68 bytes: `0x49290c1c || user || keccak(request)`. **The recipient is not in it.**
 * It lives in Relay's off-chain request, keyed by that hash. So no contract can verify a bridge's
 * destination, and any claim of an end-to-end trustless remit on this route is false — see the
 * trust note in CharityDistributor.sol.
 *
 * ➤ The compensating control is publication, not prevention. Relay's requests API resolves a
 * requestId to its recipient and is queryable by anyone, so every remit this service performs is
 * independently checkable forever. `remitReceipt` below is what gets published for each one.
 */
const API = 'https://api.relay.link'

export const RHC_CHAIN_ID = 4663
export const NATIVE = '0x0000000000000000000000000000000000000000' as const

/** USDG on Robinhood Chain. ⚠ SIX decimals, not eighteen. */
export const USDG_RHC = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address

/**
 * What the charity is paid in, on Ethereum.
 *
 * ⭐⭐ THE DESTINATION ASSET IS A PARAMETER, NOT A CONSTANT. Relay prices a route to whatever asset
 * is asked for, so a charity that publishes a USDT address is paid in USDT and one that publishes an
 * ETH address is paid in ETH. Forcing everything to USDC would deliver an asset the charity never
 * asked to receive, to an address they published for something else.
 *
 * ⚠ The CONTRACT records only the address, which is correct: what is immutable should be the
 * destination, not our opinion about denomination. The asset is resolved from the charity registry
 * at remit time, and an address that is not in it is paid in USDC, which any EVM address can hold.
 */
export const MAINNET_ASSETS = {
  ETH: '0x0000000000000000000000000000000000000000',
  USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
} as const satisfies Record<string, Address>

export type PayoutAsset = keyof typeof MAINNET_ASSETS

/** ⚠ Kept for callers that have no registry entry to consult. */
export const USDC_MAINNET = MAINNET_ASSETS.USDC as Address

export type RemitQuote = {
  requestId: Hex
  deposit: { to: Address; data: Hex; value: bigint; chainId: number }
  inUsd: number
  outUsd: number
  outFormatted: string
  timeEstimateSec: number
  /** ⚠ Present only for ERC-20 origins. Native routes are a single deposit. */
  needsApproval: boolean
  at: number
}

/**
 * ⛔⛔ A QUOTE IS PERISHABLE. Relay prices a route at a moment; sending a stale deposit gets it
 * rejected or refunded on the origin side — money out, nothing delivered, a refund to chase, and a
 * published ledger that has to explain it. Quote immediately before signing, every time.
 */
export const MAX_QUOTE_AGE_MS = 30_000
export const quoteIsStale = (q: RemitQuote, now = Date.now()) => now - q.at > MAX_QUOTE_AGE_MS

export class RelayError extends Error {}

/**
 * Prices moving everything in `amount` of `originCurrency` out of RHC to `charity` as mainnet USDC.
 *
 * ⭐ `EXACT_INPUT`, the opposite of ponsterm's funding panel. Funding says "this wallet must end up
 * holding X" so the fee comes off the sender's side. A remit says "send all of it" — the charity
 * receives whatever the route delivers, and the amount that leaves is the amount that was raised.
 * Pinning the output would mean deciding in advance how much of a donation to keep back, which is
 * not a decision this service should be able to make.
 */
export async function quoteRemit(params: {
  sender: Address
  charity: Address
  originCurrency: Address | typeof NATIVE
  amount: bigint
  destinationChainId?: number
  destinationCurrency?: Address
  signal?: AbortSignal
}): Promise<RemitQuote> {
  const body = {
    user: params.sender,
    recipient: params.charity,
    originChainId: RHC_CHAIN_ID,
    destinationChainId: params.destinationChainId ?? 1,
    originCurrency: params.originCurrency,
    destinationCurrency: params.destinationCurrency ?? USDC_MAINNET,
    tradeType: 'EXACT_INPUT',
    amount: params.amount.toString(),
  }

  /*
    ⛔⛔ RETRIED, BECAUSE A TRANSIENT QUOTE FAILURE COSTS A LAUNCH A WHOLE PASS.

    Measured 29 Aug 2026: 195 quote failures in two hours, almost all
    `Could not process request. Please try again later.` — while the same endpoint answered 6 of 6
    when asked by hand a minute later. It is transient, and it was the reason 1.48 ETH piled up in
    the vault: the keeper correctly refuses to bridge without a price, so every failed quote held
    that launch's money until the next pass, where it usually failed again.

    ⚠ Only the transient shapes are retried. `Unsupported currency` is the tokenized-stock case and
    is a launch-configuration error, not a blip — retrying it would spend three requests learning
    what the first one said, and would bury the message the operator needs to see.
  */
  const TRANSIENT = /could not process|please try again|timeout|temporar|rate limit|too many/i
  let res: Response | undefined
  let json: any
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(`${API}/quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: params.signal,
    })
    json = (await res.json().catch(() => null)) as any
    if (res.ok && json) break
    const msg = String(json?.message ?? `HTTP ${res.status}`)
    if (!TRANSIENT.test(msg) || attempt === 2) break
    /* ⚠ Backing off, not hammering: the failure mode this exists for is us asking too fast. */
    await new Promise((r) => setTimeout(r, 700 * (attempt + 1)))
  }

  if (!res!.ok || !json) {
    /* ⛔ "Unsupported currency" is the tokenized-stock case and it is not transient. It must reach
       the operator as a launch-configuration error, not as a retryable network blip. */
    const message = json?.message ?? `HTTP ${res!.status}`
    throw new RelayError(`relay: ${message}`)
  }

  const steps: any[] = json.steps ?? []
  const deposit = steps.find((s) => s.id === 'deposit')
  const item = deposit?.items?.[0]
  if (!item?.data?.to) throw new RelayError('relay returned no deposit step for this route')

  const d = json.details ?? {}
  return {
    requestId: (deposit.requestId ?? json.requestId) as Hex,
    deposit: {
      to: item.data.to as Address,
      data: (item.data.data ?? '0x') as Hex,
      value: BigInt(item.data.value ?? '0'),
      chainId: Number(item.data.chainId ?? RHC_CHAIN_ID),
    },
    inUsd: Number(d.currencyIn?.amountUsd ?? 0),
    outUsd: Number(d.currencyOut?.amountUsd ?? 0),
    outFormatted: String(d.currencyOut?.amountFormatted ?? '0'),
    timeEstimateSec: Number(d.timeEstimate ?? 0),
    needsApproval: steps.some((s) => s.id === 'approve'),
    at: Date.now(),
  }
}

/**
 * What gets published for every remit, on the site and in the log.
 *
 * ⚠⚠ Both legs, or it is not a receipt. An RHC transaction hash on its own proves money left; it
 * proves nothing about where it arrived, which is the only fact a donor cares about. The Relay
 * request status carries the destination transaction, and that is the half worth showing.
 */
export type RemitReceipt = {
  requestId: Hex
  originTx: Hex
  destinationTx?: Hex
  status: string
  charity: Address
  inUsd: number
  outUsd: number
  at: number
}

export async function pollRemit(requestId: Hex, signal?: AbortSignal): Promise<RemitReceipt | null> {
  const res = await fetch(`${API}/intents/status?requestId=${requestId}`, { signal })
  if (!res.ok) return null
  const j = (await res.json().catch(() => null)) as any
  if (!j) return null
  return {
    requestId,
    originTx: j.inTxHashes?.[0] as Hex,
    destinationTx: j.txHashes?.[0] as Hex | undefined,
    status: String(j.status ?? 'unknown'),
    charity: j.details?.recipient as Address,
    inUsd: Number(j.details?.currencyIn?.amountUsd ?? 0),
    outUsd: Number(j.details?.currencyOut?.amountUsd ?? 0),
    at: Date.now(),
  }
}

/**
 * ⛔⛔ RELAY'S DEPOSIT CALLDATA IS A MOVING TARGET AND THE VAULT PINS ONE SHAPE FOREVER.
 *
 * `RemitVault._requestId` accepts exactly 68 bytes — `0x49290c1c` (`depositNative(address,bytes32)`),
 * the depositing account, the request id — and forwards them to its own IMMUTABLE `relayDepositor`.
 * There is no setter and no upgrade. That check is the reason the keeper cannot use the vault as a
 * general-purpose call, so it is not something to relax; it is something to respect before signing.
 *
 * On 30 Aug 2026 Relay began answering RHC quotes with a 2–6 KB `0xcd6e13f7` multicall against its
 * **v3 erc20Router**, which swaps ETH→USDG on the origin before depositing. The vault refused every
 * one of them with `BadDepositData()` and the service stopped donating at 15:49 UTC. ⭐ The old
 * shape did NOT go away: it returns in waves — measured at 12–13 direct deposits a minute on chain,
 * then none for four minutes, then back. So the fix is to LOOK BEFORE SIGNING and retry into a
 * window, not to send hopefully and let the chain reject it.
 *
 * ⚠ `to` is checked too, and it is the check that is easy to forget: the vault ignores the quote's
 * `to` entirely and always calls its own pinned depositor. A 68-byte deposit addressed at some other
 * contract would look perfect here and be delivered to the wrong one.
 */
export const VAULT_DEPOSIT_SELECTOR = '0x49290c1c'
export const VAULT_DEPOSIT_BYTES = 68

export type DepositFit = { ok: boolean; reason: string }

export function fitsVault(
  q: RemitQuote,
  p: { vault: Address; depositor: Address; amount: bigint; isNative: boolean },
): DepositFit {
  const data = (q.deposit.data ?? '0x').toLowerCase()
  const bytes = (data.length - 2) / 2

  if (q.deposit.chainId !== RHC_CHAIN_ID) {
    return { ok: false, reason: `the deposit is for chain ${q.deposit.chainId}, not RHC` }
  }
  if (q.deposit.to.toLowerCase() !== p.depositor.toLowerCase()) {
    /* ⛔ The vault would send this to its OWN depositor regardless of what the quote says. */
    return { ok: false, reason: `Relay routed via ${q.deposit.to}, not the vault's depositor ${p.depositor}` }
  }
  if (bytes !== VAULT_DEPOSIT_BYTES || !data.startsWith(VAULT_DEPOSIT_SELECTOR)) {
    return {
      ok: false,
      reason: `Relay returned ${bytes}B ${data.slice(0, 10)}, and the vault pins ${VAULT_DEPOSIT_BYTES}B ${VAULT_DEPOSIT_SELECTOR}`,
    }
  }
  /* ⚠ Relay refunds a failed request to the account named here, so anything but the vault routes a
     refund away from the vault — the same reason the contract checks it. */
  const user = `0x${data.slice(10 + 24, 74)}`
  if (user !== p.vault.toLowerCase()) {
    return { ok: false, reason: `the deposit names ${user} as the depositor, not the vault` }
  }
  /* ⚠ Native sends value with the call; an ERC-20 deposit must not, or the vault leaks ETH. */
  const wantValue = p.isNative ? p.amount : 0n
  if (q.deposit.value !== wantValue) {
    return { ok: false, reason: `the deposit carries ${q.deposit.value} wei, expected ${wantValue}` }
  }
  return { ok: true, reason: 'matches the shape the vault pins' }
}
