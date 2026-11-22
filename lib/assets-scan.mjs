// ASSETS: the directory scan, driven entirely by the AssetSource and AssetKind rows (nothing about any pack or game is built in).
// Every model file of every enabled source becomes one record, classified into a kind; there is no de-duplication across sources
// (the same model in two sources is two rows). A game-local model that matches a pack model of the same kind is tagged as a copy.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { imageInfo, readModel, stats } from './glb.mjs'
import * as K from './assets-kinds.mjs'
import { globToRe, effective } from './assets-sources.mjs'
import { defInfo, eventGames, normId, soundMatches, withEvents } from './assets-events.mjs'
import { kindFlags, passes, scoreOf } from './assets-checks.mjs'
import { mapToGlb } from './map-glb.mjs'
import { AUDIT_DIR } from './assets-files.mjs'

export function probeAudio(file) {
    const r = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_entries', 'format=duration,size:stream=sample_rate,channels,codec_name', file], { encoding: 'utf8', timeout: 20000 })
    let j = {}
    try { j = JSON.parse(r.stdout || '{}') } catch { /* unknown */ }
    const s = j.streams?.[0] ?? {}
    return { len: +(+(j.format?.duration ?? 0)).toFixed(3), rate: +(s.sample_rate ?? 0), channels: s.channels ?? 0, codec: s.codec_name ?? '', bytes: +(j.format?.size ?? statSync(file).size) }
}
const stemOf = (f) => path.basename(f).replace(/\.[^.]+$/, '')
const emptyModel = () => ({ glb: '', viewer_glb: '', tris: 0, verts: 0, materials: 0, meshes: 0, bbox: [0, 0, 0], primitive_meshes: [], skins: 0, bones: 0, lods: 0 })
const soundRec = (a) => { const p = probeAudio(a); return { name: stemOf(a), len: p.len, rate: p.rate, bytes: p.bytes, channels: p.channels, codec: p.codec } }

/** Every file of a source tree (directory names in `exclude` are never entered): [{file, rel}]. */
export function walk(root, exclude, visit, rel = '') {
    let ents
    try { ents = readdirSync(path.join(root, rel), { withFileTypes: true }) } catch { return }
    for (const e of ents) {
        const r = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) { if (!exclude.includes(e.name)) walk(root, exclude, visit, r) } else if (e.isFile()) visit(path.join(root, r), r)
    }
}
const matcher = (globs) => { const re = globs.map(globToRe); return (rel) => re.some((r) => r.test(rel)) }
const pot = (n) => n > 0 && (n & (n - 1)) === 0
function guessMaps(name) {
    const n = name.toLowerCase()
    return n.includes('normal') ? ['normal'] : n.includes('rough') ? ['roughness'] : n.includes('metal') ? ['metallic'] : n.includes('orm') ? ['orm'] : n.includes('emis') ? ['emissive'] : n.includes('_ao') ? ['ao'] : ['albedo']
}

function modelRecord(pack, game, id, file, rel) {
    const m = readModel(file), st = stats(m), dir = path.dirname(file)
    const textures = st.textures.map((t) => ({ ...t, path: '' }))
    const files = { glb: file, textures: st.textures.map((t) => (t.embedded ? { kind: 'glb', index: t.image_index } : { kind: 'file', path: path.join(dir, decodeURI(m.json.images[t.image_index].uri)) })), sounds: [] }
    if (!textures.length) {   // external image files of the same stem (ammo_box_0.jpg beside ammo_box.glb) count when the glb carries none
        const stem = stemOf(file)
        for (const f of readdirSync(dir)) {
            if (!/\.(png|jpe?g|webp)$/i.test(f) || !f.startsWith(stem + '_')) continue
            const b = readFileSync(path.join(dir, f)), i = imageInfo(b)
            textures.push({ name: f.replace(/\.[^.]+$/, ''), w: i.w, h: i.h, format: i.format, bytes: b.length, maps: guessMaps(f), pot: pot(i.w) && pot(i.h), embedded: false })
            files.textures.push({ kind: 'file', path: path.join(dir, f) })
        }
    }
    const rec = {
        pack, game, weapon_id: id,
        model: { glb: rel, viewer_glb: '', tris: st.tris, verts: st.verts, materials: st.materials, meshes: st.meshes, bbox: st.bbox, primitive_meshes: [], skins: st.skins, bones: st.bones, lods: st.lods, bounds: st.bounds },
        textures: textures.map(({ image_index, ...t }) => t), animations: st.animations, sounds: [],
    }
    return { rec, files }
}

