// ASSETS (RSI) tab, the database side (CLI, node:sqlite; the panel only reads these tables through Prisma).
// One AssetWeapon row per asset (any kind) with its audit record in `data`. Rows come from `assets ingest` (audit.json from the
// shared rsi_asset_audit.py tool) or from `assets scan` (a directory scan of the configured sources, so every asset is listed
// before an audit exists). An audit row is never overwritten by a scan. Sources and kinds live in their own tables.
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { imageBytes, readModel } from './glb.mjs'
import { AUDIT_DIR, SERVE_ROOTS, resolveFile, setExtraRoots, underRoots } from './assets-files.mjs'
import { attachSidecar } from './assets-anim.mjs'
import { ensureColumns, shapeOf } from './asset-cols.mjs'
import * as K from './assets-kinds.mjs'
import * as S from './assets-sources.mjs'
import { scan, walk, probeAudio, skipDir } from './assets-scan.mjs'
import { eventGames, soundMatches, withEvents } from './assets-events.mjs'
import { SEVERITY_COST, passes, scoreOf } from './assets-checks.mjs'
export { AUDIT_DIR, SERVE_ROOTS, resolveFile, underRoots, scan, probeAudio, SEVERITY_COST, passes, scoreOf }
export { packMatch } from './assets-scan.mjs'
import { linkAttachments, prepareAttachment } from './assets-attach.mjs'
export { forAsset as attachmentsOf } from './assets-attach.mjs'

const MIGRATIONS = ['20261123000000_assets', '20261125000000_asset_sources_kinds', '20261126000000_asset_audit_history', '20261205000000_asset_attachments']
const MIG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prisma', 'migrations')
const hasTable = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)

// ---------- schema ----------
export function pending(db) { return !hasTable(db, 'AssetWeapon') || !hasTable(db, 'AssetSource') }
/** Create the tables and seed the generic kinds; with `backup` and work to do, copy the database first (VACUUM INTO, consistent under WAL). Returns the backup path or ''. */
export function migrate(db, { backup = false, dbPath = '' } = {}) {
    let bak = ''
    if (backup && pending(db)) {
        const dir = path.join(path.dirname(dbPath), 'backup')
        mkdirSync(dir, { recursive: true })
        bak = path.join(dir, `nightly-pre-assets-migrate-${new Date().toISOString().replace(/[:.]/g, '-')}.db`)
        db.exec(`VACUUM INTO '${bak.replace(/'/g, "''")}'`)
    }
    for (const m of MIGRATIONS) {
        if (m.endsWith('_assets') && hasTable(db, 'AssetWeapon')) continue
        if (m.endsWith('_sources_kinds') && hasTable(db, 'AssetSource')) continue
        if (m.endsWith('_audit_history') && hasTable(db, 'AssetAuditHistory')) continue
        if (m.endsWith('_asset_attachments') && hasTable(db, 'AssetAttachment')) continue
        const sql = readFileSync(path.join(MIG_DIR, m, 'migration.sql'), 'utf8').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
        for (const st of sql.split(/;\s*(?:\n|$)/).map((x) => x.trim()).filter(Boolean)) db.exec(st)
    }
    ensureColumns(db)
    K.seed(db)
    K.seedMissing(db)
    return bak
}
export function ready(db) {
    if (pending(db)) throw new Error('the assets tables are missing: run `nightly assets migrate` (it backs up the database first)')
    // the denormalised list columns are additive and idempotent, so a database from before them is upgraded in place
    if (!db.prepare("SELECT 1 FROM pragma_table_info('AssetWeapon') WHERE name='shape'").get()) ensureColumns(db)
}

// ---------- scan ----------
/** Sources and kinds as the scan wants them. */
export function context(db) { ready(db); return { sources: S.list(db), kinds: K.list(db) } }

