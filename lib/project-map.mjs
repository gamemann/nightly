// Maps tasks (Item), asset packs and maps to Projects. Pure resolution (no node:sqlite, so the panel can import it too) plus
// `mapProjects(db)` for the CLI / bootstrap / migrate-live.sh, which takes a node:sqlite handle.
//
// Why: Item.repos is free text written over months (`game-fatal-contact`, `game-dev/godot/dot-core`, `dev02:godot/zee-dot-weapons`),
// while Projects are keyed by their current checkout slug (`game-fatal-contact`, `gs-core`). The join table ItemProject
// (many-to-many) holds the resolved links; Item.repos is never rewritten, so the original text stays recoverable. ProjectPack
// links the asset/map store (AssetWeapon.pack, AssetSource.name) to the project that owns or uses the pack.
//
// Workspace-specific names (renames, general tags, pack->game rules) are data: the `namingRules` Setting (lib/naming-rules.mjs).
//
// Deterministic and idempotent: the same data always yields the same links, and a second run changes nothing.
import { PIECE_SQL } from './asset-names.mjs'
import { classify, gameFromText, reposFromText } from './classify.mjs'
import { compiled, loadRules, rules } from './naming-rules.mjs'

/** The last path component of a token: `game-dev/godot/game-fatal-contact` and `dev02:godot/dot-core` -> the repo name. */
export function tokenName(t) {
    let s = String(t).trim().replace(/^[`'"(\[~]+|[`'"),.;:\]]+$/g, '').replace(/\/+$/, '')
    s = s.split('/').pop().split(':').pop()
    return s.toLowerCase()
}

/** Every repo token of a repos string, in order, without repeats (comma or whitespace separated). */
export function tokensOf(repos) {
    const out = []
    for (const raw of String(repos ?? '').split(/[,\s]+/)) {
        const t = raw.trim()
        if (t && !out.includes(t)) out.push(t)
    }
    return out
}

/** Build a resolver over the project list `[{ slug, repoPath, settings }]` (settings is the JSON text or object; `aliases` there adds names). */
export function makeResolver(projects, { renames = rules.renames } = {}) {
    const slugs = new Set(projects.map((p) => p.slug))
    const alias = new Map(Object.entries(renames))
    for (const p of projects) {
        const base = String(p.repoPath ?? '').replace(/\/+$/, '').split('/').pop()
        if (base && base !== p.slug && !slugs.has(base)) alias.set(base.toLowerCase(), p.slug)
        let s = p.settings
        try { if (typeof s === 'string') s = JSON.parse(s || '{}') } catch { s = {} }
        for (const a of Array.isArray(s?.aliases) ? s.aliases : []) alias.set(String(a).toLowerCase(), p.slug)
    }
    const byGame = new Map(projects.filter((p) => p.type === 'game').map((p) => [p.slug, p]))
    const direct = (n) => {
        if (slugs.has(n)) return { slug: n, via: 'slug' }
        if (alias.has(n) && slugs.has(alias.get(n))) return { slug: alias.get(n), via: 'alias' }
        return null
    }
    // rules.rewrites [[regex, replacement]] apply in order to a renamed family of repos (dot-core -> gs-core)
    const rewrites = (rules.rewrites ?? []).map(([re, to]) => [new RegExp(re), to])
    const gsForm = (n) => rewrites.reduce((x, [re, to]) => x.replace(re, to), n)

    /** One token -> { slug, via } | { general: true } | null (unresolved). */
    function resolveToken(token) {
        const n = tokenName(token)
        if (!n) return null
        if (compiled.general.has(n)) return { general: true }
        const forms = [n]
        const g = gsForm(n)
        if (g !== n) forms.push(g)
        for (const f of forms) { const r = direct(f); if (r) return f === n ? r : { slug: r.slug, via: 'rename' } }
        // trailing counters and sub-task words: dot-player-char-38 -> gs-player-char; game-fatal-contact-vjudge -> game-fatal-contact
        for (const f of forms) {
            const parts = f.split('-')
            for (let k = parts.length - 1; k >= 2; k--) {
                const r = direct(parts.slice(0, k).join('-'))
                if (r) return { slug: r.slug, via: 'prefix' }
            }
        }
        return null
    }

    /** All projects a repos string names, plus text inference for an item with none: { links:[{slug,via,token}], unresolved:[token], general } */
    function resolveItem(repos, key = '', title = '') {
        const links = [], unresolved = []
        let general = false
        const add = (slug, via, token) => { if (!links.some((l) => l.slug === slug)) links.push({ slug, via, token }) }
        for (const t of tokensOf(repos)) {
            const r = resolveToken(t)
            if (!r) unresolved.push(t)
            else if (r.general) general = true
            else add(r.slug, r.via, t)
        }
        if (!links.length) {
            const text = [gameFromText(key, title), ...reposFromText(key, title)].filter(Boolean)
            for (const t of text) { const r = resolveToken(t); if (r && !r.general) add(r.slug, 'text', t) }
        }
        return { links, unresolved, general }
    }

    /** A pack name -> [{ slug, role, via }]: the project it is (owner) and the game that uses it (uses). */
    function resolvePack(pack) {
        const out = []
        const add = (slug, role, via) => { if (!out.some((o) => o.slug === slug)) out.push({ slug, role, via }) }
        const own = direct(pack.toLowerCase()) ?? (() => { const r = resolveToken(pack); return r && !r.general ? r : null })()
        if (own) add(own.slug, 'owner', own.via)
        const m = /^(.*?)(?:-(?:dm-)?maps|-weapons|-monsters|-pack|-char|-props|-vehicle)?$/.exec(pack.toLowerCase())
        const stem = (m?.[1] || pack).split('-')
        const packGames = (rules.packGames ?? []).map(([re, slug]) => [new RegExp(re), slug])
        if (/-(maps|weapons|monsters)$/.test(pack) || packGames.some(([re]) => re.test(pack))) {
            for (let k = stem.length; k >= 1; k--) {
                const c = stem.slice(0, k).join('-')
                for (const cand of [c, `game-${c}`, `mg-${c}`]) {
                    const r = direct(cand)
                    if (r && byGame.has(r.slug)) { add(r.slug, 'uses', 'stem'); k = 0; break }
                }
            }
            for (const [re, slug] of packGames) if (re.test(pack) && byGame.has(slug)) add(slug, 'uses', 'stem')
        }
        return out
    }
    return { resolveToken, resolveItem, resolvePack, slugs }
}

/** An unresolved token that looks like a repo name (worth a human look) as opposed to prose words picked up from a free-text repos field. */
export const REPO_LIKE = /^[a-z0-9]+(-[a-z0-9*]+)+$/i

const nowIso = () => new Date().toISOString()
const hasTable = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(t)

/**
 * Work out the mapping from the database. opts: { remapTasks } (re-resolve every Item; otherwise only items with no link yet).
 * Returns the plan; nothing is written.
 */
export function planMapping(db, { remapTasks = false } = {}) {
    loadRules(db)
    const projects = db.prepare('SELECT id, slug, type, repoPath, settings, folderId FROM Project').all()
    const R = makeResolver(projects)
    const id = new Map(projects.map((p) => [p.slug, p.id]))
    const linked = hasTable(db, 'ItemProject') ? new Set(db.prepare('SELECT DISTINCT itemId FROM ItemProject').all().map((r) => r.itemId)) : new Set()
    const items = db.prepare('SELECT id, key, title, repos FROM Item ORDER BY id').all()
    const known = new Set(items.flatMap((i) => i.repos.split(',').map((t) => tokenName(t))).filter((n) => /^(game|mg)-/.test(n)))
    const plan = { tasks: { items: items.length, scanned: 0, links: [], unresolvedTokens: {}, noProject: [], general: 0, before: {}, after: {} }, packs: { links: [], unmapped: [] }, projects: projects.length }
    const T = plan.tasks
    for (const it of items) {
        const old = classify(it.repos, it.key, it.title, known)
        if (id.has(old)) T.before[old] = (T.before[old] ?? 0) + 1
        if (!remapTasks && linked.has(it.id)) continue
        T.scanned++
        const r = R.resolveItem(it.repos, it.key, it.title)
        for (const t of r.unresolved) T.unresolvedTokens[t] = (T.unresolvedTokens[t] ?? 0) + 1
        for (const l of r.links) T.links.push({ itemId: it.id, key: it.key, projectId: id.get(l.slug), slug: l.slug, via: l.via, token: l.token })
        if (!r.links.length) { T.noProject.push(it.key); if (r.general) T.general++ }
    }
    const names = new Set(db.prepare('SELECT DISTINCT pack FROM AssetWeapon').all().map((r) => r.pack))
    for (const s of hasTable(db, 'AssetSource') ? db.prepare('SELECT name FROM AssetSource').all() : []) names.add(s.name)
    for (const p of [...names].filter(Boolean).sort()) {
        const rs = R.resolvePack(p)
        if (!rs.length) plan.packs.unmapped.push(p)
        for (const r of rs) plan.packs.links.push({ pack: p, projectId: id.get(r.slug), slug: r.slug, role: r.role, via: r.via })
    }
    return plan
}

/** Write a plan. Item links of scanned items are replaced (all of them under remapTasks); pack links are rebuilt. One transaction. */
export function applyMapping(db, plan, { remapTasks = false } = {}) {
    db.exec('BEGIN')
    try {
        const t = nowIso()
        if (remapTasks) db.exec('DELETE FROM ItemProject')
        const ins = db.prepare('INSERT OR IGNORE INTO ItemProject (itemId, projectId, via, token, createdAt) VALUES (?,?,?,?,?)')
        for (const l of plan.tasks.links) ins.run(l.itemId, l.projectId, l.via, l.token, t)
        db.exec('DELETE FROM ProjectPack')
        const pi = db.prepare('INSERT OR IGNORE INTO ProjectPack (projectId, pack, role, via, createdAt) VALUES (?,?,?,?,?)')
        for (const l of plan.packs.links) pi.run(l.projectId, l.pack, l.role, l.via, t)
        db.exec('COMMIT')
    } catch (e) { db.exec('ROLLBACK'); throw e }
}

const OPEN_SQL = "'queue','active','blocked','review'"

/** The count queries (shared by the CLI and the panel, which runs them through Prisma). `ids` = project ids; `grouped` = one row per project (`pid`), else one row over all of them with distinct counts. */
export function countSqls(ids, grouped) {
    const inn = ids.map(Number).filter(Number.isFinite).join(',') || '0'
    const g = (col) => (grouped ? { sel: `${col} pid, `, grp: ` GROUP BY ${col}` } : { sel: '', grp: '' })
    const t = g('ip.projectId'), a = g('pp.projectId')
    return {
        tasks: `SELECT ${t.sel}COUNT(DISTINCT ip.itemId) tasks, COUNT(DISTINCT CASE WHEN i.status IN (${OPEN_SQL}) THEN ip.itemId END) open FROM ItemProject ip JOIN Item i ON i.id = ip.itemId WHERE ip.projectId IN (${inn})${t.grp}`,
        assets: `SELECT ${a.sel}COUNT(DISTINCT CASE WHEN NOT x.isLevel AND NOT x.isPiece THEN x.weaponId || '/' || x.kind END) assets, COUNT(DISTINCT CASE WHEN x.isLevel THEN x.weaponId END) maps FROM ProjectPack pp JOIN (SELECT pack, weaponId, kind, (${PIECE_SQL}) isPiece, (kind IN (SELECT key FROM AssetKind WHERE tab = 'maps')) isLevel FROM AssetWeapon) x ON x.pack = pp.pack WHERE pp.projectId IN (${inn})${a.grp}`,
    }
}

/** Counts per project from the link tables: distinct tasks, assets (standalone, distinct) and maps (converted levels, distinct). */
export function countsPerProject(db) {
    const out = {}
    const get = (s) => (out[s] ??= { tasks: 0, openTasks: 0, assets: 0, maps: 0 })
    const ps = db.prepare('SELECT id, slug FROM Project').all(), slug = new Map(ps.map((p) => [p.id, p.slug]))
    const q = countSqls(ps.map((p) => p.id), true)
    for (const r of db.prepare(q.tasks).all()) { const c = get(slug.get(r.pid)); c.tasks = r.tasks; c.openTasks = r.open }
    for (const r of db.prepare(q.assets).all()) { const c = get(slug.get(r.pid)); c.assets = r.assets; c.maps = r.maps }
    return out
}

/**
 * Run the mapping. opts: { dryRun, remapTasks }. Returns a report: counts of links written, per-project counts before (old
 * classification) and after, and every unresolved token and pack.
 */
export function mapProjects(db, { dryRun = false, remapTasks = false } = {}) {
    const plan = planMapping(db, { remapTasks })
    const rep = {
        dryRun, remapTasks, projects: plan.projects,
        tasks: { items: plan.tasks.items, scanned: plan.tasks.scanned, links: plan.tasks.links.length, linkedItems: new Set(plan.tasks.links.map((l) => l.itemId)).size, general: plan.tasks.general, unlinked: plan.tasks.noProject.length, unresolvedTokens: plan.tasks.unresolvedTokens, unresolvedRepoLike: Object.fromEntries(Object.entries(plan.tasks.unresolvedTokens).filter(([t]) => REPO_LIKE.test(t))), via: {} },
        packs: { links: plan.packs.links.length, unmapped: plan.packs.unmapped },
        before: plan.tasks.before, after: {},
    }
    for (const l of plan.tasks.links) rep.tasks.via[l.via] = (rep.tasks.via[l.via] ?? 0) + 1
    if (dryRun) {
        const per = {}
        const seen = new Set()
        for (const l of plan.tasks.links) { const k = `${l.itemId}/${l.projectId}`; if (!seen.has(k)) { seen.add(k); per[l.slug] = (per[l.slug] ?? 0) + 1 } }
        rep.after = Object.fromEntries(Object.entries(per).map(([s, n]) => [s, { tasks: n }]))
        return rep
    }
    applyMapping(db, plan, { remapTasks })
    rep.after = countsPerProject(db)
    return rep
}

/** True when the link tables have never been filled (what bootstrap checks). */
export function needsMapping(db) {
    if (!hasTable(db, 'ItemProject') || !hasTable(db, 'ProjectPack')) return false
    const items = db.prepare('SELECT 1 FROM Item LIMIT 1').get(), projects = db.prepare('SELECT 1 FROM Project LIMIT 1').get()
    if (!items || !projects) return false
    return !db.prepare('SELECT 1 FROM ItemProject LIMIT 1').get() || !db.prepare('SELECT 1 FROM ProjectPack LIMIT 1').get()
}

/** Re-resolve one item's links from its repos text (CLI item create/edit). Keeps the join table in step with Item.repos. */
export function syncItem(db, key) {
    loadRules(db)
    if (!hasTable(db, 'ItemProject')) return []
    const it = db.prepare('SELECT id, key, title, repos FROM Item WHERE key = ?').get(key)
    if (!it) return []
    const projects = db.prepare('SELECT id, slug, type, repoPath, settings FROM Project').all()
    if (!projects.length) return []
    const r = makeResolver(projects).resolveItem(it.repos, it.key, it.title)
    const id = new Map(projects.map((p) => [p.slug, p.id]))
    db.prepare('DELETE FROM ItemProject WHERE itemId = ?').run(it.id)
    const ins = db.prepare('INSERT OR IGNORE INTO ItemProject (itemId, projectId, via, token, createdAt) VALUES (?,?,?,?,?)')
    for (const l of r.links) ins.run(it.id, id.get(l.slug), l.via, l.token, nowIso())
    return r.links.map((l) => l.slug)
}
