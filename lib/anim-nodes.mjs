// The baked node tracks (bolt, magazine) a sidecar carries besides the weapon pose; pure, shared by the viewer and its tests.
import { sample } from './anim-sample.mjs'

/** The sidecar's movable parts; `side.nodes[part]` names the GLB node ('' when the model has none: the viewer then draws a stand-in). */
export const NODE_PARTS = ['bolt', 'magazine']

/** The part's pose at time t of a clip: { pos, quat (null for a position-only track), visible (null when no visibility track) }, or null when the clip has no track for it.
 *  The magazine's transform is in the weapon's own frame (the bake multiplies by the weapon's inverse), so it is applied under the weapon, not the camera. */
export function partPose(clip, part, t, fps) {
    const tr = clip.tracks.find((x) => x.target === part && (x.path === 'transform' || x.path === 'position'))
    const vis = clip.tracks.find((x) => x.target === `${part}.visible`)
    if (!tr && !vis) return null
    const s = tr ? sample(tr, t, clip.frames, fps, clip.loop) : null
    return {
        pos: s ? [s[0], s[1], s[2]] : null,
        quat: s && tr.path === 'transform' ? [s[3], s[4], s[5], s[6]] : null,
        visible: vis ? sample(vis, t, clip.frames, fps, clip.loop)[0] > 0.5 : null,
    }
}

/** Which parts the sidecar animates in any clip, with the named GLB node ('' = none). */
export function animatedParts(side) {
    const out = []
    for (const part of NODE_PARTS) {
        if (side.clips.some((c) => c.tracks.some((x) => x.target === part || x.target === `${part}.visible`))) out.push({ part, node: side.nodes?.[part] ?? '' })
    }
    return out
}
