// ASSETS: converted-map manifests to GLB. A map converter writes `<name>.json` (manifest) + `<name>.bin` (geometry); this turns
// one into a single GLB the Assets 3D viewer can fly through: world surfaces chunked into a spatial grid (so three.js can cull
// them), one material per surface material (colour + texture file when one exists beside the manifest), and optional overlay
// meshes named by group: `world_*` (the map), `collision_<kind>` (convex hulls), `trigger_<kind>` (zone boxes), `entity_spawns`
// (markers). The scene `extras` carry { map: { spawns, bounds, stats } } for the viewer. Pure Node, no dependencies.
//
// Two manifest layouts are read, told apart by their content (nothing about any game or path is built in):
//   mesh   `format: "dot-bsp-mesh"`: per-surface position/normal/uv/index offsets in metres (gzip bin allowed), hulls with points.
//   tier   a `surfaces[]` list with vertex_offset/index_offset (10 floats per vertex: pos, normal, uv, uv2) in source units,
//          `collision.hull_offset` convex hulls (u32 count + xyz), `spawn`/`spawns`, `zones`; `units` names the metre scale.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'

export const DEFAULT_METRES_PER_UNIT = 0.01905

/** 'mesh' | 'tier' | '' for a parsed manifest. */
export function manifestLayout(j) {
    if (!j || typeof j !== 'object' || !Array.isArray(j.surfaces)) return ''
    if (j.format === 'dot-bsp-mesh') return 'mesh'
    if (j.surfaces.length && j.surfaces[0].vertex_offset != null) return 'tier'
    if (j.surfaces.length === 0 && j.collision?.hull_offset != null) return 'tier'
    return ''
}

const findImage = (dir, material) => {
    const base = String(material ?? '').replace(/\\/g, '/')
    if (!base || base.includes('..')) return null
    for (const rel of [base, path.basename(base)]) for (const root of [path.join(dir, 'textures'), dir]) for (const ext of ['.png', '.jpg', '.jpeg']) {
        const f = path.join(root, rel + ext)
        if (existsSync(f)) return f
    }
    return null
}
const mimeOfFile = (f) => (/\.png$/i.test(f) ? 'image/png' : 'image/jpeg')
const f32 = (blob, o, c) => new Float32Array(blob.buffer.slice(blob.byteOffset + o, blob.byteOffset + o + c * 4))

