import { useCallback, useEffect, useState } from 'react'
import { fmtAmount, ago } from '../lib/donations.ts'
import { fetchBurns, totalBurned, type Burn } from '../lib/burns.ts'
import { txUrl } from '../lib/chain.ts'
import { PAGE } from './Donations.tsx'
import { TokenImage } from './TokenImage.tsx'

/**
 * Every buy-back-and-burn this token's fees have paid for.
 *
 * ⭐ The mirror of {@link TokenDonations}, deliberately identical in shape: same head, same count,
 * same total plate, same rows with their own `View tx`. The two halves of what a fee does — half to
 * a charity, a share of the rest destroyed — should read as one register split in two, not as two
 * unrelated widgets that happen to sit together.
 *
 * ⛔⛔ THE FIGURE IS SUPPLY DESTROYED, NOT TOKENS MOVED. `burn` reduces `totalSupply`; sending to
 * `0x…dEaD` does not, and a "burn" counted that way would be a number that changes nothing. Each
 * row carries the supply immediately after it, so the claim is checkable against the token itself.
 */
export function TokenBurns({ logo, symbol }: { logo?: string; symbol?: string }) {
  const [rows, setRows] = useState<Burn[]>([])
  const [loading, setLoading] = useState(true)
  const [complete, setComplete] = useState(false)
  /* ⛔⛔ THE READ FAILING IS ITS OWN STATE, NOT AN EMPTY REGISTER. This panel used to catch the
     failure, keep `rows` empty and print "Nothing burned yet" about a contract that had burned
     seven times — while the stat directly above it, read off the burner's own counter, printed the
     ETH those burns had spent. The explorer's v2 log endpoint was answering HTTP 500 to roughly
     three requests in four, so that was what most visitors saw. */
  const [failed, setFailed] = useState(false)
  const [shown, setShown] = useState(PAGE)

  const load = useCallback(() => {
    setLoading(true)
    /* ⚠ Block-bodied: React 19 renders a blank page for a concise arrow that returns a promise. */
    void (async () => {
      const scan = await fetchBurns()
      setRows(scan.rows)
      setComplete(scan.complete)
      setFailed(!scan.ok)
      setLoading(false)
    })()
  }, [])

  useEffect(load, [load])

  const burned = totalBurned(rows)

  return (
    <div className="sect sect--center dpanel">
      <div className="sect__head">
        <div>
          <h3 className="sect__title">
            Burns
            {!loading && rows.length > 0 && <span className="sect__count">{rows.length}</span>}
          </h3>
          <p className="sect__blurb">Every buy-back this token&rsquo;s fees have paid for.</p>
        </div>
        {/* ⛔ Same rule as the donations register: no total off an incomplete walk. */}
        {rows.length > 0 && complete && (
          <div className="dtotals">
            <div className="dtotal">
              <b>{fmtAmount(burned, 18, 2)}</b>
              <span>CHARITY burned</span>
            </div>
          </div>
        )}
      </div>

      {loading ? (
        <div className="empty">Reading the chain</div>
      ) : failed ? (
        /* ⭐ Says what actually happened, and offers the one recovery that is safe. ⛔ No automatic
           retry: a 429 on this explorer is a multi-minute penalty box, so the page must not hammer
           it — a visitor pressing a button is the throttle. */
        <div className="empty">
          The block explorer didn&rsquo;t answer, so this register can&rsquo;t be shown right now.
          The burns are on chain either way.
          <div className="dmore">
            <button className="btn btn--sm" onClick={load}>Try again</button>
          </div>
        </div>
      ) : rows.length === 0 ? (
        <div className="empty">
          Nothing burned yet. A share of this token&rsquo;s fees buys $CHARITY on the pool and
          destroys it; the first one appears here with its transaction.
        </div>
      ) : (
        <>
          <ul className="dlist">
            {rows.slice(0, shown).map((r) => (
              <BurnRow key={`${r.txHash}:${r.logIndex}`} r={r} logo={logo} symbol={symbol} />
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

function BurnRow({ r, logo, symbol }: { r: Burn; logo?: string; symbol?: string }) {
  const when = ago(r.timestamp)

  return (
    <li className="drow">
      {/* ⭐ The token's OWN logo, matching the donation rows' charity logos. A donation row is
          marked with who received it; a burn has no recipient, so it is marked with what was
          destroyed. ⚠ TokenImage handles a dead or slow logo host and falls back to the site mark,
          which matters because a token logo is a URI its creator typed. */}
      <TokenImage uri={logo} symbol={symbol} className="drow__logo drow__logo--token" />

      <div className="drow__main">
        <div className="drow__who">
          <span className="drow__kind">
            {r.kind === 'bought' ? 'Bought & burned' : 'Burned directly'}
          </span>
          {when && <span className="drow__age"> · {when}</span>}
        </div>
        <div className="drow__amt">
          {fmtAmount(r.burned, 18, 2)} <span>CHARITY</span>
          {/* ⚠ The ETH is shown as context, never added to the burned figure — one is ether and the
              other is a memecoin, and this site's rule is that those never meet in one number. */}
          {r.spent > 0n && (
            <span className="drow__sub"> · {fmtAmount(r.spent, 18, 4)} ETH</span>
          )}
        </div>
      </div>

      <a className="btn btn--sm drow__tx" href={txUrl(r.txHash)} target="_blank" rel="noopener noreferrer">
        View tx
      </a>
    </li>
  )
}
