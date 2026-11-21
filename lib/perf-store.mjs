// PERFORMANCE tab, the database side (CLI, node:sqlite). The panel never writes these tables.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import * as S from './store.mjs'
import * as P from './perf.mjs'

const SLUG = /^[a-z0-9][a-z0-9_-]{0,39}$/
export const PERF_DIR = () => process.env.NIGHTLY_PERF_DIR || path.join(path.dirname(S.DB_PATH), 'perf')
const MIGRATION = path.join(S.ROOT, 'prisma', 'migrations', '20261120000000_perf', 'migration.sql')

/** Settings with their defaults. 0 means unlimited; nothing is capped silently. */
export const SETTINGS = {
    perfMaxArtifactBytes: 50_000_000,   // per file stored on disk; larger input is refused (fail loudly), 0 = unlimited
    perfRetentionDays: 0,               // runs older than this are deleted with their artefacts, 0 = keep forever
    perfRetentionRuns: 0,               // newest N runs kept per game, 0 = unlimited
    perfMaxFunctions: 300,              // function rows stored per run, 0 = all
    perfBreachItems: 1,                 // 1 = a breached budget files a queue item, 0 = findings only
}
export const setting = (db, k) => {
    const v = S.getSetting(db, k)
    const n = v === null || v === '' ? SETTINGS[k] : Number(v)
    if (!Number.isFinite(n) || n < 0) throw new Error(`setting ${k} must be a number >= 0 (0 = unlimited), got "${v}"`)
    return n
}

export function migrate(db) {
    db.exec(readFileSync(MIGRATION, 'utf8'))
}
export function ready(db) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='PerfRun'").get()) {
        throw new Error('the perf tables are missing: run `nightly perf migrate` (back up data/nightly.db first)')
    }
}

// ---------- games ----------

const parseJson = (s, d) => { try { return JSON.parse(s) } catch { return d } }
export const hydrate = (g) => g && { ...g, enabled: !!g.enabled, platforms: g.platforms.split(',').filter(Boolean), budgets: parseJson(g.budgets, []), routing: parseJson(g.routing, {}), addons: parseJson(g.addons, {}) }
export const getGame = (db, slug) => hydrate(db.prepare('SELECT * FROM PerfGame WHERE slug = ?').get(slug))
export const listGames = (db) => db.prepare('SELECT * FROM PerfGame ORDER BY slug').all().map(hydrate)

/** Create or update (when `update`) a game. `o` fields: slug name repo repoPath engine platforms owner budgets routing addons perfScript enabled. */
export function saveGame(db, o, { update = false } = {}) {
    const slug = String(o.slug ?? o.id ?? '').trim()
    if (!SLUG.test(slug)) throw new Error(`game id "${slug}": lowercase letters, digits, - and _ (max 40)`)
    const old = db.prepare('SELECT * FROM PerfGame WHERE slug = ?').get(slug)
    if (old && !update) throw new Error(`game "${slug}" already exists (use \`nightly perf game set\`)`)
    if (!old && update) throw new Error(`no game "${slug}"`)
    const cur = old ? hydrate(old) : { name: slug, repo: '', repoPath: '', engine: 'godot', platforms: ['native', 'web'], owner: '', budgets: [], routing: {}, addons: {}, perfScript: 'tools/perf.sh', enabled: true }
    const m = { ...cur, ...Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) }
    const platforms = (Array.isArray(m.platforms) ? m.platforms : String(m.platforms).split(',')).map((s) => s.trim()).filter(Boolean)
    for (const p of platforms) if (!P.PLATFORMS.includes(p)) throw new Error(`platform "${p}": one of ${P.PLATFORMS.join(', ')}`)
    const budgets = P.normaliseBudgets(m.budgets)
    const t = S.now()
    const vals = [m.name || slug, m.repo, m.repoPath, m.engine, platforms.join(','), m.owner, JSON.stringify(budgets), JSON.stringify(m.routing ?? {}), JSON.stringify(m.addons ?? {}), m.perfScript, m.enabled === false || m.enabled === 'false' ? 0 : 1]
    if (old) db.prepare('UPDATE PerfGame SET name=?, repo=?, repoPath=?, engine=?, platforms=?, owner=?, budgets=?, routing=?, addons=?, perfScript=?, enabled=?, updatedAt=? WHERE slug=?').run(...vals, t, slug)
    else db.prepare('INSERT INTO PerfGame (name, repo, repoPath, engine, platforms, owner, budgets, routing, addons, perfScript, enabled, slug, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...vals, slug, t, t)
    return getGame(db, slug)
}

