// A small RFC 6455 WebSocket (text frames, ping/pong, close, fragmentation) over node:http(s), so the
// node daemon and the panel need no npm dependency. Server side: `accept(req, socket, head)` from an
// http(s) server's 'upgrade' event. Client side: `connect(url, opts)`. Both give a `Conn`.
import { EventEmitter } from 'node:events'
import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
export const MAX_PAYLOAD = 16 * 1024 * 1024

/** Encode one frame. masked = true for client -> server. */
export function encodeFrame(opcode, payload, masked) {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? '')
    const n = body.length
    const head = n < 126 ? Buffer.alloc(2) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10)
    head[0] = 0x80 | opcode
    const mbit = masked ? 0x80 : 0
    if (n < 126) head[1] = mbit | n
    else if (n < 65536) { head[1] = mbit | 126; head.writeUInt16BE(n, 2) } else { head[1] = mbit | 127; head.writeBigUInt64BE(BigInt(n), 2) }
    if (!masked) return Buffer.concat([head, body])
    const key = randomBytes(4)
    const out = Buffer.from(body)
    for (let i = 0; i < n; i++) out[i] ^= key[i & 3]
    return Buffer.concat([head, key, out])
}

/** Incremental frame parser: feed(chunk) returns the complete frames { fin, opcode, payload }. Throws on a protocol error. */
export class FrameParser {
    constructor(maxPayload = MAX_PAYLOAD) { this.buf = Buffer.alloc(0); this.max = maxPayload }
    feed(chunk) {
        this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
        const frames = []
        for (;;) {
            const b = this.buf
            if (b.length < 2) break
            const fin = !!(b[0] & 0x80), opcode = b[0] & 0x0f, masked = !!(b[1] & 0x80)
            let len = b[1] & 0x7f, off = 2
            if (len === 126) { if (b.length < 4) break; len = b.readUInt16BE(2); off = 4 } else if (len === 127) {
                if (b.length < 10) break
                const big = b.readBigUInt64BE(2)
                if (big > BigInt(this.max)) throw new Error('frame too large')
                len = Number(big); off = 10
            }
            if (len > this.max) throw new Error('frame too large')
            if (b.length < off + (masked ? 4 : 0) + len) break
            let payload
            if (masked) {
                const key = b.subarray(off, off + 4)
                payload = Buffer.from(b.subarray(off + 4, off + 4 + len))
                for (let i = 0; i < len; i++) payload[i] ^= key[i & 3]
                off += 4
            } else payload = Buffer.from(b.subarray(off, off + len))
            this.buf = b.subarray(off + len)
            frames.push({ fin, opcode, payload })
        }
        return frames
    }
}

