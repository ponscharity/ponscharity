/**
 * What a launch owes an X or GitHub account, and the voucher that lets them take it.
 *
 * Ported from PONSPAD's `server/src/claims.ts`, which has been paying real people since 20 Aug 2026.
 *
 * ## Why a voucher rather than the server sending
 *
 * The blast radius. A wallet that can send can send **everything**, so one leaked key costs every
 * recipient their balance at once. Here the signer can only ever **sign a voucher**: it cannot move
 * money, cannot withdraw, and cannot change where a voucher pays. The recipient submits their own
 * claim and pays their own gas, so a payout is something they do rather than something they wait for.
 *
 * ## ⛔⛔ WHAT IS OWED IS READ OFF THE CHAIN, NEVER OUT OF A DATABASE
 *
 * {@link CharityFeeClaims} ring-fences money per launch AND beneficiary AND asset, so "what is this
 * account owed" is a question the contract already answers. The server's only additions are the two
 * things the contract cannot know: who owns an X account, and which vouchers it has already signed
 * but nobody has spent yet.
 */

import { createPublicClient, http, parseAbi, keccak256, toBytes } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const RHC_RPC = process.env.RHC_RPC ?? 'https://rpc.mainnet.chain.robinhood.com'

/**
 * ⛔⛔ Robinhood Chain's RPC is behind Cloudflare and it CHALLENGES A DEFAULT AGENT. Node's own
 * User-Agent gets an HTML "Just a moment..." page that viem then fails to parse, and the failure
 * names no cause. It only appears once this runs somewhere other than a laptop.
 */
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'

const rhc = {
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RHC_RPC] } },
}

const ZERO = '0x0000000000000000000000000000000000000000'

const CLAIMS_ABI = parseAbi([
  'function claimable(address launch, bytes32 beneficiary, address asset) view returns (uint256)',
  'function redeemed(bytes32 id) view returns (bool)',
  'function paused() view returns (bool)',
  'function NAME() view returns (string)',
  'function voucherId(address launch, bytes32 beneficiary, address asset, address recipient, uint256 amount, bytes32 salt, uint256 deadline) view returns (bytes32)',
])

const LAUNCHPAD_ABI = parseAbi([
  'function isCharityLaunch(address token) view returns (bool)',
  'function distributorOf(address token) view returns (address)',
])

const DISTRIBUTOR_ABI = parseAbi(['function opsVault() view returns (address)'])

const ROUTER_ABI = parseAbi([
  'struct Split { uint8 mode; uint16 bps; address wallet; bytes32 beneficiary; uint8 provider; uint256 accountId; }',
  'function splits() view returns (Split[])',
  'function pairToken() view returns (address)',
  'function token() view returns (address)',
])

/** ⚠ Mirrors `CreatorRouter.Mode`. Only `XAccount` is ever ring-fenced in the claims contract. */
const MODE_XACCOUNT = 1

