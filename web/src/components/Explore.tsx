import { useMemo, useState } from 'react'
import type { Launch } from '../lib/launchpad.ts'
import { LedgerSection, type Sort } from './LedgerSection.tsx'

/**
 * The dashboard: every token launched here, split by whether it still trades on its bonding curve.
 *
 * ## ⛔⛔ A LAUNCH APPEARS IN EXACTLY ONE SECTION
 *
 * Graduated tokens are removed from the curve list rather than shown in both. They are different
 * things: one has a curve you can still buy on, the other has a Uniswap V4 pool. A launch appearing
 * twice would also double every count on the page.
 *
 * ## ⚠ WHAT IS NOT HERE, AND WHY
 *
 * No volume, no 24 hour filter, no trending. All of those need trade history, and this chain's
 * public RPC caps `eth_getLogs` at about 2,000 blocks, roughly three minutes. Shipping those
 * controls would mean shipping pills that quietly reorder nothing.
 */
export function Explore({ launches, loading }: { launches: Launch[]; loading: boolean }) {
  const [curveSort, setCurveSort] = useState<Sort>('newest')
  const [gradSort, setGradSort] = useState<Sort>('raised')

  const graduated = useMemo(() => launches.filter((l) => l.graduated), [launches])
  const onCurve = useMemo(() => launches.filter((l) => !l.graduated), [launches])

  return (
    <section className="page">
      <div className="wrap">
        {/* ⚠ The centred `chead` pattern, matching launch, charities and how it works. Every page
            title on the site is now set the same way. */}
        <div className="chead">
          <p className="eyebrow" style={{ justifyContent: 'center' }}>Explore</p>
          <h1 className="chead__h">Every token launched here</h1>
          <p className="chead__sub">
            Every token is paired with a charity and donates a fixed share of every trade.
          </p>
        </div>

        <LedgerSection
          title="Graduated" blurb="Tokens that graduated."
          rows={graduated} loading={loading}
          sort={gradSort} onSort={setGradSort}
          empty="No token has graduated yet."
        />

        <LedgerSection
          title="On the curve" blurb="Tokens still climbing toward graduation."
          rows={onCurve} loading={loading}
          sort={curveSort} onSort={setCurveSort}
          empty="Nothing has been launched yet."
        />
      </div>
    </section>
  )
}
