/**
 * The only server Pons Charity has: it hosts a token's logo, and publishes which launch each
 * donation came from.
 *
 * ## Why this exists at all
 *
 * A Pons V2 `logo` field is 512 bytes, so it holds a LINK and never a picture. Uploading therefore
 * means putting the file somewhere that keeps serving it. A pinning service is the obvious answer
 * and the wrong one for a public launchpad: it needs an account, and a pinning key shipped in a
 * front end is a published key. This box already exists, so the file goes here and comes back as an
 * ordinary https URL that renders everywhere immediately, with nothing to sign up for.
 *
 * ## ⛔⛔ SVG IS REFUSED, AND THAT IS A SECURITY DECISION
 *
 * An SVG is a document, not a picture: it can carry `<script>`. Serving one from the same origin as
 * the site would let anybody who uploads a logo run script against a visitor who has a WALLET
 * connected, on the page whose whole job is getting them to sign a transaction. The extension is
 * not trusted either, because a `.png` that is really an SVG would walk straight through a
 * content-type allowlist. Magic bytes decide.
 *
 * ## ⛔⛔ WHERE THE FILE GOES CAN NEVER LAPSE
 *
 * The URL is written into `logo` in the token's CONSTRUCTOR and the deployed ABI has no setter, so
 * every token launched while this points somewhere carries that host forever. `/root/charity-logos`
 * is deliberately OUTSIDE the site's deploy root: the front end deploys with `rsync -az --delete`,
 * which would delete a directory kept inside it and take every token's logo with it.
 *
 * ⚠ The filename is a hash of the bytes, so the same image always lands at the same URL,
 * re-uploading is free, and an address already written on chain can never be repointed at a
 * different picture.
 */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { isAddress } from 'viem'

import { beneficiary, isProvider } from './identity.mjs'
import { xProvider } from './providers/x.mjs'
import { githubProvider, handleForGithubId } from './providers/github.mjs'
import { handleForXId } from './providers/twitterapiio.mjs'
import { stubProvider } from './providers/stub.mjs'
import { makeClaims } from './claims.mjs'

const PORT = Number(process.env.PORT || 8803)
const DIR = process.env.LOGO_DIR || '/root/charity-logos'
const PUBLIC_BASE = process.env.LOGO_PUBLIC_BASE || 'https://ponscharity.family/logos'
export const RECEIPTS = process.env.RECEIPTS ?? '/root/charity-remit/receipts.json'
const STATUS = process.env.STATUS ?? '/root/charity-remit/status.json'
const MAX_BYTES = 4 * 1024 * 1024

/* ── identity and claiming ────────────────────────────────────────────────────────────────────
   ⭐ EVERY PIECE IS OPTIONAL AND THE SERVICE RUNS WITHOUT ANY OF IT. This process also serves
   logos and the donation feed, which have nothing to do with signing in — so an unconfigured
   deployment must keep working rather than refuse to start. What is missing simply is not offered;
   see `/api/me`, which returns the providers that can actually COMPLETE a sign in.
   ⛔ Nothing may offer a sign-in button off the back of "the server answered". That mistake shipped
   on PONSPAD and produced a control that failed with `no such provider` every time. */
const PUBLIC_URL = process.env.PUBLIC_URL ?? 'https://ponscharity.family'
const CLAIMS_ADDRESS = process.env.CLAIMS_ADDRESS ?? ''
const LAUNCHPAD_ADDRESS = process.env.LAUNCHPAD_V2 ?? ''
const SIGNER_KEY = process.env.CLAIM_SIGNER_KEY ?? ''

const providers = new Map()
if (process.env.X_CLIENT_ID && process.env.X_CLIENT_SECRET) {
  providers.set('x', xProvider(process.env.X_CLIENT_ID, process.env.X_CLIENT_SECRET, process.env.X_BEARER_TOKEN, process.env.TWITTERAPI_IO_KEY))
}
if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
  providers.set('github', githubProvider(process.env.GITHUB_CLIENT_ID, process.env.GITHUB_CLIENT_SECRET))
}

