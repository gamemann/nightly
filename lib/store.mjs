// Shared data layer for the CLI and the importers. Plain Node ESM on
// node:sqlite, so it needs no build, no Prisma engine and no web server. The
// schema itself is owned by prisma/schema.prisma (`npm run db:push`); this file
// only reads and writes it. Dates are stored as ISO-8601 text, which is what
// the Prisma better-sqlite3 adapter reads and writes by default.
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DB_PATH = process.env.NIGHTLY_DB || path.join(ROOT, 'data', 'nightly.db')

export const KINDS = ['task', 'issue', 'check', 'study']
export const STATUSES = ['queue', 'in_progress', 'review', 'blocked', 'done', 'wontfix']
export const OPEN_STATUSES = ['in_progress', 'review', 'queue', 'blocked']
export const RUN_STATUSES = ['running', 'ok', 'failed', 'skipped']
export const CADENCES = ['nightly', 'every-2-days', 'weekly', 'monthly']
// A check is due once this long has passed since lastRunAt. Slightly under the
// nominal period so a run that starts a few minutes early still picks it up.
export const CADENCE_HOURS = { nightly: 20, 'every-2-days': 44, weekly: 6.5 * 24, monthly: 28 * 24 }

export const now = () => new Date().toISOString()
/** ISO -> 'YYYY-MM-DD HH:MM' in local time (the box's timezone, which cron uses). */
export const local = (iso) => {
    if (!iso) return '-'
    const d = new Date(iso)
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function open(file = DB_PATH) {
    if (!existsSync(file)) {
        throw new Error(`database not found at ${file} -- run \`npm run db:push\` in ${ROOT}`)
    }
    const db = new DatabaseSync(file)
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    return db
}

export function tx(db, fn) {
    db.exec('BEGIN IMMEDIATE')
    try {
        const r = fn()
        db.exec('COMMIT')
        return r
    } catch (e) {
        db.exec('ROLLBACK')
        throw e
    }
}

const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'its', 'it', 'with', 'by', 'at', 'be', 'no', 'not', 'from', 'that', 'this', 'still', 'does', 'do'])

export function slugify(title) {
    const words = title
        .toLowerCase()
        .replace(/`/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .split(/\s+/)
        .filter((w) => w && !STOP.has(w))
    let s = ''
    for (const w of words) {
        if (s && (s + '-' + w).length > 20) break
        s = s ? `${s}-${w}` : w
    }
    return s.slice(0, 20) || 'item'
}

export function uniqueKey(db, base) {
    const has = db.prepare('SELECT 1 FROM Item WHERE key = ?')
    if (!has.get(base) && /-\d+$/.test(base)) return base
    for (let n = 1; ; n++) {
        const k = `${base}-${n}`
        if (!has.get(k)) return k
    }
}

export const getItem = (db, key) => db.prepare('SELECT * FROM Item WHERE key = ?').get(key)

export function mustItem(db, key) {
    const it = getItem(db, key)
    if (!it) throw new Error(`no item with key "${key}"`)
    return it
}

/** Items in one status in priority order. Checks are ordered among themselves, apart from the queue. */
export const siblings = (db, status, isCheck = false) =>
    db.prepare("SELECT id, key, priority FROM Item WHERE status = ? AND (kind = 'check') = ? ORDER BY priority, id").all(status, isCheck ? 1 : 0)

/** Rewrite priorities of `ordered` (array of ids) as 10, 20, 30... */
export function renumber(db, ordered) {
    const up = db.prepare('UPDATE Item SET priority = ? WHERE id = ?')
    ordered.forEach((id, i) => up.run((i + 1) * 10, id))
}

/** Place item `id` in its status list: 'top' | 'bottom' | {after: key} | number. */
export function place(db, id, status, where) {
    const isCheck = db.prepare('SELECT kind FROM Item WHERE id = ?').get(id)?.kind === 'check'
    if (typeof where === 'number') {
        db.prepare('UPDATE Item SET priority = ? WHERE id = ?').run(where, id)
        return
    }
    const ids = siblings(db, status, isCheck).map((r) => r.id).filter((x) => x !== id)
    let at = ids.length
    if (where === 'top') at = 0
    else if (where && typeof where === 'object' && where.after) {
        const ref = mustItem(db, where.after)
        const i = ids.indexOf(ref.id)
        at = i === -1 ? ids.length : i + 1
    }
    ids.splice(at, 0, id)
    renumber(db, ids)
}

export function addItem(db, o) {
    return tx(db, () => {
        const key = o.key ? o.key : uniqueKey(db, slugify(o.title))
        if (o.key && getItem(db, o.key)) throw new Error(`key "${o.key}" already exists`)
        const kind = o.kind ?? 'task'
        const status = o.status ?? 'queue'
        check(KINDS, kind, 'kind')
        check(STATUSES, status, 'status')
        if (o.cadence) check(CADENCES, o.cadence, 'cadence')
        const t = o.createdAt ?? now()
        const r = db
            .prepare(
                `INSERT INTO Item (key, title, body, kind, status, priority, repos, doneWhen, addedBy, cadence,
                 lastRunAt, createdAt, updatedAt, completedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
                key, o.title, o.body ?? '', kind, status, 0, o.repos ?? '', o.doneWhen ?? null,
                o.addedBy ?? 'christian', o.cadence ?? null, o.lastRunAt ?? null, t, now(),
                o.completedAt ?? (status === 'done' || status === 'wontfix' ? t : null),
            )
        const id = Number(r.lastInsertRowid)
        place(db, id, status, o.priority ?? o.where ?? 'bottom')
        return getItem(db, key)
    })
}

