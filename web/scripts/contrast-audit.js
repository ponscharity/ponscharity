/**
 * Paste into the browser console on any page of this site.
 *
 * ⚠⚠ MEASURES, rather than screenshotting. A screenshot of a low-contrast label looks like a
 * low-contrast label, which is to say it looks fine — the failure is precisely the one the eye is
 * bad at. This walks every text node, resolves the first opaque background behind it, and reports
 * anything under WCAG AA (4.5:1, or 3:1 for large text).
 *
 * ⛔ IT CANNOT SEE GRADIENTS. An element whose fill is a `linear-gradient` computes
 * `backgroundColor: transparent`, so the walk finds a dark ancestor and reports a wild failure for
 * text that is in fact near-black on near-white. `.btn--primary` and `.split__a` are both this
 * case. Check gradient surfaces by hand and do not "fix" them on this script's say-so.
 */
;(() => {
  const lum = (r, g, b) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const parse = (s) => {
    const m = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/)
    return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null
  }
  const bgOf = (el) => {
    let n = el
    while (n && n !== document.documentElement) {
      const c = parse(getComputedStyle(n).backgroundColor)
      if (c && c.a > 0.5) return c
      n = n.parentElement
    }
    return { r: 8, g: 10, b: 9, a: 1 }
  }
  const GRADIENT_EXEMPT = ['btn--primary', 'split__a']
  const out = []
  for (const el of document.querySelectorAll('body *')) {
    const txt = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join('')
    if (txt.length < 2) continue
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.display === 'none') continue
    const cls = el.className?.toString?.() ?? ''
    /* ⚠ `closest`, not a check on this element's own class. The text inside a gradient button lives
       in an unclassed <span>, so a self-only check exempts the button and then fails its label —
       two "failures" that are the same false positive wearing a different hat. */
    if (el.closest(GRADIENT_EXEMPT.map((c) => `.${c}`).join(','))) continue
    const fg = parse(cs.color)
    if (!fg) continue
    const bg = bgOf(el)
    const L1 = lum(fg.r, fg.g, fg.b), L2 = lum(bg.r, bg.g, bg.b)
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)
    const size = parseFloat(cs.fontSize)
    const large = size >= 24 || (size >= 18.66 && +cs.fontWeight >= 700)
    const need = large ? 3 : 4.5
    if (ratio < need) out.push({ text: txt.slice(0, 40), ratio: +ratio.toFixed(2), need, size, cls })
  }
  console.table(out)
  return out.length === 0 ? 'PASS — every measured pairing clears AA' : `${out.length} FAIL`
})()