// ---------- ingest ----------

const clean = (s) => String(s).replace(/[^\w.-]/g, '_').slice(0, 80)

function writeArtefact(db, dir, file, content) {
    const max = setting(db, 'perfMaxArtifactBytes')
    const bytes = Buffer.byteLength(content)
    if (max > 0 && bytes > max) throw new Error(`${file} is ${bytes} bytes, over perfMaxArtifactBytes=${max} (raise it with \`nightly set-setting perfMaxArtifactBytes N\`, 0 = unlimited)`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, file), content)
}

/**
 * Store one parsed report as a run. `parsed` is parseAny()'s result; `o` overrides its run fields
 * (game is required; platform, role, map, bots, commit, name, gpu, resolution, label, ranAt, source) and may carry
 * `raw` (the original text to keep) and `register` (create an unknown game on the fly).
 * Returns {run, breaches, findings}.
 */
export function ingest(db, parsed, o = {}) {
    ready(db)
    const slug = String(o.game ?? parsed.run.game ?? '')
    if (!slug) throw new Error('--game is required (the report does not name one)')
    let game = getGame(db, slug)
    if (!game) {
        if (!o.register) throw new Error(`unknown game "${slug}": add it first (\`nightly perf game add --id ${slug} --name ...\`) or pass --register`)
        game = saveGame(db, { slug, name: o.name_ || slug })
    }
    const r = { ...parsed.run }
    for (const k of ['platform', 'role', 'map', 'commit', 'name', 'gpu', 'resolution', 'label', 'branch', 'build', 'source']) if (o[k] !== undefined && o[k] !== '') r[k] = o[k]
    if (o.bots !== undefined) r.bots = Number(o.bots)
    if (o.ranAt) r.ranAt = o.ranAt
    if (o.duration !== undefined) r.durationS = Number(o.duration)
    r.platform = r.platform || 'native'
    r.role = r.role || 'client'
    if (!P.PLATFORMS.includes(r.platform)) throw new Error(`platform "${r.platform}": one of ${P.PLATFORMS.join(', ')}`)
    if (!P.ROLES.includes(r.role)) throw new Error(`role "${r.role}": one of ${P.ROLES.join(', ')}`)
    const when = new Date(r.ranAt || Date.now())
    if (Number.isNaN(when.getTime())) throw new Error(`bad ranAt "${r.ranAt}"`)
    const metrics = { ...parsed.metrics, ...(o.metrics ?? {}) }
    const funcs = parsed.functions ?? []
    if (!Object.keys(metrics).length && !funcs.length) throw new Error('nothing to store: the input has no metrics and no function rows')
    const maxFn = setting(db, 'perfMaxFunctions')
    const keep = maxFn > 0 ? funcs.slice(0, maxFn) : funcs
    const bots = Number.isFinite(r.bots) ? Math.trunc(r.bots) : 0
    const run = { game: slug, name: r.name ?? '', commit: r.commit ?? '', build: r.build ?? '', branch: r.branch ?? '', platform: r.platform, role: r.role, map: r.map ?? '', bots,
        resolution: r.resolution ?? '', gpu: r.gpu ?? '', durationS: r.durationS ?? 0, frames: r.frames ?? 0, ranAt: when.toISOString(), source: r.source ?? '', label: r.label ?? '', reportVersion: r.reportVersion ?? 0 }

    // Artefacts first: a refusal (size limit) must leave no half-stored run behind.
    const stamp = `${slug}/${when.toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 7)}`
    const dir = path.join(PERF_DIR(), ...stamp.split('/').map(clean))
    const files = []
    try {
        if (parsed.kind === 'json' || parsed.kind === 'bench') { writeArtefact(db, dir, 'report.json', o.raw ?? JSON.stringify(parsed)); files.push('report.json') }
        if (parsed.kind === 'txt') { writeArtefact(db, dir, 'report.txt', parsed.text ?? o.raw ?? ''); files.push('report.txt') }
        const folded = o.folded ?? parsed.folded
        if (folded) { writeArtefact(db, dir, 'stacks.folded', folded); files.push('stacks.folded') }
    } catch (e) { rmSync(dir, { recursive: true, force: true }); throw e }
    run.artefact = files.length ? path.relative(PERF_DIR(), dir) : ''

    const id = S.tx(db, () => {
        const res = db.prepare(`INSERT INTO PerfRun (game, name, "commit", build, branch, platform, role, map, bots, resolution, gpu, durationS, frames, ranAt, source, label, reportVersion, artefact, createdAt)
            VALUES (@game, @name, @commit, @build, @branch, @platform, @role, @map, @bots, @resolution, @gpu, @durationS, @frames, @ranAt, @source, @label, @reportVersion, @artefact, @createdAt)`).run({ ...run, createdAt: S.now() })
        const rid = Number(res.lastInsertRowid)
        const im = db.prepare('INSERT INTO PerfMetric (runId, name, value) VALUES (?,?,?)')
        for (const [k, v] of Object.entries(metrics)) im.run(rid, k, v)
        const iff = db.prepare('INSERT INTO PerfFunc (runId, name, path, per, grp, addon, selfMs, totalMs, calls) VALUES (?,?,?,?,?,?,?,?,?)')
        for (const f of keep) iff.run(rid, f.name, f.path ?? '', f.per ?? 'frame', f.grp ?? 'other', f.addon ?? '', f.selfMs ?? 0, f.totalMs ?? 0, f.calls ?? 0)
        return rid
    })
    const { breaches } = P.evaluateBudgets(game.budgets, run, metrics)
    const findings = o.noFindings ? [] : syncFindings(db, game, id, run, metrics, breaches)
    prune(db, slug)
    return { run: { id, ...run }, metrics, breaches, findings, functions: keep.length }
}

