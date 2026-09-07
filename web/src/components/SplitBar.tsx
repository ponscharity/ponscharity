import { useLayoutEffect, useRef, useState } from 'react'

/**
 * The split, drawn.
 *
 * ⭐⭐ The signature object of this site, and it appears in exactly two places on purpose: in the
 * launch form where a creator sets it, and on every token card where a buyer reads it. Same shape,
 * same colours, same proportions — so the promise made at launch and the promise displayed
 * afterwards are visibly the same promise.
 *
 * ## ⛔⛔ A LABEL THAT DOES NOT FIT IS CLIPPED, NOT WRAPPED — AND IT IS CLIPPED SILENTLY
 *
 * Each half is `overflow: hidden`, so a label wider than its half loses characters against the edge
 * of the other colour. At a 92% charity share "8% creator" became "eator" pressed up against the
 * dark fill: unreadable, and it reads as a rendering fault rather than as a number. The exact split
 * a sceptic is checking has to stay legible at EVERY value, not just the comfortable middle.
 *
 * ⚠ The previous fix guarded one end only. It moved both numbers onto the pale side once the
 * charity share fell under 22%, and nothing at all happened at the other end, where the creator
 * side is the one with no room. The two ends are the same problem mirrored.
 *
 * ⭐ And the threshold cannot be a percentage. Whether "8% creator" fits in 8% of the bar depends
 * entirely on how wide the bar is — the same 22% that works in the launch form is wrong in the
 * signing panel beside it and wrong again on a phone. So this MEASURES: the bar's real width from a
 * ResizeObserver, and the label's real width from a canvas using the element's own computed font.
 * One pass, no DOM feedback loop, nothing to oscillate.
 */

/** ⚠ One canvas for the page, reused. Creating one per measurement is what makes this pattern slow. */
let ctx: CanvasRenderingContext2D | null | undefined
function textWidth(text: string, font: string): number {
  if (ctx === undefined) ctx = document.createElement('canvas').getContext('2d')
  /* ⚠ A rough estimate rather than a throw. A browser refusing a 2d context is not a reason to
     render no numbers at all — it is a reason to be slightly conservative about whether they fit. */
  if (!ctx || !font) return text.length * 7
  ctx.font = font
  return ctx.measureText(text).width
}

const fontOf = (el: Element | null) => {
  if (!el) return ''
  const cs = getComputedStyle(el)
  return `${cs.fontWeight} ${cs.fontSize}/${cs.lineHeight} ${cs.fontFamily}`
}

/**
 * A segment of the opt-in multi-part bar.
 *
 * ⭐ Opt-in on purpose. The two-part bar below is measured, tuned and used in the launch form and on
 * every card; a launch whose remainder is cut again is the exception, and the exception gets its own
 * path rather than a third case threaded through logic that is already handling four.
 */
export type SplitPart = { pct: number; label: string; tone: 'charity' | 'burn' | 'creator' }

