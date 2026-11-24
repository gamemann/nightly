import type { AttachLink } from "./AssetDetail"

/** The optic the viewer is looking through: where it sits on the model (model space, metres), and what it does to the view. */
export type Sight = { key: string; pos: [number, number, number]; zoom: number; aim: string; label: string }

/** The game's view-model camera FOV (degrees) before any optic; an optic's `zoom` scales the field of view (0.5 = twice the magnification). */
export const BASE_FOV = 40

/** Gun models face -Z (Godot and glTF agree), so the eye sits behind the optic on +Z and looks down -Z. */
export const EYE_BACK = 0.12

/** The first picked attachment that carries a zoom (an optic), or null. `picked` maps slot -> index into `links`. */
export function sightOf(links: AttachLink[], picked: Record<string, number>): Sight | null {
    for (const [slot, i] of Object.entries(picked)) {
        const l = links[i]
        const zoom = Number(l?.meta?.zoom)
        if (!l || !Number.isFinite(zoom) || zoom <= 0) continue
        const p = l.pos
        return { key: `${slot}:${l.other.id}`, pos: [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0], zoom, aim: String(l.meta.aim ?? "glass"), label: l.other.weaponId }
    }
    return null
}

/** Field of view (degrees) through the optic. */
export function sightFov(s: Sight, base = BASE_FOV): number {
    return Math.max(2, Math.min(120, base * s.zoom))
}

/** Magnification as the game shows it ("1.2x"): inverse of the zoom factor. */
export function sightMagnification(s: Sight): string {
    return `${(1 / s.zoom).toFixed(1)}x`
}

/** Camera pose for the sight line: position behind the optic, the point it looks at, and the fov. A pure function so a View model mode can reuse it. */
export function sightPose(s: Sight): { position: [number, number, number]; target: [number, number, number]; fov: number } {
    const [x, y, z] = s.pos
    return { position: [x, y, z + EYE_BACK], target: [x, y, z - 10], fov: sightFov(s) }
}

/** Where a held weapon goes in the eye's frame so the optic sits on the eye's axis, EYE_BACK in front of the eye (the View model mode's sight line). */
export function adsWeaponPos(s: Sight): [number, number, number] {
    const [x, y, z] = s.pos
    return [-x, -y, -EYE_BACK - z]
}
