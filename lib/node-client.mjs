// The panel's side of the node link: one NodeConnection per registered node (connect, authenticate,
// reconnect with backoff, status), and a NodeManager holding them all. No database access here: the caller
// passes node descriptors ({ id, name, host, port, tls, token, conn:{fingerprint,ca,tlsVerify} }) and listens
// for 'status' / 'event' to persist what it needs.
import { EventEmitter } from 'node:events'
import { connect } from './node-ws.mjs'
import { Peer, clientHandshake } from './node-proto.mjs'

export class NodeConnection extends EventEmitter {
    constructor(desc, { clientName = 'nightly-panel', handlers = {}, minDelay = 2000, maxDelay = 60_000 } = {}) {
        super()
        this.desc = desc; this.clientName = clientName; this.handlers = handlers
        this.minDelay = minDelay; this.maxDelay = maxDelay; this.delay = minDelay
        this.state = 'offline'; this.error = ''; this.peer = null; this.ready = null; this.stopped = true; this.lastSeen = null; this.live = null
    }
    get url() { const d = this.desc; return `${d.tls ? 'wss' : 'ws'}://${d.host.includes(':') && !d.host.startsWith('[') ? `[${d.host}]` : d.host}:${d.port}/` }
    #set(state, error = '') { if (state === this.state && error === this.error) return; this.state = state; this.error = error; this.emit('status', this.snapshot()) }
    snapshot() { return { id: this.desc.id, name: this.desc.name, state: this.state, error: this.error, lastSeen: this.lastSeen, live: this.live, version: this.ready?.version ?? '' } }
    start() { if (!this.stopped) return; this.stopped = false; this.delay = this.minDelay; void this.#loop() }
    stop() { this.stopped = true; clearTimeout(this.retry); this.peer?.close(); this.peer = null; this.#set('offline') }
    /** Replace the descriptor (host, token...) and reconnect if the endpoint changed. */
    update(desc) {
        const d = this.desc, changed = ['host', 'port', 'tls', 'token'].some((k) => d[k] !== desc[k]) || JSON.stringify(d.conn) !== JSON.stringify(desc.conn)
        this.desc = desc
        if (changed && !this.stopped) { this.peer?.close(); clearTimeout(this.retry); this.delay = this.minDelay; void this.#loop() }
    }
    async #loop() {
        if (this.stopped) return
        if (this.peer?.open) return
        this.#set('connecting')
        try {
            const d = this.desc, c = d.conn ?? {}
            const conn = await connect(this.url, { ca: c.ca || undefined, rejectUnauthorized: c.tlsVerify !== false, fingerprint: c.fingerprint || undefined, timeoutMs: 8000 })
            conn.on('error', () => {})
            const ready = await clientHandshake(conn, { token: d.token, name: this.clientName })
            const peer = new Peer(conn, this.handlers)
            this.peer = peer; this.ready = ready; this.live = ready.status ?? null; this.lastSeen = new Date().toISOString(); this.delay = this.minDelay
            peer.on('event', (ev, data) => {
                this.lastSeen = new Date().toISOString()
                if (ev === 'heartbeat' || ev === 'status') this.live = data
                this.emit('event', ev, data, this.desc)
            })
            peer.on('close', () => { if (this.peer === peer) { this.peer = null; this.live = null; this.#set('offline', 'connection lost'); this.#schedule() } })
            this.#set('online')
            this.emit('event', 'ready', ready, this.desc)
        } catch (e) {
            const denied = /denied|bad token/i.test(e.message)
            this.#set(denied ? 'denied' : 'offline', e.message)
            this.#schedule(denied ? this.maxDelay : undefined)
        }
    }
    #schedule(ms) {
        if (this.stopped) return
        const wait = ms ?? this.delay
        this.delay = Math.min(this.delay * 2, this.maxDelay)
        clearTimeout(this.retry)
        this.retry = setTimeout(() => void this.#loop(), wait)
        this.retry.unref?.()
    }
    request(op, args, ms) {
        if (!this.peer?.open) return Promise.reject(Object.assign(new Error(`node ${this.desc.name} is ${this.state}${this.error ? `: ${this.error}` : ''}`), { code: 'offline' }))
        return this.peer.request(op, args, ms)
    }
}

export class NodeManager extends EventEmitter {
    constructor(opts = {}) { super(); this.opts = opts; this.conns = new Map() }
    /** Make the set of connections match `descs` (add, update, drop). */
    sync(descs) {
        const ids = new Set(descs.map((d) => d.id))
        for (const [id, c] of this.conns) if (!ids.has(id)) { c.stop(); this.conns.delete(id) }
        for (const d of descs) {
            let c = this.conns.get(d.id)
            if (c) { c.update(d); continue }
            c = new NodeConnection(d, this.opts)
            c.on('status', (s) => this.emit('status', s))
            c.on('event', (ev, data, desc) => this.emit('event', ev, data, desc))
            this.conns.set(d.id, c)
            if (d.enabled !== false) c.start()
        }
    }
    get(id) { return this.conns.get(id) }
    statuses() { return [...this.conns.values()].map((c) => c.snapshot()) }
    request(id, op, args, ms) {
        const c = this.conns.get(id)
        return c ? c.request(op, args, ms) : Promise.reject(new Error(`node ${id} is not registered`))
    }
    stopAll() { for (const c of this.conns.values()) c.stop(); this.conns.clear() }
}