/** One open WebSocket. Events: 'message' (string), 'close' (code), 'error'. */
export class Conn extends EventEmitter {
    constructor(socket, { client = false, pingMs = 0 } = {}) {
        super()
        this.socket = socket; this.client = client; this.open = true
        this.parser = new FrameParser(); this.frag = null; this.alive = true
        socket.on('data', (d) => {
            try { for (const f of this.parser.feed(d)) this.#frame(f) } catch (e) { this.#fail(1009, e.message) }
        })
        socket.on('close', () => this.#closed(1006))
        socket.on('error', (e) => { if (this.listenerCount('error')) this.emit('error', e) })
        socket.setNoDelay?.(true)
        if (pingMs > 0) {
            this.timer = setInterval(() => {
                if (!this.alive) return this.#fail(1001, 'ping timeout')
                this.alive = false
                this.#write(encodeFrame(0x9, '', this.client))
            }, pingMs)
            this.timer.unref?.()
        }
    }
    #write(buf) { if (this.open && !this.socket.destroyed) this.socket.write(buf) }
    #frame(f) {
        this.alive = true
        if (f.opcode === 0x8) { const code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005; this.#write(encodeFrame(0x8, f.payload, this.client)); this.#closed(code); this.socket.end(); return }
        if (f.opcode === 0x9) return this.#write(encodeFrame(0xa, f.payload, this.client))
        if (f.opcode === 0xa) return
        if (f.opcode === 0x0) {
            if (!this.frag) throw new Error('unexpected continuation')
            this.frag.push(f.payload)
            if (f.fin) { const all = Buffer.concat(this.frag); this.frag = null; this.emit('message', all.toString('utf8')) }
            return
        }
        if (f.opcode !== 0x1 && f.opcode !== 0x2) throw new Error(`bad opcode ${f.opcode}`)
        if (f.fin) this.emit('message', f.payload.toString('utf8'))
        else this.frag = [f.payload]
    }
    #fail(code, why) { try { this.#write(encodeFrame(0x8, Buffer.concat([Buffer.from([code >> 8, code & 255]), Buffer.from(String(why).slice(0, 100))]), this.client)) } catch { /* closing anyway */ } this.#closed(code); this.socket.destroy() }
    #closed(code) {
        if (!this.open) return
        this.open = false; clearInterval(this.timer)
        this.emit('close', code)
    }
    send(text) { if (!this.open) throw new Error('connection closed'); this.#write(encodeFrame(0x1, text, this.client)) }
    close(code = 1000) { if (!this.open) return; this.#write(encodeFrame(0x8, Buffer.from([code >> 8, code & 255]), this.client)); this.#closed(code); this.socket.end(); setTimeout(() => this.socket.destroy(), 500).unref() }
}

/** Server side of the handshake. Returns a Conn, or null after answering 400. */
export function accept(req, socket, head, opts = {}) {
    const key = req.headers['sec-websocket-key']
    if (String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket' || !key) { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return null }
    const acceptKey = createHash('sha1').update(key + GUID).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey}\r\n\r\n`)
    const c = new Conn(socket, { pingMs: opts.pingMs ?? 25_000 })
    if (head?.length) setImmediate(() => socket.emit('data', head))
    return c
}

/** Client side: connect to ws:// or wss://. opts: { ca, rejectUnauthorized, fingerprint (pinned sha256 of the server cert), timeoutMs, pingMs, headers }. Resolves a Conn. */
export function connect(url, opts = {}) {
    const u = new URL(url)
    const tls = u.protocol === 'wss:'
    if (!tls && u.protocol !== 'ws:') return Promise.reject(new Error(`not a ws:// or wss:// url: ${url}`))
    return new Promise((resolve, reject) => {
        const key = randomBytes(16).toString('base64')
        const mod = tls ? https : http
        const req = mod.request({
            host: u.hostname, port: u.port || (tls ? 443 : 80), path: u.pathname + u.search, method: 'GET', timeout: opts.timeoutMs ?? 10_000,
            headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13', ...opts.headers },
            ...(tls ? { ca: opts.ca, rejectUnauthorized: opts.fingerprint ? false : opts.rejectUnauthorized !== false, servername: opts.servername || (/^[\d.]+$|:/.test(u.hostname) ? undefined : u.hostname) } : {}),
            agent: false,
        })
        req.on('timeout', () => req.destroy(new Error('connect timeout')))
        req.on('error', reject)
        req.on('response', (res) => { res.resume(); reject(new Error(`upgrade refused: HTTP ${res.statusCode}`)) })
        req.on('upgrade', (res, socket, head) => {
            const want = createHash('sha1').update(key + GUID).digest('base64')
            if (res.headers['sec-websocket-accept'] !== want) { socket.destroy(); return reject(new Error('bad Sec-WebSocket-Accept')) }
            req.setTimeout(0); socket.setTimeout(0)
            if (tls && opts.fingerprint) {
                const norm = (f) => String(f).replace(/[^0-9a-f]/gi, '').toLowerCase()
                if (norm(socket.getPeerCertificate?.()?.fingerprint256 ?? '') !== norm(opts.fingerprint)) { socket.destroy(); return reject(new Error('TLS certificate fingerprint does not match the pinned one')) }
            }
            const c = new Conn(socket, { client: true, pingMs: opts.pingMs ?? 25_000 })
            if (head?.length) setImmediate(() => socket.emit('data', head))
            resolve(c)
        })
        req.end()
    })
}
