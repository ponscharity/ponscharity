import { useEffect, useMemo, useRef, useState } from 'react'
import { charityPage, loadCharities, loadedCharities, searchCharities, type Charity } from '../lib/charities.ts'
import { checkCharityAddress, chunkAddress, type AddressReport } from '../lib/addressChecks.ts'
import {
  loadCharityStats, loadedCharityStats, paidParts, plural, statFor, type StatIndex,
} from '../lib/charityStats.ts'
import { REMIT_VAULT, ZERO_ID, vaultConfigured } from '../lib/launchpad.ts'

/**
 * ⛔ What THIS launchpad has paid the charity, never donate.gg's lifetime total.
 *
 * The row used to read `$1.2m raised` while somebody was choosing who to launch for, which is the
 * worst possible place for a figure that is not ours: it reads as what launching here achieves.
 * A charity nobody has launched for shows nothing, because silence is the honest form of nothing.
 */
function pickStat(stats: StatIndex, configId: string) {
  const st = statFor(stats, configId)
  if (!st) return null
  const parts = paidParts(st)
  return parts.length > 0 ? `${parts.join(' · ')} paid here` : `${plural(st.launches, 'launch', 'launches')} here`
}

/**
 * Choosing who gets the money.
 *
 * ⭐⭐ A CHARITY IS PICKED, NEVER TYPED. Selecting one records its donate.gg config id in the launch
 * contract, immutably, and that is the promise: anybody can read the id off chain and look it up.
 * The account the money passes through on the way is operated by us; who it is destined for is not,
 * and that is the distinction the whole design turns on.
 *
 * ⚠ The second path stays for a charity that publishes its own wallet, because a local charity
 * nobody has heard of is still a charity. That path pays the address directly, with no processor
 * and nothing operated in the middle, so it keeps the address checks and the confirmation tick.
 */
