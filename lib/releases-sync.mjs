// `nightly releases sync`: keep the Releases feed filled from what is on disk and on GitHub, idempotently.
//   - every real (non-symlink) git repo directly under the roots (setting releasesRoots, ':' separated) contributes its v*.*.* tags
//     as Release rows (repo = directory name, version = tag, at = tag date, commit = tagged commit, changelog = tag subject plus the
//     commits since the previous tag, channel = dev for a prerelease suffix, else stable);
//   - CI state comes from `gh run list` for the ~10 newest tags of a repo, one call per repo, only while a tag is unresolved
//     (new tags, or pending) and only while the GitHub rate limit has headroom;
//   - deployedTo is never touched: a tag is not a deploy, and nothing records deploys outside `nightly releases deploy`.
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync } from 'node:fs'
import path from 'node:path'
import * as S from './store.mjs'
import * as F from './feeds.mjs'

export const DEFAULT_ROOTS = '/home/gamedev/godot:/home/core/projects'
const SEMVER = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/
const CI_TAGS = 10, CI_RUNS = 100, MIN_RATE_LEFT = 500, RECHECK_MS = 30 * 60_000
const run = (cmd, args, o = {}) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 60_000, ...o })
const git = (dir, args) => run('git', ['-c', 'safe.directory=*', '-C', dir, ...args])

export const parseTag = (t) => { const m = SEMVER.exec(t); return m ? { n: [+m[1], +m[2], +m[3]], pre: m[4] ?? '' } : null }
export const channelOf = (t) => (parseTag(t)?.pre ? 'dev' : 'stable')
export const slugOf = (url) => /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\s*$/.exec(url.trim())?.[1] ?? ''

export function discoverRepos(roots) {
    const seen = new Set(), out = []
    for (const root of roots) {
        let names = []
        try { names = readdirSync(root).sort() } catch { continue }
        for (const name of names) {
            const dir = path.join(root, name)
            try { if (lstatSync(dir).isSymbolicLink() || !existsSync(path.join(dir, '.git'))) continue } catch { continue }
            if (seen.has(dir)) continue
            seen.add(dir); out.push({ name, dir })
        }
    }
    return out
}

/** Tags of one repo, oldest first: { tag, commit, at, subject, channel }. */
export function readTags(dir) {
    const r = git(dir, ['for-each-ref', 'refs/tags/v*', '--format=%(refname:short)%09%(objectname)%09%(*objectname)%09%(creatordate:iso-strict)%09%(contents:subject)'])
    if (r.status !== 0) return []
    const tags = []
    for (const line of r.stdout.split('\n')) {
        const [tag, obj, peeled, at, subject] = line.split('\t')
        if (!tag || !parseTag(tag) || !at) continue
        tags.push({ tag, commit: peeled || obj, at, subject: subject ?? '', channel: channelOf(tag) })
    }
    const cmp = (a, b) => { const x = parseTag(a.tag), y = parseTag(b.tag); for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] - y.n[i]; return (x.pre ? 0 : 1) - (y.pre ? 0 : 1) || x.pre.localeCompare(y.pre) }
    return tags.sort(cmp)
}

/** Changelog text: the tag annotation subject (when it adds something) then the commits since the previous tag of the channel. */
function changelog(dir, t, prev) {
    const r = git(dir, ['log', '--no-merges', '--format=%s', '-n', '12', prev ? `${prev}..${t.tag}` : t.tag])
    const lines = r.status === 0 ? r.stdout.split('\n').filter(Boolean) : []
    const body = lines.map((l) => `- ${l.slice(0, 120)}`)
    return (t.subject && t.subject !== lines[0] ? [t.subject, ...body] : body).join('\n')
}

/** CI verdict for each wanted sha from a `gh run list` array. */
export function ciByCommit(runs, shas) {
    const out = {}
    for (const sha of shas) {
        const rs = runs.filter((r) => r.headSha === sha)
        if (!rs.length) continue
        out[sha] = rs.some((r) => r.status !== 'completed') ? 'pending'
            : rs.some((r) => ['failure', 'timed_out', 'startup_failure'].includes(r.conclusion)) ? 'failing'
            : rs.some((r) => r.conclusion === 'success') ? 'passing' : 'unknown'
    }
    return out
}

