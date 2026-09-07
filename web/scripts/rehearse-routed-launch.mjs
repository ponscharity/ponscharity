/**
 * Rehearse a ROUTED launch on a fork of live Robinhood Chain.
 *
 * ## ⛔⛔ WHY THIS EXISTS SEPARATELY FROM rehearse-launch.mjs
 *
 * That script rehearses the V1 shape: one charity, one wallet, no splitter. It cannot fail the way a
 * routed launch fails, because it never builds a `Split[]` and never deploys a `CreatorRouter`. So
 * the whole V2 half of the form — buyback & burn, an X or GitHub payee, more than one recipient —
 * shipped with no rehearsal at all, and the first thing to exercise it was somebody's real launch.
 *
 * It failed. `soleWallet` returned the first row's value whatever kind that row was, so a launch
 * giving its whole remainder to an X account handed the HANDLE to `creatorPayout` and viem refused
 * to encode it. Nothing was signed and nothing was lost — but the form said only "Could not complete
 * that launch", and there was no way to find out why without reading the source.
 *
 * ➤ So this drives the SAME call the form builds, with splits, on a fork, and prints what came back.
 *
 *   node --experimental-strip-types scripts/rehearse-routed-launch.mjs \
 *     --split 8000 --pair USDG --x 1792724913528172544 [--burn 30] [--wallet 0x…] [--dev-buy 40]
 *
 * ⚠ Nothing is signed on mainnet and no key is needed: `eth_call` against a fork answers whether
 * the launch would succeed, which is the only question this can honestly answer beforehand.
 */
import { spawn } from 'node:child_process'
import { createPublicClient, createWalletClient, http, parseAbi, keccak256, toBytes, formatEther, formatUnits, parseUnits, isAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { LAUNCHPAD_V2_ABI } from '../src/lib/launchpad.ts'

const arg = (k, d = null) => {
  const i = process.argv.indexOf('--' + k)
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d
}
const die = (m) => { console.error('\n⛔ ' + m); process.exit(1) }

/* ⚠ Read from the site's own env rather than retyped, or this rehearses a launchpad nothing uses. */
const PAD2 = '0x767b4E8e3d5f7F883E4608AB6f7899Aac365C8e9'
const FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e'
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'
const ZERO = '0x0000000000000000000000000000000000000000'
const ZERO32 = '0x' + '00'.repeat(32)
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36'
const LIVE = 'https://rpc.mainnet.chain.robinhood.com'
const PORT = 8549, RPC = `http://127.0.0.1:${PORT}`
/* ⚠ Any address at all: the fork funds it and nothing is signed. */
const WHO = '0x' + '0'.repeat(36) + 'c0fe'

const SPLIT = Number(arg('split', '8000'))
const PAIR = (arg('pair', 'USDG') ?? 'USDG').toUpperCase()
const PAIR_ADDR = PAIR === 'ETH' ? ZERO : USDG
const BURN = Number(arg('burn', '0'))
const XID = arg('x'), GHID = arg('github'), WALLET = arg('wallet')
const DEV_BUY = arg('dev-buy', '0')

/*
  ⛔⛔ THE SAME MAPPING THE FORM USES: mode 0 wallet / 1 account / 2 burn, `provider` 1 X / 2 GitHub,
  and `beneficiary = keccak256("<provider>:<numeric id>")`. The router's constructor recomputes that
  hash and refuses a launch whose declared account does not match it, so a wrong id here fails on the
  fork rather than paying a stranger for ever.
*/
const legs = []
if (BURN > 0) legs.push({ mode: 2, bps: BURN * 100, wallet: ZERO, beneficiary: ZERO32, provider: 0, accountId: 0n })
if (XID) legs.push({ mode: 1, bps: 0, wallet: ZERO, beneficiary: keccak256(toBytes(`x:${XID}`)), provider: 1, accountId: BigInt(XID) })
if (GHID) legs.push({ mode: 1, bps: 0, wallet: ZERO, beneficiary: keccak256(toBytes(`github:${GHID}`)), provider: 2, accountId: BigInt(GHID) })
if (WALLET) {
  if (!isAddress(WALLET)) die(`--wallet ${WALLET} is not an address`)
  legs.push({ mode: 0, bps: 0, wallet: WALLET, beneficiary: ZERO32, provider: 0, accountId: 0n })
}
if (legs.length === 0) die('nothing to route — pass at least one of --burn, --x, --github, --wallet')

/* ⚠ Evenly, in whole percent, with the remainder on the first leg — the form's `rebalance`. Any
   explicit --burn is honoured and the rest is shared out. */
const rest = 100 - (BURN > 0 ? BURN : 0)
const others = legs.filter((l) => l.mode !== 2)
if (others.length) {
  const each = Math.floor(rest / others.length)
  others.forEach((l, i) => { l.bps = (i === 0 ? rest - each * (others.length - 1) : each) * 100 })
} else if (BURN > 0) legs[0].bps = 10000
const total = legs.reduce((n, l) => n + l.bps, 0)
if (total !== 10000) die(`the legs add up to ${total / 100}%, and CreatorRouter refuses anything but 100%`)

const anvil = spawn('anvil', ['--fork-url', LIVE, '--port', String(PORT), '--silent'])
await new Promise((r) => setTimeout(r, 7000))
const pub = createPublicClient({ transport: http(RPC, { fetchOptions: { headers: { 'user-agent': UA } } }) })
const F = parseAbi([
  'function launchFee() view returns (uint256)',
  'function previewLaunchEconomics(uint256 launchConfigId, address pairToken) view returns (bytes32)',
])
const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
])

