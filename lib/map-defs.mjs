// ASSETS: map definitions that are not a converted-map manifest themselves. Two shapes are understood (nothing about any game is built in):
//   world pack   `world: { pack }`: the geometry is a `gs-bsp-mesh` manifest + bin in a pack folder beside the definition
//                (`world/<pack>/<stem>.json`, `<pack>/<stem>.json`, or the same under the source root's `worlds/`).
//   boxes        `boxes: [{ at (centre, metres), size, material|mat?, colour (hex)|tint ([r,g,b])?, turn? (degrees about Y) }]`: a hand-built map; the boxes become
//                a mesh manifest (one surface per material + colour) so the same GLB path draws it.
import { existsSync } from 'node:fs'
import path from 'node:path'

/** The manifest file of a definition's world pack, or null. */
export function worldPackManifest(defFile, j, sourceRoot = '') {
    const pack = j?.world?.pack
    if (typeof pack !== 'string' || !pack || /[\\/]|\.\./.test(pack)) return null
    const stem = path.basename(defFile).replace(/\.[^.]+$/, ''), dir = path.dirname(defFile)
    const bases = [dir, ...(sourceRoot ? [sourceRoot, path.join(sourceRoot, 'worlds'), path.join(sourceRoot, 'maps')] : [])]
    for (const b of bases) for (const rel of [`world/${pack}/${stem}.json`, `${pack}/${stem}.json`, `${pack}.json`]) {
        const f = path.join(b, rel)
        if (existsSync(f)) return f
    }
    return null
}

const hex = (c) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(c ?? ''))
    return m ? [0, 2, 4].map((i) => +(parseInt(m[1].slice(i, i + 2), 16) / 255).toFixed(3)) : null
}
const tint = (t) => Array.isArray(t) && t.length >= 3 && t.slice(0, 3).every(Number.isFinite) ? t.slice(0, 3).map((v) => +Math.min(1, Math.max(0, v)).toFixed(3)) : null
const FACES = [   // outward normal, then the four corners (counter-clockwise seen from outside) as sign triples
    [[1, 0, 0], [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]]], [[-1, 0, 0], [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]]],
    [[0, 1, 0], [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]]], [[0, -1, 0], [[-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]]],
    [[0, 0, 1], [[1, -1, 1], [1, 1, 1], [-1, 1, 1], [-1, -1, 1]]], [[0, 0, -1], [[-1, -1, -1], [-1, 1, -1], [1, 1, -1], [1, -1, -1]]],
]

/** A mesh manifest + blob of a definition's `boxes` (null when it has none). The manifest keeps the definition's keys (spawn, name, ...). */
export function boxesMesh(j) {
    if (!Array.isArray(j?.boxes) || !j.boxes.length) return null
    const groups = new Map()
    for (const b of j.boxes) {
        const at = b?.at, sz = b?.size
        if (!Array.isArray(at) || !Array.isArray(sz) || at.length < 3 || sz.length < 3 || ![...at.slice(0, 3), ...sz.slice(0, 3)].every(Number.isFinite)) continue
        const material = String(b.material ?? b.mat ?? 'box'), colour = hex(b.colour) ?? tint(b.tint)
        const key = `${material}|${colour ?? ''}`
        if (!groups.has(key)) groups.set(key, { material: colour ? `${material} #${colour.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}` : material, colour, translucent: material === 'glass' || material === 'water', pos: [], nor: [], uv: [], idx: [] })
        const g = groups.get(key), a = (Number(b.turn) || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a)
        for (const [n, corners] of FACES) {
            const base = g.pos.length / 3
            const nn = [n[0] * c + n[2] * s, n[1], -n[0] * s + n[2] * c]
            for (const q of corners) {
                const x = q[0] * sz[0] / 2, y = q[1] * sz[1] / 2, z = q[2] * sz[2] / 2
                g.pos.push(at[0] + x * c + z * s, at[1] + y, at[2] - x * s + z * c); g.nor.push(...nn); g.uv.push(0, 0)
            }
            g.idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
        }
    }
    const parts = [], surfaces = []
    let off = 0
    const put = (arr, Type) => { const t = new Type(arr), buf = Buffer.from(t.buffer, t.byteOffset, t.byteLength); parts.push(buf); const o = off; off += buf.length; return o }
    for (const g of groups.values()) {
        const position_offset = put(g.pos, Float32Array), normal_offset = put(g.nor, Float32Array), uv_offset = put(g.uv, Float32Array), index_offset = put(g.idx, Uint32Array)
        surfaces.push({ material: g.material, ...(g.colour ? { colour: g.colour } : {}), translucent: g.translucent, vertex_count: g.pos.length / 3, index_count: g.idx.length, position_offset, normal_offset, uv_offset, index_offset })
    }
    const { boxes, props, toys, wires, declared, ...rest } = j
    const spawn = Array.isArray(rest.spawn) ? { at: rest.spawn, yaw: Number(rest.spawn_yaw) || 0 } : rest.spawn
    return { json: { ...rest, spawn, format: 'gs-bsp-mesh', surfaces, boxes_count: boxes.length }, blob: Buffer.concat(parts) }
}
