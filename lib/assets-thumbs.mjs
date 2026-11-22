// Asset thumbnails: a 128x96 webp per asset, cached under <audit dir>/thumbs and regenerated when the file hash changes.
// Textures are downscaled with sharp; models (and animation rigs, shown in their bind pose) are flat-shaded by a small software
// rasterizer, so no GPU or browser is needed. Never runs inside a page load or a scan: `nightly assets thumbs` drives it.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { AUDIT_DIR, resolveFile, setExtraRoots } from './assets-files.mjs'
import { readModel } from './glb.mjs'

export const W = 128, H = 96
const SS = 2 // supersampling factor for the rasterizer
const MAX_TRIS = 150000
export const thumbDir = () => path.join(AUDIT_DIR(), 'thumbs')
export const thumbFile = (id, kind, hash) => path.join(thumbDir(), `${id}-${kind}-${hash.slice(0, 12)}.webp`)
export const sha1 = (b) => createHash('sha1').update(b).digest('hex')

const COMPS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }
const ARR = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array }
function readAccessor(m, i) {
    const a = m.json.accessors[i], bv = m.json.bufferViews?.[a.bufferView]
    if (!bv || !m.bin) return null
    const T = ARR[a.componentType], n = COMPS[a.type] ?? 1, es = T.BYTES_PER_ELEMENT
    const stride = bv.byteStride || n * es, base = m.bin.byteOffset + (bv.byteOffset ?? 0) + (a.byteOffset ?? 0)
    const out = new Float64Array(a.count * n)
    const dv = new DataView(m.bin.buffer)
    const get = { 5120: 'getInt8', 5121: 'getUint8', 5122: 'getInt16', 5123: 'getUint16', 5125: 'getUint32', 5126: 'getFloat32' }[a.componentType]
    for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) out[k * n + c] = es === 1 ? dv[get](base + k * stride + c) : dv[get](base + k * stride + c * es, true)
    return out
}
function mul(a, b) { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o }
function local(n) {
    if (n.matrix) return n.matrix
    const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1], [sx, sy, sz] = n.scale ?? [1, 1, 1], [tx, ty, tz] = n.translation ?? [0, 0, 0]
    return [(1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0, 2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0, 2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0, tx, ty, tz, 1]
}

/** World-space triangles of a model: a Float32Array of 9 numbers per triangle (null when nothing is drawable). */
export function modelTriangles(m) {
    const tris = []
    const ident = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    const visit = (ni, parent, depth) => {
        const n = m.json.nodes?.[ni]; if (!n || depth > 64) return
        const w = mul(parent, local(n))
        if (n.mesh != null) for (const p of m.json.meshes[n.mesh].primitives ?? []) {
            if ((p.mode ?? 4) !== 4 || p.attributes?.POSITION == null) continue
            const pos = readAccessor(m, p.attributes.POSITION); if (!pos) continue
            const idx = p.indices != null ? readAccessor(m, p.indices) : null
            const cnt = idx ? idx.length : pos.length / 3
            const vert = (v) => { const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2]; return [w[0] * x + w[4] * y + w[8] * z + w[12], w[1] * x + w[5] * y + w[9] * z + w[13], w[2] * x + w[6] * y + w[10] * z + w[14]] }
            for (let t = 0; t + 2 < cnt; t += 3) tris.push(...vert(idx ? idx[t] : t), ...vert(idx ? idx[t + 1] : t + 1), ...vert(idx ? idx[t + 2] : t + 2))
        }
        for (const c of n.children ?? []) visit(c, w, depth + 1)
    }
    for (const r of m.json.scenes?.[m.json.scene ?? 0]?.nodes ?? []) visit(r, ident, 0)
    if (!tris.length) return null
    const all = Float32Array.from(tris)
    const n = all.length / 9
    if (n <= MAX_TRIS) return all
    const step = Math.ceil(n / MAX_TRIS), o = []
    for (let t = 0; t < n; t += step) o.push(...all.subarray(t * 9, t * 9 + 9))
    return Float32Array.from(o)
}

