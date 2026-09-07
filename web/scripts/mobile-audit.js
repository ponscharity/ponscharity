/**
 * Paste into the console. Measures the real mobile layout at 390x844.
 *
 * ## ⛔⛔ WHY IT USES AN IFRAME
 *
 * Resizing the browser window does NOT give you a 390px viewport — the OS and the window chrome
 * impose a minimum, and the page keeps rendering at ~1373px while every number you collect looks
 * like a real measurement. An iframe with `width=390` genuinely drives the media queries, so what
 * is measured inside it is what a phone gets.
 *
 * ⚠ It reports the HIT AREA of controls, not their painted size. The two differ, and the difference
 * is where the bugs live: this found a range input four pixels tall, which looked exactly right on
 * screen because the hairline track is meant to be four pixels.
 */
;(async () => {
  const W = 390, H = 844
  document.querySelectorAll('#mharness').forEach((n) => n.remove())
  const f = document.createElement('iframe')
  f.id = 'mharness'; f.width = W; f.height = H; f.src = location.origin + '/'
  f.style.cssText = 'position:fixed;left:-9999px;top:0;border:0'
  document.body.appendChild(f)
  await new Promise((r) => { f.onload = r; setTimeout(r, 4000) })
  await new Promise((r) => setTimeout(r, 1200))

  const d = f.contentDocument
  const vw = d.documentElement.clientWidth
  const overflowing = []
  for (const el of d.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect()
    if (r.width === 0) continue
    if (r.right > vw + 1 || r.left < -1) {
      overflowing.push({ tag: el.tagName, cls: (el.className?.toString?.() || '').slice(0, 30), right: Math.round(r.right) })
    }
  }
  const undersized = []
  for (const el of d.querySelectorAll('a,button,input,select,textarea')) {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    if (r.height < 44) {
      undersized.push({ tag: el.tagName, cls: (el.className?.toString?.() || '').slice(0, 26), h: Math.round(r.height), text: (el.textContent || '').trim().slice(0, 18) })
    }
  }
  console.table(overflowing); console.table(undersized)
  f.remove()
  const ok = overflowing.length === 0 && undersized.length === 0
  return { viewport: vw, horizontalOverflow: d.documentElement.scrollWidth > vw + 1, overflowing: overflowing.length, undersized: undersized.length, verdict: ok ? 'PASS' : 'FAIL' }
})()