// ---------- findings: budget breach -> queue item, deduped by game + metric ----------

export function syncFindings(db, game, runId, run, metrics, breaches) {
    const out = []
    const t = S.now()
    const where = `${run.platform}/${run.role}${run.map ? '/' + run.map : ''}${run.bots ? ` ${run.bots} bots` : ''}`
    const unit = (m) => P.unitOf(m)
    for (const b of breaches) {
        const f = db.prepare('SELECT * FROM PerfFinding WHERE game = ? AND metric = ?').get(game.slug, b.metric)
        const line = `${b.metric} = ${+b.value.toFixed(3)}${unit(b.metric)} breaks the ${b.op === 'max' ? 'max' : 'min'} ${b.limit} (${where}, run #${runId}${run.commit ? ', ' + run.commit.slice(0, 9) : ''}).`
        const item = f?.itemKey ? S.getItem(db, f.itemKey) : null
        if (f && f.status === 'open' && item && S.OPEN_STATUSES.includes(item.status)) {
            // Same finding still open: add to the item, never a second one.
            db.prepare('UPDATE PerfFinding SET runId=?, value=?, "limit"=?, note=?, updatedAt=? WHERE id=?').run(runId, b.value, b.limit, line, t, f.id)
            S.addNote(db, item.key, `Still over budget: ${line}`, { author: 'nightly' })
            out.push({ metric: b.metric, itemKey: item.key, created: false })
            continue
        }
        let key = ''
        if (setting(db, 'perfBreachItems')) {
            const base = `perf-${game.slug}-${b.metric}`.replace(/[^a-z0-9-]+/gi, '-').toLowerCase()
            const it = S.addItem(db, {
                key: S.getItem(db, base) ? S.uniqueKey(db, base) : base,
                title: `perf: ${game.name} ${b.metric} over budget`, kind: 'issue', addedBy: 'nightly', repos: game.repo || undefined,
                body: `${line}\n\nBudget: \`${P.budgetSpec(b)}\`. Raw run and stacks are in the PERFORMANCE tab: /perf/${game.slug}/run/${runId}.\nThis item is deduped by game + metric (\`${game.slug}\` / \`${b.metric}\`): later breaches add a note here.`,
                doneWhen: `${b.metric} ${b.op === 'max' ? '<=' : '>='} ${b.limit} on the next perf run`,
            })
            key = it.key
        }
        if (f) db.prepare("UPDATE PerfFinding SET runId=?, itemKey=?, status='open', value=?, \"limit\"=?, note=?, updatedAt=? WHERE id=?").run(runId, key, b.value, b.limit, line, t, f.id)
        else db.prepare('INSERT INTO PerfFinding (game, metric, runId, itemKey, status, value, "limit", note, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)').run(game.slug, b.metric, runId, key, 'open', b.value, b.limit, line, t, t)
        out.push({ metric: b.metric, itemKey: key, created: !!key })
    }
    // A metric that was checked and passes closes its open finding (the item stays for the owner to close).
    const broken = new Set(breaches.map((b) => b.metric))
    for (const b of P.evaluateBudgets(game.budgets, run, metrics).checked) {
        if (broken.has(b.metric)) continue
        db.prepare("UPDATE PerfFinding SET status='resolved', updatedAt=? WHERE game=? AND metric=? AND status='open'").run(t, game.slug, b.metric)
    }
    return out
}

