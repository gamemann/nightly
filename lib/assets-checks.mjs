// ASSETS: kind-aware checks for a scan record (the light set; the audit tool judges the rest). Budgets come from the AssetKind row
// (see lib/assets-kinds.mjs for the keys); nothing is hardcoded here but the flag codes. Pure functions.
import { mapFindings } from './map-glb.mjs'
export const SEVERITY_COST = { error: 20, warn: 7, info: 2 }
export function scoreOf(flags) { return Math.max(0, 100 - flags.reduce((a, f) => a + (SEVERITY_COST[f.severity] ?? 0), 0)) }
export const passes = (flags, score) => !flags.some((f) => f.severity === 'error') && score >= 70

/** Flags for one record against its kind's budget at one texture tier. */
export function kindFlags(rec, budget = {}, tier = 'high') {
    const F = []
    const add = (code, severity, msg) => F.push({ code, severity, msg })
    const m = rec.model, B = budget
    if (!m.glb) { add('NO_MODEL', 'error', 'no model file'); return F }
    if (rec.map) { for (const f of mapFindings(rec.map, B)) F.push(f); if (B.min_tris != null && m.tris < B.min_tris && m.tris) add('LOW_TRIS', 'warn', `${m.tris} tris < ${B.min_tris}`); return F }
    if (B.min_tris != null && m.tris < B.min_tris) add(m.tris < B.min_tris / 3 ? 'VERY_LOW_TRIS' : 'LOW_TRIS', 'error', `${m.tris} tris < ${B.min_tris}`)
    if (B.max_tris != null && m.tris > B.max_tris) add('HIGH_TRIS', 'warn', `${m.tris} tris > ${B.max_tris}`)
    if (B.min_materials != null && m.materials < B.min_materials) add('FEW_MATERIALS', 'warn', `${m.materials} materials < ${B.min_materials}`)
    texFlags(rec, B, tier, add)
    rigFlags(rec, B, add)
    const longest = Math.max(...m.bbox)
    if (B.min_size != null && longest > 0 && longest < B.min_size) add('SCALE_SMALL', 'warn', `largest edge ${longest} m < ${B.min_size} m: wrong scale?`)
    if (B.max_size != null && longest > B.max_size) add('SCALE_LARGE', 'warn', `largest edge ${longest} m > ${B.max_size} m: wrong scale?`)
    if (B.max_pivot_offset != null && m.bounds && longest > 0) {
        const cx = (m.bounds.min[0] + m.bounds.max[0]) / 2, cz = (m.bounds.min[2] + m.bounds.max[2]) / 2
        const off = Math.hypot(cx, cz) / longest, base = Math.abs(m.bounds.min[1]) / longest
        if (off > B.max_pivot_offset || base > B.max_pivot_offset) add('PIVOT_OFF', 'warn', `pivot is ${(Math.max(off, base) * 100).toFixed(0)}% of the size away from the base centre`)
    }
    if (B.require_lods && (m.lods ?? 0) < (B.min_lods ?? 2)) add('NO_LODS', 'warn', `${m.lods ?? 0} LOD levels < ${B.min_lods ?? 2}`)
    if (B.require_sounds && !rec.sounds.length) add('NO_SOUNDS', 'warn', 'no sounds matched to this asset')
    return F
}
function texFlags(rec, B, tier, add) {
    const tex = rec.textures
    const need = B.min_tex?.[tier]
    if (!tex.length) { if (need != null || B.require_normal || B.require_orm) add('NO_TEXTURES', 'error', 'no textures'); return }
    const big = Math.max(...tex.map((t) => Math.max(t.w, t.h)))
    if (need != null && big < need) add('LOW_TEX', 'error', `largest texture ${big}px < ${need}px (tier ${tier})`)
    if (B.max_tex != null && big > B.max_tex) add('HUGE_TEX', 'warn', `largest texture ${big}px > ${B.max_tex}px`)
    if (tex.some((t) => t.w && !t.pot)) add('NPOT_TEX', 'warn', 'a texture is not power-of-two')
    if (B.require_normal && !tex.some((t) => t.maps.includes('normal'))) add('MISSING_NORMAL', 'warn', 'no normal map')
    if (B.require_orm && !tex.some((t) => t.maps.some((x) => ['orm', 'roughness', 'metallic'].includes(x)))) add('MISSING_ORM', 'warn', 'no roughness/metallic map')
}
function rigFlags(rec, B, add) {
    const m = rec.model, clips = rec.animations.map((a) => a.name.toLowerCase())
    if (B.require_skin && !(m.skins > 0)) add('NO_SKIN', 'error', 'no skin: a rigged model is expected')
    if (m.bones > 0) {
        if (B.min_bones != null && m.bones < B.min_bones) add('FEW_BONES', 'warn', `${m.bones} bones < ${B.min_bones}`)
        if (B.max_bones != null && m.bones > B.max_bones) add('MANY_BONES', 'warn', `${m.bones} bones > ${B.max_bones}`)
    }
    const missing = (B.required_clips ?? []).filter((c) => !clips.some((n) => n.includes(c.toLowerCase())))
    if (missing.length) add('MISSING_ANIM_SET', clips.length ? 'warn' : 'error', clips.length ? `missing clips: ${missing.join(', ')}` : `no animation clips (needs ${missing.join(', ')}): T-pose`)
    else if (!clips.length && m.skins > 0) add('NO_ANIM_CLIPS', 'info', 'the model carries no animation clips')
}
