import { useEffect, useState } from 'react'
import { formatUnits, type Address } from 'viem'
import { addrUrl, short, tokenUrl } from '../lib/chain.ts'
import { accountById } from '../lib/identityApi.ts'
import { AccountShare } from './AccountShare.tsx'
import { readToken, type TokenView } from '../lib/token.ts'
import { formatUsd } from '../lib/marketCap.ts'
import { BurnPanel } from './BurnPanel.tsx'
import { TokenDonations } from './Donations.tsx'
import { TokenBurns } from './Burns.tsx'
/* ⚠ The burner is $CHARITY's own contract, so the burn register belongs to that token alone.
   Read from the same constant the rest of the site uses rather than typed again here. */
import { TOKEN_CA as CHARITY_TOKEN } from '../lib/brand.ts'
import { BURN_SHARE_PCT, CREATOR_SHARE_PCT, readBurnTotals, BURNER } from '../lib/burns.ts'
import { charityByConfig, charityPage, loadCharities, type Charity } from '../lib/charities.ts'
import { TokenImage } from './TokenImage.tsx'
import { SplitBar } from './SplitBar.tsx'
import { Link } from './Link.tsx'
import { EXPLORE } from '../lib/router.ts'

const fmt = (v: bigint, d: number, max = 4) => {
  const n = Number(formatUnits(v, d))
  if (n === 0) return '0'
  if (n < 0.0001) return '<0.0001'
  return n.toLocaleString('en-US', { maximumFractionDigits: max })
}