// ---------- store ----------
export function upsert(db, rec, files, { source = 'audit', kind } = {}) {
    kind ||= rec.kind || K.DEFAULT_KIND
    const old = db.prepare('SELECT id, source FROM AssetWeapon WHERE pack = ? AND weaponId = ?').get(rec.pack, rec.weapon_id)
    if (old && old.source === 'audit' && source === 'scan') return 'kept'
    attachSidecar(rec, files)
    const flags = rec.flags ?? []
    const vals = [
        rec.game ?? '', kind, source, rec.model?.tris ?? 0, (rec.textures ?? []).length, (rec.animations ?? []).length, (rec.sounds ?? []).length,
        flags.length, [...new Set(flags.map((f) => f.code))].join(' '), Math.round(rec.score ?? 0), rec.pass ? 1 : 0,
        rec.audited_at ?? '', new Date().toISOString(), JSON.stringify({ ...rec, kind, _files: files }),
    ]
    const sh = shapeOf(rec, files)
    const shVals = [sh.hasModel, sh.verts, sh.materials, sh.texMax, sh.texBytes, sh.texMaps, sh.animLen, sh.soundLen, sh.soundBytes]
    const shCols = 'hasModel, verts, materials, texMax, texBytes, texMaps, animLen, soundLen, soundBytes, shape'
    if (old) {
        db.prepare('UPDATE AssetWeapon SET game=?, kind=?, source=?, tris=?, texCount=?, animCount=?, soundCount=?, flagCount=?, flagCodes=?, score=?, pass=?, auditedAt=?, updatedAt=?, data=?, hasModel=?, verts=?, materials=?, texMax=?, texBytes=?, texMaps=?, animLen=?, soundLen=?, soundBytes=?, shape=1 WHERE id=?').run(...vals, ...shVals, old.id)
        return 'updated'
    }
    db.prepare(`INSERT INTO AssetWeapon (pack, weaponId, game, kind, source, tris, texCount, animCount, soundCount, flagCount, flagCodes, score, pass, auditedAt, updatedAt, data, ${shCols}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${shVals.map(() => '?').join(', ')}, 1)`).run(rec.pack, rec.weapon_id, ...vals, ...shVals)
    return 'added'
}

/** Re-read each stored row's `.anim.json` sidecar (written next to its GLB by a pack's exporter) so baked clips show without a new audit. Returns the number of rows changed. */
export function attachAnim(db) {
    let n = 0
    const ctx = context(db), srcs = new Map(ctx.sources.map((x) => [x.name, x])), games = eventGames(ctx.sources)
    for (const r of db.prepare('SELECT pack, weaponId, source, data FROM AssetWeapon WHERE hasModel = 1').all()) {
        const rec = JSON.parse(r.data), files = rec._files ?? {}
        if (!attachSidecar(rec, files)) continue
        attachSounds(rec, files, srcs.get(rec.pack), games, ctx.kinds)
        if (JSON.stringify([rec.animations, rec.sounds]) === JSON.stringify([JSON.parse(r.data).animations, JSON.parse(r.data).sounds])) continue
        delete rec._files
        upsert(db, rec, files, { source: r.source, kind: rec.kind })
        n++
    }
    return n
}

/** Resolve the open findings of asset rows that no longer exist (pruned or replaced by an audit): nothing is left to fix. */
export function closeOrphanFindings(db) {
    if (!hasTable(db, 'RsiFinding')) return 0
    const t = new Date().toISOString()
    return Number(db.prepare("UPDATE RsiFinding SET status='resolved', state='removed', fixedAt=?, lastSeenAt=?, nextAction='The asset row is gone: nothing to do' WHERE status='open' AND assetId IS NOT NULL AND assetId NOT IN (SELECT id FROM AssetWeapon) AND subject NOT IN (SELECT pack || '/' || weaponId FROM AssetWeapon)").run(t, t).changes)
}

