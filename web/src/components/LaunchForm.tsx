import { useEffect, useMemo, useState } from 'react'
import { formatEther, formatUnits, isAddress, parseAbi, parseUnits, type Address, type Hex } from 'viem'
import { useWallet } from '../lib/wallet.tsx'
import { publicClient, short, txUrl, tokenUrl } from '../lib/chain.ts'
import { NATIVE, PAIR_ASSETS, loadPairAssets, type PairAsset } from '../lib/pairs.ts'
import { usdPerAsset } from '../lib/usdPrice.ts'
import {
  RemainderSplit, BLANK_REMAINDER, remainderErrors, toSplits, summaryRows, needsRouter, soleWallet,
  type RemainderState,
} from './RemainderSplit.tsx'

/**
 * The developer buy, in the pair asset's own units.
 *
 * ⛔ Returns zero for anything unparseable rather than throwing, and the field validates separately.
 * A launch must never be built with a buy amount nobody could read: the value check on Pons's
 * periphery is exact, so a misread here is a revert after the distributor has already been deployed
 * inside the transaction.
 */
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

const pairFor = (assets: readonly PairAsset[], a: string): PairAsset =>
  assets.find((p) => p.address.toLowerCase() === a.toLowerCase()) ?? assets[0]!

function parseDevBuy(raw: string, decimals: number): bigint {
  const t = raw.trim()
  if (!t) return 0n
  try {
    const v = parseUnits(t, decimals)
    return v > 0n ? v : 0n
  } catch { return 0n }
}
import {
  LAUNCHPAD, LAUNCHPAD_ABI, LAUNCHPAD_V2, LAUNCHPAD_V2_ABI, usingV2, LAUNCH_CONFIG_ID, ZERO_ID,
  previewEconomics, readFactoryState,
} from '../lib/launchpad.ts'
import { SplitBar } from './SplitBar.tsx'
import { CharityPicker } from './CharityPicker.tsx'
import { LogoField } from './LogoField.tsx'
import { checkLogo } from '../lib/logo.ts'

type Form = {
  name: string; symbol: string; logo: string; description: string
  website: string; twitter: string; telegram: string
  pair: Address; creatorTaxBps: number
  charity: string; charityId: string; creatorPayout: string; charityBps: number
  devBuy: string; exemptions: string[]
}

const BLANK: Form = {
  name: '', symbol: '', logo: '', description: '',
  website: '', twitter: '', telegram: '',
  pair: NATIVE, creatorTaxBps: 0,
  charity: '', charityId: ZERO_ID, creatorPayout: '', charityBps: 10000,
  devBuy: '', exemptions: [],
}

type Result = { token: Address; distributor: Address; hash: Hex }

