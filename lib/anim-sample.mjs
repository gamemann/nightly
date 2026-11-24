// Sampling and lens maths for the baked animation sidecars (fc-weapons tools/aw_anim_bake.gd); pure, shared by the viewer and its tests.
export const PER_FRAME = { transform: 7, position: 3, visible: 1, vec2: 2 }
export const deg = (r) => (r * 180) / Math.PI
export const rad = (d) => (d * Math.PI) / 180

/** Frame index pair and blend for time t (seconds) in a clip of `frames` frames at `fps`; looping wraps, otherwise it holds the last frame. */
export function frameAt(t, frames, fps, loop) {
    const last = frames - 1
    let f = t * fps
    if (loop) f = ((f % frames) + frames) % frames
    else f = Math.min(Math.max(f, 0), last)
    const a = Math.floor(f)
    const b = loop ? (a + 1) % frames : Math.min(a + 1, last)
    return { a, b, k: f - a }
}

/** The track's values at time t: positions and vec2 are lerped, a transform is [x y z qx qy qz qw] with the quaternion slerped, a visible flag steps. */
export function sample(track, t, frames, fps, loop) {
    const n = PER_FRAME[track.path]
    const { a, b, k } = frameAt(t, frames, fps, loop)
    const v = track.values
    const at = (f, i) => v[f * n + i]
    if (track.path === 'visible') return [at(a, 0)]
    const out = []
    for (let i = 0; i < n; i++) out.push(at(a, i) + (at(b, i) - at(a, i)) * k)
    if (track.path === 'transform') {
        const qa = [3, 4, 5, 6].map((i) => at(a, i))
        let qb = [3, 4, 5, 6].map((i) => at(b, i))
        let d = qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3]
        if (d < 0) { qb = qb.map((x) => -x); d = -d }
        let q
        if (d > 0.9995) q = qa.map((x, i) => x + (qb[i] - x) * k)
        else {
            const th = Math.acos(d), s = Math.sin(th), wa = Math.sin((1 - k) * th) / s, wb = Math.sin(k * th) / s
            q = qa.map((x, i) => x * wa + qb[i] * wb)
        }
        const len = Math.hypot(...q) || 1
        out.splice(3, 4, ...q.map((x) => x / len))
    }
    return out
}

/** Vertical fov (degrees) for a horizontal fov on a 4:3 screen, the menu's convention (GSViewLens.vertical_from_horizontal_4_3). */
export const verticalFrom43 = (h) => deg(2 * Math.atan(Math.tan(rad(h) / 2) * 0.75))

/** GSViewLens.apply: scale (k,k,1) and a z push for the view model drawn at `hands` vertical degrees inside a `cam` vertical degree camera; hands<=1 is the identity. */
export function lens(lensInfo, camV, handsV) {
    if (handsV <= 1) return { k: 1, z: 0 }
    const k = Math.tan(rad(camV) / 2) / Math.tan(rad(handsV) / 2)
    return { k, z: -Math.max((k - 1) * lensInfo.reference_depth * lensInfo.depth_comp, -lensInfo.max_pull_in) }
}