/** Scan the enabled sources (or `only`), never overwriting audited rows. Rows of a scanned source that the scan no longer finds are dropped. */
export function scanInto(db, { only, tier = 'high', onLog } = {}) {
    const ctx = context(db)
    if (!ctx.sources.length) throw new Error('no asset sources: add one with `nightly assets source add <name> --root DIR`')
    const res = { added: 0, updated: 0, kept: 0, sources: 0, pruned: 0 }
    const covered = new Set()
    for (const r of db.prepare("SELECT pack, weaponId, data FROM AssetWeapon WHERE source = 'audit'").all()) {
        covered.add(`${r.pack}#${r.weaponId}`)
        try { covered.add(`${r.pack}|${JSON.parse(r.data).model?.glb}`) } catch { /* ignore */ }
    }
    const items = scan(ctx, { only, onLog, covered, tier })
    const names = new Set(items.map((e) => e.rec.pack))
    for (const s of ctx.sources.filter((x) => x.enabled && (!only?.length || only.includes(x.name)))) { names.add(s.name); S.touch(db, s.name); res.sources++ }
    db.exec('BEGIN')
    try {
        const keep = new Set(items.map((e) => `${e.rec.pack}#${e.rec.weapon_id}`))
        for (const r of db.prepare("SELECT id, pack, weaponId FROM AssetWeapon WHERE source = 'scan'").all()) if (names.has(r.pack) && !keep.has(`${r.pack}#${r.weaponId}`)) db.prepare('DELETE FROM AssetWeapon WHERE id = ?').run(r.id)
        for (const e of items) res[upsert(db, e.rec, e.files, { source: 'scan', kind: e.kind })]++
        // An audited row of a scanned source whose model file is gone from the source root is a deleted model: the audit that wrote it is not rerun on every scan.
        for (const s of ctx.sources.filter((x) => x.enabled && x.root && existsSync(x.root) && names.has(x.name))) {
            for (const r of db.prepare("SELECT id, data FROM AssetWeapon WHERE source = 'audit' AND pack = ?").all(s.name)) {
                let glb = ''
                try { glb = JSON.parse(r.data).model?.glb ?? '' } catch { /* keep an unreadable row */ }
                if (glb && (!existsSync(path.join(s.root, glb)) || glb.split('/').slice(0, -1).some((d) => skipDir(S.effective(s.config).exclude, d)))) { db.prepare('DELETE FROM AssetWeapon WHERE id = ?').run(r.id); res.pruned++ }
            }
        }
        res.closedFindings = closeOrphanFindings(db)
        db.exec('COMMIT')
    } catch (e) { db.exec('ROLLBACK'); throw e }
    return res
}

/** One trend row per pack per ingest (created on first use, so an existing install needs no extra migrate). */
function recordHistory(db, packs) {
    if (!hasTable(db, 'AssetAuditHistory')) migrate(db)
    const at = new Date().toISOString()
    const q = db.prepare("SELECT COUNT(*) AS n, SUM(pass) AS pass, CAST(AVG(score) AS INTEGER) AS avg FROM AssetWeapon WHERE pack = ? AND source = 'audit'")
    const ins = db.prepare('INSERT INTO AssetAuditHistory (at, pack, total, pass, avgScore) VALUES (?,?,?,?,?)')
    for (const p of packs) { const r = q.get(p); if (r.n) ins.run(at, p, r.n, r.pass ?? 0, r.avg ?? 0) }
}
/** Audit history, oldest first: `[{ at, pack, total, pass, avgScore }]`; empty before the first ingest. */
export function history(db, { pack, limit = 60 } = {}) {
    if (!hasTable(db, 'AssetAuditHistory')) return []
    const rows = db.prepare(`SELECT at, pack, total, pass, avgScore FROM AssetAuditHistory ${pack ? 'WHERE pack = ?' : ''} ORDER BY at DESC, id DESC LIMIT ?`).all(...(pack ? [pack] : []), limit * (pack ? 1 : 40))
    return rows.reverse()
}

// ---------- ingest ----------
const idxCache = new Map()
function indexFiles(root, re) {
    const k = root + re
    if (!idxCache.has(k)) { const l = []; walk(root, ['.git', '.godot', '.import', 'node_modules'], (f) => { if (re.test(f)) l.push(f) }); idxCache.set(k, l) }
    return idxCache.get(k)
}
const stemOf = (f) => path.basename(f).replace(/\.[^.]+$/, '')

