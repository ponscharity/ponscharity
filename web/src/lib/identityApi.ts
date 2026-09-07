/**
 * The charity server's identity and claim endpoints.
 *
 * ⚠⚠ Every call sends cookies. The session lands in an HttpOnly cookie the page cannot read, which
 * is the point of it being one — so `credentials: 'same-origin'` is not optional decoration, it is
 * the only way any of this works.
 */

export type Provider = 'x' | 'github'

export type Identity = {
  provider: Provider
  /** ⛔ The stable numeric id. This is what a beneficiary hash is built from, never the handle. */
  id: string
  handle: string
  name: string
  avatar: string | null
}

export type Me = {
  /** ⭐ EVERY connected account. X and GitHub are independent and somebody may hold both. */
  users: Identity[]
  /** ⛔ Only the providers a sign in can actually be COMPLETED with. Never offer a button off
      anything else — an unconfigured provider produces a control that fails every time. */
  providers: { name: Provider; label: string }[]
  claiming: boolean
  stub?: boolean
}

const same: RequestInit = { credentials: 'same-origin' }

/** ⚠ null means the SERVER IS UNREACHABLE, which is not the same as "nobody is signed in". */
export async function whoAmI(): Promise<Me | null> {
  try {
    const r = await fetch('/api/me', same)
    if (!r.ok) return null
    return (await r.json()) as Me
  } catch {
    return null
  }
}

/** @param provider disconnect just this one. ⚠ Omit to disconnect everything. */
export async function signOut(provider?: Provider): Promise<void> {
  try {
    const q = provider ? `?provider=${provider}` : ''
    await fetch(`/api/auth/signout${q}`, { ...same, method: 'POST' })
  } catch {
    /* ⚠ Swallowed: the caller re-reads `/api/me` afterwards, and the server is the only thing that
       knows whether the cookie really went. Reporting a failure we cannot confirm helps nobody. */
  }
}

/**
 * Where the browser goes to sign in.
 *
 * ⚠ A full page navigation, never fetch. OAuth sends the visitor to the provider and back.
 */
export const signInUrl = (provider: Provider) => `/api/auth/start/${provider}`

export type HandleLookup =
  | { ok: true; user: Identity | null }
  | { ok: false; error: string }

/**
 * Resolve a typed handle to the account that holds it right now.
 *
 * ⛔⛔ THE LAUNCH FORM CANNOT SKIP THIS. A beneficiary is `keccak256("x:<numeric id>")` written into
 * a constructor argument that can never change, so a launch keyed on the TEXT somebody typed pays
 * whoever holds that name years later. The id is the only thing safe to write down.
 */
export async function resolveHandle(provider: Provider, handle: string): Promise<HandleLookup> {
  try {
    const r = await fetch(
      `/api/handle?provider=${provider}&handle=${encodeURIComponent(handle)}`,
      same,
    )
    const body = await r.json().catch(() => null)
    if (!r.ok) return { ok: false, error: body?.error ?? `lookup failed (${r.status})` }
    return { ok: true, user: (body?.user ?? null) as Identity | null }
  } catch {
    return { ok: false, error: 'could not reach the server' }
  }
}

export type ClaimInfo = {
  /** Which of your accounts this launch pays — a share means nothing without knowing whose it is. */
  payee?: { provider: Provider; handle: string }
  share: { bps: number; asset: string; router: string } | null
  reason?: string
  onChain?: string
  reserved?: string
  available?: string
}

export async function claimInfo(launch: string): Promise<ClaimInfo | null> {
  try {
    const r = await fetch(`/api/claim?launch=${launch}`, same)
    if (!r.ok) return null
    return (await r.json()) as ClaimInfo
  } catch {
    return null
  }
}

export type Voucher = {
  launch: `0x${string}`
  beneficiary: `0x${string}`
  asset: `0x${string}`
  recipient: `0x${string}`
  amount: string
  salt: `0x${string}`
  deadline: string
  signature: `0x${string}`
}

export async function requestVoucher(
  launch: string,
  wallet: string,
): Promise<{ ok: true; voucher: Voucher; contract: `0x${string}` } | { ok: false; error: string }> {
  try {
    const r = await fetch('/api/voucher', {
      ...same,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ launch, wallet }),
    })
    const body = await r.json().catch(() => null)
    if (!r.ok) return { ok: false, error: body?.error ?? `the server refused (${r.status})` }
    return { ok: true, voucher: body.voucher, contract: body.contract }
  } catch {
    return { ok: false, error: 'could not reach the server' }
  }
}

/** Where an account lives, for a link out of the header menu. */
export const profileUrl = (u: Identity) =>
  u.provider === 'x' ? `https://x.com/${u.handle}` : `https://github.com/${u.handle}`

/**
 * A numeric account id back to whoever holds it now.
 *
 * ⭐ Used by the token page to NAME the account a share pays. The chain stores the id, never the
 * handle — both services let a username be released and re-registered, so a stored handle would
 * eventually name a different person. Resolving it fresh is what keeps the name and the link right.
 *
 * ⚠ Returns null rather than throwing on any failure. A page that cannot name an account still
 * reads perfectly well as "an X account"; a decoration must not be able to break the row.
 */
export async function accountById(provider: Provider, id: string): Promise<Identity | null> {
  try {
    const r = await fetch(`/api/account?provider=${provider}&id=${encodeURIComponent(id)}`, same)
    if (!r.ok) return null
    return ((await r.json())?.user ?? null) as Identity | null
  } catch {
    return null
  }
}
