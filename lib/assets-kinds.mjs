// ASSETS: asset kinds (weapon, prop, avatar, ...) as database rows. A kind says how to recognise a model by its path (`match`, a
// case-insensitive regex) and what the audit judges it against (`budget`, JSON). Nothing here knows any pack, game or path: the
// seed below is a set of generic examples a user edits in the panel (/assets/sources) or with `nightly assets kind set`.
//
// budget keys (all optional; a missing key means "not checked"):
//   min_tris / max_tris          triangle range; under min/3 is VERY_LOW_TRIS, over max is HIGH_TRIS
//   min_materials                fewer separate materials is FEW_MATERIALS
//   min_tex {low,medium,high}    largest texture edge in px each video-settings tier must reach
//   max_tex                      largest texture edge allowed (px), over is HUGE_TEX
//   require_normal / require_orm   a normal map / a roughness+metallic map must exist
//   require_lods, min_lods       at least min_lods (default 2) LOD levels (nodes named *_lodN / *_LODN)
//   require_skin, min_bones, max_bones   a skin must exist, with a bone count in range
//   required_clips [names]       animation clips that must exist (name contains the string)
//   min_size / max_size          largest bbox edge in model units (metres)
//   max_pivot_offset             how far the bbox centre of the base may sit from the origin, as a fraction of the size
//   require_sounds               at least one sound must be matched
//   max_untextured_pct, require_spawns, require_collision   for converted maps (source config `maps`): share of triangles without a
//                                texture file (MAP_UNTEXTURED), no spawn points (MAP_NO_SPAWNS), no collision hulls (MAP_NO_COLLISION)
const nowIso = () => new Date().toISOString()
const T = (lo, mid, hi) => ({ low: lo, medium: mid, high: hi })
export const SEED_KINDS = [
    { key: 'viewmodel', label: 'Viewmodels', sort: 10, match: '(viewmodel|view_model|fps_?arms|first_?person|hands)', budget: { min_tris: 2000, max_tris: 25000, min_tex: T(256, 512, 1024), require_skin: true, required_clips: ['idle'] } },
    { key: 'grenade', label: 'Grenades', sort: 20, match: '(grenade|bomb|throwable|molotov)', budget: { min_tris: 300, max_tris: 10000, min_tex: T(128, 256, 512) } },
    { key: 'weapon', label: 'Weapons', sort: 30, match: '(weapon|gun|rifle|pistol|blaster|launcher|knife|sword|melee)', budget: { min_tris: 3000, min_materials: 3, min_tex: T(256, 512, 1024), require_normal: true, require_orm: true, require_sounds: true } },
    { key: 'avatar', label: 'Avatars', sort: 40, match: '(avatar|character|player|npc|humanoid|enemy)', budget: { min_tris: 3000, max_tris: 30000, min_tex: T(256, 512, 1024), require_skin: true, min_bones: 20, max_bones: 100, required_clips: ['idle', 'walk', 'run'], min_size: 1, max_size: 2.6, max_pivot_offset: 0.15 } },
    { key: 'vehicle', label: 'Vehicles', sort: 50, match: '(vehicle|car|truck|tank|boat|plane|bike|heli)', budget: { min_tris: 3000, max_tris: 60000, min_tex: T(256, 512, 1024), require_lods: true } },
    { key: 'pickup', label: 'Pickups', sort: 60, match: '(pickup|ammo|health|powerup|loot|medkit)', budget: { min_tris: 200, max_tris: 8000, min_tex: T(128, 256, 512) } },
    { key: 'building', label: 'Buildings', sort: 70, match: '(building|house|tower|wall|structure|ruin|barn)', budget: { min_tris: 200, max_tris: 80000, min_tex: T(256, 512, 1024), require_lods: true } },
    { key: 'prop', label: 'Props', sort: 80, match: '(prop|crate|barrel|furniture|decor|rock|tree|debris)', budget: { min_tris: 100, max_tris: 20000, min_tex: T(128, 256, 512) } },
    { key: 'map', label: 'Maps', sort: 90, match: '', budget: { min_tris: 1000, max_untextured_pct: 50, require_spawns: true, require_collision: true } },
    { key: 'other', label: 'Other', sort: 99, match: '', budget: {} },
]
export const DEFAULT_KIND = 'other'

const parseRow = (r) => ({ ...r, budget: JSON.parse(r.budget || '{}') })
export function seed(db) {
    const have = db.prepare('SELECT COUNT(*) AS n FROM AssetKind').get().n
    if (have) return 0
    const ins = db.prepare('INSERT INTO AssetKind (key, label, sort, match, budget, updatedAt) VALUES (?,?,?,?,?,?)')
    for (const k of SEED_KINDS) ins.run(k.key, k.label, k.sort, k.match, JSON.stringify(k.budget), nowIso())
    return SEED_KINDS.length
}
export const list = (db) => db.prepare('SELECT * FROM AssetKind ORDER BY sort, key').all().map(parseRow)

export function validateKind(k) {
    if (!/^[a-z][a-z0-9_-]*$/.test(k.key ?? '')) throw new Error('kind key: lowercase letters, digits, - and _ (start with a letter)')
    if (k.match) { try { new RegExp(k.match, 'i') } catch (e) { throw new Error(`kind match is not a regex: ${e.message}`) } }
    if (typeof k.budget !== 'object' || k.budget === null || Array.isArray(k.budget)) throw new Error('kind budget must be a JSON object')
    if (k.budget.min_tex && (typeof k.budget.min_tex !== 'object')) throw new Error('budget.min_tex must be {low,medium,high}')
    if (k.budget.required_clips && !Array.isArray(k.budget.required_clips)) throw new Error('budget.required_clips must be a list of names')
}
export function save(db, k) {
    const old = db.prepare('SELECT * FROM AssetKind WHERE key = ?').get(k.key)
    const next = { key: k.key, label: k.label ?? old?.label ?? k.key, sort: Number(k.sort ?? old?.sort ?? 50), match: k.match ?? old?.match ?? '', budget: k.budget ?? (old ? JSON.parse(old.budget) : {}) }
    validateKind(next)
    if (old) db.prepare('UPDATE AssetKind SET label=?, sort=?, match=?, budget=?, updatedAt=? WHERE key=?').run(next.label, next.sort, next.match, JSON.stringify(next.budget), nowIso(), next.key)
    else db.prepare('INSERT INTO AssetKind (key, label, sort, match, budget, updatedAt) VALUES (?,?,?,?,?,?)').run(next.key, next.label, next.sort, next.match, JSON.stringify(next.budget), nowIso())
    return old ? 'updated' : 'added'
}
export function remove(db, key) {
    const used = db.prepare('SELECT COUNT(*) AS n FROM AssetWeapon WHERE kind = ?').get(key).n
    if (used) throw new Error(`kind "${key}" is used by ${used} assets: re-scan or move them first`)
    return db.prepare('DELETE FROM AssetKind WHERE key = ?').run(key).changes
}

/** The kind of a model: the source's own rules first, then the kinds' path regexes (by sort order), then the source default. Pure. */
export function classify(rel, { kinds, rules = [], defaultKind = '' }) {
    for (const r of rules) { try { if (new RegExp(r.match, 'i').test(rel)) return r.kind } catch { /* bad rule: validated on save */ } }
    for (const k of kinds) { if (k.match && new RegExp(k.match, 'i').test(rel)) return k.key }
    return defaultKind || DEFAULT_KIND
}
export const budgetOf = (kinds, key) => kinds.find((k) => k.key === key)?.budget ?? {}
