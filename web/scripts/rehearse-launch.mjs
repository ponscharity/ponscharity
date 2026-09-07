/**
 * Rehearse a launch on a fork of live Robinhood Chain, then show exactly what the site will display.
 *
 * ## ⛔⛔ WHY THIS EXISTS
 *
 * A launch writes its name, ticker, image, charity, split and pair asset into contracts with NO
 * setter. Pons puts the metadata in the token's own constructor; the launchpad puts the charity and
 * the split in the distributor's. A typo is permanent, a wrong charity id is permanent, and pairing
 * against ETH instead of USDG costs the charity roughly 0.45% of every fee for the life of the
 * token. None of that can be corrected afterwards by anyone, including us.
 *
 * ➤ So the real thing is done once, and everything that can be checked first is checked here, on a
 * fork, with the ACTUAL values, through the SITE'S OWN read path. Nothing is signed on mainnet.
 *
 *   node --experimental-strip-types scripts/rehearse-launch.mjs \
 *     --name "Name" --symbol TICK --logo https://… --charity st-jude \
 *     [--split 8000] [--pair USDG|ETH] [--dev-buy 0.5]
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, http, parseEther, parseUnits, formatEther, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const arg = (k, d = null) => {
  const i = process.argv.indexOf('--' + k)
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d
}
const die = (m) => { console.error('\n⛔ ' + m); process.exit(1) }

const NAME = arg('name'), SYMBOL = arg('symbol'), LOGO = arg('logo') ?? ''
const CHARITY = arg('charity'), SPLIT = Number(arg('split', '8000'))
const PAIR = (arg('pair', 'USDG') ?? 'USDG').toUpperCase()
const DEV_BUY = arg('dev-buy', '0')
if (!NAME || !SYMBOL || !CHARITY) die('need --name, --symbol and --charity (a donate.gg slug)')

const PAD = '0xF1755477b2931E6e8fc2B0f6b7d66B4AA7EeEfE3'
const FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e'
const NATIVE = '0x0000000000000000000000000000000000000000'
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'
const PAIR_ADDR = PAIR === 'ETH' ? NATIVE : USDG
const PAIR_DEC = PAIR === 'ETH' ? 18 : 6
const PORT = 8547, RPC = `http://127.0.0.1:${PORT}`

/* ── 1. the charity, from donate.gg's own data ─────────────────────────────────────────────────
   ⛔⛔ NEVER TYPED. The donation relay does not validate config ids: a donation to an id belonging
   to nobody SUCCEEDS and the money is gone, with a successful transaction to show for it. So the id
   is looked up in the directory the site itself ships, and a miss is a hard stop rather than a
   guess. */
const dir = JSON.parse(readFileSync(new URL('../public/charities.json', import.meta.url), 'utf8'))
const q = CHARITY.toLowerCase()
const hit = dir.find((c) => c.s.toLowerCase() === q) ??
            dir.find((c) => c.c.toLowerCase() === q) ??
            dir.filter((c) => c.n.toLowerCase().includes(q)).sort((a, b) => b.r - a.r)[0]
if (!hit) die(`no charity matches "${CHARITY}". Use the slug from its donate.gg page, e.g. st-jude.`)

/* ── 2. what cannot be changed later ───────────────────────────────────────────────────────── */
console.log('\n══ WHAT THIS LAUNCH WILL FIX FOREVER ══')
console.log('  name        ', JSON.stringify(NAME))
console.log('  ticker      ', '$' + SYMBOL.toUpperCase())
console.log('  image       ', LOGO || '(none — permanent, there is no setter)')
console.log('  charity     ', hit.n)
console.log('  charity id  ', hit.c)
console.log('  its page    ', 'https://www.donate.gg/charities/' + hit.s)
console.log('  split       ', SPLIT / 100 + '% to the charity,', (10000 - SPLIT) / 100 + '% to you')
console.log('  paired in   ', PAIR)
if (PAIR === 'ETH') {
  console.log('\n  ⚠⚠ PAIRED AGAINST ETH. The native route crosses an ETH→USDC spread that does not')
  console.log('     shrink with size, so roughly 0.45% MORE of every fee would reach the charity if')
  console.log('     this were paired against USDG. The pair asset cannot be changed after launch.')
}
if (LOGO && new TextEncoder().encode(LOGO).length > 512) die('the image URL is over 512 bytes; Pons truncates it and there is no setter')
if (LOGO && !/^(https?:\/\/|ipfs:\/\/)/.test(LOGO)) die('the image must be an https:// or ipfs:// URL, or the site cannot render it')
if (SPLIT < 5000) die('the launchpad enforces a 50% minimum charity share')

/* ── 3. fork, launch, read back ────────────────────────────────────────────────────────────── */
console.log('\n══ REHEARSING ON A FORK OF LIVE ROBINHOOD CHAIN ══')
const anvil = spawn('anvil', ['--fork-url', 'http://127.0.0.1:8899', '--port', String(PORT), '--silent'],
  { stdio: 'ignore', detached: true })