/** Surfaces of a manifest: { material, colour, translucent, skip, pos (metres), nor, uv, idx, texture }. */
function readSurfaces(j, blob, layout, k, dir) {
    const out = []
    for (const s of j.surfaces) {
        const n = s.vertex_count | 0, ic = s.index_count | 0
        if (n <= 0 || ic <= 0) continue
        let pos, nor, uv
        if (layout === 'mesh') {
            if (s.position_offset == null || s.index_offset + ic * 4 > blob.length) continue
            pos = f32(blob, s.position_offset, n * 3); nor = f32(blob, s.normal_offset, n * 3)
            uv = s.uv_offset != null ? f32(blob, s.uv_offset, n * 2) : new Float32Array(n * 2)
        } else {
            if (s.vertex_offset + n * 40 > blob.length || s.index_offset + ic * 4 > blob.length) continue
            const raw = f32(blob, s.vertex_offset, n * 10)
            pos = new Float32Array(n * 3); nor = new Float32Array(n * 3); uv = new Float32Array(n * 2)
            for (let v = 0; v < n; v++) {
                for (let c = 0; c < 3; c++) { pos[v * 3 + c] = raw[v * 10 + c]; nor[v * 3 + c] = raw[v * 10 + 3 + c] }
                uv[v * 2] = raw[v * 10 + 6]; uv[v * 2 + 1] = raw[v * 10 + 7]
            }
        }
        const idx = new Uint32Array(blob.buffer.slice(blob.byteOffset + s.index_offset, blob.byteOffset + s.index_offset + ic * 4))
        if (k !== 1) for (let i = 0; i < pos.length; i++) pos[i] *= k
        const tex = findImage(dir, typeof s.texture === 'string' && s.texture ? s.texture : s.material)
        out.push({ material: s.material ?? '', colour: s.colour ?? s.tint ?? null, translucent: !!(s.translucent || s.material_flags?.includes?.('translucent')), skip: !!(s.sky3d || s.decal), pos, nor, uv, idx, texture: tex })
    }
    return out
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm = (a) => { const l = Math.hypot(...a) || 1; return a.map((x) => x / l) }

/** Triangles (flat xyz) of a convex point set. `planes` ([nx,ny,nz,d], n.p = d) are used when given, else faces are
 *  found from point triples (sets over 24 points without planes are skipped). */
export function hullTriangles(points, planes) {
    const P = points
    if (P.length < 4) return []
    const faces = []
    if (planes?.length) for (const q of planes) faces.push({ n: [q[0], q[1], q[2]], d: q[3] })
    else {
        if (P.length > 24) return []
        const seen = new Set()
        for (let a = 0; a < P.length; a++) for (let b = a + 1; b < P.length; b++) for (let c = b + 1; c < P.length; c++) {
            const cr = cross(sub(P[b], P[a]), sub(P[c], P[a]))
            if (Math.hypot(...cr) < 1e-9) continue
            let n = norm(cr), d = dot(n, P[a])
            let pos = 0, neg = 0
            for (const p of P) { const e = dot(n, p) - d; if (e > 1e-4) pos++; else if (e < -1e-4) neg++ }
            if (pos && neg) continue
            if (pos) { n = n.map((x) => -x); d = -d }
            const key = [...n, d].map((x) => Math.round(x * 1e3)).join(',')
            if (!seen.has(key)) { seen.add(key); faces.push({ n, d }) }
        }
    }
    const tris = []
    const cen = [0, 1, 2].map((k) => P.reduce((s, p) => s + p[k], 0) / P.length)
    for (const { n, d } of faces) {
        let face = P.filter((p) => Math.abs(dot(n, p) - d) < 1e-3)
        if (face.length < 3) continue
        const c = [0, 1, 2].map((k) => face.reduce((s, p) => s + p[k], 0) / face.length)
        const e1 = norm(cross(Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], n)), e2 = cross(n, e1)
        face = face.map((p) => ({ p, a: Math.atan2(dot(sub(p, c), e2), dot(sub(p, c), e1)) })).sort((x, y) => x.a - y.a).map((x) => x.p)
        const out = dot(n, sub(c, cen)) >= 0
        for (let i = 1; i + 1 < face.length; i++) for (const p of out ? [face[0], face[i], face[i + 1]] : [face[0], face[i + 1], face[i]]) tris.push(p[0], p[1], p[2])
    }
    return tris
}

/** Triangles (flat xyz) of an axis-aligned box. */
export function boxTriangles(min, max) {
    const [x0, y0, z0] = min, [x1, y1, z1] = max
    const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]
    const t = []
    for (const q of [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [0, 4, 7, 3]]) for (const i of [q[0], q[1], q[2], q[0], q[2], q[3]]) t.push(...v[i])
    return t
}

const asVec = (a, k) => (Array.isArray(a) && a.length >= 3 && a.slice(0, 3).every(Number.isFinite) ? a.slice(0, 3).map((x) => x * k) : null)
/** Spawn points [{x,y,z,yaw,team}] in metres from `spawn` / `spawns` (list or { team: list }); entries use `origin` (source units) or `at` (metres). */
export function readSpawns(j, k) {
    const out = []
    const take = (e, team) => {
        if (!e || typeof e !== 'object') return
        const p = e.at ? asVec(e.at, 1) : asVec(e.origin, k)
        if (p) out.push({ x: p[0], y: p[1], z: p[2], yaw: Number(e.yaw ?? 0), team })
    }
    if (j.spawn) take(j.spawn, '')
    const s = j.spawns
    if (Array.isArray(s)) for (const e of s) take(e, e?.team ?? '')
    else if (s && typeof s === 'object') for (const [team, list] of Object.entries(s)) if (Array.isArray(list)) for (const e of list) take(e, team)
    return out
}
/** Trigger boxes [{kind,min,max}] in metres from `zones` / `volumes` / `respawn_volumes` (min+max in source units, or at+size in metres). */
export function readTriggers(j, k) {
    const out = []
    for (const [key, list] of [['zones', j.zones], ['volumes', j.volumes], ['respawn_volumes', j.respawn_volumes]]) {
        if (!Array.isArray(list)) continue
        for (const z of list) {
            let mn = asVec(z?.min, k), mx = asVec(z?.max, k)
            if (!mn && z?.at && z?.size) { const at = asVec(z.at, 1), sz = asVec(z.size, 1); if (at && sz) { mn = at.map((v, i) => v - sz[i] / 2); mx = at.map((v, i) => v + sz[i] / 2) } }
            if (mn && mx) out.push({ kind: String(z.kind ?? key).toLowerCase().replace(/[^a-z0-9]+/g, '_'), min: mn.map((v, i) => Math.min(v, mx[i])), max: mn.map((v, i) => Math.max(v, mx[i])) })
        }
    }
    return out
}

