# The keeper

The one process that signs. Everything else in this system is permissionless.

```bash
# Dry run. This is the default and it signs nothing.
LAUNCHPAD=0xBBDb5bdAe2A7Eea175aE57468cBE8A7740116f9d \
REMIT_VAULT=0x7F954db64FeC530C679c6b093a139eFB8089D7D2 \
CHARITY_PAYER=0xb3190e0AeCD4F9F502133A354BBFbA64f2eF79f2 \
  node --experimental-strip-types src/keeper.ts

# Act. Needs the keeper key, and it is checked against the vault before anything is signed.
KEEPER_KEY=0x… … node --experimental-strip-types src/keeper.ts --send
```

## What it does

1. `sweepCurve` and `harvest` on each launch. **Permissionless**: the keeper runs them only because
   somebody has to.
2. Quote a bridge from the vault to `CharityPayer` on Base.
3. `vault.remitToken` / `remitNative`. **The only signed step that moves money.**
4. `payer.pay(configId, USDC)` on Base. Permissionless again.

## ⛔ The rules it enforces

- **`--send` is never the default.** The failure mode of a remit runner is not idleness, it is
  acting once, wrongly, on somebody else's donation.
- **One launch at a time.** The vault pools every launch's share but each names a different charity.
  Remitting the whole balance and then splitting the donation is how the wrong charity gets paid.
- **The config id comes from the chain**, never from configuration. It is the promise the token made.
- **The key is checked against the vault's `keeper()` before signing.** Signing with the wrong key
  wastes gas and tells anyone watching that a non-keeper key is being used here.
- **The quote is fetched immediately before signing.** A stale Relay deposit is rejected or refunded
  on the origin side: money out, nothing delivered.
- **The ledger is written after the bridge and before the donation.** A crash between the two must
  not make the next pass send the same money twice. An undonated balance in the payer is recoverable
  by anyone calling `pay`; a double bridge is not.
- **The cap clamps rather than refuses**, so a launch earning more than one remit's worth is sent
  across several passes instead of stalling behind a cap that was set immutably on purpose.

## Gas the keeper needs

Costed from measured gas at **4x** current prices, so the answer survives a spike:

| | per completed remit | 0.05 ETH buys | 0.01 ETH buys |
| --- | --- | --- | --- |
| Robinhood Chain | 0.000111 ETH (~$0.27) | ~450 remits | |
| Base | 0.0000065 ETH (~$0.016) | | ~1,500 remits |

**Suggested: 0.05 ETH on Robinhood Chain, 0.01 ETH on Base.** Top up when either falls below a
quarter of that.

⭐ **A launch with nothing to move costs nothing.** The keeper simulates before it sends, so a quiet
launch is two `eth_call`s rather than two reverting transactions.

🔴🔴 That was not free. The first version wrapped `sweepCurve` and `harvest` in `try { write }
catch {}`, and **a reverted transaction still costs gas**. A keeper polling a handful of quiet
launches hourly would have burned real money doing nothing, for ever, draining the wallet it exists
to keep funded. Cost matters here in the same way it does for a burn cranker: an unattended process
that pays to do nothing is a slow leak nobody notices.

⚠ Remits are bounded by what is **earned**, not by how often the keeper wakes up. Waking more often
costs nothing extra.

## The remit policy lives in `decide.ts`

⛔ It used not to be wired in at all. The keeper carried two flat minimums — 0.02 ETH and 50 USDG —
while `decide.ts`, with its hard floor, per-asset loss targets and custody limit, was imported by
nothing. Its own header said *"this is the only judgement the remit service makes"* and it made none.

A flat floor in an asset's own units could not express either half of the real trade:

- **Is this batch worth what the crossing costs?** 0.02 ETH is a different amount of money every
  day and says nothing about the fee. The policy asks what fraction of the donation the bridge eats,
  against a quote that prices both sides in USD, and holds a batch that is too small **for its own
  route** — the targets are per asset because the native route floors at ~0.49% forever (the ETH→USDC
  spread never shrinks) while USDG→USDC keeps improving.
- **How long may a charity's money sit in a hot wallet?** Cost alone converges on holding it for
  ever. `maxHoldMs` is 24h and overrides the cost gate. ⛔ It does **not** lift the hard floor: age
  says stop holding this, not hold it and also destroy it in fees.

⭐ The dry run makes the same call on the same inputs, so a preview cannot report a remit that
`--send` would then decline. It deliberately does not arm the held clock — previewing must not change
what the real pass does.

## ⛔⛔ ONE LAUNCH AT A TIME, ENFORCED

`CharityPayer.pay(configId, token)` donates the contract's **entire** balance to one config id. That
is deliberate — a partial amount would be a discretion over somebody else's donation — and it means
the payer must never hold two launches' money at once.

The keeper used to check `balanceOf(payer) > 0` and read that as "my bridge landed". Those are
different questions on a shared account, and the keeper has a normal path that leaves money in it:
when a delivery outruns the two minute wait it logs "anyone can call `pay` once it lands" and moves
on. So launch B's slow 100 USDC would still be sitting there when launch A bridged 50, and A's `pay`
would donate **all 150 to A's charity** — with B's ledger already counting its 100 as remitted, so
nothing would ever retry it. One condition checked where two govern: *is there money here* against
*is there money here **and is it mine***.

`settle.ts` now holds that rule, and `test/settle.test.mjs` pins it:

| in flight | at the payer | what happens |
| --- | --- | --- |
| none | empty | bridge |
| this launch's | landed | donate it to **its own** config id, then bridge |
| another launch's | in flight | **stop.** Nothing bridges until it lands and is donated |
| none | money | **stop, and never guess a charity** |

⛔ The last row is the one that matters most. Unattributed money at the payer — a lost ledger, or
anyone at all sending USDC to a public address — is not an invitation to pick a charity. `pay` is
permissionless precisely so a human or the charity can resolve it from the vault's `Remitted` events
and Relay's request ids. Guessing turns a recoverable situation into an irreversible one.

## ⚠ `receipts.json`

The one piece of state kept off chain: how much has already been remitted per launch, **and the one
delivery currently in flight**. The distributor's `totalToCharity` is a lifetime figure, so the
amount owed is that minus this.

```json
{ "version": 2,
  "remitted": { "0x<launched token>": "<amount in the pair asset's units>" },
  "pending": { "token": "0x…", "charityId": "0x…", "amount": "…", "requestId": "0x…", "bridgedAtMs": 0 } }
```

The `pending` half is what makes a stuck delivery resolvable **by a human without this file**: the
request id resolves through Relay to the address it actually paid. ⚠ The original flat
`{ "0xtoken": "amount" }` shape is migrated on read, and an unreadable file is treated as absent
rather than throwing.

⛔ Losing this file makes the keeper try to send everything again. Back it up with the same care as
the key, for a different reason. ⭐ Losing it is no longer silent, though: an absent ledger with
money at the payer is the "stop, never guess" row above rather than a misdirected donation.

## What is proven

On a fork of live Robinhood Chain, with a real launch, a real 8 ETH buy and a **real Relay quote**:
sweep, harvest, and a 5 ETH bridge through the vault, which accepted the genuine 68 byte deposit
payload and logged the request id. The cap clamped 5.544 ETH to 5 and left the rest for the next
pass. The delivery and `pay` legs cannot be fork-tested, because Relay is a real service that will
not settle against forked state; both are separately proven on a Base fork, where 250 USDC was
actually donated to St. Jude through the relay.
