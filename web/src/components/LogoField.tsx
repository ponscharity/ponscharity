import { useEffect, useRef, useState } from 'react'
import { logoUploadAvailable, uploadLogo, LOGO_MAX_BYTES } from '../lib/upload.ts'
import { TokenImage } from './TokenImage.tsx'

/**
 * The token image, uploaded rather than linked.
 *
 * ⚠⚠ EVERY FAILURE SAYS "NOTHING WAS UPLOADED", EXPLICITLY. The logo is written into the token's
 * constructor with no setter, so somebody who believes their image was accepted when it was not
 * launches a token that has no picture, permanently. The field is left empty on failure rather than
 * pointing at something that does not exist.
 */
export function LogoField({
  value, onChange, error,
}: { value: string; onChange: (v: string) => void; error?: string }) {
  const [available, setAvailable] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [over, setOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  /* ⚠ Asked once, and the control is only drawn if the answer is yes. Offering an upload on a
     deployment with nothing behind it produces "the upload failed (405)": a status code, shown to
     somebody who did nothing wrong. */
  useEffect(() => { void logoUploadAvailable().then(setAvailable) }, [])

  async function take(file: File | undefined | null) {
    if (!file) return
    setBusy(true)
    setFailed(null)
    try {
      const { url } = await uploadLogo(file)
      onChange(url)
    } catch (e) {
      onChange('')
      setFailed(
        `${e instanceof Error ? e.message : 'the upload failed'}. Nothing was uploaded, and the image ` +
        'has been left empty rather than pointing at something that does not exist.',
      )
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }

  return (
    <div className="field">
      <label className="field__l">Token image</label>

      <div className="logorow">
        <TokenImage uri={value} className="logorow__img" />

        <div style={{ flex: 1, minWidth: 0 }}>
          {available === false ? (
            /* ⚠ A plain input, not a broken drop zone. Nothing has gone wrong for the visitor. */
            <input className="input mono" placeholder="https://  or  ipfs://" value={value}
              onChange={(e) => onChange(e.target.value)} />
          ) : (
            <div
              className={`drop${over ? ' is-over' : ''}${busy ? ' is-busy' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setOver(true) }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => { e.preventDefault(); setOver(false); void take(e.dataTransfer.files?.[0]) }}
              onClick={() => input.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.current?.click() } }}
            >
              <input
                ref={input} type="file" hidden
                accept="image/png,image/jpeg,image/gif,image/webp,image/avif"
                onChange={(e) => void take(e.target.files?.[0])}
              />
              {busy ? (
                <span className="drop__t">Uploading</span>
              ) : value ? (
                <>
                  <span className="drop__t">Image uploaded</span>
                  <span className="drop__s">Click or drop another to replace it</span>
                </>
              ) : (
                <>
                  <span className="drop__t">Drop an image, or click to choose</span>
                  <span className="drop__s">
                    PNG, JPEG, GIF, WebP or AVIF, up to {LOGO_MAX_BYTES / 1024 / 1024} MB
                  </span>
                </>
              )}
            </div>
          )}

          {failed ? <p className="field__err">{failed}</p>
            : error ? <p className="field__err">{error}</p>
            : null}

          {value && (
            <button type="button" className="btn btn--sm" style={{ marginTop: 10 }}
              onClick={() => { onChange(''); setFailed(null) }}>
              Remove image
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
