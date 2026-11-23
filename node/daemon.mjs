// nightly-node: the listener on every node (planet or station). The panel connects (WebSocket, TLS when a
// cert and key are configured, else plain), proves it knows the token, then both sides talk: the panel
// asks for specs, starts offload jobs, creates users; the node pushes heartbeats and job output.
import http from 'node:http'
import https from 'node:https'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import { accept } from '../lib/node-ws.mjs'
import { Peer, serverHandshake, PROTOCOL } from '../lib/node-proto.mjs'
import { detectSpecs } from '../lib/node-probe.mjs'
import { OFFLOAD_KINDS } from '../lib/node-specs.mjs'
import { loadConfig, saveOverrides } from './config.mjs'
import { JobRunner } from './jobs.mjs'
import * as A from './accounts.mjs'

export const VERSION = '1.0.0'

/** Probed specs with the configured kinds and slots laid over them. */
export function effectiveSpecs(cfg, probe = detectSpecs) {
    const s = probe()
    if (cfg.kinds) s.offloadKinds = cfg.kinds
    if (cfg.buildSlots != null) s.buildSlots = Number(cfg.buildSlots)
    if (cfg.heavySlots != null) s.heavySlots = Number(cfg.heavySlots)
    return s
}

export function startDaemon(cfg = loadConfig(), { log = (m) => console.log(`[nightly-node] ${m}`), probe } = {}) {
    if (!cfg.tokens.length) throw new Error('no token configured: set NIGHTLY_NODE_TOKEN (or "token" in the config file)')
    let specs = effectiveSpecs(cfg, probe)
    const peers = new Set()
    const broadcast = (ev, data) => { for (const p of peers) { try { p.notify(ev, data) } catch { /* peer gone */ } } }
    const runner = new JobRunner(cfg, broadcast, {
        slots: { kinds: () => cfg.kinds ?? specs.offloadKinds, build: () => Number(cfg.buildSlots ?? specs.buildSlots), heavy: () => Number(cfg.heavySlots ?? specs.heavySlots) },
    })
    const status = () => ({
        name: cfg.name, version: VERSION, mode: cfg.mode, time: new Date().toISOString(), uptime: Math.round(os.uptime()),
        load: os.loadavg(), memFreeMb: Math.round(os.freemem() / 2 ** 20), memTotalMb: Math.round(os.totalmem() / 2 ** 20),
        kinds: cfg.kinds ?? specs.offloadKinds,
        slots: { build: { used: runner.used(false), max: Number(cfg.buildSlots ?? specs.buildSlots) }, heavy: { used: runner.used(true), max: Number(cfg.heavySlots ?? specs.heavySlots) } },
        jobs: runner.snapshot().filter((j) => j.status === 'running').map((j) => j.job),
    })
    const handlers = {
        ping: async () => ({ pong: true, time: Date.now() }),
        status: async () => status(),
        specs: async ({ refresh } = {}) => { if (refresh) specs = effectiveSpecs(cfg, probe); return specs },
        'config.get': async () => ({ kinds: cfg.kinds ?? specs.offloadKinds, buildSlots: Number(cfg.buildSlots ?? specs.buildSlots), heavySlots: Number(cfg.heavySlots ?? specs.heavySlots), workspaces: cfg.workspaces, supportedKinds: OFFLOAD_KINDS }),
        'config.set': async (a) => { saveOverrides(cfg, a); specs = effectiveSpecs(cfg, probe); broadcast('status', status()); return status() },
        exec: async (a) => runner.start(a),
        cancel: async ({ job }) => runner.cancel(job),
        'jobs.list': async () => runner.snapshot(),
        'jobs.log': async ({ job, bytes }) => ({ job, text: runner.tail(job, bytes) }),
        'user.exists': async ({ username }) => ({ username, exists: A.userExists(username) }),
        'user.create': async (a) => A.createUser({ ...a, allowCreate: cfg.allowUserCreate }),
        'ssh.keygen': async (a) => A.generateKey(a),
        'ssh.authorize': async (a) => A.authorizeKey(a),
        'ssh.check': async (a) => A.sshCheck(a),
    }

    const tls = cfg.tlsCert && cfg.tlsKey
    const onUpgrade = async (req, socket, head) => {
        const conn = accept(req, socket, head)
        if (!conn) return
        conn.on('error', () => {})
        try {
            const { peerName } = await serverHandshake(conn, { tokens: cfg.tokens, name: cfg.name, info: { version: VERSION, mode: cfg.mode, status: status() } })
            const peer = new Peer(conn, handlers)
            peers.add(peer)
            log(`panel "${peerName}" connected from ${req.socket.remoteAddress}`)
            peer.on('close', () => { peers.delete(peer); log(`panel "${peerName}" disconnected`) })
        } catch (e) { log(`connection from ${req.socket.remoteAddress} refused: ${e.message}`) }
    }
    const handler = (req, res) => {
        if (req.url === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); return void res.end(JSON.stringify({ ok: true, name: cfg.name, proto: PROTOCOL, version: VERSION })) }
        res.writeHead(426, { 'content-type': 'text/plain' }); res.end('nightly-node: WebSocket only\n')
    }
    const server = tls
        ? https.createServer({ cert: readFileSync(cfg.tlsCert), key: readFileSync(cfg.tlsKey) }, handler)
        : http.createServer(handler)
    server.on('upgrade', onUpgrade)
    const beat = setInterval(() => broadcast('heartbeat', status()), cfg.heartbeatMs)
    beat.unref()
    return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(cfg.port, cfg.bind, () => {
            const port = server.address().port
            log(`${cfg.name} (${cfg.mode}) listening on ${cfg.bind}:${port} ${tls ? 'wss (TLS)' : 'ws (plain)'}; kinds: ${(cfg.kinds ?? specs.offloadKinds).join(',')}`)
            resolve({ server, port, cfg, peers, runner, status, stop: () => { clearInterval(beat); runner.stopAll(); for (const p of peers) p.close(); server.close() } })
        })
    })
}
