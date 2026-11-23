// Lines of code (scc): the pure parts. No SQLite, no child processes, so the panel and the tests import it freely.
// The scan and the cache live in lib/loc.mjs; the panel only reads the cache (src/server/locRouter.ts).

/** Same exclusions as ~/loc.sh -s: build output and vendored code are not the project's code. */
export const LOC_EXCLUDE_DIRS = ['node_modules', 'vendor', '.godot', '.git']
export const LOC_NOT_MATCH = '\\.min\\.|package-lock'
export const sccArgs = (root) => ['--no-cocomo', '--format', 'json', '--exclude-dir', LOC_EXCLUDE_DIRS.join(','), '-M', LOC_NOT_MATCH, root]

export const EMPTY_STATS = Object.freeze({ code: 0, comments: 0, blanks: 0, total: 0, files: 0 })
const int = (v, what) => {
    const n = Number(v ?? 0)
    if (!Number.isFinite(n) || n < 0) throw new Error(`scc output: ${what} is not a count: ${JSON.stringify(v)}`)
    return Math.round(n)
}

/** Parse `scc --format json` (an array of language rows). Throws on anything else: no silent zeros. */
export function parseScc(text) {
    let rows
    try { rows = typeof text === 'string' ? JSON.parse(text) : text } catch (e) { throw new Error(`scc output is not JSON: ${e.message}`) }
    if (!Array.isArray(rows)) throw new Error('scc output is not a list of languages')
    const byLanguage = rows.map((r) => {
        const name = String(r?.Name ?? '')
        if (!name) throw new Error('scc output: a language row has no Name')
        return { name, files: int(r.Count, `${name} Count`), code: int(r.Code, `${name} Code`), comments: int(r.Comment, `${name} Comment`), blanks: int(r.Blank, `${name} Blank`) }
    }).sort((a, b) => b.code - a.code || a.name.localeCompare(b.name))
    const sum = byLanguage.reduce((t, l) => ({ code: t.code + l.code, comments: t.comments + l.comments, blanks: t.blanks + l.blanks, files: t.files + l.files }), { code: 0, comments: 0, blanks: 0, files: 0 })
    return { ...sum, total: sum.code + sum.comments + sum.blanks, byLanguage }
}

export const addStats = (a, b) => ({ code: a.code + b.code, comments: a.comments + b.comments, blanks: a.blanks + b.blanks, total: a.total + b.total, files: a.files + b.files })

/** Merge two language lists (by name), biggest code first. */
export function mergeLanguages(a, b) {
    const m = new Map()
    for (const l of [...a, ...b]) {
        const c = m.get(l.name) ?? { name: l.name, files: 0, code: 0, comments: 0, blanks: 0 }
        c.files += l.files; c.code += l.code; c.comments += l.comments; c.blanks += l.blanks
        m.set(l.name, c)
    }
    return [...m.values()].sort((x, y) => y.code - x.code || x.name.localeCompare(y.name))
}

/** '/'-joined folder names from the root down; '' for no folder. */
export function folderPath(folders, id) {
    const by = new Map(folders.map((f) => [f.id, f]))
    const parts = []
    for (let cur = id == null ? null : by.get(id), guard = 0; cur && guard < 1000; cur = cur.parentId == null ? null : by.get(cur.parentId), guard++) parts.unshift(cur.name)
    return parts.join('/')
}

/**
 * Roll the project stats up the folder tree. folders: [{id, parentId}], projects: [{id, folderId}],
 * stats: Map<projectId, {code, comments, blanks, total, files, byLanguage}>.
 * Returns Map<folderId, {...totals, projects, byLanguage}> where every folder includes all its descendants
 * (projects without stats count as nothing; `projects` counts only those that have stats).
 */
export function rollup(folders, projects, stats) {
    const kids = new Map()
    for (const f of folders) { const k = kids.get(f.parentId ?? null) ?? []; k.push(f.id); kids.set(f.parentId ?? null, k) }
    const own = new Map()
    for (const p of projects) { if (p.folderId == null || !stats.has(p.id)) continue; const l = own.get(p.folderId) ?? []; l.push(stats.get(p.id)); own.set(p.folderId, l) }
    const out = new Map()
    const walk = (id, seen) => {
        if (out.has(id)) return out.get(id)
        if (seen.has(id)) throw new Error(`folder cycle at ${id}`)
        seen.add(id)
        let t = { ...EMPTY_STATS, projects: 0, byLanguage: [] }
        for (const s of own.get(id) ?? []) t = { ...addStats(t, s), projects: t.projects + 1, byLanguage: mergeLanguages(t.byLanguage, s.byLanguage ?? []) }
        for (const k of kids.get(id) ?? []) { const c = walk(k, seen); t = { ...addStats(t, c), projects: t.projects + c.projects, byLanguage: mergeLanguages(t.byLanguage, c.byLanguage) } }
        seen.delete(id)
        out.set(id, t)
        return t
    }
    for (const f of folders) walk(f.id, new Set())
    return out
}

export const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10)

/**
 * What to do with a project, given its newest cached row (or null) and the current git sha ('' when not a repo):
 *  'scan'     no cache, --force, a new sha, or (no sha to compare) the cache is older than staleMs
 *  'snapshot' same sha, but the cache is from an earlier UTC day: record today's point without running scc
 *  'skip'     nothing to do
 */
export function decide(latest, sha, { force = false, now = Date.now(), staleMs = 24 * 3600_000 } = {}) {
    if (force || !latest) return 'scan'
    if (sha && latest.sha !== sha) return 'scan'
    if (!sha && now - latest.scannedAt >= staleMs) return 'scan'
    return utcDay(latest.scannedAt) < utcDay(now) ? 'snapshot' : 'skip'
}

const CH_TS = (ms) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '')
/** loc_history rows (the column set of deploy/clickhouse/schema.sql). */
export function historyRow(ts, { project = '', folderPath: fp = '', type }, s, sha = '') {
    if (type !== 'project' && type !== 'folder') throw new Error(`loc_history type must be project or folder, got "${type}"`)
    return { ts: CH_TS(ts), project, folder_path: fp, type, code: s.code, comments: s.comments, blanks: s.blanks, total: s.total, files: s.files, sha }
}

/** All rows for one run: a project row for each changed project, plus a roll-up row for every folder that has code. */
export function historyRows(ts, changed, folders, rolled) {
    const rows = changed.map((c) => historyRow(ts, { project: c.slug, folderPath: folderPath(folders, c.folderId), type: 'project' }, c.stats, c.sha))
    for (const f of folders) { const r = rolled.get(f.id); if (r && r.files) rows.push(historyRow(ts, { folderPath: folderPath(folders, f.id), type: 'folder' }, r)) }
    return rows
}

/** Compact count: 1234 -> 1.2k, 2_500_000 -> 2.5M. The full value belongs in a title tooltip. */
export function compact(n) {
    const v = Number(n)
    if (!Number.isFinite(v)) return '-'
    const a = Math.abs(v)
    const f = (x, u) => `${x >= 100 ? Math.round(x) : Math.round(x * 10) / 10}${u}`
    if (a < 1000) return String(Math.round(v))
    if (a < 1e6) return f(v / 1e3, 'k')
    if (a < 1e9) return f(v / 1e6, 'M')
    return f(v / 1e9, 'B')
}
