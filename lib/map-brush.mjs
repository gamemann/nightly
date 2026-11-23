// MAP CONVERTER, pure geometry: Source .vmf and Quake .map brushes, plane-to-polytope maths, scene readers (OBJ, glTF), the GameSpice
// mesh-manifest writer, and the VMF / Quake .map writers. No disk, no database: lib/map-convert.test.mjs covers it.
//
// Axes: Source and Quake are Z-up; a GameSpice map is Y-up in metres. A source point (sx,sy,sz) is the metre point (sx*k, sz*k, -sy*k)
// (a rotation, so winding is kept). k is metres per unit: 0.01905 for Source, 1/32 for Quake.

export const SOURCE_K = 0.01905
export const QUAKE_K = 1 / 32
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const len = (a) => Math.hypot(a[0], a[1], a[2])
const unit = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l] }
export const toMetres = (p, k) => [p[0] * k, p[2] * k, -p[1] * k]
export const toSource = (p, k) => [p[0] / k, -p[2] / k, p[1] / k]

// ---------------------------------------------------------------------------------------------------------------- text parsing

/** Tokens of a Valve keyvalues file: quoted strings, `{`, `}`. Comments (// ...) are skipped. */
function kvTokens(text) {
    const t = []
    const re = /\/\/[^\n]*|"([^"]*)"|([{}])|([^\s{}"]+)/g
    let m
    while ((m = re.exec(text))) { if (m[0].startsWith('//')) continue; t.push(m[1] ?? m[2] ?? m[3]) }
    return t
}
/** The tree of a keyvalues file: { name, props: {k: v}, kids: [node] }. A block is `name {`; a pair is `"k" "v"`. */
export function parseKv(text) {
    const tok = kvTokens(text)
    let i = 0
    const block = (name) => {
        const n = { name, props: {}, kids: [] }
        while (i < tok.length && tok[i] !== '}') {
            const a = tok[i++]
            if (tok[i] === '{') { i++; n.kids.push(block(a)) } else n.props[a] = tok[i++]
        }
        i++   // the closing brace
        return n
    }
    const root = { name: '', props: {}, kids: [] }
    while (i < tok.length) { const a = tok[i++]; if (tok[i] === '{') { i++; root.kids.push(block(a)) } else i++ }
    return root
}
const triple = (s) => String(s ?? '').replace(/[()[\]]/g, ' ').trim().split(/\s+/).slice(0, 3).map(Number)

/** Brushes and point entities of a .vmf: { brushes: [{ planes: [{ pts: [p0,p1,p2], material }], entity }], entities: [{ classname, origin, angles, props }] } (source units). */
export function parseVmf(text) {
    const root = parseKv(text)
    const brushes = [], entities = []
    const takeSolids = (node, entity) => {
        for (const s of node.kids.filter((x) => x.name === 'solid')) {
            const planes = s.kids.filter((x) => x.name === 'side').map((sd) => ({
                pts: String(sd.props.plane ?? '').match(/\(([^)]*)\)/g)?.map(triple) ?? [], material: sd.props.material ?? '',
            })).filter((p) => p.pts.length === 3 && p.pts.every((q) => q.length === 3 && q.every(Number.isFinite)))
            if (planes.length >= 4) brushes.push({ planes, entity })
        }
    }
    for (const w of root.kids.filter((x) => x.name === 'world')) takeSolids(w, 'worldspawn')
    for (const e of root.kids.filter((x) => x.name === 'entity')) {
        takeSolids(e, e.props.classname ?? '')
        if (e.props.origin) entities.push({ classname: e.props.classname ?? '', origin: triple(e.props.origin), angles: triple(e.props.angles ?? '0 0 0'), props: e.props })
    }
    if (!root.kids.some((x) => x.name === 'world' || x.name === 'entity')) throw new Error('not a VMF: no world or entity block')
    return { brushes, entities }
}