/** Hulls [{kind, points (metres), planes?}]. */
function readHulls(j, blob, layout, k) {
    const out = []
    if (layout === 'mesh') {
        for (const h of j.hulls ?? []) {
            if (h.point_offset == null || h.point_offset + h.point_count * 12 > blob.length) continue
            const f = f32(blob, h.point_offset, h.point_count * 3)
            const points = []
            for (let i = 0; i < h.point_count; i++) points.push([f[i * 3], f[i * 3 + 1], f[i * 3 + 2]])
            const planes = []
            if (h.plane_offset != null && h.plane_offset + h.plane_count * 16 <= blob.length) {
                const pf = f32(blob, h.plane_offset, h.plane_count * 4)
                for (let i = 0; i < h.plane_count; i++) planes.push([pf[i * 4], pf[i * 4 + 1], pf[i * 4 + 2], pf[i * 4 + 3]])
            }
            out.push({ kind: h.kind || 'solid', points, planes })
        }
        return out
    }
    const c = j.collision
    if (!c || c.hull_offset == null) return out
    const kindOf = new Map()
    for (const [kind, list] of Object.entries(c.hull_kinds ?? {})) if (Array.isArray(list)) for (const i of list) kindOf.set(i, kind)
    let off = c.hull_offset
    for (let h = 0; h < (c.hull_count | 0) && off + 4 <= blob.length; h++) {
        const n = blob.readUInt32LE(off); off += 4
        if (off + n * 12 > blob.length) break
        const f = f32(blob, off, n * 3); off += n * 12
        const points = []
        for (let i = 0; i < n; i++) points.push([f[i * 3] * k, f[i * 3 + 1] * k, f[i * 3 + 2] * k])
        out.push({ kind: kindOf.get(h) || 'solid', points })
    }
    return out
}

function bounds(p) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < p.length; i += 3) for (let c = 0; c < 3; c++) { if (p[i + c] < min[c]) min[c] = p[i + c]; if (p[i + c] > max[c]) max[c] = p[i + c] }
    return { min, max }
}

class Glb {
    constructor() { this.json = { asset: { version: '2.0', generator: 'nightly map-glb' }, scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], materials: [], accessors: [], bufferViews: [], buffers: [{ byteLength: 0 }], images: [], textures: [] }; this.chunks = []; this.len = 0 }
    view(buf, target) {
        const pad = (4 - (this.len % 4)) % 4
        if (pad) { this.chunks.push(Buffer.alloc(pad)); this.len += pad }
        this.json.bufferViews.push({ buffer: 0, byteOffset: this.len, byteLength: buf.length, ...(target ? { target } : {}) })
        this.chunks.push(buf); this.len += buf.length
        return this.json.bufferViews.length - 1
    }
    accessor(typed, type, componentType, target, minmax) {
        const bv = this.view(Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength), target)
        this.json.accessors.push({ bufferView: bv, componentType, count: typed.length / { SCALAR: 1, VEC2: 2, VEC3: 3 }[type], type, ...(minmax ?? {}) })
        return this.json.accessors.length - 1
    }
    material(m) { this.json.materials.push(m); return this.json.materials.length - 1 }
    image(file) {
        const bv = this.view(readFileSync(file))
        this.json.images.push({ bufferView: bv, mimeType: mimeOfFile(file) })
        this.json.textures.push({ source: this.json.images.length - 1 })
        return this.json.textures.length - 1
    }
    mesh(name, positions, normals, uvs, indices, material) {
        const attributes = { POSITION: this.accessor(positions, 'VEC3', 5126, 34962, bounds(positions)) }
        if (normals) attributes.NORMAL = this.accessor(normals, 'VEC3', 5126, 34962)
        if (uvs) attributes.TEXCOORD_0 = this.accessor(uvs, 'VEC2', 5126, 34962)
        const prim = { attributes, material }
        if (indices) prim.indices = this.accessor(indices, 'SCALAR', 5125, 34963)
        this.json.meshes.push({ name, primitives: [prim] })
        this.json.nodes.push({ name, mesh: this.json.meshes.length - 1 })
        this.json.scenes[0].nodes.push(this.json.nodes.length - 1)
    }
    build() {
        const bin = Buffer.concat([...this.chunks, Buffer.alloc((4 - (this.len % 4)) % 4)])
        this.json.buffers[0].byteLength = bin.length
        let js = Buffer.from(JSON.stringify(this.json))
        js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)])
        const head = Buffer.alloc(12)
        head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8)
        const ch = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b }
        return Buffer.concat([head, ch(js.length, 0x4e4f534a), js, ch(bin.length, 0x004e4942), bin])
    }
}

