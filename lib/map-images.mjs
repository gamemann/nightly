// Image pipeline of the map converter: every texture the GLB embeds goes through one batch (sharp, in a child process) that
// downsizes it to `max` pixels on the long side and re-encodes it, with a disk cache keyed by file + size + format. A memory
// budget (estimated GPU megabytes of all distinct images, with mip maps) halves `max` until the set fits.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'map-tex-worker.mjs')
const FORMATS = { webp: 'image/webp', jpg: 'image/jpeg', png: 'image/png' }
const sha = (s) => createHash('sha1').update(s).digest('hex').slice(0, 20)
const gpuMb = (w, h) => (w * h * 4 * 1.34) / 1048576

export class ImageSet {
    /** opts: { cacheDir, max (px, default 1024), format (webp|jpg|png), quality, budgetMb (0 = unlimited) } */
    constructor(opts = {}) {
        this.cacheDir = opts.cacheDir || path.join(os.tmpdir(), 'nightly-map-tex')
        this.max = Math.max(16, Number(opts.max) || 1024)
        this.format = FORMATS[opts.format] ? opts.format : 'webp'
        this.quality = opts.quality ?? 80
        this.budgetMb = Number(opts.budgetMb) >= 0 ? Number(opts.budgetMb) : 256
        this.inputs = new Map()   // id -> { file, tag }
        this.out = new Map()      // id -> { bytes, mime, w, h } | null
        this.error = ''
        mkdirSync(this.cacheDir, { recursive: true })
    }
    /** Register an image file; returns its id (null when the file is missing). */
    want(file) {
        if (!file || !existsSync(file)) return null
        const st = statSync(file), id = sha(`${file}|${st.mtimeMs}|${st.size}`)
        this.inputs.set(id, { file }); return id
    }
    /** Register image bytes (an embedded glTF image); returns its id. */
    wantBytes(bytes) {
        const id = sha(bytes.subarray(0, 1 << 20).toString('latin1') + bytes.length)
        if (!this.inputs.has(id)) {
            const file = path.join(this.cacheDir, `src-${id}.bin`)
            if (!existsSync(file)) writeFileSync(file, bytes)
            this.inputs.set(id, { file })
        }
        return id
    }
    #run(max) {
        const jobs = [], res = new Map()
        const tag = (id) => path.join(this.cacheDir, `${id}-${max}-${this.quality}.${this.format}`)
        for (const [id, { file }] of this.inputs) {
            const out = tag(id), meta = `${out}.json`
            if (existsSync(out) && existsSync(meta)) { try { res.set(id, { out, ...JSON.parse(readFileSync(meta, 'utf8')) }); continue } catch { /* redo */ } }
            jobs.push({ id, in: file, out, max, format: this.format, quality: this.quality })
        }
        if (jobs.length) {
            const jf = path.join(this.cacheDir, `jobs-${process.pid}-${Date.now()}.json`)
            writeFileSync(jf, JSON.stringify(jobs))
            const r = spawnSync(process.execPath, ['--no-warnings', WORKER, jf], { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 20 * 60_000 })
            let o = { results: [] }
            try { o = JSON.parse(r.stdout) } catch { this.error = (r.stderr || 'image worker failed').slice(0, 200) }
            if (o.error) this.error = o.error
            o.results.forEach((x, i) => { if (!x || x.error) { if (x?.error) this.error = this.error || x.error; return } writeFileSync(`${x.out}.json`, JSON.stringify({ w: x.w, h: x.h })); res.set(jobs[i].id, { out: x.out, w: x.w, h: x.h }) })
        }
        return res
    }
    /** Convert everything registered. Afterwards out.get(id) = { bytes, mime, w, h } or undefined (failed). */
    process() {
        let max = this.max, res = this.#run(max)
        const mb = () => [...res.values()].reduce((a, r) => a + gpuMb(r.w, r.h), 0)
        while (this.budgetMb > 0 && mb() > this.budgetMb && max > 64) { max = Math.floor(max / 2); res = this.#run(max) }
        this.usedMax = max; this.gpuMb = +mb().toFixed(1)
        for (const [id, r] of res) this.out.set(id, { bytes: readFileSync(r.out), mime: FORMATS[this.format], w: r.w, h: r.h })
        // sharp missing: an already small png/jpg is embedded as is, anything else stays unmapped
        if (!res.size && this.inputs.size && this.error) for (const [id, { file }] of this.inputs) if (/\.(png|jpe?g)$/i.test(file) && statSync(file).size < (4 << 20)) this.out.set(id, { bytes: readFileSync(file), mime: /\.png$/i.test(file) ? 'image/png' : 'image/jpeg', w: 0, h: 0 })
        return this
    }
}
