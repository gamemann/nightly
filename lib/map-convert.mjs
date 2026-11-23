// MAP CONVERTER: the built-in converters (registered in lib/map-convert-formats.mjs), the job store and the job runner.
// A job is one conversion: input file -> a chain of converters -> output files under <dataDir>/<id>/out, with a log, progress and a
// mapping report (which textures resolved to a free replacement and which did not). Jobs live in the table map_convert_job (created
// here, read by the panel with raw SQL). The CLI is `nightly map-convert`; the panel starts a detached `nightly map-convert --run-job <id>`.
//
// Geometry converters are pure (lib/map-brush.mjs). BSP reading is the family's bsp.py (gs-map-convert): its checkout is found from the
// setting mapConverterPath, $GS_MAP_CONVERT_PATH or $GSBSP_PATH; nothing is bundled. Compiling a map to BSP needs a compiler this
// machine may not have: the setting mapCompiler (argv template, {input} {outDir} {name}) enables it; without one the GS map -> BSP
// route stops at the .vmf and says so.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, copyFileSync } from 'node:fs'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { registry, register, detectFormat, FORMATS } from './map-convert-formats.mjs'
import { parseVmf, parseQuakeMap, brushesToMesh, parseObj, parseGlb, sceneToMesh, meshBrushes, boxBrushes, brushesToVmf, brushesToQuakeMap, SOURCE_K, QUAKE_K } from './map-brush.mjs'
import { mapToGlb } from './map-glb.mjs'
import { boxesMesh } from './map-defs.mjs'

export { registry, register, detectFormat, FORMATS }
const HERE = path.dirname(fileURLToPath(import.meta.url))
export const JOBS_DIR = () => process.env.NIGHTLY_MAPCONVERT_DIR || path.join(HERE, '..', 'data', 'map-convert')

// ---------------------------------------------------------------------------------------------------------------- tools

const which = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).stdout.trim()
/** Directory of the bsp.py converter checkout, or ''. `settings` is { mapConverterPath }. */
export function converterDir(settings = {}) {
    const cands = [settings.mapConverterPath, process.env.GS_MAP_CONVERT_PATH, process.env.GSBSP_PATH].filter(Boolean)
    for (const d of cands) if (existsSync(path.join(d, 'bsp.py'))) return d
    return ''
}
const needBsp = (settings) => () => (converterDir(settings) ? '' : 'the BSP reader (gs-map-convert) is not configured: set mapConverterPath or $GS_MAP_CONVERT_PATH')
const needBlender = () => (which('blender') ? '' : 'blender is not installed')

