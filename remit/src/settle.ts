/**
 * Who the money sitting in `CharityPayer` belongs to, and whether it is safe to bridge more.
 *
 * Pure, so the rule can be tested without a chain — the same shape and the same reason as
 * `decide.ts`. This one is narrower and more dangerous: `decide.ts` judges WHEN to send, this
 * judges WHOSE money is on the far side, and getting it wrong donates one charity's fees to a
 * different charity, irreversibly.
 *
 * ## ⛔⛔ THE BUG THIS EXISTS TO PREVENT
 *
 * `CharityPayer.pay(configId, token)` is **all-or-nothing by design**: it donates the contract's
 * ENTIRE balance of `token` to `configId`, with no partial amount, because a partial amount would
 * be a discretion over somebody else's donation. That is the right contract. It puts the whole
 * burden of attribution on the caller.
 *
 * The keeper used to check `balanceOf(payer) > 0` and read that as "my bridge landed". It is not
 * the same question. The payer is ONE account shared by every launch, and the keeper has a
 * documented, normal path that leaves money in it: when a delivery takes longer than the two-minute
 * wait, it logs "anyone can call payer.pay once it lands" and moves on. So:
 *
 *   1. Launch B bridges 100 USDC. Relay is slow, the wait expires, the keeper continues.
 *      B's 100 USDC arrives at the payer a minute later and sits there, undonated.
 *   2. Launch A bridges 50 USDC on the next pass.
 *   3. The balance check sees 100 immediately — B's money, not A's — breaks out of the poll,
 *      and calls `pay(A.charityId)`, which donates **150 USDC to A's charity**.
 *   4. B's ledger already records the 100 as remitted, so B's charity is short for ever and
 *      nothing retries it.
 *
 * ➤ It is the failure mode the keeper's own header forbids in words — *"Each pass moves exactly one
 * launch's owed amount and donates it to exactly that launch's config id"* — reached by checking
 * ONE condition ("is there money here") where TWO govern ("is there money here **and is it mine**").
 *
 * ## ⭐⭐ THE RULE: THE PAYER HOLDS AT MOST ONE LAUNCH'S MONEY AT A TIME
 *
 * Because `pay` cannot split a balance, the only safe invariant is that a balance is never shared.
 * The keeper therefore tracks the single delivery it is waiting on, and refuses to bridge a second
 * launch's money on top of a first launch's. Serialising costs a pass; mixing costs a donation.
 *
 * ## ⛔⛔ AND WHEN IT CANNOT TELL, IT MUST NOT GUESS
 *
 * Money at the payer with no record of whose it is — a lost `receipts.json`, or anyone at all
 * sending USDC to a public address — is **not** an invitation to pick a charity. `pay` is
 * permissionless precisely so a human, or the charity itself, can resolve that case from the
 * vault's `Remitted` events and Relay's request status. A keeper that guesses turns a recoverable
 * situation into an irreversible one.
 */

export type Pending = {
  /** The LAUNCHED token, which is what the remitted ledger is keyed by. */
  token: string
  /** The donate.gg config id this delivery is for. Read from the chain, never from config. */
  charityId: string
  /** What left the vault, in the pair asset's own units, as a decimal string. */
  amount: string
  /** Relay's request id, so a stuck delivery is resolvable by a human without this file. */
  requestId: string
  bridgedAtMs: number
}

export type Ledger = {
  version: 2
  /** launched token (lowercased) -> lifetime remitted, in the pair asset's units. */
  remitted: Record<string, string>
  /** The one delivery in flight, or already landed and not yet donated. */
  pending: Pending | null
  /**
   * launched token (lowercased) -> when this keeper FIRST saw an unremitted balance for it.
   *
   * ⚠ An observation, not a chain fact. What `decide.ts` wants is when the oldest unremitted value
   * landed in the vault, and nothing on chain records that: the distributor's `totalToCharity` is a
   * running sum with no timestamps. First observation is the honest approximation, and it errs the
   * safe way — a keeper that has been down under-reports the age, so it waits rather than forcing a
   * bad-value remit on a clock it cannot actually see.
   */
  heldSince: Record<string, number>
  /**
   * Every settled donation, oldest first. ⚠ Append only: a row here is a transaction that happened,
   * and rewriting history would silently unattribute money a charity has already received.
   */
  donations: Donation[]
}

/**
 * One settled donation, kept so a launch can show its own.
 *
 * ## ⛔⛔ THIS RECORD EXISTS BECAUSE THE CHAIN CANNOT HOLD IT
 *
 * `CharityPayer.Paid` carries a config id and an amount and NO launch token. The bridge credits the
 * payer itself, so on Base the money has genuinely forgotten which coin earned it. The only place
 * the two sides meet is here, between `RemitVault.Remitted(token, amount, requestId)` on Robinhood
 * Chain and the `pay` that followed it — and RHC caps `eth_getLogs` at about three minutes of
 * history, so a browser cannot rebuild even the near side.
 *
 * ⚠ So `payTx` is the important field, not `amount`. A page showing these rows can check every one
 * of them against the `Paid` event in that transaction, which is what the amount and the recipient
 * actually are. What this file supplies is ONLY the attribution: which launch the money came from.
 * Published as a claim that the chain can contradict, rather than as a figure to be taken on trust.
 */
