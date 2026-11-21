// PERFORMANCE tab, the database side (CLI, node:sqlite). The panel never writes these tables.
import { createHash, randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import * as S from './store.mjs'
import * as P from './perf.mjs'

const SLUG = /^[a-z0-9][a-z0-9_-]{0,39}$/
export const PERF_DIR = () => process.env.NIGHTLY_PERF_DIR || path.join(path.dirname(S.DB_PATH), 'perf')
const MIGRATIONS = ['20261120000000_perf', '20261121000000_perf_rsi', '20261122000000_perf_shot'].map((d) => path.join(S.ROOT, 'prisma', 'migrations', d, 'migration.sql'))

/** Settings with their defaults. 0 means unlimited; nothing is capped silently. */
export const SETTINGS = {
    perfMaxArtifactBytes: 50_000_000,   // per file stored on disk; larger input is refused (fail loudly), 0 = unlimited
    perfRetentionDays: 0,               // runs older than this are deleted with their artefacts, 0 = keep forever
    perfRetentionRuns: 0,               // newest N runs kept per game, 0 = unlimited
    perfMaxFunctions: 300,              // function rows stored per run, 0 = all
    perfBreachItems: 1,                 // 1 = a breached budget files a queue item, 0 = findings only
    perfRegression: 1,                  // 1 = compare each run with the previous ones of its scope, 0 = off
    perfRegressionRuns: 5,              // previous comparable runs (same game/platform/role/map/bots) in the baseline, 0 = all earlier runs
    perfRegressionMinRuns: 3,           // fewer earlier runs than this = no verdict
    perfRegressionNoisePct: 5,          // smallest change, in percent of the baseline median, that counts
    perfRegressionSigma: 3,             // ... or this many robust standard deviations of the history, whichever is larger
    perfRegressionItems: 1,             // 1 = a regression files a queue item (deduped by game + metric + scope), 0 = findings only
    perfOffenderItems: 1,               // 1 = a top offender files a queue item (deduped by game + function), 0 = listed only
    perfOffenderMinMs: 1,               // a function must average at least this self ms per frame to be an offender
    perfOffenderTop: 3,                 // at most this many offenders per run scope, 0 = all above the threshold
    perfOffenderRuns: 5,                // newest runs of the scope the average is taken over, 0 = all
    perfOffenderMinRuns: 2,             // runs of the scope needed before any function is filed
    perfMaxShotBytes: 5_000_000,        // per screenshot upload; larger is refused (fail loudly), 0 = unlimited
    perfMaxShotsPerRun: 30,             // screenshots kept per run; more is refused, 0 = unlimited
    perfRequireToken: 0,                // 0 = HTTP ingest needs a token once any exists, 1 = always (refuses everything until one is made)
}
export const setting = (db, k) => {
    const v = S.getSetting(db, k)
    const n = v === null || v === '' ? SETTINGS[k] : Number(v)
    if (!Number.isFinite(n) || n < 0) throw new Error(`setting ${k} must be a number >= 0 (0 = unlimited), got "${v}"`)
    return n
}

/** Is there anything for `migrate` to do? (a missing table or a missing PerfFinding column) */
export function pending(db) {
    const has = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)
    if (!has('PerfRun') || !has('PerfToken') || !has('PerfShot')) return true
    return !db.prepare("SELECT 1 FROM pragma_table_info('PerfFinding') WHERE name='history'").get()
}
/** Apply the perf migrations, one statement at a time (an ALTER whose column exists is skipped). With `backup` and work to do,
 *  the database is first copied (VACUUM INTO, consistent under WAL) to <db dir>/backup/. Returns the backup path or ''. */
