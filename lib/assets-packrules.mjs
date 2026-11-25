// ASSETS: pack rules. Three things a source's files are judged against, all from AssetSource config (nothing hard-coded):
//   vendored copies   a game row whose file hash equals a pack row's is a copy of that pack's asset (a sync tool vendored it). It is
//                     attributed to the pack row (AssetWeapon.vendoredFrom = '<pack>/<weaponId>'), hidden from lists and counts, and
//                     never audited into findings: the pack row carries the score and the findings once.
//   allowedPacks      a game's config.allowedPacks lists the packs it may use. A pack named in ANY game's allowedPacks is "governed":
//                     a game copying a governed pack it does not list, or linking one in eventTable.linkedSources, raises
//                     PACK_NOT_ALLOWED. Packs no game governs (map packs, say) only attribute copies. No allowedPacks = no limit.
//   forbidPaths       regexes on a row's model path (config.forbidPaths of its source, plus the workspace setting assetForbidPaths,
//                     comma-separated); a match raises FORBIDDEN_PATH on the row (a vendored copy is judged through its pack row).
// judgePackRules is pure (tests); syncPackRules is the only DB writer and owns its two codes.
import * as AK from './assets-sources.mjs'
import { ensureColumns } from './asset-cols.mjs'
import * as S from './store.mjs'

export const CODES = ['PACK_NOT_ALLOWED', 'FORBIDDEN_PATH']
const NEXT = {
    PACK_NOT_ALLOWED: 'Remove the copy (or the link) from the game, or add the pack to the source\'s allowedPacks if the rule is wrong',
    FORBIDDEN_PATH: 'Delete the file from the repo (and anything that still loads it); widen forbidPaths only if the rule is wrong',
}

/** Compile forbid regexes; a bad one throws with its text so the config error is visible. */
export function compileForbid(list) {
    return (list ?? []).map((s) => String(s).trim()).filter(Boolean).map((s) => {
        try { return new RegExp(s, 'i') } catch (e) { throw new Error(`forbidPaths: bad regex ${s}: ${e.message}`) }
    })
}

/**
 * sources: [{name, type, config}]; rows: [{id, pack, weaponId, fileHash, path}].
 * -> {vendored: Map(rowId -> 'pack/weaponId'), violations: [{subject, pack, assetId, code, severity, msg}]}
 */
export function judgePackRules(sources, rows, { forbid = [] } = {}) {
    const byName = new Map(sources.map((s) => [s.name, s]))
    const isPack = (p) => byName.get(p)?.type === 'pack', isGame = (p) => byName.get(p)?.type === 'game'
    const allowedOf = (g) => (Array.isArray(byName.get(g)?.config?.allowedPacks) ? byName.get(g).config.allowedPacks : null)
    const governed = new Set(sources.filter((s) => s.type === 'game').flatMap((s) => allowedOf(s.name) ?? []))
    const packRows = new Map()                                     // hash -> pack rows, lowest id first
    for (const r of [...rows].sort((a, b) => a.id - b.id)) if (r.fileHash && isPack(r.pack)) packRows.set(r.fileHash, [...(packRows.get(r.fileHash) ?? []), r])
    const vendored = new Map(), violations = []
    const globalRe = compileForbid(forbid), forbidOf = new Map()
    const reOf = (p) => { if (!forbidOf.has(p)) forbidOf.set(p, [...globalRe, ...compileForbid(byName.get(p)?.config?.forbidPaths)]); return forbidOf.get(p) }
    for (const r of rows) {
        if (isGame(r.pack) && r.fileHash && packRows.has(r.fileHash)) {
            const allowed = allowedOf(r.pack), ok = (p) => !allowed || allowed.includes(p) || !governed.has(p)
            const cands = packRows.get(r.fileHash)
            const canon = cands.find((c) => allowed?.includes(c.pack)) ?? cands.find((c) => ok(c.pack))
            if (canon) { vendored.set(r.id, `${canon.pack}/${canon.weaponId}`); continue }
            const from = [...new Set(cands.map((c) => c.pack))]
            violations.push({ subject: `${r.pack}/${r.weaponId}`, pack: r.pack, assetId: r.id, code: 'PACK_NOT_ALLOWED', severity: 'high',
                msg: `copy of ${cands[0].pack}/${cands[0].weaponId}; ${from.join(', ')} not in ${r.pack}'s allowedPacks (${allowed.join(', ') || 'none'})` })
        }
        const hit = r.path && reOf(r.pack).find((re) => re.test(r.path))
        if (hit) violations.push({ subject: `${r.pack}/${r.weaponId}`, pack: r.pack, assetId: r.id, code: 'FORBIDDEN_PATH', severity: 'high', msg: `${r.path} matches forbidden ${hit.source}` })
    }
    for (const s of sources) {
        const allowed = s.type === 'game' ? allowedOf(s.name) : null
        if (!allowed) continue
        for (const p of s.config?.eventTable?.linkedSources ?? []) if (!allowed.includes(p))
            violations.push({ subject: `${s.name}/linkedSources/${p}`, pack: s.name, assetId: null, code: 'PACK_NOT_ALLOWED', severity: 'high',
                msg: `eventTable.linkedSources names ${p}; ${s.name}'s allowedPacks is ${allowed.join(', ') || 'empty'}` })
    }
    return { vendored, violations }
}

