import { XIcon, GithubIcon } from './Header.tsx'
import { useSession } from '../lib/session.tsx'
import { signInUrl, type Provider } from '../lib/identityApi.ts'

/**
 * "Connect X" / "Connect GitHub", in one place because it appears in two.
 *
 * ⭐ The mark, then the word. A service's own icon is recognised faster than its name, and it also
 * settles what "Connect" means before the reader gets to the label — the header menu and the claim
 * panel were otherwise two different-looking answers to the same question.
 *
 * ⛔ Only providers the SERVER says it can complete are ever offered. An unconfigured one produces a
 * button that fails every single time it is pressed, which reads as a broken site rather than as a
 * missing credential.
 *
 * ⚠ An anchor, never a button with an onClick. OAuth is a full page navigation to the provider and
 * back; a fetch cannot carry it, and the session lands in a cookie the page is not allowed to read.
 */

export function ProviderIcon({ provider }: { provider: Provider }) {
  return (
    <span className="pico" aria-hidden="true">
      {provider === 'x' ? <XIcon /> : <GithubIcon />}
    </span>
  )
}

export const providerLabel = (p: Provider) => (p === 'x' ? 'X' : 'GitHub')

/**
 * @param variant `ink` is the filled button used on the claim card; `item` is a menu row.
 * ⚠ Already-connected providers are filtered out by the caller, not here — the header wants them
 * gone from the list while the claim card wants them gone from the page entirely.
 */
export function ConnectButtons({
  variant = 'ink',
  onNavigate,
}: {
  variant?: 'ink' | 'item' | 'row'
  onNavigate?: () => void
}) {
  const session = useSession()
  const missing = session.providers.filter((p) => !session.has(p.name))
  if (missing.length === 0) return null

  /*
    ⚠ `row` is the connect DIALOG's shape — the same `.wbtn` a wallet gets, because in that dialog
    the two are the same kind of choice and a differently-shaped account row reads as a different
    kind of thing. The service is named there: the rows sit under wallets called MetaMask and
    Phantom, so a row saying only "Connect" would be the one item in the list that does not say what
    it connects to.
  */
  if (variant === 'row') {
    return (
      <>
        {missing.map((p) => (
          <a key={p.name} className="wbtn" href={signInUrl(p.name)} onClick={onNavigate}>
            <span className="wbtn__mark"><ProviderIcon provider={p.name} /></span>
            <span className="wbtn__name">{p.label}</span>
            <span className="wbtn__go">Connect</span>
          </a>
        ))}
      </>
    )
  }

  return (
    <>
      {missing.map((p) => (
        <a
          key={p.name}
          className={variant === 'ink' ? 'btn btn--ink connect' : 'profile__item connect connect--item'}
          href={signInUrl(p.name)}
          onClick={onNavigate}
        >
          <ProviderIcon provider={p.name} />
          {/* ⚠ In the MENU the mark already says which service, and the rows sit under each other —
              so "Connect X" / "Connect GitHub" repeats the icon twice over in a column two items
              tall. On the claim card the buttons sit side by side with no other context, so there
              the service is named. */}
          <span>{variant === 'item' ? 'Connect' : `Connect ${p.label}`}</span>
        </a>
      ))}
    </>
  )
}