/** Split one surface into grid chunks (cell edge `chunk` metres; 0 = one chunk): [{pos,nor,uv,idx}] with compact vertices. */
export function chunkSurface(s, chunk) {
    const cells = new Map()
    for (let t = 0; t < s.idx.length / 3; t++) {
        let key = '0'
        if (chunk > 0) {
            const a = s.idx[t * 3], b = s.idx[t * 3 + 1], c = s.idx[t * 3 + 2]
            key = [0, 1, 2].map((i) => Math.floor((s.pos[a * 3 + i] + s.pos[b * 3 + i] + s.pos[c * 3 + i]) / 3 / chunk)).join(',')
        }
        const l = cells.get(key)
        if (l) l.push(t); else cells.set(key, [t])
    }
    const out = []
    for (const list of cells.values()) {
        const remap = new Map()
        const pos = [], nor = [], uv = [], idx = []
        for (const t of list) for (let c = 0; c < 3; c++) {
            const v = s.idx[t * 3 + c]
            let n = remap.get(v)
            if (n === undefined) { n = remap.size; remap.set(v, n); pos.push(s.pos[v * 3], s.pos[v * 3 + 1], s.pos[v * 3 + 2]); nor.push(s.nor[v * 3], s.nor[v * 3 + 1], s.nor[v * 3 + 2]); uv.push(s.uv[v * 2], s.uv[v * 2 + 1]) }
            idx.push(n)
        }
        out.push({ pos: new Float32Array(pos), nor: new Float32Array(nor), uv: new Float32Array(uv), idx: new Uint32Array(idx) })
    }
    return out
}

const COLOURS = { clip: [0.9, 0.3, 0.3], glass: [0.4, 0.8, 1], sky: [0.5, 0.5, 1], solid: [0.9, 0.7, 0.2], spawns: [0.2, 1, 0.4], trigger: [0.8, 0.3, 1] }
const push = (m, key, arr) => { const l = m.get(key); if (l) for (const x of arr) l.push(x); else m.set(key, [...arr]) }

/** Convert one manifest. opts: { chunk: metres (default 32), overlays: bool (default true), metresPerUnit }. Returns null when the file is not a
 *  map manifest, else { glb (Buffer|null), layout, stats, findings }. stats = { tris, surfaces, materials, textured, untextured, untexturedTris,
 *  missingTextures: [names], spawns, hulls, triggers, chunks, bounds }. */