const rateLeft = () => { const r = run('gh', ['api', 'rate_limit', '--jq', '.rate.remaining']); return r.status === 0 ? Number(r.stdout) : -1 }

export function sync(db, { roots, now = Date.now(), ci = true, budgetMs = 40_000, log = () => {} } = {}) {
    const t0 = Date.now()
    F.ensure(db)
    roots ??= (S.getSetting(db, 'releasesRoots') || DEFAULT_ROOTS).split(':').filter(Boolean)
    const st = { repos: 0, tags: 0, added: 0, ciSet: 0, ciCalls: 0, ciSkipped: '' }
    const checked = JSON.parse(S.getSetting(db, 'releasesCiChecked') || '{}')
    const has = db.prepare('SELECT id, "commit", ci FROM "Release" WHERE repo = ? AND version = ? AND channel = ?')
    const ins = db.prepare('INSERT INTO "Release" (game, repo, version, channel, "commit", ci, deployedTo, changelog, rollback, at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    let rate = null, ciStop = false
    for (const { name, dir } of discoverRepos(roots)) {
        const tags = readTags(dir)
        if (!tags.length) continue
        st.repos++; st.tags += tags.length
        const prevOf = {}
        for (const ch of ['stable', 'dev']) { let p = ''; for (const t of tags.filter((x) => x.channel === ch)) { prevOf[t.tag] = p; p = t.tag } }
        db.exec('BEGIN')
        try {
            for (const t of tags) {
                const row = has.get(name, t.tag, t.channel)
                if (row) { if (row.commit !== t.commit) db.prepare('UPDATE "Release" SET "commit" = ?, ci = \'unknown\' WHERE id = ?').run(t.commit, row.id); continue }
                ins.run('', name, t.tag, t.channel, t.commit, 'unknown', '', changelog(dir, t, prevOf[t.tag]), prevOf[t.tag], new Date(t.at).toISOString())
                st.added++
            }
            db.exec('COMMIT')
        } catch (e) { db.exec('ROLLBACK'); throw e }
        if (!ci || ciStop) continue
        const slug = slugOf(git(dir, ['remote', 'get-url', 'origin']).stdout ?? '')
        const recent = tags.slice().sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, CI_TAGS)
        const open = recent.map((t) => ({ t, row: has.get(name, t.tag, t.channel) })).filter((x) => x.row.ci === 'unknown' || x.row.ci === 'pending')
        if (!slug || !open.length) continue
        // a young or pending tag is rechecked every RECHECK_MS, an old unresolved one once a day
        const young = open.some((x) => x.row.ci === 'pending' || now - Date.parse(x.t.at) < 86_400_000)
        if (now - (checked[name] ?? 0) < (young ? RECHECK_MS : 86_400_000)) continue
        if (Date.now() - t0 > budgetMs) { st.ciSkipped = 'time budget used; the next run continues'; ciStop = true; continue }
        rate ??= rateLeft()
        if (rate >= 0 && rate < MIN_RATE_LEFT) { st.ciSkipped = `rate limit low (${rate} left)`; ciStop = true; continue }
        const r = run('gh', ['run', 'list', '-R', slug, '--limit', String(CI_RUNS), '--json', 'headSha,conclusion,status'])
        st.ciCalls++; checked[name] = now; if (rate > 0) rate--
        S.setSetting(db, 'releasesCiChecked', JSON.stringify(checked))
        if (r.status !== 0) { log(`${name}: gh run list failed: ${(r.stderr ?? '').trim().slice(0, 120)}`); continue }
        let runs = []; try { runs = JSON.parse(r.stdout) } catch { continue }
        const verdict = ciByCommit(runs, open.map((x) => x.t.commit))
        for (const x of open) {
            const v = verdict[x.t.commit]
            if (v && v !== x.row.ci) { db.prepare('UPDATE "Release" SET ci = ? WHERE id = ?').run(v, x.row.id); st.ciSet++ }
        }
    }
    S.setSetting(db, 'releasesCiChecked', JSON.stringify(checked))
    S.setSetting(db, 'releasesLastSyncAt', new Date(now).toISOString())
    return st
}
