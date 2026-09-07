import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type Address } from 'viem'
import { useWallet } from '../lib/wallet.tsx'
import { publicClient, txUrl } from '../lib/chain.ts'
import { DISTRIBUTOR_ABI, NATIVE_ADDRESS, fmtAmount, type Launch } from '../lib/launchpad.ts'
import { claimableFor, totalsByAsset, type Claimable } from '../lib/claimable.ts'
import { readUnswept, isOperatorOnly, NOTHING_UNSWEPT, type Unswept } from '../lib/unswept.ts'
import { LAUNCH, MY_TOKENS, tokenHref } from '../lib/router.ts'
import { Link } from './Link.tsx'
import { TokenImage } from './TokenImage.tsx'

/**
 * Collecting the launcher's side of a launch's fees.
 *
 * ## ⛔⛔ NOTHING IS CLAIMED HERE, IT IS CRANKED
 *
 * `CharityDistributor.harvest()` pulls from Pons's escrow and immediately releases: the charity's
 * share goes to the vault and the launcher's share to `opsVault`, both pushed, in the same call. It
 * is **permissionless**, so this button pays out identically whether the launcher, the charity or a
 * stranger presses it, and it pays the charity whether or not the launcher has a share.
 *
 * ➤ So the copy never says "claim to your wallet". It says where the money goes, which is an
 * address fixed at launch that may not be the one connected. Calling it a claim on a balance would
 * be wrong in both directions: it is not a balance, and it is not necessarily yours.
 *
 * ## ⛔⛔ THE ESCROW IS THE SECOND HOP, AND THIS PAGE ONLY READ THE SECOND HOP
 *
 * Fees accrue on the launch's curve, or in the meme hook once it graduates. A **sweep** moves them
 * into Pons's escrow; only then can `harvest` claim and release them. `pending()` reads the escrow,
 * so between a trade and a sweep it returns zero — and this page rendered that zero as
 * "In the escrow 0 ETH" with a dead "Nothing to collect" button.
 *
 * 🔴🔴 $CHARITY, this launchpad's largest earner, **graduated**. From then on its fees accrued in
 * the hook, its dead curve made `sweepCurve` revert, and nothing here or in the keeper ever called
 * `sweepPool` — so the page truthfully reported an empty escrow, forever, on a token earning real
 * money, and pressing the button did nothing and explained nothing.
 *
 * ➤ Fixed in three places, and all three were needed: the page now READS where the fees actually
 * are ({@link readUnswept}), the button SWEEPS before it harvests, and when only Pons's operator
 * may run the sweep it says so instead of showing a figure of zero. A number we cannot act on is
 * still worth showing; "nothing to collect" when there is something is not.
 *
 * ## ⛔ A 100% CHARITY LAUNCH HAS NO LAUNCHER SIDE
 *
 * The launch form defaults to 100%, so this is the normal case rather than an edge one. Such a
 * launch is still shown, still cranked, and reported honestly as paying its charity: showing a
 * launcher a claimable zero would read as a bug in the page rather than as the split they chose.
 */
