// ASSETS (RSI) tab, the database side (CLI, node:sqlite; the panel only reads these tables through Prisma).
// One AssetWeapon row per weapon with its audit record in `data`. Rows come from `assets ingest` (audit.json from the
// shared rsi_asset_audit.py tool) or from `assets scan` (a directory scan of the weapon packs and games, so every gun
// is listed before an audit exists). An audit row is never overwritten by a scan.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { imageBytes, imageInfo, readModel, stats } from './glb.mjs'
import { AUDIT_DIR, GODOT_ROOT, SERVE_ROOTS, resolveFile, underRoots } from './assets-files.mjs'
export { AUDIT_DIR, GODOT_ROOT, SERVE_ROOTS, resolveFile, underRoots }

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const MIGRATION = path.join(ROOT, 'prisma', 'migrations', '20261123000000_assets', 'migration.sql')
export const WEAPON_PACKS = ['fc-weapons', 'arena-weapons', 'zee-dot-weapons', 'zed-dot-weapons', 'zz-medieval-weapons', 'zz-modern-weapons']
export const SEVERITY_COST = { error: 20, warn: 7, info: 2 }
const AUDIO = ['.ogg', '.wav', '.mp3']
const SKIP_DIR = /^(\.git|\.godot|node_modules|archive|art-src|assets-src|screenshots|backup|wt-.*|\.import)$/

// ---------- schema ----------
export function pending(db) {
    return !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='AssetWeapon'").get()
}
/** Create the table; with `backup` and work to do, copy the database first (VACUUM INTO, consistent under WAL). Returns the backup path or ''. */
export function migrate(db, { backup = false, dbPath = '' } = {}) {
    let bak = ''
    if (backup && pending(db)) {
        const dir = path.join(path.dirname(dbPath), 'backup')
        mkdirSync(dir, { recursive: true })
        bak = path.join(dir, `nightly-pre-assets-migrate-${new Date().toISOString().replace(/[:.]/g, '-')}.db`)
        db.exec(`VACUUM INTO '${bak.replace(/'/g, "''")}'`)
    }
    const sql = readFileSync(MIGRATION, 'utf8').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    for (const st of sql.split(/;\s*(?:\n|$)/).map((x) => x.trim()).filter(Boolean)) db.exec(st)
    return bak
}
export function ready(db) {
    if (pending(db)) throw new Error('the assets table is missing: run `nightly assets migrate` (it backs up the database first)')
}

// ---------- scoring ----------
export function scoreOf(flags) {
    const s = 100 - flags.reduce((a, f) => a + (SEVERITY_COST[f.severity] ?? 0), 0)
    return Math.max(0, s)
}
export const passes = (flags, score) => !flags.some((f) => f.severity === 'error') && score >= 70

// ---------- audio ----------
export function probeAudio(file) {
    const r = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_entries', 'format=duration,size:stream=sample_rate,channels,codec_name', file], { encoding: 'utf8', timeout: 20000 })
    let j = {}
    try { j = JSON.parse(r.stdout || '{}') } catch { /* unknown */ }
    const s = j.streams?.[0] ?? {}
    return { len: +(+(j.format?.duration ?? 0)).toFixed(3), rate: +(s.sample_rate ?? 0), channels: s.channels ?? 0, codec: s.codec_name ?? '', bytes: +(j.format?.size ?? statSync(file).size) }
}

// ---------- directory scan ----------
function walk(dir, visit, rel = '') {
    let ents
    try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
        if (e.isDirectory()) {
            if (SKIP_DIR.test(e.name) || (rel === 'addons' && /^dot_/.test(e.name))) continue
            walk(path.join(dir, e.name), visit, rel ? `${rel}/${e.name}` : e.name)
        } else if (e.isFile()) visit(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name)
    }
}
const sha1 = (f) => createHash('sha1').update(readFileSync(f)).digest('hex')
const GUNISH = /(weapon|blaster|gun|melee|ammo|grenade|knife|sword)/i

