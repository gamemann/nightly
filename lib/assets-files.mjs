// ASSETS (RSI) tab, file serving only (no scan code, so the panel bundle stays small and Turbopack does not trace the whole tree).
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { imageBytes, mimeOf, readModel } from './glb.mjs'

export const DEFAULT_AUDIT_DIR = () => path.join(/*turbopackIgnore: true*/ process.cwd(), 'data', 'rsi-assets')
export const AUDIT_DIR = () => process.env.NIGHTLY_ASSETS_DIR || DEFAULT_AUDIT_DIR()
/** Files the panel may serve: under the audit dir, NIGHTLY_ASSET_ROOTS (colon separated) or a source root (set from the
 *  AssetSource rows by whoever holds a database handle: setExtraRoots). */
let extra = []
export const setExtraRoots = (roots) => { extra = roots.filter(Boolean) }
export const SERVE_ROOTS = () => [...(process.env.NIGHTLY_ASSET_ROOTS || '').split(':'), AUDIT_DIR(), ...extra].filter(Boolean)

export function underRoots(file) {
    let real
    try { real = realpathSync(file) } catch { return false }
    return SERVE_ROOTS().some((r) => { try { const rr = realpathSync(r); return real === rr || real.startsWith(rr + path.sep) } catch { return false } })
}
/** { file } to stream, or { bytes, mime } for an image inside a glb, or null. `data` is a row's parsed JSON. */
export function resolveFile(data, kind, i = 0) {
    const f = data._files ?? {}
    if (kind === 'glb') return f.glb && underRoots(f.glb) ? { file: f.glb, mime: 'model/gltf-binary' } : null
    const ent = (kind === 'tex' ? f.textures : kind === 'snd' ? f.sounds : [])?.[i]
    if (!ent) return null
    if (ent.kind === 'file') return underRoots(ent.path) ? { file: ent.path, mime: undefined } : null
    if (ent.kind === 'glb' && f.glb && underRoots(f.glb)) {
        const m = readModel(f.glb)
        const b = imageBytes(m, ent.index)
        return b ? { bytes: b, mime: mimeOf(b) } : null
    }
    return null
}
