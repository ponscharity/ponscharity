import { createPublicClient, getAddress, http, isAddress, type Address } from 'viem'
import { publicClient } from './chain.ts'

/**
 * What can actually be checked about a charity address before it is written in forever.
 *
 * ## ⛔⛔ THE CHECK THAT MATTERS, AND WHY IT IS NOT OBVIOUS
 *
 * The distributor pushes the charity's share **on Robinhood Chain**. So whatever address is named
 * has to be controllable on Robinhood Chain, not only on Ethereum.
 *
 * For an ordinary wallet that is fine: one private key controls the same address on every EVM
 * chain, so a charity handed funds on RHC can move them.
 *
 * ⛔ For a CONTRACT it is not fine at all. A Gnosis Safe, or a Giving Block address (their own docs
 * say an ETH address "is converted to a smart contract" after the first donation), exists at that
 * address on Ethereum and **nowhere else**. The identical address on Robinhood Chain is an empty
 * account nobody holds a key to. Fees pushed there are gone permanently, and every part of this
 * looks correct while it happens: the launch succeeds, the explorer shows a balance, and the money
 * is unreachable forever.
 *
 * ➤ So the address is checked for code on BOTH chains and a contract on either one is a loud stop.
 *
 * ## ⚠ A check that cannot run must never report a pass
 *
 * Every probe here returns `unknown` when the RPC does not answer, and `unknown` renders as a
 * warning rather than a tick. A network blip that silently reads as "no code found" is how a Safe
 * address gets waved through.
 */
/**
 * ⛔⛔ SINCE EIP-7702, "HAS CODE" NO LONGER MEANS "IS A CONTRACT".
 *
 * A delegated EOA carries a 23 byte indicator, `0xef0100` followed by the address it delegates to.
 * It is still an ordinary wallet controlled by a private key, that key still controls the same
 * address on every chain, and the delegation itself is per chain. Treating it as a contract rejects
 * a perfectly good charity wallet with a scary red stop.
 *
 * 🔴 Caught by a test, not by reading: the first version of this file flagged a well known personal
 * wallet as a contract on Ethereum, which would have blocked real charities from being paid.
 */
const DELEGATION_PREFIX = '0xef0100'
const DELEGATION_LENGTH = 2 + 23 * 2

export const isDelegatedEoa = (code: string) =>
  code.length === DELEGATION_LENGTH && code.toLowerCase().startsWith(DELEGATION_PREFIX)

const MAINNET_RPC = 'https://ethereum-rpc.publicnode.com'

const mainnet = createPublicClient({
  transport: http(MAINNET_RPC),
  chain: {
    id: 1, name: 'Ethereum',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [MAINNET_RPC] } },
  },
})

export type Severity = 'ok' | 'warn' | 'stop' | 'unknown'

export type Check = { id: string; label: string; severity: Severity; detail?: string }

export type AddressReport = {
  valid: boolean
  checksummed?: Address
  checks: Check[]
  /** True when nothing found is a hard stop. A warn does not block, it just has to be read. */
  passable: boolean
}

/* ⛔ Addresses that are never a charity. Money sent to any of these is destroyed. */
const DEAD = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
  '0x0000000000000000000000000000000000000001',
])

export async function checkCharityAddress(raw: string): Promise<AddressReport> {
  const input = raw.trim()
  if (!isAddress(input)) {
    return {
      valid: false,
      passable: false,
      checks: [{ id: 'format', label: 'Not a valid address', severity: 'stop', detail: 'An address is 42 characters starting with 0x.' }],
    }
  }

  const addr = getAddress(input)
  const checks: Check[] = []

  /*
    ⚠ The mixed-case checksum is only meaningful if the input HAD mixed case. An all-lowercase
    address is perfectly valid and carries no checksum at all, so calling it "unchecked" is honest
    and calling it "failed" would be wrong.
  */
  const hadCase = /[A-F]/.test(input.slice(2)) && /[a-f]/.test(input.slice(2))
  checks.push(
    hadCase
      ? { id: 'checksum', label: 'Checksum matches', severity: 'ok', detail: 'The capitalisation confirms no character was mistyped.' }
      : { id: 'checksum', label: 'No checksum to verify', severity: 'warn', detail: 'This was typed in lower case, so a mistyped character cannot be detected. Compare it against the source, character by character.' },
  )

  if (DEAD.has(addr.toLowerCase())) {
    checks.push({ id: 'dead', label: 'This is a burn address', severity: 'stop', detail: 'Anything sent here is destroyed.' })
    return { valid: true, checksummed: addr, checks, passable: false }
  }

  const [rhcCode, ethCode] = await Promise.all([
    publicClient.getBytecode({ address: addr }).then((c) => c ?? '0x').catch(() => null),
    mainnet.getBytecode({ address: addr }).then((c) => c ?? '0x').catch(() => null),
  ])

  if (ethCode === null) {
    checks.push({ id: 'eth-code', label: 'Could not check Ethereum', severity: 'unknown', detail: 'The Ethereum node did not answer, so we cannot tell whether this address is a contract there. Try again before you launch.' })
  } else if (isDelegatedEoa(ethCode)) {
    checks.push({
      id: 'eth-code',
      label: 'A wallet with an upgrade on Ethereum',
      severity: 'ok',
      detail: 'This is an ordinary wallet that has delegated some behaviour on Ethereum. The private key behind it still controls the same address on Robinhood Chain.',
    })
  } else if (ethCode !== '0x') {
    checks.push({
      id: 'eth-code',
      label: 'This is a contract on Ethereum',
      severity: 'stop',
      detail:
        'Smart wallets and Giving Block addresses exist only on the chain they were deployed to. This address is a contract on Ethereum, so the same address on Robinhood Chain belongs to nobody and fees pushed there would be unrecoverable. Ask the charity for an ordinary wallet address instead.',
    })
  } else {
    checks.push({ id: 'eth-code', label: 'An ordinary wallet on Ethereum', severity: 'ok', detail: 'Not a contract, so the same key controls this address on Robinhood Chain too.' })
  }

  if (rhcCode === null) {
    checks.push({ id: 'rhc-code', label: 'Could not check Robinhood Chain', severity: 'unknown', detail: 'The node did not answer. Try again before you launch.' })
  } else if (isDelegatedEoa(rhcCode)) {
    checks.push({ id: 'rhc-code', label: 'A wallet on Robinhood Chain', severity: 'ok', detail: 'Delegated, but still a wallet. It can receive the charity share.' })
  } else if (rhcCode !== '0x') {
    checks.push({
      id: 'rhc-code',
      label: 'This is a contract on Robinhood Chain',
      severity: 'warn',
      detail:
        'A contract can only receive the charity share if it accepts plain transfers. If it does not, every payout reverts and the fees stay stuck in the distributor. Only use this if the charity told you it is theirs on this chain.',
    })
  } else {
    checks.push({ id: 'rhc-code', label: 'Nothing deployed on Robinhood Chain', severity: 'ok', detail: 'It can receive the charity share here.' })
  }

  const passable = !checks.some((c) => c.severity === 'stop')
  return { valid: true, checksummed: addr, checks, passable }
}

/** Groups an address into fours so a human can compare it to a source without losing their place. */
export function chunkAddress(a: string): string[] {
  const body = a.slice(2)
  const out: string[] = ['0x' + body.slice(0, 4)]
  for (let i = 4; i < body.length; i += 4) out.push(body.slice(i, i + 4))
  return out
}
