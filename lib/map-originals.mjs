// The ORIGINAL (source BSP) of a converted map, for the Assets map viewer's original / converted / split views. Nothing here is
// host-specific: the roots to search and the converter command come from the map source's config (assets-sources.mjs):
//   mapOriginalRoots      directories (absolute, or relative to the source root) holding the source maps (.bsp, or archives of them)
//   mapOriginalMatch      file-name templates tried per map ({id} = the map id, {stem} = the manifest's file stem); default {id}.bsp, {id}.zip
//   mapOriginalConverter  argv template of a converter that writes a dot-bsp-mesh pair (<prefix>.json + <prefix>.bin); {input} is the found
//                         file, {out} the prefix. The shared reader is dot-map-convert's bsp.py: ["python3","-P","<path>/bsp.py","mesh",
//                         "{input}","--out","{out}","--allow-unknown"]. No reader is bundled here.
//   mapOriginalTimeoutSec converter time limit (default 300)
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { mapToGlb } from './map-glb.mjs'

export const ORIGINAL_MATCH = ['{id}.bsp', '{id}.zip']
const indexes = new Map()   // root -> Map(lowercase file name -> first path), built once per process
function indexOf(root) {
    if (indexes.has(root)) return indexes.get(root)
    const m = new Map()
    const rec = (d) => {
        let ents
        try { ents = readdirSync(d, { withFileTypes: true }) } catch { return }
        for (const e of ents) {
            if (e.isDirectory()) { if (!['.git', 'node_modules'].includes(e.name)) rec(path.join(d, e.name)) }
            else if (e.isFile() && !m.has(e.name.toLowerCase())) m.set(e.name.toLowerCase(), path.join(d, e.name))
        }
    }
    rec(root)
    indexes.set(root, m)
    return m
}
export const clearIndexes = () => indexes.clear()

/** The first source file for a map: roots in order, templates in order. Returns an absolute path or null. */
export function findOriginal(id, cfg, sourceRoot = '', stem = id) {
    const roots = (cfg.mapOriginalRoots ?? []).map((r) => path.resolve(sourceRoot || '.', r))
    const tpl = cfg.mapOriginalMatch?.length ? cfg.mapOriginalMatch : ORIGINAL_MATCH
    for (const r of roots) {
        const ix = indexOf(r)
        for (const t of tpl) { const f = ix.get(t.replace(/\{id\}/g, id).replace(/\{stem\}/g, stem).toLowerCase()); if (f) return f }
    }
    return null
}

/** { glb, stats, layout, input } for a map's original, or { error } / null (nothing configured or found). The converter output is cached
 *  under cacheDir by the input's size + mtime; the GLB is built by mapToGlb (colours only: an original carries no texture mapping). */
export function originalGlb(id, cfg, { sourceRoot = '', cacheDir, stem = id, run = execFileSync } = {}) {
    if (!cfg.mapOriginalRoots?.length || !cfg.mapOriginalConverter?.length) return null
    const input = findOriginal(id, cfg, sourceRoot, stem)
    if (!input) return null
    const st = statSync(input), key = `${id.replace(/[^\w.-]+/g, '_')}-${st.size}-${Math.floor(st.mtimeMs)}`
    const dir = path.join(cacheDir, 'map-original'), prefix = path.join(dir, key)
    mkdirSync(dir, { recursive: true })
    if (!existsSync(prefix + '.json')) {
        for (const f of readdirSync(dir)) if (f.startsWith(id.replace(/[^\w.-]+/g, '_') + '-')) rmSync(path.join(dir, f), { force: true })   // older copies of this map
        const argv = cfg.mapOriginalConverter.map((a) => a.replace(/\{input\}/g, input).replace(/\{out\}/g, prefix))
        try { run(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], timeout: (cfg.mapOriginalTimeoutSec || 300) * 1000, maxBuffer: 1 << 26 }) }
        catch (e) { return { error: `converter failed for ${path.basename(input)}: ${String(e.stderr || e.message).trim().split('\n').slice(-1)[0]}`, input } }
        if (!existsSync(prefix + '.json')) return { error: `converter wrote no ${path.basename(prefix)}.json`, input }
    }
    const r = mapToGlb(prefix + '.json', { chunk: cfg.mapChunk, sourceRoot: dir })
    if (!r?.glb) return { error: r?.findings?.[0]?.msg ?? 'original has no geometry', input }
    return { glb: r.glb, stats: r.stats, layout: r.layout, input }
}
