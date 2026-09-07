import { useEffect, useRef, useState } from 'react'

import { useSession } from '../lib/session.tsx'
import { resolveHandle, type Provider } from '../lib/identityApi.ts'
import { ProviderIcon } from './ConnectAccount.tsx'
import {
  KIND_LABEL, maxSharePct, newId, normaliseHandle, withShare,
  type Recipient, type RecipientKind, type RemainderState,
} from '../lib/remainder.ts'

/*
  ⚠ The arithmetic and the contract mapping live in `../lib/remainder.ts`, not here. Not tidiness:
  `node --experimental-strip-types` runs a `.ts` and cannot run a `.tsx`, so anything sharing a file
  with JSX is untestable. The rule that the shares always make exactly 100 is the one `CreatorRouter`
  reverts on, and it was worth a test more than it was worth living next to its input.
  ⭐ Re-exported so callers still import one thing.
*/
export * from '../lib/remainder.ts'

/* ------------------------------------------------------------------------- view -- */

export function RemainderSplit({
  value, onChange, charityBps,
}: {
  value: RemainderState
  onChange: (next: RemainderState) => void
  charityBps: number
}) {
  const session = useSession()
  const remainderPct = (10000 - charityBps) / 100

  /** ⚠ Only the account kinds the SERVER can resolve. Offering GitHub with no GitHub app
      configured produces a row that can never be completed. */
  const kinds: RecipientKind[] = ['wallet', ...(session.providers.map((p) => p.name) as RecipientKind[])]

  const setRecipient = (id: string, patch: Partial<Recipient>) =>
    onChange({ ...value, recipients: value.recipients.map((x) => (x.id === id ? { ...x, ...patch } : x)) })

  /**
   * ⛔⛔ REBALANCED IN WHOLE PERCENT ON EVERY ADD, REMOVE OR TOGGLE.
   *
   * Leaving the shares alone means adding a second recipient instantly puts the form in an invalid
   * state the creator did not create — they asked for a payee and got a red error about arithmetic.
   * Splitting evenly is a guess, but it is a VALID guess and they can overtype it.
   *
   * ⚠ Whole percent, never basis points. Three ways in bps is 3334/3333/3333, which the boxes round
   * to 33/33/33 — three numbers that visibly do not make 100 under a total insisting they do, and
   * the moment any box is touched it becomes 3300 and the form goes red for a total nobody changed.
   */
  const rebalance = (next: RemainderState): RemainderState => {
    const legs = (next.burn.on ? 1 : 0) + next.recipients.length
    if (legs === 0) return next
    const each = Math.floor(100 / legs)
    const first = 100 - each * (legs - 1)
    let i = 0
    const take = () => (i++ === 0 ? first : each) * 100
    return {
      burn: next.burn.on ? { on: true, bps: take() } : { on: false, bps: 0 },
      recipients: next.recipients.map((x) => ({ ...x, bps: take() })),
    }
  }

  const addRecipient = () =>
    onChange(rebalance({
      ...value,
      recipients: [...value.recipients, { id: newId(), kind: kinds[0]!, value: '', resolved: null, bps: 0 }],
    }))

  const removeRecipient = (id: string) =>
    onChange(rebalance({ ...value, recipients: value.recipients.filter((x) => x.id !== id) }))

  const toggleBurn = () => onChange(rebalance({ ...value, burn: { ...value.burn, on: !value.burn.on } }))

  const ofAll = (bps: number) => {
    const n = (bps / 10000) * remainderPct
    return n % 1 === 0 ? n : Number(n.toFixed(1))
  }

  const legs = value.recipients.length + (value.burn.on ? 1 : 0)

  const maxPct = maxSharePct(value)
  /** @see withShare — the arithmetic lives outside the component so it can be tested. */
  const setShare = (key: string, typed: number) => onChange(withShare(value, key, typed))

  return (
    <div className="field">
      <label className="field__l">
        What happens to the rest{' '}
        <span style={{ color: 'var(--text-dim)', fontWeight: 500 }}>({remainderPct}% of fees)</span>
      </label>

      {/*
        ⚠ ABOVE THE LIST AND A TOGGLE, NOT A ROW. Burn is not a recipient — it has no address and no
        handle — so a row would leave an empty middle column and a dropdown that excludes itself.
      */}
      <div className={`burnrow${value.burn.on ? ' is-on' : ''}`}>
        <button
          type="button"
          className={`sw${value.burn.on ? ' is-on' : ''}`}
          role="switch"
          aria-checked={value.burn.on}
          aria-label="Buyback and Burn"
          onClick={toggleBurn}
        >
          <span className="sw__dot" />
        </button>
        <span className="burnrow__name">Buyback &amp; Burn</span>
        {/* ⚠ Shown only once there is something to share WITH. A single leg is necessarily the
            whole remainder, and a box whose only legal value is 100 is a control that does nothing. */}
        {value.burn.on && legs > 1 && (
          <span className="pctbox">
            <input
              className="pctbox__in" type="number" min={1} max={maxPct} step={1}
              value={Math.round(value.burn.bps / 100)}
              onChange={(e) => setShare('burn', Number(e.target.value))}
              aria-label="Buyback and Burn share"
            />
            <span className="pctbox__u">%</span>
          </span>
        )}
      </div>
      {value.burn.on && (
        <p className="recip__hint burnrow__hint">
          Buys the token on its own curve and burns it, permanently reducing the supply.
          {value.burn.bps > 0 && <> <strong>{ofAll(value.burn.bps)}% of all fees.</strong></>}
        </p>
      )}

      <div className="recips">
        {value.recipients.map((x) => (
          <RecipientRow
            key={x.id}
            r={x}
            kinds={kinds}
            showShare={legs > 1}
            maxPct={maxPct}
            canRemove={legs > 1}
            onPatch={(patch) => setRecipient(x.id, patch)}
            onShare={(pct) => setShare(x.id, pct)}
            onRemove={() => removeRecipient(x.id)}
          />
        ))}
      </div>

      {/* ⚠ No running total. The shares are kept summing to 100 by {@link setShare}, so the only
          number it could ever show is 100 — and a figure that can never be wrong is noise. */}
      <div className="recips__foot">
        <button type="button" className="btn btn--sm" onClick={addRecipient}>Add a recipient</button>
      </div>
    </div>
  )
}

