import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, symlinkSync, truncateSync, writeFileSync, utimesSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import { classify, indexChunk, renderEntry, renderLine, MAX_RESULT_CHARS } from './transcripts-parse.mjs'
import { discover, encodeCwd, isId, readRange, safePath, osUserOf } from './transcripts-files.mjs'
import * as T from './transcripts-store.mjs'
import * as R from './transcripts-run.mjs'

const L = (o) => JSON.stringify(o) + '\n'
const user = (text, extra = {}) => L({ type: 'user', uuid: 'u' + Math.random(), parentUuid: '', timestamp: '2026-01-01T10:00:00.000Z', sessionId: 's1', cwd: '/w/app', gitBranch: 'main', message: { role: 'user', content: text }, ...extra })
const asst = (id, content, usage = {}, extra = {}) => L({ type: 'assistant', uuid: 'a' + Math.random(), timestamp: '2026-01-01T10:00:05.000Z', sessionId: 's1', message: { id, model: 'claude-x', role: 'assistant', content, usage }, ...extra })
const toolRes = (id, content, extra = {}) => L({ type: 'user', uuid: 'r' + Math.random(), timestamp: '2026-01-01T10:00:09.000Z', sessionId: 's1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }, ...extra })

function tmpProjects() {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tr-'))
    const proj = path.join(root, '-w-app')
    mkdirSync(proj, { recursive: true })
    return { root, proj }
}
const memDb = () => { const db = new DatabaseSync(':memory:'); T.ensure(db); return db }

test('classify: only user/assistant lines are conversation entries', () => {
    assert.equal(classify({ type: 'attachment' }), null)
    assert.equal(classify({ type: 'ai-title', aiTitle: 'x' }), null)
    assert.equal(classify({ type: 'user', message: { content: 'hi' } }).kind, 'text')
    assert.equal(classify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x' }] } }).kind, 'tool_result')
    assert.equal(classify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hm' }] } }).kind, 'thinking')
    assert.equal(classify({ type: 'assistant', message: { content: [{ type: 'text', text: 'a' }, { type: 'tool_use', id: 't', name: 'Bash', input: {} }] } }).kind, 'tool_use')
})

test('indexChunk: byte offsets address the original lines, torn tail waits, junk is skipped', () => {
    const l1 = user('héllo wörld'), l2 = 'not json at all\n', l3 = asst('m1', [{ type: 'tool_use', id: 't1', name: 'Agent', input: { prompt: 'x' } }], { input_tokens: 3, output_tokens: 9 })
    const torn = '{"type":"user","mess'
    const buf = Buffer.from(l1 + l2 + l3 + torn)
    const r = indexChunk(buf, 1000)
    assert.equal(r.rows.length, 2)
    assert.equal(r.consumed, Buffer.byteLength(l1 + l2 + l3))
    assert.equal(r.rows[0].byteStart, 1000)
    assert.equal(r.rows[1].byteStart, 1000 + Buffer.byteLength(l1 + l2))
    const line = buf.subarray(r.rows[1].byteStart - 1000, r.rows[1].byteStart - 1000 + r.rows[1].byteLen).toString('utf8')
    assert.equal(JSON.parse(line).message.id, 'm1')
    assert.deepEqual(JSON.parse(r.rows[1].spawnIds), ['t1'])
    assert.deepEqual(JSON.parse(r.rows[1].tools), ['Agent'])
    assert.equal(r.state.title, 'héllo wörld')
    assert.equal(r.state.cwd, '/w/app')
    assert.equal(r.state.branch, 'main')
})

test('indexChunk: ai-title wins over the first prompt; state carries across chunks', () => {
    let r = indexChunk(Buffer.from(user('first prompt')), 0)
    assert.equal(r.state.title, 'first prompt')
    r = indexChunk(Buffer.from(L({ type: 'ai-title', aiTitle: 'Nice title' }) + asst('m', [{ type: 'text', text: 'ok' }])), 500, r.state)
    assert.equal(r.state.title, 'Nice title')
    assert.equal(r.rows[0].seq, 1)
})

test('renderEntry: blocks, truncation and the async-launch agent id', () => {
    const e = renderEntry({ type: 'assistant', uuid: 'a', message: { model: 'm', content: [{ type: 'thinking', thinking: 'plan' }, { type: 'text', text: '**hi**' }, { type: 'tool_use', id: 't', name: 'Edit', input: { old_string: 'a', new_string: 'b' } }] } })
    assert.deepEqual(e.blocks.map((b) => b.type), ['thinking', 'text', 'tool_use'])
    assert.equal(e.blocks[2].input.new_string, 'b')
    const big = 'x'.repeat(MAX_RESULT_CHARS + 50)
    const r = renderEntry({ type: 'user', toolUseResult: { agentId: 'abc123' }, message: { content: [{ type: 'tool_result', tool_use_id: 't', content: big, is_error: true }] } })
    assert.equal(r.blocks[0].text.length, MAX_RESULT_CHARS)
    assert.equal(r.blocks[0].cut, 50)
    assert.equal(r.blocks[0].isError, true)
    assert.equal(r.launched, 'abc123')
    assert.equal(renderLine('{broken'), null)
})

test('path safety: ids, traversal, symlink escape, extension', () => {
    assert.ok(isId('0f2c4e7a-1b2c-4d5e-8f90-123456789abc'))
    for (const bad of ['', '../x', 'a/b', 'a b', '.hidden', 'a;rm', 'x'.repeat(200)]) assert.equal(isId(bad), false, bad)
    const { root, proj } = tmpProjects()
    const ok = path.join(proj, 's1.jsonl'); writeFileSync(ok, '{}\n')
    assert.equal(safePath(ok, [root]), ok)
    assert.equal(safePath(path.join(proj, '..', '..', 'etc', 'passwd'), [root]), null)
    assert.equal(safePath(path.join(proj, 'x.txt'), [root]), null)
    const outside = mkdtempSync(path.join(os.tmpdir(), 'out-')); writeFileSync(path.join(outside, 'e.jsonl'), '{}\n')
    symlinkSync(path.join(outside, 'e.jsonl'), path.join(proj, 'link.jsonl'))
    assert.equal(safePath(path.join(proj, 'link.jsonl'), [root]), null)
    assert.equal(encodeCwd('/home/a b/x.y'), '-home-a-b-x-y')
    assert.equal(osUserOf('/home/alice/.claude/projects/p/s.jsonl'), 'alice')
})

test('discover: main sessions and subagents with meta', () => {
    const { root, proj } = tmpProjects()
    writeFileSync(path.join(proj, 's1.jsonl'), user('hi'))
    const sub = path.join(proj, 's1', 'subagents'); mkdirSync(sub, { recursive: true })
    writeFileSync(path.join(sub, 'agent-ab12.jsonl'), user('sub'))
    writeFileSync(path.join(sub, 'agent-ab12.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'look', toolUseId: 'toolu_1' }))
    writeFileSync(path.join(proj, 'bad name.jsonl'), 'x')
    const { files } = discover(root)
    assert.equal(files.length, 2)
    assert.equal(files.find((f) => f.agentId === 'ab12').meta.toolUseId, 'toolu_1')
    assert.equal(readRange(path.join(proj, 's1.jsonl'), 0, 5).toString(), '{"typ')
})

test('ingest: incremental, torn tail, dedupe per message id, truncation reset, subagent parent link', () => {
    const { root, proj } = tmpProjects()
    const db = memDb()
    const main = path.join(proj, 's1.jsonl')
    writeFileSync(main, user('build it') + asst('m1', [{ type: 'text', text: 'on it' }], { input_tokens: 10, output_tokens: 5 }) +
        asst('m1', [{ type: 'tool_use', id: 'toolu_1', name: 'Agent', input: {} }], { input_tokens: 10, output_tokens: 40 }))
    const sub = path.join(proj, 's1', 'subagents'); mkdirSync(sub, { recursive: true })
    writeFileSync(path.join(sub, 'agent-ab12.jsonl'), user('sub task', { isSidechain: true }) + asst('s1m', [{ type: 'tool_use', id: 'toolu_9', name: 'Bash', input: {} }], { input_tokens: 1, output_tokens: 7 }))
    writeFileSync(path.join(sub, 'agent-ab12.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'look', toolUseId: 'toolu_1' }))
    let r = T.ingestAll(db, { dirs: [root] })
    assert.equal(r.files, 2); assert.equal(r.changed, 2); assert.equal(r.linked, 1)
    const t = db.prepare("SELECT * FROM Transcript WHERE agentId=''").get()
    assert.equal(t.title, 'build it'); assert.equal(t.messageCount, 3); assert.equal(t.toolCount, 1)
    assert.equal(t.outTokens, 40, 'a message id split over lines counts once, at its largest usage')
    assert.equal(t.inTokens, 10)
    const child = db.prepare("SELECT * FROM Transcript WHERE agentId='ab12'").get()
    assert.equal(child.parentId, t.id); assert.equal(child.agentType, 'Explore')
    // nothing changed: nothing read
    assert.equal(T.ingestAll(db, { dirs: [root] }).changed, 0)
    // append a whole line plus a torn one: only the whole line is indexed, the offset stays before the torn bytes
    appendFileSync(main, user('more') + '{"type":"user","mes')
    r = T.ingestAll(db, { dirs: [root] }); assert.equal(r.added, 1)
    let row = db.prepare("SELECT * FROM Transcript WHERE agentId=''").get()
    assert.equal(row.messageCount, 4)
    assert.ok(row.offset < row.size)
    // the torn line gets finished
    appendFileSync(main, 'sage":{"role":"user","content":"done"},"timestamp":"2026-01-01T11:00:00.000Z"}\n')
    T.ingestAll(db, { dirs: [root] })
    row = db.prepare("SELECT * FROM Transcript WHERE agentId=''").get()
    assert.equal(row.messageCount, 5); assert.equal(row.offset, row.size)
    // truncated file: index restarts, no stale rows
    writeFileSync(main, user('fresh'))
    utimesSync(main, new Date(), new Date(Date.now() + 5000))
    r = T.ingestAll(db, { dirs: [root] })
    row = db.prepare("SELECT * FROM Transcript WHERE agentId=''").get()
    assert.equal(row.messageCount, 1); assert.equal(row.title, 'fresh')
    assert.equal(db.prepare('SELECT COUNT(*) n FROM TranscriptMessage WHERE transcriptId=?').get(row.id).n, 1)
    assert.equal(T.find(db, 's1').id, row.id)
    assert.equal(T.list(db, { q: 'fre' }).length, 1)
    assert.equal(T.list(db, { q: '%' }).length, 0, 'LIKE wildcards in the search are escaped')
})

test('run: argument building, validation and the key-free environment', () => {
    const a = R.buildArgs({ osUser: 'alice', cwd: '/w', permissionMode: 'plan', model: 'opus', effort: 'high', resume: 'abcdef12-0000' }, { fork: true })
    assert.deepEqual(a.slice(0, 7), ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--include-partial-messages'])
    assert.ok(a.join(' ').includes('--permission-mode plan') && a.join(' ').includes('--effort high') && a.includes('--fork-session'))
    assert.ok(R.buildArgs({ osUser: 'a', cwd: '/w', permissionMode: 'bypass' }).includes('bypassPermissions'))
    assert.ok(!R.buildArgs({ osUser: 'a', cwd: '/w', resume: 'abcdef12-0000' }).includes('--fork-session'))
    for (const bad of [{ osUser: 'root', cwd: '/w' }, { osUser: 'a;b', cwd: '/w' }, { osUser: 'a', cwd: 'rel' }, { osUser: 'a', cwd: '/w', permissionMode: 'yolo' }, { osUser: 'a', cwd: '/w', effort: 'ultra' }, { osUser: 'a', cwd: '/w', model: '$(x)' }, { osUser: 'a', cwd: '/w', resume: '../x' }])
        assert.throws(() => R.buildArgs(bad), undefined, JSON.stringify(bad))
    const env = R.cleanEnv({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', CLAUDE_CODE_OAUTH_TOKEN: 'o', PATH: '/bin' })
    assert.deepEqual(Object.keys(env), ['PATH'])
    const [cmd, args] = R.spawnPlan('alice', ['-p'], 'bob')
    assert.equal(cmd, 'sudo'); assert.deepEqual(args.slice(0, 4), ['-n', '-H', '-u', 'alice']); assert.ok(args.includes('ANTHROPIC_API_KEY'))
    assert.notEqual(R.spawnPlan('bob', ['-p'], 'bob')[0], 'sudo')
})

test('run: a resumed session that was just written is forked, an old one is not', () => {
    const { proj } = tmpProjects()
    const f = path.join(proj, 's1.jsonl'); writeFileSync(f, '{}\n')
    assert.equal(R.shouldFork(f), true)
    assert.equal(R.shouldFork(f, { now: Date.now() + R.FORK_WINDOW_MS + 1000 }), false)
    assert.equal(R.shouldFork(f, { busy: true, now: Date.now() + 1e9 }), true)
    assert.equal(R.shouldFork(path.join(proj, 'none.jsonl')), false)
})

test('run: tailLines returns whole lines only', () => {
    const { proj } = tmpProjects()
    const f = path.join(proj, 'o.ndjson'); writeFileSync(f, 'a\nb\nc')
    let [lines, off] = R.tailLines(f, 0); assert.deepEqual(lines, ['a', 'b']); assert.equal(off, 4)
    appendFileSync(f, 'd\n');[lines, off] = R.tailLines(f, off); assert.deepEqual(lines, ['cd']); assert.equal(off, 7)
    truncateSync(f, 0)
})