/** Locate the files of an audit record: the viewer glb (relative to the audit directory), the source glb in its source root, sounds by name. */
function auditFiles(rec, auditDir, src) {
    const repo = src?.root ?? ''
    const files = { glb: '', textures: [], sounds: [] }
    const viewer = rec.model?.viewer_glb && path.join(auditDir, rec.model.viewer_glb)
    const own = repo && rec.model?.glb && path.join(repo, rec.model.glb)
    files.glb = viewer && existsSync(viewer) ? viewer : own && existsSync(own) ? own : ''
    let m = null
    if (files.glb) { try { m = readModel(files.glb) } catch { /* unreadable */ } }
    const names = (m?.json.images ?? []).map((im, i) => im.name || (im.uri ? stemOf(decodeURI(im.uri)) : `image_${i}`))
    const idx = (rec.textures ?? []).map((t, i) => { const k = names.indexOf(t.name); return k >= 0 ? k : i < names.length ? i : -1 })
    let ext = null
    for (const [i, t] of (rec.textures ?? []).entries()) {
        if (idx[i] >= 0 && m && imageBytes(m, idx[i])) { files.textures.push({ kind: 'glb', index: idx[i] }); continue }
        const hit = repo && (ext ??= indexFiles(repo, /\.(png|jpe?g|webp)$/i)).find((f) => stemOf(f) === t.name)
        files.textures.push(hit ? { kind: 'file', path: hit } : { kind: 'none' })
    }
    let aud = null
    for (const s of rec.sounds ?? []) {
        const hit = repo && (aud ??= indexFiles(repo, /\.(ogg|wav|mp3)$/i)).find((f) => stemOf(f) === s.name)
        files.sounds.push(hit ? { kind: 'file', path: hit } : { kind: 'none' })
    }
    return files
}

/** The audit emits no sounds: attach the source's sounds by asset id, then the event table sounds (kinds in the source's soundKinds). */
function attachSounds(rec, files, src, games, kinds) {
    const cfg = S.effective(src?.config ?? {}, kinds)
    if (!src || cfg.soundMatch === 'none' || !cfg.soundKinds.includes(rec.kind)) return
    if (!rec.sounds?.length) {
        rec.sounds = []
        for (const f of indexFiles(src.root, /\.(ogg|wav|mp3)$/i)) {
            if (cfg.soundMatch !== 'all' && !soundMatches(stemOf(f), rec.anim_weapon ?? rec.weapon_id, path.basename(path.dirname(f)))) continue
            const p = probeAudio(f)
            rec.sounds.push({ name: stemOf(f), len: p.len, rate: p.rate, bytes: p.bytes, channels: p.channels, codec: p.codec })
            files.sounds.push({ kind: 'file', path: f })
        }
    }
    if (games.length) withEvents(rec, files, games)
}