/** Subjects ('pack/weaponId') of vendored rows; empty when the column does not exist yet. */
export function vendoredSubjects(db) {
    if (!db.prepare("SELECT 1 FROM pragma_table_info('AssetWeapon') WHERE name='vendoredFrom'").get()) return new Set()
    return new Set(db.prepare("SELECT pack || '/' || weaponId s FROM AssetWeapon WHERE vendoredFrom != ''").all().map((r) => r.s))
}

const ROWS_SQL = `SELECT id, pack, weaponId, fileHash,
    COALESCE(NULLIF(json_extract(data,'$._files.glb'),''), NULLIF(json_extract(data,'$.model.glb'),''), '') path FROM AssetWeapon`

/** The workspace-wide forbid rules (setting assetForbidPaths, comma-separated). */
export const forbidSetting = (db) => String(S.getSetting(db, 'assetForbidPaths') ?? '').split(',')

/** Apply the rules: set vendoredFrom, raise / close PACK_NOT_ALLOWED and FORBIDDEN_PATH, resolve audit findings on vendored rows. */
export function syncPackRules(db, { forbid = forbidSetting(db), at = new Date() } = {}) {
    ensureColumns(db)
    const t = at.toISOString()
    const { vendored, violations } = judgePackRules(AK.list(db), db.prepare(ROWS_SQL).all(), { forbid })
    const res = { vendored: vendored.size, raised: 0, closed: 0, hidden: 0 }
    const codesIn = `(${CODES.map(() => '?').join(',')})`
    db.exec('BEGIN')
    try {
        const cur = new Map(db.prepare("SELECT id, vendoredFrom v FROM AssetWeapon WHERE vendoredFrom != ''").all().map((r) => [r.id, r.v]))
        const setV = db.prepare('UPDATE AssetWeapon SET vendoredFrom = ? WHERE id = ?')
        for (const id of cur.keys()) if (!vendored.has(id)) setV.run('', id)
        for (const [id, v] of vendored) if (cur.get(id) !== v) setV.run(v, id)
        const seen = new Set()
        for (const f of violations) {
            const key = `${f.subject}|${f.code}`
            if (seen.has(key)) continue
            seen.add(key)
            const old = db.prepare("SELECT id FROM RsiFinding WHERE subject = ? AND code = ? AND tier = ''").get(f.subject, f.code)
            if (!old) db.prepare("INSERT INTO RsiFinding (domain, subject, assetId, code, tier, severity, msg, nextAction, state, status, itemKey, firstSeenAt, lastSeenAt, history) VALUES ('models',?,?,?,'',?,?,?,'found','open',?,?,?,'[]')")
                .run(f.subject, f.assetId, f.code, f.severity, f.msg, NEXT[f.code], `rsi-assets-${f.pack}`, t, t)
            else db.prepare("UPDATE RsiFinding SET assetId=COALESCE(?, assetId), severity=?, msg=?, nextAction=?, status='open', state='found', lastSeenAt=?, fixedAt=NULL WHERE id=?")
                .run(f.assetId, f.severity, f.msg, NEXT[f.code], t, old.id)
            res.raised++
        }
        for (const r of db.prepare(`SELECT id, subject, code FROM RsiFinding WHERE status = 'open' AND code IN ${codesIn}`).all(...CODES)) {
            if (seen.has(`${r.subject}|${r.code}`)) continue
            db.prepare("UPDATE RsiFinding SET status='resolved', state='remeasured', fixedAt=?, lastSeenAt=?, nextAction='Rule passes: nothing to do' WHERE id=?").run(t, t, r.id)
            res.closed++
        }
        const vend = vendoredSubjects(db)
        for (const r of db.prepare(`SELECT id, subject FROM RsiFinding WHERE status = 'open' AND domain NOT IN ('process', 'maps') AND code NOT IN ${codesIn}`).all(...CODES)) {
            if (!vend.has(r.subject)) continue
            db.prepare("UPDATE RsiFinding SET status='resolved', state='vendored', fixedAt=?, lastSeenAt=?, nextAction='Vendored copy of a pack asset: judged on the pack row' WHERE id=?").run(t, t, r.id)
            res.hidden++
        }
        db.exec('COMMIT')
    } catch (e) { db.exec('ROLLBACK'); throw e }
    return res
}
