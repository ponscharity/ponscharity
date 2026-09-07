/**
 * Who the visitor is on the charity server, shared by the whole shell.
 *
 * ## ⚠⚠ THERE ARE TWO INDEPENDENT IDENTITIES HERE AND NEITHER IMPLIES THE OTHER
 *
 *   - a **wallet**, which is who you are on chain. It launches tokens and it receives money.
 *   - an **account** on X or GitHub, which is who you are to a launch that names you as a payee.
 *     That share is credited to `keccak256("provider:id")`, not to an address, so the account is
 *     the only thing that can prove the share is yours.
 *
 * ⛔ Collapsing them would be wrong in both directions: somebody can launch a token without ever
 * signing in, and somebody can be owed fees on ten launches without ever holding the wallet that
 * made any of them. So they connect separately, sign out separately, and the header shows both.
 *
 * ⚠ Fetched ONCE for the whole app rather than per page. The header needs it to decide what to
 * offer and the claim page needs it to decide what to show; two components each polling `/api/me`
 * would disagree with each other for as long as one of them was behind.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

import { signOut as apiSignOut, whoAmI, type Identity, type Me } from './identityApi.ts'

export type SessionState = {
  /** Every connected account. ⚠ Also empty when the server is unreachable — read `up`. */
  users: Identity[]
  /** ⚠ Convenience only. Nothing that decides ownership may use it — a launch may pay the OTHER. */
  has: (p: Identity['provider']) => Identity | undefined
  /**
   * ⛔⛔ ONLY the providers a sign in can actually be COMPLETED with, straight from the server.
   *
   * An empty list is a real and supported deployment: this server also hosts token logos and the
   * donation feed, which have nothing to do with signing in, so it runs perfectly well with no
   * OAuth app configured. Nothing may offer a sign-in button off the back of "the server answered".
   */
  providers: Me['providers']
  /** Whether the charity server is reachable at all. ⚠ Distinct from "nobody is signed in". */
  up: boolean | null
  /** Whether this deployment can sign claim vouchers. False means shares accrue but cannot be taken. */
  claiming: boolean
  /** 🔴 True only when sign-in is stubbed, which authenticates anybody as anybody. */
  stub: boolean
  refresh: () => Promise<void>
  signOut: (provider?: Identity['provider']) => Promise<void>
}

const Ctx = createContext<SessionState | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [users, setUsers] = useState<Identity[]>([])
  const [providers, setProviders] = useState<Me['providers']>([])
  const [up, setUp] = useState<boolean | null>(null)
  const [claiming, setClaiming] = useState(false)
  const [stub, setStub] = useState(false)

  const refresh = useCallback(async () => {
    const me = await whoAmI()
    if (!me) {
      /* ⚠ The server being absent must cost the claim page and nothing else. Every other page reads
         the chain directly, so this leaves `up` false and lets the rest of the site carry on. */
      setUp(false)
      setUsers([])
      setProviders([])
      setClaiming(false)
      return
    }
    setUp(true)
    setUsers(me.users ?? [])
    setProviders(me.providers)
    setClaiming(me.claiming)
    setStub(Boolean(me.stub))
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const signOut = useCallback(async (provider?: Identity['provider']) => {
    await apiSignOut(provider)
    // ⚠ Re-read rather than assuming. The server clears the cookie and is the only thing that knows
    // whether that worked.
    await refresh()
  }, [refresh])

  const value = useMemo<SessionState>(
    () => ({
      users, providers, up, claiming, stub, refresh, signOut,
      has: (p: Identity['provider']) => users.find((u) => u.provider === p),
    }),
    [users, providers, up, claiming, stub, refresh, signOut],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useSession(): SessionState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useSession outside SessionProvider')
  return v
}
