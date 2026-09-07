import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createWalletClient, custom, type Address, type WalletClient } from 'viem'
import { rhc } from './chain.ts'
import {
  startDiscovery, getProviders, subscribe, legacyProvider,
  type Eip1193Provider, type ProviderDetail, type ProviderRpcError,
} from './eip6963.ts'

/**
 * ⛔⛔ EIP-6963, NOT `window.ethereum`.
 *
 * With several extensions installed they fight over that one property and whoever loaded last wins,
 * so `window.ethereum` silently picks a wallet FOR the user — usually not the one holding their
 * money. 6963 has every wallet announce itself and lets the person choose. The legacy object is
 * kept only as a last resort, clearly labelled, for a wallet too old to announce.
 */
const CHAIN_HEX = `0x${rhc.id.toString(16)}` as const
const STORAGE_KEY = 'ponscharity.wallet.rdns'

type Ctx = {
  address: Address | null
  chainId: number | null
  onRightChain: boolean
  providers: ProviderDetail[]
  connecting: boolean
  error: string | null
  connect: (d: ProviderDetail) => Promise<void>
  disconnect: () => void
  switchAccount: () => Promise<void>
  switchChain: () => Promise<void>
  walletClient: WalletClient | null
}

const WalletCtx = createContext<Ctx | null>(null)

/**
 * Ask the wallet for accounts, always giving the person the choice.
 *
 * ## ⛔⛔ WHY NOT JUST `eth_requestAccounts`
 *
 * Once a site is authorised that call resolves SILENTLY with the accounts already permitted. No
 * prompt, no picker, and the same address as last time. Somebody who has switched to a different
 * account in MetaMask and presses Connect sees nothing happen and gets the account they were trying
 * to leave, because MetaMask only ever reports accounts this site has permission for — switching in
 * the wallet does not grant anything, and does not even fire `accountsChanged`.
 *
 * ➤ `wallet_requestPermissions` re-opens the picker every time, and its RESULT names exactly what
 * was just granted. That list is the answer, not whatever `eth_accounts` happens to order first.
 */
