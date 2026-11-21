// The perf gate: pass/fail for one run against the game's budgets and against a noise-aware baseline (the previous comparable runs).
// Used by `nightly perf gate` (exit code for CI) and POST /api/perf/gate. Exit codes: 0 pass, 1 fail, 2 nothing to judge (no such run).
import * as P from './perf.mjs'
import * as PS from './perf-store.mjs'

export const EXIT = { pass: 0, fail: 1, error: 2 }

/** Resolve a run by id, "latest", or a commit (newest run of that commit). Scope filters narrow "latest"/commit. */
export function findRun(db, game, ref, scope = {}) {
    PS.ready(db)
    const w = ['game = @game'], a = { game }
    for (const k of ['platform', 'role', 'map']) if (scope[k]) { w.push(`${k} = @${k}`); a[k] = scope[k] }
    if (scope.bots !== undefined && scope.bots !== '') { w.push('bots = @bots'); a.bots = Number(scope.bots) }
    const ref0 = String(ref ?? 'latest')
    if (/^\d+$/.test(ref0)) return db.prepare('SELECT * FROM PerfRun WHERE id = ? AND game = ?').get(Number(ref0), game) ?? null
    if (ref0 !== 'latest') { w.push('"commit" LIKE @c'); a.c = ref0 + '%' }
    return db.prepare(`SELECT * FROM PerfRun WHERE ${w.join(' AND ')} ORDER BY ranAt DESC, id DESC LIMIT 1`).get(a) ?? null
}

/**
 * Judge run `runId`. Options (all optional): budgets (default true), baseline (default true), noisePct, sigma, minRuns, runs (how many previous
 * comparable runs form the baseline; defaults are the perfRegression* settings, 0 = all), metrics (limit the baseline check to these).
 * Returns { pass, exit, run, failures[], breaches[], regressions[], improvements[], baselineRuns, skipped[] }.
 * A baseline with fewer than minRuns earlier runs gives no verdict (listed under `skipped`, never a failure).
 */
export function gate(db, slug, runId, o = {}) {
    PS.ready(db)
    const game = PS.getGame(db, slug)
    if (!game) throw new Error(`unknown game "${slug}"`)
    const run = db.prepare('SELECT * FROM PerfRun WHERE id = ? AND game = ?').get(runId, slug)
    if (!run) throw new Error(`no run ${runId} for game ${slug}`)
    const metrics = PS.runMetrics(db, run.id)
    const out = { pass: true, exit: 0, game: slug, run: { id: run.id, commit: run.commit, platform: run.platform, role: run.role, map: run.map, bots: run.bots, ranAt: run.ranAt },
        failures: [], breaches: [], regressions: [], improvements: [], baselineRuns: [], skipped: [] }
    if (o.budgets !== false) {
        out.breaches = P.evaluateBudgets(game.budgets, run, metrics).breaches.map((b) => ({ metric: b.metric, value: b.value, limit: b.limit, op: b.op, over: b.over }))
        for (const b of out.breaches) out.failures.push(`budget ${P.budgetSpec(b)}: ${b.metric} is ${+b.value.toFixed(3)} (limit ${b.limit})`)
    }
    if (o.baseline !== false) {
        const n = o.runs ?? PS.setting(db, 'perfRegressionRuns')
        const opts = { noisePct: o.noisePct ?? PS.setting(db, 'perfRegressionNoisePct'), sigma: o.sigma ?? PS.setting(db, 'perfRegressionSigma'), minRuns: o.minRuns ?? PS.setting(db, 'perfRegressionMinRuns') }
        const prev = db.prepare(`SELECT id FROM PerfRun WHERE game = @game AND platform = @platform AND role = @role AND map = @map AND bots = @bots AND id != @id AND (ranAt < @ranAt OR (ranAt = @ranAt AND id < @id)) ORDER BY ranAt DESC, id DESC${n > 0 ? ' LIMIT @n' : ''}`)
            .all({ game: slug, platform: run.platform, role: run.role, map: run.map, bots: run.bots, id: run.id, ranAt: run.ranAt, n }).map((r) => r.id)
        out.baselineRuns = prev
        if (prev.length < Math.max(1, opts.minRuns)) out.skipped.push(`baseline: ${prev.length} earlier comparable run(s), need ${Math.max(1, opts.minRuns)}`)
        else {
            const hist = db.prepare(`SELECT value FROM PerfMetric WHERE name = ? AND runId IN (${prev.map(() => '?').join(',')})`)
            for (const m of o.metrics?.length ? o.metrics : P.WATCHED) {
                if (!Number.isFinite(metrics[m])) continue
                const d = P.detectRegression(m, metrics[m], hist.all(m, ...prev).map((r) => r.value), opts)
                const row = { metric: m, value: d.value, baseline: d.baseline, allowance: d.allowance, delta: d.delta, pct: d.pct, n: d.n }
                if (d.regressed) { out.regressions.push(row); out.failures.push(`regression ${m}: ${+d.value.toFixed(3)} vs baseline ${+d.baseline.toFixed(3)} (${d.pct >= 0 ? '+' : ''}${d.pct.toFixed(1)}%, allowance ${+d.allowance.toFixed(3)} over ${d.n} runs)`) }
                else if (d.improved) out.improvements.push(row)
            }
        }
    }
    out.pass = out.failures.length === 0
    out.exit = out.pass ? EXIT.pass : EXIT.fail
    return out
}

