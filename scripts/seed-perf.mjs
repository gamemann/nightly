// Seed the PERFORMANCE tab from a directory of dot-profiler logs:  node scripts/seed-perf.mjs [dir] [--dry-run]
// Layout: <dir>/profile-*.json (game from the report's context.game, else "fc"), <dir>/<game>/profile-*.json. Tolerant: files that are
// not reports are skipped with a note. Re-running skips files already imported (source "seed <path>").
import '../lib/env.mjs'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import * as S from '../lib/store.mjs'
import * as P from '../lib/perf.mjs'
import * as PS from '../lib/perf-store.mjs'

const args = process.argv.slice(2)
const dry = args.includes('--dry-run')
const root = args.find((a) => !a.startsWith('--')) ?? path.join(process.env.HOME ?? '', 'perf-logs')
const GAMES = {
    fc: { name: 'Fatal Contact', repo: 'fc-game', engine: 'godot', budgets: ['fps>=60@platform=native,role=client', 'frame_ms_p95<=16.7@platform=native,role=client', 'tick_ms_p95<=16.7@role=server'] },
    playlot: { name: 'Playlot', repo: 'playlot', engine: 'godot', budgets: ['fps>=60@platform=native,role=client'] },
    zz: { name: 'ZZ', repo: 'zz', engine: 'godot', budgets: ['fps>=60@platform=native,role=client'] },
}
const db = S.open()
PS.migrate(db)
const stamp = (f) => { const m = /(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)/.exec(f); return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z` : undefined }
const files = []
const walk = (d, game) => {
    for (const n of readdirSync(d).sort()) {
        const f = path.join(d, n)
        if (statSync(f).isDirectory()) { if (!['external', 'asdasd'].includes(n)) walk(f, n); continue }
        if (/\.json$/.test(n) && !/export|package/.test(n)) files.push({ f, game })
    }
}
walk(root, undefined)
let ok = 0, skipped = 0, dup = 0
for (const { f, game: dir } of files) {
    const source = `seed ${path.relative(root, f)}`
    try {
        const text = readFileSync(f, 'utf8')
        const parsed = P.parseAny(text, f)
        const game = dir && GAMES[dir] ? dir : parsed.run.game && GAMES[parsed.run.game] ? parsed.run.game : dir ?? 'fc'
        if (db.prepare('SELECT 1 FROM PerfRun WHERE source = ?').get(source)) { dup++; continue }
        if (dry) { ok++; continue }
        if (!PS.getGame(db, game)) PS.saveGame(db, { slug: game, ...(GAMES[game] ?? { name: game }) })
        PS.ingest(db, parsed, { game, ranAt: parsed.run.ranAt || stamp(f), source, raw: text, noFindings: true })
        ok++
    } catch (e) { skipped++; console.error(`skip ${source}: ${e.message}`) }
}
console.log(`${dry ? 'would import' : 'imported'} ${ok}, already there ${dup}, skipped ${skipped}`)