/** A converted-map manifest (matched by cfg.maps) becomes a GLB under the audit dir (viewer + stats) and one entry of kind cfg.mapKind. */
function mapEntry(src, game, id, file, rel, cfg, onLog) {
    const r = mapToGlb(file, { chunk: cfg.mapChunk })
    if (!r) return null
    if (!r.glb) { onLog(`map ${src.name}/${rel}: ${r.findings[0]?.msg}`); return null }
    const out = path.join(AUDIT_DIR(), 'map-glb', src.name.replace(/[^\w.-]+/g, '_'), `${id}.glb`)
    mkdirSync(path.dirname(out), { recursive: true })
    writeFileSync(out, r.glb)
    const { rec, files } = modelRecord(src.name, game, id, out, rel)
    rec.model.tris = r.stats.tris   // the overlay meshes (hulls, zones, spawns) are not drawn geometry
    rec.model.glb = rel
    rec.map = { layout: r.layout, ...r.stats, missingTextures: r.stats.missingTextures.slice(0, 40), missingTextureCount: r.stats.missingTextures.length }
    return { rec, files, kind: cfg.mapKind || 'map' }
}

/** Scan one source: model entries, definition entries, attached sounds. `known` = pack/id keys already taken. */
function scanSource(src, kinds, { onLog, covered }) {
    const cfg = effective(src.config)
    if (!existsSync(src.root)) { onLog(`skip ${src.name}: ${src.root} not found`); return { entries: [], audio: [] } }
    const isModel = matcher(cfg.models), isSound = matcher(cfg.sounds), isMap = matcher(cfg.maps ?? [])
    const game = src.type === 'game' ? src.name : ''
    const entries = [], audio = [], byId = new Set()
    walk(src.root, cfg.exclude, (file, rel) => {
        if (isSound(rel)) audio.push(file)
        if (isMap(rel) && !covered.has(`${src.name}|${rel}`)) {
            let id = stemOf(file)
            if (byId.has(id)) id = `${path.basename(path.dirname(file))}_${id}`
            try { const e = mapEntry(src, game, id, file, rel, cfg, onLog); if (e) { byId.add(id); entries.push(e) } } catch (e) { onLog(`unreadable map ${src.name}/${rel}: ${e.message}`) }
            return
        }
        if (!isModel(rel) || covered.has(`${src.name}|${rel}`)) return
        const kind = K.classify(rel, { kinds, rules: cfg.kindRules, defaultKind: cfg.defaultKind })
        let id = stemOf(file)
        if (byId.has(id)) id = `${path.basename(path.dirname(file))}_${id}`
        byId.add(id)
        try { const { rec, files } = modelRecord(src.name, game, id, file, rel); entries.push({ rec, files, kind }) } catch (e) { onLog(`unreadable ${src.name}/${rel}: ${e.message}`) }
    })
    for (const d of defInfo(src.root, cfg.weaponDefs)) addDef(entries, src.name, game, d.id, covered)
    return { entries, audio }
}
/** A definition file is the authoritative asset list of a source: bind it to its model entry, or list it without a model. */
function addDef(entries, pack, game, id, covered) {
    if (covered.has(`${pack}#${id}`) || entries.some((e) => e.rec.weapon_id === id)) return
    const m = entries.find((e) => !e.def && (e.rec.weapon_id.startsWith(id + '_') || id.startsWith(e.rec.weapon_id + '_')))
    if (m) { m.rec.def_id = id; return }
    entries.push({ rec: { pack, game, weapon_id: id, model: emptyModel(), textures: [], animations: [], sounds: [] }, files: { glb: '', textures: [], sounds: [] }, kind: 'weapon', def: true })
}

/** Attach sound files to the entries of their source (kinds in cfg.soundKinds); a pack's unmatched sounds become one pack-level entry. */
function attachSounds(src, entries, audio) {
    const cfg = effective(src.config), game = src.type === 'game' ? src.name : ''
    if (cfg.soundMatch === 'none') return
    const used = new Set(), mine = entries.filter((e) => cfg.soundKinds.includes(e.kind))
    for (const a of audio) {
        const dn = path.basename(path.dirname(a))
        const hit = cfg.soundMatch === 'all' ? mine : mine.filter((e) => soundMatches(stemOf(a), e.rec.weapon_id, dn) || (e.rec.def_id && soundMatches(stemOf(a), e.rec.def_id, dn)))
        if (!hit.length) continue
        const s = soundRec(a)
        for (const e of hit) { e.rec.sounds.push(s); e.files.sounds.push({ kind: 'file', path: a }) }
        used.add(a)
    }
    const rest = audio.filter((a) => !used.has(a))
    if (!rest.length || src.type !== 'pack') return
    entries.push({ rec: { pack: src.name, game, weapon_id: '_pack_sounds', model: emptyModel(), textures: [], animations: [], sounds: rest.map(soundRec) }, files: { glb: '', textures: [], sounds: rest.map((a) => ({ kind: 'file', path: a })) }, kind: 'pack' })
}