export const gateText = (g) => [`perf gate ${g.game} run ${g.run.id} (${g.run.platform}/${g.run.role}${g.run.map ? '/' + g.run.map : ''}${g.run.bots ? ' ' + g.run.bots + ' bots' : ''}${g.run.commit ? ' ' + g.run.commit.slice(0, 10) : ''}): ${g.pass ? 'PASS' : 'FAIL'}`,
    ...g.failures.map((f) => '  FAIL ' + f), ...g.improvements.map((r) => `  better ${r.metric}: ${+r.value.toFixed(3)} vs ${+r.baseline.toFixed(3)} (${r.pct.toFixed(1)}%)`), ...g.skipped.map((s) => '  skipped ' + s)].join('\n')

// ---------- views of stored runs (CLI side; the panel does the same from Prisma + the artefact files) ----------
import { readFileSync } from 'node:fs'
import * as V from './perf-viz.mjs'
const readArt = (run, file) => { try { return PS.hasArtefact(run.artefact, file) ? readFileSync(PS.artefactPath(run.artefact, file), 'utf8') : '' } catch { return '' } }
export const runFolded = (db, run) => V.bestFolded({ stacks: readArt(run, 'stacks.folded'), report: readArt(run, 'report.json'), funcs: PS.runFuncs(db, run.id) })
export function runHitches(run) { try { return V.hitchesFromReport(JSON.parse(readArt(run, 'report.json') || '{}')) } catch { return [] } }
/** The two runs behind an RSI finding: the run that found it and the run that remeasured it (both must exist). */
export function findingRuns(db, f) {
    const a = f.runId ? db.prepare('SELECT * FROM PerfRun WHERE id = ?').get(f.runId) : null
    const b = f.remeasuredRunId ? db.prepare('SELECT * FROM PerfRun WHERE id = ?').get(f.remeasuredRunId) : null
    return a && b ? { before: a, after: b } : null
}
/** Report bundle for one run: markdown, svg and gate verdict (baseline = the previous comparable run). */
export function runReport(db, runId, o = {}) {
    const run = db.prepare('SELECT * FROM PerfRun WHERE id = ?').get(runId)
    if (!run) throw new Error(`no run ${runId}`)
    const game = PS.getGame(db, run.game)
    const metrics = PS.runMetrics(db, run.id)
    const prev = db.prepare('SELECT id FROM PerfRun WHERE game=? AND platform=? AND role=? AND map=? AND bots=? AND id<? ORDER BY ranAt DESC, id DESC LIMIT 1').get(run.game, run.platform, run.role, run.map, run.bots, run.id)
    const g = o.gate === false ? null : gate(db, run.game, run.id)
    const folded = runFolded(db, run)
    const args = { game, run, metrics, budgets: game.budgets, base: prev ? PS.runMetrics(db, prev.id) : null, gate: g, top: PS.runFuncs(db, run.id).filter((f) => f.per !== 'tick').slice(0, 5), folded, links: o.links ?? {} }
    return { markdown: V.reportMarkdown(args), svg: V.reportSvg(args), gate: g }
}

/** Render an svg string to a png with headless chromium (CHROMIUM env, else chromium / chromium-browser / google-chrome). Throws when none is installed. */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
export function svgToPng(svg, file) {
    const m = /<svg[^>]*width="(\d+)"[^>]*height="(\d+)"/.exec(svg)
    const [w, h] = m ? [Number(m[1]), Number(m[2])] : [1100, 400]
    const dir = mkdtempSync(path.join(tmpdir(), 'perf-svg-'))
    try {
        const html = path.join(dir, 'x.html')
        writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#fff}</style>${svg}`)
        for (const bin of [process.env.CHROMIUM, 'chromium', 'chromium-browser', 'google-chrome'].filter(Boolean)) {
            const r = spawnSync(bin, ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', `--window-size=${w},${h}`, `--screenshot=${file}`, 'file://' + html], { encoding: 'utf8', timeout: 60_000 })
            if (!r.error && r.status === 0) return file
        }
        throw new Error('png needs headless chromium (set CHROMIUM=/path/to/chromium); the svg/markdown output works without it')
    } finally { rmSync(dir, { recursive: true, force: true }) }
}