export function ClaimFees({ launches, loading, onDone }: {
  launches: Launch[]; loading: boolean; onDone: () => void
}) {
  const { address, onRightChain, walletClient, switchChain } = useWallet()
  const [pendingBy, setPendingBy] = useState<Map<string, bigint>>(new Map())
  const [payoutBy, setPayoutBy] = useState<Map<string, Address>>(new Map())
  const [unsweptBy, setUnsweptBy] = useState<Map<string, Unswept>>(new Map())
  /* ⭐ `opsVault` is `immutable` on the distributor, so it is read once per token and kept. The
     busiest launcher here has 71 launches and `refreshPending` runs again after every crank, so
     re-reading a value that cannot change would double this page's calls for nothing. */
  const payoutCache = useRef<Map<string, Address>>(new Map())
  const [reading, setReading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState<{ token: string; hash: string; swept: boolean } | null>(null)

  const mine = useMemo(
    () => claimableFor(launches, address, pendingBy, payoutBy, unsweptBy),
    [launches, address, pendingBy, payoutBy, unsweptBy],
  )

  /* ⚠ `pending` is read fresh rather than taken from the register's snapshot. The register is
     fetched once when the app mounts; a launcher arriving here to collect wants the number as it is
     now, and it changes on every trade. */
  const refreshPending = useCallback(async (rows: Launch[]) => {
    if (rows.length === 0) return
    setReading(true)
    try {
      /* ⛔⛔ `opsVault` is read here rather than taken from `launch.creator`. The launchpad records
         the creator as `msg.sender` but constructs the distributor with `creatorPayout`, a separate
         argument the launch form lets the launcher change, so the two differ on launches that exist
         right now. Substituting the creator names an address the money does not go to. */
      const entries = await Promise.all(rows.map(async (l) => {
        const key = l.token.toLowerCase()
        const [p, ops, un] = await Promise.all([
          publicClient
            .readContract({ address: l.distributor, abi: DISTRIBUTOR_ABI, functionName: 'pending', args: [l.pairToken] })
            .catch(() => 0n),
          payoutCache.current.get(key) ??
            publicClient
              .readContract({ address: l.distributor, abi: DISTRIBUTOR_ABI, functionName: 'opsVault' })
              .catch(() => null),
          /* ⛔⛔ The read this page was missing entirely. Without it a graduated launch reports an
             empty escrow as "nothing earned", which is a different claim and a false one. */
          readUnswept(l).catch(() => NOTHING_UNSWEPT),
        ])
        /* ⚠ A read that failed is NOT cached and NOT recorded, so it renders as unknown and is
           retried next refresh. Defaulting to the creator would put the original bug back. */
        if (ops) payoutCache.current.set(key, ops as Address)
        return [key, p, un] as const
      }))
      setPendingBy(new Map(entries.map(([k, p]) => [k, p])))
      setUnsweptBy(new Map(entries.map(([k, , u]) => [k, u])))
      setPayoutBy(new Map(payoutCache.current))
    } finally { setReading(false) }
  }, [])

  useEffect(() => {
    const rows = launches.filter((l) => address && l.creator.toLowerCase() === address.toLowerCase())
    void refreshPending(rows)
  }, [launches, address, refreshPending])

  const totals = useMemo(() => totalsByAsset(mine), [mine])

  const crank = async (row: Claimable) => {
    if (!walletClient || !address) return
    setErr(null); setDone(null); setBusy(row.launch.token)
    try {
      const isNative = row.launch.pairToken.toLowerCase() === NATIVE_ADDRESS.toLowerCase()
      const common = { address: row.launch.distributor, abi: DISTRIBUTOR_ABI, account: address } as const

      /* ── 1. sweep, so the escrow has something to claim ──────────────────────────────────
         ⛔⛔ THIS STEP WAS MISSING AND IT IS THE ONE THAT MOVES THE MONEY. `harvest` claims the
         escrow; the escrow is filled by a sweep off the curve or out of the hook. On a graduated
         launch the harvest alone succeeds and moves exactly nothing, which is worse than failing:
         it costs gas and reports success.

         ⛔ Which sweep depends on the phase, and a launch is in exactly one. `sweepCurve` reverts
         once the curve is dead and `sweepPool` reverts before the pool exists, so the phase is read
         rather than both being tried. ⚠ Simulated first: a revert still costs gas. */
      let swept = false
      if (row.unswept.weMaySweep) {
        /* ⚠ Written out per branch rather than built as one object and spread. The two have
           different argument tuples, viem cannot narrow the union across a ternary, and the only
           way to make that compile is a cast — the same cast that once hid `harvest` and
           `harvestToken` being absent from this ABI altogether. */
        /* ⚠⚠ The `catch` covers the SIMULATION only, and the send is deliberately outside it. A
           sweep that simulates but is then rejected in the wallet must stop the whole crank, not
           fall through to a harvest of an escrow the sweep was going to fill — which would spend a
           second signature to move nothing and report success. Each branch yields a sender so the
           two argument tuples never meet in one union. */
        const send = row.unswept.where === 'pool' && row.unswept.pool
          ? await publicClient
              .simulateContract({
                ...common, functionName: 'sweepPool',
                args: [row.unswept.pool.hook, row.unswept.pool.poolId, 0n, 0n],
              })
              .then((s) => () => walletClient.writeContract(s.request))
              .catch(() => null)
          : row.unswept.where === 'curve' && row.unswept.curve
            ? await publicClient
                .simulateContract({ ...common, functionName: 'sweepCurve', args: [row.unswept.curve, 0n] })
                .then((s) => () => walletClient.writeContract(s.request))
                .catch(() => null)
            : null
        if (send) {
          await publicClient.waitForTransactionReceipt({ hash: await send() })
          swept = true
        }
      }

      /* ── 2. harvest, which claims and releases in one call ───────────────────────────────
         ⚠⚠ SIMULATED FIRST. Both calls revert when there is nothing to move, which is the normal
         state for a launch nobody has traded, and a reverted transaction still costs gas.
         ⚠⚠ `harvest` for a native launch, `harvestToken` for every other. Pons keeps two escrow
         ledgers and a launch lands in exactly one, so the wrong call SUCCEEDS and moves nothing.

         ⚠ Simulated and written inside each branch rather than picking a request with a ternary:
         the two have different argument types and viem cannot narrow the union, which is what the
         `as never` casts here were hiding. Those casts were also hiding that neither function was
         in the ABI at all. */
      const hash = isNative
        ? await walletClient.writeContract(
            (await publicClient.simulateContract({ ...common, functionName: 'harvest' })).request,
          )
        : await walletClient.writeContract(
            (await publicClient.simulateContract({
              ...common, functionName: 'harvestToken', args: [row.launch.pairToken as Address],
            })).request,
          )
      await publicClient.waitForTransactionReceipt({ hash })
      setDone({ token: row.launch.symbol, hash, swept })
      await refreshPending(mine.map((m) => m.launch))
      onDone()
    } catch (e) {
      const m = (e as Error)?.message ?? 'The transaction failed'
      /* ⚠ A user closing their wallet is not an error worth a red banner. */
      if (/User rejected|denied/i.test(m)) { setErr(null) }
      /* ⛔ Classified on the revert SELECTOR. viem renders an unknown custom error as bare hex, so
         `InternalSwapRequiresOperator` arrives as `0x31cdb504` with no name and a message match
         would show a launcher raw calldata for a situation with a plain explanation. */
      else if (isOperatorOnly(e)) {
        setErr('Only Pons’s sweep operator can move these fees right now, because part of them accrued in the token and has to be converted first. Nothing is lost; they are credited when that sweep runs.')
      } else { setErr(m.split('\n')[0]!) }
    } finally { setBusy(null) }
  }

  /**
   * What the button says, and whether it does anything.
   *
   * ⛔ Four states, not two. "Nothing to collect" is reserved for a launch that has genuinely
   * earned nothing anywhere — it used to also cover a launch with real fees we could not reach,
   * which is the bug this page was reported for.
   */
  const buttonFor = (row: Claimable): { label: string; disabled: boolean } => {
    if (busy === row.launch.token) return { label: 'Collecting', disabled: true }
    if (busy !== null || !onRightChain) {
      return { label: row.collectable > 0n ? 'Collect' : 'Nothing to collect', disabled: true }
    }
    if (row.collectable === 0n) return { label: 'Nothing to collect', disabled: true }

    /*
      ⛔⛔ "PAID AUTOMATICALLY" AND "WAITING ON PONS" ARE NOT THE SAME STATE, AND THIS CONFLATED THEM.

      `weMaySweep` is false in TWO cases, because `NOTHING_UNSWEPT` sets it false too:

        1. there is nothing unswept at all — the keeper harvested it and it is genuinely on its way;
        2. there IS unswept value and only Pons's operator can convert it, because the fees accrued
           in the memecoin (`INTERNAL_SWAP_REQUIRES_OPERATOR`).

      Both landed on "Paid automatically", so a launcher with 0.0614 ETH earned and unpaid on a
      GRADUATED launch — the normal state for the biggest earners here — was told their money had
      already been sent. It had not. It was waiting on somebody else's keeper, which is exactly the
      thing that label was chosen to avoid implying, applied to the one case where it is true.

      ⚠ It is NOT stranded: Pons's operator sweeps, and the harvest credits it afterwards. So the
      copy has to say "waiting", not "lost", and stay disabled either way — the launcher genuinely
      cannot act on it.
    */
    const blockedOnPons = row.pending === 0n
      && !row.unswept.weMaySweep
      && (row.unswept.memePending > 0n || row.unswept.creatorShare > 0n)
    if (blockedOnPons) return { label: 'Waiting on Pons’s sweep', disabled: true }

    if (row.pending === 0n && !row.unswept.weMaySweep) {
      return { label: 'Paid automatically', disabled: true }
    }
    /* ⚠ One label for both paths. The button still sweeps before it harvests when there is
       something unswept to sweep — that is `collect`'s job here, not a second thing the launcher
       has to understand. Splitting the wording only ever described OUR mechanism back at them. */
    return { label: 'Collect', disabled: false }
  }

  return (
    <section className="page">
      <div className="wrap">
        <div className="chead">
          <p className="eyebrow" style={{ justifyContent: 'center' }}>Claim fees</p>
          <h1 className="chead__h">Claim your fees</h1>
        </div>

        {!address ? (
          <div className="empty">Connect a wallet to collect fees from the tokens it launched.</div>
        ) : mine.length === 0 ? (
          <div className="empty">
            This wallet has not launched anything yet.
            <div style={{ marginTop: 18 }}><Link className="btn btn--ink btn--lg" to={LAUNCH}>Launch a token</Link></div>
          </div>
        ) : (
          <>
            {totals.length > 0 && (
              <div className="claimbar">
                {totals.map((t) => (
                  <div className="claimbar__fig" key={t.symbol}>
                    <span className="claimbar__k">Your share</span>
                    <span className="claimbar__v">{fmtAmount(t.yours, t.decimals, 4)} {t.symbol}</span>
                  </div>
                ))}
              </div>
            )}

            {!onRightChain && (
              <div className="banner" style={{ marginBottom: 16 }}>
                <strong>This wallet is on another network.</strong>{' '}
                <button className="btn btn--sm" onClick={() => void switchChain()}>Switch to Robinhood Chain</button>
              </div>
            )}

            {err && <div className="banner" style={{ marginBottom: 16 }}><strong>{err}</strong></div>}
            {done && (
              <div className="banner" style={{ marginBottom: 16 }}>
                <strong>${done.token} {done.swept ? 'swept and collected' : 'collected'}.</strong>{' '}
                <a href={txUrl(done.hash)} target="_blank" rel="noreferrer noopener">View the transaction</a>
              </div>
            )}

            <div className="claims__list">
              {mine.map((row) => {
                const btn = buttonFor(row)
                return (
                <div className="claimrow" key={row.launch.token}>
                  <Link className="claimrow__tok" to={tokenHref(row.launch.token)}>
                    <TokenImage uri={row.launch.logo} symbol={row.launch.symbol} className="lrow__art" />
                    <span style={{ minWidth: 0 }}>
                      {/* ⚠ Ticker first, as on the launch cards, so a token is identified the same
                          way wherever it appears. */}
                      <span className="lrow__sym" style={{ display: 'block' }}>${row.launch.symbol}</span>
                      <span className="lrow__name">{row.launch.name}</span>
                    </span>
                  </Link>

                  <div className="claimrow__fig">
                    {/* ⛔ "Earned, not yet paid out" rather than "In the escrow". The escrow is one
                        of two places the money sits and naming only it was how a launch with fees
                        in the hook came to be described as having none. */}
                    <span className="claimrow__k">Earned, unpaid</span>
                    <span className="claimrow__v">
                      {reading ? '...' : `${fmtAmount(row.collectable, row.launch.pairDecimals, 4)} ${row.launch.pairSymbol}`}
                    </span>
                  </div>

                  <div className="claimrow__fig">
                    <span className="claimrow__k">{row.allToCharity ? 'Goes to' : 'Your share'}</span>
                    <span className="claimrow__v">
                      {row.allToCharity
                        ? 'The charity, all of it'
                        : `${fmtAmount(row.yours, row.launch.pairDecimals, 4)} ${row.launch.pairSymbol}`}
                    </span>
                  </div>

                  <button className="btn btn--sm" disabled={btn.disabled} onClick={() => void crank(row)}>
                    {btn.label}
                  </button>

                  {/* ⛔ NO EXPLANATORY NOTE IN THE ROW. It said the right things and still made
                      the row worse: three lines of mechanism under a launch whose one-word button
                      already answers the question. `Paid automatically` carries it. The detail
                      lives in `unswept.ts`, where a reader who wants the mechanism will look. */}
                </div>
                )
              })}
            </div>

            <div style={{ marginTop: 20, textAlign: 'center' }}>
              <Link className="btn btn--sm" to={MY_TOKENS}>Back to my tokens</Link>
            </div>
          </>
        )}
      </div>
    </section>
  )
}
