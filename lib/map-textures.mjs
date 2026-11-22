// Resolve a converted map's Valve-style materials and prop stand-ins to real files. A converter writes the mapping into the
// mesh manifest: surfaces[].free -> licence.textures[] (a pack fallback image, a PBR library set, or a generated image) and
// props[].stand_in -> licence.model_stand_ins[].store_file (a model under licence.model_store) or a loose <stand_in>.glb in a
// model root. Nothing about a pack or game is built in: roots come from the source config (see assets-sources.mjs).
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

/** A stable, saturated colour for a material name (never grey): [r,g,b] 0..1. */
export function hashColour(name) {
    const h = createHash('sha1').update(String(name)).digest()
    const hue = (h[0] * 256 + h[1]) / 65535 * 360, s = 0.5, l = 0.52
    const f = (n) => { const k = (n + hue / 30) % 12; return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)) }
    return [f(0), f(8), f(4)].map((x) => +x.toFixed(3))
}

const within = (root, rel) => { const f = path.resolve(root, rel); return f.startsWith(path.resolve(root) + path.sep) || f === path.resolve(root) ? f : null }
const isDir = (d) => { try { return readdirSync(d) && true } catch { return false } }
const IMG = ['.webp', '.jpg', '.jpeg', '.png']
const firstImage = (dir, stem) => { for (const e of IMG) { const f = path.join(dir, stem + e); if (existsSync(f)) return f } return null }

/** The mesh manifest of a tier manifest: first of `templates` ({dir}, {stem} placeholders) that parses as a mesh manifest. Each template is
 *  tried against the manifest's own folder, then every parent folder up to `sourceRoot` (a game keeps maps/<id>/<id>.json beside a
 *  top-level worlds/<id>/<id>.json, so a folder-relative lookup alone never finds it). Returns { file, json } or null. */
export function findCompanion(manifestFile, templates = [], sourceRoot = '') {
    const stem = path.basename(manifestFile).replace(/\.json$/i, ''), self = path.resolve(manifestFile)
    const root = sourceRoot ? path.resolve(sourceRoot) : ''
    const bases = []
    for (let d = path.dirname(self); ; d = path.dirname(d)) {
        bases.push(d)
        if (!root || d === root || path.dirname(d) === d || !d.startsWith(root + path.sep)) break
    }
    for (const dir of bases) for (const t of templates) {
        const f = path.resolve(dir, t.replace(/\{stem\}/g, stem).replace(/\{dir\}/g, '.'))
        if (f === self || !existsSync(f)) continue
        try { const j = JSON.parse(readFileSync(f, 'utf8')); if ((j?.format === 'dot-bsp-mesh' || j?.format === 'gs-bsp-mesh') && Array.isArray(j.surfaces)) return { file: f, json: j } } catch { /* not a manifest */ }
    }
    return null
}

/** Folders that may hold PBR sets: the licence's pbr_store (against the manifest's folder) plus configured roots. */
function pbrRoots(comp, opts) {
    const dir = path.dirname(comp.file), out = []
    const store = comp.json.licence?.pbr_store
    if (store) out.push(path.resolve(dir, store))
    for (const r of opts.pbrRoots ?? []) out.push(path.resolve(opts.sourceRoot ?? dir, r))
    return out.filter(isDir)
}
/** A set's image of one map kind (albedo|normal) at the tier closest to `max` pixels. */
function pbrImage(roots, id, kind, tier, max) {
    for (const r of roots) {
        const base = within(r, id); if (!base || !isDir(base)) continue
        const tiers = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
        const px = (n) => (/^(\d+)k$/i.exec(n) ? +/^(\d+)k$/i.exec(n)[1] * 1024 : Number(n) || 0)
        const order = tiers.sort((x, y) => (px(x) < max) - (px(y) < max) || Math.abs(px(x) - max) - Math.abs(px(y) - max))
        for (const t of order) { const f = firstImage(path.join(base, t), kind); if (f) return f }
        const f = firstImage(base, kind); if (f) return f
    }
    return null
}

/** material name -> { key, colour, albedo, normal } from the manifest's surfaces + licence.textures. Materials with no mapping are absent. */
export function materialIndex(comp, opts = {}) {
    const out = new Map(), j = comp.json, dir = path.dirname(comp.file)
    const byKey = new Map((j.licence?.textures ?? []).map((t) => [t.key, t]))
    const roots = pbrRoots(comp, opts), max = opts.texMax ?? 1024
    const cache = new Map()
    for (const s of j.surfaces ?? []) {
        if (!s.material || out.has(s.material) || !s.free) continue
        let r = cache.get(s.free)
        if (r === undefined) {
            const t = byKey.get(s.free)
            r = null
            if (t) {
                let albedo = null, normal = null
                const m = /^pbr\/(.+)$/.exec(t.file ?? '')
                if (m) { albedo = pbrImage(roots, m[1], 'albedo', t.tier, max); normal = albedo ? pbrImage(roots, m[1], 'normal', t.tier, max) : null }
                if (!albedo && t.fallback_file) albedo = within(dir, t.fallback_file)
                if (!albedo && t.file && /\.\w+$/.test(t.file)) albedo = within(dir, t.file)
                if (albedo && existsSync(albedo)) r = { key: s.free, colour: t.colour ?? null, albedo, normal: normal && existsSync(normal) ? normal : null }
            }
            cache.set(s.free, r)
        }
        if (r) out.set(s.material, r)
    }
    return out
}

/** The model file of one prop stand-in id, or null. Order: the licence's store_file under the model store / roots, then a loose
 *  <id>.glb|.gltf in the roots. */
export function modelFor(standIn, comp, opts = {}) {
    if (!standIn) return null
    const dir = path.dirname(comp.file), lic = comp.json.licence ?? {}
    const roots = [path.resolve(dir, lic.model_store ?? 'models'), ...(opts.modelRoots ?? []).map((r) => path.resolve(opts.sourceRoot ?? dir, r))]
    const entry = (lic.model_stand_ins ?? []).find((e) => e.stand_in === standIn)
    const rel = entry?.store_file ?? entry?.file
    if (rel) for (const r of roots) { const f = within(r, rel); if (f && existsSync(f)) return f }
    const base = standIn.replace(/^lib\//, '')
    for (const r of roots) for (const e of ['.glb', '.gltf']) { const f = within(r, standIn + e) ?? null; if (f && existsSync(f)) return f; const g = within(r, base + e); if (g && existsSync(g)) return g }
    return null
}

/** Box size [w,h,d] (metres) of a missing prop: bounds.box / collide.box, else a block of `size`, else a small default. */
export function proxyBox(p) {
    for (const src of [p.collide, p.bounds]) if (Array.isArray(src?.box) && src.box.length >= 3 && src.box.slice(0, 3).every((x) => x > 0.001)) return src.box.slice(0, 3).map(Number)
    const s = Number(p.size)
    return s > 0.05 ? [s, s / 2, s / 2] : [0.6, 1, 0.6]
}
