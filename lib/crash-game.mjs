// Which game a crash log belongs to, decided from the Project table instead of worktree-name guesses.
// Order: (1) the path lies inside a project's repo; (2) the path lies inside a git worktree whose .git file points at a project's repo;
// (3) the worktree/run directory name carries a project slug (longest wins); (4) it carries a project's perfGame key (fc, zz, ...).
// The answer is the project's `perfGame` setting (the key perf, web and playtest rows use) or its slug. Pure apart from reading `.git` files.
import { readFileSync } from 'node:fs'
import path from 'node:path'

const norm = (p) => String(p ?? '').replace(/\/+$/, '')
const inside = (p, root) => root && (p === root || p.startsWith(root + '/'))

/** projects: [{ slug, repoPath, settings }] (settings an object or JSON string). */
export function makeGameOf(projects, { readGit = (dir) => { try { return readFileSync(path.join(dir, '.git'), 'utf8') } catch { return '' } } } = {}) {
    const rows = projects.map((p) => {
        let s = p.settings
        if (typeof s === 'string') { try { s = JSON.parse(s) } catch { s = {} } }
        return { slug: p.slug, repo: norm(p.repoPath), key: (s && s.perfGame) || p.slug, perf: (s && s.perfGame) || '' }
    })
    const byRepo = [...rows].filter((r) => r.repo).sort((a, b) => b.repo.length - a.repo.length)
    const bySlug = [...rows].sort((a, b) => b.slug.length - a.slug.length)
    const byPerf = rows.filter((r) => r.perf).sort((a, b) => b.perf.length - a.perf.length)
    const named = (dir, token) => dir === token || dir.startsWith(`${token}-`) || dir.endsWith(`-${token}`) || dir.includes(`-${token}-`)
    return function gameOf(file) {
        const p = norm(file)
        if (/\.mlogs/.test(p)) return 'dev-host'
        const hit = byRepo.find((r) => inside(p, r.repo))
        if (hit) return hit.key
        const m = p.match(/^(.*\/(?:wt|godot|runs)\/([^/]+))/)
        if (!m) return 'unknown'
        const [, root, dir] = m
        const gd = readGit(root).match(/^gitdir:\s*(.+?)\/\.git\/worktrees\//m)
        const viaGit = gd && byRepo.find((r) => r.repo === norm(gd[1]))
        if (viaGit) return viaGit.key
        const bySlugHit = bySlug.find((r) => named(dir, r.slug))
        if (bySlugHit) return bySlugHit.key
        const perfHit = byPerf.find((r) => named(dir, r.perf))
        return perfHit ? perfHit.key : 'unknown'
    }
}