try {
  const fee = await pub.readContract({ address: FACTORY, abi: F, functionName: 'launchFee' })
  const econ = await pub.readContract({
    address: FACTORY, abi: F, functionName: 'previewLaunchEconomics', args: [0n, PAIR_ADDR],
  })
  await fetch(RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'anvil_setBalance', params: [WHO, '0x56BC75E2D63100000'] }),
  })

  const DEC = PAIR === 'ETH' ? 18 : 6
  const buy = parseUnits(String(DEV_BUY), DEC)

  /*
    ⛔⛔ THE APPROVAL IS PART OF WHAT IS BEING REHEARSED, because an ERC-20 developer buy is PULLED.
    `CharityLaunchpadV2` runs `safeTransferFrom(msg.sender, …)`, so with no allowance the launch
    reverts inside the token as `SafeERC20FailedOperation` — a selector viem can only print as a raw
    hex signature, which is exactly how it reached a creator. Rehearsed BOTH ways below, so the
    difference an approval makes is visible rather than asserted.
  */
  if (buy > 0n && PAIR !== 'ETH') {
    /* ⚠ Given the balance on the fork, so the rehearsal is about the ALLOWANCE and not about who
       happens to be funded today. */
    const slot = 0n
    for (let i = 0; i < 12; i++) {
      const idx = keccak256(`0x${WHO.slice(2).padStart(64, '0')}${BigInt(i).toString(16).padStart(64, '0')}`)
      await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'anvil_setStorageAt',
          params: [PAIR_ADDR, idx, `0x${(buy * 4n).toString(16).padStart(64, '0')}`] }) })
      const b = await pub.readContract({ address: PAIR_ADDR, abi: ERC20, functionName: 'balanceOf', args: [WHO] })
      if (b >= buy) break
    }
    void slot
  }

  console.log(`\n  charity ${SPLIT / 100}%   remainder ${(10000 - SPLIT) / 100}%   pair ${PAIR}   fee ${formatEther(fee)} ETH`)
  if (buy > 0n) console.log(`  developer buy ${DEV_BUY} ${PAIR}`)
  for (const l of legs) {
    const what = l.mode === 2 ? 'buyback & burn' : l.mode === 0 ? l.wallet : `${l.provider === 1 ? 'X' : 'GitHub'} id ${l.accountId}`
    console.log(`    ${String(l.bps / 100).padStart(3)}% of the remainder  ->  ${what}`)
  }

  const call = () => pub.simulateContract({
    address: PAD2, abi: LAUNCHPAD_V2_ABI, functionName: 'launchWithBuy',
    args: [
      {
        name: 'Rehearsal', symbol: 'REH', logo: '', description: '',
        socials: { twitter: '', telegram: '', discord: '', website: '', farcaster: '' },
        creatorFeeRecipient: ZERO, creatorTaxBps: 0, buybackEnabled: false,
        expectedEconomics: econ, salt: keccak256(toBytes('rehearsal-' + Date.now())),
      },
      0n, PAIR_ADDR,
      /* ⭐ Zero, exactly as the form now sends for a launch with no wallet leg. The launchpad
         OVERWRITES it with the router whenever splits are present. */
      { charity: WHO, charityId: ZERO32, creatorPayout: ZERO, charityBps: SPLIT, splits: legs },
      /* ⛔ A NATIVE pair carries the buy in `value`; an ERC-20 one is pulled from an allowance. */
      { quoteIn: buy, minTokensOut: 0n }, [],
    ],
    account: WHO, value: fee + (PAIR === 'ETH' ? buy : 0n),
  })

  if (buy > 0n && PAIR !== 'ETH') {
    const held = await pub.readContract({ address: PAIR_ADDR, abi: ERC20, functionName: 'balanceOf', args: [WHO] })
    console.log(`  fork balance  ${formatUnits(held, DEC)} ${PAIR}`)
    if (held < buy) die(`the fork could not give this address ${DEV_BUY} ${PAIR} — the balance slot was not found`)

    /* ⭐ WITHOUT the allowance first, so the failure this rehearsal exists to catch is shown rather
       than described. */
    try {
      await call()
      console.log('  ⚠ it launched with NO allowance — the launchpad no longer pulls the buy?')
    } catch (e) {
      console.log(`  ✅ with no allowance it fails, as it must: ${String(e.shortMessage ?? e.message).split('\n')[0].slice(0, 90)}`)
    }
    await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'anvil_impersonateAccount', params: [WHO] }) })
    const wallet = createWalletClient({ account: WHO, transport: http(RPC) })
    const h = await wallet.writeContract({ address: PAIR_ADDR, abi: ERC20, functionName: 'approve', args: [PAD2, buy], chain: null })
    await pub.waitForTransactionReceipt({ hash: h })
    console.log(`  approved ${DEV_BUY} ${PAIR} to the launchpad`)
  }

  const { result } = await call()
  console.log(`\n  ✅ it would launch`)
  console.log(`     token       ${result[0]}`)
  console.log(`     distributor ${result[2]}`)
  console.log(`     router      ${result[3]}`)
  if (result[3] === ZERO) die('no router was deployed — the splits did not reach the launchpad')
} catch (e) {
  console.log(`\n  ⛔ it would NOT launch`)
  console.log(`     ${String(e.shortMessage ?? e.message).split('\n')[0]}`)
  process.exitCode = 1
} finally { anvil.kill() }
