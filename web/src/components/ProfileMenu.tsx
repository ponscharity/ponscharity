import { useEffect, useRef, useState } from 'react'
import { useWallet } from '../lib/wallet.tsx'
import { short } from '../lib/chain.ts'
import { CLAIM, MY_TOKENS, onNavClick } from '../lib/router.ts'
import { useSession } from '../lib/session.tsx'
import { profileUrl } from '../lib/identityApi.ts'
import { ConnectButtons, ProviderIcon } from './ConnectAccount.tsx'

/**
 * The connected wallet menu.
 *
 * ⚠⚠ Everything here is a link, a read, or a disconnect. Nothing in this menu moves money, which is
 * deliberate: a header dropdown is the easiest thing on a page to open by accident, and it opens
 * over whatever somebody was doing. Launching is a form you fill in and a transaction you sign there.
 *
 * ## ⛔⛔ IT MUST WORK WITH EITHER IDENTITY ALONE
 *
 * There are two, and neither implies the other: a WALLET is who you are on chain, and an ACCOUNT on
 * X or GitHub is who you are to a launch that names you as a payee. Somebody can be owed fees on
 * ten launches without ever holding the wallet that made any of them.
 *
 * ⚠ The old version returned a bare Connect button whenever no wallet was attached — so anybody who
 * had signed in with GitHub to collect fees had nowhere to see they were signed in and no way to
 * sign out. That is the exact bug PONSPAD's menu carries a comment about.
 */
export function ProfileMenu({ onOpenPicker }: { onOpenPicker: () => void }) {
  const { address, onRightChain, disconnect, switchChain } = useWallet()
  const session = useSession()
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  /* ⚠ Closed by a click anywhere else and by Escape. A dropdown that only closes from its own
     trigger sits over the page while somebody tries to use what is underneath it. */
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const users = session.users

  // Neither identity: one button, and the wallet picker behind it.
  if (!address && users.length === 0) {
    return <button className="btn btn--ink btn--sm" onClick={onOpenPicker}>Connect</button>
  }

  /* ⚠ The WALLET wins the trigger when both exist. It is the identity that signs, so it is the one
     somebody needs to check before approving anything, and a handle sitting where an address should
     be is exactly the kind of thing people click through. */
  const trigger = address ? short(address) : (users[0]?.handle ?? '')

  const copy = () => {
    void navigator.clipboard.writeText(address ?? '').then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    })
  }

  return (
    <div className="profile" ref={box}>
      <button
        className={`btn btn--sm profile__trigger${open ? ' is-open' : ''}${onRightChain ? '' : ' is-warn'}`}
        aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}
      >
        {!address && users[0]?.avatar
          ? <img className="profile__avatar" src={users[0].avatar} alt="" />
          : <span className="profile__dot" aria-hidden="true" />}
        <span className={address ? 'mono' : 'profile__name'}>{trigger}</span>
      </button>

      {open && (
        <div className="profile__menu" role="menu">
          {address && (
            <div className="profile__head">
              <span className="profile__addr mono">{short(address, 6)}</span>
              {/* ⚠ Beside the address rather than as a row below. Copying acts on the thing you are
                  looking at, so it belongs next to it. */}
              <button className="profile__copy" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
            </div>
          )}

          {/*
            ⭐ ONE ROW PER CONNECTED ACCOUNT: who you are signed in as, stated and then left alone.
            ⛔ NOT A BUTTON. The whole row used to be the link to the profile, which made an
              identity you are only being SHOWN look like something to press — it lit up under the
              cursor and sat in a menu whose every other row does something. Only the provider mark
              is interactive now, and it is the one thing on the row that goes anywhere.
            ⚠ The avatar had no CSS at all, so a square sprite rendered at its natural size and
              shoved the handle sideways. It is sized and round here, next to the name, which is the
              whole of what this row is for.
          */}
          {users.map((u) => (
            <div key={u.provider} className="profile__acct">
              {u.avatar
                ? <img className="profile__avatar" src={u.avatar} alt="" />
                : <span className="profile__dot" aria-hidden="true" />}
              <span className="profile__handle">{u.handle}</span>
              <a
                className="profile__go"
                href={profileUrl(u)}
                target="_blank"
                rel="noreferrer noopener"
                title={`Open @${u.handle} on ${u.provider === 'x' ? 'X' : 'GitHub'}`}
                aria-label={`Open @${u.handle} on ${u.provider === 'x' ? 'X' : 'GitHub'}`}
              >
                <ProviderIcon provider={u.provider} />
              </a>
            </div>
          ))}

          {/* 🔴 The loudest thing this menu can say. Stubbed sign-in authenticates anybody as
              anybody, so a deployment running it must never look like a normal one. */}
          {session.stub && (
            <p className="profile__warn">
              Sign-in is STUBBED on this deployment. Anyone can sign in as anyone.
            </p>
          )}

          {address && !onRightChain && (
            <p className="profile__warn">
              This wallet is on another network. Reads are empty and launches fail until you switch.
            </p>
          )}

          {address && !onRightChain && (
            <button className="profile__item" role="menuitem" onClick={() => void switchChain()}>
              Switch to Robinhood Chain
            </button>
          )}

          {/* ⚠ Only the two destinations that are ABOUT this wallet. Launch and Explore are in the
              header already, and a dropdown that repeats the nav makes the reader check whether the
              two are different things. */}
          <a className="profile__item" role="menuitem" href={MY_TOKENS}
            onClick={(e) => { onNavClick(MY_TOKENS)(e); setOpen(false) }}>
            My Tokens
          </a>
          <a className="profile__item" role="menuitem" href={CLAIM}
            onClick={(e) => { onNavClick(CLAIM)(e); setOpen(false) }}>
            Claim Fees
          </a>

          {/* ⚠ Switching account inside MetaMask tells a site nothing: it keeps the account it has
              permission for, and `accountsChanged` never fires because the permission did not
              change. This re-opens the wallet's picker, which is the only way to move. It is here
              rather than behind Disconnect because disconnecting first was the workaround people
              were reaching for and it did not work either. */}
          <div className="profile__sep" />

          {/* ⚠ Whichever identity is MISSING is offered, rather than assuming somebody wants both.
              ⛔ Sign-in is offered only for providers the server says it can complete — an
              unconfigured one produces a button that fails every single time it is pressed. */}
          {!address && (
            <button className="profile__item" role="menuitem"
              onClick={() => { onOpenPicker(); setOpen(false) }}>
              Connect a wallet
            </button>
          )}
          {/* ⛔ Every provider NOT yet connected, so holding X still offers GitHub. Connecting the
              second used to be impossible from here: the whole block was hidden once either one
              existed, and the server replaced rather than added. */}
          <ConnectButtons variant="item" onNavigate={() => setOpen(false)} />

          {/* ⚠ One per account: disconnecting X must not silently take GitHub with it. */}
          {users.map((u) => (
            <button key={u.provider} className="profile__item profile__item--danger" role="menuitem"
              onClick={() => { void session.signOut(u.provider); setOpen(false) }}>
              Disconnect {u.provider === 'x' ? 'X' : 'GitHub'}
            </button>
          ))}

          {address && (
            <button className="profile__item profile__item--danger" role="menuitem"
              onClick={() => { disconnect(); setOpen(false) }}>
              Disconnect wallet
            </button>
          )}
        </div>
      )}
    </div>
  )
}
