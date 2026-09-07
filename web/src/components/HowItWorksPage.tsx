import { addrUrl, short } from '../lib/chain.ts'
import { BASE_EXPLORER, CHARITY_PAYER_BASE, LAUNCHPAD, PONS_FACTORY, REMIT_VAULT, isLive } from '../lib/launchpad.ts'
import { DONATION_RELAY } from '../lib/charities.ts'

/**
 * The full explanation, and the page the rest of the site defers to.
 *
 * ⭐ The contract table is generated from the SAME constants the app transacts with, never typed
 * out. A transparency section listing an address the site does not actually use is worse than no
 * section: it reads as proof while pointing somewhere else. `LAUNCHPAD` in particular comes from the
 * build's env, so if the launchpad is ever redeployed this table follows it without an edit.
 */

const RHC = (a: string) => ({ href: addrUrl(a), label: short(a, 6) })
const BASE = (a: string) => ({ href: `${BASE_EXPLORER}/address/${a}`, label: short(a, 6) })

function ContractRow({ name, chain, what, link }: {
  name: string; chain: string; what: string; link: { href: string; label: string }
}) {
  return (
    <div className="ctr">
      <div className="ctr__id">
        <span className="ctr__name">{name}</span>
        <span className="ctr__chain">{chain}</span>
      </div>
      <p className="ctr__what">{what}</p>
      <a className="ctr__addr mono" href={link.href} target="_blank" rel="noreferrer noopener">{link.label}</a>
    </div>
  )
}

export function HowItWorksPage() {
  return (
    <section className="page">
      <div className="wrap">
        <div className="chead">
          <p className="eyebrow" style={{ justifyContent: 'center' }}>How it works</p>
          <h1 className="chead__h">How charity tokens work</h1>
          <p className="chead__sub">
            Launch a token on Pons V2 and choose a charity to receive its trading fees.
          </p>
          <p className="chead__sub" style={{ marginTop: 12 }}>
            The charity, fee split and other launch parameters are fixed onchain from the moment the
            token is created.
          </p>
        </div>

        <div className="hiw">
          <div className="steps">
            <div className="step">
              <div className="step__n">01</div>
              <h3>Launch a token</h3>
              <p>
                Choose your token, paired asset, charity and fee split.
                <br /><br />
                One transaction launches the token and deploys its distributor. The distributor
                becomes the fee recipient from the first block, these settings cannot be changed.
              </p>
            </div>

            <div className="step">
              <div className="step__n">02</div>
              <h3>Every trade generates fees</h3>
              <p>
                Pons charges a 1% fee on every buy and sell.
                <br /><br />
                70% of the Pons creator-side fee goes to your distributor, giving the charity a share
                of 0.70% of trading volume when the full creator-side fee is routed through the
                launch.
              </p>
            </div>

            <div className="step">
              <div className="step__n">03</div>
              <h3>The distributor splits the fees</h3>
              <p>
                Fees held in escrow are automatically distributed according to the percentages set
                at launch, with a minimum of 50% always allocated to the chosen charity.
              </p>
            </div>

            {/*
              ⚠ A step of its own, because it is the only decision on this page a launcher makes
              that has more than one answer — and it is permanent. Burying it inside "the distributor
              splits the fees" left the three options undocumented anywhere a reader would look.
            */}
            <div className="step">
              <div className="step__n">04</div>
              <h3>The fee split</h3>
              {/*
                ⛔ WRAPPED IN ONE ELEMENT, because `.step` is a THREE-COLUMN GRID expecting exactly
                three children: the number, the heading, and the body. A fourth and fifth child do
                not stack under the body — they wrap onto a new row starting in the 62px number
                column, which renders the whole list one word per line.
              */}
              <div className="step__body">
                <p>
                  Every token launched must allocate at least 50% of its fees to a charity.
                </p>
                <p>
                  The remaining fees can be distributed across up to three destinations:
                </p>
                <ul className="hiw__list">
                  <li><strong>Wallet</strong> — Send fees directly to any wallet, paid out
                    automatically in the asset the token is paired with.</li>
                  <li><strong>X or GitHub account</strong> — Allocate fees to an X or GitHub
                    account. The share can only be claimed by signing in with the linked
                    account.</li>
                  <li><strong>Buyback &amp; Burn</strong> — Uses fees to automatically buy the token
                    on its own curve and burn the tokens, permanently reducing the supply.</li>
                </ul>
                <p>
                  These allocations are set when the token launches and are permanently locked into
                  the contract. They cannot be changed afterwards.
                </p>
              </div>
            </div>

            <div className="step">
              <div className="step__n">05</div>
              <h3>Fees are sent to the charity</h3>
              <p>
                The charity's share is automatically bridged and distributed through{' '}
                <a href="https://www.donate.gg" target="_blank" rel="noreferrer noopener">Donate.gg</a>{' '}
                to the selected charity.
                <br /><br />
                The funds go straight from the distributor to the charity without passing through us.
              </p>
            </div>

            <div className="step">
              <div className="step__n">06</div>
              <h3>Everything is verifiable</h3>
              <p>
                Every launch is transparent from start to finish. The charity, fee split, paired
                asset and fee configuration are all recorded onchain, along with every distribution,
                bridge transfer and completed donation.
              </p>
            </div>
          </div>
        </div>

        {/* ⭐ Generated from the constants the app transacts with, so it cannot drift from reality. */}
        <div className="hiw hiw--center">
          <h2 className="hiw__h">Contracts</h2>
          <div className="ctrs">
            {isLive() && (
              <ContractRow
                name="Pons Charity" chain="Robinhood Chain" link={RHC(LAUNCHPAD)}
                what="Deploys a distributor and launches the token in one transaction, and keeps the register of every launch."
              />
            )}
            <ContractRow
              name="Pons V2 factory" chain="Robinhood Chain" link={RHC(PONS_FACTORY)}
              what="Pons's own launch factory. It creates the token and the bonding curve, and holds the fee escrow."
            />
            <ContractRow
              name="Vault" chain="Robinhood Chain" link={RHC(REMIT_VAULT)}
              what="It accepts nothing but bridge instructions and caps how much can move at a time."
            />
            <ContractRow
              name="Bridge" chain="Base" link={BASE(CHARITY_PAYER_BASE)}
              what="It has no owner and no withdraw, and the only call it can make is a donation."
            />
            <ContractRow
              name="Relay" chain="Base" link={BASE(DONATION_RELAY)}
              what="Donate.gg's public donation relay, the contract that pays the charity."
            />
          </div>
        </div>
      </div>
    </section>
  )
}
