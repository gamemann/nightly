// Read a .glb/.gltf and copy its meshes into a Glb being built, once per model, so repeated props share geometry and
// textures (placements only add nodes). Images are routed through an ImageSet (downscaled). Pure Node.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const KEEP = ['POSITION', 'NORMAL', 'TANGENT', 'TEXCOORD_0', 'TEXCOORD_1', 'COLOR_0']
const SLOTS = [['pbrMetallicRoughness', 'baseColorTexture'], ['pbrMetallicRoughness', 'metallicRoughnessTexture'], [null, 'normalTexture'], [null, 'occlusionTexture'], [null, 'emissiveTexture']]

/** Parse a glTF file: { json, bufs, imgIds } or { error }. Every image is registered with `imgs`. */
export function loadGltf(file, imgs) {
    let buf
    try { buf = readFileSync(file) } catch (e) { return { error: `cannot read ${path.basename(file)}` } }
    let json, glbBin = null
    try {
        if (buf.readUInt32LE(0) === 0x46546c67) {
            let off = 12
            while (off + 8 <= buf.length) {
                const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4), body = buf.subarray(off + 8, off + 8 + len)
                if (type === 0x4e4f534a) json = JSON.parse(body.toString('utf8')); else if (type === 0x004e4942 && !glbBin) glbBin = body
                off += 8 + len + ((4 - (len % 4)) % 4)
            }
        } else json = JSON.parse(buf.toString('utf8'))
    } catch (e) { return { error: `unreadable glTF: ${e.message}` } }
    if (!json?.meshes?.length) return { error: 'no meshes' }
    const bad = (json.extensionsRequired ?? []).find((x) => /draco|meshopt|quantiz/i.test(x))
    if (bad) return { error: `requires ${bad}` }
    if (json.accessors?.some((a) => a.sparse)) return { error: 'sparse accessors' }
    const dir = path.dirname(file)
    const uri = (u) => (u.startsWith('data:') ? Buffer.from(u.slice(u.indexOf(',') + 1), u.includes(';base64') ? 'base64' : 'utf8') : (existsSync(path.join(dir, decodeURI(u))) ? readFileSync(path.join(dir, decodeURI(u))) : null))
    const bufs = (json.buffers ?? []).map((b, i) => (b.uri ? uri(b.uri) : (i === 0 ? glbBin : null)))
    if (bufs.some((b) => !b)) return { error: 'a buffer file is missing' }
    const imgIds = (json.images ?? []).map((im) => {
        try {
            if (im.bufferView != null) { const v = json.bufferViews[im.bufferView]; return imgs.wantBytes(bufs[v.buffer].subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength)) }
            if (im.uri) { if (im.uri.startsWith('data:')) return imgs.wantBytes(uri(im.uri)); return imgs.want(path.join(dir, decodeURI(im.uri))) }
        } catch { /* unreadable image: the material loses that slot */ }
        return null
    })
    return { json, bufs, imgIds }
}

const mul = (a, b) => { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o }
const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
/** Column-major 4x4 of translation / rotation (quaternion xyzw) / scale. */
export function trs(t = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1]) {
    const [x, y, z, w] = q
    const r = [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0, 2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0, 2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0]
    return [r[0] * s[0], r[1] * s[0], r[2] * s[0], 0, r[4] * s[1], r[5] * s[1], r[6] * s[1], 0, r[8] * s[2], r[9] * s[2], r[10] * s[2], 0, t[0], t[1], t[2], 1]
}
const local = (n) => n.matrix ?? trs(n.translation, n.rotation, n.scale)