/** Runs a command, streaming its output lines to `log`. Rejects with the tail of stderr on a non-zero exit. */
function run(cmd, args, { log, timeoutMs = 600000, cwd } = {}) {
    return new Promise((resolve, reject) => {
        const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
        let tail = ''
        const feed = (d) => { const t = d.toString(); tail = (tail + t).slice(-2000); for (const l of t.split(/\r?\n/)) if (l.trim()) log?.(l.slice(0, 400)) }
        p.stdout.on('data', feed); p.stderr.on('data', feed)
        const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`${path.basename(cmd)} timed out after ${Math.round(timeoutMs / 1000)} s`)) }, timeoutMs)
        p.on('error', (e) => { clearTimeout(timer); reject(e.code === 'ENOENT' ? new Error(`${cmd} was not found`) : e) })
        p.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} exited ${code}: ${tail.trim().split('\n').slice(-3).join(' | ')}`)) })
    })
}
const sizeOf = (f) => statSync(f).size
const outFile = (ctx, ext, label) => ({ path: path.join(ctx.outDir, ctx.name + ext), label: label ?? ext })

/** Writes a gs-map pair (<name>.json + <name>.bin) from a { json, blob } mesh. Returns the file list. */
function writeMesh(ctx, m) {
    const bin = `${ctx.name}.bin`
    m.json.bin = { file: bin, bytes: m.blob.length }
    writeFileSync(path.join(ctx.outDir, bin), m.blob)
    writeFileSync(path.join(ctx.outDir, `${ctx.name}.json`), JSON.stringify(m.json))
    return [{ path: path.join(ctx.outDir, `${ctx.name}.json`), label: 'GameSpice map manifest' }, { path: path.join(ctx.outDir, bin), label: 'GameSpice map geometry' }]
}
/** The gs-map pair of an input manifest as { json, blob }: a mesh manifest + its .bin, or a boxes definition. */
export function readGsMap(file) {
    const j = JSON.parse(readFileSync(file, 'utf8'))
    if (Array.isArray(j.surfaces) && /bsp-mesh$/.test(String(j.format))) {
        const bin = path.join(path.dirname(file), j.bin?.file ?? path.basename(file).replace(/\.json$/i, '.bin'))
        if (!existsSync(bin)) throw new Error(`geometry file ${path.basename(bin)} is missing beside the manifest`)
        let blob = readFileSync(bin)
        if (blob[0] === 0x1f && blob[1] === 0x8b) blob = gunzipSync(blob)
        return { json: j, blob }
    }
    const bm = boxesMesh(j)
    if (bm) return { ...bm, boxes: j.boxes }
    throw new Error('not a GameSpice map: no mesh surfaces and no boxes')
}

// ---------------------------------------------------------------------------------------------------------------- converters

export function registerBuiltins(settings = {}) {
    const S = () => settings
    const add = (c) => { if (!registry.get(c.id)) register(c) }

    add({ id: 'bsp-gsmap', from: 'bsp', to: 'gs-map', label: 'BSP to GameSpice map (bsp.py)', available: () => needBsp(S())(),
        note: 'Reads the compiled map; with opts.full (default) also resolves textures and models to the free replacement tables and writes the credits.',
        async run(ctx) {
            const dir = converterDir(S())
            const prefix = path.join(ctx.outDir, ctx.name)
            const full = ctx.opts.full !== false
            ctx.progress(0.1); ctx.log(`bsp.py ${full ? 'import' : 'mesh'} ${path.basename(ctx.input)}`)
            const args = full
                ? ['-P', path.join(dir, 'bsp.py'), 'import', ctx.input, '--game', String(ctx.opts.game ?? 'zz'), '--raw-root', path.join(ctx.outDir, 'raw'), '--out', prefix, '--allow-unknown']
                : ['-P', path.join(dir, 'bsp.py'), 'mesh', ctx.input, '--out', prefix, '--allow-unknown']
            if (full) mkdirSync(path.join(ctx.outDir, 'raw'), { recursive: true })
            await run('python3', args, { log: ctx.log, timeoutMs: (Number(ctx.opts.timeoutSec) || 600) * 1000 })
            ctx.progress(0.9)
            const files = []
            for (const e of readdirSync(ctx.outDir, { withFileTypes: true })) {
                if (e.isFile() && /\.(json|bin|md)$/i.test(e.name)) files.push({ path: path.join(ctx.outDir, e.name), label: e.name.endsWith('.bin') ? 'GameSpice map geometry' : e.name === 'CREDITS.md' ? 'credits' : e.name === `${ctx.name}.json` ? 'GameSpice map manifest' : e.name })
            }
            if (!existsSync(`${prefix}.json`)) throw new Error('bsp.py produced no manifest')
            return { files, warnings: [] }
        } })

    add({ id: 'gsmap-glb', from: 'gs-map', to: 'glb', label: 'GameSpice map to glb', async run(ctx) {
        ctx.progress(0.2)
        const r = mapToGlb(ctx.input, { sourceRoot: path.dirname(ctx.input), cacheDir: path.join(ctx.outDir, '.cache') })
        if (!r?.glb) throw new Error(r?.findings?.[0]?.msg ?? 'not a map manifest')
        const f = outFile(ctx, '.glb', 'glb scene')
        writeFileSync(f.path, r.glb)
        ctx.log(`glb: ${r.stats?.tris ?? '?'} triangles, ${r.stats?.materials ?? '?'} materials, ${(r.glb.length / 1048576).toFixed(1)} MB`)
        return { files: [f], warnings: (r.findings ?? []).filter((x) => x.severity !== 'info').map((x) => x.msg) }
    } })

    const brushesOf = (ctx) => {
        const m = readGsMap(ctx.input)
        let brushes = meshBrushes(m.json, m.blob)
        const warnings = []
        if (!brushes.length && m.boxes) brushes = boxBrushes(m.boxes)
        if (!brushes.length) throw new Error('the map has no convex collision hulls or boxes to write as brushes (a visual-only mesh cannot become brushes)')
        const total = (m.json.hulls ?? []).filter((h) => !h.kind || h.kind === 'solid').length
        if (m.json.hulls && brushes.length < total) warnings.push(`${total - brushes.length} of ${total} hulls could not be written as brushes`)
        warnings.push('only collision hulls and boxes are written; displacements, models and entities other than spawns are not')
        return { brushes, spawns: m.json.spawns ?? (m.json.spawn ? [{ at: m.json.spawn.at, yaw: m.json.spawn.yaw }] : []), warnings, m }
    }
    add({ id: 'gsmap-vmf', from: 'gs-map', to: 'vmf', label: 'GameSpice map to VMF (brushes)', async run(ctx) {
        const { brushes, spawns, warnings } = brushesOf(ctx)
        const f = outFile(ctx, '.vmf', 'Valve Map Format')
        writeFileSync(f.path, brushesToVmf(brushes, spawns)); ctx.log(`vmf: ${brushes.length} brushes, ${spawns.length} spawns`)
        return { files: [f], warnings }
    } })
    add({ id: 'gsmap-quake', from: 'gs-map', to: 'quake-map', label: 'GameSpice map to Quake .map', async run(ctx) {
        const { brushes, spawns, warnings } = brushesOf(ctx)
        const f = outFile(ctx, '.map', 'Quake map')
        writeFileSync(f.path, brushesToQuakeMap(brushes, spawns)); ctx.log(`map: ${brushes.length} brushes, ${spawns.length} spawns`)
        return { files: [f], warnings }
    } })

    const fromBrushes = (parse, k, label) => async (ctx) => {
        const text = readFileSync(ctx.input, 'utf8')
        ctx.progress(0.2)
        const p = parse(text)
        ctx.log(`${label}: ${p.brushes.length} brushes, ${p.entities.length} point entities`)
        const m = brushesToMesh(p, { k: Number(ctx.opts.metresPerUnit) || k, name: ctx.name, source: path.basename(ctx.input) })
        ctx.log(`mesh: ${m.stats.polygons} polygons, ${m.stats.hulls} hulls, ${m.stats.materials} materials, ${m.stats.spawns} spawns`)
        const warnings = []
        if (m.stats.skipped) warnings.push(`${m.stats.skipped} degenerate brushes skipped`)
        if (!m.stats.hulls) throw new Error('no solid brushes could be built (check the plane definitions)')
        return { files: writeMesh(ctx, m), warnings, meshStats: m.stats }
    }
    add({ id: 'vmf-gsmap', from: 'vmf', to: 'gs-map', label: 'VMF to GameSpice map', run: fromBrushes(parseVmf, SOURCE_K, 'vmf') })
    add({ id: 'quake-gsmap', from: 'quake-map', to: 'gs-map', label: 'Quake .map to GameSpice map', run: fromBrushes(parseQuakeMap, QUAKE_K, 'map') })

    add({ id: 'obj-gsmap', from: 'obj', to: 'gs-map', label: 'OBJ scene to GameSpice map (visual only, 1 unit = 1 m)', async run(ctx) {
        const m = sceneToMesh(parseObj(readFileSync(ctx.input, 'utf8'), Number(ctx.opts.scale) || 1), { name: ctx.name, source: path.basename(ctx.input) })
        ctx.log(`mesh: ${m.stats.polygons} polygons, ${m.stats.materials} materials`)
        return { files: writeMesh(ctx, m), warnings: ['a scene has no collision hulls: the map is visual only'] }
    } })
    add({ id: 'glb-gsmap', from: 'glb', to: 'gs-map', label: 'glb scene to GameSpice map (visual only)', async run(ctx) {
        const m = sceneToMesh(parseGlb(readFileSync(ctx.input)), { name: ctx.name, source: path.basename(ctx.input) })
        ctx.log(`mesh: ${m.stats.polygons} polygons, ${m.stats.materials} materials`)
        return { files: writeMesh(ctx, m), warnings: ['a scene has no collision hulls: the map is visual only'] }
    } })

    for (const from of ['fbx', 'dae']) add({ id: `${from}-glb`, from, to: 'glb', label: `${from.toUpperCase()} to glb (Blender)`, available: needBlender, async run(ctx) {
        const f = outFile(ctx, '.glb', 'glb scene')
        const script = path.join(ctx.outDir, '_import.py')
        writeFileSync(script, `import bpy,sys\nargv=sys.argv[sys.argv.index('--')+1:]\nbpy.ops.wm.read_factory_settings(use_empty=True)\n${from === 'fbx' ? 'bpy.ops.import_scene.fbx(filepath=argv[0])' : 'bpy.ops.wm.collada_import(filepath=argv[0])'}\nbpy.ops.export_scene.gltf(filepath=argv[1],export_format='GLB')\n`)
        await run('blender', ['-b', '--factory-startup', '-P', script, '--', ctx.input, f.path], { log: ctx.log, timeoutMs: 600000 })
        return { files: [f], warnings: [] }
    } })

    add({ id: 'gsmap-bsp', from: 'gs-map', to: 'bsp', label: 'GameSpice map to BSP (VMF + compiler)',
        note: 'Writes the .vmf; compiling needs the setting mapCompiler (argv with {input} {outDir} {name}). Without one the result is the .vmf only.',
        async run(ctx) {
            const { brushes, spawns, warnings } = brushesOf(ctx)
            const v = outFile(ctx, '.vmf', 'Valve Map Format')
            writeFileSync(v.path, brushesToVmf(brushes, spawns)); ctx.log(`vmf: ${brushes.length} brushes`)
            const tpl = S().mapCompiler
            if (!Array.isArray(tpl) || !tpl.length) return { files: [v], warnings: [...warnings, 'no BSP compiler is configured (setting mapCompiler): the result is the .vmf, compile it with vbsp/vvis/vrad or ericw-tools'], partial: true }
            const argv = tpl.map((a) => String(a).replace('{input}', v.path).replace('{outDir}', ctx.outDir).replace('{name}', ctx.name))
            ctx.progress(0.5); await run(argv[0], argv.slice(1), { log: ctx.log, timeoutMs: 1800000 })
            const bsp = outFile(ctx, '.bsp', 'compiled BSP')
            if (!existsSync(bsp.path)) throw new Error(`the compiler finished but wrote no ${path.basename(bsp.path)}`)
            return { files: [v, bsp], warnings }
        } })
}

// ---------------------------------------------------------------------------------------------------------------- mapping report

const baseKey = (m) => String(m).toLowerCase().replace(/\\/g, '/').replace(/\s+#[0-9a-f]{6}$/, '').replace(/\.(png|jpe?g|vtf|vmt)$/i, '')

/** Which materials of a gs-map manifest resolved: textures present in the output textures/ folder or credits, vs unmapped.
 *  `lookup(key)` -> { id, pack, kind } | null finds the Asset Manager entry. Returns { materials: [{ name, tris, status, texture, credit, asset }], counts, models: [...] }. */
export function mappingReport(manifestFile, { lookup } = {}) {
    const j = JSON.parse(readFileSync(manifestFile, 'utf8'))
    const dir = path.dirname(manifestFile)
    const texDir = path.join(dir, 'textures')
    const files = existsSync(texDir) ? readdirSync(texDir) : []
    const byStem = new Map(files.map((f) => [f.replace(/\.[^.]+$/, '').toLowerCase(), f]))
    let credits = []
    try { credits = JSON.parse(readFileSync(path.join(dir, 'credits.json'), 'utf8')).works ?? [] } catch { /* no credits file: a mesh-only run */ }
    const cred = new Map(credits.filter((w) => w.kind === 'texture').map((w) => [String(w.name).toLowerCase(), w]))
    const materials = (j.surfaces ?? []).map((s) => {
        const name = String(s.material ?? '')
        const key = baseKey(name), stem = key.split('/').pop()
        const tex = byStem.get(stem) ?? byStem.get(key.replace(/\//g, '_')) ?? null
        const c = cred.get(stem) ?? null
        const generated = /^(gen_|tools\/|toolsnodraw)/.test(stem) || /^#?[0-9a-f]{6}$/.test(stem) || /^box( #|$)/.test(name)
        const status = tex || c ? 'resolved' : generated ? 'generated' : 'unmapped'
        return { name, tris: Math.round((s.index_count ?? 0) / 3), status, texture: tex ? `textures/${tex}` : '', credit: c ? { author: c.author, licence: c.licence, url: c.url } : null, asset: lookup?.(stem) ?? null }
    })
    const counts = { resolved: 0, generated: 0, unmapped: 0 }
    for (const m of materials) counts[m.status]++
    let models = []
    try { models = JSON.parse(readFileSync(path.join(dir, 'models', 'models.json'), 'utf8')) } catch { /* none */ }
    if (!Array.isArray(models)) models = Array.isArray(models?.models) ? models.models : []
    return { materials, counts, models: models.slice(0, 200).map((m) => ({ name: m.name ?? m.model ?? '', status: m.status ?? (m.replacement ? 'resolved' : 'unmapped'), replacement: m.replacement ?? m.glb ?? '' })) }
}

// ---------------------------------------------------------------------------------------------------------------- jobs

export function ensureJobTable(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS map_convert_job (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL DEFAULT '', input_name TEXT NOT NULL, from_fmt TEXT NOT NULL, to_fmt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued', progress REAL NOT NULL DEFAULT 0, log TEXT NOT NULL DEFAULT '', outputs TEXT NOT NULL DEFAULT '[]',
        warnings TEXT NOT NULL DEFAULT '[]', report TEXT NOT NULL DEFAULT '{}', error TEXT NOT NULL DEFAULT '', opts TEXT NOT NULL DEFAULT '{}',
        node TEXT NOT NULL DEFAULT 'local', pid INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, finished_at TEXT NOT NULL DEFAULT '')`)
}
const jobDir = (id) => path.join(JOBS_DIR(), String(id))
const stemOf = (n) => n.replace(/\.[^.]+$/, '').replace(/[^\w.\-]/g, '_') || 'map'

