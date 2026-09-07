import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fitsVault, RHC_CHAIN_ID, VAULT_DEPOSIT_SELECTOR } from '../src/relay.ts'

const VAULT = '0x7F954db64FeC530C679c6b093a139eFB8089D7D2'
const DEPOSITOR = '0x4cd00e387622c35bddb9b4c962c136462338bc31'
const ID = 'd7dbf434c594732864ef0480f6a1cf41b474882d7190fb4439f2bd222f2798bd'
const AMOUNT = 20000000000000000n

/** The exact 68 bytes Relay returns when the direct route is up: selector, user, request id. */
const legacy = (user = VAULT) =>
  `${VAULT_DEPOSIT_SELECTOR}${'0'.repeat(24)}${user.slice(2).toLowerCase()}${ID}`

const quote = (over = {}) => ({
  requestId: `0x${ID}`,
  deposit: { to: DEPOSITOR, data: legacy(), value: AMOUNT, chainId: RHC_CHAIN_ID, ...over },
  inUsd: 50, outUsd: 49.9, outFormatted: '49.9', timeEstimateSec: 4, needsApproval: false, at: Date.now(),
})
const base = { vault: VAULT, depositor: DEPOSITOR, amount: AMOUNT, isNative: true }

test('accepts the shape the vault pins', () => {
  assert.equal(fitsVault(quote(), base).ok, true)
})

test('refuses the v3 router multicall that broke the service', () => {
  /* The real failure: a 2-6KB 0xcd6e13f7 call against Relay's v3 erc20Router. */
  const r = fitsVault(quote({
    to: '0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f',
    data: '0xcd6e13f7' + '00'.repeat(3264),
  }), base)
  assert.equal(r.ok, false)
  assert.match(r.reason, /not the vault's depositor/)
})

test('refuses a deposit addressed at the right selector but the wrong contract', () => {
  const r = fitsVault(quote({ to: '0x000000000000000000000000000000000000dEaD' }), base)
  assert.equal(r.ok, false)
  assert.match(r.reason, /depositor/)
})

test('refuses the ERC-20 deposit shape (132B depositErc20)', () => {
  const r = fitsVault(quote({ data: '0xe8017952' + '00'.repeat(128) }), base)
  assert.equal(r.ok, false)
  assert.match(r.reason, /132B/)
})

test('refuses a deposit that names somebody else as the depositor', () => {
  /* Relay refunds a failed request to this account, so this one routes refunds away from the vault. */
  const r = fitsVault(quote({ data: legacy('0x000000000000000000000000000000000000dEaD') }), base)
  assert.equal(r.ok, false)
  assert.match(r.reason, /names .* not the vault/)
})

test('refuses a native deposit carrying the wrong value', () => {
  const r = fitsVault(quote({ value: AMOUNT - 1n }), base)
  assert.equal(r.ok, false)
  assert.match(r.reason, /wei/)
})

test('an ERC-20 remit must carry no value', () => {
  assert.equal(fitsVault(quote({ value: 0n }), { ...base, isNative: false }).ok, true)
  assert.equal(fitsVault(quote(), { ...base, isNative: false }).ok, false)
})

test('refuses a deposit for the wrong chain', () => {
  const r = fitsVault(quote({ chainId: 8453 }), base)
  assert.equal(r.ok, false)
  assert.match(r.reason, /not RHC/)
})

import { searchBudgetLeftMs } from '../src/keeper.ts'

/* ⛔ The regression that killed a pass: the search must fit inside TimeoutStartSec. */
test('the search budget counts time SPENT WAITING, not wall clock since start', () => {
  assert.equal(searchBudgetLeftMs(0, 300_000), 300_000)
  assert.equal(searchBudgetLeftMs(120_000, 300_000), 180_000)
  assert.equal(searchBudgetLeftMs(300_000, 300_000), 0)
})

test('⛔ the budget is spent by the WHOLE pass, not refreshed per launch', () => {
  /* one launch waited the whole budget: the next gets nothing and holds immediately */
  assert.equal(searchBudgetLeftMs(300_000, 300_000), 0)
  assert.equal(searchBudgetLeftMs(450_000, 300_000), 0)
})

test('⚠ a pass still fits its systemd budget with the search at full stretch', () => {
  /* measured 30 Aug: 293-329s of sweeping and harvesting before any search */
  const baselineWorstMs = 330_000
  const searchMs = 300_000
  const timeoutStartSec = 840
  assert.ok(baselineWorstMs + searchMs < timeoutStartSec * 1000,
    'baseline + search must leave room, or systemd SIGTERMs the pass mid-delivery')
  assert.ok(timeoutStartSec < 900, 'must stay under the 15 min timer or the next fire is skipped')
})