/** Brushes and point entities of a Quake .map (standard and Valve 220 face lines). */
export function parseQuakeMap(text) {
    const brushes = [], entities = []
    let depth = 0, props = {}, cur = null
    const flush = () => { if (props.classname && props.origin) entities.push({ classname: props.classname, origin: triple(props.origin), angles: triple(props.angles ?? `0 ${props.angle ?? 0} 0`), props }) }
    const face = /^\s*\(\s*(\S+)\s+(\S+)\s+(\S+)\s*\)\s*\(\s*(\S+)\s+(\S+)\s+(\S+)\s*\)\s*\(\s*(\S+)\s+(\S+)\s+(\S+)\s*\)\s*(\S+)/
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/\/\/.*$/, '').trim()
        if (!line) continue
        if (line === '{') { depth++; if (depth === 2) cur = { planes: [], entity: props.classname ?? '' }; else if (depth === 1) props = {}; continue }
        if (line === '}') {
            if (depth === 2 && cur) { if (cur.planes.length >= 4) brushes.push(cur); cur = null }
            if (depth === 1) flush()
            depth--; continue
        }
        const m = face.exec(line)
        if (m && depth === 2 && cur) {
            const n = m.slice(1, 10).map(Number)
            if (n.every(Number.isFinite)) cur.planes.push({ pts: [n.slice(0, 3), n.slice(3, 6), n.slice(6, 9)], material: m[10] })
        } else if (depth === 1) { const kv = /^"([^"]*)"\s+"([^"]*)"/.exec(line); if (kv) props[kv[1]] = kv[2] }
    }
    if (!brushes.length && !entities.length) throw new Error('not a Quake .map: no brushes or entities')
    return { brushes, entities }
}

// ---------------------------------------------------------------------------------------------------------------- polytopes

/** Outward plane { n, d } (n.p = d) of three points listed clockwise seen from outside (the Source and Quake convention). */
export function planeOf(p0, p1, p2) {
    const n = unit(cross(sub(p2, p0), sub(p1, p0)))
    return { n, d: dot(n, p0) }
}

/** Vertices and faces of the convex region n.p <= d. Returns { points, faces: [{ n, d, material, loop: [point index] }] } or null when empty. */
export function polytope(planes, eps = 1e-3) {
    const P = []
    for (let a = 0; a < planes.length; a++) for (let b = a + 1; b < planes.length; b++) for (let c = b + 1; c < planes.length; c++) {
        const A = planes[a], B = planes[b], C = planes[c]
        const bc = cross(B.n, C.n), det = dot(A.n, bc)
        if (Math.abs(det) < 1e-9) continue
        const ca = cross(C.n, A.n), ab = cross(A.n, B.n)
        const p = [0, 1, 2].map((i) => (A.d * bc[i] + B.d * ca[i] + C.d * ab[i]) / det)
        if (!p.every(Number.isFinite)) continue
        if (planes.some((q) => dot(q.n, p) > q.d + eps * Math.max(1, Math.abs(q.d) * 1e-3))) continue
        if (!P.some((q) => len(sub(p, q)) < eps)) P.push(p)
    }
    if (P.length < 4) return null
    const faces = []
    for (const pl of planes) {
        const idx = P.map((p, i) => [p, i]).filter(([p]) => Math.abs(dot(pl.n, p) - pl.d) < eps * 5).map(([, i]) => i)
        if (idx.length < 3) continue
        const c = [0, 1, 2].map((k) => idx.reduce((s, i) => s + P[i][k], 0) / idx.length)
        const e1 = unit(cross(Math.abs(pl.n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], pl.n)), e2 = cross(pl.n, e1)
        const loop = idx.map((i) => ({ i, a: Math.atan2(dot(sub(P[i], c), e2), dot(sub(P[i], c), e1)) })).sort((x, y) => x.a - y.a).map((x) => x.i)
        faces.push({ n: pl.n, d: pl.d, material: pl.material, loop })
    }
    return faces.length >= 4 ? { points: P, faces } : null
}

/** A brush's polytope in metres (Y-up). Tries the plane normals as given, then flipped (some editors wind the other way). */
export function brushPolytope(brush, k) {
    const mk = (flip) => brush.planes.map((p) => {
        const q = p.pts.map((x) => toMetres(x, k))
        const pl = flip ? planeOf(q[0], q[2], q[1]) : planeOf(q[0], q[1], q[2])
        return { ...pl, material: p.material }
    })
    return polytope(mk(false)) ?? polytope(mk(true))
}

// ---------------------------------------------------------------------------------------------------------------- the GameSpice mesh manifest

