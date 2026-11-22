// Synthetic Claude Code transcripts for tests and the README screenshot. Invented projects, ids and numbers; no real data.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const line = (o) => JSON.stringify(o)
export function assistant({ id, req, ts, session, model = 'claude-sonnet-4-5', cwd = '/work/demo-app', input = 10, output = 100, read = 0, w5 = 0, w1 = 0, think = 0, tools = [], side = false, agentId, stop = 'tool_use', branch = 'main', lines = 1 }) {
    const content = tools.map((t, i) => ({ type: 'tool_use', id: t.id || `${id}_t${i}`, name: t.name, input: t.input ?? {} }))
    const base = {
        type: 'assistant', timestamp: new Date(ts).toISOString(), sessionId: session, cwd, gitBranch: branch, requestId: req || 'req_' + id,
        ...(side ? { isSidechain: true, agentId } : {}),
        message: { id, model, role: 'assistant', stop_reason: stop, content, usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: w5 + w1, cache_creation: { ephemeral_5m_input_tokens: w5, ephemeral_1h_input_tokens: w1 }, output_tokens_details: { thinking_tokens: think } } },
    }
    return Array.from({ length: lines }, () => line(base)).join('\n')   // real transcripts repeat a message once per content block
}
export const result = ({ ts, session, toolUseId, text = 'x'.repeat(350), side = false, agentId, agent }) =>
    line({ type: 'user', timestamp: new Date(ts).toISOString(), sessionId: session, ...(side ? { isSidechain: true, agentId } : {}), ...(agent ? { toolUseResult: { agentId: agent } } : {}), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] } })
export const prompt = ({ ts, session, text }) => line({ type: 'user', timestamp: new Date(ts).toISOString(), sessionId: session, message: { role: 'user', content: text } })

/** A small tree under `root`: two projects, one session each with a subagent, a skill, a polling loop and a compaction. */
export function writeTree(root, t0 = Date.UTC(2026, 10, 20, 10, 0, 0)) {
    const sess = 'aaaaaaaa-0000-4000-8000-000000000001'
    const dir = path.join(root, '-work-demo-app')
    mkdirSync(path.join(dir, sess, 'subagents'), { recursive: true })
    const min = 60_000
    const main = [
        prompt({ ts: t0, session: sess, text: '<command-name>/review</command-name>' }),
        assistant({ id: 'msg_1', ts: t0 + min, session: sess, input: 5, output: 400, w5: 20000, think: 150, tools: [{ id: 'tu_skill', name: 'Skill', input: { skill: 'review' } }, { id: 'tu_read', name: 'Read', input: { file_path: 'a.ts' } }], lines: 3 }),
        result({ ts: t0 + 2 * min, session: sess, toolUseId: 'tu_read', text: 'y'.repeat(35000) }),
        assistant({ id: 'msg_2', ts: t0 + 3 * min, session: sess, input: 3, output: 900, read: 20000, w5: 2000, tools: [{ id: 'tu_agent', name: 'Agent', input: { subagent_type: 'builder', prompt: 'p' } }] }),
        result({ ts: t0 + 9 * min, session: sess, toolUseId: 'tu_agent', agent: 'ag1', text: 'done' }),
        ...Array.from({ length: 9 }, (_, i) => assistant({ id: `msg_p${i}`, ts: t0 + (10 + i) * min, session: sess, input: 2, output: 30, read: 24000, tools: [{ id: `tu_p${i}`, name: 'Bash', input: { command: 'sleep 30; tail log' } }] })),
        line({ type: 'system', subtype: 'compact_boundary', timestamp: new Date(t0 + 30 * min).toISOString(), sessionId: sess }),
        assistant({ id: 'msg_end', ts: t0 + 31 * min, session: sess, model: 'claude-opus-4-5', input: 4, output: 1200, read: 5000, w1: 9000, stop: 'end_turn' }),
    ].join('\n') + '\n'
    writeFileSync(path.join(dir, sess + '.jsonl'), main)
    const sub = [
        assistant({ id: 'smsg_1', ts: t0 + 4 * min, session: sess, side: true, agentId: 'ag1', input: 2, output: 300, w5: 8000, tools: [{ id: 'stu1', name: 'Grep', input: { pattern: 'x' } }] }),
        result({ ts: t0 + 5 * min, session: sess, side: true, agentId: 'ag1', toolUseId: 'stu1' }),
        assistant({ id: 'smsg_2', ts: t0 + 6 * min, session: sess, side: true, agentId: 'ag1', input: 2, output: 500, read: 8000, stop: 'end_turn' }),
    ].join('\n') + '\n'
    writeFileSync(path.join(dir, sess, 'subagents', 'agent-ag1.jsonl'), sub)
    writeFileSync(path.join(dir, sess, 'subagents', 'agent-ag1.meta.json'), JSON.stringify({ agentType: 'builder' }))
    return { sess, dir, mainFile: path.join(dir, sess + '.jsonl'), t0 }
}
