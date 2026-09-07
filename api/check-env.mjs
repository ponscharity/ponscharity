/**
 * Check `.env.production` WITHOUT printing a single secret.
 *
 * ⛔⛔ IT REPORTS SHAPE, NEVER VALUE. A validator that echoes what it read puts the credential into
 * a terminal scrollback, a screen share and this machine's shell history — which is precisely the
 * route by which a key here became reachable to a sweep tool once already. Lengths, prefixes and
 * character classes are enough to catch every mistake that actually happens.
 */
import { readFileSync } from 'node:fs'

const raw = readFileSync(new URL('.env.production', import.meta.url), 'utf8')
const env = {}
for (const line of raw.split('\n')) {
  const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim())
  if (m) env[m[1]] = m[2]
}

const shape = (v) => {
  if (v === undefined) return 'MISSING from the file'
  if (v === '') return 'blank'
  const issues = []
  if (/^['"]|['"]$/.test(v)) issues.push('WRAPPED IN QUOTES — remove them, the value is taken literally')
  if (v !== v.trim()) issues.push('has leading/trailing whitespace')
  if (/\s/.test(v.trim())) issues.push('CONTAINS A SPACE — probably a partial paste')
  if (/^<|>$/.test(v)) issues.push('still looks like a placeholder')
  return { len: v.trim().length, issues }
}

const report = []
const check = (name, expect) => {
  const s = shape(env[name])
  if (typeof s === 'string') { report.push([name, s === 'blank' ? '·' : '⛔', s]); return }
  const problems = [...s.issues]
  if (expect) problems.push(...expect(env[name].trim(), s.len))
  report.push([name, problems.length ? '⛔' : '✅', problems.length ? problems.join('; ') : `set, ${s.len} chars`])
}

/* ⚠ The single most common X mistake: pasting the API Key / API Key Secret (the OAuth 1.0a
   consumer pair, 25 and 50 chars) instead of the OAuth 2.0 Client ID / Client Secret. Both pairs
   sit on the same page. The client id is long and base64-ish; the API key is short and alphanumeric. */
check('X_CLIENT_ID', (v, n) => {
  const out = []
  if (n > 0 && n < 26) out.push('too short for an OAuth 2.0 Client ID — this looks like the API Key. Use "Client ID" from the OAuth 2.0 box')
  if (/^[A-Za-z0-9]{25}$/.test(v)) out.push('exactly 25 alphanumerics = the API Key, not the Client ID')
  return out
})
check('X_CLIENT_SECRET', (_v, n) => (n > 0 && n < 30 ? ['shorter than an OAuth 2.0 Client Secret usually is — check you took it from the OAuth 2.0 box'] : []))
check('X_BEARER_TOKEN', (v, n) => {
  const out = []
  if (n > 0 && n < 60) out.push('short for a bearer token')
  if (v && !v.startsWith('AAAA')) out.push('bearer tokens normally start "AAAA" — check this is the Bearer Token and not an access token')
  return out
})
check('TWITTERAPI_IO_KEY', (_v, n) => (n > 0 && n < 20 ? ['short for a twitterapi.io key'] : []))
check('GITHUB_CLIENT_ID', (v) => {
  const out = []
  if (v && !/^(Iv1\.|Iv23li|Ov23li)/.test(v)) out.push('GitHub client ids start "Iv1." or "Ov23li" — check this is the Client ID')
  return out
})
check('GITHUB_CLIENT_SECRET', (v, n) => {
  const out = []
  if (v && !/^[0-9a-f]{40}$/.test(v)) out.push(`GitHub client secrets are 40 lowercase hex characters; this is ${n}`)
  return out
})
check('CLAIMS_ADDRESS', (v) => (v && !/^0x[0-9a-fA-F]{40}$/.test(v) ? ['not an address'] : []))
check('LAUNCHPAD_V2', (v) => (v && !/^0x[0-9a-fA-F]{40}$/.test(v) ? ['not an address'] : []))
check('CLAIM_SIGNER_KEY', (v) => (v && !/^0x[0-9a-fA-F]{64}$/.test(v) ? ['not a 0x + 64 hex private key'] : []))

/*
  ⛔⛔ THE API AND THE SITE MUST NAME THE SAME LAUNCHPAD, and nothing on chain distinguishes a stale
  one from the live one — a superseded launchpad still answers every call, still reports `count() ==
  0`, and still points at the same claims contract. Left disagreeing, the site lists a launch the API
  cannot find, so `/api/claim/<token>` answers "this launch does not pay your account" for every
  single V2 launch, truthfully and for ever. That is precisely what shipped on 6 Sep, when the router
  gained `provider`/`accountId`, the launchpad was redeployed to follow, and only the web env moved.
  ⚠ A string comparison, deliberately: an on-chain check cannot see the difference.
*/
try {
  const web = readFileSync(new URL('../web/.env.production', import.meta.url), 'utf8')
  const m = /^VITE_LAUNCHPAD_V2=(.*)$/m.exec(web)
  const mine = env.LAUNCHPAD_V2?.trim()
  if (m && mine) {
    const same = m[1].trim().toLowerCase() === mine.toLowerCase()
    report.push([
      'LAUNCHPAD_V2 == web',
      same ? '✅' : '⛔',
      same ? 'the site and the API agree' : `DISAGREES with web/.env.production (${m[1].trim()}) — claiming will find nothing`,
    ])
  }
} catch { /* ⚠ The web env is not required to exist beside this one; only checked when it does. */ }
check('PUBLIC_URL', (v) => (v && v.endsWith('/') ? ['TRAILING SLASH — the callback URL will not match what you registered'] : []))

const w = Math.max(...report.map(([n]) => n.length))
for (const [n, mark, note] of report) console.log(`  ${mark} ${n.padEnd(w)}  ${note}`)

console.log('\n  what this enables:')
const has = (k) => Boolean(env[k]?.trim())
console.log(`    ${has('X_CLIENT_ID') && has('X_CLIENT_SECRET') ? '✅' : '⚠ '} sign in with X`)
const xLookup = has('TWITTERAPI_IO_KEY') || has('X_BEARER_TOKEN')
console.log(`    ${xLookup ? '✅' : '⚠ '} resolve an X @handle at launch time`
  + (has('TWITTERAPI_IO_KEY') ? '  (via twitterapi.io)' : has('X_BEARER_TOKEN') ? '  (via X, which is prepaid)' : ''))
console.log(`    ${has('GITHUB_CLIENT_ID') && has('GITHUB_CLIENT_SECRET') ? '✅' : '⚠ '} sign in with GitHub (handle lookup included, no extra credential)`)
console.log(`    ${has('CLAIMS_ADDRESS') && has('LAUNCHPAD_V2') && has('CLAIM_SIGNER_KEY') ? '✅' : '⚠ '} claiming — needs the deploy first`)
