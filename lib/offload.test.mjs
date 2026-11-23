import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanParams, execJob, finishJob, jobGet, jobList, markJob, playtestCommand, reapJobs, runOffload, setOffloadRemote } from './offload.mjs'
import { act, fromForgejo, fromGithub, syncRepo, verdict } from './ci.mjs'
import { createGh } from './gh.mjs'
import * as F from './feeds.mjs'

const mem = () => { const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE Setting (key TEXT PRIMARY KEY, value TEXT)'); F.ensure(db); return db }

test('cleanParams clamps and strips', () => {
    assert.deepEqual(cleanParams({ map: 'ar/ena;rm', bots: '-3', duration: 'x' }), { map: 'arenarm', bots: 4, duration: 120, mode: '' })
})

test('runOffload validates and stores a queued job; a registered remote takes station jobs', () => {
    const db = mem()
    assert.throws(() => runOffload(db, { kind: 'nope', project: 'fc' }), /unknown offload kind/)
    assert.throws(() => runOffload(db, { kind: 'playtest', project: 'fc', target: 'moon' }), /target/)
    const a = runOffload(db, { kind: 'playtest', project: 'fc', target: 'planet', spawnChild: false, requestedBy: 'u1' })
    assert.equal(a.node, 'local'); assert.equal(jobList(db)[0].status, 'queued')
    setOffloadRemote(() => ({ accepted: true, node: 'staging02' }))
    const b = runOffload(db, { kind: 'playtest', project: 'fc', target: 'station', spawnChild: false })
    assert.equal(b.node, 'staging02')
    setOffloadRemote(null)
    const c = runOffload(db, { kind: 'playtest', project: 'fc', target: 'station', spawnChild: false })
    assert.match(jobList(db, { project: 'fc' })[0].log, /no station transport/); assert.equal(c.node, 'local')
})

test('execJob runs the repo script, records a bot playtest and closes the job', () => {
    const db = mem()
    const repo = mkdtempSync(path.join(os.tmpdir(), 'pt-')); mkdirSync(path.join(repo, 'tools')); writeFileSync(path.join(repo, 'tools', 'playtest.sh'), '#!/bin/sh\n'); chmodSync(path.join(repo, 'tools', 'playtest.sh'), 0o755)
    const { id } = runOffload(db, { kind: 'playtest', project: 'fc', params: { map: 'arena', bots: 8, duration: 30 }, spawnChild: false })
    const soak = 'SOAK ' + JSON.stringify({ map: 'arena', bots: 8, duration_sec: 30, ok: true, tick_ms: { mean: 1, p95: 2 }, totals: { kills: 3 }, reasons: [] })
    const exec = (cmd, args) => { assert.deepEqual(args, ['--map', 'arena', '--bots', '8', '--duration', '30']); return { status: 0, stdout: soak, stderr: '' } }
    const j = execJob(db, id, { exec, projectRepo: () => repo })
    assert.equal(j.status, 'ok'); assert.match(j.log, /playtest\.sh/)
    assert.equal(db.prepare('SELECT count(*) n FROM "Playtest" WHERE game = ?').get('fc').n, 1)
    assert.ok(JSON.parse(j.result).playtestId)
})

test('execJob: missing repo or script becomes an error job, not a throw', () => {
    const db = mem()
    const { id } = runOffload(db, { kind: 'playtest', project: 'x', spawnChild: false })
    assert.equal(execJob(db, id, { projectRepo: () => '' }).status, 'error')
    const { id: id2 } = runOffload(db, { kind: 'playtest', project: 'x', spawnChild: false })
    const j = execJob(db, id2, { projectRepo: () => '/nonexistent' })
    assert.equal(j.status, 'error'); assert.match(j.log, /tools\/playtest\.sh/)
})

test('reapJobs closes running jobs whose process is gone', () => {
    const db = mem()
    const { id } = runOffload(db, { kind: 'playtest', project: 'x', spawnChild: false })
    db.prepare("UPDATE offload_job SET status='running', pid=999999 WHERE id=?").run(id)
    assert.equal(reapJobs(db, () => false), 1)
    assert.equal(jobList(db)[0].status, 'error')
})

test('ci: forgejo and github rows normalise; verdict words', () => {
    const f = fromForgejo('o/r', 'https://f', { id: 5, name: 'ci', head_branch: 'main', status: 'failure', created_at: '2026-01-01T00:00:00Z' })
    assert.equal(verdict(f), 'failure'); assert.equal(f.status, 'completed')
    assert.equal(verdict(fromForgejo('o/r', 'https://f', { id: 6, status: 'running' })), 'running')
    assert.equal(verdict(fromGithub('o/r', { databaseId: 9, status: 'completed', conclusion: 'success' })), 'success')
})

test('ci syncRepo: forgejo first without touching gh; gh only as fallback; ttl cache', async () => {
    const db = mem()
    let ghCalls = 0
    const gh = { call: () => { ghCalls++; return { status: 0, stdout: JSON.stringify([{ databaseId: 1, status: 'completed', conclusion: 'success', createdAt: '2026-01-01T00:00:00Z' }]), stderr: '' } } }
    const fj = { base: 'https://f', token: 't' }
    let r = await syncRepo(db, 'o/a', { gh, forgejo: fj, fetchJson: async () => ({ workflow_runs: [{ id: 1, status: 'success', head_branch: 'main' }] }) })
    assert.equal(r.source, 'forgejo'); assert.equal(ghCalls, 0)
    r = await syncRepo(db, 'o/a', { gh, forgejo: fj, fetchJson: async () => { throw new Error('no') } })
    assert.ok(r.cached)
    r = await syncRepo(db, 'o/b', { gh, forgejo: fj, fetchJson: async () => ({ workflow_runs: [] }) })
    assert.equal(r.source, 'github'); assert.equal(ghCalls, 1)
    r = await syncRepo(db, 'o/c', { gh, forgejo: null })
    assert.equal(r.runs, 1)
})

test('ci act: github runs only, through the gh wrapper', () => {
    const db = mem()
    const calls = []
    const run = (args) => { calls.push(args.join(' ')); return { status: 0, stdout: args[1] === 'rate_limit' ? '{"resources":{}}' : '', stderr: '' } }
    const gh = createGh({ db, run, sleep() {}, now: () => 1 })
    db.prepare("INSERT INTO ci_run (source, repo, run_id) VALUES ('github','o/r','7'), ('forgejo','o/r','8')").run()
    assert.deepEqual(act(gh, db, 'rerun', 'o/r', 7), { repo: 'o/r', run_id: '7', action: 'rerun' })
    assert.ok(calls.includes('run rerun 7 -R o/r'))
    assert.throws(() => act(gh, db, 'cancel', 'o/r', 8), /read-only/)
    assert.throws(() => act(gh, db, 'cancel', 'o/r', 99), /no cached run/)
    assert.throws(() => act(gh, db, 'delete', 'o/r', 7), /rerun or cancel/)
})

test('a node-scheduled job: no local child, marked running by the panel, finished from the node log', () => {
    const db = mem()
    assert.equal(playtestCommand({ map: 'arena;rm -rf', bots: 8, duration: 30 }), 'bash tools/playtest.sh --map arenarm-rf --bots 8 --duration 30')
    const { id, node } = runOffload(db, { kind: 'playtest', project: 'fc', target: 'station', node: 'gpu-1', params: { bots: 2, duration: 20 } })
    assert.equal(node, 'gpu-1'); assert.equal(jobGet(db, id).status, 'queued')
    assert.equal(runOffload(db, { kind: 'playtest', project: 'fc', target: 'station', node: 'x', params: { bots: 3, duration: 15 } }).command, 'bash tools/playtest.sh --bots 3 --duration 15')
    assert.equal(markJob(db, id, { status: 'running', node: 'gpu-2' }).node, 'gpu-2')
    assert.equal(reapJobs(db, () => false), 0, 'a remote job is not reaped while within its duration')
    const soak = 'SOAK ' + JSON.stringify({ map: 'arena', bots: 2, duration_sec: 20, ok: true, tick_ms: { mean: 1, p95: 2 }, totals: { kills: 1 }, reasons: [] })
    const j = finishJob(db, id, `boot\n${soak}\n`, 0)
    assert.equal(j.status, 'ok'); assert.equal(JSON.parse(j.result).exit, 0)
    assert.equal(finishJob(db, id, '', 1).status, 'ok', 'finishing twice keeps the first result')
    const b = runOffload(db, { kind: 'playtest', project: 'fc', target: 'station', node: 'gpu-1' })
    markJob(db, b.id, { status: 'running' })
    assert.equal(finishJob(db, b.id, 'crashed', 1).status, 'failed')
    const c = runOffload(db, { kind: 'playtest', project: 'fc', target: 'station', node: 'gpu-1', params: { duration: 10 } })
    markJob(db, c.id, { status: 'running' })
    assert.equal(reapJobs(db, () => false, Date.now() + 2 * 3600_000), 1, 'a lost remote job is reaped after duration + 1 h')
    const d = runOffload(db, { kind: 'playtest', project: 'fc', target: 'station', node: 'gpu-1' })
    assert.equal(markJob(db, d.id, { status: 'error', message: 'node gone' }).status, 'error')
})
