// RSI board, the database side (CLI, node:sqlite). Detect -> judge -> fix -> remeasure for every asset domain:
//  * `syncDoc` turns an audit document (rsi_asset_audit.py, schema rsi-assets/1) into findings: one per failing flag, created
//    when the flag appears and closed (state remeasured, with the score before and after) when the audit no longer raises it.
//  * `refresh` runs the audit tool for each texture tier, ingests the result and syncs the findings; `maybeRefresh` is the
//    scheduled call from `tick`, so nobody runs `assets ingest` by hand.
//  * Every finding carries its next action; a pack with open findings gets a fix item (rsi-assets-<pack>) queued for agents.
// The process side (stale / duplicate / blocked items) is lib/rsi-blockers.mjs.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as S from './store.mjs'
import * as AS from './assets.mjs'
import { syncBlockers } from './rsi-blockers.mjs'
import { syncMaps } from './rsi-maps.mjs'
import { AUDIT_DIR, GODOT_ROOT } from './assets-files.mjs'

export const SETTINGS = {
    rsiRefreshHours: 6,          // audit refresh interval in hours, 0 = never auto-refresh
    rsiTiers: 'low,medium,high', // video-settings texture tiers the audit judges; the last one is the one stored on the asset rows
    rsiAuditScript: '',          // path to rsi_asset_audit.py; empty = NIGHTLY_RSI_AUDIT, then dot-game/tools, then the nightly/rsi-assets-audit branch
    rsiAuditDir: '',             // audit output dir; empty = NIGHTLY_ASSETS_DIR, then <checkout>/data/rsi-assets (the panel serves NIGHTLY_ASSETS_DIR or the default only)
    rsiMeshBudget: 600,          // maps auditor: visible mesh instances over this raise MESH_OVER_BUDGET, 0 = off
    rsiAlphaBoxBudget: 50,       // maps auditor: alpha-blended BoxMesh instances over this raise ALPHA_BOXES, 0 = off
    rsiCensusDir: '/home/gamedev/perf-bench', // where perf_bench --mesh-census logs (*-playlot-draws-bench*.log) are written
    rsiStaleDays: 30,            // an open, untouched item older than this is stale (non-owner items are closed), 0 = off
}
export const SETTING_KEYS = Object.keys(SETTINGS)
export const setting = (db, k) => { const v = S.getSetting(db, k); return v == null ? SETTINGS[k] : typeof SETTINGS[k] === 'number' ? Number(v) : v }

const MIGRATION = path.join(S.ROOT, 'prisma', 'migrations', '20261124000000_rsi_findings', 'migration.sql')
export function ensure(db) {
    const sql = readFileSync(MIGRATION, 'utf8').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    for (const st of sql.split(/;\s*(?:\n|$)/).map((x) => x.trim()).filter(Boolean)) db.exec(st)
}

/** The board domain of an audit flag. Texture flags are judged per video-settings tier. */
export function domainOf(code) {
    if (/TEX|NORMAL|ORM/.test(code) && !/^NO_MODEL/.test(code)) return 'textures'
    if (/CLIP|MAG|ANIM|ARMS|BOLT|CYCLE/.test(code)) return 'animations'
    if (/SOUND/.test(code)) return 'sounds'
    return 'weapons'
}

const ACTIONS = [
    [/^(VERY_)?LOW_TRIS$/, 'Remodel with bevels and separate materials up to the triangle target (fix agent, free/own assets only)'],
    [/^FACETED$|^PRIMITIVE_/, 'Rebuild the mesh with smooth normals / real shape instead of primitives'],
    [/^NO_MODEL$/, 'Add or fix the model file in the pack, then re-run the audit'],
    [/^FEW_MATERIALS$/, 'Split the mesh into separate materials (body, metal, grip, glass)'],
    [/^LOSSY_TEX$/, 'Raise the import quality for this tier (lossless, VRAM or BasisU) within the pack size limit'],
    [/^LOW_TEX$|^NO_TEXTURES$/, 'Bake or author textures at the tier target size (tools/tex_pipeline.sh)'],
    [/^FLAT_TEX$/, 'Rebake the albedo with wear and detail so it is not near-flat'],
    [/TEX|NORMAL|ORM/, 'Fix the texture set (power-of-two sizes, normal and roughness/metallic maps)'],
    [/BOLT|CYCLE/, 'Add the bolt cycle clip to the model or procedural reload, then check the GPU filmstrip'],
    [/MAG_STATIC|NO_MAG|STATIC_CLIP|CLIP/, 'Animate the clip (magazine travels in reload) and check the GPU filmstrip'],
    [/SOUND/, 'Add free/own sound files named after the weapon id'],
]
export const nextActionFor = (code) => ACTIONS.find(([re]) => re.test(code))?.[1] ?? 'Fix in the asset, then re-run the audit (nightly assets refresh)'

