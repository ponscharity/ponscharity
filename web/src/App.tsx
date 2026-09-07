import { useCallback, useEffect, useState } from 'react'
import { WalletProvider, useWallet } from './lib/wallet.tsx'
import { SessionProvider } from './lib/session.tsx'
import { readLaunches, readMinCharityBps, type Launch } from './lib/launchpad.ts'
import { useRoute } from './lib/router.ts'
import { Header } from './components/Header.tsx'
import { Hero } from './components/Hero.tsx'
import { HowItWorks } from './components/HowItWorks.tsx'
import { HowItWorksPage } from './components/HowItWorksPage.tsx'
import { LaunchForm } from './components/LaunchForm.tsx'
import { Launches } from './components/Launches.tsx'
import { Donations } from './components/Donations.tsx'
import { fetchAllDonations, type Donation, type DonationScan } from './lib/donations.ts'
import { Explore } from './components/Explore.tsx'
import { Charities } from './components/Charities.tsx'
import { MyTokens } from './components/MyTokens.tsx'
import { ClaimFees } from './components/ClaimFees.tsx'
import { AccountClaim } from './components/AccountClaim.tsx'
import { TokenPage } from './components/TokenPage.tsx'
import { Footer } from './components/Footer.tsx'

function Site() {
  const route = useRoute()
  const { address } = useWallet()
  const [launches, setLaunches] = useState<Launch[]>([])
  const [minBps, setMinBps] = useState(5000)
  const [loading, setLoading] = useState(true)
  /* ⭐ Fetched ONCE and shared. The hero's headline and the donations list are the same facts, and
     two independent scans of Base would both cost requests and be able to disagree with each other
     on screen. */
  const [donations, setDonations] = useState<Donation[]>([])
  const [donLoading, setDonLoading] = useState(true)
  const [donFailed, setDonFailed] = useState(false)
  /* ⛔ False while any chunk of the log walk went unanswered. The headline total is a LOWER BOUND
     until this is true, so it is not printed as a figure. See `readChunk` in lib/donations.ts. */
  const [donComplete, setDonComplete] = useState(false)

  const refresh = useCallback(() => {
    /* ⚠ Block-bodied, not a concise arrow. A `useEffect(() => promise)` returns the promise as if it
       were a cleanup function, and React 19 renders a blank page with no error, which passes every
       headless check because Playwright's Chromium renders it fine. */
    void (async () => {
      try {
        const [l, m] = await Promise.all([readLaunches(), readMinCharityBps()])
        setLaunches(l)
        setMinBps(m)
      } catch {
        /* The chain being unreachable must not blank the page: each section renders its own empty
           state and the launch form still validates. */
      } finally {
        setLoading(false)
      }
    })()
  }, [address])

  useEffect(() => { refresh() }, [refresh])

  useEffect(() => {
    /* ⚠ Block-bodied: a concise arrow hands React the promise as a cleanup function and React 19
       renders a blank page with no error. */
    void (async () => {
      try {
        /* ⚠ Rendered twice on purpose: once the moment the logs are in, and again when the block
           times land. The second pass only fills in each row's age. */
        const apply = (scan: DonationScan) => {
          setDonations(scan.rows)
          setDonComplete(scan.complete)
          setDonLoading(false)
        }
        apply(await fetchAllDonations({ onPartial: apply }))
      } catch {
        setDonFailed(true)
      } finally {
        setDonLoading(false)
      }
    })()
  }, [])

  return (
    <>
      <Header route={route} />
      <main>
        {route.name === 'token' ? (
          <TokenPage address={route.address} />
        ) : route.name === 'mine' ? (
          <MyTokens launches={launches} loading={loading} />
        ) : route.name === 'claim' ? (
          <>
            <ClaimFees launches={launches} loading={loading} onDone={refresh} />
            {/* ⚠ Below the wallet panel, not merged into it. Both answer "what am I owed", but on
                the strength of different proofs against different contracts — a single merged list
                would make one revert look like the other's problem. */}
            <AccountClaim launches={launches} />
          </>
        ) : route.name === 'how' ? (
          <HowItWorksPage />
        ) : route.name === 'charities' ? (
          <Charities />
        ) : route.name === 'explore' ? (
          <Explore launches={launches} loading={loading} />
        ) : route.name === 'launch' ? (
          <LaunchForm minBps={minBps} onLaunched={refresh} />
        ) : (
          <>
            <Hero launches={launches} minBps={minBps} loading={loading}
              donations={donations} donationsLoading={donLoading} donationsComplete={donComplete} />
            <HowItWorks />
            <Launches launches={launches} loading={loading} />
            <Donations rows={donations} loading={donLoading} failed={donFailed} complete={donComplete} />
          </>
        )}
      </main>
      <Footer />
    </>
  )
}

export default function App() {
  return (
    <WalletProvider>
      {/* ⚠ Inside the wallet provider, not beside it. The two identities are independent, but the
          claim page needs both at once: an ACCOUNT proves the share is yours and a WALLET is where
          it gets paid. */}
      <SessionProvider>
      <Site />
      </SessionProvider>
    </WalletProvider>
  )
}
