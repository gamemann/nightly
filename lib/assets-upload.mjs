// ASSET UPLOADS: store an uploaded file under data/uploads/<pack>/, register that folder as an asset source, convert what the scan
// cannot read (Blender for non-glTF models, the map registry for maps) and scan. Used by `nightly assets upload`, `nightly maps upload`
// and the panel (which shells out to the CLI). Validation and limits live in assets-upload-core.mjs.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as SRC from './assets-sources.mjs'
import * as AS from './assets.mjs'
import * as S from './store.mjs'
import { UPLOAD_TYPES, validateUpload, safeName, extOf, isMapManifest } from './assets-upload-core.mjs'
import { registerBuiltins, detectFormat, converterDir } from './map-convert.mjs'
import { planFor } from './map-convert-formats.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const UPLOAD_ROOT = () => process.env.NIGHTLY_UPLOAD_DIR || path.join(HERE, '..', 'data', 'uploads')
export const UPLOAD_PACK = 'uploads'

/** Upload limits and tool paths from the Setting table. */
export function uploadSettings(db) {
    const o = {}
    for (const r of db.prepare("SELECT key, value FROM Setting WHERE key LIKE 'uploadMaxMb%' OR key = 'mapConverterPath' OR key = 'mapCompiler'").all()) o[r.key] = r.value
    return o
}

export function ensureUploadTable(db) {
    db.exec('CREATE TABLE IF NOT EXISTS AssetUpload (id INTEGER PRIMARY KEY AUTOINCREMENT, pack TEXT NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL, bytes INTEGER NOT NULL, note TEXT NOT NULL DEFAULT \'\', project TEXT NOT NULL DEFAULT \'\', uploadedBy TEXT NOT NULL DEFAULT \'\', uploadedAt TEXT NOT NULL)')
}

function ensureSource(db, pack) {
    AS.ready(db)
    const root = path.join(UPLOAD_ROOT(), pack)
    mkdirSync(root, { recursive: true })
    const cfg = { models: ['models/**/*.glb', 'models/**/*.gltf'], textures: ['textures/**/*.png', 'textures/**/*.jpg', 'textures/**/*.jpeg', 'textures/**/*.webp'], sounds: ['sounds/**/*.ogg', 'sounds/**/*.wav', 'sounds/**/*.mp3'], maps: ['worlds/*/*.json'] }
    try { SRC.get(db, pack); SRC.set(db, pack, { root, config: cfg }) } catch { SRC.add(db, { name: pack, type: 'pack', root, config: cfg }) }
    return root
}

const BLENDER_IMPORT = `import bpy, sys
src, dst = sys.argv[sys.argv.index('--') + 1:][:2]
bpy.ops.wm.read_factory_settings(use_empty=True)
e = src.rsplit('.', 1)[-1].lower()
if e == 'obj': bpy.ops.wm.obj_import(filepath=src)
elif e == 'fbx': bpy.ops.import_scene.fbx(filepath=src)
elif e == 'dae': bpy.ops.wm.collada_import(filepath=src)
elif e == 'stl': bpy.ops.wm.stl_import(filepath=src)
elif e == 'ply': bpy.ops.wm.ply_import(filepath=src)
elif e == 'blend': bpy.ops.wm.open_mainfile(filepath=src)
else: raise SystemExit('unsupported ' + e)
bpy.ops.export_scene.gltf(filepath=dst, export_format='GLB')
`

function blenderToGlb(src, dst) {
    if (!spawnSync('sh', ['-c', 'command -v blender']).stdout.length) throw new Error('blender is not installed: upload a .glb instead, or install blender to convert this format')
    const d = mkdtempSync(path.join(os.tmpdir(), 'up-bl-'))
    try {
        const py = path.join(d, 'imp.py'); writeFileSync(py, BLENDER_IMPORT)
        const r = spawnSync('blender', ['-b', '--factory-startup', '-P', py, '--', src, dst], { encoding: 'utf8', timeout: 600000 })
        if (r.status !== 0 || !existsSync(dst)) throw new Error(`blender could not convert it: ${(r.stderr || r.stdout).trim().split('\n').slice(-2).join(' | ')}`)
    } finally { rmSync(d, { recursive: true, force: true }) }
}

/** Stores one file. opts: { file, name?, type?, pack?, note?, project?, by?, bin? (a .bin companion for a gs-map manifest), settings?, log? }.
 *  Returns { id, type, name, pack, stored: [paths], warnings }. Throws a plain Error on a rejected upload. */