/**
 * One recipient: what kind, who, and how much.
 *
 * ⚠ The handle lookup is DEBOUNCED because every X lookup is prepaid from the operator's balance.
 * Typing eight characters must cost one call, not eight.
 */
function RecipientRow({
  r, kinds, showShare, maxPct, canRemove, onPatch, onShare, onRemove,
}: {
  r: Recipient
  kinds: RecipientKind[]
  showShare: boolean
  maxPct: number
  canRemove: boolean
  onPatch: (patch: Partial<Recipient>) => void
  onShare: (pct: number) => void
  onRemove: () => void
}) {
  const [looking, setLooking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<number | null>(null)

  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current)
    if (r.kind === 'wallet') { setError(null); setLooking(false); return }

    const typed = normaliseHandle(r.value)
    if (!typed) { setError(null); setLooking(false); return }
    if (r.resolved && r.resolved.handle.toLowerCase() === typed.toLowerCase() && r.resolved.provider === r.kind) return

    setLooking(true)
    setError(null)
    timer.current = window.setTimeout(async () => {
      const found = await resolveHandle(r.kind as Provider, typed)
      setLooking(false)
      if (!found.ok) { setError(found.error); return }
      if (!found.user) { setError('No such account'); return }
      onPatch({ resolved: found.user })
    }, 500)
    return () => { if (timer.current) window.clearTimeout(timer.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r.value, r.kind])

  return (
    <div className="recip">
      <div className="recip__row">
        <span className="recip__kind">
          {r.kind !== 'wallet' && <ProviderIcon provider={r.kind as Provider} />}
          <select
            className="recip__sel"
            value={r.kind}
            /*
              ⛔⛔ CHANGING THE KIND CLEARS THE VALUE AND THE RESOLVED ACCOUNT, BOTH.
              A row switched from Wallet to X kept the `0x…` address sitting in the field, which then
              read as a handle — so the row looked filled in, and the only thing standing between
              that and a launch was the lookup failing. Nothing carries across: an address is not a
              handle, and an X identity must not stay attached to a row that now says GitHub.
            */
            onChange={(e) => onPatch({ kind: e.target.value as RecipientKind, value: '', resolved: null })}
            aria-label="Recipient type"
          >
            {kinds.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
        </span>

        <input
          className={`input recip__val${r.kind === 'wallet' ? ' mono' : ''}`}
          placeholder={r.kind === 'wallet' ? '0x…' : r.kind === 'x' ? '@handle' : 'username'}
          value={r.value}
          /* ⚠ Any edit clears the resolved account, or the launch pays whoever was looked up two
             edits ago. */
          onChange={(e) => onPatch({ value: e.target.value, resolved: null })}
          aria-label="Recipient"
        />

        {showShare && (
          <span className="pctbox">
            <input
              className="pctbox__in" type="number" min={1} max={maxPct} step={1}
              value={Math.round(r.bps / 100)}
              onChange={(e) => onShare(Number(e.target.value))}
              aria-label="Recipient share"
            />
            <span className="pctbox__u">%</span>
          </span>
        )}

        <button
          type="button"
          className="recip__x"
          onClick={onRemove}
          disabled={!canRemove}
          aria-label="Remove this recipient"
          title={canRemove ? 'Remove' : 'At least one destination is required'}
        >
          ×
        </button>
      </div>

      {/*
        ⚠ STATUS ONLY, and rendered at all only when there is status. The standing explanations that
        used to sit here — what a wallet is paid in, that an account share waits to be claimed — say
        the same thing on every row for ever, and the share as a fraction of all fees is already
        itemised in the signing panel beside the form. Repeated under each row they were furniture,
        and they pushed the thing that DOES change, the resolved account, further down the card.
        ⭐ The resolved line stays: this is the one field where what the creator typed and what the
        chain records are different things, so both belong on screen.
      */}
      {(looking || error || r.resolved) && (
        <p className="recip__hint">
          {looking && 'Looking that up…'}
          {!looking && error && <span className="recip__err">{error}</span>}
          {!looking && !error && r.resolved && (
            <>
              <strong>{r.resolved.name}</strong> · @{r.resolved.handle} ·{' '}
              {r.kind === 'x' ? 'X' : 'GitHub'} id {r.resolved.id}
            </>
          )}
        </p>
      )}
    </div>
  )
}
