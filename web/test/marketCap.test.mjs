import { test } from 'node:test'
import assert from 'node:assert/strict'
import { marketCapInPair, capUsdScaled, formatUsd } from '../src/lib/marketCap.ts'
import { usdPerUnitScaled } from '../src/lib/usdPrice.ts'

const E = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n   // whole units -> 18dp
const SUPPLY = 10n ** 27n                                    // 1e9 tokens at 18dp

test('matches the live COMPANY curve to the wei', () => {
  // read from chain: quote 1.680000000000000018 ETH, token reserve = full supply, no buys yet
  const cap = marketCapInPair({
    quoteReserve: 1680000000000000018n, tokenReserve: SUPPLY, totalSupply: SUPPLY, graduated: false,
  })
  assert.equal(cap, 1680000000000000018n, 'a launch with no buys is worth its phantom reserve')
})

test('the cap rises as the curve is bought', () => {
  const before = marketCapInPair({ quoteReserve: E(1.68), tokenReserve: SUPPLY, totalSupply: SUPPLY, graduated: false })
  const after = marketCapInPair({
    quoteReserve: E(3.36), tokenReserve: SUPPLY / 2n, totalSupply: SUPPLY, graduated: false,
  })
  assert.ok(after > before, 'more quote in and fewer tokens left must price the supply higher')
  assert.equal(after, E(6.72), 'price doubles twice over: 2x the quote against half the tokens')
})

/* ── the denomination trap ───────────────────────────────────────────────────────────────── */

test("⛔ a USDG pair is priced in USDG, not out by 1e12", () => {
  // 50,000 USDG (6dp) against half the supply of an 18dp token.
  const cap = marketCapInPair({
    quoteReserve: 50_000_000_000n, tokenReserve: SUPPLY / 2n, totalSupply: SUPPLY, graduated: false,
  })
  // price = 50,000 USDG per 5e8 tokens; whole supply of 1e9 is worth 100,000 USDG
  assert.equal(cap, 100_000_000_000n)
  // USDG is the dollar, so a USDG cap converts one for one
  assert.equal(formatUsd(capUsdScaled(cap, 6, 1_000_000n)), '$100k')
})

test("the token's own decimals cancel and cannot change the answer", () => {
  const at18 = marketCapInPair({
    quoteReserve: E(4), tokenReserve: 10n ** 26n, totalSupply: 10n ** 27n, graduated: false,
  })
  const at9 = marketCapInPair({
    quoteReserve: E(4), tokenReserve: 10n ** 17n, totalSupply: 10n ** 18n, graduated: false,
  })
  assert.equal(at18, at9, 'supply and reserve share a scale, so it divides out')
})

/* ── null, never a confident zero ────────────────────────────────────────────────────────── */

test('⛔ a graduated launch reports NULL, because graduating drains the curve', () => {
  assert.equal(marketCapInPair({ quoteReserve: 0n, tokenReserve: 0n, totalSupply: SUPPLY, graduated: true }), null)
  assert.equal(
    marketCapInPair({ quoteReserve: E(9), tokenReserve: SUPPLY, totalSupply: SUPPLY, graduated: true }), null,
    'the flag decides it, even if reserves happen to still read non zero',
  )
})

test('empty or unreadable reserves are null, not zero', () => {
  for (const s of [
    { quoteReserve: 0n, tokenReserve: SUPPLY, totalSupply: SUPPLY },
    { quoteReserve: E(1), tokenReserve: 0n, totalSupply: SUPPLY },
    { quoteReserve: E(1), tokenReserve: SUPPLY, totalSupply: 0n },
  ]) {
    assert.equal(marketCapInPair({ ...s, graduated: false }), null)
  }
})

test('a null cap formats as null so the row can render a dash', () => {
  assert.equal(formatUsd(null), null)
  assert.equal(capUsdScaled(null, 18, 2_432_380_000n), null)
  assert.equal(capUsdScaled(1n, 18, null), null, 'no USD rate means no figure, never a zero')
})

/* ── display ─────────────────────────────────────────────────────────────────────────────── */

test('dollars are compact and pinned to en-US', () => {
  assert.equal(formatUsd(4_086_398_400n), '$4.1k')
  assert.equal(formatUsd(15_453_920_000n), '$15.5k')
  assert.equal(formatUsd(3_400_000_000_000n), '$3.4m')
  assert.equal(formatUsd(900_000n), '$0.9')
  assert.equal(formatUsd(1n), '<$0.01', 'a dust cap must not read as $0')
})

/* ── the whole chain, on numbers read from the live chain ────────────────────────────────── */

test('⭐ COMPANY prices end to end against the real ETH/USDG pool', () => {
  // live reads: curve quote 1.680000000000000018 ETH against the full supply,
  // and the deepest ETH/USDG tier (fee=500) at sqrtPriceX96 3907468608440384951196632
  const cap = marketCapInPair({
    quoteReserve: 1680000000000000018n, tokenReserve: SUPPLY, totalSupply: SUPPLY, graduated: false,
  })
  const ethUsd = usdPerUnitScaled(3907468608440384951196632n, true, 18)
  assert.equal(ethUsd, 2432382263n, 'about $2,432 an ether, which is what all four tiers agreed on')
  const usd = capUsdScaled(cap, 18, ethUsd)
  assert.equal(formatUsd(usd), '$4.1k', '1.68 ETH at $2,432')
})

test('⛔ a USDG launch is NOT multiplied by the ether rate', () => {
  const cap = marketCapInPair({
    quoteReserve: 50_000_000_000n, tokenReserve: SUPPLY / 2n, totalSupply: SUPPLY, graduated: false,
  })
  const wrong = capUsdScaled(cap, 6, 2_432_380_000n)
  const right = capUsdScaled(cap, 6, 1_000_000n)
  assert.equal(formatUsd(right), '$100k')
  assert.ok(wrong > right * 2000n, 'the rate must come from the pair asset, not from whatever is handy')
})