export function CharityPicker({
  value, charityId, onChange, onValidity,
}: {
  value: string
  charityId: string
  onChange: (v: { address: string; charityId: string }) => void
  onValidity: (ok: boolean) => void
}) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [manual, setManual] = useState(false)
  const [report, setReport] = useState<AddressReport | null>(null)
  const [checking, setChecking] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  /* ⚠ Loaded when the picker first mounts, not at page load: the directory is a megabyte and
     nobody browsing the home page needs it. */
  const [all, setAll] = useState<Charity[]>(() => loadedCharities() ?? [])
  useEffect(() => {
    if (all.length) return
    let live = true
    void loadCharities().then((cs) => { if (live) setAll(cs) }).catch(() => {})
    return () => { live = false }
  }, [all.length])

  /* ⚠ Loaded beside the directory and allowed to fail on its own. A launcher must be able to pick a
     charity whether or not the register read succeeded. */
  const [stats, setStats] = useState<StatIndex>(() => loadedCharityStats() ?? {})
  useEffect(() => {
    let live = true
    void loadCharityStats().then((s) => { if (live) setStats(s) })
    return () => { live = false }
  }, [])

  const results = useMemo(() => searchCharities(all, q, 40), [all, q])
  /* ⚠ Derived from the id rather than held in its own state. Two sources of truth for "which
     charity is this" drift the moment one of them is set without the other. */
  const picked: Charity | undefined = useMemo(
    () => all.find((c) => c.configId.toLowerCase() === charityId.toLowerCase()),
    [all, charityId],
  )

  useEffect(() => {
    function away(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [])

  /* ⚠ Only a directly named wallet is checked on chain. A listed charity is paid through the relay,
     so there is no counterparty address to inspect, and running the checks against our own vault
     would report three green ticks that mean nothing about the charity. */
  useEffect(() => {
    if (picked || !value.trim()) { setReport(null); setConfirmed(false); return }
    let live = true
    setChecking(true)
    const t = setTimeout(() => {
      void checkCharityAddress(value).then((r) => { if (live) { setReport(r); setChecking(false) } })
    }, 300)
    return () => { live = false; clearTimeout(t) }
  }, [value, picked])

  useEffect(() => {
    if (picked) { onValidity(true); return }
    onValidity(!!report?.passable && !checking && confirmed)
  }, [picked, report, checking, confirmed, onValidity])

  const stops = report?.checks.filter((c) => c.severity === 'stop') ?? []

  function choose(c: Charity) {
    /* ⭐ The vault is where the money lands on this chain; the config id is who it is for. Both are
       written into the launch together and neither can be changed afterwards. */
    onChange({ address: REMIT_VAULT, charityId: c.configId })
    setManual(false); setQ(''); setOpen(false)
  }

  return (
    <div className="field">
      <label className="field__l" htmlFor="charity-search">Charity</label>

      {picked ? (
        <div className="chosen">
          <div className="chosen__top">
            <img className="chosen__logo" src={picked.logo} alt=""
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden' }} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="chosen__name">{picked.name}</div>
              <div className="chosen__meta">
                {picked.place}{picked.ein && ` · EIN ${picked.ein}`}
              </div>
              <p className="chosen__cause">{picked.mission}</p>
            </div>
            <button type="button" className="btn btn--sm"
              onClick={() => { onChange({ address: '', charityId: ZERO_ID }); setManual(false) }}>
              Change
            </button>
          </div>
          <div className="chosen__addr">
            <span className="mono">{picked.configId}</span>
            <a href={charityPage(picked)} target="_blank" rel="noreferrer noopener">
              View on donate.gg
            </a>
          </div>
        </div>
      ) : (
        <div ref={boxRef} style={{ position: 'relative' }}>
          <input id="charity-search" className="input" placeholder="Search charities"
            value={q} autoComplete="off"
            onChange={(e) => { setQ(e.target.value); setOpen(true) }}
            onFocus={() => setOpen(true)} />
          {open && (
            <div className="pick">
              {vaultConfigured() && results.map((c) => (
                <button key={c.slug} type="button" className="pick__row" onClick={() => choose(c)}>
                  <img className="pick__logo" src={c.logo} alt=""
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden' }} />
                  <span style={{ minWidth: 0 }}>
                    <span className="pick__name">
                      {c.name}
                      {pickStat(stats, c.configId) && (
                        <span className="pick__assets">{pickStat(stats, c.configId)}</span>
                      )}
                    </span>
                    <span className="pick__cause">{c.mission}</span>
                  </span>
                </button>
              ))}
              {vaultConfigured() && results.length === 0 && (
                <div className="pick__none">
                  {all.length === 0 ? 'Loading charities' : 'Nothing matches that.'}
                </div>
              )}
              {!vaultConfigured() && (
                <div className="pick__none">
                  Listed charities are paid through a vault this deployment has not set yet. Use a
                  charity's own wallet below in the meantime.
                </div>
              )}
              <button type="button" className="pick__row pick__row--other"
                onClick={() => { setManual(true); setOpen(false); onChange({ address: '', charityId: ZERO_ID }) }}>
                <span style={{ minWidth: 0 }}>
                  <span className="pick__name">A charity with its own wallet</span>
                  <span className="pick__cause">
                    Paid straight to an address they published. Nothing passes through us.
                  </span>
                </span>
              </button>
              <div className="pick__foot">
                {all.length.toLocaleString('en-US')} charities, paid through donate.gg's public donation
                relay. Any figure on a row is what launches here have paid toward that charity. Being
                listed is not an endorsement.
              </div>
            </div>
          )}
        </div>
      )}

      {manual && !picked && (
        <div style={{ marginTop: 12 }}>
          <input className="input mono" placeholder="0x" value={value} autoFocus autoComplete="off"
            onChange={(e) => onChange({ address: e.target.value, charityId: ZERO_ID })} />
          <p className="field__h">
            Take this from the charity themselves. It is written into the contract when you sign and
            can never be changed afterwards, by you or by anyone else.
          </p>
        </div>
      )}

      {checking && <p className="field__h">Checking that address</p>}

      {report && !checking && !picked && (
        <div className={`verdict${stops.length ? ' verdict--stop' : ''}`}>
          {report.checksummed && (
            <>
              <div className="verdict__k">Read this back against the source</div>
              <div className="chunks">
                {chunkAddress(report.checksummed).map((c, i) => <span key={i}>{c}</span>)}
              </div>
            </>
          )}
          <ul className="checks">
            {report.checks.map((c) => (
              <li key={c.id} className={`check check--${c.severity}`}>
                <span className="check__mark" aria-hidden="true" />
                <span><b>{c.label}</b>{c.detail && <span className="check__detail">{c.detail}</span>}</span>
              </li>
            ))}
          </ul>
          {report.passable && (
            <label className="confirm">
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              <span>
                I took this address from the charity and I have compared every character. I
                understand it cannot be changed after this launch.
              </span>
            </label>
          )}
        </div>
      )}
    </div>
  )
}
