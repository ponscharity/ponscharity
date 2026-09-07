import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/** Where `/api` is proxied in dev and preview. ⚠ Defaults to production so the upload probe works. */
const API_ORIGIN = process.env.API_ORIGIN ?? 'https://ponscharity.family'
const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5233,
    strictPort: true,
    /* ⚠ Without this the upload probe answers with the dev server's index.html, the control falls
       back to a plain link box, and the drop zone is never exercised until production. Pointed at
       the live API by default on purpose: the alternative is running the service locally to test a
       page that only ever talks to the real one.

       ⛔⛔ SIGN-IN AND CLAIMING CANNOT BE TESTED AGAINST THE LIVE API, and that is not a limitation
       of the proxy — OAuth redirects back to the origin that started it, and a session cookie set
       by `ponscharity.family` is never sent to `localhost`. So point this at a local server for
       that work:

         API_ORIGIN=http://127.0.0.1:8803 npx vite

       ⚠ `changeOrigin` is FALSE for a local target. Rewriting the Host header to `127.0.0.1` is
       what the live host needs and what a local server does not, and it makes the callback's
       redirect come back to the wrong place. */
    proxy: {
      '/api': {
        target: API_ORIGIN,
        /* ⛔ `changeOrigin` is about the TARGET, not about whether the variable was set. Pointing at
           the live host with it FALSE leaves the Host header as `localhost:5198`, which that host
           does not serve — /api/me came back empty and the launch form showed no sign-in providers,
           which reads exactly like an unconfigured server. A LOCAL target is the opposite: rewriting
           Host breaks the OAuth callback's own origin. */
        changeOrigin: !LOOPBACK.test(API_ORIGIN),
        secure: true,
      },
    },
  },
  /*
    ⚠⚠ `vite dev` DOES NOT READ `.env.production` — it loads `.env.development`, so in dev
    `VITE_LAUNCHPAD` is empty, `isLive()` is false and the site renders with NO launches at all.
    That looks exactly like a broken registry read and is not one; it cost a debugging detour once.
    ➤ To exercise the real thing, build and preview:  npm run build && npx vite preview --port 5198
    which serves `dist` with the production env baked in. This proxy makes /api work there too.
  */
  preview: {
    port: 5198,
    strictPort: true,
    proxy: {
      '/api': {
        target: API_ORIGIN,
        changeOrigin: !LOOPBACK.test(API_ORIGIN),
        secure: true,
      },
    },
  },
})
