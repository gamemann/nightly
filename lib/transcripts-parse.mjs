// Claude Code session JSONL -> index rows (metadata, byte offsets) and render blocks (for the viewer). Pure: no fs, no db.
// The index keeps ids, names, counts and byte ranges only; message text is re-read lazily from the file by byte range.

const num = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.trunc(Number(v))) : 0)
const iso = (t) => { const d = Date.parse(t); return Number.isFinite(d) ? new Date(d).toISOString() : '' }
const SPAWN_TOOLS = new Set(['Agent', 'Task'])
export const MAX_RESULT_CHARS = 20_000
export const MAX_INPUT_CHARS = 12_000

const clip = (s, n) => (typeof s === 'string' && s.length > n ? { text: s.slice(0, n), cut: s.length - n } : { text: s, cut: 0 })

/** Content blocks of a message as an array (a plain string becomes one text block). */
const blocksOf = (msg) => (typeof msg?.content === 'string' ? [{ type: 'text', text: msg.content }] : Array.isArray(msg?.content) ? msg.content : [])

/** Classify one parsed line. Returns null for lines that are not conversation entries. */
export function classify(o) {
    if (!o || typeof o !== 'object') return null
    if (o.type !== 'user' && o.type !== 'assistant') return null
    const blocks = blocksOf(o.message)
    const kinds = new Set(blocks.map((b) => b?.type))
    let kind = 'text'
    if (kinds.has('tool_result') && !kinds.has('text')) kind = 'tool_result'
    else if (kinds.has('tool_use')) kind = 'tool_use'
    else if (kinds.has('thinking') && !kinds.has('text')) kind = 'thinking'
    return { role: o.type, kind, blocks }
}

/**
 * Index a chunk of a transcript. `buf` starts at file byte `base` (must be a line start). Only whole lines are consumed:
 * a torn last line is left for the next call (`consumed` says how many bytes were used).
 * state carries { title, cwd, branch, model, sessionId, firstTs, lastTs, seq } across chunks.
 * Returns { rows, consumed, state }.
 */
export function indexChunk(buf, base = 0, st = {}) {
    const state = { title: '', cwd: '', branch: '', model: '', sessionId: '', firstTs: '', lastTs: '', seq: 0, ...st }
    const rows = []
    let pos = 0
    for (;;) {
        const nl = buf.indexOf(10, pos)
        if (nl < 0) break
        const line = buf.subarray(pos, nl).toString('utf8')
        const byteStart = base + pos, byteLen = nl + 1 - pos
        pos = nl + 1
        if (!line.trim()) continue
        let o
        try { o = JSON.parse(line) } catch { continue }       // foreign or corrupt line: skipped, offsets stay right
        if (!o || typeof o !== 'object') continue
        if (o.type === 'ai-title' && typeof o.aiTitle === 'string') state.title = o.aiTitle.slice(0, 140)
        if (o.entrypoint) state.entrypoint = String(o.entrypoint)
        if (o.cwd) state.cwd = o.cwd
        if (o.gitBranch) state.branch = o.gitBranch
        if (o.sessionId && !state.sessionId) state.sessionId = o.sessionId
        const c = classify(o)
        if (!c) continue
        const ts = iso(o.timestamp)
        if (ts) { if (!state.firstTs || ts < state.firstTs) state.firstTs = ts; if (!state.lastTs || ts > state.lastTs) state.lastTs = ts }
        const m = o.message || {}
        const u = m.usage || {}
        const tools = [], toolUseIds = [], spawnIds = []
        for (const b of c.blocks) {
            if (b?.type !== 'tool_use') continue
            tools.push(String(b.name || '?')); toolUseIds.push(String(b.id || ''))
            if (SPAWN_TOOLS.has(b.name)) spawnIds.push(String(b.id || ''))
        }
        if (c.role === 'assistant' && m.model && m.model !== '<synthetic>') state.model = m.model
        if (!state.title && c.role === 'user' && c.kind === 'text' && !o.isMeta) {
            const t = c.blocks.find((b) => b?.type === 'text' && typeof b.text === 'string' && !b.text.startsWith('<'))
            if (t) state.title = t.text.replace(/\s+/g, ' ').trim().slice(0, 140)
        }
        rows.push({
            seq: state.seq++, byteStart, byteLen, uuid: String(o.uuid || ''), parentUuid: String(o.parentUuid || ''),
            msgId: c.role === 'assistant' ? String(m.id || '') : '', role: c.role, kind: c.kind, ts,
            model: c.role === 'assistant' ? String(m.model || '') : '', sidechain: o.isSidechain ? 1 : 0, meta: o.isMeta ? 1 : 0,
            inTok: num(u.input_tokens), outTok: num(u.output_tokens), cacheRead: num(u.cache_read_input_tokens), cacheWrite: num(u.cache_creation_input_tokens),
            tools: JSON.stringify(tools), toolUseIds: JSON.stringify(toolUseIds), spawnIds: JSON.stringify(spawnIds),
        })
    }
    return { rows, consumed: pos, state }
}

