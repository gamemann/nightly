#!/usr/bin/env node
// Crash scanner: prints a JSON array of crash-group records (absolute counts, so re-running is idempotent) for
// `nightly crash scan` / `nightly feed add crash -`. Run it as the user that owns the logs and the journal.
//   node lib/crash-scan.mjs [--journal] [--since 90d] [--logs DIR[,DIR...]] [--platform linux] [--projects JSON]
// --projects: [{slug, repoPath, settings}] from the Project table (`nightly crash scan` passes it); the game of a log comes from lib/crash-game.mjs.
// Sources: (1) Godot engine crash dumps ("handle_crash: Program crashed with signal N" + backtrace) in any file under --logs;
// (2) the user journal's OOM kills of systemd scopes (a killed build or suite is a crash of that job, host-level).
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { makeGameOf } from './crash-game.mjs'

const args = process.argv.slice(2)
const opt = (k, d = '') => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] ?? '' : d }
const platform = opt('platform', process.platform === 'linux' ? 'linux' : process.platform)
const groups = new Map()
function bump(r, at, file) {
    const key = `${r.game}\0${r.signature}\0${r.version}\0${r.platform}`
    const g = groups.get(key) ?? { ...r, count: 0, firstSeenAt: at, at, files: new Set() }
    g.count++; g.files.add(file)
    if (at < g.firstSeenAt) g.firstSeenAt = at
    if (at >= g.at) { g.at = at; g.sample = r.sample }
    groups.set(key, g)
}
let projects = []
try { projects = JSON.parse(opt('projects', '[]')) } catch { /* no project data: only the repo-name fallbacks apply */ }
const gameOf = makeGameOf(projects)

// 1. engine crash dumps
for (const dir of opt('logs').split(',').filter(Boolean)) {
    let files = ''
    try { files = execFileSync('grep', ['-rlE', '--include=*.log', '--include=*.txt', '--exclude-dir=.git', '--exclude-dir=node_modules', '--exclude-dir=.import', 'handle_crash: Program crashed with signal', dir], { encoding: 'utf8', timeout: 180_000, maxBuffer: 1 << 24 }) } catch (e) { files = e.stdout ?? '' }
    for (const f of files.split('\n').filter(Boolean)) {
        let text = '', at = ''
        try { text = readFileSync(f, 'utf8'); at = statSync(f).mtime.toISOString() } catch { continue }
        const lines = text.split('\n')
        for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(/handle_crash: Program crashed with signal (\d+)/)
            if (!m) continue
            const block = lines.slice(i, i + 40)
            const ver = (block.find((l) => l.startsWith('Engine version:')) ?? '').replace(/^Engine version: Godot Engine v?/, '').replace(/\.official.*$/, '').trim()
            const frames = block.filter((l) => /^\[\d+\]/.test(l)).map((l) => (l.match(/\(([^()\s]+\+[0-9a-f]+)\)/) ?? [])[1]).filter((x) => x && !x.startsWith('main+'))
            const lib = frames.find((x) => !x.startsWith('godot+'))
            const sig = `signal ${m[1]} in ${lib ?? frames[0] ?? 'unknown'}${lib && frames[0] && frames[0] !== lib ? ` (via ${frames[0]})` : ''}`
            bump({ game: gameOf(f), signature: sig, version: ver, platform, sample: `${path.basename(f)}\n${block.slice(0, 14).join('\n')}`, status: 'open' }, at, `${f}:${i}`)
        }
    }
}

// 2. OOM-killed scopes in the user journal
if (args.includes('--journal')) {
    let j = ''
    try { j = execFileSync('journalctl', ['-q', '-o', 'short-iso', '--since', `-${opt('since', '90d').replace(/d$/, 'day')}`.replace('-90', '-90 ').replace(/(\d)(day)$/, '$1 days'), '--no-pager'], { encoding: 'utf8', maxBuffer: 1 << 28, timeout: 120_000 }) } catch (e) { j = e.stdout ?? '' }
    const started = new Map()
    for (const l of j.split('\n')) {
        const s = l.match(/Started (\S+\.scope) - \[systemd-run\] (.*)$/)
        if (s) started.set(s[1], s[2])
    }
    for (const l of j.split('\n')) {
        const k = l.match(/^(\S+) \S+ systemd\[\d+\]: (\S+?)(?:-\d+-\d+)?\.scope: Failed with result 'oom-kill'/)
        if (!k) continue
        const full = l.match(/: (\S+\.scope): Failed/)[1], cmd = started.get(full) ?? ''
        const words = cmd.replace(/^\/usr\/bin\/nice -n \d+ ionice -c\d -n\d+ /, '').replace(/^(env|timeout) (\S+=\S+ |\d+\S* )*/, '').split(/\s+/)
        const tok = (w) => (/^res:\/\/|^--/.test(w) ? w : path.basename(w))
        const what = words.find((w) => /^res:\/\//.test(w)) ?? (/godot/.test(cmd) ? 'godot' : tok(words[0] ?? '') || 'unknown')
        bump({ game: 'dev-host', signature: `oom-kill: ${k[2]} ${what}`.replace(/\.+$/, '').slice(0, 120), version: '', platform, sample: cmd.slice(0, 600), status: 'open' }, new Date(k[1]).toISOString(), full)
    }
}
process.stdout.write(JSON.stringify([...groups.values()].map(({ files, ...g }) => ({ ...g, absolute: true }))) + '\n')
