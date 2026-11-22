// Claude Code transcript parser for the Usage tab. Pure: text in, plain rows out. It keeps COUNTS, IDS and NAMES only;
// no message text, tool input or tool output is ever returned (the sizes of tool results are, as an estimated token count).
import { createHash } from 'node:crypto'
import path from 'node:path'

export const CHARS_PER_TOKEN = 3.5      // tool_result size -> tokens: an estimate (labelled as one in the panel)
export const IMAGE_TOKENS = 1200        // one image block in a tool result
/** Tools that mean "waiting": an assistant message whose tool calls are all of these (or a sleep) counts as idle. */
export const IDLE_TOOLS = new Set(['Monitor', 'Sleep', 'ScheduleWakeup', 'TaskOutput', 'BashOutput', 'KillShell'])

const sha = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12)
const num = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.trunc(Number(v))) : 0)
export const estTokens = (chars) => Math.ceil(chars / CHARS_PER_TOKEN)

/** Project label from a working directory. mode: 'basename' (default), 'hash' (stable opaque id) or 'none'. */
export function projectLabel(cwd, mode = 'basename', fallback = '') {
    if (!cwd) return fallback || '(unknown)'
    if (mode === 'none') return 'project'
    if (mode === 'hash') return 'p-' + sha(cwd).slice(0, 8)
    return path.basename(cwd.replace(/[\\/]+$/, '')) || '(root)'
}

/** Characters in a tool_result's content (string, or blocks of text/image). */
function resultSize(content) {
    if (typeof content === 'string') return { chars: content.length, tokens: estTokens(content.length) }
    let chars = 0, extra = 0
    for (const b of Array.isArray(content) ? content : []) {
        if (b?.type === 'text' && typeof b.text === 'string') chars += b.text.length
        else if (b?.type === 'image') extra += IMAGE_TOKENS
    }
    return { chars, tokens: estTokens(chars) + extra }
}

/** A compaction is logged twice (a boundary marker and the summary message, within milliseconds): one key per 10 s window dedupes them. */
const compactKey = (session, agent, ts) => `c:${session}:${agent}:${Math.floor(ts / 10_000)}`
const isIdle = (name, input) => IDLE_TOOLS.has(name) || (name === 'Bash' && typeof input?.command === 'string' && /^\s*(sleep\s+\d|.*\bsleep\s+\d+\s*(;|&&|$))/.test(input.command) && input.command.length < 200)

/**
 * Parse transcript text (whole lines). ctx: { sessionId, agentId, sidechain, agentType, projectMode, fallbackProject, state }
 * `state` ({ skill, cwd, branch }) carries across chunks of one file and is returned updated.
 * Returns { messages, tools, results, spawns, links, events, state }:
 *   messages  Map key -> row (one per assistant message id; repeats merge: last usage wins, tools are unioned)
 *   tools     Map tool_use_id -> row (the call; result_tokens filled when the result is in the same text)
 *   results   [{ tool_use_id, tokens, is_error }]  tool results seen (the store applies them to calls from earlier chunks)
 *   spawns    [{ tool_use_id, subagent_type }]     Agent/Task calls;   links [{ tool_use_id, agent_id }] their results' agent ids
 *   events    [{ key, ts, kind, session_id, agent_id }]  kind 'compaction'
 */
