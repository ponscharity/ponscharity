import { useMemo, useState } from 'react'
import { type Launch } from '../lib/launchpad.ts'
import { totalsByToken, fmtAmount as fmtToken, tokenMeta, BASE_USDC, type Donation } from '../lib/donations.ts'
import { HOW, LAUNCH } from '../lib/router.ts'
import { TOKEN_CA, hasTokenCa } from '../lib/brand.ts'
import { Link } from './Link.tsx'

/**
 * ⭐⭐ A HALLMARK, NOT A MASCOT.
 *
 * Silver is hallmarked: a small punch struck into the metal that permanently certifies what it is.
 * That is exactly what a launch here does to a token, so the mark is small and precise rather than
 * a large character sitting on a coloured shape, and the one big object on the page is the split
 * itself. A launchpad hero is usually a picture of a thing; here the thing is a rule about money,
 * and drawing the rule says more than an illustration would.
 */
/**
 * The site's own contract address, under the hero.
 *
 * ⚠⚠ A BUTTON ONLY WHEN THERE IS SOMETHING TO COPY. Rendering the copy affordance around `TBA`
 * gives people a control that does nothing, and a control that does nothing is worse than none:
 * it gets pressed, and the silence reads as the page being broken rather than as the address not
 * existing yet. With no address it is plain text.
 *
 * ⚠ `navigator.clipboard` is undefined on an insecure origin and can be refused even on a secure
 * one, so the write is guarded. A refusal leaves the label alone rather than claiming a copy that
 * did not happen.
 */
function CaStrip() {
  const [copied, setCopied] = useState(false)

  const ca = hasTokenCa() ? TOKEN_CA : null

  if (!ca) {
    return (
      <p className="ca ca--tba">
        <span className="ca__k">CA:</span>
        <span className="ca__v">TBA</span>
      </p>
    )
  }

  const copy = () => {
    void navigator.clipboard?.writeText(ca).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    }).catch(() => {})
  }

  return (
    /* ⭐ THE WHOLE STRIP IS THE BUTTON. A separate copy control beside a long address is a small
       target most people never aim at and some never notice; the address itself is the thing they
       are already looking at, so it is the thing that copies.
       ⚠ `aria-live` on the confirmation, because for a screen reader the only evidence a click did
       anything is a word that changed somewhere else on the line. */
    <button type="button" className={`ca ca--btn${copied ? ' is-copied' : ''}`} onClick={copy}
      title="Copy the contract address" aria-label={`Copy the contract address ${ca}`}>
      <span className="ca__k">CA:</span>
      <span className="ca__v mono">{ca}</span>
      <span className="ca__say" aria-live="polite">{copied ? 'Copied' : ''}</span>
    </button>
  )
}

export function Hero({
  launches, minBps, loading, donations, donationsLoading, donationsComplete,
}: {
  launches: Launch[]; minBps: number; loading: boolean
  donations: Donation[]; donationsLoading: boolean
  /** ⛔ False means the walk has a hole in it and `donations` is a LOWER BOUND, not a total. */
  donationsComplete: boolean
}) {
  /*
    ⛔⛔ THIS FIGURE USED TO BE ETHER, AND IT WAS ALSO THE WRONG FACT.

    It summed each distributor's `totalToCharity` per pair asset and printed "1.4 ETH". Two things
    were wrong with that. The unit: this stack has shipped a market cap denominated in ether before,
    and a charity's receipt quoted in ether is the same mistake — nobody donates ether to a food
    bank, and the number moves when the token does. And the fact: `totalToCharity` is what a
    distributor PUSHED toward the vault, which is money on its way, not money a charity has.

    ➤ What is printed now is the sum of `CharityPayer.Paid` on Base: USDC that reached a charity,
    in the currency it reached them in, every unit of it linked to its own transaction in the list
    further down the page. It is the one number here that a stranger can check.

    ⚠ Still per token, and only the USDC line is the headline. `payNative` also emits `Paid`, and
    adding ether to dollars is exactly the addition the paragraph above exists to refuse.
  */
  const delivered = useMemo(() => {
    const byToken = totalsByToken(donations)
    return Object.entries(byToken)
      .map(([token, amount]) => ({ token, amount, ...tokenMeta(token as `0x${string}`) }))
      /* USDC first: it is the rail every remit actually uses, so it is the line that means
         "delivered" to somebody reading quickly. */
      .sort((a, b) => (a.token === BASE_USDC.toLowerCase() ? -1 : b.token === BASE_USDC.toLowerCase() ? 1 : 0))
  }, [donations])

  return (
    <section className="hero" id="top">
      <div className="wrap">
        <div className="hero__in">
          {/* ⭐ The mark sits on the page itself now, with no roundel behind it. At this size the
              chrome carries its own edge, and a plate under it only competed with it. */}
          <span className="mark hero__mark"><img src="/logo.png" alt="Pons Charity" /></span>

          <h1>Pons Charity</h1>
          <div className="hero__cta">
            <Link className="btn btn--ink btn--lg" to={LAUNCH}>Launch a token</Link>
            <Link className="btn btn--lg" to={HOW}>How it works</Link>
          </div>

          <CaStrip />
        </div>

        <div className="stats">
          <div className="stat">
            <div className="stat__k">Donated to charities</div>
            {/*
              ⛔⛔ A SHORT TOTAL MUST NOT RENDER AS A TOTAL — and `'0'` was one.

              Until 7 Sep 2026 this printed `'0'` while loading and then whatever the log walk had
              managed to read. A walk that lost chunks reads low, and the same page showed
              76,241.87, 75,936.47, 34,033.14 and 0 to different people depending on which public
              Base endpoint served them, each one looking equally settled. The figure is now shown
              only when every chunk was answered; otherwise the em dash says plainly that the number
              is not in yet. ⚠ Never substitute a partial sum here to avoid an empty-looking box.
            */}
            <div className="stat__v">
              {donationsLoading || !donationsComplete ? '—'
                : delivered.length === 0 ? '0'
                : delivered.map((d) => `${fmtToken(d.amount, d.decimals, 2)} ${d.symbol}`).join('  ')}
            </div>
          </div>
          <div className="stat">
            <div className="stat__k">Charity launches</div>
            <div className="stat__v">{loading ? '0' : launches.length}</div>
          </div>
          <div className="stat">
            <div className="stat__k">Minimum share</div>
            <div className="stat__v">{minBps / 100}<small>%</small></div>
          </div>
        </div>
      </div>
    </section>
  )
}
