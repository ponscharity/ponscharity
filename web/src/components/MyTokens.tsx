import { useMemo } from 'react'
import { useWallet } from '../lib/wallet.tsx'
import type { Launch } from '../lib/launchpad.ts'
import { launchesBy } from '../lib/claimable.ts'
import { CLAIM, LAUNCH } from '../lib/router.ts'
import { Link } from './Link.tsx'
import { Ledger } from './LedgerSection.tsx'

/**
 * The launches made by the connected wallet.
 *
 * ⚠ Filtered from the register already in memory rather than read again. `Entry.creator` is the
 * address that called `launch`, recorded on chain at launch time, so this needs no index and no
 * extra call: the whole register is one `eth_call` the page has already made.
 *
 * ⛔ The empty state distinguishes NOT CONNECTED from CONNECTED WITH NOTHING. They are different
 * situations with different fixes, and one message for both leaves somebody who launched from
 * another wallet believing their token is gone.
 */
export function MyTokens({ launches, loading }: { launches: Launch[]; loading: boolean }) {
  const { address } = useWallet()
  const mine = useMemo(() => launchesBy(launches, address), [launches, address])

  return (
    <section className="page">
      <div className="wrap">
        <div className="chead">
          <p className="eyebrow" style={{ justifyContent: 'center' }}>My tokens</p>
          <h1 className="chead__h">Your launches</h1>
        </div>

        {!address ? (
          <div className="empty">Connect a wallet to see the tokens it has launched.</div>
        ) : (
          <>
            <Ledger rows={mine} loading={loading}
              empty="This wallet has not launched anything yet." />

            <div style={{ marginTop: 26, display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
              <Link className="btn btn--ink btn--lg" to={LAUNCH}>Launch a token</Link>
              {mine.length > 0 && <Link className="btn" to={CLAIM}>Claim fees</Link>}
            </div>
          </>
        )}
      </div>
    </section>
  )
}
