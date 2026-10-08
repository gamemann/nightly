// One-off import of run history kept as files into Run rows, so the panel holds all of it:
//   --reports DIR   nightly-YYYY-MM-DD_HH-MM*.md reports (repeatable)
//   --logs DIR      the old runner's nightly_<timestamp>.log (+ .json result, + manual-launch-<timestamp>.log)
// A file is matched to an existing run that started within 20 minutes of its timestamp and
// only fills what that run lacks; otherwise it becomes a new run (trigger "import").
// Safe to re-run. Reads only: deleting the files afterwards is up to you.
// Usage: node --no-warnings scripts/import-history.ts --reports DIR [--reports DIR2] --logs DIR [--dry-run]
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import * as S from '../lib/store.mjs'

const args = process.argv.slice(2)
const all = (name: string) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []))
const DRY = args.includes('--dry-run')

const db = S.open()
const WINDOW = 20 * 60_000
type Run = { id: number; startedAt: string; report: string; log: string; summary: string; turns: number | null; minutes: number | null; costUsd: number | null }
/** A run that started within 20 min of `iso`, or (for a log, which knows when it ended) any time before `until`.
 *  Old reports are named by when they were written, not when the run started. */
const near = (iso: string, until?: string) =>
    (db.prepare('SELECT * FROM Run ORDER BY startedAt').all() as Run[]).find((r) => {
        const t = Date.parse(r.startedAt)
        return Math.abs(t - Date.parse(iso)) <= WINDOW || (until && t >= Date.parse(iso) && t <= Date.parse(until) + 5 * 60_000)
    })

/** The report's opening paragraph (before its first section) as plain text, for the runs list;
 *  its section headings when the opening is only boilerplate (engine version, scope, budget). */
function summarise(md: string) {
    const preamble = md.split(/\n## /)[0]
    for (let p of preamble.split(/\n\s*\n/).map((x) => x.trim())) {
        if (!p || /^(#|---|```|\||>|- |<!--)/.test(p) || /^(\*\*)?(In scope|Scope|Budget)\b/i.test(p) || p.endsWith(':')) continue
        p = p.replace(/^(Engine:|Godot \d)[^\n]*?\.(\s|$)/, '').trim()
        if (!p) continue
        p = p.replace(/\s+/g, ' ').replace(/\*\*|`/g, '')
        return p.length > 300 ? p.slice(0, 299) + '…' : p
    }
    const heads = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1].replace(/^\d+\.\s*/, '').trim())
    return heads.length ? `Sections: ${heads.join('; ')}`.slice(0, 300) : ''
}

const stamp = (y: number, mo: number, d: number, h: number, mi: number, s = 0) => new Date(y, mo - 1, d, h, mi, s).toISOString()
const counts = { reportsNew: 0, reportsFilled: 0, logsNew: 0, logsAttached: 0, skipped: 0 }

function insert(r: Record<string, unknown>) {
    if (DRY) return
    const cols = Object.keys(r)
    db.prepare(`INSERT INTO Run (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...(cols.map((c) => r[c]) as never[]))
}
function update(id: number, r: Record<string, unknown>) {
    const cols = Object.keys(r)
    if (DRY || !cols.length) return
    db.prepare(`UPDATE Run SET ${cols.map((c) => `"${c}" = ?`).join(', ')} WHERE id = ?`).run(...(cols.map((c) => r[c]) as never[]), id)
}

for (const dir of all('reports')) {
    for (const f of readdirSync(dir).filter((f) => /^nightly-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}.*\.md$/.test(f)).sort()) {
        const [, y, mo, d, h, mi] = /^nightly-(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})/.exec(f)!.map(Number)
        const startedAt = stamp(y, mo, d, h, mi)
        const full = path.join(dir, f)
        const report = readFileSync(full, 'utf8')
        const mtime = statSync(full).mtime.toISOString()
        const run = near(startedAt)
        if (run) {
            const patch: Record<string, unknown> = { trigger: 'import' }
            if (!run.report.trim()) patch.report = report
            if (!run.summary || run.summary.startsWith('Imported from')) patch.summary = summarise(report)
            if (run.report.trim() && run.report !== report && !run.report.startsWith(report.slice(0, 200))) {
                console.warn(`! ${f}: run #${run.id} already has a different report; left as is`)
            }
            update(run.id, patch)
            counts[patch.report ? 'reportsFilled' : 'skipped']++
            continue
        }
        const minutes = Math.round((Date.parse(mtime) - Date.parse(startedAt)) / 60000)
        insert({ startedAt, finishedAt: mtime, status: 'ok', summary: summarise(report), report, log: '', trigger: 'import',
            minutes: minutes >= 0 && minutes < 24 * 60 ? minutes : null })
        counts.reportsNew++
    }
}

for (const dir of all('logs')) {
    for (const f of readdirSync(dir).filter((f) => /^nightly_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.log$/.test(f)).sort()) {
        const ts = f.slice('nightly_'.length, -'.log'.length)
        const [y, mo, d, h, mi, s] = ts.split(/[-_]/).map(Number)
        const startedAt = stamp(y, mo, d, h, mi, s)
        const full = path.join(dir, f)
        let log = readFileSync(full, 'utf8')
        const wrapper = path.join(dir, `manual-launch-${ts}.log`)
        if (existsSync(wrapper)) log = `${readFileSync(wrapper, 'utf8').trimEnd()}\n\n${log}`
        const jsonFile = full.replace(/\.log$/, '.json')
        let j: { result?: string; num_turns?: number; duration_ms?: number; total_cost_usd?: number; is_error?: boolean } | null = null
        try { j = JSON.parse(readFileSync(jsonFile, 'utf8')) } catch { j = null }
        const meta = {
            turns: j?.num_turns ?? null,
            minutes: j?.duration_ms != null ? Math.round(j.duration_ms / 60000) : null,
            costUsd: j?.total_cost_usd != null ? Math.round(j.total_cost_usd * 10000) / 10000 : null,
        }
        const finishedAt = statSync(full).mtime.toISOString()
        const run = near(startedAt, finishedAt)
        if (run) {
            const patch: Record<string, unknown> = {}
            if (!run.log.trim()) patch.log = log
            for (const k of ['turns', 'minutes', 'costUsd'] as const) if (run[k] == null && meta[k] != null) patch[k] = meta[k]
            update(run.id, patch)
            counts[Object.keys(patch).length ? 'logsAttached' : 'skipped']++
            continue
        }
        // No run row: the old runner's log is the only record, and claude's final message in it is the report.
        const report = (j?.result ?? log).trim()
        insert({ startedAt, finishedAt, status: !j ? 'failed' : j.is_error ? 'failed' : 'ok', summary: j ? summarise(report) : 'No result: the run produced no JSON record.',
            report: j ? report : '', log, trigger: 'import', ...meta, minutes: meta.minutes ?? Math.max(0, Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 60000)) })
        counts.logsNew++
    }
}

console.log(`${DRY ? '(dry run) ' : ''}${JSON.stringify(counts)}`)
