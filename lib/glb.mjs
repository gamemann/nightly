// Minimal glTF/GLB reader for the ASSETS tab: triangle/vertex counts, bbox, materials, images (size, format, maps), animations.
// No dependencies; used by the CLI scan and by the panel's texture route.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export function readModel(file) {
    const buf = readFileSync(file)
    if (buf.readUInt32LE(0) === 0x46546c67) { // 'glTF'
        let off = 12, json = null, bin = null
        while (off + 8 <= buf.length) {
            const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4)
            const body = buf.subarray(off + 8, off + 8 + len)
            if (type === 0x4e4f534a) json = JSON.parse(body.toString('utf8'))
            else if (type === 0x004e4942 && !bin) bin = body
            off += 8 + len + ((4 - (len % 4)) % 4)
        }
        if (!json) throw new Error('glb without JSON chunk')
        return { json, bin, dir: path.dirname(file) }
    }
    const json = JSON.parse(buf.toString('utf8'))
    const b0 = json.buffers?.[0]?.uri
    const bin = b0 && !b0.startsWith('data:') && existsSync(path.join(path.dirname(file), decodeURI(b0))) ? readFileSync(path.join(path.dirname(file), decodeURI(b0))) : null
    return { json, bin, dir: path.dirname(file) }
}

const COMPS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 }

function matMul(a, b) { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o }
function nodeMat(n) {
    if (n.matrix) return n.matrix
    const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1], [sx, sy, sz] = n.scale ?? [1, 1, 1], [tx, ty, tz] = n.translation ?? [0, 0, 0]
    return [
        (1 - 2 * (y * y + z * z)) * sx, (2 * (x * y + z * w)) * sx, (2 * (x * z - y * w)) * sx, 0,
        (2 * (x * y - z * w)) * sy, (1 - 2 * (x * x + z * z)) * sy, (2 * (y * z + x * w)) * sy, 0,
        (2 * (x * z + y * w)) * sz, (2 * (y * z - x * w)) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
        tx, ty, tz, 1,
    ]
}

export function imageBytes(m, i) {
    const img = m.json.images?.[i]
    if (!img) return null
    if (img.bufferView != null) {
        const bv = m.json.bufferViews[img.bufferView]
        return m.bin ? m.bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength) : null
    }
    if (img.uri?.startsWith('data:')) return Buffer.from(img.uri.split(',')[1] ?? '', 'base64')
    if (img.uri) { const p = path.join(m.dir, decodeURI(img.uri)); return existsSync(p) ? readFileSync(p) : null }
    return null
}

/** { w, h, format } from the first bytes of a png / jpeg / webp; zeros when unknown. */
export function imageInfo(b) {
    if (!b || b.length < 24) return { w: 0, h: 0, format: 'unknown' }
    if (b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), format: 'png' }
    if (b[0] === 0xff && b[1] === 0xd8) {
        let o = 2
        while (o + 9 < b.length) {
            if (b[o] !== 0xff) { o++; continue }
            const mk = b[o + 1]
            if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) return { w: b.readUInt16BE(o + 7), h: b.readUInt16BE(o + 5), format: 'jpg' }
            o += 2 + b.readUInt16BE(o + 2)
        }
        return { w: 0, h: 0, format: 'jpg' }
    }
    if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
        const t = b.toString('ascii', 12, 16)
        if (t === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3), format: 'webp' }
        if (t === 'VP8L') { const v = b.readUInt32LE(21); return { w: 1 + (v & 0x3fff), h: 1 + ((v >> 14) & 0x3fff), format: 'webp' } }
        if (t === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff, format: 'webp' }
        return { w: 0, h: 0, format: 'webp' }
    }
    return { w: 0, h: 0, format: 'unknown' }
}
export const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }
export const mimeOf = (b) => MIME[imageInfo(b).format] ?? 'application/octet-stream'

