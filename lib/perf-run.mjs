// `nightly perf run` and the nightly scheduler hook. The per-game contract is tools/perf.sh in the game repo:
//   tools/perf.sh --platform native|web --role client|server [--map M] [--bots N] [--duration S] --out report.json
// It writes a dot-profiler report (v1/v2 JSON; or .folded/.txt) to --out and exits 0. Nothing else is assumed.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as S from './store.mjs'
import * as P from './perf.mjs'
import * as PS from './perf-store.mjs'

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

/**
 * Where a (platform, role) run executes: game.routing["native/client"] = {"host":"<ssh alias>", "args":"--map arena --bots 4", "timeoutS":900}. {"runAs":"gamedev"} runs it as that user through sudo (no ssh) when the repo belongs to another user on this box.
 * Budgets that name a map or bots (budgetRuns) add runs to the nightly matrix.
 * No host = this machine. GPU / windowed runs must route to a GPU box by name in the DB (never hard-coded here).
 */
export function route(game, platform, role) {
    const r = game.routing?.[`${platform}/${role}`] ?? game.routing?.[platform] ?? null
    return r && typeof r === 'object' ? r : null
}

export function runGame(db, game, { platform, role, map, bots, duration, dryRun = false, timeoutS } = {}) {
    PS.ready(db)
    platform = platform || 'native'
    role = role || 'client'
    const r = route(game, platform, role) ?? {}
    const script = game.perfScript || 'tools/perf.sh'
    if (!game.repoPath) throw new Error(`game "${game.slug}" has no repoPath (nightly perf game set --id ${game.slug} --repo-path DIR)`)
    const args = ['--platform', platform, '--role', role]
    const m = map ?? r.map; const b = bots ?? r.bots; const d = duration ?? r.duration
    if (m) args.push('--map', m)
    if (b !== undefined && b !== '') args.push('--bots', String(b))
    if (d) args.push('--duration', String(d))
    if (r.args) args.push(...String(r.args).split(/\s+/).filter(Boolean))
    const limit = (timeoutS ?? r.timeoutS ?? 1800) * 1000
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'perf-'))
    const out = path.join(tmp, 'report.json')
    try {
        let res
        if (r.host || r.runAs) {
            const remote = `/tmp/perf-${process.pid}-${Date.now()}.json`
            const cmd = `cd ${q(game.repoPath)} && ${q(script)} ${args.map(q).join(' ')} --out ${q(remote)} >&2 && cat ${q(remote)}; rc=$?; rm -f ${q(remote)}; exit $rc`
            const [bin, ...pre] = r.host ? ['ssh', '-o', 'BatchMode=yes', r.host] : ['sudo', '-n', '-u', r.runAs, 'bash', '-c']
            if (dryRun) return { dryRun: true, command: [bin, ...pre, cmd].join(' ') }
            res = spawnSync(bin, [...pre, cmd], { encoding: 'utf8', timeout: limit, maxBuffer: 256 << 20 })
        } else {
            const abs = path.isAbsolute(script) ? script : path.join(game.repoPath, script)
            if (dryRun) return { dryRun: true, command: [abs, ...args, '--out', out].join(' ') }
            if (!existsSync(abs)) throw new Error(`${abs} does not exist: the game has no perf.sh yet (contract in README, "Performance tab")`)
            res = spawnSync(abs, [...args, '--out', out], { cwd: game.repoPath, encoding: 'utf8', timeout: limit, maxBuffer: 256 << 20 })
        }
        if (res.error) throw new Error(`perf.sh failed to run: ${res.error.message}`)
        if (res.status !== 0) throw new Error(`perf.sh exited ${res.status}: ${String(res.stderr ?? '').trim().split('\n').slice(-3).join(' | ')}`)
        const text = (r.host || r.runAs) ? res.stdout : readFileSync(out, 'utf8')
        const parsed = P.parseAny(text, (r.host || r.runAs) ? 'report.json' : path.basename(out), { addons: game.addons })
        return PS.ingest(db, parsed, { game: game.slug, platform, role, map: m, bots: b, source: 'perf run', raw: text, commit: gitHead(game.repoPath, r.host, r.runAs) })
    } finally { rmSync(tmp, { recursive: true, force: true }) }
}

