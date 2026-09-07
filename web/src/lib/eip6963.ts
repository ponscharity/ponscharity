/**
 * EIP-6963 multi-injected provider discovery.
 *
 * The old way — reading `window.ethereum` — breaks as soon as someone has two wallet extensions
 * installed: they fight over the same global and whichever loaded last wins, so the user gets
 * MetaMask when they asked for Rabby. EIP-6963 has each wallet announce itself with a name, icon
 * and stable `rdns`, which is what lets us show a real picker.
 *
 * No dependencies: the whole protocol is two events.
 */

export type ProviderRpcError = Error & { code?: number }

export type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
  on?: (event: string, handler: (...args: never[]) => void) => void
  removeListener?: (event: string, handler: (...args: never[]) => void) => void
}

export type ProviderInfo = {
  uuid: string
  name: string
  icon: string
  rdns: string
}

export type ProviderDetail = {
  info: ProviderInfo
  provider: Eip1193Provider
}

const detected = new Map<string, ProviderDetail>()
const listeners = new Set<(list: ProviderDetail[]) => void>()
let started = false

function emit() {
  const list = [...detected.values()]
  listeners.forEach((fn) => fn(list))
}

/**
 * Starts listening. Safe to call repeatedly.
 *
 * Order matters: subscribe to `announceProvider` *before* dispatching `requestProvider`, or the
 * synchronous replies from already-loaded wallets are missed.
 */
export function startDiscovery() {
  if (started || typeof window === 'undefined') return
  started = true

  window.addEventListener('eip6963:announceProvider', ((event: CustomEvent<ProviderDetail>) => {
    const detail = event.detail
    if (!detail?.info?.uuid) return
    detected.set(detail.info.uuid, detail)
    emit()
  }) as EventListener)

  window.dispatchEvent(new Event('eip6963:requestProvider'))

  // Some extensions inject late. Re-ask a couple of times rather than showing an empty picker.
  setTimeout(() => window.dispatchEvent(new Event('eip6963:requestProvider')), 300)
  setTimeout(() => window.dispatchEvent(new Event('eip6963:requestProvider')), 1200)
}

export function getProviders(): ProviderDetail[] {
  return [...detected.values()]
}

export function subscribe(fn: (list: ProviderDetail[]) => void): () => void {
  listeners.add(fn)
  fn(getProviders())
  return () => listeners.delete(fn)
}

export function providerByRdns(rdns: string): ProviderDetail | undefined {
  return [...detected.values()].find((p) => p.info.rdns === rdns)
}

/**
 * A wallet that only supports the legacy global, exposed so it is still reachable.
 *
 * Kept separate from the discovered list and only used when discovery found nothing, so a modern
 * wallet is never shadowed by the global.
 */
export function legacyProvider(): ProviderDetail | null {
  const eth = (window as unknown as { ethereum?: Eip1193Provider }).ethereum
  if (!eth) return null
  return {
    info: {
      uuid: 'legacy-injected',
      name: 'Injected wallet',
      icon: '',
      rdns: 'legacy.injected',
    },
    provider: eth,
  }
}

/** Well-known wallets, so an empty picker can still point somewhere useful. */
export const INSTALL_LINKS = [
  { name: 'MetaMask', url: 'https://metamask.io/download/' },
  { name: 'Rabby', url: 'https://rabby.io/' },
  { name: 'Trust Wallet', url: 'https://trustwallet.com/browser-extension' },
  { name: 'OKX Wallet', url: 'https://www.okx.com/web3' },
] as const

declare global {
  interface WindowEventMap {
    'eip6963:announceProvider': CustomEvent<ProviderDetail>
  }
}