export function stats(m) {
    const { json } = m
    const acc = (i) => json.accessors[i]
    let tris = 0, verts = 0
    for (const mesh of json.meshes ?? []) for (const p of mesh.primitives ?? []) {
        const pos = p.attributes?.POSITION
        if (pos == null) continue
        verts += acc(pos).count
        const n = p.indices != null ? acc(p.indices).count : acc(pos).count
        const mode = p.mode ?? 4
        tris += mode === 4 ? Math.floor(n / 3) : mode === 5 || mode === 6 ? Math.max(0, n - 2) : 0
    }
    // bbox: every mesh instance through its node matrix
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
    const visit = (ni, parent) => {
        const n = json.nodes[ni]
        const w = matMul(parent, nodeMat(n))
        if (n.mesh != null) for (const p of json.meshes[n.mesh].primitives ?? []) {
            const a = p.attributes?.POSITION != null ? acc(p.attributes.POSITION) : null
            if (!a?.min || !a?.max) continue
            for (let c = 0; c < 8; c++) {
                const v = [c & 1 ? a.max[0] : a.min[0], c & 2 ? a.max[1] : a.min[1], c & 4 ? a.max[2] : a.min[2]]
                for (let k = 0; k < 3; k++) { const t = w[k] * v[0] + w[4 + k] * v[1] + w[8 + k] * v[2] + w[12 + k]; if (t < min[k]) min[k] = t; if (t > max[k]) max[k] = t }
            }
        }
        for (const c of n.children ?? []) visit(c, w)
    }
    const ident = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    const scene = json.scenes?.[json.scene ?? 0]
    for (const r of scene?.nodes ?? []) visit(r, ident)
    const bbox = min[0] === Infinity ? [0, 0, 0] : [0, 1, 2].map((k) => +(max[k] - min[k]).toFixed(4))

    // textures and which maps each carries
    const imgMaps = new Map()
    const tag = (ti, name) => {
        if (ti == null) return
        const t = json.textures?.[ti]
        const src = t?.source ?? t?.extensions?.EXT_texture_webp?.source
        if (src == null) return
        const s = imgMaps.get(src) ?? new Set(); s.add(name); imgMaps.set(src, s)
    }
    for (const mat of json.materials ?? []) {
        const pbr = mat.pbrMetallicRoughness ?? {}
        tag(pbr.baseColorTexture?.index, 'albedo'); tag(mat.normalTexture?.index, 'normal'); tag(mat.emissiveTexture?.index, 'emissive')
        const mr = pbr.metallicRoughnessTexture?.index
        if (mr != null) { tag(mr, mat.occlusionTexture?.index === mr ? 'orm' : 'roughness'); if (mat.occlusionTexture?.index !== mr) tag(mr, 'metallic') }
        tag(mat.occlusionTexture?.index, 'ao')
    }
    const textures = (json.images ?? []).map((img, i) => {
        const b = imageBytes(m, i)
        const info = imageInfo(b)
        const pot = (n) => n > 0 && (n & (n - 1)) === 0
        return { name: img.name || (img.uri ? path.basename(decodeURI(img.uri)).replace(/\.[^.]+$/, '') : `image_${i}`), w: info.w, h: info.h, format: info.format, bytes: b?.length ?? 0, maps: [...(imgMaps.get(i) ?? [])], pot: pot(info.w) && pot(info.h), embedded: img.bufferView != null || !!img.uri?.startsWith('data:'), image_index: i }
    })
    const animations = (json.animations ?? []).map((a, i) => {
        let length = 0
        for (const s of a.samplers ?? []) { const mx = acc(s.input)?.max?.[0]; if (mx > length) length = mx }
        return { name: a.name || `anim_${i}`, length: +length.toFixed(3), tracks: (a.channels ?? []).length, flags: (a.channels ?? []).length ? [] : ['no_tracks'] }
    })
    return { tris, verts, materials: (json.materials ?? []).length, meshes: (json.meshes ?? []).length, bbox, textures, animations }
}