export function updateItem(db, key, patch) {
    return tx(db, () => {
        const it = mustItem(db, key)
        const set = {}
        for (const f of ['title', 'body', 'kind', 'repos', 'doneWhen', 'cadence', 'addedBy', 'key']) {
            if (patch[f] !== undefined) set[f] = patch[f]
        }
        if (set.kind) check(KINDS, set.kind, 'kind')
        if (set.cadence) check(CADENCES, set.cadence, 'cadence')
        let status = it.status
        if (patch.status !== undefined && patch.status !== it.status) {
            check(STATUSES, patch.status, 'status')
            status = set.status = patch.status
            const closed = status === 'done' || status === 'wontfix'
            set.completedAt = closed ? now() : null
        }
        set.updatedAt = now()
        const cols = Object.keys(set)
        db.prepare(`UPDATE Item SET ${cols.map((c) => `"${c}" = ?`).join(', ')} WHERE id = ?`).run(
            ...cols.map((c) => set[c]),
            it.id,
        )
        if (patch.priority !== undefined) place(db, it.id, status, patch.priority)
        else if (set.status) place(db, it.id, status, status === 'queue' ? 'bottom' : 'top')
        return db.prepare('SELECT * FROM Item WHERE id = ?').get(it.id)
    })
}

export function addNote(db, key, body, { author = 'nightly', runId = null, createdAt } = {}) {
    const it = mustItem(db, key)
    if (runId != null && !db.prepare('SELECT 1 FROM Run WHERE id = ?').get(runId)) {
        throw new Error(`no run with id ${runId}`)
    }
    const t = createdAt ?? now()
    const r = db
        .prepare('INSERT INTO Note (itemId, runId, author, body, createdAt) VALUES (?,?,?,?,?)')
        .run(it.id, runId, author, body, t)
    db.prepare('UPDATE Item SET updatedAt = ? WHERE id = ?').run(now(), it.id)
    return db.prepare('SELECT * FROM Note WHERE id = ?').get(Number(r.lastInsertRowid))
}

export const notesFor = (db, id) =>
    db.prepare('SELECT * FROM Note WHERE itemId = ? ORDER BY createdAt, id').all(id)

export function isDue(item, at = Date.now()) {
    if (item.kind !== 'check' || !OPEN_STATUSES.includes(item.status)) return false
    if (!item.lastRunAt) return true
    const h = CADENCE_HOURS[item.cadence ?? 'nightly'] ?? 20
    return at - Date.parse(item.lastRunAt) >= h * 3600_000
}

export const checks = (db) =>
    db.prepare("SELECT * FROM Item WHERE kind = 'check' ORDER BY priority, id").all()

export function getSetting(db, key) {
    return db.prepare('SELECT value FROM Setting WHERE key = ?').get(key)?.value ?? null
}

export function setSetting(db, key, value) {
    db.prepare('INSERT INTO Setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value))
}

function check(list, v, what) {
    if (!list.includes(v)) throw new Error(`bad ${what} "${v}" (one of: ${list.join(', ')})`)
}
