// The panel <-> node protocol on top of lib/node-ws.mjs: a token challenge-response handshake (the token
// never crosses the wire, so plain ws:// is no worse than a shared secret), then a symmetric Peer: either
// side sends requests ({t:'req'}) and gets responses ({t:'res'}), and pushes events ({t:'evt'}).
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'

export const PROTOCOL = 1
export const DEFAULT_PORT = 4001

export const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex')
export const newToken = () => randomBytes(24).toString('base64url')
export const mac = (token, serverNonce, clientNonce) => createHmac('sha256', token).update(`${serverNonce}.${clientNonce}`).digest('hex')
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y) }

const nextMessage = (conn, ms) => new Promise((resolve, reject) => {
    const done = (fn, v) => { clearTimeout(t); conn.off('message', onMsg); conn.off('close', onClose); fn(v) }
    const onMsg = (m) => { try { done(resolve, JSON.parse(m)) } catch { done(reject, new Error('bad handshake message')) } }
    const onClose = () => done(reject, new Error('closed during handshake'))
    const t = setTimeout(() => done(reject, new Error('handshake timeout')), ms)
    conn.on('message', onMsg); conn.on('close', onClose)
})

/** Node side. tokens: accepted tokens (strings). Resolves { peerName, tokenIndex } or rejects (connection already closed). */
export async function serverHandshake(conn, { tokens, name, info = {}, ms = 8000 }) {
    const nonce = randomBytes(16).toString('hex')
    conn.send(JSON.stringify({ t: 'hello', proto: PROTOCOL, nonce, name }))
    let a
    try { a = await nextMessage(conn, ms) } catch (e) { conn.close(1002); throw e }
    const idx = a?.t === 'auth' && typeof a.cnonce === 'string' && typeof a.mac === 'string' ? tokens.findIndex((t) => t && same(mac(t, nonce, a.cnonce), a.mac)) : -1
    if (idx < 0) {
        await new Promise((r) => setTimeout(r, 400)) // slow guessing down
        try { conn.send(JSON.stringify({ t: 'denied', reason: 'bad token' })) } catch { /* gone */ }
        conn.close(1008)
        throw new Error('bad token')
    }
    conn.send(JSON.stringify({ t: 'ready', proto: PROTOCOL, ...info }))
    return { peerName: String(a.name ?? '').slice(0, 64), tokenIndex: idx }
}

/** Panel side. Resolves the node's `ready` message ({ name, proto, ...info }). */
export async function clientHandshake(conn, { token, name, ms = 8000 }) {
    const h = await nextMessage(conn, ms)
    if (h?.t !== 'hello') { conn.close(1002); throw new Error('not a nightly node') }
    const cnonce = randomBytes(16).toString('hex')
    const waitReady = nextMessage(conn, ms)
    conn.send(JSON.stringify({ t: 'auth', cnonce, mac: mac(token, h.nonce, cnonce), name }))
    const r = await waitReady
    if (r?.t === 'denied') { conn.close(1000); throw new Error(`denied: ${r.reason}`) }
    if (r?.t !== 'ready') { conn.close(1002); throw new Error('bad handshake') }
    return { nodeName: h.name, ...r }
}

/** A symmetric request/response/event endpoint on an authenticated Conn. handlers: { op: async (args, peer) => data }. */
export class Peer extends EventEmitter {
    constructor(conn, handlers = {}) {
        super()
        this.conn = conn; this.handlers = handlers; this.pending = new Map(); this.seq = 0
        conn.on('message', (m) => this.#onMessage(m))
        conn.on('close', () => {
            for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('connection closed')) }
            this.pending.clear(); this.emit('close')
        })
    }
    get open() { return this.conn.open }
    request(op, args = {}, ms = 30_000) {
        return new Promise((resolve, reject) => {
            if (!this.conn.open) return reject(new Error('connection closed'))
            const id = ++this.seq
            const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${op}: timed out`)) }, ms)
            this.pending.set(id, { resolve, reject, timer })
            this.conn.send(JSON.stringify({ t: 'req', id, op, args }))
        })
    }
    notify(ev, data = {}) { if (this.conn.open) this.conn.send(JSON.stringify({ t: 'evt', ev, data })) }
    close() { this.conn.close() }
    async #onMessage(raw) {
        let m
        try { m = JSON.parse(raw) } catch { return }
        if (m.t === 'evt') return void this.emit('event', m.ev, m.data)
        if (m.t === 'res') {
            const p = this.pending.get(m.id)
            if (!p) return
            this.pending.delete(m.id); clearTimeout(p.timer)
            return m.ok ? p.resolve(m.data) : p.reject(Object.assign(new Error(m.error || 'failed'), { code: m.code }))
        }
        if (m.t !== 'req') return
        const h = this.handlers[m.op]
        let out
        try {
            if (!h) throw Object.assign(new Error(`unknown op ${m.op}`), { code: 'unknown-op' })
            out = { t: 'res', id: m.id, ok: true, data: await h(m.args ?? {}, this) }
        } catch (e) { out = { t: 'res', id: m.id, ok: false, error: e?.message ?? String(e), code: e?.code } }
        if (this.conn.open) this.conn.send(JSON.stringify(out))
    }
}
