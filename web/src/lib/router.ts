import { useEffect, useState, type MouseEvent } from 'react'
import { isAddress, type Address } from 'viem'

/**
 * Real paths, no hash.
 *
 * ⚠⚠ THIS ONLY WORKS BECAUSE CADDY FALLS BACK TO index.html. `try_files {path} /index.html` is what
 * makes `/explore` load the app instead of 404ing, and it is not optional: without it every link
 * works in the app and every REFRESH and every shared link is a 404. The deploy and this file are a
 * pair.
 *
 * ⭐ In-page anchors still work: `#how` is a fragment, not a path, so it is left to the browser on
 * the home page and turned into a navigation plus a scroll from anywhere else.
 */
export type Route =
  | { name: 'home' }
  | { name: 'launch' }
  | { name: 'explore' }
  | { name: 'charities' }
  | { name: 'how' }
  | { name: 'mine' }
  | { name: 'claim' }
  | { name: 'token'; address: Address }

export function parsePath(pathname: string): Route {
  const p = pathname.replace(/\/+$/, '') || '/'
  if (p === '/launch') return { name: 'launch' }
  if (p === '/explore') return { name: 'explore' }
  if (p === '/charities') return { name: 'charities' }
  if (p === '/how-it-works') return { name: 'how' }
  if (p === '/my-tokens') return { name: 'mine' }
  if (p === '/claim') return { name: 'claim' }
  if (p.startsWith('/token/')) {
    const a = p.slice('/token/'.length).split('/')[0] ?? ''
    /* ⚠ Validated here, not in the page. A malformed address in the URL would otherwise reach viem
       as a contract call and surface as an unreadable RPC error instead of "no such token". */
    if (isAddress(a)) return { name: 'token', address: a as Address }
  }
  return { name: 'home' }
}

export function navigate(to: string) {
  const [path, hash] = to.split('#')
  const target = path || location.pathname
  if (target !== location.pathname) {
    history.pushState({}, '', hash ? `${target}#${hash}` : target)
    window.dispatchEvent(new PopStateEvent('popstate'))
    if (hash) {
      /* ⚠⚠ Scrolled AFTER the render, not by the browser. Arriving at an anchor from another page,
         the section does not exist at the moment the browser would scroll to it, so the native jump
         silently does nothing and the visitor lands at the top of a page they navigated into the
         middle of. */
      requestAnimationFrame(() => {
        requestAnimationFrame(() => document.getElementById(hash)?.scrollIntoView({ block: 'start' }))
      })
    } else {
      window.scrollTo(0, 0)
    }
  } else if (hash) {
    document.getElementById(hash)?.scrollIntoView({ block: 'start' })
    history.replaceState({}, '', `${target}#${hash}`)
  }
}

/**
 * ⚠ Modified clicks are left alone. Cmd-click, middle-click and shift-click are how people open
 * things in a new tab, and swallowing them is the most common way an SPA router breaks the browser.
 */
export function onNavClick(to: string) {
  return (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    navigate(to)
  }
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parsePath(location.pathname))
  useEffect(() => {
    const on = () => setRoute(parsePath(location.pathname))
    window.addEventListener('popstate', on)
    return () => window.removeEventListener('popstate', on)
  }, [])
  return route
}

export const tokenHref = (a: string) => `/token/${a}`
export const EXPLORE = '/explore'
export const CHARITIES_PAGE = '/charities'
export const LAUNCH = '/launch'
export const HOME = '/'
/* ⚠ A real page, not the `#how` fragment it used to be. The anchor only resolved on the home page
   and had to be turned into a navigation plus a scroll from anywhere else; a path needs neither. */
export const HOW = '/how-it-works'
export const MY_TOKENS = '/my-tokens'
export const CLAIM = '/claim'
