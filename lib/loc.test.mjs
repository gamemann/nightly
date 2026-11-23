import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { createFolder, createProject } from './projects.mjs'
import { ensure } from './accounts.mjs'
import { setSetting } from './store.mjs'
import { chSchemaStatements } from './usage-store.mjs'
import { compact, decide, historyRow, historyRows, parseScc, rollup, sccArgs, utcDay } from './loc-core.mjs'
import { latestStats, refresh, refreshProject, resolveScc } from './loc.mjs'

const SCC = JSON.stringify([
    { Name: 'GDScript', Count: 3, Code: 100, Comment: 20, Blank: 10, Lines: 130 },
    { Name: 'Rust', Count: 2, Code: 50, Comment: 5, Blank: 5, Lines: 60 },
])
const stat = (code, files = 1) => ({ code, comments: 0, blanks: 0, total: code, files, byLanguage: [{ name: 'X', files, code, comments: 0, blanks: 0 }] })

test('parseScc sums languages and keeps the breakdown', () => {
    const s = parseScc(SCC)
    assert.deepEqual([s.code, s.comments, s.blanks, s.total, s.files], [150, 25, 15, 190, 5])
    assert.deepEqual(s.byLanguage.map((l) => l.name), ['GDScript', 'Rust'])
    assert.equal(parseScc('[]').total, 0)
})

test('parseScc rejects non-JSON instead of returning zeros', () => {
    assert.throws(() => parseScc('scc: boom'))
})

test('sccArgs excludes the same directories as loc.sh and ends with the root', () => {
    const a = sccArgs('/x/y')
    assert.equal(a[a.length - 1], '/x/y')
    assert.ok(a.join(' ').includes('node_modules'))
})

test('rollup adds projects to every ancestor folder', () => {
    const folders = [{ id: 1, parentId: null }, { id: 2, parentId: 1 }, { id: 3, parentId: null }]
    const projects = [{ id: 10, folderId: 2 }, { id: 11, folderId: 1 }, { id: 12, folderId: null }, { id: 13, folderId: 3 }]
    const r = rollup(folders, projects, new Map([[10, stat(100, 2)], [11, stat(10)], [12, stat(1000)]]))
    assert.equal(r.get(2).code, 100)
    assert.equal(r.get(1).code, 110)
    assert.equal(r.get(1).files, 3)
    assert.equal(r.get(1).projects, 2)
    assert.equal(r.get(3).code, 0, 'an unscanned folder is zero, not missing')
})

test('rollup refuses a folder cycle', () => {
    assert.throws(() => rollup([{ id: 1, parentId: 2 }, { id: 2, parentId: 1 }], [], new Map()), /cycle/)
})

test('decide: scan on no cache, force or new sha; snapshot on a new day; else skip', () => {
    const t = Date.parse('2026-11-23T12:00:00Z')
    const same = { sha: 'a', scannedAt: t - 3600_000 }
    assert.equal(decide(null, 'a', { now: t }), 'scan')
    assert.equal(decide(same, 'a', { now: t, force: true }), 'scan')
    assert.equal(decide(same, 'b', { now: t }), 'scan')
    assert.equal(decide(same, 'a', { now: t }), 'skip')
    assert.equal(decide({ sha: 'a', scannedAt: t - 24 * 3600_000 }, 'a', { now: t }), 'snapshot')
    assert.equal(decide({ sha: '', scannedAt: t - 3600_000 }, '', { now: t }), 'skip')
    assert.equal(decide({ sha: '', scannedAt: t - 25 * 3600_000 }, '', { now: t }), 'scan', 'no git: fall back to age')
    assert.equal(utcDay(t), '2026-11-23')
})

test('compact formats counts', () => {
    assert.deepEqual([0, 999, 1234, 15_000, 2_500_000].map(compact), ['0', '999', '1.2k', '15k', '2.5M'])
})

test('historyRow and historyRows match the loc_history columns', () => {
    const cols = readFileSync(new URL('../deploy/clickhouse/schema.sql', import.meta.url), 'utf8').match(/loc_history\s*\(([\s\S]*?)\)\s*ENGINE/)[1].split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean)
    const ts = Date.parse('2026-11-23T01:02:03.456Z')
    const r = historyRow(ts, { project: 'p', folderPath: 'A / B', type: 'project' }, stat(5), 'abc')
    assert.deepEqual(Object.keys(r).sort(), [...cols].sort())
    assert.equal(r.ts, '2026-11-23 01:02:03.456')
    assert.throws(() => historyRow(ts, { type: 'nope' }, stat(1)))
    const folders = [{ id: 1, parentId: null, name: 'A' }, { id: 2, parentId: 1, name: 'B' }]
    const rolled = rollup(folders, [{ id: 7, folderId: 2 }], new Map([[7, stat(9)]]))
    const rows = historyRows(ts, [{ slug: 'p', folderId: 2, stats: stat(9), sha: 's' }], folders, rolled)
    assert.deepEqual(rows.map((x) => `${x.type}:${x.project || x.folder_path}`), ['project:p', 'folder:A', 'folder:A/B'])
})