export function migrate(db, { backup = false } = {}) {
    let bak = ''
    if (backup && pending(db)) {
        const dir = path.join(path.dirname(S.DB_PATH), 'backup')
        mkdirSync(dir, { recursive: true })
        bak = path.join(dir, `nightly-pre-perf-migrate-${new Date().toISOString().replace(/[:.]/g, '-')}.db`)
        db.exec(`VACUUM INTO '${bak.replace(/'/g, "''")}'`)
    }
    for (const f of MIGRATIONS) {
        const sql = readFileSync(f, 'utf8').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
        for (const st of sql.split(/;\s*(?:\n|$)/).map((x) => x.trim()).filter(Boolean)) {
            try { db.exec(st) } catch (e) { if (!/duplicate column name/i.test(e.message)) throw new Error(`${path.basename(path.dirname(f))}: ${e.message} in: ${st.slice(0, 80)}`) }
        }
    }
    return bak
}
export function ready(db) {
    if (pending(db)) throw new Error('the perf tables are missing or old: run `nightly perf migrate` (it backs up the database first)')
}

// ---------- ingest tokens ----------

const sha = (s) => createHash('sha256').update(String(s)).digest('hex')
const TOKEN_NAME = /^[\w.-]{1,40}$/

/** Make a token for one runner and/or game. The secret is returned here ONCE and never stored: only its sha256 is. */
export function addToken(db, { name, game = '' }) {
    ready(db)
    if (!TOKEN_NAME.test(String(name ?? ''))) throw new Error('token --name: letters, digits, . _ - (max 40), e.g. the runner box or game')
    if (game && !getGame(db, game)) throw new Error(`unknown game "${game}"`)
    if (db.prepare('SELECT 1 FROM PerfToken WHERE name = ?').get(name)) throw new Error(`a token named "${name}" exists (revoke it first, or pick another name)`)
    const secret = `nps_${randomBytes(24).toString('base64url')}`
    db.prepare('INSERT INTO PerfToken (name, hash, prefix, game, createdAt) VALUES (?,?,?,?,?)').run(name, sha(secret), secret.slice(0, 8), game, S.now())
    return { name, game, prefix: secret.slice(0, 8), token: secret }
}
export const listTokens = (db) => { ready(db); return db.prepare('SELECT id, name, prefix, game, createdAt, lastUsedAt, revokedAt FROM PerfToken ORDER BY name').all() }
export function revokeToken(db, name) {
    ready(db)
    const r = db.prepare('UPDATE PerfToken SET revokedAt = ? WHERE name = ? AND revokedAt IS NULL').run(S.now(), String(name))
    if (!r.changes) throw new Error(`no active token named "${name}"`)
    return { name, revoked: true }
}
/** Gate for HTTP ingest. Returns the token row, or null when none is needed (no active token exists and perfRequireToken=0).
 *  Messages never contain the secret. */
export function authorizeIngest(db, secret, game, { strict = false } = {}) {
    ready(db)
    const active = db.prepare('SELECT COUNT(*) n FROM PerfToken WHERE revokedAt IS NULL').get().n
    if (!strict && !active && !setting(db, 'perfRequireToken')) return null
    if (!secret) throw new Error('ingest token required: send "Authorization: Bearer <token>" (make one with `nightly perf token add --name N [--game G]`)')
    const row = db.prepare('SELECT * FROM PerfToken WHERE hash = ? AND revokedAt IS NULL').get(sha(secret))
    if (!row) throw new Error('ingest token not recognised or revoked')
    if (row.game && game && row.game !== game) throw new Error(`ingest token "${row.name}" is limited to game "${row.game}"`)
    db.prepare('UPDATE PerfToken SET lastUsedAt = ? WHERE id = ?').run(S.now(), row.id)
    return row
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
    let findings = [], regressions = [], offenders = []
    if (!o.noFindings) {
        syncRsi(db, game, { id, run, metrics, funcs: keep })
        findings = syncFindings(db, game, id, run, metrics, breaches)
        if (setting(db, 'perfRegression')) regressions = detectRegressions(db, game, id, run, metrics)
        offenders = fileOffenders(db, game, id, run)
    }
    prune(db, slug)
    return { run: { id, ...run }, metrics, breaches, findings, regressions, offenders, functions: keep.length }
}

// ---------- findings: budget breach -> queue item, deduped by game + metric ----------

