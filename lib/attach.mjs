// Screenshot attachments on items: files plus an index.json per item under NIGHTLY_ATTACH
// (default data/attachments/<key>/), no schema change. The panel reads the same files.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
export const ATTACH_DIR = path.resolve(process.env.NIGHTLY_ATTACH || path.join(ROOT, 'data', 'attachments'))
export const MAX_WIDTH = 1280
export const MAX_BYTES = 2 * 1024 * 1024
export const KEEP = 20

const dirFor = (key) => path.join(ATTACH_DIR, key.replace(/[^\w.-]/g, '_'))
const baseUrl = () => (process.env.NIGHTLY_PUBLIC_URL || `http://${os.hostname()}:3010`).replace(/\/$/, '')

/** URL the panel serves an attachment at. */
export const urlFor = (key, file) => `${baseUrl()}/attachments/${encodeURIComponent(key)}/${encodeURIComponent(file)}`

export function list(key) {
    try { return JSON.parse(readFileSync(path.join(dirFor(key), 'index.json'), 'utf8')) } catch { return [] }
}

/** Downscale to MAX_WIDTH, re-encode until under MAX_BYTES, store, record, prune to the last KEEP. */
export function attach(key, src, { note = '', by = 'session' } = {}) {
    if (!existsSync(src)) throw new Error(`no such file: ${src}`)
    const ext = path.extname(src).toLowerCase()
    if (!['.png', '.jpg', '.jpeg'].includes(ext)) throw new Error('attach takes a .png or .jpg')
    const dir = dirFor(key)
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '')
    let file = `${stamp}-${path.basename(src, ext).replace(/[^\w.-]/g, '_').slice(0, 40)}${ext === '.png' ? '.png' : '.jpg'}`
    const dest = path.join(dir, file)
    const tmp = dest + '.tmp' + (ext === '.png' ? '.png' : '.jpg')
    const run = (args) => {
        const r = spawnSync('convert', args, { encoding: 'utf8' })
        if (r.status !== 0) throw new Error(`convert failed: ${(r.stderr || r.error?.message || '').trim()}`)
    }
    run([src, '-auto-orient', '-resize', `${MAX_WIDTH}x>`, '-strip', tmp])
    // Still too big (a busy PNG): fall back to JPEG at falling quality.
    if (statSync(tmp).size > MAX_BYTES) {
        rmSync(tmp)
        file = file.replace(/\.\w+$/, '.jpg')
        const jtmp = path.join(dir, file + '.tmp.jpg')
        for (const q of [88, 75, 60, 45]) {
            run([src, '-auto-orient', '-resize', `${MAX_WIDTH}x>`, '-strip', '-background', 'white', '-flatten', '-quality', String(q), jtmp])
            if (statSync(jtmp).size <= MAX_BYTES) break
        }
        if (statSync(jtmp).size > MAX_BYTES) { rmSync(jtmp); throw new Error('image still over 2 MB after compression') }
        renameSync(jtmp, path.join(dir, file))
    } else renameSync(tmp, path.join(dir, file))
    const idx = list(key)
    const entry = { file, note, by, at: new Date().toISOString(), bytes: statSync(path.join(dir, file)).size }
    idx.push(entry)
    while (idx.length > KEEP) rmSync(path.join(dir, idx.shift().file), { force: true })
    writeFileSync(path.join(dir, 'index.json'), JSON.stringify(idx, null, 2))
    return { ...entry, url: urlFor(key, file) }
}
