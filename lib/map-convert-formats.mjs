// MAP CONVERTER registry: format detection and a pluggable list of converters (from-format -> to-format). Pure; the converters
// themselves live in lib/map-convert.mjs and register here. Formats: bsp, vmf, quake-map, gs-map, glb, gltf, obj.

export const FORMATS = {
    bsp: { label: 'Source / Quake BSP (compiled)', ext: ['bsp'] },
    vmf: { label: 'Valve Map Format (VMF)', ext: ['vmf'] },
    'quake-map': { label: 'Quake .map', ext: ['map'] },
    'gs-map': { label: 'GameSpice map (mesh manifest + blob)', ext: ['json'] },
    glb: { label: 'glTF binary scene', ext: ['glb'] },
    gltf: { label: 'glTF scene', ext: ['gltf'] },
    obj: { label: 'Wavefront OBJ scene', ext: ['obj'] },
}

/** The format of an input by its first bytes and extension; '' when unknown. */
export function detectFormat(name, head) {
    const e = (/\.([A-Za-z0-9]+)$/.exec(String(name))?.[1] ?? '').toLowerCase()
    const buf = Buffer.isBuffer(head) ? head : Buffer.from(head ?? '')
    const s = buf.subarray(0, 4096).toString('latin1')
    if (buf.subarray(0, 4).toString('latin1') === 'glTF') return 'glb'
    if (['VBSP', 'rBSP', 'IBSP', 'BSP2'].includes(buf.subarray(0, 4).toString('latin1')) || (e === 'bsp' && buf.length >= 4)) return 'bsp'
    if (/^\s*(\/\/[^\n]*\n\s*)*versioninfo\b/i.test(s) || (e === 'vmf' && /\b(world|solid)\b/.test(s))) return 'vmf'
    if (e === 'json' || s.trimStart().startsWith('{') && /^\s*\{\s*"/.test(s)) {
        if (/"format"\s*:\s*"[^"]*bsp-mesh"|"boxes"\s*:\s*\[|"surfaces"\s*:\s*\[|"tiers"\s*:\s*\[/.test(s)) return 'gs-map'
        if (/"asset"\s*:\s*\{/.test(s) && e !== 'map') return e === 'json' || e === 'gltf' ? 'gltf' : ''
        return ''
    }
    if (e === 'obj' || /^\s*(#[^\n]*\n\s*)*(v|vn|vt|o|g|mtllib|usemtl)\s/.test(s)) return 'obj'
    if (e === 'map' || /^\s*(\/\/[^\n]*\n\s*)*\{\s*\n\s*"classname"/.test(s)) return 'quake-map'
    return ''
}

/** A converter registry. A converter: { id, from, to, label, run(ctx), available?() -> '' | reason, note? }.
 *  run(ctx) gets { input, outDir, name, log(line), progress(0..1), opts } and resolves { files: [{ path, label }], warnings?: [], report? }. */
export function makeRegistry() {
    const items = []
    const avail = (c) => { try { return c.available?.() || '' } catch (e) { return String(e.message ?? e) } }
    return {
        register(c) {
            if (!c?.id || !c.from || !c.to || typeof c.run !== 'function') throw new Error('a converter needs id, from, to and run')
            if (items.some((x) => x.id === c.id)) throw new Error(`converter "${c.id}" is already registered`)
            items.push(c)
            return c
        },
        get: (id) => items.find((c) => c.id === id),
        /** Every converter with its availability: '' = ready, otherwise the reason it cannot run here. */
        list: () => items.map((c) => ({ id: c.id, from: c.from, to: c.to, label: c.label ?? c.id, note: c.note ?? '', available: avail(c) })),
        /** Formats reachable from `from` through available converters. */
        targets(from) {
            const seen = new Set([from]), q = [from]
            while (q.length) { const f = q.shift(); for (const c of items) if (c.from === f && !seen.has(c.to) && !avail(c)) { seen.add(c.to); q.push(c.to) } }
            seen.delete(from)
            return [...seen]
        },
        /** The shortest chain of available converters from one format to another; [] when equal, null when there is no route. */
        plan(from, to) {
            if (from === to) return []
            const prev = new Map([[from, null]]), q = [from]
            while (q.length) {
                const f = q.shift()
                for (const c of items) {
                    if (c.from !== f || prev.has(c.to) || avail(c)) continue
                    prev.set(c.to, [f, c]); if (c.to === to) { const steps = []; for (let x = to; prev.get(x); x = prev.get(x)[0]) steps.unshift(prev.get(x)[1]); return steps }
                    q.push(c.to)
                }
            }
            return null
        },
    }
}

/** The shared registry; lib/map-convert.mjs fills it with the built-in converters. */
export const registry = makeRegistry()
export const register = (c) => registry.register(c)
export const planFor = (from, to) => registry.plan(from, to)
export const routes = () => registry.list()