export function SplitBar({ bps, small = false, creatorLabel = 'creator', parts }: {
  bps: number
  small?: boolean
  /**
   * ⭐⭐ THE REMAINDER, BROKEN DOWN, when the launch breaks it down.
   *
   * $CHARITY's creator half is cut again off chain — most of it buys the token back and burns it —
   * so "50% creator" is a true statement about the chain and a false one about where the money
   * goes. When this is passed the bar draws every part; when it is not, nothing changes.
   * ⛔ The percentages must sum to 100. They are shares of the WHOLE fee, not of the remainder.
   */
  parts?: SplitPart[]
  /**
   * ⭐ What the OTHER half is, when the launch says something more specific than "creator".
   *
   * On a routed launch the remainder does not go to a creator at all — it goes to an X account, to
   * a burn, or to several places at once. A bar reading "20% creator" beside a fee table reading
   * "@MEADGod 20%" makes a reader check whether those are two different twenty percents. The token
   * page knows the splits and passes the truth; a card that does not know keeps the default.
   */
  creatorLabel?: string
}) {
  const pct = Math.max(0, Math.min(100, bps / 100))
  const creatorPct = 100 - pct
  const fmt = (n: number) => (Number.isInteger(n) ? n : n.toFixed(1))

  const charityText = `${fmt(pct)}% charity`
  const creatorText = `${fmt(creatorPct)}% ${creatorLabel}`
  const bothText = `${charityText} · ${creatorText}`

  const bar = useRef<HTMLDivElement>(null)
  const aRef = useRef<HTMLDivElement>(null)
  const bRef = useRef<HTMLDivElement>(null)
  const [m, setM] = useState<{ w: number; fa: string; fb: string; pad: number } | null>(null)

  /* ⚠ Layout effect, not effect: it runs before paint, so the measured arrangement is the first
     one drawn. In a plain `useEffect` the unmeasured guess would paint first and visibly snap. */
  useLayoutEffect(() => {
    const el = bar.current
    if (!el) return
    const read = () => {
      const cs = aRef.current ? getComputedStyle(aRef.current) : null
      setM({
        w: el.clientWidth,
        fa: fontOf(aRef.current),
        fb: fontOf(bRef.current),
        /* ⭐ The real padding, both sides, read off the element — it differs between the normal and
           the small bar, and a hard-coded number here is the same mistake as a hard-coded 22%. */
        pad: cs ? parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) : 28,
      })
    }
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [small, creatorLabel])

  /*
    Four arrangements, chosen by what actually fits:

      all    100% charity — there is no creator side to label.
      roomy  each number in its own half. The one everybody sees.
      tight  the charity half is too narrow: both numbers move to the pale half.
      wide   the CREATOR half is too narrow: both numbers move to the dark half. ← was missing.

    ⚠ And a last resort under all of them: when even the combined label has nowhere to go, the
    charity percentage alone goes in whichever half is wider. A number with no word beside it is
    terse; half a word is broken.
  */
  let state: 'all' | 'roomy' | 'tight' | 'wide' | 'bare' = 'roomy'

  if (pct >= 99.5) {
    state = 'all'
  } else if (m && m.w > 0) {
    const aW = (m.w * pct) / 100
    const bW = m.w - aW
    const fits = (text: string, room: number, font: string) => textWidth(text, font) + m.pad <= room

    const aFits = fits(charityText, aW, m.fa)
    const bFits = fits(creatorText, bW, m.fb)

    if (aFits && bFits) state = 'roomy'
    else if (!aFits && fits(bothText, bW, m.fb)) state = 'tight'
    else if (!bFits && fits(bothText, aW, m.fa)) state = 'wide'
    /* ⚠ Both halves too narrow for the pair. Prefer the dark half when it is the bigger one, so the
       fallback still lands where the eye already is. */
    else if (fits(bothText, Math.max(aW, bW), aW >= bW ? m.fa : m.fb)) state = aW >= bW ? 'wide' : 'tight'
    else state = 'bare'
  }

  const bareInA = state === 'bare' && pct >= 50

  /*
    ⚠ THE MULTI-PART BAR MEASURES TOO, but it has nowhere to move a label that does not fit — with
    three segments there is no "put both on the other side". So it degrades in one step: every label
    shows, or every label drops to its bare percentage, or the whole set drops out and the bar is
    read from `aria-label`. Mixing full and bare labels across segments looked like a bug.
  */
  if (parts?.length) {
    const total = parts.reduce((n, p) => n + p.pct, 0)
    const fitsAll = m && m.w > 0 && parts.every((p) => {
      const room = (m.w * p.pct) / Math.max(total, 1)
      return textWidth(`${fmt(p.pct)}% ${p.label}`, m.fa) + m.pad <= room
    })
    const fitsPct = m && m.w > 0 && parts.every((p) => {
      const room = (m.w * p.pct) / Math.max(total, 1)
      return textWidth(`${fmt(p.pct)}%`, m.fa) + m.pad <= room
    })
    return (
      <div
        ref={bar}
        className={`split split--multi${small ? ' split--sm' : ''}`}
        role="img"
        aria-label={parts.map((p) => `${fmt(p.pct)}% ${p.label}`).join(', ')}
      >
        {parts.map((p, i) => (
          /* ⛔ A bare text node inside, never a wrapper element — a wrapper becomes a flex item with
             `min-width: auto` and the segment stops honouring its own width. Same trap as below. */
          <div
            key={i}
            ref={i === 0 ? aRef : undefined}
            className={`split__seg split__seg--${p.tone}`}
            style={{ width: `${(p.pct / Math.max(total, 1)) * 100}%` }}
          >
            {fitsAll ? `${fmt(p.pct)}% ${p.label}` : fitsPct ? `${fmt(p.pct)}%` : ''}
          </div>
        ))}
      </div>
    )
  }

  return (
    <div
      ref={bar}
      className={`split${small ? ' split--sm' : ''}`}
      role="img"
      aria-label={`${fmt(pct)}% to the charity, ${fmt(creatorPct)}% to ${creatorLabel}`}
    >
      {/* ⛔⛔ A BARE TEXT NODE, NEVER A <span>. Both halves are `display: flex`, so a wrapper element
          becomes a flex ITEM with its own `min-width: auto`, and the dark half stopped honouring its
          own `width: <pct>%` — it took the whole bar at every split. Text goes in an anonymous flex
          item, which has no such minimum. The wrapper was there to keep the two halves structurally
          identical and it cost the thing they exist to show. */}
      <div ref={aRef} className="split__a" style={{ width: `${pct}%` }}>
        {state === 'roomy' || state === 'all'
          ? charityText
          : state === 'wide'
            ? bothText
            : bareInA
              ? `${fmt(pct)}%`
              : ''}
      </div>
      {state !== 'all' && (
        <div ref={bRef} className="split__b">
          {state === 'roomy'
            ? creatorText
            : state === 'tight'
              ? bothText
              : state === 'bare' && !bareInA
                ? `${fmt(pct)}% charity`
                : ''}
        </div>
      )}
    </div>
  )
}