const nowIso = () => new Date().toISOString()
const push = (hist, ev) => JSON.stringify([...JSON.parse(hist || '[]'), ev].slice(-20))

/** Create or update the finding for one raised flag. */
export function raise(db, f, t) {
    const old = db.prepare('SELECT * FROM RsiFinding WHERE subject = ? AND code = ? AND tier = ?').get(f.subject, f.code, f.tier)
    if (!old) {
        db.prepare('INSERT INTO RsiFinding (domain, subject, assetId, code, tier, severity, msg, nextAction, state, status, beforeScore, afterScore, itemKey, firstSeenAt, lastSeenAt, history) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
            .run(f.domain, f.subject, f.assetId ?? null, f.code, f.tier, f.severity, f.msg, f.nextAction, 'found', 'open', f.score, f.score, f.itemKey, t, t, '[]')
        return 'added'
    }
    const reopened = old.status === 'resolved'
    db.prepare('UPDATE RsiFinding SET domain=?, assetId=?, severity=?, msg=?, nextAction=?, state=?, status=\'open\', afterScore=?, itemKey=?, lastSeenAt=?, beforeScore=?, fixedAt=?, history=? WHERE id=?')
        .run(f.domain, f.assetId ?? old.assetId, f.severity, f.msg, f.nextAction, 'found', f.score, f.itemKey || old.itemKey, t,
            reopened ? f.score : old.beforeScore, reopened ? null : old.fixedAt,
            reopened ? push(old.history, { regressed: t, fixedAt: old.fixedAt, before: old.beforeScore, after: old.afterScore }) : old.history, old.id)
    return reopened ? 'reopened' : 'updated'
}

/** Close findings of the audited subjects whose flag the audit no longer raises (remeasured). */
function settle(db, subjects, seen, tier, primary, t) {
    let closed = 0
    const open = db.prepare("SELECT * FROM RsiFinding WHERE status = 'open' AND domain != 'process'").all()
    for (const r of open) {
        if (!subjects.has(r.subject) || seen.has(`${r.subject}|${r.code}|${r.tier}`)) continue
        if (r.domain === 'textures' ? r.tier !== tier : !primary) continue
        const score = subjects.get(r.subject)
        db.prepare("UPDATE RsiFinding SET status='resolved', state='remeasured', afterScore=?, fixedAt=?, lastSeenAt=?, nextAction='Passes the audit: nothing to do', history=? WHERE id=?")
            .run(score, t, t, push(r.history, { remeasured: t, before: r.beforeScore, after: score }), r.id)
        closed++
    }
    return closed
}

/** Sync findings from an audit doc. `primary` = the tier whose run also judges the non-texture flags. */
export function syncDoc(db, doc, { tier = doc?.thresholds?.tier ?? 'high', primary = true } = {}) {
    ensure(db)
    const t = nowIso()
    const res = { added: 0, updated: 0, reopened: 0, closed: 0 }
    const subjects = new Map(), seen = new Set()
    db.exec('BEGIN')
    try {
        for (const w of doc.weapons ?? []) {
            const subject = `${w.pack}/${w.weapon_id}`
            subjects.set(subject, w.score ?? AS.scoreOf(w.flags ?? []))
            const row = db.prepare('SELECT id FROM AssetWeapon WHERE pack = ? AND weaponId = ?').get(w.pack, w.weapon_id)
            for (const fl of w.flags ?? []) {
                const domain = domainOf(fl.code)
                if (domain !== 'textures' && !primary) continue
                const ft = domain === 'textures' ? tier : ''
                seen.add(`${subject}|${fl.code}|${ft}`)
                res[raise(db, { domain, subject, assetId: row?.id, code: fl.code, tier: ft, severity: fl.severity, score: subjects.get(subject),
                    msg: fl.msg ?? '', nextAction: nextActionFor(fl.code), itemKey: `rsi-assets-${w.pack}` }, t)]++
            }
        }
        res.closed = settle(db, subjects, seen, tier, primary, t)
        db.exec('COMMIT')
    } catch (e) { db.exec('ROLLBACK'); throw e }
    return res
}

/** Queue (or refresh) one fix item per pack that has open asset findings, so fix agents are fed from the board. */
export function queueFixItems(db) {
    const rows = db.prepare("SELECT subject, code, tier, severity FROM RsiFinding WHERE status = 'open' AND domain NOT IN ('process', 'maps')").all()
    const byPack = new Map()
    for (const r of rows) { const p = r.subject.split('/')[0]; byPack.set(p, [...(byPack.get(p) ?? []), r]) }
    const made = []
    for (const [pack, fl] of byPack) {
        const key = `rsi-assets-${pack}`, it = S.getItem(db, key)
        const worst = db.prepare("SELECT subject, afterScore FROM RsiFinding WHERE status = 'open' AND subject LIKE ? GROUP BY subject ORDER BY afterScore LIMIT 5").all(`${pack}/%`)
        const body = `Auto-filed from the RSI board: ${fl.length} open findings in ${pack} (${fl.filter((x) => x.severity === 'error').length} errors). Worst: ${worst.map((w) => `${w.subject.split('/')[1]} ${Math.round(w.afterScore)}`).join(', ')}.\nSee /assets and the home board; re-run \`nightly assets refresh\` after each fix. Free/own assets only; no per-game forks.`
        if (!it) { S.addItem(db, { key, title: `RSI assets ${pack}: ${fl.length} open audit findings`, body, kind: 'task', addedBy: 'nightly', repos: pack, doneWhen: `audit: ${pack} has no open findings`, priority: 'bottom' }); made.push(key) }
        else if (it.status === 'done' || it.status === 'wontfix') { S.updateItem(db, key, { status: 'queue' }); S.addNote(db, key, `Reopened by the RSI board: the audit raises ${fl.length} findings again.`); made.push(key) }
    }
    return made
}

// ---------- audit tool ----------
function auditScript(db) {
    const cfg = setting(db, 'rsiAuditScript') || process.env.NIGHTLY_RSI_AUDIT
    if (cfg) return existsSync(cfg) ? cfg : null
    const repo = path.join(GODOT_ROOT(), 'dot-game')
    const main = path.join(repo, 'tools', 'rsi_asset_audit.py')
    if (existsSync(main)) return main
    for (const ref of ['nightly/rsi-assets-audit', 'origin/nightly/rsi-assets-audit']) {   // not merged yet: read it from the branch
        const r = spawnSync('git', ['-C', repo, 'show', `${ref}:tools/rsi_asset_audit.py`], { encoding: 'utf8', maxBuffer: 16 << 20 })
        if (r.status === 0 && r.stdout) {
            const f = path.join(mkdtempSync(path.join(tmpdir(), 'rsi-audit-')), 'rsi_asset_audit.py')
            writeFileSync(f, r.stdout)
            return f
        }
    }
    return null
}

function toolMissing(db, on) {
    const t = nowIso()
    const k = ['rsi-audit-tool', 'NO_AUDIT_TOOL', '']
    if (!on) { db.prepare("UPDATE RsiFinding SET status='resolved', state='remeasured', fixedAt=? WHERE subject=? AND code=? AND tier=? AND status='open'").run(t, ...k); return }
    const old = db.prepare('SELECT id FROM RsiFinding WHERE subject=? AND code=? AND tier=?').get(...k)
    const vals = ['process', k[0], k[1], 'error', 'rsi_asset_audit.py not found: the scheduled audit cannot run',
        'Merge dot-game nightly/rsi-assets-audit to main (tools/rsi_asset_audit.py; refresh prefers main and falls back to that branch) or set rsiAuditScript / NIGHTLY_RSI_AUDIT']
    if (old) db.prepare("UPDATE RsiFinding SET status='open', state='found', msg=?, nextAction=?, lastSeenAt=? WHERE id=?").run(vals[4], vals[5], t, old.id)
    else db.prepare('INSERT INTO RsiFinding (domain, subject, code, severity, msg, nextAction, firstSeenAt, lastSeenAt) VALUES (?,?,?,?,?,?,?,?)').run(vals[0], k[0], k[1], vals[3], vals[4], vals[5], t, t)
}

/** Run the audit for every tier, ingest the stored tier, sync findings, queue fix items. Returns a summary. */
export function refresh(db, { onLog = () => {} } = {}) {
    AS.ready(db); ensure(db)
    const script = auditScript(db)
    toolMissing(db, !script)
    if (!script) throw new Error('rsi_asset_audit.py not found (set rsiAuditScript or NIGHTLY_RSI_AUDIT)')
    const tiers = String(setting(db, 'rsiTiers')).split(',').map((x) => x.trim()).filter(Boolean)
    const out = setting(db, 'rsiAuditDir') || AUDIT_DIR()
    mkdirSync(out, { recursive: true })
    const sum = { tiers: {}, ingested: null, made: [] }
    tiers.forEach((tier, i) => {
        const last = i === tiers.length - 1
        const r = spawnSync('python3', ['-I', script, '--root', GODOT_ROOT(), '--out', out, '--tier', tier, ...(last ? [] : ['--no-glb'])], { encoding: 'utf8', timeout: 20 * 60_000, maxBuffer: 16 << 20 })
        if (r.status !== 0) throw new Error(`audit tier ${tier} failed: ${(r.stderr || r.stdout || '').trim().split('\n').pop()}`)
        const file = path.join(out, tier === 'high' ? 'audit.json' : `audit-${tier}.json`)
        const doc = JSON.parse(readFileSync(file, 'utf8'))
        onLog(`tier ${tier}: ${doc.summary?.weapons} weapons, ${doc.summary?.pass} pass`)
        if (last) sum.ingested = AS.ingestAudit(db, doc, { auditDir: out })
        sum.tiers[tier] = syncDoc(db, doc, { tier: doc.thresholds?.tier ?? tier, primary: last })
    })
    db.exec("UPDATE RsiFinding SET assetId = (SELECT id FROM AssetWeapon WHERE pack || '/' || weaponId = subject) WHERE assetId IS NULL AND domain != 'process'")
    sum.made = queueFixItems(db)
    sum.blockers = syncBlockers(db)
    sum.maps = syncMaps(db, { budget: setting(db, 'rsiMeshBudget'), alphaBudget: setting(db, 'rsiAlphaBoxBudget'), dir: setting(db, 'rsiCensusDir') })
    S.setSetting(db, 'rsiLastRefreshAt', nowIso())
    return sum
}

/** From `tick`: start a refresh detached when the last one is older than rsiRefreshHours. */
export function maybeRefresh(db, at = new Date()) {
    const hours = setting(db, 'rsiRefreshHours')
    if (!hours || AS.pending(db)) return null
    const last = S.getSetting(db, 'rsiLastRefreshAt')
    if (last && at - Date.parse(last) < hours * 3600_000) return null
    S.setSetting(db, 'rsiLastRefreshAt', at.toISOString())   // claim it, so overlapping ticks do not start two
    spawn(process.execPath, [path.join(S.ROOT, 'bin', 'nightly.mjs'), 'rsi', 'refresh'], { detached: true, stdio: 'ignore', env: process.env }).unref()
    return 'rsi audit refresh started'
}

/** From `tick`: the cheap process pass (stale / duplicate / blocked) at most every 30 minutes, then the audit refresh when due. */
export function tickHook(db, at = new Date()) {
    const lines = []
    const last = S.getSetting(db, 'rsiBlockersAt')
    if (!last || at - Date.parse(last) >= 30 * 60_000) {
        S.setSetting(db, 'rsiBlockersAt', at.toISOString())
        ensure(db)
        const r = syncBlockers(db)
        if (r.closed) lines.push(`rsi: ${r.closed} stale/duplicate items auto-closed`)
    }
    const m = maybeRefresh(db, at)
    if (m) lines.push(m)
    return lines
}

/** Plain-text board for the CLI: per domain, open findings (worst first) and resolved counts. */
export function board(db) {
    ensure(db)
    return db.prepare("SELECT domain, SUM(status='open') AS open, SUM(status='resolved') AS resolved FROM RsiFinding GROUP BY domain ORDER BY domain").all()
}