/** Manual finding: link a perf metric/problem to an existing item (--item KEY) or file a new one. */
export function addFinding(db, { game, metric, item, title, body, runId }) {
    ready(db)
    const g = getGame(db, game)
    if (!g) throw new Error(`unknown game "${game}"`)
    if (!metric) throw new Error('--metric is required')
    let key = item
    if (key) S.mustItem(db, key)
    else key = S.addItem(db, { title: title || `perf: ${g.name} ${metric}`, kind: 'issue', addedBy: 'nightly', repos: g.repo || undefined, body: body || '' }).key
    const t = S.now()
    db.prepare(`INSERT INTO PerfFinding (game, metric, runId, itemKey, status, value, "limit", note, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(game, metric) DO UPDATE SET itemKey=excluded.itemKey, runId=excluded.runId, status='open', updatedAt=excluded.updatedAt`).run(game, metric, runId ?? null, key, 'open', 0, 0, body || '', t, t)
    return { game, metric, itemKey: key }
}

// ---------- retention ----------

export function prune(db, slug, at = Date.now()) {
    const days = setting(db, 'perfRetentionDays')
    const keepN = setting(db, 'perfRetentionRuns')
    const doomed = new Map()
    if (days > 0) for (const r of db.prepare('SELECT id, artefact FROM PerfRun WHERE game = ? AND ranAt < ?').all(slug, new Date(at - days * 86400_000).toISOString())) doomed.set(r.id, r.artefact)
    if (keepN > 0) for (const r of db.prepare('SELECT id, artefact FROM PerfRun WHERE game = ? ORDER BY ranAt DESC, id DESC LIMIT -1 OFFSET ?').all(slug, keepN)) doomed.set(r.id, r.artefact)
    for (const [id, art] of doomed) {
        db.prepare('DELETE FROM PerfRun WHERE id = ?').run(id)
        if (art) rmSync(path.join(PERF_DIR(), art), { recursive: true, force: true })
    }
    return doomed.size
}

export function listRuns(db, { game, limit = 20 } = {}) {
    ready(db)
    return db.prepare(`SELECT * FROM PerfRun ${game ? 'WHERE game = ?' : ''} ORDER BY ranAt DESC, id DESC LIMIT ?`).all(...(game ? [game] : []), limit)
}
export const runMetrics = (db, id) => Object.fromEntries(db.prepare('SELECT name, value FROM PerfMetric WHERE runId = ?').all(id).map((r) => [r.name, r.value]))
export const runFuncs = (db, id) => db.prepare('SELECT name, path, per, grp, addon, selfMs, totalMs, calls FROM PerfFunc WHERE runId = ? ORDER BY selfMs DESC').all(id)

export const artefactPath = (art, file) => path.join(PERF_DIR(), art, file)
export const hasArtefact = (art, file) => !!art && existsSync(artefactPath(art, file))
