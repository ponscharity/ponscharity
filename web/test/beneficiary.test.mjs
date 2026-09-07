import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keccak256, toBytes } from 'viem'

/* The server's own derivation, imported rather than reimplemented — that is the whole point. */
import { beneficiary as serverBeneficiary, key } from '../../api/identity.mjs'

/**
 * ⛔⛔ THE ONE MISMATCH THAT WOULD BE INVISIBLE.
 *
 * The launch form hashes an account into a constructor argument. The server hashes the signed-in
 * account to decide what that same launch owes. If those two derivations ever disagree, the chain
 * credits one beneficiary and every claim is checked against another: the money is visibly there,
 * the account is visibly signed in, and every claim reverts with nothing saying why.
 *
 * Nothing about that shows up in a UI test or a contract test, because each side is individually
 * self-consistent. So it is pinned here, from both directions at once.
 */

/** ⚠ EXACTLY what `LaunchForm` does when it builds a split. Kept literal, not factored out — a
    shared helper would make this test pass by construction and prove nothing. */
const uiBeneficiary = (provider, id) => keccak256(toBytes(`${provider}:${id}`))

test('⛔⛔ the launch form and the server derive the SAME beneficiary', () => {
  for (const [provider, id] of [['x', '1234567890'], ['github', '99'], ['x', '1']]) {
    assert.equal(
      uiBeneficiary(provider, id),
      serverBeneficiary({ provider, id }),
      `${provider}:${id} — the form would credit an account the server cannot pay`,
    )
  }
})

test('⛔ the provider is folded in, so the same id on X and GitHub are different people', () => {
  assert.notEqual(serverBeneficiary({ provider: 'x', id: '1' }), serverBeneficiary({ provider: 'github', id: '1' }))
  assert.notEqual(uiBeneficiary('x', '1'), uiBeneficiary('github', '1'))
})

test('the key is the string that gets hashed, and it is provider-first', () => {
  assert.equal(key({ provider: 'github', id: '42' }), 'github:42')
})

/**
 * ⚠ A handle is NOT an id. This is the mistake the first draft of the launch form actually made,
 * and it would have been permanent: both services let a username be released and re-registered, so
 * a launch keyed on the text pays whoever holds that name later.
 */
test('⛔⛔ hashing the handle gives a different beneficiary from hashing the id', () => {
  assert.notEqual(uiBeneficiary('x', 'alice'), uiBeneficiary('x', '1234567890'))
})
