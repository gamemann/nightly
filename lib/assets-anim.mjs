// Baked animation sidecars (<glb stem>.anim.json, written by the pack's anim track export tool) next to an asset's GLB.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export const sidecarOf = (glb) => (glb && glb.endsWith('.glb') ? glb.slice(0, -4) + '.anim.json' : '')

/** Where a GLB's sidecar lives: next to it, else in the served audit dir's glb/ folder (audits record the producer's GLB path, the bakes are published to the panel). */
export function sidecarPath(glb) {
    const p = sidecarOf(glb)
    if (!p || existsSync(p)) return p
    const dir = process.env.NIGHTLY_ASSETS_DIR || path.join(/*turbopackIgnore: true*/ process.cwd(), 'data', 'rsi-assets')
    const alt = path.join(dir, 'glb', path.basename(p))
    return existsSync(alt) ? alt : p
}

/** The sidecar's parsed JSON, or null when the asset has none or it is not a version-1 bake. */
export function readSidecar(glb) {
    const p = sidecarPath(glb)
    if (!p || !existsSync(p)) return null
    try {
        const j = JSON.parse(readFileSync(p, 'utf8'))
        return j && j.version === 1 && Array.isArray(j.clips) ? j : null
    } catch { return null }
}

/** The Animations rows for a bake: real length and track count, the "procedural" flag replaced by "baked". */
/** Smallest magazine travel (metres) that counts as the magazine moving; below it the clip has none. */
const MAG_EPSILON = 1e-4

/** How far a clip's magazine travels: the peak distance of its position from the first frame, from the `magazine` track (transform: 7 floats a frame, position: 3). An explicit `mag_displacement` on the clip wins; null when the clip has no magazine track or it never moves. */
export function magDisplacement(clip) {
    if (typeof clip.mag_displacement === 'number') return clip.mag_displacement
    const t = (clip.tracks || []).find((k) => k.target === 'magazine' && (k.path === 'transform' || k.path === 'position'))
    if (!t || !Array.isArray(t.values)) return null
    const stride = t.path === 'transform' ? 7 : 3
    const v = t.values
    if (v.length < stride * 2) return null
    let best = 0
    for (let i = stride; i + 2 < v.length; i += stride) best = Math.max(best, Math.hypot(v[i] - v[0], v[i + 1] - v[1], v[i + 2] - v[2]))
    return best < MAG_EPSILON ? null : Math.round(best * 1000) / 1000
}

export const clipRows = (side) => side.clips.map((c) => ({ name: c.name, length: c.length, tracks: c.tracks.length, flags: ['baked', ...(c.loop ? ['loop'] : [])], mag_displacement: magDisplacement(c) }))

/** Replaces a record's procedural clip stubs with the baked rows and points files.anim at the sidecar (mutates both). Returns whether it did. */
export function attachSidecar(rec, files) {
    const side = readSidecar(files?.glb)
    if (!side) return false
    rec.animations = clipRows(side)
    if (side.weapon) rec.anim_weapon = side.weapon
    files.anim = sidecarPath(files.glb)
    return true
}
