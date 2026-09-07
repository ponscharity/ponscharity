/**
 * The home page summary. The full explanation is the `/how-it-works` page, and this defers to it.
 *
 * ## ⛔⛔ WHAT THIS SECTION USED TO SAY, AND WHY IT HAD TO CHANGE
 *
 * It described an earlier design and three of its statements had become false:
 *
 * - *"bridges to their own address on Ethereum"*. It goes to Base, into a contract that can only
 *   donate, and then through donate.gg's relay.
 * - *"We do not list charities. You supply the address. We will not publish a directory of
 *   nonprofits who never agreed to be on one."* There is a directory of 2,705, one click away in
 *   the header. The site contradicted itself.
 * - *"We never hold your money. Nothing accumulates here, and this site has no wallet that could
 *   receive it."* A listed charity's share pools in the remit vault on its way out. That was a
 *   deliberate choice, taken so thousands of charities could be paid instead of four, and the honest
 *   move is to say so rather than to keep a sentence that reads better.
 *
 * ⚠⚠ Wrong copy about custody is worse than no copy about custody. This is a page about somebody
 * else's donations, and the first thing a sceptical reader checks is whether the site's own account
 * of itself matches what the contracts do.
 *
 * ⚠ The "what we do not claim" panel that used to sit under these steps has been removed, along
 * with the link out to the full page. The disclosures themselves still exist in full on
 * `/how-it-works`, which the header and the footer both link to; this section is now a summary and
 * nothing more.
 */
export function HowItWorks() {
  return (
    <section id="how" className="section--alt">
      <div className="wrap">
        <div className="head head--center">
          <p className="eyebrow">How it works</p>
          <h2>Charity Tokens on Pons</h2>
        </div>

        <div className="steps">
          <div className="step">
            <div className="step__n">01</div>
            <h3>You launch</h3>
            <p>
              One transaction deploys the distributor and launches your token on Pons, with the
              distributor set as the fee recipient. The charity address and fee split are constructor
              arguments, making them immutable from the first block.
            </p>
          </div>

          <div className="step">
            <div className="step__n">02</div>
            <h3>Fees collect automatically</h3>
            <p>
              Pons charges a 1% fee on every buy and sell, with 0.70% going to the creator
              side. Fees accumulate and are automatically distributed to your chosen charity. The
              system is permissionless and fully verifiable onchain.
            </p>
          </div>

          <div className="step">
            <div className="step__n">03</div>
            <h3>It reaches the charity</h3>
            <p>
              Fees are automatically bridged and routed to the charity with the donation settled
              through Donate.gg. Every payout is recorded onchain, creating a transparent trail from
              the token fees to the charity that receives them.
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}