/*
  🔴🔴 STUB SIGN-IN IS REFUSED ON A PUBLIC ORIGIN, AND THE CHECK IS THE ORIGIN, NOT A FLAG.
  It authenticates anybody as anybody, so on https it is a way for a stranger to sign in as any
  account and take its fees. Gating it on `NODE_ENV` or on the operator remembering to unset a
  variable is not enough — the deployment that matters is the one where somebody forgot.
*/
if (process.env.STUB_AUTH === '1') {
  if (PUBLIC_URL.startsWith('https://')) {
    throw new Error('STUB_AUTH is set on an https origin. That would sign anybody in as anybody.')
  }
  providers.set('x', stubProvider('x', 'X'))
  providers.set('github', stubProvider('github', 'GitHub'))
}

const claims = CLAIMS_ADDRESS && LAUNCHPAD_ADDRESS && SIGNER_KEY
  ? makeClaims({ address: CLAIMS_ADDRESS, launchpad: LAUNCHPAD_ADDRESS, signerKey: SIGNER_KEY })
  : null

const redirectFor = (name) => `${PUBLIC_URL}/api/auth/callback/${name}`

/*
  ⛔⛔ IN MEMORY, AND BOUNDED. `pending` is filled by an UNAUTHENTICATED GET, so without a ceiling
  anybody could grow it until the process died. Sessions are capped for the same reason. Both are
  lost on restart, which signs everybody out — an inconvenience, not a loss: nothing is owed to a
  session, and what a launch owes an account is on chain.
*/
const pending = new Map()
const sessions = new Map()
const MAX_PENDING = 5_000
const MAX_SESSIONS = 20_000
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000

const sweepOld = (map, ttl) => {
  const cutoff = Date.now() - ttl
  for (const [k, v] of map) if (v.createdAt < cutoff) map.delete(k)
}

const readCookie = (req, name) => {
  const raw = req.headers.cookie ?? ''
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === name) return decodeURIComponent(rest.join('='))
  }
  return null
}

/* ⚠ HttpOnly so the page cannot read it, SameSite=Lax so it survives the OAuth redirect back from
   the provider — `Strict` drops the cookie on that navigation and the callback then reads no state,
   which looks exactly like a forged callback. */
const setCookie = (res, name, value, maxAgeSeconds) => {
  const bits = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ]
  if (PUBLIC_URL.startsWith('https://')) bits.push('Secure')
  const existing = res.getHeader('set-cookie')
  res.setHeader('set-cookie', existing ? [].concat(existing, bits.join('; ')) : bits.join('; '))
}