/** Creates a queued job from an uploaded file (already on disk at `file`) and returns its id. Throws on an unknown format or no route. */
export function createJob(db, { file, name, to, project = '', opts = {}, createdBy = '', settings = {} }) {
    registerBuiltins(settings)
    ensureJobTable(db)
    const head = readFileSync(file).subarray(0, 8192)
    const from = detectFormat(name ?? file, head) || (/\.(fbx|dae)$/i.test(name ?? file) ? String(name ?? file).split('.').pop().toLowerCase() : '')
    if (!from) throw new Error(`${name}: cannot tell what map format this is (expected bsp, vmf, Quake .map, GameSpice manifest .json, glb, obj, fbx, dae)`)
    if (!FORMATS[to] && !['fbx', 'dae'].includes(to)) throw new Error(`unknown target format "${to}" (${Object.keys(FORMATS).join(', ')})`)
    const plan = registry.plan(from, to)
    if (plan == null) {
        const why = registry.list().filter((c) => c.from === from && c.available).map((c) => `${c.label}: ${c.available}`)
        throw new Error(`no conversion route from ${from} to ${to}${why.length ? ` (${why.join('; ')})` : ` (reachable from ${from}: ${registry.targets(from).join(', ') || 'nothing'})`}`)
    }
    if (!plan.length) throw new Error(`the input already is ${to}`)
    const now = new Date().toISOString()
    const id = Number(db.prepare('INSERT INTO map_convert_job (project, input_name, from_fmt, to_fmt, opts, created_by, created_at) VALUES (?,?,?,?,?,?,?)').run(String(project), String(name ?? path.basename(file)), from, to, JSON.stringify(opts), String(createdBy), now).lastInsertRowid)
    mkdirSync(path.join(jobDir(id), 'in'), { recursive: true })
    copyFileSync(file, path.join(jobDir(id), 'in', path.basename(name ?? file).replace(/[^\w.\-]/g, '_')))
    return id
}
export const jobRow = (db, id) => { ensureJobTable(db); return db.prepare('SELECT * FROM map_convert_job WHERE id = ?').get(Number(id)) ?? null }
export function jobList(db, { project, limit = 30 } = {}) {
    ensureJobTable(db)
    return project ? db.prepare('SELECT * FROM map_convert_job WHERE project = ? ORDER BY id DESC LIMIT ?').all(String(project), limit) : db.prepare('SELECT * FROM map_convert_job ORDER BY id DESC LIMIT ?').all(limit)
}
const jobPatch = (db, id, p) => { const k = Object.keys(p); db.prepare(`UPDATE map_convert_job SET ${k.map((x) => `${x} = ?`).join(', ')} WHERE id = ?`).run(...k.map((x) => p[x]), id) }

