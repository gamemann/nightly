// Baked animation sidecars (<glb stem>.anim.json, written by fc-weapons tools/export_anim_tracks.gd) next to an asset's GLB.
import { existsSync, readFileSync } from 'node:fs'

export const sidecarOf = (glb) => (glb && glb.endsWith('.glb') ? glb.slice(0, -4) + '.anim.json' : '')

/** The sidecar's parsed JSON, or null when the asset has none or it is not a version-1 bake. */
export function readSidecar(glb) {
    const p = sidecarOf(glb)
    if (!p || !existsSync(p)) return null
    try {
        const j = JSON.parse(readFileSync(p, 'utf8'))
        return j && j.version === 1 && Array.isArray(j.clips) ? j : null
    } catch { return null }
}

/** The Animations rows for a bake: real length and track count, the "procedural" flag replaced by "baked". */
export const clipRows = (side) => side.clips.map((c) => ({ name: c.name, length: c.length, tracks: c.tracks.length, flags: ['baked', ...(c.loop ? ['loop'] : [])], mag_displacement: null }))

/** Replaces a record's procedural clip stubs with the baked rows and points files.anim at the sidecar (mutates both). Returns whether it did. */
export function attachSidecar(rec, files) {
    const side = readSidecar(files?.glb)
    if (!side) return false
    rec.animations = clipRows(side)
    files.anim = sidecarOf(files.glb)
    return true
}
