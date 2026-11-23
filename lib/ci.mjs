// CI workflows and runs of the projects: Forgejo first (zero GitHub API calls, read-only token in ~/.config/forgejo/readonly.env as chk-ci-red.sh),
// GitHub Actions through lib/gh.mjs (rate-limit aware) for repos Forgejo has no runs for. Results are cached in ci_run / ci_repo (ttl setting ciTtlMin, default 10).
//   nightly ci sync [--repo owner/name] [--force]      refresh stale repos         nightly ci list [--repo R] [--status S]
//   nightly ci rerun|cancel <repo> <run_id>            GitHub runs only (Forgejo runs are read-only here)
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensure } from './ops-store.mjs'
import { discoverRepos, slugOf, DEFAULT_ROOTS } from './releases-sync.mjs'
import { spawnSync } from 'node:child_process'
import * as S from './store.mjs'

const TTL_DEFAULT_MIN = 10
export const FORGEJO_ENV = () => process.env.FORGEJO_RO_ENV || path.join(os.homedir(), '.config', 'forgejo', 'readonly.env')

export function forgejoConfig(file = FORGEJO_ENV()) {
    try {
        const cfg = Object.fromEntries(readFileSync(file, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }))
        return cfg.FORGEJO_URL && cfg.FORGEJO_TOKEN ? { base: cfg.FORGEJO_URL.replace(/\/$/, ''), token: cfg.FORGEJO_TOKEN } : null
    } catch { return null }
}

/** Forgejo task -> ci_run row. Forgejo reports one status (success|failure|cancelled|running|waiting|skipped); GitHub splits it into status + conclusion. */
export function fromForgejo(repo, base, t) {
    const done = !['running', 'waiting', 'blocked'].includes(t.status)
    return { source: 'forgejo', repo, run_id: String(t.id), workflow: t.name ?? '', branch: t.head_branch ?? '', sha: t.head_sha ?? '', status: done ? 'completed' : t.status === 'running' ? 'in_progress' : 'queued',
        conclusion: done ? (t.status === 'failure' ? 'failure' : t.status) : '', event: t.event ?? '', title: t.display_title ?? '', url: t.url || `${base}/${repo}/actions`,
        created_at: Date.parse(t.created_at) || 0, updated_at: Date.parse(t.updated_at) || 0 }
}
export function fromGithub(repo, r) {
    return { source: 'github', repo, run_id: String(r.databaseId), workflow: r.workflowName ?? r.name ?? '', branch: r.headBranch ?? '', sha: r.headSha ?? '', status: r.status ?? '', conclusion: r.conclusion ?? '',
        event: r.event ?? '', title: r.displayTitle ?? '', url: r.url ?? '', created_at: Date.parse(r.createdAt) || 0, updated_at: Date.parse(r.updatedAt) || 0 }
}
/** One word for a run: success|failure|cancelled|running|queued|skipped. */
export const verdict = (r) => (r.status === 'completed' ? (r.conclusion || 'unknown') : r.status === 'in_progress' ? 'running' : r.status || 'unknown')