const f32 = (arr) => { const t = new Float32Array(arr); return Buffer.from(t.buffer, t.byteOffset, t.byteLength) }
const u32 = (arr) => { const t = new Uint32Array(arr); return Buffer.from(t.buffer, t.byteOffset, t.byteLength) }
const planarUv = (p, n) => {
    const a = [Math.abs(n[0]), Math.abs(n[1]), Math.abs(n[2])]
    return a[1] >= a[0] && a[1] >= a[2] ? [p[0], p[2]] : a[0] >= a[2] ? [p[2], p[1]] : [p[0], p[1]]
}

/** Build a gs-bsp-mesh manifest + blob. `polys`: [{ material, n: [x,y,z], loop: [[x,y,z]...] }] (metres, outward winding); `hulls`: [{ points, planes: [[nx,ny,nz,d]] }]
 *  (collision); `spawns`: [{ at, yaw, team, classname }]; `extra`: manifest keys (name, source, ...). */
export function buildMesh({ polys, hulls = [], spawns = [], extra = {} }) {
    const groups = new Map()
    for (const p of polys) {
        if (p.loop.length < 3) continue
        const g = groups.get(p.material) ?? groups.set(p.material, { pos: [], nor: [], uv: [], idx: [] }).get(p.material)
        const base = g.pos.length / 3
        for (const v of p.loop) { g.pos.push(...v); g.nor.push(...p.n); g.uv.push(...planarUv(v, p.n)) }
        for (let i = 1; i + 1 < p.loop.length; i++) g.idx.push(base, base + i, base + i + 1)
    }
    const parts = [], surfaces = []
    let off = 0
    const put = (buf) => { parts.push(buf); const o = off; off += buf.length; return o }
    for (const [material, g] of groups) {
        const position_offset = put(f32(g.pos)), normal_offset = put(f32(g.nor)), uv_offset = put(f32(g.uv)), index_offset = put(u32(g.idx))
        surfaces.push({ material, translucent: /glass|water/i.test(material), vertex_count: g.pos.length / 3, index_count: g.idx.length, position_offset, normal_offset, uv_offset, index_offset })
    }
    const hullRows = hulls.map((h, i) => {
        const point_offset = put(f32(h.points.flat())), plane_offset = put(f32(h.planes.flat()))
        return { brush: i, kind: 'solid', model: 0, entity: null, point_count: h.points.length, point_offset, plane_count: h.planes.length, plane_offset }
    })
    const json = { ...extra, format: 'gs-bsp-mesh', version: 2, units: { metres_per_unit: 1 }, surfaces, hulls: hullRows, spawns, counts: { surfaces: surfaces.length, hulls: hullRows.length, spawns: spawns.length } }
    return { json, blob: Buffer.concat(parts) }
}

const teamOf = (c) => (/terrorist$/.test(c) && !/counter/.test(c) ? 'red' : /counter|ct$|team2|blue/i.test(c) ? 'blue' : /team1|red/i.test(c) ? 'red' : '')
const yawOf = (angles) => (Number.isFinite(angles?.[1]) ? angles[1] : 0)

/** Brushes (+ entities) in source units to a GameSpice mesh manifest + blob. Returns { json, blob, stats }. */
export function brushesToMesh(parsed, { k = SOURCE_K, name = 'map', source = '' } = {}) {
    const polys = [], hulls = []
    let skipped = 0
    for (const b of parsed.brushes) {
        const pt = brushPolytope(b, k)
        if (!pt) { skipped++; continue }
        const solid = !/^(trigger_|func_(?:areaportal|occluder|detail_blocker))/.test(b.entity ?? '')
        if (solid) hulls.push({ points: pt.points, planes: pt.faces.map((f) => [...f.n, f.d]) })
        for (const f of pt.faces) {
            if (/^(tools\/|toolsnodraw|toolsskip|toolshint|toolsclip|toolsplayerclip|toolstrigger|skip|clip|hint|trigger|common\/)/i.test(f.material) || !solid) continue
            polys.push({ material: String(f.material || 'unknown').toLowerCase(), n: f.n, loop: f.loop.map((i) => pt.points[i]) })
        }
    }
    const spawns = parsed.entities.filter((e) => /^info_player|^info_t|_spawn$/.test(e.classname)).map((e) => ({ at: toMetres(e.origin, k).map((v) => +v.toFixed(3)), yaw: yawOf(e.angles), team: teamOf(e.classname), classname: e.classname }))
    const m = buildMesh({ polys, hulls, spawns, extra: { name, source: source ? { file: source } : undefined, notes: skipped ? [`${skipped} degenerate brushes skipped`] : [] } })
    return { ...m, stats: { brushes: parsed.brushes.length, skipped, polygons: polys.length, hulls: hulls.length, spawns: spawns.length, materials: new Set(polys.map((p) => p.material)).size } }
}

