// A small GLB writer shared by the map converter: one binary buffer, accessors, shared materials/images/samplers, nodes with
// transforms. Pure Node.
export const bounds = (p) => {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < p.length; i += 3) for (let c = 0; c < 3; c++) { if (p[i + c] < min[c]) min[c] = p[i + c]; if (p[i + c] > max[c]) max[c] = p[i + c] }
    return { min, max }
}
const WIDTH = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }

export class Glb {
    constructor() {
        this.json = { asset: { version: '2.0', generator: 'nightly map-glb' }, scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], materials: [], accessors: [], bufferViews: [], buffers: [{ byteLength: 0 }], images: [], textures: [] }
        this.chunks = []; this.len = 0; this.imageCache = new Map(); this.sampler = -1
    }
    view(buf, target, byteStride) {
        const pad = (4 - (this.len % 4)) % 4
        if (pad) { this.chunks.push(Buffer.alloc(pad)); this.len += pad }
        this.json.bufferViews.push({ buffer: 0, byteOffset: this.len, byteLength: buf.length, ...(target ? { target } : {}), ...(byteStride ? { byteStride } : {}) })
        this.chunks.push(buf); this.len += buf.length
        return this.json.bufferViews.length - 1
    }
    accessor(typed, type, componentType, target, minmax) {
        const bv = this.view(Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength), target)
        this.json.accessors.push({ bufferView: bv, componentType, count: typed.length / WIDTH[type], type, ...(minmax ?? {}) })
        return this.json.accessors.length - 1
    }
    material(m) { this.json.materials.push(m); return this.json.materials.length - 1 }
    /** A texture for image bytes (deduplicated by `key`); a repeating, mip-mapped sampler is shared by all of them. */
    texture(key, bytes, mimeType) {
        let t = this.imageCache.get(key)
        if (t !== undefined) return t
        if (this.sampler < 0) { (this.json.samplers ??= []).push({ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }); this.sampler = 0 }
        this.json.images.push({ bufferView: this.view(bytes), mimeType })
        this.json.textures.push({ source: this.json.images.length - 1, sampler: this.sampler })
        t = this.json.textures.length - 1
        this.imageCache.set(key, t)
        return t
    }
    /** Add a node (optionally as a scene root) and return its index. */
    node(def, root = true) {
        this.json.nodes.push(def)
        const i = this.json.nodes.length - 1
        if (root) this.json.scenes[0].nodes.push(i)
        return i
    }
    mesh(name, positions, normals, uvs, indices, material, extras) {
        const attributes = { POSITION: this.accessor(positions, 'VEC3', 5126, 34962, bounds(positions)) }
        if (normals) attributes.NORMAL = this.accessor(normals, 'VEC3', 5126, 34962)
        if (uvs) attributes.TEXCOORD_0 = this.accessor(uvs, 'VEC2', 5126, 34962)
        const prim = { attributes, material }
        if (indices) prim.indices = this.accessor(indices, 'SCALAR', 5125, 34963)
        this.json.meshes.push({ name, primitives: [prim] })
        return this.node({ name, mesh: this.json.meshes.length - 1, ...(extras ? { extras } : {}) })
    }
    build() {
        const j = { ...this.json }
        for (const k of ['images', 'textures', 'materials', 'meshes']) if (!j[k].length) delete j[k]
        const bin = Buffer.concat([...this.chunks, Buffer.alloc((4 - (this.len % 4)) % 4)])
        j.buffers = [{ byteLength: bin.length }]
        let js = Buffer.from(JSON.stringify(j))
        js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)])
        const head = Buffer.alloc(12)
        head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8)
        const ch = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b }
        return Buffer.concat([head, ch(js.length, 0x4e4f534a), js, ch(bin.length, 0x004e4942), bin])
    }
}
