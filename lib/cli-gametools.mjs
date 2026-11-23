// CLI for the game tools: `nightly assets upload`, `nightly maps list|upload|formats`, `nightly map-convert`.
import { readFileSync } from 'node:fs'
import * as AS from './assets.mjs'
import * as U from './assets-upload.mjs'
import * as MC from './map-convert.mjs'
import { routes, planFor } from './map-convert-formats.mjs'

export const GAMETOOLS_BOOL = ['noScan', 'jobs', 'formats']
export const GAMETOOLS_COMMANDS = ['maps', 'map-convert']
export const GAMETOOLS_HELP = `  assets upload <file> [--type model|texture|sound|animation|map|other] [--pack P] [--name N] [--note T] [--project SLUG] [--by USER] [--no-scan]   store an asset (validated, size limits from settings uploadMaxMb[.type], 0 = unlimited), convert if needed, scan
  assets uploads [--pack P] [--type T]          list uploaded files
  maps list [--pack P] [--q TEXT]               converted maps (name, pack, triangles, spawns)
  maps upload <file> [--bin FILE] [--pack P] [--name N] [--note T] [--by USER]   add a map: GameSpice manifest .json (+ --bin), BSP, VMF, Quake .map, glb, obj; converted to a GameSpice map and scanned
  map-convert <file> --to <fmt> [--bin FILE] [--project SLUG] [--by USER] [--wait] [--json]   convert a map (bsp, vmf, quake-map, gs-map, glb, obj, ...) as a job; prints the job id (--wait runs it here; --bin: a gs-map manifest's geometry when not beside it)
  map-convert --jobs [--project SLUG] | --job <id> | --formats | --run-job <id>   list jobs, show one, list the registered converters and what is unavailable, or run a queued job (the panel does this detached)`

/** name -> { id, pack, weaponId } for every texture inside the asset rows, so the mapping preview can link to Asset Manager entries. */
export function textureLookup(db) {
    const m = new Map()
    let rows = []
    try { rows = db.prepare('SELECT id, pack, weaponId, data FROM AssetWeapon').all() } catch { return () => null }
    for (const r of rows) {
        let d; try { d = JSON.parse(r.data) } catch { continue }
        for (const t of d.textures ?? []) {
            const k = String(t.name ?? '').replace(/\.[^.]+$/, '').toLowerCase()
            if (k && !m.has(k)) m.set(k, { id: r.id, pack: r.pack, weaponId: r.weaponId })
        }
    }
    return (s) => m.get(String(s).toLowerCase()) ?? null
}

export async function assetsUploadCmd(sub, { db, pos, opt, out, die }) {
    if (sub === 'uploads') { const r = U.uploadList(db, { pack: opt.pack, type: opt.type }); return out(r, () => r.map((x) => `${String(x.id).padStart(4)}  ${x.pack.padEnd(14)} ${x.type.padEnd(9)} ${x.name.padEnd(32)} ${x.bytes} B  ${x.uploadedBy}`).join('\n') || '(no uploads)') }
    const file = pos[0] ?? die('assets upload <file> [--type T] [--pack P]')
    try {
        const r = await U.uploadAsset(db, { file, name: opt.name, type: opt.type, pack: opt.pack, note: opt.note, project: opt.project, by: opt.by, bin: opt.bin, noScan: !!opt.noScan, log: (m) => process.stderr.write(`upload: ${m}\n`) })
        return out(r, () => `uploaded ${r.type} ${r.name} to ${r.pack} (#${r.id}, ${r.bytes} B)${r.warnings.length ? '\n' + r.warnings.map((w) => `warning: ${w}`).join('\n') : ''}`)
    } catch (e) { die(e.message) }
}

export async function runGametoolsCommand(cmd, { db, pos, opt, out, die }) {
    const settings = U.uploadSettings(db)
    MC.registerBuiltins(settings)
    if (cmd === 'maps') {
        const sub = pos.shift() ?? 'list'
        if (sub === 'upload') return assetsUploadCmd('upload', { db, pos, opt: { ...opt, type: 'map' }, out, die })
        if (sub === 'list' || sub === 'ls') {
            const rows = AS.list(db, { pack: opt.pack, kind: 'map', q: opt.q })
            return out(rows, () => rows.map((r) => `${String(r.id).padStart(4)}  ${r.pack.padEnd(22)} ${r.weaponId.padEnd(28)} tris ${String(r.tris).padStart(7)}`).join('\n') + `\n${rows.length} maps`)
        }
        die('maps list|upload')
    }
    // map-convert
    if (opt.formats) { const r = routes(); return out(r, () => r.map((c) => `${c.id.padEnd(14)} ${c.from.padEnd(10)} -> ${c.to.padEnd(10)} ${c.available ? 'UNAVAILABLE: ' + c.available : 'ready'}`).join('\n')) }
    if (opt.runJob) { const j = await MC.runJob(db, Number(opt.runJob), { settings, lookup: textureLookup(db) }); return out(j, () => `job ${j.id}: ${j.status}${j.error ? ' ' + j.error : ''}`) }
    if (opt.jobs) { const r = MC.jobList(db, { project: opt.project }); return out(r, () => r.map((j) => `${String(j.id).padStart(4)}  ${j.status.padEnd(8)} ${j.input_name} ${j.from_fmt} -> ${j.to_fmt}`).join('\n') || '(no jobs)') }
    if (opt.job) { const j = MC.jobRow(db, Number(opt.job)) ?? die(`no job ${opt.job}`); return out(j, () => `${j.status} ${Math.round(j.progress * 100)}%\n${j.log}${j.error ? '\nerror: ' + j.error : ''}`) }
    const file = pos[0] ?? die('map-convert <file> --to <fmt>   (map-convert --formats lists them)')
    const to = opt.to ?? die('--to <fmt> is required')
    let id
    try { id = MC.createJob(db, { file, name: opt.name ?? file.split('/').pop(), to, project: opt.project ?? '', createdBy: opt.by ?? '', settings, bin: opt.bin ?? '' }) } catch (e) { die(e.message) }
    if (opt.wait) { const j = await MC.runJob(db, id, { settings, lookup: textureLookup(db) }); return out(j, () => `job ${id}: ${j.status}${j.error ? ' ' + j.error : ''}\noutputs in ${MC.jobOutDir(id)}: ${JSON.parse(j.outputs).map((o) => o.name).join(', ')}`) }
    MC.startJob(id)
    return out({ id }, () => `job ${id} started (nightly map-convert --job ${id})`)
}