/** Flat-shaded z-buffered render of triangles from a fixed three-quarter view; returns raw RGB of (W*SS)x(H*SS). */
export function rasterize(tris) {
    const w = W * SS, h = H * SS
    const rgb = Buffer.alloc(w * h * 3, 0)
    const zb = new Float32Array(w * h).fill(Infinity)
    // view: yaw 35 deg, pitch 20 deg (y up)
    const ya = 0.61, pa = 0.35, cy = Math.cos(ya), sy = Math.sin(ya), cp = Math.cos(pa), sp = Math.sin(pa)
    const rot = (x, y, z) => { const x1 = cy * x + sy * z, z1 = -sy * x + cy * z; return [x1, cp * y - sp * z1, sp * y + cp * z1] }
    const n = tris.length / 9, P = new Float32Array(tris.length)
    let mn = [Infinity, Infinity], mx = [-Infinity, -Infinity]
    for (let i = 0; i < tris.length; i += 3) {
        const [x, y, z] = rot(tris[i], tris[i + 1], tris[i + 2])
        P[i] = x; P[i + 1] = y; P[i + 2] = z
        if (x < mn[0]) mn[0] = x; if (x > mx[0]) mx[0] = x; if (y < mn[1]) mn[1] = y; if (y > mx[1]) mx[1] = y
    }
    const sc = 0.9 * Math.min(w / Math.max(mx[0] - mn[0], 1e-9), h / Math.max(mx[1] - mn[1], 1e-9))
    const ox = w / 2 - sc * (mx[0] + mn[0]) / 2, oy = h / 2 + sc * (mx[1] + mn[1]) / 2
    for (let t = 0; t < n; t++) {
        const o = t * 9
        const ax = P[o], ay = P[o + 1], az = P[o + 2], bx = P[o + 3], by = P[o + 4], bz = P[o + 5], cx = P[o + 6], cy2 = P[o + 7], cz = P[o + 8]
        const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy2 - ay, vz = cz - az
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
        const l = Math.hypot(nx, ny, nz); if (l === 0) continue
        nx /= l; ny /= l; nz /= l
        const lam = Math.abs(nx * -0.4 + ny * 0.7 + nz * 0.6) // two-sided, light from upper front-left
        const sh = Math.round(45 + 190 * Math.min(1, lam))
        const X = [ox + sc * ax, ox + sc * bx, ox + sc * cx], Y = [oy - sc * ay, oy - sc * by, oy - sc * cy2], Z = [az, bz, cz]
        const x0 = Math.max(0, Math.floor(Math.min(...X))), x1 = Math.min(w - 1, Math.ceil(Math.max(...X)))
        const y0 = Math.max(0, Math.floor(Math.min(...Y))), y1 = Math.min(h - 1, Math.ceil(Math.max(...Y)))
        const den = (Y[1] - Y[2]) * (X[0] - X[2]) + (X[2] - X[1]) * (Y[0] - Y[2]); if (den === 0) continue
        for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) {
            const qx = px + 0.5, qy = py + 0.5
            const l0 = ((Y[1] - Y[2]) * (qx - X[2]) + (X[2] - X[1]) * (qy - Y[2])) / den
            const l1 = ((Y[2] - Y[0]) * (qx - X[2]) + (X[0] - X[2]) * (qy - Y[2])) / den
            const l2 = 1 - l0 - l1
            if (l0 < 0 || l1 < 0 || l2 < 0) continue
            const z = l0 * Z[0] + l1 * Z[1] + l2 * Z[2], k = py * w + px
            if (z >= zb[k]) continue
            zb[k] = z; rgb[k * 3] = sh * 0.8; rgb[k * 3 + 1] = sh * 0.9; rgb[k * 3 + 2] = sh
        }
    }
    return { rgb, w, h }
}

/** Source file bytes the thumbnail is made from: the model for kind "model", the first texture for "tex". null when none. */
function sourceOf(data, kind) {
    if (kind === 'model') { const r = resolveFile(data, 'glb'); return r?.file ? { file: r.file, bytes: readFileSync(r.file) } : null }
    const r = resolveFile(data, 'tex', 0)
    return r ? { bytes: r.file ? readFileSync(r.file) : r.bytes } : null
}

/** Make (or reuse) the thumbnail of one row. Returns { status: 'made'|'fresh'|'none'|'error', hash }. */
export async function thumbFor(db, row, kinds = ['tex', 'model'], { force = false } = {}) {
    const sharp = (await import('sharp')).default
    const data = JSON.parse(row.data)
    let status = 'none', hash = ''
    for (const kind of kinds) {
        const k = kind === 'tex' ? 'tex' : 'model'
        try {
            const src = sourceOf(data, k); if (!src) continue
            hash = sha1(src.bytes)
            const dest = thumbFile(row.id, k, hash)
            if (existsSync(dest) && !force) { status = status === 'made' ? 'made' : 'fresh'; continue }
            mkdirSync(thumbDir(), { recursive: true })
            let img
            if (k === 'tex') img = sharp(src.bytes).resize(W, H, { fit: 'contain', background: { r: 20, g: 24, b: 31, alpha: 1 } })
            else {
                const tris = modelTriangles(readModel(src.file)); if (!tris) continue
                const { rgb, w, h } = rasterize(tris)
                img = sharp(rgb, { raw: { width: w, height: h, channels: 3 } }).resize(W, H, { fit: 'fill' })
            }
            writeFileSync(dest, await img.webp({ quality: 78 }).toBuffer())
            for (const f of readdirSync(thumbDir())) if (f.startsWith(`${row.id}-${k}-`) && f !== path.basename(dest)) rmSync(path.join(thumbDir(), f), { force: true })
            status = 'made'
        } catch { status = status === 'made' ? 'made' : 'error' }
    }
    if (hash && hash !== row.fileHash) db.prepare('UPDATE AssetWeapon SET fileHash=? WHERE id=?').run(hash, row.id)
    return { status, hash }
}

/** Generate thumbnails for every asset (or `ids`), a few at a time so the process stays responsive. */
export async function generate(db, { ids = null, force = false, limit = 0, onRow = null } = {}) {
    setExtraRoots(db.prepare('SELECT root FROM AssetSource').all().map((r) => r.root)) // only files under a source root, NIGHTLY_ASSET_ROOTS or the audit dir are read
    const rows = db.prepare('SELECT id, data, fileHash FROM AssetWeapon' + (ids ? ` WHERE id IN (${ids.map(() => '?').join(',')})` : '') + ' ORDER BY id').all(...(ids ?? []))
    const tally = { made: 0, fresh: 0, none: 0, error: 0 }
    for (const row of limit ? rows.slice(0, limit) : rows) {
        const r = await thumbFor(db, row, ['tex', 'model'], { force })
        tally[r.status]++
        onRow?.(row, r)
        await new Promise((res) => setImmediate(res))
    }
    return { total: rows.length, ...tally }
}
