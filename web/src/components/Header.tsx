import { useState } from 'react'
import { WalletModal } from './WalletModal.tsx'
import { ProfileMenu } from './ProfileMenu.tsx'
import { CHARITIES_PAGE, EXPLORE, HOME, HOW, LAUNCH, type Route } from '../lib/router.ts'
import { Link } from './Link.tsx'

/** ⚠ Same 24x24 viewBox and `fill` behaviour as {@link XIcon}, so the two sit on the same optical
 *  baseline in the footer without either needing its own sizing rule. */
export function GithubIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.55v-2.1c-3.2.7-3.88-1.37-3.88-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.2 1.77 1.2 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.12 3.05.74.81 1.18 1.84 1.18 3.1 0 4.43-2.69 5.4-5.25 5.69.41.36.78 1.06.78 2.14v3.17c0 .3.2.66.8.55A11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  )
}

export function XIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M18.9 2H22l-7.1 8.1L23.2 22h-6.5l-5.1-6.6L5.8 22H2.6l7.6-8.7L1.6 2h6.7l4.6 6.1L18.9 2Zm-1.1 18h1.8L7.3 3.9H5.4L17.8 20Z" />
    </svg>
  )
}

const ITEMS = [
  { href: LAUNCH, label: 'Launch', on: (r: Route) => r.name === 'launch' },
  { href: EXPLORE, label: 'Explore', on: (r: Route) => r.name === 'explore' || r.name === 'token' },
  { href: CHARITIES_PAGE, label: 'Charities', on: (r: Route) => r.name === 'charities' },
  { href: HOW, label: 'How it works', on: (r: Route) => r.name === 'how' },
] as const

/**
 * ⭐ A segmented control, not a row of links. The three destinations are one choice, so they sit in
 * one recessed track with the current one raised out of it. It also gives the header a centre of
 * gravity, which a row of evenly spaced links never has.
 */
function Nav({ route }: { route: Route }) {
  return (
    <nav className="seg" aria-label="Sections">
      {ITEMS.map((it) => {
        const on = it.on(route)
        return (
          <Link key={it.href} to={it.href}
            className={`seg__item${on ? ' is-on' : ''}`}
            aria-current={on ? 'page' : undefined}>
            {it.label}
          </Link>
        )
      })}
    </nav>
  )
}

export function Header({ route }: { route: Route }) {
  const [picker, setPicker] = useState(false)
  return (
    <header className="hdr">
      <div className="hdr__in">
        <Link className="hdr__brand" to={HOME}>
          <span className="hdr__tile"><span className="mark"><img src="/logo.png" alt="" /></span></span>
          <span className="hdr__name">Pons Charity</span>
        </Link>

        <Nav route={route} />

        <div className="hdr__right">
          <ProfileMenu onOpenPicker={() => setPicker(true)} />
        </div>
      </div>
      {picker && <WalletModal onClose={() => setPicker(false)} />}
    </header>
  )
}
