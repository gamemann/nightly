// ASSETS: the editor-facing description of a converted map, written into the GLB scene extras by map-glb.mjs so the Maps page
// (Hammer/Godot-style outliner + inspector) never re-parses a manifest. Pure helpers: everything is derived from the manifest content,
// nothing about a game or pack is built in. Units are metres, Godot axes (the caller passes the manifest's metres-per-unit).

export const slug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'item'

/** A JSON-safe, size-capped copy of a manifest value (long strings cut, long lists summarised, deep objects dropped). */
export function trim(v, depth = 0) {
    if (v == null || typeof v === 'number' || typeof v === 'boolean') return v
    if (typeof v === 'string') return v.length > 240 ? `${v.slice(0, 240)}...` : v
    if (Array.isArray(v)) {
        if (v.length && v.every((x) => typeof x === 'number')) return v.length > 16 ? [...v.slice(0, 16), `... ${v.length} values`] : v
        if (depth >= 3) return `[${v.length} items]`
        return v.length > 12 ? [...v.slice(0, 12).map((x) => trim(x, depth + 1)), `... ${v.length} items`] : v.map((x) => trim(x, depth + 1))
    }
    if (typeof v === 'object') {
        if (depth >= 3) return `{${Object.keys(v).length} keys}`
        const out = {}
        const keys = Object.keys(v)
        for (const k of keys.slice(0, 40)) out[k] = trim(v[k], depth + 1)
        if (keys.length > 40) out['...'] = `${keys.length - 40} more keys`
        return out
    }
    return String(v)
}
/** Every key of `o` except `skip`, trimmed: the Hammer-style key/value list of an item. */
export function rawOf(o, skip = []) {
    const out = {}
    if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) if (!skip.includes(k) && v !== undefined) out[k] = trim(v)
    return out
}

export const vec = (a, k) => (Array.isArray(a) && a.length >= 3 && a.slice(0, 3).every(Number.isFinite) ? a.slice(0, 3).map((x) => +(x * k).toFixed(4)) : null)

/** Corner points of a convex brush given as outward planes [nx,ny,nz,d] (n.p = d): every plane triple's intersection inside all planes. */
export function planePoints(planes) {
    const P = (planes ?? []).filter((q) => Array.isArray(q) && q.length >= 4 && q.every(Number.isFinite))
    if (P.length < 4 || P.length > 40) return []
    const out = []
    for (let a = 0; a < P.length; a++) for (let b = a + 1; b < P.length; b++) for (let c = b + 1; c < P.length; c++) {
        const [A, B, C] = [P[a], P[b], P[c]]
        const det = A[0] * (B[1] * C[2] - B[2] * C[1]) - A[1] * (B[0] * C[2] - B[2] * C[0]) + A[2] * (B[0] * C[1] - B[1] * C[0])
        if (Math.abs(det) < 1e-9) continue
        const x = (A[3] * (B[1] * C[2] - B[2] * C[1]) - A[1] * (B[3] * C[2] - B[2] * C[3]) + A[2] * (B[3] * C[1] - B[1] * C[3])) / det
        const y = (A[0] * (B[3] * C[2] - B[2] * C[3]) - A[3] * (B[0] * C[2] - B[2] * C[0]) + A[2] * (B[0] * C[3] - B[3] * C[0])) / det
        const z = (A[0] * (B[1] * C[3] - B[3] * C[1]) - A[1] * (B[0] * C[3] - B[3] * C[0]) + A[3] * (B[0] * C[1] - B[1] * C[0])) / det
        if (P.every((q) => q[0] * x + q[1] * y + q[2] * z <= q[3] + 1e-4) && !out.some((p) => Math.hypot(p[0] - x, p[1] - y, p[2] - z) < 1e-4)) out.push([x, y, z])
    }
    return out
}

/** Editor group of an entity class: spawn | light | trigger | logic | prop | func | sound | other. */
export function classGroup(cn) {
    const c = String(cn ?? '').toLowerCase()
    if (/^info_player|spawn/.test(c)) return 'spawn'
    if (/^light|^env_sun|^env_sprite|^env_fog|^env_tonemap|^env_cubemap/.test(c)) return 'light'
    if (/^trigger_/.test(c)) return 'trigger'
    if (/^(logic_|filter_|math_|game_|point_template|point_clientcommand|phys_|env_|team_)/.test(c)) return 'logic'
    if (/^prop_/.test(c)) return 'prop'
    if (/^func_|^momentary_|^path_track|^info_target|^info_landmark/.test(c)) return 'func'
    if (/^ambient_|^env_soundscape|^snd_/.test(c)) return 'sound'
    if (/^weapon_|^item_|^ammo_/.test(c)) return 'pickup'
    return 'other'
}

