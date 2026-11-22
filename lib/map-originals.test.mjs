import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { clearIndexes, findOriginal, originalGlb } from './map-originals.mjs'
import { validateConfig } from './assets-sources.mjs'
import { readModel } from './glb.mjs'

function roots() {
    const d = mkdtempSync(path.join(os.tmpdir(), 'orig-'))
    mkdirSync(path.join(d, 'raw/deep'), { recursive: true })
    writeFileSync(path.join(d, 'raw/deep/m.bsp'), 'BSP')
    writeFileSync(path.join(d, 'raw/other.ZIP'), 'zip')
    return d
}
// stands in for the converter: writes a one-quad dot-bsp-mesh pair at the {out} prefix
const fake = (_cmd, argv) => {
    const out = argv[argv.indexOf('--out') + 1]
    const pos = new Float32Array([0, 0, 0, 10, 0, 0, 10, 0, 10, 0, 0, 10]), nor = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]), uv = new Float32Array(8)
    writeFileSync(out + '.bin', Buffer.concat([pos, nor, uv, new Uint32Array([0, 1, 2, 0, 2, 3])].map((a) => Buffer.from(a.buffer))))
    writeFileSync(out + '.json', JSON.stringify({ format: 'dot-bsp-mesh', surfaces: [{ material: 'a/b', vertex_count: 4, position_offset: 0, normal_offset: 48, uv_offset: 96, index_offset: 128, index_count: 6 }] }))
}

test('findOriginal searches the configured roots by template, case-insensitively, nothing without config', () => {
    const d = roots(); clearIndexes()
    const cfg = { mapOriginalRoots: ['raw'] }
    assert.equal(findOriginal('m', cfg, d), path.join(d, 'raw/deep/m.bsp'))
    assert.equal(findOriginal('other', cfg, d), path.join(d, 'raw/other.ZIP'))
    assert.equal(findOriginal('nope', cfg, d), null)
    assert.equal(findOriginal('m', {}, d), null)
})
test('originalGlb converts through the configured command, caches, and reports converter failure', () => {
    const d = roots(); clearIndexes()
    const cfg = { mapOriginalRoots: ['raw'], mapOriginalConverter: ['conv', 'mesh', '{input}', '--out', '{out}'] }
    let runs = 0
    const r = originalGlb('m', cfg, { sourceRoot: d, cacheDir: path.join(d, 'cache'), run: (...a) => { runs++; return fake(...a) } })
    assert.ok(r.glb && r.stats.tris === 2)
    assert.ok(readModel(Buffer.from(r.glb).length ? writeTmp(d, r.glb) : '').json.meshes.length >= 1)
    originalGlb('m', cfg, { sourceRoot: d, cacheDir: path.join(d, 'cache'), run: () => { runs++ } })
    assert.equal(runs, 1)   // second call is served from the cache
    const bad = originalGlb('m', cfg, { sourceRoot: d, cacheDir: path.join(d, 'cache2'), run: () => { throw Object.assign(new Error('x'), { stderr: 'boom\nbad bsp' }) } })
    assert.match(bad.error, /bad bsp/)
    assert.equal(originalGlb('m', {}, { sourceRoot: d, cacheDir: d }), null)
})
test('config validation needs an {input} placeholder', () => {
    assert.throws(() => validateConfig({ mapOriginalConverter: ['conv'] }), /\{input\}/)
    validateConfig({ mapOriginalRoots: ['/x'], mapOriginalConverter: ['conv', '{input}', '{out}'] })
})
function writeTmp(d, buf) { const f = path.join(d, 'o.glb'); writeFileSync(f, buf); return f }