/** An audit document: `assets` (or the older `weapons`) array of records; each record may carry `kind`. */
export function ingestAudit(db, doc, { auditDir = AUDIT_DIR() } = {}) {
    const ctx = context(db)
    const list = doc && (Array.isArray(doc.assets) ? doc.assets : Array.isArray(doc.weapons) ? doc.weapons : null)
    if (!list) throw new Error('not an audit file: expected {"assets": [...]} (schema rsi-assets/2) or {"weapons": [...]} (rsi-assets/1)')
    const byName = new Map(ctx.sources.map((s) => [s.name, s])), games = eventGames(ctx.sources)
    const res = { added: 0, updated: 0, kept: 0, skipped: 0 }
    db.exec('BEGIN')
    try {
        for (const w of list) {
            if (!w.pack || !w.weapon_id) { res.skipped++; continue }
            w.kind ||= 'weapon'
            w.flags ??= []
            w.score ??= scoreOf(w.flags)
            w.pass ??= passes(w.flags, w.score)
            w.audited_at ??= doc.generated_at ?? new Date().toISOString()
            const src = byName.get(w.pack)
            const files = auditFiles(w, auditDir, src)
            if (w.kind === 'attachment') prepareAttachment(w, files)
            attachSounds(w, files, src, games, ctx.kinds)
            db.prepare("DELETE FROM AssetWeapon WHERE source = 'scan' AND pack = ? AND (weaponId = ? OR json_extract(data, '$.model.glb') = ?)").run(w.pack, w.weapon_id, w.model?.glb ?? '')
            res[upsert(db, w, files, { source: 'audit', kind: w.kind })]++
        }
        // The audit lists every model of the packs it covers: an audited row of such a pack that it no longer lists is a deleted model.
        const seen = new Set(list.map((w) => `${w.pack}#${w.weapon_id}`)), packs = new Set(list.map((w) => w.pack).filter((p) => byName.has(p)))
        for (const r of db.prepare("SELECT id, pack, weaponId FROM AssetWeapon WHERE source = 'audit'").all()) if (packs.has(r.pack) && !seen.has(`${r.pack}#${r.weaponId}`)) { db.prepare('DELETE FROM AssetWeapon WHERE id = ?').run(r.id); res.pruned = (res.pruned ?? 0) + 1 }
        res.closedFindings = closeOrphanFindings(db)
        db.exec('COMMIT')
    } catch (e) { db.exec('ROLLBACK'); throw e }
    recordHistory(db, [...new Set(list.map((w) => w.pack).filter(Boolean))])
    if (Array.isArray(doc.attach_links)) res.links = linkAttachments(db, doc.attach_links)
    return res
}

// ---------- read ----------
export function list(db, { pack, game, kind, flag, minScore, maxScore, q } = {}) {
    ready(db)
    const W = [], A = []
    if (pack) { W.push('pack = ?'); A.push(pack) }
    if (kind) { W.push('kind = ?'); A.push(kind) }
    if (game) { W.push("(',' || game || ',') LIKE ?"); A.push(`%,${game},%`) }
    if (flag) { W.push("(' ' || flagCodes || ' ') LIKE ?"); A.push(`% ${flag} %`) }
    if (minScore != null) { W.push('score >= ?'); A.push(minScore) }
    if (maxScore != null) { W.push('score <= ?'); A.push(maxScore) }
    if (q) { W.push('weaponId LIKE ?'); A.push(`%${q}%`) }
    return db.prepare(`SELECT id, pack, game, weaponId, kind, source, tris, texCount, animCount, soundCount, flagCount, flagCodes, score, pass, auditedAt FROM AssetWeapon ${W.length ? 'WHERE ' + W.join(' AND ') : ''} ORDER BY score ASC, pack, weaponId`).all(...A)
}
/** `ID` or `pack/asset_id` (or a bare asset id when unique). */
export function show(db, ref) {
    ready(db)
    let row = /^\d+$/.test(ref) ? db.prepare('SELECT * FROM AssetWeapon WHERE id = ?').get(+ref) : null
    if (!row && ref.includes('/')) { const [p, ...r] = ref.split('/'); row = db.prepare('SELECT * FROM AssetWeapon WHERE pack = ? AND weaponId = ?').get(p, r.join('/')) }
    if (!row) { const rows = db.prepare('SELECT * FROM AssetWeapon WHERE weaponId = ?').all(ref); if (rows.length > 1) throw new Error(`"${ref}" is in several sources: ${rows.map((r) => `${r.pack}/${r.weaponId}`).join(', ')}`); row = rows[0] }
    if (!row) throw new Error(`no such asset: ${ref}`)
    return { ...row, data: JSON.parse(row.data) }
}
export function summary(db, { kind } = {}) {
    ready(db)
    return db.prepare(`SELECT pack, COUNT(*) AS weapons, SUM(pass) AS pass, CAST(AVG(score) AS INTEGER) AS avg_score, SUM(source='audit') AS audited FROM AssetWeapon ${kind ? 'WHERE kind = ?' : ''} GROUP BY pack ORDER BY pack`).all(...(kind ? [kind] : []))
}
export function kindCounts(db) {
    ready(db)
    return db.prepare('SELECT kind, COUNT(*) AS n, SUM(pass) AS pass FROM AssetWeapon GROUP BY kind ORDER BY kind').all()
}
export { setExtraRoots }
