// One-off import of ~/stack/nightly-todo.md and ~/stack/reports/nightly-*.md.
// Reads only; never modifies the Markdown. Safe to re-run: items whose key is
// already in the DB and runs with the same startedAt are skipped.
// Usage: npm run db:import [-- --todo FILE --reports DIR]
import { readFileSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as S from '../lib/store.mjs'

const arg = (name: string, dflt: string) => {
    const i = process.argv.indexOf(`--${name}`)
    return i > 0 ? process.argv[i + 1] : dflt
}
const TODO = arg('todo', path.join(os.homedir(), 'stack', 'nightly-todo.md'))
const REPORTS = arg('reports', path.join(os.homedir(), 'stack', 'reports'))

const SECTION: Record<string, string> = { queue: 'queue', review: 'review', done: 'done', 'in progress': 'in_progress' }
const DATE = '(\\d{4}-\\d{2}-\\d{2})'
const DONE_PREFIX = new RegExp(`^Done ${DATE}(?:\\s*\\([^)]*\\))?\\s*[—–-]+\\s*`, 'i')
const DONE_SUFFIX = new RegExp(`\\s*[—–-]*\\s*(?:done|found and fixed|confirmed|fixed)\\s+${DATE}\\s*$`, 'i')

type Parsed = {
    key: string; title: string; status: string; body: string; repos: string; doneWhen: string | null
    addedBy: string; createdAt: string; completedAt: string | null
}

const at = (d: string) => `${d}T12:00:00.000Z`

function parse(md: string) {
    const items: Parsed[] = []
    let section: string | null = null
    let sectionName = ''
    let cur: { head: string; lines: string[]; status: string } | null = null
    const extra: Record<string, string[]> = {}
    let fence = false
    const flush = () => {
        if (cur) items.push(build(cur.head, cur.lines, cur.status))
        cur = null
    }
    for (const line of md.split('\n')) {
        if (/^```/.test(line)) fence = !fence
        if (!fence && /^## /.test(line)) {
            flush()
            sectionName = line.slice(3).trim()
            section = SECTION[sectionName.toLowerCase()] ?? null
            if (!section) extra[sectionName] = []
            continue
        }
        const h = !fence && section ? /^### \[([^\]]+)\]\s*(.*)$/.exec(line) : null
        if (h) {
            flush()
            cur = { head: line, lines: [], status: section! }
            continue
        }
        if (cur) (cur as { lines: string[] }).lines.push(line)
        else if (!section && extra[sectionName]) extra[sectionName].push(line)
    }
    flush()
    return { items, extra }
}

function build(head: string, lines: string[], status: string): Parsed {
    const m = /^### \[([^\]]+)\]\s*(.*)$/.exec(head)!
    const key = m[1].trim()
    let title = m[2].trim()
    let completedAt: string | null = null
    const p = DONE_PREFIX.exec(title)
    const s = DONE_SUFFIX.exec(title)
    if (p) { completedAt = at(p[1]); title = title.slice(p[0].length) }
    else if (s) { completedAt = at(s[1]); title = title.slice(0, s.index) }
    if (completedAt || status === 'done') status = 'done'

    const meta: Record<string, string> = {}
    let i = 0
    let last: string | null = null
    while (i < lines.length && lines[i].trim() === '') i++
    for (; i < lines.length; i++) {
        const b = /^- \*\*(added|repos|done when):\*\*\s*(.*)$/i.exec(lines[i])
        if (b) { last = b[1].toLowerCase(); meta[last] = b[2].trim(); continue }
        if (last && /^\s{2,}\S/.test(lines[i])) { meta[last] += ' ' + lines[i].trim(); continue }
        break
    }
    const pre: string[] = []
    const added = meta['added'] ?? ''
    const am = /^(\d{4}-\d{2}-\d{2})\s*(?:by\s+(\w+))?(.*)$/.exec(added)
    const who = (am?.[2] ?? '').toLowerCase()
    const addedBy = who === 'christian' || who === 'session' ? who : who ? 'nightly' : 'christian'
    if (am?.[3]?.trim() || (who && !['christian', 'session', 'nightly'].includes(who))) pre.push(`*Added ${added}*`)
    const rawRepos = meta['repos'] ?? ''
    // Repo names are the backticked words outside parentheses; paths inside
    // parentheses stay in the body via the raw line below.
    let outer = rawRepos
    for (let k = 0; k < 5; k++) outer = outer.replace(/\([^()]*\)/g, '')
    const names = [...outer.matchAll(/`([^`]+)`/g)].map((x) => x[1].trim())
        .filter((n) => /^[a-z0-9~][\w.~-]*(\/[\w.-]+)?$/i.test(n) && !/\.(py|gd|ts|tsx|rs|go|md|json|gdshader|sh|mjs|js)$/.test(n))
    const repos = names.length ? [...new Set(names)].join(', ') : rawRepos
    if (names.length && rawRepos.replace(/`[^`]+`|[,\s]|and/g, '').length) pre.push(`**repos:** ${rawRepos}`)
    if (!am && added) pre.push(`*Added ${added}*`)
    const body = [...pre, ...(pre.length ? [''] : []), lines.slice(i).join('\n').replace(/\n*(---\s*)?\s*$/, '')].join('\n').trim()
    return {
        key, title: title.trim(), status, body, repos, doneWhen: meta['done when'] || null, addedBy,
        createdAt: am ? at(am[1]) : completedAt ?? S.now(), completedAt,
    }
}

const db = S.open()
const { items, extra } = parse(readFileSync(TODO, 'utf8'))
const counts: Record<string, number> = {}
let skipped = 0, renamed = 0
const seen = new Set<string>()
S.tx(db, () => {
    const ins = db.prepare(`INSERT INTO Item (key, title, body, kind, status, priority, repos, doneWhen, addedBy,
        createdAt, updatedAt, completedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    const prio: Record<string, number> = {}
    for (const it of items) {
        let key = it.key
        if (seen.has(key)) { key = S.uniqueKey(db, `${key}-dup`); renamed++ }
        else if (S.getItem(db, key)) { skipped++; continue }
        seen.add(key)
        prio[it.status] = (prio[it.status] ?? 0) + 10
        ins.run(key, it.title, it.body, 'task', it.status, prio[it.status], it.repos, it.doneWhen, it.addedBy,
            it.createdAt, S.now(), it.status === 'done' ? it.completedAt ?? it.createdAt : null)
        counts[it.status] = (counts[it.status] ?? 0) + 1
    }
})

// The "Level rotation" section is live state for the chk-levels standing check.
const rotation = extra['Level rotation']?.join('\n').trim()
if (rotation && S.getItem(db, 'chk-levels')) {
    const has = db.prepare("SELECT 1 FROM Note n JOIN Item i ON i.id = n.itemId WHERE i.key = 'chk-levels' AND n.body LIKE '%Imported from nightly-todo.md%'").get()
    if (!has) S.addNote(db, 'chk-levels', `**Level rotation** (Imported from nightly-todo.md)\n\n${rotation}`, { author: 'christian' })
}
if (/^Do Run:\s*true/im.test(readFileSync(TODO, 'utf8')) && S.getSetting(db, 'doRun') === null) S.setSetting(db, 'doRun', 'true')

// Reports -> Run rows
let runs = 0, runSkipped = 0
for (const f of readdirSync(REPORTS).filter((f) => /^nightly-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}.*\.md$/.test(f)).sort()) {
    const [, y, mo, d, h, mi] = /^nightly-(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})/.exec(f)!.map(Number)
    const startedAt = new Date(y, mo - 1, d, h, mi).toISOString()
    if (db.prepare('SELECT 1 FROM Run WHERE startedAt = ?').get(startedAt)) { runSkipped++; continue }
    const full = path.join(REPORTS, f)
    const report = readFileSync(full, 'utf8')
    const heads = [...report.matchAll(/^## (.+)$/gm)].map((m) => m[1].replace(/^\d+\.\s*/, '').trim())
    const summary = `Imported from reports/${f}.` + (heads.length ? ` Sections: ${heads.join('; ')}` : '')
    const mtime = statSync(full).mtime.toISOString()
    const minutes = Math.max(0, Math.round((Date.parse(mtime) - Date.parse(startedAt)) / 60000))
    db.prepare("INSERT INTO Run (startedAt, finishedAt, status, summary, report, minutes) VALUES (?, ?, 'ok', ?, ?, ?)")
        .run(startedAt, mtime, summary.slice(0, 400), report, minutes < 24 * 60 ? minutes : null)
    runs++
}

console.log(`items imported: ${JSON.stringify(counts)} (total ${Object.values(counts).reduce((a, b) => a + b, 0)}), ` +
    `skipped (key already in DB): ${skipped}, duplicate keys renamed: ${renamed}`)
console.log(`runs imported: ${runs}, skipped: ${runSkipped}`)