// ---------------------------------------------------------------------------------------------------------------- scenes (OBJ, glTF)

/** Triangulated polygons of a Wavefront OBJ. Y-up metres are taken as is (`scale` multiplies). */
export function parseObj(text, scale = 1) {
    const v = [], vn = [], polys = []
    let mat = 'obj'
    for (const raw of text.split(/\r?\n/)) {
        const l = raw.trim()
        if (l.startsWith('v ')) v.push(l.slice(2).trim().split(/\s+/).slice(0, 3).map((x) => Number(x) * scale))
        else if (l.startsWith('vn ')) vn.push(l.slice(3).trim().split(/\s+/).map(Number))
        else if (l.startsWith('usemtl ')) mat = l.slice(7).trim() || 'obj'
        else if (l.startsWith('f ')) {
            const ids = l.slice(2).trim().split(/\s+/).map((t) => { const [a, , c] = t.split('/'); const i = Number(a); return { i: i < 0 ? v.length + i : i - 1, n: c ? Number(c) : 0 } })
            if (ids.length < 3 || ids.some((x) => !(x.i >= 0 && x.i < v.length))) continue
            const loop = ids.map((x) => v[x.i])
            const n = unit(cross(sub(loop[1], loop[0]), sub(loop[2], loop[0])))
            polys.push({ material: mat, n, loop })
        }
    }
    if (!polys.length) throw new Error('OBJ has no faces')
    return polys
}

const COMP = { 5120: [Int8Array, 1], 5121: [Uint8Array, 1], 5122: [Int16Array, 2], 5123: [Uint16Array, 2], 5125: [Uint32Array, 4], 5126: [Float32Array, 4] }
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }
const matMul = (a, b) => { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let i = 0; i < 4; i++) o[c * 4 + r] += a[i * 4 + r] * b[c * 4 + i]; return o }
const trs = (n) => {
    if (n.matrix) return n.matrix
    const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1], [sx, sy, sz] = n.scale ?? [1, 1, 1], [tx, ty, tz] = n.translation ?? [0, 0, 0]
    return [(1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0, 2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0, 2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0, tx, ty, tz, 1]
}
const xf = (m, p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]]

/** Triangulated polygons of a glb (binary glTF) with node transforms applied. */
export function parseGlb(buf) {
    if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a glb (missing glTF header)')
    let off = 12, json = null, bin = null
    while (off + 8 <= buf.length) {
        const n = buf.readUInt32LE(off), t = buf.readUInt32LE(off + 4)
        const body = buf.subarray(off + 8, off + 8 + n)
        if (t === 0x4e4f534a) json = JSON.parse(body.toString('utf8')); else if (t === 0x004e4942 && !bin) bin = body
        off += 8 + n + ((4 - (n % 4)) % 4)
    }
    if (!json) throw new Error('glb has no JSON chunk')
    const read = (ai) => {
        const a = json.accessors[ai], bv = json.bufferViews[a.bufferView], [T, sz] = COMP[a.componentType], nc = NCOMP[a.type]
        if (!bin) throw new Error('glb has no BIN chunk')
        const stride = bv.byteStride && bv.byteStride !== sz * nc ? bv.byteStride : 0
        const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0), out = []
        for (let i = 0; i < a.count; i++) {
            const row = []
            for (let c = 0; c < nc; c++) { const o = base + (stride || sz * nc) * i + c * sz; row.push(T === Float32Array ? bin.readFloatLE(o) : sz === 4 ? bin.readUInt32LE(o) : sz === 2 ? (T === Int16Array ? bin.readInt16LE(o) : bin.readUInt16LE(o)) : (T === Int8Array ? bin.readInt8(o) : bin.readUInt8(o))) }
            out.push(nc === 1 ? row[0] : row)
        }
        return out
    }
    const polys = []
    const walk = (ni, parent) => {
        const n = json.nodes[ni], m = matMul(parent, trs(n))
        if (n.mesh != null) for (const prim of json.meshes[n.mesh].primitives ?? []) {
            if ((prim.mode ?? 4) !== 4 || prim.attributes?.POSITION == null) continue
            const pos = read(prim.attributes.POSITION).map((p) => xf(m, p))
            const idx = prim.indices != null ? read(prim.indices) : pos.map((_, i) => i)
            const material = json.materials?.[prim.material]?.name ?? 'glb'
            for (let i = 0; i + 2 < idx.length; i += 3) {
                const loop = [pos[idx[i]], pos[idx[i + 1]], pos[idx[i + 2]]]
                polys.push({ material, n: unit(cross(sub(loop[1], loop[0]), sub(loop[2], loop[0]))), loop })
            }
        }
        for (const c of n.children ?? []) walk(c, m)
    }
    const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    const sc = json.scenes?.[json.scene ?? 0]
    for (const r of sc?.nodes ?? json.nodes.map((_, i) => i)) walk(r, I)
    if (!polys.length) throw new Error('glb has no triangle meshes')
    return polys
}