/** Runs a queued job in this process; the log, progress and the outputs are written to the row as it goes. */
export async function runJob(db, id, { settings = {}, lookup } = {}) {
    registerBuiltins(settings)
    const job = jobRow(db, id)
    if (!job) throw new Error(`no map-convert job ${id}`)
    const inDir = path.join(jobDir(id), 'in')
    let input = path.join(inDir, readdirSync(inDir)[0])
    let log = ''
    const L = (line) => { log = (log + `[${new Date().toISOString().slice(11, 19)}] ${line}\n`).slice(-60000); jobPatch(db, id, { log }) }
    jobPatch(db, id, { status: 'running', pid: process.pid })
    try {
        const plan = registry.plan(job.from_fmt, job.to_fmt)
        if (!plan?.length) throw new Error(`no route from ${job.from_fmt} to ${job.to_fmt} on this machine`)
        L(`route: ${plan.map((s) => s.label).join(' -> ')}`)
        const name = stemOf(job.input_name)
        const opts = JSON.parse(job.opts || '{}')
        let warnings = [], partial = false, outputs = [], report = {}
        for (let i = 0; i < plan.length; i++) {
            const step = plan[i], last = i === plan.length - 1
            const outDir = path.join(jobDir(id), last ? 'out' : `step${i + 1}`)
            mkdirSync(outDir, { recursive: true })
            L(`step ${i + 1}/${plan.length}: ${step.label}`)
            const r = await step.run({ input, outDir, name, opts, log: L, progress: (p) => jobPatch(db, id, { progress: +((i + p) / plan.length).toFixed(3) }) })
            warnings = warnings.concat(r.warnings ?? []); partial ||= !!r.partial
            outputs = r.files
            const mf = step.to === 'gs-map' ? r.files.find((x) => path.basename(x.path) === `${name}.json`) : null
            if (mf) { try { report = mappingReport(mf.path, { lookup }) } catch (e) { L(`mapping report skipped: ${e.message}`) } }
            const next = plan[i + 1]
            if (next) {
                const f = r.files.find((x) => path.basename(x.path) === `${name}.json` && next.from === 'gs-map') ?? r.files.find((x) => FORMATS[next.from]?.ext.some((e) => x.path.toLowerCase().endsWith(`.${e}`))) ?? r.files[0]
                input = f.path
            }
        }
        const listed = outputs.map((f) => ({ name: path.basename(f.path), label: f.label, bytes: sizeOf(f.path) }))
        for (const e of existsSync(path.join(jobDir(id), 'out', 'textures')) ? [{ n: 'textures' }] : []) L(`${e.n}/ folder kept beside the outputs`)
        L(partial ? 'done with a partial result (see warnings)' : 'done')
        jobPatch(db, id, { status: partial ? 'partial' : 'done', progress: 1, outputs: JSON.stringify(listed), warnings: JSON.stringify([...new Set(warnings)]), report: JSON.stringify(report), finished_at: new Date().toISOString(), pid: 0 })
    } catch (e) {
        L(`failed: ${e.message}`)
        jobPatch(db, id, { status: 'failed', error: String(e.message).slice(0, 2000), finished_at: new Date().toISOString(), pid: 0 })
    }
    return jobRow(db, id)
}

/** Starts a job as a detached child (`bin/nightly map-convert --run-job <id>`) so the caller returns at once. */
export function startJob(id, { nightlyBin = path.join(HERE, '..', 'bin', 'nightly') } = {}) {
    const p = spawn(nightlyBin, ['map-convert', '--run-job', String(id)], { detached: true, stdio: 'ignore', env: process.env })
    p.unref()
    return p.pid
}
/** A finished job's output file path, or null when the name is not one of its outputs (no traversal). */
export function jobOutputPath(db, id, name) {
    const j = jobRow(db, id)
    if (!j) return null
    const n = path.basename(String(name))
    const f = path.join(jobDir(id), 'out', n)
    return existsSync(f) && statSync(f).isFile() ? f : null
}
/** The converted map's output directory (the Map Manager can load its manifest from here). */
export const jobOutDir = (id) => path.join(jobDir(id), 'out')