function gitHead(dir, host, runAs) {
    const a = runAs ? spawnSync('sudo', ['-n', '-u', runAs, 'git', '-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 20000 }) : host ? spawnSync('ssh', ['-o', 'BatchMode=yes', host, `git -C ${q(dir)} rev-parse HEAD`], { encoding: 'utf8', timeout: 20000 })
        : spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 20000 })
    return a.status === 0 ? a.stdout.trim() : ''
}

/**
 * The runs one routing entry stands for: its own defaults, plus one run per distinct (map, bots) that a budget of this platform/role names
 * (a budget "fps>=120@map=crackhouse" makes a crackhouse run at the entry's bots). Budgets with neither map nor bots add nothing.
 */
export function budgetRuns(game, platform, role) {
    const r = route(game, platform, role) ?? {}
    const seen = new Set([`${r.map ?? ''}|${r.bots ?? ''}`])
    const runs = [{}]
    for (const b of game.budgets ?? []) {
        if ((b.platform && b.platform !== platform) || (b.role && b.role !== role)) continue
        if (b.map === undefined && b.bots === undefined) continue
        const map = b.map ?? r.map; const bots = b.bots ?? r.bots
        const key = `${map ?? ''}|${bots ?? ''}`
        if (seen.has(key)) continue
        seen.add(key)
        runs.push({ map, bots })
    }
    return runs
}

/** Run the matrix = every routing entry of every enabled game. One failure never stops the rest. */
export function runAll(db, { dryRun = false, only } = {}) {
    const rows = []
    for (const g of PS.listGames(db)) {
        if (!g.enabled || (only && g.slug !== only)) continue
        const combos = Object.keys(g.routing).filter((k) => /^(native|web)\/(client|server)$/.test(k))
        if (!combos.length) { rows.push({ game: g.slug, status: 'skipped', note: 'no routing entries (set routing "native/client" etc.)' }); continue }
        for (const k of combos) {
            const [platform, role] = k.split('/')
            for (const extra of budgetRuns(g, platform, role)) {
                const label = extra.map || extra.bots !== undefined ? `${k} ${extra.map ?? ''} bots=${extra.bots ?? ''}`.trim() : k
                try {
                    const r = runGame(db, g, { platform, role, dryRun, ...extra })
                    rows.push({ game: g.slug, combo: label, status: dryRun ? 'dry' : 'ok', runId: r.run?.id, breaches: r.breaches?.length ?? 0, command: r.command })
                } catch (e) { rows.push({ game: g.slug, combo: label, status: 'failed', note: e.message }) }
            }
        }
    }
    return rows
}

/** Called from `tick` every minute: starts `perf nightly` detached once a day at perfNightlyAt (HH:MM local, empty = off). */
export function maybeSchedule(db, at = new Date()) {
    const when = S.getSetting(db, 'perfNightlyAt') ?? '03:40'
    if (!when || !/^\d\d:\d\d$/.test(when)) return null
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='PerfGame'").get()) return null
    const local = S.local(at.toISOString())
    const day = local.slice(0, 10)
    if (local.slice(11, 16) < when || S.getSetting(db, 'perfLastDay') === day) return null
    if (!db.prepare('SELECT 1 FROM PerfGame WHERE enabled = 1').get()) return null
    S.setSetting(db, 'perfLastDay', day)
    const cli = path.join(S.ROOT, 'bin', 'nightly.mjs')
    spawn(process.execPath, [cli, 'perf', 'nightly'], { detached: true, stdio: 'ignore', env: process.env }).unref()
    return `perf nightly started for ${day}`
}
