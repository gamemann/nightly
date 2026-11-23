import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startDaemon } from '../node/daemon.mjs'
import { loadConfig } from '../node/config.mjs'
import { NodeManager } from './node-client.mjs'
import { pickNode, detectHeavy, inferKinds, hasGpu, nodeCwd } from './node-sched.mjs'
import { checkSpecs } from './node-specs.mjs'

const fakeProbe = () => ({ cpu: { model: 'fake', cores: 4, threads: 8 }, ramMb: 8000, gpu: [], disks: [], offloadKinds: ['build', 'test'], buildSlots: 1, heavySlots: 1 })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(25) } throw new Error('timeout') }

const tmp = mkdtempSync(path.join(os.tmpdir(), 'nn-test-'))
const ws = path.join(tmp, 'ws'); mkdirSync(ws)
const cfg = loadConfig({ NIGHTLY_NODE_STATE: path.join(tmp, 'state'), NIGHTLY_NODE_TOKEN: 'secret-token', NIGHTLY_NODE_PORT: '0', NIGHTLY_NODE_BIND: '127.0.0.1', NIGHTLY_NODE_NAME: 'st1', NIGHTLY_NODE_WORKSPACES: ws, NIGHTLY_NODE_HEARTBEAT_MS: '200' })
let d, mgr
const desc = (over = {}) => ({ id: 1, name: 'st1', host: '127.0.0.1', port: d.port, tls: false, token: 'secret-token', enabled: true, ...over })

test('daemon starts and the panel connects', async () => {
    d = await startDaemon(cfg, { log: () => {}, probe: fakeProbe })
    assert.ok(d.port > 0)
    mgr = new NodeManager({ minDelay: 50, maxDelay: 200 })
    mgr.sync([desc()])
    await until(() => mgr.statuses()[0]?.state === 'online')
    const specs = await mgr.request(1, 'specs')
    assert.equal(specs.cpu.model, 'fake')
    const st = await mgr.request(1, 'status')
    assert.equal(st.slots.build.max, 1)
})

test('bad token is denied', async () => {
    const m2 = new NodeManager({ minDelay: 50, maxDelay: 100 })
    m2.sync([desc({ id: 2, token: 'wrong' })])
    await until(() => m2.statuses()[0]?.state === 'denied')
    m2.stopAll()
})

test('heartbeat reaches the panel', async () => {
    const got = await new Promise((res) => { mgr.once('event', (ev) => ev === 'heartbeat' && res(ev)); setTimeout(() => res(null), 3000) })
    assert.equal(got, 'heartbeat')
})

test('exec streams logs and reports the exit code', async () => {
    const events = []
    mgr.on('event', (ev, data) => events.push([ev, data]))
    await mgr.request(1, 'exec', { job: 'j1', kind: 'build', cmd: 'echo hello; exit 3', cwd: ws })
    await until(() => events.some(([e, x]) => e === 'done' && x.job === 'j1'))
    const done = events.find(([e]) => e === 'done')[1]
    assert.equal(done.code, 3)
    const log = await mgr.request(1, 'jobs.log', { job: 'j1' })
    assert.match(log.text, /hello/)
})

test('kind, cwd and slot restrictions', async () => {
    await assert.rejects(mgr.request(1, 'exec', { job: 'k', kind: 'gpu', cmd: 'true', cwd: ws }), /does not offer/)
    await assert.rejects(mgr.request(1, 'exec', { job: 'c', kind: 'build', cmd: 'true', cwd: '/etc' }), /outside the workspace/)
    await mgr.request(1, 'exec', { job: 's1', kind: 'build', cmd: 'sleep 2', cwd: ws })
    await assert.rejects(mgr.request(1, 'exec', { job: 's2', kind: 'build', cmd: 'true', cwd: ws }), /no free build slot/)
    await mgr.request(1, 'cancel', { job: 's1' })
})

test('config.set changes offered kinds', async () => {
    await mgr.request(1, 'config.set', { kinds: ['build', 'gpu'] })
    const c = await mgr.request(1, 'config.get')
    assert.deepEqual(c.kinds, ['build', 'gpu'])
})

test('reconnects after the connection drops', async () => {
    for (const p of d.peers) p.conn?.close?.()
    await sleep(100)
    await until(() => mgr.statuses()[0]?.state === 'online')
    mgr.stopAll(); d.stop()
})

test('scheduler: kinds, slots, GPU, planet fallback', () => {
    const st = (name, over = {}) => ({ id: 1, name, type: 'station', online: true, enabled: true, specs: { offloadKinds: ['build', 'test'], buildSlots: 2, heavySlots: 1, gpu: [] }, live: null, ...over })
    const gpuSt = st('gpu', { specs: { offloadKinds: ['build', 'gpu', 'browser'], buildSlots: 1, heavySlots: 1, gpu: ['NVIDIA RTX 3060'] } })
    assert.equal(pickNode([st('a')], { kinds: ['gpu'] }).node, null)
    assert.equal(pickNode([st('a'), gpuSt], { kinds: ['gpu'] }).node.name, 'gpu')
    assert.equal(pickNode([st('a')], { kinds: ['test'] }).node.name, 'a')
    const busy = st('a', { live: { slots: { build: { used: 2, max: 2 } } } })
    const r = pickNode([busy], { kinds: ['build'] })
    assert.equal(r.node, null)
    assert.equal(r.capable.length, 1)
    assert.equal(pickNode([st('p', { type: 'planet' })], { kinds: ['build'] }).node.name, 'p')
    assert.equal(pickNode([st('p', { type: 'planet' })], { kinds: ['build'] }, { planetFallback: false }).node, null)
    assert.equal(pickNode([st('p', { type: 'planet', specs: { offloadKinds: ['gpu'], buildSlots: 1, gpu: ['RTX'] } })], { kinds: ['gpu'] }).node, null)
    assert.equal(pickNode([st('off', { online: false })], { kinds: ['build'] }).node, null)
    assert.equal(hasGpu({ gpu: ['QEMU virtio VGA'] }), false)
    assert.equal(detectHeavy('cargo build --release').heavy, true)
    assert.equal(detectHeavy('echo hi').heavy, false)
    assert.deepEqual(inferKinds('./game' + '.sh test foo'), ['suite'])
})

test('nodeCwd: per-node project mapping, then workspace root, then the panel path', () => {
    const p = { slug: 'fc', repoPath: '/home/gamedev/godot/fc-game' }
    assert.equal(nodeCwd({ specs: { projectPaths: { fc: '/srv/fc' }, workspace: '/w' } }, p), '/srv/fc')
    assert.equal(nodeCwd({ specs: { workspace: '/w' } }, p), '/w/fc-game')
    assert.equal(nodeCwd({ specs: { workspace: '/w' } }, { slug: 'x', repoPath: '' }), '/w/x')
    assert.equal(nodeCwd({ specs: {} }, p), '/home/gamedev/godot/fc-game')
    assert.equal(nodeCwd({ specs: {} }, null), '')
    assert.throws(() => checkSpecs({ projectPaths: { fc: 'relative' } }), /absolute/)
    assert.throws(() => checkSpecs({ workspace: 'w' }), /absolute/)
    assert.equal(checkSpecs({ workspace: '/w', projectPaths: { fc: '/srv/fc' } }).workspace, '/w')
})