export function parseTranscript(text, ctx = {}) {
    const state = { skill: '', cwd: '', branch: '', ...(ctx.state || {}) }
    const messages = new Map(), tools = new Map(), results = [], spawns = [], links = [], events = []
    const mode = ctx.projectMode || 'basename'
    for (const raw of text.split('\n')) {
        if (!raw.trim()) continue
        let o
        try { o = JSON.parse(raw) } catch { continue }       // a torn or foreign line: skipped, not fatal
        if (!o || typeof o !== 'object') continue
        if (o.cwd) state.cwd = o.cwd
        if (o.gitBranch) state.branch = o.gitBranch
        const ts = Date.parse(o.timestamp)
        const session = o.sessionId || ctx.sessionId || ''
        const sidechain = !!(o.isSidechain || ctx.sidechain)
        const agentId = o.agentId || ctx.agentId || ''
        const agentType = sidechain ? (ctx.agentType || o.attributionAgent || 'subagent') : (o.attributionAgent || 'main')
        const project = projectLabel(state.cwd, mode, ctx.fallbackProject)

        if (o.type === 'assistant' && o.message && typeof o.message === 'object') {
            const m = o.message, u = m.usage
            if (!u || m.model === '<synthetic>' || !Number.isFinite(ts)) continue
            const key = m.id || o.requestId || o.uuid
            if (!key) continue
            const cc = u.cache_creation || {}
            const total = num(u.cache_creation_input_tokens)
            const c1 = num(cc.ephemeral_1h_input_tokens), c5 = cc.ephemeral_5m_input_tokens !== undefined ? num(cc.ephemeral_5m_input_tokens) : Math.max(0, total - c1)
            const names = [], idleFlags = []
            for (const b of Array.isArray(m.content) ? m.content : []) {
                if (b?.type !== 'tool_use' || !b.name) continue
                names.push(b.name)
                idleFlags.push(isIdle(b.name, b.input))
                if (b.id) {
                    tools.set(b.id, { tool_use_id: b.id, ts, session_id: session, agent_id: agentId, agent_type: agentType, project, model: m.model || '', tool: b.name,
                        sig: sha(b.name + JSON.stringify(b.input ?? null)), result_tokens: 0, is_error: 0, has_result: 0, skill: state.skill })
                    if (b.name === 'Skill' && typeof b.input?.skill === 'string') state.skill = b.input.skill.slice(0, 80)
                    if ((b.name === 'Agent' || b.name === 'Task') && typeof b.input?.subagent_type === 'string') spawns.push({ tool_use_id: b.id, subagent_type: b.input.subagent_type.slice(0, 80) })
                }
            }
            const prev = messages.get(key)
            const row = {
                msg_key: key, ts, session_id: session, agent_id: agentId, agent_type: agentType, sidechain: sidechain ? 1 : 0, project, branch: state.branch || '',
                model: m.model || o.requestedModel || '', input: num(u.input_tokens), output: num(u.output_tokens), cache_read: num(u.cache_read_input_tokens),
                cache_5m: c5, cache_1h: c1, thinking: num(u.output_tokens_details?.thinking_tokens), tools: [...new Set([...(prev?.tools ?? []), ...names])],
                stop_reason: m.stop_reason || prev?.stop_reason || '', request_id: o.requestId || prev?.request_id || '', skill: state.skill,
                idle: 0, _n: (prev?._n ?? 0) + names.length, _idle: (prev?._idle ?? 0) + idleFlags.filter(Boolean).length,
            }
            row.idle = row._n > 0 && row._idle === row._n ? 1 : 0
            messages.set(key, row)
        } else if (o.type === 'user' && o.message) {
            const c = o.message.content
            if (o.isCompactSummary) events.push({ key: compactKey(session, agentId, ts), ts, kind: 'compaction', session_id: session, agent_id: agentId, project })
            if (Array.isArray(c)) {
                let hadResult = false
                for (const b of c) {
                    if (b?.type !== 'tool_result' || !b.tool_use_id) continue
                    hadResult = true
                    const { tokens } = resultSize(b.content)
                    const r = { tool_use_id: b.tool_use_id, tokens, is_error: b.is_error ? 1 : 0 }
                    results.push(r)
                    const call = tools.get(b.tool_use_id)
                    if (call) Object.assign(call, { result_tokens: tokens, is_error: r.is_error, has_result: 1 })
                    const aid = o.toolUseResult?.agentId
                    if (typeof aid === 'string' && aid) links.push({ tool_use_id: b.tool_use_id, agent_id: aid })
                }
                if (!hadResult && !o.isMeta && !o.isCompactSummary) state.skill = ''
            } else if (typeof c === 'string' && !o.isMeta && !o.isCompactSummary) {
                const cmd = /<command-name>\s*\/?([^<\s]{1,80})\s*<\/command-name>/.exec(c)
                state.skill = cmd ? '/' + cmd[1] : ''
            }
        } else if (o.type === 'system' && o.subtype === 'compact_boundary') {
            events.push({ key: compactKey(session, agentId, ts), ts, kind: 'compaction', session_id: session, agent_id: agentId, project })
        }
    }
    for (const r of messages.values()) { delete r._n; delete r._idle }
    return { messages, tools, results, spawns, links, events, state }
}
