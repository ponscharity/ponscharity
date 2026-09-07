import { useCallback, useEffect, useState } from 'react'
import { formatUnits, parseAbi, type Hex } from 'viem'

import { publicClient, txUrl, short } from '../lib/chain.ts'
import { useWallet } from '../lib/wallet.tsx'
import { useSession } from '../lib/session.tsx'
import { claimInfo, requestVoucher, type ClaimInfo, type Voucher } from '../lib/identityApi.ts'
import { ConnectButtons, ProviderIcon } from './ConnectAccount.tsx'
import { pairBy } from '../lib/pairs.ts'
import type { Launch } from '../lib/launchpad.ts'

/**
 * Collecting a share a launch assigned to your X or GitHub account.
 *
 * ## ⛔⛔ THIS IS A DIFFERENT THING FROM THE PANEL ABOVE IT
 *
 * `ClaimFees` collects what Pons owes a WALLET as a launch's fee recipient. This collects what a
 * launch chose to hand to an ACCOUNT — a share ring-fenced in `CharityFeeClaims` under
 * `keccak256("provider:id")`, which no address can prove it owns. The two live on one page because
 * "what am I owed" is one question to the person asking it, and they are kept visibly apart because
 * they are answered by different contracts on the strength of different proofs.
 *
 * ## Both identities are needed, and for different reasons
 *
 * The ACCOUNT proves the share is yours. The WALLET is where it gets paid. Neither implies the
 * other and either can be missing, so both are asked for separately and the page says which is
 * outstanding rather than showing one dead button.
 */

const CLAIMS_ABI = parseAbi([
  'function claim(address launch, bytes32 beneficiary, address asset, address recipient, uint256 amount, bytes32 salt, uint256 deadline, bytes signature) returns (uint256)',
])

const NATIVE = '0x0000000000000000000000000000000000000000'

type Row = { launch: Launch; info: ClaimInfo }

