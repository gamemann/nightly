// Folders, projects and project access for the CLI (`nightly folder|project ...`), on node:sqlite.
// The panel does the same through Prisma (src/server/projectsRouter.ts); the rules live in
// lib/projects-core.mjs and lib/permissions.mjs.
import { existsSync, lstatSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import * as S from './store.mjs'
import { loadRules } from './naming-rules.mjs'
import { ensure } from './accounts.mjs'
import { SEED_FOLDERS, checkSlug, checkType, classifyRepo, projectName } from './projects-core.mjs'
import { validGrant, wouldCycle } from './permissions.mjs'

export const DEFAULT_PROJECT_ROOTS = '/home/core/projects:/home/gamedev/projects/godot'

const folderRow = (db, ref) => {
    const r = /^\d+$/.test(String(ref)) ? db.prepare('SELECT * FROM Folder WHERE id = ?').get(Number(ref)) : folderByPath(db, String(ref).split('/').filter(Boolean))
    return r ?? (() => { throw new Error(`no folder "${ref}" (nightly folder list)`) })()
}
function folderByPath(db, parts) {
    let parent = null, row = null
    for (const name of parts) {
        row = db.prepare(`SELECT * FROM Folder WHERE name = ? AND parentId ${parent == null ? 'IS NULL' : '= ?'}`).get(name, ...(parent == null ? [] : [parent]))
        if (!row) return null
        parent = row.id
    }
    return row
}
export const projectRow = (db, slug) => db.prepare('SELECT * FROM Project WHERE slug = ?').get(String(slug)) ?? (() => { throw new Error(`no project "${slug}" (nightly project list)`) })()

export function listFolders(db) {
    ensure(db)
    return db.prepare('SELECT f.*, (SELECT count(*) FROM Project p WHERE p.folderId = f.id) AS projects FROM Folder f ORDER BY f.sort, f.name').all()
}

export function createFolder(db, { name, parent, sort = 0, icon = '' }) {
    ensure(db)
    const n = String(name ?? '').trim()
    if (!n || n.length > 60 || n.includes('/')) throw new Error('folder name: 1-60 characters, no /')
    const parentId = parent != null && parent !== '' ? folderRow(db, parent).id : null
    return db.prepare('INSERT INTO Folder (name, parentId, icon, sort, createdAt) VALUES (?, ?, ?, ?, ?) RETURNING *').get(n, parentId, String(icon), Number(sort) || 0, S.now())
}

export function editFolder(db, ref, { name, parent, sort, icon }) {
    const f = folderRow(db, ref)
    if (name !== undefined) db.prepare('UPDATE Folder SET name = ? WHERE id = ?').run(String(name).trim(), f.id)
    if (parent !== undefined) {
        const pid = parent === '' || parent === null ? null : folderRow(db, parent).id
        const parents = new Map(db.prepare('SELECT id, parentId FROM Folder').all().map((r) => [r.id, r.parentId]))
        if (pid === f.id || wouldCycle(f.id, pid, parents)) throw new Error('a folder cannot move inside itself')
        db.prepare('UPDATE Folder SET parentId = ? WHERE id = ?').run(pid, f.id)
    }
    if (sort !== undefined) db.prepare('UPDATE Folder SET sort = ? WHERE id = ?').run(Number(sort) || 0, f.id)
    if (icon !== undefined) db.prepare('UPDATE Folder SET icon = ? WHERE id = ?').run(String(icon), f.id)
    return db.prepare('SELECT * FROM Folder WHERE id = ?').get(f.id)
}

/** Delete a folder; its subfolders and projects move up to its parent. */
export function deleteFolder(db, ref) {
    const f = folderRow(db, ref)
    return S.tx(db, () => {
        db.prepare('UPDATE Folder SET parentId = ? WHERE parentId = ?').run(f.parentId, f.id)
        db.prepare('UPDATE Project SET folderId = ? WHERE folderId = ?').run(f.parentId, f.id)
        db.prepare('DELETE FROM Folder WHERE id = ?').run(f.id)
        return { id: f.id, name: f.name }
    })
}

export function listProjects(db, { type, folder, q } = {}) {
    ensure(db)
    const where = [], args = []
    if (type) { where.push('p.type = ?'); args.push(checkType(type)) }
    if (folder) { where.push('p.folderId = ?'); args.push(folderRow(db, folder).id) }
    if (q) { where.push('(p.slug LIKE ? OR p.name LIKE ?)'); args.push(`%${q}%`, `%${q}%`) }
    return db.prepare(`SELECT p.*, f.name AS folder FROM Project p LEFT JOIN Folder f ON f.id = p.folderId ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.sort, p.name`).all(...args)
}

export function createProject(db, { slug, name, type = 'game', folder, repoPath = '', repoUrl = '', settings = {} }) {
    ensure(db)
    const s = checkSlug(slug)
    checkType(type)
    if (db.prepare('SELECT 1 FROM Project WHERE slug = ?').get(s)) throw new Error(`project "${s}" exists`)
    const folderId = folder != null && folder !== '' ? folderRow(db, folder).id : null
    const t = S.now()
    return db.prepare('INSERT INTO Project (slug, name, type, repoPath, repoUrl, folderId, settings, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *')
        .get(s, String(name || projectName(s, type)), type, String(repoPath), String(repoUrl), folderId, JSON.stringify(settings), t, t)
}

export function editProject(db, slug, patch) {
    const p = projectRow(db, slug)
    const set = [], args = []
    const put = (col, v) => { set.push(`${col} = ?`); args.push(v) }
    if (patch.name !== undefined) put('name', String(patch.name))
    if (patch.type !== undefined) put('type', checkType(patch.type))
    if (patch.repoPath !== undefined) put('repoPath', String(patch.repoPath))
    if (patch.repoUrl !== undefined) put('repoUrl', String(patch.repoUrl))
    if (patch.folder !== undefined) put('folderId', patch.folder === '' || patch.folder === null ? null : folderRow(db, patch.folder).id)
    if (patch.sort !== undefined) put('sort', Number(patch.sort) || 0)
    if (patch.archived !== undefined) put('archived', patch.archived ? 1 : 0)
    if (patch.settings !== undefined) put('settings', JSON.stringify(patch.settings))
    if (patch.slug !== undefined) put('slug', checkSlug(patch.slug))
    if (!set.length) return p
    put('updatedAt', S.now())
    db.prepare(`UPDATE Project SET ${set.join(', ')} WHERE id = ?`).run(...args, p.id)
    return db.prepare('SELECT * FROM Project WHERE id = ?').get(p.id)
}

export function deleteProject(db, slug) {
    const p = projectRow(db, slug)
    db.prepare('DELETE FROM Project WHERE id = ?').run(p.id)
    return { id: p.id, slug: p.slug }
}

/** Give a user (`user:<name>`) or role (`role:<name>`) perms on a project (`project:<slug>`) or folder (`folder:<id|path>`). */
export function grantAccess(db, who, on, perms = ['projects.view']) {
    ensure(db)
    for (const p of perms) if (!validGrant(p)) throw new Error(`unknown permission "${p}"`)
    const [wk, wn] = String(who).split(':'), [ok, ...on_] = String(on).split(':'), oname = on_.join(':')
    const userId = wk === 'user' ? (db.prepare('SELECT id FROM User WHERE username = ?').get(wn)?.id ?? (() => { throw new Error(`no user "${wn}"`) })()) : null
    const roleId = wk === 'role' ? (db.prepare('SELECT id FROM Role WHERE name = ?').get(wn)?.id ?? (() => { throw new Error(`no role "${wn}"`) })()) : null
    if (userId == null && roleId == null) throw new Error('who: user:<name> or role:<name>')
    const projectId = ok === 'project' ? projectRow(db, oname).id : null
    const folderId = ok === 'folder' ? folderRow(db, oname).id : null
    if (projectId == null && folderId == null) throw new Error('on: project:<slug> or folder:<id|path>')
    return db.prepare('INSERT INTO ProjectAccess (projectId, folderId, userId, roleId, perms, createdAt) VALUES (?, ?, ?, ?, ?, ?) RETURNING *').get(projectId, folderId, userId, roleId, perms.join(','), S.now())
}
export const listAccess = (db) => { ensure(db); return db.prepare(`SELECT a.id, a.perms, p.slug AS project, f.name AS folder, u.username AS user, r.name AS role FROM ProjectAccess a
    LEFT JOIN Project p ON p.id = a.projectId LEFT JOIN Folder f ON f.id = a.folderId LEFT JOIN User u ON u.id = a.userId LEFT JOIN Role r ON r.id = a.roleId ORDER BY a.id`).all() }
export const revokeAccess = (db, id) => { const n = db.prepare('DELETE FROM ProjectAccess WHERE id = ?').run(Number(id)).changes; if (!n) throw new Error(`no access row ${id}`); return { id: Number(id) } }

const isDir = (d) => { try { return !lstatSync(d).isSymbolicLink() && lstatSync(d).isDirectory() } catch { return false } }
const remote = (dir) => spawnSync('git', ['-c', 'safe.directory=*', '-C', dir, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8', timeout: 10_000 }).stdout?.trim() ?? ''

/**
 * Seed folders and projects from the repo roots (setting projectRoots, ':' separated) and the repos
 * the database already knows (Release.repo, PerfGame.repoPath). Existing projects are left alone.
 * Returns { folders, added, skipped }.
 */
export function seed(db, { roots, dryRun = false } = {}) {
    ensure(db)
    roots ??= (S.getSetting(db, 'projectRoots') || DEFAULT_PROJECT_ROOTS).split(':').filter(Boolean)
    const found = new Map()   // slug -> { kind, dir }
    for (const root of roots) {
        let names = []
        try { names = readdirSync(root).sort() } catch { continue }
        for (const name of names) {
            const dir = path.join(root, name)
            if (!isDir(dir) || !existsSync(path.join(dir, '.git')) || found.has(name.toLowerCase())) continue
            const kind = existsSync(path.join(dir, 'project.godot')) ? 'godot' : existsSync(path.join(dir, 'package.json')) ? 'web' : 'none'
            found.set(name.toLowerCase(), { kind, dir })
        }
    }
    const has = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)
    if (has('Release')) for (const { repo } of db.prepare('SELECT DISTINCT repo FROM "Release"').all()) if (!found.has(repo)) found.set(repo, { kind: 'name', dir: '' })
    const perf = has('PerfGame') ? db.prepare('SELECT slug, name, repoPath FROM PerfGame').all() : []
    for (const g of perf) { const b = path.basename(g.repoPath || ''); if (b && !found.has(b)) found.set(b, { kind: 'godot', dir: g.repoPath }) }
    const names = new Set(found.keys())
    loadRules(db)
    const plan = [...found].map(([name, r]) => ({ ...classifyRepo(name, r.kind, names), dir: r.dir })).filter((x) => x.slug)
    if (dryRun) return { folders: SEED_FOLDERS.length, added: plan.map((p) => p.slug), skipped: [...names].filter((n) => !plan.some((p) => p.slug === n)) }
    return S.tx(db, () => {
        const ids = new Map()
        for (const fp of SEED_FOLDERS) {
            const parentId = fp.length > 1 ? ids.get(fp.slice(0, -1).join('/')) : null
            const row = folderByPath(db, fp) ?? db.prepare('INSERT INTO Folder (name, parentId, icon, sort, createdAt) VALUES (?, ?, \'\', ?, ?) RETURNING *').get(fp.at(-1), parentId, SEED_FOLDERS.indexOf(fp), S.now())
            ids.set(fp.join('/'), row.id)
        }
        const added = []
        for (const p of plan) {
            if (db.prepare('SELECT 1 FROM Project WHERE slug = ?').get(p.slug)) continue
            const pg = perf.find((g) => path.basename(g.repoPath || '') === p.slug)
            const t = S.now()
            db.prepare('INSERT INTO Project (slug, name, type, repoPath, repoUrl, folderId, settings, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
                .run(p.slug, pg?.name || projectName(p.slug, p.type), p.type, p.dir, p.dir ? remote(p.dir) : '', ids.get(p.folder.join('/')), JSON.stringify(pg ? { perfGame: pg.slug } : {}), t, t)
            added.push(p.slug)
        }
        return { folders: ids.size, added, skipped: [...names].filter((n) => !plan.some((p) => p.slug === n)) }
    })
}
