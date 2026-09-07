/**
 * Verify a contract on Robinhood Chain's Blockscout.
 *
 * ⛔⛔ WHY THIS EXISTS RATHER THAN `forge verify-contract`. The explorer sits behind Cloudflare and
 * its managed challenge fires on Foundry's User-Agent, exactly as the RPC does. Forge takes no
 * header flag for the verifier, so it receives a challenge page, fails to parse it as JSON and
 * reports "Failed to obtain contract ABI" — a message about deserialisation that says nothing about
 * the real cause. `scripts/rpc-proxy.mjs` cannot help either: it is a POST-only JSON-RPC forwarder
 * and verification is a multipart upload to a REST path.
 *
 * ➤ So this posts the standard JSON input directly, with a browser agent.
 *
 *   forge verify-contract <addr> <path>:<name> --show-standard-json-input > std.json
 *   node scripts/verify-blockscout.mjs <addr> <name> std.json <constructor-args-hex>
 */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
const BASE = 'https://robinhoodchain.blockscout.com'

const [address, name, jsonPath, ctorArgs] = process.argv.slice(2)
if (!address || !name || !jsonPath) {
  console.error('usage: verify-blockscout.mjs <address> <ContractName> <std.json> [constructorArgsHex]')
  process.exit(1)
}

const std = await import('node:fs/promises').then((fs) => fs.readFile(jsonPath, 'utf8'))

const form = new FormData()
form.append('compiler_version', 'v0.8.24+commit.e11b9ed9')
form.append('license_type', 'mit')
/* ⚠ The contract name must be `path:Name`, not just `Name`. Blockscout matches it against the keys
   of the standard input's `sources`, and a bare name silently matches nothing. */
form.append('contract_name', `src/${name}.sol:${name}`)
if (ctorArgs) form.append('constructor_args', ctorArgs)
form.append('files[0]', new Blob([std], { type: 'application/json' }), 'standard-input.json')

const url = `${BASE}/api/v2/smart-contracts/${address}/verification/via/standard-input`
const res = await fetch(url, { method: 'POST', headers: { 'User-Agent': UA }, body: form })
const text = await res.text()
console.log('submit:', res.status, text.slice(0, 300))

/* ⚠ Verification is asynchronous. A 200 on the submit means "queued", not "verified", and reporting
   the submit as success is how a contract ends up unverified with a green log line. */
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 3000))
  const st = await fetch(`${BASE}/api/v2/smart-contracts/${address}`, { headers: { 'User-Agent': UA } })
  if (!st.ok) continue
  const j = await st.json().catch(() => null)
  if (j?.is_verified) {
    console.log(`VERIFIED  ${BASE}/address/${address}?tab=contract`)
    process.exit(0)
  }
  process.stdout.write('.')
}
console.log('\nstill not verified after 60s. Check the explorer.')
process.exit(1)
