import { isAddress, keccak256, toBytes, type Address } from 'viem'

import type { Identity } from './identityApi.ts'

/**
 * What happens to the fees the charity does not take.
 *
 * ## The thing this UI has to get right
 *
 * A creator is choosing something PERMANENT, in a form where everything else is undoable. The pair
 * asset, the charity and this are the three fields a launch can never revisit, so the design job is
 * not to fit the options on screen — it is to make the consequence legible before the signature.
 *
 * ➤ So percentages appear twice: as a share of the remainder, which is what the creator types, and
 * as a share of the WHOLE fee, which is what actually happens. Someone giving 50% to charity and
 * typing 30 into a box is allocating 15% of fees, and 15 is the number they will be held to.
 *
 * ## ⭐ A LIST OF RECIPIENTS, NOT THREE FIXED SLOTS
 *
 * The first version had one row per KIND — one wallet, one account, one burn — which quietly capped
 * a launch at a single payee of each type. The contract never had that limit: `splits` is an array
 * and each entry carries its own mode, so three wallets and two X accounts were always legal. The
 * form was the only thing saying otherwise.
 *
 * ⚠ Burn sits above the list and is a toggle rather than a row, because it is not a recipient: it
 * has no address, no handle and nothing to identify. Putting it in the list would mean a row with
 * an empty middle column and a dropdown that has to exclude itself.
 */

export type RecipientKind = 'wallet' | 'x' | 'github'

export type Recipient = {
  /** ⚠ A stable local key. Index-keyed rows lose focus and swap values when one is removed. */
  id: string
  kind: RecipientKind
  /** An address, or a handle. Display text only for the account kinds — see `resolved`. */
  value: string
  /**
   * ⛔⛔ THE RESOLVED ACCOUNT, AND THE ONLY THING THAT MAY BE WRITTEN ON CHAIN.
   *
   * A beneficiary is `keccak256("<provider>:<numeric id>")`, in a constructor argument that can
   * never change. Both X and GitHub let a username be released and re-registered, so a launch keyed
   * on the TEXT pays whoever holds that name later — for ever, with no way to correct it.
   */
  resolved: Identity | null
  /** Basis points OF THE REMAINDER. */
  bps: number
}

export type RemainderState = {
  burn: { on: boolean; bps: number }
  recipients: Recipient[]
}

export const newId = () => Math.random().toString(36).slice(2, 9)

export const BLANK_REMAINDER: RemainderState = {
  burn: { on: false, bps: 0 },
  recipients: [{ id: newId(), kind: 'wallet', value: '', resolved: null, bps: 10000 }],
}

export const KIND_LABEL: Record<RecipientKind, string> = { wallet: 'Wallet', x: 'X', github: 'GitHub' }

/** ⚠ Only ever the leading `@` and a pasted profile URL. A handle is otherwise character-exact. */
export const normaliseHandle = (h: string) =>
  h.trim()
    .replace(/^@/, '')
    .replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, '')
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/\/.*$/, '')

export function remainderTotalBps(r: RemainderState): number {
  return (r.burn.on ? r.burn.bps : 0) + r.recipients.reduce((n, x) => n + (x.bps || 0), 0)
}

/**
 * ⛔ The same rules the contract enforces, checked here so a creator finds out in the form rather
 * than in a revert. `CreatorRouter` refuses a zero-bps share and a total that is not exactly 10,000;
 * a launch that reaches the chain with either is a wasted launch fee.
 */