/** Flags for a scan record (a lighter set than the audit tool: no clip or mag checks, those need the audit). */
export function scanFlags(rec, th = { min_tris: 3000, min_tex: 1024 }) {
    const F = []
    const add = (code, severity, msg) => F.push({ code, severity, msg })
    if (!rec.model.glb) add('NO_MODEL', 'error', 'no model file')
    else {
        if (rec.model.tris < th.min_tris) add(rec.model.tris < th.min_tris / 3 ? 'VERY_LOW_TRIS' : 'LOW_TRIS', 'error', `${rec.model.tris} tris < ${th.min_tris}`)
        if (rec.model.materials < 3) add('FEW_MATERIALS', 'warn', `${rec.model.materials} materials`)
        if (!rec.textures.length) add('NO_TEXTURES', 'error', 'no textures')
        else {
            if (Math.max(...rec.textures.map((t) => Math.max(t.w, t.h))) < th.min_tex) add('LOW_TEX', 'error', `largest texture under ${th.min_tex}px`)
            if (rec.textures.some((t) => t.w && !t.pot)) add('NPOT_TEX', 'warn', 'a texture is not power-of-two')
            if (!rec.textures.some((t) => t.maps.includes('normal'))) add('MISSING_NORMAL', 'warn', 'no normal map')
            if (!rec.textures.some((t) => t.maps.some((m) => ['orm', 'roughness', 'metallic'].includes(m)))) add('MISSING_ORM', 'warn', 'no roughness/metallic map')
        }
    }
    if (!rec.animations.length) add('NO_ANIM_CLIPS', 'info', 'the model carries no animation clips')
    if (!rec.sounds.length) add('NO_SOUNDS', 'warn', 'no sounds matched to this weapon')
    return F
}

function modelRecord(pack, game, weaponId, file, rel) {
    const m = readModel(file)
    const st = stats(m)
    const dir = path.dirname(file)
    // external image files of the same stem (e.g. ammo_box_0.jpg beside ammo_box.glb) count as textures when the glb carries none
    const textures = st.textures.map((t) => ({ ...t, path: '' }))
    const files = { glb: file, textures: st.textures.map((t) => (t.embedded ? { kind: 'glb', index: t.image_index } : { kind: 'file', path: path.join(dir, decodeURI(m.json.images[t.image_index].uri)) })), sounds: [] }
    if (!textures.length) {
        const stem = path.basename(file).replace(/\.[^.]+$/, '')
        for (const f of readdirSync(dir)) {
            if (!/\.(png|jpe?g|webp)$/i.test(f) || !f.startsWith(stem + '_')) continue
            const b = readFileSync(path.join(dir, f))
            const info = imageInfoSafe(b)
            textures.push({ name: f.replace(/\.[^.]+$/, ''), ...info, bytes: b.length, maps: guessMaps(f), pot: pot(info.w) && pot(info.h), embedded: false })
            files.textures.push({ kind: 'file', path: path.join(dir, f) })
        }
    }
    const rec = {
        pack, game, weapon_id: weaponId,
        model: { glb: rel, viewer_glb: '', tris: st.tris, verts: st.verts, materials: st.materials, meshes: st.meshes, bbox: st.bbox, primitive_meshes: [] },
        textures: textures.map(({ image_index, ...t }) => t), animations: st.animations, sounds: [],
    }
    return { rec, files }
}
const pot = (n) => n > 0 && (n & (n - 1)) === 0
const imageInfoSafe = (b) => { const i = imageInfo(b); return { w: i.w, h: i.h, format: i.format } }
function guessMaps(name) {
    const n = name.toLowerCase()
    return n.includes('normal') ? ['normal'] : n.includes('rough') ? ['roughness'] : n.includes('metal') ? ['metallic'] : n.includes('orm') ? ['orm'] : n.includes('emis') ? ['emissive'] : n.includes('_ao') ? ['ao'] : ['albedo']
}