process.on('exit', () => { try { process.kill(-anvil.pid) } catch {} })
await new Promise((r) => setTimeout(r, 12000))

const chain = { id: 4663, name: 'rhc', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
                rpcUrls: { default: { http: [RPC] } } }
const pub = createPublicClient({ chain, transport: http(RPC) })
/* ⛔ A fresh key. Anvil's dev accounts are REAL used addresses on this chain and their forked
   balance can vanish mid-run. */
const me = privateKeyToAccount('0x' + 'f1'.repeat(32))
const wallet = createWalletClient({ account: me, chain, transport: http(RPC) })
const rpc = (m, p) => fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }) }).then((r) => r.json())
await rpc('anvil_setBalance', [me.address, '0x' + parseEther('100').toString(16)])

const F = parseAbi(['function launchFee() view returns (uint256)',
  'function previewLaunchEconomics(uint256,address) view returns (bytes32)'])
const fee = await pub.readContract({ address: FACTORY, abi: F, functionName: 'launchFee' })
const econ = await pub.readContract({ address: FACTORY, abi: F, functionName: 'previewLaunchEconomics', args: [0n, PAIR_ADDR] })

process.env.VITE_RHC_RPC = RPC
process.env.VITE_LAUNCHPAD = PAD
process.env.VITE_REMIT_VAULT = '0x7F954db64FeC530C679c6b093a139eFB8089D7D2'
const { LAUNCHPAD_ABI, readLaunches, fmtAmount } = await import('../src/lib/launchpad.ts')
const { readToken } = await import('../src/lib/token.ts')
const { formatUsd } = await import('../src/lib/marketCap.ts')

const buy = DEV_BUY && Number(DEV_BUY) > 0 ? parseUnits(DEV_BUY, PAIR_DEC) : 0n
const params = {
  name: NAME, symbol: SYMBOL.toUpperCase(), logo: LOGO, description: arg('description', '') ?? '',
  socials: { twitter: arg('twitter', '') ?? '', telegram: '', discord: '', website: arg('website', '') ?? '', farcaster: '' },
  creatorFeeRecipient: NATIVE, creatorTaxBps: Number(arg('tax', '0')), buybackEnabled: false,
  expectedEconomics: econ, salt: '0x' + Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join(''),
}
const terms = { charity: '0x00000000000000000000000000000000caFe0001', charityId: hit.c,
                creatorPayout: me.address, charityBps: SPLIT }

/* ⚠ Native pairs carry the dev buy in msg.value; an ERC-20 pair pays it from an allowance, and
   sending it as value there reverts NativeValueMismatch. */
const isNative = PAIR_ADDR === NATIVE
if (!isNative && buy > 0n) {
  console.log('  (a USDG dev buy needs an allowance on the real launch; rehearsing without it)')
}
const value = fee + (isNative ? buy : 0n)
const hash = await wallet.writeContract({
  address: PAD, abi: LAUNCHPAD_ABI, functionName: 'launchWithBuy',
  args: [params, 0n, PAIR_ADDR, terms, { quoteIn: isNative ? buy : 0n, minTokensOut: 0n }, []],
  value,
})
const rc = await pub.waitForTransactionReceipt({ hash })
if (rc.status !== 'success') die('the launch reverted on the fork. Nothing would have been signed.')
console.log('  launch succeeded, gas', rc.gasUsed)

const [l] = await readLaunches()
const t = await readToken(l.token)

console.log('\n══ WHAT THE SITE WILL SHOW ══')
console.log('\n  the card on the dashboards')
console.log('    $' + l.symbol)
console.log('    ' + l.name)
console.log('    ' + (formatUsd(l.marketCapUsd) ?? '—') + '   MARKET CAP')
console.log('    CHARITY')
console.log('    ' + hit.n)
console.log('\n  the token page')
console.log('    badges      Pays ' + hit.n + ' · ' + (l.graduated ? 'Trading on the pool' : 'On the curve') + ' · Priced in ' + l.pairSymbol)
console.log('    donated     ' + fmtAmount(t.paidToCharity, t.pairDecimals, 4) + ' ' + t.pairSymbol)
console.log('    waiting     ' + fmtAmount(t.pending, t.pairDecimals, 4) + ' ' + t.pairSymbol)
console.log('    market cap  ' + (formatUsd(t.marketCapUsd) ?? '—'))
console.log('    charity cut ' + (((70 + t.creatorTaxBps) * (t.charityBps / 10000)) / 100).toFixed(3) + '%')
console.log('    split       ' + t.charityBps / 100 + '% charity / ' + (100 - t.charityBps / 100) + '% creator')
if (buy > 0n && isNative) {
  const ERC = parseAbi(['function balanceOf(address) view returns (uint256)'])
  const got = await pub.readContract({ address: l.token, abi: ERC, functionName: 'balanceOf', args: [me.address] })
  console.log('\n  your dev buy  ' + formatEther(got) + ' ' + l.symbol + '  (to YOUR wallet, not the distributor)')
}
console.log('\n✅ Rehearsal only. Nothing was signed on mainnet and no charity was named on chain.')
process.exit(0)
