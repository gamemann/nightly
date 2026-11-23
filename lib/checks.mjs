// Script checks: scripts/chk-*.sh (exit 0 ok, 1 flagged, 2+ unreadable; lines starting FLAG are the findings), registered in check_script with an
// optional schedule (interval_min, run by the tick) and run on demand. Every run is a check_run row with the output tail.
//   nightly check scripts | add|edit|rm <name> | run <name> | runs [name] | due <item-key>   (item checks stay the Item kind=check rows: create/edit via `nightly add/edit`, `check due` = run now)
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensure } from './ops-store.mjs'

export const SCRIPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts')
const OUT_MAX = 60_000
const NAME = /^[a-z0-9][a-z0-9_.-]{0,40}$/

/** scripts/chk-*.sh with the first comment line as description. */
export function scanScripts(dir = SCRIPTS_DIR) {
    let names = []
    try { names = readdirSync(dir).filter((f) => /^chk-.+\.sh$/.test(f)).sort() } catch { return [] }
    return names.map((f) => {
        const lines = readFileSync(path.join(dir, f), 'utf8').split('\n')
        const d = lines.find((l, i) => i > 0 && l.startsWith('#'))
        return { script: f, name: f.replace(/^chk-|\.sh$/g, ''), description: (d ?? '').replace(/^#\s*(chk-[\w.-]+\.sh:?\s*)?/, '').slice(0, 200) }
    })
}

export function list(db, dir) {
    ensure(db)
    const cfg = new Map(db.prepare('SELECT * FROM check_script').all().map((r) => [r.name, r]))
    const last = db.prepare('SELECT * FROM check_run WHERE name = ? ORDER BY id DESC LIMIT 1')
    const known = scanScripts(dir)
    const names = new Set([...known.map((s) => s.name), ...cfg.keys()])
    return [...names].sort().map((name) => {
        const s = known.find((x) => x.name === name), c = cfg.get(name)
        return { name, script: c?.script ?? s?.script ?? '', description: s?.description ?? c?.note ?? '', args: c?.args ?? '', intervalMin: c?.interval_min ?? 0, enabled: c ? !!c.enabled : false, configured: !!c, itemKey: c?.item_key ?? '', note: c?.note ?? '', last: last.get(name) ?? null }
    })
}

export function save(db, { name, script, args = '', intervalMin = 0, enabled = true, itemKey = '', note = '' }, dir = SCRIPTS_DIR) {
    ensure(db)
    if (!NAME.test(String(name ?? ''))) throw new Error('name: lowercase letters, digits, - _ . (max 41)')
    script = String(script ?? `chk-${name}.sh`)
    if (!/^chk-[\w.-]+\.sh$/.test(script)) throw new Error('script must be a scripts/chk-*.sh file name')
    if (!existsSync(path.join(dir, script))) throw new Error(`scripts/${script} does not exist`)
    const iv = Number(intervalMin)
    if (!Number.isInteger(iv) || iv < 0 || iv > 60 * 24 * 31) throw new Error('intervalMin: whole minutes, 0 = manual only')
    if (/[\n\r]/.test(String(args))) throw new Error('args: one line')
    db.prepare(`INSERT INTO check_script (name, script, args, interval_min, enabled, item_key, note, created_at) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT (name) DO UPDATE SET script=excluded.script, args=excluded.args, interval_min=excluded.interval_min, enabled=excluded.enabled, item_key=excluded.item_key, note=excluded.note`)
        .run(name, script, String(args), iv, enabled ? 1 : 0, String(itemKey), String(note), Date.now())
    return list(db, dir).find((c) => c.name === name)
}
export function remove(db, name) {
    ensure(db)
    if (!db.prepare('DELETE FROM check_script WHERE name = ?').run(name).changes) throw new Error(`no configured check "${name}"`)
    return { name }
}

export const statusOf = (code) => (code === 0 ? 'ok' : code === 1 ? 'flagged' : 'unreadable')
export const countFlags = (text) => String(text).split('\n').filter((l) => l.startsWith('FLAG')).length

/** Run one script now; `exec` is injectable. Returns the check_run row. */
export function runScript(db, name, { trigger = 'manual', exec = spawnSync, dir = SCRIPTS_DIR, timeoutS = 600 } = {}) {
    ensure(db)
    const c = list(db, dir).find((x) => x.name === name)
    if (!c || !c.script) throw new Error(`no check "${name}" (nightly check scripts)`)
    const t0 = Date.now()
    const id = Number(db.prepare('INSERT INTO check_run (name, script, started_at, trigger) VALUES (?,?,?,?)').run(name, c.script, t0, trigger).lastInsertRowid)
    let r
    try { r = exec('bash', [path.join(dir, c.script), ...c.args.split(/\s+/).filter(Boolean)], { encoding: 'utf8', maxBuffer: 16 << 20, timeout: timeoutS * 1000, cwd: path.join(dir, '..') }) } catch (e) { r = { status: 2, stdout: '', stderr: String(e.message) } }
    const code = r.status ?? 2
    const out = `${r.stdout ?? ''}${r.stderr ? '\n' + r.stderr : ''}`.slice(-OUT_MAX)
    db.prepare('UPDATE check_run SET finished_at = ?, exit_code = ?, status = ?, output = ?, flags = ? WHERE id = ?').run(Date.now(), code, statusOf(code), out, countFlags(out), id)
    return db.prepare('SELECT * FROM check_run WHERE id = ?').get(id)
}

export function runs(db, { name, limit = 30 } = {}) {
    ensure(db)
    return db.prepare(`SELECT id, name, script, started_at, finished_at, exit_code, status, trigger, flags, substr(output, -4000) AS output FROM check_run ${name ? 'WHERE name = ?' : ''} ORDER BY id DESC LIMIT ?`).all(...(name ? [name] : []), limit)
}

/** Tick: run every enabled, scheduled script whose last run is older than its interval. */
export function tickHook(db, { now = Date.now(), ...o } = {}) {
    ensure(db)
    const lines = []
    for (const c of list(db, o.dir)) {
        if (!c.configured || !c.enabled || !c.intervalMin) continue
        if (c.last && now - c.last.started_at < c.intervalMin * 60_000) continue
        if (c.last && c.last.status === 'running' && now - c.last.started_at < 15 * 60_000) continue
        const r = runScript(db, c.name, { trigger: 'schedule', ...o })
        lines.push(`check ${c.name}: ${r.status}${r.flags ? ` (${r.flags} flags)` : ''}`)
    }
    return lines
}