const SCALAR_SKIP = new Set(['surfaces', 'hulls', 'props', 'spawns', 'entities', 'links', 'vis', 'lightmap', 'skin_materials', 'volumes', 'zones', 'respawn_volumes', 'trigger_volumes', 'push_volumes', 'mechanics', 'movers', 'breakables', 'pickups', 'sounds', 'licence', 'collision', 'entity_report', 'bin', 'source'])
/** Map-level key/values: the tier manifest's keys over the mesh companion's (small values only; lists are summarised by count). */
export function mapInfo(j, comp) {
    const out = {}
    const add = (src, prefix = '') => {
        if (!src || typeof src !== 'object') return
        for (const [k, v] of Object.entries(src)) {
            if (v == null) continue
            const key = prefix + k
            if (Array.isArray(v) && (SCALAR_SKIP.has(k) || JSON.stringify(v).length > 600)) { out[`${key} (count)`] = v.length; continue }
            if (SCALAR_SKIP.has(k) && typeof v === 'object') { out[`${key} (keys)`] = Object.keys(v).length; continue }
            if (!(key in out)) out[key] = trim(v)
        }
    }
    add(j)
    if (comp && comp.json !== j) add(comp.json)
    if (j.source && typeof j.source === 'object') out.source = trim(j.source)
    return out
}

/** Point entities [{class, kind, name, at, yaw?, raw}] (metres): control points, flag spawns, pickups, sounds, lights/sun, and every
 *  other entity of the mesh companion that has an origin (spawns are listed separately). `k` scales the tier manifest's source units. */
export function readPoints(j, comp, k) {
    const out = []
    const add = (cls, kind, name, at, yaw, raw) => { if (at) out.push({ class: cls, kind: slug(kind), name: String(name ?? ''), at, ...(yaw != null && Number.isFinite(Number(yaw)) ? { yaw: Number(yaw) } : {}), raw }) }
    const mk = comp?.json && comp.json !== j ? [[j, k], [comp.json, 1]] : [[j, j.format ? 1 : k]]
    for (const [m, kk] of mk) {
        for (const e of m.control_points ?? []) add('control_point', e.owner || 'neutral', e.name ?? `Control Point ${e.index ?? ''}`, vec(e.origin, kk), e.yaw, rawOf(e, ['origin']))
        for (const e of m.flag_spawns ?? []) add('flag_spawn', e.team || 'flag', `${e.team ?? ''} flag`, vec(e.origin, kk), e.yaw, rawOf(e, ['origin']))
        for (const e of m.pickups ?? []) add('pickup', e.classname || 'pickup', e.props?.targetname || e.classname, vec(e.origin, 1), e.angle, rawOf(e, ['origin']))
        for (const e of m.sounds?.ambient ?? []) add('sound', 'ambient', e.targetname || e.stand_in || 'ambient', vec(e.at, 1), null, rawOf(e, ['at']))
        for (const e of m.sounds?.soundscapes ?? []) add('sound', 'soundscape', e.targetname || e.soundscape, vec(e.at, 1), null, rawOf(e, ['at']))
        for (const z of m.zones ?? []) if (!z?.min && Array.isArray(z?.destination)) add('zone_point', z.kind || 'zone', `${z.kind ?? 'zone'} destination`, vec(z.destination, kk), z.destination_yaw, rawOf(z, ['destination']))
    }
    const env = comp?.json?.environment ?? j.environment
    if (env?.env_sun) add('light', 'env_sun', 'env_sun', null, null, rawOf(env.env_sun))
    let n = 0
    for (const e of comp?.json?.entities ?? (Array.isArray(j.entities) ? j.entities : [])) {
        if (!e?.classname || classGroup(e.classname) === 'spawn') continue
        const at = vec(e.origin, 1)
        if (!at || n++ > 3000) continue
        add(classGroup(e.classname) === 'pickup' ? 'pickup' : 'entity', e.classname, e.targetname || e.classname, at, null, { classname: e.classname, treatment: e.treatment, rule: e.rule, ...rawOf(e.keys ?? {}), ...(e.model ? { model: e.model } : {}) })
    }
    return out
}
