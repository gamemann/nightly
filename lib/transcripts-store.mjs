// Transcript index in the CLI's database (node:sqlite): incremental ingest of Claude Code session files, and the queries the
// CLI prints. The panel reads the same tables through Prisma (src/server/transcriptsRouter.ts) and asks this module (via
// `nightly transcript ingest`) to refresh them. Ingest only ever READS the session files.
import { accessSync, constants, statSync } from 'node:fs'
import { TRANSCRIPT_DDL } from './transcripts-ddl.mjs'
import { discover, osUserOf, readRange, roots, isId } from './transcripts-files.mjs'
import { indexChunk } from './transcripts-parse.mjs'

const CHUNK = 16 << 20
const nowIso = () => new Date().toISOString()

export function ensure(db) { for (const s of TRANSCRIPT_DDL) db.exec(s) }

const tableExists = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)
const setting = (db, k) => (tableExists(db, 'Setting') ? db.prepare('SELECT value FROM Setting WHERE key=?').get(k)?.value ?? '' : '')

/** The local planet node (lowest-id planet), or null while the registry is empty. */
export function localNodeId(db) {
    if (!tableExists(db, 'Node')) return null
    return db.prepare("SELECT id FROM Node WHERE type='planet' ORDER BY id LIMIT 1").get()?.id ?? null
}

function projectSlugFor(db, cwd) {
    if (!cwd || !tableExists(db, 'Project')) return null
    let best = null
    for (const p of db.prepare("SELECT slug, repoPath FROM Project WHERE repoPath <> ''").all()) {
        const rp = p.repoPath.replace(/\/+$/, '')
        if ((cwd === rp || cwd.startsWith(rp + '/')) && (!best || rp.length > best.len)) best = { slug: p.slug, len: rp.length }
    }
    return best?.slug ?? null
}

export const uidOf = (osUser, sessionId, agentId) => `${osUser}:${sessionId}:${agentId || 'main'}`

function recompute(db, id) {
    const t = db.prepare(`SELECT COALESCE(SUM(i),0) i, COALESCE(SUM(o),0) o, COALESCE(SUM(r),0) r, COALESCE(SUM(w),0) w FROM
      (SELECT MAX(inTok) i, MAX(outTok) o, MAX(cacheRead) r, MAX(cacheWrite) w FROM TranscriptMessage WHERE transcriptId=? AND role='assistant'
       GROUP BY CASE WHEN msgId='' THEN id ELSE msgId END)`).get(id)
    const c = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(json_array_length(toolUseIds)),0) t FROM TranscriptMessage WHERE transcriptId=? AND meta=0").get(id)
    db.prepare('UPDATE Transcript SET inTokens=?, outTokens=?, cacheReadTokens=?, cacheWriteTokens=?, messageCount=?, toolCount=? WHERE id=?')
        .run(t.i, t.o, t.r, t.w, c.n, c.t, id)
}

/**
 * Ingest one session file. Incremental: reads only bytes after the stored offset, whole lines only (a torn tail waits for the
 * next pass), and starts over when the file shrank. Returns { id, added, reset } or null when unchanged/unreadable.
 */
