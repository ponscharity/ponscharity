import { test } from 'node:test'
import assert from 'node:assert/strict'
import { remitAssetFor, decimalsOf, owed } from '../src/keeper.ts'
import { canLeaveRhc } from '../src/decide.ts'

/**
 * The accounting keystone for selling stock-paired fees.
 *
 * ⛔⛔ WHAT THESE ARE GUARDING AGAINST, IN ONE SENTENCE: `CharityDistributor._release` credits
 * `totalToCharity[asset]` under the asset it RELEASED, which for a sold stock is USDG — so a keeper
 * that reads the ledger under the launch's `pairToken` sees a launch it has just sold as owing
 * nothing, and the proceeds become USDG in the vault that no launch claims.
 *
 * That is the same unattributed-money state that froze every donation for two days on 4 Sep 2026,
 * reached from the other direction. It has no on-chain fix — `Remitted` carries the asset, not the
 * launch — so it has to be impossible by construction, which is what `remitAssetFor` is for.
 */

const NATIVE = '0x0000000000000000000000000000000000000000'
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'
const AAPL = '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9'
const GME = '0x1b0E319c6A659F002271B69dB8A7df2F911c153E'
/** ⭐ 8 decimals, and the reason a `USDG ? 6 : 18` binary over PAIR assets is now wrong. */
const CBBTC = '0xcec185eB182c47d1bA1EFc84E6959e18cD620be4'

test('a bridgeable pair asset remits as itself', () => {
  assert.equal(remitAssetFor(NATIVE), NATIVE)
  assert.equal(remitAssetFor(USDG), USDG)
})

test('⛔⛔ every unbridgeable pair asset remits as USDG, because that is what the sell produces', () => {
  for (const stock of [AAPL, GME, CBBTC]) {
    assert.equal(remitAssetFor(stock), USDG, `${stock} must be accounted for in USDG`)
  }
})

test('the remit asset is always something Relay will actually carry', () => {
  for (const asset of [NATIVE, USDG, AAPL, GME, CBBTC]) {
    assert.ok(canLeaveRhc(remitAssetFor(asset)), `${asset} produced an unbridgeable remit asset`)
  }
})

test('⚠ case does not decide accounting — a checksummed and a lowercased stock agree', () => {
  assert.equal(remitAssetFor(GME), remitAssetFor(GME.toLowerCase()))
  assert.equal(remitAssetFor(USDG), remitAssetFor(USDG.toLowerCase()))
})

/**
 * ⭐ `decimalsOf` is a two-way binary and stays correct ONLY because it is fed remit assets. This
 * pins that reasoning: it is right for everything `remitAssetFor` can return, and wrong for cbBTC —
 * which is precisely why cbBTC must never reach it.
 */
test('decimalsOf is sound for every asset remitAssetFor can produce', () => {
  assert.equal(decimalsOf(remitAssetFor(NATIVE)), 18)
  assert.equal(decimalsOf(remitAssetFor(USDG)), 6)
  assert.equal(decimalsOf(remitAssetFor(CBBTC)), 6, 'a sold cbBTC launch is owed USDG, at 6dp')
})

test('⛔ decimalsOf would be WRONG for cbBTC as a pair asset — the reason pairDecimals exists', () => {
  assert.equal(decimalsOf(CBBTC), 18)
  assert.notEqual(decimalsOf(CBBTC), 8, 'cbBTC really is 8dp on chain; this binary cannot see that')
})

/**
 * The failure the whole change exists to prevent, expressed as arithmetic: a launch whose ledger is
 * read under the wrong key looks settled when it is owed money.
 */
test('⛔⛔ reading the ledger under the pair asset reports a sold launch as owing NOTHING', () => {
  const soldProceedsUsdg = 12_407_059n // the real GME position, from the fork rehearsal

  // What the chain holds after a sell: credited under USDG, zero under the stock.
  const totalToCharity = { [USDG.toLowerCase()]: soldProceedsUsdg, [GME.toLowerCase()]: 0n }

  const readUnder = (asset) => totalToCharity[asset.toLowerCase()] ?? 0n

  assert.equal(owed({ paidToVault: readUnder(GME) }, 0n), 0n, 'the bug: money exists, ledger says none')
  assert.equal(owed({ paidToVault: readUnder(remitAssetFor(GME)) }, 0n), soldProceedsUsdg, 'the fix')
})

test('a partly delivered sold launch is owed only the remainder', () => {
  assert.equal(owed({ paidToVault: 12_407_059n }, 10_000_000n), 2_407_059n)
  assert.equal(owed({ paidToVault: 12_407_059n }, 12_407_059n), 0n)
  assert.equal(owed({ paidToVault: 12_407_059n }, 99_000_000n), 0n, 'never negative')
})