async function pickAccounts(p: Eip1193Provider): Promise<string[]> {
  try {
    const granted = (await p.request({
      method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }],
    })) as { parentCapability?: string; caveats?: { type?: string; value?: unknown }[] }[]

    /* ⚠ Read out of the caveat rather than calling `eth_accounts` afterwards. The permission result
       is the authoritative list of what the person just chose; a follow-up read can come back in a
       different order and hand back the old account again. */
    const accounts = granted
      ?.find((g) => g.parentCapability === 'eth_accounts')
      ?.caveats?.map((c) => c.value)
      .flat()
      .filter((v): v is string => typeof v === 'string' && v.startsWith('0x'))
    if (accounts?.length) return accounts
  } catch (e) {
    /* ⛔ 4001 is the person closing the picker. That is an answer, not a failure to fall through
       from: falling back here would silently connect the very account they declined to keep. */
    if ((e as ProviderRpcError)?.code === 4001) throw e
    /* Anything else means the wallet does not implement it, which is allowed. */
  }
  return (await p.request({ method: 'eth_requestAccounts' })) as string[]
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [providers, setProviders] = useState<ProviderDetail[]>([])
  const [active, setActive] = useState<ProviderDetail | null>(null)
  const [address, setAddress] = useState<Address | null>(null)
  const [chainId, setChainId] = useState<number | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    startDiscovery()
    setProviders(getProviders())
    return subscribe(setProviders)
  }, [])

  /* ⛔⛔ LISTENERS ARE TRACKED SO THEY CAN BE REMOVED. `on` without a matching `removeListener` leaks
     a set per connect: connect twice and two handlers fire, and after a disconnect the OLD provider
     is still listening and can push an address back into a site the user just signed out of. */
  const detach = useRef<(() => void) | null>(null)

  const attach = useCallback((p: Eip1193Provider) => {
    detach.current?.()
    const onAccounts = (accs: unknown) => {
      const list = accs as string[]
      /* ⚠ An empty array means the user disconnected IN THE WALLET. Treated as a disconnect rather
         than ignored, or the site keeps showing an address that can no longer sign anything. */
      if (!list?.length) { setAddress(null); setActive(null); localStorage.removeItem(STORAGE_KEY) }
      else setAddress(list[0] as Address)
    }
    const onChain = (id: unknown) => setChainId(Number(id))
    p.on?.('accountsChanged', onAccounts)
    p.on?.('chainChanged', onChain)
    detach.current = () => {
      p.removeListener?.('accountsChanged', onAccounts)
      p.removeListener?.('chainChanged', onChain)
      detach.current = null
    }
  }, [])

  const connect = useCallback(async (d: ProviderDetail) => {
    setConnecting(true)
    setError(null)
    try {
      const accs = await pickAccounts(d.provider)
      const id = (await d.provider.request({ method: 'eth_chainId' })) as string
      setActive(d)
      setAddress((accs[0] ?? null) as Address | null)
      setChainId(Number(id))
      attach(d.provider)
      localStorage.setItem(STORAGE_KEY, d.info.rdns)
    } catch (e) {
      const err = e as ProviderRpcError
      /* ⚠ 4001 is the user closing the popup. It is not an error worth a red banner — showing one
         for a deliberate "no" trains people to distrust the real messages. */
      setError(err?.code === 4001 ? null : err?.message ?? 'Could not connect')
    } finally {
      setConnecting(false)
    }
  }, [attach])

  /* Reconnect silently to the wallet last used, but only if it is already authorised. ⛔ Never
     `eth_requestAccounts` on load — that pops a wallet the moment somebody opens the page. */
  useEffect(() => {
    const rdns = localStorage.getItem(STORAGE_KEY)
    if (!rdns || address) return
    const d = providers.find((p) => p.info.rdns === rdns)
    if (!d) return
    void (async () => {
      try {
        const accs = (await d.provider.request({ method: 'eth_accounts' })) as string[]
        if (!accs?.length) return
        const id = (await d.provider.request({ method: 'eth_chainId' })) as string
        setActive(d); setAddress(accs[0] as Address); setChainId(Number(id)); attach(d.provider)
      } catch { /* a wallet that will not answer eth_accounts is simply not reconnected */ }
    })()
  }, [providers, address, attach])

  /**
   * ⛔⛔ CLEARING LOCAL STATE IS NOT DISCONNECTING.
   *
   * The wallet stays authorised, so the next Connect resolves silently with the same account and
   * the person is back where they started with no prompt. This revokes the `eth_accounts`
   * permission, which is what makes the wallet ask again.
   *
   * ⚠ Best effort. `wallet_revokePermissions` is MetaMask 11.6 and later and not universal, so a
   * wallet without it still disconnects locally — and `connect` requests the permission explicitly,
   * which re-opens the picker either way.
   */
  /**
   * Change which account this site uses, without disconnecting first.
   *
   * ⚠⚠ THIS IS THE ONE THE REPORT WAS ABOUT. Switching account inside MetaMask does not tell a site
   * anything: the site keeps the account it has permission for, `accountsChanged` never fires
   * because nothing about the permission changed, and Connect looks broken because it resolves
   * silently with the old address. Re-requesting the permission is the only way to move.
   */
  const switchAccount = useCallback(async () => {
    const d = active ?? providers[0]
    if (!d) return
    setConnecting(true); setError(null)
    try {
      const accs = await pickAccounts(d.provider)
      const id = (await d.provider.request({ method: 'eth_chainId' })) as string
      setActive(d)
      setAddress((accs[0] ?? null) as Address | null)
      setChainId(Number(id))
      attach(d.provider)
      localStorage.setItem(STORAGE_KEY, d.info.rdns)
    } catch (e) {
      const err = e as ProviderRpcError
      setError(err?.code === 4001 ? null : err?.message ?? 'Could not switch account')
    } finally { setConnecting(false) }
  }, [active, providers, attach])

  const disconnect = useCallback(() => {
    const p = active?.provider
    detach.current?.()
    setActive(null); setAddress(null); setChainId(null)
    localStorage.removeItem(STORAGE_KEY)
    void p?.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] }).catch(() => {})
  }, [active])

  const switchChain = useCallback(async () => {
    if (!active) return
    try {
      await active.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_HEX }] })
    } catch (e) {
      /* 4902 = the wallet has never heard of this chain. Adding it is the only way forward, and it
         is a separate call the user must also approve. */
      if ((e as ProviderRpcError)?.code === 4902) {
        await active.provider.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: CHAIN_HEX,
            chainName: rhc.name,
            nativeCurrency: rhc.nativeCurrency,
            rpcUrls: [rhc.rpcUrls.default.http[0]],
            blockExplorerUrls: [rhc.blockExplorers!.default.url],
          }],
        })
      } else throw e
    }
  }, [active])

  const walletClient = useMemo(
    () => (active && address ? createWalletClient({ account: address, chain: rhc, transport: custom(active.provider) }) : null),
    [active, address],
  )

  const all = useMemo(() => {
    const legacy = providers.length === 0 ? legacyProvider() : null
    return legacy ? [legacy] : providers
  }, [providers])

  const value: Ctx = {
    address, chainId, onRightChain: chainId === rhc.id, providers: all,
    connecting, error, connect, disconnect, switchAccount, switchChain, walletClient,
  }
  return <WalletCtx.Provider value={value}>{children}</WalletCtx.Provider>
}

export function useWallet(): Ctx {
  const c = useContext(WalletCtx)
  if (!c) throw new Error('useWallet outside WalletProvider')
  return c
}
