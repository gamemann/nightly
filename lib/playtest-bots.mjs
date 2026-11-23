// Bot playtests: one Playtest row per unattended bot run (tester "bots"). The row's facts are a fixed "key=value" line in text (and the tags),
// because the Playtest table is feedback-shaped (rating/tags/text): map, mode, bots, duration, result, crashes, tick/fps.
//   nightly playtest record --from-soak - --game G [--mode M] [--build B]   a game's `tools/soak.tscn` output (SOAK {json} line) on stdin
//   nightly playtest import-perf                                           perf runs with bots become bot playtests (history; idempotent)
import * as F from './feeds.mjs'

const TESTER = 'bots'
export const factsText = (f) => ['map', 'mode', 'bots', 'duration_s', 'result', 'crashes', 'avg_fps', 'tick_ms_mean', 'tick_ms_p95', 'kills', 'source']
    .filter((k) => f[k] !== undefined && f[k] !== '').map((k) => `${k}=${f[k]}`).join(' ') + (f.notes ? `\n${f.notes}` : '')

/** Parse the output of a game's bot soak (the `SOAK {json}` line plus the engine's crash dump marker). */
export function parseSoak(text) {
    const line = String(text).split('\n').find((l) => l.startsWith('SOAK {'))
    const crashed = /handle_crash: Program crashed|SCRIPT ERROR|Segmentation fault/.test(text)
    if (!line) return { result: 'no-report', crashes: crashed ? 1 : 0, notes: 'no SOAK line in the output (setup failed or the engine died)' }
    const j = JSON.parse(line.slice(5))
    return { map: j.map, bots: j.bots, duration_s: Math.round(j.duration_sec), result: j.ok && !crashed ? 'pass' : 'fail', crashes: crashed ? 1 : 0,
        tick_ms_mean: j.tick_ms?.mean, tick_ms_p95: j.tick_ms?.p95, kills: j.totals?.kills, notes: (j.reasons ?? []).join('; ') }
}

/** Post one bot playtest. Idempotent on (game, tester, tags, at): the same run is never stored twice. */
export function record(db, { game, build = '', at, ...facts }) {
    F.ensure(db)
    const tags = ['bot', facts.map, facts.mode, facts.bots ? `${facts.bots}bots` : '', facts.result].filter(Boolean).join(',')
    const when = (at ? new Date(at) : new Date()).toISOString()
    const dup = db.prepare('SELECT id FROM "Playtest" WHERE game = ? AND tester = ? AND tags = ? AND at = ?').get(game, TESTER, tags, when)
    if (dup) return { id: dup.id, created: false }
    return F.add(db, 'playtest', { game, build, tester: TESTER, tags, text: factsText(facts), at: when })
}

/** History: every perf run that had bots is a bot playtest (map, bots, duration, avg fps); crashes were not recorded by perf runs, so the field is omitted. */
export function importPerf(db) {
    F.ensure(db)
    const runs = db.prepare('SELECT * FROM "PerfRun" WHERE bots > 0 ORDER BY ranAt').all()
    const fps = db.prepare("SELECT value FROM \"PerfMetric\" WHERE runId = ? AND name = 'fps'")
    let created = 0
    for (const r of runs) {
        const f = fps.get(r.id)
        const res = record(db, { game: r.game, build: String(r.commit).slice(0, 9), at: r.ranAt, map: r.map, mode: `${r.platform}-${r.role}`, bots: r.bots,
            duration_s: Math.round(r.durationS), result: 'completed', avg_fps: f ? Math.round(f.value * 10) / 10 : undefined, source: 'perf-run' })
        if (res.created) created++
    }
    return { runs: runs.length, created }
}