/** Shrink huge strings inside a tool input so a page of entries stays small. */
function slimInput(v, depth = 0) {
    if (typeof v === 'string') { const c = clip(v, MAX_INPUT_CHARS); return c.cut ? c.text + `\n... (${c.cut} more characters)` : c.text }
    if (depth > 4 || v === null || typeof v !== 'object') return v
    if (Array.isArray(v)) return v.slice(0, 200).map((x) => slimInput(x, depth + 1))
    const out = {}
    for (const [k, x] of Object.entries(v)) out[k] = slimInput(x, depth + 1)
    return out
}

function resultBlock(b) {
    let text = '', images = 0
    if (typeof b.content === 'string') text = b.content
    else for (const x of Array.isArray(b.content) ? b.content : []) { if (x?.type === 'text' && typeof x.text === 'string') text += (text ? '\n' : '') + x.text; else if (x?.type === 'image') images++ }
    const c = clip(text, MAX_RESULT_CHARS)
    return { type: 'tool_result', id: String(b.tool_use_id || ''), isError: !!b.is_error, text: c.text, cut: c.cut, images }
}

/**
 * Parsed JSONL line -> viewer entry { uuid, role, kind, ts, model, meta, blocks, agentId? }.
 * blocks: text | thinking | tool_use{id,name,input} | tool_result{id,text,isError,cut} | image | notice.
 * A tool_result line also carries `launched` (agent id of an async Agent launch) so the viewer can open the child thread.
 */
export function renderEntry(o) {
    const c = classify(o)
    if (!c) return null
    const blocks = []
    for (const b of c.blocks) {
        if (!b || typeof b !== 'object') continue
        if (b.type === 'text' && typeof b.text === 'string') blocks.push({ type: 'text', text: b.text })
        else if (b.type === 'thinking') blocks.push({ type: 'thinking', text: String(b.thinking || ''), redacted: !b.thinking })
        else if (b.type === 'tool_use') blocks.push({ type: 'tool_use', id: String(b.id || ''), name: String(b.name || '?'), input: slimInput(b.input) })
        else if (b.type === 'tool_result') blocks.push(resultBlock(b))
        else if (b.type === 'image') blocks.push({ type: 'image' })
    }
    const out = { uuid: String(o.uuid || ''), role: c.role, kind: c.kind, ts: iso(o.timestamp), model: String(o.message?.model || ''), meta: !!o.isMeta, blocks }
    const agentId = o.toolUseResult?.agentId
    if (typeof agentId === 'string') out.launched = agentId
    return out
}

/** Parse one raw line string (as read by byte range) and render it; null when it is not an entry. */
export function renderLine(line) {
    try { return renderEntry(JSON.parse(line)) } catch { return null }
}
