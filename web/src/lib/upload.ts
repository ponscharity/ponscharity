/**
 * Uploading a token image to Pons Charity's own host.
 *
 * ⚠⚠ THE PROBE READS THE BODY, NOT THE STATUS CODE. On a deployment with no upload service the path
 * `/api/logo` is served by the front end's own `try_files` rule, which answers **200 with the HTML
 * of the home page**. A probe that trusted the status would decide the service was up and draw a
 * drop zone that cannot work.
 */
export const LOGO_MAX_BYTES = 4 * 1024 * 1024

export async function logoUploadAvailable(): Promise<boolean> {
  try {
    const res = await fetch('/api/logo')
    if (!res.ok) return false
    const body = (await res.json().catch(() => null)) as { upload?: boolean } | null
    return body?.upload === true
  } catch {
    return false
  }
}

export async function uploadLogo(file: File): Promise<{ url: string; bytes: number }> {
  if (file.size > LOGO_MAX_BYTES) {
    throw new Error(`that is larger than the ${LOGO_MAX_BYTES / 1024 / 1024} MB limit`)
  }
  const res = await fetch('/api/logo', { method: 'POST', body: file })
  const body = (await res.json().catch(() => null)) as { url?: string; bytes?: number; error?: string } | null
  if (!res.ok || !body?.url) {
    /* ⚠ The server's own sentence wins. It knows whether the file was an SVG, too large, or stored
       but unreachable, and a bare status code tells somebody none of those. */
    throw new Error(body?.error ?? `the upload failed (${res.status})`)
  }
  return { url: body.url, bytes: body.bytes ?? file.size }
}