export function remainderErrors(r: RemainderState): string | null {
  const legs = (r.burn.on ? 1 : 0) + r.recipients.length
  if (legs === 0) return 'Choose at least one thing to do with the rest'
  if (r.burn.on && !r.burn.bps) return 'Buyback & Burn needs a share above zero'
  if (r.recipients.some((x) => !x.bps)) return 'Every recipient needs a share above zero'

  const total = remainderTotalBps(r)
  if (total !== 10000) {
    const pct = (total / 100).toFixed(total % 100 === 0 ? 0 : 1)
    return `These add up to ${pct}% — they have to make exactly 100%`
  }
  for (const x of r.recipients) {
    if (x.kind === 'wallet' && !isAddress(x.value.trim())) return 'Every wallet needs a valid address'
    /* ⛔ The RESOLVED account, not the text. See `Recipient.resolved`. */
    if (x.kind !== 'wallet' && !x.resolved) return 'Find each account first — the launch records its id, not its name'
  }
  /* ⚠ The same payee twice is two splits paying one destination. The contract accepts it and the
     money still arrives, so nothing breaks — but it is never what somebody means, and it makes the
     token page list one recipient twice. */
  const accounts = r.recipients.filter((x) => x.resolved).map((x) => `${x.resolved!.provider}:${x.resolved!.id}`)
  if (new Set(accounts).size !== accounts.length) return 'That account is already in the list'
  const wallets = r.recipients.filter((x) => x.kind === 'wallet').map((x) => x.value.trim().toLowerCase())
  if (new Set(wallets).size !== wallets.length) return 'That wallet is already in the list'
  return null
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000'

/**
 * The form's shape turned into the contract's.
 *
 * ⛔⛔ Lives here, beside the state it reads, so the two cannot drift. `mode` is 0 wallet /
 * 1 account / 2 burn, matching `CreatorRouter.Mode`, and `provider` is 1 X / 2 GitHub matching
 * `CreatorRouter.PROVIDER_*`. ⚠ The contract recomputes `keccak256("<provider>:<id>")` and refuses
 * a launch whose declared account does not hash to its beneficiary, so this cannot silently name
 * the wrong person.
 */
export function toSplits(r: RemainderState) {
  const burn = r.burn.on
    ? [{
        mode: 2, bps: r.burn.bps, wallet: ZERO_ADDRESS as Address,
        beneficiary: ZERO_BYTES32 as `0x${string}`, provider: 0, accountId: 0n,
      }]
    : []
  const rest = r.recipients.map((x) =>
    x.kind === 'wallet'
      ? {
          mode: 0, bps: x.bps, wallet: x.value.trim() as Address,
          beneficiary: ZERO_BYTES32 as `0x${string}`, provider: 0, accountId: 0n,
        }
      : {
          mode: 1, bps: x.bps, wallet: ZERO_ADDRESS as Address,
          beneficiary: keccak256(toBytes(`${x.resolved!.provider}:${x.resolved!.id}`)),
          provider: x.kind === 'x' ? 1 : 2,
          accountId: BigInt(x.resolved!.id),
        },
  )
  return [...burn, ...rest]
}

/**
 * The same allocation, for DISPLAY, tolerating a row that is not finished yet.
 *
 * ⛔⛔ SEPARATE FROM {@link toSplits} ON PURPOSE, AND THE SEPARATION IS THE POINT.
 *
 * `toSplits` asserts `resolved` is present, which is true at SUBMISSION because `remainderErrors`
 * has refused everything else. The signing panel renders on every keystroke, including the moment
 * between typing a handle and the lookup returning — so calling `toSplits` there dereferenced null
 * inside a `.map`, threw during render, and took the WHOLE PAGE BLANK. Not the panel: the page.
 *
 * ➤ So the strict one stays strict, and this one never assumes.
 */
export function summaryRows(r: RemainderState, charityBps: number) {
  const remainderPct = (10000 - charityBps) / 100
  const pctOfAll = (bps: number) => {
    const n = (bps / 10000) * remainderPct
    return n % 1 === 0 ? n : Number(n.toFixed(1))
  }
  const rows: { key: string; label: string; pct: number }[] = []
  if (r.burn.on) rows.push({ key: 'burn', label: 'Bought back & burned', pct: pctOfAll(r.burn.bps) })
  for (const x of r.recipients) {
    const label = x.kind === 'wallet'
      ? `To ${x.value.trim() ? `${x.value.trim().slice(0, 6)}…${x.value.trim().slice(-4)}` : 'a wallet'}`
      : `To @${x.resolved?.handle ?? (normaliseHandle(x.value) || '…')}`
    rows.push({ key: x.id, label, pct: pctOfAll(x.bps) })
  }
  return rows
}

/**
 * ⭐ Whether this launch needs a router at all.
 *
 * One wallet and nothing else is the plain launch: the launchpad deploys no router, so nobody pays
 * gas for a splitter that splits one way.
 */
export function needsRouter(r: RemainderState): boolean {
  return r.burn.on || r.recipients.length > 1 || r.recipients.some((x) => x.kind !== 'wallet')
}

/**
 * The wallet a plain launch pays, for the path that takes a single address.
 *
 * ⛔⛔ ONLY A WALLET ROW, NEVER JUST THE FIRST ROW.
 *
 * This used to return `recipients[0].value` whatever kind that row was, so a launch giving its whole
 * remainder to an X account handed the HANDLE to `creatorPayout` — the launch form then tried to
 * encode `"MEADGod"` as an address and viem refused, which surfaced as "Could not complete that
 * launch" with no further explanation. Nothing reached the chain and nothing was signed, but nothing
 * said why either, and the form had already passed its own validation because a handle is a
 * perfectly good handle.
 *
 * ⚠ Empty is a correct answer, not a failure: a launch with no wallet leg has no single payout, and
 * the caller falls back to a zero address. That is safe because `CharityLaunchpadV2` OVERWRITES the
 * payout with the router whenever splits are present — see its `launch`, where `payout = router`.
 */
export function soleWallet(r: RemainderState): string {
  const w = r.recipients.find((x) => x.kind === 'wallet')
  return w ? w.value.trim() : ''
}

/** Every leg of a remainder in the order it is drawn — burn first, because burn is drawn first. */
const legKeysOf = (r: RemainderState) =>
  [...(r.burn.on ? ['burn'] : []), ...r.recipients.map((x) => x.id)]

/** ⛔ The contract refuses a zero-bps share, so every OTHER leg has to keep at least one point. */
export const maxSharePct = (r: RemainderState) => 100 - (legKeysOf(r).length - 1)

/**
 * ⛔⛔ THE SHARES ALWAYS MAKE EXACTLY 100. TYPING CANNOT BREAK THAT.
 *
 * They used to be independent boxes with a running total underneath that went red when they did not
 * agree — so a form with burn at 100 and a wallet at 50 was a reachable state, reading "150% of 14%
 * — needs to be 100%". That is a puzzle handed to somebody who was not trying to make one: the
 * numbers are all individually plausible, and nothing says which of them to move.
 *
 * ➤ So an impossible value cannot be typed at all. Raising one leg lowers the others in proportion,
 * the sum is 100 at every keystroke, and there is consequently no total left to display.
 *
 * ⚠ Whole percent throughout. Basis points here would show three legs as 33/33/33 under a total
 * insisting on 100 — three numbers that visibly do not add up. @see rebalance
 *
 * ⭐ Pure, and exported, because `CreatorRouter` reverts on a total that is not exactly 10,000: the
 * invariant is worth a test rather than a reading of the JSX.
 */
export function withShare(r: RemainderState, key: string, typed: number): RemainderState {
  const legKeys = legKeysOf(r)
  if (legKeys.length <= 1) return r
  const p = Math.max(1, Math.min(maxSharePct(r), Math.round(typed) || 1))
  const others = legKeys.filter((k) => k !== key)
  const bpsOfKey = (k: string) => (k === 'burn' ? r.burn.bps : r.recipients.find((x) => x.id === k)!.bps)
  const cur = others.map((k) => bpsOfKey(k) / 100)
  const sum = cur.reduce((a, b) => a + b, 0)
  const rest = 100 - p
  const alloc = others.map((_, i) =>
    Math.max(1, Math.round(sum > 0 ? (cur[i]! / sum) * rest : rest / others.length)))

  /* ⚠ Rounding leaves the total a point or two out. Corrected round-robin rather than dumped on one
     leg, so nudging the same box repeatedly does not quietly drain one neighbour down to 1.
     ⭐ It always terminates: `p <= maxSharePct` guarantees `rest >= others.length`, so there is
     always room to give every other leg its minimum point. */
  let drift = rest - alloc.reduce((a, b) => a + b, 0)
  for (let i = 0; drift !== 0 && i < 1000; i++) {
    const j = i % alloc.length
    if (drift > 0) { alloc[j]!++; drift-- }
    else if (alloc[j]! > 1) { alloc[j]!--; drift++ }
  }

  const next = (k: string) => (k === key ? p : alloc[others.indexOf(k)]!) * 100
  return {
    burn: r.burn.on ? { on: true, bps: next('burn') } : r.burn,
    recipients: r.recipients.map((x) => ({ ...x, bps: next(x.id) })),
  }
}