export function LaunchForm({ minBps, onLaunched }: { minBps: number; onLaunched: () => void }) {
  const { address, onRightChain, walletClient, switchChain } = useWallet()
  const [f, setF] = useState<Form>(BLANK)
  const [rem, setRem] = useState<RemainderState>(BLANK_REMAINDER)
  const [fee, setFee] = useState<bigint | null>(null)
  const [maxTax, setMaxTax] = useState(1000)
  const [enabled, setEnabled] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  /* ⚠⚠ Errors are held back until a field has been LEFT, or until launch is attempted. A form that
     greets you with "Required" under every empty box has told you nothing and looks broken — the
     message is only useful once you could plausibly have filled it in. */
  const [touched, setTouched] = useState<Set<keyof Form>>(new Set())
  const [tried, setTried] = useState(false)
  /* ⛔ Owned by the picker, which is the only thing that knows whether the address survived its
     on-chain checks and whether the launcher ticked the confirmation. The form never second-guesses
     it: two components disagreeing about whether an address is safe is worse than either answer. */
  const [charityOk, setCharityOk] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [result, setResult] = useState<Result | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const s = await readFactoryState()
        if (!alive) return
        setFee(s.fee); setMaxTax(s.maxTax); setEnabled(s.enabled)
      } catch { /* the preview panel simply shows dashes */ }
    })()
    return () => { alive = false }
  }, [])

  /* ⭐ The creator's payout defaults to the connected wallet, but only while untouched. Overwriting
     an address somebody typed because their wallet reconnected would be a very expensive tidy-up. */
  const [payoutTouched, setPayoutTouched] = useState(false)
  /* ⚠ The draft is separate from the committed list. A half-typed address must never reach the
     launch, and the list is what is signed. */
  const [exemptDraft, setExemptDraft] = useState('')
  useEffect(() => {
    if (address && !payoutTouched) {
      setF((p) => ({ ...p, creatorPayout: address }))
      /* ⚠ Prefilled into the FIRST recipient when it is an empty wallet row, or connecting a
         wallet silently stops filling in the one field it used to fill in. Only when empty: a
         creator who has typed somebody else's address must not have it overwritten. */
      setRem((p) => {
        const first = p.recipients[0]
        if (!first || first.kind !== 'wallet' || first.value.trim()) return p
        return { ...p, recipients: [{ ...first, value: address }, ...p.recipients.slice(1)] }
      })
    }
  }, [address, payoutTouched])

  /*
    ⛔⛔ SEEDED, THEN REPLACED BY WHAT THE CHAIN SAYS. Pons approved 32 new pair assets between
    28 Aug and 4 Sep 2026 and this form offered none of them, because the catalogue was a literal in
    our repo describing somebody else's contract. The seed is what renders on the first paint and
    what survives the explorer being unreachable; the chain is what decides.
  */
  const [assets, setAssets] = useState<PairAsset[]>(PAIR_ASSETS)
  useEffect(() => {
    let live = true
    loadPairAssets().then((a) => { if (live) setAssets(a) }).catch(() => {})
    return () => { live = false }
  }, [])

  const pair = useMemo<PairAsset>(
    () => assets.find((p) => p.address.toLowerCase() === f.pair.toLowerCase()) ?? assets[0]!,
    [f.pair, assets],
  )

  /*
    ⛔⛔ PROBED LIVE, NEVER LISTED. This used to be a hardcoded `remit: 'blocked'` on MSTR, on the
    grounds that its only initialised tier held zero liquidity. That stopped being true — MSTR is
    initialised at two tiers as of 6 Sep 2026 — so the form was refusing a launch the market would
    now support, and would equally have allowed one whose pool had since emptied. A fact about a
    live order book cannot live in a source file.

    ⚠ It WARNS rather than blocking. The probe is one RPC read that can fail transiently, and a
    launch button disabled by a network hiccup is worse than a clear warning: every asset offered
    here is one Pons approved, and the fees are recoverable the day the pool has depth — they sit in
    the distributor's escrow, which is exactly where `sellStock` looks every pass.
  */
  const [thinPool, setThinPool] = useState(false)
  useEffect(() => {
    if (pair.remit === 'direct') { setThinPool(false); return }
    let live = true
    setThinPool(false)
    usdPerAsset(pair.address, pair.decimals)
      .then((p) => { if (live) setThinPool(p === null) })
      .catch(() => {})
    return () => { live = false }
  }, [pair.address, pair.decimals, pair.remit])

  /** ⚠ The generic line is only true of an asset that is actually sold to USDG on the way out. */
  const pairNote = pair.note
    ?? (pair.remit === 'sell-first'
      ? 'Fees are earned in this asset and sold to USDG before they reach the charity.'
      : null)

  const errors = useMemo(() => {
    const e: Partial<Record<keyof Form, string>> = {}
    /* ⛔⛔ THE VALUE CHECK ON PONS'S PERIPHERY IS EXACT, so an unreadable amount is not a warning,
       it is a revert AFTER the distributor has been deployed inside the same transaction. Caught
       here, before anything is signed. */
    if (f.devBuy.trim()) {
      const parsed = parseDevBuy(f.devBuy, pairFor(assets, f.pair).decimals)
      if (parsed === 0n) e.devBuy = 'Enter an amount, or leave it empty for no developer buy'
    }
    if (f.exemptions.length > 8) e.exemptions = 'Pons caps how many wallets a launch can declare'
    if (!f.name.trim()) e.name = 'Required'
    if (!f.symbol.trim()) e.symbol = 'Required'
    else if (!/^[A-Za-z0-9]{2,11}$/.test(f.symbol.trim())) e.symbol = '2–11 letters or digits'
    if (!f.charity.trim()) e.charity = 'Required'
    else if (!isAddress(f.charity.trim())) e.charity = 'Not a valid address'
    /* ⚠ Only asked when there IS a remainder. At 100% to the charity there is nothing to route and
       the whole section is hidden, so validating it would block a launch on an invisible field. */
    if (f.charityBps < 10000) {
      if (usingV2()) {
        const bad = remainderErrors(rem)
        if (bad) e.creatorPayout = bad
      } else if (!isAddress(f.creatorPayout.trim())) {
        /* ⚠ V1's rule, unchanged: one payout address, required unless the charity takes everything. */
        e.creatorPayout = f.creatorPayout.trim() ? 'Not a valid address' : 'Required unless the charity gets 100%'
      }
    }
    if (f.charityBps < minBps) e.charityBps = `This launchpad requires at least ${minBps / 100}%`
    if (f.creatorTaxBps < 0 || f.creatorTaxBps > maxTax) e.creatorTaxBps = `0–${maxTax / 100}%`
    /* ⛔⛔ Pons reverts `MetadataTooLong` above 512 bytes and the revert names no field, so an
       oversized logo fails the whole launch with a message pointing nowhere. Checked here instead. */
    const lg = checkLogo(f.logo)
    if (!lg.ok) e.logo = lg.error ?? 'Not a usable image link'
    return e
  }, [f, minBps, maxTax, rem])

  const ready =
    Object.keys(errors).length === 0 && charityOk &&
    !!address && onRightChain && enabled