export function ingestFile(db, f, { nodeId = null, homeRoot = '/home', now = nowIso() } = {}) {
    let st
    try { accessSync(f.file, constants.R_OK); st = statSync(f.file) } catch { return null }   // unreadable (another user's mode 600 file): skipped
    const osUser = osUserOf(f.file, homeRoot)
    const uid = uidOf(osUser, f.sessionId, f.agentId)
    let row = db.prepare('SELECT * FROM Transcript WHERE filePath=?').get(f.file)
    if (row && row.size === st.size && row.mtimeMs === Math.trunc(st.mtimeMs)) return null
    let reset = false
    if (!row) {
        const ins = db.prepare(`INSERT INTO Transcript (uid,nodeId,osUser,sessionId,agentId,agentType,description,toolUseId,filePath,createdAt,updatedAt)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(uid, nodeId, osUser, f.sessionId, f.agentId, f.meta?.agentType ?? '', f.meta?.description ?? '', f.meta?.toolUseId ?? '', f.file, now, now)
        row = db.prepare('SELECT * FROM Transcript WHERE id=?').get(ins.lastInsertRowid)
    } else if (st.size < row.offset) {
        db.prepare('DELETE FROM TranscriptMessage WHERE transcriptId=?').run(row.id)
        db.prepare("UPDATE Transcript SET offset=0, state='{}', messageCount=0, toolCount=0, title='' WHERE id=?").run(row.id)
        row = db.prepare('SELECT * FROM Transcript WHERE id=?').get(row.id)
        reset = true
    }
    let state = {}
    try { state = JSON.parse(row.state || '{}') } catch { /* fresh state */ }
    let off = row.offset, added = 0
    const insMsg = db.prepare(`INSERT OR IGNORE INTO TranscriptMessage (transcriptId,seq,uuid,parentUuid,msgId,role,kind,ts,byteStart,byteLen,model,sidechain,meta,inTok,outTok,cacheRead,cacheWrite,tools,toolUseIds,spawnIds)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    db.exec('BEGIN')
    try {
        while (off < st.size) {
            const buf = readRange(f.file, off, Math.min(CHUNK, st.size - off), CHUNK)
            if (!buf.length) break
            const r = indexChunk(buf, off, state)
            for (const m of r.rows) {
                insMsg.run(row.id, m.seq, m.uuid, m.parentUuid, m.msgId, m.role, m.kind, m.ts, m.byteStart, m.byteLen, m.model, m.sidechain, m.meta, m.inTok, m.outTok, m.cacheRead, m.cacheWrite, m.tools, m.toolUseIds, m.spawnIds)
                added++
            }
            state = r.state
            if (r.consumed === 0) break          // only a torn line left
            off += r.consumed
        }
        const { seq: _s, ...keep } = state
        const keepState = { ...keep, seq: state.seq }
        const source = row.source === 'panel' ? 'panel' : /vscode/i.test(state.entrypoint ?? '') ? 'vscode' : 'cli'
        db.prepare(`UPDATE Transcript SET offset=?, size=?, mtimeMs=?, state=?, title=?, cwd=?, gitBranch=?, model=?, startedAt=?, lastAt=?, projectSlug=?, source=?, nodeId=COALESCE(nodeId,?), updatedAt=? WHERE id=?`)
            .run(off, st.size, Math.trunc(st.mtimeMs), JSON.stringify(keepState), state.title ?? '', state.cwd ?? '', state.branch ?? '', state.model ?? '',
                state.firstTs ?? '', state.lastTs ?? '', projectSlugFor(db, state.cwd), source, nodeId, now, row.id)
        recompute(db, row.id)
        db.exec('COMMIT')
    } catch (e) { db.exec('ROLLBACK'); throw e }
    return { id: row.id, added, reset }
}

/** Link subagent transcripts to the entry that spawned them (parent id), by tool_use id; nested spawns resolve too. */
export function linkParents(db) {
    const orphans = db.prepare("SELECT id, toolUseId, sessionId FROM Transcript WHERE toolUseId<>'' AND parentId IS NULL").all()
    const find = db.prepare('SELECT transcriptId FROM TranscriptMessage WHERE spawnIds LIKE ? ORDER BY id LIMIT 1')
    const main = db.prepare("SELECT id FROM Transcript WHERE sessionId=? AND agentId='' LIMIT 1")
    let n = 0
    for (const o of orphans) {
        const hit = find.get(`%"${o.toolUseId}"%`)
        const pid = hit?.transcriptId ?? main.get(o.sessionId)?.id
        if (pid && pid !== o.id) { db.prepare('UPDATE Transcript SET parentId=? WHERE id=?').run(pid, o.id); n++ }
    }
    return n
}

/** Ingest every session file under the configured roots. Returns { files, changed, added, linked, unreadable }. */
export function ingestAll(db, { homeRoot = '/home', dirs, now = nowIso() } = {}) {
    ensure(db)
    const list = dirs ?? roots(setting(db, 'transcriptDirs'), homeRoot)
    const nodeId = localNodeId(db)
    const out = { files: 0, changed: 0, added: 0, linked: 0, unreadable: 0 }
    for (const d of list) {
        const { files, unreadable } = discover(d)
        out.unreadable += unreadable
        // main files first so subagents can find their parent
        files.sort((a, b) => (a.agentId ? 1 : 0) - (b.agentId ? 1 : 0))
        for (const f of files) {
            out.files++
            const r = ingestFile(db, f, { nodeId, homeRoot, now })
            if (r) { out.changed++; out.added += r.added }
        }
    }
    out.linked = linkParents(db)
    return out
}

/** Re-ingest one transcript by id (after a run wrote to it). */
export function refresh(db, id) {
    const t = db.prepare('SELECT * FROM Transcript WHERE id=?').get(id)
    if (!t) return null
    const r = ingestFile(db, { file: t.filePath, sessionId: t.sessionId, agentId: t.agentId, meta: { agentType: t.agentType, description: t.description, toolUseId: t.toolUseId } }, { nodeId: t.nodeId })
    if (r) linkParents(db)
    return r
}

/** Find a transcript row by numeric id, uid or session id (main). */
export function find(db, key) {
    const k = String(key)
    if (/^\d+$/.test(k)) return db.prepare('SELECT * FROM Transcript WHERE id=?').get(Number(k)) ?? null
    if (!isId(k) && !k.includes(':')) return null
    return db.prepare("SELECT * FROM Transcript WHERE uid=? OR (sessionId=? AND agentId='') ORDER BY lastAt DESC LIMIT 1").get(k, k) ?? null
}

export function list(db, { q = '', limit = 30, main = true, osUser = '' } = {}) {
    const where = [], args = []
    if (main) where.push("agentId=''")
    if (osUser) { where.push('osUser=?'); args.push(osUser) }
    if (q) { where.push("(title LIKE ? ESCAPE '\\' OR cwd LIKE ? ESCAPE '\\' OR sessionId LIKE ? ESCAPE '\\')"); const p = `%${q.replace(/[\\%_]/g, '\\$&')}%`; args.push(p, p, p) }
    return db.prepare(`SELECT id,uid,osUser,sessionId,agentId,agentType,title,cwd,projectSlug,model,lastAt,messageCount,toolCount,outTokens,status,source FROM Transcript ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY lastAt DESC LIMIT ?`).all(...args, limit)
}