export function TokenPage({ address }: { address: Address }) {
  const [t, setT] = useState<TokenView | null>(null)
  /* ⚠ null means "not read yet or could not read", which is NOT the same as zero. Zero is a real
     answer meaning nothing has been burned, and showing it for a failed read would state a
     falsehood with total confidence. @see readBurnTotals */
  const [burnTotals, setBurnTotals] = useState<{ spent: bigint; burned: bigint } | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading')
  /* ⭐ The whole promise is "this token pays X", so the page has to be able to say X. The chain
     records an id; the directory turns it into a name and a link to where it is published. */
  const [charity, setCharity] = useState<Charity | null>(null)
  /* ⚠ The handle for the split bar's own label. `AccountShare` resolves this again for the row in
     the fee table; two reads of a cached directory entry is the cheaper mistake than threading a
     name up through a component that exists to render one row. */
  const [soleHandle, setSoleHandle] = useState<string | null>(null)

  /*
    ⭐⭐ WHAT THE OTHER HALF OF THE BAR ACTUALLY IS.

    "20% creator" is only true of a launch that pays a creator. This one pays @MEADGod, and a bar
    saying "creator" above a fee table saying "@MEADGod 20%" makes a reader stop and work out
    whether those are the same twenty percent. The chain knows, so the bar should say.

    ⚠ Falls back to the shape rather than to a name: several legs are "split", and an account whose
    handle has not resolved yet is "an X account". The percentage is the fact and it is never
    waiting on a lookup.
  */
  const splits = t?.splits ?? []
  const sole = splits.length === 1 ? splits[0]! : null

  useEffect(() => {
    setSoleHandle(null)
    if (!sole || sole.mode !== 1) return
    const provider = sole.provider === 1 ? 'x' : sole.provider === 2 ? 'github' : null
    if (!provider || sole.accountId === 0n) return
    let live = true
    void accountById(provider, sole.accountId.toString()).then((u) => { if (live && u) setSoleHandle(u.handle) })
    return () => { live = false }
  }, [sole?.mode, sole?.provider, sole?.accountId])

  const remainderLabel =
    splits.length === 0 ? 'creator'
      : splits.length > 1 ? 'split'
        : sole!.mode === 2 ? 'burned'
          : sole!.mode === 0 ? 'a wallet'
            : soleHandle ? `@${soleHandle}`
              : sole!.provider === 2 ? 'a GitHub account' : 'an X account'

  useEffect(() => {
    let live = true
    setState('loading')
    void (async () => {
      const v = await readToken(address).catch(() => null)
      if (!live) return
      setT(v)
      setState(v ? 'ready' : 'missing')
      if (v?.charityId && !/^0x0+$/.test(v.charityId)) {
        void loadCharities()
          .then((cs) => { if (live) setCharity(charityByConfig(cs, v.charityId) ?? null) })
          .catch(() => {})
      }
    })()
    return () => { live = false }
  }, [address])

  /*
    ⛔⛔ DEFINED AND USED ABOVE THE EARLY RETURNS, BECAUSE HOOKS CANNOT BE CONDITIONAL.

    The first draft put this effect below the `state === 'loading'` bail-out. That runs two hooks
    while the token is loading and three once it arrives, which is React's "Rendered more hooks
    than during the previous render" crash — and it would have fired on the very first visit to
    every token page, not on some edge case. `t` is optional here for exactly that reason.
  */
  const isCharityToken = !!t && t.address.toLowerCase() === CHARITY_TOKEN.toLowerCase()

  /* ⚠ Reads the burner's OWN counters rather than summing the log register beside it: a walk that
     loses a page understates the total silently, and this is a headline figure. @see readBurnTotals */
  useEffect(() => {
    if (!isCharityToken) return
    let live = true
    /* ⚠ Block-bodied: React 19 renders a blank page for a concise arrow that returns a promise. */
    void (async () => {
      const totals = await readBurnTotals()
      if (live) setBurnTotals(totals)
    })()
    return () => { live = false }
  }, [isCharityToken])

  if (state === 'loading') {
    return <section><div className="wrap"><div className="empty">Reading the chain</div></div></section>
  }

  /* ⛔ A token this launchpad did not create has no charity and no split. Rendering it with zeroes
     would present a charity of 0x000 as a fact about somebody's token. */
  if (state === 'missing' || !t) {
    return (
      <section>
        <div className="wrap">
          <div className="head head--center">
            <p className="eyebrow">Not found</p>
            <h2>No charity launch at this address</h2>
            <p>
              This page only shows tokens launched through Pons Charity, because only those have a
              charity and a split recorded on chain.
            </p>
          </div>
          <Link className="btn" to={EXPLORE}>Back to the dashboard</Link>
        </div>
      </section>
    )
  }

  /*
    ⛔⛔ THE CHARITY'S SHARE OF THIS TOKEN'S FEES — NOT OF TRADING VOLUME.

    This used to fold in Pons's protocol cut and the creator tax, producing "0.850%" on a launch
    that splits its fees fifty-fifty. That figure was not wrong so much as answering a question
    nobody asked: it was the fraction of every dollar TRADED that reaches the charity, printed
    under a label everyone reads as "how much of the fees go to the charity". Beside a "Charity
    share 50%" row two inches below, it just looked broken.

    ➤ So it is the split this launch actually chose, which is the one number the launcher set and
    the one a visitor is checking. Pons's own cut is Pons's to describe.
  */
  const toCharity = t.charityBps / 100

  /* ⛔ $CHARITY alone. Its creator half is cut again by our keeper into a buy-back and a remainder,
     and the burn register below is that one token's contract. Everything gated on this would be
     false on any other launch. */
  return (
    <>
      <section className="tok">
        <div className="wrap">
          <Link className="tok__back" to={EXPLORE}>Back to the dashboard</Link>

          <div className="tok__head">
            <TokenImage uri={t.logo} symbol={t.symbol} className="tok__art" />
            <div style={{ minWidth: 0 }}>
              {/* ⚠ Ticker above the name, as on the launch cards and the claim row, so a token is
                  identified the same way wherever it appears. ⛔ The NAME stays the h1: the heading
                  level follows what the page is about, not what is printed first. */}
              <div className="tok__sym mono">${t.symbol}</div>
              <h1 className="tok__name">{t.name}</h1>
            </div>
            <div className="tok__badges">
              {charity && <span className="tag tag--live">Pays {charity.name}</span>}
              <span className="tag">{t.graduated ? 'Trading on the pool' : 'On the curve'}</span>
              <span className="tag">Priced in {t.pairSymbol}</span>
            </div>
          </div>

          {t.description && <p className="tok__desc">{t.description}</p>}

          <div className="tok__split">
            {/* ⭐⭐ On $CHARITY the bar states all three parts. "50% creator" is true of the chain
                and false of where the money goes: most of that half buys the token back and burns
                it. ⛔ Gated — every other launch's remainder really is undivided, and the parts
                come from the same constants the fee table uses so the two can never disagree. */}
            {isCharityToken ? (
              <SplitBar
                bps={t.charityBps}
                parts={[
                  { pct: t.charityBps / 100, label: 'charity', tone: 'charity' },
                  { pct: BURN_SHARE_PCT, label: 'burned', tone: 'burn' },
                  { pct: CREATOR_SHARE_PCT, label: 'creator', tone: 'creator' },
                ]}
              />
            ) : (
              <SplitBar bps={t.charityBps} creatorLabel={remainderLabel} />
            )}
          </div>

          {/*
            ⛔⛔ "DONATED TO THE CHARITY" WAS THE WRONG WORD FOR THE COLLECTED FIGURE.

            `totalToCharity` is what the distributor has PUSHED toward the charity — as far as the
            RemitVault, on this chain, in the pair asset. It has not reached anybody yet: it still
            has to be bridged and donated. What a charity has actually RECEIVED is USDC on Base, and
            it is listed with its transactions under `Donations` further down this page.

            ⚠ Three tiles, not four. "In escrow" was removed: it read 0 almost always — the keeper
            harvests every fifteen minutes, so a non-zero value is a few seconds of a fifteen-minute
            cycle — and a permanently-zero headline figure teaches a reader that the row is noise.
            The escrow is still read and still acted on; it just is not a headline.
          */}
          <div className="figs figs--3">
            <div className="fig">
              <div className="fig__k">Market cap</div>
              {/* ⛔ USD, like every other cap on the site. This read "18,420 ETH" while the
                  dashboards showed dollars for the same launch. */}
              <div className="fig__v">{formatUsd(t.marketCapUsd) ?? '—'}</div>
            </div>
            <div className="fig">
              <div className="fig__k">Charity Cut</div>
              <div className="fig__v">
                {toCharity % 1 === 0 ? toCharity : Number(toCharity.toFixed(2))}<small>%</small>
              </div>
            </div>
            {/* ⭐ Last, and it is the one that differs by token: on $CHARITY it is what the fees
                actually did — bought the supply back and destroyed it, in ETH spent, read off the
                burner's own counter. Everywhere else it is what has been collected for the charity.
                ⚠ An em dash while the read is pending or failed: a zero here would claim nothing
                has been burned, which is a different statement from "we could not ask". */}
            <div className="fig">
              <div className="fig__k">{isCharityToken ? 'Burned' : 'Collected for the charity'}</div>
              {isCharityToken ? (
                <div className="fig__v">
                  {burnTotals ? fmt(burnTotals.spent, 18, 4) : '—'} <small>ETH</small>
                </div>
              ) : (
                <div className="fig__v">{fmt(t.paidToCharity, t.pairDecimals, 2)} <small>{t.pairSymbol}</small></div>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="section--alt">
        <div className="wrap">
          <div className="tok__cols">
            <div>
              <p className="eyebrow" style={{ justifyContent: 'center' }}>Fee Distribution</p>
              <div className="ledger" style={{ borderTop: '1px solid var(--ink)' }}>
                {/* ⚠ The name when we can resolve it, the raw id when we cannot. An unresolvable id
                    is shown as an id rather than hidden: it is still the promise, and a reader can
                    look it up themselves. */}
                <Row k="Charity" v={
                  charity
                    ? <a href={charityPage(charity)} target="_blank" rel="noreferrer">{charity.name}</a>
                    : /^0x0+$/.test(t.charityId)
                      ? <a className="mono" href={addrUrl(t.charity)} target="_blank" rel="noreferrer">{short(t.charity, 6)}</a>
                      : <span className="mono">{short(t.charityId, 8)}</span>
                } />
                <Row k="Charity share" v={`${t.charityBps / 100}%`} />

                {/*
                  ⭐⭐ THE CREATOR'S HALF, BROKEN DOWN WHEN THE LAUNCH BROKE IT DOWN.

                  A launch can route that half to a wallet, to an X or GitHub account, to a
                  buy-and-burn, or any mix — fixed at launch and unchangeable. One line saying
                  "Creator share 50%" is true and useless on such a launch: it hides the very thing
                  that makes it different from every other one.

                  ⚠ Every figure is a share of the WHOLE fee, not of the remainder. `bps` on chain
                  is of the remainder, so it is multiplied out here — a creator who typed 30 into
                  the burn box on a 50% charity split is burning 15%, and 15 is the number a reader
                  of this page is asking about.
                */}
                {isCharityToken ? (
                  /*
                    ⭐⭐ $CHARITY'S OWN SPLIT, NAMED. Its creator half is cut again off chain: most
                    of it buys the token back and burns it, the rest is kept. That second cut is a
                    keeper policy rather than anything a contract knows — `opsVault` is an EOA and
                    the distributor's halves are immutable — so it cannot be read from the chain and
                    is stated from one constant instead. @see lib/burns.ts
                    ⛔ Gated to this token. Every other launch's creator half really is undivided,
                    and printing "Buybacks & Burns 40%" on one would be a flat lie.
                  */
                  <>
                    <Row k="Buybacks & Burns" v={`${BURN_SHARE_PCT}%`} />
                    <Row k="Creator share" v={`${CREATOR_SHARE_PCT}%`} />
                  </>
                ) : t.splits.length === 0 ? (
                  <Row k="Creator share" v={`${100 - t.charityBps / 100}%`} />
                ) : (
                  t.splits.map((sp, i) => {
                    const ofAll = ((sp.bps / 10000) * (100 - t.charityBps / 100))
                    const pct = ofAll % 1 === 0 ? ofAll : Number(ofAll.toFixed(1))
                    if (sp.mode === 1) {
                      return <Row key={i} k={<AccountShare provider={sp.provider} id={sp.accountId} />} v={`${pct}%`} />
                    }
                    const label = sp.mode === 0 ? 'To the creator' : 'Bought back & burned'
                    return <Row key={i} k={label} v={`${pct}%`} />
                  })
                )}

                {/* ⚠ "the creator" only when that is who it went to. On a routed launch this
                    figure is what the ROUTER has been paid, and it is then split again.
                    ⛔ Omitted on $CHARITY: the rows above already say where that half goes as
                    percentages, and a running ETH total beside them invited the two to be read as
                    one split — a share and a balance are not the same kind of number. */}
                {!isCharityToken && (
                  <Row
                    k={t.splits.length === 0 ? 'Paid to the creator' : 'Paid to the fee router'}
                    v={`${fmt(t.paidToCreator, t.pairDecimals, 2)} ${t.pairSymbol}`}
                  />
                )}
                {/* ⭐ A real burn: this came out of `totalSupply`, it did not move to a dead
                    address. Shown only once something has actually been destroyed. */}
                {t.burned > 0n && (
                  <Row k="Burned so far" v={`${fmt(t.burned, t.decimals, 0)} ${t.symbol}`} />
                )}
                {/*
                  ⚠ ONE figure that rises, not a sum shown as its parts. A trader pays a single
                  percentage on a trade, so "1% plus 1.00% creator tax" asks them to add up what
                  they are about to be charged. Pons's 1% and the creator tax land on the same leg.
                */}
                <Row k="Trading fee" v={`${(1 + t.creatorTaxBps / 100).toFixed(2).replace(/\.00$/, '')}%`} />
              </div>
            </div>

            <div>
              <p className="eyebrow" style={{ justifyContent: 'center' }}>Token Details</p>
              <div className="ledger" style={{ borderTop: '1px solid var(--ink)' }}>
                <Row k="Token" v={<a className="mono" href={tokenUrl(t.address)} target="_blank" rel="noreferrer">{short(t.address, 6)}</a>} />
                <Row k="Distributor" v={<a className="mono" href={addrUrl(t.distributor)} target="_blank" rel="noreferrer">{short(t.distributor, 6)}</a>} />
                {/* ⚠ Only when there is one. A launch that just pays a wallet has no router, and an
                    empty row invites the reader to wonder what is missing. */}
                {!/^0x0+$/.test(t.router) && (
                  <Row k="Fee router" v={<a className="mono" href={addrUrl(t.router)} target="_blank" rel="noreferrer">{short(t.router, 6)}</a>} />
                )}
                <Row k="Curve" v={<a className="mono" href={addrUrl(t.curve)} target="_blank" rel="noreferrer">{short(t.curve, 6)}</a>} />
                <Row k="Launched by" v={<a className="mono" href={addrUrl(t.creator)} target="_blank" rel="noreferrer">{short(t.creator, 6)}</a>} />
                {/* ⭐ The contract that does the buying and burning. Worth listing beside the curve
                    and the distributor for the same reason those are: the claim on this page is
                    only checkable if the thing making it is findable.
                    ⛔ $CHARITY only — no other launch has one. */}
                {isCharityToken && (
                  <Row k="Burn Contract" v={<a className="mono" href={addrUrl(BURNER)} target="_blank" rel="noreferrer">{short(BURNER, 6)}</a>} />
                )}
              </div>

              {/* ⛔ Only renders for a wallet that actually holds this token, so it is invisible to
                  everyone else rather than a disabled control everyone has to reason about. */}
              <BurnPanel token={t.address} symbol={t.symbol} decimals={t.decimals}
                onBurned={() => { void readToken(t.address).then((v) => v && setT(v)) }} />
            </div>
          </div>

          {/* ⭐⭐ THE TWO HALVES OF WHAT A FEE DOES, SIDE BY SIDE. Half of every fee goes to a
              charity and a share of the rest buys this token back and destroys it. Stacked, the
              second register read as an afterthought to the first; paired, they read as one record
              with two columns — which is what they are.
              ⚠ They collapse to one column under 900px rather than squeezing: two five-row lists
              at half a phone's width is two unreadable lists. */}
          <div className="dpair">
            <TokenDonations token={t.address} collected={t.paidToCharity}
              pairSymbol={t.pairSymbol} pairDecimals={t.pairDecimals} />
            {/* ⚠ Only on $CHARITY: the burner is that one token's contract, so any other launch
                would render an empty panel that implies a buy-back it does not have. */}
            {isCharityToken && <TokenBurns logo={t.logo} symbol={t.symbol} />}
          </div>
        </div>
      </section>
    </>
  )
}

/** ⚠ The label takes a node, not just a string: an account share names a person and links to them,
 *  which is a label with an icon and an anchor in it. */
function Row({ k, v }: { k: React.ReactNode; v: React.ReactNode }) {
  return (
    <div className="trow">
      <span className="trow__k">{k}</span>
      <span className="trow__v">{v}</span>
    </div>
  )
}