export function mapToGlb(manifestFile, opts = {}) {
    const dir = path.dirname(manifestFile)
    let j
    try { j = JSON.parse(readFileSync(manifestFile, 'utf8')) } catch { return null }
    const layout = manifestLayout(j)
    if (!layout) return null
    const binName = j.bin?.file ?? path.basename(manifestFile).replace(/\.json$/i, '.bin')
    const binFile = path.join(dir, binName)
    if (!existsSync(binFile)) return { glb: null, layout, stats: null, findings: [{ code: 'MAP_NO_BIN', severity: 'error', msg: `geometry file ${binName} is missing` }] }
    let blob = readFileSync(binFile)
    if (blob[0] === 0x1f && blob[1] === 0x8b) blob = gunzipSync(blob)
    const unit = Number(/\*\s*([0-9.]+)/.exec(String(j.units ?? ''))?.[1])
    const k = layout === 'mesh' ? 1 : (opts.metresPerUnit ?? (unit > 0 ? unit : DEFAULT_METRES_PER_UNIT))
    const chunk = opts.chunk ?? 32
    const surfaces = readSurfaces(j, blob, layout, k, dir)
    const g = new Glb()
    const matIds = new Map()
    const matFor = (s) => {
        const key = `${s.material}|${s.translucent}`
        let id = matIds.get(key)
        if (id === undefined) {
            const pbr = { baseColorFactor: [...(s.colour?.slice(0, 3) ?? [0.7, 0.7, 0.7]), 1], metallicFactor: 0, roughnessFactor: 1 }
            const m = { name: s.material || 'material', doubleSided: true, pbrMetallicRoughness: pbr }
            if (s.texture) { pbr.baseColorTexture = { index: g.image(s.texture) }; pbr.baseColorFactor = [1, 1, 1, 1] }
            if (s.translucent) m.alphaMode = 'BLEND'
            id = g.material(m); matIds.set(key, id)
        }
        return id
    }
    const st = { tris: 0, surfaces: 0, materials: 0, textured: 0, untextured: 0, untexturedTris: 0, missingTextures: [], spawns: 0, hulls: 0, triggers: 0, chunks: 0, bounds: null }
    const missing = new Set(), mats = new Set()
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
    let world = 0
    for (const s of surfaces) {
        if (s.skip) continue
        const tris = s.idx.length / 3
        st.surfaces++; st.tris += tris; mats.add(s.material)
        if (s.texture) st.textured++; else { st.untextured++; st.untexturedTris += tris; missing.add(s.material) }
        const mat = matFor(s)
        for (const c of chunkSurface(s, chunk)) { g.mesh(`world_${world++}_${(s.material || 'm').replace(/[^\w-]+/g, '_').slice(0, 40)}`, c.pos, c.nor, c.uv, c.idx, mat); st.chunks++ }
        const b = bounds(s.pos)
        for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], b.min[i]); hi[i] = Math.max(hi[i], b.max[i]) }
    }
    st.materials = mats.size
    st.missingTextures = [...missing].sort()
    st.bounds = lo[0] === Infinity ? null : { min: lo.map((v) => +v.toFixed(3)), max: hi.map((v) => +v.toFixed(3)) }
    const spawns = readSpawns(j, k), triggers = readTriggers(j, k), hulls = readHulls(j, blob, layout, k)
    st.spawns = spawns.length; st.triggers = triggers.length; st.hulls = hulls.length
    if (opts.overlays !== false) {
        const overlay = (name, c, a) => g.material({ name, doubleSided: true, alphaMode: 'BLEND', pbrMetallicRoughness: { baseColorFactor: [...c, a], metallicFactor: 0, roughnessFactor: 1 } })
        const byKind = new Map()
        for (const h of hulls) push(byKind, h.kind, hullTriangles(h.points, h.planes))
        for (const [kind, t] of byKind) if (t.length) g.mesh(`collision_${kind}`, new Float32Array(t), null, null, null, overlay(`collision_${kind}`, COLOURS[kind] ?? COLOURS.solid, 0.35))
        const tk = new Map()
        for (const z of triggers) push(tk, z.kind, boxTriangles(z.min, z.max))
        for (const [kind, t] of tk) g.mesh(`trigger_${kind}`, new Float32Array(t), null, null, null, overlay(`trigger_${kind}`, COLOURS.trigger, 0.3))
        if (spawns.length) {
            const t = []
            for (const p of spawns) t.push(...boxTriangles([p.x - 0.3, p.y, p.z - 0.3], [p.x + 0.3, p.y + 1.8, p.z + 0.3]))
            g.mesh('entity_spawns', new Float32Array(t), null, null, null, overlay('entity_spawns', COLOURS.spawns, 0.8))
        }
    }
    g.json.scenes[0].extras = { map: { layout, spawns: spawns.slice(0, 256), bounds: st.bounds, stats: { ...st, missingTextures: st.missingTextures.length } } }
    return { glb: g.build(), layout, stats: st, findings: mapFindings(st) }
}

/** Findings from conversion stats: [{code, severity, msg}]. Budget keys: max_untextured_pct, require_spawns, require_collision. */
export function mapFindings(st, B = {}) {
    const F = [], add = (code, severity, msg) => F.push({ code, severity, msg })
    if (!st?.tris) { if (st?.hulls) add('MAP_HULLS_ONLY', 'warn', 'only collision hulls were converted, no drawn surfaces'); else add('MAP_NO_GEOMETRY', 'error', 'the map has no drawn triangles'); return F }
    const pct = (st.untexturedTris / st.tris) * 100
    if (B.max_untextured_pct != null && pct > B.max_untextured_pct) add('MAP_UNTEXTURED', 'warn', `${pct.toFixed(0)}% of triangles (${st.untextured} surfaces) have no texture file: ${st.missingTextures.slice(0, 6).join(', ')}${st.missingTextures.length > 6 ? ', ...' : ''}`)
    if (B.require_spawns && !st.spawns) add('MAP_NO_SPAWNS', 'error', 'the map lists no spawn points')
    if (B.require_collision && !st.hulls) add('MAP_NO_COLLISION', 'warn', 'the map has no collision hulls')
    return F
}