test('chSchemaStatements: loc_history is in the bootstrap list, db substituted', () => {
    const sql = readFileSync(new URL('../deploy/clickhouse/schema.sql', import.meta.url), 'utf8')
    const stmts = chSchemaStatements(sql, 'scratch_db')
    const loc = stmts.find((s) => /loc_history/.test(s))
    assert.ok(loc, 'loc_history statement present')
    assert.match(loc, /^CREATE TABLE IF NOT EXISTS scratch_db\.loc_history/)
    assert.ok(!stmts.some((s) => s.includes('{db}')))
})

function fixture() {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE Setting (key TEXT NOT NULL PRIMARY KEY, value TEXT NOT NULL)')
    ensure(db)
    createFolder(db, { name: 'Games' })
    const a = createProject(db, { slug: 'a', type: 'game', folder: 'Games', repoPath: '/tmp/a' })
    const b = createProject(db, { slug: 'b', type: 'game', repoPath: '' })
    return { db, a, b }
}

test('cache invalidation by sha: same sha skips, new sha rescans, force rescans', () => {
    const { db, a } = fixture()
    let runs = 0
    const run = () => { runs++; return parseScc(SCC) }
    const go = (o) => refreshProject(db, a, { getScc: () => 'scc', run, ...o })
    const t = Date.parse('2026-11-23T10:00:00Z')
    assert.equal(go({ sha: 'one', now: t }).action, 'scan')
    assert.equal(go({ sha: 'one', now: t + 1000 }).action, 'skip')
    assert.equal(runs, 1)
    assert.equal(go({ sha: 'two', now: t + 2000 }).action, 'scan')
    assert.equal(go({ sha: 'two', now: t + 3000, force: true }).action, 'scan')
    assert.equal(runs, 3)
    assert.equal(go({ sha: 'two', now: t + 86_400_000 }).action, 'snapshot', 'next UTC day, same sha: a history point without scc')
    assert.equal(runs, 3)
    const n = db.prepare('SELECT COUNT(*) n FROM LocStat WHERE projectId = ?').get(a.id).n
    assert.equal(n, 4)
    assert.equal(latestStats(db).get(a.id).code, 150)
})

test('refresh writes history through chInsert and survives an unreachable ClickHouse', async () => {
    const { db, a, b } = fixture()
    setSetting(db, 'usageChEnabled', 'true')
    const calls = []
    const ok = async (url, init) => { calls.push({ url, body: init.body }); return new Response('', { status: 200 }) }
    const r = await refresh(db, [a, b], { run: () => parseScc(SCC), fetchImpl: ok, now: Date.parse('2026-11-23T10:00:00Z') })
    assert.equal(r.scanned, 1, 'b has no repoPath and is skipped')
    assert.equal(r.chError, null)
    assert.ok(r.chRows >= 2)
    assert.match(decodeURIComponent(calls[0].url.replace(/\+/g, ' ')), /INSERT INTO nightly_usage\.loc_history FORMAT JSONEachRow/)
    const down = async () => { throw new Error('connect ECONNREFUSED') }
    const r2 = await refresh(db, [a], { run: () => parseScc(SCC), force: true, fetchImpl: down })
    assert.equal(r2.scanned, 1)
    assert.match(r2.chError, /unreachable/)
    assert.equal(latestStats(db).get(a.id).files, 5, 'the SQLite cache is written even when ClickHouse is down')
})

test('a missing scc fails loudly, never zeros', async () => {
    const { db, a } = fixture()
    assert.throws(() => resolveScc(db, { PATH: '/nonexistent', HOME: '/nonexistent', NIGHTLY_SCC: '/nonexistent/scc' }), /scc not found/)
    // injected run bypasses resolution; with the real runner and no scc a refresh must throw, not record zeros
    const saved = process.env.NIGHTLY_SCC, path = process.env.PATH, home = process.env.HOME
    process.env.NIGHTLY_SCC = '/nonexistent/scc'; process.env.PATH = '/nonexistent'; process.env.HOME = '/nonexistent'
    try {
        if (!existsSync('/usr/local/bin/scc')) await assert.rejects(refresh(db, [a], { ch: false }), /scc not found/)
    } finally { process.env.NIGHTLY_SCC = saved ?? ''; process.env.PATH = path; process.env.HOME = home }
    assert.equal(latestStats(db).size, 0)
})
