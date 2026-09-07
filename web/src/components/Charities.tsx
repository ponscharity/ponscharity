import { useEffect, useMemo, useState } from 'react'
import { charityPage, loadCharities, loadedCharities, searchCharities, type Charity } from '../lib/charities.ts'
import {
  amountsComparable, loadCharityStats, loadedCharityStats, paidIn, paidParts, plural, soleAsset,
  statFor, type StatIndex,
} from '../lib/charityStats.ts'
import { LAUNCH } from '../lib/router.ts'
import { Link } from './Link.tsx'

/*
  ⛔⛔ EVERY FIGURE IS PINNED TO en-US, NEVER THE VISITOR'S LOCALE.

  `toLocaleString()` with no argument follows the machine's REGIONAL settings, not its language, and
  on this machine it rendered 2705 as "2.705" while `navigator.language` said en-GB. A count that
  reads as a decimal to some visitors and an integer to others is worse than either, and it is
  invisible to whoever built it because it depends on settings they are not looking at.
*/
/**
 * What this launchpad has done for one charity, or nothing at all.
 *
 * ⛔ Returns null rather than a zero. A charity nobody has launched for gets no figure, because the
 * honest rendering of "we have not done this yet" is silence, not a 0 that looks like a measurement.
 */
function statLine(stats: StatIndex, c: Charity) {
  const st = statFor(stats, c.configId)
  if (!st) return null
  const parts = paidParts(st)
  return parts.length > 0
    ? `${plural(st.launches, 'launch', 'launches')} · ${parts.join(' · ')} paid`
    : plural(st.launches, 'launch', 'launches')
}

type Sort = 'paid' | 'name'
const SORTS: { id: Sort; label: string }[] = [
  { id: 'paid', label: 'Most used' },
  { id: 'name', label: 'A to Z' },
]

/** ⚠ Rendered a page at a time. Two and a half thousand cards mounted at once is tens of thousands
 *  of DOM nodes and a visibly janky scroll, for a list nobody reads past the third screen. */
const PAGE = 24

