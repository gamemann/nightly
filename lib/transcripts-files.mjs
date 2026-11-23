// Claude Code session files on disk: where they are, which are safe to read, and byte-range reads.
// Pure fs, no database: shared by the CLI (lib/transcripts-store.mjs) and the panel (src/server/transcriptsRouter.ts).
// Read-only by design: nothing here opens a session file for writing, so a VS Code window that has the same session
// open is never disturbed.
import { closeSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Session ids are UUIDs, subagent ids short hex; both pass this. Anything with a slash, dot or space does not. */
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
export const isId = (s) => typeof s === 'string' && ID_RE.test(s)
/** Linux login names. */
export const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/

/** Home directory of an OS user from /etc/passwd (no shell-out); '' when unknown. */
export function homeOf(user, passwd = '/etc/passwd') {
    if (!USER_RE.test(user)) return ''
    try {
        for (const l of readFileSync(passwd, 'utf8').split('\n')) {
            const f = l.split(':')
            if (f[0] === user) return f[5] || ''
        }
    } catch { /* no passwd: unknown */ }
    return ''
}

/** Login names with a home directory under /home (plus the current user). */
export function homeUsers(homeRoot = '/home') {
    const names = new Set([os.userInfo().username])
    try { for (const e of readdirSync(homeRoot, { withFileTypes: true })) if (e.isDirectory() && USER_RE.test(e.name)) names.add(e.name) } catch { /* no /home */ }
    return [...names]
}

const expand = (d) => (d === '~' || d.startsWith('~/') ? path.join(os.homedir(), d.slice(1)) : d)

/**
 * Transcript roots (the `projects` directories). `configured` is the `transcriptDirs` setting (newline or comma separated,
 * ~ allowed); blank means every readable /home/<user>/.claude/projects plus the current user's.
 */
export function roots(configured = '', homeRoot = '/home') {
    const list = String(configured ?? '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean).map(expand)
    if (list.length) return list
    const out = new Set([path.join(os.homedir(), '.claude', 'projects')])
    for (const u of homeUsers(homeRoot)) out.add(path.join(homeRoot, u, '.claude', 'projects'))
    return [...out].filter((d) => { try { return statSync(d).isDirectory() } catch { return false } })
}

/** The OS user a file belongs to: /home/<u>/.claude/... -> u; anything else -> the current user. */
export function osUserOf(file, homeRoot = '/home') {
    const m = new RegExp('^' + homeRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/([^/]+)/\\.claude/').exec(file)
    return m && USER_RE.test(m[1]) ? m[1] : os.userInfo().username
}

/** realpath of `file` when it is a *.jsonl strictly inside one of `rootDirs`; else null (traversal, symlink escape, wrong type). */
export function safePath(file, rootDirs) {
    if (typeof file !== 'string' || !file.endsWith('.jsonl') || file.includes('\0')) return null
    let real
    try { real = realpathSync(file) } catch { return null }
    for (const r of rootDirs) {
        let rr
        try { rr = realpathSync(r) } catch { continue }
        if (real.startsWith(rr + path.sep)) return real
    }
    return null
}

/** Claude Code names a project dir after the cwd with every non-alphanumeric character turned into '-'. */
export const encodeCwd = (cwd) => String(cwd).replace(/[^A-Za-z0-9]/g, '-')

/**
 * Transcript files under one projects dir. Main sessions: <proj>/<sessionId>.jsonl. Subagents:
 * <proj>/<sessionId>/subagents/agent-<id>.jsonl with a sibling .meta.json {agentType, description, toolUseId, spawnDepth, model}.
 */
export function discover(dir) {
    const files = []
    let unreadable = 0
    const ls = (p) => { try { return readdirSync(p, { withFileTypes: true }) } catch { unreadable++; return [] } }
    for (const proj of ls(dir)) {
        if (!proj.isDirectory()) continue
        const pd = path.join(dir, proj.name)
        for (const e of ls(pd)) {
            if (e.isFile() && e.name.endsWith('.jsonl') && isId(e.name.slice(0, -6))) files.push({ file: path.join(pd, e.name), sessionId: e.name.slice(0, -6), agentId: '', project: proj.name, meta: {} })
            else if (e.isDirectory() && isId(e.name)) {
                const sd = path.join(pd, e.name, 'subagents')
                for (const s of ls(sd)) {
                    if (!s.isFile() || !s.name.endsWith('.jsonl')) continue
                    const agentId = s.name.replace(/^agent-/, '').slice(0, -6)
                    if (!isId(agentId)) continue
                    let meta = {}
                    try { meta = JSON.parse(readFileSync(path.join(sd, s.name.slice(0, -6) + '.meta.json'), 'utf8')) } catch { /* no meta */ }
                    files.push({ file: path.join(sd, s.name), sessionId: e.name, agentId, project: proj.name, meta })
                }
            }
        }
    }
    return { files, unreadable }
}

/** Read bytes [start, start+len) of a file, len clamped to `max`. */
export function readRange(file, start, len, max = 4 << 20) {
    const n = Math.max(0, Math.min(len, max))
    const buf = Buffer.alloc(n)
    const fd = openSync(file, 'r')
    try {
        const got = readSync(fd, buf, 0, n, start)
        return buf.subarray(0, got)
    } finally { closeSync(fd) }
}
