import { useEffect, useState } from 'react'

import { accountById, profileUrl, type Identity, type Provider } from '../lib/identityApi.ts'
import { ProviderIcon } from './ConnectAccount.tsx'

/**
 * The account a launch's share is paid to, named and linked.
 *
 * ## ⛔⛔ THE CHAIN HAS THE ID, NEVER THE HANDLE — AND THAT IS ON PURPOSE
 *
 * A launch records `keccak256("<provider>:<id>")` plus the provider and id in the clear, and the
 * router proves on chain that those two hash to the beneficiary it pays. So what is stored is
 * unforgeable but unreadable: it says WHICH account, not what it is called.
 *
 * A handle could not have been stored instead. Both X and GitHub let a username be released and
 * registered by somebody else, so a handle written into a constructor would sooner or later name —
 * and link to — a different person, permanently, with no way to correct it. Resolving the id every
 * time it is displayed is what keeps the name and the link correct for ever.
 *
 * ⚠ Degrades to "an X account" when the lookup fails or is not configured. The percentage beside it
 * is the fact; the name is a courtesy, and a courtesy must never be able to break the row.
 */
export function AccountShare({ provider, id }: { provider: number; id: bigint }) {
  const name: Provider | null = provider === 1 ? 'x' : provider === 2 ? 'github' : null
  const [who, setWho] = useState<Identity | null>(null)

  useEffect(() => {
    if (!name || id === 0n) return
    let live = true
    void accountById(name, id.toString()).then((u) => { if (live) setWho(u) })
    return () => { live = false }
  }, [name, id])

  if (!name) return <>To a linked account</>

  const label = name === 'x' ? 'X' : 'GitHub'
  if (!who) return <>To an {label} account</>

  return (
    <a className="acctlink" href={profileUrl(who)} target="_blank" rel="noreferrer noopener"
      title={`Open @${who.handle} on ${label}`}>
      <ProviderIcon provider={name} />
      <span>@{who.handle}</span>
    </a>
  )
}
