import { useEffect, useState } from 'react'
import {
  totalsByToken, fmtAmount, tokenMeta, ago, baseTxUrl, fetchAllDonations, fetchAttribution,
  donationsFor, type Donation,
} from '../lib/donations.ts'
import { loadCharities, charityByConfig, charityPage, type Charity } from '../lib/charities.ts'

/**
 * Every donation this launchpad has made, newest first.
 *
 * ⭐ Each row is one `Paid` event on Base and carries the link to it. A visitor does not have to
 * believe the number: `View tx` opens the transaction that moved the money on an explorer we have
 * nothing to do with. That is the whole reason this reads the chain rather than the keeper's
 * receipts file, which would have been one fetch instead of several.
 *
 * ⚠ The list starts at the chain head and walks BACKWARDS a day at a time. Opening the home page
 * costs one or two requests; the cost of deep history is only paid by somebody who asks for it.
 */
export const PAGE = 5

export function Donations({ rows, loading, failed, complete }: {
  rows: Donation[]; loading: boolean; failed: boolean
  /** ⛔ False when the log walk had a hole: the rows are real, their SUM is a lower bound. */
  complete: boolean
}) {
  const [shown, setShown] = useState(PAGE)
  const [charities, setCharities] = useState<Charity[]>([])

  useEffect(() => {
    void (async () => {
      try { setCharities(await loadCharities()) } catch { /* rows fall back to the config id */ }
    })()
  }, [])

  /* ⛔⛔ THE TOTAL IS OF EVERY DONATION, NOT OF THE ROWS ON SCREEN. Summing the visible page and
     labelling it "delivered" understates it the moment there is more than one page, silently: the
     figure stays plausible and just gets smaller than the truth. `Load more` reveals rows that are
     already loaded rather than fetching, so the two can never disagree. */
  const totals = totalsByToken(rows)

  return (
    <section className="section--alt" id="donations">
      <div className="wrap">
        <div className="sect__head">
          <div>
            <h3 className="sect__title">
              Donations
              {!loading && rows.length > 0 && <span className="sect__count">{rows.length}</span>}
            </h3>
            <p className="sect__blurb">
              Every donation our launchpad has made to a charity.
            </p>
          </div>
          {/* ⛔⛔ Per token. Adding USDC to ETH would be adding dollars to ether, and the two differ
              by twelve decimal places, so the larger number would always be the smaller amount. */}
          {/* ⛔⛔ The rows are each provable on their own; the TOTAL is only true if every chunk of
              the walk was answered. Printing the sum of a walk with a hole in it is what showed
              four different "delivered" figures to four different visitors. Rows still render. */}
          {rows.length > 0 && complete && (
            <div className="dtotals">
              {Object.entries(totals).map(([t, v]) => {
                const m = tokenMeta(t as `0x${string}`)
                return (
                  <div className="dtotal" key={t}>
                    <b>{fmtAmount(v, m.decimals, 2)}</b>
                    <span>{m.symbol} delivered</span>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {loading ? (
          <div className="empty">Reading the chain</div>
        ) : failed && rows.length === 0 ? (
          <div className="empty">Base could not be reached. The donations are on chain either way.</div>
        ) : rows.length === 0 ? (
          <div className="empty">No donations yet. The first launch to earn a fee starts this list.</div>
        ) : (
          <>
            <ul className="dlist">
              {rows.slice(0, shown).map((r) => (
                <DonationRow key={`${r.txHash}:${r.logIndex}`} r={r} charities={charities} />
              ))}
            </ul>
            {shown < rows.length && (
              <div className="dmore">
                <button className="btn btn--sm" onClick={() => setShown((n) => n + PAGE)}>
                  Load more
                  <span className="dmore__plus" aria-hidden="true">+</span>
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  )
}

export function DonationRow({ r, charities }: { r: Donation; charities: Charity[] }) {
  const c = charities.length ? charityByConfig(charities, r.configId) : undefined
  const m = tokenMeta(r.token)
  const when = ago(r.timestamp)

  return (
    <li className="drow">
      {/* ⚠ eager, not lazy. A lazily loaded logo inside a list that is not yet scrolled to never
          issues its request at all, and the row renders with a blank square. */}
      {c?.logo ? (
        <img className="drow__logo" src={c.logo} alt="" loading="eager" decoding="async" />
      ) : (
        <div className="drow__logo drow__logo--none" aria-hidden="true" />
      )}

      <div className="drow__main">
        <div className="drow__who">
          {c ? (
            <a href={charityPage(c)} target="_blank" rel="noopener noreferrer">{c.name}</a>
          ) : (
            /* ⚠ A config id with no row in the directory is shown as the id, never guessed at. */
            <span className="drow__unknown">{r.configId.slice(0, 10)}…</span>
          )}
          {when && <span className="drow__age"> · {when}</span>}
        </div>
        <div className="drow__amt">
          {fmtAmount(r.amount, m.decimals)} <span>{m.symbol}</span>
        </div>
      </div>

      <a className="btn btn--sm drow__tx" href={baseTxUrl(r.txHash)} target="_blank" rel="noopener noreferrer">
        View tx
      </a>
    </li>
  )
}

/**
 * One launch's donations, for its own page.
 *
 * ⭐ Same rows, same proof: each one still links to the `Paid` transaction that moved the money.
 * The only thing that differs from the home page's list is which rows are shown, and that filter is
 * the one piece of information the chain cannot supply. @see donationsFor
 */
export function TokenDonations({
  token, collected = 0n, pairSymbol = '', pairDecimals = 18,
}: {
  token: string
  /** `totalToCharity`: pushed toward the charity but not necessarily delivered. */
  collected?: bigint
  pairSymbol?: string
  pairDecimals?: number
}) {
  const [rows, setRows] = useState<Donation[]>([])
  const [charities, setCharities] = useState<Charity[]>([])
  const [loading, setLoading] = useState(true)
  const [complete, setComplete] = useState(false)
  const [shown, setShown] = useState(PAGE)

  useEffect(() => {
    /* ⚠ Block-bodied: React 19 renders a blank page for a concise arrow that returns a promise. */
    void (async () => {
      try {
        /* Together, not in sequence: one is a chain read and the other is our own service, and
           neither needs the other's answer. */
        /* ⚠ The attribution is needed before ANY row can be shown, so the partial pass waits on it
           too — but it is one small request against our own box, not a scan of Base. */
        const attribution = await fetchAttribution()
        const show = (scan: { rows: Donation[]; complete: boolean }) => {
          setRows(donationsFor(scan.rows, attribution, token))
          setComplete(scan.complete)
          setLoading(false)
        }
        show(await fetchAllDonations({ onPartial: show }))
      } catch {
        /* An unreachable Base or a down index shows no rows, never an error. */
      } finally {
        setLoading(false)
      }
    })()
  }, [token])

  useEffect(() => {
    void (async () => {
      try { setCharities(await loadCharities()) } catch { /* falls back to the config id */ }
    })()
  }, [])

  const totals = totalsByToken(rows)

  return (
    /* ⚠ Set apart from the detail grid above it with a rule and real space. Without them the
       heading butted straight onto the last row of a table and read as another of its fields. */
    <div className="sect sect--center">
      <div className="sect__head">
        <div>
          <h3 className="sect__title">
            Donations
            {!loading && rows.length > 0 && <span className="sect__count">{rows.length}</span>}
          </h3>
          <p className="sect__blurb">Every donation this token&rsquo;s fees have paid for.</p>
        </div>
        {/* ⛔ Same rule as the launchpad-wide list: no total off an incomplete walk. */}
        {rows.length > 0 && complete && (
          <div className="dtotals">
            {Object.entries(totals).map(([t, v]) => {
              const m = tokenMeta(t as `0x${string}`)
              return (
                <div className="dtotal" key={t}>
                  <b>{fmtAmount(v, m.decimals, 2)}</b>
                  <span>{m.symbol} delivered</span>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {loading ? (
        <div className="empty">Reading the chain</div>
      ) : rows.length === 0 ? (
        /* ⚠ Says what the state IS. "No donations yet" on a token that has earned fees would be
           wrong: the money may be swept, harvested, or mid-crossing, and none of that is nothing. */
        /*
          ⛔⛔ "NOTHING DONATED YET" IS FALSE FOR A LAUNCH THAT HAS EARNED.

          Fees are swept, harvested, bridged and only then donated, and each step takes time — this
          page said a token had delivered nothing while real money of its own was mid-pipeline. So
          when something HAS been collected, the empty state says where it actually is.

          ⚠ The two figures are never added or subtracted: collected is in the pair asset and
          delivered is USDC, and the site's rule is that those never meet in one number.
        */
        <div className="empty">
          {collected > 0n ? (
            <>
              <b>{fmtAmount(collected, pairDecimals, 4)} {pairSymbol}</b> has been collected for this
              charity and is on its way. It appears here, with its transaction, once it has been
              bridged and donated.
            </>
          ) : (
            <>Nothing has been collected for this token&rsquo;s charity yet. Fees are collected on
            chain first and appear here once they have been donated.</>
          )}
        </div>
      ) : (
        <>
          <ul className="dlist">
            {rows.slice(0, shown).map((r) => (
              <DonationRow key={`${r.txHash}:${r.logIndex}`} r={r} charities={charities} />
            ))}
          </ul>
          {shown < rows.length && (
            <div className="dmore">
              <button className="btn btn--sm" onClick={() => setShown((n) => n + PAGE)}>
                Load more
                <span className="dmore__plus" aria-hidden="true">+</span>
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
