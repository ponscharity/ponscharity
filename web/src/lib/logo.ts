/**
 * The token image.
 *
 * ## ⛔⛔ ON PONS V2 THE LOGO IS A LINK, NOT A PICTURE
 *
 * `PonsV2LaunchDeployer._requireMetadataWithinLimits` reverts `MetadataTooLong` above
 * **512 bytes**. A 128x128 WebP data URI is several thousand bytes, and even a 16x16 one does not
 * reliably fit. So an image cannot be uploaded into the launch itself: the field holds a URI and
 * the image has to live somewhere that keeps existing.
 *
 * ⚠ The revert names no field, so an oversized logo fails the whole launch with a message that
 * points nowhere. That is why this is checked here, before anything is signed.
 *
 * ⭐ The convention on this chain is `ipfs://…`, about 60 bytes, which at least cannot silently
 * change what it points at. An ordinary https link works too and is checked the same way.
 */

/** `PonsV2LaunchDeployer.MAX_LOGO_LENGTH`, in bytes rather than characters. */
export const LOGO_MAX_BYTES = 512

/**
 * Gateways used ONLY to render a preview.
 *
 * ⚠⚠ Never substituted into the launch. The `ipfs://` URI somebody typed is what goes on chain, so
 * the token is never bound to one gateway's continued existence. A gateway that is down makes an
 * image fail to load and changes nothing about the token.
 */
const GATEWAYS = ['https://ipfs.io/ipfs/', 'https://cloudflare-ipfs.com/ipfs/'] as const

export function resolveImage(uri: string | undefined | null, gateway = 0): string | null {
  const v = (uri ?? '').trim()
  if (!v) return null
  if (v.startsWith('ipfs://')) return GATEWAYS[Math.min(gateway, GATEWAYS.length - 1)] + v.slice('ipfs://'.length)
  if (/^https?:\/\//i.test(v)) return v
  /* ⛔ Anything else is not rendered. A bare CID, a relative path or a `javascript:` URI all end up
     here, and putting an unvalidated string into `src` is how a token's metadata becomes a way to
     load something from somewhere nobody chose. */
  return null
}

export const GATEWAY_COUNT = GATEWAYS.length

export type LogoCheck = { ok: boolean; bytes: number; preview: string | null; error: string | null }

export function checkLogo(value: string): LogoCheck {
  const v = value.trim()
  const bytes = new TextEncoder().encode(v).length

  // ⚠ Empty is valid. A token with no image is allowed, it just never gets one.
  if (!v) return { ok: true, bytes: 0, preview: null, error: null }

  if (bytes > LOGO_MAX_BYTES) {
    return {
      ok: false, bytes, preview: null,
      error: v.startsWith('data:')
        ? `A pasted image is ${bytes} bytes and Pons allows ${LOGO_MAX_BYTES}. Host the image and use its link instead.`
        : `${bytes} bytes, over the ${LOGO_MAX_BYTES} byte limit Pons enforces.`,
    }
  }

  const preview = resolveImage(v)
  if (!preview) {
    return { ok: false, bytes, preview: null, error: 'Use a link starting with https:// or ipfs://' }
  }
  return { ok: true, bytes, preview, error: null }
}
