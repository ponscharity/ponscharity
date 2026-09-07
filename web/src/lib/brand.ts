export const X_URL = 'https://x.com/ponscharity'
export const GITHUB_URL = 'https://github.com/ponscharity/ponscharity'
export const SITE_URL = 'https://ponscharity.family'
export const SITE_NAME = 'Pons Charity'

/**
 * This site's own token, shown as a copyable strip under the hero.
 *
 * ⛔⛔ `CA: TBA` UNTIL THE TOKEN EXISTS, and never a sentence about the build. The site does not
 * narrate its own construction status to visitors, so the strip does not say "coming soon", "not
 * launched yet" or anything else about what has or has not happened. It states the address, and
 * where there is no address yet it says so in the shortest form that is still true. This is the one
 * standing exception to writing every feature in the present tense.
 *
 * ➤ Set `VITE_TOKEN_CA` in `web/.env.production` and redeploy to fill it in. Nothing else changes:
 * the strip becomes click-to-copy on its own once there is something to copy.
 */
export const TOKEN_CA = (
  (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_TOKEN_CA ?? ''
).trim()

export const hasTokenCa = () => /^0x[0-9a-fA-F]{40}$/.test(TOKEN_CA)