/** ⚠ Constant time. A `===` on a secret leaks it a character at a time to a patient caller. */
const sameState = (a, b) => {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * Which of the visitor's connected accounts this launch pays, if any.
 *
 * ⛔⛔ TRIED ACROSS EVERY CONNECTED IDENTITY, because a launch names exactly ONE beneficiary and a
 * person may hold it through either account. Checking only "the" signed-in one made a share owed to
 * the other invisible — indistinguishable, from the page, from not being owed anything.
 *
 * ⛔ `beneficiary` folds the provider into the hash, so a GitHub account can never collect the fees
 * of the X account that shares its number — and both providers number from small integers, so early
 * accounts on each collide with near certainty. That property is what makes trying both safe.
 */
const payeeFor = async (session, launch) => {
  for (const user of Object.values(session.users ?? {})) {
    const who = beneficiary(user)
    const share = await claims.shareOf(launch, who)
    if (share.ok) return { user, who, share }
  }
  return null
}

const sessionOf = (req) => {
  const token = readCookie(req, 'charity_session')
  if (!token) return null
  const found = sessions.get(token)
  if (!found) return null
  if (Date.now() - found.createdAt > SESSION_TTL_MS) { sessions.delete(token); return null }
  return found
}

/** What a browser reliably renders as a token logo, minus SVG. ⚠ Keyed by magic bytes. */
const SIGNATURES = [
  { ext: 'png', match: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'jpg', match: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'gif', match: (b) => b.subarray(0, 6).toString('ascii').startsWith('GIF8') },
  { ext: 'webp', match: (b) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP' },
  { ext: 'avif', match: (b) => b.subarray(4, 8).toString('ascii') === 'ftyp' && b.subarray(8, 12).toString('ascii').startsWith('avif') },
]

/* ── a crude per-caller budget ────────────────────────────────────────────────────────────────
   A public upload endpoint is a disk somebody else can fill. Content addressing means a determined
   uploader still needs a different image each time, but only just. This turns "fill the disk" into
   "fill the disk slowly and visibly". */
const RATE_WINDOW_MS = 60 * 60 * 1000
const RATE_LIMIT = 40
const seen = new Map()

export function rateLimited(who, now = Date.now(), limit = RATE_LIMIT) {
  const hits = (seen.get(who) ?? []).filter((t) => t > now - RATE_WINDOW_MS)
  /* ⛔⛔ A caller already over budget is turned away WITHOUT being recorded. Pushing first means a
     refused caller keeps growing their own array and every later request re-filters all of it, so a
     flood that is being rejected costs the server more the longer it runs. */
  if (hits.length >= limit) {
    seen.set(who, hits)
    return true
  }
  hits.push(now)
  seen.set(who, hits)
  /* ⚠ Callers whose window has lapsed are dropped, or the map keeps one key per address that ever
     asked, forever: the same unbounded growth the limiter exists to prevent, one level up. */
  if (seen.size > 5000) {
    for (const [other, times] of seen) {
      if (other !== who && !times.some((t) => t > now - RATE_WINDOW_MS)) seen.delete(other)
    }
  }
  return false
}

export async function storeLogo(body, config = { dir: DIR, publicBase: PUBLIC_BASE }) {
  if (body.length === 0) return { ok: false, status: 400, error: 'the upload was empty' }
  if (body.length > MAX_BYTES) {
    return { ok: false, status: 413, error: `that is larger than the ${MAX_BYTES / 1024 / 1024} MB limit` }
  }

  const kind = SIGNATURES.find((s) => s.match(body))
  if (!kind) {
    /* ⚠ Names SVG specifically. Somebody uploading one has done nothing wrong and would otherwise
       be told their perfectly good file is "not an image". */
    const head = body.subarray(0, 512).toString('utf8').toLowerCase()
    const looksSvg = head.trimStart().startsWith('<svg') || head.includes('<svg')
    return {
      ok: false,
      status: 415,
      error: looksSvg
        ? 'An SVG can contain scripts and these are served from the same site you connect a wallet on, so it cannot be accepted. Use PNG, JPEG, GIF, WebP or AVIF.'
        : 'That does not look like a PNG, JPEG, GIF, WebP or AVIF.',
    }
  }

  const name = `${createHash('sha256').update(body).digest('hex').slice(0, 32)}.${kind.ext}`
  const url = `${config.publicBase}/${name}`
  const path = join(config.dir, name)

  try {
    mkdirSync(config.dir, { recursive: true })
    // ⚠ Content addressed, so an existing file is byte for byte the same file. Skipping keeps a
    // re-upload free and cannot change what an on-chain address points at.
    let exists = false
    try { exists = statSync(path).size === body.length } catch { exists = false }
    if (!exists) writeFileSync(path, body)
  } catch (err) {
    return { ok: false, status: 500, error: `could not store the image: ${err?.message ?? err}` }
  }

  /*
    ⭐⭐ Fetched back over the PUBLIC url before saying yes. Writing the file and assuming it is
    reachable is exactly how a launch ends up pointing at a logo nobody can load, and on this chain
    that mistake is permanent. A vhost not serving this directory is caught here rather than by
    whoever looks at the token afterwards.
  */
  const check = await fetch(url, { method: 'HEAD' }).catch(() => null)
  if (!check || !check.ok) {
    return {
      ok: false,
      status: 502,
      error: `Stored, but ${url} does not serve it (${check ? check.status : 'unreachable'}). Not using that address.`,
    }
  }
  return { ok: true, url, bytes: body.length }
}

/** ⚠ Bounded while reading, not after. A body cap enforced once the whole thing is buffered has
 *  already let somebody send it. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

const server = createServer((req, res) => {
  void (async () => {
    const path = (req.url ?? '').split('?')[0]
    /* ⚠ A base is required — `req.url` is a PATH, not an absolute URL, and `new URL` throws on one
       without it. The host is never read from this; it exists only so query parsing works. */
    const url = new URL(req.url ?? '/', 'http://localhost')

    /* ⚠ The availability probe returns JSON, not a status code. A deployment with no upload service
       answers this path with the front end's index.html and a 200, so a probe that trusted the
       status would decide the service was up and offer a control that cannot work. */
    if (path === '/api/logo' && req.method === 'GET') {
      return json(res, 200, { service: 'charity-logo', upload: true, maxBytes: MAX_BYTES })
    }

    if (path === '/api/logo' && req.method === 'POST') {
      const who = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? 'unknown').split(',')[0].trim()
      if (rateLimited(who)) return json(res, 429, { error: 'Too many uploads from here in the last hour.' })
      let body
      try {
        body = await readBody(req, MAX_BYTES + 1024)
      } catch {
        return json(res, 413, { error: `That is larger than the ${MAX_BYTES / 1024 / 1024} MB limit.` })
      }
      const out = await storeLogo(body)
      if (!out.ok) return json(res, out.status, { error: out.error })
      return json(res, 200, { url: out.url, bytes: out.bytes })
    }

    /*
      Which launch each donation came from.

      ## ⛔⛔ THIS IS AN ATTRIBUTION INDEX, NOT A LEDGER OF AMOUNTS

      `CharityPayer.Paid` carries a config id and an amount and no launch token, because the bridge
      credits the payer itself and the money arrives on Base having forgotten which coin earned it.
      The keeper is the only thing that sees both sides, so it writes the join down. That makes this
      the ONE figure on the site sourced from our own box rather than from a chain.

      ➤ So it publishes as little as it can get away with: a launch token and the transaction that
      paid. The browser looks every `payTx` up in the `Paid` events it already reads from Base and
      takes the AMOUNT and the CHARITY from there, so this file can misattribute a donation but
      cannot inflate one, and a row naming a transaction that does not exist is simply dropped.

      ⛔ Serves the donations array and nothing else. `receipts.json` also holds the pending delivery
      and the remitted totals, which are the keeper's working state and no business of a visitor's.
    */
    if (path === '/api/donations') {
      try {
        const raw = JSON.parse(await readFile(RECEIPTS, 'utf8'))
        const rows = Array.isArray(raw?.donations) ? raw.donations : []
        res.setHeader('Cache-Control', 'public, max-age=30')
        return json(res, 200, {
          donations: rows.map((d) => ({ token: d.token, payTx: d.payTx, at: d.at })),
        })
      } catch {
        /* ⚠ An empty list, not a 500. A missing or unreadable file means nothing is attributable,
           and the pages that read this must degrade to showing no rows rather than to an error. */
        return json(res, 200, { donations: [] })
      }
    }

    /*
      Whether money can still move, for an uptime monitor to watch.

      ## ⭐⭐ 200 WHILE MONEY MOVES, 503 ONCE SOMETHING IS STOPPING IT

      On 29 Aug 2026 donations were halted for about forty minutes and nothing said so. Every free
      uptime monitor already knows how to alert on a non-200, so that is the whole interface: point
      one at this path and the silence stops being silent.

      ⚠ SERVED FROM A FILE, never computed here. The checks read two chains, and doing that in the
      request path would make this endpoint slow, rate limitable, and able to hang the one server the
      site has. `charity-health.timer` samples every five minutes and writes `status.json`; this only
      reads it.

      ⚠ A missing or stale file answers 200 with `level: "unknown"`, not 503. A monitor that goes red
      because the checker has not run yet would be ignored within a week.
    */
    if (path === '/api/status') {
      try {
        const st = JSON.parse(await readFile(STATUS, 'utf8'))
        const age = Date.now() - Date.parse(st.at)
        /* ⚠ A status older than four checks is not evidence of health, so it stops asserting any. */
        if (!Number.isFinite(age) || age > 20 * 60 * 1000) {
          return json(res, 200, { level: 'unknown', detail: 'the health check has not reported recently', at: st.at ?? null })
        }
        return json(res, st.code ?? 200, st)
      } catch {
        return json(res, 200, { level: 'unknown', detail: 'no health report yet' })
      }
    }

    /* ══ identity ═══════════════════════════════════════════════════════════════════════════ */

    /**
     * Who the visitor is, and what sign-ins this deployment can actually complete.
     *
     * ⛔ `providers` lists only what is CONFIGURED. The front end must offer buttons off this and
     * nothing else — an unconfigured provider produces a control that fails every time it is used.
     */
    if (path === '/api/me') {
      const session = sessionOf(req)
      return json(res, 200, {
        /*
          ⭐⭐ A LIST, BECAUSE THE TWO ACCOUNTS ARE INDEPENDENT AND SOMEBODY MAY HOLD BOTH.
          A launch names ONE beneficiary, and a person's X account and their GitHub account are
          different beneficiaries — so being signed in with one said nothing about shares owed to
          the other, and connecting the second used to sign you out of the first. Whoever was owed
          on the one they were not currently holding simply could not see it.
        */
        users: Object.values(session?.users ?? {}),
        providers: [...providers.values()].map((p) => ({ name: p.name, label: p.label })),
        claiming: Boolean(claims),
        /* 🔴 True only when sign-in is stubbed, so the UI can say so in the loudest way it has. */
        stub: [...providers.values()].some((p) => p.isStub === true),
      })
    }

    if (path.startsWith('/api/auth/start/')) {
      const name = path.slice('/api/auth/start/'.length)
      if (!isProvider(name) || !providers.has(name)) return json(res, 404, { error: 'no such sign in method' })

      sweepOld(pending, 10 * 60 * 1000)
      if (pending.size > MAX_PENDING) return json(res, 503, { error: 'too many sign ins in flight' })

      const provider = providers.get(name)
      const { url: to, state, verifier } = provider.begin(redirectFor(name))
      pending.set(state, { verifier, createdAt: Date.now() })
      setCookie(res, 'charity_state', state, 600)
      res.writeHead(302, { location: to })
      return res.end()
    }

    if (path.startsWith('/api/auth/callback/')) {
      const name = path.slice('/api/auth/callback/'.length)
      if (!isProvider(name) || !providers.has(name)) return json(res, 404, { error: 'no such sign in method' })

      const provider = providers.get(name)
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      const cookieState = readCookie(req, 'charity_state')

      /*
        ⚠⚠ The state has to match BOTH what we issued and what this browser was given. Checking only
        the server-side map lets any browser complete somebody else's sign in by replaying a state
        they observed; checking only the cookie lets a state we never issued through.
      */
      if (!code || !state || !cookieState || !sameState(state, cookieState) || !pending.has(state)) {
        return json(res, 400, { error: 'that sign in did not come from here' })
      }
      const { verifier } = pending.get(state)
      pending.delete(state)

      const user = await provider.complete(code, verifier, redirectFor(name))

      sweepOld(sessions, SESSION_TTL_MS)
      if (sessions.size > MAX_SESSIONS) return json(res, 503, { error: 'too many sessions' })

      /*
        ⛔⛔ ADDED TO THE EXISTING SESSION, NEVER REPLACING IT. Signing in with GitHub used to
        overwrite an X identity, so "connect the other one" silently meant "disconnect this one" —
        and a share owed to the account you just dropped became invisible with no hint why.
        ⚠ The cookie is REUSED when there is one, so both identities live under one session token.
      */
      const existing = sessionOf(req)
      const token = readCookie(req, 'charity_session') && existing
        ? readCookie(req, 'charity_session')
        : randomBytes(32).toString('hex')
      const users = { ...(existing?.users ?? {}), [user.provider]: user }
      sessions.set(token, { users, createdAt: existing?.createdAt ?? Date.now() })
      setCookie(res, 'charity_session', token, 7 * 24 * 3600)
      setCookie(res, 'charity_state', '', 0)
      res.writeHead(302, { location: '/claim' })
      return res.end()
    }

    if (path === '/api/auth/signout' && req.method === 'POST') {
      const token = readCookie(req, 'charity_session')
      const which = url.searchParams.get('provider')
      const session = token ? sessions.get(token) : null

      /* ⚠ Disconnecting ONE account must not disconnect the other. Only a signout with no provider
         named clears everything. */
      if (session && isProvider(which) && session.users[which]) {
        delete session.users[which]
        if (Object.keys(session.users).length > 0) {
          sessions.set(token, session)
          return json(res, 200, { ok: true })
        }
      }
      if (token) sessions.delete(token)
      setCookie(res, 'charity_session', '', 0)
      return json(res, 200, { ok: true })
    }

    /**
     * Resolve a typed handle to the account that currently holds it.
     *
     * ⛔⛔ THE LAUNCH FORM NEEDS THE NUMERIC ID, NOT THE HANDLE. A beneficiary is
     * `keccak256("x:<id>")` and it goes into a constructor argument that can never be changed — so
     * a launch keyed on the TEXT `@alice` pays whoever holds that name years later. This route is
     * what turns what somebody typed into what gets written down.
     *
     * 🔴🔴 RATE LIMITED, BECAUSE EVERY X CALL SPENDS THE OPERATOR'S MONEY. X's user endpoints are
     * prepaid per lookup and this is an unauthenticated proxy straight to them; a loop could empty
     * the balance. GitHub is free but rate limited by GitHub, and exhausting that breaks it for
     * everyone. ⚠ A generous ceiling — nobody filling in a form makes 120 lookups an hour.
     */
    if (path === '/api/handle') {
      const handle = url.searchParams.get('handle')
      const name = url.searchParams.get('provider')
      if (!handle) return json(res, 400, { error: 'no handle' })
      if (!isProvider(name) || !providers.has(name)) return json(res, 400, { error: 'no such provider' })

      const who = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? 'unknown').split(',')[0].trim()
      if (rateLimited(`handle:${who}`, Date.now(), 120)) {
        return json(res, 429, { error: 'that is a lot of lookups. Try again in a little while.' })
      }

      try {
        const found = await providers.get(name).lookup(handle)
        return json(res, 200, { user: found })
      } catch (err) {
        /* ⛔ A DEPLETED BALANCE IS NOT "TRY AGAIN". It is a prepaid quota only the operator can top
           up, and a generic handler tells the visitor to retry forever. 503, not 500: the route is
           temporarily unable to answer and the caller did nothing wrong. */
        if (err instanceof Error && err.message === 'X_CREDITS_DEPLETED') {
          return json(res, 503, { error: 'handle lookup is unavailable right now. Try GitHub, or try again later.' })
        }
        throw err
      }
    }

    /**
     * A numeric account id back to whoever holds it NOW.
     *
     * ⭐⭐ WHY A TOKEN PAGE NEEDS THIS. A launch records `keccak256("<provider>:<id>")` — a hash,
     * which cannot be reversed — plus the provider and id in the clear, and the router PROVES those
     * two describe the beneficiary. So the page knows which account is paid but not what it is
     * called, because a handle is the one thing that must never be written down: both services let
     * a username be released and re-registered, and a stored one would eventually name, and link
     * to, a different person for ever.
     *
     * ⚠ Public and unauthenticated. It answers a question about a public launch's public metadata.
     * 🔴 Rate limited all the same: X lookups are prepaid from the operator's balance.
     */
    if (path === '/api/account') {
      const name = url.searchParams.get('provider')
      const id = String(url.searchParams.get('id') ?? '')
      if (!isProvider(name)) return json(res, 400, { error: 'no such provider' })
      if (!/^[0-9]{1,25}$/.test(id)) return json(res, 400, { error: 'not an account id' })

      const who = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? 'unknown').split(',')[0].trim()
      if (rateLimited(`account:${who}`, Date.now(), 240)) {
        return json(res, 429, { error: 'too many lookups' })
      }

      try {
        const user = name === 'github'
          ? await handleForGithubId(id)
          : process.env.TWITTERAPI_IO_KEY
            ? await handleForXId(process.env.TWITTERAPI_IO_KEY, id)
            : null
        return json(res, 200, { user })
      } catch (err) {
        /* ⚠ 200 with a null user, not a 500. A page that cannot name an account still renders
           perfectly well saying "an X account" — a failed decoration must not break the row. */
        if (err instanceof Error && err.message === 'X_CREDITS_DEPLETED') return json(res, 200, { user: null })
        throw err
      }
    }

    /* ══ claiming ═══════════════════════════════════════════════════════════════════════════ */

    /**
     * What the signed-in account is owed on one launch.
     *
     * ⚠ Readable with a session but no signature: what a launch pays and what it holds are facts
     * about a public contract. Signing only decides who can be PAID, which is the route below.
     */
    if (path === '/api/claim' && req.method === 'GET') {
      if (!claims) return json(res, 503, { error: 'claiming is not configured on this deployment' })
      const session = sessionOf(req)
      if (!session) return json(res, 401, { error: 'sign in first' })

      const launch = String(url.searchParams.get('launch') ?? '')
      if (!isAddress(launch)) return json(res, 400, { error: 'launch is required' })

      const found = await payeeFor(session, launch)
      if (!found) return json(res, 200, { share: null, reason: 'that launch does not pay any of your accounts' })
      const { user, who, share } = found

      const e = await claims.entitlement(launch, who, share.asset)
      return json(res, 200, {
        /* ⭐ WHICH account is owed it, so the page can say "@alice on GitHub" rather than leaving
           somebody with both connected to guess which one a share belongs to. */
        payee: { provider: user.provider, handle: user.handle },
        share: { bps: share.bps, asset: share.asset, router: share.router },
        onChain: e.onChain.toString(),
        reserved: e.reserved.toString(),
        available: e.available.toString(),
      })
    }

    if (path === '/api/voucher' && req.method === 'POST') {
      if (!claims) return json(res, 503, { error: 'claiming is not configured on this deployment' })
      const session = sessionOf(req)
      if (!session) return json(res, 401, { error: 'sign in first' })

      const body = JSON.parse((await readBody(req, 8192)).toString('utf8') || '{}')
      const launch = String(body.launch ?? '')
      const wallet = String(body.wallet ?? '')
      if (!isAddress(launch) || !isAddress(wallet)) {
        return json(res, 400, { error: 'launch and wallet are required' })
      }

      /*
        ⛔⛔ OWNERSHIP IS CHECKED HERE AND NOWHERE ELSE MATTERS. The session says which account this
        is; the ROUTER'S OWN CONSTRUCTOR ARGUMENTS say which accounts a launch pays. Anything else
        the browser sent is decoration.
        ⛔ `beneficiary` folds the provider into the hash, so a GitHub account can never collect the
        fees of the X account that shares its number — and both providers number from small
        integers, so early accounts on each collide with near certainty.
      */
      const found = await payeeFor(session, launch)
      if (!found) return json(res, 403, { error: 'that launch does not pay any of your accounts' })
      const { who, share } = found

      const e = await claims.entitlement(launch, who, share.asset)
      if (e.available === 0n) return json(res, 400, { error: 'there is nothing available to claim right now' })

      const issuedVoucher = await claims.issue({
        launch, beneficiary: who, asset: share.asset, recipient: wallet, amount: e.available,
      })
      if (!issuedVoucher.ok) return json(res, 400, { error: issuedVoucher.error })
      return json(res, 200, { voucher: issuedVoucher.voucher, contract: claims.address })
    }

    if (path === '/api/health') return json(res, 200, { ok: true })
    return json(res, 404, { error: 'not found' })
  })().catch((err) => json(res, 500, { error: String(err?.message ?? err) }))
})

/* ⛔ Loopback only. Bound to 0.0.0.0 this is an open upload endpoint on the public internet, no
   matter what the firewall is assumed to be doing. Caddy is the only way in. */
if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, '127.0.0.1', () => console.log(`charity logo api on 127.0.0.1:${PORT} -> ${DIR}`))
}

export { server }
