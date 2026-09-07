import { useCallback, useEffect, useState } from 'react'
import { formatUnits, parseUnits, type Address } from 'viem'
import { useWallet } from '../lib/wallet.tsx'
import { publicClient, txUrl } from '../lib/chain.ts'
import { TOKEN_ABI } from '../lib/launchpad.ts'

/**
 * Burning tokens you hold, from the page the token lives on.
 *
 * ## ⛔⛔ WHY A BUTTON HERE RATHER THAN A HEX FIELD SOMEWHERE ELSE
 *
 * `burn` takes an amount in BASE UNITS. 185,393,258.42 tokens is
 * `185393258426966292134831461`, and typing the human number burns a millionth of a millionth of
 * what was meant. It is irreversible either way. Doing it through a wallet's raw hex data field, or
 * by retyping a figure off an explorer, puts a 27 digit integer between somebody and a decision they
 * cannot undo. This takes a human amount and does the conversion.
 *
 * ## ⛔ AND IT IS NOT A TRANSFER TO A DEAD ADDRESS
 *
 * Sending to `0x…dEaD` leaves `totalSupply` exactly where it was, because the tokens still exist.
 * Every market cap on this site is computed from `totalSupply`, so that kind of "burn" changes
 * nothing here and nothing anywhere else either. This calls `burn`, and the confirmation reports the
 * supply BEFORE and AFTER so the difference is the evidence.
 */
export function BurnPanel({ token, symbol, decimals, onBurned }: {
  token: Address; symbol: string; decimals: number; onBurned: () => void
}) {
  const { address, onRightChain, walletClient, switchChain } = useWallet()
  const [held, setHeld] = useState<bigint | null>(null)
  const [amount, setAmount] = useState('')
  const [arming, setArming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState<{ hash: string; before: bigint; after: bigint } | null>(null)

  const refresh = useCallback(async () => {
    if (!address) { setHeld(null); return }
    const b = await publicClient
      .readContract({ address: token, abi: TOKEN_ABI, functionName: 'balanceOf', args: [address] })
      .catch(() => 0n)
    setHeld(b)
  }, [address, token])
  useEffect(() => { void refresh() }, [refresh])

  if (!address || held === null || held === 0n) return null

  const whole = formatUnits(held, decimals)
  /* ⚠ Parsed from the human figure, so nobody handles base units. An unparseable amount is refused
     rather than coerced: this cannot be undone. */
  let wei: bigint | null = null
  try { wei = amount.trim() ? parseUnits(amount.trim(), decimals) : held } catch { wei = null }
  const tooMuch = wei !== null && wei > held
  const valid = wei !== null && wei > 0n && !tooMuch

  const burn = async () => {
    if (!walletClient || !valid || wei === null) return
    setBusy(true); setErr(null)
    try {
      const before = await publicClient.readContract({ address: token, abi: TOKEN_ABI, functionName: 'totalSupply' })
      /* ⚠⚠ Simulated first. A burn that reverts still costs gas, and the revert on this one is
         almost always "more than you hold", which is a sentence rather than a hex error. */
      const { request } = await publicClient.simulateContract({
        address: token, abi: TOKEN_ABI, functionName: 'burn', args: [wei], account: address,
      })
      const hash = await walletClient.writeContract(request)
      await publicClient.waitForTransactionReceipt({ hash })
      const after = await publicClient.readContract({ address: token, abi: TOKEN_ABI, functionName: 'totalSupply' })
      setDone({ hash, before, after })
      setArming(false); setAmount('')
      await refresh()
      onBurned()
    } catch (e) {
      const m = (e as Error)?.message ?? 'The burn failed'
      setErr(/User rejected|denied/i.test(m) ? null : m.split('\n')[0]!)
    } finally { setBusy(false) }
  }

  return (
    <div className="burn">
      <div className="burn__head">
        <div>
          <div className="burn__k">You hold</div>
          <div className="burn__v">{Number(whole).toLocaleString('en-US', { maximumFractionDigits: 4 })} <small>{symbol}</small></div>
        </div>
        {!arming && !done && (
          <button className="btn btn--sm" onClick={() => { setArming(true); setAmount(whole) }}>Burn</button>
        )}
      </div>

      {done && (
        <p className="burn__done">
          {/* ⭐ The supply before and after, because that difference is the only proof a burn
              happened. Tokens arriving somewhere would prove nothing. */}
          Burned. Supply fell from{' '}
          <b>{Number(formatUnits(done.before, decimals)).toLocaleString('en-US', { maximumFractionDigits: 0 })}</b> to{' '}
          <b>{Number(formatUnits(done.after, decimals)).toLocaleString('en-US', { maximumFractionDigits: 0 })}</b>.{' '}
          <a href={txUrl(done.hash)} target="_blank" rel="noreferrer noopener">View the transaction</a>
        </p>
      )}

      {arming && (
        <div className="burn__arm">
          <p className="burn__warn">
            <strong>This cannot be undone.</strong> Burning destroys the tokens and lowers the total
            supply. It is not a transfer, and there is no way to recover them.
          </p>
          <div className="burn__row">
            <input className="input" inputMode="decimal" value={amount} aria-label={`Amount of ${symbol} to burn`}
              onChange={(e) => setAmount(e.target.value)} />
            <button className="btn btn--sm" onClick={() => setAmount(whole)}>Max</button>
          </div>
          {tooMuch && <p className="field__err">That is more than you hold.</p>}
          {wei === null && <p className="field__err">Enter an amount.</p>}
          {err && <p className="field__err">{err}</p>}
          {!onRightChain ? (
            <button className="btn btn--sm" onClick={() => void switchChain()}>Switch to Robinhood Chain</button>
          ) : (
            <div className="burn__row">
              <button className="btn btn--ink btn--sm" disabled={!valid || busy} onClick={() => void burn()}>
                {busy ? 'Burning' : `Burn ${amount.trim() || whole} ${symbol}`}
              </button>
              <button className="btn btn--sm" disabled={busy} onClick={() => { setArming(false); setErr(null) }}>Cancel</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