export function Charities() {
  const [all, setAll] = useState<Charity[]>(() => loadedCharities() ?? [])
  const [failed, setFailed] = useState(false)
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<Sort>('paid')
  const [shown, setShown] = useState(PAGE)
  const [stats, setStats] = useState<StatIndex>(() => loadedCharityStats() ?? {})

  useEffect(() => {
    if (all.length) return
    let live = true
    void loadCharities()
      .then((cs) => { if (live) setAll(cs) })
      .catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [all.length])

  /* ⚠ Separate from the directory, and never allowed to fail it. The figures decorate a list whose
     real job is choosing somebody; an RPC hiccup costs a card its numbers, not the whole page. */
  useEffect(() => {
    let live = true
    void loadCharityStats().then((s) => { if (live) setStats(s) })
    return () => { live = false }
  }, [])

  // ⚠ Reset the page size whenever the list changes underneath, or a search lands on page four.
  useEffect(() => { setShown(PAGE) }, [q, sort])

  const comparable = useMemo(() => amountsComparable(stats), [stats])
  const only = useMemo(() => soleAsset(stats), [stats])

  const rows = useMemo(() => {
    /* ⚠ Search ranks by relevance and already returns its own order, so a sort is only applied when
       there is no query. Sorting a ranked result by name throws the ranking away. */
    if (q.trim()) return searchCharities(all, q, 400)
    const c = [...all]
    if (sort === 'name') return c.sort((a, b) => a.name.localeCompare(b.name))

    /*
      ⛔⛔ THE TIEBREAK IS NOT A CLAIM, AND IT IS NEVER SHOWN.

      Ranking 2,705 charities by what this launchpad has paid them puts every charity we have not
      launched for — which on any given day is nearly all of them — into one enormous tie. Left
      there, the first screen is whatever order the file happens to be in, which is not an order.

      ➤ So ties fall back to donate.gg's own figure, purely to decide who is shown first. That number
      does not appear anywhere on this page any more, and ordering a directory is not the same act as
      printing somebody else's total under our masthead and letting it read as ours.

      ⚠⚠ And ranking by AMOUNT is refused outright once two pair assets have paid: comparing ether to
      dollars sorts by decimal count. It falls back to launches, and the note under the chips says so
      rather than presenting a confidently wrong leaderboard.
    */
    const tie = (a: Charity, b: Charity) => b.raisedUsd - a.raisedUsd
    /* ⚠ Launch count is no longer a chip, but it is still the fallback ORDER, because it stays a
       real integer when two pair assets make amounts incomparable. Removing the control does not
       remove the situation it was there to describe. */
    if (!comparable) {
      return c.sort((a, b) =>
        (statFor(stats, b.configId)?.launches ?? 0) - (statFor(stats, a.configId)?.launches ?? 0) || tie(a, b))
    }
    return c.sort((a, b) => {
      const pa = paidIn(statFor(stats, a.configId), only)
      const pb = paidIn(statFor(stats, b.configId), only)
      return pb > pa ? 1 : pb < pa ? -1 : tie(a, b)
    })
  }, [all, q, sort, stats, comparable, only])

  return (
    <section className="page">
      <div className="wrap">
        <div className="chead">
          <p className="eyebrow" style={{ justifyContent: 'center' }}>Charities</p>
          <h1 className="chead__h">Find a cause worth launching for</h1>
          {/*
            ⛔⛔ NO AGGREGATE OF donate.gg's FIGURES. This read "Over $Xm raised, with N charities to
            choose from", summing `raisedUsd` across the directory. Every one of those dollars was
            raised on donate.gg by other people, and none of it came through this launchpad — but on
            this page, under this masthead, a headline total reads as ours. Summing somebody else's
            numbers and presenting the result as a top line is how a site claims a track record it
            does not have, without a single sentence being literally false.

            ➤ The count is ours to state: 2,705 charities really are selectable here. The money is
            not, so it is not totalled anywhere, and the per-charity figures below carry donate.gg's
            name in the same breath as the number.
          */}
          {/*
            ⚠ The launchpad's own line is rendered ONLY once there is something in it. A standing
            "0 launches, nothing paid" is a status report on the build rather than an empty state,
            and it would need taking out again on the first launch. The directory count is always
            true, so it always shows; the rest arrives on its own.
          */}
          <p className="chead__sub">
            {all.length === 0
              ? 'Loading the directory'
              : <><b>{all.length.toLocaleString('en-US')}</b> charities to choose from.</>}
          </p>
        </div>

        <div className="cbar">
          <input className="input" placeholder="Search charities" value={q}
            onChange={(e) => setQ(e.target.value)} />
          <div className="chips">
            {SORTS.map((s) => (
              <button key={s.id} className="chip" aria-pressed={!q.trim() && sort === s.id}
                disabled={!!q.trim()} onClick={() => setSort(s.id)}>
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {failed ? (
          <div className="empty">The directory could not be loaded. Reload the page to try again.</div>
        ) : all.length === 0 ? (
          <div className="empty">Loading charities</div>
        ) : rows.length === 0 ? (
          <div className="empty">Nothing matches “{q.trim()}”.</div>
        ) : (
          <>
            <div className="cgrid">
              {rows.slice(0, shown).map((c) => (
                <article key={c.configId} className="ccard">
                  <div className="ccard__top">
                    <img className="ccard__logo" src={c.logo} alt="" loading="lazy" decoding="async"
                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden' }} />
                  </div>
                  <h3 className="ccard__name">{c.name}</h3>
                  {c.place && <div className="ccard__place">{c.place}</div>}
                  <p className="ccard__mission">{c.mission}</p>
                  {/* ⚠ The span is rendered even when empty so `Details` stays on the right. A card
                      for a charity nobody has launched for carries no figure at all — absence is the
                      empty state, and "0 ETH paid" would be a number we invented to fill a slot. */}
                  <div className="ccard__foot">
                    <span>{statLine(stats, c)}</span>
                    <a href={charityPage(c)} target="_blank" rel="noreferrer noopener">Details</a>
                  </div>
                  <Link className="btn btn--sm ccard__cta" to={LAUNCH}>Launch for them</Link>
                </article>
              ))}
            </div>

            {shown < rows.length && (
              <div style={{ marginTop: 30, textAlign: 'center' }}>
                <button className="btn" onClick={() => setShown(shown + PAGE * 2)}>
                  Show more ({(rows.length - shown).toLocaleString('en-US')} left)
                </button>
              </div>
            )}
          </>
        )}

        <p className="cnote">
          Charities are listed from donate.gg's public directory and paid through their donation
          relay.
        </p>
      </div>
    </section>
  )
}