/** Tag game-local models that duplicate a pack model of the same kind (same id, or one that extends the other). */
export function packMatch(id, packEntries) {
    const n = normId(id)
    const exact = packEntries.find((e) => normId(e.rec.weapon_id) === n || (e.rec.def_id && normId(e.rec.def_id) === n))
    if (exact) return exact
    return packEntries.find((e) => { const w = normId(e.rec.def_id || e.rec.weapon_id); return w.length >= 4 && (n.startsWith(w + '_') || w.startsWith(n + '_')) }) ?? null
}
function compareLocal(all, types) {
    for (const e of all) {
        if (e.def || e.kind === 'pack' || types.get(e.rec.pack) !== 'game' || types.noCompare.has(e.rec.pack)) continue
        const hit = packMatch(e.rec.weapon_id, all.filter((p) => p.kind === e.kind && !p.def && types.get(p.rec.pack) === 'pack'))
        if (!hit) { e.localFlags = [{ code: 'GAME_ONLY', severity: 'info', msg: `no pack has a ${e.kind} "${e.rec.weapon_id}": it exists only in ${e.rec.pack}` }]; e.rec.compare = { status: 'game_only' }; continue }
        const a = e.rec.model, b = hit.rec.model, diff = []
        if (a.tris !== b.tris) diff.push(`tris ${a.tris} vs ${b.tris}`)
        if (a.materials !== b.materials) diff.push(`materials ${a.materials} vs ${b.materials}`)
        if (e.rec.textures.length !== hit.rec.textures.length) diff.push(`textures ${e.rec.textures.length} vs ${hit.rec.textures.length}`)
        e.rec.compare = { status: diff.length ? 'diverged' : 'same_stats', pack: hit.rec.pack, weapon_id: hit.rec.weapon_id, diff, tris_pack: b.tris, tris_local: a.tris }
        e.localFlags = [diff.length
            ? { code: 'LOCAL_DIVERGES', severity: 'warn', msg: `game-local copy of ${hit.rec.pack}/${hit.rec.weapon_id} differs (${diff.join(', ')}): fix it in the pack and drop the copy` }
            : { code: 'LOCAL_COPY', severity: 'info', msg: `same geometry as ${hit.rec.pack}/${hit.rec.weapon_id} (re-exported bytes): use the pack file` }]
    }
}

/** Scan the enabled sources (or the named ones). ctx = { sources, kinds }. Returns [{ rec, files, kind }]. */
export function scan(ctx, { only, onLog = () => {}, covered = new Set(), tier = 'high' } = {}) {
    const srcs = ctx.sources.filter((s) => s.enabled && (!only?.length || only.includes(s.name)))
    const all = [], types = new Map(ctx.sources.map((s) => [s.name, s.type]))
    types.noCompare = new Set(ctx.sources.filter((s) => s.config.compare === false).map((s) => s.name))
    for (const s of srcs) {
        const { entries, audio } = scanSource(s, ctx.kinds, { onLog, covered })
        attachSounds(s, entries, audio)
        all.push(...entries)
    }
    const games = eventGames(ctx.sources)
    for (const e of all) if (e.kind === 'weapon' && games.length) withEvents(e.rec, e.files, games)
    compareLocal(all, types)
    return all.map((e) => {
        const budget = K.budgetOf(ctx.kinds, e.kind)
        e.rec.kind = e.kind
        e.rec.source_commit = ''
        if (e.def) e.rec.flags = [{ code: 'NO_MODEL', severity: 'warn', msg: 'definition has no model file in the source' }]
        else if (e.kind === 'pack') e.rec.flags = e.rec.sounds.length ? [] : [{ code: 'NO_SOUNDS', severity: 'warn', msg: 'no sounds' }]
        else e.rec.flags = [...kindFlags(e.rec, budget, tier), ...(e.localFlags ?? [])]
        e.rec.score = scoreOf(e.rec.flags)
        e.rec.pass = passes(e.rec.flags, e.rec.score)
        e.rec.audited_at = new Date().toISOString()
        return { rec: e.rec, files: e.files, kind: e.kind }
    })
}