export function makeClaims({ address, launchpad, signerKey, voucherTtlSeconds = 900 }) {
  const client = createPublicClient({
    chain: rhc,
    transport: http(RHC_RPC, { fetchOptions: { headers: { 'User-Agent': BROWSER_UA } }, retryCount: 4 }),
  })
  const account = privateKeyToAccount(signerKey)

  /* ⛔ Set from the chain by `assertDomain()` before the server starts serving. The default is what
     the contract is expected to say, not a value anything may rely on. */
  let domainName = 'CharityFeeClaims'

  /**
   * ⛔⛔ IN-MEMORY, AND THAT IS A DELIBERATE LIMIT, NOT AN OVERSIGHT.
   *
   * It records vouchers signed but not yet spent, so two claims in the same minute cannot both be
   * signed for the whole balance. A restart forgets them — and the consequence is bounded: the
   * contract itself refuses to pay more than `claimable`, so the worst case is a second voucher
   * that reverts, never a double payment. Persisting it would be better; pretending the contract
   * needs it to be safe would be wrong.
   */
  const issued = new Map()

  const liveVouchers = (launch, beneficiary, asset, now) =>
    [...issued.values()].filter(
      (v) =>
        v.launch.toLowerCase() === launch.toLowerCase() &&
        v.beneficiary.toLowerCase() === beneficiary.toLowerCase() &&
        v.asset.toLowerCase() === asset.toLowerCase() &&
        v.deadline > now,
    )

  /** ⛔ One signature at a time per (launch, beneficiary, asset) — the read, the sign and the record
      are one critical section, or the reservation below is advisory. */
  const locks = new Map()
  const oneAtATime = async (lockKey, fn) => {
    const prior = locks.get(lockKey) ?? Promise.resolve()
    let release
    locks.set(lockKey, new Promise((r) => { release = r }))
    try {
      await prior
      return await fn()
    } finally {
      release()
    }
  }

  return {
    address,
    signer: account.address,

    /**
     * ⛔⛔ WHAT A LAUNCH ACTUALLY PAYS, READ OFF THE CHAIN — never out of a request body.
     *
     * The chain is walked the whole way: our launchpad's registry says which distributor a token
     * uses, the distributor says which router it pays, and the router's own immutable `splits` say
     * which accounts it pays and how much. An attacker cannot name themselves anywhere along that
     * path, because their hash is simply not in the router's constructor arguments.
     */
    async payingShares(launch) {
      try {
        const isOurs = await client.readContract({
          address: launchpad, abi: LAUNCHPAD_ABI, functionName: 'isCharityLaunch', args: [launch],
        })
        if (!isOurs) return { ok: false, error: 'that token was not launched here' }

        const distributor = await client.readContract({
          address: launchpad, abi: LAUNCHPAD_ABI, functionName: 'distributorOf', args: [launch],
        })
        if (!distributor || distributor === ZERO) return { ok: false, error: 'that launch has no distributor' }

        const router = await client.readContract({
          address: distributor, abi: DISTRIBUTOR_ABI, functionName: 'opsVault',
        })
        if (!router || router === ZERO) return { ok: false, error: 'that launch pays nobody' }

        /* ⚠ A router is a CONTRACT; a plain wallet payout is an EOA. Reading `splits()` off an EOA
           returns empty data, which viem surfaces as a decode error rather than "no shares" — so
           the shape is checked first and the honest answer given. */
        const code = await client.getBytecode({ address: router })
        if (!code || code === '0x') {
          return { ok: false, error: 'that launch pays a wallet directly, so there is nothing to claim here' }
        }

        const [splits, asset] = await Promise.all([
          client.readContract({ address: router, abi: ROUTER_ABI, functionName: 'splits' }),
          client.readContract({ address: router, abi: ROUTER_ABI, functionName: 'pairToken' }),
        ])

        const shares = splits
          .filter((s) => Number(s.mode) === MODE_XACCOUNT)
          .map((s) => ({ beneficiary: s.beneficiary.toLowerCase(), bps: Number(s.bps) }))

        return { ok: true, shares, asset, router }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message.split('\n')[0] : String(err) }
      }
    },

    async shareOf(launch, beneficiary) {
      const all = await this.payingShares(launch)
      if (!all.ok) return all
      const share = all.shares.find((s) => s.beneficiary === beneficiary.toLowerCase())
      if (!share) return { ok: false, error: 'that launch does not pay that account' }
      return { ok: true, bps: share.bps, asset: all.asset, router: all.router }
    },

    /**
     * What is claimable right now, after subtracting vouchers already signed and not yet spent.
     *
     * ⚠ A live voucher that has ALREADY been redeemed is not debt: the chain has taken it out of
     * `claimable` too, so counting it again would hide money from its owner until the window
     * lapsed. Asked per voucher rather than assumed, because the alternative errs against the payee.
     */
    async entitlement(launch, beneficiary, asset) {
      const onChain = await client.readContract({
        address, abi: CLAIMS_ABI, functionName: 'claimable', args: [launch, beneficiary, asset],
      })

      const now = Math.floor(Date.now() / 1000)
      let reserved = 0n
      for (const v of liveVouchers(launch, beneficiary, asset, now)) {
        const spent = await client.readContract({
          address, abi: CLAIMS_ABI, functionName: 'redeemed', args: [v.id],
        })
        if (!spent) reserved += BigInt(v.amount)
      }

      const available = onChain > reserved ? onChain - reserved : 0n
      return { launch, beneficiary, asset, onChain, reserved, available }
    },

    async issue({ launch, beneficiary, asset, recipient, amount }) {
      if (amount <= 0n) return { ok: false, error: 'there is nothing to claim' }

      /*
        ⛔⛔ REFUSED WHILE THE CONTRACT IS PAUSED, because `claim` reverts before it looks at
        anything else — so a voucher signed now is not a voucher, it is a transaction the holder
        pays gas to watch fail.
        🔴🔴 And it is worse than a wasted signature: issuing RECORDS the voucher, and a recorded
        voucher is debt that suppresses `available` for its whole window. Signing during a pause
        would take the money away from the person who could not spend it. Pausing is the documented
        answer to a stolen signer key, so this is the one moment the route must refuse.
      */
      try {
        const paused = await client.readContract({ address, abi: CLAIMS_ABI, functionName: 'paused' })
        if (paused) return { ok: false, error: 'claiming is paused right now. Nothing is lost — try again later.' }
      } catch {
        /* ⚠ A read that FAILS is not a pause. Refusing here would let one unreachable RPC stop every
           claim on the site, a bigger outage than the one this check prevents — and the contract
           enforces the pause itself, so the worst case is the wasted signature this guards against. */
      }

      const lockKey = `${launch.toLowerCase()}|${beneficiary.toLowerCase()}|${asset.toLowerCase()}`
      return oneAtATime(lockKey, async () => {
        const e = await this.entitlement(launch, beneficiary, asset)
        if (amount > e.available) {
          return {
            ok: false,
            error: `that is more than this share has available (${e.available} of ${e.onChain}, `
              + `with ${e.reserved} already signed for)`,
          }
        }

        const deadline = BigInt(Math.floor(Date.now() / 1000) + voucherTtlSeconds)
        const salt = keccak256(toBytes(`${lockKey}|${Date.now()}|${Math.random()}`))

        /*
          ⛔⛔ THE DOMAIN NAME MUST MATCH THE CONTRACT'S `NAME`, EXACTLY.
          This contract is a rename of PONSPAD's, and the rename went through the Solidity constant
          too — so a server left signing "PonsiFeeClaims" would produce a signature that recovers to
          a different address and every claim would revert `BadSignature`, with the money sitting
          right there and nothing saying why. It is READ FROM THE CHAIN at startup rather than
          pinned here; see `assertDomain`.
        */
        const signature = await account.signTypedData({
          domain: { name: domainName, version: '1', chainId: 4663, verifyingContract: address },
          types: {
            Voucher: [
              { name: 'launch', type: 'address' },
              { name: 'beneficiary', type: 'bytes32' },
              { name: 'asset', type: 'address' },
              { name: 'recipient', type: 'address' },
              { name: 'amount', type: 'uint256' },
              { name: 'salt', type: 'bytes32' },
              { name: 'deadline', type: 'uint256' },
            ],
          },
          primaryType: 'Voucher',
          message: { launch, beneficiary, asset, recipient, amount, salt, deadline },
        })

        const id = await client.readContract({
          address, abi: CLAIMS_ABI, functionName: 'voucherId',
          args: [launch, beneficiary, asset, recipient, amount, salt, deadline],
        })

        /* ⚠⚠ Recorded AFTER the signature exists, never before. A row written first and a signature
           that then fails leaves a debt against a voucher nobody holds, and the payee's retry is
           told they are owed nothing. That exact ordering locked somebody out permanently once. */
        issued.set(id, {
          id, launch, beneficiary, asset, recipient,
          amount: amount.toString(), deadline: Number(deadline),
        })

        return {
          ok: true,
          voucher: {
            launch, beneficiary, asset, recipient,
            amount: amount.toString(), salt, deadline: deadline.toString(), signature,
          },
          id,
        }
      })
    },

    /**
     * ⛔⛔ READ THE CONTRACT'S OWN NAME AT STARTUP AND REFUSE TO RUN IF IT DISAGREES.
     *
     * The EIP-712 domain is the one thing that can be wrong while everything looks right: a
     * mismatched name produces a perfectly well-formed signature that recovers to the wrong address,
     * so the server reports success, the site shows a voucher, and the claim reverts on chain. This
     * contract was renamed from PONSPAD's, so the hazard is not hypothetical here.
     */
    async assertDomain() {
      const onChain = await client.readContract({ address, abi: CLAIMS_ABI, functionName: 'NAME' })
      domainName = onChain
      return onChain
    },
  }
}
