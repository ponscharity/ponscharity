import type { Launch } from '../lib/launchpad.ts'
import { EXPLORE } from '../lib/router.ts'
import { Link } from './Link.tsx'
import { Ledger, applySort } from './LedgerSection.tsx'

/** ⚠ Six on the home page, not all of them. The home page is an introduction; the dashboard is the
 *  dashboard, and a home page that lists everything gives the dashboard nothing to be. */
const HOME_ROWS = 6

/**
 * Recent launches, newest first.
 *
 * ⭐ NO SORT CONTROL, AND THAT IS THE POINT. This is the recent launches panel: it answers "what has
 * just happened here", and a panel whose order can be changed is no longer answering that. Sorting
 * belongs on the explore page, which exists to be sorted. The order is fixed at newest so the
 * heading and the contents cannot disagree.
 */
export function Launches({ launches, loading }: { launches: Launch[]; loading: boolean }) {
  const rows = applySort(launches, 'newest').slice(0, HOME_ROWS)

  return (
    <section id="explore-preview">
      <div className="wrap">
        {/* ⚠ The centred `head--center` every other heading on the site uses, rather than the flex
            row this was. That row put the title left and the link right, which cannot be centred
            without the link fighting it, so the link moved under the grid where it reads as
            "and there is more" rather than as part of the title. */}
        <div className="head head--center" style={{ marginBottom: 22 }}>
          <p className="eyebrow">Explore</p>
          <h2>Recent launches</h2>
        </div>

        <Ledger rows={rows} loading={loading} empty="Nothing here yet. Launch the first one." />

        {launches.length > HOME_ROWS && (
          <div style={{ marginTop: 26, textAlign: 'center' }}>
            <Link className="btn" to={EXPLORE}>See all {launches.length} launches</Link>
          </div>
        )}
      </div>
    </section>
  )
}
