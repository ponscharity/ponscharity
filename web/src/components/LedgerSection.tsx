import { useMemo } from 'react'
import { type Launch } from '../lib/launchpad.ts'
import { TokenCard } from './TokenCard.tsx'

export type Sort = 'newest' | 'raised'
export const SORTS: { id: Sort; label: string }[] = [
  { id: 'newest', label: 'Newest' },
  { id: 'raised', label: 'Most paid' },
]

/**
 * ⚠⚠ Ranking by amount compares dollars to ether the moment two pair assets are in one list, and
 * puts whichever has more decimals on top. Without a price feed there is no honest ranking, so the
 * order falls back to newest and the caller is told, rather than a confidently wrong leaderboard.
 */
export function mixedAssets(rows: Launch[]) {
  return new Set(rows.map((r) => r.pairToken.toLowerCase())).size > 1
}

export function applySort(rows: Launch[], sort: Sort): Launch[] {
  const c = [...rows]
  if (sort === 'raised' && !mixedAssets(rows)) {
    return c.sort((a, b) => (b.raised > a.raised ? 1 : b.raised < a.raised ? -1 : 0))
  }
  return c
}

/**
 * A grid of launch cards.
 *
 * ⚠⚠ THIS WAS A RULED TABLE, AND THE TABLE WAS THE WRONG OBJECT. Seven columns of #, token, market
 * cap, charity, split, paid and age is a ledger: it is for reading down a column and comparing, and
 * it gives the token's own art a 34px square. A launchpad is browsed, not audited, and what somebody
 * is doing on this page is choosing which token to look at, which the art does most of the work for.
 *
 * ⭐ So it is cards, the same shape Pons's own launchpad uses. Every figure the table carried is
 * still here; the ones that decide a click are just larger than the ones that do not.
 */
export function Ledger({ rows, loading, empty }: { rows: Launch[]; loading: boolean; empty: string }) {
  if (loading) return <div className="empty">Reading the chain</div>
  if (rows.length === 0) return <div className="empty">{empty}</div>
  return (
    <div className="tgrid">
      {rows.map((l) => <TokenCard key={l.token} l={l} />)}
    </div>
  )
}

/** A titled register with its own sort control and count. */
export function LedgerSection({
  title, blurb, rows, loading, empty, sort, onSort,
}: {
  title: string; blurb: string; rows: Launch[]; loading: boolean; empty: string
  sort: Sort; onSort: (s: Sort) => void
}) {
  const shown = useMemo(() => applySort(rows, sort), [rows, sort])
  const mixed = mixedAssets(rows)

  return (
    <div className="sect">
      <div className="sect__head">
        <div>
          <h3 className="sect__title">
            {title}
            {!loading && <span className="sect__count">{rows.length}</span>}
          </h3>
          <p className="sect__blurb">{blurb}</p>
        </div>
        <div className="chips">
          {SORTS.map((s) => (
            <button key={s.id} className="chip" aria-pressed={sort === s.id} onClick={() => onSort(s.id)}>
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {sort === 'raised' && mixed && (
        <div className="banner" style={{ marginBottom: 16 }}>
          These tokens are priced in different assets, so ranking them by amount needs a price feed
          this page does not have. Showing newest first instead.
        </div>
      )}

      <Ledger rows={shown} loading={loading} empty={empty} />
    </div>
  )
}
