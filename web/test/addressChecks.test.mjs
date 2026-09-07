import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkCharityAddress, chunkAddress, isDelegatedEoa } from '../src/lib/addressChecks.ts'

const sev = (r, id) => r.checks.find((c) => c.id === id)?.severity

test('a contract on Ethereum is a hard stop', async () => {
  // USDC. Its address on Robinhood Chain belongs to nobody.
  const r = await checkCharityAddress('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')
  assert.equal(sev(r, 'eth-code'), 'stop')
  assert.equal(r.passable, false)
})

/**
 * 🔴🔴 THE REGRESSION THAT MATTERS. Since EIP-7702 an ordinary wallet can carry a 23 byte
 * delegation indicator. Reading "has code" as "is a contract" rejected this address, which is a
 * personal wallet, and would have blocked real charities from being named.
 */
test('a 7702 delegated wallet is a wallet, not a contract', async () => {
  const r = await checkCharityAddress('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')
  assert.equal(sev(r, 'eth-code'), 'ok')
  assert.equal(r.passable, true)
})

test('the delegation indicator is matched exactly', () => {
  assert.equal(isDelegatedEoa('0xef01005a7fc11397e9a8ad41bf10bf13f22b0a63f96f6d'), true)
  assert.equal(isDelegatedEoa('0x'), false)
  // ⚠ Right prefix, wrong length. Real contract code can begin with anything.
  assert.equal(isDelegatedEoa('0xef0100' + 'ab'.repeat(40)), false)
})

test('burn addresses are refused', async () => {
  for (const a of ['0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dEaD']) {
    const r = await checkCharityAddress(a)
    assert.equal(r.passable, false)
    assert.equal(sev(r, 'dead'), 'stop')
  }
})

test('a lower case address passes but says its checksum cannot be verified', async () => {
  const r = await checkCharityAddress('0xd8da6bf26964af9d7eed9e03e53415d37aa96045')
  assert.equal(sev(r, 'checksum'), 'warn')
  assert.equal(r.passable, true, 'no checksum is a caution, not a refusal')
})

test('nonsense is refused before any network call', async () => {
  const r = await checkCharityAddress('0x123')
  assert.equal(r.valid, false)
  assert.equal(r.passable, false)
})

test('an address is chunked into fours so a human can actually compare it', () => {
  assert.deepEqual(
    chunkAddress('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'),
    ['0xd8dA', '6BF2', '6964', 'aF9D', '7eEd', '9e03', 'E534', '15D3', '7aA9', '6045'],
  )
})
