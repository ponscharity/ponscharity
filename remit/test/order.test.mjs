import { test } from 'node:test'
import assert from 'node:assert/strict'
import { orderForDelivery } from '../src/settle.ts'

const L = (token) => ({ token })
const owedBy = (m) => (l) => m[l.token] ?? 0n

test('⛔ the largest balance goes first, not the lowest register index', () => {
  /* The real case: $CHARITY was owed 3.19 ETH at index 23 and never got reached, while $0.79 and
     $2.52 balances ahead of it bridged again and again. */
  const dust1 = L('0xa'), dust2 = L('0xb'), charity = L('0xc')
  const owed = { '0xa': 333233999999999n, '0xb': 1048162850000000n, '0xc': 3190241244252812753n }
  assert.deepEqual(
    orderForDelivery([dust1, dust2, charity], owedBy(owed)).map((l) => l.token),
    ['0xc', '0xb', '0xa'],
  )
})

test('a launch owed nothing sorts last and never blocks one that is owed', () => {
  const a = L('0xa'), b = L('0xb')
  assert.deepEqual(
    orderForDelivery([a, b], owedBy({ '0xa': 0n, '0xb': 1n })).map((l) => l.token),
    ['0xb', '0xa'],
  )
})

test('⚠ the lead changes hands, so a big launch cannot starve a small one for ever', () => {
  /* Once the leader is remitted its owed drops to zero, which is the whole reason ordering by
     amount does not simply invert the starvation it fixes. */
  const big = L('0xbig'), small = L('0xsmall')
  const before = orderForDelivery([big, small], owedBy({ '0xbig': 100n, '0xsmall': 5n }))
  assert.equal(before[0].token, '0xbig')
  const after = orderForDelivery([big, small], owedBy({ '0xbig': 0n, '0xsmall': 5n }))
  assert.equal(after[0].token, '0xsmall')
})

test('equal amounts break on age, oldest first', () => {
  const a = L('0xA'), b = L('0xB')
  const order = orderForDelivery([a, b], owedBy({ '0xA': 9n, '0xB': 9n }), { '0xb': 1000, '0xa': 5000 })
  assert.deepEqual(order.map((l) => l.token), ['0xB', '0xA'])
})

test('⚠ a launch never seen before does not jump the queue on a tie', () => {
  const seen = L('0xseen'), fresh = L('0xfresh')
  const order = orderForDelivery([fresh, seen], owedBy({ '0xfresh': 9n, '0xseen': 9n }), { '0xseen': 1000 })
  assert.deepEqual(order.map((l) => l.token), ['0xseen', '0xfresh'])
})

test('the order is total and stable when amount and age are both equal', () => {
  const rows = [L('0x1'), L('0x2'), L('0x3')]
  const owed = { '0x1': 7n, '0x2': 7n, '0x3': 7n }
  assert.deepEqual(orderForDelivery(rows, owedBy(owed)).map((l) => l.token), ['0x1', '0x2', '0x3'])
})

test('heldSince is matched case insensitively against a checksummed token', () => {
  const a = L('0xAbCd'), b = L('0xBeEf')
  const order = orderForDelivery([a, b], owedBy({ '0xAbCd': 1n, '0xBeEf': 1n }), { '0xbeef': 10, '0xabcd': 99 })
  assert.deepEqual(order.map((l) => l.token), ['0xBeEf', '0xAbCd'])
})

test('the input array is not mutated', () => {
  const rows = [L('0xa'), L('0xb')]
  const copy = [...rows]
  orderForDelivery(rows, owedBy({ '0xa': 1n, '0xb': 2n }))
  assert.deepEqual(rows, copy)
})
