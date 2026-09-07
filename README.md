# Pons Charity

Launch a token on [Pons](https://ponsfamily.com) V2 whose trading fees are split with a charity, and
whose routing can be checked by a stranger without trusting us.

**[ponscharity.family](https://ponscharity.family)** · [@ponscharity](https://x.com/ponscharity)

---

## What this is

A token launched here names a charity when it is created. That name, the split, and the address the
fees are paid to are constructor arguments, so they are fixed from the first block and no key in
existence can change them afterwards.

The design goal is narrower than "route fees to charity", because the crypto half of that was always
trivial. In 2026 a charity-coin platform routed roughly $135M of trading volume under nonprofit
brands, credited charities about $997k of it into wallets they did not control, left $1.7M
undistributed across wallets belonging to organisations that had never heard of it, and did not
disclose its 10% fee. None of that was a hack. Every step was a discretionary decision taken by
whoever held the keys.

So the goal here is to **remove discretion where that is possible, and publish it where it is not**.

Every donation the launchpad has ever made is listed on
[the home page](https://ponscharity.family/#donations) and on each token's own page, with a link to
the transaction that moved the money. Those rows are read from `CharityPayer.Paid` on Base in the
visitor's browser, not served from here — so the amounts and the recipients are checkable on an
explorer we do not run. ⚠ No figures are quoted in this file on purpose: a README that freezes a
total is wrong by the next donation, and a number that has quietly stopped being true spends more
trust than it earns.

## How the money moves

```
 trades ──1%──► Pons curve ──sweep──► fee escrow ──claim──► CharityDistributor
                                                                    │
                                        immutable split, no owner ───┤
                                                                    ├──► RemitVault (RHC)
                                                                    │         │  bridge
                                                                    │         ▼
                                                                    │    CharityPayer (Base)
                                                                    │         │
                                                                    │         ▼
                                                                    │    Donate.gg relay ──► charity
                                                                    └──► creator payout
```

1. **A token trades.** Pons charges 1% on every buy and sell. Thirty percent is Pons's own fee and
   seventy percent is the creator side, which is 0.70% of volume at a 0% creator tax.
2. **`CharityDistributor` splits it.** One per launch, no owner, no setters, no upgrade path, no
   withdraw and no arbitrary call. It claims from Pons's escrow and pushes both halves to two
   addresses fixed at construction. **Permissionless**, so it keeps working whoever is watching.
3. **The charity share pools in `RemitVault`** on Robinhood Chain.
4. **The keeper bridges it to `CharityPayer` on Base.** This is the one step a key signs.
5. **Anyone calls `payer.pay(configId, USDC)`**, which donates through Donate.gg's public relay.
   **Permissionless** again.

A charity that publishes its own wallet skips steps 3 to 5 entirely: the distributor pays that
address directly and nothing passes through us.

## ⛔ The part that is not trustless, stated plainly

**Step 4 is trusted.** The bridge puts its destination in an off-chain request rather than in the
transaction, so no contract on Robinhood Chain can verify where a transfer will land. That hop
cannot be made trustless, and any description claiming otherwise is wrong.

What the design does instead is shrink what that trust can reach:

- The vault **refuses any instruction that is not a bridge deposit naming itself as the sender**.
- It **caps how much can leave per remit**, set at deployment and unraisable.
- It **emits the bridge request id**, which resolves through the bridge's public API to the address
  actually paid. Verifying it needs neither our word nor our cooperation.
- The far side is a contract whose **only outbound call is a donation**. No owner, no withdraw, no
  rescue. A key that misdirected a bridge could not touch what had already arrived.
- The final donation is **open to anyone**, so the money is never stuck behind one person.

**Which launch each donation came from is also trusted, and it is the only figure on the site not
read from a chain.** `CharityPayer.Paid` carries a config id and an amount and no launch token: the
bridge credits the payer itself, so the money arrives on Base having forgotten what earned it, and
the near side — `RemitVault.Remitted` — records the *pair asset*, not the launch. Nothing a browser
can reach holds the join, so the keeper publishes it at `/api/donations`.

That index publishes **only the join**: a launch token and a transaction hash, never an amount or a
charity. Every figure a row shows still comes from the `Paid` event the browser reads itself. So the
index can misattribute a donation and **cannot invent or inflate one**, and a hash with no event
behind it never renders.

A listed charity's share does pass through an account we operate. That was chosen deliberately: the
alternative was supporting four charities instead of thousands. What is *not* operated is who the
money is for, which is written into the launch where no key can change it.

## Deployed contracts

| Contract | Chain | Address |
| --- | --- | --- |
| `CharityLaunchpad` | Robinhood Chain | [`0xF1755477b2931E6e8fc2B0f6b7d66B4AA7EeEfE3`](https://robinhoodchain.blockscout.com/address/0xF1755477b2931E6e8fc2B0f6b7d66B4AA7EeEfE3) |
| `RemitVault` | Robinhood Chain | [`0x7F954db64FeC530C679c6b093a139eFB8089D7D2`](https://robinhoodchain.blockscout.com/address/0x7F954db64FeC530C679c6b093a139eFB8089D7D2) |
| `CharityPayer` | Base | [`0xb3190e0AeCD4F9F502133A354BBFbA64f2eF79f2`](https://basescan.org/address/0xb3190e0AeCD4F9F502133A354BBFbA64f2eF79f2) |
| Pons V2 factory | Robinhood Chain | [`0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`](https://robinhoodchain.blockscout.com/address/0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e) |
| Donate.gg relay | Base | [`0x02A0d2a39732082b824a5A3D3b026C54d581DCC8`](https://basescan.org/address/0x02A0d2a39732082b824a5A3D3b026C54d581DCC8) |

Terms, all immutable: **50% minimum charity share**, caps of **5 ETH / 25,000 USDG** per remit.

### $CHARITY

The site's own token, launched here on the same terms as any other. It pays
[Operation Hope, Inc.](https://www.donate.gg/charities/operation-hope) and its share is fixed in the
same constructor arguments as everyone else's.

| | |
| --- | --- |
| Contract | [`0x030FA758daD53f0D6e23cfD3a8Fe7bC7B54E5Ac9`](https://robinhoodchain.blockscout.com/address/0x030FA758daD53f0D6e23cfD3a8Fe7bC7B54E5Ac9) |
| Pair asset | Native ETH |
| Charity share | 50% |
| Page | [ponscharity.family](https://ponscharity.family/token/0x030FA758daD53f0D6e23cfD3a8Fe7bC7B54E5Ac9) |

A `CharityDistributor` is deployed per launch, so each token has its own; its address is recorded in
the launchpad's on-chain register alongside the charity it pays.

## Layout

| | |
| --- | --- |
| `contracts/` | Solidity, Foundry. The launchpad, the per-launch distributor, the vault, the payer, and the V4 seller that converts tokenized-stock fees to USDG. |
| `remit/` | The keeper. The one process that signs, and the smallest thing that could be. |
| `remit/ops/` | The systemd units that supervise it, and the ledger backup. |
| `web/` | The front end. A static React site that reads the chain in the visitor's browser. |
| `api/` | Two endpoints: a token's logo, and the donation attribution index. The only server. |

## Running it

```bash
# contracts. Fork tests need a Robinhood Chain RPC; they skip without one.
cd contracts && forge test

# the keeper. A dry run is the default and signs nothing.
cd remit && npm i
LAUNCHPAD=0x… REMIT_VAULT=0x… CHARITY_PAYER=0x… \
  node --experimental-strip-types src/keeper.ts

# the front end
cd web && npm i && npm run dev
```

`web/.env.production` carries `VITE_LAUNCHPAD` and `VITE_REMIT_VAULT`. It is not in this repository,
and neither is any key: the keeper reads `KEEPER_KEY` from its environment and it is never written to
a file, never logged, and never committed.

## How the keeper is supervised

`remit/ops/` holds the units. Three properties are load bearing rather than incidental:

- **`Type=oneshot`.** systemd will not start a second instance while one runs, and a timer that fires
  mid-pass is skipped rather than queued. The keeper's one-launch-at-a-time rule is enforced *within*
  a pass, so two overlapping passes would race on the single shared payer and whichever `pay` fired
  first would donate both launches' money to its own charity. `Persistent=false` for the same reason:
  a missed pass must not fire a catch-up burst.
- **Arming is the presence of a file.** Without `KEEPER_KEY` the keeper refuses to send and prints a
  dry run, so the whole path can be installed and proven long before a key exists anywhere near it.
- **The ledger is backed up on change, not on a schedule.** `receipts.json` is the only state that
  cannot be rebuilt from the chain: `totalToCharity` is a lifetime figure, so what is still owed is
  that minus what has been remitted, and that subtrahend lives nowhere else. The vault's `Remitted`
  event records the amount and the request id but **not which launch it was for**, so with two
  launches paired in the same asset the attribution exists in that file alone.

## Some things worth knowing

- **The site is static and has no backend**, because Robinhood Chain makes a block roughly every
  100ms and the public RPC caps `eth_getLogs` at 2,000 blocks, about three minutes of history. A feed
  built on events would need an indexer, a database and a daemon. The launchpad keeps an on-chain
  array instead, read with one `eth_call`.
- **Only ETH and USDG can leave the chain,** and a launch paired against a tokenized stock therefore
  **cannot currently pay its charity at all**. `contracts/src/V4Seller.sol` is the intended answer —
  it sells stock fees to USDG directly against the Uniswap V4 singleton, because this chain has no
  canonical router — but **it is written and not deployed**, and nothing calls it yet.

  ⛔ Until it is, the keeper refuses a stock-paired launch *before* harvesting it, and that ordering
  is the whole safety property. `harvest()` does not merely claim, it **pushes** the charity's share
  into `RemitVault` — and the vault has three functions, `remitToken`, `remitNative`, `setKeeper`.
  No swap, no withdraw, no rescue. `remitToken` reverts `NoCapForAsset` for an asset that was never
  given a cap, so a stock that reached the vault could never leave it: not delayed, gone. Skipping
  the launch entirely leaves the share in the distributor's escrow, where it stays recoverable the
  day a seller exists. Nothing has been lost to this, because no stock-paired launch has yet earned
  a fee.
- **Pairing against USDG delivers more of every fee** than pairing against ETH, because the native
  route crosses a swap spread that does not shrink with size. The pair asset cannot be changed after
  launch.
- **A developer buy settles in the same transaction as the launch**, through Pons's periphery, so
  there is no intermediate state to trade against. The bought tokens go to `msg.sender`: Pons V1
  chose the buyer for you and sent it to the fee recipient, which here is a contract that cannot
  move a token balance out.
- **Nothing is claimed, it is pushed.** `harvest()` pulls from the escrow and releases in the same
  call, to both sides. There is no balance sitting anywhere waiting to be withdrawn.

## ⚠ What this is not

- A token is not an investment, and launching one is not a donation. What reaches a charity depends
  entirely on whether people trade, and that may be nothing.
- Being listed in the directory is not an endorsement or an agreement. The directory comes from
  Donate.gg. An organisation appearing in it has not agreed to receive anything from a token
  launched here and may not know it exists.
- The donation relay does not validate charity ids. A donation to an id belonging to nobody succeeds
  and the money is gone, which is why every id on the site was read from Donate.gg's own API and none
  was typed by hand.

## Licence

MIT. See [LICENSE](LICENSE).