export function AccountClaim({ launches }: { launches: Launch[] }) {
  const session = useSession()
  const { address, walletClient, onRightChain } = useWallet()

  const [rows, setRows] = useState<Row[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState<{ token: string; hash: Hex } | null>(null)

  /**
   * ⚠⚠ ASKED PER LAUNCH, and only of launches that could possibly pay an account.
   *
   * There is no "what am I owed everywhere" read: the contract keys money by launch AND beneficiary
   * AND asset, which is exactly what stops one recipient being paid out of another's share. So the
   * page walks the launches it knows about. That is fine at this size and would not be at ten
   * thousand — the honest fix then is an index, not a looser contract.
   */
  const load = useCallback(async () => {
    if (session.users.length === 0) { setRows(null); return }
    const found: Row[] = []
    for (const l of launches) {
      const info = await claimInfo(l.token)
      /* ⚠ A launch that does not pay this account answers `share: null` with a reason. That is the
         ordinary case for almost every launch, so it is skipped silently rather than listed as a
         problem. */
      if (info?.share) found.push({ launch: l, info })
    }
    setRows(found)
  }, [launches, session.users])

  useEffect(() => { void load() }, [load])

  async function collect(row: Row) {
    if (!walletClient || !address) return
    setErr(null); setDone(null)
    try {
      setBusy('Asking the server to sign…')
      const issued = await requestVoucher(row.launch.token, address)
      if (!issued.ok) { setErr(issued.error); return }

      const v: Voucher = issued.voucher
      /*
        ⛔ The VOUCHER's fields are sent, never the page's own idea of them. The signature covers
        exactly these values; substituting anything — even a recipient the page believes is the same
        wallet — produces a signature that recovers to a different address and reverts.

        ⛔⛔ SIMULATED BEFORE IT IS SIGNED, like every other write on this site. A claim that reverts
        on chain has still cost gas and shows a hex error; simulating turns almost every failure —
        an expired voucher, a paused contract, a balance already taken — into a sentence beforehand.
      */
      setBusy('Checking the claim will succeed…')
      const { request } = await publicClient.simulateContract({
        address: issued.contract,
        abi: CLAIMS_ABI,
        functionName: 'claim',
        args: [
          v.launch, v.beneficiary, v.asset, v.recipient,
          BigInt(v.amount), v.salt, BigInt(v.deadline), v.signature,
        ],
        account: address,
      })
      setBusy('Confirm in your wallet…')
      const hash = await walletClient.writeContract(request)
      setBusy('Waiting for it to land…')
      await publicClient.waitForTransactionReceipt({ hash })
      setDone({ token: row.launch.symbol || short(row.launch.token), hash })
      await load()
    } catch (e) {
      const m = e instanceof Error ? e.message.split('\n')[0] : String(e)
      setErr(m)
    } finally {
      setBusy(null)
    }
  }

  /* ── the two identities, asked for separately ─────────────────────────────────────────────── */

  if (session.up === false) {
    return null /* ⚠ The server is down. Every other panel reads the chain and still works. */
  }

  if (session.users.length === 0) {
    return (
      /* ⚠ Centred as a block. The copy and the two buttons are one invitation, and left-aligned in
         a wide card they read as a paragraph that happens to have controls under it. */
      <section className="panel panel--pad acctcard" style={{ marginTop: 20 }}>
        <p className="eyebrow" style={{ justifyContent: 'center' }}>Assigned to your account</p>
        <p className="acctcard__lede">
          A launch can route a share of its fees to an X or GitHub account. The allocated share is
          held onchain for that account and can only be claimed by signing in with the linked
          account to verify ownership.
        </p>
        {session.providers.length === 0 ? (
          /* ⛔ Says so rather than showing a button that cannot work. An unconfigured provider
             fails every time it is pressed, which reads as a broken site. */
          <p className="field__err">Account sign-in is not configured on this deployment yet.</p>
        ) : (
          <div className="acctcard__actions"><ConnectButtons /></div>
        )}
      </section>
    )
  }

  return (
    <section className="panel panel--pad acctcard" style={{ marginTop: 20 }}>
      <p className="eyebrow" style={{ justifyContent: 'center' }}>Assigned to your accounts</p>

      {/* ⚠ Which accounts are being checked, and the chance to add the other. Somebody owed on a
          GitHub share while holding only X would otherwise see "nothing owed" and believe it. */}
      <div className="acctcard__who">
        {session.users.map((u) => (
          <span className="acctchip" key={u.provider}>
            <ProviderIcon provider={u.provider} />{u.handle}
          </span>
        ))}
        <ConnectButtons />
      </div>

      {session.stub && (
        <p className="field__err" style={{ marginTop: 8 }}>
          Sign-in is STUBBED on this deployment — anyone can sign in as anyone.
        </p>
      )}

      {rows === null && <p className="field__h" style={{ marginTop: 10 }}>Looking…</p>}

      {rows?.length === 0 && (
        <p className="field__h" style={{ marginTop: 10 }}>
          No launch here pays this account yet. If somebody named you, it will appear once they
          launch — nothing needs to be set up on your side.
        </p>
      )}

      {rows?.map((row) => {
        const asset = row.info.share!.asset
        const meta = pairBy(asset)
        const decimals = meta?.decimals ?? (asset.toLowerCase() === NATIVE ? 18 : 18)
        const symbol = meta?.symbol ?? (asset.toLowerCase() === NATIVE ? 'ETH' : 'tokens')
        const available = BigInt(row.info.available ?? '0')
        const reserved = BigInt(row.info.reserved ?? '0')

        return (
          <div className="claim" key={row.launch.token} style={{ marginTop: 14 }}>
            <div className="kv">
              <span className="kv__k">{row.launch.symbol || short(row.launch.token)}</span>
              <span className="kv__v mono">
                {formatUnits(available, decimals)} {symbol}
              </span>
            </div>
            <p className="field__h" style={{ marginTop: 4 }}>
              {row.info.payee && (
                <>Paid to <strong>@{row.info.payee.handle}</strong> on{' '}
                  {row.info.payee.provider === 'x' ? 'X' : 'GitHub'}. </>
              )}
              {row.info.share!.bps / 100}% of this launch's creator share.
              {reserved > 0n && (
                /* ⚠ Named rather than hidden. A voucher already signed and not yet spent is
                   subtracted from what can be signed again, and a balance that quietly shrank
                   without explanation is the kind of thing people read as theft. */
                <> {formatUnits(reserved, decimals)} {symbol} is already signed for and waiting to
                  be spent.</>
              )}
            </p>

            {!address ? (
              <p className="field__h" style={{ marginTop: 6 }}>
                Connect a wallet to choose where it is paid.
              </p>
            ) : !onRightChain ? (
              <p className="field__err" style={{ marginTop: 6 }}>
                Switch to Robinhood Chain to collect.
              </p>
            ) : (
              <button
                className="btn btn--accent btn--sm"
                style={{ marginTop: 8 }}
                disabled={available === 0n || busy !== null}
                onClick={() => void collect(row)}
              >
                {available === 0n ? 'Nothing to collect yet' : `Collect to ${short(address)}`}
              </button>
            )}
          </div>
        )
      })}

      {busy && <p className="field__h" style={{ marginTop: 10 }}>{busy}</p>}
      {err && <p className="field__err" style={{ marginTop: 10 }}>{err}</p>}
      {done && (
        <p className="field__h" style={{ marginTop: 10 }}>
          Collected from {done.token}. <a href={txUrl(done.hash)} target="_blank" rel="noreferrer">Receipt</a>
        </p>
      )}
    </section>
  )
}