/**
 * ⛔⛔ AN ERC-20 DEVELOPER BUY IS PULLED, NOT SENT — SO IT NEEDS AN APPROVAL FIRST.
 *
 * A native launch carries the buy in `msg.value`. An ERC-20 one cannot: `CharityLaunchpadV2` runs
 * `safeTransferFrom(msg.sender, address(this), quoteIn)` and forwards it, so without an allowance
 * the launch reverts inside the token — as `SafeERC20FailedOperation`, a selector viem cannot name,
 * which reached the creator as "reverted with the following signature:" and nothing else.
 *
 * The form used to know this and do nothing about it: there is a comment three screens up saying the
 * quote "comes out of an allowance the launchpad pulls instead", and no code ever asked for one. So
 * every ERC-20 paired developer buy this site has ever offered was unlaunchable.
 *
 * ⚠ The BALANCE is checked before the approval, not after. Approving money you do not have succeeds
 * — an allowance is a permission, not a transfer — so without this the creator signs an approval, is
 * charged gas for it, and then watches the launch revert anyway.
 *
 * ⭐ Approves EXACTLY the buy. An unlimited approval is the habit here and it is the wrong one for a
 * one-off: this contract would keep a standing claim on a launcher's USDG for ever afterwards.
 */
const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
])

  async function submit() {
    if (!walletClient || !address) return
    setTried(true)
    setErr(null); setBusy('Reading the launch terms…')
    try {
      /* ⛔⛔ Pinned IMMEDIATELY before signing, never carried from page load. `expectedEconomics` is
         Pons's guard that the curve's terms have not moved since you looked; a stale pin reverts the
         launch, and a pin fetched minutes ago is stale by definition. */
      const economics = await previewEconomics(f.pair)

      /* ⚠ A random salt. Reusing one collides with an existing CREATE2 address and reverts with
         nothing useful to say. */
      const salt = ('0x' + crypto.getRandomValues(new Uint8Array(32))
        .reduce((s, b) => s + b.toString(16).padStart(2, '0'), '')) as Hex

      const params = {
        name: f.name.trim(),
        symbol: f.symbol.trim().toUpperCase(),
        logo: f.logo.trim(),
        description: f.description.trim(),
        socials: {
          twitter: f.twitter.trim(), telegram: f.telegram.trim(),
          discord: '', website: f.website.trim(), farcaster: '',
        },
        /* ⚠ Ignored by the launchpad, which overwrites it with the distributor it creates. Sent as
           the zero address rather than the user's own so nothing here even looks like a way in. */
        creatorFeeRecipient: '0x0000000000000000000000000000000000000000' as Address,
        creatorTaxBps: f.creatorTaxBps,
        buybackEnabled: false,
        expectedEconomics: economics,
        salt,
      }

      /*
        ⛔⛔ THE SPLITS ARE BUILT HERE AND THEY ARE PERMANENT, so they are derived from the form
        rather than from anything held in state alongside it. `bps` is of the REMAINDER — the
        contract applies it after the charity's share — and `CreatorRouter` refuses a total that is
        not exactly 10,000, which `remainderErrors` has already checked in the form.

        ⚠ The beneficiary is `keccak256("x:<handle>")`. It commits to the account the creator typed
        and is opaque to the contract, which is what lets another way of proving identity be added
        later without touching a deployed contract.
      */
      /*
        ⛔⛔ THE SPLITS ARE BUILT IN `toSplits`, BESIDE THE STATE THEY READ, so the form's shape and
        the contract's cannot drift apart. `bps` is of the REMAINDER — the contract applies it after
        the charity's share — and `CreatorRouter` refuses a total that is not exactly 10,000, which
        `remainderErrors` has already checked in the form.
      */
      const splits = toSplits(rem)

      /* ⭐ One wallet and nothing else is the plain launch: no router, same gas, same shape as
         before. Anything else needs one. */
      const routed = usingV2() && f.charityBps < 10000 && needsRouter(rem)

      /*
        ⚠ The single address a NON-routed launch pays. A routed one still sends this — the launchpad
        overwrites it with the router once splits are present — but it must still be a valid address
        or the call cannot even be ENCODED.

        ⛔⛔ `isAddress` GUARDED, not cast. `soleWallet` once returned whatever was in the first row
        regardless of its kind, so an X-only launch put the handle here and viem threw
        `Address "MEADGod" is invalid` before anything was signed — a launch that failed with no
        reason anybody could act on. That particular bug is fixed at the source, and this stays
        because a bad address reaching an `as Address` cast is a whole CLASS of failure that looks
        identical and is invisible to the type checker.
      */
      const wanted = f.charityBps === 10000 ? '' : (soleWallet(rem) || f.creatorPayout.trim())
      const payout = (isAddress(wanted) ? wanted : ZERO_ADDRESS) as Address

      /*
        ⛔⛔ THE VALUE IS EXACT, AND ONLY A NATIVE PAIR CARRIES THE BUY IN IT.
        Pons's periphery checks `launchFee + quoteIn` for a native launch and `launchFee` alone for
        an ERC-20 one, reverting `NativeValueMismatch` on anything else. Sending the buy as value on
        a USDG launch is the mistake a native habit produces; there the quote comes out of an
        allowance the launchpad pulls instead.
      */
      const isNativePair = f.pair.toLowerCase() === NATIVE.toLowerCase()
      const buyWei = parseDevBuy(f.devBuy, pair.decimals)
      const value = (fee ?? 0n) + (isNativePair ? buyWei : 0n)
      const exemptions = f.exemptions.filter((a) => isAddress(a)) as Address[]

      /* ── the developer buy's allowance, for an ERC-20 pair ────────────────────────────────
         @see ERC20 above for why this is not optional. */
      if (!isNativePair && buyWei > 0n) {
        const spender = (usingV2() ? LAUNCHPAD_V2 : LAUNCHPAD) as Address
        const [held, allowed] = await Promise.all([
          publicClient.readContract({ address: f.pair, abi: ERC20, functionName: 'balanceOf', args: [address] }),
          publicClient.readContract({ address: f.pair, abi: ERC20, functionName: 'allowance', args: [address, spender] }),
        ])
        if (held < buyWei) {
          throw new Error(
            `SHORT_PAIR_BALANCE:That wallet holds ${formatUnits(held, pair.decimals)} ${pair.symbol}, `
            + `and the developer buy needs ${formatUnits(buyWei, pair.decimals)}.`,
          )
        }
        if (allowed < buyWei) {
          setBusy(`Approve ${formatUnits(buyWei, pair.decimals)} ${pair.symbol} for the launchpad…`)
          const { request } = await publicClient.simulateContract({
            address: f.pair, abi: ERC20, functionName: 'approve',
            args: [spender, buyWei], account: address,
          })
          const approveHash = await walletClient.writeContract(request)
          setBusy('Waiting for the approval…')
          const rec = await publicClient.waitForTransactionReceipt({ hash: approveHash })
          /* ⛔ `status` CHECKED. A receipt resolving is not a transaction succeeding, and an approval
             that silently failed here would surface as the same nameless revert as before. */
          if (rec.status !== 'success') throw new Error('The approval did not go through, so nothing was launched.')
        }
      }

      /* ⛔⛔ SIMULATED BEFORE IT IS SIGNED. A launch that reverts on chain has still cost gas and
         still shows the user a failed transaction with a hex error. Simulating first turns almost
         every failure into a sentence before anything is signed. */
      setBusy('Checking the launch will succeed…')

      /* ⚠ Two entrypoints, and the plain one is still sent when there is nothing extra to say. An
         empty array is NOT the same calldata as no array, and `launch` is the call this launchpad
         has always made. */
      /* ⛔ A routed launch is never "plain". `launch` takes no splits at all, so sending a routed
         launch down that branch would silently drop the burn and X shares and pay the whole
         remainder to the wallet — the launch would succeed and be permanently wrong. */
      const plain = !routed && buyWei === 0n && exemptions.length === 0
      /*
        ⛔⛔ FOUR BRANCHES, AND NOT ONE OF THEM MAY BE MERGED WITH A TERNARY.

        Two launchpads with different `CharityTerms`, times two entry points that take different
        arguments. viem cannot narrow a request built from an ABI chosen at runtime — it is the same
        shape of mistake an `as never` would have papered over on the claim page, and here it would
        paper over sending V2's struct to a V1 contract, which breaks every developer-buy launch.

        ⚠ The V1 branches are byte-identical to what has always shipped. Nothing about a launch made
        today changes until V2 is configured.
      */
      let hash: Hex
      const terms1 = {
        charity: f.charity.trim() as Address, charityId: f.charityId as `0x${string}`,
        creatorPayout: payout, charityBps: f.charityBps,
      }

      if (usingV2()) {
        const at2 = { address: LAUNCHPAD_V2 as Address, abi: LAUNCHPAD_V2_ABI, value, account: address } as const
        if (plain) {
          const { request } = await publicClient.simulateContract({
            ...at2, functionName: 'launch',
            args: [params, LAUNCH_CONFIG_ID, f.pair, f.charity.trim() as Address,
                   f.charityId as `0x${string}`, payout, f.charityBps],
          })
          setBusy('Confirm in your wallet…')
          hash = await walletClient.writeContract(request)
        } else {
          const { request } = await publicClient.simulateContract({
            ...at2, functionName: 'launchWithBuy',
            args: [params, LAUNCH_CONFIG_ID, f.pair,
                   { ...terms1, splits: routed ? splits : [] },
                   /* ⚠ `minTokensOut` 0 only because the buy and the launch settle in ONE
                      transaction: there is no pool to sandwich yet. On a follow-up buy this would
                      be a free sandwich. */
                   { quoteIn: buyWei, minTokensOut: 0n },
                   exemptions],
          })
          setBusy('Confirm in your wallet…')
          hash = await walletClient.writeContract(request)
        }
      } else {
        const at1 = { address: LAUNCHPAD as Address, abi: LAUNCHPAD_ABI, value, account: address } as const
        if (plain) {
          const { request } = await publicClient.simulateContract({
            ...at1, functionName: 'launch',
            args: [params, LAUNCH_CONFIG_ID, f.pair, f.charity.trim() as Address,
                   f.charityId as `0x${string}`, payout, f.charityBps],
          })
          setBusy('Confirm in your wallet…')
          hash = await walletClient.writeContract(request)
        } else {
          const { request } = await publicClient.simulateContract({
            ...at1, functionName: 'launchWithBuy',
            args: [params, LAUNCH_CONFIG_ID, f.pair, terms1,
                   { quoteIn: buyWei, minTokensOut: 0n }, exemptions],
          })
          setBusy('Confirm in your wallet…')
          hash = await walletClient.writeContract(request)
        }
      }

      setBusy('Waiting for the block…')
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error('The launch transaction reverted.')

      /* ⚠ Read back from the registry rather than decoding the return value: a receipt carries logs,
         not return data, and re-reading is the only way to be sure what actually landed. */
      /* ⛔ Read back from the registry the launch actually went INTO. Reading V1 after launching
         into V2 returns somebody else's most recent token and shows it as yours. */
      const entries = (await publicClient.readContract({
        address: (usingV2() ? LAUNCHPAD_V2 : LAUNCHPAD) as Address,
        abi: LAUNCHPAD_ABI, functionName: 'page', args: [0n, 1n],
      })) as readonly { token: Address; distributor: Address }[]

      setResult({ token: entries[0]!.token, distributor: entries[0]!.distributor, hash })
      setF(BLANK); setPayoutTouched(false); setTouched(new Set()); setTried(false)
      onLaunched()
    } catch (e) {
      const m = (e as Error).message ?? ''
      /* ⛔ A failure says what happened to the user's money and nothing about the build. "Nothing was
         signed and nothing left your wallet" is the fact that matters, and it is always true here
         because every path that can fail does so before or during the simulate. */
      /* ⚠ THE UNRECOGNISED CASE CARRIES ITS REASON. The reassurance is the important half and stays
         first, but "Could not complete that launch" ALONE is a dead end: it was the whole message a
         creator got when an X-only launch encoded its handle as an address, and there was no way for
         them — or for us reading a report of it — to tell a bad address from a dead RPC. One line,
         first line only, because a viem error is a page of ABI dump after that. */
      const reason = m.split('\n')[0]!.trim().slice(0, 160)
      setErr(
        /User rejected|denied/i.test(m) ? 'You cancelled the signature. Nothing was signed.'
          : /CharityShareTooSmall/.test(m) ? `The charity share has to be at least ${minBps / 100}%.`
          : /EconomicsMoved/.test(m) ? 'The curve terms moved while you were filling this in. Read them again and retry.'
          : /PairTokenNotApproved/.test(m) ? 'Pons does not accept that pair asset.'
          : /SHORT_PAIR_BALANCE:/.test(m) ? m.split('SHORT_PAIR_BALANCE:')[1]!
          : /insufficient funds/i.test(m) ? 'That wallet does not hold enough ETH for the launch fee and gas.'
          /* ⚠ SafeERC20's own error, which viem can only report as a bare selector. It means the
             pull of the developer buy failed — almost always a missing allowance. */
          : /SafeERC20FailedOperation|0x5274afe7/.test(m)
            ? `The launchpad could not take the ${pair.symbol} for the developer buy. Approve it and try again.`
          : `Could not complete that launch. Nothing was signed and nothing left your wallet.${reason ? ` (${reason})` : ''}`,
      )
    } finally {
      setBusy(null)
    }
  }

  const set = <K extends keyof Form>(k: K) => (v: Form[K]) => setF((p) => ({ ...p, [k]: v }))

  /* ⚠ Deduplicated case-insensitively. Pons caps the exemption list, and the same wallet twice
     spends one of those slots on nothing. */
  const addExempt = () => {
    const a = exemptDraft.trim()
    if (!isAddress(a)) return
    setF((p) => p.exemptions.some((x) => x.toLowerCase() === a.toLowerCase())
      ? p : { ...p, exemptions: [...p.exemptions, a] })
    setExemptDraft('')
  }
  const blur = (k: keyof Form) => () => setTouched((p) => new Set(p).add(k))
  /** The error to SHOW, as opposed to the error that exists. */
  const shown = (k: keyof Form) => (tried || touched.has(k) ? errors[k] : undefined)

  if (result) {
    return (
      <section className="page" id="launch">
        <div className="wrap">
          <div className="head head--center">
            <p className="eyebrow">Launched</p>
            <h2>Your token is <span className="hl">live</span></h2>
          </div>
          {/* ⚠ `maxWidth` alone does not centre anything — it only stops the card growing, and this
              one sat hard left under a centred heading. @see .launched for the auto margins. */}
          <div className="panel panel--pad launched">
            {/* ⚠ The rows stay label-left, value-right. They are a table of addresses read down one
                edge; centring them would put every value in a different place. */}
            <div className="kv"><span className="kv__k">Token</span>
              <a className="kv__v mono" href={tokenUrl(result.token)} target="_blank" rel="noreferrer">{result.token}</a></div>
            <div className="kv"><span className="kv__k">Charity distributor</span>
              <span className="kv__v mono">{result.distributor}</span></div>
            <div className="kv"><span className="kv__k">Transaction</span>
              <a className="kv__v mono" href={txUrl(result.hash)} target="_blank" rel="noreferrer">View</a></div>
            <p className="launched__note">
              The distributor is this token's fee recipient and cannot be changed. Fees show as pending
              until the first harvest lands.
            </p>
            <button className="btn launched__again" onClick={() => setResult(null)}>Launch another</button>
          </div>
        </div>
      </section>
    )
  }

  return (
    <section className="page" id="launch">
      <div className="wrap">
        {/* ⚠ The centred `chead` pattern, the same one the charities and how it works pages use,
            rather than the left aligned `head`. Three page titles set the same way is a layout; two
            set one way and one another is an inconsistency a visitor feels without naming. */}
        <div className="chead">
          <p className="eyebrow" style={{ justifyContent: 'center' }}>Launch</p>
          <h1 className="chead__h">Launch a charity token</h1>
          <p className="chead__sub">
            The charity address, fee split and paired asset are permanently fixed in the contract.
          </p>
        </div>

        {/*
          ⛔ NOTHING HERE NARRATES BUILD STATUS. A visitor is never told what is or is not wired up.
          A launch that cannot complete fails plainly in `submit`, saying that nothing was signed and
          nothing left their wallet. The engineering truth lives in comments, where it belongs.
        */}
        {!enabled && (
          <div className="banner" style={{ marginBottom: 26 }}>
            <strong>Pons is not accepting launches at the moment.</strong> This is set on their
            factory. Try again shortly.
          </div>
        )}

        <div className="launch__grid">
          <div className="panel panel--pad">
            <div className="row">
              <div className="field">
                <label className="field__l" htmlFor="name">Token name</label>
                <input id="name" className="input" placeholder="Clean Water Coin" value={f.name}
                  onChange={(e) => set('name')(e.target.value)} onBlur={blur('name')} maxLength={64} />
                {shown('name') && <p className="field__err">{shown('name')}</p>}
              </div>
              <div className="field">
                <label className="field__l" htmlFor="symbol">Symbol</label>
                <input id="symbol" className="input mono" placeholder="WATER" value={f.symbol}
                  onChange={(e) => set('symbol')(e.target.value.toUpperCase())} onBlur={blur('symbol')} maxLength={11} />
                {shown('symbol') && <p className="field__err">{shown('symbol')}</p>}
              </div>
            </div>

            <LogoField value={f.logo} onChange={set('logo')} error={shown('logo')} />

            <div className="field">
              <label className="field__l" htmlFor="desc">Description</label>
              <textarea id="desc" className="textarea" placeholder="What this token is for."
                value={f.description} onChange={(e) => set('description')(e.target.value)} maxLength={500} />
            </div>

            <div className="row">
              <div className="field">
                <label className="field__l" htmlFor="site">Website</label>
                <input id="site" className="input" placeholder="https://" value={f.website}
                  onChange={(e) => set('website')(e.target.value)} />
              </div>
              <div className="field">
                <label className="field__l" htmlFor="tw">X / Twitter</label>
                <input id="tw" className="input" placeholder="@handle" value={f.twitter}
                  onChange={(e) => set('twitter')(e.target.value)} />
              </div>
            </div>

            <hr className="rule" />

            <CharityPicker
              value={f.charity}
              charityId={f.charityId}
              onChange={(v) => setF((p) => ({ ...p, charity: v.address, charityId: v.charityId }))}
              onValidity={setCharityOk}
            />
            {shown('charity') && <p className="field__err" style={{ marginTop: -8 }}>{shown('charity')}</p>}

            <div className="field">
              <label className="field__l" htmlFor="split">
                Charity share <span style={{ color: 'var(--text-dim)', fontWeight: 500 }}>({f.charityBps / 100}%)</span>
              </label>
              <input id="split" type="range" min={minBps} max={10000} step={100}
                value={f.charityBps} onChange={(e) => set('charityBps')(Number(e.target.value))} />
              <div style={{ marginTop: 10 }}><SplitBar bps={f.charityBps} /></div>
              {errors.charityBps && <p className="field__err">{errors.charityBps}</p>}
            </div>

            {/* ⚠ Only when V2 is live. Offering a burn or an account share that the deployed
                launchpad cannot record would take somebody's permanent, unchangeable choice and
                silently drop it. Until then this is the field it has always been. */}
            {f.charityBps < 10000 && (
              usingV2() ? (
                <>
                  <RemainderSplit
                    value={rem}
                    charityBps={f.charityBps}
                    onChange={(next) => { setPayoutTouched(true); setRem(next) }}
                  />
                  {shown('creatorPayout') && <p className="field__err">{shown('creatorPayout')}</p>}
                </>
              ) : (
                /* ⛔ THE V1 FIELD, AND IT HAS TO BE HERE. Replacing it with the new one and then
                   gating the new one behind V2 left the V1 form with NO payout field at all — while
                   still refusing to launch without a payout address, which is a form that cannot be
                   completed and gives no clue why. Caught by rendering the page with V2 unset. */
                <div className="field">
                  <label className="field__l" htmlFor="payout">Your payout address</label>
                  <input id="payout" className="input mono" placeholder="0x…" value={f.creatorPayout}
                    onChange={(e) => { setPayoutTouched(true); set('creatorPayout')(e.target.value) }}
                    onBlur={blur('creatorPayout')} />
                  {shown('creatorPayout') && <p className="field__err">{shown('creatorPayout')}</p>}
                </div>
              )
            )}

            <hr className="rule" />

            <div className="field">
              <label className="field__l" htmlFor="pair">Paired asset</label>
              <select id="pair" className="select" value={f.pair}
                onChange={(e) => set('pair')(e.target.value as Address)}>
                {assets.map((p) => (
                  <option key={p.address} value={p.address}>
                    {p.symbol}
                    {/* ⚠ The "cannot be remitted" note stays. It is not a description of the route
                        like the sold-to-USDG one was, it is the reason picking this asset strands a
                        charity's fees, and the field error below only appears once it is chosen. */}

                  </option>
                ))}
              </select>
              {/* ⚠ The fallback describes selling to USDG, which is only true of a `sell-first`
                  asset. Left unscoped it stood in for any asset with no note of its own and would
                  have told somebody choosing ETH that their fees are sold to USDG, which they are
                  not. An asset with nothing to say now says nothing. */}
              {pairNote && <p className="field__h">{pairNote}</p>}
              {thinPool && (
                <p className="field__err">
                  No {pair.symbol}/USDG pool has depth right now, so fees earned in {pair.symbol}
                  {' '}cannot be sold on to a charity yet. They are not lost — they wait in this
                  launch's escrow and go out as soon as the pool can fill them — but the pair asset
                  is fixed for ever, so pick another unless you mean this.
                </p>
              )}
            </div>

            <div className="field">
              <label className="field__l" htmlFor="devbuy">
                Developer buy{' '}
                <span style={{ color: 'var(--text-dim)', fontWeight: 500 }}>(optional, in {pair.symbol})</span>
              </label>
              <input id="devbuy" className="input" inputMode="decimal" placeholder="0.0"
                value={f.devBuy} onChange={(e) => set('devBuy')(e.target.value)} />
              {errors.devBuy && <p className="field__err">{errors.devBuy}</p>}
            </div>

            <div className="field">
              <label className="field__l" htmlFor="exempt">Snipe tax exemptions</label>
              <div className="tagin">
                <input id="exempt" className="input" placeholder="0x wallet address"
                  value={exemptDraft} autoComplete="off"
                  onChange={(e) => setExemptDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addExempt() } }} />
                <button type="button" className="tagin__add" onClick={addExempt}
                  aria-label="Add this wallet" disabled={!isAddress(exemptDraft.trim())}>+</button>
              </div>
              {f.exemptions.length > 0 && (
                <div className="xtags">
                  {f.exemptions.map((a) => (
                    <span className="xtag" key={a}>
                      <span className="mono">{short(a, 4)}</span>
                      <button type="button" onClick={() => set('exemptions')(f.exemptions.filter((x) => x !== a))}
                        aria-label={`Remove ${a}`}>&times;</button>
                    </span>
                  ))}
                </div>
              )}
              <p className="field__h">
                Buys in the launch second pay 99%, decaying to zero across 3s.
              </p>
              {errors.exemptions && <p className="field__err">{errors.exemptions}</p>}
            </div>

            <div className="field">
              <label className="field__l" htmlFor="tax">
                Creator tax <span style={{ color: 'var(--text-dim)', fontWeight: 500 }}>({(f.creatorTaxBps / 100).toFixed(2)}%)</span>
              </label>
              <input id="tax" type="range" min={0} max={maxTax} step={25}
                value={f.creatorTaxBps} onChange={(e) => set('creatorTaxBps')(Number(e.target.value))} />
              {errors.creatorTaxBps && <p className="field__err">{errors.creatorTaxBps}</p>}
            </div>
          </div>

          <aside className="aside">
            <div className="panel panel--pad">
              <p className="eyebrow" style={{ marginBottom: '0.9rem' }}>What you are signing</p>
              <div className="kv"><span className="kv__k">Launch fee</span>
                <span className="kv__v mono">{fee === null ? '0' : `${formatEther(fee)} ETH`}</span></div>
              {/* ⚠ ONE figure that rises, not a sum shown as its parts. A trader pays a single
                  percentage on a trade, so "1% + 0.50%" asks the reader to add up what they are
                  about to be charged. Pons's 1% and the creator tax land on the same leg. */}
              <div className="kv"><span className="kv__k">Trading fee</span>
                <span className="kv__v">
                  {f.creatorTaxBps ? `${(1 + f.creatorTaxBps / 100).toFixed(2)}%` : '1%'}
                </span></div>
              {/* ⚠ The SHARE, rendered exactly as the slider above renders it: `charityBps / 100`,
                  stepping 1% at a time from the floor to 100. The two are the same number in the
                  same units, so they move together and cannot be read as disagreeing. It used to
                  show the share multiplied out into a percentage of volume, which is a different
                  quantity in different units sitting under a slider showing this one. */}
              <div className="kv kv--loud"><span className="kv__k">To the charity</span>
                <span className="kv__v">{f.charityBps / 100}%</span></div>
              <div className="kv"><span className="kv__k">Paired asset</span>
                <span className="kv__v">{pair.symbol}</span></div>
              <div style={{ marginTop: 16 }}><SplitBar bps={f.charityBps} small /></div>

              {/*
                ⛔⛔ THE REST IS ITEMISED HERE OR THE PANEL LIES BY OMISSION. `SplitBar` says
                "50% creator", which is true of the split and false about where the money goes the
                moment a burn or an X account is chosen. This is the last thing read before a
                signature that cannot be undone, so every destination is named, in percent OF ALL
                FEES — the figure that actually happens, not the share of the remainder typed above.
              */}
              {f.charityBps < 10000 && usingV2() && (
                <div style={{ marginTop: 14 }}>
                  {/* ⛔ `summaryRows`, never `toSplits`. The strict builder asserts a resolved
                      account and this renders on every keystroke — including before a lookup has
                      returned, where it threw during render and blanked the whole page. */}
                  {summaryRows(rem, f.charityBps).map((row) => (
                    <div className="kv" key={row.key}>
                      <span className="kv__k">{row.label}</span>
                      <span className="kv__v">{row.pct}%</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {err && <div className="panel panel--pad"><p className="field__err" style={{ margin: 0 }}>{err}</p></div>}

            {!address ? (
              <div className="banner" style={{ margin: 0 }}>Connect a wallet to launch.</div>
            ) : !onRightChain ? (
              <button className="btn btn--lg" onClick={() => void switchChain()}>Switch to Robinhood Chain</button>
            ) : (
              <>
                {/* ⚠ A disabled button with no reason reads as a broken site. The one condition a
                    launcher cannot otherwise see is the charity confirmation, so it is named. */}
                {!charityOk && Object.keys(errors).length === 0 && (
                  <p className="field__h" style={{ margin: '0 0 4px' }}>
                    Confirm the charity address above to enable this.
                  </p>
                )}
                <button className="btn btn--ink btn--lg" disabled={!ready || !!busy} onClick={() => void submit()}>
                  {busy ?? 'Launch token'}
                </button>
              </>
            )}
          </aside>
        </div>
      </div>
    </section>
  )
}