/** Does sound `stem` belong to weapon `wid`? (stem starts with the id, or the id starts with the stem's first token) */
export function soundMatches(stem, wid, dirName = '') {
    const s = stem.toLowerCase().replace(/[-\s]/g, '_'), w = wid.toLowerCase().replace(/[-\s]/g, '_')
    if (dirName && dirName.toLowerCase() === w) return true
    if (s.startsWith(w + '_') || s === w) return true
    const tok = s.split('_')[0]
    return tok.length >= 3 && (w === tok || w.startsWith(tok + '_'))
}

/** Weapon ids declared by a pack's weapons/*.tres definitions. */
function defIds(repo) {
    const dir = path.join(repo, 'weapons')
    if (!existsSync(dir)) return []
    const ids = []
    for (const f of readdirSync(dir)) {
        if (!f.endsWith('.tres')) continue
        const m = /\[resource\][\s\S]*?\nid = &?"([^"]+)"/.exec(readFileSync(path.join(dir, f), 'utf8'))
        if (m) ids.push(m[1])
    }
    return ids
}

/** Scan the weapon packs and the games: one record per distinct model file (content hash), packs first so a gun is credited to its pack. */
export function scan({ packs = WEAPON_PACKS, root = GODOT_ROOT(), onLog = () => {}, covered = new Set() } = {}) {
    const repos = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    const games = repos.filter((r) => /^(game-|mg-)/.test(r)).sort()
    const seen = new Map() // sha1 -> entry
    const byKey = new Map() // pack/id -> entry
    const out = []
    const sounds = new Map() // repo -> [{file, rel}]
    const collect = (repo, isPack) => {
        const base = path.join(root, repo)
        if (!existsSync(base)) { onLog(`skip ${repo}: not found`); return }
        const audio = []
        walk(base, (file, rel) => {
            const ext = path.extname(file).toLowerCase()
            if (AUDIO.includes(ext) && (isPack || GUNISH.test(rel))) audio.push({ file, rel })
            if (!['.glb', '.gltf'].includes(ext)) return
            if (!isPack && !GUNISH.test(rel)) return
            let h
            try { h = sha1(file) } catch { return }
            const stem = path.basename(file).replace(/\.[^.]+$/, '')
            const prior = seen.get(isPack ? `${repo}:${h}` : h) ?? (isPack ? null : seen.get(h))
            if (prior) { if (!isPack) prior.games.add(repo.replace(/^(game|mg)-/, '')); return }
            if (isPack && covered.has(`${repo}|${rel}`)) { seen.set(`${repo}:${h}`, { games: new Set() }); return }
            let id = stem
            if (byKey.has(`${repo}/${id}`)) id = `${path.basename(path.dirname(file))}_${stem}`
            try {
                const { rec, files } = modelRecord(repo, '', id, file, rel)
                const entry = { rec, files, games: new Set(isPack ? [] : [repo.replace(/^(game|mg)-/, '')]), kind: 'weapon' }
                seen.set(isPack ? `${repo}:${h}` : h, entry); if (isPack && !seen.has(h)) seen.set(h, entry); byKey.set(`${repo}/${id}`, entry); out.push(entry)
            } catch (e) { onLog(`unreadable ${rel}: ${e.message}`) }
        })
        sounds.set(repo, audio)
    }
    for (const p of packs) collect(p, true)
    for (const g of games) collect(g, false)
    // weapon definition files (weapons/*.tres, id = &"...") are the authoritative gun list of a pack: one entry per definition
    for (const p of packs) {
        for (const id of defIds(path.join(root, p))) {
            if (byKey.has(`${p}/${id}`) || covered.has(`${p}#${id}`)) continue
            const m = out.find((e) => e.rec.pack === p && e.kind === 'weapon' && !e.def && (e.rec.weapon_id === id || e.rec.weapon_id.startsWith(id + '_') || id.startsWith(e.rec.weapon_id + '_')))
            if (m) { m.rec.def_id = id; continue }
            const rec = { pack: p, game: '', weapon_id: id, model: { glb: '', viewer_glb: '', tris: 0, verts: 0, materials: 0, meshes: 0, bbox: [0, 0, 0], primitive_meshes: [] }, textures: [], animations: [], sounds: [] }
            out.push({ rec, files: { glb: '', textures: [], sounds: [] }, games: new Set(), kind: 'weapon', def: true })
            byKey.set(`${p}/${id}`, out[out.length - 1])
        }
    }
    // sounds: attach to weapons of the same repo; the rest of a pack's sounds go to one pack-level entry
    for (const [repo, audio] of sounds) {
        const mine = out.filter((e) => e.rec.pack === repo)
        const used = new Set()
        for (const a of audio) {
            const stem = path.basename(a.file).replace(/\.[^.]+$/, ''), dn = path.basename(path.dirname(a.file))
            const hit = mine.filter((e) => soundMatches(stem, e.rec.weapon_id, dn) || (e.rec.def_id && soundMatches(stem, e.rec.def_id, dn)))
            for (const e of hit) {
                const p = probeAudio(a.file)
                e.rec.sounds.push({ name: stem, len: p.len, rate: p.rate, bytes: p.bytes, channels: p.channels, codec: p.codec })
                e.files.sounds.push({ kind: 'file', path: a.file })
                used.add(a.file)
            }
        }
        const rest = audio.filter((a) => !used.has(a.file))
        if (rest.length && WEAPON_PACKS.includes(repo)) {
            const rec = { pack: repo, game: '', weapon_id: '_pack_sounds', model: { glb: '', viewer_glb: '', tris: 0, verts: 0, materials: 0, meshes: 0, bbox: [0, 0, 0], primitive_meshes: [] }, textures: [], animations: [], sounds: [] }
            const files = { glb: '', textures: [], sounds: [] }
            for (const a of rest) {
                const p = probeAudio(a.file)
                rec.sounds.push({ name: path.basename(a.file).replace(/\.[^.]+$/, ''), len: p.len, rate: p.rate, bytes: p.bytes, channels: p.channels, codec: p.codec })
                files.sounds.push({ kind: 'file', path: a.file })
            }
            out.push({ rec, files, games: new Set(), kind: 'pack' })
        }
    }
    return out.map((e) => {
        e.rec.game = [...e.games].sort().join(',')
        e.rec.source_commit = ''
        if (e.def) e.rec.flags = [{ code: 'NO_MODEL', severity: 'warn', msg: 'weapon definition has no model file in the pack' }]
        else if (e.kind === 'weapon') e.rec.flags = scanFlags(e.rec)
        else e.rec.flags = e.rec.sounds.length ? [] : [{ code: 'NO_SOUNDS', severity: 'warn', msg: 'no sounds' }]
        e.rec.score = scoreOf(e.rec.flags)
        e.rec.pass = passes(e.rec.flags, e.rec.score)
        e.rec.audited_at = new Date().toISOString()
        return { rec: e.rec, files: e.files, kind: e.kind }
    })
}