export type Donation = {
  /** The launched token whose fees paid for this. */
  token: string
  charityId: string
  /** USDC delivered, in USDC's own 6dp units, as a decimal string. */
  amount: string
  /** The `pay` transaction on Base. The row's proof, and its identity. */
  payTx: string
  /** Relay's request id for the crossing that funded it. */
  requestId: string
  at: number
}

export const EMPTY_LEDGER: Ledger = { version: 2, remitted: {}, pending: null, heldSince: {}, donations: [] }

/**
 * Read a ledger from whatever is on disk.
 *
 * ⚠ Accepts the ORIGINAL flat `{ "0xtoken": "amount" }` shape and migrates it. There is no such
 * file in production yet, but this is the one piece of state that cannot be rebuilt from chain, so
 * the reader is the last place that should ever throw on it. An unreadable ledger is treated as
 * absent — and an absent ledger with money at the payer is exactly the `blocked` case below, which
 * stops rather than double-sends.
 */
export function parseLedger(raw: unknown): Ledger {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_LEDGER, remitted: {} }
  const o = raw as Record<string, unknown>
  if (o.version === 2) {
    return {
      /*
        ⛔⛔ UNKNOWN FIELDS ARE CARRIED THROUGH, NOT DROPPED.

        This reader used to rebuild a fixed object, so any key it did not know about vanished on the
        next `saveLedger`. That is a silent data loss whenever the code on the box is older than the
        file it is writing — which is exactly what happened when `donations` was added here and the
        keeper was not redeployed: 23 backfilled records were erased by the next pass, with no error
        and nothing in the log.

        ⚠ receipts.json is the ONE piece of state that cannot be rebuilt from a chain. A reader for
        it must lose nothing it does not understand.
      */
      ...(o as Record<string, unknown>),
      version: 2,
      remitted: (o.remitted as Record<string, string>) ?? {},
      pending: (o.pending as Pending | null) ?? null,
      heldSince: (o.heldSince as Record<string, number>) ?? {},
      /* ⚠ Absent on a ledger written before donations were recorded, which is not an error: it
         means no row is attributable yet, not that none happened. */
      donations: (o.donations as Donation[]) ?? [],
    } as Ledger
  }
  /* The v1 shape: every value was a decimal string amount keyed by token. */
  const remitted: Record<string, string> = {}
  for (const [k, v] of Object.entries(o)) {
    if (/^0x[0-9a-fA-F]{40}$/.test(k) && (typeof v === 'string' || typeof v === 'number')) {
      remitted[k.toLowerCase()] = String(v)
    }
  }
  return { version: 2, remitted, pending: null, heldSince: {}, donations: [] }
}

/**
 * Note that a launch has an unremitted balance, and answer how long it has had one.
 *
 * ⛔ The clock survives a CAPPED remit. A launch owed more than one remit's worth is drained over
 * several passes, and the remainder has genuinely been waiting since the original observation —
 * restarting the clock each pass would let a launch that earns faster than the cap sit indefinitely
 * while never appearing old. It is cleared only when the launch owes nothing at all.
 *
 * ⚠ Mutates `l` so the caller writes it with the same `saveLedger` as everything else. Returns the
 * timestamp to judge against.
 */
export function noteHeld(l: Ledger, token: string, owed: bigint, now: number): number {
  const k = token.toLowerCase()
  if (owed === 0n) { delete l.heldSince[k]; return now }
  if (l.heldSince[k] === undefined) l.heldSince[k] = now
  return l.heldSince[k]
}

export const remittedFor = (l: Ledger, token: string): bigint =>
  BigInt(l.remitted[token.toLowerCase()] ?? '0')

export type Delivery =
  /** The payer is empty and nothing is in flight. Safe to bridge. */
  | { action: 'clear' }
  /** A delivery landed and is waiting to be donated. Donate it to THIS id, then bridge again. */
  | { action: 'settle'; pending: Pending; reason: string }
  /** A delivery is in flight but has not landed. Bridging now would mix two launches. */
  | { action: 'awaiting'; pending: Pending; reason: string }
  /** In flight long enough that it cannot still be in flight. Release the record and carry on. */
  | { action: 'stale'; pending: Pending; reason: string }
  /** Money is here and we cannot say whose. Stop, and do not pick a charity. */
  | { action: 'blocked'; balance: bigint; reason: string }

/**
 * What to do about the payer's balance BEFORE bridging anything else into it.
 *
 * ⚠ Called before every bridge, not just the first, because the situation it guards against is
 * created by the pass before it.
 */
