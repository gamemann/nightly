// Lines of code for every project (`nightly loc`), on node:sqlite. The panel never opens node:sqlite: it reads the LocStat
// cache through Prisma and starts a rescan by shelling out to `nightly loc --json`.
//
//  - scc does the counting (setting sccPath, env NIGHTLY_SCC, then PATH, then ~/bin/scc and /usr/local/bin/scc). Missing -> an error, never zeros.
//  - LocStat (SQLite) gets one row per scan; the newest row of a project is the cache. A scan runs only when the git HEAD sha
//    changed (or --force); an unchanged project gets one snapshot row per UTC day, which keeps the history chart continuous.
//  - loc_history (ClickHouse, created by lib/bootstrap.mjs from deploy/clickhouse/schema.sql) mirrors every row, plus the folder
//    roll-ups. ClickHouse down = a logged warning; the cache and the UI do not depend on it.
import { accessSync, constants, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import * as S from './store.mjs'
import { ensure } from './accounts.mjs'
import { listFolders, listProjects } from './projects.mjs'
import { chConfigFrom } from './usage-store.mjs'
import { chInsert } from './usage-ch.mjs'
import { addStats, compact, decide, folderPath, historyRows, parseScc, rollup, sccArgs } from './loc-core.mjs'

export const LOC_SETTINGS = {
    sccPath: '',          // path of the scc binary; blank = env NIGHTLY_SCC, then PATH, then ~/bin/scc
    locRefreshHours: 24,  // `nightly tick` rescans changed projects when the cache is older than this; 0 = only by hand
}

const executable = (f) => { try { accessSync(f, constants.X_OK); return true } catch { return false } }
const onPath = (name, env) => (env.PATH ?? '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, name)).find(executable)

/** Where scc is. Throws with everything it tried when it is nowhere: a missing counter must not turn into zeros. */
export function resolveScc(db, env = process.env) {
    const tried = []
    const pick = (label, f) => { if (!f) return null; tried.push(`${label}: ${f}`); return executable(f) ? f : null }
    const found = pick('setting sccPath', S.getSetting(db, 'sccPath')) || pick('env NIGHTLY_SCC', env.NIGHTLY_SCC) || onPath('scc', env)
        || pick('~/bin/scc', path.join(env.HOME || os.homedir(), 'bin', 'scc')) || pick('/usr/local/bin/scc', '/usr/local/bin/scc')
    if (!found) throw new Error(`scc not found (tried ${tried.join(', ') || 'nothing'}, PATH); install it or set: nightly set-setting sccPath /path/to/scc  (or env NIGHTLY_SCC)`)
    return found
}

export function runScc(scc, root) {
    if (!existsSync(root)) throw new Error(`path ${root} does not exist`)
    const r = spawnSync(scc, sccArgs(root), { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 10 * 60_000 })
    if (r.error) throw new Error(`scc failed to run (${scc}): ${r.error.message}`)
    if (r.status !== 0) throw new Error(`scc exited ${r.status} on ${root}: ${(r.stderr || '').trim().slice(0, 300)}`)
    return parseScc(r.stdout)
}

/** HEAD sha of the repository at root, '' when it is not a git checkout. */
export function headSha(root) {
    const r = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
    return r.status === 0 ? r.stdout.trim() : ''
}

export function ensureLoc(db) {
    ensure(db)
    db.exec(`CREATE TABLE IF NOT EXISTS "LocStat" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "projectId" INTEGER NOT NULL, "scannedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "code" INTEGER NOT NULL DEFAULT 0, "comments" INTEGER NOT NULL DEFAULT 0, "blanks" INTEGER NOT NULL DEFAULT 0, "total" INTEGER NOT NULL DEFAULT 0, "files" INTEGER NOT NULL DEFAULT 0,
  "byLanguage" TEXT NOT NULL DEFAULT '[]', "sha" TEXT NOT NULL DEFAULT '', CONSTRAINT "LocStat_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE);
CREATE INDEX IF NOT EXISTS "LocStat_projectId_scannedAt_idx" ON "LocStat"("projectId", "scannedAt");`)
}

const fromRow = (r) => ({ ...r, scannedAt: Date.parse(r.scannedAt), byLanguage: JSON.parse(r.byLanguage || '[]') })

/** The newest LocStat row of every project: Map<projectId, row with scannedAt in ms and byLanguage parsed>. */
export function latestStats(db) {
    ensureLoc(db)
    const rows = db.prepare('SELECT * FROM LocStat WHERE id IN (SELECT MAX(id) FROM LocStat GROUP BY projectId)').all()
    return new Map(rows.map((r) => [r.projectId, fromRow(r)]))
}

/** One project: decide (scan / snapshot / skip) and write the cache row. Returns { slug, action, stats?, sha } (error in `error`). */
export function refreshProject(db, p, { force = false, now = Date.now(), getScc, sha, run = runScc } = {}) {
    ensureLoc(db)
    if (!p.repoPath) return { slug: p.slug, action: 'skip', skipped: 'no repoPath', projectId: p.id, folderId: p.folderId }
    const cur = sha ?? headSha(p.repoPath)
    const last = db.prepare('SELECT * FROM LocStat WHERE projectId = ? ORDER BY id DESC LIMIT 1').get(p.id)
    const latest = last ? fromRow(last) : null
    const action = decide(latest, cur, { force, now, staleMs: Math.max(1, Number(S.getSetting(db, 'locRefreshHours') ?? LOC_SETTINGS.locRefreshHours) || 24) * 3600_000 })
    const base = { slug: p.slug, projectId: p.id, folderId: p.folderId, sha: cur, action }
    if (action === 'skip') return { ...base, stats: latest }
    const stats = action === 'scan' ? run((getScc ?? (() => resolveScc(db)))(), p.repoPath) : latest
    db.prepare('INSERT INTO LocStat (projectId, scannedAt, code, comments, blanks, total, files, byLanguage, sha) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(p.id, new Date(now).toISOString(), stats.code, stats.comments, stats.blanks, stats.total, stats.files, JSON.stringify(stats.byLanguage), cur)
    return { ...base, stats }
}

/** Per-project totals plus folder roll-ups from the cache. */
export function overview(db) {
    ensureLoc(db)
    const folders = listFolders(db), projects = listProjects(db), latest = latestStats(db)
    const rolled = rollup(folders, projects, latest)
    const total = [...latest.values()].reduce((t, s) => addStats(t, s), { code: 0, comments: 0, blanks: 0, total: 0, files: 0 })
    return {
        projects: projects.map((p) => ({ slug: p.slug, name: p.name, folder: folderPath(folders, p.folderId), stats: latest.get(p.id) ?? null })),
        folders: folders.map((f) => ({ id: f.id, path: folderPath(folders, f.id), stats: rolled.get(f.id) ?? null })),
        total,
    }
}

/**
 * Refresh a set of projects, then mirror what changed to ClickHouse. `projects` are Project rows.
 * ch: false skips ClickHouse (--no-ch); a ClickHouse failure is returned in `chError`, never thrown.
 */
export async function refresh(db, projects, { force = false, ch = true, now = Date.now(), fetchImpl, run = runScc } = {}) {
    ensureLoc(db)
    let scc = null
    const getScc = () => (scc ??= run !== runScc ? 'injected' : resolveScc(db))
    const results = []
    for (const p of projects) {
        try { results.push(refreshProject(db, p, { force, now, getScc, run })) } catch (e) {
            if (/scc not found/.test(e.message)) throw e
            results.push({ slug: p.slug, projectId: p.id, folderId: p.folderId, action: 'error', error: e.message })
        }
    }
    const changed = results.filter((r) => r.action === 'scan' || r.action === 'snapshot')
    let chError = null, chRows = 0
    if (ch && changed.length) {
        try {
            const cfg = chConfigFrom(db)
            if (cfg.enabled) {
                const folders = listFolders(db)
                const rolled = rollup(folders, listProjects(db), latestStats(db))
                const rows = historyRows(now, changed.map((r) => ({ slug: r.slug, folderId: r.folderId, stats: r.stats, sha: r.sha })), folders, rolled)
                chRows = await chInsert(cfg, 'loc_history', rows, { fetchImpl })
            }
        } catch (e) { chError = e.message; console.error(`loc: clickhouse history not written (${chError}); the SQLite cache is up to date`) }
    }
    return { results, scanned: results.filter((r) => r.action === 'scan').length, snapshots: results.filter((r) => r.action === 'snapshot').length, errors: results.filter((r) => r.action === 'error').length, chRows, chError }
}

/** `nightly tick` hook: refresh changed projects every locRefreshHours (0 = never). Returns log lines. */
export async function tickHook(db, now = Date.now()) {
    const every = Number(S.getSetting(db, 'locRefreshHours') ?? LOC_SETTINGS.locRefreshHours)
    if (!Number.isFinite(every) || every < 0) throw new Error(`setting locRefreshHours must be a number >= 0, got "${S.getSetting(db, 'locRefreshHours')}"`)
    if (!every) return []
    const last = Date.parse(S.getSetting(db, 'locLastRunAt') ?? '')
    if (Number.isFinite(last) && now - last < every * 3600_000) return []
    const r = await refresh(db, listProjects(db).filter((p) => !p.archived), { now })
    S.setSetting(db, 'locLastRunAt', new Date(now).toISOString())
    return [`loc: ${r.scanned} scanned, ${r.snapshots} snapshots, ${r.errors} errors${r.chError ? `, clickhouse: ${r.chError}` : ''}`]
}

export const fmt = (s) => (s ? `${compact(s.code)} code  ${compact(s.comments)} comments  ${compact(s.blanks)} blank  ${compact(s.total)} total  ${compact(s.files)} files` : 'not scanned')

export const LOC_HELP = `  loc [PROJECT | --all] [--folder F] [--force] [--no-ch] [--json]   lines of code (scc): scan the project path(s), cache in the database (rescans only when the git HEAD changed, or --force),
      mirror to ClickHouse loc_history; with no project, print the cached overview with folder roll-ups. scc: setting sccPath | env NIGHTLY_SCC | PATH | ~/bin/scc; tick rescans every locRefreshHours (default 24, 0 = never)`

export async function runLocCommand({ db, pos, opt, out, die }) {
    ensureLoc(db)
    const slug = pos.shift()
    const targets = slug ? [listProjects(db, {}).find((p) => p.slug === slug) ?? die(`no project "${slug}" (nightly project list)`)]
        : opt.all || opt.folder ? listProjects(db, { folder: opt.folder }).filter((p) => !p.archived) : []
    if (targets.length) {
        const r = await refresh(db, targets, { force: !!opt.force, ch: !opt.noCh })
        const view = { ...r, ...overview(db) }
        return out(view, () => r.results.map((x) => `${x.slug.padEnd(28)} ${x.action.padEnd(8)} ${x.error ?? x.skipped ?? fmt(x.stats)}`).join('\n') + (r.chError ? `\nclickhouse: ${r.chError}` : ''))
    }
    const o = overview(db)
    return out(o, () => [`TOTAL  ${fmt(o.total)}`, ...o.folders.map((f) => `${('[' + f.path + ']').padEnd(30)} ${fmt(f.stats)}`), ...o.projects.map((p) => `${p.slug.padEnd(30)} ${fmt(p.stats)}`)].join('\n'))
}