/** Copy a loaded model's first scene into `g`. imgs must be processed. Returns { tpl, bounds } (tpl = node templates for place()). */
export function mergeInto(g, model, imgs) {
    const { json, bufs, imgIds } = model
    const bvMap = new Map(), accMap = new Map(), matMap = new Map(), meshMap = new Map()
    const bv = (i) => {
        if (!bvMap.has(i)) { const v = json.bufferViews[i], o = v.byteOffset ?? 0; bvMap.set(i, g.view(bufs[v.buffer].subarray(o, o + v.byteLength), v.target, v.byteStride)) }
        return bvMap.get(i)
    }
    const acc = (i) => {
        if (!accMap.has(i)) {
            const a = json.accessors[i]
            if (a.bufferView == null) throw new Error('accessor without data')
            const { sparse, ...rest } = a
            g.json.accessors.push({ ...rest, bufferView: bv(a.bufferView) }); accMap.set(i, g.json.accessors.length - 1)
        }
        return accMap.get(i)
    }
    const tex = (ti) => {
        const t = json.textures?.[ti]; if (!t) return null
        const id = imgIds[t.source]; const o = id && imgs.out.get(id)
        return o ? g.texture(`${id}|${imgs.usedMax}|${imgs.format}`, o.bytes, o.mime) : null
    }
    const mat = (i) => {
        if (i == null) return undefined
        if (!matMap.has(i)) {
            const m = JSON.parse(JSON.stringify(json.materials[i])); delete m.extensions
            for (const [grp, key] of SLOTS) {
                const holder = grp ? m[grp] : m, info = holder?.[key]
                if (!info) continue
                const t = tex(info.index)
                if (t == null) delete holder[key]; else { holder[key] = { index: t, ...(info.texCoord ? { texCoord: info.texCoord } : {}), ...(info.scale != null ? { scale: info.scale } : {}), ...(info.strength != null ? { strength: info.strength } : {}) } }
            }
            matMap.set(i, g.material(m))
        }
        return matMap.get(i)
    }
    const mesh = (i) => {
        if (!meshMap.has(i)) {
            const m = json.meshes[i]
            const prims = m.primitives.filter((p) => (p.mode ?? 4) === 4 && p.attributes?.POSITION != null).map((p) => {
                const attributes = {}
                for (const k of KEEP) if (p.attributes[k] != null) attributes[k] = acc(p.attributes[k])
                const mm = mat(p.material)
                return { attributes, ...(p.indices != null ? { indices: acc(p.indices) } : {}), ...(mm !== undefined ? { material: mm } : {}) }
            })
            g.json.meshes.push({ name: m.name, primitives: prims }); meshMap.set(i, g.json.meshes.length - 1)
        }
        return meshMap.get(i)
    }
    const tpl = (ni, depth = 0) => {
        const n = json.nodes[ni]
        if (depth > 32) return null
        const out = { name: n.name, ...(n.matrix ? { matrix: n.matrix } : { translation: n.translation, rotation: n.rotation, scale: n.scale }) }
        if (n.mesh != null) out.mesh = mesh(n.mesh)
        out.children = (n.children ?? []).map((c) => tpl(c, depth + 1)).filter(Boolean)
        return out
    }
    const roots = (json.scenes?.[json.scene ?? 0]?.nodes ?? json.nodes.map((_, i) => i).slice(0, 1)).map((r) => tpl(r))
    // bounds: the POSITION accessor boxes, corner by corner through the node matrices
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
    const walk = (n, M) => {
        const W = mul(M, local(n))
        if (n.mesh != null) for (const p of g.json.meshes[n.mesh].primitives) {
            const a = g.json.accessors[p.attributes.POSITION]; if (!a.min || !a.max) continue
            for (let c = 0; c < 8; c++) {
                const v = [c & 1 ? a.max[0] : a.min[0], c & 2 ? a.max[1] : a.min[1], c & 4 ? a.max[2] : a.min[2]]
                for (let k = 0; k < 3; k++) { const x = W[k] * v[0] + W[4 + k] * v[1] + W[8 + k] * v[2] + W[12 + k]; lo[k] = Math.min(lo[k], x); hi[k] = Math.max(hi[k], x) }
            }
        }
        for (const c of n.children) walk(c, W)
    }
    for (const r of roots) walk(r, IDENT)
    return { tpl: roots, bounds: lo[0] === Infinity ? null : { min: lo, max: hi } }
}

/** Create fresh nodes for a template (shared meshes); returns the top node indices. */
export function instantiate(g, tpl) {
    return tpl.map((n) => {
        const { children, ...rest } = n
        const kids = instantiate(g, children)
        return g.node({ ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)), ...(kids.length ? { children: kids } : {}) }, false)
    })
}