// ---------- store ----------
export function upsert(db, rec, files, { source = 'audit', kind = 'weapon' } = {}) {
    const old = db.prepare('SELECT id, source FROM AssetWeapon WHERE pack = ? AND weaponId = ?').get(rec.pack, rec.weapon_id)
    if (old && old.source === 'audit' && source === 'scan') return 'kept'
    const flags = rec.flags ?? []
    const vals = [
        rec.game ?? '', kind, source, rec.model?.tris ?? 0, (rec.textures ?? []).length, (rec.animations ?? []).length, (rec.sounds ?? []).length,
        flags.length, [...new Set(flags.map((f) => f.code))].join(' '), Math.round(rec.score ?? 0), rec.pass ? 1 : 0,
        rec.audited_at ?? '', new Date().toISOString(), JSON.stringify({ ...rec, _files: files }),
    ]
    if (old) {
        db.prepare('UPDATE AssetWeapon SET game=?, kind=?, source=?, tris=?, texCount=?, animCount=?, soundCount=?, flagCount=?, flagCodes=?, score=?, pass=?, auditedAt=?, updatedAt=?, data=? WHERE id=?').run(...vals, old.id)
        return 'updated'
    }
    db.prepare('INSERT INTO AssetWeapon (pack, weaponId, game, kind, source, tris, texCount, animCount, soundCount, flagCount, flagCodes, score, pass, auditedAt, updatedAt, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(rec.pack, rec.weapon_id, ...vals)
    return 'added'
}

export function scanInto(db, opts) {
    ready(db)
    const res = { added: 0, updated: 0, kept: 0 }
    const covered = new Set()
    for (const r of db.prepare("SELECT pack, weaponId, data FROM AssetWeapon WHERE source = 'audit'").all()) {
        covered.add(`${r.pack}#${r.weaponId}`)
        try { covered.add(`${r.pack}|${JSON.parse(r.data).model?.glb}`) } catch { /* ignore */ }
    }
    for (const e of scan({ ...opts, covered })) res[upsert(db, e.rec, e.files, { source: 'scan', kind: e.kind })]++
    return res
}

/** Locate the files of an audit record: the viewer glb (relative to the audit directory), the source glb in the pack repo, sounds by name. */
function auditFiles(rec, auditDir) {
    const godot = GODOT_ROOT()
    const repo = path.join(godot, rec.pack)
    const files = { glb: '', textures: [], sounds: [] }
    const viewer = rec.model?.viewer_glb && path.join(auditDir, rec.model.viewer_glb)
    const src = rec.model?.glb && path.join(repo, rec.model.glb)
    files.glb = viewer && existsSync(viewer) ? viewer : src && existsSync(src) ? src : ''
    let m = null
    if (files.glb) { try { m = readModel(files.glb) } catch { /* unreadable */ } }
    const names = (m?.json.images ?? []).map((im, i) => im.name || (im.uri ? path.basename(decodeURI(im.uri)).replace(/\.[^.]+$/, '') : `image_${i}`))
    const idx = (rec.textures ?? []).map((t, i) => { const k = names.indexOf(t.name); return k >= 0 ? k : i < names.length ? i : -1 })
    let ext = null
    for (const [i, t] of (rec.textures ?? []).entries()) {
        if (idx[i] >= 0 && m && imageBytes(m, idx[i])) { files.textures.push({ kind: 'glb', index: idx[i] }); continue }
        ext ??= indexFiles(repo, /\.(png|jpe?g|webp)$/i)
        const hit = ext.find((f) => path.basename(f).replace(/\.[^.]+$/, '') === t.name)
        files.textures.push(hit ? { kind: 'file', path: hit } : { kind: 'none' })
    }
    let aud = null
    for (const s of rec.sounds ?? []) {
        aud ??= indexFiles(repo, /\.(ogg|wav|mp3)$/i)
        const hit = aud.find((f) => path.basename(f).replace(/\.[^.]+$/, '') === s.name)
        files.sounds.push(hit ? { kind: 'file', path: hit } : { kind: 'none' })
    }
    return files
}
const idxCache = new Map()
function indexFiles(repo, re) {
    const k = repo + re
    if (!idxCache.has(k)) { const l = []; walk(repo, (f) => { if (re.test(f)) l.push(f) }); idxCache.set(k, l) }
    return idxCache.get(k)
}

/** The audit emits no sounds: attach the pack's sounds by weapon id (sounds/<id>/ directory or <id>_<event> file name). */
function attachSounds(rec, files) {
    if (rec.sounds?.length || !WEAPON_PACKS.includes(rec.pack)) return
    rec.sounds = []
    for (const f of indexFiles(path.join(GODOT_ROOT(), rec.pack), /\.(ogg|wav|mp3)$/i)) {
        const stem = path.basename(f).replace(/\.[^.]+$/, '')
        if (!soundMatches(stem, rec.weapon_id, path.basename(path.dirname(f)))) continue
        const p = probeAudio(f)
        rec.sounds.push({ name: stem, len: p.len, rate: p.rate, bytes: p.bytes, channels: p.channels, codec: p.codec })
        files.sounds.push({ kind: 'file', path: f })
    }
}

export function ingestAudit(db, doc, { auditDir = AUDIT_DIR() } = {}) {
    ready(db)
    if (!doc || !Array.isArray(doc.weapons)) throw new Error('not an audit file: expected {"weapons": [...]} (schema rsi-assets/1)')
    const res = { added: 0, updated: 0, kept: 0, skipped: 0 }
    db.exec('BEGIN')
    try {
        for (const w of doc.weapons) {
            if (!w.pack || !w.weapon_id) { res.skipped++; continue }
            w.flags ??= []
            w.score ??= scoreOf(w.flags)
            w.pass ??= passes(w.flags, w.score)
            w.audited_at ??= doc.generated_at ?? new Date().toISOString()
            const files = auditFiles(w, auditDir)
            attachSounds(w, files)
            db.prepare("DELETE FROM AssetWeapon WHERE source = 'scan' AND pack = ? AND (weaponId = ? OR json_extract(data, '$.model.glb') = ?)").run(w.pack, w.weapon_id, w.model?.glb ?? '')
            res[upsert(db, w, files, { source: 'audit' })]++
        }
        db.exec('COMMIT')
    } catch (e) { db.exec('ROLLBACK'); throw e }
    return res
}

export function list(db, { pack, game, flag, minScore, maxScore, q } = {}) {
    ready(db)
    const W = [], A = []
    if (pack) { W.push('pack = ?'); A.push(pack) }
    if (game) { W.push("(',' || game || ',') LIKE ?"); A.push(`%,${game},%`) }
    if (flag) { W.push("(' ' || flagCodes || ' ') LIKE ?"); A.push(`% ${flag} %`) }
    if (minScore != null) { W.push('score >= ?'); A.push(minScore) }
    if (maxScore != null) { W.push('score <= ?'); A.push(maxScore) }
    if (q) { W.push('weaponId LIKE ?'); A.push(`%${q}%`) }
    return db.prepare(`SELECT id, pack, game, weaponId, kind, source, tris, texCount, animCount, soundCount, flagCount, flagCodes, score, pass, auditedAt FROM AssetWeapon ${W.length ? 'WHERE ' + W.join(' AND ') : ''} ORDER BY score ASC, pack, weaponId`).all(...A)
}
/** `ID` or `pack/weapon_id` (or a bare weapon id when unique). */
export function show(db, ref) {
    ready(db)
    let row = /^\d+$/.test(ref) ? db.prepare('SELECT * FROM AssetWeapon WHERE id = ?').get(+ref) : null
    if (!row && ref.includes('/')) { const [p, ...r] = ref.split('/'); row = db.prepare('SELECT * FROM AssetWeapon WHERE pack = ? AND weaponId = ?').get(p, r.join('/')) }
    if (!row) { const rows = db.prepare('SELECT * FROM AssetWeapon WHERE weaponId = ?').all(ref); if (rows.length > 1) throw new Error(`"${ref}" is in several packs: ${rows.map((r) => `${r.pack}/${r.weaponId}`).join(', ')}`); row = rows[0] }
    if (!row) throw new Error(`no such weapon: ${ref}`)
    return { ...row, data: JSON.parse(row.data) }
}
export function summary(db) {
    ready(db)
    return db.prepare("SELECT pack, COUNT(*) AS weapons, SUM(pass) AS pass, CAST(AVG(score) AS INTEGER) AS avg_score, SUM(source='audit') AS audited FROM AssetWeapon GROUP BY pack ORDER BY pack").all()
}