export function syncFindings(db, game, runId, run, metrics, breaches) {
    const out = []
    const t = S.now()
    const where = `${run.platform}/${run.role}${run.map ? '/' + run.map : ''}${run.bots ? ` ${run.bots} bots` : ''}`
    const unit = (m) => P.unitOf(m)
    for (const b of breaches) {
        const f = db.prepare('SELECT * FROM PerfFinding WHERE game = ? AND metric = ?').get(game.slug, b.metric)
        if (f && f.state === 'dismissed' && f.kind !== 'budget') continue
        const line = `${b.metric} = ${+b.value.toFixed(3)}${unit(b.metric)} breaks the ${b.op === 'max' ? 'max' : 'min'} ${b.limit} (${where}, run #${runId}${run.commit ? ', ' + run.commit.slice(0, 9) : ''}).`
        const item = f?.itemKey ? S.getItem(db, f.itemKey) : null
        if (f && f.status === 'open' && f.state === 'found' && item && S.OPEN_STATUSES.includes(item.status)) {
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
        if (f) db.prepare("UPDATE PerfFinding SET runId=?, itemKey=?, status='open', value=?, \"limit\"=?, note=?, updatedAt=?, state='found', history=?, scope=?, beforeValue=NULL, afterValue=NULL, fixedAt=NULL, remeasuredRunId=NULL, remeasuredAt=NULL WHERE id=?").run(runId, key, b.value, b.limit, line, t, archive(f), scopeJson(run, b.metric), f.id)
        else db.prepare('INSERT INTO PerfFinding (game, metric, runId, itemKey, status, value, "limit", note, createdAt, updatedAt, kind, scope) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(game.slug, b.metric, runId, key, 'open', b.value, b.limit, line, t, t, 'budget', scopeJson(run, b.metric))
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


// ---------- regressions, offenders and the RSI loop (found -> fixed -> remeasured) ----------

const scopeJson = (run, metric = '') => JSON.stringify({ platform: run.platform, role: run.role, map: run.map || '', bots: run.bots || 0, metric })
const scopeLabel = (run) => `${run.platform}/${run.role}${run.map ? '/' + run.map : ''}${run.bots ? ` ${run.bots} bots` : ''}`
const slugOf = (x) => String(x).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 48) || 'x'
/** A finding that comes back after a completed cycle: keep the old cycle in `history` (JSON list). */
function archive(f) {
    const h = parseJson(f.history, [])
    if (f.state === 'remeasured' || f.state === 'fixed') h.push({ itemKey: f.itemKey, before: f.beforeValue, after: f.afterValue, fixedAt: f.fixedAt, remeasuredAt: f.remeasuredAt, remeasuredRunId: f.remeasuredRunId, state: f.state, reopenedAt: S.now() })
    return JSON.stringify(h)
}
const SCOPE_SQL = 'game = @game AND platform = @platform AND role = @role AND map = @map AND bots = @bots'
const scopeArgs = (game, run) => ({ game, platform: run.platform, role: run.role, map: run.map || '', bots: run.bots || 0 })

/** File or update one non-budget finding (regression or offender): deduped per game + metric key, one queue item while it is open. */
function raise(db, game, o) {
    const t = S.now()
    const f = db.prepare('SELECT * FROM PerfFinding WHERE game = ? AND metric = ?').get(game.slug, o.metric)
    if (f && f.state === 'dismissed') return null
    const item = f?.itemKey ? S.getItem(db, f.itemKey) : null
    if (f && f.state === 'found' && f.status === 'open' && (item ? S.OPEN_STATUSES.includes(item.status) : !o.items)) {
        db.prepare('UPDATE PerfFinding SET runId=?, value=?, "limit"=?, note=?, updatedAt=? WHERE id=?').run(o.runId, o.value, o.limit, o.line, t, f.id)
        if (item) S.addNote(db, item.key, `Still there: ${o.line}`, { author: 'nightly' })
        return { metric: o.metric, itemKey: item?.key ?? '', created: false }
    }
    let key = ''
    if (o.items) {
        const it = S.addItem(db, { key: S.getItem(db, o.itemBase) ? S.uniqueKey(db, o.itemBase) : o.itemBase, title: o.title, kind: 'issue', addedBy: 'nightly', repos: game.repo || undefined,
            body: `${o.line}\n\n${o.body}\nRuns and stacks: the PERFORMANCE tab, /perf/${game.slug}/run/${o.runId}. Deduped by game + ${o.kind === 'offender' ? 'function' : 'metric and scope'}: later runs add a note here; when this item closes the next run in the same scope remeasures it (RSI tab).`, doneWhen: o.doneWhen })
        key = it.key
    }
    if (f) db.prepare("UPDATE PerfFinding SET runId=?, itemKey=?, status='open', value=?, \"limit\"=?, note=?, updatedAt=?, kind=?, state='found', fn=?, scope=?, history=?, beforeValue=NULL, afterValue=NULL, fixedAt=NULL, remeasuredRunId=NULL, remeasuredAt=NULL WHERE id=?").run(o.runId, key, o.value, o.limit, o.line, t, o.kind, o.fn ?? '', o.scope, archive(f), f.id)
    else db.prepare('INSERT INTO PerfFinding (game, metric, runId, itemKey, status, value, "limit", note, createdAt, updatedAt, kind, fn, scope) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(game.slug, o.metric, o.runId, key, 'open', o.value, o.limit, o.line, t, t, o.kind, o.fn ?? '', o.scope)
    return { metric: o.metric, itemKey: key, created: !!key }
}

/** Compare this run's watched metrics with the previous N comparable runs (same game/platform/role/map/bots). */
export function detectRegressions(db, game, runId, run, metrics) {
    const n = setting(db, 'perfRegressionRuns')
    const opts = { noisePct: setting(db, 'perfRegressionNoisePct'), sigma: setting(db, 'perfRegressionSigma'), minRuns: setting(db, 'perfRegressionMinRuns') }
    const prev = db.prepare(`SELECT id FROM PerfRun WHERE ${SCOPE_SQL} AND id < @id ORDER BY ranAt DESC, id DESC${n > 0 ? ' LIMIT @n' : ''}`).all({ ...scopeArgs(game.slug, run), id: runId, n }).map((r) => r.id)
    const out = []
    if (prev.length < Math.max(1, opts.minRuns)) return out
    const hist = db.prepare(`SELECT runId, value FROM PerfMetric WHERE name = ? AND runId IN (${prev.map(() => '?').join(',')})`)
    for (const m of P.WATCHED) {
        if (!Number.isFinite(metrics[m])) continue
        const d = P.detectRegression(m, metrics[m], hist.all(m, ...prev).map((r) => r.value), opts)
        if (!d.regressed) continue
        const sign = d.delta >= 0 ? '+' : ''
        const line = `${m} regressed: ${+d.value.toFixed(3)}${P.unitOf(m)} vs a median of ${+d.baseline.toFixed(3)} over the last ${d.n} runs (${sign}${+d.delta.toFixed(3)}, ${sign}${d.pct.toFixed(1)}%; noise allowance ${+d.allowance.toFixed(3)}) on ${scopeLabel(run)}, run #${runId}${run.commit ? ', ' + run.commit.slice(0, 9) : ''}.`
        const r = raise(db, game, { kind: 'regression', metric: `regress:${m}@${scopeLabel(run)}`, runId, value: d.value, limit: d.baseline, line, scope: scopeJson(run, m), items: setting(db, 'perfRegressionItems'),
            itemBase: `perf-${game.slug}-regress-${slugOf(m)}`, title: `perf: ${game.name} ${m} regressed on ${scopeLabel(run)}`,
            body: `Baseline: median of the previous ${d.n} comparable runs; the allowance is the larger of ${opts.noisePct}% and ${opts.sigma} robust sigmas of their spread (settings perfRegression*).`,
            doneWhen: `${m} is back within ${+d.allowance.toFixed(2)} of ${+d.baseline.toFixed(2)} on the next run of ${scopeLabel(run)}` })
        if (r) out.push({ ...r, regressionOf: m, pct: d.pct })
    }
    return out
}

/** Top self-time functions of the scope, averaged over its newest runs, filed once per game + function. */
export function fileOffenders(db, game, runId, run) {
    const n = setting(db, 'perfOffenderRuns')
    const runs = db.prepare(`SELECT id FROM PerfRun WHERE ${SCOPE_SQL} AND id <= @id ORDER BY ranAt DESC, id DESC${n > 0 ? ' LIMIT @n' : ''}`).all({ ...scopeArgs(game.slug, run), id: runId, n }).map((r) => r.id)
    if (runs.length < Math.max(1, setting(db, 'perfOffenderMinRuns'))) return []
    const rows = db.prepare(`SELECT name, MAX(path) path, MAX(grp) grp, MAX(addon) addon, SUM(selfMs) tot FROM PerfFunc WHERE runId IN (${runs.map(() => '?').join(',')}) AND per = 'frame' GROUP BY name`).all(...runs)
        .map((r) => ({ ...r, selfMs: r.tot / runs.length }))
    // after a fix was remeasured, only runs from that one on count: older (pre-fix) runs must not drag the average back over the threshold
    for (const r of rows) {
        const since = db.prepare("SELECT MAX(remeasuredRunId) id FROM PerfFinding WHERE game = ? AND kind = 'offender' AND fn = ? AND state = 'remeasured' AND scope = ?").get(game.slug, r.name, scopeJson(run, '')).id
        if (!since) continue
        const use = runs.filter((id) => id >= since)
        if (use.length === runs.length || !use.length) continue
        r.selfMs = db.prepare(`SELECT COALESCE(SUM(selfMs),0) t FROM PerfFunc WHERE name = ? AND per = 'frame' AND runId IN (${use.map(() => '?').join(',')})`).get(r.name, ...use).t / use.length
    }
    const top = P.pickOffenders(rows, { minMs: setting(db, 'perfOffenderMinMs'), top: setting(db, 'perfOffenderTop') })
    return top.map((f) => raise(db, game, { kind: 'offender', metric: `fn:${f.name}`, fn: f.name, runId, value: f.selfMs, limit: setting(db, 'perfOffenderMinMs'), scope: scopeJson(run, ''), items: setting(db, 'perfOffenderItems'),
        line: `${f.name} costs ${+f.selfMs.toFixed(3)} ms per frame on average over the last ${runs.length} runs of ${scopeLabel(run)} (self time${f.addon ? ', addon ' + f.addon : ''}${f.path ? ', ' + f.path : ''}).`,
        itemBase: `perf-${game.slug}-fn-${slugOf(f.name)}`, title: `perf: ${game.name} top offender ${f.name}`, body: `Self-time ranking, engine and wait rows excluded (settings perfOffender*).`,
        doneWhen: `${f.name} self time drops clearly below ${+f.selfMs.toFixed(2)} ms/frame on the next runs of ${scopeLabel(run)}` })).filter(Boolean).map((r) => ({ ...r, fn: r.metric.slice(3) }))
}

/** Move findings along found -> fixed -> remeasured as their items close and fresh runs arrive. `ctx` = the run just stored. */
export function syncRsi(db, game, ctx = null) {
    ready(db)
    const t = S.now()
    for (const f of db.prepare("SELECT * FROM PerfFinding WHERE game = ? AND state = 'found' AND itemKey != ''").all(game.slug)) {
        const it = S.getItem(db, f.itemKey)
        if (!it) continue
        if (it.status === 'done') db.prepare("UPDATE PerfFinding SET state='fixed', beforeValue=?, fixedAt=?, updatedAt=? WHERE id=?").run(f.value, it.completedAt || t, t, f.id)
        else if (it.status === 'wontfix') db.prepare("UPDATE PerfFinding SET state='dismissed', updatedAt=? WHERE id=?").run(t, f.id)
    }
    if (!ctx) return
    for (const f of db.prepare("SELECT * FROM PerfFinding WHERE game = ? AND state = 'fixed'").all(game.slug)) {
        const sc = parseJson(f.scope, null)
        if (!sc || sc.platform !== ctx.run.platform || sc.role !== ctx.run.role || (sc.map || '') !== (ctx.run.map || '') || (sc.bots || 0) !== (ctx.run.bots || 0)) continue
        let after = null
        if (f.kind === 'offender') after = ctx.funcs.filter((x) => x.name === f.fn && (x.per ?? 'frame') === 'frame').reduce((a, x) => a + (x.selfMs ?? 0), 0)
        else { const m = sc.metric || f.metric; if (Number.isFinite(ctx.metrics[m])) after = ctx.metrics[m] }
        if (after === null) continue
        db.prepare("UPDATE PerfFinding SET state='remeasured', afterValue=?, remeasuredRunId=?, remeasuredAt=?, status='resolved', updatedAt=? WHERE id=?").run(after, ctx.id, t, t, f.id)
    }
}

/** RSI rows for a game (or all games): every finding with its state and before/after delta. */
export function listRsi(db, { game } = {}) {
    ready(db)
    const rows = db.prepare(`SELECT * FROM PerfFinding ${game ? 'WHERE game = ?' : ''} ORDER BY game, updatedAt DESC`).all(...(game ? [game] : []))
    return rows.map((f) => {
        const it = f.itemKey ? S.getItem(db, f.itemKey) : null
        const delta = f.beforeValue != null && f.afterValue != null ? f.afterValue - f.beforeValue : null
        return { id: f.id, game: f.game, kind: f.kind, metric: f.metric, fn: f.fn, state: f.state, status: f.status, itemKey: f.itemKey, itemStatus: it?.status ?? '', value: f.value, limit: f.limit, note: f.note,
            before: f.beforeValue, after: f.afterValue, delta, pct: delta != null && f.beforeValue ? (delta / Math.abs(f.beforeValue)) * 100 : null,
            runId: f.runId, remeasuredRunId: f.remeasuredRunId, fixedAt: f.fixedAt, remeasuredAt: f.remeasuredAt, updatedAt: f.updatedAt, history: parseJson(f.history, []) }
    })
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
        db.prepare('DELETE FROM PerfShot WHERE runId = ?').run(id)
        rmSync(path.join(PERF_DIR(), 'shots', String(id)), { recursive: true, force: true })
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

// ---------- screenshots attached to runs ----------

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/** Attach a png (Buffer) to a run. Refuses non-png data and anything over the size / count settings (0 = unlimited). */
export function addShot(db, runId, buf, { name = '', note = '' } = {}) {
    ready(db)
    if (!db.prepare('SELECT 1 FROM PerfRun WHERE id = ?').get(runId)) throw new Error(`no run ${runId}`)
    if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.subarray(0, 8).equals(PNG)) throw new Error('not a png image')
    const max = setting(db, 'perfMaxShotBytes')
    if (max > 0 && buf.length > max) throw new Error(`screenshot is ${buf.length} bytes, over perfMaxShotBytes=${max} (raise it with \`nightly setting set perfMaxShotBytes N\`, 0 = unlimited)`)
    const cap = setting(db, 'perfMaxShotsPerRun')
    if (cap > 0 && db.prepare('SELECT COUNT(*) n FROM PerfShot WHERE runId = ?').get(runId).n >= cap) throw new Error(`run ${runId} already has ${cap} screenshots (setting perfMaxShotsPerRun, 0 = unlimited)`)
    const file = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}.png`
    const dir = path.join(PERF_DIR(), 'shots', String(runId))
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, file), buf)
    const res = db.prepare('INSERT INTO PerfShot (runId, name, note, file, bytes, createdAt) VALUES (?,?,?,?,?,?)').run(runId, clean(name).slice(0, 60) === name ? name : String(name).slice(0, 60), String(note).slice(0, 300), file, buf.length, S.now())
    return { id: Number(res.lastInsertRowid), runId, name, note, file, bytes: buf.length }
}
export const listShots = (db, runId) => { ready(db); return db.prepare('SELECT * FROM PerfShot WHERE runId = ? ORDER BY id').all(runId) }
export const shotPath = (runId, file) => path.join(PERF_DIR(), 'shots', String(Number(runId)), clean(file))