/** A scene (polygons in metres, Y-up) as a map: the geometry as is, a spawn above the middle of the bounds, one box hull around it all. */
export function sceneToMesh(polys, { name = 'scene', source = '' } = {}) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
    for (const p of polys) for (const v of p.loop) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], v[i]); hi[i] = Math.max(hi[i], v[i]) }
    const mid = [(lo[0] + hi[0]) / 2, hi[1] + 1.8, (lo[2] + hi[2]) / 2]
    const m = buildMesh({ polys, spawns: [{ at: mid.map((v) => +v.toFixed(3)), yaw: 0, team: '', classname: 'info_player_start' }], extra: { name, source: source ? { file: source } : undefined, notes: ['converted from a scene: no collision hulls; the spawn is placed above the bounds'] } })
    return { ...m, stats: { polygons: polys.length, materials: new Set(polys.map((p) => p.material)).size, bounds: [lo, hi], hulls: 0, spawns: 1 } }
}

// ---------------------------------------------------------------------------------------------------------------- writers

/** Three well spread points of a face (metres), clockwise seen from outside, in source units: the plane line of a .vmf side. */
function cwTriple(on, n, k) {
    const c = [0, 1, 2].map((q) => on.reduce((s, p) => s + p[q], 0) / on.length)
    const e1 = unit(cross(Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], n)), e2 = cross(n, e1)
    const ring = on.map((p) => ({ p, a: Math.atan2(dot(sub(p, c), e2), dot(sub(p, c), e1)) })).sort((x, y) => x.a - y.a).map((x) => x.p)   // counter-clockwise seen from outside
    const s = ring.length, pick = [ring[0], ring[Math.floor(s / 3)], ring[Math.floor((2 * s) / 3)]]
    return [pick[0], pick[2], pick[1]].map((p) => toSource(p, k))
}
/** Brushes from a hand-built `boxes` definition ({ at: centre, size, turn: degrees about Y, material }), in the shape meshBrushes returns. */
export function boxBrushes(boxes, k = SOURCE_K) {
    const out = []
    for (const b of boxes ?? []) {
        const at = b?.at, sz = b?.size
        if (!Array.isArray(at) || !Array.isArray(sz) || ![...at.slice(0, 3), ...sz.slice(0, 3)].every(Number.isFinite)) continue
        const a = (Number(b.turn) || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a)
        const corner = (x, y, z) => [at[0] + (x * sz[0] / 2) * c + (z * sz[2] / 2) * s, at[1] + y * sz[1] / 2, at[2] - (x * sz[0] / 2) * s + (z * sz[2] / 2) * c]
        const faces = []
        for (const [ax, sg] of [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]]) {
            const on = []
            for (const u of [-1, 1]) for (const v of [-1, 1]) { const q = [0, 0, 0]; q[ax] = sg; q[(ax + 1) % 3] = u; q[(ax + 2) % 3] = v; on.push(corner(...q)) }
            const n0 = [0, 0, 0]; n0[ax] = sg
            const n = [n0[0] * c + n0[2] * s, n0[1], -n0[0] * s + n0[2] * c]
            faces.push({ pts: cwTriple(on, n, k), material: String(b.material ?? b.mat ?? 'box') })
        }
        out.push({ faces })
    }
    return out
}
/** Convex hulls of a gs-bsp-mesh manifest as brushes in source units: [{ faces: [{ pts: [p0,p1,p2], material }] }]. Reads the points and planes from the blob. */
export function meshBrushes(j, blob, k = SOURCE_K) {
    const brushes = []
    const rd = (o, n) => { const a = []; for (let i = 0; i < n; i++) a.push(blob.readFloatLE(o + i * 4)); return a }
    for (const h of j.hulls ?? []) {
        if (h.kind && h.kind !== 'solid') continue
        if (h.point_offset == null || h.plane_offset == null || h.point_offset + h.point_count * 12 > blob.length || h.plane_offset + h.plane_count * 16 > blob.length) continue
        const P = [], f = rd(h.point_offset, h.point_count * 3)
        for (let i = 0; i < h.point_count; i++) P.push([f[i * 3], f[i * 3 + 1], f[i * 3 + 2]])
        const pf = rd(h.plane_offset, h.plane_count * 4)
        const faces = []
        for (let i = 0; i < h.plane_count; i++) {
            const n = [pf[i * 4], pf[i * 4 + 1], pf[i * 4 + 2]], d = pf[i * 4 + 3]
            const on = P.filter((p) => Math.abs(dot(n, p) - d) < 2e-3)
            if (on.length < 3) continue
            const cw = cwTriple(on, n, k)
            faces.push({ pts: cw, material: h.material ?? 'dev/dev_measuregeneric01' })
        }
        if (faces.length >= 4) brushes.push({ faces })
    }
    return brushes
}
const r3 = (v) => v.map((x) => +x.toFixed(3)).join(' ')
/** A .vmf with the brushes as world solids and the spawns as info_player entities. */
export function brushesToVmf(brushes, spawns = [], k = SOURCE_K) {
    let id = 1
    const L = ['versioninfo', '{', '\t"editorversion" "400"', '\t"formatversion" "100"', '\t"prefab" "0"', '}', 'world', '{', '\t"id" "1"', '\t"mapversion" "1"', '\t"classname" "worldspawn"', '\t"skyname" "sky_day01_01"']
    id = 2
    for (const b of brushes) {
        L.push('\tsolid', '\t{', `\t\t"id" "${id++}"`)
        for (const f of b.faces) L.push('\t\tside', '\t\t{', `\t\t\t"id" "${id++}"`, `\t\t\t"plane" "${f.pts.map((p) => `(${r3(p)})`).join(' ')}"`, `\t\t\t"material" "${String(f.material).toUpperCase()}"`,
            '\t\t\t"uaxis" "[1 0 0 0] 0.25"', '\t\t\t"vaxis" "[0 -1 0 0] 0.25"', '\t\t\t"rotation" "0"', '\t\t\t"lightmapscale" "16"', '\t\t\t"smoothing_groups" "0"', '\t\t}')
        L.push('\t}')
    }
    L.push('}')
    for (const s of spawns) {
        const o = toSource(s.at, k)
        L.push('entity', '{', `\t"id" "${id++}"`, `\t"classname" "${s.classname || 'info_player_start'}"`, `\t"origin" "${r3(o)}"`, `\t"angles" "0 ${s.yaw ?? 0} 0"`, '}')
    }
    return L.join('\n') + '\n'
}
/** A Quake .map (standard texture format) with the brushes in worldspawn and the spawns as info_player_* entities. */
export function brushesToQuakeMap(brushes, spawns = [], k = QUAKE_K) {
    const L = ['// converted from a GameSpice map', '{', '"classname" "worldspawn"']
    for (const b of brushes) {
        L.push('{')
        for (const f of b.faces) {
            const pts = f.pts.map((p) => toSource(toMetres(p, SOURCE_K), k))   // source units -> metres -> quake units
            L.push(pts.map((p) => `( ${r3(p)} )`).join(' ') + ` ${String(f.material).replace(/\s+/g, '_')} 0 0 0 1 1`)
        }
        L.push('}')
    }
    L.push('}')
    for (const s of spawns) L.push('{', `"classname" "${s.classname || 'info_player_start'}"`, `"origin" "${r3(toSource(s.at, k))}"`, `"angle" "${s.yaw ?? 0}"`, '}')
    return L.join('\n') + '\n'
}
