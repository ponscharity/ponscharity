import { useEffect, useState } from 'react'
import { type Launch } from '../lib/launchpad.ts'
import { formatUsd } from '../lib/marketCap.ts'
import { charityByConfig, loadCharities } from '../lib/charities.ts'
import { loadDonatedByLaunch } from '../lib/donations.ts'
import { tokenHref } from '../lib/router.ts'
import { Link } from './Link.tsx'
import { TokenImage } from './TokenImage.tsx'

/**
 * One launch, as a card.
 *
 * ## ⭐⭐ WHAT A PONS CARD SHOWS, AND THE ONE THING IT CANNOT
 *
 * Pons's own launch card is art, name, ticker and market cap, and that is the right shape: at a
 * glance somebody is choosing what to look at, and the art does most of that work. This borrows the
 * shape.
 *
 * ➤ But a card here that stopped there would be a Pons card. The whole claim of this site is WHICH
 * CHARITY a token pays, so the charity is on the card, named, resolved from the id recorded on
 * chain. A launchpad whose distinguishing feature is invisible until you click through has hidden
 * the only thing it is for.
 *
 * ⚠ The name is looked up, not stored. The chain records a donate.gg config id; the directory turns
 * it into a name. Until that resolves the card shows the split rather than a placeholder that would
 * shift the layout when it arrives.
 */

/* ⚠ One shared load for every card on the page. `loadCharities` already dedupes a concurrent call
   behind one promise, so twenty cards mounting together make one request, not twenty. */
function useCharityName(charityId: string): string | null {
  const [name, setName] = useState<string | null>(null)
  useEffect(() => {
    if (!charityId || /^0x0+$/.test(charityId)) return
    let live = true
    void loadCharities()
      .then((cs) => { if (live) setName(charityByConfig(cs, charityId)?.name ?? null) })
      .catch(() => {})
    return () => { live = false }
  }, [charityId])
  return name
}

/* ⚠ Shares one load across the whole grid, like `useCharityName` above. */
function useDonated(token: string): bigint {
  const [usdc, setUsdc] = useState(0n)
  useEffect(() => {
    let live = true
    void loadDonatedByLaunch()
      .then((m) => { if (live) setUsdc(m.get(token.toLowerCase()) ?? 0n) })
      .catch(() => {})
    return () => { live = false }
  }, [token])
  return usdc
}

export function TokenCard({ l }: { l: Launch }) {
  const charity = useCharityName(l.charityId)
  const donated = useDonated(l.token)

  return (
    <Link className="tcard" to={tokenHref(l.token)}>
      <div className="tcard__art">
        <TokenImage uri={l.logo} symbol={l.symbol} className="tcard__img" />
        {/* ⚠ Overlaid on the art rather than given a row, so every card is the same height whether
            or not it has graduated. A badge that pushes the body down makes a grid of cards ripple. */}
        {l.graduated && <span className="tcard__badge">Graduated</span>}
      </div>

      <div className="tcard__body">
        {/* ⚠ Ticker first. It is what a token is referred to as and what somebody scans a grid
            looking for; the name is the fuller label under it. */}
        <div className="tcard__sym mono">${l.symbol}</div>
        <div className="tcard__name">{l.name}</div>

        {/* ⛔ USD, like every cap on this site. A cap in the pair asset is a reserve balance wearing
            a market cap, and two tokens paired against different assets cannot be compared. */}
        <div className="tcard__cap">
          {formatUsd(l.marketCapUsd) ?? <span className="tcard__dash">&mdash;</span>}
          <span className="tcard__capk">Market cap</span>
        </div>

        {/*
          ⚠⚠ A SIBLING UNDER THE CAP, NOT A CHILD OF IT. `.tcard__cap` is a flex ROW holding the
          figure and its label side by side, so a third child is laid out beside them and squeezed:
          measured live, this span got 39px of a 168px row and rendered as "$19…".

          ⚠ Always rendered, empty when there is nothing yet, so a card that has donated is not
          taller than one that has not — the same reason the graduated badge is overlaid on the art.

          ⛔ Empty, never "nothing donated yet", which would be false: fees are swept, harvested and
          bridged before they can be donated, so a launch with money genuinely on its way would be
          captioned as having raised nothing.
        */}
        <span className="tcard__gave">
          {donated > 0n ? `${formatUsd(donated)} donated` : ''}
        </span>

        <div className="tcard__pays">
          {/* ⭐ The claim the whole site turns on. Held to two lines so a long charity name cannot
              make one card taller than its neighbours. */}
          <span className="tcard__paysk">Charity</span>
          <span className="tcard__paysv">{charity ?? 'a charity named on chain'}</span>
        </div>
      </div>
    </Link>
  )
}