/** Repos to show: projects with a GitHub repoUrl (if the Project table is there), else the repos under the releases roots. */
export function repoList(db, roots) {
    const out = new Map()
    try { for (const p of db.prepare('SELECT slug, repoUrl FROM Project WHERE archived = 0').all()) { const s = slugOf(p.repoUrl || ''); if (s) out.set(s, p.slug) } } catch { /* foundation tables absent */ }
    if (!out.size) {
        roots ??= (S.getSetting(db, 'releasesRoots') || DEFAULT_ROOTS).split(':').filter(Boolean)
        for (const r of discoverRepos(roots)) {
            const u = spawnSync('git', ['-c', 'safe.directory=*', '-C', r.dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8' })
            const s = slugOf(u.stdout ?? ''); if (s) out.set(s, r.name)
        }
    }
    return [...out].map(([repo, project]) => ({ repo, project }))
}

function store(db, rows) {
    const ins = db.prepare(`INSERT INTO ci_run (source, repo, run_id, workflow, branch, sha, status, conclusion, event, title, url, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT (source, repo, run_id) DO UPDATE SET status=excluded.status, conclusion=excluded.conclusion, updated_at=excluded.updated_at, title=excluded.title, url=excluded.url`)
    for (const r of rows) ins.run(r.source, r.repo, r.run_id, r.workflow, r.branch, r.sha, r.status, r.conclusion, r.event, r.title, r.url, r.created_at, r.updated_at)
}

/**
 * Refresh one repo: Forgejo, else GitHub. `fetchJson(url, token)` and `gh` are injectable. Returns { source, runs, error }.
 * A repo refreshed within the ttl is left alone unless force.
 */
export async function syncRepo(db, repo, { gh, forgejo = forgejoConfig(), fetchJson = defaultFetch, force = false, now = Date.now(), ttlMin } = {}) {
    ensure(db)
    ttlMin ??= Number(S.getSetting(db, 'ciTtlMin') || TTL_DEFAULT_MIN)
    const cur = db.prepare('SELECT * FROM ci_repo WHERE repo = ?').get(repo)
    if (!force && cur && now - cur.fetched_at < ttlMin * 60_000) return { repo, source: cur.source, runs: cur.runs, error: cur.error, cached: true }
    let source = '', rows = [], error = ''
    if (forgejo) {
        try {
            const j = await fetchJson(`${forgejo.base}/api/v1/repos/${repo}/actions/tasks?limit=50`, forgejo.token)
            rows = (j?.workflow_runs ?? []).map((t) => fromForgejo(repo, forgejo.base, t))
            if (rows.length) source = 'forgejo'
        } catch (e) { error = `forgejo: ${e.message}` }
    }
    if (!rows.length && gh && process.env.CI_RED_GITHUB !== '0') {
        const r = gh.call(['run', 'list', '-R', repo, '--limit', '30', '--json', 'databaseId,workflowName,headBranch,headSha,status,conclusion,event,displayTitle,url,createdAt,updatedAt'], { caller: 'ci-sync' })
        if (r.status === 0) { try { rows = JSON.parse(r.stdout).map((x) => fromGithub(repo, x)); source = 'github'; error = '' } catch { error = 'github: unreadable answer' } }
        else error = (r.skipped ? 'rate limited: ' : 'github: ') + (r.stderr || '').trim().slice(0, 160)
    }
    db.exec('BEGIN')
    try {
        store(db, rows)
        db.prepare(`INSERT INTO ci_repo (repo, source, fetched_at, error, runs) VALUES (?,?,?,?,?) ON CONFLICT (repo) DO UPDATE SET source=excluded.source, fetched_at=excluded.fetched_at, error=excluded.error, runs=excluded.runs`)
            .run(repo, source || cur?.source || '', now, error, rows.length)
        db.exec('COMMIT')
    } catch (e) { db.exec('ROLLBACK'); throw e }
    return { repo, source, runs: rows.length, error }
}
async function defaultFetch(url, token) {
    const r = await fetch(url, { headers: { Authorization: `token ${token}` }, signal: AbortSignal.timeout(15_000) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return r.json()
}

export async function syncAll(db, opts = {}) {
    const out = []
    for (const { repo } of repoList(db, opts.roots)) out.push(await syncRepo(db, repo, opts))
    return out
}

export function list(db, { repo, status, limit = 100 } = {}) {
    ensure(db)
    const w = [], a = []
    if (repo) { w.push('repo = ?'); a.push(repo) }
    const rows = db.prepare(`SELECT * FROM ci_run ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`).all(...a, limit * 3).map((r) => ({ ...r, verdict: verdict(r) }))
    return (status ? rows.filter((r) => r.verdict === status) : rows).slice(0, limit)
}

/** Re-run or cancel one GitHub run (Forgejo runs are read-only: the answer says so). */
export function act(gh, db, action, repo, runId) {
    if (!['rerun', 'cancel'].includes(action)) throw new Error('action must be rerun or cancel')
    ensure(db)
    const row = db.prepare('SELECT source FROM ci_run WHERE repo = ? AND run_id = ?').get(repo, String(runId))
    if (!row) throw new Error(`no cached run ${runId} of ${repo} (nightly ci sync first)`)
    if (row.source !== 'github') throw new Error('Forgejo runs are read-only here; re-run them in Forgejo')
    const r = gh.call(['run', action, String(runId), '-R', repo], { caller: `ci-${action}` })
    if (r.status !== 0) throw new Error((r.stderr || `gh run ${action} failed`).trim().slice(0, 200))
    db.prepare('UPDATE ci_repo SET fetched_at = 0 WHERE repo = ?').run(repo)   // next read refreshes
    return { repo, run_id: String(runId), action }
}