export function decideDelivery(payerBalance: bigint, pending: Pending | null, now = Date.now()): Delivery {
  if (pending) {
    if (payerBalance > 0n) {
      return {
        action: 'settle',
        pending,
        reason: `${pending.requestId} landed — donating to ${pending.charityId.slice(0, 10)}… before anything else bridges`,
      }
    }
    /*
      ⛔⛔ A PENDING RECORD MUST NOT BE ABLE TO WEDGE THE KEEPER FOR EVER.

      The payer being empty is ambiguous: the delivery has not landed YET, or it landed, was donated,
      and the record was never cleared. The second happened on the first real run — the donation
      succeeded and the process then died reading its own receipt, leaving `pending` set against an
      empty payer. Left as pure 'awaiting', that record blocks every launch on every later pass, for
      ever, over a transaction that had already worked.

      ➤ Relay settles in seconds. A record older than this with nothing at the payer has either been
      donated already or been refunded to the vault, and both are recoverable states that the next
      pass can see for itself. So it is RELEASED, loudly, rather than waited on indefinitely.
      ⚠ Not shortened casually: it must comfortably exceed a slow bridge, or a real delivery gets
      abandoned and its money donated to whichever launch bridges next.
    */
    const STALE_MS = 30 * 60 * 1000
    if (now - pending.bridgedAtMs > STALE_MS) {
      return {
        action: 'stale',
        pending,
        reason: `${pending.requestId} was bridged ${Math.round((now - pending.bridgedAtMs) / 60000)} minutes ago and the payer is empty, so it has either been donated already or refunded. Releasing the record; check the request id if the charity is short.`,
      }
    }

    return {
      action: 'awaiting',
      pending,
      reason: `waiting on ${pending.requestId} for ${pending.token} — nothing else may bridge until it lands and is donated`,
    }
  }
  if (payerBalance > 0n) {
    return {
      action: 'blocked',
      balance: payerBalance,
      reason:
        `the payer holds ${payerBalance} of USDC that this keeper has no record of. It is NOT lost — ` +
        `\`pay\` is permissionless — but only a human can say which charity it belongs to, by reading ` +
        `the vault's Remitted events and resolving the request ids through Relay. Refusing to guess.`,
    }
  }
  return { action: 'clear' }
}

/**
 * Has our delivery actually arrived?
 *
 * ⛔ A DELTA, never an absolute balance. `balance > 0` answers "is there money here", which is a
 * different question from "did MY bridge land" the moment the account is shared. The pre-bridge
 * balance is normally zero because `decideDelivery` insists on it; comparing anyway costs nothing
 * and means this function is still correct if that ever stops being true.
 */
export const hasArrived = (balanceBefore: bigint, balanceNow: bigint): boolean =>
  balanceNow > balanceBefore

/**
 * The order launches are offered delivery in.
 *
 * ## ⛔⛔ REGISTER ORDER STARVES THE LARGEST LAUNCH
 *
 * The pass walked `page()` order and bridged the first launch it found money on, and a bridge plus
 * its donation is slow: a Relay crossing is waited on for up to two minutes, and every launch ahead
 * pays that cost before the next one is even looked at. So a pass that dies partway — a rate limited
 * RPC, a timeout, a restart — always dies at the same place, and everything past that index never
 * gets reached AT ALL.
 *
 * ➤ That is not hypothetical. $CHARITY sits at index 23 of 34, was owed 3.19 ETH (about $7,700, by
 * far the largest balance on the launchpad), and had NO `heldSince` entry at all while thirteen
 * launches after it did — proof no pass had ever gotten far enough to look at it, while dust
 * balances of $0.79 and $2.52 ahead of it were bridged again and again.
 *
 * ⭐ Ordering by what is owed, largest first, fixes it without touching the one-at-a-time rule:
 * the money most worth moving crosses before anything can go wrong, and a truncated pass now
 * truncates the CHEAPEST work rather than always the same launch.
 *
 * ⚠ It cannot starve the small ones in turn. A remitted launch's owed figure drops to roughly zero
 * on the next pass, because `remitted` grows by what was sent, so the lead changes hands by
 * construction. Age breaks ties so that two launches owed the same amount cannot swap places
 * forever, and the register index breaks that in turn so the order is total and stable.
 */
export function orderForDelivery<T extends { token: string }>(
  launches: T[],
  owed: (l: T) => bigint,
  heldSince: Record<string, number> = {},
): T[] {
  return launches
    .map((l, i) => ({ l, i }))
    .sort((a, b) => {
      const oa = owed(a.l)
      const ob = owed(b.l)
      if (oa !== ob) return ob > oa ? 1 : -1
      /* ⚠ Oldest first, and a launch never seen before sorts LAST among equals rather than first:
         it has no waiting time to credit, and jumping the queue on an unknown is not a tie break. */
      const ha = heldSince[a.l.token.toLowerCase()] ?? Number.MAX_SAFE_INTEGER
      const hb = heldSince[b.l.token.toLowerCase()] ?? Number.MAX_SAFE_INTEGER
      if (ha !== hb) return ha - hb
      return a.i - b.i
    })
    .map((x) => x.l)
}