export async function uploadAsset(db, o) {
    const log = o.log ?? (() => {})
    const settings = o.settings ?? uploadSettings(db)
    const file = path.resolve(o.file)
    if (!existsSync(file)) throw new Error(`no such file: ${o.file}`)
    const name0 = o.name || path.basename(file)
    const st = statSync(file)
    const whole = extOf(name0) === 'json' ? readFileSync(file) : null
    const head = whole ?? readFileSync(file).subarray(0, 8192)
    const v = validateUpload({ name: name0, bytes: st.size, buf: head, hint: o.type, settings })
    const pack = o.pack || UPLOAD_PACK
    if (!/^[A-Za-z0-9][\w.-]*$/.test(pack)) throw new Error('pack: letters, digits, . _ -')
    ensureUploadTable(db)
    const root = ensureSource(db, pack)
    const stem = v.name.replace(/\.[^.]+$/, '')
    const stored = [], warnings = []
    const put = (rel, from) => { const to = path.join(root, rel); mkdirSync(path.dirname(to), { recursive: true }); copyFileSync(from, to); stored.push(to); return to }
    const cls = UPLOAD_TYPES[v.type]
    if (v.type === 'model' && !cls.native.includes(v.ext)) {
        const tmp = path.join(os.tmpdir(), `up-${process.pid}-${stem}.glb`)
        log(`converting ${v.ext} to glb with Blender`)
        try { blenderToGlb(file, tmp); put(`models/${stem}.glb`, tmp) } finally { rmSync(tmp, { force: true }) }
        warnings.push(`converted from ${v.ext} with Blender`)
    } else if (v.type === 'map') {
        registerBuiltins(settings)
        const from = detectFormat(v.name, head)
        if (!from) throw new Error('not a recognised map format (bsp, vmf, quake .map, GameSpice map json, glb, obj)')
        if (from === 'gs-map') {
            if (!isMapManifest(JSON.parse(readFileSync(file, 'utf8')))) throw new Error('that json is not a GameSpice map manifest')
            put(`worlds/${stem}/${stem}.json`, file)
            if (o.bin) put(`worlds/${stem}/${path.basename(JSON.parse(readFileSync(file, 'utf8')).bin?.file ?? `${stem}.bin`)}`, path.resolve(o.bin))
        } else {
            const plan = planFor(from, 'gs-map')
            if (!plan) throw new Error(`no converter from ${from} to a GameSpice map is available here${from === 'bsp' && !converterDir(settings) ? ' (set mapConverterPath or $GS_MAP_CONVERT_PATH)' : ''}`)
            const tmp = mkdtempSync(path.join(os.tmpdir(), 'up-map-'))
            try {
                let input = file, last = { files: [] }
                for (let i = 0; i < plan.length; i++) {
                    const outDir = i === plan.length - 1 ? tmp : path.join(tmp, `step${i}`); mkdirSync(outDir, { recursive: true })
                    last = await plan[i].run({ input, outDir, name: safeName(stem).replace(/\.[^.]+$/, ''), log, progress() {}, opts: {} })
                    for (const w of last.warnings ?? []) warnings.push(w)
                    input = last.files.find((f) => f.path.endsWith('.json') || (plan[i + 1] && f.path.toLowerCase().endsWith(`.${plan[i + 1].from === 'gs-map' ? 'json' : plan[i + 1].from}`)))?.path ?? last.files[0]?.path
                }
                const dir = path.join(root, 'worlds', stem); mkdirSync(dir, { recursive: true })
                for (const f of readdirSync(tmp)) { const p = path.join(tmp, f); if (statSync(p).isFile()) { copyFileSync(p, path.join(dir, f)); stored.push(path.join(dir, f)) } }
                if (existsSync(path.join(tmp, 'textures'))) { const { cpSync } = await import('node:fs'); cpSync(path.join(tmp, 'textures'), path.join(dir, 'textures'), { recursive: true }) }
            } finally { rmSync(tmp, { recursive: true, force: true }) }
        }
    } else {
        put(`${cls.dir}/${v.name}`, file)
    }
    const info = db.prepare('INSERT INTO AssetUpload (pack, type, name, path, bytes, note, project, uploadedBy, uploadedAt) VALUES (?,?,?,?,?,?,?,?,?)').run(pack, v.type, v.name, path.relative(root, stored[0] ?? ''), st.size, o.note ?? '', o.project ?? '', o.by ?? '', new Date().toISOString())
    if (v.type !== 'other' && !o.noScan) { log('scanning'); AS.scanInto(db, { only: [pack] }) }
    return { id: Number(info.lastInsertRowid), type: v.type, name: v.name, pack, stored, warnings, bytes: st.size }
}

export function uploadList(db, { pack, type, limit = 100 } = {}) {
    ensureUploadTable(db)
    const w = [], a = []
    if (pack) { w.push('pack = ?'); a.push(pack) }
    if (type) { w.push('type = ?'); a.push(type) }
    return db.prepare(`SELECT * FROM AssetUpload ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY id DESC LIMIT ${Number(limit) || 100}`).all(...a)
}
